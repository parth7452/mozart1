import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  CaseAlreadyDeclinedError,
  CaseWorkflowError,
  ConfirmationNumberRequiredError,
  DuplicateApprovalError,
  DuplicateSubmissionError,
  InvalidRecoveryAmountError,
  PacketHashMismatchError,
  PacketSupersededError,
  PreparerCannotApproveError,
  RationaleTooLongError,
  WrongCaseStateError,
  WrongRoleError,
  type CaseWorkflowStore,
} from '@recouple/pipeline';
import { MAX_RATIONALE_LENGTH, buildPacketNarrative } from '@recouple/core-domain';
import { InMemoryStore } from '@recouple/pipeline/testing';
import { closeAllPools, PostgresStore } from '../src/store';
import { ApprovalAuthorError, approve } from '../src/workflow';

/**
 * The Phase 3 workflow against the real schema, and the contract both stores
 * have to satisfy.
 *
 * Two halves:
 *
 *  - **The contract** runs the same cases against `InMemoryStore` and
 *    `PostgresStore`. Everything that is not about the database — who may act,
 *    what order things happen in, which refusal a caller gets — has one
 *    description and two implementations, and this is what keeps the in-memory
 *    store from quietly becoming a more permissive system than the one that
 *    ships. The memory half needs no database and always runs.
 *  - **The Postgres half** is what only a database can prove: RLS, the
 *    separation-of-duties trigger, the approval gate refusing a submission that
 *    goes around the store entirely, and the shape of the rows that are left
 *    behind.
 */

const connectionString = process.env.TEST_DATABASE_URL;
const describeDb = connectionString === undefined ? describe.skip : describe;

/** What the contract needs from a store to exercise it. */
interface Harness {
  store(userId: string): CaseWorkflowStore;
  /** A case in `classified`, with a notice and one piece of evidence. */
  newCase(amountCents?: number): Promise<string>;
  /** One more evidence document, so re-assembly produces different contents. */
  attachEvidence(deductionId: string): Promise<void>;
  readonly analyst: string;
  readonly approver: string;
  /** The tenant's owner, who may approve as well as write (migration 0005). */
  readonly owner: string;
  /** An analyst who prepared nothing: not a preparer, and not an approver. */
  readonly colleague: string;
  readonly reader: string;
  /** Records that the tenant chose not to fight this case. */
  decline(deductionId: string): Promise<void>;
  close(): Promise<void>;
}

const RATIONALE = 'POD signed for the full quantity on 2026-08-02.';

async function decide(h: Harness, deductionId: string): Promise<string> {
  const { decisionId } = await h.store(h.analyst).recordHumanDecision({
    deductionId,
    preparedBy: h.analyst,
    reason: 'shortage_never_received',
    rationale: RATIONALE,
  });
  return decisionId;
}

async function toAwaitingApproval(
  h: Harness,
  deductionId: string,
): Promise<{ decisionId: string; packetId: string; contentHash: string }> {
  const decisionId = await decide(h, deductionId);
  const packet = await h
    .store(h.analyst)
    .assemblePacket({ deductionId, decisionId, assembledBy: h.analyst });
  return { decisionId, packetId: packet.packetId, contentHash: packet.contentHash };
}

async function toSubmitted(
  h: Harness,
  deductionId: string,
): Promise<{ decisionId: string; packetId: string; approvalId: string; submissionId: string }> {
  const { decisionId, packetId } = await toAwaitingApproval(h, deductionId);
  const { approvalId } = await h
    .store(h.approver)
    .approve({ decisionId, packetId, approverId: h.approver, note: 'Checked the POD.' });
  const { submissionId } = await h.store(h.approver).recordSubmission({
    decisionId,
    packetId,
    approvalId,
    channel: 'manual_portal',
    confirmationNumber: 'APDP-41007',
    submittedAt: new Date('2026-09-20T10:00:00.000Z'),
    actorId: h.approver,
  });
  return { decisionId, packetId, approvalId, submissionId };
}

/**
 * The cases both stores answer identically.
 *
 * Written once and run twice, because two stores that are supposed to agree and
 * are tested apart will not stay agreeing: the drift shows up the day somebody
 * trusts a memory test about a rule the database never had.
 */
type RegisterSuite = (name: string, body: () => void) => void;

