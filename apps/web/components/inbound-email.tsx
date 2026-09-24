import type {
  DkimVerdict,
  InboundPartKind,
  InboundPartOutcome,
  UnattachedDocument,
} from '@recouple/pipeline';
import type {
  FiledNothingByAddress,
  FiledNothingEmail,
  InboundAddressRow,
} from '@recouple/store-postgres';
import { FILED_NOTHING_DAYS } from '@recouple/store-postgres';
import { resolveNotice } from '../lib/notices';
import { retireAsksFirst } from '../lib/inbound-addresses';
import { WorkspaceShell } from './workspace-shell';
import type { Viewer } from './case-list';

/**
 * Email-in, as a person sees it (ADR 0047 §4, §7, §11, §12).
 *
 * Pure functions of what the store returned. Three kinds of text here came from
 * somebody else — a filename, a sender domain and nothing more — and React
 * escapes both. Every row is worded as a fact about what arrived, never as an
 * instruction: a stranger controls these rows, and the page must not turn one
 * into a lure ("an email to this address did not reach us", never "go and get
 * it from …").
 */

/** What a sender needs to know before they try (§12). */
export const EMAIL_SIZE_LINE = 'Attachments up to about 3 MB in total; larger files by upload.';

/** `<token>@<domain>`, or the token alone where this deployment has no domain. */
export function addressText(token: string, domain: string | undefined): string {
  return domain === undefined ? token : `${token}@${domain}`;
}

/** Postmark's aligned-DKIM report, in the three words the hold line uses. */
function dkimWord(dkim: DkimVerdict): string {
  if (dkim === 'pass') return 'yes';
  if (dkim === 'unknown') return 'unknown';
  // `fail` is signed, but not by the author's domain; `none` is not signed.
  return 'no';
}

/**
 * What the email that brought a held document said about its sender (§7):
 * "By email · from harborlane.example (as the email claims) · aligned DKIM per
 * Postmark: yes". Information for the person deciding; it opens nothing.
 */
export function emailLine(email: NonNullable<UnattachedDocument['email']>): string {
  const from =
    email.senderDomain === undefined
      ? 'the sender is not one address'
      : `from ${email.senderDomain} (as the email claims)`;
  return `By email · ${from} · aligned DKIM per Postmark: ${dkimWord(email.dkim)}`;
}

const PART_KIND: Record<InboundPartKind, string> = {
  attachment: 'attachment',
  inline: 'inline image',
  body: 'the message itself',
};

/** One closed set in, one phrase out: a part's outcome is never text off the email. */
const PART_OUTCOME: Record<InboundPartOutcome, string> = {
  stored: 'kept',
  already_held: 'already held here',
  over_daily_budget: 'kept, and waiting to be read: past today’s reading budget',
  not_clean: 'refused by the virus scan',
  inline_image: 'a small image the email showed inline, such as a logo — not kept',
  too_many_parts: 'past the ten parts one email may file — not kept',
  not_base64: 'not readable as an attachment — not kept',
  empty_file: 'empty',
  body_too_short: 'too short to be a notice',
  too_large: 'too large',
  type_not_allowed: 'not a kind of file this app reads',
  content_does_not_match_type: 'its contents are not what its name says',
  encrypted_pdf: 'an encrypted PDF',
  active_content_pdf: 'a PDF with active content',
  decompression_bomb: 'expands to far more than it claims to be',
  malformed_pdf: 'a malformed PDF',
};

export function partOutcomeWords(outcome: InboundPartOutcome): string {
  return PART_OUTCOME[outcome];
}

/** The first sentence of a row: what happened, and when. */
export function filedNothingSentence(email: FiledNothingEmail): string {
  const day = email.at.slice(0, 10);
  if (email.outcome === 'not_received') {
    // Postmark's own date: the day it accepted the email and failed to give it
    // to us (§12). The usual cause is size, and that is said as a fact.
    return (
      `An email to this address on ${day} did not reach us. Postmark could not deliver it ` +
      'here; the usual cause is attachments over about 3 MB in total.'
    );
  }
  if (email.outcome === 'refused_retired') {
    return `An email to this address on ${day} was refused: the address is retired.`;
  }
  return email.parts.length === 0
    ? `An email to this address on ${day} carried nothing to file.`
    : `An email to this address on ${day} filed nothing.`;
}

