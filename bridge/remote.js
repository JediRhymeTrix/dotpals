// Remote client: pairing, device credentials and what a paired device may do.
// Kept in ~/.dotpals/remote.json (0600), never in config.json (the pages can read that).
// A device holds a secret only it knows; the bridge keeps its SHA-256, so a leaked file
// can't be used to sign in. Pairing tokens live in memory, work once, and expire.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { platform } from 'node:os';
import { b64u, generateVapid, pushEndpoint, unb64u } from './webpush.js';

const sha = (s) => createHash('sha256').update(s).digest();
const clipText = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, n);

/** What a device can be told about (Settings on the device). `quietWhenOpen`: no push while the app is open there. */
export const PUSH_KINDS = ['done', 'waiting', 'approval', 'stuck', 'conflict', 'loop', 'context'];
export const DEFAULT_PREFS = { done: true, waiting: true, approval: true, stuck: true, conflict: true, loop: true, context: false, quietWhenOpen: true };

export function cleanPrefs(input, before = DEFAULT_PREFS) {
  const out = { ...DEFAULT_PREFS, ...before };
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const k of [...PUSH_KINDS, 'quietWhenOpen']) if (typeof input[k] === 'boolean') out[k] = input[k];
  }
  return out;
}

/** A browser's push subscription, checked: an https push service and keys of the right size. */
export function cleanSubscription(sub) {
  const endpoint = pushEndpoint(sub?.endpoint);
  if (!endpoint || endpoint.length > 1000) return null;
  try {
    if (unb64u(sub.keys?.p256dh).length !== 65 || unb64u(sub.keys?.auth).length !== 16) return null;
  } catch { return null; }
  return { endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } };
}

// -- what a paired device may ask the bridge ---------------------------------------------------
// Reading is open. A few things never go through (agents' hooks, quitting, pairing others, the
// local OAuth callback). Changing settings, answering permission prompts and dismissing sessions
// are allowed. Everything else on the API runs something on this computer or changes other
// programs' files (hand-off terminals, Blu's tasks, rewinds, chat, apps, agent connect…): that
// needs the device's `control` switch, which you turn on yourself, on this computer.
// `/api/remote/me…` is a device managing itself (its own push, name, sign-out); the rest of /api/remote is this computer's.
const NEVER = [/^\/hook$/, /^\/event$/, /^\/api\/remote(?:\/(?!me(?:\/|$)).*)?$/, /^\/api\/app\/quit$/, /^\/api\/apps\/callback$/];
const ALLOWED_POSTS = [/^\/api\/config$/, /^\/api\/approvals\/[\w-]{8,64}$/, /^\/api\/sessions\/[^/]{1,200}\/dismiss$/, /^\/api\/chat\/answer$/, /^\/api\/remote\/me(?:\/[a-z]+)?$/];

/** 'ok', 'control' (needs the device's control switch) or 'blocked'. */
export function permission(device, method, path) {
  if (NEVER.some((r) => r.test(path))) return 'blocked';
  if (method === 'GET' || method === 'HEAD') return path === '/events' || path.startsWith('/api/') ? 'ok' : 'blocked';
  if (method !== 'POST' || !path.startsWith('/api/')) return 'blocked';
  if (ALLOWED_POSTS.some((r) => r.test(path))) return 'ok';
  return device?.control ? 'ok' : 'control';
}

/** Settings any paired device may change: how things look and sound, not what runs on this computer. */
export const SAFE_SETTINGS = ['sounds', 'notifications', 'character', 'custom', 'palSize', 'storyView', 'morningBrief', 'stuckAlerts', 'conflictMinutes', 'approvalWait'];

/**
 * A settings patch from a paired device: { patch, denied }. A device with the control switch
 * may change anything; the others only SAFE_SETTINGS. `denied` lists what was refused (the
 * whole request is then refused, never half applied).
 */
export function remotePatch(patch, device) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { patch: {}, denied: [] };
  if (device?.control) return { patch, denied: [] };
  const out = {};
  const denied = [];
  for (const [key, value] of Object.entries(patch)) {
    if (SAFE_SETTINGS.includes(key)) out[key] = value; else denied.push(key);
  }
  return { patch: out, denied };
}

