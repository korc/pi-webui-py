'use strict';

const $ = (sel) => document.querySelector(sel);

// ================= state =================

const state = {
  streaming: false,
  model: null,
  thinkingLevel: null,
  thinkingLevels: [],
  sessionName: null,
  stats: null,
  queue: { steering: [], followUp: [] },
  items: [],
  sessions: [],
  historyMessages: null,
  historyVisible: 50,
  toolBlocks: new Map(),
  streamingItem: null,
  dialog: null,
  retry: null,
  autoScroll: true,
  token: null,
  authGateToken: null,
};


// ================= helpers =================

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

function extractText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  const parts = [];
  for (const b of content || []) {
    if (!b) continue;
    if (b.type === 'text') parts.push(b.text || '');
    else if (b.type === 'thinking') parts.push(b.thinking || '');
  }
  return parts.join('\n');
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatBytes(b) {
  if (b == null) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i];
}

const TOKEN_RE = /(?<comment>\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*|<!--[\s\S]*?-->)|(?<str>'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)|(?<num>\b\d+(?:\.\d+)?\b)|(?<fn>[A-Za-z_$][\w$]*(?=\())|(?<tag><\/?[A-Za-z][\w-]*|<!DOCTYPE[^>]*|<\?[\s\S]*?\?>)|(?<word>[A-Za-z_$][\w$]*)/g;

const LANG_KEYWORDS = {
  bash: ['if','then','else','elif','fi','for','while','do','done','case','esac','in','function','local','return','exit','echo','export','cd','sudo','cat','ls','grep','sed','awk','curl','git','npm','pip','python3','node'],
  python: ['def','class','import','from','as','return','if','elif','else','for','while','try','except','finally','with','pass','break','continue','lambda','yield','raise','in','not','and','or','True','False','None'],
  javascript: ['const','let','var','function','return','if','else','for','while','do','switch','case','break','continue','new','class','extends','super','try','catch','finally','throw','typeof','instanceof','of','async','await','yield','import','from','export'],
  typescript: ['interface','type','implements','public','private','protected','readonly','namespace','declare','abstract','keyof','enum','satisfies'],
  css: ['important','inherit','initial','unset','media','keyframes','from','to','root','hover','focus','active','none','auto','solid','absolute','relative','fixed','sticky','block','inline','flex','grid','hidden','solid'],
  json: ['true','false','null'],
  markdown: [],
  plaintext: [],
};

function highlight(code, lang) {
  code = code == null ? '' : String(code);
  const key = String(lang || '').toLowerCase().split(/[-_]/)[0];
  const kws = new Set(LANG_KEYWORDS[key] || LANG_KEYWORDS.plaintext);
  let out = '';
  let last = 0;
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(code)) !== null) {
    if (m[0].length === 0) { TOKEN_RE.lastIndex++; continue; }
    out += esc(code.slice(last, m.index));
    const g = m.groups || {};
    let cls = 'tok-plain';
    if (g.comment) cls = 'tok-com';
    else if (g.str) cls = 'tok-str';
    else if (g.num) cls = 'tok-num';
    else if (g.fn) cls = 'tok-fn';
    else if (g.tag) cls = 'tok-tag';
    else if (g.word && kws.has(g.word)) cls = 'tok-kw';
    out += '<span class="' + cls + '">' + esc(m[0]) + '</span>';
    last = m.index + m[0].length;
  }
  out += esc(code.slice(last));
  return out;
}

function mdInline(t) {
  let s = esc(t);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/_([^_]+)_/g, '<em>$1</em>');
  return s;
}

