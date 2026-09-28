/**
 * The rule the worker holds its browser to before it takes a run (ADR 0057
 * §6, `src/sandbox.ts`): no `--no-sandbox`, and every renderer under a seccomp
 * filter in a PID namespace of its own. main.test.ts reads it off a real
 * browser; this is the rule on its own.
 */
import { describe, expect, it } from 'vitest';
import { sandboxFaults, type ChromiumProcess, type ChromiumTree } from '../src/sandbox';

const browser: ChromiumProcess = { pid: 100, type: 'browser', seccomp: 0, pidNamespaces: 1, noSandboxSwitch: false };
const sandboxedRenderer: ChromiumProcess = { pid: 120, type: 'renderer', seccomp: 2, pidNamespaces: 3, noSandboxSwitch: false };
// The browser, its zygotes, the GPU process and the network service are not renderers, and run as Chromium runs them.
const others: ChromiumProcess[] = [
  { pid: 101, type: 'zygote', seccomp: 0, pidNamespaces: 1, noSandboxSwitch: false },
  { pid: 102, type: 'gpu-process', seccomp: 0, pidNamespaces: 1, noSandboxSwitch: false },
  { pid: 103, type: 'utility', seccomp: 0, pidNamespaces: 1, noSandboxSwitch: false },
];
const tree = (over: Partial<ChromiumTree> = {}): ChromiumTree => ({ browser, descendants: [...others, sandboxedRenderer], ...over });

describe('sandboxFaults', () => {
  it('finds nothing wrong with a browser whose every renderer is filtered and in a namespace of its own', () => {
    expect(sandboxFaults(tree())).toEqual([]);
  });

  it.each([
    ['a browser started with --no-sandbox', tree({ browser: { ...browser, noSandboxSwitch: true } }), 'the browser was started with --no-sandbox'],
    ['no renderer to check', tree({ descendants: others }), 'no renderer was running to be checked'],
    ['a renderer with no seccomp filter', tree({ descendants: [...others, sandboxedRenderer, { ...sandboxedRenderer, pid: 121, seccomp: 0 }] }), 'a renderer runs without a seccomp filter'],
    ['a renderer whose seccomp state the kernel does not give', tree({ descendants: [...others, { ...sandboxedRenderer, seccomp: null }] }), 'a renderer runs without a seccomp filter'],
    ['a renderer in the machine\'s own PID namespace', tree({ descendants: [...others, { ...sandboxedRenderer, pidNamespaces: 1 }] }), 'a renderer shares the machine\'s PID namespace'],
  ])('names %s', (_what, t, fault) => {
    expect(sandboxFaults(t)).toContain(fault);
  });
});
