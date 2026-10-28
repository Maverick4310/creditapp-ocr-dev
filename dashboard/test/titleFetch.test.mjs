// 2026-10 (Large Packages) /title-docs/fetch downloads a Salesforce file and reads it in the
// background; /title-docs/jobs/:id returns the result. No Salesforce or model call is made.
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { registerTitleDocs } from "../titleDocs.js";
import { makeSfFiles } from "../sfFiles.js";

const VIN = "1M8GDM9AXKP042788";
const VERSION = "068000000000001AAA";
const fakeAnthropic = {
  messages: {
    create: async ({ messages }) => {
      const doc = messages[0].content.find((b) => b.type === "document");
      assert.equal(Buffer.from(doc.source.data, "base64").toString(), "%PDF-1.4 big");
      return { stop_reason: "tool_use", content: [{ type: "tool_use", input: { documents: [
        { type: "title_front", file_index: 0, pages: [1], legible: true, vin: VIN, owner_names: ["Acme Paving LLC"], lienholders: [] },
      ] } }] };
    },
  },
};
const fileBlock = (f) => ({ type: "document", source: { type: "base64", media_type: f.media_type, data: f.data } });

async function serve(sfFiles) {
  const app = express();
  app.use(express.json());
  registerTitleDocs(app, { anthropic: fakeAnthropic, model: "test", checkToken: (_q, _r, n) => n(), fileBlock, sfFiles });
  const server = app.listen(0);
  return { server, url: `http://localhost:${server.address().port}` };
}
const start = (url, body) => fetch(`${url}/title-docs/fetch`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function waitFor(url, jobId) {
  for (let i = 0; i < 50; i++) {
    const r = await fetch(`${url}/title-docs/jobs/${jobId}`);
    const b = await r.json();
    if (b.done) return { status: r.status, body: b };
    await new Promise((ok) => setTimeout(ok, 10));
  }
  throw new Error("job never finished");
}

test("a large file is downloaded, read in the background and its result collected", async () => {
  const { server, url } = await serve({ configured: () => true, download: async (id) => {
    assert.equal(id, VERSION);
    return Buffer.from("%PDF-1.4 big");
  } });
  const res = await start(url, { contentVersionId: VERSION, mediaType: "application/pdf", expected: { vins: [VIN] } });
  assert.equal(res.status, 202);
  const { jobId } = await res.json();
  const { status, body } = await waitFor(url, jobId);
  server.close();
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.result.checks.find((c) => c.id === "vin_match").status, "pass");
});

test("a download failure is the job's result, with its status", async () => {
  const sfFiles = makeSfFiles({ env: {} });
  const { server, url } = await serve({ configured: () => true, download: (id, max) => sfFiles.download(id, max) });
  const { jobId } = await (await start(url, { contentVersionId: VERSION, mediaType: "application/pdf" })).json();
  const { status, body } = await waitFor(url, jobId);
  server.close();
  assert.equal(status, 503);
  assert.equal(body.error, "Large files cannot be read yet.");
});

test("fetch refuses unsupported types, no login, and unknown jobs", async () => {
  const { server, url } = await serve({ configured: () => false, download: async () => Buffer.alloc(0) });
  assert.equal((await start(url, { contentVersionId: VERSION, mediaType: "text/plain" })).status, 400);
  assert.equal((await start(url, { contentVersionId: VERSION, mediaType: "application/pdf" })).status, 503);
  assert.equal((await fetch(`${url}/title-docs/jobs/nope`)).status, 404);
  server.close();
});

// A fake Salesforce: token endpoint plus VersionData.
function fakeSalesforce({ size = 10, expireFirst = false } = {}) {
  const calls = [];
  let logins = 0;
  const fetchImpl = async (u, opts = {}) => {
    calls.push(u);
    if (u.endsWith("/services/oauth2/token")) {
      logins++;
      assert.equal(new URLSearchParams(opts.body).get("grant_type"), "client_credentials");
      return new Response(JSON.stringify({ access_token: `t${logins}`, instance_url: "https://sf.example" }), { status: 200 });
    }
    if (expireFirst && opts.headers.Authorization === "Bearer t1") return new Response("", { status: 401 });
    if (u.includes("/ContentVersion/068000000000404AAA/")) return new Response("", { status: 404 });
    return new Response(Buffer.alloc(size, 1), { status: 200, headers: { "content-length": String(size) } });
  };
  const env = { SF_LOGIN_URL: "https://login.example/", SF_CLIENT_ID: "id", SF_CLIENT_SECRET: "secret" };
  return { sf: makeSfFiles({ env, fetchImpl }), calls };
}

test("downloads with client credentials and reuses the token", async () => {
  const { sf, calls } = fakeSalesforce();
  assert.equal((await sf.download(VERSION, 100)).length, 10);
  await sf.download(VERSION, 100);
  assert.equal(calls.filter((u) => u.endsWith("/token")).length, 1);
  assert.ok(calls.includes(`https://sf.example/services/data/v62.0/sobjects/ContentVersion/${VERSION}/VersionData`));
});

test("an expired session logs in again once", async () => {
  const { sf, calls } = fakeSalesforce({ expireFirst: true });
  assert.equal((await sf.download(VERSION, 100)).length, 10);
  assert.equal(calls.filter((u) => u.endsWith("/token")).length, 2);
});

test("bad Ids, missing files and oversized files are refused", async () => {
  const { sf } = fakeSalesforce({ size: 50 });
  await assert.rejects(sf.download("069000000000001AAA", 100), (e) => e.status === 400);
  await assert.rejects(sf.download("068000000000404AAA", 100), (e) => e.status === 404);
  await assert.rejects(sf.download(VERSION, 20), (e) => e.status === 413 && /too large/.test(e.message));
});