function workflowContract(
  name: string,
  register: RegisterSuite,
  create: () => Promise<Harness>,
): void {
  register(`the workflow contract: ${name}`, () => {
    let h: Harness;
    beforeAll(async () => {
      h = await create();
    });
    afterAll(async () => {
      await h?.close();
    });

    it('runs a case from a human decision to a won outcome', async () => {
      const deductionId = await h.newCase();
      const { decisionId } = await toSubmitted(h, deductionId);
      const { eventId } = await h
        .store(h.approver)
        .recordOutcome({
          deductionId,
          outcome: 'won',
          recoveredCents: 312_000,
          recordedBy: h.approver,
        });
      expect(eventId).not.toBe('');

      const workflow = await h.store(h.approver).getWorkflow(deductionId);
      expect(workflow?.state).toBe('won');
      expect(workflow?.decision?.decisionId).toBe(decisionId);
      expect(workflow?.decision?.preparedBy).toBe(h.analyst);
      expect(workflow?.decision?.rationale).toBe(RATIONALE);
      expect(workflow?.outcome?.recoveredCents).toBe(312_000);
      // The packet approved is the packet submitted, which is the whole point
      // of the hash travelling from one row to the next.
      expect(workflow?.approval?.packetHash).toBe(workflow?.packet?.contentHash);
      expect(workflow?.submission?.packetHash).toBe(workflow?.approval?.packetHash);

      // The same shape from both stores, not merely the same values: a caller
      // that can tell them apart by their keys is a caller whose tests against
      // the memory store are about a different object.
      expect(Object.keys(workflow ?? {}).sort()).toEqual([
        'approval',
        'decision',
        'deductionId',
        'outcome',
        'packet',
        'state',
        'submission',
      ]);
      expect(Object.keys(workflow?.decision ?? {}).sort()).toEqual([
        'decidedAt',
        'decisionId',
        'deductionId',
        'preparedBy',
        'rationale',
        'reason',
      ]);
      // `deductionId` is one more than `PacketRecord` declares, and both stores
      // carry it: the case page reaches for it, and an extra one store had and
      // the other did not would be the drift this assertion exists to catch.
      expect(Object.keys(workflow?.packet ?? {}).sort()).toEqual([
        'assembledAt',
        'assembledBy',
        'contentHash',
        'decisionId',
        'deductionId',
        'fileDocumentIds',
        'narrative',
        'packetId',
      ]);
      expect(Object.keys(workflow?.approval ?? {}).sort()).toEqual([
        'approvalId',
        'approvedAt',
        'approverId',
        'decisionId',
        'note',
        'packetHash',
      ]);
      expect(Object.keys(workflow?.submission ?? {}).sort()).toEqual([
        'channel',
        'confirmationNumber',
        'decisionId',
        'packetHash',
        'submissionId',
        'submittedAt',
      ]);
      expect(Object.keys(workflow?.outcome ?? {}).sort()).toEqual([
        'deductionId',
        'eventId',
        'outcome',
        'recordedAt',
        'recordedBy',
        'recoveredCents',
      ]);
    });

    it('records a partial recovery, strictly between nothing and the deduction', async () => {
      const deductionId = await h.newCase();
      await toSubmitted(h, deductionId);
      await h.store(h.approver).recordOutcome({
        deductionId,
        outcome: 'partial',
        recoveredCents: 180_000,
        recordedBy: h.approver,
        note: 'They allowed three of the five cartons.',
      });
      const workflow = await h.store(h.approver).getWorkflow(deductionId);
      expect(workflow?.state).toBe('partial');
      expect(workflow?.outcome?.recoveredCents).toBe(180_000);
      expect(workflow?.outcome?.note).toBe('They allowed three of the five cartons.');
    });

    it('records a lost dispute, which recovered nothing', async () => {
      const deductionId = await h.newCase();
      await toSubmitted(h, deductionId);
      await h
        .store(h.approver)
        .recordOutcome({ deductionId, outcome: 'lost', recoveredCents: 0, recordedBy: h.approver });
      const workflow = await h.store(h.approver).getWorkflow(deductionId);
      expect(workflow?.state).toBe('lost');
      expect(workflow?.outcome?.recoveredCents).toBe(0);
    });

    it('hands back the packet that exists when identical contents are assembled again', async () => {
      const deductionId = await h.newCase();
      const { decisionId, packetId, contentHash } = await toAwaitingApproval(h, deductionId);
      const again = await h
        .store(h.analyst)
        .assemblePacket({ deductionId, decisionId, assembledBy: h.analyst });
      expect(again.packetId).toBe(packetId);
      expect(again.contentHash).toBe(contentHash);
      // And the case did not move twice.
      expect((await h.store(h.analyst).getWorkflow(deductionId))?.state).toBe('awaiting_approval');
    });

    it('refuses a decision on a case that is not classified', async () => {
      const deductionId = await h.newCase();
      await decide(h, deductionId);
      await expect(
        h.store(h.analyst).recordHumanDecision({
          deductionId,
          preparedBy: h.analyst,
          reason: 'price_discrepancy',
          rationale: 'On reflection it was the price.',
        }),
      ).rejects.toBeInstanceOf(WrongCaseStateError);
    });

    it('refuses a reason code nothing could ever add up, and one with no rationale', async () => {
      const deductionId = await h.newCase();
      await expect(
        h.store(h.analyst).recordHumanDecision({
          deductionId,
          preparedBy: h.analyst,
          // The type says canonical; a form post is a string until something
          // checks, and a code no playbook maps is a decision nobody can count.
          reason: 'they_were_mean_to_us' as never,
          rationale: RATIONALE,
        }),
      ).rejects.toBeInstanceOf(CaseWorkflowError);
      await expect(
        h.store(h.analyst).recordHumanDecision({
          deductionId,
          preparedBy: h.analyst,
          reason: 'shortage_never_received',
          rationale: '   ',
        }),
      ).rejects.toBeInstanceOf(CaseWorkflowError);
      expect((await h.store(h.analyst).getWorkflow(deductionId))?.decision).toBeUndefined();
    });

    it('refuses a read_only member, whatever the UI showed them', async () => {
      const deductionId = await h.newCase();
      await expect(
        h.store(h.reader).recordHumanDecision({
          deductionId,
          preparedBy: h.reader,
          reason: 'shortage_never_received',
          rationale: RATIONALE,
        }),
      ).rejects.toBeInstanceOf(WrongRoleError);
      // Nothing happened: the case is where it was.
      expect((await h.store(h.analyst).getWorkflow(deductionId))?.state).toBe('classified');
    });

    it('refuses to assemble a packet before anyone has decided', async () => {
      const deductionId = await h.newCase();
      await expect(
        h.store(h.analyst).assemblePacket({
          deductionId,
          decisionId: randomUUID(),
          assembledBy: h.analyst,
        }),
      ).rejects.toBeInstanceOf(CaseWorkflowError);
    });

    it('answers with the case it approved and the case it filed against', async () => {
      // Neither method is told which case it is acting on: `approve` and
      // `recordSubmission` take a decision and a packet, both of which arrive
      // on a form, and the case is the packet's. A caller that is not told
      // where its own write landed has to read a case back to find out — and
      // reading the case it *thought* it wrote to can say "not here" but never
      // "here instead".
      const deductionId = await h.newCase();
      const { decisionId, packetId } = await toAwaitingApproval(h, deductionId);

      const approval = await h
        .store(h.approver)
        .approve({ decisionId, packetId, approverId: h.approver });
      expect(approval.deductionId).toBe(deductionId);

      const submission = await h.store(h.approver).recordSubmission({
        decisionId,
        packetId,
        approvalId: approval.approvalId,
        channel: 'manual_portal',
        confirmationNumber: 'APDP-41009',
        submittedAt: new Date('2026-09-20T10:00:00.000Z'),
        actorId: h.approver,
      });
      expect(submission.deductionId).toBe(deductionId);
    });

    it('refuses the analyst who decided approving their own decision', async () => {
      const deductionId = await h.newCase();
      const { decisionId, packetId } = await toAwaitingApproval(h, deductionId);
      await expect(
        h.store(h.analyst).approve({ decisionId, packetId, approverId: h.analyst }),
      ).rejects.toBeInstanceOf(PreparerCannotApproveError);
    });

    it('refuses an analyst who prepared nothing: they are still not an approver', async () => {
      const deductionId = await h.newCase();
      const { decisionId, packetId } = await toAwaitingApproval(h, deductionId);
      await expect(
        h.store(h.colleague).approve({ decisionId, packetId, approverId: h.colleague }),
      ).rejects.toBeInstanceOf(WrongRoleError);
    });

    it('refuses a second approval of the same decision', async () => {
      const deductionId = await h.newCase();
      const { decisionId, packetId } = await toAwaitingApproval(h, deductionId);
      await h.store(h.approver).approve({ decisionId, packetId, approverId: h.approver });
      const second = h
        .store(h.approver)
        .approve({ decisionId, packetId, approverId: h.approver });
      await expect(second).rejects.toBeInstanceOf(CaseWorkflowError);
      await expect(second).rejects.toHaveProperty('name', 'DuplicateApprovalError');
    });

    it('refuses a submission naming a packet the approval did not', async () => {
      const deductionId = await h.newCase();
      const { decisionId, packetId: first } = await toAwaitingApproval(h, deductionId);
      // A document arrives, so re-assembling is a second packet with different
      // contents — the substitution the hash exists to catch.
      await h.attachEvidence(deductionId);
      const second = await h
        .store(h.analyst)
        .assemblePacket({ deductionId, decisionId, assembledBy: h.analyst });
      expect(second.packetId).not.toBe(first);

      const { approvalId } = await h
        .store(h.approver)
        .approve({ decisionId, packetId: second.packetId, approverId: h.approver });
      await expect(
        h.store(h.approver).recordSubmission({
          decisionId,
          packetId: first,
          approvalId,
          channel: 'manual_portal',
          confirmationNumber: 'APDP-1',
          submittedAt: new Date(),
          actorId: h.approver,
        }),
      ).rejects.toBeInstanceOf(PacketHashMismatchError);
      expect((await h.store(h.analyst).getWorkflow(deductionId))?.state).toBe('awaiting_approval');
    });

    it('refuses approving a packet that has since been assembled again', async () => {
      const deductionId = await h.newCase();
      const { decisionId, packetId: first, contentHash } = await toAwaitingApproval(h, deductionId);
      // Evidence arrives while the packet waits, and the analyst assembles
      // again: the case stays where it is, and the new packet is the one shown.
      await h.attachEvidence(deductionId);
      const second = await h
        .store(h.analyst)
        .assemblePacket({ deductionId, decisionId, assembledBy: h.analyst });
      expect(second.contentHash).not.toBe(contentHash);
      expect(second.fileDocumentIds).toHaveLength(3);
      const shown = await h.store(h.approver).getWorkflow(deductionId);
      expect(shown?.state).toBe('awaiting_approval');
      expect(shown?.packet?.packetId).toBe(second.packetId);

      // An approver on a page loaded before the re-assembly: refused by name,
      // and nothing written — the latest packet can still be approved.
      const stale = h
        .store(h.approver)
        .approve({ decisionId, packetId: first, approverId: h.approver });
      await expect(stale).rejects.toBeInstanceOf(PacketSupersededError);
      await expect(stale).rejects.toHaveProperty('latestPacketHash', second.contentHash);
      expect((await h.store(h.approver).getWorkflow(deductionId))?.approval).toBeUndefined();

      await h
        .store(h.approver)
        .approve({ decisionId, packetId: second.packetId, approverId: h.approver });
      const approved = await h.store(h.approver).getWorkflow(deductionId);
      expect(approved?.approval?.packetHash).toBe(second.contentHash);
    });

    it('refuses a second submission on the same channel', async () => {
      const deductionId = await h.newCase();
      const { decisionId, packetId, approvalId } = await toSubmitted(h, deductionId);
      await expect(
        h.store(h.approver).recordSubmission({
          decisionId,
          packetId,
          approvalId,
          channel: 'manual_portal',
          confirmationNumber: 'APDP-41007',
          submittedAt: new Date(),
          actorId: h.approver,
        }),
      ).rejects.toBeInstanceOf(DuplicateSubmissionError);
    });

    it('refuses recovered cents the outcome could not have produced', async () => {
      const deductionId = await h.newCase();
      await toSubmitted(h, deductionId);
      const bad = [
        { outcome: 'lost' as const, recoveredCents: 1 },
        { outcome: 'won' as const, recoveredCents: 311_999 },
        { outcome: 'won' as const, recoveredCents: 312_001 },
        { outcome: 'partial' as const, recoveredCents: 0 },
        { outcome: 'partial' as const, recoveredCents: 312_000 },
        { outcome: 'partial' as const, recoveredCents: 1800.5 },
        { outcome: 'partial' as const, recoveredCents: -1 },
        { outcome: 'won' as const, recoveredCents: Number.MAX_VALUE },
      ];
      for (const attempt of bad) {
        await expect(
          h.store(h.approver).recordOutcome({ deductionId, ...attempt, recordedBy: h.approver }),
          JSON.stringify(attempt),
        ).rejects.toBeInstanceOf(InvalidRecoveryAmountError);
      }
      expect((await h.store(h.approver).getWorkflow(deductionId))?.state).toBe('submitted');
    });

    it('refuses a second outcome, and an outcome on a case nobody filed', async () => {
      const deductionId = await h.newCase();
      await toSubmitted(h, deductionId);
      await h
        .store(h.approver)
        .recordOutcome({ deductionId, outcome: 'lost', recoveredCents: 0, recordedBy: h.approver });
      await expect(
        h.store(h.approver).recordOutcome({
          deductionId,
          outcome: 'won',
          recoveredCents: 312_000,
          recordedBy: h.approver,
        }),
      ).rejects.toBeInstanceOf(WrongCaseStateError);

      const unfiled = await h.newCase();
      await expect(
        h.store(h.approver).recordOutcome({
          deductionId: unfiled,
          outcome: 'lost',
          recoveredCents: 0,
          recordedBy: h.approver,
        }),
      ).rejects.toBeInstanceOf(WrongCaseStateError);
    });

    // ADR 0020 §5: `owner` is in both lists — it may write, and it may approve.
    // Only `approver` was ever exercised, so an implementation that read the
    // approver list as `['approver']` would have passed every other test here.
    it('lets an owner approve, because an owner is an approver too', async () => {
      const deductionId = await h.newCase();
      const { decisionId, packetId, contentHash } = await toAwaitingApproval(h, deductionId);
      const { approvalId } = await h
        .store(h.owner)
        .approve({ decisionId, packetId, approverId: h.owner });
      expect(approvalId).not.toBe('');

      const workflow = await h.store(h.owner).getWorkflow(deductionId);
      expect(workflow?.approval?.approverId).toBe(h.owner);
      expect(workflow?.approval?.packetHash).toBe(contentHash);
    });

    // A case we already chose not to fight is not a case to dispute:
    // `declined_candidates` is the coverage denominator, and a case counted as
    // both given up on and acted on moves the one number it exists to produce
    // (STRATEGY ADD-1).
    it('refuses a decision on a case that was already declined', async () => {
      const deductionId = await h.newCase();
      await h.decline(deductionId);
      await expect(
        h.store(h.analyst).recordHumanDecision({
          deductionId,
          preparedBy: h.analyst,
          reason: 'shortage_never_received',
          rationale: RATIONALE,
        }),
      ).rejects.toBeInstanceOf(CaseAlreadyDeclinedError);
      expect((await h.store(h.analyst).getWorkflow(deductionId))?.decision).toBeUndefined();
    });

    // The wedge this suite exists to keep shut. `decisions` is append-only and
    // the packet is assembled later, so a rationale accepted here and refused
    // by `packets.narrative` would leave the case in `analyst_review` with
    // nothing able to move it: no amended decision, and no packet, ever.
    it('refuses a rationale the packet narrative could not hold, before writing it', async () => {
      const deductionId = await h.newCase();
      const refusal = h.store(h.analyst).recordHumanDecision({
        deductionId,
        preparedBy: h.analyst,
        reason: 'shortage_never_received',
        rationale: 'x'.repeat(MAX_RATIONALE_LENGTH + 1),
      });
      await expect(refusal).rejects.toBeInstanceOf(RationaleTooLongError);
      // Nothing was written, and the case can still be decided.
      const untouched = await h.store(h.analyst).getWorkflow(deductionId);
      expect(untouched?.decision).toBeUndefined();
      expect(untouched?.state).toBe('classified');
    });

    it('accepts a rationale at the cap and assembles a packet from it', async () => {
      const deductionId = await h.newCase();
      const rationale = 'x'.repeat(MAX_RATIONALE_LENGTH);
      const { decisionId } = await h.store(h.analyst).recordHumanDecision({
        deductionId,
        preparedBy: h.analyst,
        reason: 'shortage_never_received',
        rationale,
      });
      const packet = await h
        .store(h.analyst)
        .assemblePacket({ deductionId, decisionId, assembledBy: h.analyst });
      expect(packet.narrative).toContain(rationale);
      // The number the cap is derived from: `packets.narrative` holds 20,000.
      expect(packet.narrative.length).toBeLessThanOrEqual(20_000);
    });

    // A confirmation number that differs from the portal's by a trailing space
    // is one nobody can match back to the retailer's record.
    it('trims the confirmation number it stores and reports', async () => {
      const deductionId = await h.newCase();
      const { decisionId, packetId } = await toAwaitingApproval(h, deductionId);
      const { approvalId } = await h
        .store(h.approver)
        .approve({ decisionId, packetId, approverId: h.approver });
      await h.store(h.approver).recordSubmission({
        decisionId,
        packetId,
        approvalId,
        channel: 'manual_portal',
        confirmationNumber: '  APDP-41007\n',
        submittedAt: new Date('2026-09-20T10:00:00.000Z'),
        actorId: h.approver,
      });
      expect(
        (await h.store(h.approver).getWorkflow(deductionId))?.submission?.confirmationNumber,
      ).toBe('APDP-41007');
    });

    it('refuses a submission whose confirmation number is only whitespace', async () => {
      const deductionId = await h.newCase();
      const { decisionId, packetId } = await toAwaitingApproval(h, deductionId);
      const { approvalId } = await h
        .store(h.approver)
        .approve({ decisionId, packetId, approverId: h.approver });
      await expect(
        h.store(h.approver).recordSubmission({
          decisionId,
          packetId,
          approvalId,
          channel: 'manual_portal',
          confirmationNumber: ' \t ',
          submittedAt: new Date(),
          actorId: h.approver,
        }),
      ).rejects.toBeInstanceOf(ConfirmationNumberRequiredError);
      expect((await h.store(h.analyst).getWorkflow(deductionId))?.submission).toBeUndefined();
    });

    it('shows the case page only what has happened so far', async () => {
      const deductionId = await h.newCase();
      const opening = await h.store(h.analyst).getWorkflow(deductionId);
      expect(opening?.state).toBe('classified');
      expect(opening?.decision).toBeUndefined();
      expect(opening?.packet).toBeUndefined();
      expect(opening?.approval).toBeUndefined();
      expect(opening?.submission).toBeUndefined();
      expect(opening?.outcome).toBeUndefined();

      const { decisionId } = await toAwaitingApproval(h, deductionId);
      const midway = await h.store(h.analyst).getWorkflow(deductionId);
      expect(midway?.decision?.decisionId).toBe(decisionId);
      expect(midway?.packet?.narrative).toContain('Amount deducted: $3,120.00\n');
      expect(midway?.packet?.fileDocumentIds.length).toBeGreaterThan(0);
      expect(midway?.approval).toBeUndefined();
      expect(midway?.submission).toBeUndefined();
      expect(midway?.outcome).toBeUndefined();

      expect(await h.store(h.analyst).getWorkflow(randomUUID())).toBeUndefined();
    });
  });
}

