/* rslack web client — plain JS, no build step. */
'use strict';

// ------------------------------------------------------------------ helpers
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
const EMOJI = ['👍', '❤️', '😂', '🎉', '🚀', '👀', '🙏', '🔥', '✅', '❌', '😮', '😢', '🤔', '👏', '💯', '🙌',
  '😄', '😅', '😎', '🥳', '🤝', '💡', '⚡', '🐛', '📌', '🍕', '☕', '🦀', '🌟', '👋', '🫡', '⏰'];

const S = {
  me: null, workspaces: [], wsId: null, channels: [], members: [], online: new Set(),
  chId: null, preview: null, msgs: new Map(), lastReadAtOpen: 0,
  panel: null, threadId: null, thread: null, search: null,
  typing: new Map(), sock: null, sockRetry: 0, connected: false, collapsed: {},
};

async function api(method, path, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch('/api' + path, opts);
  let data = null;
  try { data = await r.json(); } catch (_) { /* empty body */ }
  if (!r.ok) {
    const e = new Error((data && data.error) || r.statusText || 'Request failed');
    e.status = r.status;
    throw e;
  }
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 3200);
}

function hue(str) { let h = 0; for (const c of String(str)) h = (h * 31 + c.codePointAt(0)) >>> 0; return h % 360; }
function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
function avatar(user, size = '') {
  const name = user.display_name || user.username;
  return `<div class="avatar ${size}" style="background:hsl(${hue(user.username)} 52% 44%)" title="${esc(name)}">${esc(initials(name))}</div>`;
}
function presenceDot(uid) { return `<span class="presence-dot ${S.online.has(uid) ? 'online' : ''}" data-presence="${uid}"></span>`; }

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
function fmtTime(ms) { return timeFmt.format(new Date(ms)); }
function dayKey(ms) { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
function dayLabel(ms) {
  const d = new Date(ms), now = new Date();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (dayKey(ms) === dayKey(now.getTime())) return 'Today';
  if (dayKey(ms) === dayKey(y.getTime())) return 'Yesterday';
  return dayFmt.format(d);
}
function relTime(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return dayLabel(ms);
}
function fmtSize(n) { return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`; }

// ------------------------------------------------------------------ markdown-lite
function mentionsMe(body) {
  if (!S.me || !body) return false;
  return new RegExp(`(^|[^\\w@])@(${reEsc(S.me.username)}|here|channel)(?![\\w.-])`, 'i').test(body);
}

function fmt(src) {
  const ph = [];
  const hold = (html) => `\u0000${ph.push(html) - 1}\u0000`;
  let s = String(src);
  s = s.replace(/```(?:[\w+-]*\n)?([\s\S]*?)```/g, (_, code) => hold(`<pre>${esc(code.replace(/^\n+|\n+$/g, ''))}</pre>`));
  s = esc(s);
  s = s.replace(/`([^`\n]+)`/g, (_, c) => hold(`<code>${c}</code>`));
  s = s.replace(/\bhttps?:\/\/[^\s<]*[^\s<.,;:!?)\]'"&]/g, (url) => hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`));
  s = s.replace(/\*\*(\S(?:[^*\n]*?\S)?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w*])\*(\S(?:[^*\n]*?\S)?)\*(?![\w*])/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[^\w])_(\S(?:[^_\n]*?\S)?)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w~])~(\S(?:[^~\n]*?\S)?)~(?![\w~])/g, '$1<del>$2</del>');
  const known = new Set(S.members.map((m) => m.username));
  s = s.replace(/(^|[^\w@])@([a-z0-9_.-]{2,32})/gi, (all, pre, name) => {
    const n = name.replace(/[.-]+$/, '');
    const tail = name.slice(n.length);
    const lower = n.toLowerCase();
    if (!known.has(lower) && lower !== 'here' && lower !== 'channel') return all;
    const me = S.me && (lower === S.me.username || lower === 'here' || lower === 'channel');
    return `${pre}<span class="mention${me ? ' me' : ''}">@${n}</span>${tail}`;
  });
  s = s.split('\n').map((line) => (line.startsWith('&gt; ') ? `<blockquote>${line.slice(5)}</blockquote>` : line)).join('\n');
  s = s.replace(/\n/g, '<br>').replace(/<\/blockquote><br>/g, '</blockquote>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => ph[+i]);
}

function highlightTerms(root, terms) {
  if (!terms.length) return;
  const re = new RegExp(`(${terms.map(reEsc).join('|')})`, 'gi');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    if (!re.test(node.nodeValue)) continue;
    re.lastIndex = 0;
    const span = document.createElement('span');
    span.innerHTML = esc(node.nodeValue).replace(re, '<mark>$1</mark>');
    node.replaceWith(...span.childNodes);
  }
}

// ------------------------------------------------------------------ screens
function showScreen(id) {
  for (const s of ['auth', 'onboard', 'app']) $('#' + s).classList.toggle('hidden', s !== id);
}

let authMode = 'login';
function showAuth() {
  showScreen('auth');
  setTimeout(() => $('#auth-form [name=username]').focus(), 0);
}
$$('#auth .tab').forEach((t) => t.addEventListener('click', () => {
  authMode = t.dataset.mode;
  $$('#auth .tab').forEach((x) => x.classList.toggle('active', x === t));
  $$('.signup-only').forEach((x) => x.classList.toggle('hidden', authMode !== 'signup'));
  $('#auth-submit').textContent = authMode === 'signup' ? 'Create account' : 'Sign in';
  $('#auth-form [name=password]').autocomplete = authMode === 'signup' ? 'new-password' : 'current-password';
  $('#auth-error').textContent = '';
}));
$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = { username: f.get('username'), password: f.get('password') };
  if (authMode === 'signup') body.display_name = f.get('display_name');
  $('#auth-submit').disabled = true;
  try {
    const res = await api('POST', authMode === 'signup' ? '/auth/signup' : '/auth/login', body);
    S.me = res.user;
    e.target.reset();
    await afterLogin();
  } catch (err) {
    $('#auth-error').textContent = err.status === 401 ? 'Wrong username or password.' : err.message;
  } finally {
    $('#auth-submit').disabled = false;
  }
});

function showOnboard() {
  showScreen('onboard');
  $('#onboard-name').textContent = S.me.display_name;
}
async function createWorkspace(name) {
  const ws = await api('POST', '/workspaces', { name });
  S.workspaces = await api('GET', '/workspaces');
  showScreen('app');
  await openWorkspace(ws.id);
  return ws;
}
async function joinWorkspace(code) {
  const ws = await api('POST', '/workspaces/join', { invite_code: code });
  S.workspaces = await api('GET', '/workspaces');
  showScreen('app');
  await openWorkspace(ws.id);
  return ws;
}
$('#onboard-create').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await createWorkspace(new FormData(e.target).get('name')); } catch (err) { $('#onboard-error').textContent = err.message; }
});
$('#onboard-join').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await joinWorkspace(new FormData(e.target).get('invite_code').trim()); } catch (err) {
    $('#onboard-error').textContent = err.status === 404 ? 'No workspace with that invite code.' : err.message;
  }
});
$('#onboard-logout').addEventListener('click', logout);

