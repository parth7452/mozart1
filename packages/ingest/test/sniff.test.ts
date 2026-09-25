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
import { classicPdf, noise, objectStreamPdf, onePage, stream, type Body } from './pdf-builders';

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
      // Read by the tokenizer, not waved through by the raw scan's fallback.
      expect(inspectPdf(document.bytes).nameScan, document.key).toBe('tokenized');
    }
  });

  it('passes real documents nobody wrote for us', () => {
    // The `public` suites: real municipal invoices, purchase orders and
    // Medicaid advices, as their authors' software wrote them. Three were
    // refused for their fonts' names until active content was read as a whole
    // name. Two scans are stored without the view-on-open instruction they
    // were published with (`pages.json` names what was removed); the door
    // would now take it back (`a destination-only /OpenAction`, below).
    for (const document of publicDocuments()) {
      const accepted = acceptUpload(document.bytes, document.filename);
      expect(accepted.mimeType, document.key).toBe('application/pdf');
      if (document.suite === 'public') {
        expect(accepted.pageCount, document.key).toBe(document.pageText.length);
      }
      expect(inspectPdf(document.bytes).nameScan, document.key).toBe('tokenized');
    }
  });
});

// --- Names where a reader reads them -------------------------------------------

/** The markers that block this file, and how they were found. */
function verdict(bytes: Uint8Array) {
  const inspection = inspectPdf(bytes);
  return {
    blocks: inspection.activeContent,
    allowed: inspection.allowedOpenActions,
    scan: inspection.nameScan,
    reason: inspection.rawScanReason,
  };
}

function refused(bytes: Uint8Array): string {
  try {
    acceptUpload(bytes, 'upload.pdf');
  } catch (error) {
    return (error as RejectedUploadError).code;
  }
  return 'accepted';
}

/** Whether a whole name appears anywhere in the raw bytes, as the old scan read them. */
const rawlyNames = (bytes: Uint8Array, name: string): boolean =>
  new RegExp(`${name.replace('/', '\\/')}(?![^\\x00\\t\\n\\f\\r ()<>[\\]{}/%\\xFF])`).test(
    Buffer.from(bytes).toString('latin1'),
  );

const JS_ACTION = '<< /S /JavaScript /JS (app.alert\\(1\\)) >>';
const URI_ACTION = '<< /S /URI /URI (https://example.com) >>';

/** `onePage` with one of its three objects moved into an object stream, `keys` added to it. */
function compressedPdf(which: 1 | 3, keys: string, options: Parameters<typeof objectStreamPdf>[2] = {}) {
  const plain = onePage();
  const body = (plain.get(which) as string).replace(/>>$/, `${keys} >>`);
  plain.delete(which);
  return objectStreamPdf(plain, new Map([[which, body]]), options);
}

