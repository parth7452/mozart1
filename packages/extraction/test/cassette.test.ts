import { describe, expect, it } from 'vitest';
import {
  CassetteClassifier,
  classificationIsCurrent,
  classifierPromptSha256,
  extractionIsCurrent,
  extractorPromptSha256,
  withClassification,
  type Cassette,
} from '../src/cassette';
import { extractionInstruction } from '../src/claude';
import { SCHEMA_VERSION } from '../src/field';
import { CLASSIFY_SYSTEM } from '../src/prompt';
import { CLASSIFY_TEMPERATURE, classifyTemperatureFor } from '../src/models';

const recorded: Cassette = {
  key: 'service-order',
  docType: 'price_agreement',
  classifiedAs: 'po',
  classifierConfidence: 0.95,
  document: { agreement_type: { value: 'TERMS', confidence: 0.9, source_page: 1, source_quote: 'TERMS' } },
  recordedWith: 'claude-sonnet-5',
  recordedAt: '2026-09-22T20:39:09.088Z',
  call: {
    modelVersion: 'claude-sonnet-5',
    inputTokens: 3_987,
    outputTokens: 876,
    costMicros: 16_734,
    latencyMs: 6_730,
  },
  ocr: {
    provider: 'reducto',
    pages: [{ page: 1, text: 'TERMS' }],
    blocks: [],
    credits: 0,
    latencyMs: 10,
  },
};

const stamp = (
  model: string,
  system: string = CLASSIFY_SYSTEM,
  temperature: number | null | 'absent' = classifyTemperatureFor(model),
) => ({
  model,
  promptSha256: classifierPromptSha256(system),
  ...(temperature !== 'absent' ? { temperature } : {}),
  classifiedAt: '2026-09-23T00:00:00.000Z',
});

describe('what answered a recorded classification', () => {
  it('names the prompt by a hash that moves when one character of it does', () => {
    expect(classifierPromptSha256()).toMatch(/^[0-9a-f]{64}$/);
    expect(classifierPromptSha256()).toBe(classifierPromptSha256(CLASSIFY_SYSTEM));
    expect(classifierPromptSha256(`${CLASSIFY_SYSTEM} `)).not.toBe(classifierPromptSha256());
  });

  it('does not call a classification current when nothing recorded what answered it', () => {
    // Every cassette recorded before stamps existed. Nothing says which prompt
    // answered them, so nothing may say it was this one.
    expect(classificationIsCurrent(recorded, 'claude-haiku-4-5')).toBe(false);
  });

  it('calls it current only for the same model under the same prompt', () => {
    const stamped = { ...recorded, classifier: stamp('claude-haiku-4-5') };
    expect(classificationIsCurrent(stamped, 'claude-haiku-4-5')).toBe(true);
    expect(classificationIsCurrent(stamped, 'claude-sonnet-5')).toBe(false);
    expect(classificationIsCurrent(stamped, 'claude-haiku-4-5', `${CLASSIFY_SYSTEM}\nMore.`)).toBe(
      false,
    );
  });

  it('calls an answer given before the temperature was pinned not current', () => {
    // A stamp from before the pin records no temperature: that answer was one
    // sample of several, and nothing says this checkout would give it.
    const unpinned = { ...recorded, classifier: stamp('claude-haiku-4-5', CLASSIFY_SYSTEM, 'absent') };
    expect(classificationIsCurrent(unpinned, 'claude-haiku-4-5')).toBe(false);
    const other = { ...recorded, classifier: stamp('claude-haiku-4-5', CLASSIFY_SYSTEM, 0.7) };
    expect(classificationIsCurrent(other, 'claude-haiku-4-5')).toBe(false);
  });
});

