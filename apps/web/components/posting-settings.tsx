import { REASON_FAMILIES, type ReasonFamily } from '@recouple/core-domain';
import {
  SETUP_ACCOUNTS,
  type LedgerAccountMap,
  type PostingSetupProposal,
  type QboAccount,
  type RowResolution,
  type SetupRow,
} from '@recouple/qbo';
import {
  CREATE_ACCOUNT,
  SAME_AS_WRITEOFF,
  splitField,
  type PostingChart,
  type PostingConnectionSetup,
} from '../lib/posting-setup';

/**
 * Settings → QuickBooks → Posting (ADR 0060 §4, §5; ADR 0063): for an owner,
 * on a deployment that posts at all. The page renders this only when both
 * hold; the database refuses a non-owner whatever it shows.
 *
 * With no map saved, a card proposes one from the company's chart, read live,
 * and one press turns posting on. With a map saved, the switch, and the map's
 * accounts as dropdowns to change it by. No account id is ever shown or typed:
 * a dropdown carries ids as its values and shows names. A pure function of
 * what the store and the proposal returned.
 */
export function PostingSettings({
  connections,
}: {
  connections: readonly PostingConnectionSetup[];
}) {
  return (
    <section className="card connection" aria-label="Posting to QuickBooks">
      <h2>Posting to QuickBooks</h2>
      <p className="hint">
        Off unless you turn it on. When it is on, nothing is sent until a second person approves
        a case — and every posting is read back from QuickBooks before it counts. The only
        accounts we ever create are {SETUP_ACCOUNTS.deductions_receivable.name} and{' '}
        {SETUP_ACCOUNTS.writeoff.name}, and only when you press Turn on posting and your books
        have none by that name. We never change or delete an account.
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
            {connection.map === undefined ? (
              <SetUpPosting connectionId={connection.connectionId} chart={connection.chart} />
            ) : (
              <SavedMap connection={connection} map={connection.map} />
            )}
          </div>
        ))
      )}
    </section>
  );
}

/** Why the chart is not in front of the owner, when it is not. */
function NoChart({ chart, doing }: { chart: Exclude<PostingChart, { kind: 'read' }>; doing: string }) {
  return (
    <p className="empty" role="status">
      {chart.kind === 'unreadable'
        ? `QuickBooks could not be read just now, so ${doing}. Reload this page to try again.`
        : `This deployment cannot reach QuickBooks for this company, so ${doing}.`}
    </p>
  );
}

// --- no map yet: the proposal and its one button (ADR 0063 §1) -------------

function SetUpPosting({ connectionId, chart }: { connectionId: string; chart: PostingChart }) {
  if (chart.kind !== 'read') return <NoChart chart={chart} doing="there is nothing to propose yet" />;
  const { proposal } = chart;
  const { options } = proposal;
  const stops = whyNot(proposal);
  return (
    <form action="/settings/quickbooks/setup" method="post" aria-label="Set up posting">
      <input type="hidden" name="connectionId" value={connectionId} />
      <dl className="connection">
        <div>
          <dt>Receivable</dt>
          <dd>
            <ReceivableRow connectionId={connectionId} proposal={proposal} />
          </dd>
        </div>
        <div>
          <dt>Deductions held</dt>
          <dd>
            <ProposedRow
              row="deductions_receivable"
              resolution={proposal.deductionsReceivable}
              options={options.otherCurrentAsset}
            />
          </dd>
        </div>
        <div>
          <dt>Write-offs</dt>
          <dd>
            <ProposedRow row="writeoff" resolution={proposal.writeoff} options={options.expense} />
            {proposal.writeoff.kind === 'blocked' ? null : ', for every reason'}
          </dd>
        </div>
      </dl>
      {stops.length > 0 ? null : (
        <>
          <details>
            <summary>Change accounts</summary>
            {proposal.ar.kind === 'existing' ? (
              <AccountSelect
                connectionId={connectionId}
                name="ar"
                label="Receivable"
                options={options.ar}
                selected={proposal.ar.accountId}
              />
            ) : null}
            <AccountSelect
              connectionId={connectionId}
              name="deductionsReceivable"
              label="Deductions held"
              options={options.otherCurrentAsset}
              {...createOffer('deductions_receivable', proposal.deductionsReceivable)}
            />
            <AccountSelect
              connectionId={connectionId}
              name="writeoff"
              label="Write-offs"
              options={options.expense}
              {...createOffer('writeoff', proposal.writeoff)}
            />
          </details>
          <details>
            <summary>Split write-offs by reason</summary>
            {[...REASON_FAMILIES, 'unclassified' as const].map((family) => (
              <AccountSelect
                key={family}
                connectionId={connectionId}
                name={splitField(family)}
                label={`Write-offs, ${familyWords(family)}`}
                options={options.expense}
                same
                {...createOffer('writeoff', proposal.writeoff)}
                selected={SAME_AS_WRITEOFF}
              />
            ))}
          </details>
        </>
      )}
      <button className="primary" type="submit" disabled={stops.length > 0}>
        Turn on posting
      </button>
      {stops.map((stop) => (
        <p key={stop} className="empty">
          {stop}
        </p>
      ))}
    </form>
  );
}

