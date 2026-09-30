// 2026-09 (Title Docs) Prompt and output shape for /title-docs.
//
// The model's job is to READ: split a titling package (or a single upload) into its
// documents, say what each one is, whether it is legible, and copy out the facts the
// Title Department checks. It does NOT decide pass/fail — titleRules.js does that, with
// plain comparisons against what Salesforce expects, so every verdict is reproducible.
//
// Written from real Navitas packages ("Title Packet Sent to DDI"), which arrive in this
// order: Title Information Sheet, title front, title back / reassignment form, POA(s)
// with DocuSign notary pages, invoice / sales order / bill of sale, Titled Addendum,
// Equipment Finance Agreement (with Pay Proceeds), insurance, driver's license.

export const DOC_TYPES = [
  "title_information_sheet", // DDI TIS5050 or Navitas's own sheet
  "title_front",
  "title_back", // back of the title: assignment / reassignments
  "reassignment_form", // separate state dealer-reassignment form
  "mso", // Manufacturer's Statement / Certificate of Origin
  "guaranty_of_title",
  "lien_release",
  "title_application",
  "electronic_title_copy", // e.g. DDI Premier eTitleLien report — proof AFTER perfection
  "invoice", // vendor invoice, retail sales order, buyer's order
  "bill_of_sale",
  "auction_document",
  "one_and_same_letter", // vendor name-variation statement
  "power_of_attorney",
  "notary_or_signing_certificate", // DocuSign certificate of completion / notary events
  "notary_acknowledgment", // separate notary acknowledgment page, e.g. California All-Purpose Acknowledgment
  "equipment_finance_agreement",
  "titled_addendum",
  "other_addendum",
  "insurance",
  "drivers_license",
  "other",
];

const str = { type: ["string", "null"] };
const num = { type: ["number", "null"] };
const bool = { type: ["boolean", "null"] };

export const TITLE_TOOL = {
  name: "emit_title_package",
  description:
    "Report every document found in the titling files, in page order, with the facts read from each.",
  input_schema: {
    type: "object",
    properties: {
      documents: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: DOC_TYPES },
            file_index: { type: "integer", description: "0-based index of the file this came from" },
            pages: { type: "array", items: { type: "integer" }, description: "1-based pages within that file" },
            legible: { type: "boolean", description: "false if the key facts cannot be read with confidence" },
            legibility_note: str,
            contract_number: str,
            vin: str,
            year: str,
            make: str,
            model: str,
            // Title / MSO / GOT / electronic copy
            title_state: str,
            title_number: str,
            owner_names: { type: "array", items: { type: "string" } },
            no_liens_stated: bool,
            lienholders: {
              type: "array",
              items: {
                type: "object",
                properties: { name: { type: "string" }, released: bool, release_evidence: str },
                required: ["name"],
              },
            },
            assignments: {
              type: "array",
              description: "Every filled-in assignment or reassignment, in order (first = earliest).",
              items: {
                type: "object",
                properties: {
                  seller_name: str,
                  buyer_name: str,
                  buyer_address: str,
                  sale_date: str,
                  odometer: str,
                  new_lienholder: str,
                  seller_signed: bool,
                  buyer_signed: bool,
                },
              },
            },
            // Invoice / bill of sale / auction
            vendor_name: str,
            sold_to: str,
            ship_to: str,
            document_date: { type: ["string", "null"], description: "YYYY-MM-DD" },
            total_amount: num,
            is_auction: bool,
            seller_signed: bool,
            buyer_signed: bool,
            // Equipment Finance Agreement
            customer_legal_name: str,
            secured_party: str,
            amount_financed: num,
            pay_proceeds_vendor: str,
            signed_by_customer: bool,
            // Power of attorney
            poa_role: { type: ["string", "null"], enum: ["buyer", "seller", null] },
            poa_owner_name: str,
            poa_grantee: str,
            signature_date: { type: ["string", "null"], description: "YYYY-MM-DD" },
            notarized: bool,
            notary_date: { type: ["string", "null"], description: "YYYY-MM-DD" },
            remote_online_notarization: bool,
            // Driver's license — deliberately minimal
            license_name: str,
            license_state: str,
            license_expiration: { type: ["string", "null"], description: "YYYY-MM-DD" },
            license_number_last4: str,
            // Insurance
            insured_name: str,
            loss_payee: str,
            additional_insured: str,
            comprehensive_and_collision: bool,
            property_limit: num,
            liability_each_occurrence: num,
            liability_aggregate: num,
            policy_expiration: { type: ["string", "null"], description: "YYYY-MM-DD" },
            vehicle_listed: bool,
            // Anything a title analyst would want to see: handwriting, stamps, cross-outs.
            notes: { type: "array", items: { type: "string" } },
          },
          required: ["type", "file_index", "pages", "legible"],
        },
      },
      package_notes: { type: "array", items: { type: "string" } },
    },
    required: ["documents"],
  },
};

