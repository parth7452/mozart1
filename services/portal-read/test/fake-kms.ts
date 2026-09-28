// A stand-in for AWS KMS, for the production entry point's tests. It does the
// two operations the portal key is used for:
//  - GenerateDataKey, in process, for the test's seal-only KmsTokenCipher, as
//    the app's cipher asks it;
//  - Decrypt, over HTTP as the AWS SDK sends it (JSON 1.1,
//    `X-Amz-Target: TrentService.Decrypt`), as the worker's open-only cipher
//    asks it, with `AWS_ENDPOINT_URL_KMS` pointing here.
// It keeps its own root key and, as KMS does, binds each wrapped key to its
// encryption context, so a Decrypt under any other context fails. Given a
// KeyId it refuses a key but its own, as KMS does. It records every request
// it receives, so a test can show a run asked it nothing.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeKmsDecrypt {
  readonly keyId: unknown;
  readonly encryptionContext: unknown;
}

export interface FakeKms {
  /** For `AWS_ENDPOINT_URL_KMS`. */
  readonly endpoint: string;
  /** Every request it received, by its X-Amz-Target. */
  readonly targets: string[];
  /** Every Decrypt it was asked, with the key and context it named. */
  readonly decrypts: FakeKmsDecrypt[];
  generateDataKey(input: { readonly keyId: string; readonly encryptionContext: Record<string, string> }): Promise<{ plaintext: Buffer; wrappedKey: Buffer; keyId: string }>;
  close(): Promise<void>;
}

export async function startFakeKms(keyArn: string): Promise<FakeKms> {
  const root = randomBytes(32);
  const targets: string[] = [];
  const decrypts: FakeKmsDecrypt[] = [];

  /** The context as authenticated data: its pairs sorted by key, so the order they arrive in does not matter. */
  const aadOf = (context: unknown): Buffer => {
    if (context === null || typeof context !== 'object') return Buffer.from('[]');
    const pairs = Object.entries(context as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Buffer.from(JSON.stringify(pairs), 'utf8');
  };

  const wrap = (dataKey: Buffer, context: Record<string, string>): Buffer => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', root, iv);
    cipher.setAAD(aadOf(context));
    const body = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  };

  const unwrap = (blob: Buffer, context: unknown): Buffer => {
    const decipher = createDecipheriv('aes-256-gcm', root, blob.subarray(0, 12));
    decipher.setAAD(aadOf(context));
    decipher.setAuthTag(blob.subarray(12, 28));
    return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
  };

  const answer = (res: ServerResponse, status: number, body: Record<string, unknown>, errorType?: string): void => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/x-amz-json-1.1',
      'content-length': String(Buffer.byteLength(text)),
      'x-amzn-requestid': randomUUID(),
      ...(errorType === undefined ? {} : { 'x-amzn-errortype': errorType }),
    });
    res.end(text);
  };
  const refuse = (res: ServerResponse, type: string): void => answer(res, 400, { __type: type, message: 'refused by the fake KMS' }, type);

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const target = String(req.headers['x-amz-target'] ?? '');
      targets.push(target);
      if (target !== 'TrentService.Decrypt') {
        refuse(res, 'UnsupportedOperationException');
        return;
      }
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        refuse(res, 'ValidationException');
        return;
      }
      decrypts.push({ keyId: input.KeyId, encryptionContext: input.EncryptionContext });
      if (input.KeyId !== undefined && input.KeyId !== keyArn) {
        refuse(res, 'IncorrectKeyException');
        return;
      }
      let plaintext: Buffer;
      try {
        plaintext = unwrap(Buffer.from(String(input.CiphertextBlob ?? ''), 'base64'), input.EncryptionContext);
      } catch {
        refuse(res, 'InvalidCiphertextException');
        return;
      }
      answer(res, 200, { KeyId: keyArn, Plaintext: plaintext.toString('base64'), EncryptionAlgorithm: 'SYMMETRIC_DEFAULT' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${port}`,
    targets,
    decrypts,
    generateDataKey: async ({ keyId, encryptionContext }) => {
      if (keyId !== keyArn) throw new Error('the fake KMS holds one key');
      const plaintext = randomBytes(32);
      return { plaintext, wrappedKey: wrap(plaintext, encryptionContext), keyId: keyArn };
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}
