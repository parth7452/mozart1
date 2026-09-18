---
description: Audit a change for money-path and invariant safety before it ships
---

Review the current diff as an auditor of money paths, not as its author. For
each of the seven invariants in CLAUDE.md, state whether this change touches it
and what still enforces it afterwards.

Then check specifically:

1. Could any code path insert into `submissions`, `writebacks` or `writeoffs`
   without an `approvals` row? Show the trigger still in place.
2. Any new UPDATE/DELETE grant, or any edit to an already-merged migration?
3. Any float, `parseFloat`, division or `toFixed` on a money value?
4. Does untrusted document text reach a component that holds tools, or a
   `DecisionState`?
5. Is the service-role key reachable from a request path?
6. Does any threshold move in the loosening direction without an ADR?
7. Are new decision paths covered by a recorded fixture and an eval case?

Report findings most severe first, each with the file, the line, and the
concrete failure it allows. If you find none, say so plainly.
