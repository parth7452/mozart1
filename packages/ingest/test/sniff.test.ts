import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { allFixtureDocuments, formatsDocuments, publicDocuments, renderTextPdf } from '@recouple/fixtures';
import {
  ALLOWED_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  RejectedUploadError,
  acceptUpload,
  detectMimeType,
  inspectPdf,
  sha256,
} from '../src/sniff';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
const pdf = () => renderTextPdf([['Deduction Notice', 'Claim ID: TEST-1']]);

describe('type detection', () => {
  it('identifies each allowed type by its magic bytes', () => {
    expect(detectMimeType(pdf())).toBe('application/pdf');
    expect(detectMimeType(PNG)).toBe('image/png');
    expect(detectMimeType(JPEG)).toBe('image/jpeg');
  });

  it('does not take the caller’s word for it', () => {
    // A .pdf full of ELF is still ELF.
    const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]);
    expect(() =>
      acceptUpload(elf, 'notice.pdf', { declaredMimeType: 'application/pdf' }),
    ).toThrow(RejectedUploadError);
  });

  it('warns when the declared type and the bytes disagree, and trusts the bytes', () => {
    const accepted = acceptUpload(PNG, 'scan.png', { declaredMimeType: 'application/pdf' });
    expect(accepted.mimeType).toBe('image/png');
    expect(accepted.warnings.join(' ')).toMatch(/claimed application\/pdf/);
  });

  it('rejects types that are not on the list', () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]);
    expect(() => acceptUpload(zip, 'evidence.zip')).toThrow(/not one of/);
    expect(ALLOWED_MIME_TYPES).not.toContain('application/zip');
  });
});

describe('size and emptiness', () => {
  it('rejects an empty file', () => {
    expect(() => acceptUpload(new Uint8Array(), 'empty.pdf')).toThrow(/is empty/);
  });

  it('rejects a file over the cap', () => {
    try {
      acceptUpload(pdf(), 'big.pdf', { maxBytes: 10 });
      expect.unreachable('should have been rejected');
    } catch (error) {
      expect((error as RejectedUploadError).code).toBe('too_large');
    }
    expect(MAX_UPLOAD_BYTES).toBe(50 * 1024 * 1024);
  });
});

