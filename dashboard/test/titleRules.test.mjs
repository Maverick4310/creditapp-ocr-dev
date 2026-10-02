// 2026-09 (Title Docs) Rule checks against fixtures shaped like real title packages.
// All names, VINs and numbers are invented — this repo is public.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runChecks, sameName, vinValid } from "../titleRules.js";

const VIN = "1XKZZ49X9MD000001";
const doc = (type, pages, extra = {}) => ({ type, file_index: 0, pages, legible: true, ...extra });

// A clean package, like a Colorado dealer sale: title front + back, one RON POA, sales
// order matching the EFA, license, and a vendor name-variation letter.
function cleanPackage() {
  return {
    documents: [
      doc("title_information_sheet", [1], { contract_number: "41000001", vin: VIN }),
      doc("title_front", [2], { vin: VIN, owner_names: ["Desert Truck Centers of Arizona Inc"], lienholders: [] }),
      doc("title_back", [3], { assignments: [{ seller_name: "DESERT TRUCK CENTERS OF ARIZONA INC", buyer_name: "ACME PAVING LLC",
        new_lienholder: "NAVITAS CREDIT CORP", seller_signed: true, sale_date: "2026-08-28" }] }),
      doc("power_of_attorney", [4], { contract_number: "41000001", vin: VIN, poa_role: "buyer", notarized: true,
        remote_online_notarization: true, signature_date: "2026-08-25", notary_date: "2026-08-25" }),
      doc("notary_or_signing_certificate", [5, 6]),
      doc("one_and_same_letter", [7], { contract_number: "41000001" }),
      doc("invoice", [8], { vendor_name: "Desert Truck Centers of Arizona Inc", sold_to: "Acme Paving LLC",
        document_date: "2026-08-28", total_amount: 91900 }),
      doc("equipment_finance_agreement", [11, 12], { contract_number: "41000001", vin: VIN, customer_legal_name: "Acme Paving LLC",
        amount_financed: 91900, pay_proceeds_vendor: "Desert Truck Centers Of Arizona, Inc", secured_party: "Navitas Credit Corp" }),
      doc("drivers_license", [15], { license_state: "CO", license_expiration: "2027-07-23", license_number_last4: "0000" }),
    ],
  };
}
const EXPECTED = { dealNumber: "41000001", customerName: "Acme Paving LLC", vins: [VIN], referenceDate: "2026-09-02" };
const status = (r, id) => (r.checks.find((c) => c.id === id) || {}).status;

test("names compare without punctuation or company suffixes", () => {
  assert.ok(sameName("Desert Truck Centers Of Arizona, Inc", "DESERT TRUCK CENTERS OF ARIZONA INC"));
  assert.ok(sameName("A & B Trucking Co", "A and B Trucking"));
  assert.ok(!sameName("Acme Paving LLC", "Luna Landscape Corp"));
});

test("a clean package passes; its one remotely notarized POA is enough", () => {
  const r = runChecks(cleanPackage(), EXPECTED);
  for (const id of ["legible", "belongs_to_deal", "vin_match", "title_present", "title_back_present", "unreleased_liens",
    "chain_to_customer", "lienholder_on_assignment", "invoice_recent", "invoice_customer", "vendor_matches_pay_proceeds",
    "amount_financed_vs_invoice", "poa_notarized", "license_current"]) {
    assert.equal(status(r, id), "pass", id);
  }
  // 2026-10 (Titling answers) One remotely notarized POA meets the requirement.
  assert.equal(status(r, "poa_count"), "pass");
});

