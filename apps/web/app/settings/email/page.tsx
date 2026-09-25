import { requireSession } from '../../../lib/session';
import { mayWrite } from '../../../lib/pipeline';
import { inboundEmailFromEnv, inboundStoreFor } from '../../../lib/inbound';
import { mayManageInboundAddresses } from '../../../lib/inbound-addresses';
import { isUuid } from '../../../lib/request';
import { InboundEmailPage, type InboundDeployment } from '../../../components/inbound-email';
import { viewerOf } from '../../../lib/viewer';

export const dynamic = 'force-dynamic';

/**
 * Settings → Email: resolve the member, read, render (ADR 0047 §4).
 *
 * Every read is this tenant's through RLS, as the member signed in. A
 * `read_only` member is told how many addresses there are and shown none of
 * them, and the emails that filed nothing are not asked for on their behalf.
 */
export default async function EmailSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; confirm?: string }>;
}) {
  const session = await requireSession();
  const { email, confirm } = await searchParams;
  const identity = { orgId: session.org.orgId, userId: session.userId };
  const writer = mayWrite(session.org.role);
  const inbound = inboundStoreFor(identity);
  const today = new Date();

  const binding = inboundEmailFromEnv();
  const deployment: InboundDeployment =
    binding.kind === 'bound'
      ? { kind: 'bound', domain: binding.domain }
      : binding.kind === 'none'
        ? { kind: 'none' }
        : { kind: 'misconfigured', reason: binding.reason };

  return (
    <InboundEmailPage
      viewer={viewerOf(session)}
      viewerUserId={session.userId}
      deployment={deployment}
      addresses={await inbound.addresses()}
      mayWriteHere={writer}
      mayManage={mayManageInboundAddresses(session.org.role)}
      filedNothing={writer ? await inbound.emailsThatFiledNothing(today) : []}
      notice={email}
      confirmRetire={isUuid(confirm) ? confirm : undefined}
      today={today}
    />
  );
}
