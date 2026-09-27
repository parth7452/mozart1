import { REASON_FAMILIES } from '@recouple/core-domain';
import type { PostingConnectionView } from '@recouple/store-postgres';

/**
 * Settings → QuickBooks → Posting (ADR 0060 §4, §5): the account map and the
 * switch, for an owner, on a deployment that posts at all. The page renders
 * this only when both hold; the database refuses a non-owner whatever it
 * shows. A pure function of what the store returned.
 */
export function PostingSettings({
  connections,
}: {
  connections: readonly PostingConnectionView[];
}) {
  return (
    <section className="card connection" aria-label="Posting to QuickBooks">
      <h2>Posting to QuickBooks</h2>
      <p className="hint">
        Off unless you turn it on. When it is on, nothing is sent until a second person approves
        a case — and every posting is read back from QuickBooks before it counts. Every account
        below is one already in your QuickBooks; we never create one.
      </p>
      {connections.length === 0 ? (
        <p className="empty">Connect a QuickBooks company first.</p>
      ) : (
        connections.map((connection) => (
          <div key={connection.connectionId} style={{ marginTop: 12 }}>
            <p>
              Company <span className="mono">{connection.realmId}</span>: posting is{' '}
              <strong>{connection.postingEnabled ? 'on' : 'off'}</strong>
              {connection.map === undefined ? ', and no account map is saved yet' : ''}.
            </p>
            <form action="/settings/quickbooks/account-map" method="post">
              <input type="hidden" name="connectionId" value={connection.connectionId} />
              <AccountField
                name="arAccountId"
                label="Accounts receivable (Accounts Receivable)"
                value={connection.map?.arAccountId}
              />
              <AccountField
                name="deductionsReceivableAccountId"
                label="Deductions receivable (Other Current Asset)"
                value={connection.map?.deductionsReceivableAccountId}
              />
              {REASON_FAMILIES.map((family) => (
                <AccountField
                  key={family}
                  name={`writeoff_${family}`}
                  label={`Write-off, ${family.replace(/_/g, ' ')} (Expense)`}
                  value={connection.map?.writeoffByFamily[family]}
                />
              ))}
              <AccountField
                name="unclassifiedWriteoff"
                label="Write-off, unclassified (Expense)"
                value={connection.map?.unclassifiedWriteoff}
              />
              <button type="submit">Save account map</button>
            </form>
            <form action="/settings/quickbooks/posting" method="post" style={{ marginTop: 8 }}>
              <input type="hidden" name="connectionId" value={connection.connectionId} />
              <input type="hidden" name="enabled" value={connection.postingEnabled ? 'off' : 'on'} />
              <button
                className={connection.postingEnabled ? undefined : 'primary'}
                type="submit"
                disabled={!connection.postingEnabled && connection.map === undefined}
              >
                {connection.postingEnabled ? 'Turn posting off' : 'Turn posting on'}
              </button>
            </form>
          </div>
        ))
      )}
    </section>
  );
}

function AccountField({ name, label, value }: { name: string; label: string; value: string | undefined }) {
  return (
    <p style={{ margin: '6px 0' }}>
      <label htmlFor={name}>{label}</label>{' '}
      <input id={name} name={name} inputMode="numeric" pattern="[0-9]{1,20}" required defaultValue={value ?? ''} />
    </p>
  );
}
