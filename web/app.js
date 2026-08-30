/**
 * sh-agent — web client
 *
 * Talks to the relay running on the user's PC (server/relay.mjs), which in turn
 * fronts LM Studio. Everything here is static: no build step, no dependencies.
 */

const $ = (id) => document.getElementById(id);

const CFG_KEY = 'sh-agent:config';
const CHATS_KEY = 'sh-agent:chats';

const state = {
  cfg: { endpoint: '', token: '', model: '', system: '', temp: 0.7 },
  chats: [],
  activeId: null,
  stream: null,
  stickToBottom: true,
  pairingFailed: false,
};

/* ------------------------------------------------------------- persistence */

function loadConfig() {
  try {
    Object.assign(state.cfg, JSON.parse(localStorage.getItem(CFG_KEY) || '{}'));
  } catch {}
}

/** Decodes the blob a pairing link carries. Returns false if it is not one. */
function applyPairing(blob) {
  try {
    const paired = JSON.parse(atob(blob.replace(/-/g, '+').replace(/_/g, '/')));
    if (!paired.e) return false;
    state.cfg.endpoint = String(paired.e).replace(/\/+$/, '');
    if (paired.t) state.cfg.token = String(paired.t);
    saveConfig();
    return true;
  } catch {
    return false;
  }
}

/**
 * The pairing link keeps the server address and key in the fragment, which the
 * browser never sends anywhere. Read it, then scrub it from the address bar.
 * Messengers love to truncate long links, so a half-eaten one says so rather
 * than dumping the reader into a blank form.
 */