describe('PDF inspection', () => {
  it('accepts a clean generated notice and counts its pages', () => {
    const accepted = acceptUpload(renderTextPdf([['page one'], ['page two']]), 'notice.pdf');
    expect(accepted.mimeType).toBe('application/pdf');
    expect(accepted.pageCount).toBe(2);
    expect(accepted.requiresSplit).toBe(false);
    expect(accepted.sha256).toHaveLength(64);
  });

  it('rejects an encrypted PDF instead of failing later in a renderer', () => {
    const encrypted = Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n'),
      Buffer.from('trailer\n<< /Size 2 /Root 1 0 R /Encrypt 5 0 R >>\n%%EOF\n'),
    ]);
    try {
      acceptUpload(new Uint8Array(encrypted), 'locked.pdf');
      expect.unreachable('should have been rejected');
    } catch (error) {
      expect((error as RejectedUploadError).code).toBe('encrypted_pdf');
    }
  });

  it('rejects a PDF carrying active content', () => {
    const withJs = Buffer.concat([
      Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /OpenAction << /S /JavaScript'),
      Buffer.from(' /JS (app.alert\\(1\\)) >> >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n'),
    ]);
    try {
      acceptUpload(new Uint8Array(withJs), 'active.pdf');
      expect.unreachable('should have been rejected');
    } catch (error) {
      expect((error as RejectedUploadError).code).toBe('active_content_pdf');
    }
  });

  describe('active content is a whole name, the way a reader parses it', () => {
    const body = (dictionary: string) =>
      new Uint8Array(
        Buffer.from(`%PDF-1.4\n1 0 obj\n${dictionary}\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'latin1'),
      );

    it('does not mistake a font or a metadata key for an action', () => {
      // Three real invoices and a purchase order were refused as "active
      // content (/AA)" for nothing but their fonts: a subset font's name is six
      // capitals and a plus, and `AAAAAB+Arial` begins with `AA`. macOS writes
      // `/AAPL:Keywords`. Neither does anything when the file is opened.
      for (const dictionary of [
        '<< /Type /Font /Subtype /TrueType /BaseFont /AAAAAB+Arial,BoldItalic >>',
        '<< /Type /FontDescriptor /FontName/AAAAAA+IDAutomationHC39M/ItalicAngle 0 >>',
        '<< /CMapName /AAAAFL+Arial def >>',
        '<< /BaseFont /JSKQWE+Helvetica /Encoding /XFAVUT+Symbol >>',
        '<< /Producer (Quartz PDFContext) /AAPL:Keywords [ (remittance) ] >>',
        '<< /Title (What /JavaScriptish means) /LaunchDate (2026-09-25) >>',
      ]) {
        expect(inspectPdf(body(dictionary)).activeContent, dictionary).toEqual([]);
        expect(() => acceptUpload(body(dictionary), 'invoice.pdf'), dictionary).not.toThrow();
      }
    });

    it('refuses the additional-actions key however the next token begins', () => {
      for (const dictionary of [
        '<< /Type /Page /AA << /O 5 0 R >> >>',
        '<< /Type /Page /AA 5 0 R >>',
        '<< /Type /Page /AA<</C 5 0 R>> >>',
        '<< /Type /Page /AA\n5 0 R >>',
        '<< /Type /Page /AA[5 0 R] >>',
        '<< /Type /Page /AA/Foo >>',
        '<< /Type /Page /AA%comment\n5 0 R >>',
        // Chrome's reader (PDFium) splits a name at 0xFF, so it reads this key
        // as `/AA`.
        '<< /Type /Page /AA\xff<< /O 5 0 R >> >>',
      ]) {
        expect(inspectPdf(body(dictionary)).activeContent, dictionary).toEqual(['/AA']);
      }
      // And at the very end of the file.
      expect(inspectPdf(new Uint8Array(Buffer.from('%PDF-1.4\n<< /AA', 'latin1'))).activeContent).toEqual([
        '/AA',
      ]);
    });

    it('decodes a name spelled in hex before comparing it', () => {
      // `#53` is `S`: a reader runs `/J#53` as `/JS`. The substring match never
      // saw these at all.
      expect(inspectPdf(body('<< /S /Java#53cript /J#53 (app.alert\\(1\\)) >>')).activeContent).toEqual([
        '/JavaScript',
        '/JS',
      ]);
      expect(inspectPdf(body('<< /Type /Catalog /Open#41ction 5 0 R >>')).activeContent).toEqual([
        '/OpenAction',
      ]);
      expect(inspectPdf(body('<< /Type /Page /#41#41 << /O 5 0 R >> >>')).activeContent).toEqual(['/AA']);
    });

    it('still refuses an attachment reached only through the name tree', () => {
      // An embedded file stream's `/Type` is optional, so the name tree may be
      // the only place `EmbeddedFile` is spelled.
      const dictionary = '<< /Type /Catalog /Names << /EmbeddedFiles << /Names [(a.exe) 5 0 R] >> >> >>';
      expect(inspectPdf(body(dictionary)).activeContent).toEqual(['/EmbeddedFiles']);
      expect(() => acceptUpload(body(dictionary), 'invoice.pdf')).toThrow(RejectedUploadError);
    });
  });

  it('catches a decompression bomb that a size cap would wave through', () => {
    // 64 MB of zeros deflates to a few kilobytes: small on disk, ruinous in a
    // renderer. This is exactly the file a size limit cannot see.
    const bomb = deflateSync(Buffer.alloc(64 * 1024 * 1024, 0));
    const file = Buffer.concat([
      Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${bomb.length} /Filter /FlateDecode >>\nstream\n`),
      bomb,
      Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n'),
    ]);
    expect(file.length).toBeLessThan(200_000); // it really is a small file

    try {
      acceptUpload(new Uint8Array(file), 'bomb.pdf', {
        bombLimits: { maxInflatedBytes: 8 * 1024 * 1024, maxRatio: 500, maxStreams: 500 },
      });
      expect.unreachable('should have been rejected');
    } catch (error) {
      expect((error as RejectedUploadError).code).toBe('decompression_bomb');
    }
  });

  it('flags a document too long to read in one request', () => {
    const many = Array.from({ length: 120 }, (_, i) => [`page ${i + 1}`]);
    const accepted = acceptUpload(renderTextPdf(many), 'long-remittance.pdf');
    expect(accepted.pageCount).toBe(120);
    expect(accepted.requiresSplit).toBe(true);
    expect(accepted.warnings.join(' ')).toMatch(/must be split/);
  });

  it('reports what it inspected without throwing on a clean file', () => {
    const inspection = inspectPdf(pdf());
    expect(inspection.encrypted).toBe(false);
    expect(inspection.activeContent).toEqual([]);
    expect(inspection.pageCount).toBe(1);
  });
});

describe('content hashing', () => {
  it('is stable, and identical bytes dedupe to the same hash', () => {
    const a = renderTextPdf([['same']]);
    const b = renderTextPdf([['same']]);
    expect(sha256(a)).toBe(sha256(b));
    expect(sha256(a)).not.toBe(sha256(renderTextPdf([['different']])));
  });
});

describe('the fixture corpus', () => {
  it('passes the same front door as a customer upload', () => {
    // The `formats` suite too: a distributor's merged-cell table and an 812
    // printout are PDFs a customer would upload through this same door.
    for (const document of [...allFixtureDocuments(), ...formatsDocuments()]) {
      const accepted = acceptUpload(document.bytes, document.filename);
      expect(accepted.mimeType, document.key).toBe('application/pdf');
      expect(accepted.pageCount, document.key).toBe(document.pageText.length);
      expect(accepted.requiresSplit, document.key).toBe(false);
      expect(accepted.warnings, document.key).toEqual([]);
    }
  });

  it('passes real documents nobody wrote for us', () => {
    // The `public` suites: real municipal invoices, purchase orders and
    // Medicaid advices, as their authors' software wrote them. Three were
    // refused for their fonts' names until active content was read as a whole
    // name. Two scans are stored without a view-on-open instruction, which the
    // door refuses whatever it points at (`pages.json` names what was removed).
    for (const document of publicDocuments()) {
      const accepted = acceptUpload(document.bytes, document.filename);
      expect(accepted.mimeType, document.key).toBe('application/pdf');
      if (document.suite === 'public') {
        expect(accepted.pageCount, document.key).toBe(document.pageText.length);
      }
    }
  });
});