async function logout() {
  try { await api('POST', '/auth/logout'); } catch (_) { /* ignore */ }
  if (S.sock) { S.sock.onclose = null; S.sock.close(); S.sock = null; }
  Object.assign(S, { me: null, workspaces: [], wsId: null, channels: [], chId: null, msgs: new Map(), panel: null });
  location.hash = '';
  showAuth();
}

async function boot() {
  try { S.me = await api('GET', '/me'); } catch (_) { return showAuth(); }
  await afterLogin();
}

function parseHash() {
  const m = location.hash.match(/^#\/ws\/(\d+)(?:\/c\/(\d+))?/);
  return m ? { ws: +m[1], ch: m[2] ? +m[2] : null } : {};
}

async function afterLogin() {
  S.workspaces = await api('GET', '/workspaces');
  connectSocket();
  if (!S.workspaces.length) return showOnboard();
  const route = parseHash();
  const saved = +localStorage.getItem('rslack.ws');
  const ws = S.workspaces.find((w) => w.id === route.ws) || S.workspaces.find((w) => w.id === saved) || S.workspaces[0];
  showScreen('app');
  await openWorkspace(ws.id, route.ws === ws.id ? route.ch : null);
}

// ------------------------------------------------------------------ workspace & sidebar
const chan = (id) => S.channels.find((c) => c.id === id);
const member = (id) => S.members.find((m) => m.id === id);
const chanLabel = (c) => (c.is_dm ? (c.dm_user ? c.dm_user.display_name : 'Direct message') : c.name);

function renderMe() {
  $('#me-name').textContent = S.me.display_name;
  $('#me-avatar').outerHTML = avatar(S.me, 'sm').replace('class="avatar sm"', 'id="me-avatar" class="avatar sm"');
}

async function openWorkspace(id, chId) {
  renderMe();
  S.wsId = id;
  localStorage.setItem('rslack.ws', id);
  closePanel();
  S.msgs.clear();
  [S.channels, S.members] = await Promise.all([
    api('GET', `/workspaces/${id}/channels`),
    api('GET', `/workspaces/${id}/members`),
  ]);
  for (const m of S.members) if (m.online) S.online.add(m.id);
  const ws = S.workspaces.find((w) => w.id === id);
  $('#ws-title').textContent = ws ? ws.name : '';
  renderRail();
  renderSidebar();
  const target = chan(chId) || S.channels.find((c) => c.name === 'general' && !c.is_dm) || S.channels[0];
  if (target) await openChannel(target.id);
}

async function refreshChannels() {
  if (!S.wsId) return;
  const [channels, members] = await Promise.all([
    api('GET', `/workspaces/${S.wsId}/channels`),
    api('GET', `/workspaces/${S.wsId}/members`),
  ]);
  S.channels = channels;
  S.members = members;
  for (const m of members) if (m.online) S.online.add(m.id); else S.online.delete(m.id);
  renderSidebar();
  if (S.chId && S.preview && chan(S.chId)) { S.preview = null; renderHeader(); mountMainComposer(); }
}

function renderRail() {
  $('#rail').innerHTML = S.workspaces.map((w) => `
    <button class="ws-icon ${w.id === S.wsId ? 'active' : ''}" data-ws="${w.id}" title="${esc(w.name)}"
      style="background:linear-gradient(135deg,hsl(${hue(w.name)} 60% 48%),hsl(${(hue(w.name) + 40) % 360} 55% 38%))">${esc(initials(w.name))}</button>`).join('')
    + '<button class="ws-icon add" id="add-ws" title="Create or join a workspace">＋</button>';
}
$('#rail').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ws]');
  if (b && +b.dataset.ws !== S.wsId) openWorkspace(+b.dataset.ws);
  if (e.target.closest('#add-ws')) addWorkspaceModal();
});

function renderSidebar() {
  const sideItem = (c) => {
    const unread = c.unread_count > 0;
    const badge = c.mention_count > 0 ? `<span class="badge">${c.mention_count}</span>` : '';
    const icon = c.is_dm
      ? `<span class="avatar-wrap">${avatar(c.dm_user || S.me, 'xs')}${presenceDot((c.dm_user || S.me).id)}</span>`
      : `<span class="hash">${c.is_private ? '🔒' : '#'}</span>`;
    const label = c.is_dm && c.dm_user && c.dm_user.id === S.me.id ? `${esc(S.me.display_name)} <span class="muted">(you)</span>` : esc(chanLabel(c));
    return `<li class="${c.id === S.chId ? 'active' : ''} ${unread ? 'unread' : ''}" data-ch="${c.id}">
      <div class="side-item">${icon}<span class="label">${label}</span>${badge}</div></li>`;
  };
  $('#channel-list').innerHTML = S.channels.filter((c) => !c.is_dm).map(sideItem).join('')
    || '<li class="muted small" style="padding:4px 12px">No channels yet</li>';
  $('#dm-list').innerHTML = S.channels.filter((c) => c.is_dm).map(sideItem).join('')
    || '<li class="muted small" style="padding:4px 12px">No conversations yet</li>';
  $('#channel-list').classList.toggle('collapsed', !!S.collapsed.channels);
  $('#dm-list').classList.toggle('collapsed', !!S.collapsed.dms);
  const total = S.channels.reduce((n, c) => n + c.mention_count, 0);
  const anyUnread = S.channels.some((c) => c.unread_count > 0);
  document.title = `${total ? `(${total}) ` : anyUnread ? '* ' : ''}rslack`;
}
$('#sidebar').addEventListener('click', (e) => {
  const li = e.target.closest('[data-ch]');
  if (li) openChannel(+li.dataset.ch);
  const t = e.target.closest('.side-toggle');
  if (t) { const k = t.dataset.section; S.collapsed[k] = !S.collapsed[k]; t.classList.toggle('collapsed', S.collapsed[k]); renderSidebar(); }
});
$('#new-channel-btn').addEventListener('click', createChannelModal);
$('#browse-btn').addEventListener('click', browseModal);
$('#new-dm-btn').addEventListener('click', newDmModal);
$('#logout-btn').addEventListener('click', logout);
$('#theme-btn').addEventListener('click', () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
  localStorage.setItem('rslack.theme', t);
});
$('#ws-menu-btn').addEventListener('click', (e) => {
  const ws = S.workspaces.find((w) => w.id === S.wsId);
  openMenu(e.currentTarget, [
    ['Invite people to ' + ws.name, inviteModal],
    ['Create a channel', createChannelModal],
    ['Browse channels', browseModal],
    null,
    ['Create or join a workspace', addWorkspaceModal],
    ['Sign out', logout],
  ]);
});

