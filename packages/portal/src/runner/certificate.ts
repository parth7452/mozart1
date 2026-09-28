// The egress proxy's own certificate (egress.ts): made once per run, for that
// run's proxy and that run's browser alone, and never written anywhere.
//
// The proxy decides the method and target of every request the browser sends,
// and inside a CONNECT tunnel those are encrypted to whoever answers the TLS
// handshake. So the proxy answers it, with this certificate, and the browser is
// told to accept this one key and no other (`--ignore-certificate-errors-
// spki-list`, egressSwitches). Upstream, the proxy makes its own TLS
// connection to the portal and checks the portal's certificate against the
// system's roots, as a browser would.
//
// One self-signed ECDSA P-256 certificate serves every host: Chromium accepts
// a chain holding a listed key whatever it names, so no certificate is minted
// per host and no authority exists that could sign another. The key lives in
// this process's memory for the run and is dropped with the proxy. Node can
// read a certificate and not write one, so the DER is written here, field by
// field (RFC 5280 §4.1), and read back by Node before it is used.
import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';

export interface EgressCertificate {
  /** The private key, PKCS #8 PEM. */
  readonly key: string;
  /** The certificate, PEM. */
  readonly cert: string;
  /** SHA-256 of the certificate's SubjectPublicKeyInfo, base64: what the browser is told to accept. */
  readonly spkiSha256: string;
}

/** How long the certificate is valid either side of now: longer than any run (the worker's ceiling is 30 minutes). */
const VALIDITY_MS = 24 * 60 * 60 * 1000;
/** ecdsa-with-SHA256 (RFC 5758 §3.2), with no parameters. */
const ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';
const COMMON_NAME = '2.5.4.3';
const BASIC_CONSTRAINTS = '2.5.29.19';

/** A certificate for one run's egress proxy, with a key made for it. */
export function egressCertificate(now: number = Date.now()): EgressCertificate {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const algorithm = sequence(objectId(ECDSA_WITH_SHA256));
  const name = sequence(set(sequence(objectId(COMMON_NAME), tlv(0x0c, Buffer.from('portal-read egress proxy', 'utf8')))));
  // A positive serial of 16 octets, in at most 20 (RFC 5280 §4.1.2.2): its first
  // octet neither zero, which DER would drop, nor above 0x7f, which would read
  // as a sign.
  const serial = randomBytes(16);
  serial[0] = 0x40 | (serial[0]! & 0x3f);
  const tbs = sequence(
    tlv(0xa0, integer(Buffer.from([2]))), // v3
    integer(serial),
    algorithm,
    name, // issuer: itself
    sequence(utcTime(new Date(now - VALIDITY_MS)), utcTime(new Date(now + VALIDITY_MS))),
    name,
    spki,
    // Not an authority: it can sign nothing, and a chain that names it proves nothing but itself.
    tlv(0xa3, sequence(sequence(objectId(BASIC_CONSTRAINTS), tlv(0x01, Buffer.from([0xff])), tlv(0x04, sequence())))),
  );
  const der = sequence(tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, privateKey)])));
  const cert = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
  // Read back as Node reads a certificate: a DER mistake here throws now, not in a handshake.
  const parsed = new X509Certificate(cert);
  if (!parsed.checkPrivateKey(privateKey)) throw new Error('the egress certificate does not carry its own key');
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    cert,
    spkiSha256: createHash('sha256').update(spki).digest('base64'),
  };
}

/** One DER tag-length-value (X.690 §8.1). */
function tlv(tag: number, content: Buffer): Buffer {
  const length = content.length;
  if (length < 0x80) return Buffer.concat([Buffer.from([tag, length]), content]);
  const octets: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) octets.unshift(n % 256);
  return Buffer.concat([Buffer.from([tag, 0x80 | octets.length, ...octets]), content]);
}

function sequence(...parts: Buffer[]): Buffer {
  return tlv(0x30, Buffer.concat(parts));
}

function set(...parts: Buffer[]): Buffer {
  return tlv(0x31, Buffer.concat(parts));
}

/**
 * A non-negative INTEGER in DER's one encoding (X.690 §8.3.2): no leading zero
 * octet but the one needed where the high bit would otherwise read as a sign.
 */
function integer(magnitude: Buffer): Buffer {
  let start = 0;
  while (start < magnitude.length - 1 && magnitude[start] === 0) start++;
  const minimal = magnitude.subarray(start);
  return tlv(0x02, (minimal[0]! & 0x80) !== 0 ? Buffer.concat([Buffer.from([0]), minimal]) : minimal);
}

function objectId(dotted: string): Buffer {
  const [first, second, ...rest] = dotted.split('.').map(Number);
  const octets = [first! * 40 + second!];
  for (const arc of rest) {
    const base128 = [arc % 128];
    for (let n = Math.floor(arc / 128); n > 0; n = Math.floor(n / 128)) base128.unshift(0x80 | (n % 128));
    octets.push(...base128);
  }
  return tlv(0x06, Buffer.from(octets));
}

/** UTCTime, YYMMDDHHMMSSZ: for a year before 2050 (RFC 5280 §4.1.2.5.1). */
function utcTime(date: Date): Buffer {
  return tlv(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`, 'ascii'));
}
