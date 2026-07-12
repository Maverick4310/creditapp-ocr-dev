// server.js
//
// Navitas OCR prefill service.
// Flow:  LWC (browser)  →  POST /ocr  →  Claude  →  structured JSON back to LWC
//
// The Anthropic API key lives ONLY in this service's environment. It never
// reaches the browser and never touches Salesforce. The browser is trusted
// only by Origin (CORS allowlist) — see README for what that does and doesn't
// protect. No applicant data is persisted here; documents are held in memory
// for the duration of the request and then discarded.
//
// CHANGE (Jul 2026) — DASHBOARD INSIGHTS ROUTE.
// Added POST /insights. Same service, same deploy, same API key, same
// SHARED_TOKEN and checkToken gate — a second route is strictly cheaper than a
// second Render app, and nothing about this workload needs isolation from /ocr.
//
// This change is deliberately ADDITIVE: not one line inside the /ocr handler is
// touched. There is a small amount of duplicated fence-strip/parse logic between
// the two routes as a result, and that is the intended trade — /ocr runs in
// production against real credit applications, and a working extraction path
// should not acquire a diff because an unrelated feature shipped. If the two
// parsers ever need to be factored together, do it THEN, as its own change with
// its own regression pass.
//
// /insights is the inverse of /ocr: instead of reading documents to produce
// numbers, it is handed pre-computed numbers (from DashboardInsightController,
// which reuses MyDashboardController's existing aggregation) and produces
// narrative. No files, no applicant PII — the payload is aggregate sales metrics
// and seller company names. The prompt lives in insightPrompt.js, mirroring how
// prompt.js is kept out of the wiring.

import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import { SCHEMA_PROMPT } from "./prompt.js";
import { INSIGHT_PROMPT } from "./insightPrompt.js";   // Jul 2026

// ── Config (all from environment) ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL || "claude-sonnet-5"; // flip to claude-haiku-4-5-20251001 for cheap testing
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "4096", 10);
// Jul 2026 — insights are a short narrative, not a full extraction schema.
// Separate ceiling so /insights doesn't pay for /ocr's headroom.
const INSIGHT_MAX_TOKENS = parseInt(process.env.INSIGHT_MAX_TOKENS || "1500", 10);
const SHARED_TOKEN = process.env.SHARED_TOKEN || ""; // optional soft check (see README)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!API_KEY) {
  console.error("FATAL: ANTHROPIC_API_KEY is not set.");
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: API_KEY });
const app = express();

// ── CORS: only accept browser calls from our Salesforce My Domain origins ──
// Requests with no Origin (curl, server-to-server, health checks) are allowed
// so the service stays testable; browser requests must match the allowlist.
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
        return cb(null, true);
      }
      return cb(new Error("Origin not allowed: " + origin));
    },
    methods: ["POST", "GET", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Navitas-Token"],
  })
);

// Base64-encoded PDFs inflate ~33%; give plenty of headroom over the raw file size.
app.use(express.json({ limit: "30mb" }));

// ── Health check (Render pings this) ──────────────────────────────────────
app.get(["/", "/health"], (_req, res) => res.json({ ok: true, model: MODEL }));

// ── Shared-secret auth (Apex → Render) ────────────────────────────────────
// Salesforce Apex is the only caller, so this token is a REAL secret: it's
// held server-side in Salesforce (Named Credential / custom metadata) and
// never reaches a browser. Set SHARED_TOKEN here and have Apex send it in the
// X-Navitas-Token header; non-matching requests are rejected. CORS is no
// longer the primary gate (Apex callouts send no Origin) — it stays only as
// defense in depth. Leave SHARED_TOKEN unset to disable (not recommended).
function checkToken(req, res, next) {
  if (!SHARED_TOKEN) return next();
  if (req.get("X-Navitas-Token") === SHARED_TOKEN) return next();
  return res.status(401).json({ ok: false, error: "Unauthorized" });
}

// ── Helper: turn an uploaded { media_type, data } into a Claude content block
function fileBlock(file) {
  if (!file || !file.data || !file.media_type) return null;
  if (file.media_type === "application/pdf") {
    return {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: file.data },
    };
  }
  if (file.media_type.startsWith("image/")) {
    return {
      type: "image",
      source: { type: "base64", media_type: file.media_type, data: file.data },
    };
  }
  return null; // unsupported type — silently skipped
}