// ------------------------------------------------------------------ channel view
function current() { return chan(S.chId) || S.preview; }

async function openChannel(id, opts = {}) {
  S.chId = id;
  let c = chan(id);
  S.preview = null;
  if (!c) {
    const browse = await api('GET', `/workspaces/${S.wsId}/channels/browse`);
    const b = browse.find((x) => x.id === id);
    if (!b) { toast('Channel not found'); return; }
    S.preview = { ...b, is_private: false, is_dm: false, last_read_id: 0, unread_count: 0, mention_count: 0 };
    c = S.preview;
  }
  history.replaceState(null, '', `#/ws/${S.wsId}/c/${id}`);
  S.lastReadAtOpen = c.last_read_id || 0;
  renderSidebar();
  renderHeader();
  $('#messages').innerHTML = '';
  mountMainComposer();
  const data = await api('GET', `/channels/${id}/messages?limit=50`);
  if (S.chId !== id) return;
  S.msgs.set(id, { list: data.messages, hasMore: data.has_more });
  renderMessages({ bottom: true });
  if (opts.flash) flashMessage(opts.flash);
  markRead();
  if (!opts.keepFocus) setTimeout(() => { const ta = $('#composer-wrap textarea'); if (ta) ta.focus(); }, 0);
}

function renderHeader() {
  const c = current();
  if (!c) return;
  if (c.is_dm) {
    const u = c.dm_user || S.me;
    $('#chan-name').innerHTML = `<span class="avatar-wrap" style="margin-right:8px;vertical-align:-4px">${avatar(u, 'sm')}${presenceDot(u.id)}</span>${esc(u.display_name)}`;
  } else {
    $('#chan-name').textContent = `${c.is_private ? '🔒 ' : '# '}${c.name}`;
  }
  $('#chan-topic').textContent = c.topic || (c.is_dm ? `@${(c.dm_user || S.me).username}` : 'Add a topic');
  $('#chan-topic').disabled = !!c.is_dm || !!S.preview;
  $('#members-count').textContent = c.member_count ?? '';
  $('#members-btn').classList.toggle('hidden', !!c.is_dm);
}
$('#chan-topic').addEventListener('click', topicModal);
$('#members-btn').addEventListener('click', membersModal);

function isNearBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 120; }

function renderMessages({ bottom = false, keepFrom = null } = {}) {
  const box = $('#messages');
  const st = S.msgs.get(S.chId);
  if (!st) return;
  const c = current();
  const wasNear = isNearBottom(box);
  const prevHeight = box.scrollHeight, prevTop = box.scrollTop;
  let html = '';
  if (st.hasMore) html += '<button class="btn load-more" data-act="older">Load older messages</button>';
  else html += c.is_dm
    ? `<div class="chan-intro">${avatar(c.dm_user || S.me)}<h2 style="margin-top:10px">${esc((c.dm_user || S.me).display_name)}</h2><p class="muted">This is the very beginning of your direct message history with <b>@${esc((c.dm_user || S.me).username)}</b>.</p></div>`
    : `<div class="chan-intro"><h2>${c.is_private ? '🔒' : '#'} ${esc(c.name)}</h2><p class="muted">This is the very beginning of the <b>${c.is_private ? '🔒' : '#'}${esc(c.name)}</b> channel.${c.topic ? ' ' + esc(c.topic) : ''}</p></div>`;
  let prev = null, newShown = false;
  for (const m of st.list) {
    if (!prev || dayKey(prev.created_at) !== dayKey(m.created_at)) {
      html += `<div class="day-divider"><span>${esc(dayLabel(m.created_at))}</span></div>`;
      prev = null;
    }
    if (!newShown && S.lastReadAtOpen && m.id > S.lastReadAtOpen && m.user_id !== S.me.id) {
      html += '<div class="new-divider">New</div>';
      newShown = true;
      prev = null;
    }
    const compact = prev && prev.user_id === m.user_id && !prev.deleted && m.created_at - prev.created_at < 5 * 60 * 1000;
    html += msgHtml(m, { compact });
    prev = m;
  }
  box.innerHTML = html;
  if (bottom || (keepFrom === null && wasNear)) box.scrollTop = box.scrollHeight;
  else if (keepFrom === 'top') box.scrollTop = box.scrollHeight - prevHeight + prevTop;
  else box.scrollTop = prevTop;
}

function msgHtml(m, { compact = false, inThread = false } = {}) {
  const mine = m.user_id === S.me.id;
  const u = { username: m.username, display_name: m.display_name };
  const body = m.deleted
    ? '<div class="msg-body deleted">This message was deleted.</div>'
    : `<div class="msg-body">${m.body ? fmt(m.body) : ''}${m.edited_at ? '<span class="edited">(edited)</span>' : ''}</div>`;
  const atts = !m.deleted && m.attachments.length ? `<div class="attachments">${m.attachments.map((a) => (
    a.content_type.startsWith('image/') && !a.content_type.includes('svg')
      ? `<a href="${esc(a.url)}" target="_blank" rel="noopener"><img class="att-img" src="${esc(a.url)}" alt="${esc(a.filename)}" loading="lazy"></a>`
      : `<a class="att-file" href="${esc(a.url)}" target="_blank" rel="noopener" download="${esc(a.filename)}"><span class="ico">📄</span><span class="meta"><b>${esc(a.filename)}</b><span class="muted">${fmtSize(a.size)}</span></span></a>`
  )).join('')}</div>` : '';
  const reacts = m.reactions.length ? `<div class="reactions">${m.reactions.map((r) => {
    const names = r.user_ids.map((id) => (id === S.me.id ? 'You' : (member(id) || {}).display_name || 'someone')).join(', ');
    return `<button class="reaction ${r.user_ids.includes(S.me.id) ? 'mine' : ''}" data-act="react" data-emoji="${esc(r.emoji)}" title="${esc(names)} reacted with ${esc(r.emoji)}">${esc(r.emoji)}<span class="n">${r.count}</span></button>`;
  }).join('')}<button class="reaction add" data-act="pick" title="Add reaction">☺＋</button></div>` : '';
  const thread = !inThread && m.reply_count > 0
    ? `<button class="thread-link" data-act="thread"><b>${m.reply_count} ${m.reply_count === 1 ? 'reply' : 'replies'}</b><span class="muted">Last reply ${esc(relTime(m.last_reply_at))}</span></button>`
    : '';
  const canThread = !inThread && !m.parent_id && !m.deleted;
  const actions = m.deleted ? '' : `<div class="msg-actions">
      <button data-act="quick" data-emoji="👍" title="React 👍">👍</button>
      <button data-act="quick" data-emoji="🎉" title="React 🎉">🎉</button>
      <button data-act="pick" title="Add reaction">☺</button>
      ${canThread ? '<button data-act="thread" title="Reply in thread">💬</button>' : ''}
      ${mine ? '<button data-act="edit" title="Edit message">✏️</button><button data-act="delete" title="Delete message">🗑️</button>' : ''}
    </div>`;
  const head = compact
    ? `<span class="msg-gutter-time">${esc(fmtTime(m.created_at))}</span>`
    : `<div class="msg-head"><span class="msg-author">${esc(m.display_name)}</span><span class="msg-time" title="${esc(new Date(m.created_at).toLocaleString())}">${esc(fmtTime(m.created_at))}</span></div>`;
  return `<div class="msg ${compact ? 'compact' : ''} ${!m.deleted && !mine && mentionsMe(m.body) ? 'mentions-me' : ''}" data-id="${m.id}">
    ${compact ? '<div></div>' : avatar(u)}
    <div class="msg-main">${head}${body}${atts}${reacts}${thread}</div>${actions}</div>`;
}

