import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPusher, pushFor } from '../bridge/remote-push.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('what becomes a notification', () => {
  const turn = () => ({ ms: 60_000, prompt: 'fix the login bug' });
  assert.deepEqual(pushFor('message', { state: 'done', session: 's', harness: 'claude', label: 'shop' }, { turn }),
    { kind: 'done', title: 'Claude is done · shop', body: '“fix the login bug”', tag: 'done-s' });
  assert.equal(pushFor('message', { state: 'done', session: 's' }, { turn: () => ({ ms: 2000 }) }), null); // too quick to matter
  assert.equal(pushFor('message', { state: 'done', session: 's' }), null);
  assert.equal(pushFor('message', { state: 'working', session: 's' }), null);
  const waiting = pushFor(null, { state: 'waiting', session: 's', harness: 'codex', text: 'Run tests?' });
  assert.equal(waiting.kind, 'waiting');
  assert.equal(waiting.delay, 20_000);
  assert.equal(pushFor('approval', { status: 'expired', id: 'x' }), null);
  assert.equal(pushFor('approval', { status: 'pending', id: 'abcdefgh', harness: 'claude', kind: 'run', command: 'npm install' }).title, 'Claude wants to run a command');
  assert.equal(pushFor('stuck', { session: 's', text: 'same error 3 times' }).kind, 'stuck');
  assert.equal(pushFor('loop', { kind: 'told', text: 'x' }), null);
  assert.equal(pushFor('loop', { kind: 'gave-up', text: 'x' }).kind, 'loop');
  assert.equal(pushFor('context', { known: true, used: 50, size: 100 }), null);
  assert.equal(pushFor('context', { known: true, used: 95, size: 100, session: 's' }).kind, 'context');
  assert.equal(pushFor('activity', { id: 'x' }), null);
  assert.equal(pushFor('stuck', null), null);
});

test('secrets are redacted from what leaves the computer', () => {
  const item = pushFor('approval', { status: 'pending', id: 'abcdefgh', kind: 'run', command: 'curl -H "Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" https://x.io' });
  assert.ok(!item.body.includes('abcdefghijklmnopqrstuvwxyz0123456789'), item.body);
});

function rig(devices, opts = {}) {
  const sent = [];
  const updates = [];
  let clock = 1_000_000;
  const open = new Set(opts.open ?? []);
  const remote = { pushTargets: () => devices, update: (id, p) => updates.push([id, p]) };
  const hub = { open: (id) => open.has(id) };
  const send = async (sub, body, vapid, o) => { sent.push({ sub, body: JSON.parse(body), o }); return opts.result ?? { ok: true, status: 201, gone: false }; };
  const pusher = createPusher({ remote, hub, send, vapid: () => ({}), subject: 'mailto:a@b.co', turn: () => ({ ms: 60_000, prompt: 'p' }), now: () => clock });
  return { sent, updates, pusher, tick: (ms) => { clock += ms; } };
}
const dev = (id, over = {}) => ({ id, sub: { endpoint: `https://p/${id}` }, control: true, prefs: { done: true, waiting: true, approval: true, stuck: true, conflict: true, loop: true, context: false, quietWhenOpen: true, ...over } });

test('each device gets what its own preferences allow, and not while it has the app open', async () => {
  const r = rig([dev('a'), dev('b', { done: false }), dev('c')], { open: ['c'] });
  r.pusher.handle('message', { state: 'done', session: 's', harness: 'claude' });
  await wait(10);
  assert.deepEqual(r.sent.map((s) => s.sub.endpoint), ['https://p/a']);
  assert.equal(r.sent[0].o.urgency, 'normal');
});

test('an approval only reaches a device that is allowed to answer it, and is urgent and short-lived', async () => {
  const r = rig([dev('a', {}), { ...dev('b'), control: false }]);
  r.pusher.handle('approval', { status: 'pending', id: 'abcdefgh', kind: 'run', command: 'ls' });
  await wait(10);
  assert.deepEqual(r.sent.map((s) => s.sub.endpoint), ['https://p/a']);
  assert.equal(r.sent[0].o.urgency, 'high');
  assert.equal(r.sent[0].o.ttl, 120);
});

test('the same thing is not sent twice in 10 seconds, and a device gets at most 20 a minute', async () => {
  const r = rig([dev('a')]);
  r.pusher.handle('stuck', { session: 's', text: 'x' });
  r.pusher.handle('stuck', { session: 's', text: 'x' });
  await wait(10);
  assert.equal(r.sent.length, 1);
  for (let i = 0; i < 30; i++) r.pusher.handle('stuck', { session: `s${i}`, text: 'x' });
  await wait(30);
  assert.equal(r.sent.length, 20);
});

test('waiting is sent only if still waiting after 20 s; a new state cancels it; a dead subscription is forgotten', async () => {
  const r = rig([dev('a')], { result: { ok: false, status: 410, gone: true } });
  r.pusher.handle('message', { state: 'waiting', session: 's' });
  r.pusher.handle('message', { state: 'working', session: 's' });
  r.pusher.stop();
  await wait(10);
  assert.equal(r.sent.length, 0);
  r.pusher.handle('stuck', { session: 's', text: 'x' });
  await wait(10);
  assert.deepEqual(r.updates, [['a', { push: null }]]);
});

test('with no device subscribed, nothing is sent and no timers are started', async () => {
  const r = rig([]);
  r.pusher.handle('message', { state: 'waiting', session: 's' });
  r.pusher.handle('message', { state: 'done', session: 's' });
  await wait(5);
  assert.equal(r.sent.length, 0);
});

test('the test notification goes to one device whatever its preferences', async () => {
  const r = rig([dev('a', { done: false }), dev('b')]);
  await r.pusher.test('a');
  assert.deepEqual(r.sent.map((s) => s.sub.endpoint), ['https://p/a']);
});
