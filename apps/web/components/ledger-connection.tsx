import { LEDGER_CONNECTION_DISABLED, LEDGER_SYNC_REFUSED } from '@recouple/pipeline';
import type { LedgerConnectionOverview } from '@recouple/store-postgres';
import { resolveNotice } from '../lib/notices';
import { WorkspaceShell } from './workspace-shell';
import type { Viewer } from './case-list';

/** Whether this deployment can connect QuickBooks, and if not, what to set. */
export type QboDeployment =
  | { readonly environment: 'sandbox' | 'production' }
  | { readonly missing: readonly string[] };

/**
 * Settings → QuickBooks, as a pure function of one read (ADR 0039 §12).
 *
 * Every member sees what is connected and how its last sync went; only an owner
 * sees the buttons, and the database refuses anybody else anyway. Nothing here
 * is a credential: the company id names which books and authorises nothing,
 * and the two expiry timestamps are stored in the clear to be looked at.
 */
export function LedgerConnectionPage({
  viewer,
  connections,
  mayConnect,
  deployment,
  notice,
  today,
}: {
  viewer: Viewer;
  connections: readonly LedgerConnectionOverview[];
  /** An owner, as the session resolved it. The database is what enforces it. */
  mayConnect: boolean;
  deployment: QboDeployment;
  /** A notice key from the last step of the flow, never a sentence (`lib/notices.ts`). */
  notice?: string | undefined;
  today: Date;
}) {
  const said = resolveNotice(notice);
  const current = connections.find((connection) => connection.enabled);
  const previous = connections.filter((connection) => !connection.enabled);
  const configured = 'environment' in deployment;

  return (
    <WorkspaceShell viewer={viewer} section="quickbooks">
      <main id="workspace-main" className="workspace-main">
        <div className="page-heading">
          <div>
            <p className="eyebrow">SETTINGS</p>
            <h1>QuickBooks</h1>
            <p className="page-description">
              Connect your QuickBooks company and every short-paid invoice becomes a case to look
              at — read once a day, never written to.
            </p>
          </div>
        </div>

        {said === undefined ? null : (
          <p className={said.tone === 'good' ? 'notice sent' : 'notice bad'}>{said.text}</p>
        )}

        {configured ? null : (
          <section className="card connection" aria-label="QuickBooks is not set up">
            <h2>QuickBooks is not set up on this deployment</h2>
            <p className="empty">
              Nothing can be connected here until it is. For your administrator: set{' '}
              {deployment.missing.join(', ')} — see docs/qbo-credentials.md.
            </p>
          </section>
        )}

        <section className="card connection" aria-label="Your QuickBooks connection">
          {current === undefined ? (
            <>
              <h2>Not connected</h2>
              <p className="empty">
                No QuickBooks company is connected to this workspace.
                {configured ? ` This deployment reads ${deployment.environment} companies.` : ''}
              </p>
              {previous[0]?.releasedBySync === undefined ? null : (
                <p className="empty" role="status">
                  {releasedSentence(previous[0].providerAccountId, previous[0].releasedBySync)}
                </p>
              )}
              {mayConnect && configured ? <ConnectButton label="Connect QuickBooks" /> : null}
              {mayConnect ? null : <OwnersOnly />}
            </>
          ) : (
            <CurrentConnection
              connection={current}
              mayConnect={mayConnect}
              configured={configured}
              today={today}
              {...(configured ? { environment: deployment.environment } : {})}
            />
          )}
        </section>

        {previous.length === 0 ? null : (
          <section className="card connection" aria-label="Earlier connections">
            <h2 className="section" style={{ marginTop: 0 }}>
              Earlier connections
            </h2>
            <table className="cases">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Connected by</th>
                  <th>Turned off</th>
                </tr>
              </thead>
              <tbody>
                {previous.map((connection) => (
                  <tr key={connection.connectionId}>
                    <td className="mono">{connection.providerAccountId}</td>
                    <td>{connection.createdByEmail ?? 'a former member'}</td>
                    <td>
                      {connection.updatedAt.slice(0, 10)}
                      {connection.releasedBySync === undefined
                        ? ''
                        : connection.releasedBySync.reason === 'grant_refused'
                          ? ', after QuickBooks refused its sign-in'
                          : ', after its QuickBooks sign-in expired'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        <footer className="workspace-footer">
          <span>YOUR REVENUE. ORCHESTRATED.</span>
          <span>mozart.</span>
        </footer>
      </main>
    </WorkspaceShell>
  );
}

/**
 * Why the latest connection is off, when the sync turned it off itself
 * (ADR 0046): Intuit refused its stored sign-in for good, so nothing reads the
 * company and no other workspace is kept from it. Said once, beside the button
 * that fixes it.
 */
function releasedSentence(
  company: string,
  released: NonNullable<LedgerConnectionOverview['releasedBySync']>,
): string {
  const on = released.at.slice(0, 10);
  const what =
    released.reason === 'grant_refused'
      ? `QuickBooks refused the stored sign-in for company ${company} on ${on}`
      : `The stored QuickBooks sign-in for company ${company} expired, found on ${on}`;
  return (
    `${what}, so it was turned off automatically and nothing reads it now. ` +
    'Connect QuickBooks to sign in again.'
  );
}

function CurrentConnection({
  connection,
  mayConnect,
  configured,
  environment,
  today,
}: {
  connection: LedgerConnectionOverview;
  mayConnect: boolean;
  configured: boolean;
  environment?: 'sandbox' | 'production';
  today: Date;
}) {
  const reconnect = needsReconnect(connection, today);
  return (
    <>
      <h2>{reconnect === undefined ? 'Connected' : 'Connected — needs reconnecting'}</h2>
      {reconnect === undefined ? null : <p className="notice bad">{reconnect}</p>}
      <dl className="connection">
        <div>
          <dt>Company</dt>
          <dd className="mono">{connection.providerAccountId}</dd>
        </div>
        {environment === undefined ? null : (
          <div>
            <dt>Reads</dt>
            <dd>{environment} QuickBooks companies</dd>
          </div>
        )}
        <div>
          <dt>Syncs as</dt>
          <dd>{connection.createdByEmail ?? 'a former member — reconnect as a current owner'}</dd>
        </div>
        <div>
          <dt>Sign-in good until</dt>
          <dd>
            {connection.latestCredential === undefined
              ? '—'
              : connection.latestCredential.refreshExpiresAt.slice(0, 10)}
          </dd>
        </div>
        <div>
          <dt>Last sync</dt>
          <dd>{lastSyncSentence(connection)}</dd>
        </div>
      </dl>
      {mayConnect ? (
        <div className="connection-actions">
          {configured && reconnect !== undefined ? <ConnectButton label="Reconnect" /> : null}
          {/*
            A POST, not a link: it turns off a customer's ledger and revokes our
            access at Intuit, which is not something a prefetch may do.
          */}
          <form action="/settings/quickbooks/disconnect" method="post">
            <input type="hidden" name="connectionId" value={connection.connectionId} />
            <button type="submit">Disconnect</button>
          </form>
        </div>
      ) : (
        <OwnersOnly />
      )}
    </>
  );
}

function ConnectButton({ label }: { label: string }) {
  return (
    <form action="/settings/quickbooks/connect" method="post">
      <button className="primary" type="submit">
        {label}
      </button>
    </form>
  );
}

function OwnersOnly() {
  return <p className="empty">Only an owner of this workspace can connect or disconnect QuickBooks.</p>;
}

/**
 * Why a connection that is on cannot be read, in a sentence, or nothing.
 *
 * From what was recorded — the credential chain and the run log's error class
 * — never a guess: an access token that has expired is not a reason, because
 * the next sync refreshes it (ADR 0026). A run counts only if it finished after
 * the latest sign-in was stored.
 */
export function needsReconnect(
  connection: LedgerConnectionOverview,
  today: Date,
): string | undefined {
  if (connection.latestCredential === undefined) {
    return 'No QuickBooks sign-in is stored for it, so nothing can be read.';
  }
  if (Date.parse(connection.latestCredential.refreshExpiresAt) <= today.getTime()) {
    return `Its QuickBooks sign-in expired on ${connection.latestCredential.refreshExpiresAt.slice(0, 10)}.`;
  }
  // A run that finished before the latest sign-in was stored is about the
  // sign-in that sign-in replaced: a reconnect, or a later run's own rotation.
  // Without this, an owner who has just reconnected is told to reconnect.
  const last = connection.lastRun;
  const run =
    last !== undefined &&
    Date.parse(last.finishedAt) >= Date.parse(connection.latestCredential.storedAt)
      ? last
      : undefined;
  if (run?.outcome === 'failed' && run.errorClass === 'QboAuthError') {
    return 'QuickBooks refused its sign-in on the last sync — it may have been disconnected inside QuickBooks.';
  }
  if (run?.outcome === 'failed' && run.errorClass === 'CredentialUnreadableError') {
    return 'Its stored sign-in could not be opened on the last sync.';
  }
  if (run?.outcome === 'refused' && run.errorClass === LEDGER_SYNC_REFUSED) {
    return 'The member it syncs as can no longer write in this workspace. Reconnect as a current owner.';
  }
  return undefined;
}

/** How the last sync ended, from the run log's own words: an outcome, counts, a class name. */
export function lastSyncSentence(connection: LedgerConnectionOverview): string {
  const run = connection.lastRun;
  if (run === undefined) return 'not yet — the first one is on its way';
  const when = `${run.finishedAt.slice(0, 16).replace('T', ' ')} UTC`;
  switch (run.outcome) {
    case 'completed':
      return (
        `${when}: ${run.invoicesExamined} invoices read, ${run.openedCount} cases opened, ` +
        `${run.declinedCount} declined, ${run.anomalyCount} anomalies`
      );
    case 'not_configured':
      return `${when}: not read — this deployment could not reach QuickBooks`;
    case 'refused':
      // Shown when the same owner reconnects: the row is reused, so a run
      // refused while it was off can still be this connection's last.
      if (run.errorClass === LEDGER_CONNECTION_DISABLED) {
        return `${when}: not read — it was disconnected when this run started`;
      }
      return `${when}: not read — refused${run.errorClass === undefined ? '' : ` (${run.errorClass})`}`;
    case 'failed':
      return `${when}: failed${run.errorClass === undefined ? '' : ` (${run.errorClass})`}`;
  }
}