function findMsg(id) {
  for (const st of S.msgs.values()) { const m = st.list.find((x) => x.id === id); if (m) return m; }
  if (S.thread) {
    if (S.thread.parent.id === id) return S.thread.parent;
    const r = S.thread.replies.find((x) => x.id === id);
    if (r) return r;
  }
  return null;
}

function flashMessage(id) {
  const el = $(`#messages .msg[data-id="${id}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1700);
}

async function markRead() {
  const c = chan(S.chId);
  const st = S.msgs.get(S.chId);
  if (!c || !st || !st.list.length || document.visibilityState !== 'visible') return;
  const last = Math.max(...st.list.map((m) => m.id));
  if (last <= c.last_read_id && !c.unread_count) return;
  c.last_read_id = Math.max(c.last_read_id, last);
  c.unread_count = 0;
  c.mention_count = 0;
  renderSidebar();
  try { await api('POST', `/channels/${c.id}/read`, { message_id: last }); } catch (_) { /* best effort */ }
}
document.addEventListener('visibilitychange', markRead);
window.addEventListener('focus', markRead);

async function onMessageAction(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  if (btn.dataset.act === 'older') return loadOlder();
  const el = btn.closest('.msg');
  if (!el) return;
  const id = +el.dataset.id;
  const m = findMsg(id);
  if (!m) return;
  switch (btn.dataset.act) {
    case 'react': case 'quick': return react(m, btn.dataset.emoji);
    case 'pick': return openEmojiPicker(btn, (emoji) => react(m, emoji));
    case 'thread': return openThread(m.parent_id || m.id);
    case 'edit': return startEdit(el, m);
    case 'delete': return confirmDelete(m);
    default:
  }
}
$('#messages').addEventListener('click', onMessageAction);
$('#panel-body').addEventListener('click', onMessageAction);

async function loadOlder() {
  const st = S.msgs.get(S.chId);
  if (!st || !st.list.length) return;
  const data = await api('GET', `/channels/${S.chId}/messages?limit=50&before=${st.list[0].id}`);
  st.list = data.messages.concat(st.list);
  st.hasMore = data.has_more;
  renderMessages({ keepFrom: 'top' });
}

async function react(m, emoji) {
  if (!chan(m.channel_id)) { toast('Join the channel to react'); return; }
  try {
    const res = await api('POST', `/messages/${m.id}/reactions`, { emoji });
    m.reactions = res.reactions;
    rerenderMessage(m);
  } catch (err) { toast(err.message); }
}

function rerenderMessage(m) {
  if (m.parent_id ? S.thread && S.thread.parent.id === m.parent_id : S.thread && S.thread.parent.id === m.id) renderPanel();
  if (!m.parent_id && m.channel_id === S.chId) renderMessages();
}

function startEdit(el, m) {
  const bodyEl = $('.msg-body', el);
  if (!bodyEl || $('.edit-box', el)) return;
  const box = document.createElement('div');
  box.className = 'edit-box';
  box.innerHTML = '<textarea class="field"></textarea><div class="row"><button class="btn" data-x="cancel">Cancel</button><button class="btn primary" data-x="save">Save</button></div>';
  const ta = $('textarea', box);
  ta.value = m.body;
  bodyEl.replaceWith(box);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  const done = () => rerenderMessage(m);
  const save = async () => {
    const body = ta.value.trim();
    if (body === m.body) return done();
    try { Object.assign(m, await api('PATCH', `/messages/${m.id}`, { body })); } catch (err) { toast(err.message); }
    done();
  };
  box.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target.dataset.x === 'cancel') done();
    if (e.target.dataset.x === 'save') save();
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') done();
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
  });
}

function confirmDelete(m) {
  const md = openModal('Delete message', `<p>Are you sure you want to delete this message? This can't be undone.</p>
    <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="confirm-del" style="background:var(--danger)">Delete</button></div>`);
  $('#confirm-del', md.el).addEventListener('click', async () => {
    try { await api('DELETE', `/messages/${m.id}`); applyDelete({ message_id: m.id, channel_id: m.channel_id, parent_id: m.parent_id, has_replies: m.reply_count > 0 }); } catch (err) { toast(err.message); }
    md.close();
  });
}

// ------------------------------------------------------------------ side panel: thread & search
function closePanel() {
  S.panel = null; S.threadId = null; S.thread = null; S.search = null;
  $('#panel').classList.add('hidden');
  $('#panel-composer').innerHTML = '';
}
$('#panel-close').addEventListener('click', closePanel);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal-root').children.length && !$('#popover-root').children.length && S.panel && !e.target.closest('.edit-box')) closePanel();
});

async function openThread(id) {
  S.panel = 'thread';
  S.threadId = id;
  S.search = null;
  const data = await api('GET', `/messages/${id}/thread`);
  if (S.threadId !== id) return;
  S.thread = data;
  $('#panel').classList.remove('hidden');
  renderPanel({ bottom: true });
  const c = chan(data.parent.channel_id);
  $('#panel-composer').innerHTML = '';
  if (c) {
    mountComposer($('#panel-composer'), { channelId: c.id, parentId: id, placeholder: 'Reply…' });
    setTimeout(() => $('#panel-composer textarea').focus(), 0);
  }
}

function renderPanel({ bottom = false } = {}) {
  const body = $('#panel-body');
  if (S.panel === 'thread' && S.thread) {
    const { parent, replies } = S.thread;
    const c = chan(parent.channel_id) || S.preview || {};
    $('#panel-title').textContent = 'Thread';
    $('#panel-sub').textContent = c.is_dm ? (c.dm_user ? c.dm_user.display_name : '') : `#${c.name || ''}`;
    const near = isNearBottom(body);
    let html = msgHtml(parent, { inThread: true });
    html += `<div class="reply-sep">${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}</div>`;
    let prev = null;
    for (const r of replies) {
      const compact = prev && prev.user_id === r.user_id && r.created_at - prev.created_at < 5 * 60 * 1000;
      html += msgHtml(r, { inThread: true, compact });
      prev = r;
    }
    body.innerHTML = html;
    if (bottom || near) body.scrollTop = body.scrollHeight;
  } else if (S.panel === 'search' && S.search) {
    const { q, results } = S.search;
    $('#panel-title').textContent = 'Search';
    $('#panel-sub').textContent = `${results.length} result${results.length === 1 ? '' : 's'} for “${q}”`;
    body.innerHTML = results.length ? results.map(({ message: m, channel: c }) => `
      <div class="search-result" data-ch="${c.id}" data-mid="${m.id}" data-parent="${m.parent_id || ''}">
        <div class="where">${c.is_dm ? 'Direct message' : (c.is_private ? '🔒 ' : '#') + esc(c.name)}${m.parent_id ? ' · in thread' : ''} · ${esc(dayLabel(m.created_at))}</div>
        ${msgHtml(m, { inThread: true })}
      </div>`).join('') : '<div class="empty">No messages match your search.</div>';
    highlightTerms(body, q.split(/[^\p{L}\p{N}_]+/u).filter(Boolean));
    $$('.msg-actions', body).forEach((x) => x.remove());
  }
}