export const TITLE_PROMPT = `
You are reading vehicle titling documents for Navitas Credit Corp, an equipment finance
company. Each file above may be a single document or a whole title package. Report EVERY
document you find, in page order, by calling emit_title_package once.

HOW TO SPLIT
- One entry per document, not per page. A 2-page EFA is one entry with pages [n, n+1].
- The front and the back of a title are TWO entries: title_front and title_back.
- A separate state "reassignment" form is reassignment_form, not title_back.
- DocuSign "Certificate of Completion" pages and notary-event pages are
  notary_or_signing_certificate, even though they follow a POA or the EFA.
- An electronic title printout that says "THIS IS NOT A TITLE" (e.g. Premier eTitleLien)
  is electronic_title_copy.
- A Retail Sales Order or Buyer's Order that prices the vehicle is an invoice.

LEGIBILITY
- legible=false only when you cannot read the facts this document is for (VIN, names,
  dates, amounts, signatures) with confidence. Explain in legibility_note. Blurry
  background art or a watermark alone is not illegible.
- A form that is blank or partly blank is LEGIBLE (you can read it); say it is blank in notes.
- Read pages that are rotated or upside down; only call them illegible if the text itself
  cannot be read.

WHAT TO COPY
- contract_number is ONLY a Navitas contract / agreement / EFA number (8 digits, e.g. on the
  Title Information Sheet, POA, EFA or an addendum). Never an invoice, stock, dealer, title
  or policy number.
- sold_to / ship_to: the NAME only, without the address. null when only an address is shown.
- Copy values exactly as printed (names, VINs, amounts). Dates as YYYY-MM-DD. Amounts as
  numbers. Leave a field null when it is not on the document; never guess or fill from
  another document.
- VIN: 17 characters where printed; copy what is there even if it looks wrong.
- Title lienholders: list every lienholder shown. released=true only when the title shows a
  release (signed release section, "lien released" stamp). A title that prints "NO LIENS"
  sets no_liens_stated=true and has no lienholders.
- Assignments: include every filled-in assignment/reassignment on the title back or a
  reassignment form, earliest first. new_lienholder is what is written in the
  "new lienholder" box on that assignment (null when the form has no such box or it is blank).
- POA: poa_owner_name is the vehicle owner named on the POA (the grantor). poa_role is
  "seller" only when that owner is the party SELLING the vehicle (the prior owner); when the
  owner is the customer being financed, it is "buyer". notarized=true when a notary seal/stamp and notary signature are
  present, including remote online notarization (then remote_online_notarization=true).
- If the POA's own notary block is crossed out or says "see attached", set notarized=null and
  add the note "notary acknowledgment attached". A separate acknowledgment page (e.g. a
  California All-Purpose Acknowledgment) is its own notary_acknowledgment entry.
- EFA: amount_financed is "Amount Financed"; pay_proceeds_vendor is the vendor named in
  the Pay Proceeds Direction (or the VENDOR box).
- Insurance: loss_payee exactly as written; limits as numbers.

PRIVACY — do NOT copy these, anywhere, including notes:
- full driver's license numbers (only the last 4 digits, in license_number_last4)
- dates of birth, Social Security numbers, bank account numbers
- in notes: no people's names, home addresses, email addresses or phone numbers.

NOTES — anomalies only
- notes are ONLY for things a title analyst must look at: handwriting such as "Lien Hold",
  cross-outs or white-out, a different contract number written in, a required signature
  missing, an odometer discrepancy box ticked, an auction or consignment sale, a date that
  looks wrong. At most 3 per document, one short sentence each.
- Do NOT summarise the document, restate fields you already filled, or note things that are
  normal (blank unused reassignment sections, DocuSign details, terms and conditions).
  Leave notes empty when nothing is wrong.
`.trim();
