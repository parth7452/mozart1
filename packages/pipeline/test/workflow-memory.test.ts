import { describe, expect, it } from 'vitest';
import { buildPacketNarrative, packetContentHash } from '@recouple/core-domain';
import {
  CaseWorkflowError,
  DuplicateSubmissionError,
  InvalidRecoveryAmountError,
  PacketHashMismatchError,
  PreparerCannotApproveError,
  WrongCaseStateError,
  WrongRoleError,
} from '../src/ports';
import { DuplicateApprovalError, InMemoryStore } from '../src/testing/memory-store';

/**
 * The Phase 3 workflow on the in-memory store.
 *
 * This store is what every test that is not about Postgres runs against, so
 * what it refuses has to be what the database refuses — otherwise a green test
 * suite is a description of a system that does not exist. The suite that proves
 * the two agree runs the same cases against both
 * (`packages/store-postgres/test/workflow.test.ts`); what is here is the half
 * that needs no database: the event stream a case leaves behind, and the
 * refusals in their own words.
 */

const ORG = 'org-1';
const ANALYST = 'user-analyst';
const OWNER = 'user-owner';
const COLLEAGUE = 'user-colleague';
const READER = 'user-reader';

function freshStore(): InMemoryStore {
  const store = new InMemoryStore();
  store.addMember(ORG, ANALYST, 'analyst');
  store.addMember(ORG, OWNER, 'owner');
  store.addMember(ORG, COLLEAGUE, 'analyst');
  store.addMember(ORG, READER, 'read_only');
  return store;
}

let claims = 0;

/** A case in `classified` with a notice and one piece of evidence, as uploaded. */
async function newCase(store: InMemoryStore, amountCents = 312_000): Promise<string> {
  claims += 1;
  const opened = await store.openCase({
    orgId: ORG,
    claimId: `APDP-${claims}`,
    retailerName: 'WALMART STORES, INC.',
    deductionAmountCents: amountCents,
    deductionDate: '2026-08-14',
    disputeDeadline: '2026-10-13',
  });
  for (const [index, role] of (['notice', 'evidence'] as const).entries()) {
    const document = await store.putDocument({
      orgId: ORG,
      sha256: `${claims}`.padStart(64, `${index}`),
      filename: `${role}-${claims}.pdf`,
      mimeType: 'application/pdf',
      byteSize: 1024,
      bytes: new Uint8Array([1, 2, 3]),
      requiresSplit: false,
    });
    await store.linkDocument(opened.deductionId, document.documentId, role);
  }
  await store.transitionCase(opened.deductionId, 'classified');
  return opened.deductionId;
}

async function throughToSubmission(
  store: InMemoryStore,
  deductionId: string,
): Promise<{ decisionId: string; packetId: string; approvalId: string }> {
  const { decisionId } = await store.recordHumanDecision({
    deductionId,
    preparedBy: ANALYST,
    reason: 'shortage_never_received',
    rationale: 'POD signed for the full quantity.',
  });
  const packet = await store.assemblePacket({ deductionId, decisionId, assembledBy: ANALYST });
  const { approvalId } = await store.approve({
    decisionId,
    packetId: packet.packetId,
    approverId: OWNER,
  });
  await store.recordSubmission({
    decisionId,
    packetId: packet.packetId,
    approvalId,
    channel: 'manual_portal',
    confirmationNumber: 'APDP-41007',
    submittedAt: new Date('2026-09-20T10:00:00Z'),
    actorId: OWNER,
  });
  return { decisionId, packetId: packet.packetId, approvalId };
}

