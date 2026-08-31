/**
 * sh-agent relay
 *
 * Sits between the public web UI and the Ollama server running on this PC.
 *   phone -> https tunnel -> relay (this file) -> http://127.0.0.1:11434 (Ollama)
 *
 * It exists for three reasons:
 *   1. a tunnel URL is public, so the endpoint needs a token gate
 *   2. the browser needs CORS headers the model server does not send
 *   3. one stable /health surface to drive the UI's connection indicator
 *
 * Backend-agnostic by design: anything with an OpenAI-compatible /v1/models
 * and /v1/chat/completions works here. This shipped against LM Studio first;
 * switching to Ollama (for real audio-input support — see git history and
 * the lmstudio-backend branch) only meant changing MODEL_SERVER_URL below.
 *
 * No dependencies. Node 18+.
 */

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const PORT = Number(process.env.RELAY_PORT || 8787);
const HOST = process.env.RELAY_HOST || '127.0.0.1'; // 0.0.0.0 only when LAN access is wanted
const UPSTREAM = (process.env.MODEL_SERVER_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const KEYS_FILE = process.env.RELAY_KEYS_FILE || '';
const FALLBACK_TOKEN = process.env.RELAY_TOKEN || randomBytes(16).toString('base64url');
const MAX_KEYS = 2; // one model on one machine; a third seat only makes a queue
// Every attached image rides along on every later turn too, since the whole
// conversation is resent each request — a few image turns adds up fast.
const MAX_BODY = 24 * 1024 * 1024;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type,x-client-id',
  // A cross-origin fetch() only exposes the handful of "simple" response
  // headers to JS unless the server explicitly lists anything past that —
  // x-job-id would otherwise silently read back as null.
  'access-control-expose-headers': 'x-job-id',
  'access-control-max-age': '86400',
  vary: 'origin',
};

/* ------------------------------------------------------------------ logging
 *
 * The launcher starts this process with -NoNewWindow, so everything printed
 * here lands in the same PowerShell window the user ran start.ps1 in. That
 * window is the only place to watch what the phone is actually doing, so it
 * gets a real request log rather than a bare arrow: who asked, from which
 * device, how much context went up, and how the answer came back out.
 */
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  violet: (s) => `\x1b[35m${s}\x1b[0m`,
};

const ts = () => new Date().toLocaleTimeString('en-GB', { hour12: false });
const log = (...a) => console.log(C.dim(ts()), ...a);

// Hangul and CJK occupy two terminal columns, but padEnd counts code units —
// a seat named "나" would knock every following column out of line without this.
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/;
const width = (s) => [...s].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0);
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)));
const amt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** The tunnel terminates on loopback, so the real address arrives in a header. */
const clientIp = (req) =>
  String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '').replace(/^::ffff:/, '');

/** Coarse device label off the User-Agent — enough to tell phone from laptop. */
function deviceOf(ua = '') {
  const os = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows'
    : /Linux/.test(ua) ? 'Linux'
    : '알 수 없음';
  // Order matters: Edge and Samsung Internet both also claim to be Chrome.
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /SamsungBrowser/.test(ua) ? 'Samsung'
    : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : '';
  return browser ? `${os} ${browser}` : os;
}

/**
 * Two people can share one seat, and one person routinely has the app open on
 * both a phone and a laptop — the access key alone can't tell those apart. The
 * web UI mints a random id per browser and sends it on every request, which is
 * what actually makes a line in this log identifiable.
 */
const clients = new Map(); // clientId -> { id, name, device, ip, turns, since }

function trackClient(req, who) {
  const id = String(req.headers['x-client-id'] || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16) || '무명';
  let c = clients.get(id);
  if (!c) {
    c = { id, name: who, device: deviceOf(req.headers['user-agent']), ip: clientIp(req), turns: 0, since: Date.now() };
    clients.set(id, c);
    log(C.green('＋'), `새 클라이언트  ${C.bold(who)} ${C.dim('·')} ${C.violet(id)} ${C.dim('·')} ${c.device} ${C.dim(c.ip)}`);
  } else {
    c.name = who;
    c.ip = clientIp(req) || c.ip;
  }
  return c;
}

const tag = (c) => C.bold(pad(`${c.name}·${c.id}`, 20));

