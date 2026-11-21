// The remote client's server: a second listener, separate from the bridge's own 127.0.0.1 one
// (agents' hooks never face a network). Off unless Settings → Remote turns it on.
//   GET  /pair, /manifest.webmanifest, /sw.js, static scripts    open (no data in them)
//   POST /pair/claim { code, name }                              trade a pairing code for a device cookie
//   GET  /, /events, /api/*                                      a paired device (cookie dp_device, or Bearer)
//   POST /api/*                                                  same, plus the x-dotpals header, and remote.js permission()
// A device's cookie is HttpOnly + SameSite=Strict: the unmodified dashboard just works, and no
// script on the page can read it. API calls are handed to the bridge's own handler.
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { Readable } from 'node:stream';
import { gzip as gzipCb } from 'node:zlib';
import { promisify } from 'node:util';
import { allowed, createAssets, csp, inlineHashes, negotiate } from './remote-assets.js';
import { createHub } from './remote-hub.js';
import { createPusher } from './remote-push.js';
import { sendPush } from './webpush.js';
import { createLimiter, createRemote, permission, remotePatch } from './remote.js';
import qrcode from './vendor/qrcode.js';

const gzipAsync = promisify(gzipCb);
const COOKIE = 'dp_device';
const YEAR_AND_A_BIT = 400 * 86400; // the longest a browser keeps a cookie
const cookieOf = (req) => /(?:^|;\s*)dp_device=([\w.-]{20,140})/.exec(req.headers.cookie ?? '')?.[1] ?? null;
const SECURITY = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-origin', 'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

/** This computer's network addresses (IPv4), for the pairing link in 'lan' mode. */
export const lanAddresses = () => Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')).map((i) => i.address);

/** Only the names this server is meant to answer to (stops DNS-rebinding pages): this computer, the public address, and in 'lan' mode, IP addresses. */
export function hostAllowed(host, cfg) {
  const name = String(host ?? '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (/^(127\.0\.0\.1|localhost|::1)$/.test(name)) return true;
  try { if (cfg.publicUrl && new URL(cfg.publicUrl).hostname.toLowerCase() === name) return true; } catch {}
  return cfg.bind === 'lan' && /^\d{1,3}(\.\d{1,3}){3}$/.test(name);
}

/** The link a device opens: public address, else this computer's network address (lan), else localhost. The code rides in the #fragment: never sent to a server or logged. */
export function pairingUrl(cfg, code, lan = lanAddresses()) {
  const base = cfg.publicUrl || (cfg.bind === 'lan' && lan[0] ? `http://${lan[0]}:${cfg.port}` : `http://127.0.0.1:${cfg.port}`);
  return `${base}/pair#${code}`;
}

/** A QR code as rows of '0'/'1' (the page draws it: no markup is built from it). */
export function qrRows(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (__, c) => (qr.isDark(r, c) ? '1' : '0')).join(''));
}

const readJson = (req, max = 4096) => new Promise((ok, fail) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size > max) { fail(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { fail(Object.assign(new Error('bad json'), { status: 400 })); } });
  req.on('error', fail);
});
const readBuffer = (req, max = 1024 * 1024) => new Promise((ok, fail) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size > max) fail(Object.assign(new Error('too large'), { status: 413 })); else chunks.push(c); });
  req.on('end', () => ok(Buffer.concat(chunks)));
  req.on('error', fail);
});
const out = (res, status, data, extra = {}) => res.writeHead(status, { ...SECURITY, 'content-type': 'application/json', 'cache-control': 'no-store', ...extra }).end(JSON.stringify(data));
const loopback = (a = '') => /^(127\.|::1$|::ffff:127\.)/.test(a);
const REPO = 'https://github.com/JediRhymeTrix/dotpals'; // the VAPID contact: push services want a mailto: or https URL