describe('names are read where a reader reads them', () => {
  describe('what a reader never reads as a key is not refused', () => {
    it('a name inside a literal string, escaped and nested parentheses included', () => {
      const bytes = classicPdf(onePage('/Lang (see /OpenAction \\(and /JS\\) (nested /AA) done)'));
      expect(rawlyNames(bytes, '/OpenAction')).toBe(true);
      expect(verdict(bytes)).toEqual({ blocks: [], allowed: [], scan: 'tokenized', reason: undefined });
      expect(refused(bytes)).toBe('accepted');
    });

    it('a key that appears only inside a comment', () => {
      const bytes = classicPdf(onePage(`% /OpenAction ${JS_ACTION} /AA\n/PageMode /UseNone`));
      expect(rawlyNames(bytes, '/JavaScript')).toBe(true);
      expect(verdict(bytes).blocks).toEqual([]);
      expect(refused(bytes)).toBe('accepted');
    });

    it('`/AA ` and `/JS(` inside stream data whose /Length is right', () => {
      // An image's compressed bytes: random-like, so a delimited `/AA` or `/JS`
      // turns up in them by chance. These carry both on purpose.
      const data = Buffer.concat([
        noise(4000, 1),
        Buffer.from('/AA ', 'latin1'),
        noise(4000, 2),
        Buffer.from('/JS(', 'latin1'),
        noise(4000, 3),
      ]);
      const objects = onePage('', '/Resources << /XObject << /Im1 4 0 R >> >>');
      objects.set(
        4,
        stream('/Type /XObject /Subtype /Image /Width 100 /Height 40 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /DCTDecode', data),
      );
      const bytes = classicPdf(objects);
      expect(rawlyNames(bytes, '/AA')).toBe(true);
      expect(rawlyNames(bytes, '/JS')).toBe(true);
      expect(verdict(bytes)).toEqual({ blocks: [], allowed: [], scan: 'tokenized', reason: undefined });
      expect(refused(bytes)).toBe('accepted');
    });

    it('stream data whose /Length is indirect or wrong runs to the first endstream', () => {
      const data = Buffer.concat([noise(3000, 4), Buffer.from('/AA ', 'latin1'), noise(3000, 5)]);
      for (const length of ['9 0 R', String(data.length + 40), '12']) {
        const objects = onePage('', '/Contents 4 0 R');
        objects.set(
          4,
          Buffer.concat([
            Buffer.from(`<< /Length ${length} >>\nstream\n`, 'latin1'),
            data,
            Buffer.from('\nendstream', 'latin1'),
          ]),
        );
        objects.set(9, String(data.length));
        expect(verdict(classicPdf(objects)), length).toEqual({ blocks: [], allowed: [], scan: 'tokenized', reason: undefined });
      }
    });

    it('a comment that ends the file with no newline', () => {
      const bytes = classicPdf(onePage());
      expect(verdict(bytes.subarray(0, bytes.length - 1)).scan).toBe('tokenized');
    });
  });

  describe('a key a reader reads is refused', () => {
    it('beside strings that spell out stream and endstream', () => {
      // A scan that skipped from any `stream` to the next `endstream` would
      // skip the real key between them.
      for (const catalog of [
        `/A (stream\nendstream) /OpenAction ${JS_ACTION} /B (stream\nendstream)`,
        `/A (x) /B (stream) /OpenAction ${JS_ACTION} /C (endstream)`,
        `/A <73747265616d> /OpenAction ${JS_ACTION} /B (endstream)`,
      ]) {
        const bytes = classicPdf(onePage(catalog));
        expect(verdict(bytes), catalog).toMatchObject({
          blocks: ['/JavaScript', '/JS', '/OpenAction'],
          scan: 'tokenized',
        });
        expect(refused(bytes), catalog).toBe('active_content_pdf');
      }
    });

    it('an /OpenAction dictionary inside a Flate object stream', () => {
      // The old blind spot: the whole-file scan saw only compressed bytes here.
      const bytes = compressedPdf(1, `/OpenAction ${JS_ACTION}`);
      expect(rawlyNames(bytes, '/OpenAction')).toBe(false);
      const inspection = inspectPdf(bytes);
      expect(inspection.activeContent).toEqual(['/JavaScript', '/JS', '/OpenAction']);
      expect(inspection.objectStreamsDecoded).toBe(1);
      expect(refused(bytes)).toBe('active_content_pdf');
    });

    it('a file forced to fall back while an action hides in an object stream', () => {
      // One unterminated string sends the file to the raw scan, which cannot
      // see inside compressed object streams. So a file that falls back and has
      // one is refused, rather than read as blind as every file used to be.
      const hidden = compressedPdf(1, `/OpenAction ${JS_ACTION}`);
      const bytes = new Uint8Array(Buffer.concat([Buffer.from(hidden), Buffer.from('\n(never closed', 'latin1')]));
      const inspection = inspectPdf(bytes);
      expect(inspection.nameScan).toBe('raw');
      expect(inspection.activeContent).toEqual([]);
      expect(inspection.objectStreamsUnread).toBe(true);
      expect(refused(bytes)).toBe('malformed_pdf');
    });

    it('a file that falls back with no object stream is judged by the raw scan, as before', () => {
      const bytes = new Uint8Array(
        Buffer.concat([Buffer.from(classicPdf(onePage())), Buffer.from('\n(never closed', 'latin1')]),
      );
      const inspection = inspectPdf(bytes);
      expect(inspection.nameScan).toBe('raw');
      expect(inspection.objectStreamsUnread).toBe(false);
      expect(refused(bytes)).toBe('accepted');
    });

    it('a hex-escaped /AA inside an object stream', () => {
      const bytes = compressedPdf(3, '/#41#41 << /O 5 0 R >>');
      expect(verdict(bytes)).toMatchObject({ blocks: ['/AA'], scan: 'tokenized' });
      expect(refused(bytes)).toBe('active_content_pdf');
    });

    it('an object stream whose /Type does not say so', () => {
      // pdf.js reads an object stream by its /First and /N and never checks
      // /Type, so neither does the door.
      const bytes = compressedPdf(3, `/AA << /O ${JS_ACTION} >>`, { dictionary: '/Filter /FlateDecode' });
      expect(verdict(bytes)).toMatchObject({ blocks: ['/JavaScript', '/JS', '/AA'], scan: 'tokenized' });
    });

    it('an object stream cut short, or with a bad checksum, as far as it inflates', () => {
      // pdf.js reads a truncated Flate stream as far as it goes and never
      // checks the Adler-32, so neither keeps the door from reading one.
      const truncated = compressedPdf(3, `/AA << /O ${JS_ACTION} >>`, {
        // Letters after the last object, so the cut falls in them.
        encode: (text) => {
          const letters = Buffer.from([...noise(2000, 6)].map((byte) => 0x61 + (byte % 26)));
          const full = deflateSync(Buffer.concat([text, Buffer.from('\n'), letters]));
          return full.subarray(0, full.length - 300);
        },
      });
      expect(verdict(truncated)).toMatchObject({ blocks: ['/JavaScript', '/JS', '/AA'], scan: 'tokenized' });
      const badChecksum = compressedPdf(3, `/AA << /O ${JS_ACTION} >>`, {
        encode: (text) => {
          const data = Buffer.from(deflateSync(text));
          data[data.length - 1] = (data[data.length - 1] ?? 0) ^ 0xff;
          return data;
        },
      });
      expect(verdict(badChecksum)).toMatchObject({ blocks: ['/JavaScript', '/JS', '/AA'], scan: 'tokenized' });
    });

    it('a destination-only /OpenAction beside an /AA elsewhere', () => {
      const bytes = classicPdf(onePage('/OpenAction [3 0 R /Fit]', '/AA << /O 5 0 R >>'));
      expect(verdict(bytes)).toEqual({
        blocks: ['/AA'],
        allowed: ['[3 0 R /Fit]'],
        scan: 'tokenized',
        reason: undefined,
      });
      expect(refused(bytes)).toBe('active_content_pdf');
    });
  });

  describe('what it cannot account for goes to the raw scan, which is stricter', () => {
    const fallsBack = (bytes: Uint8Array, reason: RegExp): readonly string[] => {
      const inspection = inspectPdf(bytes);
      expect(inspection.nameScan).toBe('raw');
      expect(inspection.rawScanReason).toMatch(reason);
      expect(inspection.allowedOpenActions).toEqual([]);
      return inspection.activeContent;
    };
    const lone = (text: string) => new Uint8Array(Buffer.from(`%PDF-1.4\n${text}\n%%EOF\n`, 'latin1'));

    it('an unterminated literal string before a real key', () => {
      const bytes = classicPdf(onePage(`/Title (never closed /OpenAction ${JS_ACTION}`));
      expect(fallsBack(bytes, /unterminated literal string/)).toEqual(['/JavaScript', '/JS', '/OpenAction']);
      expect(refused(bytes)).toBe('active_content_pdf');
    });

    it('an unterminated hex string, dictionary or array, or a bracket closing the wrong thing', () => {
      expect(fallsBack(lone('1 0 obj\n<< /ID <0011 /AA'), /unterminated hex string/)).toEqual(['/AA']);
      expect(fallsBack(lone('1 0 obj\n<< /Type /Catalog'), /unterminated dictionary/)).toEqual([]);
      expect(fallsBack(lone('1 0 obj\n[1 0 R'), /unterminated array/)).toEqual([]);
      expect(fallsBack(lone('1 0 obj\n<< /A [ >> ]'), /closes no dictionary/)).toEqual([]);
    });

    it('a stream with no endstream', () => {
      expect(fallsBack(lone('1 0 obj\n<< /Length 999 >>\nstream\n/AA '), /no endstream/)).toEqual(['/AA']);
    });

    it('an object header a reader could jump to inside a string, a comment or stream data', () => {
      // A cross-reference entry may point anywhere, and a repairing reader
      // looks for headers anywhere. One inside what the tokenizer skipped
      // would have a reader parse a catalog nobody tokenized.
      const hidden = `2 0 obj\n<< /Type /Catalog /OpenAction ${JS_ACTION} >>\nendobj`;
      expect(fallsBack(classicPdf(onePage(`/Title (${hidden})`)), /object header inside a literal string/)).toContain('/OpenAction');
      expect(fallsBack(classicPdf(onePage(`%${hidden.replaceAll('\n', ' ')}\n`)), /object header inside a comment/)).toContain(
        '/OpenAction',
      );
      const objects = onePage('', '/Contents 4 0 R');
      objects.set(4, stream('', `q ${hidden} Q`));
      expect(fallsBack(classicPdf(objects), /object header inside stream data/)).toContain('/OpenAction');
      // A header written across a comment, whose first half the comment could hold.
      expect(fallsBack(lone('1 0 obj\n<< >>\nendobj\n7 %2\n0 obj\n[3 0 R /Fit]\nendobj'), /obj keyword/)).toEqual([]);
    });

    it('a trailer inside skipped bytes', () => {
      const bytes = classicPdf(onePage(`/Title (trailer << /Root << /OpenAction ${JS_ACTION} >> >>)`));
      expect(fallsBack(bytes, /trailer inside a literal string/)).toContain('/OpenAction');
    });

    it('an object stream it cannot decode', () => {
      // The raw scan cannot see into these either. Refusing them outright
      // instead would be a tightening; see the report on this change.
      const keys = `/AA << /O ${JS_ACTION} >>`;
      expect(fallsBack(compressedPdf(3, keys, { encode: (text) => noise(text.length, 7) }), /will not inflate/)).toEqual([]);
      expect(
        fallsBack(
          compressedPdf(3, keys, {
            dictionary: '/Type /ObjStm /Filter /ASCIIHexDecode',
            encode: (text) => Buffer.from(text.toString('hex'), 'latin1'),
          }),
          /filter other than/,
        ),
      ).toEqual([]);
      expect(
        fallsBack(compressedPdf(3, keys, { dictionary: '/Type /ObjStm /Filter /FlateDecode /DecodeParms << /Predictor 12 >>' }), /DecodeParms/),
      ).toEqual([]);
    });

    it('object streams that inflate past the budget the bomb loop never reached', () => {
      // The bomb loop inflates a file's first 500 streams; the name scan reads
      // object streams wherever they are, and stops at its own budget.
      const plain = onePage();
      plain.delete(3);
      for (let n = 10; n < 510; n += 1) plain.set(n, stream('', 'x'));
      const bytes = objectStreamPdf(
        plain,
        new Map([[3, `<< /Type /Page /Parent 2 0 R /Pad (${'0'.repeat(2 * 1024 * 1024)}) >>`]]),
      );
      const inspection = inspectPdf(bytes, { maxInflatedBytes: 1024 * 1024, maxRatio: 500, maxStreams: 500 });
      expect(inspection.nameScan).toBe('raw');
      expect(inspection.rawScanReason).toMatch(/past the inflate budget/);
    });

    it('an object stream whose object starts inside a string', () => {
      const plain = onePage();
      plain.delete(3);
      const bytes = objectStreamPdf(plain, new Map([[3, '(<< /Type /Page /Parent 2 0 R /AA << /O 5 0 R >> >>)']]), {
        offsets: [1],
      });
      expect(fallsBack(bytes, /starts inside a string/)).toEqual([]);
    });
  });

  it('refuses a decompression bomb in an object stream exactly as before', () => {
    const bytes = compressedPdf(3, `/Pad (${'0'.repeat(9 * 1024 * 1024)})`);
    try {
      acceptUpload(bytes, 'bomb.pdf', {
        bombLimits: { maxInflatedBytes: 8 * 1024 * 1024, maxRatio: 500, maxStreams: 500 },
      });
      expect.unreachable('should have been rejected');
    } catch (error) {
      expect((error as RejectedUploadError).code).toBe('decompression_bomb');
    }
  });
});

