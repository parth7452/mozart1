/**
 * Where a tenant's recipe may send the shared worker's browser (ADR 0057 §6):
 * public destinations only, read as the browser reads a host; every URL a
 * step names held to the guard's own rule; https throughout; and loopback,
 * over plain http, only for a test's worker, whose fixture portal listens
 * there.
 */
import { describe, expect, it } from 'vitest';
import { parseRecipe } from '../../../packages/portal/src/recipe';
import {
  PUBLIC_DESTINATIONS_ONLY,
  destinationRefusal,
  isPublicHostname,
  namesNonPublicHost,
  stepUrls,
  type DestinationPolicy,
} from '../src/destinations';
import type { RecipeStep, RecipeVersion } from '../src/portal';

const TEST_WORKER: DestinationPolicy = { allowLoopback: true };
/** A host as a recipe's allowlist spells it, read as the browser would read it. */
const hostnameOf = (host: string): string => new URL(`http://${host}`).hostname;

describe('isPublicHostname', () => {
  it.each([
    'service.ariba.com',
    'supplier.ariba.com:443',
    'accounts.sap.com',
    'portal.example.com',
    'portal.example.com.',
    'xn--nxasmq6b.com',
    '8.8.8.8',
    '1.1.1.1:8443',
    '[2606:4700:4700::1111]',
  ])('admits %s', (host) => {
    expect(isPublicHostname(hostnameOf(host), PUBLIC_DESTINATIONS_ONLY)).toBe(true);
  });

  it.each([
    // Loopback, however it is spelled: the browser reads each of these as 127.0.0.1.
    ['127.0.0.1', 'loopback'],
    ['127.1', 'loopback, short form'],
    ['2130706433', 'loopback, as one number'],
    ['0x7f.1', 'loopback, in hex'],
    ['017700000001', 'loopback, in octal'],
    ['[::1]', 'IPv6 loopback'],
    ['localhost', 'loopback by name'],
    ['portal.localhost', 'a subdomain of localhost'],
    // The operator's own network.
    ['10.0.0.5', 'private'],
    ['172.16.8.1', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'shared address space'],
    ['169.254.169.254', 'link-local: a cloud metadata service'],
    ['0.0.0.0', 'this network'],
    ['0', 'this network, as one number'],
    ['224.0.0.251', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['[fdaa:0:1:a7b::2]', 'unique-local IPv6: Fly\'s private network'],
    ['[fe80::1]', 'link-local IPv6'],
    ['[::ffff:127.0.0.1]', 'IPv4-mapped loopback'],
    ['[::ffff:a9fe:a9fe]', 'IPv4-mapped link-local'],
    ['[64:ff9b::a9fe:a9fe]', 'NAT64 carrying a link-local address'],
    ['[2002:a9fe:a9fe::1]', '6to4 carrying a link-local address'],
    ['[2001:db8::1]', 'IPv6 documentation'],
    ['[ff02::1]', 'IPv6 multicast'],
    // Names only a private resolver answers.
    ['my-app.internal', 'Fly\'s private DNS'],
    ['top1.nearest.of.my-app.internal', 'Fly\'s private DNS, deeper'],
    ['my-app.flycast', 'Fly\'s private proxy'],
    ['printer.local', 'mDNS'],
    ['router.home.arpa', 'a home network'],
    ['metadata', 'a name with no dot, completed by the resolver\'s search domains'],
    ['vault.', 'a name with no dot but the root'],
  ])('refuses %s (%s)', (host) => {
    expect(isPublicHostname(hostnameOf(host), PUBLIC_DESTINATIONS_ONLY)).toBe(false);
  });

  it('admits loopback for a test\'s worker, and nothing else it refuses', () => {
    for (const host of ['127.0.0.1', '127.0.0.1:4000', '[::1]', '2130706433']) {
      expect(isPublicHostname(hostnameOf(host), TEST_WORKER)).toBe(true);
    }
    for (const host of ['localhost', '10.0.0.5', '169.254.169.254', 'my-app.internal', '[fdaa::3]', '[::ffff:127.0.0.1]']) {
      expect(isPublicHostname(hostnameOf(host), TEST_WORKER)).toBe(false);
    }
  });
});

describe('namesNonPublicHost', () => {
  const recipe = (hostAllowlist: string[], origin: string) => ({ hostAllowlist, signIn: { origin, formPaths: ['/login'], mfaPaths: [], acsPaths: [] } });

  it('passes a recipe whose every host is public', () => {
    expect(namesNonPublicHost(recipe(['service.ariba.com', 'accounts.sap.com'], 'https://accounts.sap.com'), PUBLIC_DESTINATIONS_ONLY)).toBe(false);
  });

  it('refuses a recipe with one internal host among public ones', () => {
    expect(namesNonPublicHost(recipe(['service.ariba.com', '169.254.169.254'], 'https://service.ariba.com'), PUBLIC_DESTINATIONS_ONLY)).toBe(true);
    expect(namesNonPublicHost(recipe(['service.ariba.com', 'db.internal:5432'], 'https://service.ariba.com'), PUBLIC_DESTINATIONS_ONLY)).toBe(true);
  });

  it('asks the sign-in origin too, rather than trusting the schema to have put it on the allowlist', () => {
    expect(namesNonPublicHost(recipe(['service.ariba.com'], 'http://10.1.2.3:8080'), PUBLIC_DESTINATIONS_ONLY)).toBe(true);
  });

  it('refuses a host the URL parser reads nothing from', () => {
    expect(namesNonPublicHost(recipe(['256.1.1.1'], 'https://service.ariba.com'), PUBLIC_DESTINATIONS_ONLY)).toBe(true);
    expect(namesNonPublicHost(recipe(['service.ariba.com'], 'not a url'), PUBLIC_DESTINATIONS_ONLY)).toBe(true);
  });

  it('lets a test\'s worker reach its fixture portal on loopback', () => {
    expect(namesNonPublicHost(recipe(['127.0.0.1:4000'], 'http://127.0.0.1:4000'), TEST_WORKER)).toBe(false);
    expect(namesNonPublicHost(recipe(['127.0.0.1:4000'], 'http://127.0.0.1:4000'), PUBLIC_DESTINATIONS_ONLY)).toBe(true);
  });
});

describe('destinationRefusal', () => {
  const HTTPS = 'https://service.ariba.com';
  const LOOPBACK = 'http://127.0.0.1:4000';
  /** A recipe as a person would promote one, signing in at `origin`, whose allowlist is `hosts`. */
  const recipe = (origin: string, steps: RecipeStep[], hosts: string[] = [new URL(origin).host]): RecipeVersion =>
    parseRecipe({
      portalKey: 'sap_business_network',
      version: 1,
      effectiveFrom: '2026-09-28',
      hostAllowlist: hosts,
      signIn: { origin, formPaths: ['/login'], mfaPaths: ['/mfa'], acsPaths: [] },
      neverClick: [],
      postAsRead: [],
      caps: { maxPages: 5, maxDownloads: 0, maxRunMs: 60_000 },
      provenance: { draftedBy: { kind: 'person', id: 'destinations-test' }, source: 'test', portalAdr: '0062' },
      steps,
    });
  const open = (url: string): RecipeStep => ({ kind: 'open', name: 'start', url });
  const search = (recordedAction: string): RecipeStep => ({ kind: 'search', name: 'find', formSelector: '#search', fields: {}, recordedMethod: 'post', recordedAction });
  const signInAt = (url: string): RecipeStep[] => [open(url), { kind: 'sign_in' }, { kind: 'capture_page', name: 'landing' }];

  it('passes a recipe whose every host is public and whose every URL is https on its allowlist', () => {
    const r = recipe(HTTPS, [...signInAt(`${HTTPS}/login`), search(`${HTTPS}/search?view=deductions`)], ['service.ariba.com', 'accounts.sap.com']);
    expect(destinationRefusal(r, PUBLIC_DESTINATIONS_ONLY)).toBeNull();
    // Uppercase and a default port are the same URL to the browser, and to the guard.
    expect(destinationRefusal(recipe(HTTPS, signInAt('HTTPS://SERVICE.ARIBA.COM:443/login')), PUBLIC_DESTINATIONS_ONLY)).toBeNull();
  });

  it.each([
    ['data:text/html,<p>a remittance nobody sent</p>', 'a data: page, written by the recipe'],
    ['about:blank', 'an empty page'],
    ['chrome://version', 'a page of the browser\'s own'],
    ["javascript:document.write('x')", 'script the recipe wrote'],
    ['file:///proc/self/environ', 'a local file'],
    ['view-source:https://service.ariba.com/login', 'a page\'s source'],
    ['blob:https://service.ariba.com/7f1c', 'a blob'],
    ['ftp://service.ariba.com/statement.pdf', 'ftp'],
    ['wss://service.ariba.com/socket', 'a WebSocket'],
    ['https://elsewhere.example.net/login', 'a host off the allowlist'],
    ['https://service.ariba.com:8443/login', 'its own host, on a port the allowlist does not name'],
    ['https://service.ariba.com./login', 'its own host, spelled with the root\'s dot'],
    ['https://svc.reader:pw@service.ariba.com/login', 'a user name and a password in the URL'],
    ['https://svc.reader@service.ariba.com/login', 'a user name in the URL'],
  ])('refuses an open step to %s (%s), whatever the policy', (url) => {
    for (const policy of [PUBLIC_DESTINATIONS_ONLY, TEST_WORKER]) {
      expect(destinationRefusal(recipe(HTTPS, signInAt(url)), policy)).toBe('step_url_not_allowed');
    }
  });

  it('asks a search step\'s recorded action, and the steps inside a for_each', () => {
    expect(destinationRefusal(recipe(HTTPS, [...signInAt(`${HTTPS}/login`), search('https://elsewhere.example.net/search')]), PUBLIC_DESTINATIONS_ONLY)).toBe('step_url_not_allowed');
    expect(destinationRefusal(recipe(HTTPS, [...signInAt(`${HTTPS}/login`), search('data:text/plain,x')]), PUBLIC_DESTINATIONS_ONLY)).toBe('step_url_not_allowed');
    const nested: RecipeStep = {
      kind: 'for_each',
      name: 'rows',
      rowSelector: 'tr',
      maxRows: 3,
      steps: [{ kind: 'for_each', name: 'cells', rowSelector: 'td', maxRows: 2, steps: [{ kind: 'open', name: 'cell', url: 'about:blank' }] }],
    };
    expect(destinationRefusal(recipe(HTTPS, [...signInAt(`${HTTPS}/login`), nested]), PUBLIC_DESTINATIONS_ONLY)).toBe('step_url_not_allowed');
  });

  it('refuses plain http on a public host, for the sign-in origin or any step, whatever the policy', () => {
    const httpOrigin = 'http://service.ariba.com';
    for (const policy of [PUBLIC_DESTINATIONS_ONLY, TEST_WORKER]) {
      expect(destinationRefusal(recipe(httpOrigin, signInAt(`${HTTPS}/login`)), policy)).toBe('not_https');
      expect(destinationRefusal(recipe(HTTPS, signInAt(`${httpOrigin}/login`)), policy)).toBe('not_https');
      expect(destinationRefusal(recipe(HTTPS, [...signInAt(`${HTTPS}/login`), search(`${httpOrigin}/search`)]), policy)).toBe('not_https');
    }
    // A sign-in origin the binding could not even describe is not https either.
    expect(destinationRefusal(recipe('ftp://service.ariba.com', signInAt(`${HTTPS}/login`)), PUBLIC_DESTINATIONS_ONLY)).toBe('not_https');
  });

  it('admits plain http to loopback for a test\'s worker alone', () => {
    const fixture = recipe(LOOPBACK, [...signInAt(`${LOOPBACK}/login.html`), search(`${LOOPBACK}/search`)]);
    expect(destinationRefusal(fixture, TEST_WORKER)).toBeNull();
    expect(destinationRefusal(recipe('https://127.0.0.1:4443', signInAt('https://127.0.0.1:4443/login.html')), TEST_WORKER)).toBeNull();
    expect(destinationRefusal(fixture, PUBLIC_DESTINATIONS_ONLY)).toBe('host_not_public');
  });

  it('names the first rule broken: a host before a step URL, a step URL before its scheme', () => {
    const everything = recipe('http://service.ariba.com', signInAt('data:text/html,x'), ['service.ariba.com', '10.0.0.5']);
    expect(destinationRefusal(everything, PUBLIC_DESTINATIONS_ONLY)).toBe('host_not_public');
    expect(destinationRefusal(recipe('http://service.ariba.com', signInAt('data:text/html,x')), PUBLIC_DESTINATIONS_ONLY)).toBe('step_url_not_allowed');
  });
});

describe('stepUrls', () => {
  it('lists every open step\'s URL and search step\'s recorded action, in order, for_each bodies included', () => {
    const steps: RecipeStep[] = [
      { kind: 'open', name: 'start', url: 'https://service.ariba.com/login' },
      { kind: 'sign_in' },
      { kind: 'follow', name: 'deductions', label: 'Deductions' },
      {
        kind: 'for_each',
        name: 'rows',
        rowSelector: 'tr',
        maxRows: 2,
        steps: [
          { kind: 'search', name: 'find', formSelector: '#search', fields: {}, recordedMethod: 'post', recordedAction: 'https://service.ariba.com/search' },
          { kind: 'open', name: 'row', url: 'https://service.ariba.com/row' },
        ],
      },
      { kind: 'download', name: 'export', label: 'Export' },
    ];
    expect(stepUrls(steps)).toEqual(['https://service.ariba.com/login', 'https://service.ariba.com/search', 'https://service.ariba.com/row']);
  });
});
