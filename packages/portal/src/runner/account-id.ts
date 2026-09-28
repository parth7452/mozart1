// The account check (ADR 0057 §13). An owner types a connection's account id
// and nothing checks it before it is written, so every run checks it against
// what the portal prints, folded as migration 0038 folds it for
// `portal_connections_one_enabled_per_account`. Pure: Playwright never reaches
// this file.

/** An account id folded as the index folds it: its ASCII letters and digits, lower-cased. */
export function foldAccountId(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

/**
 * Whether `text` prints the account id as whole words, folded: the id's
 * letters and digits are those of a run of adjacent words, from the first
 * word's start to the last one's end. So `ANID: AN 0100000001` shows
 * `AN0100000001` and `an-0100000001`, and `ANID: AN0100000001-T` shows
 * `AN0100000001-T` and not `AN0100000001`, which is another account.
 */
export function showsAccountId(text: string, accountId: string): boolean {
  const want = foldAccountId(accountId);
  if (want === '') return false;
  // A word of punctuation alone folds to nothing, and adds nothing to a run.
  const words = text.split(/\s+/).map(foldAccountId).filter((w) => w !== '');
  for (let i = 0; i < words.length; i++) {
    let run = '';
    for (let j = i; j < words.length; j++) {
      run += words[j];
      if (run === want) return true;
      if (!want.startsWith(run)) break;
    }
  }
  return false;
}
