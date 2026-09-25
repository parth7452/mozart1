import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MultiUpload } from '../components/multi-upload';
import { browserUploadNotices, NOTICES } from '../lib/notices';
import { answerOf, sendInTurn, sendOne, type FileResult, type Post } from '../lib/upload-batch';
import {
  FORM_OVERHEAD_BYTES,
  PLATFORM_BODY_LIMIT_BYTES,
  UPLOAD_ACCEPT,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_MB,
} from '../lib/upload-limits';

const notices = browserUploadNotices();
const CASE_ID = '33333333-3333-3333-3333-333333333333';

function file(name: string, size = 16): File {
  return new File([new Uint8Array(size) as BlobPart], name, { type: 'application/pdf' });
}

function answer(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const onCase = {
  notice: 'upload_on_case',
  about: [],
  tone: 'good',
  text: NOTICES.upload_on_case.text,
  caseId: CASE_ID,
};

describe('the upload limit (pilot E2)', () => {
  it('fits the platform: the largest file plus its framing is a body Vercel delivers', () => {
    // Vercel answers a body over 4.5 MB with its own 413 before this app runs
    // (ADR 0047, context item 8). A limit that does not fit is a promise the
    // person meets as Vercel's error page.
    expect(UPLOAD_MAX_BYTES + FORM_OVERHEAD_BYTES).toBeLessThanOrEqual(PLATFORM_BODY_LIMIT_BYTES);
    expect(UPLOAD_MAX_BYTES).toBe(UPLOAD_MAX_MB * 1024 * 1024);
  });

  it('is the number the sentence names, and the sentence says what to do instead', () => {
    expect(notices.tooLarge.text).toContain(`${UPLOAD_MAX_MB} MB`);
    expect(notices.tooLarge.text).toMatch(/Split the PDF/);
    expect(notices.tooLarge.text).toMatch(/lower resolution/);
    expect(notices.tooLarge.text).toMatch(/send it to us/);
  });
});

describe('sending one file', () => {
  it('refuses a file over the limit in the browser, and sends nothing', async () => {
    let posts = 0;
    const post: Post = async () => {
      posts += 1;
      return answer(onCase);
    };
    const result = await sendOne(file('big.pdf', UPLOAD_MAX_BYTES + 1), undefined, notices, post);
    expect(posts).toBe(0);
    expect(result).toEqual({ status: 'answered', tone: 'bad', text: notices.tooLarge.text });
  });

  it('sends a file exactly at the limit', async () => {
    let posts = 0;
    const post: Post = async () => {
      posts += 1;
      return answer(onCase);
    };
    await sendOne(file('edge.pdf', UPLOAD_MAX_BYTES), undefined, notices, post);
    expect(posts).toBe(1);
  });

  it('sends the file under `file` and the case under `attachToCase`, one file per request', async () => {
    const bodies: FormData[] = [];
    const post: Post = async (body) => {
      bodies.push(body);
      return answer(onCase);
    };
    const result = await sendOne(file('pod.pdf'), CASE_ID, notices, post);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.getAll('file')).toHaveLength(1);
    expect((bodies[0]?.get('file') as File).name).toBe('pod.pdf');
    expect(bodies[0]?.get('attachToCase')).toBe(CASE_ID);
    expect(result).toEqual({
      status: 'answered',
      tone: 'good',
      text: NOTICES.upload_on_case.text,
      caseId: CASE_ID,
    });
  });

  it('says the platform’s 413 in our words', async () => {
    const result = await sendOne(file('a.pdf'), undefined, notices, async () =>
      new Response('Request Entity Too Large', { status: 413 }),
    );
    expect(result).toEqual({ status: 'answered', tone: 'bad', text: notices.tooLarge.text });
  });

  it('never shows a response it did not get from the route as an answer', async () => {
    const unanswered = { status: 'unanswered', tone: 'bad', text: notices.unanswered.text };
    const cases: (() => Promise<Response>)[] = [
      async () => {
        throw new TypeError('network');
      },
      async () => new Response('<html>sign in</html>', { headers: { 'content-type': 'text/html' } }),
      async () => answer(onCase, 500),
      async () => new Response('{"notice":', { headers: { 'content-type': 'application/json' } }),
      async () => answer({ ...onCase, tone: 'shouting' }),
      async () => answer({ ...onCase, text: '' }),
      async () => answer({ ...onCase, caseId: '../../settings' }),
      async () => answer({ ...onCase, about: [1] }),
    ];
    for (const post of cases) {
      expect(await sendOne(file('a.pdf'), undefined, notices, post)).toEqual(unanswered);
    }
  });

  it('reads a well-formed answer with no case id', async () => {
    const parsed = await answerOf(
      answer({ notice: 'upload_held', about: [], tone: 'bad', text: NOTICES.upload_held.text }),
    );
    expect(parsed).toEqual({
      notice: 'upload_held',
      about: [],
      tone: 'bad',
      text: NOTICES.upload_held.text,
    });
  });
});

