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

test("a clean package passes, with one POA left for review", () => {
  const r = runChecks(cleanPackage(), EXPECTED);
  for (const id of ["legible", "belongs_to_deal", "vin_match", "title_present", "title_back_present", "unreleased_liens",
    "chain_to_customer", "lienholder_on_assignment", "invoice_recent", "invoice_customer", "vendor_matches_pay_proceeds",
    "amount_financed_vs_invoice", "poa_notarized", "license_current"]) {
    assert.equal(status(r, id), "pass", id);
  }
  assert.equal(status(r, "poa_count"), "warn");
  assert.equal(r.verdict, "review");
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
