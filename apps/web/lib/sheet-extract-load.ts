import { formatCents, type Cents } from '@recouple/core-domain';
import { isSpreadsheetMime, parseWorkbook } from '@recouple/ingest';
import { headerCandidates } from '@recouple/pipeline';
import type { PostgresStore, StoredField } from '@recouple/store-postgres';
import type { SheetExtractView } from '../components/sheet-extract';
import { buildSheetExtract } from './sheet-extract';

/**
 * Loads what `buildSheetExtract` needs for a case's spreadsheet notice: the
 * bytes through `servableDocument` (the scan gate, one snapshot), the cells
 * its fields were read from, and the mapping that matches its header today.
 */
export async function sheetExtractFor(
  store: Pick<PostgresStore, 'servableDocument' | 'resultCellsFor' | 'sheetMappingFor'>,
  orgId: string,
  documentId: string,
  fields: readonly StoredField[],
  amountCents: number,
): Promise<SheetExtractView | undefined> {
  const served = await store.servableDocument(documentId);
  if (served === undefined || served.refusal !== undefined) return undefined;
  if (!isSpreadsheetMime(served.document.mimeType)) return undefined;
  const wb = parseWorkbook(served.document.bytes, served.document.mimeType);
  const own = fields.filter((f) => f.documentId === documentId);
  const cells = await store.resultCellsFor(
    own.map((f) => f.extractionResultId).filter((id): id is string => id !== undefined),
  );
  const today = new Date().toISOString().slice(0, 10);
  let mapping: Awaited<ReturnType<typeof store.sheetMappingFor>>;
  for (const candidate of headerCandidates(wb)) {
    mapping = await store.sheetMappingFor(orgId, candidate.fingerprint, today);
    if (mapping !== undefined) break;
  }
  return buildSheetExtract({
    documentId,
    wb,
    fields: own,
    cells,
    amountValue: formatCents(amountCents as Cents),
    ...(mapping !== undefined
      ? {
          headerRow: mapping.headerRow,
          mapping: { version: mapping.version, confirmedBy: mapping.confirmedBy, confirmedOn: mapping.effectiveFrom },
        }
      : {}),
  });
}