/** At most `max` tries per `windowMs` for one key (an address): small, in memory, forgets itself. */
export function createLimiter({ max = 10, windowMs = 60_000, now = Date.now } = {}) {
  const hits = new Map();
  return {
    hit(key) {
      const t = now();
      const list = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
      list.push(t);
      hits.set(key, list);
      if (hits.size > 500) for (const [k, v] of hits) if (t - v.at(-1) >= windowMs) hits.delete(k);
      return list.length <= max;
    },
  };
}

const PAIR_TTL = 5 * 60_000;
const MAX_DEVICES = 20;

export function createRemote({ file, now = Date.now } = {}) {
  let data = null;
  const load = () => {
    if (data) return data;
    try { data = JSON.parse(readFileSync(file(), 'utf8')) ?? {}; } catch { data = {}; }
    if (!Array.isArray(data.devices)) data.devices = [];
    return data;
  };
  const save = () => {
    const path = file();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    if (platform() !== 'win32') { try { chmodSync(path, 0o600); } catch {} }
  };
  const pending = new Map(); // sha(token) hex → expiresAt
  let wrote = 0;

  const view = (d) => ({
    id: d.id, name: d.name, createdAt: d.createdAt, lastSeen: d.lastSeen, control: !!d.control,
    push: !!d.push, prefs: cleanPrefs(d.prefs),
  });
  const find = (id) => load().devices.find((d) => d.id === id);

  return {
    vapid() {
      const d = load();
      if (!d.vapid?.publicKey || !d.vapid?.privateKey) { d.vapid = generateVapid(); save(); }
      return d.vapid;
    },
    /** A one-time pairing token, good for 5 minutes. Only its hash is kept. */
    startPairing() {
      for (const [h, at] of pending) if (at <= now()) pending.delete(h);
      if (pending.size >= 5) pending.delete(pending.keys().next().value);
      const token = b64u(randomBytes(32));
      const expiresAt = now() + PAIR_TTL;
      pending.set(sha(token).toString('hex'), expiresAt);
      return { token, expiresAt };
    },
    /** Trade a token for a device credential, once. Returns { id, secret } or null. */
    finishPairing(token, name) {
      const h = sha(String(token ?? '')).toString('hex');
      const at = pending.get(h);
      pending.delete(h);
      if (!at || at <= now()) return null;
      const d = load();
      if (d.devices.length >= MAX_DEVICES) return null;
      const id = b64u(randomBytes(9));
      const secret = b64u(randomBytes(32));
      d.devices.push({ id, name: clipText(name, 40) || 'Device', hash: sha(secret).toString('hex'), createdAt: now(), lastSeen: now(), control: false, push: null, prefs: { ...DEFAULT_PREFS } });
      save();
      return { id, secret };
    },
    /** The device behind an `Authorization: Bearer <id>.<secret>` header, or null. */
    authenticate(header) {
      const m = /^Bearer ([\w-]{8,32})\.([\w-]{20,100})$/.exec(String(header ?? ''));
      const d = m && find(m[1]);
      if (!d) return null;
      const a = Buffer.from(d.hash, 'hex');
      const b = sha(m[2]);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
      d.lastSeen = now();
      if (now() - wrote > 10 * 60_000) { wrote = now(); save(); } // not on every request
      return d;
    },
    devices: () => load().devices.map(view),
    device: (id) => { const d = find(id); return d ? view(d) : null; },
    pushTargets: () => load().devices.filter((d) => d.push).map((d) => ({ id: d.id, sub: d.push, prefs: cleanPrefs(d.prefs) })),
    /** { name?, control?, prefs?, push? (a subscription, or null to remove it) } */
    update(id, patch = {}) {
      const d = find(id);
      if (!d) return null;
      if (typeof patch.name === 'string' && clipText(patch.name, 40)) d.name = clipText(patch.name, 40);
      if (typeof patch.control === 'boolean') d.control = patch.control;
      if (patch.prefs) d.prefs = cleanPrefs(patch.prefs, d.prefs);
      if (patch.push === null) d.push = null;
      else if (patch.push) { const s = cleanSubscription(patch.push); if (s) d.push = s; else return null; }
      save();
      return view(d);
    },
    revoke(id) {
      const d = load();
      const n = d.devices.length;
      d.devices = d.devices.filter((x) => x.id !== id);
      if (d.devices.length !== n) save();
      return d.devices.length !== n;
    },
    revokeAll() { load().devices = []; save(); },
  };
}
