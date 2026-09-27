import { z } from 'zod';

/**
 * A person-confirmed, versioned column mapping for one tenant's spreadsheets
 * from one debtor (ADR 0056). Code reads rows through it; no model proposes it.
 * Columns are 1-based sheet column numbers, keyed by the field they carry.
 */
export const SheetMappingSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  debtorId: z.string().uuid(),
  version: z.number().int().positive(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  headerRow: z.number().int().positive(),
  sheetName: z.string().min(1),
  headerFingerprint: z.array(z.string()).min(1),
  shape: z.enum(['remittance', 'deduction_list']),
  columns: z.record(z.string(), z.number().int().positive()),
  nonLineRule: z.union([
    z.object({ blankColumn: z.number().int().positive() }).strict(),
    z.object({ firstCellMatches: z.array(z.string()).min(1) }).strict(),
  ]),
  sign: z.enum(['deductions_positive', 'deductions_negative']),
  currency: z.string().length(3),
  dateOrder: z.enum(['mdy', 'dmy', 'ymd']),
  sourceDocumentId: z.string().uuid().nullable(),
  confirmedBy: z.string().uuid(),
});

export type SheetMapping = z.infer<typeof SheetMappingSchema>;

/** A header row's identity: each cell's text trimmed, in column order. */
export function headerFingerprint(cells: readonly { text: string }[]): string[] {
  return cells.map((cell) => cell.text.trim());
}