// 2026-10 (Titling answers) Title Department rules, 2 Oct 2026.
const onePoa = (ron) => {
  const p = cleanPackage();
  p.documents.find((d) => d.type === "power_of_attorney").remote_online_notarization = ron;
  return p;
};
test("one original POA is not enough; NC takes originals only", () => {
  assert.equal(status(runChecks(onePoa(false), EXPECTED), "poa_count"), "fail");
  assert.equal(status(runChecks(onePoa(true), { ...EXPECTED, titlingState: "NC" }), "poa_count"), "fail");
  const nc = onePoa(false);
  nc.documents.push(doc("power_of_attorney", [9], { contract_number: "41000001", vin: VIN, poa_role: "buyer", notarized: true,
    signature_date: "2026-08-25", notary_date: "2026-08-25" }));
  assert.equal(status(runChecks(nc, { ...EXPECTED, titlingState: "NC" }), "poa_count"), "pass");
});
test("warns that Broward County's tag agency needs wet-ink POAs", () => {
  const r = runChecks(onePoa(true), { ...EXPECTED, titlingState: "FL", titlingCounty: "Broward" });
  assert.equal(status(r, "poa_wet_ink"), "warn");
  assert.equal(status(runChecks(onePoa(true), { ...EXPECTED, titlingState: "FL", titlingCounty: "Miami-Dade" }), "poa_wet_ink"), undefined);
});
test("checks invoice signatures only where the state requires them", () => {
  const sign = (seller, buyer) => {
    const p = cleanPackage();
    Object.assign(p.documents.find((d) => d.type === "invoice"), { seller_signed: seller, buyer_signed: buyer });
    return p;
  };
  assert.equal(status(runChecks(sign(true, true), { ...EXPECTED, titlingState: "TX" }), "invoice_signed"), "pass");
  assert.equal(status(runChecks(sign(false, true), { ...EXPECTED, titlingState: "CO" }), "invoice_signed"), "fail");
  assert.equal(status(runChecks(sign(true, false), { ...EXPECTED, titlingState: "GA" }), "invoice_signed"), "warn");
  assert.equal(status(runChecks(sign(false, false), { ...EXPECTED, titlingState: "FL", titlingCounty: "Broward County" }), "invoice_signed"), "fail");
  assert.equal(status(runChecks(sign(false, false), { ...EXPECTED, titlingState: "AZ" }), "invoice_signed"), undefined);
  assert.equal(status(runChecks(sign(false, false), { ...EXPECTED, titlingState: "TX", lienAdditionOnly: true }), "invoice_signed"), undefined);
});
test("insurance follows the titling state unless Salesforce says otherwise", () => {
  assert.equal(status(runChecks(cleanPackage(), { ...EXPECTED, titlingState: "WV" }), "insurance_present"), "fail");
  assert.equal(status(runChecks(cleanPackage(), { ...EXPECTED, titlingState: "GA" }), "insurance_present"), undefined);
  assert.equal(status(runChecks(cleanPackage(), { ...EXPECTED, titlingState: "NC", lienAdditionOnly: true }), "insurance_present"), undefined);
});

test("a misfiled package fails on contract number and VIN", () => {
  const p = cleanPackage();
  p.documents.forEach((d) => { if (d.contract_number) d.contract_number = "41999999"; if (d.vin) d.vin = "1NKZZZZX9MJ000002"; });
  const r = runChecks(p, EXPECTED);
  assert.equal(status(r, "belongs_to_deal"), "fail");
  assert.equal(status(r, "vin_match"), "fail");
  assert.equal(r.verdict, "fail");
});

test("no title means no review", () => {
  const p = cleanPackage();
  p.documents = p.documents.filter((d) => !d.type.startsWith("title_"));
  assert.equal(status(runChecks(p, EXPECTED), "title_present"), "fail");
});

test("an unreleased lien fails unless released or being paid off", () => {
  const p = cleanPackage();
  p.documents[1].lienholders = [{ name: "First Regional Bank", released: false }];
  assert.equal(status(runChecks(p, EXPECTED), "unreleased_liens"), "fail");
  assert.equal(status(runChecks(p, { ...EXPECTED, payingOffLien: true }), "unreleased_liens"), "warn");
  p.documents.push(doc("lien_release", [16]));
  assert.equal(status(runChecks(p, EXPECTED), "unreleased_liens"), "pass");
});

test("a title printed NO LIENS, with no lienholder box on the assignment, warns rather than fails", () => {
  const p = cleanPackage();
  p.documents[1].no_liens_stated = true;
  p.documents[2].assignments[0].new_lienholder = null;
  const r = runChecks(p, EXPECTED);
  assert.equal(status(r, "unreleased_liens"), "pass");
  assert.equal(status(r, "lienholder_on_assignment"), "warn");
});

test("assignment to someone else fails the chain", () => {
  const p = cleanPackage();
  p.documents[2].assignments[0].buyer_name = "Other Buyer Inc";
  assert.equal(status(runChecks(p, EXPECTED), "chain_to_customer"), "fail");
});

