import { describe, expect, it } from 'vitest';
import { PORTAL_LIMITS, PortalCredentialPayloadSchema } from '../src/contracts';
import {
  TOTP_DIGITS,
  TOTP_STEP_SECONDS,
  TotpInputError,
  TotpSecretError,
  canonicalTotpSecret,
  totpCode,
  totpStepRemainingMs,
} from '../src/totp';

/** RFC 4648 base32, unpadded: written out here so the fixture below is checked, not trusted. */
function base32(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  return bits > 0 ? out + alphabet[(buffer << (5 - bits)) & 31] : out;
}

/** RFC 6238 Appendix B's SHA-1 seed, the ASCII string "12345678901234567890", as a setup key. */
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

/** RFC 6238 Appendix B, the SHA-1 rows: time in seconds and the eight-digit TOTP. */
const RFC_6238_SHA1: Array<[number, string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

/** RFC 4226 Appendix D: HOTP over the same seed, counters 0 to 9, six digits. */
const RFC_4226_HOTP = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];

describe('the RFC fixture', () => {
  it('is the ASCII seed "12345678901234567890" in base32', () => {
    expect(base32(Buffer.from('12345678901234567890', 'ascii'))).toBe(RFC_SECRET);
  });

  it('is what the contract seals a TOTP secret as', () => {
    const payload = { username: 'reader', password: 'x', totpSecret: RFC_SECRET };
    expect(PortalCredentialPayloadSchema.safeParse(payload).success).toBe(true);
  });
});

describe('RFC 6238 Appendix B, the SHA-1 column', () => {
  it.each(RFC_6238_SHA1)('at %i seconds is %s in eight digits', (seconds, code) => {
    expect(totpCode(RFC_SECRET, seconds * 1000, 8)).toBe(code);
  });

  it.each(RFC_6238_SHA1)('at %i seconds is the last six digits of %s in six', (seconds, code) => {
    // Truncated modulo 10^6 rather than 10^8, which is the eight-digit code's
    // last six digits: what an authenticator app shows for the same moment.
    expect(totpCode(RFC_SECRET, seconds * 1000)).toBe(code.slice(-6));
    expect(totpCode(RFC_SECRET, seconds * 1000, 6)).toBe(code.slice(-6));
  });
});

describe('RFC 4226 Appendix D, through the step', () => {
  it.each(RFC_4226_HOTP.map((code, counter) => [counter, code] as const))(
    'step %i is that HOTP counter’s code, %s',
    (counter, code) => {
      // TOTP is HOTP over the number of whole steps since the epoch, so the
      // first moment of step n is HOTP(n), and so is its last millisecond.
      const stepMs = TOTP_STEP_SECONDS * 1000;
      expect(totpCode(RFC_SECRET, counter * stepMs)).toBe(code);
      expect(totpCode(RFC_SECRET, counter * stepMs + stepMs - 1)).toBe(code);
    },
  );
});

