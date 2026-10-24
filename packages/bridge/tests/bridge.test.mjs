import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runCore, LatestValidation } from '../src/core.ts';

const python = process.env.VECTOR_PNG_PYTHON ?? 'python';
const fake = fileURLToPath(new URL('./fake-core/', import.meta.url));
const real = fileURLToPath(new URL('../../core/src/', import.meta.url));
const options = {env: {...process.env, PYTHONPATH: fake}};
const request = input => ({protocol: 1, command: 'validate', request_id: 'test-1', input});

test('bounded diagnostics are separate from the response', async () => {
  const report = await runCore(python, request('stderr'), options);
  assert.equal(report.response.ok, true);
  assert.equal(report.diagnostics, 'a bounded diagnostic');
});
test('Core failure remains a typed response with a consistent exit', async () => {
  const report = await runCore(python, request('core-error'), options);
  assert.equal(report.response.error.code, 'invalid-svg');
});
for (const mode of ['wrong-id', 'bad-success', 'invalid-json', 'invalid-utf8']) {
  test(`reject ${mode}`, async () => {
    await assert.rejects(runCore(python, request(mode), options), {code: 'protocol-error'});
  });
}
for (const mode of ['stdout-limit', 'stderr-limit']) {
  test(`stop excessive ${mode}`, async () => {
    await assert.rejects(runCore(python, request(mode), options), {code: 'output-limit'});
  });
}
test('timeout stops a read-only process', async () => {
  await assert.rejects(runCore(python, request('slow'), {...options, timeoutMs: 150}), {code: 'timeout'});
});
test('pre-aborted request never launches', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runCore('does-not-exist', request('slow'), {signal: controller.signal}), {code: 'cancelled'});
});
test('latest preview ignores cancelled old work', async () => {
  const lane = new LatestValidation();
  const old = lane.run(python, request('slow'), options);
  const latest = lane.run(python, {...request('quick'), request_id: 'test-2'}, options);
  assert.equal(await old, undefined);
  assert.equal((await latest).response.request_id, 'test-2');
  lane.dispose();
});
test('save operations reject preview cancellation before launch', async () => {
  await assert.rejects(runCore('does-not-exist', {...request('a.svg'), command: 'build', output: 'a.png'},
    {signal: new AbortController().signal}), {code: 'invalid-request'});
});
test('missing Python is actionable and bounded', async () => {
  await assert.rejects(runCore('vector-png-nonexistent-python', request('quick')), {code: 'launch-failed'});
});
test('oversized request never launches', async () => {
  await assert.rejects(runCore('does-not-exist', {...request('quick'), source_base64: 'x'.repeat(2_000_001)}), {code: 'invalid-request'});
});
test('real Python accepts unchanged inline source and echoes revision ID', async () => {
  const source = Buffer.from('\ufeff<?xml version="1.0" encoding="UTF-8"?>\r\n<svg xmlns="http://www.w3.org/2000/svg"/>');
  const report = await runCore(python, {protocol: 1, command: 'validate', request_id: 'real-revision',
    source_base64: source.toString('base64'), syntax_only: true}, {env: {...process.env, PYTHONPATH: real}});
  assert.equal(report.response.result.svg_bytes, source.length);
  assert.equal(report.response.result.render, 'not-checked');
});
