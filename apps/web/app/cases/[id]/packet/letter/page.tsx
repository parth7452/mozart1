import { notFound } from 'next/navigation';
import { CaseNotVisibleError } from '@recouple/pipeline';
import { requireSession } from '../../../../../lib/session';
import { isUuid } from '../../../../../lib/request';
import { workflowStoreFor } from '../../../../../lib/workflow';
import { DisputeLetter } from '../../../../../components/dispute-letter';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Dispute letter' };

/**
 * The packet's dispute letter, to print or save as PDF.
 *
 * One read, `getWorkflow`, through `PostgresStore` as `app_rw` with this
 * session's claims — the same read the case page makes, so it shows the same
 * packet: the approved one once there is an approval, else the latest. Any
 * member may read it, `read_only` included. A case this tenant cannot see, and
 * a case with no packet yet, are the same 404.
 */
export default async function DisputeLetterPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const session = await requireSession();
  const store = workflowStoreFor(session);
  try {
    const workflow = await store.getWorkflow(id).catch((cause: unknown) => {
      if (cause instanceof CaseNotVisibleError) return undefined;
      throw cause;
    });
    const packet = workflow?.packet;
    if (packet === undefined) notFound();
    return (
      <DisputeLetter
        deductionId={id}
        narrative={packet.narrative}
        contentHash={packet.contentHash}
        approved={workflow?.approval?.packetHash === packet.contentHash}
      />
    );
  } finally {
    await store.close();
  }
}