function md(text) {
  text = text || '';
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  let inCode = false;
  const codeLines = [];
  let codeLang = '';
  const isSpecial = (l) =>
    /^\s*$/.test(l) ||
    /^(#{1,6})\s/.test(l) ||
    /^\s*```/.test(l) ||
    /^\s*>/.test(l) ||
    /^\s*[-*]\s+/.test(l) ||
    /^\s*\d+[.)]\s+/.test(l) ||
    /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      if (!inCode) { inCode = true; codeLines.length = 0; codeLang = fence[1] || ''; }
      else {
        inCode = false;
        out.push('<pre><code' + (codeLang ? ' class="language-' + esc(codeLang) + '"' : '') + '>' + highlight(codeLines.join('\n'), codeLang) + '</code></pre>');
      }
      i++;
      continue;
    }
    if (inCode) { codeLines.push(line); i++; continue; }
    if (/^\s*$/.test(line)) { i++; continue; }
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) { out.push('<h' + m[1].length + '>' + mdInline(m[2]) + '</h' + m[1].length + '>'); i++; continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr/>'); i++; continue; }
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push('<blockquote>' + md(buf.join('\n')) + '</blockquote>');
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        const re = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/;
        if (!re.test(l)) break;
        items.push(l.replace(re, ''));
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push('<' + tag + '>' + items.map((it) => '<li>' + mdInline(it) + '</li>').join('') + '</' + tag + '>');
      continue;
    }
    const buf = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isSpecial(lines[i])) { buf.push(lines[i]); i++; }
    out.push('<p>' + buf.map((l) => mdInline(l)).join('<br/>') + '</p>');
  }
  if (inCode) out.push('<pre><code>' + esc(codeLines.join('\n')) + '</code></pre>');
  return out.join('\n');
}

// ================= api =================

async function loadSessions() {
  try {
    const data = await api('/api/sessions');
    if (data.ok) state.sessions = data.data.sessions || [];
    renderSessions();
  } catch { /* ignore */ }
}

function sessionDisplayName(s) {
  const base = (s.path || '').split('/').pop() || '';
  return base.replace(/\.jsonl$/, '');
}

function renderSessions() {
  const list = $('#session-list');
  list.innerHTML = '';
  const sessions = state.sessions || [];
  if (!sessions.length) {
    $('#sessions-empty').style.display = 'block';
    return;
  }
  $('#sessions-empty').style.display = 'none';
  for (const s of sessions) {
    const div = document.createElement('div');
    div.className = 'session-item';
    const nameEl = document.createElement('div');
    nameEl.className = 'session-name';
    nameEl.textContent = sessionDisplayName(s);
    const meta = document.createElement('div');
    meta.className = 'session-meta';
    meta.textContent = new Date(s.mtime * 1000).toLocaleString();
    const dirEl = document.createElement('div');
    dirEl.className = 'session-meta';
    dirEl.textContent = s.dir || '';
    const sizeEl = document.createElement('div');
    sizeEl.className = 'session-meta';
    sizeEl.textContent = formatBytes(s.size) + ' · ' + (s.messages || 0) + ' msgs';
    div.appendChild(nameEl);
    div.appendChild(meta);
    div.appendChild(dirEl);
    div.appendChild(sizeEl);
    div.addEventListener('click', () => loadSession(s.path));
    list.appendChild(div);
  }
}

async function loadSession(path) {
  try {
    const resp = await cmd({ type: 'switch_session', sessionPath: path });
    if (resp && resp.cancelled) { toast('Session switch was cancelled', 'error'); return; }
  } catch { toast('Failed to load session', 'error'); return; }
  state.items = [];
  state.toolBlocks.clear();
  state.streamingItem = null;
  state.queue = { steering: [], followUp: [] };
  state.historyMessages = [];
  state.historyVisible = 50;
  renderConversation();
  try {
    const data = await cmd({ type: 'get_messages' });
    const messages = (data && data.messages) || [];
    state.historyMessages = messages;
    renderHistorySlice();
  } catch { /* ignore */ }
  await refreshState();
  await refreshStats();
}

function renderHistorySlice() {
  const messages = state.historyMessages || [];
  const count = Math.min(state.historyVisible || 50, messages.length);
  state.items = [];
  state.toolBlocks.clear();
  const slice = messages.slice(-count);
  for (const m of slice) handleMessageStart(m);
  renderConversation({ noScroll: true });
}

// ================= token =================

const TOKEN_STORAGE_KEY = 'pi_token';

function getStoredToken() {
  try { return sessionStorage.getItem(TOKEN_STORAGE_KEY); } catch { return null; }
}

function setStoredToken(t) {
  try {
    if (t) sessionStorage.setItem(TOKEN_STORAGE_KEY, t);
    else sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch { /* ignore */ }
}

function getAccessLink(token) {
  const t = token || state.token;
  const origin = window.location.origin;
  return t ? origin + '/?token=' + encodeURIComponent(t) : origin;
}

function setAuthenticated(v) {
  $('#queue').classList.toggle('hidden', !v);
  $('#composer-wrap').classList.toggle('hidden', !v);
  $('#statsbar').classList.toggle('hidden', !v);
}

function showAuthGate(token) {
  state.authGateToken = token || null;
  const inner = $('#messages-inner');
  inner.innerHTML = '';
  const w = el('div', 'welcome');
  const card = el('div', 'welcome-card auth-card');
  const h = el('h1', null, 'π web ui');
  const p1 = el('p', null, 'This browser does not have a valid access token.');
  const steps = el('ol', 'auth-steps');
  const li1 = el('li', null, 'Start the pi web ui server. On startup it prints an access link containing your access token.');
  const li2 = el('li', null, 'Open that access link in this browser. The access token is stored in browser memory and you are redirected to the top page without the token.');
  steps.appendChild(li1); steps.appendChild(li2);
  card.appendChild(h); card.appendChild(p1); card.appendChild(steps);
  const t = state.authGateToken;
  if (t) {
    const p2 = el('p', null, 'To get your access link, open this URL in this browser:');
    const row = document.createElement('div');
    row.className = 'auth-link-row';
    const code = el('code', null, getAccessLink(t));
    row.appendChild(code);
    p2.appendChild(row);
    card.appendChild(p2);
  }
  const p3 = el('p', null, 'The access token is valid for 5 minutes and is regenerated automatically. When it is regenerated, the server prints a new access link and pushes the new token to connected browsers over the event stream.');
  card.appendChild(p3);
  const copyBtn = document.createElement('button');
  copyBtn.className = 'auth-copy';
  copyBtn.textContent = 'Copy access link';
  copyBtn.addEventListener('click', () => { copyText(getAccessLink(state.authGateToken)).then(() => { copyBtn.textContent = 'Copied!'; setTimeout(() => { copyBtn.textContent = 'Copy access link'; }, 1500); }); });
  card.appendChild(copyBtn);
  w.appendChild(card);
  inner.appendChild(w);
  setAuthenticated(false);
}

function handleUnauthorized() {
  const hadToken = state.token;
  state.token = null;
  setStoredToken(null);
  if (es) { es.close(); es = null; }
  showAuthGate(hadToken || null);
}

async function api(path, opts) {
  opts = opts || {};
  if (state.token) {
    opts.headers = Object.assign({}, opts.headers, { Authorization: 'Bearer ' + state.token });
  }
  const r = await fetch(path, opts);
  if (r.status === 401) { handleUnauthorized(); }
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, ...j };
}

async function cmd(cmdObj) {
  const j = await api('/api/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cmdObj),
  });
  if (!j.ok) throw new Error((j.error) || ('Command failed with status ' + j.status));
  return j.data;
}

function toast(msg, type) {
  const t = document.createElement('div');
  t.className = 'toast' + (type ? ' ' + type : '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 5000);
}

async function copyText(t) {
  const text = t == null ? '' : String(t);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function enhanceCodeBlocks(container) {
  if (!container || !container.querySelectorAll) return;
  const pres = container.querySelectorAll('pre');
  pres.forEach(pre => {
    if (pre.querySelector('.codeblock-header')) return;
    const code = pre.querySelector('code');
    const lang = code ? (code.getAttribute('class') || '').replace(/^language-/, '') : '';
    const header = document.createElement('div');
    header.className = 'codeblock-header';
    const langEl = document.createElement('span');
    langEl.className = 'codeblock-lang';
    langEl.textContent = lang || 'code';
    const btn = document.createElement('button');
    btn.className = 'codeblock-copy';
    btn.textContent = 'Copy';
    btn.addEventListener('click', () => {
      const val = code ? code.textContent : pre.textContent;
      copyText(val).then(() => { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); });
    });
    header.appendChild(langEl);
    header.appendChild(btn);
    pre.insertBefore(header, pre.firstChild);
  });
}

async function postUiResponse(rec) {
  try { await api('/api/ui-response', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rec) }); } catch { /* ignore */ }
}

// ================= sse =================

let es = null;

function connectEvents() {
  if (es) { es.close(); es = null; }
  if (!state.token) return;
  es = new EventSource('/api/events?token=' + encodeURIComponent(state.token));
  es.onmessage = (ev) => {
    let rec;
    try { rec = JSON.parse(ev.data); } catch { return; }
    handleEvent(rec);
  };
  es.onerror = () => { /* EventSource auto-retries */ };
}

async function refreshState() {
  try {
    const data = await cmd({ type: 'get_state' });
    if (data) {
      state.streaming = !!data.isStreaming;
      state.model = data.model || null;
      state.thinkingLevel = data.thinkingLevel || null;
      state.sessionName = data.sessionName || null;
      syncControlsNow();
      setStatus(data.isStreaming ? 'streaming' : 'idle', data.isStreaming ? 'pill-streaming' : 'pill-idle');
      $('#btn-abort').classList.toggle('hidden', !data.isStreaming);
      renderSessionName();
    }
  } catch { /* ignore */ }
}

async function refreshStats() {
  try {
    const data = await cmd({ type: 'get_session_stats' });
    if (data) state.stats = data;
    renderStats();
  } catch { /* ignore */ }
}

// ================= events =================

function handleEvent(rec) {
  const t = rec.type;
  switch (t) {
    case 'agent_start':
      state.streaming = true;
      state.streamingItem = null;
      setStatus('streaming', 'pill-streaming');
      $('#btn-abort').classList.remove('hidden');
      break;
    case 'agent_end':
      break;
    case 'agent_settled':
      state.streaming = false;
      state.retry = null;
      refreshState();
      refreshStats();
      break;
    case 'turn_start':
    case 'turn_end':
      break;
    case 'message_start':
      handleMessageStart(rec.message);
      break;
    case 'message_update':
      handleMessageUpdate(rec);
      break;
    case 'message_end':
      handleMessageEnd(rec.message);
      break;
    case 'tool_execution_start':
      handleToolExecutionStart(rec);
      break;
    case 'tool_execution_update':
      handleToolExecutionUpdate(rec);
      break;
    case 'tool_execution_end':
      handleToolExecutionEnd(rec);
      break;
    case 'queue_update':
      state.queue = { steering: rec.steering || [], followUp: rec.followUp || [] };
      renderQueue();
      break;
    case 'thinking_level_changed':
      state.thinkingLevel = rec.level;
      syncThinkingUI();
      break;
    case 'session_info_changed':
      state.sessionName = rec.name !== undefined ? rec.name : null;
      renderSessionName();
      break;
    case 'auto_retry_start':
      state.retry = { attempt: rec.attempt, maxAttempts: rec.maxAttempts, errorMessage: rec.errorMessage };
      renderRetry();
      break;
    case 'auto_retry_end':
      state.retry = null;
      renderRetry();
      break;
    case 'extension_error':
      toast('Extension error: ' + (rec.error || ''), 'error');
      break;
    case 'extension_ui_request':
      handleExtensionUI(rec);
      break;
    case 'extension_ui_response':
      break;
    case 'token_rotated': {
      const newToken = rec.token;
      if (!newToken) break;
      state.token = newToken;
      setStoredToken(newToken);
      setAuthenticated(true);
      connectEvents();
      toast('Access token rotated. New access link: ' + window.location.origin + '/?token=' + newToken);
      break;
    }
    default:
      break;
  }
}

// ================= messages =================

function makeBlock(b) {
  if (b.type === 'thinking') return { type: 'thinking', text: b.thinking || '', open: false };
  if (b.type === 'toolCall') {
    return { type: 'toolCall', id: b.id, toolName: b.name, arguments: b.arguments || {}, rawArgs: JSON.stringify(b.arguments || {}), status: 'pending', resultText: '', isError: false, open: true };
  }
  if (b.type === 'text') return { type: 'text', text: b.text || '' };
  return null;
}

function handleMessageStart(msg) {
  const role = msg.role;
  if (role === 'user') {
    const text = (extractText(msg.content) || '').trim();
    if (text) state.items.push({ kind: 'user', text });
    renderConversation();
  } else if (role === 'assistant') {
    const item = { kind: 'assistant', blocks: [], stopReason: msg.stopReason || 'pending', usage: msg.usage || null, errorMessage: msg.errorMessage || null, done: false };
    const content = msg.content || [];
    const blocks = [];
    for (let i = 0; i < content.length; i++) {
      const nb = makeBlock(content[i]);
      if (nb) blocks[i] = nb;
    }
    item.blocks = blocks;
    state.items.push(item);
    state.streamingItem = item;
    renderConversation();
  } else if (role === 'toolResult') {
    const bid = msg.toolCallId;
    let b = state.toolBlocks.get(bid);
    if (!b) {
      b = { type: 'toolCall', id: bid, toolName: msg.toolName || '', arguments: {}, rawArgs: '{}', status: 'ok', resultText: '', isError: false, open: true };
      state.toolBlocks.set(bid, b);
    }
    b.isError = !!msg.isError;
    b.resultText = extractText(msg.content);
    b.status = 'ok';
    updateToolCard(b);
  } else if (role === 'custom') {
    const text = extractText(msg.content) || '';
    if (msg.display !== false && text.trim()) state.items.push({ kind: 'custom', text });
    renderConversation();
  } else if (role === 'branchSummary' || role === 'compactionSummary') {
    state.items.push({ kind: 'summary', text: msg.summary || '' });
    renderConversation();
  }
}

function handleMessageEnd(msg) {
  const item = state.streamingItem;
  if (item && item.kind === 'assistant') {
    item.stopReason = msg.stopReason;
    item.usage = msg.usage || item.usage;
    item.errorMessage = msg.errorMessage || null;
    item.done = true;
    if (item.usage) {
      state.stats = Object.assign({}, state.stats || {}, { tokens: item.usage, cost: item.usage.cost, assistantUsage: item.usage });
    }
    renderStats();
  }
}

function handleMessageUpdate(rec) {
  const item = state.streamingItem;
  const ev = rec.assistantMessageEvent;
  if (!item || !ev) return;
  let b = item.blocks[ev.contentIndex];
  let created = false;
  if (!b) {
    if (ev.type === 'thinking_start') b = { type: 'thinking', text: '', open: false };
    else if (ev.type === 'toolcall_start') b = { type: 'toolCall', id: ev.id, toolName: ev.toolName, arguments: {}, rawArgs: '', status: 'running', resultText: '', isError: false, open: true };
    else b = { type: 'text', text: '' };
    item.blocks[ev.contentIndex] = b;
    created = true;
  }
  if (created) renderConversation();
  switch (ev.type) {
    case 'text_start':
      b.type = 'text'; b.text = ''; b.state = 'open';
      break;
    case 'text_delta':
      b.type = 'text'; b.text += ev.delta;
      if (b.el) { b.el.innerHTML = md(b.text); enhanceCodeBlocks(b.el); }
      break;
    case 'text_end':
      b.type = 'text'; b.text = ev.content != null ? ev.content : b.text; b.state = 'closed';
      if (b.el) { b.el.innerHTML = md(b.text); enhanceCodeBlocks(b.el); }
      break;
    case 'thinking_start':
      b.type = 'thinking'; b.text = ''; b.open = false; b.state = 'open';
      break;
    case 'thinking_delta':
      b.type = 'thinking'; b.text += ev.delta;
      if (b.el && b.open) b.textEl.textContent = b.text;
      break;
    case 'thinking_end':
      b.type = 'thinking'; b.text = ev.thinking != null ? ev.thinking : b.text; b.state = 'closed';
      if (b.el && b.open) b.textEl.textContent = b.text;
      break;
    case 'toolcall_start':
      b.type = 'toolCall'; b.id = ev.id; b.toolName = ev.toolName; b.arguments = {}; b.rawArgs = ''; b.status = 'running'; b.resultText = ''; b.isError = false; b.open = true;
      state.toolBlocks.set(ev.id, b);
      break;
    case 'toolcall_delta':
      if (b && b.type === 'toolCall') {
        b.rawArgs += ev.delta;
        try { b.arguments = JSON.parse(b.rawArgs); } catch { /* partial json */ }
        updateToolCard(b);
      }
      break;
    case 'toolcall_end':
      if (b && b.type === 'toolCall') {
        const tc = ev.toolCall || { id: ev.id, name: ev.toolName, arguments: b.arguments || {} };
        b.id = tc.id; b.toolName = tc.name; b.arguments = tc.arguments || {}; b.rawArgs = JSON.stringify(tc.arguments || {});
        updateToolCard(b);
      }
      break;
    case 'done':
      break;
    case 'error':
      if (b) b.status = 'error';
      break;
  }
  if (rec.usage && item) item.usage = rec.usage;
}

function handleToolExecutionStart(rec) {
  const bid = rec.toolCallId;
  let b = state.toolBlocks.get(bid);
  if (!b) {
    b = { type: 'toolCall', id: bid, toolName: rec.toolName || '', arguments: rec.args || {}, rawArgs: JSON.stringify(rec.args || {}), status: 'running', resultText: '', isError: false, open: true };
    state.toolBlocks.set(bid, b);
  }
  b.toolName = rec.toolName || b.toolName;
  b.arguments = rec.args || b.arguments;
  b.rawArgs = JSON.stringify(rec.args || {});
  b.status = 'running';
  if (!b.el) renderConversation();
}

function handleToolExecutionUpdate(rec) {
  const b = state.toolBlocks.get(rec.toolCallId);
  if (!b) return;
  b.status = 'running';
  if (b.type === 'toolCall' && String(b.toolName).includes('bash')) {
    b.output = (b.output || '') + extractText(rec.partialResult && rec.partialResult.content);
    updateToolCard(b);
  }
}

function handleToolExecutionEnd(rec) {
  const b = state.toolBlocks.get(rec.toolCallId);
  if (!b) return;
  b.status = rec.isError ? 'error' : 'ok';
  b.durationMs = rec.durationMs;
  b.resultText = extractText(rec.result && rec.result.content);
  b.output = b.resultText;
  updateToolCard(b);
}

// ================= rendering =================

function renderConversation(opts) {
  opts = opts || {};
  const inner = $('#messages-inner');
  inner.innerHTML = '';
  if (!state.items.length) {
    const w = el('div', 'welcome');
    const card = el('div', 'welcome-card');
    const h = el('h1', null, 'π web ui');
    const p1 = el('p', null, 'Chat with your pi coding agent.');
    const p2 = el('p', null, 'Prompts are sent to <code>pi --mode rpc</code> over a JSONL bridge.');
    const p3 = el('p', null, 'The agent can read, write, and run tools in the workspace.');
    card.appendChild(h); card.appendChild(p1); card.appendChild(p2); card.appendChild(p3);
    w.appendChild(card);
    inner.appendChild(w);
    return;
  }
  for (const item of state.items) {
    const e = createItemEl(item);
    if (e) inner.appendChild(e);
  }
  if (!opts || !opts.noScroll) scrollToBottom();
}

function createItemEl(item) {
  if (item.kind === 'user') {
    const wrap = el('div', 'msg user');
    const content = el('div', 'msg-content');
    const bubble = el('div', 'user-bubble');
    bubble.innerHTML = md(item.text);
    content.appendChild(bubble);
    const actions = el('div', 'msg-actions');
    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-action-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => { copyText(item.text).then(() => { copyBtn.textContent = 'Copied!'; setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500); }); });
    actions.appendChild(copyBtn);
    content.appendChild(actions);
    wrap.appendChild(content);
    return wrap;
  }
  if (item.kind === 'assistant') {
    const wrap = el('div', 'msg assistant');
    const content = el('div', 'msg-content');
    const body = el('div', 'assistant-body');
    const blocksEl = el('div', 'blocks');
    const blocks = item.blocks || [];
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b) blocksEl.appendChild(createBlockEl(b));
    }
    body.appendChild(blocksEl);
    content.appendChild(body);
    wrap.appendChild(content);
    if (item.errorMessage) {
      const errEl = el('div', 'block-text md');
      errEl.style.cssText = 'border:1px solid #a12622; background:rgba(248,81,73,0.08); color:#ff8f88; border-radius:8px; padding:8px 10px; white-space:pre-wrap;';
      errEl.innerHTML = '<strong>Error</strong> ' + esc(item.errorMessage);
      blocksEl.appendChild(errEl);
    }
    const actions = el('div', 'msg-actions');
    const copyBtn = document.createElement('button');
    copyBtn.className = 'msg-action-btn';
    copyBtn.textContent = 'Copy message';
    copyBtn.addEventListener('click', () => {
      let mdText = '';
      if (item.kind === 'assistant') {
        const parts = [];
        for (const b of item.blocks || []) { if (b.type === 'text') parts.push(b.text || ''); }
        mdText = parts.join('\n\n');
      }
      copyText(mdText).then(() => { copyBtn.textContent = 'Copied!'; setTimeout(() => { copyBtn.textContent = 'Copy message'; }, 1500); });
    });
    actions.appendChild(copyBtn);
    content.appendChild(actions);
    return wrap;
  }
  if (item.kind === 'custom' || item.kind === 'summary') {
    const wrap = el('div', 'msg ' + item.kind);
    const content = el('div', 'msg-content');
    const b = el('div', 'user-bubble');
    b.innerHTML = md(item.text);
    content.appendChild(b);
    wrap.appendChild(content);
    return wrap;
  }
  return null;
}

function createBlockEl(b) {
  if (b.type === 'text') {
    const d = el('div', 'block-text md');
    d.innerHTML = md(b.text);
    enhanceCodeBlocks(d);
    b.el = d;
    return d;
  }
  if (b.type === 'thinking') {
    const det = document.createElement('details');
    det.className = 'block block-thinking' + (b.open ? ' open' : '');
    const sum = document.createElement('summary');
    const lbl = document.createElement('span');
    lbl.className = 'thinking-label';
    lbl.textContent = 'Thinking';
    sum.appendChild(lbl);
    det.appendChild(sum);
    const content = document.createElement('div');
    content.className = 'thinking-content';
    const inner = document.createElement('div');
    inner.className = 'thinking-text';
    content.appendChild(inner);
    det.appendChild(content);
    b.el = det;
    b.textEl = inner;
    b.open = !!b.open;
    det.addEventListener('toggle', () => { b.open = det.open; });
    if (b.text) inner.textContent = b.text;
    return det;
  }
  if (b.type === 'toolCall') {
    const det = document.createElement('details');
    det.className = 'block tool';
    if (b.open) det.open = true;
    const sum = document.createElement('summary');
    const statusEl = document.createElement('span');
    statusEl.className = 'tool-status ' + (b.status || 'pending');
    statusEl.textContent = b.status === 'running' ? 'running' : b.status;
    const nameEl = document.createElement('span');
    nameEl.className = 'tool-name';
    nameEl.textContent = b.toolName;
    const descEl = document.createElement('span');
    descEl.className = 'tool-desc';
    descEl.textContent = describeArgs(b.arguments);
    sum.appendChild(statusEl);
    sum.appendChild(nameEl);
    sum.appendChild(descEl);
    det.appendChild(sum);
    const body = document.createElement('div');
    body.className = 'tool-body';
    const cmdWrap = document.createElement('div');
    const cmdPre = document.createElement('pre');
    cmdPre.className = 'bash-command';
    cmdPre.innerHTML = highlight((b.arguments && b.arguments.command) || '', 'bash');
    const outWrap = document.createElement('div');
    const outPre = document.createElement('pre');
    outPre.className = 'bash-output';
    outPre.textContent = b.output || '';
    cmdWrap.appendChild(cmdPre);
    outWrap.appendChild(outPre);
    body.appendChild(cmdWrap);
    body.appendChild(outWrap);
    const argsWrap = document.createElement('div');
    const argsPre = document.createElement('pre');
    argsPre.className = 'tool-args';
    argsPre.textContent = JSON.stringify(b.arguments || {}, null, 2);
    argsWrap.appendChild(argsPre);
    body.appendChild(argsWrap);
    const resWrap = document.createElement('div');
    const resPre = document.createElement('pre');
    resPre.className = 'tool-result';
    resPre.textContent = b.resultText || '';
    resWrap.appendChild(resPre);
    body.appendChild(resWrap);
    det.appendChild(body);
    b.el = det;
    b.statusEl = statusEl;
    b.argsEl = argsPre;
    b.resultEl = resPre;
    b.outputEl = outPre;
    b.commandEl = cmdPre;
    det.addEventListener('toggle', () => { b.open = det.open; });
    return det;
  }
  return null;
}

function describeArgs(args) {
  if (!args) return '';
  const keys = Object.keys(args);
  if (!keys.length) return '';
  if (args.command) return args.command;
  if (keys.length <= 3) return JSON.stringify(args);
  return keys.slice(0, 3).map((k) => k + ': ' + JSON.stringify(args[k])).join(', ') + ', …';
}

function updateToolCard(b) {
  if (!b.el) return;
  b.statusEl.className = 'tool-status ' + (b.status || 'pending');
  b.statusEl.textContent = b.status === 'running' ? 'running' : b.status;
  b.el.classList.toggle('error', b.status === 'error');
  if (b.type === 'toolCall') {
    if (b.arguments && b.arguments.command) b.commandEl.innerHTML = highlight(b.arguments.command, 'bash');
    b.argsEl.textContent = JSON.stringify(b.arguments || {}, null, 2);
    b.resultEl.textContent = b.resultText || '';
    b.outputEl.textContent = b.output != null ? b.output : (b.resultText || '');
  }
}

function renderQueue() {
  const q = $('#queue');
  const items = $('#queue-items');
  const all = [...state.queue.steering, ...state.queue.followUp];
  if (!all.length) { q.classList.add('hidden'); return; }
  q.classList.remove('hidden');
  items.innerHTML = '';
  for (const m of all) {
    const c = document.createElement('div');
    c.className = 'queue-chip';
    c.textContent = m;
    items.appendChild(c);
  }
}

function renderSessionName() {
  $('#stat-session').textContent = state.sessionName || 'session';
}

function renderRetry() {
  $('#status-text').textContent = state.retry ? 'retrying…' : 'idle';
}

// ================= controls sync =================

function syncControlsNow() {
  const sel = $('#model-select');
  const list = state.allModels || [];
  sel.innerHTML = '<option value="">model…</option>';
  for (const m of list) {
    const o = document.createElement('option');
    o.value = (m.provider || '') + '|' + (m.id || '');
    o.textContent = (m.name || m.id) + (m.reasoning ? ' · reasoning' : '');
    sel.appendChild(o);
  }
  if (state.model) {
    sel.value = (state.model.provider || '') + '|' + (state.model.id || '');
  }
}

function syncThinkingUI() {
  const think = $('#thinking-select');
  if (state.thinkingLevel && state.thinkingLevels.includes(state.thinkingLevel)) {
    think.value = state.thinkingLevel;
  }
}

function setStatus(text, cls) {
  const pill = $('#status-pill');
  pill.className = 'pill ' + (cls || 'pill-idle');
  $('#status-text').textContent = text;
}

function renderStats() {
  const stats = state.stats || {};
  const usage = (stats.assistantUsage && stats.assistantUsage.totalTokens) ? stats.assistantUsage : stats.tokens;
  $('#stat-tokens').textContent = usage && usage.totalTokens != null ? usage.totalTokens.toLocaleString() : '—';
  $('#stat-cost').textContent = stats.cost != null ? '$' + stats.cost.toFixed(4) : '—';
  const cu = stats.contextUsage;
  if (cu && cu.contextWindow) {
    const pct = cu.percent != null ? Math.round(cu.percent) : Math.round(((cu.tokens || 0) / cu.contextWindow) * 100);
    const ce = $('#stat-context');
    ce.textContent = pct + '%';
    ce.classList.toggle('warn', pct > 80);
  } else {
    $('#stat-context').textContent = '—';
  }
}

// ================= dialogs =================

function handleExtensionUI(rec) {
  const method = rec.method;
  if (method === 'notify') {
    toast(rec.message || 'notification', rec.notifyType === 'error' ? 'error' : undefined);
    return;
  }
  if (method === 'setStatus') {
    const pill = $('#status-pill');
    pill.className = 'pill ' + (rec.statusText === undefined ? 'pill-idle' : 'pill-streaming');
    return;
  }
  if (method === 'setTitle') {
    document.title = (rec.title ? 'pi — ' : '') + (rec.title || 'pi web ui');
    return;
  }
  if (method === 'set_editor_text') {
    const input = $('#input');
    input.value = rec.text || '';
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    return;
  }
  if (method === 'setWidget' || method === 'custom') return;
  state.dialog = { id: rec.id, method, title: rec.title || 'Input', options: rec.options || [], message: rec.message || '', placeholder: rec.placeholder || '', prefill: rec.prefill || '', timeout: rec.timeout };
  renderDialog();
}

function renderDialog() {
  const overlay = $('#dialog-overlay');
  const title = $('#dialog-title');
  const body = $('#dialog-body');
  const actions = $('#dialog-actions');
  const d = state.dialog;
  if (!d) { overlay.classList.add('hidden'); return; }
  overlay.classList.remove('hidden');
  title.textContent = d.title;
  actions.innerHTML = '';
  if (d.method === 'confirm') {
    body.innerHTML = '<div class="dialog-body">' + esc(d.message) + '</div>';
    const yes = document.createElement('button');
    yes.textContent = 'Yes';
    yes.classList.add('primary');
    yes.addEventListener('click', () => { postUiResponse({ id: d.id, confirmed: true }); closeDialog(); });
    const no = document.createElement('button');
    no.textContent = 'No';
    no.addEventListener('click', () => { postUiResponse({ id: d.id, cancelled: true }); closeDialog(); });
    actions.appendChild(yes); actions.appendChild(no);
  } else if (d.method === 'select') {
    const list = document.createElement('div');
    list.className = 'dialog-option-list';
    for (const opt of d.options) {
      const btn = document.createElement('button');
      btn.className = 'dialog-option';
      btn.textContent = String(opt);
      btn.addEventListener('click', () => { postUiResponse({ id: d.id, value: String(opt) }); closeDialog(); });
      list.appendChild(btn);
    }
    body.appendChild(list);
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => { postUiResponse({ id: d.id, cancelled: true }); closeDialog(); });
    actions.appendChild(cancel);
  } else {
    const inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.className = 'dialog-input';
    inputEl.placeholder = d.placeholder || '';
    if (d.method === 'editor') inputEl.value = d.prefill || '';
    body.appendChild(inputEl);
    const ok = document.createElement('button');
    ok.textContent = 'OK';
    ok.classList.add('primary');
    ok.addEventListener('click', async () => { const v = inputEl.value; await postUiResponse({ id: d.id, value: v }); closeDialog(); });
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => { postUiResponse({ id: d.id, cancelled: true }); closeDialog(); });
    actions.appendChild(ok); actions.appendChild(cancel);
    setTimeout(() => inputEl.focus(), 50);
  }
}

function closeDialog() {
  state.dialog = null;
  $('#dialog-overlay').classList.add('hidden');
}

// ================= composer =================

const input = $('#input');
const sendBtn = $('#send-btn');
const abortBtn = $('#btn-abort');

function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
}
input.addEventListener('input', autosize);
autosize();

function setSending(v) { sendBtn.disabled = v; }

async function send() {
  const text = input.value.trim();
  if (!text) return;
  setSending(true);
  try {
    await cmd({ type: 'prompt', message: text, streamingBehavior: state.streaming ? 'steer' : undefined });
  } catch {
    toast('Failed to send prompt', 'error');
  } finally {
    setSending(false);
    input.value = '';
    autosize();
  }
}

sendBtn.addEventListener('click', send);
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

abortBtn.addEventListener('click', async () => { try { await cmd({ type: 'abort' }); } catch { /* ignore */ } });

$('#btn-compact').addEventListener('click', async () => {
  try { await cmd({ type: 'compact' }); toast('Compaction requested'); } catch { toast('Compact failed', 'error'); }
});

// ================= init =================

async function loadModels() {
  try {
    const data = await cmd({ type: 'get_available_models' });
    const models = (data && data.models) || [];
    state.allModels = models;
    for (const m of models) {
      if (!m.provider) m.provider = (m.id && m.id.includes('/')) ? m.id.split('/')[0] : 'default';
    }
    syncControlsNow();
  } catch { /* ignore */ }
}

async function loadThinkingLevels() {
  try {
    const data = await cmd({ type: 'get_available_thinking_levels' });
    const levels = (data && data.levels) || [];
    state.thinkingLevels = levels;
    if (state.thinkingLevel && levels.includes(state.thinkingLevel)) $('#thinking-select').value = state.thinkingLevel;
  } catch { /* ignore */ }
}

function bindControls() {
  const sel = $('#model-select');
  sel.addEventListener('change', async () => {
    const v = sel.value;
    if (!v) return;
    const [provider, id] = v.split('|');
    try {
      const data = await cmd({ type: 'set_model', provider, modelId: id });
      state.model = data;
      await loadThinkingLevels();
      toast('Switched to ' + (data.name || id));
    } catch { toast('Model switch failed', 'error'); }
  });
  $('#thinking-select').addEventListener('change', async () => {
    try { await cmd({ type: 'set_thinking_level', level: $('#thinking-select').value }); } catch { /* ignore */ }
  });
  $('#btn-sessions').addEventListener('click', async () => {
    const panel = $('#sessions-panel');
    if (panel.classList.contains('hidden')) {
      panel.classList.remove('hidden');
      await loadSessions();
    } else {
      panel.classList.add('hidden');
    }
  });
  $('#sessions-close').addEventListener('click', () => { $('#sessions-panel').classList.add('hidden'); });
}

const messagesEl = $('#messages');
messagesEl.addEventListener('scroll', () => {
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 90;
  state.autoScroll = nearBottom;
  const total = (state.historyMessages || []).length;
  const visible = state.historyVisible || 50;
  if (messagesEl.scrollTop <= 60 && visible < total) {
    state.historyVisible = Math.min(visible * 2, total);
    renderHistorySlice();
    messagesEl.scrollTop = 0;
  }
});

function scrollToBottom() {
  const el_ = $('#messages');
  el_.scrollTop = el_.scrollHeight;
}

async function init() {
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get('token');
  if (urlToken) {
    // Browser connected via the access link: store the access token in
    // browser memory and redirect to the URL without token (top page).
    setStoredToken(urlToken);
    const clean = (window.location.pathname === '/index.html') ? '/' : window.location.pathname;
    window.history.replaceState(null, '', clean + window.location.hash);
  }
  const stored = getStoredToken();
  if (stored) state.token = stored;
  if (!state.token) { showAuthGate(); return; }
  setAuthenticated(true);
  await connect();
}

async function connect() {
  connectEvents();
  let alive = true;
  try {
    const h = await api('/api/health');
    alive = h.ok;
  } catch { alive = false; }
  setStatus(alive ? 'idle' : 'agent offline', alive ? 'pill-idle' : 'pill-error');
  $('#btn-abort').classList.toggle('hidden', !alive);
  await loadModels();
  await loadThinkingLevels();
  bindControls();
  await loadSessions();
  await refreshState();
  await refreshStats();
}

document.addEventListener('DOMContentLoaded', async () => {
  await init();
  scrollToBottom();
});

globalThis.addEventListener('error', (e) => { toast('JS error: ' + e.message, 'error'); });