test("stale invoice and vendor mismatch without a letter fail; financing over the invoice is review", () => {
  const p = cleanPackage();
  p.documents.find((d) => d.type === "invoice").document_date = "2026-07-01";
  p.documents.find((d) => d.type === "equipment_finance_agreement").amount_financed = 95000;
  p.documents = p.documents.filter((d) => d.type !== "one_and_same_letter");
  p.documents.find((d) => d.type === "invoice").vendor_name = "Other Motors";
  const r = runChecks(p, EXPECTED);
  assert.equal(status(r, "invoice_recent"), "fail");
  assert.equal(status(r, "amount_financed_vs_invoice"), "warn");
  assert.equal(status(r, "vendor_matches_pay_proceeds"), "fail");
});

test("a POA notarized on a different day fails", () => {
  const p = cleanPackage();
  p.documents.find((d) => d.type === "power_of_attorney").notary_date = "2026-08-27";
  assert.equal(status(runChecks(p, EXPECTED), "poa_notarized"), "fail");
});

test("an expired license and an unreadable page fail", () => {
  const p = cleanPackage();
  p.documents.find((d) => d.type === "drivers_license").license_expiration = "2025-01-01";
  p.documents[1].legible = false;
  const r = runChecks(p, EXPECTED);
  assert.equal(status(r, "license_current"), "fail");
  assert.equal(status(r, "legible"), "fail");
});

test("insurance: loss payee and limits", () => {
  const p = cleanPackage();
  p.documents.push(doc("insurance", [16], { loss_payee: "Navitas Credit Corp", property_limit: 50000,
    liability_each_occurrence: 1000000, liability_aggregate: 2000000 }));
  const r = runChecks(p, EXPECTED);
  assert.equal(status(r, "insurance_loss_payee"), "pass");
  assert.equal(status(r, "insurance_limit"), "fail");
  assert.equal(status(r, "insurance_liability"), "pass");
});

test("a single upload in the wrong slot fails", () => {
  const r = runChecks({ documents: [doc("invoice", [1], { document_date: "2026-08-30" })] },
    { ...EXPECTED, docType: "Title/MSO Front" });
  assert.equal(status(r, "right_document"), "fail");
  assert.equal(status(r, "poa_count"), undefined, "package-level POA count is skipped for single uploads");
});

test("auction sales and analyst notes are surfaced for review", () => {
  const p = cleanPackage();
  p.documents.find((d) => d.type === "invoice").is_auction = true;
  p.documents[0].notes = ["Handwritten: Lien Hold"];
  const r = runChecks(p, EXPECTED);
  assert.equal(status(r, "auction_sale"), "warn");
  assert.equal(status(r, "analyst_notes"), "warn");
});

// ── Fixes found by the first run on real packages (29 Sep 2026) ─────────
test("a VIN that differs only by look-alike characters warns instead of failing", () => {
  const p = cleanPackage();
  p.documents.push(doc("reassignment_form", [16], { vin: "1XKZ249X9MD000001" }));
  assert.equal(status(runChecks(p, EXPECTED), "vin_match"), "warn");
  p.documents[p.documents.length - 1].vin = "1XKZZ49X9MD999991";
  assert.equal(status(runChecks(p, EXPECTED), "vin_match"), "fail");
});

test("invoice and stock numbers are not treated as contract numbers", () => {
  const p = cleanPackage();
  p.documents.find((d) => d.type === "invoice").contract_number = "3520";
  assert.equal(status(runChecks(p, EXPECTED), "belongs_to_deal"), "pass");
});

test("Ship To with an address compares only the name", () => {
  const p = cleanPackage();
  p.documents.find((d) => d.type === "invoice").ship_to = "Acme Paving LLC, 4851 Forest St, Denver, CO 80022";
  assert.equal(status(runChecks(p, EXPECTED), "invoice_customer"), "pass");
});

test("a POA granted by the customer counts as a buyer POA whatever the model called it", () => {
  const p = cleanPackage();
  const poa = p.documents.find((d) => d.type === "power_of_attorney");
  poa.poa_role = "seller";
  poa.poa_owner_name = "Acme Paving LLC";
  p.documents.push({ ...poa, pages: [17] });
  assert.equal(status(runChecks(p, EXPECTED), "poa_count"), "pass");
});

