// The worker exactly as `main.ts` starts it, KMS cipher and all, with one
// difference: its browser may reach the fixture portal on loopback, which a
// production worker refuses (destinations.ts), so that a whole run through KMS
// can be made against a portal on this machine. main.test.ts runs `main.ts`
// itself for everything else, the loopback refusal included. Nothing in `src/`
// imports this file, and the image never holds it.
import { kmsCipher } from '../src/kms';
import { startWorker } from '../src/start';

await startWorker(kmsCipher, { destinations: { allowLoopback: true } });
