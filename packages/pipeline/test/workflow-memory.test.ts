import { describe, expect, it } from 'vitest';
import {
  buildPacketNarrative,
  MAX_NARRATIVE_LENGTH,
  MAX_RATIONALE_LENGTH,
  packetContentHash,
} from '@recouple/core-domain';
import {
  CaseWorkflowError,
  DuplicateApprovalError,
  DuplicateSubmissionError,
  InvalidRecoveryAmountError,
  PacketHashMismatchError,
  PacketNotBuildableError,
  PreparerCannotApproveError,
  RationaleTooLongError,
  WrongCaseStateError,
  WrongRoleError,
} from '../src/ports';
import { InMemoryStore } from '../src/testing/memory-store';

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
  store.nameOrg(ORG, 'Harbor Lane Foods, LLC');
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
    expect(packet.narrative).toContain('From: Harbor Lane Foods, LLC\n');
    expect(packet.narrative).toContain('To: WALMART STORES, INC.\n');
    expect(packet.narrative).toContain('Amount deducted: $3,120.00\n');
    expect(packet.narrative).toContain('Explanation:\nPOD signed for the full quantity.\n');
    for (const document of documents) expect(packet.narrative).toContain(document.filename);

    // No model wrote this, so it can be recomputed and checked (ADR 0020 §2).
    expect(
      packetContentHash({
        decisionId,
        narrative: buildPacketNarrative({
          supplier: 'Harbor Lane Foods, LLC',
          claimId: (await store.getCase(deductionId))?.claimId as string,
          payer: 'WALMART STORES, INC.',
          invoiceNumbers: [],
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

  it("names the case's invoice numbers in the letter, once each and in code-unit order", async () => {
    const store = freshStore();
    const deductionId = await newCase(store);
    const upload = await store.recordUpload({ orgId: ORG, source: 'web_upload' });
    const remittance = await store.putDocument({
      orgId: ORG,
      sha256: 'f'.repeat(64),
      filename: 'remittance.pdf',
      mimeType: 'application/pdf',
      byteSize: 1024,
      bytes: new Uint8Array([1, 2, 3]),
      uploadId: upload.uploadId,
      requiresSplit: false,
    });
    await store.recordIdentifiers({
      orgId: ORG,
      deductionId,
      documentId: remittance.documentId,
      identifiers: [
        { kind: 'invoice_number', identifier: 'INV-9' },
        { kind: 'invoice_number', identifier: 'INV-10' },
        { kind: 'claim_id', identifier: 'NOT-AN-INVOICE' },
      ],
    });
    const { decisionId } = await store.recordHumanDecision({
      deductionId,
      preparedBy: ANALYST,
      reason: 'duplicate_invoice_deduction',
      rationale: 'Paid once, deducted twice.',
    });
    const packet = await store.assemblePacket({ deductionId, decisionId, assembledBy: ANALYST });
    expect(packet.narrative).toContain('Invoice numbers: INV-10, INV-9\n');
    expect(packet.narrative).not.toContain('NOT-AN-INVOICE');
    expect(packet.narrative).toContain('Reason for dispute: The same invoice deducted twice\n');
  });

  it('refuses to write a letter from a tenant it cannot name', async () => {
    const store = new InMemoryStore();
    store.addMember(ORG, ANALYST, 'analyst');
    const deductionId = await newCase(store);
    const { decisionId } = await store.recordHumanDecision({
      deductionId,
      preparedBy: ANALYST,
      reason: 'shortage_never_received',
      rationale: 'POD signed.',
    });
    await expect(
      store.assemblePacket({ deductionId, decisionId, assembledBy: ANALYST }),
    ).rejects.toThrow(/has no name/);
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

  // The hash covers the document *set*; the narrative covers the *order*. Two
  // documents with the same role and the same filename produce the same
  // enclosed list whichever way round they are, and their ids sort the same, so
  // the contents are the same contents and the packet that exists is handed
  // back rather than a second one being written.
  it('hands back the first packet when two identical documents swap places', async () => {
    const store = freshStore();
    const deductionId = await newCase(store);
    const { decisionId } = await store.recordHumanDecision({
      deductionId,
      preparedBy: ANALYST,
      reason: 'shortage_never_received',
      rationale: 'POD signed for the full quantity.',
    });
    // Two evidence documents that differ only in their bytes: same role, same
    // filename, different ids — a POD scanned twice.
    for (const sha of ['a'.repeat(64), 'b'.repeat(64)]) {
      const copy = await store.putDocument({
        orgId: ORG,
        sha256: sha,
        filename: 'pod-signed.pdf',
        mimeType: 'application/pdf',
        byteSize: 1024,
        bytes: new Uint8Array([1]),
        requiresSplit: false,
      });
      await store.linkDocument(deductionId, copy.documentId, 'evidence');
    }
    const first = await store.assemblePacket({ deductionId, decisionId, assembledBy: ANALYST });

    // Reverse the order the two copies were attached in, which is all
    // `packetDocuments` reads to build the enclosed list.
    const copied = store.links.flatMap((link, index) =>
      link.deductionId === deductionId && link.role === 'evidence' ? [index] : [],
    );
    const [penultimate, last] = [copied.at(-2) as number, copied.at(-1) as number];
    [store.links[penultimate], store.links[last]] = [
      store.links[last] as (typeof store.links)[number],
      store.links[penultimate] as (typeof store.links)[number],
    ];

    const again = await store.assemblePacket({ deductionId, decisionId, assembledBy: ANALYST });
    expect(again.contentHash).toBe(first.contentHash);
    expect(again.packetId).toBe(first.packetId);
    // The packet handed back is the one that was written, ordered as it was.
    expect(again.fileDocumentIds).toEqual(first.fileDocumentIds);
    expect(store.packets).toHaveLength(1);
  });

  // `decisions` is append-only and the packet is assembled later, so a
  // rationale the narrative could not hold would leave the case in
  // `analyst_review` with nothing able to move it.
  it('refuses a rationale longer than the packet narrative can hold', async () => {
    const store = freshStore();
    const deductionId = await newCase(store);
    await expect(
      store.recordHumanDecision({
        deductionId,
        preparedBy: ANALYST,
        reason: 'shortage_never_received',
        rationale: 'x'.repeat(MAX_RATIONALE_LENGTH + 1),
      }),
    ).rejects.toBeInstanceOf(RationaleTooLongError);
    expect(store.decisions).toHaveLength(0);
    expect((await store.getCase(deductionId))?.state).toBe('classified');

    // At the cap it is accepted, and the packet built from it fits the column
    // the cap was derived from.
    const { decisionId } = await store.recordHumanDecision({
      deductionId,
      preparedBy: ANALYST,
      reason: 'shortage_never_received',
      rationale: 'x'.repeat(MAX_RATIONALE_LENGTH),
    });
    const packet = await store.assemblePacket({ deductionId, decisionId, assembledBy: ANALYST });
    expect(packet.narrative.length).toBeLessThanOrEqual(MAX_NARRATIVE_LENGTH);
  });

  // The residue the rationale cap cannot cover. `claim_id` is unbounded `text`
  // and so is a debtor's display name, so a narrative can still come out too
  // long — and when it does, `core-domain`'s `PacketError` has to arrive as a
  // `CaseWorkflowError`, or a route renders a refusal a person can act on as a
  // fault. The Postgres store wraps it identically (`buildNarrativeOrRefuse`).
  it('surfaces a narrative that will not build as a named refusal, not a PacketError', async () => {
    const store = freshStore();
    const opened = await store.openCase({
      orgId: ORG,
      // Longer than the whole column, never mind the budget.
      claimId: 'C'.repeat(MAX_NARRATIVE_LENGTH + 1),
      retailerName: 'WALMART STORES, INC.',
      deductionAmountCents: 312_000,
    });
    const document = await store.putDocument({
      orgId: ORG,
      sha256: 'c'.repeat(64),
      filename: 'notice.pdf',
      mimeType: 'application/pdf',
      byteSize: 1024,
      bytes: new Uint8Array([1]),
      requiresSplit: false,
    });
    await store.linkDocument(opened.deductionId, document.documentId, 'notice');
    await store.transitionCase(opened.deductionId, 'classified');

    const { decisionId } = await store.recordHumanDecision({
      deductionId: opened.deductionId,
      preparedBy: ANALYST,
      reason: 'shortage_never_received',
      rationale: 'POD signed for the full quantity.',
    });
    const refusal = store.assemblePacket({
      deductionId: opened.deductionId,
      decisionId,
      assembledBy: ANALYST,
    });
    await expect(refusal).rejects.toBeInstanceOf(CaseWorkflowError);
    await expect(refusal).rejects.toBeInstanceOf(PacketNotBuildableError);
    // Not swallowed: the builder's own words survive inside the refusal.
    await expect(refusal).rejects.toThrow(/shorten the rationale/);
    expect(store.packets).toHaveLength(0);
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
