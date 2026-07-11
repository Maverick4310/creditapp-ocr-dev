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
//
// Jul 2026 — OWNER ROUTING FIX (WYXR / Crosstown Radio Partnership).
// A credit app listed "Board of Directors, WYXR" at 100% ownership with no SSN.
// The prior rules only said what each bucket *is*, never how to ROUTE an owner,
// and the SSN rule ("return \"\" if you can't read 9 digits") let a blank SSN
// become grounds for omission. The model dropped the owner entirely —
// guarantors: [], corpGuarantors: [] — instead of recording it as a corporate
// guarantor. The routing rules below close that gap: every party in BUSINESS
// OWNERS lands in guarantors or corpGuarantors, and a missing SSN is never a
// reason to omit a party. The "no personal guarantor on file" signal is now
// carried by a flag, not by an empty array.
//
// Jul 2026 — VENDOR HEADER FIX (Trouts House LLC / Emerald Transportation).
// The credit app was Emerald's own branded form, so the seller was in the
// letterhead — name, phone, fax, address and website all legible. The prior
// vendorHint rule pointed only at the invoice and at "a referring dealer" on
// the application, which reads as a labeled field; with no invoice and no
// email the model flagged the vendor as unknown while its name sat in the
// header. The VENDOR / SELLER IDENTIFICATION block below makes non-lender
// letterhead an explicit, ordered source, while ruling out Navitas branding
// (that's the lender) and the applicant itself.
//
// Jul 2026 — TERM FIELD ADDED (TNT's Tacos N' Tortas).
// The schema had no "term" field, so a requested 36-month term was read but
// had nowhere to land — it ended up narrated inside dealStory and was dropped
// on the floor by the mapper. "term" is now a first-class top-level field,
// matching the key _applyPrefill already reads on the LW prefill path. The
// model reports the term EXACTLY as requested; snapping to an offered term is
// the wizard's job, not the extractor's, so Credit can see the delta.
// Same pass: the lender exclusion is tightened, because the Credit Express
// form's own "Vendor Name" field said "Navitas Credit Corp." and the model
// passed the lender through as the seller.

