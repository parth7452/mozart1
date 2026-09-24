import {
  defaultInboundRouteDeps,
  handleInboundPostmark,
  inboundMethodNotAllowed,
} from '../../../../lib/inbound-route';

/**
 * Where Postmark delivers inbound email (ADR 0047). Production only: a preview
 * holds neither `POSTMARK_INBOUND_SECRET` nor `INBOUND_DOMAIN` and answers 503.
 * The door is `lib/inbound-route.ts`; this file is its address.
 */

/** Never prerendered: every request is a delivery. */
export const dynamic = 'force-dynamic';

/**
 * The request only stores and scans; the read is a job. Sixty seconds is
 * inside Postmark's two-minute wait.
 */
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  return handleInboundPostmark(request, defaultInboundRouteDeps());
}

export async function GET(): Promise<Response> {
  return inboundMethodNotAllowed();
}

export async function PUT(): Promise<Response> {
  return inboundMethodNotAllowed();
}

export async function PATCH(): Promise<Response> {
  return inboundMethodNotAllowed();
}

export async function DELETE(): Promise<Response> {
  return inboundMethodNotAllowed();
}
