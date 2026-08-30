/**
 * sh-agent relay
 *
 * Sits between the public web UI and the LM Studio server running on this PC.
 *   phone -> https tunnel -> relay (this file) -> http://127.0.0.1:1234 (LM Studio)
 *
 * It exists for three reasons:
 *   1. a tunnel URL is public, so the endpoint needs a token gate
 *   2. the browser needs CORS headers LM Studio does not always send
 *   3. one stable /health surface to drive the UI's connection indicator
 *
 * No dependencies. Node 18+.
 */

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const PORT = Number(process.env.RELAY_PORT || 8787);
const HOST = process.env.RELAY_HOST || '127.0.0.1'; // 0.0.0.0 only when LAN access is wanted
const UPSTREAM = (process.env.LMS_URL || 'http://127.0.0.1:1234').replace(/\/+$/, '');
const KEYS_FILE = process.env.RELAY_KEYS_FILE || '';
const FALLBACK_TOKEN = process.env.RELAY_TOKEN || randomBytes(16).toString('base64url');
const MAX_KEYS = 2; // one model on one machine; a third seat only makes a queue
const MAX_BODY = 8 * 1024 * 1024;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-max-age': '86400',
  vary: 'origin',
};

const ts = () => new Date().toLocaleTimeString('en-GB', { hour12: false });
const log = (...a) => console.log(`\x1b[2m${ts()}\x1b[0m`, ...a);

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
    'cache-control': 'no-store',
    ...CORS,
    ...headers,
  });
  res.end(payload);
}

let keys = [];
let keysStamp = -1;

/**
 * Keys live in a file the launcher owns, re-read whenever it changes. Revoking
 * someone therefore takes effect at once: restarting the relay would hand out a
 * new tunnel address and break the other person's link along with it.
 */
function loadKeys() {
  if (!KEYS_FILE) {
    if (!keys.length) keys = [{ name: '나', key: FALLBACK_TOKEN }];
    return;
  }
  try {
    const stamp = statSync(KEYS_FILE).mtimeMs;
    if (stamp === keysStamp) return;
    keysStamp = stamp;
    // PowerShell writes UTF-8 with a BOM, which JSON.parse refuses outright.
    const parsed = JSON.parse(readFileSync(KEYS_FILE, 'utf8').replace(/^\uFEFF/, ''));
    keys = (Array.isArray(parsed) ? parsed : [parsed])
      .filter((k) => k && typeof k.key === 'string' && k.key)
      .slice(0, MAX_KEYS);
    log(`keys: ${keys.map((k) => k.name).join(', ') || '(none)'}`);
  } catch {
    keys = [];
  }
}

/** Returns the name behind the key, or null. Comparison stays constant time. */
function identify(req) {
  loadKeys();
  const raw = req.headers.authorization || '';
  const given = Buffer.from(raw.startsWith('Bearer ') ? raw.slice(7) : raw);
  for (const entry of keys) {
    const known = Buffer.from(entry.key);
    if (given.length === known.length && timingSafeEqual(given, known)) return entry.name || '?';
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function upstreamAlive() {
  try {
    const r = await fetch(`${UPSTREAM}/v1/models`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return { ok: false, models: [] };
    const data = await r.json();
    // LM Studio lists embedding models alongside chat models; the UI would
    // happily pick one as a default, so keep them out of the health report.
    const models = (data?.data || []).map((m) => m.id).filter((id) => !/embed/i.test(id));
    return { ok: true, models };
  } catch {
    return { ok: false, models: [] };
  }
}

/** Forward a request to LM Studio, streaming the response through untouched. */
async function proxy(req, res, path) {
  const body = req.method === 'POST' ? await readBody(req) : undefined;
  const abort = new AbortController();
  res.on('close', () => abort.abort());

  let upstream;
  try {
    upstream = await fetch(`${UPSTREAM}${path}`, {
      method: req.method,
      headers: { 'content-type': 'application/json' },
      body,
      signal: abort.signal,
    });
  } catch (err) {
    log('\x1b[31mupstream unreachable\x1b[0m', err.message);
    return send(res, 502, {
      error: { message: 'LM Studio server is not reachable. Start it with: lms server start' },
    });
  }

  const headers = { ...CORS, 'cache-control': 'no-store' };
  const ct = upstream.headers.get('content-type');
  if (ct) headers['content-type'] = ct;
  if (ct?.includes('event-stream')) headers['x-accel-buffering'] = 'no';
  res.writeHead(upstream.status, headers);

  if (!upstream.body) return res.end();
  try {
    for await (const chunk of upstream.body) {
      res.write(chunk);
      res.flushHeaders?.();
    }
  } catch (err) {
    if (!abort.signal.aborted) log('\x1b[31mstream broke\x1b[0m', err.message);
  }
  res.end();
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://relay');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  if (pathname === '/health') {
    const up = await upstreamAlive();
    loadKeys();
    return send(res, 200, {
      relay: 'ok',
      upstream: up.ok,
      models: up.models,
      upstreamUrl: UPSTREAM,
      seats: keys.length,
    });
  }

  const who = identify(req);
  if (!who) {
    log(`\x1b[33m401\x1b[0m ${req.method} ${pathname}`);
    return send(res, 401, { error: { message: 'Invalid or missing access key.' } });
  }

  if (pathname === '/v1/models' && req.method === 'GET') return proxy(req, res, '/v1/models');
  if (pathname === '/v1/chat/completions' && req.method === 'POST') {
    log(`\x1b[36m→\x1b[0m ${who}`);
    return proxy(req, res, '/v1/chat/completions');
  }

  return send(res, 404, { error: { message: `No route for ${pathname}` } });
});

server.keepAliveTimeout = 0;
server.requestTimeout = 0;
server.headersTimeout = 0;

server.listen(PORT, HOST, async () => {
  const up = await upstreamAlive();
  loadKeys();
  console.log('');
  console.log('  \x1b[1msh-agent relay\x1b[0m');
  console.log(`  listening   http://localhost:${PORT}`);
  console.log(`  upstream    ${UPSTREAM} ${up.ok ? '\x1b[32m● online\x1b[0m' : '\x1b[31m● offline\x1b[0m'}`);
  if (up.ok && up.models.length) console.log(`  models      ${up.models.join(', ')}`);
  console.log(`  seats       ${keys.map((k) => k.name).join(', ') || '(none)'}  (최대 ${MAX_KEYS})`);
  console.log('');
});
