import { randomUUID } from 'node:crypto';
import type {
  InboundClaim,
  InboundMessageRecord,
  InboundMessageStore,
  InboundPartRecord,
  InboundProvider,
  RecordedInboundPart,
} from '../inbound-ports';
import type { InMemoryStore } from './memory-store';

interface RecordedMessage extends InboundMessageRecord {
  readonly id: string;
  readonly receivedAt: Date;
  readonly parts: readonly InboundPartRecord[];
}

/**
 * Email-in's store, in memory, for pipeline tests. Never reaches production
 * (`@recouple/pipeline/testing`).
 *
 * It keeps the one rule the database's record door enforces that a test would
 * otherwise never meet: a part recorded `stored` must name a document whose
 * arrival is the email's own door. The acting-member and retired-address
 * rules are the database's and are proven by suite 30.
 */
export class InMemoryInboundStore implements InboundMessageStore {
  readonly messages: RecordedMessage[] = [];
  private readonly claimsHeld = new Set<string>();
  /** A test can fill the pool, to see a delivery answered at once. */
  poolFull = false;

  constructor(
    private readonly orgId: string,
    private readonly store: InMemoryStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async withMessageClaim<T>(
    provider: InboundProvider,
    providerMessageId: string,
    work: () => Promise<T>,
  ): Promise<InboundClaim<T>> {
    if (this.poolFull) return { claimed: false, reason: 'no_connection' };
    const key = `${this.orgId}:${provider}:${providerMessageId}`;
    if (this.claimsHeld.has(key)) return { claimed: false, reason: 'held' };
    this.claimsHeld.add(key);
    try {
      return { claimed: true, result: await work() };
    } finally {
      this.claimsHeld.delete(key);
    }
  }

  async receivedMessage(provider: InboundProvider, providerMessageId: string) {
    return this.messages.find(
      (m) => m.provider === provider && m.providerMessageId === providerMessageId && m.outcome === 'received',
    )?.id;
  }

  async recordInboundMessage(
    message: InboundMessageRecord,
    parts: readonly InboundPartRecord[],
  ): Promise<string> {
    const existing = this.messages.find(
      (m) =>
        m.provider === message.provider &&
        m.providerMessageId === message.providerMessageId &&
        m.outcome === message.outcome,
    );
    if (existing !== undefined) return existing.id;
    for (const part of parts) {
      if (part.outcome !== 'stored') continue;
      const source =
        part.documentId === undefined ? undefined : await this.store.uploadSourceFor(part.documentId);
      const expected = part.kind === 'body' ? 'email_body' : 'email_in';
      if (source !== expected) {
        throw new Error(`part ${part.ordinal} is recorded as stored and did not arrive by email`);
      }
    }
    const id = randomUUID();
    this.messages.push({ ...message, id, receivedAt: this.clock(), parts });
    return id;
  }

  async inboundMessageParts(inboundMessageId: string): Promise<readonly RecordedInboundPart[]> {
    const message = this.messages.find((m) => m.id === inboundMessageId);
    return (message?.parts ?? []).map((part) => ({ ...part, inboundMessageId }));
  }

  async inboundReadsLastDay(now: Date): Promise<number> {
    const since = now.getTime() - 24 * 60 * 60 * 1000;
    return this.messages
      .filter((m) => m.receivedAt.getTime() > since)
      .flatMap((m) => m.parts)
      .filter((p) => p.outcome === 'stored' || p.outcome === 'already_held').length;
  }
}
