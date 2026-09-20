import { describe, expect, it } from 'vitest';
import {
  CaseWorkflowError,
  DuplicateSubmissionError,
  InvalidRecoveryAmountError,
  PacketHashMismatchError,
  PreparerCannotApproveError,
  WrongCaseStateError,
  WrongRoleError,
  type CaseWorkflow,
  type CaseWorkflowStore,
  type WorkflowSubmissionChannel,
} from '../src/ports';

/**
 * Phase 3 ships the contract before the store, the same way Phase 0 shipped the
 * adapter contracts (`packages/adapters/test/interfaces.test.ts`). These tests
 * pin two things the implementation will be written against:
 *
 *  - every refusal is a distinct, catchable class under one base, carrying the
 *    ids a reviewer would need, and saying what happened in its message. A
 *    money path that swallows a refusal is the first failure mode `CLAUDE.md`
 *    names, and a caller can only avoid swallowing one it can name;
 *  - the port's shape, so a store that satisfies it cannot quietly drift into
 *    accepting a channel that does not exist or returning a status a caller
 *    could ignore.
 *
 * Nothing here reaches the far side of the approval gate: the database refuses
 * a submission with no `approvals` row for that exact decision whatever an
 * implementation of this interface believes (migration 0005, ADR 0020 §5).
 */
describe('the Phase 3 workflow refusals', () => {
  it('puts every refusal under one base class, so a caller can sort rules from bugs', () => {
    const refusals = [
      new PreparerCannotApproveError('dec-1', 'user-1'),
      new PacketHashMismatchError('dec-1', 'aaaa', 'bbbb'),
      new WrongRoleError('user-1', 'approve', ['owner', 'approver']),
      new WrongCaseStateError('ded-1', 'submit', 'classified', ['awaiting_approval']),
      new InvalidRecoveryAmountError('ded-1', 'lost', 5, 'a lost case recovered nothing'),
      new DuplicateSubmissionError('dec-1', 'manual_portal', 'sub-1'),
    ];

    for (const refusal of refusals) {
      expect(refusal, refusal.name).toBeInstanceOf(CaseWorkflowError);
      expect(refusal, refusal.name).toBeInstanceOf(Error);
      // A class whose name is 'Error' is indistinguishable in a log.
      expect(refusal.name).not.toBe('Error');
      expect(refusal.message).not.toBe('');
    }

    // Distinct classes, not one class with a code: `catch (e) { if (e
    // instanceof PacketHashMismatchError) }` is the check a route needs.
    expect(new Set(refusals.map((r) => r.name)).size).toBe(refusals.length);
    for (const refusal of refusals) {
      expect(refusal.name).toBe(refusal.constructor.name);
    }
  });

  it('names the preparer and the decision when separation of duties refuses', () => {
    const error = new PreparerCannotApproveError('dec-7', 'analyst-3');
    expect(error.decisionId).toBe('dec-7');
    expect(error.approverId).toBe('analyst-3');
    expect(error.message).toBe(
      'approval refused: analyst-3 prepared decision dec-7 and cannot approve it',
    );
  });

  it('shows both hashes when the packet submitted is not the packet approved', () => {
    const error = new PacketHashMismatchError('dec-7', 'abc123', 'def456');
    expect(error.approvedHash).toBe('abc123');
    expect(error.submittedHash).toBe('def456');
    expect(error.message).toBe(
      'submission refused for decision dec-7: approved packet abc123, submitted packet def456',
    );
  });

  it('says which roles would have been enough', () => {
    const error = new WrongRoleError('user-9', 'approve', ['owner', 'approver']);
    expect(error.requiredRoles).toEqual(['owner', 'approver']);
    expect(error.message).toBe(
      'approve refused: user-9 is not one of owner, approver in this tenant',
    );
  });

  it('says where the case actually is and where it would have had to be', () => {
    const error = new WrongCaseStateError('ded-2', 'submit', 'classified', [
      'awaiting_approval',
    ]);
    expect(error.state).toBe('classified');
    expect(error.expected).toEqual(['awaiting_approval']);
    expect(error.message).toBe(
      'submit refused: case ded-2 is classified, expected awaiting_approval',
    );
  });

  // Invariant 3. This was a RangeError, which the language itself throws, so a
  // caller could not tell a refusal on a money path from a bug in the
  // arithmetic above it — and `instanceof CaseWorkflowError` missed it.
  it('is a workflow refusal and not a RangeError when the cents contradict the outcome', () => {
    const error = new InvalidRecoveryAmountError(
      'ded-4',
      'partial',
      312000,
      'a partial recovery is strictly less than the deduction',
    );
    expect(error).toBeInstanceOf(CaseWorkflowError);
    expect(error).not.toBeInstanceOf(RangeError);
    expect(error.outcome).toBe('partial');
    expect(error.recoveredCents).toBe(312000);
    expect(error.message).toBe(
      'outcome refused for case ded-4: partial with 312000 cents — ' +
        'a partial recovery is strictly less than the deduction',
    );
  });

  it('names the submission that already exists rather than only saying "duplicate"', () => {
    const error = new DuplicateSubmissionError('dec-3', 'manual_portal', 'sub-88');
    expect(error.existingSubmissionId).toBe('sub-88');
    expect(error.message).toBe(
      'submission refused: decision dec-3 was already submitted on manual_portal as sub-88',
    );
  });
});