/** What the phone is actually sending up, read straight off the request body. */
function summarizeRequest(buf) {
  try {
    const req = JSON.parse(buf.toString('utf8'));
    const msgs = Array.isArray(req.messages) ? req.messages : [];
    let chars = 0;
    let images = 0;
    let audios = 0;
    for (const m of msgs) {
      const content = m.content;
      if (typeof content === 'string') chars += content.length;
      else if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === 'text') chars += (part.text || '').length;
          else if (part.type === 'image_url') images++;
          else if (part.type === 'input_audio') audios++;
        }
      }
    }
    return {
      model: req.model || '(기본)',
      turns: msgs.filter((m) => m.role !== 'system').length,
      chars,
      images,
      audios,
    };
  } catch {
    return null;
  }
}

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
    log(C.dim('·'), C.dim(`좌석 갱신 · ${keys.map((k) => k.name).join(', ') || '(없음)'}`));
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
    // The catalog can list embedding models alongside chat models; the UI
    // would happily pick one as a default, so keep them out of the health report.
    const models = (data?.data || []).map((m) => m.id).filter((id) => !/embed/i.test(id));
    return { ok: true, models };
  } catch {
    return { ok: false, models: [] };
  }
}

/** Forward a request to the model server, streaming the response through untouched. */
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
    log(C.red('✗'), C.red('모델 서버에 연결하지 못했습니다'), C.dim(err.message));
    return send(res, 502, {
      error: { message: 'Model server is not reachable. Start it with: ollama serve' },
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
    if (!abort.signal.aborted) log(C.red('✗'), C.red('스트림이 끊겼습니다'), C.dim(err.message));
  }
  res.end();
}

/**
 * A phone that gets backgrounded mid-answer has its connection to the relay
 * cut by the OS — that used to mean the answer was gone, because the only
 * copy of it lived in the reading loop of a fetch() that just died. Chat
 * completions now get buffered here in memory as they stream, keyed by a
 * job id, independent of whether the phone is still listening. The client
 * streams live same as before when it's connected, and can come back later
 * — even after a full page reload — and ask this relay what the answer
 * ended up being via GET /v1/jobs/:id.
 */
const jobs = new Map(); // id -> { content, reasoning, done, error, createdAt, abort }
const JOB_TTL_MS = 20 * 60 * 1000;

function pruneJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.done && job.createdAt < cutoff) jobs.delete(id);
  }
}

function parseSseDelta(line, job) {
  if (!line.startsWith('data:')) return;
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return;
  try {
    const parsed = JSON.parse(payload);
    // The final chunk usually carries token counts; they make a far better
    // log line than character counts, when the backend bothers to send them.
    if (parsed.usage) job.usage = parsed.usage;
    const delta = parsed.choices?.[0]?.delta;
    // Ollama sends this delta as `reasoning`; LM Studio (and OpenAI) call the
    // same thing `reasoning_content`. Take whichever shows up.
    const reasoningDelta = delta?.reasoning ?? delta?.reasoning_content;
    if (reasoningDelta) job.reasoning += reasoningDelta;
    if (delta?.content) job.content += delta.content;
  } catch {}
}

