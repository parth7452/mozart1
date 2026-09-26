# Fictional browser comparisons

These screenshots come from `pnpm render:web` and its fictional Harborline Foods fixture, not from the live app. The account address was replaced with “Preview analyst” in screenshots. `before` is `origin/main` at `708dfc1`; `after` is this branch. Each image shows the initial viewport at 1440 × 1000 or 390 × 844.

| View | Before | After |
| --- | --- | --- |
| Deductions, desktop | [Before](case-list-desktop-before.png) | [After](case-list-desktop-after.png) |
| Deductions, mobile | [Before](case-list-mobile-before.png) | [After](case-list-mobile-after.png) |
| Case review, desktop | [Before](case-review-desktop-before.png) | [After](case-review-desktop-after.png) |
| Case review, mobile | [Before](case-review-mobile-before.png) | [After](case-review-mobile-after.png) |

Chromium also checked 1024 × 768 and both sides of the 760px breakpoint (761px and 759px). The file-based preview cannot load the authenticated document URL, so the embedded preview appears as a browser plugin placeholder in screenshots; the view and full-document link were checked as markup, not as an authenticated session.
