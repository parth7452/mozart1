import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PORTAL_TERMS_ALLOWED,
  PortalTermsAllowanceError,
  portalTermsAllowances,
  portalTermsVerdict,
  type PortalTermsAllowance,
} from '../src/portal-terms';

/**
 * The terms gate's data (ADR 0057 §2). Two questions matter if it is wrong:
 * can a recipe run under an ADR whose record does not allow it, and can a
 * recipe for one portal borrow another portal's answer?
 */

const ADR_DIR = new URL('../../../docs/adr/', import.meta.url);

/** The ADR file whose name begins with this number. */
function adrText(adr: string): string {
  const files = readdirSync(ADR_DIR).filter((name) => name.startsWith(`${adr}-`) && name.endsWith('.md'));
  if (files.length !== 1) throw new Error(`expected one ADR ${adr}, found ${files.length}`);
  return readFileSync(new URL(files[0]!, ADR_DIR), 'utf8');
}

type RecordedAnswer =
  | 'pending'
  | 'allowed'
  | 'allowed_with_conditions'
  | 'needs_written_consent'
  | 'payer_written_consent'
  | 'not_allowed';

/**
 * A terms record's `- Answer:` and `- On:` lines, read the way a person
 * would: emphasis dropped, the answer's opening words deciding. Anything this
 * cannot place is a failure rather than a guess.
 */
function termsRecord(text: string): { readonly answer: RecordedAnswer; readonly on: string } {
  const answers = [...text.matchAll(/^- Answer:\s*(.+)$/gm)];
  const ons = [...text.matchAll(/^- On:\s*(.+)$/gm)];
  if (answers.length !== 1 || ons.length !== 1) {
    throw new Error(`expected one terms record, found ${answers.length} answers and ${ons.length} dates`);
  }
  const plain = (s: string) => s.replace(/[*_]/g, '').trim().toLowerCase();
  const answer = plain(answers[0]![1]!);
  const on = plain(ons[0]![1]!);
  const recorded: RecordedAnswer = answer.startsWith('pending')
    ? 'pending'
    : answer.startsWith('allowed with conditions')
      ? 'allowed_with_conditions'
      : answer.startsWith('allowed')
        ? 'allowed'
        : answer.startsWith('not allowed')
          ? 'not_allowed'
          : answer.startsWith('needs')
            ? 'needs_written_consent'
            : answer.startsWith('written consent given')
              ? 'payer_written_consent'
              : (() => {
                  throw new Error(`a terms answer this test cannot place: ${answer.slice(0, 40)}`);
                })();
  return { answer: recorded, on };
}

/** Every ADR that carries a terms record, by number. */
function adrsWithTermsRecords(): string[] {
  return readdirSync(ADR_DIR)
    .filter((name) => /^\d{4}-.*\.md$/.test(name))
    .filter((name) => /^- Answer:/m.test(readFileSync(new URL(name, ADR_DIR), 'utf8')))
    .map((name) => name.slice(0, 4))
    .sort();
}

const SAP = { portalKey: 'sap_business_network', portalAdr: '0062' };

const allowance = (over: Partial<PortalTermsAllowance> = {}): PortalTermsAllowance => ({
  adr: '0062',
  portalKey: 'sap_business_network',
  answer: 'allowed',
  recordedOn: '2026-10-01',
  ...over,
});

describe('what is deployed', () => {
  it('allows SAP Business Network with conditions, and not UNFI, which is paused', () => {
    expect([...PORTAL_TERMS_ALLOWED.keys()]).toEqual(['0062']);
    expect(portalTermsVerdict(SAP)).toEqual({ allowed: true, allowance: PORTAL_TERMS_ALLOWED.get('0062') });
    expect(PORTAL_TERMS_ALLOWED.get('0062')?.answer).toBe('allowed_with_conditions');
    expect(portalTermsVerdict({ portalKey: 'unfi', portalAdr: '0058' })).toEqual({
      allowed: false,
      reason: 'not_recorded',
    });
  });

  it('reads the two portal ADRs the way this test reads every entry', () => {
    expect(adrsWithTermsRecords()).toEqual(['0058', '0062']);
    expect(termsRecord(adrText('0058'))).toEqual({ answer: 'allowed', on: '2026-09-27' });
    expect(termsRecord(adrText('0062'))).toEqual({ answer: 'allowed_with_conditions', on: '2026-09-28' });
  });

  it('holds no entry its ADR does not record, for that portal and that day', () => {
    for (const [adr, entry] of PORTAL_TERMS_ALLOWED) {
      const text = adrText(adr);
      const record = termsRecord(text);
      expect(record.answer, `ADR ${adr}'s terms answer`).toBe(entry.answer);
      expect(record.on, `ADR ${adr}'s terms date`).toBe(entry.recordedOn);
      expect(text, `ADR ${adr} names its portal key`).toContain(`\`${entry.portalKey}\``);
    }
  });

  it('holds no ADR whose record lets nothing run', () => {
    for (const adr of adrsWithTermsRecords()) {
      const { answer } = termsRecord(adrText(adr));
      if (!['allowed', 'allowed_with_conditions', 'payer_written_consent'].includes(answer)) {
        expect(PORTAL_TERMS_ALLOWED.has(adr), `ADR ${adr} records ${answer}`).toBe(false);
      }
    }
  });
});

describe('the verdict', () => {
  const allowed = portalTermsAllowances([allowance()]);

  it('lets a recipe run under an ADR that records its own portal as allowed', () => {
    expect(portalTermsVerdict(SAP, allowed)).toEqual({ allowed: true, allowance: allowance() });
  });

  it('refuses a recipe of another portal that names the allowed ADR', () => {
    expect(portalTermsVerdict({ portalKey: 'unfi', portalAdr: '0062' }, allowed)).toEqual({
      allowed: false,
      reason: 'other_portal',
    });
  });

  it.each(['ADR 0062', '62', '0062-sap', ' 0062', '0062 ', 'none', ''])(
    'names nothing with %j',
    (portalAdr) => {
      expect(portalTermsVerdict({ portalKey: 'sap_business_network', portalAdr }, allowed)).toEqual({
        allowed: false,
        reason: 'no_adr_named',
      });
    },
  );

  it('refuses an ADR with no entry', () => {
    expect(portalTermsVerdict({ portalKey: 'sap_business_network', portalAdr: '0063' }, allowed)).toEqual({
      allowed: false,
      reason: 'not_recorded',
    });
  });
});

describe('an allowance', () => {
  it.each([
    ['adr', allowance({ adr: '62' })],
    ['portalKey', allowance({ portalKey: 'SAP' })],
    ['answer', allowance({ answer: 'pending' as never })],
    ['recordedOn', allowance({ recordedOn: '2026-02-30' })],
    ['recordedOn', allowance({ recordedOn: 'pending' })],
  ])('refuses a malformed %s', (field, bad) => {
    const error = (() => {
      try {
        portalTermsAllowances([bad]);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(PortalTermsAllowanceError);
    expect((error as PortalTermsAllowanceError).field).toBe(field);
  });

  it('refuses an ADR listed twice', () => {
    expect(() => portalTermsAllowances([allowance(), allowance({ answer: 'allowed_with_conditions' })])).toThrow(
      PortalTermsAllowanceError,
    );
  });

  it('keeps each allowance as it was given, and frozen', () => {
    const map = portalTermsAllowances([allowance()]);
    expect(map.get('0062')).toEqual(allowance());
    expect(Object.isFrozen(map.get('0062'))).toBe(true);
  });
});