// ---------------------------------------------------------------------------
// The in-memory harness
// ---------------------------------------------------------------------------

workflowContract('in memory', describe, async () => {
  const store = new InMemoryStore();
  const orgId = randomUUID();
  const analyst = randomUUID();
  const approver = randomUUID();
  const owner = randomUUID();
  const colleague = randomUUID();
  const reader = randomUUID();
  store.addMember(orgId, analyst, 'analyst');
  store.addMember(orgId, approver, 'approver');
  store.addMember(orgId, owner, 'owner');
  store.addMember(orgId, colleague, 'analyst');
  store.addMember(orgId, reader, 'read_only');
  store.nameOrg(orgId, 'Workflow in memory');
  let claim = 0;
  let document = 0;

  const put = async (deductionId: string, role: 'notice' | 'evidence') => {
    document += 1;
    // The same two writes in the same order as the Postgres harness, and as
    // `ingestDocument`: where a document came from is recorded first.
    const upload = await store.recordUpload({
      orgId,
      source: 'web_upload',
      createdBy: analyst,
    });
    const stored = await store.putDocument({
      orgId,
      sha256: String(document).padStart(64, '0'),
      filename: `${role}-${document}.pdf`,
      mimeType: 'application/pdf',
      byteSize: 1024,
      bytes: new Uint8Array([1, 2, 3]),
      uploadId: upload.uploadId,
      requiresSplit: false,
    });
    await store.linkDocument(deductionId, stored.documentId, role);
  };

  return {
    store: () => store,
    analyst,
    approver,
    owner,
    colleague,
    reader,
    async decline(deductionId: string) {
      store.declineCase(deductionId);
    },
    async newCase(amountCents = 312_000) {
      claim += 1;
      const opened = await store.openCase({
        orgId,
        claimId: `WF-${claim}`,
        retailerName: 'WALMART STORES, INC.',
        deductionAmountCents: amountCents,
        deductionDate: '2026-08-14',
        disputeDeadline: '2026-10-13',
      });
      await put(opened.deductionId, 'notice');
      await put(opened.deductionId, 'evidence');
      await store.transitionCase(opened.deductionId, 'classified');
      return opened.deductionId;
    },
    async attachEvidence(deductionId: string) {
      await put(deductionId, 'evidence');
    },
    async close() {
      return;
    },
  };
});

