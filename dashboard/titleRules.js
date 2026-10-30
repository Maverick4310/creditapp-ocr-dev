// 2026-09 (Title Docs) Checks run on what /title-docs read from a titling package.
//
// Source: the Title Department's review (Titling Procedures approved 04/14/26, "What is
// checked" per document) and the validation ruleset in the Titling spec Rev 2, 5.2.
// Every check compares what the documents say against what Salesforce expects, so the
// same package always gets the same verdict. The model never decides pass/fail.
//
// Verdicts:
//   pass — the rule is met
//   fail — the rule is broken; the Title Department would send it back
//   warn — needs a person: judgment items (vendor name variations, auctions, one POA),
//          or a fact the documents cannot settle
//   na   — the rule does not apply to what was uploaded
//
// expected (all optional): {
//   dealNumber, customerName, vins: [], lienholder ("Navitas Credit LLC"),
//   referenceDate (YYYY-MM-DD, default today), payingOffLien, privateSale,
//   insuranceRequired, docType (the slot a single file was uploaded to), cost,
//   titlingState (two letters), titlingCounty, lienAdditionOnly   — 2026-10 (Titling answers)
// }

// 2026-10 (Titling answers) Title Department, 2 Oct 2026.
// Insurance is required in these titling states (not on a lien addition only).
export const INSURANCE_STATES = ["DC", "MN", "NC", "OR", "SC", "TN", "WV"];
// One remotely notarized (DocuSign) buyer POA is enough, except in these counties (originals only).
// 2026-10 (Titling testing 30 Oct) Not all of North Carolina: only the Kannapolis, Angier and Mooresville
// tag offices refuse electronic POAs (Cabarrus, Harnett and Iredell counties), per the NC state rules.
export const ORIGINAL_POA_COUNTIES = { NC: ["CABARRUS", "HARNETT", "IREDELL"] };
// The invoice or bill of sale must be signed by buyer and seller in these states (+ Broward County, FL).
export const INVOICE_SIGNATURE_STATES = ["AR", "CO", "GA", "IN", "KY", "LA", "MD", "NE", "SC", "TX", "VA"];
export const INVOICE_SIGNATURE_COUNTIES = { FL: ["BROWARD"] };
// Florida's Coral Springs tag agency (Broward County) needs wet-ink POAs.
export const WET_INK_POA_COUNTIES = { FL: ["BROWARD"] };
// 2026-10 (Titling answers 28 Oct) Navitas is not an LLC yet in these states, so a title naming Navitas
// Credit Corp as lienholder goes to Titling to approve there; everywhere else only the LLC passes.
export const CORP_NAME_STATES = ["CA", "VA"];
// 2026-10 (Titling answers 28 Oct) Documents whose every signer position must be signed. Invoices follow
// INVOICE_SIGNATURE_STATES, and the seller lines on assignments are checked by assignment_signed.
const SIGNED_DOC_TYPES = ["title_back", "reassignment_form", "title_application", "guaranty_of_title", "lien_release",
  "one_and_same_letter", "power_of_attorney", "equipment_finance_agreement", "titled_addendum", "other_addendum"];

const stateOf = (exp) => String(exp.titlingState || "").slice(0, 2).toUpperCase();
// 2026-10 (Sales samples) "Maine" or "ME" → "ME", to compare a title application with the sheet.
const STATE_NAMES = { ALABAMA: "AL", ALASKA: "AK", ARIZONA: "AZ", ARKANSAS: "AR", CALIFORNIA: "CA", COLORADO: "CO",
  CONNECTICUT: "CT", DELAWARE: "DE", "DISTRICT OF COLUMBIA": "DC", FLORIDA: "FL", GEORGIA: "GA", HAWAII: "HI", IDAHO: "ID",
  ILLINOIS: "IL", INDIANA: "IN", IOWA: "IA", KANSAS: "KS", KENTUCKY: "KY", LOUISIANA: "LA", MAINE: "ME", MARYLAND: "MD",
  MASSACHUSETTS: "MA", MICHIGAN: "MI", MINNESOTA: "MN", MISSISSIPPI: "MS", MISSOURI: "MO", MONTANA: "MT", NEBRASKA: "NE",
  NEVADA: "NV", "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ", "NEW MEXICO": "NM", "NEW YORK": "NY", "NORTH CAROLINA": "NC",
  "NORTH DAKOTA": "ND", OHIO: "OH", OKLAHOMA: "OK", OREGON: "OR", PENNSYLVANIA: "PA", "RHODE ISLAND": "RI",
  "SOUTH CAROLINA": "SC", "SOUTH DAKOTA": "SD", TENNESSEE: "TN", TEXAS: "TX", UTAH: "UT", VERMONT: "VT", VIRGINIA: "VA",
  WASHINGTON: "WA", "WEST VIRGINIA": "WV", WISCONSIN: "WI", WYOMING: "WY" };
const stateCode = (s) => {
  const t = String(s || "").toUpperCase().replace(/[^A-Z ]/g, " ").replace(/\s+/g, " ").trim();
  return STATE_NAMES[t] || (/^[A-Z]{2}$/.test(t) ? t : "");
};
const countyIn = (map, exp) => (map[stateOf(exp)] || [])
  .includes(String(exp.titlingCounty || "").toUpperCase().replace(/\s+COUNTY$/, "").trim());

const NOISE = new Set([
  "LLC", "L", "C", "INC", "INCORPORATED", "CORP", "CORPORATION", "CO", "COMPANY", "LTD",
  "LIMITED", "LP", "LLP", "PLLC", "PC", "PA", "THE", "DBA", "OF",
]);

export function nameKey(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/[&+]/g, " AND ")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !NOISE.has(w))
    .join("");
}

