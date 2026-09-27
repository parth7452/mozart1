import type { PipelineDeps, PipelineStore } from '@recouple/pipeline';

/**
 * The deps `reconcileCase` needs on a request path that only reads: the store,
 * and a scanner, classifier and extractor that refuse loudly if anything ever
 * asks them to do work. Shared by the case page and the packet route, so both
 * reconcile the case the same way.
 */
export function reviewPipelineDeps(store: PipelineStore): PipelineDeps {
  return {
    store,
    scanner: {
      name: 'none',
      async scan() {
        throw new Error('a review page does not scan');
      },
    },
    classifier: {
      async classify() {
        throw new Error('a review page does not classify');
      },
    },
    extractor: {
      name: 'none',
      async extract() {
        throw new Error('a review page does not extract');
      },
    },
    now: () => new Date(),
  };
}