// ---------------------------------------------------------------------------
// The Postgres harness, and what only Postgres can prove
// ---------------------------------------------------------------------------

/** One tenant, its people, and the plumbing to open cases in it. */
interface Tenant {
  readonly orgId: string;
  readonly analyst: string;
  readonly approver: string;
  readonly owner: string;
  readonly colleague: string;
  readonly reader: string;
  storeFor(userId: string): PostgresStore;
  newCase(amountCents?: number): Promise<string>;
  attachEvidence(deductionId: string): Promise<void>;
  decline(deductionId: string): Promise<void>;
  close(): Promise<void>;
}

let tenants = 0;

async function seedTenant(admin: Pool, label: string): Promise<Tenant> {
  tenants += 1;
  const orgId = randomUUID();
  const suffix = `${label}-${tenants}-${orgId.slice(0, 8)}`;
  const analyst = randomUUID();
  const approver = randomUUID();
  const owner = randomUUID();
  const colleague = randomUUID();
  const reader = randomUUID();
  const debtorId = randomUUID();

  await admin.query(`insert into organizations (id, slug, name) values ($1, $2, $3)`, [
    orgId,
    `wf-${suffix}`,
    `Workflow ${suffix}`,
  ]);
  await admin.query(`insert into org_settings (org_id) values ($1)`, [orgId]);
  await admin.query(
    `insert into users (id, email) values ($1,$2), ($3,$4), ($5,$6), ($7,$8), ($9,$10)`,
    [
      analyst, `wf-analyst-${suffix}@example.test`,
      approver, `wf-approver-${suffix}@example.test`,
      owner, `wf-owner-${suffix}@example.test`,
      colleague, `wf-colleague-${suffix}@example.test`,
      reader, `wf-reader-${suffix}@example.test`,
    ],
  );
  await admin.query(
    `insert into memberships (org_id, user_id, role)
     values ($1,$2,'analyst'), ($1,$3,'approver'), ($1,$4,'owner'), ($1,$5,'analyst'),
            ($1,$6,'read_only')`,
    [orgId, analyst, approver, owner, colleague, reader],
  );
  // A debtor, so the packet names the tenant's own master data rather than the
  // string the notice printed (ADR 0019).
  await admin.query(
    `insert into debtors (id, org_id, retailer_key, display_name)
     values ($1, $2, 'walmart-stores', 'Walmart Stores, Inc.')`,
    [debtorId, orgId],
  );

  const stores = new Map<string, PostgresStore>();
  const storeFor = (userId: string): PostgresStore => {
    const existing = stores.get(userId);
    if (existing !== undefined) return existing;
    const store = new PostgresStore(
      { connectionString: connectionString as string },
      { orgId, userId },
    );
    stores.set(userId, store);
    return store;
  };

  let claim = 0;
  let document = 0;
  // An arrival, then the bytes — the order `ingestDocument` writes them in, so
  // a case seeded here has the provenance a case opened by the pipeline has.
  // Without it every case in this suite would be undeclinable, which is the
  // right refusal and the wrong test.
  const put = async (deductionId: string, role: 'notice' | 'evidence'): Promise<void> => {
    document += 1;
    const upload = await storeFor(analyst).recordUpload({
      orgId,
      source: 'web_upload',
      createdBy: analyst,
    });
    const stored = await storeFor(analyst).putDocument({
      orgId,
      sha256: `${suffix}/${document}`
        .split('')
        .reduce((hash, ch) => hash + ch.charCodeAt(0).toString(16), '')
        .padEnd(64, '0')
        .slice(0, 64),
      filename: `${role}-${document}.pdf`,
      mimeType: 'application/pdf',
      byteSize: 1024,
      bytes: new Uint8Array([37, 80, 68, 70]),
      uploadId: upload.uploadId,
      requiresSplit: false,
    });
    await storeFor(analyst).linkDocument(deductionId, stored.documentId, role);
  };

  return {
    orgId,
    analyst,
    approver,
    owner,
    colleague,
    reader,
    storeFor,
    async decline(deductionId: string) {
      await storeFor(analyst).declineCase({
        deductionId,
        reason: 'below_economic_floor',
        decidedBy: 'analyst',
      });
    },
    async newCase(amountCents = 312_000) {
      claim += 1;
      const opened = await storeFor(analyst).openCase({
        orgId,
        claimId: `WF-${suffix}-${claim}`,
        retailerName: 'WALMART STORES, INC.',
        deductionAmountCents: amountCents,
        deductionDate: '2026-08-14',
        disputeDeadline: '2026-10-13',
      });
      await put(opened.deductionId, 'notice');
      await put(opened.deductionId, 'evidence');
      await storeFor(analyst).transitionCase(opened.deductionId, 'classified');
      return opened.deductionId;
    },
    async attachEvidence(deductionId: string) {
      await put(deductionId, 'evidence');
    },
    async close() {
      await Promise.all([...stores.values()].map((store) => store.close()));
    },
  };
}

