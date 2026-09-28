// Whether the browser this process started is sandboxed, as Linux shows it in
// /proc (ADR 0057 §6). The switches a browser was given say what was asked
// for; this reads what the kernel says each of its renderers is running under:
//  - a seccomp-bpf filter (`Seccomp: 2` in /proc/<pid>/status), which is what
//    keeps a renderer from opening a file, another process's /proc entries
//    among them;
//  - a PID namespace of its own (`NSpid` naming more than one pid), in which
//    no other process on the machine is visible.
// A renderer is the process that parses and runs a portal's pages, so it is
// the one an exploit from a page lands in.
//
// Only /proc/<pid>/status and /proc/<pid>/cmdline are read, which any process
// may read of any other. A sandboxed renderer is not dumpable, so its environ,
// exe and memory are closed even to its own user; nothing here asks for them.
import { readFileSync, readdirSync } from 'node:fs';

export interface ChromiumProcess {
  readonly pid: number;
  /** Chromium's `--type=` switch, or `browser` for the process Playwright launched. */
  readonly type: string;
  /** The seccomp mode: 0 none, 1 strict, 2 a filter. Null when the kernel does not say. */
  readonly seccomp: number | null;
  /** How many PID namespaces deep it is: 1 for the machine's own, more for one of its own. */
  readonly pidNamespaces: number;
  /** Whether its command line holds `--no-sandbox`. */
  readonly noSandboxSwitch: boolean;
}

/** One browser this process started, and every process under it. */
export interface ChromiumTree {
  readonly browser: ChromiumProcess;
  readonly descendants: readonly ChromiumProcess[];
}

interface ProcEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly status: string;
  readonly cmdline: string;
}

/** Every process /proc shows now. One that ends while it is read is left out. */
function processes(): ProcEntry[] {
  const entries: ProcEntry[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const status = readFileSync(`/proc/${name}/status`, 'utf8');
      const cmdline = readFileSync(`/proc/${name}/cmdline`, 'utf8');
      entries.push({ pid: Number(name), ppid: Number(/^PPid:\s*(\d+)/m.exec(status)?.[1] ?? -1), status, cmdline });
    } catch {
      // It ended between the listing and the read: it is not a process any more.
    }
  }
  return entries;
}

function describe(entry: ProcEntry, type: string): ChromiumProcess {
  const seccomp = /^Seccomp:\s*(\d)/m.exec(entry.status)?.[1];
  const nspid = /^NSpid:\s*(.*)$/m.exec(entry.status)?.[1]?.trim().split(/\s+/) ?? [];
  return {
    pid: entry.pid,
    type,
    seccomp: seccomp === undefined ? null : Number(seccomp),
    pidNamespaces: Math.max(nspid.length, 1),
    // A renderer's command line is rewritten to one string; the browser's is one argument per NUL.
    noSandboxSwitch: /(?:^|[\s\0])--no-sandbox(?=[\s\0=]|$)/.test(entry.cmdline),
  };
}

/**
 * The browsers `parentPid` started and that are running now: its children
 * launched with Playwright's pipe (`--remote-debugging-pipe`), each with the
 * processes under it. Linux only; elsewhere there is no /proc to read.
 */
export function chromiumTrees(parentPid: number): ChromiumTree[] {
  const children = new Map<number, ProcEntry[]>();
  for (const entry of processes()) {
    const siblings = children.get(entry.ppid);
    if (siblings === undefined) children.set(entry.ppid, [entry]);
    else siblings.push(entry);
  }
  const under = (pid: number): ProcEntry[] => (children.get(pid) ?? []).flatMap((child) => [child, ...under(child.pid)]);
  return (children.get(parentPid) ?? [])
    .filter((entry) => entry.cmdline.split('\0').includes('--remote-debugging-pipe'))
    .map((browser) => ({
      browser: describe(browser, 'browser'),
      descendants: under(browser.pid).map((entry) => describe(entry, /--type=([a-z0-9-]+)/.exec(entry.cmdline)?.[1] ?? 'unknown')),
    }));
}

/**
 * The one browser `parentPid` started, read again until its sandbox shows no
 * fault or `timeoutMs` passes, and the last reading. A renderer is forked by
 * Chromium's zygote a moment before it turns its seccomp filter on, so one
 * read in that moment shows none; and a filter, once on, never comes off. So a
 * fault that lasts the whole time is a real one, and the caller reports it.
 * Undefined when there is not exactly one browser to read.
 */
export async function settledChromiumTree(
  parentPid: number,
  options: { readonly timeoutMs: number; readonly intervalMs?: number; readonly until?: (tree: ChromiumTree) => boolean },
): Promise<ChromiumTree | undefined> {
  const deadline = Date.now() + options.timeoutMs;
  const done = options.until ?? ((tree: ChromiumTree) => sandboxFaults(tree).length === 0);
  let last: ChromiumTree | undefined;
  for (;;) {
    const trees = chromiumTrees(parentPid);
    last = trees.length === 1 ? trees[0] : undefined;
    if (last !== undefined && done(last)) return last;
    if (Date.now() >= deadline) return last;
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 50));
  }
}

/**
 * What is wrong with a browser's sandbox, as rules and never values: empty
 * when its command line did not turn the sandbox off, it has at least one
 * renderer, and every renderer runs under a seccomp filter in a PID namespace
 * of its own.
 */
export function sandboxFaults(tree: ChromiumTree): string[] {
  const faults: string[] = [];
  if (tree.browser.noSandboxSwitch) faults.push('the browser was started with --no-sandbox');
  const renderers = tree.descendants.filter((p) => p.type === 'renderer');
  if (renderers.length === 0) faults.push('no renderer was running to be checked');
  if (renderers.some((p) => p.seccomp !== 2)) faults.push('a renderer runs without a seccomp filter');
  if (renderers.some((p) => p.pidNamespaces < 2)) faults.push('a renderer shares the machine\'s PID namespace');
  return faults;
}
