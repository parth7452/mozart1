// The worker as `main.ts` starts it, with two differences: its cipher is an
// open-only `LocalTokenCipher` on a root key the test holds, in place of KMS,
// and its browser may reach the fixture portal on loopback, which a production
// worker refuses (destinations.ts). The tests seal credentials with a
// seal-only cipher on the same key, as the app seals with its seal-only KMS
// cipher. Nothing in `src/` imports this file, and the image never holds it
// (build.mjs bundles `src/main.ts` alone).
//
// Each call to `decrypt` appends one line, the connection it was asked for, to
// the file `PORTAL_READ_TEST_DECRYPT_LOG` names. A test can then prove a run
// refused before decrypt never called it, and that one which ran called it
// once. The line holds an id and nothing else.
//
// Two more variables let a test start a worker with `main.ts`'s own policy:
//  - `PORTAL_READ_TEST_DESTINATIONS=public` gives it public destinations only,
//    over https, as `main.ts` has, in place of loopback;
//  - `PORTAL_READ_TEST_HOSTS`, a JSON object of names and addresses, answers
//    the egress proxy's lookups for those names, and no other name resolves.
//    So a public-looking name can be made to resolve to the fixture's
//    loopback, as a public name whose DNS answer is private would.
import { appendFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { LocalTokenCipher } from '@recouple/crypto/testing';
import { PUBLIC_DESTINATIONS_ONLY, type Resolver } from '../src/portal';
import { startWorker } from '../src/start';

const rootKey = Buffer.from(process.env.PORTAL_READ_TEST_ROOT_KEY ?? '', 'hex');
const decryptLog = process.env.PORTAL_READ_TEST_DECRYPT_LOG ?? '';
if (rootKey.length !== 32 || decryptLog === '') {
  throw new Error('PORTAL_READ_TEST_ROOT_KEY (64 hex characters) and PORTAL_READ_TEST_DECRYPT_LOG must be set');
}
const destinations = process.env.PORTAL_READ_TEST_DESTINATIONS === 'public' ? PUBLIC_DESTINATIONS_ONLY : { allowLoopback: true };
const hosts = process.env.PORTAL_READ_TEST_HOSTS === undefined ? undefined : (JSON.parse(process.env.PORTAL_READ_TEST_HOSTS) as Record<string, string>);
const resolve: Resolver | undefined =
  hosts === undefined
    ? undefined
    : async (hostname) => {
        const address = Object.hasOwn(hosts, hostname) ? hosts[hostname] : undefined;
        if (address === undefined) throw new Error('this test worker resolves only the names it was given');
        return [{ address, family: isIP(address) }];
      };

await startWorker(
  (config) => {
    const inner = new LocalTokenCipher({ rootKey, keyId: config.keyId, mode: 'open_only' });
    return {
      name: inner.name,
      mode: inner.mode,
      encrypt: (plaintext, context) => inner.encrypt(plaintext, context),
      decrypt: (sealed, context) => {
        appendFileSync(decryptLog, `${context.purpose === 'portal_credential' ? context.connectionId : 'not-a-portal-context'}\n`);
        return inner.decrypt(sealed, context);
      },
    };
  },
  { destinations, resolve },
);
