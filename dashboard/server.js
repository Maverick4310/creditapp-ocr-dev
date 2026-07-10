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

import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import { SCHEMA_PROMPT } from "./prompt.js";

// ── Config (all from environment) ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL || "claude-sonnet-5"; // flip to claude-haiku-4-5-20251001 for cheap testing
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "4096", 10);
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

// ── /ocr ──────────────────────────────────────────────────────────────────
// Body: { creditApp?: {media_type,data}, invoice?: {media_type,data}, emailText?: string }
// 200:  { ok:true, data:{...extraction...} }
// 422:  { ok:false, error, raw }   (model replied but JSON didn't parse)
// 4xx/5xx on bad input or upstream failure.
app.post("/ocr", checkToken, async (req, res) => {
  try {
    const { creditApp, invoice, emailText } = req.body || {};

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

if (!SHARED_TOKEN) {
  console.warn(
    "WARNING: SHARED_TOKEN is not set — the /ocr endpoint is unauthenticated. " +
    "Set it and have Apex send X-Navitas-Token before exposing this publicly."
  );
}

app.listen(PORT, () => {
  console.log(`navitas-ocr-service listening on ${PORT} (model: ${MODEL})`);
});