function FiledNothingRows({ group }: { group: FiledNothingByAddress }) {
  return (
    <>
      <ul className="filed-nothing-list">
        {group.emails.map((email) => (
          <li key={email.inboundMessageId}>
            <span>{filedNothingSentence(email)}</span>
            {email.senderDomain === undefined ? null : (
              <span className="claimed-sender">
                {' '}
                From {email.senderDomain} — as the email claims, unverified.
              </span>
            )}
            {email.parts.length === 0 ? null : (
              <ul className="filed-nothing-parts">
                {email.parts.map((part) => (
                  <li key={part.ordinal}>
                    {PART_KIND[part.kind]}
                    {part.filename === undefined || part.kind === 'body' ? '' : ` “${part.filename}”`}:{' '}
                    {partOutcomeWords(part.outcome)}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {group.beyond === 0 ? null : (
        <p className="empty">
          And {group.beyond.toLocaleString('en-US')} more to this address in the last{' '}
          {FILED_NOTHING_DAYS} days.
        </p>
      )}
    </>
  );
}

/**
 * The case list's **Email that filed nothing** (§11): over the last 30 days,
 * the emails that left no document anyone can read — every part refused, lost
 * on the way (`not_received`, which the operator's sweep records), or sent to a
 * retired address — with each part's outcome. Twenty per address and a count.
 *
 * Shown to a member who may add documents, like the lists beside it: the rows
 * name the address, and an address is a way to write into this workspace.
 */
export function EmailThatFiledNothing({
  groups,
  domain,
}: {
  groups: readonly FiledNothingByAddress[];
  /** This deployment's inbound domain, when it receives email. */
  domain?: string | undefined;
}) {
  if (groups.length === 0) return null;
  return (
    <div className="card filed-nothing">
      <h2 className="section" style={{ marginTop: 0 }}>
        Email that filed nothing
      </h2>
      <p className="empty">
        Emails to this workspace&rsquo;s addresses in the last {FILED_NOTHING_DAYS} days that left no
        document to read, and why. This is a record of what arrived; nothing here was sent to
        anyone.
      </p>
      {groups.map((group) => (
        <section key={group.addressId} className="filed-nothing-address">
          <h3>
            <span className="mono">{addressText(group.token, domain)}</span>
            {group.retired ? ' · retired' : ''}
          </h3>
          <FiledNothingRows group={group} />
        </section>
      ))}
    </div>
  );
}

/** Where this deployment stands on receiving email (§14), as the page shows it. */
export type InboundDeployment =
  | { readonly kind: 'bound'; readonly domain: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'misconfigured'; readonly reason: string };

const dayOf = (date: Date | undefined): string =>
  date === undefined ? 'never' : date.toISOString().slice(0, 10);

/**
 * Settings → Email (§4).
 *
 * Writers see the addresses; a `read_only` member is told how many there are
 * and not what they are, because an address writes into this workspace and
 * theirs is the role with no write. Only an owner sees Issue, Adopt and
 * Retire, and the database refuses anyone else whatever this page shows.
 */
export function InboundEmailPage({
  viewer,
  viewerUserId,
  deployment,
  addresses,
  mayWriteHere,
  mayManage,
  filedNothing,
  notice,
  confirmRetire,
  today,
}: {
  viewer: Viewer;
  viewerUserId: string;
  deployment: InboundDeployment;
  addresses: readonly InboundAddressRow[];
  /** Owner, approver or analyst: may see the addresses. */
  mayWriteHere: boolean;
  /** An owner: may issue, adopt and retire. */
  mayManage: boolean;
  filedNothing: readonly FiledNothingByAddress[];
  /** A notice key, never a sentence (`lib/notices.ts`). */
  notice?: string | undefined;
  /** The address a retire asked to confirm, as the route redirected with it. */
  confirmRetire?: string | undefined;
  today: Date;
}) {
  const said = resolveNotice(notice);
  const live = addresses.filter((address) => address.retiredAt === undefined);
  const retired = addresses.filter((address) => address.retiredAt !== undefined);
  const domain = deployment.kind === 'bound' ? deployment.domain : undefined;
  const confirming =
    mayManage && confirmRetire !== undefined
      ? live.find((address) => address.addressId === confirmRetire)
      : undefined;
  const filedFor = new Map(filedNothing.map((group) => [group.addressId, group]));

  return (
    <WorkspaceShell viewer={viewer} section="email">
      <main id="workspace-main" className="workspace-main">
        <div className="page-heading">
          <div>
            <p className="eyebrow">SETTINGS</p>
            <h1>Email</h1>
            <p className="page-description">
              Suppliers and payers email documents to an address this workspace was given. A
              deduction notice or remittance that arrives by email is held for a person to open —
              no email opens a case on its own.
            </p>
          </div>
        </div>

        {said === undefined ? null : (
          <p className={said.tone === 'good' ? 'notice sent' : 'notice bad'}>{said.text}</p>
        )}

        {deployment.kind === 'bound' ? null : (
          <section className="card connection" aria-label="Email is not set up">
            <h2>
              {deployment.kind === 'none'
                ? 'This deployment does not receive email'
                : 'Email is set up wrongly on this deployment'}
            </h2>
            <p className="empty">
              {deployment.kind === 'none'
                ? 'Mail sent to these addresses reaches the production app only. For your ' +
                  'administrator: POSTMARK_INBOUND_SECRET and INBOUND_DOMAIN are set on ' +
                  'Production alone — see apps/web/DEPLOY.md.'
                : 'Mail is refused here and Postmark keeps retrying it for about ten hours.' +
                  // The reason names settings, never their values; an owner is
                  // who can pass it on.
                  (mayManage ? ` For your administrator: ${deployment.reason}.` : '')}
            </p>
          </section>
        )}

        {confirming === undefined ? null : (
          <section className="card connection" aria-label="Confirm retiring an address">
            <h2>Retire an address still in use?</h2>
            <p className="empty">
              <span className="mono">{addressText(confirming.token, domain)}</span> last received
              mail on {dayOf(confirming.lastReceivedAt)}. Retiring it refuses everything sent to it
              from now on, and it is never issued again. Issue a new address and tell your senders
              first, if you have not.
            </p>
            <form action="/settings/email/retire" method="post">
              <input type="hidden" name="addressId" value={confirming.addressId} />
              <input type="hidden" name="confirmed" value="yes" />
              <button type="submit">Retire it anyway</button>
            </form>
          </section>
        )}

        <section className="card connection" aria-label="This workspace’s addresses">
          <h2>Addresses</h2>
          {!mayWriteHere ? (
            <p className="empty">
              {live.length === 0
                ? 'This workspace has no email address yet.'
                : `This workspace has ${live.length} live address${live.length === 1 ? '' : 'es'}. ` +
                  'Addresses are shown to members who can add documents, because mail sent to one ' +
                  'files documents here.'}
            </p>
          ) : live.length === 0 ? (
            <p className="empty">
              This workspace has no email address yet.
              {mayManage ? ' Issue one, and give it to the senders who should reach you.' : ''}
            </p>
          ) : (
            <ul className="inbound-addresses">
              {live.map((address) => (
                <li key={address.addressId}>
                  <p>
                    <strong className="mono">{addressText(address.token, domain)}</strong>
                  </p>
                  <p className="empty">
                    Acts as {address.actingMemberEmail ?? 'a member no longer visible here'}: what
                    arrives is filed on their authority. Last received mail:{' '}
                    {dayOf(address.lastReceivedAt)}. {EMAIL_SIZE_LINE}
                  </p>
                  {address.actingMemberMayWrite ? null : (
                    <p className="notice bad" role="status">
                      Not accepting mail:{' '}
                      {address.actingMemberEmail ?? 'the member it acts as'} can no longer add
                      documents here, so every delivery is refused and retried for about ten hours.
                      An owner should adopt this address.
                    </p>
                  )}
                  {mayManage ? (
                    <div className="inbound-address-actions">
                      {address.actingMember === viewerUserId ? null : (
                        <form action="/settings/email/adopt" method="post">
                          <input type="hidden" name="addressId" value={address.addressId} />
                          <button type="submit">Adopt: act as me</button>
                        </form>
                      )}
                      <form action="/settings/email/retire" method="post">
                        <input type="hidden" name="addressId" value={address.addressId} />
                        <button type="submit">
                          {retireAsksFirst(address, today) ? 'Retire…' : 'Retire'}
                        </button>
                      </form>
                    </div>
                  ) : null}
                  {filedFor.get(address.addressId) === undefined ? null : (
                    <FiledNothingRows group={filedFor.get(address.addressId) as FiledNothingByAddress} />
                  )}
                </li>
              ))}
            </ul>
          )}
          {mayManage ? (
            <form action="/settings/email/issue" method="post">
              <button type="submit">Issue a new address</button>
            </form>
          ) : null}
          {mayWriteHere ? (
            <p className="empty">
              When someone who knew an address leaves, or can no longer add documents, retire it
              and issue a new one: a former member keeps whatever they remember.
            </p>
          ) : null}
        </section>

        {!mayWriteHere || retired.length === 0 ? null : (
          <section className="card connection" aria-label="Retired addresses">
            <h2>Retired</h2>
            <ul className="inbound-addresses">
              {retired.map((address) => (
                <li key={address.addressId}>
                  <p>
                    <span className="mono">{addressText(address.token, domain)}</span> · retired{' '}
                    {dayOf(address.retiredAt)}
                  </p>
                  <p className="empty">
                    {address.refusedSinceRetired === 0
                      ? 'No mail has reached it since.'
                      : `${address.refusedSinceRetired.toLocaleString('en-US')} email` +
                        `${address.refusedSinceRetired === 1 ? '' : 's'} reached it after it was ` +
                        `retired and ${address.refusedSinceRetired === 1 ? 'was' : 'were'} refused; ` +
                        `the last on ${dayOf(address.lastRefusedAt)}.`}
                  </p>
                  {filedFor.get(address.addressId) === undefined ? null : (
                    <FiledNothingRows group={filedFor.get(address.addressId) as FiledNothingByAddress} />
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </WorkspaceShell>
  );
}
