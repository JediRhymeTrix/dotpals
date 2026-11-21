// The service worker's push handler, run in a sandbox with a fake worker scope: no browser needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../bridge/remote/sw.js', import.meta.url), 'utf8').replace('__VERSION__', 't');

/** Load sw.js against a fake scope. `clients`: the windows the page has open, by visibility. */
function worker(clients) {
  const shown = [];
  const handlers = {};
  const self = {
    location: { origin: 'https://x' },
    addEventListener: (type, fn) => { handlers[type] = fn; },
    registration: { showNotification: async (title, o) => { shown.push({ title, ...o }); } },
    clients: { matchAll: async () => clients.map((v) => ({ visibilityState: v, url: 'https://x/' })), claim: async () => {}, openWindow: async () => {} },
    skipWaiting: async () => {},
  };
  vm.runInNewContext(source, { self, caches: { open: async () => ({ addAll: async () => {}, add: async () => {}, match: async () => null, put: async () => {} }), keys: async () => [], delete: async () => {} }, URL, Response: class {}, fetch: async () => ({}), Promise, String, Number, JSON, Date });
  const push = async (note) => {
    const waits = [];
    handlers.push({ data: { json: () => note, text: () => '' }, waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  };
  return { shown, push };
}

test('a push shows a notification when the app is closed or in the background', async () => {
  for (const clients of [[], ['hidden'], ['hidden', 'hidden']]) {
    const w = worker(clients);
    await w.push({ kind: 'done', title: 'Claude is done', body: 'x', tag: 'done-1' });
    assert.equal(w.shown.length, 1, JSON.stringify(clients));
    assert.equal(w.shown[0].title, 'Claude is done');
    assert.equal(w.shown[0].tag, 'done-1');
  }
});

test('with the app open in front, a real notification is held back (it shows live), but a test and a permission prompt are not', async () => {
  const front = worker(['visible']);
  await front.push({ kind: 'done', title: 'Claude is done', tag: 'done-1' });
  assert.equal(front.shown.length, 0, 'already on screen');
  await front.push({ kind: 'done', title: 'dotpals', body: 'Notifications are working on this device.', tag: 'test', test: true });
  assert.equal(front.shown.length, 1, 'a test pressed in the open app must still show');
  assert.equal(front.shown[0].tag, 'test');
  await front.push({ kind: 'approval', title: 'Claude wants to run a command', tag: 'ask-1' });
  assert.equal(front.shown.length, 2, 'a permission prompt always shows');
  assert.equal(front.shown[1].requireInteraction, true);
});

test('what is shown is bounded and the click target stays on this site', async () => {
  const w = worker([]);
  await w.push({ kind: 'done', title: 'T'.repeat(300), body: 'B'.repeat(900), tag: 't', url: 'https://evil.example/x' });
  assert.equal(w.shown[0].title.length, 80);
  assert.equal(w.shown[0].body.length, 200);
  assert.equal(w.shown[0].data.url, '/', 'an absolute URL from a push is ignored');
  await w.push({ kind: 'done', title: 'ok', url: '/#sessions' });
  assert.equal(w.shown[1].data.url, '/#sessions');
});
