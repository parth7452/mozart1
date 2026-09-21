# Mozart interface refresh

Isolated branch: `codex/mozart-platform-ui`, based on main. Presentation only;
coordinate these frontend files when merging other agents' work.

## Plan
1. Carry the marketing site's Helvetica, navy, lime and orchestration motif into
   a shared workspace shell and a branded magic-link sign-in page.
2. Improve deduction list hierarchy, truthful counts, client-side search/state
   filters, readable evidence and responsive case review. Preserve route reads,
   form targets/fields, roles, provenance and approval gates.
3. Verify typecheck, existing frontend tests, production build and cassette evals;
   visually inspect desktop/mobile with clearly labelled local sample data kept
   outside production routes. Add regression coverage for filtering/count rules.
4. Deliver as a draft PR. No merge, production deployment, database changes,
   dependency changes, or changes to another agent's branch.

The marketing site's login link is a separate change in its own workspace,
pointing to https://mozart1-web.vercel.app/login. It is not deployed by this PR.

## Validation
- Workspace and web TypeScript checks pass.
- Existing web suite: 206 tests passed; two new ledger count/filter regressions pass.
- Next.js production build passes.
- Recorded cassette evals: no regression; 26 recorded documents. Unrecorded
  authored_pending, logistics and customer suites remain skipped by the runner.
- Browser: desktop sign-in/ledger, 390px sign-in/ledger/review, search + state
  filter + no-results reset. Marketing header fits mobile and points to /login.
- Database integration suite not run: this checkout has no scratch DATABASE_URL;
  this branch changes no storage code, auth handler, workflow action or migration.
- Live email delivery and authenticated production data not exercised. The local
  visual preview uses labelled illustrative data outside the app's route tree.

## Integration notes
Base: 524dbb5d907a6a22fa19501ad76983c97cd16877. Main was unchanged at the final
remote check. The open ERP and scanned-eval PRs are independent of this scope.
The shared shell and table are additive files; the two existing view components,
login presentation, metadata and stylesheet are the frontend integration points.
No new dependencies. Existing POST targets, field names and role checks remain.