describe('the in-memory workflow', () => {
  it('walks a case from classified to won, leaving a timeline behind it', async () => {
    const store = freshStore();
    const deductionId = await newCase(store);
    const { decisionId } = await throughToSubmission(store, deductionId);
    await store.recordOutcome({
      deductionId,
      outcome: 'won',
      recoveredCents: 312_000,
      recordedBy: OWNER,
    });

    expect((await store.getCase(deductionId))?.state).toBe('won');
    // The state is a projection; the events are the record it is rebuildable
    // from, so every step has to have left one.
    expect(store.events.filter((e) => e.deductionId === deductionId).map((e) => e.eventType)).toEqual(
      [
        'decision.recorded',
        'packet.assembled',
        'approval.granted',
        'submission.recorded',
        'outcome.recorded',
      ],
    );
    const outcome = store.events.find((e) => e.eventType === 'outcome.recorded');
    // Digits, not a number: everything that reads a payload back goes through
    // JSON.parse, and that is where a bigint would round (invariant 3).
    expect(outcome?.payload.recovered_cents).toBe('312000');
    expect(outcome?.payload.outcome).toBe('won');

    const decision = store.decisions.find((d) => d.decisionId === decisionId);
    expect(decision?.preparedBy).toBe(ANALYST);
    expect(decision?.reason).toBe('shortage_never_received');
  });

  it('builds the packet from the case, with the same hash core-domain would give', async () => {
    const store = freshStore();
    const deductionId = await newCase(store);
    const { decisionId } = await store.recordHumanDecision({
      deductionId,
      preparedBy: ANALYST,
      reason: 'shortage_never_received',
      rationale: 'POD signed for the full quantity.',
    });
    const packet = await store.assemblePacket({ deductionId, decisionId, assembledBy: ANALYST });

    const documents = await store.documentsForCase(deductionId);
    expect(packet.fileDocumentIds).toHaveLength(2);
    expect(packet.narrative).toContain('Retailer: WALMART STORES, INC.');
    expect(packet.narrative).toContain('Deduction amount: $3,120.00');
    expect(packet.narrative).toContain('Rationale: POD signed for the full quantity.');
    for (const document of documents) expect(packet.narrative).toContain(document.filename);

    // No model wrote this, so it can be recomputed and checked (ADR 0020 §2).
    expect(
      packetContentHash({
        decisionId,
        narrative: buildPacketNarrative({
          claimId: (await store.getCase(deductionId))?.claimId as string,
          retailer: 'WALMART STORES, INC.',
          deductionAmountCents: 312_000,
          deductionDate: '2026-08-14',
          disputeDeadline: '2026-10-13',
          reason: 'shortage_never_received',
          rationale: 'POD signed for the full quantity.',
          documents: documents.map((d, index) => ({
            role: index === 0 ? 'notice' : 'evidence',
            filename: d.filename,
          })),
        }),
        fileDocumentIds: [...packet.fileDocumentIds],
      }),
    ).toBe(packet.contentHash);
  });

  it('refuses a decision from anyone the tenant has not made a writer', async () => {
    const store = freshStore();
    const deductionId = await newCase(store);
    await expect(
      store.recordHumanDecision({
        deductionId,
        preparedBy: READER,
        reason: 'shortage_never_received',
        rationale: 'POD signed.',
      }),
    ).rejects.toBeInstanceOf(WrongRoleError);
    // And from someone with no membership at all: an unknown `sub` is not a
    // member, which is what `app.member_may_write()` says too.
    await expect(
      store.recordHumanDecision({
        deductionId,
        preparedBy: 'user-nobody',
        reason: 'shortage_never_received',
        rationale: 'POD signed.',
      }),
    ).rejects.toBeInstanceOf(WrongRoleError);
    expect(store.decisions).toHaveLength(0);
  });

  it('refuses a dispute with no rationale, because the packet quotes it', async () => {
    const store = freshStore();
    const deductionId = await newCase(store);
    await expect(
      store.recordHumanDecision({
        deductionId,
        preparedBy: ANALYST,
        reason: 'shortage_never_received',
        rationale: '   ',
      }),
    ).rejects.toBeInstanceOf(CaseWorkflowError);
  });

  it('refuses a second decision, and says where the case actually is', async () => {
    const store = freshStore();
    const deductionId = await newCase(store);
    await store.recordHumanDecision({
      deductionId,
      preparedBy: ANALYST,
      reason: 'shortage_never_received',
      rationale: 'POD signed.',
    });
    await expect(
      store.recordHumanDecision({
        deductionId,
        preparedBy: ANALYST,
        reason: 'price_discrepancy',
        rationale: 'Actually it was the price.',
      }),
    ).rejects.toThrow(/is analyst_review, expected classified/);
  });

  it('will not decide, assemble or act on a case it cannot see', async () => {
    const store = freshStore();
    await expect(
      store.recordHumanDecision({
        deductionId: 'ded-nobody',
        preparedBy: ANALYST,
        reason: 'shortage_never_received',
        rationale: 'POD signed.',
      }),
    ).rejects.toThrow(/not visible to this tenant/);
    expect(await store.getWorkflow('ded-nobody')).toBeUndefined();
  });

  it('keeps separation of duties: the preparer cannot approve, nor can a bystander', async () => {
    const store = freshStore();
    const deductionId = await newCase(store);
    const { decisionId } = await store.recordHumanDecision({
      deductionId,
      preparedBy: ANALYST,
      reason: 'shortage_never_received',
      rationale: 'POD signed.',
    });
    const packet = await store.assemblePacket({ deductionId, decisionId, assembledBy: ANALYST });

    await expect(
      store.approve({ decisionId, packetId: packet.packetId, approverId: ANALYST }),
    ).rejects.toBeInstanceOf(PreparerCannotApproveError);
    // An analyst who prepared nothing is still not an approver: two rules, and
    // this is the one `prepared_by` does not cover.
    await expect(
      store.approve({ decisionId, packetId: packet.packetId, approverId: COLLEAGUE }),
    ).rejects.toBeInstanceOf(WrongRoleError);
    expect(store.approvals).toHaveLength(0);
  });

  it('refuses a second approval of the same decision', async () => {
    const store = freshStore();
    const deductionId = await newCase(store);
    const { decisionId } = await store.recordHumanDecision({
      deductionId,
      preparedBy: ANALYST,
      reason: 'shortage_never_received',
      rationale: 'POD signed.',
    });
    const packet = await store.assemblePacket({ deductionId, decisionId, assembledBy: ANALYST });
    await store.approve({ decisionId, packetId: packet.packetId, approverId: OWNER });
    await expect(
      store.approve({ decisionId, packetId: packet.packetId, approverId: OWNER }),
    ).rejects.toBeInstanceOf(DuplicateApprovalError);
    expect(store.approvals).toHaveLength(1);
  });

  it('refuses a submission of a packet nobody approved', async () => {
    const store = freshStore();
    const deductionId = await newCase(store);
    const { decisionId } = await store.recordHumanDecision({
      deductionId,
      preparedBy: ANALYST,
      reason: 'shortage_never_received',
      rationale: 'POD signed.',
    });
    const first = await store.assemblePacket({ deductionId, decisionId, assembledBy: ANALYST });
    // A third document, so re-assembling produces different contents and a
    // second packet — which is exactly the substitution the hash exists to
    // catch when the wrong one is filed.
    const extra = await store.putDocument({
      orgId: ORG,
      sha256: 'f'.repeat(64),
      filename: 'second-pod.pdf',
      mimeType: 'application/pdf',
      byteSize: 2048,
      bytes: new Uint8Array([9]),
      requiresSplit: false,
    });
    await store.linkDocument(deductionId, extra.documentId, 'evidence');
    const second = await store.assemblePacket({ deductionId, decisionId, assembledBy: ANALYST });
    expect(second.packetId).not.toBe(first.packetId);
    expect(second.contentHash).not.toBe(first.contentHash);

    const { approvalId } = await store.approve({
      decisionId,
      packetId: second.packetId,
      approverId: OWNER,
    });
    await expect(
      store.recordSubmission({
        decisionId,
        packetId: first.packetId,
        approvalId,
        channel: 'manual_portal',
        confirmationNumber: 'APDP-1',
        submittedAt: new Date(),
        actorId: OWNER,
      }),
    ).rejects.toBeInstanceOf(PacketHashMismatchError);
    expect(store.submissions).toHaveLength(0);

    // Assembling the *same* contents again is still just a read of the packet
    // that exists — idempotent, whatever state the case is in.
    expect(
      (await store.assemblePacket({ deductionId, decisionId, assembledBy: ANALYST })).packetId,
    ).toBe(second.packetId);

    // But once a packet is approved, no *different* packet may be assembled:
    // there is no second approval, so it could never be authorised, and it
    // would sit next to an approval naming the packet it replaced.
    const late = await store.putDocument({
      orgId: ORG,
      sha256: 'e'.repeat(64),
      filename: 'late-arrival.pdf',
      mimeType: 'application/pdf',
      byteSize: 512,
      bytes: new Uint8Array([7]),
      requiresSplit: false,
    });
    await store.linkDocument(deductionId, late.documentId, 'evidence');
    await expect(
      store.assemblePacket({ deductionId, decisionId, assembledBy: ANALYST }),
    ).rejects.toBeInstanceOf(CaseWorkflowError);
    expect(store.packets).toHaveLength(2);
  });

  it('refuses a second submission on the same channel', async () => {
    const store = freshStore();
    const deductionId = await newCase(store);
    const { decisionId, packetId, approvalId } = await throughToSubmission(store, deductionId);
    await expect(
      store.recordSubmission({
        decisionId,
        packetId,
        approvalId,
        channel: 'manual_portal',
        confirmationNumber: 'APDP-41007',
        submittedAt: new Date(),
        actorId: OWNER,
      }),
    ).rejects.toBeInstanceOf(DuplicateSubmissionError);
    expect(store.submissions).toHaveLength(1);
  });

  it('refuses recovered cents the outcome could not have produced', async () => {
    const store = freshStore();
    const deductionId = await newCase(store);
    await throughToSubmission(store, deductionId);
    const bad = [
      { outcome: 'lost' as const, recoveredCents: 1 },
      { outcome: 'won' as const, recoveredCents: 311_999 },
      { outcome: 'partial' as const, recoveredCents: 0 },
      { outcome: 'partial' as const, recoveredCents: 312_000 },
      { outcome: 'partial' as const, recoveredCents: 1800.5 },
      { outcome: 'partial' as const, recoveredCents: -1 },
      { outcome: 'won' as const, recoveredCents: Number.MAX_VALUE },
    ];
    for (const attempt of bad) {
      await expect(
        store.recordOutcome({ deductionId, ...attempt, recordedBy: OWNER }),
        JSON.stringify(attempt),
      ).rejects.toBeInstanceOf(InvalidRecoveryAmountError);
    }
    // Nothing moved: a refused outcome leaves the case where it was.
    expect((await store.getCase(deductionId))?.state).toBe('submitted');
    expect(store.outcomes).toHaveLength(0);
  });

  it('refuses a second outcome, and an outcome on a case nobody filed', async () => {
    const store = freshStore();
    const deductionId = await newCase(store);
    await throughToSubmission(store, deductionId);
    await store.recordOutcome({
      deductionId,
      outcome: 'partial',
      recoveredCents: 180_000,
      recordedBy: OWNER,
    });
    await expect(
      store.recordOutcome({
        deductionId,
        outcome: 'won',
        recoveredCents: 312_000,
        recordedBy: OWNER,
      }),
    ).rejects.toBeInstanceOf(WrongCaseStateError);

    const untouched = await newCase(store);
    await expect(
      store.recordOutcome({
        deductionId: untouched,
        outcome: 'lost',
        recoveredCents: 0,
        recordedBy: OWNER,
      }),
    ).rejects.toBeInstanceOf(WrongCaseStateError);
  });

  it('shows the case page everything that has happened, and nothing that has not', async () => {
    const store = freshStore();
    const deductionId = await newCase(store);
    const opening = await store.getWorkflow(deductionId);
    expect(opening?.state).toBe('classified');
    expect(opening?.decision).toBeUndefined();
    expect(opening?.packet).toBeUndefined();

    const { decisionId, packetId, approvalId } = await throughToSubmission(store, deductionId);
    await store.recordOutcome({
      deductionId,
      outcome: 'partial',
      recoveredCents: 180_000,
      recordedBy: OWNER,
    });

    const workflow = await store.getWorkflow(deductionId);
    expect(workflow?.state).toBe('partial');
    expect(workflow?.decision?.decisionId).toBe(decisionId);
    expect(workflow?.packet?.packetId).toBe(packetId);
    expect(workflow?.approval?.approvalId).toBe(approvalId);
    expect(workflow?.approval?.approverId).toBe(OWNER);
    expect(workflow?.submission?.confirmationNumber).toBe('APDP-41007');
    expect(workflow?.outcome?.recoveredCents).toBe(180_000);
    // The approval names a packet, and the packet is the one it names.
    expect(workflow?.approval?.packetHash).toBe(workflow?.packet?.contentHash);
    expect(workflow?.submission?.packetHash).toBe(workflow?.approval?.packetHash);
  });
});