// --- A destination-only /OpenAction ----------------------------------------------

describe('a destination-only /OpenAction', () => {
  const openingAt = (value: string, extra: ReadonlyMap<number, Body> = new Map()) => {
    const objects = onePage(`/OpenAction ${value}`);
    for (const [number, body] of extra) objects.set(number, body);
    return verdict(classicPdf(objects));
  };

  describe('is allowed when all it says is where to open', () => {
    it.each([
      ['[3 0 R /Fit]', '[3 0 R /Fit]'],
      ['[0 /XYZ null null 0]', '[0 /XYZ null null 0]'],
      ['[3 0 R /XYZ 0 792 1.25]', '[3 0 R /XYZ 0 792 1.25]'],
      ['[3 0 R /FitH 792]', '[3 0 R /FitH 792]'],
      ['[3 0 R /FitR 0 0 612 792]', '[3 0 R /FitR 0 0 612 792]'],
      ['[ 3 0 R /FitBV -.5 ]', '[3 0 R /FitBV -.5]'],
      ['[3 0 R /F#69t]', '[3 0 R /Fit]'],
      ['[3 0 R/Fit]', '[3 0 R /Fit]'],
    ])('%s', (value, destination) => {
      expect(openingAt(value)).toEqual({ blocks: [], allowed: [destination], scan: 'tokenized', reason: undefined });
    });

    it('an indirect reference to a destination array', () => {
      expect(openingAt('4 0 R', new Map([[4, '[3 0 R /FitH 792]']]))).toEqual({
        blocks: [],
        allowed: ['4 0 R → [3 0 R /FitH 792]'],
        scan: 'tokenized',
        reason: undefined,
      });
    });

    it('a direct destination inside an object stream', () => {
      expect(verdict(compressedPdf(1, '/OpenAction [3 0 R /Fit]'))).toMatchObject({
        blocks: [],
        allowed: ['[3 0 R /Fit]'],
        scan: 'tokenized',
      });
    });

    it('the Hingham scans, with the /OpenAction they were published with', () => {
      // Both were stored without it (packages/fixtures/public/README.md). Put
      // back exactly as the originals carried it, they now come through.
      const hingham = publicDocuments().filter((document) => document.key.startsWith('eb-hingham-'));
      expect(hingham).toHaveLength(2);
      for (const document of hingham) {
        const stored = Buffer.from(document.bytes).toString('latin1');
        expect(stored, document.key).toContain('/Type /Catalog\n');
        const original = new Uint8Array(
          Buffer.from(stored.replace('/Type /Catalog\n', '/Type /Catalog\n/OpenAction[1 0 R/Fit]\n'), 'latin1'),
        );
        expect(rawlyNames(original, '/OpenAction'), document.key).toBe(true);
        expect(verdict(original), document.key).toEqual({
          blocks: [],
          allowed: ['[1 0 R /Fit]'],
          scan: 'tokenized',
          reason: undefined,
        });
        expect(refused(original), document.key).toBe('accepted');
      }
    });
  });

  describe('is refused otherwise, as before', () => {
    it.each([
      ['a GoTo action', '<< /S /GoTo /D [3 0 R /Fit] >>'],
      ['a URI action', URI_ACTION],
      ['a named destination', '/Chapter1'],
      ['a named destination string', '(Chapter1)'],
      ['a view short of its parameters', '[3 0 R /XYZ null null]'],
      ['a view with one too many', '[3 0 R /Fit 0]'],
      ['a view nobody defined', '[3 0 R /Bogus]'],
      ['no page', '[/Fit]'],
      ['a negative page', '[-1 /Fit]'],
      ['a string parameter', '[3 0 R /FitH (0)]'],
      ['a nested array', '[3 0 R /Fit [0]]'],
      ['a reference as a parameter', '[3 0 R /XYZ 5 0 R null 0]'],
      ['a reference that resolves nowhere', '9 0 R'],
      ['a number that is not a reference', '4 /Fit'],
    ])('%s', (_, value) => {
      const result = openingAt(value);
      expect(result.allowed).toEqual([]);
      expect(result.blocks).toContain('/OpenAction');
    });

    it('a reference to an action, or to anything but one array', () => {
      for (const target of ['<< /S /GoTo /D [3 0 R /Fit] >>', '[3 0 R /Fit] [3 0 R /Fit]', '(x)']) {
        expect(openingAt('4 0 R', new Map([[4, target]])).blocks, target).toEqual(['/OpenAction']);
      }
    });

    it('a reference whose number another header ends in', () => {
      // A cross-reference entry pointing at the `2` of `12 0 obj` has a reader
      // take object 12's action for object 2.
      const result = openingAt('2 0 R', new Map<number, Body>([[2, '[3 0 R /Fit]'], [12, URI_ACTION]]));
      expect(result).toMatchObject({ blocks: ['/OpenAction'], allowed: [] });
      expect(openingAt('2 0 R', new Map<number, Body>([[2, '[3 0 R /Fit]'], [12, '[3 0 R /FitH 0]']])).allowed).toEqual([
        '2 0 R → [3 0 R /Fit]',
      ]);
    });

    it('a reference into an object stream, which cannot be resolved there', () => {
      const bytes = objectStreamPdf(onePage('/OpenAction 4 0 R'), new Map([[4, '[3 0 R /Fit]']]));
      expect(verdict(bytes)).toMatchObject({ blocks: ['/OpenAction'], allowed: [], scan: 'tokenized' });
    });

    it('a reference to a body destination in a file with object streams', () => {
      // pdf.js takes the object stream slot its cross-reference stream names,
      // whatever number the object stream gives that slot. Here the body's
      // `4 0 obj` is a destination, and the cross-reference stream sends
      // object 4 to the slot of a URI action labelled 5.
      const plain = onePage('/OpenAction 4 0 R');
      plain.set(4, '[3 0 R /Fit]');
      const bytes = objectStreamPdf(plain, new Map([[5, URI_ACTION]]), { slotFor: new Map([[4, 5]]) });
      expect(verdict(bytes)).toMatchObject({ blocks: ['/OpenAction'], allowed: [], scan: 'tokenized' });
    });

    it('another /OpenAction elsewhere whose value is a dictionary', () => {
      const bytes = classicPdf(onePage('/OpenAction [3 0 R /Fit]', `/OpenAction ${URI_ACTION}`));
      expect(verdict(bytes)).toEqual({
        blocks: ['/OpenAction'],
        allowed: ['[3 0 R /Fit]'],
        scan: 'tokenized',
        reason: undefined,
      });
    });

    it('any /OpenAction seen only through the raw fallback', () => {
      const bytes = classicPdf(onePage('/OpenAction [3 0 R /Fit] /Title (never closed'));
      expect(verdict(bytes)).toMatchObject({ blocks: ['/OpenAction'], allowed: [], scan: 'raw' });
      expect(refused(bytes)).toBe('active_content_pdf');
    });
  });
});