// ══════════════════════════════════════════════════════════════════════════
// /ocr — UNCHANGED from the production version. Do not edit this handler as
//        part of an insights change.
// ══════════════════════════════════════════════════════════════════════════
// Body: { creditApp?: {media_type,data}, invoice?: {media_type,data}, emailText?: string,
//         instructions?: string }
//   emailText    — evidence. Feeds gap-filling and dealStory.
//   instructions — rep directives (Jul 2026). Override document values; see prompt.js.
// 200:  { ok:true, data:{...extraction...} }
// 422:  { ok:false, error, raw }   (model replied but JSON didn't parse)
// 4xx/5xx on bad input or upstream failure.
app.post("/ocr", checkToken, async (req, res) => {
  try {
    const { creditApp, invoice, emailText, instructions } = req.body || {};

    if (!creditApp && !invoice && !(emailText && emailText.trim())) {
      return res
        .status(400)
        .json({ ok: false, error: "Provide at least one document or an email body." });
    }

    // Build the multimodal message: documents first (each labeled), then the
    // email body and the extraction instructions.
    const content = [];

    const ca = fileBlock(creditApp);
    if (ca) {
      content.push(ca);
      content.push({ type: "text", text: "^ The document above is the CREDIT APPLICATION." });
    }
    const inv = fileBlock(invoice);
    if (inv) {
      content.push(inv);
      content.push({ type: "text", text: "^ The document above is the VENDOR INVOICE." });
    }

    // Rep instructions (Jul 2026) — a directive channel, deliberately separate
    // from emailText. The email is EVIDENCE and feeds dealStory; these are
    // corrections from the Navitas rep. Pushed as its own labeled block, and
    // pushed BEFORE the schema prompt on purpose: this is rep-authored free
    // text, so the extraction rules must come after it and have the final say
    // on what may and may not be overridden.
    if (instructions && instructions.trim()) {
      content.push({
        type: "text",
        text:
          `REP INSTRUCTIONS (written by the Navitas rep submitting this deal — ` +
          `directives, not document evidence):\n"""\n${instructions.trim()}\n"""`,
      });
    }

    let instruction = SCHEMA_PROMPT;
    if (emailText && emailText.trim()) {
      instruction += `\n\nEMAIL BODY:\n"""\n${emailText.trim()}\n"""`;
    }
    content.push({ type: "text", text: instruction });

    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content }],
    });

    // Concatenate any text blocks, strip stray code fences, parse.
    const text = (message.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .replace(/```json|```/g, "")
      .trim();

    let data;
    try {
      data = JSON.parse(text);
    } catch (parseErr) {
      // Model answered but not as clean JSON — hand back the raw text so the
      // caller can decide, rather than pretending it succeeded.
      return res.status(422).json({
        ok: false,
        error: "Model response was not valid JSON.",
        raw: text,
      });
    }

    return res.json({ ok: true, data });
  } catch (err) {
    console.error("OCR error:", err?.message || err);
    // Don't leak internals to the browser.
    return res.status(500).json({ ok: false, error: "Extraction failed. Please retry." });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// /insights — Jul 2026. Dashboard trend/pattern analysis. Purely additive.
// ══════════════════════════════════════════════════════════════════════════
// Body: { metrics: {...}, series: {...}, sellers: {...} }
//   Everything is PRE-COMPUTED in Apex from the existing MyDashboardController
//   aggregation. This route does no math, and insightPrompt.js forbids the model
//   from doing any either — if it derived its own figures, the panel would print
//   a number that contradicts the KPI tile directly above it, and the dashboard
//   would lose credibility permanently.
//
// Text-only. No attachments, no applicant PII: aggregate sales figures plus
// seller company names.
//
// OUTPUT SHAPE — FORCED TOOL USE (Jul 2026):
//   /ocr asks for raw JSON and defensively strips code fences, which is fine for
//   a rigid extraction schema. A NARRATIVE task is different: the model wants to
//   frame its answer ("Here's the analysis:"), and that preamble broke JSON.parse.
//   Prefilling the assistant turn with "{" would solve it, but Sonnet 5 rejects
//   assistant prefill outright. So instead the response schema is declared as a
//   TOOL and tool_choice forces the call. The API then returns a validated object
//   on the tool_use block's `input` — there is no text to parse, no fence to
//   strip, and malformed output stops being a possible failure mode.
//
// 200:  { ok:true, data:{ headline, summaryText, insights:[...] } }
// 422:  { ok:false, error }   (model failed to produce the structured call)
// 4xx/5xx on bad input or upstream failure.

// The analysis contract, expressed as a schema. Mirrors the OUTPUT block in
// insightPrompt.js — if one changes, change both.
const ANALYSIS_TOOL = {
  name: "emit_analysis",
  description:
    "Emit the dashboard trend analysis. This is the only way to respond.",
  input_schema: {
    type: "object",
    properties: {
      headline: {
        type: "string",
        description: "One-line verdict, under 90 characters.",
      },
      summaryText: {
        type: "string",
        description:
          "2-3 sentences: the year-over-year trend and what the monthly shape shows.",
      },
      insights: {
        type: "array",
        minItems: 3,
        maxItems: 5,
        description: "Prioritized findings, most important first.",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Under 50 characters." },
            detail: {
              type: "string",
              description:
                "1-2 sentences. Specific. Name the sellers. Say what to do.",
            },
            severity: {
              type: "string",
              enum: ["critical", "watch", "info", "positive"],
            },
            category: {
              type: "string",
              enum: ["pipeline", "sellers", "goal", "activity", "trend"],
            },
          },
          required: ["title", "detail", "severity", "category"],
        },
      },
    },
    required: ["headline", "summaryText", "insights"],
  },
};