function ReceivableRow({
  connectionId,
  proposal,
}: {
  connectionId: string;
  proposal: PostingSetupProposal;
}) {
  switch (proposal.ar.kind) {
    case 'existing':
      return <strong>{nameOf(proposal.options.ar, proposal.ar.accountId)}</strong>;
    case 'choose':
      return (
        <AccountSelect
          connectionId={connectionId}
          name="ar"
          label="Your company has more than one receivable account; choose the one deductions come from"
          options={proposal.options.ar}
          selected=""
        />
      );
    case 'missing':
      return <span>No active Accounts Receivable account, and we never create one</span>;
  }
}

/** What a row's account is to be, in words: found, ours to create, or blocked. */
function ProposedRow({
  row,
  resolution,
  options,
}: {
  row: SetupRow;
  resolution: RowResolution;
  options: readonly QboAccount[];
}) {
  const fixed = SETUP_ACCOUNTS[row];
  switch (resolution.kind) {
    case 'existing':
      return <strong>{nameOf(options, resolution.accountId)}</strong>;
    case 'create':
      return (
        <span>
          <strong>{fixed.name}</strong> — we&apos;ll create it ({fixed.accountType})
        </span>
      );
    case 'blocked':
      return resolution.reason === 'name_taken_inactive' ? (
        <span>Not set: an inactive account in your QuickBooks is named {fixed.name}</span>
      ) : (
        <span>
          Not set: an account named {fixed.name} is in your QuickBooks and is not {TYPE_WORDS[row]}
        </span>
      );
  }
}

/** The type each row's account must have, as a sentence says it. */
const TYPE_WORDS: Readonly<Record<SetupRow, string>> = {
  deductions_receivable: 'an Other Current Asset account',
  writeoff: 'an Expense or Other Expense account',
};

/**
 * Why the button is off, one sentence per reason, or none: no A/R account to
 * post against, or one of our names held by an account we will not touch.
 */
function whyNot(proposal: PostingSetupProposal): readonly string[] {
  const stops: string[] = [];
  if (proposal.ar.kind === 'missing') {
    stops.push(
      'Your QuickBooks company has no active Accounts Receivable account, and we never create ' +
        'one. Add one in QuickBooks, then reload this page.',
    );
  }
  for (const [row, resolution] of [
    ['deductions_receivable', proposal.deductionsReceivable],
    ['writeoff', proposal.writeoff],
  ] as const) {
    if (resolution.kind !== 'blocked') continue;
    const name = SETUP_ACCOUNTS[row].name;
    stops.push(
      resolution.reason === 'name_taken_inactive'
        ? `An inactive account in your QuickBooks is named ${name}. We never reactivate an ` +
            'account: make it active or rename it in QuickBooks, then reload this page.'
        : `An account named ${name} is already in your QuickBooks and is not ${TYPE_WORDS[row]}. ` +
            'We never change an account: rename it in QuickBooks, then reload this page.',
    );
  }
  return stops;
}

/**
 * A row's "we'll create it" option and its default: offered only when the
 * row would create its account, and chosen at first when it would. Otherwise
 * the default is the account found.
 */
function createOffer(
  row: SetupRow,
  resolution: RowResolution,
): { readonly create?: string; readonly selected: string } {
  if (resolution.kind === 'create') return { create: SETUP_ACCOUNTS[row].name, selected: CREATE_ACCOUNT };
  return { selected: resolution.kind === 'existing' ? resolution.accountId : '' };
}

// --- a map saved: the switch, and the map by name to change (ADR 0063 §4) ---

function SavedMap({ connection, map }: { connection: PostingConnectionSetup; map: LedgerAccountMap }) {
  const { chart } = connection;
  return (
    <>
      {chart.kind === 'read' ? <MapSummary map={map} options={chart.proposal.options} /> : null}
      <form action="/settings/quickbooks/posting" method="post" style={{ marginTop: 8 }}>
        <input type="hidden" name="connectionId" value={connection.connectionId} />
        <input type="hidden" name="enabled" value={connection.postingEnabled ? 'off' : 'on'} />
        <button className={connection.postingEnabled ? undefined : 'primary'} type="submit">
          {connection.postingEnabled ? 'Turn posting off' : 'Turn posting on'}
        </button>
      </form>
      {chart.kind === 'read' ? (
        <details style={{ marginTop: 8 }}>
          <summary>Change accounts</summary>
          <MapForm connectionId={connection.connectionId} map={map} options={chart.proposal.options} />
        </details>
      ) : (
        <NoChart chart={chart} doing="its accounts cannot be changed here" />
      )}
    </>
  );
}