describe('a code', () => {
  it('is six digits unless asked for more, and keeps its leading zeros', () => {
    expect(TOTP_DIGITS).toBe(6);
    expect(TOTP_STEP_SECONDS).toBe(30);
    // 1111111109 s is 07081804 in eight digits: its six are 081804, a leading zero kept.
    expect(totpCode(RFC_SECRET, 1_111_111_109_000)).toBe('081804');
    expect(totpCode(RFC_SECRET, 1_111_111_109_000, 7)).toBe('7081804');
    expect(totpCode(RFC_SECRET, 1_111_111_109_000, 8)).toBe('07081804');
  });

  it('changes at a step boundary and not inside one', () => {
    expect(totpCode(RFC_SECRET, 29_999)).toBe(RFC_4226_HOTP[0]);
    expect(totpCode(RFC_SECRET, 30_000)).toBe(RFC_4226_HOTP[1]);
    expect(totpCode(RFC_SECRET, 59_999.9)).toBe(RFC_4226_HOTP[1]);
  });

  it('agrees with itself across digit counts for any key and time', () => {
    // Every length is the same truncated number modulo another power of ten,
    // so the shorter code is always the longer one's tail.
    for (let i = 0; i < 64; i += 1) {
      const key = base32(Buffer.from(Array.from({ length: 20 }, (_, j) => (i * 31 + j * 17) % 256)));
      const at = 1_700_000_000_000 + i * 7_919_000;
      const eight = totpCode(key, at, 8);
      expect(eight).toMatch(/^\d{8}$/);
      expect(totpCode(key, at, 7)).toBe(eight.slice(-7));
      expect(totpCode(key, at, 6)).toBe(eight.slice(-6));
    }
  });

  it('says how long it has left', () => {
    expect(totpStepRemainingMs(0)).toBe(30_000);
    expect(totpStepRemainingMs(1)).toBe(29_999);
    expect(totpStepRemainingMs(29_999)).toBe(1);
    expect(totpStepRemainingMs(30_000)).toBe(30_000);
    expect(totpStepRemainingMs(1_111_111_109_000)).toBe(1_000);
  });
});

