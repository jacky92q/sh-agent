/**
 * sh-agent — web client
 *
 * Talks to the relay running on the user's PC (server/relay.mjs), which in turn
 * fronts Ollama. Everything here is static: no build step, no dependencies.
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
  // Each entry is { id, kind: 'image', dataUrl }, { id, kind: 'doc', name, size, text, truncated },
  // or { id, kind: 'audio', dataUrl, durationSec }.
  pendingAttachments: [],
};

const MAX_IMAGES = 4;
const MAX_DOCS = 3;
const MAX_AUDIO = 2;
const DOC_CHAR_CAP = 4000; // ~1200 tokens; the loaded model's context window is small
const MAX_DOC_BYTES = 3 * 1024 * 1024;

// Extensions read as plain text. Anything else falls to MIME sniffing in docKind().
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml', 'log',
  'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'h', 'cpp', 'hpp',
  'go', 'rs', 'rb', 'php', 'html', 'htm', 'css', 'scss', 'sh', 'bash', 'ps1',
  'sql', 'xml', 'ini', 'toml', 'conf', 'env',
]);

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

/**
 * Attached images live in the stored chat as data URLs, so history fills the
 * quota far faster than plain text ever did. On overflow, drop the oldest
 * chats — newest first is what anyone actually wants kept — until it fits.
 */
function saveChats() {
  state.chats = state.chats.slice(0, 40);
  for (;;) {
    try {
      localStorage.setItem(CHATS_KEY, JSON.stringify(state.chats));
      return;
    } catch {
      if (state.chats.length <= 1) {
        localStorage.removeItem(CHATS_KEY);
        toast('저장 공간이 부족해 오래된 대화를 정리했습니다');
        return;
      }
      state.chats.pop();
    }
  }
}

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

/* ------------------------------------------------------------ attachments */

/**
 * Downscales to a JPEG data URL before it ever touches localStorage or the
 * wire. The model gains nothing from a 12MP photo, and at full size a couple
 * of attachments would blow both the relay's body limit and the phone's
 * storage quota.
 */
function resizeImage(file, maxDim = 1152, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('이미지를 읽을 수 없습니다'));
    };
    img.src = url;
  });
}

/** 'pdf' | 'text' | null (unsupported) — decided by extension first, MIME as a fallback. */
function docKind(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf' || file.type === 'application/pdf') return 'pdf';
  if (TEXT_EXTENSIONS.has(ext) || file.type.startsWith('text/') || file.type === 'application/json') return 'text';
  return null;
}

// pdf.js is only fetched the moment someone actually attaches a PDF — most
// sessions never touch it, so it stays off the critical path entirely.
const PDFJS_VERSION = '3.11.174';
const PDFJS_BASE = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`;
let pdfjsReady = null;
function loadPdfJs() {
  if (pdfjsReady) return pdfjsReady;
  pdfjsReady = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `${PDFJS_BASE}/pdf.min.js`;
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/pdf.worker.min.js`;
      resolve(window.pdfjsLib);
    };
    s.onerror = () => reject(new Error('PDF 라이브러리를 불러오지 못했습니다'));
    document.head.append(s);
  });
  return pdfjsReady;
}

async function extractPdfText(file, capChars) {
  const pdfjsLib = await loadPdfJs();
  const doc = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages && text.length < capChars; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str).join(' ') + '\n';
  }
  return text;
}

async function readDoc(file, kind) {
  const raw = kind === 'pdf' ? await extractPdfText(file, DOC_CHAR_CAP + 1) : await file.text();
  const truncated = raw.length > DOC_CHAR_CAP;
  return { text: truncated ? raw.slice(0, DOC_CHAR_CAP) : raw, truncated };
}

const countPending = (kind) => state.pendingAttachments.filter((a) => a.kind === kind).length;
const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

const DOC_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M9 12h6M9 16h6"/></svg>';
const AUDIO_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4M8 6v12M12 9v6M16 4v16M20 10v4"/></svg>';

