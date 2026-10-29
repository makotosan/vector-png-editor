import test from 'node:test';
import assert from 'node:assert/strict';
import { PreviewController, PreviewInvalidError, PreviewUnavailableError, PREVIEW_DEBOUNCE_MS } from '../src/preview.ts';
import { validateWebviewMessage } from '../src/messages.ts';

function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => { const id = nextId++; pending.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id) => { pending.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, job] of [...pending.entries()].sort((a, b) => a[1].at - b[1].at))
        if (job.at <= now) { pending.delete(id); job.fn(); }
    },
  };
}
const flush = () => new Promise(r => setImmediate(r));

test('renders only after 300ms idle, once, with the latest source', async () => {
  const timers = fakeTimers();
  const calls = [];
  const events = [];
  const c = new PreviewController(async (source, revision) => { calls.push([source, revision]); return '/tmp/p.png'; },
    e => events.push(e), timers);
  assert.equal(PREVIEW_DEBOUNCE_MS, 300);
  c.schedule('v1', 1);
  timers.advance(100);
  c.schedule('v2', 2);
  timers.advance(100);
  c.schedule('v3', 3);
  timers.advance(299);
  await flush();
  assert.equal(calls.length, 0, 'nothing renders before 300ms idle');
  timers.advance(1);
  await flush();
  assert.deepEqual(calls, [['v3', 3]]);
  assert.deepEqual(events, [{ type: 'rendered', revision: 3, imageUri: '/tmp/p.png' }]);
  c.dispose();
});

test('out-of-order worker results: the stale render is discarded', async () => {
  const timers = fakeTimers();
  const events = [];
  const resolvers = new Map();
  const c = new PreviewController((source, revision) => new Promise(res => resolvers.set(revision, res)),
    e => events.push(e), timers);
  c.schedule('old', 1);
  timers.advance(300);
  c.schedule('new', 2);
  timers.advance(300);
  resolvers.get(2)('/tmp/new.png');           // newer finishes first
  await flush();
  resolvers.get(1)('/tmp/old.png');           // stale finishes later
  await flush();
  assert.deepEqual(events, [{ type: 'rendered', revision: 2, imageUri: '/tmp/new.png' }]);
  c.dispose();
});

test('a render superseded before it starts never runs twice and late errors are dropped', async () => {
  const timers = fakeTimers();
  const events = [];
  let rejectFirst;
  const c = new PreviewController((source, revision) => revision === 1
    ? new Promise((_, rej) => { rejectFirst = rej; })
    : Promise.resolve('/tmp/ok.png'), e => events.push(e), timers);
  c.schedule('bad-old', 1);
  timers.advance(300);
  c.schedule('good', 2);
  timers.advance(300);
  await flush();
  rejectFirst(new PreviewInvalidError('stale failure'));
  await flush();
  assert.deepEqual(events, [{ type: 'rendered', revision: 2, imageUri: '/tmp/ok.png' }]);
  c.dispose();
});

test('invalid source emits invalid and never a rendered image', async () => {
  const timers = fakeTimers();
  const events = [];
  const c = new PreviewController(async () => { throw new PreviewInvalidError('script element is not allowed'); },
    e => events.push(e), timers);
  c.schedule('<svg><script/></svg>', 1);
  timers.advance(300);
  await flush();
  assert.deepEqual(events, [{ type: 'invalid', revision: 1, message: 'script element is not allowed' }]);
  c.dispose();
});

test('unavailable renderer is reported distinctly', async () => {
  const timers = fakeTimers();
  const events = [];
  const c = new PreviewController(async () => { throw new PreviewUnavailableError('no core'); }, e => events.push(e), timers);
  c.schedule('<svg/>', 1);
  timers.advance(300);
  await flush();
  assert.equal(events[0].type, 'unavailable');
  c.dispose();
});

test('setPreviewMode messages validate strictly', () => {
  assert.deepEqual(validateWebviewMessage({ type: 'setPreviewMode', mode: 'edited' }),
    { ok: true, message: { type: 'setPreviewMode', mode: 'edited' } });
  assert.equal(validateWebviewMessage({ type: 'setPreviewMode', mode: 'auto' }).ok, false);
  assert.equal(validateWebviewMessage({ type: 'setPreviewMode' }).ok, false);
});
