import type { UnreadDocument } from '@recouple/pipeline';

/**
 * The documents that were stored and scanned and never read, and a way to ask
 * again.
 *
 * This section exists because of a failure with no error in it: an upload was
 * stored, scanned clean and handed to the queue, the read function was invoked
 * once and never came back to run its step, and nothing logged anything. The
 * document was fine. The reviewer was told it was being read, and it never was.
 * Nothing in the product said otherwise, so there was no way to know a case was
 * missing — which is worse than a visible failure, because a visible failure is
 * something somebody does about it.
 *
 * A pure function of what the store returned, like every other view here. The
 * filename is the one piece of text on this page that somebody outside chose,
 * and it is rendered as text: React escapes it, and nothing here builds markup
 * out of it or puts it in a URL.
 */
export function UnreadDocuments({ documents }: { documents: readonly UnreadDocument[] }) {
  if (documents.length === 0) return null;

  return (
    <div className="card unread">
      <h2 className="section" style={{ marginTop: 0 }}>
        Documents waiting to be read
      </h2>
      <p className="empty">
        These were stored and scanned clean, and nothing has read them yet. That is usually the
        queue: the bytes are safe and nothing was lost, and reading one again costs one read.
      </p>
      <table className="cases">
        <thead>
          <tr>
            <th>Document</th>
            <th>Waiting</th>
            <th>On a case</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {documents.map((document) => (
            <tr key={document.documentId}>
              <td>{document.filename === '' ? '—' : document.filename}</td>
              <td>{waiting(document.ageMinutes)}</td>
              <td>{document.onCase ? 'yes' : 'no'}</td>
              <td>
                {/*
                  A POST, not a link: this asks for a document to be read, which
                  spends money, and a thing that spends money is not something a
                  crawler or a prefetch may do by visiting a URL.
                */}
                <form action={`/documents/${document.documentId}/reread`} method="post">
                  <button type="submit">Read again</button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** How long it has been waiting, in the largest unit that is still honest. */
export function waiting(ageMinutes: number): string {
  if (ageMinutes < 60) return `${ageMinutes}m`;
  const hours = Math.floor(ageMinutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
