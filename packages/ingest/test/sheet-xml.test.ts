import { describe, expect, it } from 'vitest';
import { tokenizeXml, XmlDtdRefusedError } from '../src/sheet-xml';

describe('tokenizeXml', () => {
  it('reads elements, attributes and text', () => {
    const t = tokenizeXml('<?xml version="1.0"?><a x="1" y=\'two\'><b/>hi</a>');
    expect(t).toEqual([
      { kind: 'open', name: 'a', attrs: { x: '1', y: 'two' }, selfClosing: false },
      { kind: 'open', name: 'b', attrs: {}, selfClosing: true },
      { kind: 'text', text: 'hi' },
      { kind: 'close', name: 'a' },
    ]);
  });

  it('decodes the five named entities and numeric references', () => {
    const t = tokenizeXml('<t v="&quot;&apos;">&amp;&lt;&gt;&#65;&#x42;</t>');
    expect(t[0]).toMatchObject({ attrs: { v: `"'` } });
    expect(t[1]).toEqual({ kind: 'text', text: '&<>AB' });
  });

  it('refuses a DOCTYPE, an ENTITY (billion laughs, XXE) and CDATA', () => {
    expect(() => tokenizeXml('<!DOCTYPE a><a/>')).toThrow(XmlDtdRefusedError);
    expect(() =>
      tokenizeXml('<?xml version="1.0"?><!DOCTYPE l [<!ENTITY a "aaa"><!ENTITY b "&a;&a;">]><l>&b;</l>'),
    ).toThrow(XmlDtdRefusedError);
    expect(() => tokenizeXml('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>')).toThrow(
      XmlDtdRefusedError,
    );
    expect(() => tokenizeXml('<a><![CDATA[x]]></a>')).toThrow(XmlDtdRefusedError);
  });

  it('refuses an unknown entity', () => {
    expect(() => tokenizeXml('<a>&nbsp;</a>')).toThrow(/unknown entity/);
  });
});