export function sameName(a, b) {
  const x = nameKey(a);
  const y = nameKey(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

const vinKey = (v) => String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
// 2026-10 (Sales samples) "1XP... / 5MA..." on a UCC-1 is two VINs, not one 34-character VIN.
const docVins = (d) => {
  const parts = String(d.vin || "").toUpperCase().split(/[\s,;/&+]+|\bAND\b/).map(vinKey).filter(Boolean);
  return parts.length > 1 && parts.every((x) => x.length === 17) ? parts : vinKey(d.vin) ? [vinKey(d.vin)] : [];
};

// Characters that are easily confused when a VIN is handwritten or read from a poor scan.
const LOOKALIKE = [["U", "V"], ["5", "S"], ["0", "O"], ["0", "D"], ["8", "B"], ["1", "I"], ["2", "Z"], ["6", "G"]];
const lookalike = (a, b) => LOOKALIKE.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
// "near" = same length and every difference is a look-alike pair (at most 2 of them).
function vinNear(a, b) {
  if (a.length !== b.length) return false;
  let diffs = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (!lookalike(a[i], b[i])) return false;
    diffs++;
  }
  return diffs > 0 && diffs <= 2;
}

// VIN check digit (position 9) for 17-character VINs. Tells which of two different VINs is
// real: a Salesforce VIN that fails it was keyed wrong; a document VIN that fails it was misread.
const TRANSLIT = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
export function vinValid(v) {
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += (/\d/.test(v[i]) ? Number(v[i]) : TRANSLIT[v[i]]) * WEIGHTS[i];
  const r = sum % 11;
  return v[8] === (r === 10 ? "X" : String(r));
}
// Edit distance: a handwritten VIN can gain or drop a character, not just change one.
function diffCount(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

// A check's detail often lists several documents ("title_front (file 1, p1): ...; invoice (...): ...").
// For one document keep only its own segments, plus segments that name no document at all.
const DOC_REF = /^[a-z_]+ \(file \d+, p[\d,]+\)/;
function ownPart(detail, ref) {
  // 2026-10 (Sales samples) A note can itself contain "; ". A piece without a document
  // reference belongs to the document named before it, not to every document.
  let owner = null;
  const kept = String(detail || "").split("; ").filter((x) => {
    if (DOC_REF.test(x)) owner = x.startsWith(ref) ? "mine" : "other";
    return owner === null || owner === "mine";
  });
  return kept.join("; ");
}

// Only Navitas documents carry the Navitas contract number.
const NAVITAS_DOCS = ["title_information_sheet", "power_of_attorney", "equipment_finance_agreement",
  "titled_addendum", "other_addendum", "one_and_same_letter"];
// "Luna Landscape Corp., 56 Park Lane, ..." → "Luna Landscape Corp."
// An address alone ("2990 Minnesota Ave, ...") has no name.
const NOT_A_NAME = /^\s*(\d|pick\s*-?\s*up|will\s*call|same|customer|n\/?a\b)/i;
const nameOnly = (s) => (NOT_A_NAME.test(String(s || "")) ? "" : String(s || "").split(/,\s*\d|\s\d{2,}/)[0].trim());
// "41630242-1" (schedule suffix) is contract 41630242.
const contractKey = (s) => digits(String(s || "").split(/[-/]/)[0]);
const NO_LIEN = /^(none|n\/?a|no liens?|-+)$/i;
const digits = (s) => String(s || "").replace(/\D/g, "");

function days(fromIso, toIso) {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

const where = (d) => `${d.type} (file ${d.file_index + 1}, p${(d.pages || []).join(",")})`;

const SLOT_TYPES = {
  "Title/MSO Front": ["title_front", "mso"],
  "Title/MSO Back": ["title_back", "reassignment_form", "mso"],
  "Guaranty of Title": ["guaranty_of_title"],
  "Lien Release": ["lien_release"],
  "Invoice / Bill of Sale": ["invoice", "bill_of_sale", "auction_document"],
  "Driver's License": ["drivers_license"],
  "Proof of Insurance": ["insurance"],
  "POA - Buyer": ["power_of_attorney"],
  "POA - Seller": ["power_of_attorney"],
  // 2026-10 (TITAN EFA slot) Titling opens the EFA to confirm the VIN and model.
  "EFA": ["equipment_finance_agreement"],
};

// 2026-10 (Titling testing 23 Oct) Notes the Titling Manager confirmed are normal, so they never send a
// document to review: the "previous owner" line some titles print, a second POA (two originals are often
// required), and the same odometer reading on more than one assignment.
const NORMAL_NOTES = [
  { types: null, re: /\b(previous|prior) owner/i },
  { types: ["power_of_attorney"], re: /\b(duplicate|second|2nd|another copy)\b/i },
  { types: ["title_front", "title_back", "mso", "reassignment_form", "title_application"],
    re: /odometer.*\b(same|duplicat\w*|identical|matching)\b|\b(same|duplicat\w*|identical|matching)\b.*odometer/i },
];
// 2026-10 (Titling testing 30 Oct) The reader described an MSO back used as the reassignment form and
// the blank reassignment blocks after the last one used: both normal (41703857, 41411556). So is a
// supplemental insurance page ("Additional Remarks Schedule") that only continues the certificate.
NORMAL_NOTES.push(
  { types: ["title_back", "reassignment_form", "mso"],
    re: /\b(remaining|other|unused|subsequent|later)\b.*\bblank\b|\bblank\b.*\b(remaining|unused)\b|\bonly (the )?first\b.*\b(filled|completed|used)\b/i },
  { types: ["title_back", "reassignment_form", "mso"],
    re: /\b(back|reverse)( side)? of (the )?(MSO|certificate of origin|title|manufacturer)/i },
  { types: ["insurance"], re: /\b(additional remarks|supplement\w*|continuation)\b/i },
);
const normalNote = (type, n) => NORMAL_NOTES.some((x) => (!x.types || x.types.includes(type)) && x.re.test(n));
// 2026-10 (UCB call, 41708906) A note saying a signature is missing, on a document whose signature fields
// were read as signed or "couldn't tell", contradicts the reader's own answer. The fields (and the
// invoice_signed check, where a state requires signatures) decide; only a signature read as missing stays.
const SIGNATURE_FIELDS = ["seller_signed", "buyer_signed", "signed_by_customer"];
const UNSIGNED_NOTE = /\bunsigned\b|\bnot (been )?signed\b|\bno (visible )?signature|\bsignature(s| lines?)? (is |are |appears? |appear )?(blank|missing|absent)/i;
const contradictedNote = (d, n) => UNSIGNED_NOTE.test(n)
  && SIGNATURE_FIELDS.some((f) => f in d) && !SIGNATURE_FIELDS.some((f) => d[f] === false)
  && !(d.signatures || []).some((x) => x.signed === false);

// 2026-10 (Titling testing 30 Oct) Trailers have no odometer, so no reading is expected on their
// assignments (41703857, 41411556). A trailer by its body type or name on the document, or by the
// sheet's vehicle type ("TRL - Trailer") that Salesforce sends with each vehicle.
// "TR" is a truck in Salesforce's body-type map, so only TRL / TL / TRLR / SEMI / TRAILER count.
const TRAILER = /\b(TRL|TL|TRLR|SEMI)\b|TRAILER/i;
const docTrailer = (d) => TRAILER.test(String(d.body_type || "")) || /TRAILER/i.test(`${d.make || ""} ${d.model || ""}`);

export function runChecks(extraction, expected = {}) {
  const docs = (extraction && extraction.documents) || [];
  const exp = { lienholder: "Navitas Credit LLC", ...expected };
  // 2026-10 (Titling answers) Salesforce sends the titling state; an explicit flag still wins.
  if (exp.insuranceRequired === undefined && exp.titlingState) {
    exp.insuranceRequired = INSURANCE_STATES.includes(stateOf(exp)) && !exp.lienAdditionOnly;
  }
  const sheetTrailer = (vin) => (exp.vehicles || []).some((v) => v && /^TRL/i.test(String(v.type || ""))
    && (!vin || !vinKey(v.vin) || vinKey(v.vin) === vin));
  const allTrailers = (exp.vehicles || []).length > 0 && exp.vehicles.every((v) => v && /^TRL/i.test(String(v.type || "")));
  for (const d of docs) {
    if (!d.notes) continue;
    d.notes = d.notes.filter((n) => !normalNote(d.type, n) && !contradictedNote(d, n)
      // A trailer's missing odometer is not worth a note either.
      && !(/odometer|mileage/i.test(n) && (docTrailer(d) || allTrailers))
      // 2026-10 (Titling testing 30 Oct) Where insurance is not required the certificate is not checked,
      // so its notes are not either.
      && !(d.type === "insurance" && exp.insuranceRequired === false));
  }
  // "NAVITAS, 201 EXECUTIVE CENTER DR ..." is Navitas too.
  const isNavitas = (name) => sameName(nameOnly(name) || name, exp.lienholder) || /^NAVITAS/.test(nameKey(name));
  const isCorpName = (name) => /\bNAVITAS\s+CREDIT\s+CORP(ORATION)?\b/i.test(String(name || ""));
  // 2026-10 (Titling testing 23 Oct) Navitas's lienholder address, word by word; "201 Executive Dr" is wrong.
  const navitasAddressOk = (text) => {
    const t = " " + String(text || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ") + " ";
    return / 201 /.test(t) && / EXECUTIVE CENTER /.test(t) && / (DR|DRIVE) /.test(t) && / (STE|SUITE|#)? ?100 /.test(t)
      && / COLUMBIA /.test(t) && / (SC|SOUTH CAROLINA) /.test(t) && / 29210 /.test(t);
  };
  const today = exp.referenceDate || new Date().toISOString().slice(0, 10);
  const of = (...types) => docs.filter((d) => types.includes(d.type));
  const checks = [];
  const roles = new Map();   // POA document → "buyer" / "seller", for filing
  const add = (id, label, status, detail, evidence = []) =>
    checks.push({ id, label, status, detail, evidence });

  // ── The upload itself ────────────────────────────────────────────────
  if (exp.docType && SLOT_TYPES[exp.docType]) {
    const want = SLOT_TYPES[exp.docType];
    const found = docs.map((d) => d.type);
    const ok = found.some((t) => want.includes(t));
    add("right_document", `Uploaded file is a ${exp.docType}`, ok ? "pass" : "fail",
      ok ? "Document type matches the slot." : `Found ${found.join(", ") || "nothing readable"} instead.`,
      docs.map(where));
  }

  // Broker / portfolio deals: the broker's documents carry the broker's contract numbers, the
  // broker's lender may be on the title, and the broker (not the customer) gives Navitas a POA
  // (Titling Procedures: portfolio purchase and service-released contracts).
  const efaDocs = of("equipment_finance_agreement");
  const brokerPoas = of("power_of_attorney").filter((d) => d.poa_grantee && isNavitas(d.poa_grantee));
  const brokerEfa = efaDocs.find((d) => d.secured_party && !isNavitas(d.secured_party));
  const broker = !!(exp.brokerDeal || brokerPoas.length || brokerEfa);
  if (broker) {
    add("broker_deal", "Partner Funding (PFC / PFA) or broker documents", "warn",
      "Division or broker documents (" + [exp.brokerDeal ? "deal is PFC / PFA" : "", brokerPoas.length ? "POA granted to Navitas" : "", brokerEfa ? `EFA secured party ${brokerEfa.secured_party}` : ""]
        .filter(Boolean).join("; ") + "). Broker contract numbers and the broker's lienholder are expected; the analyst confirms the assignment to Navitas.",
      [...brokerPoas, ...(brokerEfa ? [brokerEfa] : [])].map(where));
  }
  const brokerDoc = (d) => brokerPoas.includes(d)
    || (brokerEfa && contractKey(d.contract_number) && contractKey(d.contract_number) === contractKey(brokerEfa.contract_number))
    || (exp.brokerDeal && contractKey(d.contract_number).length < 8);

  // An unreadable DocuSign certificate or "other" page is worth a look, not a rejection.
  const SUPPORTING = ["notary_or_signing_certificate", "other", "other_addendum"];
  const unreadable = docs.filter((d) => d.legible === false);
  // 2026-10 (Sales samples) A scan the reader marks hard to read "but key fields are readable"
  // (a watermark, a distorted copy) is for the analyst to look at, not a rejection.
  const stillReadable = (d) => /(?<!\bun|\bnot |\bil)\b(readable|legible)\b/i.test(d.legibility_note || "")
    && !/\b(unreadable|illegible|not (readable|legible))\b/i.test(d.legibility_note || "");
  const keyUnreadable = unreadable.filter((d) => !SUPPORTING.includes(d.type) && !stillReadable(d));
  add("legible", "Every document is legible",
    docs.length === 0 || keyUnreadable.length ? "fail" : unreadable.length ? "warn" : "pass",
    docs.length === 0 ? "No document could be read."
      : unreadable.length ? unreadable.map((d) => `${where(d)}: ${d.legibility_note || "not readable"}`).join("; ")
        : `${docs.length} document(s) read.`,
    unreadable.map(where));

  // ── Does it belong to this deal? ─────────────────────────────────────
  if (exp.dealNumber) {
    const numbered = docs.filter((d) => NAVITAS_DOCS.includes(d.type) && contractKey(d.contract_number) && !brokerDoc(d));
    const wrong = numbered.filter((d) => contractKey(d.contract_number) !== contractKey(exp.dealNumber));
    add("belongs_to_deal", `Documents are for contract ${exp.dealNumber}`,
      numbered.length === 0 ? "na" : wrong.length ? "fail" : "pass",
      numbered.length === 0 ? "No contract number printed on the documents."
        : wrong.length ? wrong.map((d) => `${where(d)} shows ${d.contract_number}`).join("; ")
          : `${numbered.length} document(s) carry the contract number.`,
      wrong.map(where));
  }

  const vins = (exp.vins || []).map(vinKey).filter(Boolean);
  const vinVerdict = {};   // document VIN → "different" (another vehicle) or "explained" (keyed wrong / misread)
  const withVin = docs.filter((d) => vinKey(d.vin) && d.type !== "insurance");
  if (vins.length) {
    // Each document VIN that is not on the deal is explained: Salesforce keyed wrong (its VIN fails
    // the check digit, the document's passes), a misread (the reverse, or look-alike characters),
    // or a different vehicle.
    const offVin = (d) => docVins(d).find((v) => !vins.includes(v));
    const off = withVin.filter((d) => offVin(d));
    const explain = (d) => {
      const doc = offVin(d);
      const close = vins.find((v) => diffCount(doc, v) <= 2);
      if (close && vinValid(doc) && !vinValid(close)) {
        return { status: "fail", text: `${where(d)}: ${d.vin}. The Salesforce VIN ${close} fails the VIN check digit and this one passes — correct the VIN in LeaseWorks.` };
      }
      if (close && (!vinValid(doc) && vinValid(close) || vinNear(doc, close))) {
        return { status: "warn", text: `${where(d)}: read as ${d.vin}, close to ${close} — likely a misread; check by eye.` };
      }
      return { status: "fail", text: `${where(d)}: ${doc} is a different vehicle.` };
    };
    const found = off.map(explain);
    off.forEach((d, i) => { vinVerdict[offVin(d)] = found[i].status === "fail" && /different vehicle/.test(found[i].text) ? "different" : "explained"; });
    add("vin_match", "VIN matches the vehicle",
      withVin.length === 0 ? "warn" : found.some((f) => f.status === "fail") ? "fail" : found.length ? "warn" : "pass",
      withVin.length === 0 ? "No VIN could be read."
        : found.length ? found.map((f) => f.text).join("; ")
          : `VIN ${vins.join(", ")} on ${withVin.length} document(s).`,
      off.map(where));
  } else if (withVin.length > 1) {
    const distinct = [...new Set(withVin.map((d) => vinKey(d.vin)))];
    add("vin_consistent", "Same VIN on every document", distinct.length === 1 ? "pass" : "warn",
      distinct.length === 1 ? `VIN ${distinct[0]}.` : `Different VINs: ${distinct.join(", ")}.`, withVin.map(where));
  }

  // 2026-10 (TITAN EFA slot) The equipment on the EFA (year, make, model) against the vehicle in Salesforce.
  // The VIN is checked above with every other document. A review, never a failure: models are written many ways.
  const cars = (exp.vehicles || []).filter((v) => v && (v.year || v.make || v.model));
  const efaRead = of("equipment_finance_agreement").filter((d) => d.year || d.make || d.model);
  if (cars.length && efaRead.length) {
    const word = (x) => String(x || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
    const sameWords = (a, b) => !word(a) || !word(b) || word(a).includes(word(b)) || word(b).includes(word(a));
    const sameMake = (a, b) => !word(a) || !word(b) || word(a).slice(0, 4) === word(b).slice(0, 4);
    const sameYear = (a, b) => !digits(a) || !digits(b) || digits(a).slice(-2) === digits(b).slice(-2);
    const off = [];
    efaRead.forEach((d) => {
      const car = cars.find((v) => vinKey(v.vin) && docVins(d).includes(vinKey(v.vin))) || (cars.length === 1 ? cars[0] : null);
      if (!car) return;
      const diff = [];
      if (!sameYear(d.year, car.year)) diff.push(`year ${d.year} (Salesforce ${car.year})`);
      if (!sameMake(d.make, car.make)) diff.push(`make ${d.make} (Salesforce ${car.make})`);
      if (!sameWords(d.model, car.model)) diff.push(`model ${d.model} (Salesforce ${car.model})`);
      if (diff.length) off.push({ d, text: `${where(d)}: ${diff.join(", ")}` });
    });
    add("efa_equipment", "Equipment on the EFA matches the vehicle", off.length ? "warn" : "pass",
      off.length ? off.map((o) => o.text).join("; ") : "Year, make and model match.", off.map((o) => where(o.d)));
  }

  // 2026-10 (Sales samples) The title application names the state the vehicle is being titled in.
  // One for another state means the sheet's titling state is out of date (or a vehicle is titled elsewhere).
  if (stateOf(exp)) {
    const apps = of("title_application").filter((d) => stateCode(d.title_state));
    const elsewhere = apps.filter((d) => stateCode(d.title_state) !== stateOf(exp));
    if (apps.length) {
      add("titling_state_matches", `Title application is for the sheet's titling state (${stateOf(exp)})`,
        elsewhere.length ? "warn" : "pass",
        elsewhere.length ? elsewhere.map((d) => `${where(d)}: ${stateCode(d.title_state)} application`).join("; ")
          + ` — the sheet says ${stateOf(exp)}. Update the sheet's titling state, or confirm the vehicle is titled there.`
          : `${apps.length} title application(s) for ${stateOf(exp)}.`,
        elsewhere.map(where));
    }
  }

  // ── Title: no title, no review ────────────────────────────────────────
  const titles = of("title_front", "mso", "guaranty_of_title");
  const backs = of("title_back", "reassignment_form");
  const eTitle = of("electronic_title_copy");
  const titleRelevant = !exp.docType || ["Title/MSO Front", "Title/MSO Back", "Guaranty of Title"].includes(exp.docType);

  if (titleRelevant) {
    add("title_present", "A title, MSO or Guaranty of Title is present",
      titles.length || eTitle.length ? "pass" : exp.docType === "Title/MSO Back" ? "na" : "fail",
      titles.length ? titles.map(where).join("; ") : eTitle.length ? "Electronic title copy only." : "No title found. No title, no review.",
      titles.map(where));

    // 2026-09 (Title Package) One group per vehicle: a title front / MSO / GOT and the back or
    // reassignment pages that follow it until the next one. A file with four trailer titles is
    // four groups; each is checked on its own. Backs before any front form their own group.
    const groups = [];
    [...titles, ...backs, ...eTitle]
      .sort((a, b) => (a.file_index - b.file_index) || ((a.pages || [0])[0] - (b.pages || [0])[0]))
      .forEach((d) => {
        const starts = ["title_front", "mso", "guaranty_of_title", "electronic_title_copy"].includes(d.type);
        if (starts || !groups.length) groups.push({ head: starts ? d : null, docs: [d] });
        else groups[groups.length - 1].docs.push(d);
      });
    const many = groups.length > 1;
    groups.forEach((g) => checkTitleGroup(g, many));

    function checkTitleGroup(g, labelled) {
      const vin = g.docs.map((d) => vinKey(d.vin)).find(Boolean);
      const tag = labelled ? ` (${vin ? "VIN " + vin : where(g.docs[0])})` : "";
      const gTitles = g.docs.filter((d) => ["title_front", "mso", "guaranty_of_title"].includes(d.type));
      const gBacks = g.docs.filter((d) => ["title_back", "reassignment_form"].includes(d.type));
      const gE = g.docs.filter((d) => d.type === "electronic_title_copy");

      if (g.head && g.head.type === "title_front" && !exp.docType) {
        add("title_back_present", "Title back or reassignment is present" + tag, gBacks.length ? "pass" : "fail",
          gBacks.length ? gBacks.map(where).join("; ") : "Title front without its back: the assignment cannot be checked.",
          [where(g.head)]);
      }

      // Unreleased liens
      const lienDocs = [...gTitles, ...gE];
      const liens = lienDocs.flatMap((d) => (d.lienholders || []).map((l) => ({ ...l, doc: d })))
        .filter((l) => l.name && !NO_LIEN.test(String(l.name).trim()));
      const foreign = liens.filter((l) => !isNavitas(l.name) && l.released !== true);
      if (lienDocs.length) {
        const releaseDoc = of("lien_release").filter((d) => !vin || !vinKey(d.vin) || vinKey(d.vin) === vin);
        let status = "pass";
        let detail = lienDocs.some((d) => d.no_liens_stated) ? "Title states no liens." : "No other lienholder shown.";
        if (foreign.length) {
          detail = `Unreleased lien: ${foreign.map((l) => l.name).join(", ")}.`;
          if (releaseDoc.length) { status = "pass"; detail += " Lien release provided."; }
          else if (exp.payingOffLien) { status = "warn"; detail += " Navitas is paying it off — confirm the payoff."; }
          else if (broker) { status = "warn"; detail += " Broker deal — confirm the lien is assigned to Navitas or released."; }
          else status = "fail";
        }
        add("unreleased_liens", "No unreleased lien on the title" + tag, status, detail, lienDocs.map(where));
      }

      // Assignment chain
      const assignments = [...gTitles, ...gBacks].flatMap((d) => (d.assignments || []).map((a) => ({ ...a, doc: d })))
        .filter((a) => a.buyer_name || a.seller_name);
      if (!gTitles.length && !gBacks.length) return;
      if (!assignments.length) {
        // No assignment filled in: fine only when the title is already in the customer's name
        // (lien addition). A title still in the seller's name has not been signed over yet.
        const owners = gTitles.flatMap((d) => d.owner_names || []).filter(Boolean);
        const ownerIsCustomer = exp.customerName && owners.some((o) => sameName(o, exp.customerName));
        if (exp.customerName && owners.length && !ownerIsCustomer) {
          add("chain_to_customer", "Last assignment is to our customer" + tag, "fail",
            `Title is still in ${owners.join(", ")}'s name and has not been assigned to the customer.`,
            g.docs.map(where));
        } else {
          add("chain_to_customer", "Last assignment is to our customer" + tag, "warn",
            ownerIsCustomer ? "Title is already in the customer's name (lien addition only)."
              : "No filled-in assignment found — the title may already be in the customer's name (lien addition only).",
            g.docs.map(where));
        }
        return;
      }
      const last = assignments[assignments.length - 1];
      const ok = exp.customerName ? sameName(last.buyer_name, exp.customerName) : null;
      add("chain_to_customer", "Last assignment is to our customer" + tag,
        ok === null ? "warn" : ok ? "pass" : "fail",
        !last.buyer_name ? `The buyer's name is blank on the last assignment (from ${last.seller_name || "the seller"}).`
          : `Last assignment: ${last.seller_name || "?"} → ${last.buyer_name}` + (ok === false ? `; expected ${exp.customerName}.` : "."),
        [where(last.doc)]);
      const unsigned = assignments.filter((a) => a.seller_signed === false);
      if (unsigned.length) {
        add("assignment_signed", "Seller signed every assignment" + tag, "fail",
          unsigned.map((a) => `${a.seller_name || "seller"} → ${a.buyer_name || "buyer"} not signed`).join("; "),
          unsigned.map((a) => where(a.doc)));
      }
      // 2026-10 (Titling testing 23 Oct) Every assignment carries an odometer reading ("EXEMPT" counts);
      // the same reading on two assignments is fine. Review, not a failure, until Titling signs off.
      const trailer = g.docs.some(docTrailer) || sheetTrailer(vin) || allTrailers;
      const noOdometer = trailer ? [] : assignments.filter((a) => !String(a.odometer || "").trim());
      if (noOdometer.length) {
        add("assignment_odometer", "Every assignment shows an odometer reading" + tag, "warn",
          noOdometer.map((a) => `${a.seller_name || "seller"} → ${a.buyer_name || "buyer"}: no odometer reading`).join("; "),
          noOdometer.map((a) => where(a.doc)));
      }
      const named = last.new_lienholder;
      // 2026-10 (Titling testing 23 Oct) Navitas written in a lienholder box ("1st lien in favor of") on the
      // title, MSO or reassignment counts too (41444028 had it there, not on the assignment).
      const boxLien = !named && [...gTitles, ...gBacks, ...gE].flatMap((d) => (d.lienholders || []).map((l) => ({ ...l, doc: d })))
        .find((l) => l.name && isNavitas(l.name));
      // 2026-10 (Titling answers) Virginia reassignments have no lienholder section: Navitas goes on
      // the title application, added after booking (Titling Manager, 2 Oct 2026).
      const noLienSection = !named && !boxLien && stateOf(exp) === "VA";
      add("lienholder_on_assignment", `${exp.lienholder} is named as new lienholder` + tag,
        // 2026-10 (Titling testing 30 Oct) Nothing written is normal: many assignments (an MSO back) have no
        // lienholder section, and Navitas's lien goes on the title application after booking (41411556).
        noLienSection || !named && !boxLien ? "na" : boxLien ? "pass" : isNavitas(named) ? "pass" : broker ? "warn" : "fail",
        noLienSection ? "Virginia reassignments have no lienholder section; Navitas goes on the title application after booking."
          : boxLien ? `${boxLien.name} is written in the lienholder box (${where(boxLien.doc)}).`
            : !named ? "No lienholder written on the assignment; Navitas's lien goes on the title application after booking."
              : `New lienholder written: ${named}.`,
        [where(boxLien ? boxLien.doc : last.doc)]);
      // 2026-10 (Titling answers 28 Oct) Only Navitas Credit LLC passes; Navitas Credit Corp is for Titling
      // to approve in CA and VA, where Navitas is not an LLC yet.
      const lienName = boxLien ? boxLien.name : named && isNavitas(named) ? named : null;
      if (lienName && isCorpName(lienName)) {
        const allowed = CORP_NAME_STATES.includes(stateOf(exp));
        add("lienholder_llc", `Lienholder is ${exp.lienholder}, not Navitas Credit Corp` + tag, allowed ? "warn" : "fail",
          allowed ? `${lienName} is written. Navitas is not an LLC in ${stateOf(exp)} yet, so Titling approves it.`
            : `${lienName} is written. Only ${exp.lienholder} is accepted (Corp is allowed only in ${CORP_NAME_STATES.join(" and ")}).`,
          [where(boxLien ? boxLien.doc : last.doc)]);
      }
      // 2026-10 (Titling testing 23 Oct) Navitas's address as written, where one was written.
      const written = boxLien ? boxLien.address : named && isNavitas(named) ? (last.new_lienholder_address || named) : null;
      // 2026-10 (UCB call, 41708906) Handwriting the reader is unsure of ("201" read as 401) is a "please look",
      // never a claim that the address is wrong.
      const unclear = (boxLien ? boxLien.address_clear : last.new_lienholder_address_clear) === false;
      if (written && /\d/.test(written)) {
        const ok = navitasAddressOk(written);
        add("lienholder_address", `${exp.lienholder}'s address is correct` + tag, ok ? "pass" : "warn",
          ok ? `${written}.`
            : unclear ? `Handwritten and hard to read (read as: ${written}). Please check it reads 201 Executive Center Dr, Suite 100, Columbia, SC 29210.`
              : `Written: ${written}. Expected 201 Executive Center Dr, Suite 100, Columbia, SC 29210.`,
          [where(boxLien ? boxLien.doc : last.doc)]);
      }
    }
  }

  // ── Invoice / bill of sale ───────────────────────────────────────────
  const invoices = of("invoice", "bill_of_sale", "auction_document");
  const efa = of("equipment_finance_agreement")[0];
  if (invoices.length) {
    const inv = invoices.find((d) => d.document_date) || invoices[0];
    const age = inv.document_date ? days(inv.document_date, today) : null;
    add("invoice_recent", "Invoice dated within the last 30 days",
      age === null ? "warn" : age > 30 ? "fail" : "pass",
      age === null ? "No invoice date could be read." : `Dated ${inv.document_date} (${age} day(s) old; 5 or fewer preferred).`,
      [where(inv)]);

    // 2026-10 (Titling answers) Buyer and seller must sign the invoice or bill of sale in these states.
    // The spreadsheet says DDI can sign for the buyer with the POA, so a missing buyer signature is a review.
    if (!exp.lienAdditionOnly && (INVOICE_SIGNATURE_STATES.includes(stateOf(exp)) || countyIn(INVOICE_SIGNATURE_COUNTIES, exp))) {
      const signed = invoices.filter((d) => d.type !== "auction_document");
      const noSeller = signed.filter((d) => d.seller_signed === false);
      const noBuyer = signed.filter((d) => d.buyer_signed === false);
      const unread = signed.filter((d) => d.seller_signed == null || d.buyer_signed == null);
      const where_ = exp.titlingCounty && countyIn(INVOICE_SIGNATURE_COUNTIES, exp) ? `${exp.titlingCounty} County, ${stateOf(exp)}` : stateOf(exp);
      add("invoice_signed", `Invoice signed by buyer and seller (${where_})`,
        noSeller.length ? "fail" : noBuyer.length || unread.length ? "warn" : "pass",
        noSeller.length ? noSeller.map((d) => `${where(d)}: no seller signature`).join("; ")
          : noBuyer.length ? noBuyer.map((d) => `${where(d)}: no buyer signature — DDI can sign for the buyer with the POA`).join("; ")
            : unread.length ? "Signatures could not be read." : "Signed by buyer and seller.",
        [...noSeller, ...noBuyer, ...unread].map(where));
    }

    const buyer = exp.customerName || (efa && efa.customer_legal_name);
    if (buyer) {
      const bad = invoices.filter((d) => (nameOnly(d.sold_to) && !sameName(nameOnly(d.sold_to), buyer))
        || (nameOnly(d.ship_to) && !sameName(nameOnly(d.ship_to), buyer)));
      // 2026-10 (Titling ruling) Never billed to Navitas: titled equipment is on security agreements, not leases.
      const toNavitas = bad.some((d) => isNavitas(d.sold_to || "") || isNavitas(d.ship_to || ""));
      add("invoice_customer", "Invoice Sold To and Ship To are the customer", bad.length ? "fail" : "pass",
        bad.length ? bad.map((d) => `${where(d)}: sold to ${d.sold_to || "?"}, ship to ${d.ship_to || "?"}`).join("; ") +
          (toNavitas ? ". Invoices must be in the customer's name; Navitas uses security agreements, not leases, for titled equipment. Ask the vendor to reissue." : "")
          : `Matches ${buyer}.`, bad.map(where));
    }

    if (efa && efa.pay_proceeds_vendor && inv.vendor_name) {
      const same = sameName(efa.pay_proceeds_vendor, inv.vendor_name);
      const letter = of("one_and_same_letter").length > 0;
      // Pay proceeds may go to the customer on a sale-leaseback or reimbursement (Titling Procedures, funding checklist).
      const toCustomer = buyer && sameName(efa.pay_proceeds_vendor, buyer);
      add("vendor_matches_pay_proceeds", "Invoice vendor matches the pay proceeds vendor",
        same ? "pass" : letter || toCustomer ? "warn" : "fail",
        same ? `${inv.vendor_name}.`
          : `Invoice: ${inv.vendor_name}; pay proceeds: ${efa.pay_proceeds_vendor}.` +
            (letter ? " A one-and-the-same letter is included — analyst to confirm." : "") +
            (toCustomer ? " Pay proceeds go to the customer (sale-leaseback or reimbursement) — analyst to confirm." : ""),
        [where(inv), where(efa)]);
    }

    // Sum invoice totals; copies of the same invoice (same VIN and total) count once. Two trucks
    // at the same price are two invoices (2026-10, Sales samples). Financing more than the
    // invoice is normal when taxes, fees or other equipment are financed — review, not a failure.
    const byInvoice = new Map();
    invoices.filter((d) => d.total_amount != null).forEach((d) => byInvoice.set(`${docVins(d).join(",")}|${d.total_amount}`, d.total_amount));
    const totals = [...byInvoice.values()];
    const invoiceTotal = totals.reduce((a, b) => a + b, 0);
    if (efa && efa.amount_financed != null && totals.length) {
      const diff = Math.round((invoiceTotal - efa.amount_financed) * 100) / 100;
      const fmt = (n) => "$" + n.toLocaleString();
      // 2026-10 (Titling testing 23 Oct) A down payment on the invoice that covers the gap (within $5,
      // or the printed balance due equals the amount financed) is correct (41458567).
      const down = invoices.reduce((n, d) => n + (Number(d.down_payment) || 0), 0);
      const balances = invoices.map((d) => d.balance_due).filter((x) => x != null);
      const byDown = diff > 0 && down > 0 && Math.abs(diff - down) <= 5;
      const byBalance = diff > 0 && balances.length === invoices.length
        && Math.abs(balances.reduce((a, b) => a + b, 0) - efa.amount_financed) <= 5;
      add("amount_financed_vs_invoice", "Amount financed matches the invoice",
        diff === 0 || byDown || byBalance ? "pass" : "warn",
        diff === 0 ? `${fmt(efa.amount_financed)}.`
          : byDown || byBalance ? `Invoice ${fmt(invoiceTotal)} less the down payment ${fmt(down || diff)} matches ${fmt(efa.amount_financed)} financed.`
          : diff > 0 ? `Invoice ${fmt(invoiceTotal)} is ${fmt(diff)} more than financed — a down payment?`
            : `Financed ${fmt(efa.amount_financed)} is ${fmt(-diff)} more than the invoice ${fmt(invoiceTotal)} — taxes, fees or other equipment financed?`,
        [...invoices.map(where), where(efa)]);
    }

    const auction = invoices.filter((d) => d.is_auction || d.type === "auction_document");
    if (auction.length) {
      add("auction_sale", "Auction or consignment sale", "warn",
        "Auction or consignment: seller authorization is needed if the title is not signed by the seller.",
        auction.map(where));
    }
  }

  // ── Powers of attorney ───────────────────────────────────────────────
  const poas = of("power_of_attorney");
  if (poas.length || (!exp.docType && titles.length)) {
    // Role by name first: a POA granted by our customer is a buyer POA, whatever the model called it.
    const customer = exp.customerName || (efa && efa.customer_legal_name);
    // A seller POA is granted by the party selling the vehicle: the title owner or an assignor.
    // Anyone else (the customer, or its owner signing personally) is a buyer.
    const sellers = [...titles.flatMap((d) => d.owner_names || []),
      ...[...titles, ...backs].flatMap((d) => (d.assignments || []).map((a) => a.seller_name))].filter(Boolean);
    const roleOf = (d) => {
      if (d.poa_owner_name && customer && sameName(d.poa_owner_name, customer)) return "buyer";
      if (d.poa_owner_name && sellers.some((x) => sameName(x, d.poa_owner_name))) return "seller";
      if (d.poa_owner_name && sellers.length) return "buyer";
      return d.poa_role === "seller" ? "seller" : "buyer";
    };
    poas.forEach((d) => { roles.set(d, roleOf(d)); });
    const buyerPoas = poas.filter((d) => roleOf(d) === "buyer");
    const sellerPoas = poas.filter((d) => roleOf(d) === "seller");
    // A POA whose notary block says "see attached" is notarized by a separate acknowledgment page
    // (California requires its own form) — that is for the analyst to match, not a failure.
    const acknowledgments = of("notary_acknowledgment");
    const attached = (d) => d.notarized !== true && acknowledgments.length > 0 && (d.notarized === null || d.notarized === undefined
      || (d.notes || []).some((n) => /acknowledg|see attached/i.test(n)));
    const viaAttached = poas.filter(attached);
    const bad = poas.filter((d) => !attached(d) && (d.notarized !== true || (d.notary_date && d.signature_date && d.notary_date !== d.signature_date)));
    if (poas.length) {
      add("poa_notarized", "Each POA is notarized on the day it was signed", bad.length ? "fail" : viaAttached.length ? "warn" : "pass",
        bad.length ? bad.map((d) => d.notarized !== true ? `${where(d)}: not notarized`
          : `${where(d)}: signed ${d.signature_date}, notarized ${d.notary_date}`).join("; ")
          : viaAttached.length ? `${viaAttached.length} POA(s) notarized by an attached acknowledgment — check each acknowledgment matches its POA.`
            : `${poas.length} POA(s)` + (poas.some((d) => d.remote_online_notarization) ? " (remote online notarization)." : "."),
        bad.map(where));
      if (vins.length) {
        // Only a POA for another vehicle fails here; keyed-wrong or misread VINs are reported by vin_match.
        const wrongVin = poas.filter((d) => docVins(d).some((v) => !vins.includes(v) && vinVerdict[v] !== "explained"));
        if (wrongVin.length) add("poa_vin", "POA lists this vehicle's VIN", "fail",
          wrongVin.map((d) => `${where(d)}: ${d.vin}`).join("; "), wrongVin.map(where));
      }
    }
    if (!exp.docType && broker && brokerPoas.length) {
      add("poa_count", "Broker POA to Navitas", "pass", `${brokerPoas.length} broker POA(s) granted to Navitas.`, brokerPoas.map(where));
    } else if (!exp.docType) {
      // 2026-10 (Titling answers) One remotely notarized POA is enough; two if originals; originals only in
      // the NC counties whose tag offices refuse electronic POAs.
      const originalsOnly = countyIn(ORIGINAL_POA_COUNTIES, exp);
      const county = `${String(exp.titlingCounty || "").replace(/\s+county$/i, "").trim()} County, ${stateOf(exp)}`;
      const eBuyer = buyerPoas.filter((d) => d.remote_online_notarization);
      const originals = buyerPoas.filter((d) => !d.remote_online_notarization);
      const met = originalsOnly ? originals.length >= 2 : eBuyer.length > 0 || originals.length >= 2;
      add("poa_count", originalsOnly ? `Two original buyer POAs (${county})` : "Buyer POA: one notarized online, or two originals",
        met ? "pass" : "fail",
        met ? (eBuyer.length && !originalsOnly ? `${eBuyer.length} buyer POA(s) notarized online.` : `${originals.length} original buyer POAs.`)
          : originalsOnly && eBuyer.length ? `${county} takes original POAs only; ${eBuyer.length} notarized online, ${originals.length} original.`
            : originals.length === 1 ? "One original buyer POA. Two originals are needed, or one notarized online."
              : "No buyer POA found.",
        buyerPoas.map(where));
      if (eBuyer.length && countyIn(WET_INK_POA_COUNTIES, exp)) {
        add("poa_wet_ink", "Wet-ink POA for this county", "warn",
          `${exp.titlingCounty} County (Coral Springs tag agency) does not accept DocuSign POAs; wet ink is needed if it goes there.`,
          eBuyer.map(where));
      }
      if (exp.privateSale) {
        add("seller_poa", "Seller POA on a private sale", sellerPoas.length ? "pass" : "fail",
          sellerPoas.length ? "Seller POA present." : "Private sale without a seller POA.", sellerPoas.map(where));
      }
    }
  }

  // ── Driver's license ─────────────────────────────────────────────────
  const licenses = of("drivers_license");
  if (licenses.length) {
    const expired = licenses.filter((d) => d.license_expiration && days(today, d.license_expiration) < 0);
    const unknown = licenses.filter((d) => !d.license_expiration);
    add("license_current", "Driver's license is current",
      expired.length ? "fail" : unknown.length ? "warn" : "pass",
      expired.length ? expired.map((d) => `${where(d)} expired ${d.license_expiration}`).join("; ")
        : unknown.length ? "Expiration date could not be read."
          : licenses.map((d) => `${d.license_state || ""} expires ${d.license_expiration}`).join("; "),
      [...expired, ...unknown].map(where));
    // 2026-10 (Titling testing 23 Oct) A license the reader says is hard to make out goes to review
    // (41444028 passed while barely legible).
    const blurry = licenses.filter((d) => d.legible !== false && String(d.legibility_note || "").trim());
    if (blurry.length) {
      add("license_legible", "Driver's license is clearly readable", "warn",
        blurry.map((d) => `${where(d)}: ${d.legibility_note}`).join("; "), blurry.map(where));
    }
  }

  // ── Insurance ────────────────────────────────────────────────────────
  const insurance = of("insurance");
  if (insurance.length && exp.insuranceRequired === false) {
    // 2026-10 (Sales samples) Insurance is not required in this state: a certificate in the package is not checked.
    add("insurance_not_required", `Proof of insurance (not required in ${stateOf(exp) || "this state"})`, "na",
      "Insurance is not required for this titling state, so the certificate is not checked.", []);
  } else if (insurance.length) {
    // An ID card carries no coverage details, so read the other insurance documents first.
    // 2026-10 (Titling testing 30 Oct) A certificate often continues on a second page (ACORD 101 "Additional
    // Remarks"), where comp/collision or the limits may appear (40444256). Each fact comes from the first
    // page that shows it, and every message names that page.
    const ordered = [...insurance.filter((d) => d.insurance_form !== "id_card"), ...insurance.filter((d) => d.insurance_form === "id_card")];
    const ins = ordered[0];
    const from = (pick) => ordered.find((d) => pick(d) != null && pick(d) !== "") || null;
    const at = (d) => `${where(d || ins)}: `;
    // 2026-10 (Titling answers 28 Oct) Where insurance is required, a binder is needed: an ID card alone
    // is not enough. A declarations page or the policy shows more than a binder, so it passes too;
    // a certificate alone is review until Titling says whether it counts.
    if (exp.insuranceRequired) {
      const forms = insurance.map((d) => d.insurance_form);
      const full = insurance.find((d) => ["binder", "declarations_page", "policy"].includes(d.insurance_form));
      const cardOnly = forms.every((f) => f === "id_card");
      add("insurance_binder", "Insurance binder (an ID card alone is not enough)", full ? "pass" : cardOnly ? "fail" : "warn",
        full ? `${at(full)}${full.insurance_form.replace("_", " ")} found.`
          : cardOnly ? `${at(ins)}Only an insurance ID card was uploaded. A binder is needed.`
            : `${at(ins)}No binder found (${forms.map((f) => (f || "unknown form").replace("_", " ")).join(", ")}). Please check it is enough.`,
        insurance.map(where));
    }
    const payee = ordered.find((d) => d.loss_payee && isNavitas(d.loss_payee)) || from((d) => d.loss_payee) || ins;
    add("insurance_loss_payee", `${exp.lienholder} is loss payee`,
      payee.loss_payee && isNavitas(payee.loss_payee) ? "pass" : "fail",
      `${at(payee)}Loss payee: ${payee.loss_payee || "not shown"}.`, [where(payee)]);
    // 2026-10 (Titling testing 30 Oct) Navitas's address in the loss payee / certificate holder box, as on titles.
    const payeeAddress = payee.loss_payee && isNavitas(payee.loss_payee) ? payee.loss_payee_address : null;
    if (payeeAddress && /\d/.test(payeeAddress) && !navitasAddressOk(payeeAddress)) {
      add("insurance_payee_address", `${exp.lienholder}'s address on the certificate is correct`, "warn",
        `${at(payee)}Written: ${payeeAddress}. Expected 201 Executive Center Dr, Suite 100, Columbia, SC 29210.`, [where(payee)]);
    }
    const compDoc = ordered.find((d) => d.comprehensive_and_collision === true);
    const noComp = ordered.find((d) => d.comprehensive_and_collision === false);
    if (!compDoc && noComp) {
      add("insurance_comp_collision", "Comprehensive and collision coverage", "fail", `${at(noComp)}Not shown on the certificate.`, insurance.map(where));
    } else if (exp.insuranceRequired && !compDoc) {
      // 2026-10 (Titling answers 28 Oct) Required in insurance states; coverage the reader could not see is a look, not a failure.
      add("insurance_comp_collision", "Comprehensive and collision coverage", "warn",
        `${at(ins)}Could not confirm comprehensive and collision coverage. Please check.`, insurance.map(where));
    }
    // 2026-10 (Titling testing 30 Oct) An expired policy (40444256).
    const expDoc = from((d) => d.policy_expiration);
    if (expDoc && days(today, expDoc.policy_expiration) < 0) {
      add("insurance_current", "Insurance policy is current", "fail",
        `${at(expDoc)}Policy expired ${expDoc.policy_expiration}.`, [where(expDoc)]);
    }
    // 2026-10 (Titling testing 30 Oct) The insured is our customer, at the address on the other documents.
    const customer = exp.customerName || (efa && efa.customer_legal_name);
    const insuredDoc = from((d) => d.insured_name);
    if (customer && insuredDoc && !sameName(nameOnly(insuredDoc.insured_name) || insuredDoc.insured_name, customer)) {
      add("insurance_insured", "The insured is our customer", "warn",
        `${at(insuredDoc)}Insured: ${insuredDoc.insured_name}; customer: ${customer}.`, [where(insuredDoc)]);
    }
    const insuredAddr = from((d) => d.insured_address);
    if (insuredAddr && efa && (efa.customer_street || efa.customer_zip)) {
      const zipOf = (x) => (String(x || "").match(/\b\d{5}\b(?!.*\b\d{5}\b)/) || [""])[0];
      const numberOf = (x) => (String(x || "").match(/^\s*(\d+)/) || ["", ""])[1];
      const efaAddr = [efa.customer_street, efa.customer_city, efa.customer_state, efa.customer_zip].filter(Boolean).join(", ");
      const zipDiff = efa.customer_zip && zipOf(insuredAddr.insured_address) && zipOf(insuredAddr.insured_address) !== digits(efa.customer_zip).slice(0, 5);
      const numDiff = numberOf(efa.customer_street) && numberOf(insuredAddr.insured_address) && numberOf(efa.customer_street) !== numberOf(insuredAddr.insured_address);
      if (zipDiff || numDiff) {
        add("insurance_insured_address", "The insured's address matches the EFA", "warn",
          `${at(insuredAddr)}Insured at ${insuredAddr.insured_address}; the EFA shows ${efaAddr}.`, [where(insuredAddr), where(efa)]);
      }
    }
    const cost = exp.cost || (efa && efa.amount_financed);
    const limitDoc = from((d) => d.property_limit);
    if (cost && limitDoc) {
      // 1% allowance: certificates round the stated amount (e.g. $15,243 for a $15,243.75 cost).
      add("insurance_limit", "Property coverage at least the equipment cost", limitDoc.property_limit >= cost * 0.99 ? "pass" : "fail",
        `${at(limitDoc)}Coverage $${limitDoc.property_limit.toLocaleString()} vs cost $${Number(cost).toLocaleString()}.`, [where(limitDoc)]);
    }
    // A limit the certificate does not show (null or 0) is not checked; one that is shown must meet the minimum.
    const liabDoc = ordered.find((d) => d.liability_each_occurrence || d.liability_aggregate) || ins;
    const occ = liabDoc.liability_each_occurrence || null;
    const agg = liabDoc.liability_aggregate || null;
    if (occ || agg) {
      const ok = (!occ || occ >= 300000) && (!agg || agg >= 600000);
      add("insurance_liability", "Liability at least $300,000 / $600,000", ok ? "pass" : "fail",
        at(liabDoc) + [occ ? `Each occurrence $${occ.toLocaleString()}` : "Each occurrence not shown",
          agg ? `aggregate $${agg.toLocaleString()}` : "aggregate not shown"].join(", ") + ".",
        [where(liabDoc)]);
    }
    const addl = ordered.find((d) => d.additional_insured && isNavitas(d.additional_insured));
    if (addl) {
      add("insurance_not_additional_insured", `${exp.lienholder} is not listed as additional insured`, "fail",
        `${at(addl)}Navitas is listed as additional insured.`, [where(addl)]);
    }
  } else if (exp.insuranceRequired && !exp.docType) {
    add("insurance_present", "Proof of insurance (required in this state)", "fail", "No insurance document found.");
  }

  // ── Signatures ───────────────────────────────────────────────────────
  // 2026-10 (Titling answers 28 Oct) Flag blank signer positions and stamped or computer-generated
  // signatures. Ink color cannot be read reliably from a scan, so it stays with the reviewer.
  const isAssignment = (d) => ["title_back", "reassignment_form"].includes(d.type);
  const lines = docs.flatMap((d) => (d.signatures || []).map((x) => ({ ...x, doc: d })));
  const blank = lines.filter((x) => x.signed === false && SIGNED_DOC_TYPES.includes(x.doc.type)
    && !(isAssignment(x.doc) && /seller/i.test(x.signer)) && !isNavitas(x.signer));
  if (blank.length) {
    add("signer_positions", "Every signer position is signed", "warn",
      blank.map((x) => `${where(x.doc)}: ${x.signer} signature line is blank`).join("; "), [...new Set(blank.map((x) => where(x.doc)))]);
  }
  const notPen = lines.filter((x) => x.signed !== false && (x.kind === "stamped" || x.kind === "typed"));
  if (notPen.length) {
    add("signature_style", "No stamped or computer-generated signatures", "warn",
      notPen.map((x) => `${where(x.doc)}: ${x.signer} signature is ${x.kind === "typed" ? "computer-generated" : "stamped"}`).join("; "),
      [...new Set(notPen.map((x) => where(x.doc)))]);
  }

  // ── Anything an analyst should see ───────────────────────────────────
  const noted = docs.filter((d) => (d.notes || []).length);
  if (noted.length || (extraction.package_notes || []).length) {
    add("analyst_notes", "Notes for the title analyst", "warn",
      [...noted.flatMap((d) => d.notes.map((n) => `${where(d)}: ${n}`)), ...(extraction.package_notes || [])].join("; "),
      noted.map(where));
  }

  const count = (s) => checks.filter((c) => c.status === s).length;
  return {
    summary: { pass: count("pass"), fail: count("fail"), warn: count("warn"), na: count("na") },
    verdict: count("fail") ? "fail" : count("warn") ? "review" : "pass",
    checks,
    // 2026-09 (Title Package) A verdict per document, from the checks whose evidence points at
    // its pages, so a package's title and license can pass or fail separately when filed.
    documents: docs.map((d, index) => {
      const ref = where(d);
      const mine = checks.filter((c) => (c.evidence || []).includes(ref) && c.status !== "na");
      const fails = mine.filter((c) => c.status === "fail");
      const warns = mine.filter((c) => c.status === "warn");
      return {
        index,
        type: d.type,
        pages: d.pages || [],
        vin: vinKey(d.vin) || null,
        vins: vinKey(d.vin) ? [vinKey(d.vin)] : [],
        role: roles.get(d) || null,
        notarized: d.notarized === true || (d.type === "power_of_attorney" && of("notary_acknowledgment").length > 0 && d.notarized !== false),
        verdict: fails.length ? "fail" : warns.length ? "review" : "pass",
        problems: [...fails, ...warns].map((c) => ownPart(c.detail, ref)).filter(Boolean),
      };
    }),
  };
}