describe('sending several files (pilot E3)', () => {
  it('sends them one at a time, in the order chosen, each after the last was answered', async () => {
    const events: string[] = [];
    let inFlight = 0;
    const post: Post = async (body) => {
      const name = (body.get('file') as File).name;
      inFlight += 1;
      expect(inFlight).toBe(1);
      events.push(`start ${name}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
      events.push(`end ${name}`);
      inFlight -= 1;
      return answer(onCase);
    };
    const files = Array.from({ length: 20 }, (_, i) => file(`doc-${i}.pdf`));
    const answered = await sendInTurn(files, undefined, notices, post, () => {});
    expect(answered).toBe(20);
    expect(events).toEqual(files.flatMap((f) => [`start ${f.name}`, `end ${f.name}`]));
  });

  it('reports each file as it is sent and answered, and goes on past a refusal', async () => {
    const seen: [number, FileResult['status']][] = [];
    const post: Post = async (body) =>
      (body.get('file') as File).name === 'bad.pdf'
        ? answer({
            notice: 'upload_rejected_type_not_allowed',
            about: [],
            tone: 'bad',
            text: NOTICES.upload_rejected_type_not_allowed.text,
          })
        : answer(onCase);
    const answered = await sendInTurn(
      [file('a.pdf'), file('big.pdf', UPLOAD_MAX_BYTES + 1), file('bad.pdf'), file('b.pdf')],
      undefined,
      notices,
      post,
      (index, result) => seen.push([index, result.status]),
    );
    expect(answered).toBe(4);
    expect(seen).toEqual([
      [0, 'sending'],
      [0, 'answered'],
      [1, 'sending'],
      [1, 'answered'],
      [2, 'sending'],
      [2, 'answered'],
      [3, 'sending'],
      [3, 'answered'],
    ]);
  });

  it('stops at a file that got no answer and marks the rest not sent', async () => {
    const sent: string[] = [];
    const post: Post = async (body) => {
      const name = (body.get('file') as File).name;
      sent.push(name);
      return name === 'b.pdf'
        ? new Response('', { status: 502 })
        : answer(onCase);
    };
    const results = new Map<number, FileResult>();
    const answered = await sendInTurn(
      [file('a.pdf'), file('b.pdf'), file('c.pdf'), file('d.pdf')],
      undefined,
      notices,
      post,
      (index, result) => results.set(index, result),
    );
    expect(sent).toEqual(['a.pdf', 'b.pdf']);
    expect(answered).toBe(1);
    expect(results.get(1)?.status).toBe('unanswered');
    expect(results.get(2)).toEqual({ status: 'not_sent', tone: 'bad', text: notices.notSent.text });
    expect(results.get(3)?.status).toBe('not_sent');
  });
});

describe('the upload form', () => {
  it('is a real form to /upload that takes many files of the types the door accepts', () => {
    const html = renderToStaticMarkup(
      <MultiUpload formId="add-document" inputId="file" buttonLabel="Read them" notices={notices}>
        <label htmlFor="file">Add documents</label>
      </MultiUpload>,
    );
    expect(html).toContain('action="/upload"');
    expect(html).toContain('method="post"');
    // HTML attribute names are case-insensitive; React writes this one as spelt.
    expect(html.toLowerCase()).toContain('enctype="multipart/form-data"');
    const picker = /<input[^>]*type="file"[^>]*>/.exec(html)?.[0] ?? '';
    expect(picker).toContain('name="file"');
    expect(picker).toContain('multiple=""');
    expect(html).toContain(`accept="${UPLOAD_ACCEPT}"`);
    expect(html).toContain(`up to ${UPLOAD_MAX_MB} MB each`);
    expect(html).not.toContain('attachToCase');
    // TIFF is not a type the door accepts, so the picker does not offer it.
    expect(UPLOAD_ACCEPT).not.toMatch(/tif/);
  });

  it('carries the case it attaches evidence to', () => {
    const html = renderToStaticMarkup(
      <MultiUpload attachToCase={CASE_ID} buttonLabel="Attach to this case" notices={notices} />,
    );
    expect(html).toContain(`name="attachToCase" value="${CASE_ID}"`);
    expect(html).toContain('Attach to this case');
  });
});