function renderAttachStrip() {
  const strip = $('attachStrip');
  strip.replaceChildren();
  strip.hidden = state.pendingAttachments.length === 0;

  for (const item of state.pendingAttachments) {
    const chip = document.createElement('div');
    const kill = '<button class="kill" type="button" aria-label="제거"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';

    if (item.kind === 'image') {
      chip.className = 'attach-chip image';
      chip.innerHTML = `<img src="${item.dataUrl}" alt="" />${kill}`;
    } else if (item.kind === 'audio') {
      chip.className = 'attach-chip doc';
      chip.innerHTML = `${AUDIO_ICON}<span class="doc-name">${fmtDuration(item.durationSec)}</span>${kill}`;
    } else {
      chip.className = 'attach-chip doc';
      chip.innerHTML = `${DOC_ICON}<span class="doc-name">${esc(item.name)}</span>${kill}`;
      chip.title = `${item.name} · ${item.text.length.toLocaleString()}자${item.truncated ? ' (일부만 첨부됨)' : ''}`;
    }

    chip.querySelector('.kill').addEventListener('click', () => {
      state.pendingAttachments = state.pendingAttachments.filter((a) => a.id !== item.id);
      renderAttachStrip();
      updateSendReady();
    });
    strip.append(chip);
  }
}

const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'ogg', 'oga', 'webm', 'flac', 'aac', 'opus']);
const isAudioFile = (file) => file.type.startsWith('audio/') || AUDIO_EXTENSIONS.has((file.name.split('.').pop() || '').toLowerCase());

async function addFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  let imageOverflow = false;
  let docOverflow = false;
  let audioOverflow = false;

  for (const file of files) {
    if (file.type.startsWith('image/')) {
      if (countPending('image') >= MAX_IMAGES) { imageOverflow = true; continue; }
      try {
        state.pendingAttachments.push({ id: newId(), kind: 'image', dataUrl: await resizeImage(file) });
      } catch {
        toast(`${file.name} 을(를) 첨부하지 못했습니다`);
      }
      continue;
    }

    if (isAudioFile(file)) {
      if (countPending('audio') >= MAX_AUDIO) { audioOverflow = true; continue; }
      try {
        const { dataUrl, durationSec } = await blobToWav(file);
        state.pendingAttachments.push({ id: newId(), kind: 'audio', dataUrl, durationSec });
      } catch {
        toast(`${file.name} 을(를) 처리하지 못했습니다`);
      }
      continue;
    }

    const kind = docKind(file);
    if (!kind) {
      toast(`${file.name} 은(는) 지원하지 않는 형식입니다 (이미지 · 오디오 · 텍스트 · PDF만 가능)`);
      continue;
    }
    if (countPending('doc') >= MAX_DOCS) { docOverflow = true; continue; }
    if (file.size > MAX_DOC_BYTES) {
      toast(`${file.name} 이(가) 너무 큽니다 (최대 3MB)`);
      continue;
    }
    try {
      const { text, truncated } = await readDoc(file, kind);
      state.pendingAttachments.push({ id: newId(), kind: 'doc', name: file.name, size: file.size, text, truncated });
    } catch {
      toast(`${file.name} 을(를) 읽지 못했습니다`);
    }
  }

  if (imageOverflow) toast(`이미지는 최대 ${MAX_IMAGES}장까지 첨부할 수 있습니다`);
  if (docOverflow) toast(`파일은 최대 ${MAX_DOCS}개까지 첨부할 수 있습니다`);
  if (audioOverflow) toast(`오디오는 최대 ${MAX_AUDIO}개까지 첨부할 수 있습니다`);
  renderAttachStrip();
  updateSendReady();
}

$('attachBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', () => {
  addFiles($('fileInput').files);
  $('fileInput').value = '';
});

const lightbox = $('lightbox');
function openLightbox(src) {
  $('lightboxImg').src = src;
  reveal(lightbox);
}
lightbox.addEventListener('click', () => conceal(lightbox, 280));

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