$('#search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#search-input').value.trim();
  if (!q) return;
  const res = await api('GET', `/workspaces/${S.wsId}/search?q=${encodeURIComponent(q)}`);
  S.panel = 'search';
  S.thread = null;
  S.threadId = null;
  S.search = { q, results: res.results };
  $('#panel').classList.remove('hidden');
  $('#panel-composer').innerHTML = '';
  renderPanel();
});
$('#panel-body').addEventListener('click', async (e) => {
  const r = e.target.closest('.search-result');
  if (!r || e.target.closest('[data-act]')) return;
  const ch = +r.dataset.ch, mid = +r.dataset.mid, parent = +r.dataset.parent || null;
  await openChannel(ch, { flash: parent || mid, keepFocus: true });
  if (parent) openThread(parent);
});

// ------------------------------------------------------------------ composer
function mountMainComposer() {
  const wrap = $('#composer-wrap');
  wrap.innerHTML = '';
  const c = current();
  $('#join-bar').classList.toggle('hidden', !S.preview);
  if (S.preview) { $('#join-name').textContent = '#' + S.preview.name; return; }
  if (!c) return;
  const ph = c.is_dm ? `Message ${(c.dm_user || S.me).display_name}` : `Message ${c.is_private ? '🔒' : '#'}${c.name}`;
  mountComposer(wrap, { channelId: c.id, parentId: null, placeholder: ph });
}
$('#join-btn').addEventListener('click', async () => {
  const id = S.chId;
  await api('POST', `/channels/${id}/join`);
  await refreshChannels();
  S.preview = null;
  await openChannel(id);
});

function mountComposer(container, { channelId, parentId, placeholder }) {
  const node = $('#composer-tpl').content.firstElementChild.cloneNode(true);
  container.appendChild(node);
  const ta = $('textarea', node);
  const send = $('.send-btn', node);
  const preview = $('.attachments-preview', node);
  const fileInput = $('.file-input', node);
  ta.placeholder = placeholder;
  node.dataset.key = `${channelId}:${parentId || ''}`;
  const pending = []; // {id?, name, el, promise}
  let lastTyping = 0;
  let mention = null; // {start, sel, opts}

  const update = () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
    send.disabled = !ta.value.trim() && !pending.some((p) => p.id);
  };
  update();

  const doSend = async () => {
    const body = ta.value.trim();
    if (pending.some((p) => !p.id)) { toast('Wait for uploads to finish'); return; }
    const ids = pending.map((p) => p.id);
    if (!body && !ids.length) return;
    send.disabled = true;
    try {
      const m = await api('POST', `/channels/${channelId}/messages`, { body, parent_id: parentId, attachment_ids: ids });
      ta.value = '';
      lastTyping = 0; // next keystroke announces typing again
      pending.length = 0;
      preview.innerHTML = '';
      insertMessage(m, true);
    } catch (err) { toast(err.message); }
    update();
    ta.focus();
  };

  node.addEventListener('submit', (e) => { e.preventDefault(); doSend(); });

  ta.addEventListener('keydown', (e) => {
    if (mention && mention.opts.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        mention.sel = (mention.sel + (e.key === 'ArrowDown' ? 1 : -1) + mention.opts.length) % mention.opts.length;
        return renderMentionPop();
      }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return pickMention(mention.opts[mention.sel]); }
      if (e.key === 'Escape') { e.preventDefault(); return closeMention(); }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); doSend(); }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'i')) { e.preventDefault(); wrapSel(e.key === 'b' ? '**' : '_'); }
    if (e.key === 'ArrowUp' && !ta.value && !parentId) {
      const st = S.msgs.get(channelId);
      const mine = st && [...st.list].reverse().find((m) => m.user_id === S.me.id && !m.deleted);
      const el = mine && $(`#messages .msg[data-id="${mine.id}"]`);
      if (el) { e.preventDefault(); startEdit(el, mine); }
    }
  });

  ta.addEventListener('input', () => {
    update();
    const now = Date.now();
    if (ta.value && now - lastTyping > 2500 && S.sock && S.sock.readyState === 1) {
      lastTyping = now;
      S.sock.send(JSON.stringify({ type: 'typing', channel_id: channelId, parent_id: parentId }));
    }
    checkMention();
  });
  ta.addEventListener('blur', () => setTimeout(closeMention, 150));

  function wrapSel(mark, block = false) {
    const { selectionStart: a, selectionEnd: b, value: v } = ta;
    const inner = v.slice(a, b) || (block ? 'code' : 'text');
    const open = block ? `${mark}\n` : mark, close = block ? `\n${mark}` : mark;
    ta.value = v.slice(0, a) + open + inner + close + v.slice(b);
    ta.focus();
    ta.setSelectionRange(a + open.length, a + open.length + inner.length);
    update();
  }
  function insertText(t) {
    const { selectionStart: a, selectionEnd: b, value: v } = ta;
    ta.value = v.slice(0, a) + t + v.slice(b);
    ta.focus();
    ta.setSelectionRange(a + t.length, a + t.length);
    update();
  }
  $$('.fmt [data-wrap]', node).forEach((b) => b.addEventListener('click', () => wrapSel(b.dataset.wrap)));
  $$('.fmt [data-block]', node).forEach((b) => b.addEventListener('click', () => wrapSel(b.dataset.block, true)));
  $('.emoji-btn', node).addEventListener('click', (e) => openEmojiPicker(e.currentTarget, insertText));
  $('.mention-btn', node).addEventListener('click', () => { insertText((ta.value && !/\s$/.test(ta.value.slice(0, ta.selectionStart)) ? ' @' : '@')); checkMention(); });
  $('.attach-btn', node).addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { [...fileInput.files].forEach(addFile); fileInput.value = ''; });
  ta.addEventListener('paste', (e) => { const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); files.forEach(addFile); } });
  node._addFile = addFile;

  function addFile(file) {
    const p = { id: null, name: file.name };
    p.el = document.createElement('span');
    p.el.className = 'chip uploading';
    p.el.innerHTML = `📎 ${esc(file.name)} <span class="muted small">${fmtSize(file.size)}</span><button type="button" title="Remove">✕</button>`;
    preview.appendChild(p.el);
    pending.push(p);
    $('button', p.el).addEventListener('click', () => { pending.splice(pending.indexOf(p), 1); p.el.remove(); update(); });
    const fd = new FormData();
    fd.append('file', file, file.name);
    fetch('/api/uploads', { method: 'POST', body: fd, credentials: 'same-origin' })
      .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Upload failed'); return d; })
      .then((att) => { p.id = att.id; p.el.classList.remove('uploading'); update(); })
      .catch((err) => { toast(`${file.name}: ${err.message}`); pending.splice(pending.indexOf(p), 1); p.el.remove(); update(); });
  }

  function checkMention() {
    const upto = ta.value.slice(0, ta.selectionStart);
    const m = upto.match(/(^|\s)@([\w.-]*)$/);
    if (!m) return closeMention();
    const q = m[2].toLowerCase();
    const opts = S.members.filter((u) => u.username.startsWith(q) || u.display_name.toLowerCase().includes(q)).slice(0, 8);
    if (!opts.length) return closeMention();
    mention = { start: ta.selectionStart - m[2].length - 1, sel: 0, opts };
    renderMentionPop();
  }
  function renderMentionPop() {
    const pop = showPopover(node, `<div class="mention-pop">${mention.opts.map((u, i) => `
      <div class="opt ${i === mention.sel ? 'sel' : ''}" data-i="${i}"><span class="avatar-wrap">${avatar(u, 'xs')}</span><b>${esc(u.display_name)}</b><span class="sub">@${esc(u.username)}</span></div>`).join('')}</div>`, { above: true });
    pop.addEventListener('mousedown', (e) => { const o = e.target.closest('.opt'); if (o) { e.preventDefault(); pickMention(mention.opts[+o.dataset.i]); } });
  }
  function pickMention(u) {
    const v = ta.value;
    const before = v.slice(0, mention.start), after = v.slice(ta.selectionStart);
    ta.value = `${before}@${u.username} ${after}`;
    const pos = before.length + u.username.length + 2;
    ta.setSelectionRange(pos, pos);
    closeMention();
    ta.focus();
    update();
  }
  function closeMention() { if (mention) { mention = null; closePopover(); } }
  renderTyping();
  return node;
}