test("pay proceeds to the customer (sale-leaseback) warn instead of failing", () => {
  const p = cleanPackage();
  p.documents = p.documents.filter((d) => d.type !== "one_and_same_letter");
  p.documents.find((d) => d.type === "invoice").vendor_name = "Statewide Auctions LLC";
  p.documents.find((d) => d.type === "equipment_finance_agreement").pay_proceeds_vendor = "Acme Paving LLC";
  assert.equal(status(runChecks(p, EXPECTED), "vendor_matches_pay_proceeds"), "warn");
});

test("insurance within 1% of cost passes (rounded stated amount)", () => {
  const p = cleanPackage();
  p.documents.push(doc("insurance", [16], { loss_payee: "Navitas Credit Corp", property_limit: 15243 }));
  assert.equal(status(runChecks(p, { ...EXPECTED, cost: 15243.75 }), "insurance_limit"), "pass");
});

// ── Round 2 on 39 real files across 15 states (29 Sep 2026) ─────────────
// The public textbook example VIN, and one-character variants of it.
const GOOD = "1M8GDM9AXKP042788";
const TYPO = "1M8GDN9AXKP042788"; // M→N: fails the check digit

test("VIN check digit", () => {
  assert.ok(vinValid(GOOD));
  assert.ok(!vinValid(TYPO));
});

test("a Salesforce VIN that fails the check digit is reported as keyed wrong", () => {
  const p = cleanPackage();
  p.documents.forEach((d) => { if (d.vin) d.vin = GOOD; });
  const r = runChecks(p, { ...EXPECTED, vins: [TYPO] });
  assert.equal(status(r, "vin_match"), "fail");
  assert.match(r.checks.find((c) => c.id === "vin_match").detail, /correct the VIN in LeaseWorks/);
});

test("a document VIN that fails the check digit next to a valid Salesforce VIN is a likely misread", () => {
  const p = cleanPackage();
  p.documents.forEach((d) => { if (d.vin) d.vin = GOOD; });
  p.documents.push(doc("reassignment_form", [16], { vin: TYPO }));
  assert.equal(status(runChecks(p, { ...EXPECTED, vins: [GOOD] }), "vin_match"), "warn");
});

test("a broker deal accepts the broker's contract numbers, lienholder and POA", () => {
  const p = cleanPackage();
  const poa = p.documents.find((d) => d.type === "power_of_attorney");
  Object.assign(poa, { contract_number: "33001", poa_grantee: "Navitas Credit Corp", poa_owner_name: "Acme Paving LLC" });
  p.documents[1].lienholders = [{ name: "Broker Lender Bank NA", released: false }];
  p.documents[2].assignments[0].new_lienholder = "Broker Lender Bank NA";
  const r = runChecks(p, EXPECTED);
  assert.equal(status(r, "broker_deal"), "warn");
  assert.equal(status(r, "belongs_to_deal"), "pass");
  assert.equal(status(r, "unreleased_liens"), "warn");
  assert.equal(status(r, "lienholder_on_assignment"), "warn");
  assert.equal(status(r, "poa_count"), "pass");
});

test("a blank buyer on the last assignment says so", () => {
  const p = cleanPackage();
  p.documents[2].assignments[0].buyer_name = null;
  const c = runChecks(p, EXPECTED).checks.find((x) => x.id === "chain_to_customer");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /buyer's name is blank/);
});

test("duplicate invoice copies count once against the amount financed", () => {
  const p = cleanPackage();
  const inv = p.documents.find((d) => d.type === "invoice");
  p.documents.push({ ...inv, pages: [9] });
  assert.equal(status(runChecks(p, EXPECTED), "amount_financed_vs_invoice"), "pass");
});

test("Navitas with its address, NONE as a lienholder, and an address-only Ship To are handled", () => {
  const p = cleanPackage();
  p.documents[1].lienholders = [{ name: "NAVITAS, 201 EXECUTIVE CENTER DR STE 100, COLUMBIA SC 29210", released: false }, { name: "NONE" }];
  p.documents.find((d) => d.type === "invoice").ship_to = "2990 Main Ave, Springfield, FL";
  const r = runChecks(p, EXPECTED);
  assert.equal(status(r, "unreleased_liens"), "pass");
  assert.equal(status(r, "invoice_customer"), "pass");
});

