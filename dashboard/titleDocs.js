// 2026-09 (Title Docs) POST /title-docs — read titling documents and check them.
//
// Body, either:
//   JSON: { files: [{ media_type, data (base64), name? }] (1 to 10), expected: {...} }
//   2026-09 (Title Package) or the raw file: Content-Type application/pdf or image/*, with
//     expected as base64 JSON in the X-Title-Expected header. Salesforce sends packages this
//     way: without base64 a 10 MB package fits Apex's 12 MB async heap.
// {
//   files:    [{ media_type, data (base64), name? }]   — 1 to 10 files (PDF or image)
//   expected: { dealNumber, customerName, vins, referenceDate, payingOffLien,
//               privateSale, insuranceRequired, docType, cost }   — see titleRules.js
// }
// Returns: { ok, data: { documents, package_notes }, result: { verdict, summary, checks } }
//
// 2026-09 (Title Split) POST /title-docs/split — the raw package PDF, with the 1-based pages
// to keep in the X-Split-Pages header ("3,4"). Returns just those pages as a PDF. No model
// call: Salesforce uses it to save each filed document as its own file.
//
// Salesforce (CreditAppOcrController, called from a Queueable after a rep uploads a
// document) sends the same X-Navitas-Token as /ocr. Logs carry counts only — never
// document contents, names or numbers.
import express from "express";
import { PDFDocument } from "pdf-lib"; // 2026-09 (Title Split)
import { TITLE_TOOL, TITLE_PROMPT } from "./titlePrompt.js";
import { runChecks } from "./titleRules.js";

const MAX_FILES = 10;

// A list, a JSON string of a list, or a JSON string of { [key]: list } → the list; else null.
function asArray(value, key) {
  let v = value;
  for (let i = 0; i < 3; i++) {
    if (typeof v === "string") {
      try { v = JSON.parse(v); } catch { return null; }
    } else if (v && !Array.isArray(v) && typeof v === "object" && key in v) {
      v = v[key];
    } else break;
  }
  return Array.isArray(v) ? v : null;
}

export function registerTitleDocs(app, { anthropic, model, checkToken, fileBlock }) {
  const maxTokens = parseInt(process.env.TITLE_MAX_TOKENS || "16000", 10);

  const raw = express.raw({ type: ["application/pdf", "image/*"], limit: "30mb" });

  app.post("/title-docs", checkToken, raw, async (req, res) => {
    const started = Date.now();
    try {
      let files;
      let expected;
      if (Buffer.isBuffer(req.body)) {
        files = [{ media_type: req.get("content-type").split(";")[0].trim(), data: req.body.toString("base64") }];
        try {
          expected = JSON.parse(Buffer.from(req.get("x-title-expected") || "", "base64").toString("utf8") || "{}");
        } catch {
          return res.status(400).json({ ok: false, error: "X-Title-Expected is not base64 JSON." });
        }
      } else {
        ({ files, expected } = req.body || {});
      }
      const list = Array.isArray(files) ? files : [];
      if (!list.length || list.length > MAX_FILES) {
        return res.status(400).json({ ok: false, error: `Send 1 to ${MAX_FILES} files.` });
      }

      const content = [];
      list.forEach((f, i) => {
        const block = fileBlock(f);
        if (!block) return;
        content.push(block);
        content.push({ type: "text", text: `^ The document above is FILE ${i} (file_index ${i}).` });
      });
      if (!content.length) {
        return res.status(400).json({ ok: false, error: "No readable PDF or image was sent." });
      }
      content.push({ type: "text", text: TITLE_PROMPT });

      // The model occasionally returns the document list in a shape that cannot be recovered;
      // one retry clears it (seen on 2 of 48 real packages).
      let data = null;
      let message = null;
      for (let attempt = 1; attempt <= 2 && !data; attempt++) {
        message = await anthropic.messages.create({
          model,
          max_tokens: maxTokens,
          messages: [{ role: "user", content }],
          tools: [TITLE_TOOL],
          tool_choice: { type: "tool", name: TITLE_TOOL.name },
        });
        if (message.stop_reason === "max_tokens") {
          console.error(`Title docs hit max_tokens (${maxTokens}) — raise TITLE_MAX_TOKENS.`);
          return res.status(422).json({ ok: false, error: "The documents were too long to read in one pass." });
        }
        const toolUse = (message.content || []).find((b) => b.type === "tool_use");
        const input = toolUse && toolUse.input;
        // The list sometimes arrives as a JSON string, sometimes wrapping {"documents":[...]}.
        const list = input ? asArray(input.documents, "documents") : null;
        if (list) {
          data = input;
          data.documents = list;
        } else {
          console.error(`Title docs: attempt ${attempt} returned no readable document list (stop_reason=${message.stop_reason}).`);
        }
      }
      if (!data) {
        return res.status(422).json({ ok: false, error: "The documents could not be read cleanly. Please retry." });
      }
      data.package_notes = asArray(data.package_notes, "package_notes") || [];
      const result = runChecks(data, expected || {});
      console.log(
        `Title docs: ${list.length} file(s), ${(data.documents || []).length} document(s), ` +
          `verdict ${result.verdict} (${result.summary.fail} fail, ${result.summary.warn} warn), ` +
          `${Date.now() - started} ms, ${message.usage?.input_tokens || 0} in / ${message.usage?.output_tokens || 0} out tokens.`
      );
      return res.json({ ok: true, data, result });
    } catch (err) {
      console.error("Title docs error:", err?.message || err);
      return res.status(500).json({ ok: false, error: "Reading the documents failed. Please retry." });
    }
  });

  // 2026-09 (Title Split)
  const rawPdf = express.raw({ type: "application/pdf", limit: "30mb" });
  app.post("/title-docs/split", checkToken, rawPdf, async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        return res.status(400).json({ ok: false, error: "Send the PDF as application/pdf." });
      }
      const pages = parsePages(req.get("x-split-pages"));
      if (!pages) return res.status(400).json({ ok: false, error: "X-Split-Pages must list page numbers, e.g. 3,4." });
      const src = await PDFDocument.load(req.body, { ignoreEncryption: true });
      const total = src.getPageCount();
      if (pages.some((p) => p > total)) {
        return res.status(400).json({ ok: false, error: `The PDF has ${total} page(s).` });
      }
      const out = await PDFDocument.create();
      const copied = await out.copyPages(src, pages.map((p) => p - 1));
      copied.forEach((p) => out.addPage(p));
      const bytes = Buffer.from(await out.save());
      console.log(`Title split: ${pages.length} of ${total} page(s), ${Math.round(bytes.length / 1024)} KB`);
      res.set("Content-Type", "application/pdf");
      return res.send(bytes);
    } catch (err) {
      console.error("Title split error:", err?.message || err);
      return res.status(422).json({ ok: false, error: "The PDF could not be split." });
    }
  });
}

// "3,4" or "3-5,7" → [3, 4] / [3, 4, 5, 7] (sorted, unique, 1-based); null when invalid.
export function parsePages(header) {
  if (!header || typeof header !== "string") return null;
  const set = new Set();
  for (const part of header.split(",")) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const a = parseInt(m[1], 10);
    const b = m[2] ? parseInt(m[2], 10) : a;
    if (a < 1 || b < a || b - a > 500) return null;
    for (let p = a; p <= b; p++) set.add(p);
  }
  return set.size ? [...set].sort((x, y) => x - y) : null;
}
