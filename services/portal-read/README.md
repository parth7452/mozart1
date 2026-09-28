# `portal-read`: the browser that reads a payer's portal

A portal read needs a browser that signs in, answers MFA and pages through
screens. That outlasts what Vercel lets a function run, so the browser runs
here, in a container of its own ([ADR 0057](../../docs/adr/0057-a-portal-is-read-never-written.md)
§6). This is the one process that ever opens a portal credential:

- **It opens one only for the recipe it is about to run.** A credential is
  sealed to a *binding*: the sign-in origin, the paths a sign-in or MFA form
  may post to, and a hash of the host allowlist. The worker computes the
  binding of the recipe it is handed and compares it with the credential's
  before it calls `kms:Decrypt` (§6-7). The binding is also inside the
  encryption context, so a binding altered in the row does not decrypt.
- **It types a value only where the binding says.** The username and
  password go only into the bound sign-in form, and a TOTP code, computed
  here from the sealed setup key, goes only into the bound MFA form, and never
  the same code twice for one connection. That is the runner's rule
  (`packages/portal/src/runner`) and this worker's, and the tests check it
  against the fixture portal.
- **Its browser runs in Chromium's sandbox**, with an environment that holds
  nothing of the worker's (below). A portal's pages are untrusted, and this
  process holds a token and AWS credentials that can decrypt every tenant's
  portal credential.
