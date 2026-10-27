import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseSource } from '../src/diagnostics.ts';

const clean = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>';

test('clean safe-svg produces no diagnostics', () => {
  assert.deepEqual(diagnoseSource(clean), []);
});

test('hostile SVG: script, event handler and style are flagged', () => {
  const hostile = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1" onclick="x()" style="fill:red"/></svg>';
  const codes = diagnoseSource(hostile).map(d => `${d.code}`);
  assert.ok(codes.includes('unsupported-element'), 'script element');
  const attrs = diagnoseSource(hostile).filter(d => d.code === 'unsupported-attribute').map(d => d.message);
  assert.ok(attrs.some(m => m.includes('onclick')));
  assert.ok(attrs.some(m => m.includes('style')));
});

test('external references are flagged, local fragments are not', () => {
  const ext = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" fill="url(http://evil.example/x)"/></svg>';
  assert.ok(diagnoseSource(ext).some(d => d.code === 'external-reference'));
  const local = '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="1" height="1" fill="url(#g)"/></svg>';
  assert.deepEqual(diagnoseSource(local), []);
});

test('DOCTYPE is a forbidden construct', () => {
  assert.ok(diagnoseSource('<!DOCTYPE svg [<!ENTITY x "y">]>' + clean).some(d => d.code === 'forbidden-construct'));
});

test('unknown element and attribute are flagged with positions', () => {
  const src = '<svg xmlns="http://www.w3.org/2000/svg">\n<image href="x.png" class="y"/></svg>';
  const diags = diagnoseSource(src);
  assert.ok(diags.some(d => d.code === 'unsupported-element' && d.offset > 10));
});