function consumeHash() {
  const hash = location.hash;
  if (!/[#&]c=/.test(hash)) return false;

  const m = hash.match(/[#&]c=([A-Za-z0-9_-]+)/);
  if (!m || !applyPairing(m[1])) {
    state.pairingFailed = true;
    toast('페어링 링크가 잘렸거나 손상되었습니다');
    return false;
  }
  state.pairingFailed = false;
  history.replaceState(null, '', location.pathname + location.search);
  toast('연결 정보를 불러왔습니다');
  return true;
}

const saveConfig = () => localStorage.setItem(CFG_KEY, JSON.stringify(state.cfg));

function loadChats() {
  try {
    state.chats = JSON.parse(localStorage.getItem(CHATS_KEY) || '[]');
  } catch {
    state.chats = [];
  }
}

const saveChats = () => localStorage.setItem(CHATS_KEY, JSON.stringify(state.chats.slice(0, 40)));

const activeChat = () => state.chats.find((c) => c.id === state.activeId);

function ensureChat() {
  let chat = activeChat();
  if (!chat) {
    chat = { id: String(Date.now()), title: '새 대화', at: Date.now(), messages: [] };
    state.chats.unshift(chat);
    state.activeId = chat.id;
  }
  return chat;
}

/* ---------------------------------------------------------------- markdown */

// Parks fenced code blocks while the line parser runs. Safe because esc() has
// already turned every real "<" into "&lt;", so this can never collide.
const fenceSlot = (i) => `<cb:${i}>`;
const FENCE_SLOT_RE = /^<cb:(\d+)>$/;

const esc = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function inlineFmt(s) {
  return s
    .replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

/** A deliberately small Markdown subset — enough for chat, nothing to exploit. */
function renderMarkdown(md) {
  const fences = [];
  const src = esc(md).replace(/```([\w+-]*)\n?([\s\S]*?)(?:```|$)/g, (_, lang, code) => {
    fences.push({ lang, code: code.replace(/\n$/, '') });
    return `\n${fenceSlot(fences.length - 1)}\n`;
  });

  const out = [];
  let list = null;
  let para = [];

  const flushPara = () => {
    if (para.length) out.push(`<p>${inlineFmt(para.join('<br>'))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inlineFmt(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  const flushAll = () => { flushPara(); flushList(); };

  for (const raw of src.split('\n')) {
    const line = raw.trimEnd();
    const fence = line.trim().match(FENCE_SLOT_RE);

    if (fence) {
      flushAll();
      const { lang, code } = fences[Number(fence[1])];
      out.push(
        `<div class="code-block">${lang ? `<span class="code-lang">${lang}</span>` : ''}` +
          `<button class="copy" type="button">복사</button><pre><code>${code}</code></pre></div>`
      );
      continue;
    }
    if (!line.trim()) { flushAll(); continue; }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushAll();
      const level = Math.min(heading[1].length + 1, 4);
      out.push(`<h${level}>${inlineFmt(heading[2])}</h${level}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { flushAll(); out.push('<hr>'); continue; }

    const quote = line.match(/^&gt;\s?(.*)$/);
    if (quote) { flushAll(); out.push(`<blockquote>${inlineFmt(quote[1])}</blockquote>`); continue; }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const number = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || number) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push((bullet || number)[1]);
      continue;
    }

    flushList();
    para.push(line);
  }
  flushAll();
  return out.join('');
}

/* ------------------------------------------------------------------ thread */

const thread = $('thread');
const stage = $('stage');

function scrollToEnd(force) {
  if (!force && !state.stickToBottom) return;
  stage.scrollTop = stage.scrollHeight;
}

stage.addEventListener('scroll', () => {
  state.stickToBottom = stage.scrollHeight - stage.scrollTop - stage.clientHeight < 130;
});

function addUserTurn(text) {
  const el = document.createElement('div');
  el.className = 'turn user';
  el.textContent = text;
  thread.appendChild(el);
  return el;
}

/**
 * gemma-4 streams `reasoning_content` before it streams an answer. Rather than
 * leaving the reader staring at three dots, the thinking is shown live and then
 * folded away the moment real content starts.
 */
function addModelTurn() {
  const el = document.createElement('div');
  el.className = 'turn model live';

  const byline = document.createElement('div');
  byline.className = 'byline';
  byline.textContent = (state.cfg.model || 'model').split('/').pop();

  const think = document.createElement('div');
  think.className = 'think';
  think.hidden = true;
  think.innerHTML =
    '<button class="think-toggle" type="button" aria-expanded="true">' +
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>' +
    '<span class="think-label">생각하는 중</span></button>' +
    '<div class="think-fold"><div class="think-body"></div></div>';

  const body = document.createElement('div');
  body.className = 'body';
  body.innerHTML = '<span class="thinking"><i></i><i></i><i></i></span>';

  el.append(byline, think, body);
  thread.appendChild(el);

  const toggle = think.querySelector('.think-toggle');
  const label = think.querySelector('.think-label');
  const thinkBody = think.querySelector('.think-body');
  let sealedLabel = null;
  toggle.addEventListener('click', () => {
    const open = think.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });

  return {
    el,
    body,
    showThinking(text) {
      if (think.hidden) {
        think.hidden = false;
        think.classList.add('open');
      }
      thinkBody.textContent = text;
      thinkBody.scrollTop = thinkBody.scrollHeight;
    },
    sealThinking(seconds) {
      // Remember the duration even when the fold is not on screen yet: in a
      // backgrounded tab no frame has painted, so the answer can start before
      // the reasoning has ever been revealed.
      if (seconds) sealedLabel = `생각 과정 · ${seconds}초`;
      if (think.hidden) return;
      think.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
      label.textContent = sealedLabel || '생각 과정';
    },
  };
}

function addNotice(html) {
  const el = document.createElement('div');
  el.className = 'turn notice';
  el.innerHTML = html;
  thread.appendChild(el);
  scrollToEnd(true);
}

function paintThread() {
  thread.replaceChildren();
  const chat = activeChat();
  const msgs = chat ? chat.messages : [];
  $('overture').hidden = msgs.length > 0;
  for (const m of msgs) {
    if (m.role === 'user') {
      addUserTurn(m.content);
    } else {
      const turn = addModelTurn();
      turn.el.classList.remove('live');
      turn.el.style.animation = 'none';
      if (m.reasoning) {
        turn.showThinking(m.reasoning);
        turn.sealThinking();
      }
      turn.body.innerHTML = renderMarkdown(m.content);
    }
  }
  requestAnimationFrame(() => scrollToEnd(true));
}

thread.addEventListener('click', async (e) => {
  const btn = e.target.closest('.copy');
  if (!btn) return;
  const code = btn.parentElement.querySelector('code');
  try {
    await navigator.clipboard.writeText(code.innerText);
    btn.textContent = '복사됨';
    setTimeout(() => (btn.textContent = '복사'), 1400);
  } catch {
    toast('클립보드를 사용할 수 없습니다');
  }
});

/* ------------------------------------------------------------- connection */

function setLed(stateName, label) {
  $('statusLed').dataset.state = stateName;
  if (label) $('modelLabel').textContent = label;
}

async function health(quiet) {
  const { endpoint } = state.cfg;
  if (!endpoint) { setLed('idle', '서버 미설정'); return null; }
  try {
    const r = await fetch(`${endpoint.replace(/\/+$/, '')}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(7000),
    });
    const data = await r.json();
    if (!data.upstream) { setLed('down', 'LM STUDIO 꺼짐'); return data; }
    if (data.models?.length && !data.models.includes(state.cfg.model)) {
      state.cfg.model = data.models[0];
      saveConfig();
    }
    fillModels(data.models || []);
    setLed('live', (state.cfg.model || 'connected').split('/').pop());
    return data;
  } catch (err) {
    setLed('down', '연결 실패');
    if (!quiet) toast('서버에 연결할 수 없습니다');
    return null;
  }
}

function fillModels(models) {
  const sel = $('fModel');
  const current = state.cfg.model;
  sel.replaceChildren();
  if (!models.length) {
    sel.append(new Option('연결 후 자동으로 채워집니다', ''));
    return;
  }
  for (const id of models) sel.append(new Option(id, id, false, id === current));
}

/* ------------------------------------------------------------------ stream */

async function send(text) {
  if (state.stream) return;
  const { endpoint, token } = state.cfg;
  if (!endpoint) { openSheet(); toast('서버 주소를 먼저 입력하세요'); return; }

  const chat = ensureChat();
  if (chat.messages.length === 0) {
    chat.title = text.replace(/\s+/g, ' ').slice(0, 42) || '새 대화';
  }
  chat.messages.push({ role: 'user', content: text });
  chat.at = Date.now();
  saveChats();
  paintHistory();

  $('overture').hidden = true;
  addUserTurn(text);
  scrollToEnd(true);

  const turn = addModelTurn();
  state.stickToBottom = true;
  scrollToEnd(true);

  const controller = new AbortController();
  state.stream = controller;
  setBusy(true);
  setLed('busy');

  const messages = [];
  if (state.cfg.system.trim()) messages.push({ role: 'system', content: state.cfg.system.trim() });
  messages.push(...chat.messages.map((m) => ({ role: m.role, content: m.content })));

  let acc = '';
  let reasoning = '';
  let queued = false;
  const startedAt = Date.now();

  const paint = () => {
    queued = false;
    if (reasoning) turn.showThinking(reasoning);
    if (acc) turn.body.innerHTML = renderMarkdown(acc);
    scrollToEnd();
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(paint);
  };

  /** Persist the finished turn. Returns false when nothing was produced. */
  const commit = () => {
    if (!acc.trim()) return false;
    const message = { role: 'assistant', content: acc };
    if (reasoning.trim()) message.reasoning = reasoning.trim();
    chat.messages.push(message);
    chat.at = Date.now();
    saveChats();
    paintHistory();
    return true;
  };

  try {
    const res = await fetch(`${endpoint.replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model: state.cfg.model || undefined,
        messages,
        temperature: Number(state.cfg.temp),
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      let msg = `서버가 ${res.status} 응답을 보냈습니다`;
      try {
        const body = await res.json();
        if (body?.error?.message) msg = body.error.message;
      } catch {}
      throw new Error(msg);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const delta = JSON.parse(payload).choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.reasoning_content) {
            reasoning += delta.reasoning_content;
            schedule();
          }
          if (delta.content) {
            if (!acc) turn.sealThinking(Math.max(1, Math.round((Date.now() - startedAt) / 1000)));
            acc += delta.content;
            schedule();
          }
        } catch {}
      }
    }

    paint();
    commit();
    if (!acc.trim()) {
      turn.el.remove();
      addNotice('모델이 빈 응답을 보냈습니다.');
    }
  } catch (err) {
    if (controller.signal.aborted) {
      paint();
      if (!commit()) turn.el.remove();
    } else if (commit()) {
      // A phone that locks mid-answer drops the connection. Keep the partial
      // reply rather than throwing away what the model already said.
      addNotice(`<b>연결이 끊겼습니다</b> · 여기까지만 받았습니다`);
    } else {
      turn.el.remove();
      addNotice(`<b>실패</b> · ${esc(err.message)}`);
    }
  } finally {
    turn.el.classList.remove('live');
    turn.sealThinking();
    state.stream = null;
    setBusy(false);
    health(true);
  }
}

function setBusy(busy) {
  $('send').classList.toggle('busy', busy);
  $('hint').textContent = busy ? '생성 중 · 버튼을 눌러 중단' : 'Enter 전송 · Shift+Enter 줄바꿈';
}

/* --------------------------------------------------------------- composer */

const input = $('input');

function autoGrow() {
  // Collapsing to 0 first makes scrollHeight the true content height; 'auto'
  // lets the UA fall back to the rows attribute and occasionally overshoots.
  input.style.height = '0px';
  const cap = Math.round(window.innerHeight * 0.42);
  input.style.height = `${Math.max(28, Math.min(input.scrollHeight, cap))}px`;
  $('send').classList.toggle('ready', input.value.trim().length > 0 && !state.stream);
}

input.addEventListener('input', autoGrow);
window.addEventListener('resize', autoGrow);
window.addEventListener('load', autoGrow);

input.addEventListener('keydown', (e) => {
  // Korean IME: a keydown during composition must never submit.
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  if (state.stream) { state.stream.abort(); return; }
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  autoGrow();
  send(text);
});

/* ----------------------------------------------------------------- panels */

const scrim = $('scrim');

// `hidden` has to outlive the slide-out transition, so each element carries a
// pending timer. Reopening cancels it — otherwise a stale close from 400ms ago
// hides the panel that was just opened.
const hideTimers = new WeakMap();

function reveal(el) {
  clearTimeout(hideTimers.get(el));
  el.hidden = false;
  void el.offsetWidth; // flush layout so the transition starts from the closed state
  el.classList.add('open');
}

function conceal(el, after) {
  el.classList.remove('open');
  clearTimeout(hideTimers.get(el));
  hideTimers.set(el, setTimeout(() => { el.hidden = true; }, after));
}

function openPanel(el) {
  for (const other of [$('drawer'), $('sheet')]) {
    if (other !== el && !other.hidden) conceal(other, 460);
  }
  reveal(scrim);
  reveal(el);
}

function closePanels() {
  conceal($('drawer'), 460);
  conceal($('sheet'), 460);
  conceal(scrim, 360);
}

const HINT_FRESH =
  'PC에서 <code>start.ps1</code>을 실행하면 나오는 페어링 링크를 폰에서 열면 아래가 자동으로 채워집니다.';
const HINT_BROKEN =
  '링크가 중간에 잘린 것 같습니다. 메신저가 긴 주소를 자르는 경우가 많습니다. ' +
  '<b>링크 전체를 복사해 아래 서버 주소 칸에 그대로 붙여넣으면</b> 나머지는 알아서 채워집니다.';

function openSheet() {
  $('setupHint').hidden = Boolean(state.cfg.endpoint);
  $('setupHint').innerHTML = state.pairingFailed ? HINT_BROKEN : HINT_FRESH;
  $('fEndpoint').value = state.cfg.endpoint;
  $('fToken').value = state.cfg.token;
  $('fSystem').value = state.cfg.system;
  $('fTemp').value = state.cfg.temp;
  $('tempVal').textContent = Number(state.cfg.temp).toFixed(1);
  $('probeMsg').textContent = '';
  $('probeMsg').className = 'probe-msg';
  openPanel($('sheet'));
}

scrim.addEventListener('click', closePanels);
$('sheetClose').addEventListener('click', closePanels);
$('settingsBtn').addEventListener('click', openSheet);
$('statusBtn').addEventListener('click', openSheet);
$('menuBtn').addEventListener('click', () => { paintHistory(); openPanel($('drawer')); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanels(); });

/* --------------------------------------------------------------- settings */

const commitField = (id, key, transform = (v) => v) => {
  $(id).addEventListener('change', () => {
    state.cfg[key] = transform($(id).value);
    saveConfig();
    if (key === 'endpoint' || key === 'token') health(true);
  });
};

commitField('fToken', 'token', (v) => v.trim());

// Pasting the entire pairing link in here is the obvious move when the link
// itself would not open, so accept that as well as a bare server address.
$('fEndpoint').addEventListener('change', () => {
  const raw = $('fEndpoint').value.trim();
  const paired = raw.match(/[#&]c=([A-Za-z0-9_-]+)/);
  if (paired && applyPairing(paired[1])) {
    $('fEndpoint').value = state.cfg.endpoint;
    $('fToken').value = state.cfg.token;
    toast('링크에서 연결 정보를 읽었습니다');
  } else {
    state.cfg.endpoint = raw.replace(/\/+$/, '');
    saveConfig();
  }
  health(true);
});
commitField('fSystem', 'system');
commitField('fModel', 'model');

$('fTemp').addEventListener('input', () => {
  state.cfg.temp = Number($('fTemp').value);
  $('tempVal').textContent = state.cfg.temp.toFixed(1);
  saveConfig();
});

$('testBtn').addEventListener('click', async () => {
  state.cfg.endpoint = $('fEndpoint').value.trim().replace(/\/+$/, '');
  state.cfg.token = $('fToken').value.trim();
  saveConfig();

  const msg = $('probeMsg');
  msg.className = 'probe-msg';
  msg.textContent = '확인 중…';

  const data = await health(true);
  if (!data) {
    msg.className = 'probe-msg bad';
    msg.textContent = '릴레이에 닿지 못했습니다. 주소와 PC 상태를 확인하세요.';
    return;
  }
  if (!data.upstream) {
    msg.className = 'probe-msg bad';
    msg.textContent = '릴레이는 살아있지만 LM Studio 서버가 꺼져 있습니다.';
    return;
  }
  // The key only matters on /v1/*, so verify it separately.
  try {
    const r = await fetch(`${state.cfg.endpoint}/v1/models`, {
      headers: { authorization: `Bearer ${state.cfg.token}` },
      signal: AbortSignal.timeout(7000),
    });
    if (r.status === 401) {
      msg.className = 'probe-msg bad';
      msg.textContent = '액세스 키가 맞지 않습니다.';
      return;
    }
  } catch {}
  msg.className = 'probe-msg ok';
  msg.textContent = `연결됨 · ${data.models.join(', ')}`;
});

/* ---------------------------------------------------------------- history */

function paintHistory() {
  const list = $('history');
  list.replaceChildren();
  if (!state.chats.length) {
    const empty = document.createElement('p');
    empty.className = 'history-empty';
    empty.textContent = '아직 대화가 없습니다.';
    list.append(empty);
    return;
  }
  for (const chat of state.chats) {
    const row = document.createElement('div');
    row.className = `history-item${chat.id === state.activeId ? ' active' : ''}`;

    const label = document.createElement('button');
    label.className = 'label';
    label.type = 'button';
    label.textContent = chat.title;
    label.addEventListener('click', () => {
      state.activeId = chat.id;
      paintThread();
      paintHistory();
      closePanels();
    });

    const kill = document.createElement('button');
    kill.className = 'kill';
    kill.type = 'button';
    kill.setAttribute('aria-label', '삭제');
    kill.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    kill.addEventListener('click', (e) => {
      e.stopPropagation();
      state.chats = state.chats.filter((c) => c.id !== chat.id);
      if (state.activeId === chat.id) {
        state.activeId = state.chats[0]?.id || null;
        paintThread();
      }
      saveChats();
      paintHistory();
    });

    row.append(label, kill);
    list.append(row);
  }
}

$('newChatBtn').addEventListener('click', () => {
  if (state.stream) state.stream.abort();
  const blank = state.chats.find((c) => c.messages.length === 0);
  state.activeId = blank ? blank.id : null;
  paintThread();
  paintHistory();
  closePanels();
  input.focus();
});

/* ------------------------------------------------------------------ misc */

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  void el.offsetWidth;
  el.classList.add('open');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('open');
    setTimeout(() => { el.hidden = true; }, 400);
  }, 2600);
}

const SEEDS = ['이 문장 자연스럽게 다듬어줘', '개념 하나 쉽게 설명해줘', '오늘 할 일 정리 도와줘', '내 생각의 허점 짚어줘'];

function paintSeeds() {
  const wrap = $('seeds');
  SEEDS.forEach((text, i) => {
    const b = document.createElement('button');
    b.className = 'seed';
    b.type = 'button';
    b.style.setProperty('--i', i);
    b.textContent = text;
    b.addEventListener('click', () => send(text));
    wrap.append(b);
  });
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !state.stream) health(true);
});

// Opening a pairing link while this page is already up is a same-document
// navigation: no reload happens, so the fragment has to be picked up here.
window.addEventListener('hashchange', () => {
  if (consumeHash()) {
    closePanels();
    health(true);
  }
});

/* ------------------------------------------------------------------- boot */

loadConfig();
consumeHash();
loadChats();
state.activeId = state.chats[0]?.id || null;
paintSeeds();
paintThread();
paintHistory();
autoGrow();
health(true);
setInterval(() => { if (!state.stream && !document.hidden) health(true); }, 45000);

if (!state.cfg.endpoint) setTimeout(openSheet, 700);
