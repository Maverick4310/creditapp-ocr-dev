// 2026-10 (Large Packages) Downloads a Salesforce file for /title-docs/fetch.
//
// Apex holds a file in a 12 MB heap, so Salesforce can send at most about 11 MB itself. For
// larger files it sends the ContentVersion Id and this service downloads the bytes with the
// read-only "Title Docs Reader" login (External Client App, client credentials).
// Env: SF_LOGIN_URL (https://navitascredit.my.salesforce.com), SF_CLIENT_ID, SF_CLIENT_SECRET.
// Logs never carry file names or contents.
const API_VERSION = "v62.0";
// Client-credentials tokens carry no expiry; refresh well inside the org's session timeout.
const TOKEN_TTL_MS = 20 * 60 * 1000;
const VERSION_ID = /^068[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;

export class SfFileError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function makeSfFiles({ env = process.env, fetchImpl = fetch } = {}) {
  let cached = null; // { token, instanceUrl, at }

  const configured = () => !!(env.SF_LOGIN_URL && env.SF_CLIENT_ID && env.SF_CLIENT_SECRET);

  async function login(force) {
    if (!force && cached && Date.now() - cached.at < TOKEN_TTL_MS) return cached;
    const res = await fetchImpl(`${env.SF_LOGIN_URL.replace(/\/+$/, "")}/services/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: env.SF_CLIENT_ID,
        client_secret: env.SF_CLIENT_SECRET,
      }),
    });
    if (!res.ok) {
      console.error(`Salesforce login failed: HTTP ${res.status}`);
      throw new SfFileError(502, "The file could not be downloaded from Salesforce.");
    }
    const j = await res.json();
    cached = { token: j.access_token, instanceUrl: j.instance_url, at: Date.now() };
    return cached;
  }

  // ContentVersion Id → Buffer. Refuses files over maxBytes before reading them.
  async function download(versionId, maxBytes) {
    if (!configured()) throw new SfFileError(503, "Large files cannot be read yet.");
    if (!VERSION_ID.test(String(versionId || ""))) throw new SfFileError(400, "contentVersionId is not a file version Id.");
    for (let attempt = 0; attempt < 2; attempt++) {
      const s = await login(attempt > 0);
      const res = await fetchImpl(`${s.instanceUrl}/services/data/${API_VERSION}/sobjects/ContentVersion/${versionId}/VersionData`, {
        headers: { Authorization: `Bearer ${s.token}` },
      });
      if (res.status === 401 && attempt === 0) continue; // session expired: log in again once
      if (res.status === 404) throw new SfFileError(404, "The file could not be found in Salesforce.");
      if (!res.ok) {
        console.error(`Salesforce file download failed: HTTP ${res.status}`);
        throw new SfFileError(502, "The file could not be downloaded from Salesforce.");
      }
      const declared = Number(res.headers.get("content-length") || 0);
      if (declared > maxBytes) throw tooLarge(declared, maxBytes);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw tooLarge(buf.length, maxBytes);
      return buf;
    }
    throw new SfFileError(502, "The file could not be downloaded from Salesforce.");
  }

  return { configured, download };
}

function tooLarge(bytes, maxBytes) {
  return new SfFileError(413, `The file is too large to read automatically (${Math.round(bytes / 1048576)} MB; up to ${Math.round(maxBytes / 1048576)} MB).`);
}
