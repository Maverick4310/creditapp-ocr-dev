// 2026-09 (Title Docs) Run real title packages through a local /title-docs and print the checks.
// Usage: node test/runSamples.mjs <cases.json> [baseUrl]
// cases.json (kept OUTSIDE this public repo): [{ name, files: [path], expected: {...} }]
// Prints verdicts and check details only; never writes document contents anywhere.
// Env: CONCURRENCY (default 1); RESULTS_OUT=<path> also writes { name, verdict, summary, checks, types }
// per case as JSON (checks and types only — still no document contents).
import { readFileSync, writeFileSync } from "node:fs";
import { extname } from "node:path";

const [casesPath, base = "http://localhost:3000"] = process.argv.slice(2);
const cases = JSON.parse(readFileSync(casesPath, "utf8"));
const MIME = { ".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };

async function runCase(c) {
  const files = c.files.map((p) => ({ media_type: MIME[extname(p).toLowerCase()], data: readFileSync(p).toString("base64") }));
  const t = Date.now();
  const res = await fetch(`${base}/title-docs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Navitas-Token": process.env.SHARED_TOKEN || "" },
    body: JSON.stringify({ files, expected: c.expected }),
  });
  const body = await res.json();
  const lines = [`\n══ ${c.name} — HTTP ${res.status} in ${((Date.now() - t) / 1000).toFixed(1)}s`];
  if (!body.ok) {
    lines.push(`  error: ${body.error}`);
    return { lines, row: { name: c.name, error: body.error } };
  }
  lines.push("  documents: " + body.data.documents.map((d) => `${d.type}[p${(d.pages || []).join(",")}]${d.legible ? "" : "(ILLEGIBLE)"}`).join("  "));
  lines.push(`  verdict: ${body.result.verdict}  ${JSON.stringify(body.result.summary)}`);
  for (const k of body.result.checks) lines.push(`  ${k.status.toUpperCase().padEnd(4)} ${k.label} — ${k.detail}`);
  return { lines, row: { name: c.name, verdict: body.result.verdict, summary: body.result.summary, checks: body.result.checks,
    types: body.data.documents.map((d) => d.type), illegible: body.data.documents.filter((d) => !d.legible).map((d) => d.type) } };
}

const limit = Math.max(1, parseInt(process.env.CONCURRENCY || "1", 10));
const results = new Array(cases.length);
let next = 0;
await Promise.all(Array.from({ length: limit }, async () => {
  while (next < cases.length) {
    const i = next++;
    try { results[i] = await runCase(cases[i]); }
    catch (e) { results[i] = { lines: [`\n══ ${cases[i].name} — ${e.message}`], row: { name: cases[i].name, error: e.message } }; }
  }
}));
for (const r of results) console.log(r.lines.join("\n"));
if (process.env.RESULTS_OUT) writeFileSync(process.env.RESULTS_OUT, JSON.stringify(results.map((r) => r.row), null, 1));
