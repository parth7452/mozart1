/**
 * `@recouple/crypto` — sealing a credential before it is stored (ADR 0033).
 *
 * One port, `TokenCipher`, and one production implementation,
 * `KmsTokenCipher`. `@recouple/crypto/testing` — where `LocalTokenCipher`
 * lives — is **not** exported from here, so a production path cannot reach it:
 * the rule `@recouple/pipeline/testing`, `NullScanner` and
 * `InMemoryQboTokenStore` already follow, and the one it matters most for,
 * because the fixture in question would be holding a customer's QuickBooks
 * credentials.
 *
 * `packages/crypto/test/cipher.test.ts` asserts that absence rather than
 * trusting it.
 */

export * from './cipher';
export * from './kms';
