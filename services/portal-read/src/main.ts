// The worker's entry point (ADR 0057 §6): `node --import tsx src/main.ts`, or
// the bundle build.mjs makes of it. Its cipher is KMS, open-only (kms.ts), and
// its browser may go to public destinations only.
import { kmsCipher } from './kms';
import { startWorker } from './start';

await startWorker(kmsCipher);
