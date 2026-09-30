// 2026-09 (Title Package) The /title-docs route accepts a raw PDF with expected values in a header,
// as Salesforce sends packages. The model is a stand-in; no API call is made.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { registerTitleDocs } from "../titleDocs.js";

const VIN = "1M8GDM9AXKP042788";
const fakeAnthropic = {
  messages: {
    create: async ({ messages }) => {
      const doc = messages[0].content.find((b) => b.type === "document");
      assert.ok(doc && doc.source.data.length > 0, "the file reached the model as a document block");
      return {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", input: { documents: [
          { type: "title_front", file_index: 0, pages: [1], legible: true, vin: VIN, owner_names: ["Acme Paving LLC"], lienholders: [] },
          { type: "title_back", file_index: 0, pages: [2], legible: true, assignments: [] },
        ] } }],
      };
    },
  },
};
const fileBlock = (f) => ({ type: "document", source: { type: "base64", media_type: f.media_type, data: f.data } });

test("a raw PDF with X-Title-Expected is read and checked", async () => {
  const app = express();
  app.use(express.json({ limit: "30mb" }));
  registerTitleDocs(app, { anthropic: fakeAnthropic, model: "test", checkToken: (_q, _r, n) => n(), fileBlock });
  const server = app.listen(0);
  const port = server.address().port;
  const expected = Buffer.from(JSON.stringify({ vins: [VIN], customerName: "Acme Paving LLC" })).toString("base64");
  const res = await fetch(`http://localhost:${port}/title-docs`, {
    method: "POST",
    headers: { "Content-Type": "application/pdf", "X-Title-Expected": expected },
    body: Buffer.from("%PDF-1.4 test"),
  });
  const body = await res.json();
  server.close();
  assert.equal(res.status, 200);
  assert.equal(body.data.documents.length, 2);
  assert.equal(body.result.documents[0].vin, VIN);
  assert.equal(body.result.checks.find((c) => c.id === "vin_match").status, "pass");
});
