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
// 200:  { ok:true, data:{ headline, summaryText, insights:[...] } }
// 422:  { ok:false, error, raw }   (model replied but JSON didn't parse)
// 4xx/5xx on bad input or upstream failure.
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
      messages: [
        { role: "user", content },
        // ASSISTANT PREFILL (Jul 2026 — fixes intermittent 422s).
        // Seeding the assistant turn with an open brace removes the model's
        // ability to emit a preamble ("Here's the analysis:") or a closing note
        // before/after the JSON — the completion starts INSIDE the object. The
        // prompt asks for raw JSON; this makes it structurally impossible to do
        // otherwise. /ocr does not need this because a rigid extraction schema
        // leaves no room for conversational framing; a narrative task does.
        // NOTE: the response therefore OMITS the leading "{" — it is re-attached
        // below before parsing.
        { role: "assistant", content: "{" },
      ],
    });

    // Same hardening as /ocr: concatenate text blocks, strip stray fences, parse.
    // Duplicated on purpose — see the header note. Do NOT factor these together
    // as part of an insights change.
    let text = (message.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .replace(/```json|```/g, "")
      .trim();

    // Re-attach the prefilled brace the model was never asked to repeat.
    text = "{" + text;

    // Belt and braces: if anything still trails the object (a stray sentence,
    // a truncated token), slice to the outermost balanced braces before parsing.
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) {
      text = text.slice(first, last + 1);
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (parseErr) {
      console.error("Insights parse failure. Raw model text:\n", text);
      return res.status(422).json({
        ok: false,
        error: "Model response was not valid JSON.",
        raw: text,
      });
    }

    return res.json({ ok: true, data });
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
