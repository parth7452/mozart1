# 13 — Portal read, first retailer

*Phase 2 plan task. Not started; waits for approval.*

**Starts when:** Draft H accepted; a customer who uses that portal; its terms read and recorded in a short per-portal ADR.

## Steps
- `portal_credentials` sealed like QuickBooks tokens; Settings entry by an owner; a scheduled read as a member; `portal_read_runs` with class names; every fetched file through `acceptUpload`, the scan gate and the reader as `portal_fetch`.
- No method that writes to the portal.

## Done when
- A failure degrades to upload with a visible notice; nothing in the adapter can submit.
- `pnpm verify` green; any migration applied to `mozart-preview` first, then production, read back on both.