test("a schedule suffix on the contract number still matches the deal", () => {
  const p = cleanPackage();
  p.documents.find((d) => d.type === "equipment_finance_agreement").contract_number = "41000001-1";
  assert.equal(status(runChecks(p, EXPECTED), "belongs_to_deal"), "pass");
});

test("a PFC / PFA deal treats the division's short contract numbers and lender as expected", () => {
  const p = cleanPackage();
  p.documents.find((d) => d.type === "power_of_attorney").contract_number = "33723";
  p.documents[1].lienholders = [{ name: "Partner Lender Bank NA", released: false }];
  const r = runChecks(p, { ...EXPECTED, brokerDeal: true });
  assert.equal(status(r, "belongs_to_deal"), "pass");
  assert.equal(status(r, "unreleased_liens"), "warn");
  assert.equal(status(r, "broker_deal"), "warn");
});

test("'+' reads as '&', and a pick-up instruction is not a Ship To name", () => {
  assert.ok(sameName("Acme Tires + Service LLC", "ACME TIRES & SERVICE LLC"));
  const p = cleanPackage();
  p.documents.find((d) => d.type === "invoice").ship_to = "Pick up in Springfield";
  assert.equal(status(runChecks(p, EXPECTED), "invoice_customer"), "pass");
});

test("a POA carrying the correct VIN is not failed when Salesforce holds a mistyped one", () => {
  const p = cleanPackage();
  p.documents.forEach((d) => { if (d.vin) d.vin = GOOD; });
  const r = runChecks(p, { ...EXPECTED, vins: [TYPO] });
  assert.equal(status(r, "vin_match"), "fail");
  assert.equal(status(r, "poa_vin"), undefined);
});

test("a handwritten VIN with one extra character is a likely misread", () => {
  const p = cleanPackage();
  p.documents.forEach((d) => { if (d.vin) d.vin = GOOD; });
  p.documents.push(doc("reassignment_form", [16], { vin: GOOD.slice(0, 11) + "T" + GOOD.slice(11) }));
  assert.equal(status(runChecks(p, { ...EXPECTED, vins: [GOOD] }), "vin_match"), "warn");
});

test("an unreadable signing certificate warns; an unreadable title fails", () => {
  const p = cleanPackage();
  p.documents.find((d) => d.type === "notary_or_signing_certificate").legible = false;
  assert.equal(status(runChecks(p, EXPECTED), "legible"), "warn");
  p.documents[1].legible = false;
  assert.equal(status(runChecks(p, EXPECTED), "legible"), "fail");
});

test("a POA notarized by an attached acknowledgment (California) is review, not a failure", () => {
  const p = cleanPackage();
  const poa = p.documents.find((d) => d.type === "power_of_attorney");
  Object.assign(poa, { notarized: null, notary_date: null, notes: ["notary acknowledgment attached"] });
  p.documents.push(doc("notary_acknowledgment", [16]));
  assert.equal(status(runChecks(p, EXPECTED), "poa_notarized"), "warn");
  p.documents.pop();
  assert.equal(status(runChecks(p, EXPECTED), "poa_notarized"), "fail", "without the acknowledgment page it is still missing");
});