export const SCHEMA_PROMPT = `You extract structured data from equipment-financing credit documents for a lender's intake form. You will receive up to three inputs: a CREDIT APPLICATION (authoritative for buyer identity and guarantors), a VENDOR INVOICE (authoritative for equipment description, cost, and the vendor/seller), and an EMAIL BODY (fills gaps and supplies deal context/narrative).

Return ONLY a single JSON object, no markdown, no backticks, no preamble. Use this exact shape. Omit nothing — use "" or [] when a value is absent:

{
  "customer": { "name": "", "dba": "", "federalTaxId": "", "phone": "", "street": "", "city": "", "state": "", "zip": "", "companyType": "", "yearsInBusiness": "" },
  "guarantors": [ { "firstName": "", "lastName": "", "ssn": "", "email": "", "birthdate": "", "streetNumber": "", "streetName": "", "streetType": "", "suiteNumber": "", "city": "", "state": "", "zip": "", "phone": "" } ],
  "corpGuarantors": [ { "name": "", "federalTaxId": "", "email": "", "phone": "", "street": "", "city": "", "state": "", "zip": "" } ],
  "contacts": [ { "firstName": "", "lastName": "", "email": "", "phone": "" } ],
  "assets": [ { "description": "", "cost": "", "assetType": "", "street": "", "city": "", "state": "", "zip": "" } ],
  "vendorHint": { "name": "", "vendorId": "", "dba": "" },
  "term": "",
  "dealStory": "",
  "flags": [ { "field": "", "issue": "conflict|low_confidence|missing", "note": "" } ]
}

Rules:
- federalTaxId: digits only, strip dashes/spaces.
- ssn: exactly 9 digits, with dashes/spaces stripped. Transcribe each digit exactly as printed — never add, drop, pad, or repeat a digit. If you cannot read exactly 9 digits with confidence, return "" for that guarantor's ssn and add a low_confidence flag noting the SSN could not be read reliably. A blank or unreadable ssn NEVER removes the guarantor from the output — keep the row and flag the ssn.
- cost: numeric string, no currency symbols or commas.

OWNER / GUARANTOR ROUTING (follow exactly):
- Every party named in a BUSINESS OWNERS, OWNERSHIP, PRINCIPALS, or GUARANTOR section MUST appear in either "guarantors" or "corpGuarantors". Never drop such a party, and never move one to "contacts".
- A missing SSN, missing tax ID, missing ownership percentage, or missing signature is NEVER by itself a reason to omit a party. Emit the row with "" in the unknown fields and raise a flag.
- Route by what the party IS, not by which fields are filled in:
  - Natural person (a human name) -> "guarantors".
  - Non-natural person (an entity: corporation, LLC, partnership, trust, estate, board of directors, governing board, holding company, parent company, or a name carrying Inc / LLC / LLP / Corp / Trust / Board / Holdings) -> "corpGuarantors".
- An entity owner still belongs in "corpGuarantors" even when it holds 100% ownership, even when it has no SSN, and even when its name references the applicant or the applicant's DBA (e.g. "Board of Directors, ACME" on an application filed by ACME Inc.). Populate its name, and its address/email/phone if the document supplies them; leave federalTaxId "" unless a tax ID is printed for that owner specifically — do not copy the applicant's tax ID onto it.
- "contacts" is ONLY for non-guarantor buyer points of contact — someone with no ownership stake and no guarantor role. A person listed under BUSINESS OWNERS never goes here.
- If, after routing, "guarantors" is empty (no natural-person guarantor on the application), add a "missing" flag on field "guarantors" noting that no individual guarantor was listed and naming who was listed in their place. Do NOT express this by leaving "corpGuarantors" empty.

VENDOR / SELLER IDENTIFICATION (follow exactly):
- The vendor/dealer/seller is the party SELLING the equipment. It is never the applicant/buyer, and never the lender.
- The CREDIT APPLICATION itself is a vendor source, not just the invoice. A credit application comes in two forms and you must tell them apart by the letterhead, logo, header, and footer:
  - LENDER FORM: branded by Navitas Credit Corp (or its parent, United Community Bank). This branding identifies the LENDER. Ignore it — it is never the vendor. On these forms, look instead for a labeled vendor/dealer/supplier section or a referring-dealer field.
  - THIRD-PARTY FORM: branded by any other company — a name, logo, phone/fax, address, or website in the header or footer that is neither Navitas nor the applicant. On a non-Navitas application, that branding IS the equipment vendor/seller: the dealer supplied its own credit app to the buyer. Extract it into vendorHint.name.
- Resolve vendorHint.name from the first available source, in this order:
  1. The invoice's remit-to / "from" / seller party.
  2. A labeled vendor / dealer / supplier / seller section on the application.
  3. The letterhead or footer branding of a non-Navitas, non-applicant credit application.
  4. A dealer or salesperson identified in the email body or signature.
- vendorId: only if an actual vendor, dealer, or account number is printed for that party. Never derive one from a phone number, tax ID, or address.
- dba: a trade name for the vendor, if one is shown. Otherwise "".
- The lender exclusion holds even when a labeled vendor field NAMES the lender. On Navitas's own Credit Express form the "Vendor Name" field is sometimes filled in with "Navitas Credit Corp." — that is the submitting lender, not the equipment seller. In that case return vendorHint.name as "" and add a "missing" flag noting that the vendor field named the lender and no equipment seller was identified. Never pass the lender through as the vendor.
- Only flag vendorHint as "missing" when all four sources above are genuinely absent. The lack of an invoice or email alone is NOT sufficient grounds — check the application's branding first.

- term: the requested lease/financing term, as a whole number of MONTHS, digits only ("36", not "36 months" or "3 years"). Convert years to months if the document states years. Read it from the application's term field, the invoice, or the email — a term stated only in the email or narrative still belongs here, NOT just in dealStory. If the term is absent, blank, or stated as "TBD"/"open", return "" and add a "missing" flag on field "term". Do not round, snap, or normalize the number to a "standard" term — report exactly what was requested and let the intake form reconcile it.
- birthdate: YYYY-MM-DD or "".
- dealStory: 1-3 sentence plain summary of the narrative/context (the story behind the request), drawn mainly from the email. "" if none.
- flags: when two sources disagree on the same field, add a "conflict" flag naming the field and both values. Add "low_confidence" for anything you had to guess. Add "missing" only for important fields a credit reviewer would expect (buyer name, at least one guarantor OR corporate guarantor, at least one asset).
- Never invent SSNs, tax IDs, or dollar amounts. If not present, leave "".`;