app.post("/insights", checkToken, async (req, res) => {
  try {
    const payload = req.body || {};

    if (!payload.metrics) {
      return res.status(400).json({ ok: false, error: "No metrics provided." });
    }

    // Numbers first, rules last — same ordering logic as /ocr, where the schema
    // prompt is pushed after the evidence so it has the final say.
    const content = [
      {
        type: "text",
        text:
          `DASHBOARD METRICS (pre-computed — do not recalculate):\n"""\n` +
          `${JSON.stringify(payload, null, 2)}\n"""`,
      },
      { type: "text", text: INSIGHT_PROMPT },
    ];

    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: INSIGHT_MAX_TOKENS,
      messages: [{ role: "user", content }],
      tools: [ANALYSIS_TOOL],
      // Forces the tool call — the model cannot answer in prose.
      tool_choice: { type: "tool", name: "emit_analysis" },
    });

    // Truncation looks IDENTICAL to a malformed response downstream — the tool
    // input is cut off and never lands. Call it out separately so a max_tokens
    // problem doesn't get chased as a prompt problem.
    if (message.stop_reason === "max_tokens") {
      console.error(
        `Insights hit max_tokens (${INSIGHT_MAX_TOKENS}) — response truncated. ` +
          `Raise INSIGHT_MAX_TOKENS.`
      );
      return res
        .status(422)
        .json({ ok: false, error: "The analysis was cut short. Please retry." });
    }

    // The validated object arrives on the tool_use block's `input`. No text
    // parsing, no fence stripping.
    const toolUse = (message.content || []).find((b) => b.type === "tool_use");

    if (!toolUse || !toolUse.input) {
      console.error(
        "Insights: no tool_use block returned. stop_reason=",
        message.stop_reason,
        "content=",
        JSON.stringify(message.content)
      );
      return res
        .status(422)
        .json({ ok: false, error: "The analysis came back empty. Please retry." });
    }

    return res.json({ ok: true, data: toolUse.input });
  } catch (err) {
    console.error("Insights error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "Analysis failed. Please retry." });
  }
});

if (!SHARED_TOKEN) {
  console.warn(
    "WARNING: SHARED_TOKEN is not set — the /ocr and /insights endpoints are " +
    "unauthenticated. Set it and have Apex send X-Navitas-Token before exposing " +
    "this publicly."
  );
}

app.listen(PORT, () => {
  console.log(`navitas-ocr-service listening on ${PORT} (model: ${MODEL})`);
});
