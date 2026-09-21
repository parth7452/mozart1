# The customer evaluation pack

Fifteen documents across three cases — two staffing, one freight — supplied as a
`customer_evals_15` pack and copied here unchanged: twelve simulated camera
JPEGs, three native-text PDFs, a per-document OCR label (full transcription plus
word polygons) and case-level ground truth.

`packages/fixtures/src/customer.ts` is what reads this directory. It records the
document-type mapping and why each one was chosen; this file records what the
pack says about itself.

**It is synthetic. Its own README says so, and so does every label file
(`"synthetic": true`). Nothing here is a real customer document, no recovery
described here has happened, and no number from this suite is evidence about
production accuracy.**

## What the pack's README says, verbatim

> CUSTOMER DOCUMENT EVALUATION PACK
> 15 new documents: 12 camera-style JPEGs and 3 native-text PDFs.
> These are programmatically simulated photographs, not real camera captures.
> All companies, people, approvals and transactions are fictional. No visible training markers appear in the source documents.
>
> CASES
> STF-201: staffing overtime; dispute full $600 with written approval.
> LOG-202: freight; dispute $500 late fee, accept $300 documented shortage.
> STF-203: staffing weekend premium; request missing written approval; $450 at issue but recovery is undetermined.
> No recovery has actually occurred. Labels describe expected decisions under the supplied fictional terms.
>
> OCR LABELS
> JSON and TXT per document; full transcription and word polygons.
> Polygons use top-left origin; JPEG coordinates are pixels after perspective transformation. PDF coordinates are points.
> Polygons derive from source typography and are not exact ink segmentation.
> Shared case references are contextual labels and may not all appear on each page.
> Case monetary labels are integer cents. A null recovery amount means undetermined, not zero.
>
> EVALUATION
> Keep all five documents for a case in the same data split. Do not train on a case you use as a held-out evaluation.
> This small synthetic set tests extraction, linkage and evidence reasoning; it cannot estimate production accuracy.
> Camera effects include perspective, paper shadows, desk texture, uneven illumination, noise, blur and JPEG compression. No text occlusion is introduced.

## What that means for how this repo uses it

- **Five documents per case stay together.** The suite is scored as one suite,
  never split across a train/eval boundary, because the pack asks for that and
  because a case is the unit that means anything here.
- **A null recovery is undetermined, not zero.** STF-203 is worth $450 and the
  pack declines to say what comes back; `recoverCents` is `null` and stays
  `null`. Writing 0 would turn "we do not know" into "we recover nothing".
- **"No visible training markers" is asserted, not assumed.** The OCR starter
  pack stamps every page `SYNTHETIC TRAINING SAMPLE`, which its own README warns
  can become a shortcut feature a classifier learns instead of the document.
  `packages/fixtures/test/customer.test.ts` reads the three PDFs' own text
  layers and all fifteen label transcriptions and fails if any such marker
  appears.
- **The label transcription is the expected text layer, not the input.** The
  twelve JPEGs are photographs and reach the pipeline with no text layer at all,
  exactly as a real camera capture would; OCR supplies one at recording time.
  Handing the model a perfect transcription of a photograph would measure
  nothing. For the three native PDFs the transcription *is* the document's own
  text layer, and a test decodes each PDF to prove it.

## Files

| Path | What it is |
| --- | --- |
| `documents/` | 12 JPEGs and 3 PDFs, byte-identical to the pack |
| `labels/*.txt` | full transcription, one file per document |
| `labels/*.json` | the same transcription plus per-word polygons and the pack's own `synthetic` flag |
| `manifest.json` | document id, case id, the pack's document-type string, file and rendering |
| `case_ground_truth.json` | per case: vendor, customer, invoice, gross/deduction/recovery cents, decision, basis |
