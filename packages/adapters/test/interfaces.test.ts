import { describe, expect, it } from 'vitest';
import { EVIDENCE_TYPES, type EvidenceSource, type SubmissionChannel } from '../src/index';

/**
 * Phase 0 ships the contracts, not the implementations. These tests pin the
 * shapes so the V1/V1.5/V3 channels really are drop-in, which is the whole
 * reason for defining them this early.
 */
describe('adapter contracts', () => {
  it('lets a manual channel satisfy SubmissionChannel without any outbound side effect', async () => {
    const manual: SubmissionChannel = {
      kind: 'manual_portal',
      async prepare(packet, playbook) {
        return {
          kind: 'manual_portal',
          packet,
          instructions: [`Open ${playbook.name}`, 'Attach the packet files', 'Submit'],
          payload: { granularity: playbook.granularity },
        };
      },
      async submit(prepared, ctx) {
        // A manual channel only records what the human did.
        expect(ctx.approvalId).not.toBe('');
        return {
          status: 'recorded',
          confirmationNumber: 'APDP-99812',
          submittedAt: new Date(0).toISOString(),
          evidence: { filedBy: ctx.actorId, files: prepared.packet.files.length },
        };
      },
    };

    const prepared = await manual.prepare(
      {
        orgId: 'org',
        deductionId: 'ded',
        decisionId: 'dec',
        narrative: 'BOL shows 30 cartons; the DC signed for 25.',
        files: [],
        contentHash: 'abc',
      },
      {
        type: 'portal',
        name: 'APDP',
        granularity: 'claim_line',
        fileTypes: ['pdf', 'jpeg', 'png'],
        maxFileMb: 10,
      },
    );
    expect(prepared.instructions[0]).toBe('Open APDP');

    const result = await manual.submit(prepared, {
      actorId: 'user',
      approvalId: 'approval',
      idempotencyKey: 'dec:manual_portal',
    });
    expect(result.status).toBe('recorded');
  });

  it('lets the V1 upload source satisfy EvidenceSource', async () => {
    const uploads: EvidenceSource = {
      kind: 'user_upload',
      async fetch() {
        return [];
      },
    };
    expect(await uploads.fetch('signed_pod', { orgId: 'o', deductionId: 'd' })).toEqual([]);
  });

  it('keeps evidence types unique', () => {
    expect(new Set(EVIDENCE_TYPES).size).toBe(EVIDENCE_TYPES.length);
  });
});
