import { serve } from 'inngest/next';
import type { NextRequest } from 'next/server';
import type { JobDeps } from '@recouple/pipeline';
import {
  inngestClient,
  inngestKeysFromEnv,
  readDocumentFunction,
  type JobStoreHandle,
} from '../../../lib/inngest';
import { ledgerSyncFunctions } from '../../../lib/inngest-ledger';
import { pipelineDepsFor, storeForActor } from '../../../lib/pipeline';
import { connectionsToSync, ledgerSyncDepsFor } from '../../../lib/ledger-sync';

/**
 * Where Inngest calls us back to run the read (ADR 0021).
 *
 * The SDK verifies Inngest's signature against `INNGEST_SIGNING_KEY` on every
 * request — the client is built in cloud mode unless `INNGEST_DEV` says
 * otherwise — so an unsigned POST here does not run anything. That check is the
 * whole authentication of this endpoint: there is no session, and the function
 * it fronts builds a tenant's store from the payload it is handed. Which is why
 * a production build with `INNGEST_DEV` set serves nothing at all: dev mode
 * turns that check off.
 *
 * With no keys there is no client, no function and no endpoint: a deployment
 * that runs its reads inline answers 503 here rather than serving a job runner
 * that nothing can authenticate.
 */

/**
 * The longest a read may take, in seconds.
 *
 * A dense remittance is around 63 seconds of model time on its own, and a scan
 * adds OCR in front of it; the request path's default of 10–15 seconds is what
 * ADR 0021 is about. 300 is the largest value Vercel allows on the plans this
 * project might be on — the plan is not recorded in this repository, so if it is
 * Hobby the platform clamps this to that plan's ceiling rather than honouring
 * it, and the fix is the plan rather than this number. What a clamp costs when
 * it lands mid-extraction is ADR 0021's "What a clamped `maxDuration` costs".
 */
export const maxDuration = 300;

/** Never prerendered: every request here is a signed call from Inngest. */
export const dynamic = 'force-dynamic';

type Served = ReturnType<typeof serve>;

let served: Served | undefined;

/** A deployment with no binding at all, which is the safe default (ADR 0021). */
const NO_BINDING =
  'no Inngest binding here: this deployment reads documents inside the upload request';

/**
 * Why this endpoint is not serving, when it is not. `undefined` means it is.
 *
 * Two reasons, said apart because they mean opposite things to whoever is
 * looking: one is a deployment that reads inline and never wanted a job runner,
 * the other is a deployment that wanted one and must not have it.
 */
function refusedBecause(): string | undefined {
  // `INNGEST_DEV` puts the SDK in dev mode, and dev mode does not verify
  // Inngest's signature. That is right on a laptop, where the local dev server
  // is the only thing calling this. In production that signature is the whole
  // authentication of this endpoint: without it, anyone who can reach this URL
  // can hand the function a payload naming any org and any member, and the
  // function would build that tenant's store from it. Serving is not an option,
  // so it refuses and names the variable to unset.
  if (isDevMode() && process.env.NODE_ENV === 'production') {
    return (
      'INNGEST_DEV is set in a production build, and dev mode does not verify ' +
      'Inngest’s request signature — which is this endpoint’s only authentication ' +
      '(ADR 0021). Unset INNGEST_DEV.'
    );
  }
  if (inngestKeysFromEnv() === undefined) return NO_BINDING;
  return undefined;
}

/** Set is set: an empty value is not a setting, and neither is `0` or `false`. */
function isDevMode(): boolean {
  const value = process.env.INNGEST_DEV;
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

/**
 * The handlers, built once per process and only where there is a binding.
 *
 * Built lazily rather than at module load so an environment that is configured
 * wrong — one key and not the other — fails on a request to this endpoint with
 * the error `inngestKeysFromEnv` raises, instead of taking down every route in
 * the app at import time.
 */
function handlers(): Served | undefined {
  if (served !== undefined) return served;

  const keys = inngestKeysFromEnv();
  if (keys === undefined) return undefined;

  const client = inngestClient(keys);
  served = serve({
    client,
    functions: [
      readDocumentFunction(client, {
        // The identity in the event, and nothing else, decides what this can
        // see: `app_rw` with those claims, the same store a request builds.
        storeFor: (identity) => storeForActor(identity),
        depsFor: (store: JobStoreHandle): JobDeps => pipelineDepsFor(store),
      }),
      // The schedule, and the per-connection sync it fans out to (ADR 0031).
      // The fan-out lists connections with no tenant claims, because it is the
      // query that decides which tenants to adopt; every sync it triggers runs
      // as the connection's own member, through RLS, like everything else.
      ...ledgerSyncFunctions(client, {
        connectionsToSync,
        // Copied into a mutable array because that is what the SDK's signature
        // takes; the payloads themselves are the ones the fan-out memoized, so
        // a retry sends the same `syncKey`s.
        send: async (events) => {
          await client.send([...events]);
        },
        depsFor: (identity) => ledgerSyncDepsFor(identity),
      }),
    ],
  });
  return served;
}

/**
 * 503, with a misconfiguration logged as well as returned.
 *
 * Whoever set `INNGEST_DEV` on a production deployment is not reading this
 * endpoint's response body — Inngest is, and all it will report is a failing
 * sync. A refusal nobody can see is a refusal nobody fixes, so that one goes to
 * the log too. Having no binding at all is not a fault and is not logged: it is
 * what a deployment that reads inline is supposed to answer here, on every
 * request, forever.
 */
function notServing(reason: string): Response {
  if (reason !== NO_BINDING) console.error(`[recouple] /api/inngest refuses to serve: ${reason}`);
  return new Response(reason, {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

export async function GET(request: NextRequest, context: unknown): Promise<Response> {
  const reason = refusedBecause();
  if (reason !== undefined) return notServing(reason);
  return (await handlers()?.GET(request, context)) ?? notServing(NO_BINDING);
}

export async function POST(request: NextRequest, context: unknown): Promise<Response> {
  const reason = refusedBecause();
  if (reason !== undefined) return notServing(reason);
  return (await handlers()?.POST(request, context)) ?? notServing(NO_BINDING);
}

export async function PUT(request: NextRequest, context: unknown): Promise<Response> {
  const reason = refusedBecause();
  if (reason !== undefined) return notServing(reason);
  return (await handlers()?.PUT(request, context)) ?? notServing(NO_BINDING);
}
