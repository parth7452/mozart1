/**
 * Renders the text fixtures as simulated scans.
 *
 * Every measurement so far is on clean generated PDFs with a text layer, which
 * is the easiest input the product will ever see. A scan is the hard case: the
 * model has to read pixels, and quote verification has nothing to check against
 * because there is no text layer.
 *
 * These are *simulated* scans — rasterised, rotated, greyscaled, speckled and
 * JPEG-compressed. That is harder than clean text and strictly easier than a real
 * fax of a photocopy. The numbers they produce are a floor, not a substitute for
 * measuring on real customer documents.
 *
 *   pnpm render:scans
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';
import { everyDocument } from '@recouple/fixtures';

const documentByKey = (key: string) => {
  const found = everyDocument().find((d) => d.key === key);
  if (found === undefined) throw new Error(`no fixture ${key}`);
  return found;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'packages', 'fixtures', 'scans');

/** Which text fixtures get a scanned twin, and how badly each is degraded. */
const TARGETS = [
  { key: 'walmart-apdp-notice', rotate: -1.4, quality: 68, speckle: 0.1, blur: 0.4 },
  { key: 'carrier-bol', rotate: 2.1, quality: 55, speckle: 0.16, blur: 0.6 },
  { key: 'hl-case-01-notice', rotate: -2.3, quality: 60, speckle: 0.13, blur: 0.5 },
  { key: 'hl-case-06-notice', rotate: 1.7, quality: 50, speckle: 0.18, blur: 0.7 },
] as const;

function html(lines: readonly string[], opts: (typeof TARGETS)[number]): string {
  const body = lines
    .map((line) =>
      line.trim() === ''
        ? '<div class="blank"></div>'
        : `<div class="line">${line.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>`,
    )
    .join('\n');

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: #6b6b6b; }
  .sheet {
    width: 1000px; min-height: 1294px; box-sizing: border-box;
    padding: 76px 64px; background: #fdfdfb;
    font-family: "DejaVu Sans Mono", "Liberation Mono", monospace;
    font-size: 15px; line-height: 1.42; color: #13161a;
    transform: rotate(${opts.rotate}deg) scale(0.985);
    transform-origin: 50% 40%;
    position: relative; overflow: hidden;
  }
  .line { white-space: pre-wrap; word-break: break-word; }
  .blank { height: 21px; }
  /* Toner falloff towards the spine, the way a flatbed scan of a stapled page goes. */
  .sheet::before {
    content: ""; position: absolute; inset: 0; pointer-events: none;
    background:
      linear-gradient(97deg, rgba(0,0,0,0.20) 0%, rgba(0,0,0,0) 26%, rgba(0,0,0,0) 74%, rgba(0,0,0,0.10) 100%),
      radial-gradient(120% 60% at 50% -10%, rgba(0,0,0,0.13), rgba(0,0,0,0) 60%);
  }
  /* Dust, speckle and a scanner streak. */
  .sheet::after {
    content: ""; position: absolute; inset: -10%; pointer-events: none;
    opacity: ${opts.speckle};
    background-image:
      radial-gradient(circle at 12% 22%, #000 0.9px, transparent 1.1px),
      radial-gradient(circle at 63% 8%,  #000 0.7px, transparent 1px),
      radial-gradient(circle at 81% 57%, #000 1.1px, transparent 1.3px),
      radial-gradient(circle at 27% 78%, #000 0.8px, transparent 1px),
      linear-gradient(0deg, rgba(0,0,0,0.5) 0 1px, transparent 1px 240px);
    background-size: 37px 41px, 53px 47px, 61px 59px, 43px 67px, 100% 240px;
  }
  .stamp {
    position: absolute; right: 74px; top: 232px;
    border: 3px solid #5a1f22; color: #5a1f22; opacity: 0.62;
    padding: 6px 16px; font-size: 22px; letter-spacing: 2px; font-weight: 700;
    transform: rotate(-8deg); border-radius: 4px;
  }
  .wrap { filter: grayscale(1) contrast(0.88) brightness(1.06) blur(${opts.blur}px); }
</style></head>
<body><div class="wrap"><div class="sheet">
${body}
<div class="stamp">RECEIVED</div>
</div></div></body></html>`;
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1300 }, deviceScaleFactor: 1.4 });

  for (const target of TARGETS) {
    const fixture = documentByKey(target.key);
    const lines = fixture.pageText.join('\n').split('\n');
    await page.setContent(html(lines, target), { waitUntil: 'load' });
    const buffer = await page.screenshot({ type: 'jpeg', quality: target.quality, fullPage: true });
    const file = path.join(outDir, `${target.key}-scan.jpg`);
    writeFileSync(file, buffer);
    console.log(
      `${target.key}-scan.jpg  ${(buffer.byteLength / 1024).toFixed(0)} KB  ` +
        `rotate ${target.rotate}° quality ${target.quality}`,
    );
  }
} finally {
  await browser.close();
}
