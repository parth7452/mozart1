# Fictional browser comparisons

These screenshots come from `pnpm render:web` and its fictional Harborline Foods fixture, not from the live app. The account address was replaced with “Preview analyst” in screenshots. `before` is `origin/main` at `708dfc1`; `after` is this branch. Each image shows the initial viewport at 1440 × 1000 or 390 × 844.

| View | Before | After |
| --- | --- | --- |
| Deductions, desktop | [Before](case-list-desktop-before.png) | [After](case-list-desktop-after.png) |
| Deductions, mobile | [Before](case-list-mobile-before.png) | [After](case-list-mobile-after.png) |
| Case review, desktop | [Before](case-review-desktop-before.png) | [After](case-review-desktop-after.png) |
| Case review, mobile | [Before](case-review-mobile-before.png) | [After](case-review-mobile-after.png) |

Chromium also checked 1024 × 768 and both sides of the 760px breakpoint (761px and 759px). The file-based preview cannot load the authenticated document URL, so the embedded preview appears as a browser plugin placeholder in screenshots; the view and full-document link were checked as markup, not as an authenticated session.

## 2026-10-04: the overnight screens

[`2026-10-04/`](2026-10-04/) holds the retailer board, the documents list with its suggestions, a case page's suggestion block and Books, at 1440 × 900 and 390 × 844, before and after the visual pass. Fictional data in a scratch database, written through the pipeline and the store. [`../04-overnight-screens.md`](../04-overnight-screens.md) lists each defect with its screenshots and how the pages were rendered.
