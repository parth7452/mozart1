'use client';
import { useState, type FormEvent, type ReactNode } from 'react';
import type { BrowserUploadNotices } from '../lib/notices';
import { postUpload, sendInTurn, type FileResult } from '../lib/upload-batch';
import { UPLOAD_ACCEPT, UPLOAD_MAX_MB } from '../lib/upload-limits';

interface Row {
  readonly name: string;
  readonly result: FileResult;
}

/**
 * An upload form that takes many files and sends them one at a time.
 *
 * It is a real form posting to `/upload`, so with JavaScript off it still
 * sends a file and the route answers with its redirect — and refuses, by name,
 * a post carrying several (`upload_several_files`), rather than reading the
 * first and dropping the rest. With JavaScript on, the submit is taken over:
 * each file is its own request, in turn (`sendInTurn`), and its result is shown
 * beside its name in the route's own words.
 *
 * `children` is the form's label; the two forms that use this word it
 * differently.
 */
export function MultiUpload({
  formId,
  className,
  inputId,
  attachToCase,
  buttonLabel,
  notices,
  children,
}: {
  formId?: string;
  className?: string;
  inputId?: string;
  /** The case every file is evidence for, on the case page. */
  attachToCase?: string;
  buttonLabel: string;
  notices: BrowserUploadNotices;
  children?: ReactNode;
}) {
  const [rows, setRows] = useState<readonly Row[]>([]);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const input = form.elements.namedItem('file');
    const files = input instanceof HTMLInputElement && input.files !== null ? [...input.files] : [];
    if (files.length === 0) return;

    setBusy(true);
    setRows(files.map((file) => ({ name: file.name, result: { status: 'waiting' } })));
    const report = (index: number, result: FileResult): void =>
      setRows((current) =>
        current.map((row, at) => (at === index ? { name: row.name, result } : row)),
      );
    try {
      await sendInTurn(files, attachToCase, notices, postUpload, report);
    } finally {
      setBusy(false);
      form.reset();
    }
  }

  const done = rows.filter((row) => row.result.status !== 'waiting' && row.result.status !== 'sending');
  return (
    <form
      id={formId}
      className={className}
      action="/upload"
      method="post"
      encType="multipart/form-data"
      onSubmit={(event) => void onSubmit(event)}
    >
      {children}
      <div>
        {/* The case this belongs to travels with each file rather than being
            inferred later: a document with no case is the thing that sits
            unread forever. */}
        {attachToCase === undefined ? null : (
          <input type="hidden" name="attachToCase" value={attachToCase} />
        )}
        <input
          id={inputId}
          type="file"
          name="file"
          accept={UPLOAD_ACCEPT}
          multiple
          required
          disabled={busy}
          aria-describedby={inputId === undefined ? undefined : `${inputId}-limit`}
        />
        <button className="primary" type="submit" disabled={busy} aria-busy={busy}>
          {busy ? `Sending ${Math.min(done.length + 1, rows.length)} of ${rows.length}…` : buttonLabel}
        </button>
      </div>
      <p className="upload-limit" id={inputId === undefined ? undefined : `${inputId}-limit`}>
        PDF, PNG, JPEG, GIF or WebP, up to {UPLOAD_MAX_MB} MB each. Choose as many as you like;
        they are sent one at a time.
      </p>
      {rows.length === 0 ? null : (
        <ol className="upload-results" aria-live="polite">
          {rows.map((row, index) => (
            <li key={index} className={resultClass(row.result)}>
              <strong>{row.name}</strong> <span>{resultText(row.result)}</span>
              {row.result.status === 'answered' && row.result.caseId !== undefined ? (
                <>
                  {' '}
                  <a href={`/cases/${row.result.caseId}`}>Open the case</a>
                </>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {/* The lists on the page — new cases, held documents, this case's
          evidence — are rendered on the server, so they show the batch once
          the page is loaded again. Not done by itself: reloading would clear
          the results above before anybody had read them. */}
      {rows.length > 0 && !busy ? (
        <p className="upload-limit">
          <a href="">Reload the page</a> to see these in the lists.
        </p>
      ) : null}
    </form>
  );
}

function resultText(result: FileResult): string {
  switch (result.status) {
    case 'waiting':
      return 'waiting';
    case 'sending':
      return 'sending and reading…';
    default:
      return result.text;
  }
}

function resultClass(result: FileResult): string {
  if (result.status === 'waiting' || result.status === 'sending') return 'pending';
  return result.tone === 'good' ? 'sent' : 'bad';
}
