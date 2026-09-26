# Supabase Auth email templates

*2026-09-26. The emails Supabase Auth sends for this app, as they should be
set in the dashboard. They live in the dashboard, not in code: nothing reads
these files except `scripts/test/email-templates.test.ts`, which checks each
still has its one link and loads nothing remote.*

**Why they exist.** On 2026-09-26 both dashboard invitations sent during the
VERIFY-CHECKLIST §2 run went to Gmail's **spam** folder, while every sign-in
email from the same sender reached the inbox. Authentication was not the
cause: the spam-foldered message's headers read DKIM `pass` (`mozart.financial`,
selector `resend`), SPF `pass` and DMARC `pass`. The difference was the
content. The sign-in email had been given the branded template below; the
invitation was still Supabase's default ("You've been invited… Accept
invitation", unstyled, a bare link). Since ADR 0051, an invitee's first email
is the **Confirm signup** template, which was also still the default.

## Where each one goes

Supabase dashboard → project `hvheqbgkvwhlqutklwfh` (production) →
**Authentication → Emails → Templates**. For each row below, open the
template, set the **Subject**, replace the whole **Body** with the file's
contents, and press **Save**. Then do the same on `mozart-preview`.

| Template in the dashboard | Subject | Body | When it is sent |
| --- | --- | --- | --- |
| **Confirm signup** | `Welcome to Mozart: your first sign-in link` | [`confirm-signup.html`](confirm-signup.html) | An invited person's first **Email me a sign-in link** (ADR 0051 §6). Its link confirms the address and signs them in through `/auth/callback` |
| **Magic link** | `Your sign-in link` | [`magic-link.html`](magic-link.html) | Every sign-in after the first. Already set in production; this file is the copy of record |
| **Invite user** | `Your Mozart workspace is ready` | [`invite.html`](invite.html) | Only the fallback, Authentication → Users → **Send invitation**. Its link confirms the address and lands on the sign-in page still signed out |

The other templates (Change email address, Reset password, Reauthentication)
are not reachable in this app: it has no password and no email change screen.
Leave them as they are.

## Rules the files keep

- **One link, `{{ .ConfirmationURL }}`.** It is the provider's PKCE link and
  signs in through `/auth/callback`. A `{{ .TokenHash }}` link would need an
  `/auth/confirm` route this app does not have.
- **Only `{{ .ConfirmationURL }}` and `{{ .Email }}`**, which every template
  has.
- **Nothing remote**: no images, fonts, stylesheets or scripts. The logo is
  text. Everything is inline styles in tables, because that is what mail
  clients render.
- The invitation says plainly that it does not sign the person in; the first
  sign-in email says it does, and that it expires five minutes after it was
  sent (ONBOARDING §2).

## After pasting: the check

1. Add a test person to the test workspace on **Settings → Team**, as its
   owner, with an address you control that has no Auth user yet (for example
   `you+tenantb@gmail.com` after its Auth user was deleted).
2. In a private window, ask for a sign-in link for that address.
3. **You should see** the email arrive in the **inbox**, not spam, with the
   subject "Welcome to Mozart: your first sign-in link" and the Mozart design.
   Its button signs you in.
4. If it lands in spam anyway, press **Report not spam**, and tell me: the next
   step would be a custom domain for Supabase Auth, so the link no longer
   points at `supabase.co` (a paid add-on).