describe('the CaseWorkflowStore contract', () => {
  // `manual_portal` is the only channel that exists. `email` is ADR 0020 §3's
  // "follows", and this assertion is what has to change with it — deliberately,
  // alongside a store that can actually send one.
  it('offers exactly the one channel a human can file on today', () => {
    const channel: WorkflowSubmissionChannel = 'manual_portal';
    expect(channel).toBe('manual_portal');
    // @ts-expect-error — `email` is not a channel until something can send one.
    const unsent: WorkflowSubmissionChannel = 'email';
    expect(unsent).toBe('email');
    // @ts-expect-error — `portal_agent` is Phase 6, behind the same gate.
    const agent: WorkflowSubmissionChannel = 'portal_agent';
    expect(agent).toBe('portal_agent');
  });

  it('is satisfiable by a store that only records, and returns ids rather than statuses', async () => {
    const empty: CaseWorkflow = { deductionId: 'ded-1', state: 'classified' };

    const store: CaseWorkflowStore = {
      async recordHumanDecision(input) {
        expect(input.reason).toBe('shortage_never_received');
        expect(input.preparedBy).not.toBe('');
        return { decisionId: 'dec-1' };
      },
      async assemblePacket() {
        return {
          packetId: 'pkt-1',
          contentHash: 'a'.repeat(64),
          narrative: 'Claim CLAIM-1 is disputed in full.',
          fileDocumentIds: ['doc-1'],
        };
      },
      async approve() {
        return { approvalId: 'apr-1' };
      },
      async recordSubmission(input) {
        // The channel is the union, not a wider string: a store cannot be
        // handed a way of filing that does not exist.
        expect(input.channel).toBe('manual_portal');
        return { submissionId: 'sub-1' };
      },
      async recordOutcome(input) {
        if (!Number.isInteger(input.recoveredCents)) {
          throw new InvalidRecoveryAmountError(
            input.deductionId,
            input.outcome,
            input.recoveredCents,
            'cents are integers (invariant 3)',
          );
        }
        return { eventId: 'evt-1' };
      },
      async getWorkflow() {
        return empty;
      },
    };

    expect(
      await store.recordHumanDecision({
        deductionId: 'ded-1',
        preparedBy: 'analyst-1',
        reason: 'shortage_never_received',
        rationale: 'POD signed for the full quantity.',
      }),
    ).toEqual({ decisionId: 'dec-1' });

    const packet = await store.assemblePacket({
      deductionId: 'ded-1',
      decisionId: 'dec-1',
      assembledBy: 'analyst-1',
    });
    expect(packet.contentHash).toHaveLength(64);
    expect(packet.fileDocumentIds).toEqual(['doc-1']);

    expect(
      await store.approve({
        decisionId: 'dec-1',
        packetId: 'pkt-1',
        approverId: 'approver-1',
      }),
    ).toEqual({ approvalId: 'apr-1' });

    expect(
      await store.recordSubmission({
        decisionId: 'dec-1',
        packetId: 'pkt-1',
        approvalId: 'apr-1',
        channel: 'manual_portal',
        confirmationNumber: 'APDP-41007',
        submittedAt: new Date(0),
        actorId: 'approver-1',
      }),
    ).toEqual({ submissionId: 'sub-1' });

    await expect(
      store.recordOutcome({
        deductionId: 'ded-1',
        outcome: 'partial',
        recoveredCents: 1800.5,
        recordedBy: 'approver-1',
      }),
    ).rejects.toBeInstanceOf(InvalidRecoveryAmountError);

    // Each part of the workflow is absent until it happens, rather than
    // present and empty — the case page shows what has occurred, not a shape.
    const workflow = await store.getWorkflow('ded-1');
    expect(workflow?.decision).toBeUndefined();
    expect(workflow?.packet).toBeUndefined();
    expect(workflow?.approval).toBeUndefined();
    expect(workflow?.submission).toBeUndefined();
    expect(workflow?.outcome).toBeUndefined();
  });
});