function MapSummary({
  map,
  options,
}: {
  map: LedgerAccountMap;
  options: PostingSetupProposal['options'];
}) {
  const writeoffs = new Set([
    ...REASON_FAMILIES.map((family) => map.writeoffByFamily[family]),
    map.unclassifiedWriteoff,
  ]);
  const [only] = writeoffs;
  return (
    <dl className="connection">
      <div>
        <dt>Receivable</dt>
        <dd>{nameOf(options.ar, map.arAccountId)}</dd>
      </div>
      <div>
        <dt>Deductions held</dt>
        <dd>{nameOf(options.otherCurrentAsset, map.deductionsReceivableAccountId)}</dd>
      </div>
      <div>
        <dt>Write-offs</dt>
        <dd>
          {writeoffs.size === 1 && only !== undefined
            ? `${nameOf(options.expense, only)}, for every reason`
            : `split by reason across ${writeoffs.size} accounts — see Change accounts`}
        </dd>
      </div>
    </dl>
  );
}

/** The saved map as dropdowns; the account-map route saves a change as a new map. */
function MapForm({
  connectionId,
  map,
  options,
}: {
  connectionId: string;
  map: LedgerAccountMap;
  options: PostingSetupProposal['options'];
}) {
  return (
    <form action="/settings/quickbooks/account-map" method="post">
      <input type="hidden" name="connectionId" value={connectionId} />
      <AccountSelect
        connectionId={connectionId}
        name="arAccountId"
        label="Receivable (Accounts Receivable)"
        options={options.ar}
        selected={offered(options.ar, map.arAccountId)}
      />
      <AccountSelect
        connectionId={connectionId}
        name="deductionsReceivableAccountId"
        label="Deductions held (Other Current Asset)"
        options={options.otherCurrentAsset}
        selected={offered(options.otherCurrentAsset, map.deductionsReceivableAccountId)}
      />
      {REASON_FAMILIES.map((family) => (
        <AccountSelect
          key={family}
          connectionId={connectionId}
          name={`writeoff_${family}`}
          label={`Write-offs, ${familyWords(family)} (Expense or Other Expense)`}
          options={options.expense}
          selected={offered(options.expense, map.writeoffByFamily[family])}
        />
      ))}
      <AccountSelect
        connectionId={connectionId}
        name="unclassifiedWriteoff"
        label="Write-offs, unclassified (Expense or Other Expense)"
        options={options.expense}
        selected={offered(options.expense, map.unclassifiedWriteoff)}
      />
      <button type="submit">Save account map</button>
    </form>
  );
}

// --- the pieces ---------------------------------------------------------------

/**
 * One row's dropdown: account names shown, ids as values. `selected` is the
 * value chosen at first — an id, `create`, `same`, or `''` for no default, in
 * which case the owner has to choose before the form will send.
 */
function AccountSelect({
  connectionId,
  name,
  label,
  options,
  selected,
  create,
  same = false,
}: {
  connectionId: string;
  name: string;
  label: string;
  options: readonly QboAccount[];
  selected: string;
  /** Our fixed name, offered as the account we would create. */
  create?: string | undefined;
  /** Offer "the same as write-offs" first, for a split row. */
  same?: boolean;
}) {
  const id = `${name}-${connectionId}`;
  return (
    <p style={{ margin: '6px 0' }}>
      <label htmlFor={id}>{label}</label>{' '}
      <select id={id} name={name} required defaultValue={selected}>
        {selected === '' ? (
          <option value="" disabled>
            Choose an account
          </option>
        ) : null}
        {same ? <option value={SAME_AS_WRITEOFF}>Same as write-offs</option> : null}
        {create === undefined ? null : (
          <option value={CREATE_ACCOUNT}>{create} (we&apos;ll create it)</option>
        )}
        {options.map((account) => (
          <option key={account.id} value={account.id}>
            {account.fullyQualifiedName}
          </option>
        ))}
      </select>
    </p>
  );
}

/** An account's name as the chart lists it, or words for one it does not list as active. */
function nameOf(options: readonly QboAccount[], id: string): string {
  return (
    options.find((account) => account.id === id)?.fullyQualifiedName ??
    'an account QuickBooks no longer lists as active'
  );
}

/** A saved id as a dropdown's default, only when the dropdown offers it. */
function offered(options: readonly QboAccount[], id: string): string {
  return options.some((account) => account.id === id) ? id : '';
}

function familyWords(family: ReasonFamily | 'unclassified'): string {
  return family.replace(/_/g, ' ');
}
