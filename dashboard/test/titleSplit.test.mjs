// 2026-09 (Title Split) /title-docs/split returns only the requested pages.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { PDFDocument } from "pdf-lib";
import { registerTitleDocs, parsePages } from "../titleDocs.js";

async function fivePagePdf() {
  const doc = await PDFDocument.create();
  for (let i = 1; i <= 5; i++) doc.addPage([200 + i, 300]); // widths mark the pages
  return Buffer.from(await doc.save());
}

async function withServer(fn) {
  const app = express();
  registerTitleDocs(app, { anthropic: null, model: "test", checkToken: (_q, _r, n) => n(), fileBlock: () => null });
  const server = app.listen(0);
  try { return await fn(`http://localhost:${server.address().port}/title-docs/split`); } finally { server.close(); }
}

test("parsePages reads lists and ranges", () => {
  assert.deepEqual(parsePages("3,4"), [3, 4]);
  assert.deepEqual(parsePages("4-5, 1"), [1, 4, 5]);
  assert.equal(parsePages("0"), null);
  assert.equal(parsePages("a"), null);
  assert.equal(parsePages(""), null);
});

test("returns just the requested pages, in order", async () => {
  const pdf = await fivePagePdf();
  await withServer(async (url) => {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/pdf", "X-Split-Pages": "4,2" }, body: pdf });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/pdf");
    const out = await PDFDocument.load(Buffer.from(await res.arrayBuffer()));
    assert.deepEqual(out.getPages().map((p) => p.getWidth()), [202, 204]);
  });
});

test("rejects pages past the end and bad headers", async () => {
  const pdf = await fivePagePdf();
  await withServer(async (url) => {
    const past = await fetch(url, { method: "POST", headers: { "Content-Type": "application/pdf", "X-Split-Pages": "6" }, body: pdf });
    assert.equal(past.status, 400);
    const bad = await fetch(url, { method: "POST", headers: { "Content-Type": "application/pdf", "X-Split-Pages": "x" }, body: pdf });
    assert.equal(bad.status, 400);
    const notPdf = await fetch(url, { method: "POST", headers: { "Content-Type": "application/pdf", "X-Split-Pages": "1" }, body: Buffer.from("hello") });
    assert.equal(notPdf.status, 422);
  });
});

// 2026-10 (Titling testing 30 Oct) Packages over 8 MB: the service downloads the package once and cuts it.
test("split-remote downloads the package once and returns the requested pages", async () => {
  const pdf = await fivePagePdf();
  let downloads = 0;
  const sfFiles = { configured: () => true, download: async () => { downloads++; return pdf; } };
  const app = express();
  app.use(express.json());
  registerTitleDocs(app, { anthropic: null, model: "test", checkToken: (_q, _r, n) => n(), fileBlock: () => null, sfFiles });
  const server = app.listen(0);
  const url = `http://localhost:${server.address().port}/title-docs/split-remote`;
  const post = (body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const a = await post({ contentVersionId: "068000000000001AAA", pages: "2,3" });
    assert.equal(a.status, 200);
    assert.deepEqual((await PDFDocument.load(Buffer.from(await a.arrayBuffer()))).getPages().map((p) => p.getWidth()), [202, 203]);
    const b = await post({ contentVersionId: "068000000000001AAA", pages: "5" });
    assert.deepEqual((await PDFDocument.load(Buffer.from(await b.arrayBuffer()))).getPages().map((p) => p.getWidth()), [205]);
    assert.equal(downloads, 1);
    assert.equal((await post({ contentVersionId: "068000000000001AAA", pages: "x" })).status, 400);
    assert.equal((await post({ contentVersionId: "068000000000001AAA", pages: "9" })).status, 400);
  } finally { server.close(); }
});
