import { PrintButton } from './print-button';

export interface DisputeLetterProps {
  readonly deductionId: string;
  /** `packets.narrative`, exactly as stored — the bytes the hash covers. */
  readonly narrative: string;
  readonly contentHash: string;
  /** Whether a second person has approved this packet. */
  readonly approved: boolean;
}

/**
 * The packet's letter, laid out to print.
 *
 * It prints the stored narrative and nothing composed here, so what comes out
 * of the printer (or "Save as PDF") is the text the approval's hash covers —
 * a view re-derived from the case would be a letter nobody approved. The page
 * adds only what is outside the letter: a toolbar the print stylesheet hides,
 * the packet's short hash in the footer so a printed copy can be traced back to
 * its row, and, until it is approved, a draft mark that prints too.
 *
 * The narrative is rendered as text, never as markup: it carries values read
 * off somebody else's document.
 *
 * A pure function of what the store returned — the page reads, this renders.
 */
export function DisputeLetter({ deductionId, narrative, contentHash, approved }: DisputeLetterProps) {
  return (
    <>
      <style>{LETTER_CSS}</style>
      <nav className="letter-toolbar">
        <a href={`/cases/${deductionId}`}>← Back to the case</a>
        <PrintButton />
        <a href={`/cases/${deductionId}/packet/enclosures`}>All enclosures (.zip)</a>
      </nav>
      <article className="letter">
        {approved ? null : (
          <p className="letter-draft">Draft — awaiting approval. Not for sending.</p>
        )}
        <div className="letter-body">{narrative}</div>
        <p className="letter-ref">Packet {contentHash.slice(0, 12)}</p>
      </article>
    </>
  );
}

const LETTER_CSS = `
body { background: var(--bg); }
.letter-toolbar {
  display: flex; gap: 16px; align-items: center; flex-wrap: wrap;
  max-width: 7.5in; margin: 24px auto 0; padding: 0 16px;
}
.letter {
  background: #fff; color: #111; max-width: 7.5in; margin: 16px auto 48px;
  padding: 0.9in 0.9in 0.6in; box-shadow: 0 1px 3px rgba(0,0,0,0.12);
  font: 11pt/1.5 Georgia, 'Times New Roman', serif;
}
.letter-body { white-space: pre-wrap; overflow-wrap: anywhere; }
.letter-draft {
  margin: 0 0 18pt; padding: 6pt 10pt; border: 1.5pt solid #b3261e; color: #b3261e;
  font: 600 10pt/1.3 system-ui, sans-serif; text-transform: uppercase; letter-spacing: 0.04em;
}
.letter-ref { margin: 24pt 0 0; color: #666; font: 8pt/1.3 var(--mono); }
@media (max-width: 640px) {
  .letter { padding: 24px 16px; margin: 12px 0 24px; box-shadow: none; }
}
@page { size: letter; margin: 0.75in; }
@media print {
  body { background: #fff; }
  .letter-toolbar { display: none; }
  .letter { max-width: none; margin: 0; padding: 0; box-shadow: none; }
}
`;
