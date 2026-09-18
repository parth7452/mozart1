---
description: Draft a versioned retailer playbook from a notice or routing guide
---

Draft a retailer playbook as data — never as code. Fill every fact from the
source document or an explicit user answer, and attach provenance
(`source_url` or document + page, `captured_at`) to each one. Leave a fact out
rather than guessing it.

Required: `retailer_key`, `display_name`, `version`, `effective_from`,
`identity_signals`, `code_map` (retailer code → canonical reason code),
`deadline_rules`, `evidence_requirements`, `submission_channel`,
`auto_reversal_behavior` (this one drives billing attribution, so mark it
`unknown` rather than assuming), `escalation_path`.

Mark the playbook `confidence: low` until a human confirms it, and list the one
to three questions a user should be asked to raise that confidence.
