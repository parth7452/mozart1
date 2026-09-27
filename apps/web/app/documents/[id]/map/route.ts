import { NextResponse, type NextRequest } from 'next/server';
import { headerFingerprint, SheetMappingSchema, type SheetMapping } from '@recouple/core-domain';
import { isSpreadsheetMime, parseWorkbook } from '@recouple/ingest';
import {
  CaseMergedAwayError,
  DocumentAlreadyOnCaseError,
  DocumentBusyError,
  DocumentNotFoundError,
  DocumentNotHeldError,
  DocumentNotReadError,
  DuplicateCaseError,
  HeldReadingUnusableError,
  openHeldDocument,
  sheetFields,
  WrongRoleError,
} from '@recouple/pipeline';
import { requireSession, storeFor } from '../../../../lib/session';
import { mayWrite } from '../../../../lib/pipeline';
import { isCrossSite, isUuid, refuseCrossSite } from '../../../../lib/request';
import { NOTICE_ABOUT_PARAM, type NoticeKey } from '../../../../lib/notices';

const SHAPES = ['remittance', 'deduction_list'] as const;
const SIGNS = ['deductions_positive', 'deductions_negative'] as const;
const DATE_ORDERS = ['mdy', 'dmy', 'ymd'] as const;

/** A positive whole number as a form sends it, or undefined. */
function positive(value: FormDataEntryValue | null): number | undefined {
  if (typeof value !== 'string' || !/^[1-9]\d{0,5}$/.test(value)) return undefined;
  return Number.parseInt(value, 10);
}

function oneOf<T extends string>(value: FormDataEntryValue | null, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

/**
 * Records a person's column mapping for a spreadsheet held `no_mapping`, then
 * opens it the way "Open a case from it" does (ADR 0056). The rows are read by
 * code through the mapping; no model is asked, and the header the mapping is
 * keyed on is read from the stored bytes, never taken from the form.
 *
 * Its guards are `open-case`'s: cross-site first, then the session, the role,
 * the database's `member_may_write`, and RLS's 404.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (isCrossSite(request)) return refuseCrossSite();

  const { id } = await params;
  const session = await requireSession();
  const back = new URL('/', request.url);

  const say = (notice: NoticeKey, ...about: readonly string[]): NextResponse => {
    back.searchParams.set('action', notice);
    back.searchParams.delete(NOTICE_ABOUT_PARAM);
    for (const fragment of about) back.searchParams.append(NOTICE_ABOUT_PARAM, fragment);
    return NextResponse.redirect(back, { status: 303 });
  };
  const toCase = (deductionId: string, notice: NoticeKey): NextResponse => {
    const onCase = new URL(`/cases/${deductionId}`, request.url);
    onCase.searchParams.set('action', notice);
    return NextResponse.redirect(onCase, { status: 303 });
  };
  const notFound = (): NextResponse =>
    new NextResponse('no such document', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });

  if (!isUuid(id)) return NextResponse.redirect(back, { status: 303 });
  if (!mayWrite(session.org.role)) return say('open_held_role');

  const store = storeFor(session);
  try {
    if (!(await store.memberMayWrite({ orgId: session.org.orgId, userId: session.userId }))) {
      return say('open_held_role');
    }
    if (!(await store.documentIsVisible(id))) return notFound();

    const stored = await store.getDocument(id);
    if (stored === undefined) return notFound();
    if (!isSpreadsheetMime(stored.mimeType)) return say('map_not_spreadsheet');

    const form = await request.formData();
    const shape = oneOf(form.get('shape'), SHAPES);
    const sign = oneOf(form.get('sign'), SIGNS);
    const dateOrder = oneOf(form.get('date_order'), DATE_ORDERS);
    const debtor = form.get('debtor');
    const sheetOrdinal = form.get('sheet');
    const headerRow = positive(form.get('header_row'));
    if (
      shape === undefined ||
      sign === undefined ||
      dateOrder === undefined ||
      typeof debtor !== 'string' ||
      !isUuid(debtor) ||
      typeof sheetOrdinal !== 'string' ||
      !/^\d{1,3}$/.test(sheetOrdinal) ||
      headerRow === undefined
    ) {
      return say('map_invalid');
    }

    const columns: Record<string, number> = {};
    for (const field of sheetFields(shape)) {
      const column = positive(form.get(`col:${field}`));
      if (column !== undefined) columns[field] = column;
    }
    const amountColumn = columns['deduction_amount'];
    if (amountColumn === undefined) return say('map_invalid');

    // The header is the stored file's, read after the scan gate the read
    // already passed; the form only says which row it is.
    const wb = parseWorkbook(stored.bytes, stored.mimeType);
    const sheet = wb.sheets.find((s) => s.ordinal === Number.parseInt(sheetOrdinal, 10));
    const headerCells = sheet?.cells
      .filter((c) => c.row === headerRow)
      .sort((a, b) => a.column - b.column);
    if (sheet === undefined || headerCells === undefined || headerCells.length === 0) {
      return say('map_invalid');
    }

    const nonLineValues = form
      .getAll('non_line')
      .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      .map((v) => v.trim());
    const nonLineRule: SheetMapping['nonLineRule'] =
      nonLineValues.length > 0 ? { firstCellMatches: nonLineValues } : { blankColumn: amountColumn };

    const input = SheetMappingSchema.omit({ id: true, version: true }).safeParse({
      orgId: session.org.orgId,
      debtorId: debtor,
      effectiveFrom: new Date().toISOString().slice(0, 10),
      headerRow,
      sheetName: sheet.name,
      headerFingerprint: headerFingerprint(headerCells),
      shape,
      columns,
      nonLineRule,
      sign,
      currency: 'USD',
      dateOrder,
      sourceDocumentId: id,
      // The person is the session's member, never a form field.
      confirmedBy: session.userId,
    });
    if (!input.success) return say('map_invalid');

    await store.recordSheetMapping(input.data);

    const result = await openHeldDocument(store, {
      orgId: session.org.orgId,
      documentId: id,
      confirmedBy: session.userId,
    });
    const cases = [
      ...new Set([...result.opened.map((c) => c.deductionId), ...result.mergedInto]),
    ];
    if (cases.length === 1) return toCase(cases[0] as string, 'open_held_done');
    if (cases.length > 1) return say('open_held_cases', String(cases.length));
    return say('open_held_none');
  } catch (cause) {
    if (cause instanceof WrongRoleError) return say('open_held_role');
    if (cause instanceof DocumentAlreadyOnCaseError) return toCase(cause.deductionId, 'open_held_already');
    if (cause instanceof DocumentNotHeldError) return say('open_held_not_held');
    if (cause instanceof HeldReadingUnusableError) return say('open_held_unusable');
    if (cause instanceof DocumentBusyError) return say('open_held_busy');
    if (cause instanceof DocumentNotReadError) return say('open_held_not_read');
    if (cause instanceof DuplicateCaseError) return toCase(cause.existingDeductionId, 'open_held_duplicate');
    if (cause instanceof CaseMergedAwayError) return say('open_held_case_merged');
    if (cause instanceof DocumentNotFoundError) return notFound();
    console.error(
      `[recouple] map: mapping document ${id} for org ${session.org.orgId} failed`,
      cause,
    );
    return say('open_held_failed');
  } finally {
    await store.close();
  }
}
