'use client';
import { useState, type FormEvent, type ReactNode } from 'react';
import type { BrowserUploadNotices } from '../lib/notices';
import type { NewCaseJsonAnswer } from '../lib/manual-case';
import { postUpload, sendInTurn, type FileResult } from '../lib/upload-batch';

/** The file input the dialog renders, outside this form's own fields. */
export const NEW_CASE_FILES_INPUT = 'nc-files';
/** The empty form that file input belongs to, so a no-script submit never sends it. */
export const NEW_CASE_FILES_HOLDER = 'nc-files-holder';

/**
 * What a submit does: with no file chosen the form posts as it would with no
 * script at all; with files the script opens the case first and then files
 * each one on it through `/upload`.
 */
export function planSubmit(fileCount: number): 'native' | 'open_then_attach' {
  return fileCount > 0 ? 'open_then_attach' : 'native';
}

/** The route's JSON answer, if the body is one; anything else is not. */
export function newCaseAnswerOf(body: unknown): NewCaseJsonAnswer | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { ok, deductionId, caseUrl, redirect } = body as Record<string, unknown>;
  const local = (value: unknown): value is string =>
    typeof value === 'string' && value.startsWith('/') && !value.startsWith('//');
  if (ok === true && typeof deductionId === 'string' && local(caseUrl)) return { ok, deductionId, caseUrl };
  if (ok === false && local(redirect)) return { ok, redirect };
  return undefined;
}

interface Row {
  readonly name: string;
  readonly result: FileResult;
}

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'opening' }
  | { readonly kind: 'attaching' }
  | { readonly kind: 'failed_open' }
  | { readonly kind: 'attached_with_errors'; readonly caseUrl: string };

const NOT_OPENED = 'The case was not opened — nothing was saved. Try again.';

/**
 * The "Open a case" form, with its chosen documents filed on the new case.
 *
 * The file input lives in an empty holder form, so without a script the main
 * form posts url-encoded fields exactly as before and the person attaches
 * documents on the case page. With one, and only when files were chosen, the
 * submit is taken over: the case is opened by the same route (as JSON), then
 * each file goes through `/upload` with `attachToCase`, in turn, and the
 * person is taken to the case. A refusal of the case goes where the route's
 * redirect would have gone, and no file is sent.
 */
export function NewCaseSubmit({
  notices,
  buttonLabel = 'Open case',
  children,
}: {
  notices: BrowserUploadNotices;
  buttonLabel?: string;
  children?: ReactNode;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [rows, setRows] = useState<readonly Row[]>([]);
  const busy = phase.kind === 'opening' || phase.kind === 'attaching';

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    const input = document.getElementById(NEW_CASE_FILES_INPUT);
    const files = input instanceof HTMLInputElement && input.files !== null ? [...input.files] : [];
    if (planSubmit(files.length) === 'native') return;
    event.preventDefault();
    if (busy) return;

    const form = event.currentTarget;
    const body = new URLSearchParams();
    for (const [name, value] of new FormData(form)) {
      if (typeof value === 'string') body.append(name, value);
    }

    setPhase({ kind: 'opening' });
    setRows([]);
    let answer: NewCaseJsonAnswer | undefined;
    try {
      const response = await fetch('/cases/new/open', {
        method: 'POST',
        body,
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        redirect: 'manual',
      });
      answer = response.ok ? newCaseAnswerOf(await response.json()) : undefined;
    } catch {
      answer = undefined;
    }
    if (answer === undefined) {
      setPhase({ kind: 'failed_open' });
      return;
    }
    if (!answer.ok) {
      window.location.assign(answer.redirect);
      return;
    }

    const { deductionId, caseUrl } = answer;
    setPhase({ kind: 'attaching' });
    setRows(files.map((file) => ({ name: file.name, result: { status: 'waiting' } })));
    let failed = false;
    const report = (index: number, result: FileResult): void => {
      if (result.status !== 'waiting' && result.status !== 'sending' && result.tone !== 'good') failed = true;
      setRows((current) => current.map((row, at) => (at === index ? { name: row.name, result } : row)));
    };
    try {
      await sendInTurn(files, deductionId, notices, postUpload, report);
    } catch {
      failed = true;
    }
    if (failed) setPhase({ kind: 'attached_with_errors', caseUrl });
    else window.location.assign(caseUrl);
  }

  const done = rows.filter((row) => row.result.status !== 'waiting' && row.result.status !== 'sending');
  const label =
    phase.kind === 'opening'
      ? 'Opening case…'
      : phase.kind === 'attaching'
        ? `Attaching ${Math.min(done.length + 1, rows.length)} of ${rows.length}…`
        : buttonLabel;

  return (
    <form
      method="post"
      action="/cases/new/open"
      className="modal-form"
      onSubmit={(event) => void onSubmit(event)}
    >
      {children}
      {phase.kind === 'failed_open' ? (
        <p className="notice bad" role="alert">
          {NOT_OPENED}
        </p>
      ) : null}
      {rows.length === 0 ? null : (
        <ol className="upload-results new-case-results" aria-live="polite">
          {rows.map((row, index) => (
            <li key={index} className={resultClass(row.result)}>
              <strong>{row.name}</strong> <span>{resultText(row.result)}</span>
            </li>
          ))}
        </ol>
      )}
      {phase.kind === 'attached_with_errors' ? (
        <p className="notice bad">
          The case is open, but not every document was filed on it. <a href={phase.caseUrl}>Go to the case</a>
        </p>
      ) : null}
      <div className="modal-footer">
        <a href="#" className="modal-cancel">
          Cancel
        </a>
        {phase.kind === 'attached_with_errors' ? null : (
          <button className="primary" type="submit" disabled={busy} aria-busy={busy}>
            {label}
          </button>
        )}
      </div>
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