describe('what read a recorded extraction', () => {
  const extractor = (docType: Cassette['docType'], overrides: Record<string, string> = {}) => ({
    model: 'claude-sonnet-5',
    promptSha256: extractorPromptSha256(docType),
    schemaVersion: SCHEMA_VERSION,
    extractedAt: '2026-09-24T00:00:00.000Z',
    ...overrides,
  });

  it('hashes the instruction per type, so one type’s change leaves the others current', () => {
    // A field added to the notice schema moves the notice's field list, and
    // nothing in any other type's instruction.
    expect(extractorPromptSha256('deduction_notice')).toMatch(/^[0-9a-f]{64}$/);
    expect(extractorPromptSha256('deduction_notice')).not.toBe(
      extractorPromptSha256('remittance_advice'),
    );
    expect(extractionInstruction('deduction_notice')).toContain('lines[N].deduction_reference');
    expect(extractionInstruction('invoice')).not.toContain('deduction_reference');
  });

  it('does not call an extraction current when nothing recorded what read it', () => {
    expect(extractionIsCurrent(recorded, 'claude-sonnet-5')).toBe(false);
  });

  it('calls it current only for the same model, schema version and instruction', () => {
    const stamped = { ...recorded, extractor: extractor('price_agreement') };
    expect(extractionIsCurrent(stamped, 'claude-sonnet-5')).toBe(true);
    expect(extractionIsCurrent(stamped, 'claude-opus-5-5')).toBe(false);
    expect(
      extractionIsCurrent({ ...recorded, extractor: extractor('price_agreement', { schemaVersion: '1.1.0' }) }, 'claude-sonnet-5'),
    ).toBe(false);
    // Read as another type's instruction: the stamp is for the type it was read as.
    expect(
      extractionIsCurrent({ ...recorded, extractor: extractor('invoice') }, 'claude-sonnet-5'),
    ).toBe(false);
  });
});

describe('re-classifying a cassette', () => {
  const answered = withClassification(
    recorded,
    { docType: 'price_agreement', confidence: 0.9 },
    stamp('claude-haiku-4-5'),
  );

  it('replaces the classification and says what gave it', () => {
    expect(answered.classifiedAs).toBe('price_agreement');
    expect(answered.classifierConfidence).toBe(0.9);
    expect(classificationIsCurrent(answered, 'claude-haiku-4-5')).toBe(true);
  });

  it('leaves the extraction, its cost and the OCR pages exactly as recorded', () => {
    // Re-reading them would spend money on a question nobody asked, and let
    // extraction noise move the field scores of a change to the classifier.
    const { classifiedAs, classifierConfidence, classifier, ...rest } = answered;
    const { classifiedAs: _a, classifierConfidence: _c, ...before } = recorded;
    expect(rest).toEqual(before);
    expect(answered.document).toBe(recorded.document);
    expect(answered.ocr).toBe(recorded.ocr);
    expect(answered.call).toBe(recorded.call);
    expect([classifiedAs, classifierConfidence, classifier?.model]).toEqual([
      'price_agreement',
      0.9,
      'claude-haiku-4-5',
    ]);
  });

  it('is what replay answers with', async () => {
    const replay = new CassetteClassifier(new Map([[answered.key, answered]]), (d) => d.documentId);
    const result = await replay.classify({
      documentId: 'service-order',
      orgId: 'eval',
      filename: 'service-order.pdf',
      mimeType: 'application/pdf',
      base64: '',
      byteSize: 0,
    });
    expect([result.docType, result.confidence]).toEqual(['price_agreement', 0.9]);
  });
});

describe('the classifier temperature', () => {
  it('is pinned at zero on the default classifier and on models that take sampling', () => {
    expect(CLASSIFY_TEMPERATURE).toBe(0);
    expect(classifyTemperatureFor('claude-haiku-4-5')).toBe(0);
    expect(classifyTemperatureFor('claude-sonnet-4-6')).toBe(0);
  });

  it('is not sent to a model that refuses sampling parameters', () => {
    // A 400 on every read would be worse than an unpinned classifier; the
    // stamp says `null` so the eval can tell the difference.
    for (const model of ['claude-sonnet-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-fable-5-1']) {
      expect(classifyTemperatureFor(model)).toBeNull();
    }
  });
});