// drag & drop onto the main pane
(() => {
  const main = $('#main'), overlay = $('#drop-overlay');
  let depth = 0;
  main.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files') && !S.preview) { depth++; overlay.classList.remove('hidden'); } });
  main.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) overlay.classList.add('hidden'); });
  main.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  main.addEventListener('drop', (e) => {
    e.preventDefault(); depth = 0; overlay.classList.add('hidden');
    const comp = $('#composer-wrap .composer');
    if (comp && comp._addFile) [...e.dataTransfer.files].forEach(comp._addFile);
  });
})();

function renderTyping() {
  const now = Date.now();
  for (const comp of $$('.composer')) {
    const set = S.typing.get(comp.dataset.key);
    const names = set ? [...set.entries()].filter(([, v]) => v.until > now).map(([, v]) => v.name) : [];
    const el = $('.typing', comp);
    el.textContent = names.length === 0 ? '' : names.length === 1 ? `${names[0]} is typing…`
      : names.length === 2 ? `${names[0]} and ${names[1]} are typing…` : 'Several people are typing…';
  }
}
setInterval(renderTyping, 1000);

// ------------------------------------------------------------------ realtime
function connectSocket() {
  if (S.sock && S.sock.readyState <= 1) return;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`;
  const sock = new WebSocket(url);
  S.sock = sock;
  sock.onopen = () => {
    const reconnect = S.sockRetry > 0 || S.connected === 'lost';
    S.sockRetry = 0;
    S.connected = true;
    setConn('Active', true);
    if (reconnect) resync();
  };
  sock.onmessage = (e) => { try { handleEvent(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  sock.onclose = () => {
    if (S.sock !== sock) return;
    S.connected = 'lost';
    setConn('Reconnecting…', false);
    const delay = Math.min(10000, 500 * 2 ** S.sockRetry++);
    setTimeout(() => { if (S.me) connectSocket(); }, delay);
  };
}
setInterval(() => { if (S.sock && S.sock.readyState === 1) S.sock.send('{"type":"ping"}'); }, 25000);

function setConn(text, ok) {
  $('#conn-status').textContent = text;
  $('#me-presence').classList.toggle('online', ok);
}

async function resync() {
  try {
    await refreshChannels();
    if (S.chId) {
      const data = await api('GET', `/channels/${S.chId}/messages?limit=50`);
      S.msgs.set(S.chId, { list: data.messages, hasMore: data.has_more });
      renderMessages();
    }
    if (S.panel === 'thread' && S.threadId) openThread(S.threadId);
  } catch (_) { /* next reconnect will retry */ }
}

function insertMessage(m, own = false) {
  if (m.parent_id) {
    if (S.thread && S.thread.parent.id === m.parent_id && !S.thread.replies.some((r) => r.id === m.id)) {
      S.thread.replies.push(m);
      renderPanel({ bottom: own });
    }
    return;
  }
  const st = S.msgs.get(m.channel_id);
  if (st && !st.list.some((x) => x.id === m.id)) {
    st.list.push(m);
    if (m.channel_id === S.chId) {
      renderMessages({ bottom: own });
      if (m.user_id !== S.me.id) markRead();
    }
  }
  const c = chan(m.channel_id);
  if (own && c) c.last_read_id = Math.max(c.last_read_id, m.id);
}

function replaceMessage(m) {
  const st = S.msgs.get(m.channel_id);
  if (st) { const i = st.list.findIndex((x) => x.id === m.id); if (i >= 0) st.list[i] = m; }
  if (S.thread) {
    if (S.thread.parent.id === m.id) S.thread.parent = m;
    const i = S.thread.replies.findIndex((x) => x.id === m.id);
    if (i >= 0) S.thread.replies[i] = m;
  }
  rerenderMessage(m);
}

function applyDelete(ev) {
  const st = S.msgs.get(ev.channel_id);
  if (st) {
    const i = st.list.findIndex((x) => x.id === ev.message_id);
    if (i >= 0) {
      if (ev.has_replies) Object.assign(st.list[i], { deleted: true, body: '', attachments: [], reactions: [] });
      else st.list.splice(i, 1);
    }
  }
  if (S.thread) {
    if (S.thread.parent.id === ev.message_id) Object.assign(S.thread.parent, { deleted: true, body: '', attachments: [], reactions: [] });
    S.thread.replies = S.thread.replies.filter((r) => r.id !== ev.message_id);
    renderPanel();
  }
  if (ev.channel_id === S.chId) renderMessages();
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'hello':
      S.online = new Set(ev.online_user_ids);
      renderPresence();
      break;
    case 'presence':
      if (ev.online) S.online.add(ev.user_id); else S.online.delete(ev.user_id);
      renderPresence();
      break;
    case 'message.new': {
      const m = ev.message;
      const c = chan(m.channel_id);
      if (!c && !(S.preview && S.preview.id === m.channel_id)) { refreshChannels(); break; }
      insertMessage(m);
      // clear typing for that author
      const set = S.typing.get(`${m.channel_id}:${m.parent_id || ''}`);
      if (set) set.delete(m.user_id);
      renderTyping();
      if (c && !m.parent_id && m.user_id !== S.me.id && !(m.channel_id === S.chId && document.visibilityState === 'visible')) {
        c.unread_count += 1;
        if (c.is_dm || mentionsMe(m.body)) c.mention_count += 1;
        renderSidebar();
      }
      break;
    }
    case 'message.updated': replaceMessage(ev.message); break;
    case 'message.deleted': applyDelete(ev); break;
    case 'reaction.updated': {
      const m = findMsg(ev.message_id);
      if (m) { m.reactions = ev.reactions; rerenderMessage(m); }
      break;
    }
    case 'typing': {
      const key = `${ev.channel_id}:${ev.parent_id || ''}`;
      if (!S.typing.has(key)) S.typing.set(key, new Map());
      S.typing.get(key).set(ev.user_id, { name: ev.display_name, until: Date.now() + 4500 });
      renderTyping();
      break;
    }
    case 'channel.updated': {
      const c = chan(ev.channel_id);
      if (c) { c.topic = ev.topic; if (c.id === S.chId) renderHeader(); }
      break;
    }
    case 'channel.read': {
      const c = chan(ev.channel_id);
      if (c && ev.message_id >= c.last_read_id) { c.last_read_id = ev.message_id; c.unread_count = 0; c.mention_count = 0; renderSidebar(); }
      break;
    }
    case 'channels.changed': case 'channel.members_changed': case 'workspace.member_joined':
      if (!ev.workspace_id || ev.workspace_id === S.wsId) refreshChannels().then(() => { if (ev.channel_id === S.chId) renderHeader(); });
      break;
    case 'workspaces.changed':
      api('GET', '/workspaces').then((w) => { S.workspaces = w; renderRail(); });
      break;
    default:
  }
}

function renderPresence() {
  $$('[data-presence]').forEach((el) => el.classList.toggle('online', S.online.has(+el.dataset.presence)));
  for (const m of S.members) m.online = S.online.has(m.id);
}

// ------------------------------------------------------------------ popovers & modals
function showPopover(anchor, html, { above = false } = {}) {
  const root = $('#popover-root');
  root.innerHTML = `<div class="popover">${html}</div>`;
  const pop = root.firstElementChild;
  const r = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  let top = above ? r.top - pr.height - 6 : r.bottom + 6;
  if (top + pr.height > innerHeight - 8) top = r.top - pr.height - 6;
  if (top < 8) top = 8;
  let left = Math.min(r.left, innerWidth - pr.width - 8);
  pop.style.top = `${top}px`;
  pop.style.left = `${Math.max(8, left)}px`;
  return pop;
}
function closePopover() { $('#popover-root').innerHTML = ''; }
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.popover') && !e.target.closest('[data-act="pick"]') && !e.target.closest('.emoji-btn') && !e.target.closest('#ws-menu-btn')) closePopover();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopover(); });

function openEmojiPicker(anchor, onPick) {
  const pop = showPopover(anchor, `<div class="emoji-grid">${EMOJI.map((e) => `<button data-e="${e}" title="${e}">${e}</button>`).join('')}</div>`);
  pop.addEventListener('click', (e) => { const b = e.target.closest('[data-e]'); if (b) { closePopover(); onPick(b.dataset.e); } });
}

function openMenu(anchor, items) {
  const pop = showPopover(anchor, `<div class="menu">${items.map((it, i) => (it ? `<button data-i="${i}">${esc(it[0])}</button>` : '<hr>')).join('')}</div>`);
  pop.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) { closePopover(); items[+b.dataset.i][1](); } });
}

function openModal(title, html) {
  const root = $('#modal-root');
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `<div class="modal" role="dialog" aria-label="${esc(title)}"><header><h2>${esc(title)}</h2><button class="icon-btn" data-close title="Close">✕</button></header><div class="body">${html}</div></div>`;
  root.appendChild(wrap);
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  wrap.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  const first = $('input, textarea', wrap);
  if (first) setTimeout(() => first.focus(), 0);
  return { el: wrap, close };
}

function createChannelModal() {
  const md = openModal('Create a channel', `<form id="cc-form">
    <label>Name<input name="name" placeholder="e.g. plan-budget" maxlength="80" required></label>
    <label>Topic <span class="muted small">(optional)</span><input name="topic" maxlength="250" placeholder="What's this channel about?"></label>
    <div class="toggle-row"><div><b>Make private</b><div class="muted small">Only invited people can see and join it.</div></div><input type="checkbox" name="is_private"></div>
    <div class="error" id="cc-err"></div>
    <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Create</button></div></form>`);
  $('#cc-form', md.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const c = await api('POST', `/workspaces/${S.wsId}/channels`, { name: f.get('name'), topic: f.get('topic'), is_private: f.get('is_private') === 'on' });
      md.close();
      await refreshChannels();
      openChannel(c.id);
    } catch (err) { $('#cc-err', md.el).textContent = err.message; }
  });
}

async function browseModal() {
  const rows = await api('GET', `/workspaces/${S.wsId}/channels/browse`);
  const md = openModal('Browse channels', `<input id="bc-filter" placeholder="Search channels"><ul class="list" id="bc-list"></ul>`);
  const render = (q = '') => {
    $('#bc-list', md.el).innerHTML = rows.filter((r) => r.name.includes(q.toLowerCase())).map((r) => `
      <li class="clickable" data-id="${r.id}"><span class="hash" style="font-size:18px">#</span>
        <div class="grow"><b>${esc(r.name)}</b><div class="sub">${r.joined ? '<b style="color:var(--online)">✓ Joined</b> · ' : ''}${r.member_count} member${r.member_count === 1 ? '' : 's'}${r.topic ? ' · ' + esc(r.topic) : ''}</div></div>
        ${r.joined ? '<button class="btn" data-open>Open</button>' : '<button class="btn primary" data-join>Join</button>'}</li>`).join('') || '<li class="muted">No channels match.</li>';
  };
  render();
  $('#bc-filter', md.el).addEventListener('input', (e) => render(e.target.value));
  $('#bc-list', md.el).addEventListener('click', async (e) => {
    const li = e.target.closest('[data-id]');
    if (!li) return;
    const id = +li.dataset.id;
    if (e.target.closest('[data-join]')) { await api('POST', `/channels/${id}/join`); await refreshChannels(); }
    md.close();
    openChannel(id);
  });
}

function newDmModal() {
  const md = openModal('Direct messages', `<input id="dm-filter" placeholder="Find a person"><ul class="list" id="dm-people"></ul>`);
  const render = (q = '') => {
    q = q.toLowerCase();
    $('#dm-people', md.el).innerHTML = S.members.filter((u) => u.username.includes(q) || u.display_name.toLowerCase().includes(q)).map((u) => `
      <li class="clickable" data-id="${u.id}"><span class="avatar-wrap">${avatar(u)}${presenceDot(u.id)}</span>
        <div class="grow"><b>${esc(u.display_name)}</b>${u.id === S.me.id ? ' <span class="muted">(you)</span>' : ''}<div class="sub">@${esc(u.username)} · ${S.online.has(u.id) ? 'Active' : 'Away'}</div></div></li>`).join('');
  };
  render();
  $('#dm-filter', md.el).addEventListener('input', (e) => render(e.target.value));
  $('#dm-people', md.el).addEventListener('click', async (e) => {
    const li = e.target.closest('[data-id]');
    if (!li) return;
    const c = await api('POST', `/workspaces/${S.wsId}/dms`, { user_id: +li.dataset.id });
    md.close();
    await refreshChannels();
    openChannel(c.id);
  });
}

async function membersModal() {
  const c = current();
  if (!c || c.is_dm) return;
  const list = await api('GET', `/channels/${c.id}/members`);
  const canAdd = !!chan(c.id);
  const md = openModal(`${c.is_private ? '🔒' : '#'} ${c.name} · ${list.length} member${list.length === 1 ? '' : 's'}`, `
    ${canAdd ? `<form id="am-form" style="display:flex;gap:8px"><input name="username" placeholder="Add someone by @username" list="am-users"><button class="btn primary">Add</button></form>
      <datalist id="am-users">${S.members.filter((m) => !list.some((x) => x.id === m.id)).map((m) => `<option value="${esc(m.username)}">${esc(m.display_name)}</option>`).join('')}</datalist>
      <div class="error" id="am-err"></div>` : ''}
    <ul class="list">${list.map((u) => `<li><span class="avatar-wrap">${avatar(u)}${presenceDot(u.id)}</span><div class="grow"><b>${esc(u.display_name)}</b>${u.id === S.me.id ? ' <span class="muted">(you)</span>' : ''}<div class="sub">@${esc(u.username)} · ${S.online.has(u.id) ? 'Active' : 'Away'}</div></div></li>`).join('')}</ul>
    ${canAdd && c.name !== 'general' ? '<div class="actions"><button class="btn danger" id="leave-btn">Leave channel</button></div>' : ''}`);
  const form = $('#am-form', md.el);
  if (form) form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', `/channels/${c.id}/members`, { username: new FormData(form).get('username') });
      md.close();
      toast('Added to channel');
      refreshChannels().then(renderHeader);
    } catch (err) { $('#am-err', md.el).textContent = err.status === 404 ? 'No such user.' : err.message; }
  });
  const leave = $('#leave-btn', md.el);
  if (leave) leave.addEventListener('click', async () => {
    await api('POST', `/channels/${c.id}/leave`);
    md.close();
    await refreshChannels();
    const g = S.channels.find((x) => x.name === 'general') || S.channels[0];
    if (g) openChannel(g.id);
  });
}

function topicModal() {
  const c = chan(S.chId);
  if (!c || c.is_dm) return;
  const md = openModal('Edit topic', `<form id="tp-form"><input name="topic" maxlength="250" value="${esc(c.topic)}" placeholder="Add a topic">
    <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`);
  $('#tp-form', md.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('PATCH', `/channels/${c.id}`, { topic: new FormData(e.target).get('topic') });
      c.topic = r.topic;
      renderHeader();
      md.close();
    } catch (err) { toast(err.message); }
  });
}

function inviteModal() {
  const ws = S.workspaces.find((w) => w.id === S.wsId);
  const md = openModal(`Invite people to ${ws.name}`, `<p class="muted">Share this invite code. Anyone with an account on this server can use it to join.</p>
    <div class="invite-box"><code id="inv-code">${esc(ws.invite_code)}</code><button class="btn primary" id="inv-copy">Copy</button></div>`);
  $('#inv-copy', md.el).addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(ws.invite_code); toast('Invite code copied'); } catch (_) { toast('Copy failed — select the code manually'); }
  });
}

function addWorkspaceModal() {
  const md = openModal('Add a workspace', `<div class="onboard-grid" style="margin:6px 0 0">
    <form id="aw-create" class="stack"><h3>Create a workspace</h3><input name="name" placeholder="Workspace name" required maxlength="80"><button class="btn primary">Create</button></form>
    <form id="aw-join" class="stack"><h3>Join with invite code</h3><input name="invite_code" placeholder="Invite code" required><button class="btn">Join</button></form>
  </div><div class="error" id="aw-err"></div>`);
  $('#aw-create', md.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await createWorkspace(new FormData(e.target).get('name')); md.close(); } catch (err) { $('#aw-err', md.el).textContent = err.message; }
  });
  $('#aw-join', md.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await joinWorkspace(new FormData(e.target).get('invite_code').trim()); md.close(); } catch (err) { $('#aw-err', md.el).textContent = err.status === 404 ? 'No workspace with that invite code.' : err.message; }
  });
}

window.addEventListener('hashchange', () => {
  const r = parseHash();
  if (r.ws && r.ws !== S.wsId && S.workspaces.some((w) => w.id === r.ws)) openWorkspace(r.ws, r.ch);
  else if (r.ch && r.ch !== S.chId) openChannel(r.ch);
});

boot();
