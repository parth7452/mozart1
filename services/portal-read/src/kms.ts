// The worker's cipher (ADR 0057 §7): KMS, open-only, under the portal key named
// by its ARN in `PORTAL_KMS_KEY_ID`. It can call `kms:Decrypt` and nothing
// else, and it names its own key to it, so KMS refuses a wrapped key made
// under any other. AWS credentials come from the SDK's own provider chain;
// nothing here reads them. `main.ts` starts the worker with it, and so does
// the test entry that runs the same worker against a fake KMS.
import { KmsTokenCipher } from '@recouple/crypto';
import type { WorkerConfig } from './config';
import type { WorkerCipher } from './start';

export function kmsCipher(config: WorkerConfig): WorkerCipher {
  return KmsTokenCipher.forKey(config.keyId, { region: config.keyRegion, mode: 'open_only' });
}

