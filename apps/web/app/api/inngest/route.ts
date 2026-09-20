import { serve } from 'inngest/next';
import type { NextRequest } from 'next/server';
import type { JobDeps } from '@recouple/pipeline';
import {
  inngestClient,
  inngestKeysFromEnv,
  readDocumentFunction,
  type JobStoreHandle,
} from '../../../lib/inngest';
import { pipelineDepsFor, storeForActor } from '../../../lib/pipeline';

/**
 * Where Inngest calls us back to run the read (ADR 0021).
 *
 * The SDK verifies Inngest's signature against `INNGEST_SIGNING_KEY` on every
 * request — the client is built in cloud mode unless `INNGEST_DEV` says
 * otherwise — so an unsigned POST here does not run anything. That check is the
 * whole authentication of this endpoint: there is no session, and the function
 * it fronts builds a tenant's store from the payload it is handed.
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
 * it, and the fix is the plan rather than this number.
 */
export const maxDuration = 300;

/** Never prerendered: every request here is a signed call from Inngest. */
export const dynamic = 'force-dynamic';

type Served = ReturnType<typeof serve>;

let served: Served | undefined;

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
    ],
  });
  return served;
}

function notConfigured(): Response {
  return new Response(
    'no Inngest binding here: this deployment reads documents inside the upload request',
    { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } },
  );
}

export async function GET(request: NextRequest, context: unknown): Promise<Response> {
  return (await handlers()?.GET(request, context)) ?? notConfigured();
}

export async function POST(request: NextRequest, context: unknown): Promise<Response> {
  return (await handlers()?.POST(request, context)) ?? notConfigured();
}

export async function PUT(request: NextRequest, context: unknown): Promise<Response> {
  return (await handlers()?.PUT(request, context)) ?? notConfigured();
}
