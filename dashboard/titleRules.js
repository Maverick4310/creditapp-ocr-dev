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
//   dealNumber, customerName, vins: [], lienholder ("Navitas Credit Corp"),
//   referenceDate (YYYY-MM-DD, default today), payingOffLien, privateSale,
//   insuranceRequired, docType (the slot a single file was uploaded to), cost,
//   titlingState (two letters), titlingCounty, lienAdditionOnly   — 2026-10 (Titling answers)
// }

// 2026-10 (Titling answers) Title Department, 2 Oct 2026.
// Insurance is required in these titling states (not on a lien addition only).
export const INSURANCE_STATES = ["DC", "MN", "NC", "OR", "SC", "TN", "WV"];
// One remotely notarized (DocuSign) buyer POA is enough, except in these states (originals only).
export const ORIGINAL_POA_STATES = ["NC"];
// The invoice or bill of sale must be signed by buyer and seller in these states (+ Broward County, FL).
export const INVOICE_SIGNATURE_STATES = ["AR", "CO", "GA", "IN", "KY", "LA", "MD", "NE", "SC", "TX", "VA"];
export const INVOICE_SIGNATURE_COUNTIES = { FL: ["BROWARD"] };
// Florida's Coral Springs tag agency (Broward County) needs wet-ink POAs.
export const WET_INK_POA_COUNTIES = { FL: ["BROWARD"] };

const stateOf = (exp) => String(exp.titlingState || "").slice(0, 2).toUpperCase();
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
  const parts = String(detail || "").split("; ");
  const kept = parts.filter((x) => x.startsWith(ref) || !DOC_REF.test(x));
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
};