// ── From the first live upload (Idaho title, 29 Sep 2026) ───────────────
test("a title still in the seller's name with no assignment fails", () => {
  const p = cleanPackage();
  p.documents[1].owner_names = ["Desert Truck Centers of Arizona Inc"];
  p.documents[2].assignments = [];
  const c = runChecks(p, EXPECTED).checks.find((x) => x.id === "chain_to_customer");
  assert.equal(c.status, "fail");
  assert.match(c.detail, /still in Desert Truck Centers of Arizona Inc's name/);
});

test("a title already in the customer's name with no assignment is a lien addition", () => {
  const p = cleanPackage();
  p.documents[1].owner_names = ["Acme Paving LLC"];
  p.documents[2].assignments = [];
  const c = runChecks(p, EXPECTED).checks.find((x) => x.id === "chain_to_customer");
  assert.equal(c.status, "warn");
  assert.match(c.detail, /already in the customer's name/);
});

// ── From a partner's full package (29 Sep 2026) ─────────────────────────
test("a POA granted by the customer's owner personally counts as a buyer POA", () => {
  const p = cleanPackage();
  const poa = p.documents.find((d) => d.type === "power_of_attorney");
  poa.poa_owner_name = "Pat Owner";   // an individual, not the seller on the title
  p.documents.push({ ...poa, pages: [17], poa_owner_name: "Acme Paving LLC" });
  assert.equal(status(runChecks(p, EXPECTED), "poa_count"), "pass");
});

test("a POA granted by the title's seller is a seller POA", () => {
  const p = cleanPackage();
  p.documents.find((d) => d.type === "power_of_attorney").poa_owner_name = "Desert Truck Centers of Arizona Inc";
  assert.equal(status(runChecks(p, { ...EXPECTED, privateSale: true }), "seller_poa"), "pass");
});

test("a liability limit the certificate does not show is not failed", () => {
  const p = cleanPackage();
  p.documents.push(doc("insurance", [16], { loss_payee: "Navitas Credit Corp", liability_each_occurrence: 1000000, liability_aggregate: 0 }));
  assert.equal(status(runChecks(p, EXPECTED), "insurance_liability"), "pass");
  p.documents[p.documents.length - 1].liability_each_occurrence = 100000;
  assert.equal(status(runChecks(p, EXPECTED), "insurance_liability"), "fail");
});

// ── Title Package: a verdict per document (29 Sep 2026) ─────────────────
test("each document gets its own verdict and problems", () => {
  const p = cleanPackage();
  p.documents.find((d) => d.type === "drivers_license").license_expiration = "2025-01-01";
  const r = runChecks(p, EXPECTED);
  const lic = r.documents.find((d) => d.type === "drivers_license");
  const front = r.documents.find((d) => d.type === "title_front");
  assert.equal(lic.verdict, "fail");
  assert.match(lic.problems.join(" "), /expired/);
  assert.equal(front.verdict, "pass");
  assert.equal(front.vin, VIN);
  assert.equal(r.documents.find((d) => d.type === "power_of_attorney").role, "buyer");
});

test("a file with several titles checks each vehicle on its own", () => {
  const V1 = "1M8GDM9AXKP042788";
  const V2 = "1FTFW1E50NFA00002";
  const extraction = { documents: [
    doc("title_front", [1], { vin: V1, owner_names: ["Seller One"], lienholders: [] }),
    doc("title_back", [2], { assignments: [{ seller_name: "Seller One", buyer_name: "Acme Paving LLC", seller_signed: true, new_lienholder: "Navitas Credit Corp" }] }),
    doc("title_front", [3], { vin: V2, owner_names: ["Seller Two"], lienholders: [] }),
    doc("reassignment_form", [4], { assignments: [{ seller_name: "Seller Two", buyer_name: "Someone Else Inc", seller_signed: true }] }),
  ] };
  const r = runChecks(extraction, { customerName: "Acme Paving LLC", vins: [V1, V2] });
  const chains = r.checks.filter((c) => c.id === "chain_to_customer");
  assert.equal(chains.length, 2);
  assert.equal(chains.find((c) => c.label.includes(V1)).status, "pass");
  assert.equal(chains.find((c) => c.label.includes(V2)).status, "fail");
  const byPage = (pg) => r.documents.find((d) => d.pages[0] === pg);
  assert.equal(byPage(2).verdict, "pass", "trailer 1's back is not failed by trailer 2");
  assert.equal(byPage(4).verdict, "fail");
  assert.ok(!byPage(2).problems.join(" ").includes("p4"), "no other document's problems");
});

// 2026-10 (Titling answers) Virginia: no lienholder section on the reassignment.
test("a Virginia title without a lienholder on the reassignment is not flagged", () => {
  const p = cleanPackage();
  p.documents.find((d) => d.type === "title_back").assignments[0].new_lienholder = "";
  assert.equal(status(runChecks(p, { ...EXPECTED, titlingState: "VA" }), "lienholder_on_assignment"), "na");
  assert.equal(status(runChecks(p, { ...EXPECTED, titlingState: "TX" }), "lienholder_on_assignment"), "warn");
});