describe('what a code is refused for', () => {
  it.each([
    ['a time before the epoch', -1],
    ['a time that is not a number', Number.NaN],
    ['an infinite time', Number.POSITIVE_INFINITY],
    ['a time past what a millisecond count can hold exactly', Number.MAX_SAFE_INTEGER + 2],
  ])('%s', (_, at) => {
    expect(() => totpCode(RFC_SECRET, at)).toThrow(TotpInputError);
    expect(() => totpStepRemainingMs(at)).toThrow(TotpInputError);
  });

  it.each([5, 9, 6.5, 0])('%s digits', (digits) => {
    expect(() => totpCode(RFC_SECRET, 0, digits as 6)).toThrow(TotpInputError);
  });

  const unusable: Array<[string, string]> = [
    ['empty', ''],
    ['lower case', RFC_SECRET.toLowerCase()],
    ['spaced as an app shows it', 'GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ'],
    ['padded', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ======'],
    ['carrying a 0, which base32 has no letter for', 'GEZDGNBVGY3TQOJ0'],
    ['carrying an 8', 'GEZDGNBVGY3TQOJ8'],
    ['one character too many for a whole encoding', 'GEZDGNBVGY3TQOJQG'],
    ['three characters too many', 'GEZDGNBVGY3TQOJQGEZ'],
    ['six characters too many', 'GEZDGNBVGY3TQOJQGEZDGN'],
    ['shorter than the contract allows', 'GEZDGNBVGY3TQOJ'],
    ['longer than the contract allows', 'A'.repeat(PORTAL_LIMITS.totpSecretMax + 8)],
  ];

  it.each(unusable)('a secret that is %s', (_, secret) => {
    expect(() => totpCode(secret, 0)).toThrow(TotpSecretError);
  });

  it('a secret that is not a string', () => {
    expect(() => totpCode(undefined as unknown as string, 0)).toThrow(TotpSecretError);
  });

  it('says which rule, and never the secret', () => {
    // A secret that is wrong only in its length, so every character of it
    // would be worth something to whoever read the message.
    const secret = 'MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43UOV3HO6DZPI';
    let refusal: unknown;
    try {
      totpCode(secret.slice(0, 17), 0);
    } catch (thrown) {
      refusal = thrown;
    }
    expect(refusal).toBeInstanceOf(TotpSecretError);
    expect((refusal as Error).name).toBe('TotpSecretError');
    expect((refusal as Error).message).not.toContain(secret.slice(0, 8));
    expect(String(refusal)).not.toContain(secret.slice(0, 8));
  });
});

describe('a TOTP secret, sealed or refused', () => {
  // The worker must compute a code from every secret Settings can seal, or a
  // credential accepted at entry fails at run time; and from nothing Settings
  // would refuse. The contract's schema is the rule, so the two are asked the
  // same question.
  const candidates = [
    RFC_SECRET,
    'JBSWY3DPEHPK3PXP',
    'GEZDGNBVGY3TQOJQGEZDGNBVGY',
    'A'.repeat(PORTAL_LIMITS.totpSecretMin),
    'A'.repeat(PORTAL_LIMITS.totpSecretMax),
    'A'.repeat(PORTAL_LIMITS.totpSecretMin - 1),
    'A'.repeat(PORTAL_LIMITS.totpSecretMax + 1),
    'GEZDGNBVGY3TQOJQG',
    'GEZDGNBVGY3TQOJQGEZ',
    'GEZDGNBVGY3TQOJQGEZDGN',
    'GEZDGNBVGY3TQOJQGEZDG',
    'GEZDGNBVGY3TQOJQGEZD',
    'gezdgnbvgy3tqojq',
    'GEZDGNBVGY3TQOJ1',
    'GEZDGNBV GY3TQOJQ',
    'GEZDGNBVGY3TQOJQ====',
  ];

  it.each(candidates)('%s: the worker computes a code exactly when the contract would seal it', (secret) => {
    const sealable = PortalCredentialPayloadSchema.safeParse({
      username: 'reader',
      password: 'x',
      totpSecret: secret,
    }).success;
    let computable = true;
    try {
      totpCode(secret, 0);
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(TotpSecretError);
      computable = false;
    }
    expect(computable).toBe(sealable);
  });
});

describe('a setup key as a person types it', () => {
  it.each([
    ['as an app shows it, in groups', 'GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ'],
    ['in lower case', 'gezd gnbv gy3t qojq gezd gnbv gy3t qojq'],
    ['with hyphens', 'GEZD-GNBV-GY3T-QOJQ-GEZD-GNBV-GY3T-QOJQ'],
    ['with a newline and surrounding space', '  GEZDGNBVGY3TQOJQ\nGEZDGNBVGY3TQOJQ  '],
  ])('is folded to canonical base32 %s', (_, typed) => {
    expect(canonicalTotpSecret(typed)).toBe(RFC_SECRET);
  });

  it('loses its padding', () => {
    expect(canonicalTotpSecret('GEZDGNBVGY3TQOJQGE======')).toBe('GEZDGNBVGY3TQOJQGE');
  });

  it('comes out as a secret the contract seals and a code can be computed from', () => {
    const secret = canonicalTotpSecret('jbsw y3dp ehpk 3pxp');
    expect(PortalCredentialPayloadSchema.safeParse({ username: 'reader', password: 'x', totpSecret: secret }).success).toBe(true);
    expect(totpCode(secret, 0)).toMatch(/^\d{6}$/);
  });

  it.each([
    ['a 0 where an O was meant', 'GEZD GNBV GY3T 0OJQ'],
    ['a 1 where an I was meant', 'GEZD GNBV GY3T QOJ1'],
    ['a letter outside ASCII, which upper-casing would turn into two', 'GEZD GNBV GY3T QOJß'],
    ['padding in the middle', 'GEZD==GNBV GY3T QOJQ'],
    ['an otpauth URI rather than its key', 'otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ'],
    ['too few characters once folded', 'GEZD GNBV GY3T QOJ'],
    ['nothing', '   '],
  ])('is refused with %s, and not guessed at', (_, typed) => {
    expect(() => canonicalTotpSecret(typed)).toThrow(TotpSecretError);
  });

  it('is refused by rule, never quoting what was typed', () => {
    let refusal: unknown;
    try {
      canonicalTotpSecret('MFRG GZDF MZTW Q2LK NNWG 23TP 0BYX');
    } catch (thrown) {
      refusal = thrown;
    }
    expect(refusal).toBeInstanceOf(TotpSecretError);
    expect((refusal as Error).message).not.toContain('MFRG');
  });
});
