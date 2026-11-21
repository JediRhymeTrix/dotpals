// What the remote client may download, and how: an allowlist (never the bridge's own source or
// settings), each file read once, compressed once, and answered with an ETag so a device that
// has it gets a 304 and no bytes. The pages' inline script and style are allowed by hash in
// the Content-Security-Policy, so nothing else can run.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { brotliCompress, constants, gzip } from 'node:zlib';
import { promisify } from 'node:util';

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
};
export const typeOf = (path) => TYPES[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream';

// Files a device may fetch once signed in, and (PUBLIC) those it may fetch before: the sign-in page
// and what the browser needs to install the app.
export const PUBLIC = [/^\/pair$/, /^\/manifest\.webmanifest$/, /^\/sw\.js$/, /^\/remote\/(pair|icon-[\w-]+)\.(js|png)$/, /^\/desktop\/icon\.png$/];
const PRIVATE = [/^\/src\/[\w.-]+\.js$/, /^\/bridge\/ui\/[\w.-]+\.js$/, /^\/bridge\/activity\.js$/, /^\/remote\/[\w.-]+\.(js|css)$/];
export const allowed = (path) => PUBLIC.some((r) => r.test(path)) || PRIVATE.some((r) => r.test(path));

const sha = (data, alg = 'sha256') => createHash(alg).update(data).digest('base64');

/** The 'sha256-…' sources for every inline <script> and <style> in a page. */
export function inlineHashes(html) {
  const out = { script: [], style: [] };
  for (const m of html.matchAll(/<(script|style)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    if (/\bsrc\s*=/.test(m[2]) || !m[3].trim()) continue;
    out[m[1].toLowerCase()].push(`'sha256-${sha(m[3])}'`);
  }
  return out;
}

/** The CSP for a page with these inline hashes. Only this origin; no inline script but the page's own. */
export function csp({ script = [], style = [] } = {}) {
  return [
    "default-src 'none'", `script-src 'self' ${script.join(' ')}`.trim(), `style-src 'self' ${style.join(' ')}`.trim(),
    "style-src-attr 'unsafe-inline'", "img-src 'self' data: blob:", "connect-src 'self'", "manifest-src 'self'",
    "worker-src 'self'", "font-src 'self'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * A cache of files by path: { body, etag, type, br, gz }. `transform(path, text)` may rewrite a
 * text file once (the dashboard gets the manifest link and the client scripts); it's re-read when
 * the file's time changes. Compression is done once, in the background, and used when it's ready.
 */
export function createAssets({ root, transform = (path, text) => text, extra = new Map() } = {}) {
  const cache = new Map();
  async function load(path) {
    if (extra.has(path)) {
      const e = extra.get(path);
      const hit = cache.get(path);
      if (hit && hit.source === e) return hit;
      return pack(path, Buffer.from(e.body), e.type, e, 0);
    }
    const file = normalize(join(root, path === '/' ? '/bridge/dashboard.html' : path));
    if (!file.startsWith(root)) return null;
    let info;
    try { info = await stat(file); } catch { return null; }
    if (!info.isFile()) return null;
    const hit = cache.get(path);
    if (hit && hit.mtime === info.mtimeMs) return hit;
    let body = await readFile(file);
    const type = typeOf(path);
    if (type.startsWith('text/html') || path.startsWith('/remote/') || path.endsWith('.js')) body = Buffer.from(transform(path, body.toString('utf8')));
    return pack(path, body, type, null, info.mtimeMs);
  }
  function pack(path, body, type, source, mtime) {
    const entry = { body, type, source, mtime, etag: `"${sha(body, 'sha1').slice(0, 27)}"`, br: null, gz: null };
    if (type.startsWith('text/') || type.includes('json') || type.includes('javascript') || type.includes('svg')) {
      brotli(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: body.length } }).then((b) => { entry.br = b; }).catch(() => {});
      gz(body, { level: 9 }).then((b) => { entry.gz = b; }).catch(() => {});
    }
    cache.set(path, entry);
    return entry;
  }
  return { load, size: () => cache.size };
}

/** The best encoding this client takes that we already have: [body, 'br' | 'gzip' | null]. */
export function negotiate(entry, acceptEncoding = '') {
  if (entry.br && /\bbr\b/.test(acceptEncoding)) return [entry.br, 'br'];
  if (entry.gz && /\bgzip\b/.test(acceptEncoding)) return [entry.gz, 'gzip'];
  return [entry.body, null];
}