const contractAdmin = connectionString === undefined ? undefined : new Pool({ connectionString });

workflowContract('on postgres', describeDb, async () => {
  const tenant = await seedTenant(contractAdmin as Pool, 'contract');
  return {
    store: (userId: string) => tenant.storeFor(userId),
    analyst: tenant.analyst,
    approver: tenant.approver,
    owner: tenant.owner,
    colleague: tenant.colleague,
    reader: tenant.reader,
    newCase: (amountCents?: number) => tenant.newCase(amountCents),
    attachEvidence: (deductionId: string) => tenant.attachEvidence(deductionId),
    decline: (deductionId: string) => tenant.decline(deductionId),
    close: async () => {
      await tenant.close();
      await contractAdmin?.end();
    },
  };
});

describeDb('the workflow on postgres', () => {
  const admin = new Pool({ connectionString });
  let tenant: Tenant;
  let other: Tenant;

  beforeAll(async () => {
    tenant = await seedTenant(admin, 'pg');
    other = await seedTenant(admin, 'other');
  });

  afterAll(async () => {
    await tenant?.close();
    await other?.close();
    await closeAllPools();
    await admin.end();
  });

  it('writes a human decision the way ADR 0020 §1 says, and nothing else', async () => {
    const deductionId = await tenant.newCase();
    const { decisionId } = await tenant.storeFor(tenant.analyst).recordHumanDecision({
      deductionId,
      preparedBy: tenant.analyst,
      reason: 'shortage_never_received',
      rationale: RATIONALE,
    });

    const { rows } = await admin.query<{
      schema_id: string;
      schema_version: string;
      provider: string;
      model_version: string;
      confidence: string;
      cost_micros: string;
      latency_ms: number;
      raw_probabilities: Record<string, unknown>;
      result: Record<string, unknown>;
      questions: Record<string, unknown>;
      prepared_by: string;
      hash_bytes: number;
    }>(
      `select schema_id, schema_version, provider, model_version, confidence::text,
              cost_micros::text, latency_ms, raw_probabilities, result, questions,
              prepared_by, octet_length(input_state_hash) as hash_bytes
         from decisions where id = $1`,
      [decisionId],
    );
    const row = rows[0];
    expect(row?.schema_id).toBe('B');
    expect(row?.schema_version).toBe('human-1');
    expect(row?.provider).toBe('human');
    // Not a model's name: a cost query that believed it would be reading a lie.
    expect(row?.model_version).toBe('human');
    expect(row?.confidence).toBe('1.0000');
    expect(row?.cost_micros).toBe('0');
    expect(row?.latency_ms).toBe(0);
    // No fabricated distribution — an empty object is the honest answer, and a
    // 1.0 would be scored as calibration data.
    expect(row?.raw_probabilities).toEqual({});
    expect(row?.result).toEqual({
      dispute_reason: 'shortage_never_received',
      rationale: RATIONALE,
    });
    expect(row?.questions).toEqual({ dispute_reason: 'choice', rationale: 'text' });
    // The column the separation-of-duties trigger reads.
    expect(row?.prepared_by).toBe(tenant.analyst);
    expect(Number(row?.hash_bytes)).toBe(32);

    expect((await tenant.storeFor(tenant.analyst).getCase(deductionId))?.state).toBe(
      'analyst_review',
    );
  });

  it('refuses a decision that names somebody else as its author', async () => {
    // The database refuses this too (`app.human_decision_names_its_author()`),
    // which is the point: the store is code on the near side of the gate.
    const deductionId = await tenant.newCase();
    await expect(
      tenant.storeFor(tenant.analyst).recordHumanDecision({
        deductionId,
        preparedBy: tenant.approver,
        reason: 'shortage_never_received',
        rationale: RATIONALE,
      }),
    ).rejects.toBeInstanceOf(CaseWorkflowError);
    const { rows } = await admin.query<{ n: string }>(
      `select count(*)::text as n from decisions where deduction_id = $1`,
      [deductionId],
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('refuses a case that was already declined, so coverage is not counted twice', async () => {
    const deductionId = await tenant.newCase();
    await tenant.storeFor(tenant.analyst).declineCase({
      deductionId,
      reason: 'below_economic_floor',
      decidedBy: 'analyst',
    });
    await expect(
      tenant.storeFor(tenant.analyst).recordHumanDecision({
        deductionId,
        preparedBy: tenant.analyst,
        reason: 'shortage_never_received',
        rationale: RATIONALE,
      }),
    ).rejects.toBeInstanceOf(CaseAlreadyDeclinedError);
  });

  it('assembles a packet naming the matched debtor, hashed and append-only', async () => {
    const deductionId = await tenant.newCase();
    const { decisionId, packetId, contentHash } = await toAwaitingApproval(
      harnessFor(tenant),
      deductionId,
    );

    const { rows } = await admin.query<{
      hash: string;
      narrative: string;
      files: string[];
      assembled_by: string;
      decision_id: string;
    }>(
      `select encode(content_hash, 'hex') as hash, narrative, file_document_ids as files,
              assembled_by, decision_id
         from packets where id = $1`,
      [packetId],
    );
    expect(rows[0]?.hash).toBe(contentHash);
    expect(rows[0]?.decision_id).toBe(decisionId);
    expect(rows[0]?.assembled_by).toBe(tenant.analyst);
    expect(rows[0]?.files).toHaveLength(2);
    // The debtor the tenant created, not the string the notice printed.
    expect(rows[0]?.narrative).toContain('To: Walmart Stores, Inc.\n');
    expect(rows[0]?.narrative).toContain('Claim or deduction reference: WF-');
    expect(rows[0]?.narrative).toContain('Amount deducted: $3,120.00\n');
    expect(rows[0]?.narrative).toContain(`Explanation:\n${RATIONALE}\n`);

    // Byte for byte what `buildPacketNarrative` gives for this case's own
    // values — which is also what the in-memory store is held to
    // (`workflow-memory.test.ts`), so the two stores build the same letter.
    const { rows: facts } = await admin.query<{ supplier: string; claim: string }>(
      `select o.name as supplier, d.claim_id as claim
         from deductions d join organizations o on o.id = d.org_id where d.id = $1`,
      [deductionId],
    );
    const { rows: files } = await admin.query<{ id: string; filename: string; role: string }>(
      `select d.id, d.filename, dd.role from deduction_documents dd
         join documents d on d.id = dd.document_id where dd.deduction_id = $1`,
      [deductionId],
    );
    const filenameOf = new Map(files.map((f) => [f.id, f]));
    expect(rows[0]?.narrative).toBe(
      buildPacketNarrative({
        supplier: facts[0]?.supplier as string,
        payer: 'Walmart Stores, Inc.',
        claimId: facts[0]?.claim as string,
        invoiceNumbers: [],
        deductionAmountCents: 312_000,
        deductionDate: '2026-08-14',
        disputeDeadline: '2026-10-13',
        reason: 'shortage_never_received',
        rationale: RATIONALE,
        documents: (rows[0]?.files ?? []).map((id) => ({
          role: filenameOf.get(id)?.role as 'notice' | 'evidence',
          filename: filenameOf.get(id)?.filename as string,
        })),
      }),
    );

    // Append-only: nothing in this path holds an UPDATE on it, and the trigger
    // refuses the table's owner as well.
    await expect(
      admin.query(`update packets set narrative = 'rewritten' where id = $1`, [packetId]),
    ).rejects.toThrow(/append-only table packets/);
  });

  it('records the approval, the submission and the outcome as the schema expects', async () => {
    const deductionId = await tenant.newCase();
    const h = harnessFor(tenant);
    const { decisionId, packetId, approvalId, submissionId } = await toSubmitted(h, deductionId);
    await tenant.storeFor(tenant.approver).recordOutcome({
      deductionId,
      outcome: 'partial',
      recoveredCents: 180_000,
      recordedBy: tenant.approver,
    });

    const { rows: approvals } = await admin.query<{
      action_type: string;
      approver_id: string;
      hash: string;
      note: string | null;
    }>(
      `select action_type, approver_id, encode(packet_hash, 'hex') as hash, note
         from approvals where id = $1`,
      [approvalId],
    );
    expect(approvals[0]?.action_type).toBe('submit');
    expect(approvals[0]?.approver_id).toBe(tenant.approver);
    expect(approvals[0]?.note).toBe('Checked the POD.');

    const { rows: submissions } = await admin.query<{
      channel: string;
      status: string;
      confirmation_number: string;
      hash: string;
      submitted_at: Date;
      decision_id: string;
    }>(
      `select channel, status, confirmation_number, encode(packet_hash, 'hex') as hash,
              submitted_at, decision_id
         from submissions where id = $1`,
      [submissionId],
    );
    expect(submissions[0]?.channel).toBe('manual_portal');
    expect(submissions[0]?.status).toBe('recorded');
    expect(submissions[0]?.confirmation_number).toBe('APDP-41007');
    expect(submissions[0]?.decision_id).toBe(decisionId);
    // The hash the approval named is the hash that was filed.
    expect(submissions[0]?.hash).toBe(approvals[0]?.hash);
    expect(submissions[0]?.submitted_at.toISOString()).toBe('2026-09-20T10:00:00.000Z');

    const { rows: events } = await admin.query<{
      event_type: string;
      payload: Record<string, unknown>;
      created_by: string | null;
    }>(
      `select event_type, payload, created_by from deduction_events
        where deduction_id = $1 order by id asc`,
      [deductionId],
    );
    expect(events.map((e) => e.event_type)).toEqual([
      'decision.recorded',
      'packet.assembled',
      'approval.granted',
      'submission.recorded',
      'outcome.recorded',
    ]);
    // Every event says who recorded it; the projection is rebuildable from them.
    for (const event of events) expect(event.created_by).not.toBeNull();
    const outcome = events.at(-1);
    // Digits, not a JSON number: this is the value Phase 4 bills a contingency
    // fee on, and `JSON.parse` is where a bigint would round (invariant 3).
    expect(outcome?.payload.recovered_cents).toBe('180000');
    expect(typeof outcome?.payload.recovered_cents).toBe('string');

    const { rows: cases } = await admin.query<{ state: string }>(
      `select state from deductions where id = $1`,
      [deductionId],
    );
    expect(cases[0]?.state).toBe('partial');
    expect(packetId).not.toBe('');
  });

  it('lets the database refuse a submission that goes around the store entirely', async () => {
    // The gate is a trigger, not a check in TypeScript (invariant 1). This
    // writes the row the way a buggy store would — as `app_rw`, with the
    // tenant's claims set, exactly as `withTenant` does — and the database
    // still refuses it, because no approval exists for that decision.
    const deductionId = await tenant.newCase();
    const h = harnessFor(tenant);
    const { decisionId, contentHash } = await toAwaitingApproval(h, deductionId);

    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role app_rw');
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ org_id: tenant.orgId, sub: tenant.approver }),
      ]);
      await expect(
        client.query(
          `insert into submissions (org_id, deduction_id, decision_id, channel, packet_hash,
                                    confirmation_number, submitted_at)
           values ($1, $2, $3, 'manual_portal', $4, 'FORGED-1', now())`,
          [tenant.orgId, deductionId, decisionId, Buffer.from(contentHash, 'hex')],
        ),
      ).rejects.toThrow(/no submit approval row/);
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }

    const { rows } = await admin.query<{ n: string }>(
      `select count(*)::text as n from submissions where decision_id = $1`,
      [decisionId],
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('lets the database refuse a filing record written blank', async () => {
    // `recordSubmission` writes the packet hash, the confirmation number and
    // the filing date in one insert, and refuses an empty confirmation number
    // before it gets there. That is the store, on the near side of the gate —
    // and migration 0017 froze all three, so a row written blank could never be
    // completed by anybody. The constraint is what makes the database the
    // referee (ADR 0023): this writes the row the way a buggy store would, as
    // `app_rw` with the tenant's claims, against a decision that really is
    // approved, so nothing but the constraint can be what refuses it.
    const deductionId = await tenant.newCase();
    const h = harnessFor(tenant);
    const { decisionId, packetId, contentHash } = await toAwaitingApproval(h, deductionId);
    await h
      .store(tenant.approver)
      .approve({ decisionId, packetId, approverId: tenant.approver, note: 'Checked the POD.' });

    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role app_rw');
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ org_id: tenant.orgId, sub: tenant.approver }),
      ]);
      // A savepoint each, because a refused statement aborts the transaction
      // and the second attempt would otherwise be answered by that rather than
      // by the constraint it is about.
      await client.query('savepoint blank');
      await expect(
        client.query(
          `insert into submissions (org_id, deduction_id, decision_id, channel, packet_hash,
                                    submitted_at)
           values ($1, $2, $3, 'manual_portal', $4, now())`,
          [tenant.orgId, deductionId, decisionId, Buffer.from(contentHash, 'hex')],
        ),
      ).rejects.toThrow(/submissions_manual_filing_is_complete/);
      await client.query('rollback to savepoint blank');

      // And the cap the submit route enforces is enforced here too, so a caller
      // that is not that route cannot store a reference the app can never show
      // — and, since 0017, can never trim.
      await expect(
        client.query(
          `insert into submissions (org_id, deduction_id, decision_id, channel, packet_hash,
                                    confirmation_number, submitted_at)
           values ($1, $2, $3, 'manual_portal', $4, $5, now())`,
          [tenant.orgId, deductionId, decisionId, Buffer.from(contentHash, 'hex'), 'A'.repeat(121)],
        ),
      ).rejects.toThrow(/submissions_confirmation_number_length/);
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }

    const { rows } = await admin.query<{ n: string }>(
      `select count(*)::text as n from submissions where decision_id = $1`,
      [decisionId],
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('refuses a method that acts as somebody other than the session', async () => {
    // The store carries one person's session. A call naming another actor is a
    // bug or a forgery, and on a money path those look identical from here.
    const deductionId = await tenant.newCase();
    const h = harnessFor(tenant);
    const { decisionId, packetId } = await toAwaitingApproval(h, deductionId);
    await expect(
      tenant.storeFor(tenant.analyst).approve({
        decisionId,
        packetId,
        approverId: tenant.approver,
      }),
    ).rejects.toThrow(/cannot act as/);
    const { rows } = await admin.query<{ n: string }>(
      `select count(*)::text as n from approvals where decision_id = $1`,
      [decisionId],
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('lets the database refuse an approval written in somebody else\'s name', async () => {
    // `requireCaller` above is the store checking itself. This is what stands
    // behind it when the store is wrong (ADR 0041): the analyst who prepared
    // the decision writes an approval naming the approver, as `app_rw` with
    // the analyst's own claims — the row separation of duties would pass on
    // its name alone — and `app.approval_names_its_approver()` refuses it.
    const deductionId = await tenant.newCase();
    const h = harnessFor(tenant);
    const { decisionId, packetId, contentHash } = await toAwaitingApproval(h, deductionId);

    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query('set local role app_rw');
      await client.query('select set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ org_id: tenant.orgId, sub: tenant.analyst }),
      ]);

      await client.query('savepoint forged');
      await expect(
        client.query(
          `insert into approvals (org_id, decision_id, approver_id, action_type, packet_hash)
           values ($1, $2, $3, 'submit', $4)`,
          [tenant.orgId, decisionId, tenant.approver, Buffer.from(contentHash, 'hex')],
        ),
      ).rejects.toThrow(/is not the caller/);
      await client.query('rollback to savepoint forged');

      // And through the store, with its own check fooled: a tenant context that
      // says the approver while the claims on the connection say the analyst.
      // `requireCaller` passes, the database does not, and the refusal reaches
      // the caller by name rather than as a driver error.
      await expect(
        approve(
          client,
          { orgId: tenant.orgId, userId: tenant.approver },
          { decisionId, packetId, approverId: tenant.approver },
        ),
      ).rejects.toBeInstanceOf(ApprovalAuthorError);
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }

    const { rows } = await admin.query<{ n: string }>(
      `select count(*)::text as n from approvals where decision_id = $1`,
      [decisionId],
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('shows another tenant nothing, and lets them do nothing', async () => {
    const deductionId = await tenant.newCase();
    const h = harnessFor(tenant);
    const { decisionId, packetId, approvalId } = await toSubmitted(h, deductionId);

    const stranger = other.storeFor(other.analyst);
    expect(await stranger.getWorkflow(deductionId)).toBeUndefined();
    await expect(
      stranger.recordHumanDecision({
        deductionId,
        preparedBy: other.analyst,
        reason: 'shortage_never_received',
        rationale: RATIONALE,
      }),
    ).rejects.toThrow(/not visible to this tenant/);
    await expect(
      stranger.assemblePacket({ deductionId, decisionId, assembledBy: other.analyst }),
    ).rejects.toThrow(/not visible to this tenant/);
    // A packet of another tenant comes back as nothing, so the refusal is about
    // a packet that does not exist rather than one they may not have.
    await expect(
      other
        .storeFor(other.approver)
        .approve({ decisionId, packetId, approverId: other.approver }),
    ).rejects.toBeInstanceOf(CaseWorkflowError);
    await expect(
      stranger.recordSubmission({
        decisionId,
        packetId,
        approvalId,
        channel: 'manual_portal',
        confirmationNumber: 'POACHED',
        submittedAt: new Date(),
        actorId: other.analyst,
      }),
    ).rejects.toBeInstanceOf(CaseWorkflowError);
    await expect(
      stranger.recordOutcome({
        deductionId,
        outcome: 'won',
        recoveredCents: 312_000,
        recordedBy: other.analyst,
      }),
    ).rejects.toThrow(/not visible to this tenant/);

    // And nothing of theirs landed on our case.
    const { rows } = await admin.query<{ n: string }>(
      `select count(*)::text as n from submissions where decision_id = $1`,
      [decisionId],
    );
    expect(rows[0]?.n).toBe('1');
  });

  it('refuses a read_only member without telling them their case does not exist', async () => {
    const deductionId = await tenant.newCase();
    const refusal = tenant.storeFor(tenant.reader).recordHumanDecision({
      deductionId,
      preparedBy: tenant.reader,
      reason: 'shortage_never_received',
      rationale: RATIONALE,
    });
    await expect(refusal).rejects.toBeInstanceOf(WrongRoleError);
    // Not "no such case": they can see it, they just may not write.
    await expect(refusal).rejects.toThrow(/is not one of owner, approver, analyst/);
    expect(
      (await tenant.storeFor(tenant.reader).getWorkflow(deductionId))?.state,
    ).toBe('classified');
  });

  // getWorkflow answers with *the human decision*, not the newest decision. The
  // same case will carry a model's Schema B row once Phase 2 lands in the slot
  // Phase 3 has already used, and a case page that showed a model's rationale
  // as the analyst's would be showing something nobody said.
  it('shows the human decision even when the case also carries a model one', async () => {
    const deductionId = await tenant.newCase();
    const h = harnessFor(tenant);
    const { decisionId } = await toAwaitingApproval(h, deductionId);

    // A model decision on the same case, written the way a provider would:
    // `provider = 'jev'`, no `prepared_by`, its own probabilities — and
    // created after the human one, so "the newest row" and "the human row" are
    // different answers.
    const { rows: modelRows } = await admin.query<{ id: string }>(
      `insert into decisions
         (org_id, deduction_id, schema_id, schema_version, provider, model_version,
          input_state_hash, questions, result, raw_probabilities, confidence,
          latency_ms, cost_micros)
       values ($1, $2, 'B', 'b-1', 'jev', 'jev-0.4.2', $3,
               '{"dispute": "choice"}'::jsonb,
               '{"dispute_reason": "price_discrepancy", "rationale": "the model said so"}'::jsonb,
               '{"price_discrepancy": 0.91}'::jsonb, 0.9100, 42, 1200)
       returning id`,
      [tenant.orgId, deductionId, Buffer.alloc(32, 7)],
    );
    expect(modelRows[0]?.id).not.toBe(decisionId);

    const workflow = await tenant.storeFor(tenant.analyst).getWorkflow(deductionId);
    expect(workflow?.decision?.decisionId).toBe(decisionId);
    expect(workflow?.decision?.preparedBy).toBe(tenant.analyst);
    expect(workflow?.decision?.rationale).toBe(RATIONALE);
    expect(workflow?.decision?.reason).toBe('shortage_never_received');
    // And the packet still belongs to the decision a human made.
    expect(workflow?.packet?.decisionId).toBe(decisionId);
  });

  it('refuses a duplicate approval by the constraint, not by a convention', async () => {
    const deductionId = await tenant.newCase();
    const h = harnessFor(tenant);
    const { decisionId, packetId } = await toAwaitingApproval(h, deductionId);
    await tenant
      .storeFor(tenant.approver)
      .approve({ decisionId, packetId, approverId: tenant.approver });
    await expect(
      tenant
        .storeFor(tenant.approver)
        .approve({ decisionId, packetId, approverId: tenant.approver }),
    ).rejects.toBeInstanceOf(DuplicateApprovalError);
    const { rows } = await admin.query<{ n: string }>(
      `select count(*)::text as n from approvals where decision_id = $1`,
      [decisionId],
    );
    expect(rows[0]?.n).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// Two people pressing the same button at the same moment
// ---------------------------------------------------------------------------

/**
 * Every write in this workflow is a check followed by a write, and READ
 * COMMITTED lets two transactions both pass the check. What stops them is the
 * `for update` on the case row in `lockCase`: the second waits until the first
 * commits, then reads what it actually did. The in-memory store cannot show
 * this — it has one thread and no transactions — so it lives here, against two
 * pooled connections doing the real thing.
 *
 * The shape of every case below is the same: fire both, expect exactly one row
 * and one event, and expect the loser to be told what happened by name rather
 * than by a driver error or a lie about the state.
 */
describeDb('two people pressing the same button', () => {
  const admin = new Pool({ connectionString });
  let tenant: Tenant;

  beforeAll(async () => {
    tenant = await seedTenant(admin, 'race');
  });

  afterAll(async () => {
    await tenant?.close();
    await closeAllPools();
    await admin.end();
  });

  /** How many rows a query counted. */
  async function count(sql: string, params: unknown[]): Promise<number> {
    const { rows } = await admin.query<{ n: string }>(sql, params);
    return Number(rows[0]?.n ?? '-1');
  }

  /** The one rejection out of a settled pair, or a failure saying there was not one. */
  function loserOf(results: PromiseSettledResult<unknown>[]): unknown {
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    return (rejected[0] as PromiseRejectedResult).reason;
  }

  it('records one decision when two tabs decide at once', async () => {
    const deductionId = await tenant.newCase();
    const store = tenant.storeFor(tenant.analyst);
    // Named apart from the module-level `decide` helper it is not.
    const decideOnce = () =>
      store.recordHumanDecision({
        deductionId,
        preparedBy: tenant.analyst,
        reason: 'shortage_never_received',
        rationale: RATIONALE,
      });
    const results = await Promise.allSettled([decideOnce(), decideOnce()]);

    // The loser is told where the case is, not handed a driver error: the
    // winner already moved it to `analyst_review`.
    expect(loserOf(results)).toBeInstanceOf(WrongCaseStateError);
    expect(
      await count(`select count(*)::text as n from decisions where deduction_id = $1`, [
        deductionId,
      ]),
    ).toBe(1);
    expect(
      await count(
        `select count(*)::text as n from deduction_events
          where deduction_id = $1 and event_type = 'decision.recorded'`,
        [deductionId],
      ),
    ).toBe(1);
  });

  it('assembles one packet when the same contents are assembled twice at once', async () => {
    const deductionId = await tenant.newCase();
    const decisionId = await decide(harnessFor(tenant), deductionId);
    const store = tenant.storeFor(tenant.analyst);
    const assemble = () =>
      store.assemblePacket({ deductionId, decisionId, assembledBy: tenant.analyst });
    const results = await Promise.allSettled([assemble(), assemble()]);

    // Identical contents are one packet, so *both* callers get one back —
    // re-assembling is not a second assembly, and neither of two people who
    // pressed the same button has done anything wrong.
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const packets = (results as PromiseFulfilledResult<{ packetId: string }>[]).map(
      (r) => r.value.packetId,
    );
    expect(new Set(packets).size).toBe(1);
    expect(
      await count(`select count(*)::text as n from packets where decision_id = $1`, [decisionId]),
    ).toBe(1);
    expect(
      await count(
        `select count(*)::text as n from deduction_events
          where deduction_id = $1 and event_type = 'packet.assembled'`,
        [deductionId],
      ),
    ).toBe(1);
    // And the case crossed the edge once.
    expect(await tenant.storeFor(tenant.analyst).getWorkflow(deductionId)).toMatchObject({
      state: 'awaiting_approval',
    });
  });

  it('grants one approval when two approvers approve at once', async () => {
    const deductionId = await tenant.newCase();
    const { decisionId, packetId } = await toAwaitingApproval(harnessFor(tenant), deductionId);
    // Two different people, both entitled to approve: the constraint is on the
    // decision, not on who pressed the button.
    const results = await Promise.allSettled([
      tenant.storeFor(tenant.approver).approve({
        decisionId,
        packetId,
        approverId: tenant.approver,
      }),
      tenant.storeFor(tenant.owner).approve({ decisionId, packetId, approverId: tenant.owner }),
    ]);

    expect(loserOf(results)).toBeInstanceOf(DuplicateApprovalError);
    expect(
      await count(`select count(*)::text as n from approvals where decision_id = $1`, [
        decisionId,
      ]),
    ).toBe(1);
    expect(
      await count(
        `select count(*)::text as n from deduction_events
          where deduction_id = $1 and event_type = 'approval.granted'`,
        [deductionId],
      ),
    ).toBe(1);
  });

  it('records one submission when the submit button is pressed twice at once', async () => {
    const deductionId = await tenant.newCase();
    const { decisionId, packetId } = await toAwaitingApproval(harnessFor(tenant), deductionId);
    const { approvalId } = await tenant
      .storeFor(tenant.approver)
      .approve({ decisionId, packetId, approverId: tenant.approver });
    const store = tenant.storeFor(tenant.approver);
    const submit = () =>
      store.recordSubmission({
        decisionId,
        packetId,
        approvalId,
        channel: 'manual_portal',
        confirmationNumber: 'APDP-41007',
        submittedAt: new Date('2026-09-20T10:00:00.000Z'),
        actorId: tenant.approver,
      });
    const results = await Promise.allSettled([submit(), submit()]);

    // Not `WrongCaseStateError`: the case has moved to `submitted` by the time
    // the loser looks, and "you are in the wrong state" would be true and
    // useless. The duplicate is asked about first, on purpose.
    expect(loserOf(results)).toBeInstanceOf(DuplicateSubmissionError);
    expect(
      await count(`select count(*)::text as n from submissions where decision_id = $1`, [
        decisionId,
      ]),
    ).toBe(1);
    expect(
      await count(
        `select count(*)::text as n from deduction_events
          where deduction_id = $1 and event_type = 'submission.recorded'`,
        [deductionId],
      ),
    ).toBe(1);
  });

  it('records one outcome when two people record what came back at once', async () => {
    const deductionId = await tenant.newCase();
    await toSubmitted(harnessFor(tenant), deductionId);
    const store = tenant.storeFor(tenant.approver);
    const results = await Promise.allSettled([
      store.recordOutcome({
        deductionId,
        outcome: 'won',
        recoveredCents: 312_000,
        recordedBy: tenant.approver,
      }),
      store.recordOutcome({
        deductionId,
        outcome: 'lost',
        recoveredCents: 0,
        recordedBy: tenant.approver,
      }),
    ]);

    // Whichever landed first, there is one outcome and the case says what it
    // says: two would be a recovery rate that counts one dispute twice.
    expect(loserOf(results)).toBeInstanceOf(WrongCaseStateError);
    expect(
      await count(
        `select count(*)::text as n from deduction_events
          where deduction_id = $1 and event_type = 'outcome.recorded'`,
        [deductionId],
      ),
    ).toBe(1);
    const state = (await tenant.storeFor(tenant.approver).getWorkflow(deductionId))?.state;
    expect(['won', 'lost']).toContain(state);
  });
});

/** The contract's view of a seeded tenant, so the Postgres tests can reuse the steps. */
function harnessFor(tenant: Tenant): Harness {
  return {
    store: (userId: string) => tenant.storeFor(userId),
    analyst: tenant.analyst,
    approver: tenant.approver,
    owner: tenant.owner,
    colleague: tenant.colleague,
    reader: tenant.reader,
    newCase: (amountCents?: number) => tenant.newCase(amountCents),
    attachEvidence: (deductionId: string) => tenant.attachEvidence(deductionId),
    decline: (deductionId: string) => tenant.decline(deductionId),
    close: async () => undefined,
  };
}
