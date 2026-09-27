/** Small, real XLSX packages for the door's tests, built with fflate's `zipSync`. */
import { strToU8, zipSync, type Zippable } from 'fflate';

export const SHEET_MAIN = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';

export interface WorkbookParts {
  sheets?: { name: string; xml: string; state?: string }[];
  sharedStrings?: string[];
  styles?: string;
  date1904?: boolean;
  extra?: Record<string, string | Uint8Array>;
  contentTypes?: string;
}

export const sheetXml = (rows: string): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;

export function workbookParts(p: WorkbookParts = {}): Zippable {
  const sheets = p.sheets ?? [{ name: 'Sheet1', xml: sheetXml('<row r="1"><c r="A1" t="inlineStr"><is><t>hi</t></is></c></row>') }];
  const files: Zippable = {
    '[Content_Types].xml': strToU8(
      p.contentTypes ??
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${SHEET_MAIN}"/></Types>`,
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${p.date1904 ? '<workbookPr date1904="1"/>' : ''}<sheets>${sheets
        .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ''} r:id="rId${i + 1}"/>`)
        .join('')}</sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join('')}</Relationships>`,
    ),
  };
  sheets.forEach((s, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(s.xml)));
  if (p.sharedStrings) {
    files['xl/sharedStrings.xml'] = strToU8(
      `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${p.sharedStrings
        .map((s) => `<si><t>${s}</t></si>`)
        .join('')}</sst>`,
    );
  }
  if (p.styles) files['xl/styles.xml'] = strToU8(p.styles);
  for (const [k, v] of Object.entries(p.extra ?? {})) files[k] = typeof v === 'string' ? strToU8(v) : v;
  return files;
}

export const buildXlsx = (p: WorkbookParts = {}): Uint8Array => zipSync(workbookParts(p));