- **It holds nothing else.** No database credential and no model key: the job
  reads the recipe and the sealed credential as `app_rw`, hands both over,
  and writes back what comes out. The worker holds its bearer token and
  `kms:Decrypt` on the portal key (a separate key from QuickBooks'), and can
  open a credential but never seal one.

```
GET  /health                             no token           -> 200 {"status":"ok"}
POST /runs                               Bearer <token>     body: RunRequest -> RunHandle
GET  /runs/:runId                        Bearer <token>     -> RunHandle
GET  /runs/:runId/result                 Bearer <token>     -> RunResult, once the run is done
GET  /runs/:runId/captures/:index        Bearer <token>     -> RunCapture, one at a time, with its bytes
```

The shapes are `packages/portal/src/contracts.ts`'s, and every answer the
tests read is parsed by the contract's own schemas. An error is
`{"error": <code>}` and nothing else, never an echo of the request:

| Status | `error` | When |
| --- | --- | --- |
| 401 | `unauthorized` | No bearer token, or the wrong one, on any route but `/health` |
| 400 | `bad_request` | Not a `RunRequest`, a malformed run id or capture index, or a run id this worker holds for another tenant or connection |
| 413 | `too_large` | A body over 256 KB, declared or streamed |
| 404 | `not_found` | A run or capture this worker does not hold, or any other route |
| 409 | `not_done` | A result or capture asked of a run still running |
| 503 | `busy` | A run is in flight. Nothing was started; try again later |

`POST /runs` answers 202 for a new run and 200 for an id the worker has
already seen, which it never starts again, so a retried job step cannot sign
in twice.

## What it refuses before anything is opened

These are decided on the request alone. The run is created already `done`,
nothing is decrypted, no browser starts, and the portal is sent nothing:

| The request | The run ends |
| --- | --- |
| A host on the recipe's allowlist, or its sign-in origin's, is not public: loopback, a private or link-local address (a cloud metadata service among them), unique-local IPv6 (Fly's private network), `localhost`, `.internal`, `.flycast`, `.local`, or a name with no dot. Hosts are read as a browser reads them, so `2130706433` is 127.0.0.1 (`src/destinations.ts`) | `failed`, `RecipeHostNotPublicError` |
| A step's URL, an `open` step's `url` or a `search` step's `recordedAction` (inside a `for_each` too), is one the guard would not let the browser load: not http(s) (`data:`, `about:`, `chrome:`, `javascript:`, `file:`), or to a host off the recipe's allowlist. Or it carries a user name or a password | `failed`, `RecipeStepUrlError` |
| The recipe's sign-in origin, or a step's URL, is plain http. Only a test's worker admits http, and only to its loopback fixture | `failed`, `RecipeNotHttpsError` |
| The recipe's binding is not the credential's: another host, sign-in path or origin | `needs_attention`, `binding_mismatch`. An owner enters the credential again under the new recipe |
| The credential names a KMS key other than `PORTAL_KMS_KEY_ID` | `failed`, `PortalKeyMismatchError` |
| A recipe step's name is one no result could carry (the contract's step-name rule) | `failed`, `RecipeStepNameError` |

The first three are asked in that order, before the binding and whatever the
credential: such a recipe runs for nobody, so no owner is asked to enter a
credential again for it. A recipe is a tenant owner's text, and the worker is
shared and sits inside the operator's network, so these three hold whoever
wrote the recipe.

The second is there because the guard cannot see everything the runner does.
At run time the guard decides every request the browser sends, in the runner's
route handler and again in its egress proxy, but a navigation the runner starts
itself (`page.goto`) to a URL that is not http(s) sends no request at all. Run by the real
runner, an `open` step to a `data:` URL ran to `completed`, and a
`capture_page` after it handed the job the recipe's own HTML as the portal's
page; `about:blank`, `chrome://version` (the browser's version and command
line) and `javascript:` did the same. A `file:` URL was refused at run time,
after decrypt. So every URL a step names is put to the guard's own rule
(`decideRequest`, as a GET) here, from the recipe's text. The recipe schema
should refuse such a URL at its source, and the runner should put a step's
URL to the guard before it navigates; until both do, this is the check.

These rules read the recipe's text, before anything is decrypted: its host
names as written, not what they resolve to. What the browser actually connects
to is held at run time, by the runner's egress proxy
(`packages/portal/src/runner/egress.ts`), under the same policy this worker
passes it (`destinations`, public destinations only in `main.ts`):

- **Every request the browser sends goes through the proxy**, the ones the
  runner's route handler allowed included: the route handler aborts a refusal
  and hands every other request back to the browser to send, so nothing on a
  portal's behalf is fetched from the worker's own process. What Playwright
  never routes (a redirect hop, a beacon or keepalive fetch sent as a page
  unloads, a worker's WebSocket, a `WebSocketStream`, a download) goes the same
  way.
- **The proxy decides method and target as well as the host.** Inside an https
  tunnel it answers the TLS handshake with a key made for the run, which the
  browser is told to accept and nothing else is, so it reads each request
  there as it reads a plain one, and puts it to the guard with the step
  running. Every upgrade, a WebSocket among them, is refused.
- **It connects only to an address it has checked.** It resolves each name,
  refuses the connection when any answer is not public (loopback, private,
  link-local and the cloud metadata address among them, and Fly's `fdaa::/16`),
  and connects to the answer it checked, so an answer that changes between the
  check and the connection cannot move it. It checks the portal's certificate
  against the system's roots.
- **Plain http goes nowhere in production.** It is refused before any name is
  looked up, whatever the recipe says, a redirect or a link to http on an
  allowlisted host included. Only a test's worker admits it, to loopback.

A refusal there ends the run `failed` with `guard_refused` if it was a
navigation, and is counted in the result's `refusals` either way.
`worker.test.ts` runs a worker with `main.ts`'s own policy and a recipe whose
public-looking host resolves to the fixture portal's loopback address: every
check before decrypt passes, the credential is opened, and the portal is sent
nothing.

Once a run has started, it can also end `failed` with a class name of the
worker's own:

- `TokenDecryptionError`: the credential did not open. Another tenant,
  another connection, a binding altered in the row, or KMS refused. The run's
  `run_ended` log line names what refused it as `decryptCause`, a class name:
  `AccessDeniedException` (the worker's IAM policy), `IncorrectKeyException`
  (the wrong key), `InvalidCiphertextException` (a context or ciphertext that
  does not match), or a network error class when KMS could not be reached.
- `PortalCredentialPayloadError`: it opened, but not to a credential.
- `TotpStepUnavailableError`: no fresh TOTP step came, because the clock kept
  going back.
- `PortalCaptureTooLargeError`: a capture was over 50 MB, the door's own
  ceiling (`MAX_UPLOAD_BYTES`), which ingest would refuse anyway.
  `PortalRunCapturesTooLargeError`: the run's captures together passed
  128 MB. Either way the run ends at the step that made the capture, that
  step and any loop around it are marked as not passed, and no capture of the
  run is offered.
- `PortalRunOverranError`: the run outlasted every cap (see below).
- `PortalResultInvalidError`: the run broke the contract, a worker fault, so
  its captures are not offered.

Everything else is the runner's, as ADR 0057 §13 and ADR 0062 §5 name them.

## The browser

Every browser the worker starts goes through `src/launch-chromium.sh`: the
runner is handed its path as the browser to launch, and it starts the real
Chromium with two things the worker requires of anything that renders a
portal's pages.

- **Chromium's sandbox.** Playwright passes `--no-sandbox` unless asked not
  to, and the launcher drops it, so each renderer runs under a seccomp filter
  in user, PID and network namespaces of its own, where it can open no file
  (no other process's `/proc` entries among them), see no other process, and
  reach the network only through the browser's own network service. Any other
  switch that would turn part of the sandbox off ends the launch. Chromium
  refuses to start where its sandbox cannot, rather than running without it.
- **An environment built from nothing**: `PATH`, `HOME`, `TMPDIR` and the
  locale. The worker's own environment holds its AWS credentials and the
  rest of its configuration, and no process that renders a page is given any
  of it.

Before it takes a run, the worker starts the browser once, that same way, on
an empty page behind an egress proxy that lets nothing out, and asks the
kernel (`/proc/<pid>/status`) whether each renderer runs under seccomp in a
PID namespace of its own (`src/browser.ts`, `src/sandbox.ts`). If not, it
refuses to start, naming what it found. So a platform where the sandbox
cannot start (no unprivileged user namespaces, a container runtime that
refuses them, root) is found at deploy, not by a run. It also refuses to run
as root.

What this does not do, said plainly:

- **The worker's own environment is still readable by its own user.** It
  removes the token and the key's name from `process.env`, which keeps them
  from any process it starts later. The kernel keeps the environment a process
  started with, and `/proc/<pid>/environ` shows it, AWS credentials included,
  to any process of the same user. What keeps a portal's page from it is the
  renderer's sandbox, which cannot open that file.
- **The browser's own process is not sandboxed**, as Chromium's never is: it
  is the broker the sandboxed renderers ask for what they may have. A page
  that escaped the renderer's sandbox as well would be the same user as the
  worker. Short-lived AWS credentials limit what that would get ("AWS
  credentials", below).

## What it keeps, and for how long

- **One run at a time.** A run is a browser and a signed-in session.
- **A result and its captures for an hour** (`PORTAL_WORKER_RESULT_TTL_MS`),
  then they are forgotten. The run's id is remembered, so it is never run
  again. A restarted worker holds nothing, and the job records a run whose
  result it cannot find as failed.
- **Captures within bounds.** A capture's bytes are held as they came, in a
  buffer outside the JavaScript heap, and are base64'd a piece at a time as
  they are sent, so neither holding nor sending one costs a copy of it. No
  capture over 50 MB and no run over 128 MB is held (above). Across every
  finished run the worker holds at most 256 MB: past that, the captures of
  other finished runs are let go to make room for the newest, those the job
  has already fetched in full first, then the oldest. The run keeps its
  result, the capture answers 404, and the job records the run failed rather
  than starting it again; a `captures_let_go` line names the run.
- **The last TOTP step each connection typed a code in**, by its tenant's and
  its own id and a step number, nothing derived from any secret. A second
  sign-in for the same connection within one 30-second step waits for the
  next step (RFC 6238 §5.2: a verifier refuses a code used twice, and a
  refused code would read as a refused credential and turn the connection
  off). Another connection waits for nothing. It is forgotten when the worker
  restarts.
- **The plaintext for its run alone.** The runner asks for each value as it
  types it. When the run ends the credential is released, and anything still
  holding it gets an error, never a value.
- **Nothing on disk.** Every browser starts from an empty profile, and
  Playwright deletes the profile and any download when the browser closes. No
  trace, HAR, video or screenshot is made. A test runs the worker with a
  temporary directory of its own, sees the profile there mid-run, and finds
  the directory empty afterwards.
- **Logs** are one JSON line per event, with ids, outcome codes, counts,
  recipe step names and class names. Never a credential, a code, a URL, a
  host, page text or an error's message. A test reads everything the worker
  wrote and finds none of them.
- **A run that will not end** is cut off. The runner is handed the recipe's
  `maxRunMs` or 30 minutes, whichever is less, and stops itself there. Two
  minutes past that, a run still going ends `failed` with
  `PortalRunOverranError`. If its browser still has not closed a minute
  later, the process exits and Fly starts a clean one (`[[restart]]` is
  `always`).

## Configuration

| Variable | What |
| --- | --- |
| `PORTAL_READ_TOKEN` | The bearer token, 64 characters or more of printable ASCII (`openssl rand -hex 32`). The same value goes on Vercel |
| `PORTAL_KMS_KEY_ID` | The portal key's **ARN**, `arn:aws:kms:<region>:<account>:key/<id>`. A sealed credential records the ARN KMS resolved, and the worker refuses any other, so an alias is refused at start. The KMS client asks the ARN's region |
| `AWS_ROLE_ARN` | The worker's role, assumed with Fly's OpenID Connect token ("AWS credentials"). Preferred |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Static keys, only where OIDC cannot be set up. The AWS SDK takes them before a role when both are set |
| `PORT` | 8080 unless set |
| `PORTAL_CHROMIUM_PATH` | An absolute path, only where Chromium is not where `playwright install chromium` put it. The image needs none |

It refuses to start, naming the variable and never its value, without the
token or with a short one, without the key or with anything but a key ARN,
without a Chromium, with `DEBUG`, `PWDEBUG` or `NODE_DEBUG` set (Playwright's
`pw:api` debug channel logs every value the browser types), as root, and
when its browser does not start sandboxed. The `listening` line says which of
the AWS SDK's sources holds its credentials (`awsCredentials`:
`web_identity`, `static_keys`, or `provider_chain` for anything else).

### AWS credentials

The worker's identity may call `kms:Decrypt` on the portal key and nothing
else. Give it that identity by Fly's OpenID Connect rather than a static key,
so what it holds expires in minutes:

1. In IAM, add an OpenID Connect identity provider for
   `https://oidc.fly.io/<fly-org>`, audience `sts.amazonaws.com`.
2. Create a role, `recouple-portal-read`, trusted by that provider for
   `sts:AssumeRoleWithWebIdentity`, with the conditions
   `oidc.fly.io/<fly-org>:aud` = `sts.amazonaws.com` and
   `oidc.fly.io/<fly-org>:sub` like `<fly-org>:recouple-portal-read:*`, so
   only this app's Machines may assume it. Its one permission is
   `kms:Decrypt` on the portal key.
3. Set `AWS_ROLE_ARN` in `fly.toml`'s `[env]` (it names the role, and is not a
   secret) and deploy. Fly gives each Machine a token for the role, and the
   AWS SDK assumes it. The `listening` line then says
   `"awsCredentials":"web_identity"`.

Static keys (`fly secrets set AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=…`)
also work, and last until someone rotates them.

## Deploying it on Fly

The build needs the workspace, so deploy **from the repository root**, never
from this folder:

```sh
fly deploy . --config services/portal-read/fly.toml --ha=false
```

- `fly.toml` names the Dockerfile and `Dockerfile.dockerignore` beside it,
  and flyctl resolves both there. Its ignore file keeps every `.env`, key
  file, `.git` and agent folder out of what is uploaded. A flyctl that found
  no ignore file would upload the whole checkout, `.env` included, so do not
  move or rename one without the other.
- The image is Node, one Chromium with its libraries, Playwright, one bundled
  file (`build.mjs`) and the launcher beside it. No TypeScript or workspace
  source is in it, and it runs as the image's unprivileged `node` user under
  `tini`.
- **The first deploy shows whether the sandbox starts.** `fly logs` has a
  `listening` line with `"browserSandbox":"checked"` if it did, and a
  `refused_to_start` line naming what was found if it did not: most likely
  that Chromium could not create its user namespace. The worker does not run
  without it.
- **One machine, always on.** `fly.toml` keeps `auto_stop_machines = false`
  and `min_machines_running = 1`. A run's result lives in that machine's
  memory, so if `fly status` shows two machines, run `fly scale count 1`.
- **Billing must be on.** An organization on Fly's free trial stops every
  machine five minutes after it starts, whatever `fly.toml` says
  (`services/clamav-scan/README.md`). The scanner's organization has billing
  on.
- The secrets, and how to set them without a shell history holding them, are
  step 5 of `docs/plans/ariba-portal/README.md`.

### Anywhere with Docker

```sh
docker build -f services/portal-read/Dockerfile -t recouple-portal-read .
docker run -d --name portal-read -p 8080:8080 \
  -e PORTAL_READ_TOKEN -e PORTAL_KMS_KEY_ID -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \
  --security-opt seccomp=/path/to/chrome.json \
  recouple-portal-read
```

`-e NAME` with no value passes the variable from your shell, so no secret is
typed into the command. Docker's default seccomp profile refuses the user
namespaces Chromium's sandbox is made of, so under it the worker refuses to
start. Give the container a seccomp profile that is Docker's default with
`clone` and `unshare` allowed to create user namespaces. BuildKit reads
`Dockerfile.dockerignore` beside the Dockerfile.

The image was built from this Dockerfile and started on 2026-09-28 (Docker
29), with a dummy token and key ARN. The build ran in a sandbox that re-signs
all TLS, so each stage was also given that sandbox's CA, and nothing else was
changed. What it showed:

- The build context was 18 MB (the ignore file held), the workspace installed
  offline from the lockfile, and the bundle was built.
- Playwright's own Chromium and its libraries were installed, and `tini` was
  at `/usr/bin/tini`.
- The worker ran as `node` and found its launcher beside the bundle in `/srv`.
- Under `--security-opt seccomp=unconfined` it logged `listening` with
  `"browserSandbox":"checked"`, and its health check passed in six seconds.
  `/health` answered, and `/runs/…` answered 401 without the token.
- Under Docker's default profile it logged `refused_to_start`: "Chromium did
  not start with its sandbox".

Fly's builder and machines are not that sandbox, so the first deploy is
still the check that counts there.

## Pointing the app at it

Three variables on Vercel, **Production only**, never Preview
(`docs/supabase.md`):

```
PORTAL_READ_URL=https://recouple-portal-read.fly.dev
PORTAL_READ_TOKEN=<the same token>
PORTAL_KMS_KEY_ID=<the key's ARN>
```

The app's AWS identity may call `kms:GenerateDataKey` on the key and nothing
else, so it seals and can never open. The key policy is in step 4 of the
runbook.

## Checking it

```sh
curl -sS https://recouple-portal-read.fly.dev/health
# {"status":"ok"}

curl -sS -o /dev/null -w '%{http_code}\n' \
  https://recouple-portal-read.fly.dev/runs/00000000-0000-4000-8000-000000000000
# 401: the token is required
```

A real run is started by the job, from Settings → Portals, never by hand: the
request carries a sealed credential only the app can make.

## Rotating the token

Set the new one on Fly first, then on Vercel. Between the two, the job gets
401s and records its runs as failed. Nothing is started unauthenticated.

## Tests

From the repository root:

```sh
CI=1 pnpm exec vitest run --config services/portal-read/vitest.config.ts
pnpm exec tsc -p services/portal-read/tsconfig.json
```

(`pnpm --dir services/portal-read test` and `… typecheck` do the same.) The
repository's `pnpm typecheck` includes the worker's `tsconfig.json`, and CI
runs these tests in a step of their own (`.github/workflows/ci.yml`), since
`pnpm test` covers the workspace's packages only. They
need a Chromium: the container's at `/opt/pw-browsers`, or
`pnpm exec playwright install --with-deps chromium`. Under `CI` a missing one
fails the run rather than skipping it. They also need Chromium's sandbox to
start, because the worker refuses to start without it:

- The spawned worker must not be root. Where the tests themselves run as root,
  they start it as `nobody` (uid 65534), as the image runs it as `node`.
- Unprivileged user namespaces must be allowed. Ubuntu 24.04, and so GitHub's
  `ubuntu-latest`, restricts them with AppArmor by default, and Playwright's
  Chromium has no setuid helper to fall back on, so a CI job that runs these
  tests lifts the restriction first:
  `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`.

What they cover:

- `worker.test.ts` spawns the worker as a process, with the real runner and
  Chromium, against the fixture portal (`packages/portal/test/fixture-portal`).
  Credentials are sealed by a seal-only `LocalTokenCipher` and opened by an
  open-only one injected in place of KMS (`test/serve-local-cipher.ts`, never
  in the image), whose worker may also reach the fixture on loopback. It
  covers:
  - a TOTP sign-in, completed and captured, and a dry run;
  - `credential_rejected`, `session_expired`, `mfa_unanswerable`,
    `account_mismatch`, a download and a search;
  - a binding mismatch, a foreign key, and a step that opens a `data:` URL or
    a host off the allowlist refused before `decrypt` is ever called, with the
    portal sent nothing;
  - the token on every route, one run at a time, the error answers, and the
    empty temporary directory;
  - that none of the username, password, TOTP secret, any code typed, the
    token or page text reaches stdout or stderr;
  - a second worker with `main.ts`'s own policy (public destinations only),
    whose test entry answers a public-looking name with the fixture's loopback
    address: the run decrypts, is refused at its first page by the egress
    proxy, and sends the portal nothing.
- `main.test.ts` runs the production entry point: what it refuses to start
  without, a browser that does not start sandboxed among them, and a recipe
  on loopback refused before KMS is asked anything. A production worker's
  browser reaches public destinations only, so the whole run through KMS is
  made by `test/serve-kms.ts`, which is `main.ts`'s own start and cipher with
  the loopback fixture reachable. Its credential is sealed by a seal-only
  `KmsTokenCipher` and opened by the worker's own, through the AWS SDK, against
  a fake KMS on loopback (`AWS_ENDPOINT_URL_KMS`). The one `Decrypt` names the
  worker's key and the credential's portal context, a refused decrypt's
  `decryptCause` is on its `run_ended` line, and while the run is in flight
  the test reads its browser out of `/proc`: no `--no-sandbox` on its command
  line, every renderer under a seccomp filter in its own PID namespace, and
  nothing in its environment but the launcher's few variables, where the
  worker's held AWS keys and a KMS endpoint.
- `server.test.ts` runs the server in-process with a runner the test controls:
  every refusal before decrypt, reaching neither `decrypt` nor the runner (the
  destination rules among them: a host that is not public; a step URL that is
  `data:`, `about:`, `chrome:`, `javascript:`, `file:`, `view-source:`, `ftp:`
  or `wss:`, off the allowlist, on another port or carrying a password, inside
  a `for_each` or a `search` too; and plain http, with a test's worker
  admitting it to loopback alone); the credential released after its run; one
  TOTP code per step per connection across runs; the run cap handed to the
  runner; the capture limits, a capture streamed, and captures let go to make
  room; the result forgotten after its time; and the watchdog.
- `credentials.test.ts`, `destinations.test.ts` and `capture.test.ts` are the
  TOTP timing and ledger, the destination rules, and a capture's page path,
  filename and bytes.

To run `main.test.ts` against the bundle the image runs, rather than the
TypeScript (a directory every user can read, since the worker may run as
`nobody`):

```sh
node services/portal-read/build.mjs /tmp/portal-read-dist
PORTAL_READ_MAIN=/tmp/portal-read-dist/portal-read.mjs \
  CI=1 pnpm exec vitest run --config services/portal-read/vitest.config.ts main.test.ts
```

The service is not a pnpm workspace package: `pnpm-workspace.yaml` names
`apps/*` and `packages/*`. That is why `src/portal.ts` imports the portal
package's modules by path, and the one place to change when it joins.

## Not done yet

- **A step's URL is checked here, not at its source.** The recipe schema
  (`RecipeVersionSchema`) accepts any URL an `open` step or a `search` step's
  `recordedAction` names, and the runner navigates to an `open` step's URL
  without putting it to the guard. This worker refuses such a recipe before
  decrypt ("What it refuses before anything is opened"); the schema and the
  runner should refuse it too.
- **The runner could say what the launcher does.** `chromiumSandbox: true` and
  an explicit `env` on its `chromium.launch` would make the launcher's
  dropping of `--no-sandbox` a no-op rather than the only thing that turns
  the sandbox on. The launcher and the start-up check stay either way.
- **The runner reads a download whole before the worker can refuse it.** It
  should refuse one over 50 MB by its size on disk, before reading it.
- **The fixture portal accepts a TOTP code any number of times**, so the tests
  that spawn the worker cannot show a reused code refused; the in-process
  tests show the worker never types one.
- A deploy or a restart while a run is in flight loses that run. The job
  records it as failed, and a person presses **Dry run** again.
