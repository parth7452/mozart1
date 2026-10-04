# MVP and pre-sell: the deliverables

*2026-09-30. Index for this folder and the onboarding materials it points at.
Status is as of this commit; the dashboard (`.dashboard/`, gitignored) tracks
the live state during a session.*

## Written in this change

| Deliverable | File | Status |
| --- | --- | --- |
| The platform, as a client meets it: users, doors, screens, outbound, every external system and its state | `PLATFORM-MODEL.md` | Done |
| Road to MVP: four milestones with go/no-gos, and where we are on each | `ROAD-TO-MVP.md` | Done |
| Execution: the twelve-item pre-sell build (P1–P12), two-week sequence, what is parked | `EXECUTION.md` | Done |
| The 30-minute pre-sell call: materials, minute-by-minute script, rehearsal checklist, one-pager and data note text | `../../onboarding/PRE-SELL-CALL.md` | Done |
| Lead notes: Tarazi Foods (UNFI, KeHE, broker, planner, paystubs, logistics) | `../../onboarding/leads/tarazi-foods.md` | Done |
| Lead notes: Anthem Snacks (discovery questions; doors depend on answers) | `../../onboarding/leads/anthem-snacks.md` | Done |

## To build next (from `EXECUTION.md`)

| # | Deliverable | Owner | Status |
| --- | --- | --- | --- |
| P1 | `natural` fixture pack: UNFI-style advice, MCB backup, KeHE-style detail, deal confirmation, BOL, POD | Claude | Not started |
| P2 | Record the `natural` cassettes (spends ~$0.50) | Founder's go, Claude runs | Waits on P1 and the go |
| P3 | Beachhead codes on the decide form | Claude | Not started |
| P4 | UNFI and KeHE seed code maps as documents | Claude | Not started |
| P5 | `Harborline Foods` demo workspace populated on production | Founder | Waits on P1, P3 |
| P6 | A QuickBooks Online trial company connected to the demo workspace | Founder | Waits on P5 |
| P7 | Custom SMTP for sign-in mail, tested with an outside address | Founder | Not started; unknown state |
| P8 | A workspace per lead, made the morning of the call | Founder | Waits on P7 |
| P9 | VERIFY-CHECKLIST §11.1, 11.2, 11.4–11.7 run in production | Founder | Not started |
| P10 | The call materials | Claude | Done (this change) |
| P11 | Rotate the AWS key and worker token exposed 2026-09-29 | Founder | Not started |
| P12 | Decide proactive paging (ADR 0053 §6); default: tell pilots to split at 100 rows | Founder | Open |

## Decisions the founder owns

1. The go on P2's spend.
2. The pilot terms: contingency percentage, 90 days, invoicing by hand.
3. P12, before the first pilot uploads a backlog.
4. Whether Anthem's first call is discovery only (recommended) or the demo.
