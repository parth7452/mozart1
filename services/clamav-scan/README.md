# `clamav-scan` — the malware scanner, with a front door

`apps/web` refuses to read an uploaded file without a clean scan verdict
(invariant 4). On a laptop it talks to clamd directly. Deployed, it talks to
this: clamd bound to loopback inside a container, with a token-checked HTTPS
endpoint in front of it, because **clamd has no authentication of any kind**
and must never be reachable from a network we do not own ([ADR 0018](../../docs/adr/0018-a-hosted-scanner-is-reached-over-authenticated-https.md)).

```
POST /scan   Authorization: Bearer <token>   body: the raw bytes
  -> 200 {"status":"clean"|"infected"|"error","scanner":"clamav","detail":"…"}

GET /health  (no token; this is what the platform probes)
  -> 200 {"clamd":"PONG"} | 503 {"clamd":"unreachable"}
```

An infected file is a **200 with a verdict inside**, not an HTTP error. The
caller's gate decides what to do about it, and a 5xx here has to keep meaning
"the scanner is broken".

## What it costs and why it cannot be serverless

ClamAV's signature database is ~1 GB resident and takes 30–60s to load. There
is no scale-to-zero shape of this: a cold start would time out the upload that
triggered it. Budget one always-on machine with **2 GB of RAM** — about
$5–10/month on any of the hosts below. `freshclam` runs inside the container,
so signatures stay current with no action from us.

## Deploying it

Any host that runs a container and terminates HTTPS works. Pick one:

### Fly.io

```sh
cd services/clamav-scan
fly launch --no-deploy --name recouple-clamav      # fly.toml is already here
fly secrets set SCAN_TOKEN="$(openssl rand -hex 32)"
fly deploy
fly logs                                            # wait for the first freshclam
```

### Railway / Render

Point a new service at this directory, let it build the `Dockerfile`, set
`SCAN_TOKEN`, and give it 2 GB. Health check path `/health`, and raise the
start-up grace period to at least 240s or the first deploy will be killed
mid-signature-load.

### Anywhere with Docker

```sh
docker build -t recouple-clamav services/clamav-scan
docker run -d --name clamav-scan -p 8080:8080 \
  -e SCAN_TOKEN="$(openssl rand -hex 32)" recouple-clamav
```

It refuses to start without `SCAN_TOKEN`. An unauthenticated clamd relay is
worse than no scanner at all, because the app would believe it had one.

## Pointing the app at it

Two variables on the deployment (see [`apps/web/DEPLOY.md`](../../apps/web/DEPLOY.md)):

```
CLAMAV_SCAN_URL=https://recouple-clamav.fly.dev/scan
CLAMAV_SCAN_TOKEN=<the same token>
```

Setting the URL without the token gives you `NullScanner` — uploads stay
refused, deliberately and visibly, rather than becoming unauthenticated calls.

## Checking it for real

```sh
# clean
curl -sS -X POST "$CLAMAV_SCAN_URL" \
  -H "authorization: Bearer $CLAMAV_SCAN_TOKEN" \
  --data-binary @README.md
# {"status":"clean","scanner":"clamav","detail":"stream: OK"}

# infected — the EICAR test file, which every scanner is required to flag
printf 'X5O!P%%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' \
  | curl -sS -X POST "$CLAMAV_SCAN_URL" \
      -H "authorization: Bearer $CLAMAV_SCAN_TOKEN" --data-binary @-
# {"status":"infected","scanner":"clamav","detail":"Eicar-Test-Signature"}
```

If the second one comes back `clean`, the signature database has not finished
loading. Wait for `/health` to return `PONG` and try again.

## Rotating the token

Set it on the service first, then on the deployment. A mismatch is a 401, which
the client reports as `error`, which the gate treats as "do not read this" —
uploads stop rather than going unscanned.

## Tests

`packages/ingest/test/scan-service.test.ts` spawns `server.mjs` for real against
a fake clamd and exercises the token check, both size ceilings, INSTREAM
chunking, `/health` and the JSON contract. clamd itself is faked there because
it needs the container; the EICAR probe above is what checks the real one.