export function runChecks(extraction, expected = {}) {
  const docs = (extraction && extraction.documents) || [];
  const exp = { lienholder: "Navitas Credit LLC", ...expected };
  // 2026-10 (Titling answers) Salesforce sends the titling state; an explicit flag still wins.
  if (exp.insuranceRequired === undefined && exp.titlingState) {
    exp.insuranceRequired = INSURANCE_STATES.includes(stateOf(exp)) && !exp.lienAdditionOnly;
  }
  // "NAVITAS, 201 EXECUTIVE CENTER DR ..." is Navitas too.
  const isNavitas = (name) => sameName(nameOnly(name) || name, exp.lienholder) || /^NAVITAS/.test(nameKey(name));
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
  const keyUnreadable = unreadable.filter((d) => !SUPPORTING.includes(d.type));
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
    const off = withVin.filter((d) => !vins.includes(vinKey(d.vin)));
    const explain = (d) => {
      const doc = vinKey(d.vin);
      const close = vins.find((v) => diffCount(doc, v) <= 2);
      if (close && vinValid(doc) && !vinValid(close)) {
        return { status: "fail", text: `${where(d)}: ${d.vin}. The Salesforce VIN ${close} fails the VIN check digit and this one passes — correct the VIN in LeaseWorks.` };
      }
      if (close && (!vinValid(doc) && vinValid(close) || vinNear(doc, close))) {
        return { status: "warn", text: `${where(d)}: read as ${d.vin}, close to ${close} — likely a misread; check by eye.` };
      }
      return { status: "fail", text: `${where(d)}: ${d.vin} is a different vehicle.` };
    };
    const found = off.map(explain);
    off.forEach((d, i) => { vinVerdict[vinKey(d.vin)] = found[i].status === "fail" && /different vehicle/.test(found[i].text) ? "different" : "explained"; });
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
      const named = last.new_lienholder;
      add("lienholder_on_assignment", `${exp.lienholder} is named as new lienholder` + tag,
        !named ? "warn" : isNavitas(named) ? "pass" : broker ? "warn" : "fail",
        !named ? "No new lienholder written on the last assignment (some states, e.g. VA, add it on the title application)."
          : `New lienholder written: ${named}.`,
        [where(last.doc)]);
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
      add("invoice_customer", "Invoice Sold To and Ship To are the customer", bad.length ? "fail" : "pass",
        bad.length ? bad.map((d) => `${where(d)}: sold to ${d.sold_to || "?"}, ship to ${d.ship_to || "?"}`).join("; ")
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

    // Sum distinct invoice totals (copies of the same invoice count once). Financing more than the
    // invoice is normal when taxes, fees or other equipment are financed — review, not a failure.
    const totals = [...new Set(invoices.map((d) => d.total_amount).filter((n) => n != null))];
    const invoiceTotal = totals.reduce((a, b) => a + b, 0);
    if (efa && efa.amount_financed != null && totals.length) {
      const diff = Math.round((invoiceTotal - efa.amount_financed) * 100) / 100;
      const fmt = (n) => "$" + n.toLocaleString();
      add("amount_financed_vs_invoice", "Amount financed matches the invoice",
        diff === 0 ? "pass" : "warn",
        diff === 0 ? `${fmt(efa.amount_financed)}.`
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
        const wrongVin = poas.filter((d) => vinKey(d.vin) && !vins.includes(vinKey(d.vin)) && vinVerdict[vinKey(d.vin)] !== "explained");
        if (wrongVin.length) add("poa_vin", "POA lists this vehicle's VIN", "fail",
          wrongVin.map((d) => `${where(d)}: ${d.vin}`).join("; "), wrongVin.map(where));
      }
    }
    if (!exp.docType && broker && brokerPoas.length) {
      add("poa_count", "Broker POA to Navitas", "pass", `${brokerPoas.length} broker POA(s) granted to Navitas.`, brokerPoas.map(where));
    } else if (!exp.docType) {
      // 2026-10 (Titling answers) One remotely notarized POA is enough; two if originals; NC originals only.
      const originalsOnly = ORIGINAL_POA_STATES.includes(stateOf(exp));
      const eBuyer = buyerPoas.filter((d) => d.remote_online_notarization);
      const originals = buyerPoas.filter((d) => !d.remote_online_notarization);
      const met = originalsOnly ? originals.length >= 2 : eBuyer.length > 0 || originals.length >= 2;
      add("poa_count", originalsOnly ? "Two original buyer POAs (NC)" : "Buyer POA: one notarized online, or two originals",
        met ? "pass" : "fail",
        met ? (eBuyer.length && !originalsOnly ? `${eBuyer.length} buyer POA(s) notarized online.` : `${originals.length} original buyer POAs.`)
          : originalsOnly && eBuyer.length ? `North Carolina takes original POAs only; ${eBuyer.length} notarized online, ${originals.length} original.`
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
  }

  // ── Insurance ────────────────────────────────────────────────────────
  const insurance = of("insurance");
  if (insurance.length) {
    const ins = insurance[0];
    add("insurance_loss_payee", `${exp.lienholder} is loss payee`,
      ins.loss_payee && isNavitas(ins.loss_payee) ? "pass" : "fail",
      `Loss payee: ${ins.loss_payee || "not shown"}.`, [where(ins)]);
    if (ins.comprehensive_and_collision === false) {
      add("insurance_comp_collision", "Comprehensive and collision coverage", "fail", "Not shown on the certificate.", [where(ins)]);
    }
    const cost = exp.cost || (efa && efa.amount_financed);
    if (cost && ins.property_limit != null) {
      // 1% allowance: certificates round the stated amount (e.g. $15,243 for a $15,243.75 cost).
      add("insurance_limit", "Property coverage at least the equipment cost", ins.property_limit >= cost * 0.99 ? "pass" : "fail",
        `Coverage $${ins.property_limit.toLocaleString()} vs cost $${Number(cost).toLocaleString()}.`, [where(ins)]);
    }
    // A limit the certificate does not show (null or 0) is not checked; one that is shown must meet the minimum.
    const occ = ins.liability_each_occurrence || null;
    const agg = ins.liability_aggregate || null;
    if (occ || agg) {
      const ok = (!occ || occ >= 300000) && (!agg || agg >= 600000);
      add("insurance_liability", "Liability at least $300,000 / $600,000", ok ? "pass" : "fail",
        [occ ? `Each occurrence $${occ.toLocaleString()}` : "Each occurrence not shown",
          agg ? `aggregate $${agg.toLocaleString()}` : "aggregate not shown"].join(", ") + ".",
        [where(ins)]);
    }
    if (ins.additional_insured && isNavitas(ins.additional_insured)) {
      add("insurance_not_additional_insured", `${exp.lienholder} is not listed as additional insured`, "fail",
        "Navitas is listed as additional insured.", [where(ins)]);
    }
  } else if (exp.insuranceRequired && !exp.docType) {
    add("insurance_present", "Proof of insurance (required in this state)", "fail", "No insurance document found.");
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
