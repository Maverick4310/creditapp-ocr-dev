// prompt.js
//
// The extraction contract. Kept in its own file so the schema can evolve
// (add a field, tighten a rule) without touching server wiring.
//
// The shape below MIRRORS the Navitas credit-app submit payload sections
// (customer, guarantors, corpGuarantors, contacts, assets) so the JSON that
// comes back maps straight onto the wizard form with no translation layer.
// Pricing is intentionally excluded — it's calculator-computed, not read off
// a document.

export const SCHEMA_PROMPT = `You extract structured data from equipment-financing credit documents for a lender's intake form. You will receive up to three inputs: a CREDIT APPLICATION (authoritative for buyer identity and guarantors), a VENDOR INVOICE (authoritative for equipment description, cost, and the vendor/seller), and an EMAIL BODY (fills gaps and supplies deal context/narrative).

Return ONLY a single JSON object, no markdown, no backticks, no preamble. Use this exact shape. Omit nothing — use "" or [] when a value is absent:

{
  "customer": { "name": "", "dba": "", "federalTaxId": "", "phone": "", "street": "", "city": "", "state": "", "zip": "", "companyType": "", "yearsInBusiness": "" },
  "guarantors": [ { "firstName": "", "lastName": "", "ssn": "", "email": "", "birthdate": "", "streetNumber": "", "streetName": "", "streetType": "", "suiteNumber": "", "city": "", "state": "", "zip": "", "phone": "" } ],
  "corpGuarantors": [ { "name": "", "federalTaxId": "", "email": "", "phone": "", "street": "", "city": "", "state": "", "zip": "" } ],
  "contacts": [ { "firstName": "", "lastName": "", "email": "", "phone": "" } ],
  "assets": [ { "description": "", "cost": "", "assetType": "", "street": "", "city": "", "state": "", "zip": "" } ],
  "vendorHint": { "name": "", "vendorId": "", "dba": "" },
  "dealStory": "",
  "flags": [ { "field": "", "issue": "conflict|low_confidence|missing", "note": "" } ]
}

Rules:
- federalTaxId: digits only, strip dashes/spaces.
- ssn: exactly 9 digits, with dashes/spaces stripped. Transcribe each digit exactly as printed — never add, drop, pad, or repeat a digit. If you cannot read exactly 9 digits with confidence, return "" for that guarantor's ssn and add a low_confidence flag noting the SSN could not be read reliably.
- birthdate: YYYY-MM-DD or "".
- cost: numeric string, no currency symbols or commas.
- guarantors are individuals (people). corpGuarantors are corporate guarantor entities. contacts are non-guarantor buyer points of contact (no SSN/ownership).
- vendorHint: any vendor/dealer/seller name tied to the deal — usually the invoice's remit/"from" party, but also check the application for a referring dealer.
- dealStory: 1-3 sentence plain summary of the narrative/context (the story behind the request), drawn mainly from the email. "" if none.
- flags: when two sources disagree on the same field, add a "conflict" flag naming the field and both values. Add "low_confidence" for anything you had to guess. Add "missing" only for important fields a credit reviewer would expect (buyer name, at least one guarantor, at least one asset).
- Never invent SSNs, tax IDs, or dollar amounts. If not present, leave "".`;