/** A body shaped like the original request, for handing the bridge a changed one. */
const shim = (req, text) => Object.assign(Readable.from([Buffer.from(text)]), { method: req.method, url: req.url, headers: { ...req.headers, 'content-length': String(Buffer.byteLength(text)) } });
export function createRemoteServer({ config, file, root, version, api, snapshot, turn, log = () => {}, pushSend }) {
  const remote = createRemote({ file });
  const hub = createHub();
  const claims = createLimiter({ max: 8, windowMs: 60_000 });
  let failures = 0;
  let failedAt = 0;
  let server = null;
  let runKey = '';
  let lastError = null;
  const pusher = createPusher({ remote, hub, send: pushSend ?? sendPush, vapid: () => remote.vapid(), subject: REPO, turn, log });
  const onEvent = (event, data) => { hub.publish(event, data); pusher.handle(event, data); };

  const HEAD = [
    '<link rel="manifest" href="/manifest.webmanifest">', '<meta name="theme-color" content="#0b0b0e">',
    '<meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
    '<link rel="apple-touch-icon" href="/bridge/remote/icons/icon-180.png">',
    '<link rel="stylesheet" href="/bridge/remote/remote.css">', '<script src="/bridge/remote/boot.js"></script>',
  ].join('\n');
  const TAIL = '<script type="module" src="/bridge/remote/settings.js"></script>\n<script type="module" src="/bridge/remote/client.js"></script>\n';
  const transform = (target, text) => {
    if (target.endsWith('/sw.js')) return text.replace('__VERSION__', version);
    if (!target.endsWith('.html') || target.endsWith('/pair.html')) return text;
    return text.replace(/<meta name="viewport"[^>]*>/, '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">')
      .replace('</head>', () => `${HEAD}\n</head>`).replace('</body>', () => `${TAIL}</body>`);
  };
  const assets = createAssets({ root, transform });

  /** Encrypted, or this computer talking to itself. Behind your own tunnel or proxy (on this computer), its X-Forwarded-Proto counts. */
  const isSecure = (req) => {
    if (req.socket.encrypted) return true;
    const local = loopback(req.socket.remoteAddress);
    if (local && req.headers['x-forwarded-proto'] === 'https') return true;
    return local && /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(req.headers.host ?? '') && !req.headers['x-forwarded-for'];
  };
  const originOk = (req) => {
    const origin = req.headers.origin;
    if (!origin) return true;
    const cfg = config();
    try { const h = new URL(origin).host; return h === req.headers.host || (cfg.publicUrl && h === new URL(cfg.publicUrl).host); } catch { return false; }
  };
  const bearer = (req) => { const c = cookieOf(req); return c ? `Bearer ${c}` : req.headers.authorization; };
  const cookieHeader = (value, maxAge, secure) => `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  function sendEntry(req, res, entry) {
    const headers = { ...SECURITY, 'content-type': entry.type, etag: entry.etag, 'cache-control': 'no-cache', vary: 'accept-encoding' };
    if (entry.type.startsWith('text/html')) headers['content-security-policy'] = (entry.csp ??= csp(inlineHashes(entry.body.toString('utf8'))));
    if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304, headers); return res.end(); }
    const [body, encoding] = negotiate(entry, req.headers['accept-encoding']);
    if (encoding) headers['content-encoding'] = encoding;
    headers['content-length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  async function claim(req, res) {
    if (!isSecure(req)) return out(res, 426, { error: 'This address isn’t encrypted (http). Pair over https: use a tunnel, Tailscale, or your own certificate (Settings → Remote).' });
    if (req.headers['x-dotpals'] !== '1' || !originOk(req)) return out(res, 403, { error: 'forbidden' });
    if (!claims.hit(req.socket.remoteAddress ?? '?')) return out(res, 429, { error: 'Too many tries. Wait a minute.' });
    let body;
    try { body = await readJson(req); } catch (err) { return out(res, err.status ?? 400, { error: err.message }); }
    const made = remote.finishPairing(body.code, body.name);
    if (!made) {
      if (Date.now() - failedAt > 5 * 60_000) failures = 0;
      failedAt = Date.now();
      if (++failures >= 10) { remote.cancelPairing(); failures = 0; log('remote: too many wrong pairing codes: pairing codes cancelled'); }
      return out(res, 403, { error: 'That code didn’t work. It may have expired: make a new one on the computer.' });
    }
    failures = 0;
    const secure = !!req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' || /^https:/.test(config().publicUrl ?? '');
    log(`remote: paired "${remote.device(made.id)?.name}"`);
    return out(res, 200, { ok: true, name: remote.device(made.id)?.name }, { 'set-cookie': cookieHeader(`${made.id}.${made.secret}`, YEAR_AND_A_BIT, secure) });
  }

  /** Gzip an API answer when the device accepts it: the bridge's handlers answer with writeHead(...).end(json). */
  function compressApi(req, res) {
    if (!/\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) return;
    const writeHead = res.writeHead.bind(res);
    const end = res.end.bind(res);
    let held = null;
    res.writeHead = (status, headers) => { held = [status, headers]; return res; };
    res.end = (chunk) => {
      res.writeHead = writeHead;
      res.end = end;
      const [status, headers = {}] = held ?? [res.statusCode, {}];
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (buf && buf.length > 1024 && !headers['content-encoding']) {
        gzipAsync(buf).then((z) => { writeHead(status, { ...headers, 'content-encoding': 'gzip', vary: 'accept-encoding' }); end(z); }).catch(() => { writeHead(status, headers); end(buf); });
      } else { writeHead(status, headers); end(buf); }
      return res;
    };
  }
  /** The device's own page of API: who am I, my push subscription and preferences, sign out. */
  async function meApi(req, res, path, device) {
    const id = device.id;
    if (req.method === 'GET' && path === '/api/remote/me') return out(res, 200, { ...remote.device(id), vapid: remote.vapid().publicKey, pushReady: true });
    let body;
    try { body = await readJson(req, 8192); } catch (err) { return out(res, err.status ?? 400, { error: err.message }); }
    if (path === '/api/remote/me/push') {
      const updated = remote.update(id, { push: body.subscription ?? null });
      if (!updated) return out(res, 400, { error: 'That notification subscription isn’t valid.' });
      if (body.subscription) pusher.test(id).catch(() => {});
      return out(res, 200, updated);
    }
    if (path === '/api/remote/me/prefs') return out(res, 200, remote.update(id, { prefs: body.prefs, name: body.name }));
    if (path === '/api/remote/me/test') { pusher.test(id).catch(() => {}); return out(res, 200, { ok: true }); }
    if (path === '/api/remote/me/signout') {
      remote.revoke(id);
      hub.drop(id);
      return out(res, 200, { ok: true }, { 'set-cookie': cookieHeader('', 0, true), 'clear-site-data': '"cache", "storage"' });
    }
    return out(res, 404, { error: 'not found' });
  }

  /** What /events says to a new device: the same picture the pal and dashboard get, trimmed to `historyDays`. */
  const live = (req, res, device) => {
    const url = new URL(req.url, 'http://x');
    const since = req.headers['last-event-id'] || url.searchParams.get('since') || '';
    hub.join(req, res, {
      since, deviceId: device.id, compress: /\bgzip\b/.test(req.headers['accept-encoding'] ?? ''),
      snapshot: (emit) => snapshot(emit, { days: config().historyDays, canAnswer: !!device.control }),
    });
  };

  async function handle(req, res) {
    const cfg = config();
    if (!hostAllowed(req.headers.host, cfg)) return res.writeHead(421, SECURITY).end();
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    if (req.method === 'POST' && path === '/pair/claim') return claim(req, res);
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) return res.writeHead(405, SECURITY).end();

    // The app's own files: open, cached, compressed. The page then asks for data with its cookie.
    if (req.method !== 'POST' && allowed(path)) {
      const entry = await assets.load(path);
      return entry ? sendEntry(req, res, entry) : res.writeHead(404, SECURITY).end();
    }

    const device = remote.authenticate(bearer(req));
    if (!device) return out(res, 401, { error: 'not paired' });
    const verdict = permission(device, req.method, path);
    if (verdict === 'blocked') return out(res, 403, { error: 'not available from a paired device' });
    if (verdict === 'control') return out(res, 403, { error: 'control', message: 'This device can look but not change things. Turn on “Let this device control” for it, on the computer (Settings → Remote).' });
    if (req.method === 'POST' && (req.headers['x-dotpals'] !== '1' || !originOk(req))) return out(res, 403, { error: 'forbidden' });

    if (path === '/events') return live(req, res, device);
    if (path === '/api/remote/me' || path.startsWith('/api/remote/me/')) return meApi(req, res, path, device);

    if (req.method === 'POST' && path === '/api/config') {
      let body;
      try { body = JSON.parse((await readBuffer(req)).toString('utf8') || '{}'); } catch (err) { return out(res, err.status ?? 400, { error: 'bad json' }); }
      const { patch, denied } = remotePatch(body, device);
      if (denied.length) return out(res, 403, { error: 'control', message: `This device can't change: ${denied.join(', ')}. Turn on “Let this device control” for it, on the computer.` });
      if (patch.remote) return out(res, 403, { error: 'forbidden' });
      compressApi(req, res);
      return api(shim(req, JSON.stringify(patch)), res, path, { device });
    }
    compressApi(req, res);
    return api(req, res, path, { device });
  }
  // -- the listener ---------------------------------------------------------------------------
  const keyOfConfig = (c) => JSON.stringify([c.enabled, c.bind, c.port, c.tlsCert, c.tlsKey]);
  const stop = () => new Promise((ok) => {
    const s = server;
    server = null;
    runKey = '';
    hub.close();
    if (!s) return ok();
    s.close(() => ok());
    s.closeAllConnections?.();
  });
  /** Start, stop or move the listener to match the settings. Safe to call whenever they change. */
  async function apply() {
    const cfg = config();
    const key = keyOfConfig(cfg);
    if (key === runKey && (server || !cfg.enabled)) return;
    await stop();
    lastError = null;
    if (!cfg.enabled) { runKey = key; return; }
    let make = createHttp;
    let options = {};
    if (cfg.tlsCert && cfg.tlsKey) {
      try { options = { cert: readFileSync(cfg.tlsCert), key: readFileSync(cfg.tlsKey) }; make = createHttps; } catch (err) { lastError = `Couldn’t read the certificate: ${err.code ?? err.message}`; return; }
    }
    const s = make(options, (req, res) => { handle(req, res).catch((err) => { log(`remote: ${err.message}`); if (!res.headersSent) out(res, 500, { error: 'server error' }); else res.end(); }); });
    s.keepAliveTimeout = 65_000;
    s.headersTimeout = 20_000;
    s.requestTimeout = 30_000;
    s.maxConnections = 64;
    await new Promise((ok) => {
      s.once('error', (err) => { lastError = err.code === 'EADDRINUSE' ? `Port ${cfg.port} is already in use. Pick another in Settings → Remote.` : err.message; ok(); });
      s.listen(cfg.port, cfg.bind === 'lan' ? '0.0.0.0' : '127.0.0.1', () => { server = s; runKey = key; log(`remote client → ${cfg.bind === 'lan' ? 'network' : 'this computer only'}, port ${cfg.port}`); ok(); });
    });
  }

  // -- the computer's own side: /api/remote/* on the bridge's 127.0.0.1 listener ------------------
  async function controlApi(req, res, path, { json, readBody }) {
    const cfg = config();
    const view = () => ({
      enabled: !!cfg.enabled, running: !!server, error: lastError, port: cfg.port, bind: cfg.bind,
      secure: !!(cfg.tlsCert && cfg.tlsKey) || /^https:/.test(cfg.publicUrl ?? ''), publicUrl: cfg.publicUrl || '',
      addresses: cfg.bind === 'lan' ? lanAddresses() : [], devices: remote.devices().map((d) => ({ ...d, open: hub.open(d.id) })), waiting: remote.waiting(), streams: hub.size(),
    });
    if (req.method === 'GET' && path === '/api/remote') return json(res, 200, view());
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
    if (path === '/api/remote/pair') {
      if (!server) return json(res, 409, { error: 'The remote client is off. Turn it on first.' });
      const { token, expiresAt } = remote.startPairing();
      const url = pairingUrl(cfg, token);
      return json(res, 200, { code: token, expiresAt, url, secure: /^https:/.test(url), qr: qrRows(url) });
    }
    if (path === '/api/remote/pair/cancel') { remote.cancelPairing(); return json(res, 200, { ok: true }); }
    if (path === '/api/remote/revoke-all') { for (const d of remote.devices()) hub.drop(d.id); remote.revokeAll(); return json(res, 200, view()); }
    const one = /^\/api\/remote\/devices\/([\w-]{8,32})(?:\/(revoke|test))?$/.exec(path);
    if (!one) return json(res, 404, { error: 'not found' });
    if (one[2] === 'revoke') { hub.drop(one[1]); return json(res, remote.revoke(one[1]) ? 200 : 404, view()); }
    if (one[2] === 'test') { pusher.test(one[1]).catch(() => {}); return json(res, 200, { ok: true }); }
    const updated = remote.update(one[1], { name: body.name, control: body.control, prefs: body.prefs });
    return updated ? json(res, 200, view()) : json(res, 404, { error: 'no such device' });
  }

  return {
    remote, hub, apply, controlApi, onEvent, stop: async () => { pusher.stop(); await stop(); },
    /** A paired device that may answer permission prompts has the app open right now. */
    canAnswer: () => remote.devices().some((d) => d.control && hub.open(d.id)),
  };
}