async function handleChatCompletion(req, res, client) {
  const body = await readBody(req);
  pruneJobs();

  const info = summarizeRequest(body);
  const startedAt = Date.now();
  client.turns++;
  if (info) {
    const bits = [`${info.turns}턴`, `${amt(info.chars)}자`];
    if (info.images) bits.push(`이미지 ${info.images}`);
    if (info.audios) bits.push(`오디오 ${info.audios}`);
    log(C.cyan('→'), tag(client), C.dim(pad(info.model, 12)), bits.join(C.dim(' · ')));
  } else {
    log(C.cyan('→'), tag(client), C.dim('(본문을 읽지 못함)'));
  }

  const id = randomBytes(9).toString('base64url');
  const upstreamAbort = new AbortController();
  const job = {
    content: '', reasoning: '', usage: null, done: false, error: null,
    createdAt: Date.now(), abort: upstreamAbort, client,
  };
  jobs.set(id, job);

  // The point of buffering: a closed downstream response must not cancel the
  // upstream generation. Only an explicit /cancel (the user actually pressing
  // stop) should do that — see the route below.
  let downstreamAlive = true;
  let detachedAt = null;
  res.on('close', () => {
    if (downstreamAlive && !job.done) detachedAt = Date.now();
    downstreamAlive = false;
  });

  /** One closing line per request — this is what the shell is actually for. */
  const report = () => {
    const secs = (Date.now() - startedAt) / 1000;
    const size = job.usage?.completion_tokens
      ? `${job.usage.completion_tokens}tok`
      : `${amt(job.content.length)}자`;
    // A two-character answer has no meaningful rate — printing "0자/s" for it
    // only makes the column look broken.
    const rate = job.content.length >= 40 ? ` · ${(job.content.length / secs).toFixed(0)}자/s` : '';
    const think = job.reasoning.length ? C.dim(` · 생각 ${amt(job.reasoning.length)}자`) : '';
    const detached = detachedAt
      ? C.yellow(`  ⤶ ${((detachedAt - startedAt) / 1000).toFixed(0)}초에 연결 끊김, 버퍼에 계속 받음`)
      : '';

    if (job.error) {
      log(C.red('✗'), tag(client), C.red(`실패 · ${job.error}`), C.dim(`${secs.toFixed(1)}s`));
    } else if (upstreamAbort.signal.aborted) {
      log(C.yellow('⨯'), tag(client), C.yellow('사용자 취소'), C.dim(`${size} · ${secs.toFixed(1)}s`) + think);
    } else {
      log(C.green('←'), tag(client), `${size} · ${secs.toFixed(1)}s${rate}` + think + detached);
    }
  };

  let upstream;
  try {
    upstream = await fetch(`${UPSTREAM}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: upstreamAbort.signal,
    });
  } catch (err) {
    job.done = true;
    job.error = err.message;
    report();
    return send(res, 502, {
      error: { message: 'Model server is not reachable. Start it with: ollama serve' },
    });
  }

  const headers = { ...CORS, 'cache-control': 'no-store', 'x-job-id': id };
  const ct = upstream.headers.get('content-type');
  if (ct) headers['content-type'] = ct;
  if (ct?.includes('event-stream')) headers['x-accel-buffering'] = 'no';
  res.writeHead(upstream.status, headers);

  if (!upstream.ok || !upstream.body) {
    job.done = true;
    job.error = `모델 서버가 ${upstream.status} 응답`;
    report();
    if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
    return res.end();
  }

  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of upstream.body) {
      if (downstreamAlive) {
        try { res.write(chunk); } catch { downstreamAlive = false; }
      }
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) parseSseDelta(line, job);
    }
  } catch (err) {
    if (!upstreamAbort.signal.aborted) job.error = err.message;
  }
  job.done = true;
  report();
  if (downstreamAlive) { try { res.end(); } catch {} }
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
    log(C.yellow('✗ 401'), C.dim(`${req.method} ${pathname}`), C.dim(clientIp(req)), C.dim(deviceOf(req.headers['user-agent'])));
    return send(res, 401, { error: { message: 'Invalid or missing access key.' } });
  }

  const client = trackClient(req, who);

  if (pathname === '/v1/models' && req.method === 'GET') {
    log(C.dim('·'), tag(client), C.dim('모델 목록 조회'));
    return proxy(req, res, '/v1/models');
  }
  if (pathname === '/v1/chat/completions' && req.method === 'POST') {
    return handleChatCompletion(req, res, client);
  }

  const jobMatch = pathname.match(/^\/v1\/jobs\/([A-Za-z0-9_-]+)(\/cancel)?$/);
  if (jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) {
      log(C.yellow('?'), tag(client), C.yellow(`만료된 작업 ${jobMatch[1]}`));
      return send(res, 404, { error: { message: 'Unknown or expired job.' } });
    }

    if (jobMatch[2] && req.method === 'POST') {
      if (!job.done) {
        log(C.yellow('⨯'), tag(client), C.yellow('중지 요청'));
        job.abort.abort();
      }
      return send(res, 200, { ok: true });
    }
    if (!jobMatch[2] && req.method === 'GET') {
      // Worth one line, not a wall of them: recovery polls this every second
      // until the answer lands.
      if (!job.polledBy?.has(client.id)) {
        (job.polledBy ||= new Set()).add(client.id);
        log(C.violet('↺'), tag(client), C.violet('끊긴 응답 이어받는 중'));
      }
      return send(res, 200, {
        id: jobMatch[1],
        done: job.done,
        content: job.content,
        reasoning: job.reasoning,
        error: job.error,
      });
    }
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
  console.log(`  ${C.bold('sh-agent relay')}`);
  console.log(`  listening   http://localhost:${PORT}`);
  console.log(`  upstream    ${UPSTREAM} ${up.ok ? C.green('● online') : C.red('● offline')}`);
  if (up.ok && up.models.length) console.log(`  models      ${up.models.join(', ')}`);
  console.log(`  seats       ${keys.map((k) => k.name).join(', ') || '(none)'}  (최대 ${MAX_KEYS})`);
  console.log('');
  console.log(C.dim('  시각      이름·클라이언트        요청 / 응답'));
  console.log(C.dim('  ────────────────────────────────────────────────────────────'));
});
