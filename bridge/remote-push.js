// Which bridge events become a push notification, and who gets it. The pal page makes these
// decisions in the browser (index.html notifyState…); a phone with the app closed has no page
// running, so the bridge decides here, the same way, per device and per its own preferences.
import { redactText } from './redact.js';
import { harnessName } from './ui/recap.js';

const clip = (s, n) => { const t = redactText(String(s ?? '')).text.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const VERB = { run: 'run a command', edit: 'edit a file', write: 'write a file', delete: 'delete a file', web: 'go online', agent: 'start a helper agent', mcp: 'use a tool', read: 'read a file', search: 'search' };
const MIN_DONE_MS = 15_000;   // a request that took less than this isn't worth a buzz
const WAITING_AFTER = 20_000; // like the pal: only when it's still waiting for you after this long

/**
 * What an event means for a notification, or null. `turn(session)` → { ms, prompt } for the
 * request that just ended. Returns { kind, title, body, tag, delay? }.
 */
export function pushFor(event, data, { turn = () => null } = {}) {
  if (!data || typeof data !== 'object') return null;
  const who = harnessName(data.harness);
  const where = data.label ? ` · ${clip(data.label, 40)}` : '';
  const session = data.session ?? data.id ?? '';
  switch (event ?? 'message') {
    case 'message': {
      if (data.state === 'done') {
        const t = turn(data.session);
        if (!t || t.ms < MIN_DONE_MS) return null;
        return { kind: 'done', title: `${who} is done${where}`, body: t.prompt ? `“${clip(t.prompt, 90)}”` : 'Finished', tag: `done-${session}` };
      }
      if (data.state === 'waiting') return { kind: 'waiting', title: `${who} needs your OK${where}`, body: clip(data.text, 120) || 'Waiting for you', tag: `wait-${session}`, delay: WAITING_AFTER };
      return null;
    }
    case 'approval': {
      if (data.status !== 'pending') return null;
      return { kind: 'approval', title: `${who} wants to ${VERB[data.kind] ?? `use ${clip(data.tool, 30)}`}${where}`, body: clip(data.command || data.title || data.tool, 140), tag: `ask-${data.id}` };
    }
    case 'ocask': {
      if (data.status !== 'pending') return null;
      return { kind: 'approval', title: `OpenCode needs you${where}`, body: clip(data.kind === 'question' ? data.questions?.[0]?.question : `Permission: ${data.permission}`, 140), tag: `ask-${data.id}` };
    }
    case 'stuck': return { kind: 'stuck', title: `${who}${where} may be stuck`, body: clip(data.text, 140), tag: `stuck-${data.session}` };
    case 'conflict': return { kind: 'conflict', title: 'Two agents, one file', body: clip(data.text, 140), tag: `conflict-${data.session ?? ''}` };
    case 'loop': return ['gave-up', 'ask-you', 'bluff'].includes(data.kind) ? { kind: 'loop', title: `Claude${where}`, body: clip(data.text, 140), tag: `loop-${data.session}` } : null;
    case 'context': {
      const pct = data.size ? (data.used / data.size) * 100 : 0;
      return data.known && pct >= 90 ? { kind: 'context', title: `${who}'s context is ${Math.round(pct)}% full`, body: `${data.label ?? ''}: it will compact soon`.trim(), tag: `ctx-${data.session}` } : null;
    }
    default: return null;
  }
}

/**
 * Sends them. Quiet while a device has the app open (its live stream is the foreground signal),
 * at most one per tag per 10 s and 20 a minute per device, dead subscriptions forgotten.
 */
export function createPusher({ remote, hub, send, vapid, subject, turn, now = Date.now, log = () => {} }) {
  const waiting = new Map(); // session → timer, for "still waiting after 20 s"
  const recent = new Map();  // `${device}|${tag}` → time
  const minute = new Map();  // device → times in the last minute

  async function deliver(item, only) {
    const t = now();
    for (const target of remote.pushTargets()) {
      if (only && target.id !== only) continue;
      if (!only) {
        const { prefs } = target;
        if (!prefs[item.kind]) continue;
        if (item.kind === 'approval' && !target.control) continue; // it couldn't answer anyway
        if (prefs.quietWhenOpen && hub.open(target.id)) continue;
        const key = `${target.id}|${item.tag}`;
        if (t - (recent.get(key) ?? 0) < 10_000) continue;
        const times = (minute.get(target.id) ?? []).filter((x) => t - x < 60_000);
        if (times.length >= 20) continue;
        recent.set(key, t);
        times.push(t);
        minute.set(target.id, times);
        if (recent.size > 400) for (const [k, v] of recent) if (t - v > 60_000) recent.delete(k);
      }
      const urgent = item.kind === 'approval' || item.kind === 'waiting';
      const body = JSON.stringify({ kind: item.kind, title: item.title, body: item.body, tag: item.tag, at: t, url: '/#sessions' });
      const res = await send(target.sub, body, vapid(), { subject, urgency: urgent ? 'high' : 'normal', ttl: item.kind === 'approval' ? 120 : 3600, topic: item.tag });
      if (res.gone) { remote.update(target.id, { push: null }); log(`push: forgot a dead subscription for ${target.id}`); }
    }
  }

  return {
    /** Call for every bridge event; does nothing (no timers either) while no device wants pushes. */
    handle(event, data) {
      if (event == null || event === 'message') {
        const timer = waiting.get(data?.session);
        if (timer) { clearTimeout(timer); waiting.delete(data.session); }
      }
      if (!remote.pushTargets().length) return;
      const item = pushFor(event, data, { turn });
      if (!item) return;
      if (!item.delay) { deliver(item).catch(() => {}); return; }
      const timer = setTimeout(() => { waiting.delete(data.session); deliver(item).catch(() => {}); }, item.delay);
      timer.unref?.();
      waiting.set(data.session, timer);
    },
    /** A test notification for one device, whatever its preferences. */
    test: (deviceId) => deliver({ kind: 'done', title: 'dotpals', body: 'Notifications are working on this device.', tag: 'test' }, deviceId),
    stop() { for (const t of waiting.values()) clearTimeout(t); waiting.clear(); },
  };
}
