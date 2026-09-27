import { describe, expect, it } from 'vitest';
import { serialiseSnapshot } from '../src/runner/snapshot';

const page = `<!doctype html><html><head><title>t</title><script>alert(1)</script><style>p{}</style></head>
<body onload="x()"><h1 class="a">Deductions for jane.doe@acme.test</h1>
<a href="javascript:evil()">Change password</a>
<form action="/dispute" method="post"><input type="file" name="f"><input name="u" value="jane.doe@acme.test"><button onclick="go()">Submit dispute</button></form>
<table data-x="1"><thead><tr><th colspan="2" onclick="y()">Claim</th></tr></thead>
<tbody><tr><td rowspan=2 style="color:red">DN-1</td><td>$1,200.00</td></tr></tbody></table>
<ul><li>one &amp; two</li></ul><!-- jane.doe@acme.test --><SCRIPT type="x">more()</SCRIPT></body></html>`;

describe('serialiseSnapshot', () => {
  const out = serialiseSnapshot(page, 'jane.doe@acme.test');
  it('drops everything outside the allowlist', () => {
    for (const bad of ['<script', '<SCRIPT', '<a', 'href', '<form', '<input', 'onclick', 'onload', 'javascript:', 'style=', 'data-x', 'alert(', 'more()']) {
      expect(out).not.toContain(bad);
    }
    expect(out).not.toMatch(/\son\w+=/i);
  });
  it('keeps text, structure and spans', () => {
    expect(out).toContain('<th colspan="2">Claim</th>');
    expect(out).toContain('<td rowspan="2">DN-1</td>');
    expect(out).toContain('$1,200.00');
    expect(out).toContain('<li>one &amp; two</li>');
    expect(out).toContain('Change password');
  });
  it('replaces the username everywhere', () => {
    expect(out).not.toContain('jane.doe');
    expect(out).toContain('Deductions for [portal-user]');
  });
});

describe('package index', () => {
  it('does not re-export the runner', async () => {
    const { readFile } = await import('node:fs/promises');
    const index = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(index).not.toMatch(/from '\.\/runner|playwright/);
  });
});
