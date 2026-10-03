# 0065 — An invited person is emailed how to sign in

- Status: proposed (the founder asked for it on 2026-10-03: "new users aren't
  receiving emails when I add them to my team"); accepted on merge
- Date: 2026-10-03
- Amends: ADR 0051 §6, whose last paragraph said "Sending our own invitation
  email would be a new outbound side effect and is not done"
- Adds: one outbound side effect (an email through Resend). No table, no
  column, no grant, no migration, no new environment variable.

## Context

ADR 0051 let an owner add a teammate on Settings → Team and then showed the
owner a welcome message to copy and send from their own email. The app sent
nothing. The person's first email from anyone was the provider's "Confirm
signup", and only after they had typed their address on the sign-in page.

In production that read as broken. On 2026-10-03 the founder added two people
(16:19 and 20:01 UTC). The auth logs for the day hold no `/otp` request for
either address, and neither has an Auth user: nobody had told them to sign in,
so nothing was ever asked of the provider. The one person who did sign in
after being added (2026-09-26) had been told by hand.

## Decision

1. **After the membership commits, the invite route emails an invitation to
   the address the owner typed.** Its words are `welcomeEmail()`'s (subject
   and plain text), and its HTML part is `invitationHtml()`, in
   `docs/email-templates/magic-link.html`'s layout with every value a person
   typed escaped. It contains the address of the sign-in page and no link that
   signs anyone in, so a forwarded or intercepted invitation gives nobody
   anything the page itself does not. The welcome message ADR 0051 showed an
   owner to copy is gone from the page (the founder, 2026-10-03: it only
   added complexity once the app sends the email).
2. **The provider's own email is not used for this.** Calling
   `signInWithOtp` from the owner's request would send a PKCE link whose code
   verifier sits in the *owner's* browser. The invitee's click would confirm
   the address and then fail as "that link has expired". The admin invite
   endpoint needs the service-role key (invariant 6).
3. **It is sent through the Resend account the failure alerts use** (ADR
   0052): `RESEND_API_KEY` (send-only) and `ALERT_EMAIL_FROM`, as
   `Mozart Financial <ALERT_EMAIL_FROM>`. `ALERT_EMAIL_TO` stays the alerts' alone.
   `inviteMailFromEnv` is `alertsFromEnv`'s shape: both variables or neither,
   and one alone is logged as misconfigured. Both are Production only
   (docs/supabase.md), so a preview sends no invitation.
4. **A send never undoes or blocks the invitation.** The notice says which of
   three things happened: `team_invited` (emailed), `team_invited_not_emailed`
   (this deployment sends no mail) or `team_invited_mail_failed` (Resend
   refused, timed out or could not be reached, or the address was not one
   bare address). The last two tell the owner to let the person know where to
   sign in. Nothing is retried. A second press of "Add" is refused as `already_member`
   and sends nothing.
5. **Logs carry ids, Resend's status and a class name.** They never carry the
   address, the name, the key or Resend's body. `AlertMailError` already
   kept the key and body out; the route's log line already kept the address
   out.

## Consequences

- An owner adds someone and that person gets an email within seconds, saying
  where to sign in. The provider's "Confirm signup" follows once they ask for
  a link, as before.
- The email is sent from the alerts' address. A dedicated sender
  (`team@…`) is a later change to one variable.
- Enumeration is unchanged: the email and the notice are the same whether or
  not the address already signs in elsewhere.
- An owner can make the app email any address they type, once per add. That is
  bounded by owner-only membership writes (ADR 0039 §8, 0051) and by
  `already_member`. A removed and re-added person is emailed again.

## Invariants touched

- **New outbound side effect:** this ADR. It is not a money path and writes
  nothing.
- **6:** no service role. The route sends with the same send-only key the
  alert job uses.
- No append-only table, grant or threshold changes.

## Rollback

Revert this change: the route goes back to ADR 0051's notice and copy-only
message. Unsetting `ALERT_EMAIL_FROM` or `RESEND_API_KEY` on Production also
stops the invitations, and the notice then says so, but it stops the failure
alerts too.
