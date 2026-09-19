# 0018 — A hosted scanner is reached over authenticated HTTPS, not raw clamd

- Status: accepted
- Date: 2026-09-19

## Context

`apps/web` is deployed and can sign people in, list cases and render a review.
It cannot accept an upload. `pipelineDepsFor` finds no `CLAMAV_HOST`, builds a
`NullScanner`, and the gate refuses the file with `not scanned clean: error
(none)`. That is the design working (invariant 4, ADR 0007) — and it means
production has no scanner at all.

`ClamAvScanner` speaks clamd's INSTREAM protocol over TCP on port 3310. That is
the right protocol on a private network and the wrong one across the public
internet, for a reason that is not a preference:

**clamd has no authentication.** There is no password, no token, no TLS. Any
host that can open a socket to port 3310 can submit files, read the signature
version, and — depending on how clamd was built — reach `SCAN`, which takes a
*path* on the scanner's own filesystem. Exposing it publicly so Vercel can
reach it hands every scanner on the internet an unauthenticated service.

An IP allowlist does not rescue it: Vercel's egress addresses are not static
without a dedicated-egress add-on, so the allowlist would have to be wide
enough to cover a shared pool, which is most of the point gone.

The scan also has to be reachable from a serverless function with no VPC, and
has to return a verdict our code can treat as *deliberate* — a transport that
fails ambiguously is a transport that eventually gets read as "clean".

## Decision

Add a second `MalwareScanner`, `HttpScanner`, that POSTs the bytes to a scan
service over HTTPS with a bearer token and reads back a JSON verdict. clamd
itself stays where it belongs: bound to loopback inside the scan service's own
container, never routable.

The service is in `services/clamav-scan`: `clamav/clamav` with a small Node
process in front of it that authenticates the caller, enforces a size ceiling,
runs INSTREAM against loopback clamd, and answers
`{"status":"clean"|"infected"|"error", "scanner", "detail"}`.

`scannerFromEnv` becomes the single place that decides which scanner an
environment gets, and `pipelineDepsFor` calls it instead of repeating the
decision:

| Configuration | Scanner |
| --- | --- |
| `CLAMAV_SCAN_URL` set (+ `CLAMAV_SCAN_TOKEN`) | `HttpScanner` — hosted, what Vercel uses |
| `CLAMAV_HOST` set | `ClamAvScanner` — direct clamd, what `docker compose` gives a laptop |
| neither | `NullScanner` — the file is not read |

`HttpScanner` reports `clean` only for HTTP 2xx carrying a JSON body whose
`status` is exactly `"clean"`. A non-2xx, a body that is not JSON, a status it
does not recognise, a timeout and a DNS failure are all `error`, and the gate
treats every one of them as "not clean". `CLAMAV_SCAN_URL` without a token is
`NullScanner`, not an unauthenticated call: a half-configured scanner is an
unconfigured one.

## Consequences

Uploads work in production once the service is deployed and two variables are
set, and the scanner can be redeployed, resized or replaced without touching
the app.

It costs a container that has to stay warm. ClamAV's signature database is
~1 GB resident and takes 30–60s to load, so this cannot be serverless and
cannot scale to zero; a small always-on machine is the shape of it. `freshclam`
runs in the container, so signatures stay current without us doing anything.

A scan is now a network round trip with the file in it — one more hop that can
be slow. The 25 MB ceiling the upload route already enforces is repeated in the
service, because a limit only enforced by the caller is not a limit.

The token is a shared secret in two places. Rotating it means setting it on the
service and on Vercel, in that order, and a mismatch fails closed and loudly
rather than quietly skipping the scan.

We now have a second implementation of "did this file scan clean", which is a
second thing that can drift. `interpretClamdReply` stays the one parser of
clamd's answer — the service imports nothing from us and reimplements it in 20
lines, which is the honest cost of keeping the service dependency-free.

## Invariants touched

**Invariant 4 (document content is untrusted).** Unchanged in what it requires
and strengthened in practice: the gate is still `assertScannedClean`, which
still reads a recorded verdict and still refuses anything that is not `clean`.
What changes is that a deployed environment can now *get* a real verdict
instead of only ever getting `error`. Enforced by `assertScannedClean` in
`packages/ingest/src/scan.ts`, by `processUpload` halting before any model
call, and by `apps/web/test/fail-closed.test.tsx`, which asserts the
unconfigured and half-configured cases both come back as `none`.

No other invariant is touched. The scan service holds no tenant data beyond the
bytes of the file it is scanning for the duration of the call, has no database
credentials, and cannot write anything.

## Rollback

Unset `CLAMAV_SCAN_URL`. The environment falls back to `CLAMAV_HOST` if it has
one and to `NullScanner` if it does not — which stops uploads rather than
letting an unscanned file through. Delete `services/clamav-scan` and the
`HttpScanner` class; nothing else imports them.
