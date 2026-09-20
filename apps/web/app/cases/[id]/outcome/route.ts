import { NextResponse, type NextRequest } from 'next/server';
import { MoneyError, parseMoneyToCents } from '@recouple/core-domain';
import {
  CaseNotVisibleError,
  InvalidRecoveryAmountError,
  WrongCaseStateError,
  WrongRoleError,
  type CaseOutcome,
} from '@recouple/pipeline';
import { requireSession } from '../../../../lib/session';
import { mayWrite } from '../../../../lib/pipeline';
import { isCrossSite, isUuid, refuseCrossSite } from '../../../../lib/request';
import { backToCase, caseNotFound, workflowStoreFor } from '../../../../lib/workflow';

const OUTCOMES: readonly CaseOutcome[] = ['won', 'partial', 'lost'];

function isOutcome(value: unknown): value is CaseOutcome {
  return typeof value === 'string' && (OUTCOMES as readonly string[]).includes(value);
}

const MAX_NOTE = 2000;

/**
 * Records what the retailer did with the dispute.
 *
 * The recovered amount is typed by a person as money — `1,800.00`, `$1,800` —
 * and `parseMoneyToCents` turns it into integer cents, the same function that
 * turns a notice's printed total into cents. Never `Number(text)`, never a
 * float, and never a guess: `12.345` is three decimal places on a money path,
 * and this refuses it instead of rounding somebody's recovery (invariant 3).
 *
 * The event this writes is where Phase 4 reads attributable recoveries from, so
 * a wrong number here is a wrong invoice later. There is no new table and no
 * second place for the fact to live (ADR 0020 §3).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (isCrossSite(request)) return refuseCrossSite();

  const { id } = await params;
  const session = await requireSession();

  if (!isUuid(id)) {
    return NextResponse.redirect(new URL('/', request.url), { status: 303 });
  }
  if (!mayWrite(session.org.role)) {
    return NextResponse.redirect(
      backToCase(request.url, id, 'your role can review cases but not record an outcome'),
      { status: 303 },
    );
  }

  const form = await request.formData();
  const outcome = form.get('outcome');
  if (!isOutcome(outcome)) {
    return NextResponse.redirect(
      backToCase(request.url, id, 'say what came back: won, partial or lost'),
      { status: 303 },
    );
  }

  const typed = form.get('recovered');
  const written = typeof typed === 'string' ? typed.trim() : '';
  let recoveredCents: number;
  if (written === '') {
    // Nothing typed is zero recovered, which is the only amount a lost case
    // can have. A `won` or `partial` with no amount is refused by the store,
    // by name, against the deduction it could have recovered.
    recoveredCents = 0;
  } else {
    try {
      recoveredCents = parseMoneyToCents(written);
    } catch (cause) {
      if (cause instanceof MoneyError) {
        return NextResponse.redirect(
          backToCase(
            request.url,
            id,
            'write the recovered amount as dollars and cents, like 1,800.00 — it is stored as whole cents',
          ),
          { status: 303 },
        );
      }
      throw cause;
    }
  }

  const note = form.get('note');
  const said = typeof note === 'string' ? note.trim() : '';

  const store = workflowStoreFor(session);
  try {
    await store.recordOutcome({
      deductionId: id,
      outcome,
      recoveredCents,
      recordedBy: session.userId,
      ...(said === '' ? {} : { note: said.slice(0, MAX_NOTE) }),
    });
    return NextResponse.redirect(
      backToCase(request.url, id, `recorded: this case is ${outcome}`),
      { status: 303 },
    );
  } catch (cause) {
    if (cause instanceof InvalidRecoveryAmountError) {
      // The amount contradicts the outcome, or is not a number of cents this
      // case could have recovered. Said in the store's own words, because the
      // reason is the useful half — "more than the deduction" and "not an
      // integer" are different mistakes.
      return NextResponse.redirect(
        backToCase(request.url, id, `that amount cannot be right: ${cause.reason}`),
        { status: 303 },
      );
    }
    if (cause instanceof WrongCaseStateError) {
      return NextResponse.redirect(
        backToCase(
          request.url,
          id,
          `this case is ${cause.state.replace(/_/g, ' ')}, and an outcome is recorded on a case that was filed`,
        ),
        { status: 303 },
      );
    }
    if (cause instanceof WrongRoleError) {
      return NextResponse.redirect(
        backToCase(request.url, id, 'your role can review cases but not record an outcome'),
        { status: 303 },
      );
    }
    if (cause instanceof CaseNotVisibleError) return caseNotFound();
    throw cause;
  } finally {
    await store.close();
  }
}
