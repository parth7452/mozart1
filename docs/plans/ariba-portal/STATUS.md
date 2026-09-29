# SAP Business Network: where it stands (paused 2026-09-29)

Paused by the founder on 2026-09-29, before any run, because the sign-in the
walk-through found needs four runner changes (below) and none of it is needed
for the MVP. Pick up from here. Step numbers are `README.md`'s.

## Done

| Step | State |
| --- | --- |
| 1. Terms | Recorded in ADR 0062 §2 (allowed with conditions) and deployed: `PORTAL_TERMS_ALLOWED` holds `0062` (PR #133) |
| 2. Account | Standard account created. A service user was added with the ready-made role **Services Limited Access - Assignment** |
| 3. Authenticator | Found and enabled on the account (an authenticator-app option exists; SMS/email-only was a false alarm) |
| 4. KMS key | Created in `us-east-1`, account `611932493200`: `arn:aws:kms:us-east-1:611932493200:key/a508d47b-c923-4536-bc2b-7d1f77e12421`. Whether the key policy (README step 4) was saved is **not confirmed** |
| 5. Fly worker | App `recouple-portal-read` created, in the founder's **personal** Fly organization ("Parth"); not yet checked to be the scanner's billed org. **Not deployed.** Secrets are half-set and wrong (see below) |
| 6. Vercel variables | Not set |
| 7. Walk-through | Done on 2026-09-29; findings below |

## Before anything else on pickup

- **Rotate what was exposed on 2026-09-29.** A terminal screenshot shared in a
  Claude session showed the worker's AWS secret access key, a generated worker
  token, and a password-like string typed where the token belonged. Delete the
  `recouple-portal-worker` access key in IAM and make a new one; generate a new
  token with `openssl rand -hex 32`; change that password anywhere it is used;
  clear `~/.zsh_history`.
- **Fix the worker's Fly secrets.** `PORTAL_KMS_KEY_ID` was set to the account
  number instead of the key's ARN, and `AWS_ACCESS_KEY_ID` was never set on Fly.
  Redo README step 5 one line at a time, after `git pull`.
- Confirm the app sits in the org with billing on (`fly apps list`), or recreate
  it there.

## Walk-through findings (2026-09-29, founder, Chrome)

- **Start URL:** `https://service.ariba.com/Authenticator.aw/ad/`
- **Address bar showed:** `service.ariba.com`
- **Username and password:** on **two separate pages**.
- **Code:** six separate boxes.
- **ANID:** not found on the landing page without clicking; no selector.
- **Banners:** only update banners.
- **Sign-out:** inside the profile circle menu, top right.
- **Buttons that would change something:** none noted.

Hosts that matter (the rest are analytics and consent trackers the guard
refuses, which is harmless):
- `service.ariba.com`: Ariba's authenticator and profile pages.
- `lwbnlive.accounts.ondemand.com`: SAP Cloud Identity, where the sign-in
  happens; it posts back to Ariba by SAML.
- `portal.us.bn.cloud.ariba.com`: the landing page after sign-in.

Trackers seen: `smetrics.sap.com`, `sapglobalmarketingin.tt.omtrdc.net`,
`dpm.demdex.net`, `assets.adobedtm.com`, `*.split.io`,
`siteintercept.qualtrics.com`, `consent.trustarc.com`,
`static.cloudflareinsights.com`, `aribacsp.report-uri.com`,
`webassistant.enable-now.cloud.sap`. Also `content.cdn.sap.com`,
`ui5.sap.com`, `help.sap.com`, `www.sap.com`, `people.wdf.sap.corp`.

POSTs, in the order recorded (cut at `?`, `#`, `;`; when each came was not
noted):
1. `https://lwbnlive.accounts.ondemand.com/saml2/idp/acs/lwbnlive.accounts.ondemand.com`
2. `https://service.ariba.com/Authenticator.aw/ad/ssoIDP`
3. `https://portal.us.bn.cloud.ariba.com/tpx/ingress/logout`
4. `https://service.ariba.com/Authenticator.aw/ad/login/SSOActions`
5. `https://service.ariba.com/Authenticator.aw/ad/switchUser`
6. `https://service.ariba.com/scripts/WebObjects.dll/ProfileManagement.woa/<n>`
7. `https://service.ariba.com/ProfileManagement.aw/<n>/ad/loginPage/SSOActions`
8. `https://service.ariba.com/Authenticator.aw/<n>/aw`
9. `https://service.ariba.com/ProfileManagement.aw/<n>/aw`
10. `https://portal.us.bn.cloud.ariba.com/cdn-cgi/rum`
11. `https://portal.us.bn.cloud.ariba.com/tpx/ingress/tps/messaging-client/odata/v4/MessagingService/getConversationLastUnreadCount`
12. `https://service.ariba.com/Authenticator.aw/ad/logoutAck/SSOActions`

(and tracker beacons). `<n>` is a numeric session path segment.

## What the runner needs before a dry run can pass

1. **Two-page sign-in.** `sign_in` requires one form holding exactly one
   username box and one password box (`sign_in_form_refused` otherwise). Ariba
   asks for the username, then the password on the next page.
2. **Six-box code entry.** `answer_mfa` types into one box.
3. **Where the ANID is.** `expect_anid` needs a selector on a page reached
   without a click that writes. Likely under the profile circle (Company
   Settings / My Account); if only inside a menu, the runner needs a read-only
   menu open before `expect`.
4. **Sign-out by POST from a menu.** `portal.us.bn.cloud.ariba.com/tpx/ingress/logout`
   must be listed in `postAsRead`, and the menu opened by a `dismiss`-like
   read-only click.

Also still open:
- Which POST came at the username page, the password page and the code page.
  The password and code must post to the same host (`signIn.origin`), expected
  to be `lwbnlive.accounts.ondemand.com`.
- Whether the automatic POSTs after the code (SAML to `service.ariba.com`) go
  in `signIn.acsPaths`: today acsPaths are on the sign-in origin only, and the
  SAML post-back is to another host.
- The service user's white page: with Services Limited Access the landing page
  showed nothing. Try the admin, or a role that shows the dashboard; if only the
  admin works, record that exception in ADR 0062 §1 before a credential is
  sealed.
- Every ready-made role hides financial data. A real read (not this plumbing
  test) needs a view-only role for invoices, remittances and payments, if the
  account type lets the administrator build one.