function addUserTurn(text, images = [], docs = [], audios = []) {
  const el = document.createElement('div');
  el.className = 'turn user';

  if (docs.length) {
    const row = document.createElement('div');
    row.className = 'user-docs';
    for (const doc of docs) {
      const badge = document.createElement('span');
      badge.className = 'doc-badge';
      badge.title = `${doc.text.length.toLocaleString()}자${doc.truncated ? ' · 일부만 전달됨' : ''}`;
      badge.innerHTML = `${DOC_ICON}<span class="doc-name">${esc(doc.name)}</span>`;
      row.append(badge);
    }
    el.append(row);
  }
  if (audios.length) {
    const row = document.createElement('div');
    row.className = 'user-audios';
    for (const audio of audios) {
      const player = document.createElement('audio');
      player.className = 'audio-player';
      player.controls = true;
      player.src = audio.dataUrl;
      row.append(player);
    }
    el.append(row);
  }
  if (images.length) {
    const grid = document.createElement('div');
    grid.className = 'user-images';
    for (const src of images) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = '첨부 이미지';
      img.loading = 'lazy';
      grid.append(img);
    }
    el.append(grid);
  }
  if (text) {
    const p = document.createElement('div');
    p.className = 'user-text';
    p.textContent = text;
    el.append(p);
  }
  thread.appendChild(el);
  return el;
}

/**
 * A stored user message is a plain string (text only — the common case, and
 * how every message looked before attachments existed) or an object carrying
 * images/docs alongside the text. partsOf() also reads the older in-between
 * shape (a raw OpenAI content-parts array) that a couple of chats saved
 * during this feature's own development still have on disk.
 */
function partsOf(content) {
  if (typeof content === 'string') return { text: content, images: [], docs: [], audios: [] };
  if (Array.isArray(content)) {
    const text = content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    const images = content.filter((p) => p.type === 'image_url').map((p) => p.image_url.url);
    return { text, images, docs: [], audios: [] };
  }
  return {
    text: content.text || '',
    images: content.images || [],
    docs: content.docs || [],
    audios: content.audios || [],
  };
}

/** What actually gets saved to localStorage for a new user turn. */
function toStored(text, images, docs, audios) {
  if (!images.length && !docs.length && !audios.length) return text;
  return { text, images, docs, audios };
}

/**
 * What goes out over the wire. The API has no notion of an attached document,
 * so each one is folded into the text as a clearly delimited block ahead of
 * the user's own words — the model just reads it as more context. Audio has
 * its own OpenAI-style part type, so it rides alongside images instead.
 */
function toApiContent(content) {
  const { text, images, docs, audios } = partsOf(content);
  const docText = docs
    .map((d) => `--- 첨부 파일: ${d.name} ---\n${d.text}${d.truncated ? '\n[이하 생략]' : ''}\n--- 파일 끝 ---`)
    .join('\n\n');
  const combined = [docText, text].filter(Boolean).join('\n\n');
  if (!images.length && !audios.length) return combined;
  const parts = images.map((url) => ({ type: 'image_url', image_url: { url } }));
  for (const a of audios) {
    // input_audio wants raw base64, not a data: URL — unlike image_url.
    parts.push({ type: 'input_audio', input_audio: { data: a.dataUrl.split(',')[1], format: 'wav' } });
  }
  if (combined) parts.push({ type: 'text', text: combined });
  return parts;
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
      const { text, images, docs, audios } = partsOf(m.content);
      addUserTurn(text, images, docs, audios);
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
  const img = e.target.closest('.user-images img');
  if (img) { openLightbox(img.src); return; }

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
    if (!data.upstream) { setLed('down', '모델 서버 꺼짐'); return data; }
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

async function send(text, images = [], docs = [], audios = []) {
  if (state.stream) return;
  const { endpoint, token } = state.cfg;
  if (!endpoint) { openSheet(); toast('서버 주소를 먼저 입력하세요'); return; }

  const chat = ensureChat();
  if (chat.messages.length === 0) {
    chat.title = text.replace(/\s+/g, ' ').slice(0, 42) || docs[0]?.name || (audios.length ? '음성 메시지' : '이미지 메시지');
  }
  chat.messages.push({ role: 'user', content: toStored(text, images, docs, audios) });
  chat.at = Date.now();
  saveChats();
  paintHistory();

  $('overture').hidden = true;
  addUserTurn(text, images, docs, audios);
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
  messages.push(
    ...chat.messages.map((m) => ({
      role: m.role,
      content: m.role === 'user' ? toApiContent(m.content) : m.content,
    }))
  );

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

function updateSendReady() {
  const hasContent = input.value.trim().length > 0 || state.pendingAttachments.length > 0;
  $('send').classList.toggle('ready', hasContent && !state.stream);
}

function autoGrow() {
  // Collapsing to 0 first makes scrollHeight the true content height; 'auto'
  // lets the UA fall back to the rows attribute and occasionally overshoots.
  input.style.height = '0px';
  const cap = Math.round(window.innerHeight * 0.42);
  input.style.height = `${Math.max(28, Math.min(input.scrollHeight, cap))}px`;
  updateSendReady();
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

// Pasting an image straight into the composer works too.
input.addEventListener('paste', (e) => {
  const files = Array.from(e.clipboardData?.files || []);
  if (files.length) addFiles(files);
});

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  if (state.stream) { state.stream.abort(); return; }
  const text = input.value.trim();
  const images = state.pendingAttachments.filter((a) => a.kind === 'image').map((a) => a.dataUrl);
  const docs = state.pendingAttachments.filter((a) => a.kind === 'doc');
  const audios = state.pendingAttachments.filter((a) => a.kind === 'audio');
  if (!text && !images.length && !docs.length && !audios.length) return;
  input.value = '';
  state.pendingAttachments = [];
  renderAttachStrip();
  autoGrow();
  send(text, images, docs, audios);
});

/* ----------------------------------------------------------------- audio */

/**
 * gemma4:e2b genuinely takes audio — confirmed by sending it a real spoken
 * clip and getting back an answer derived from what was said, not a schema
 * error. (That was never true running the same model under LM Studio: its
 * backend, llama.cpp's own server, has no request-routing for input_audio at
 * all. See the lmstudio-backend branch for that version.) So the mic records
 * real audio rather than transcribing speech to text locally — recognition
 * quality on a 2B model is well short of a dedicated ASR model, but it is
 * actually listening.
 */
function encodeWav(pcm, sampleRate) {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  for (let i = 0, off = 44; i < pcm.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

function bufferToBase64(buf) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

const MAX_AUDIO_SEC = 90;

/** Any audio Blob → mono 16kHz WAV. 16kHz keeps the payload small and is what most speech models expect. */
async function blobToWav(blob, maxSec = MAX_AUDIO_SEC) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  } finally {
    ctx.close();
  }
  const rate = 16000;
  const duration = Math.min(decoded.duration, maxSec);
  const offline = new OfflineAudioContext(1, Math.ceil(duration * rate), rate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start(0, 0, duration);
  const rendered = await offline.startRendering();
  const base64 = bufferToBase64(encodeWav(rendered.getChannelData(0), rate));
  return { dataUrl: `data:audio/wav;base64,${base64}`, durationSec: duration };
}

function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

async function attachAudioBlob(blob) {
  if (countPending('audio') >= MAX_AUDIO) {
    toast(`오디오는 최대 ${MAX_AUDIO}개까지 첨부할 수 있습니다`);
    return;
  }
  try {
    const { dataUrl, durationSec } = await blobToWav(blob);
    state.pendingAttachments.push({ id: newId(), kind: 'audio', dataUrl, durationSec });
    renderAttachStrip();
    updateSendReady();
  } catch {
    toast('오디오를 처리하지 못했습니다');
  }
}

const canRecord = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
if (canRecord) {
  const micBtn = $('micBtn');
  micBtn.hidden = false;

  let recorder = null;
  let chunks = [];
  let stream = null;
  let autoStop = null;

  function teardown() {
    clearTimeout(autoStop);
    micBtn.classList.remove('recording');
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast('마이크 권한이 필요합니다');
      return;
    }
    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      teardown();
      if (blob.size > 300) await attachAudioBlob(blob);
    };
    recorder.start();
    micBtn.classList.add('recording');
    autoStop = setTimeout(() => recorder.state === 'recording' && recorder.stop(), MAX_AUDIO_SEC * 1000);
  }

  micBtn.addEventListener('click', () => {
    if (recorder?.state === 'recording') recorder.stop();
    else start();
  });
}

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
    msg.textContent = '릴레이는 살아있지만 모델 서버가 꺼져 있습니다.';
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

// The only thing this buys is Chrome's "설치" prompt — see sw.js for why it
// is safe to have running underneath a page that also talks to a tunnel.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
