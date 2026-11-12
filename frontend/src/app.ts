/* rslack web client. TypeScript source; compiled to web/app.js by `npm run build:web`. */
import { $, $opt, $$, tgt, esc, reEsc, field } from './dom';
import type {
  User, Person, Workspace, Member, ChannelSummary, BrowseRow, Message, UserBrief, Attachment,
  AuthResponse, MessagePage, ThreadResponse, ReactionResponse, SearchResponse, SearchHit,
  ServerEvent, DeleteInfo, ClientEvent, SignupRequest, ApiErrorBody, OkResponse, AddMemberResponse,
} from './types';

// ------------------------------------------------------------------ state
const EMOJI = ['👍', '❤️', '😂', '🎉', '🚀', '👀', '🙏', '🔥', '✅', '❌', '😮', '😢', '🤔', '👏', '💯', '🙌',
  '😄', '😅', '😎', '🥳', '🤝', '💡', '⚡', '🐛', '📌', '🍕', '☕', '🦀', '🌟', '👋', '🫡', '⏰'];

/** A public channel opened from "Browse" before joining it. */
interface PreviewChannel extends BrowseRow {
  is_private: false;
  is_dm: false;
  last_read_id: number;
  unread_count: number;
  mention_count: number;
  dm_user?: null;
}
type ViewChannel = ChannelSummary | PreviewChannel;

interface ChannelMessages { list: Message[]; hasMore: boolean; }
interface Typist { name: string; until: number; }
type PanelKind = 'thread' | 'search';

interface State {
  me: User | null;
  workspaces: Workspace[];
  wsId: number | null;
  channels: ChannelSummary[];
  members: Member[];
  online: Set<number>;
  chId: number | null;
  preview: PreviewChannel | null;
  msgs: Map<number, ChannelMessages>;
  lastReadAtOpen: number;
  panel: PanelKind | null;
  threadId: number | null;
  thread: ThreadResponse | null;
  search: { q: string; results: SearchHit[] } | null;
  typing: Map<string, Map<number, Typist>>;
  sock: WebSocket | null;
  sockRetry: number;
  connected: boolean | 'lost';
  collapsed: Record<string, boolean>;
}

const S: State = {
  me: null, workspaces: [], wsId: null, channels: [], members: [], online: new Set(),
  chId: null, preview: null, msgs: new Map(), lastReadAtOpen: 0,
  panel: null, threadId: null, thread: null, search: null,
  typing: new Map(), sock: null, sockRetry: 0, connected: false, collapsed: {},
};

/** The signed-in user. Only called from views that exist after login. */
function me(): User {
  return S.me as User;
}

// ------------------------------------------------------------------ API
class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const errStatus = (err: unknown): number | undefined => (err instanceof ApiError ? err.status : undefined);

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
async function api<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const opts: RequestInit = { method, headers, credentials: 'same-origin' };
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch('/api' + path, opts);
  let data: unknown = null;
  try { data = await r.json(); } catch { /* empty body */ }
  if (!r.ok) {
    const e = (data as Partial<ApiErrorBody> | null)?.error;
    throw new ApiError(e || r.statusText || 'Request failed', r.status);
  }
  return data as T;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string): void {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
}

// ------------------------------------------------------------------ formatting helpers
function hue(str: string): number { let h = 0; for (const c of String(str)) h = (h * 31 + (c.codePointAt(0) ?? 0)) >>> 0; return h % 360; }
function initials(name: string): string {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
function avatar(user: Person, size = ''): string {
  const name = user.display_name || user.username;
  return `<div class="avatar ${size}" style="--h:${hue(user.username)}" title="${esc(name)}">${esc(initials(name))}</div>`;
}
function presenceDot(uid: number): string { return `<span class="presence-dot ${S.online.has(uid) ? 'online' : ''}" data-presence="${uid}"></span>`; }

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
function fmtTime(ms: number): string { return timeFmt.format(new Date(ms)); }
function dayKey(ms: number): string { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
function dayLabel(ms: number): string {
  const d = new Date(ms), now = new Date();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (dayKey(ms) === dayKey(now.getTime())) return 'Today';
  if (dayKey(ms) === dayKey(y.getTime())) return 'Yesterday';
  return dayFmt.format(d);
}
function relTime(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return dayLabel(ms);
}
function fmtSize(n: number): string { return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`; }

// ------------------------------------------------------------------ markdown-lite
function mentionsMe(body: string): boolean {
  if (!S.me || !body) return false;
  return new RegExp(`(^|[^\\w@])@(${reEsc(S.me.username)}|here|channel)(?![\\w.-])`, 'i').test(body);
}

function fmt(src: string): string {
  const ph: string[] = [];
  const hold = (html: string): string => `\u0000${ph.push(html) - 1}\u0000`;
  let s = String(src);
  s = s.replace(/```(?:[\w+-]*\n)?([\s\S]*?)```/g, (_, code: string) => hold(`<pre>${esc(code.replace(/^\n+|\n+$/g, ''))}</pre>`));
  s = esc(s);
  s = s.replace(/`([^`\n]+)`/g, (_, c: string) => hold(`<code>${c}</code>`));
  s = s.replace(/\bhttps?:\/\/[^\s<]*[^\s<.,;:!?)\]'"&]/g, (url) => hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`));
  s = s.replace(/\*\*(\S(?:[^*\n]*?\S)?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w*])\*(\S(?:[^*\n]*?\S)?)\*(?![\w*])/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[^\w])_(\S(?:[^_\n]*?\S)?)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w~])~(\S(?:[^~\n]*?\S)?)~(?![\w~])/g, '$1<del>$2</del>');
  const known = new Set(S.members.map((m) => m.username));
  s = s.replace(/(^|[^\w@])@([a-z0-9_.-]{2,32})/gi, (all, pre: string, name: string) => {
    const n = name.replace(/[.-]+$/, '');
    const tail = name.slice(n.length);
    const lower = n.toLowerCase();
    if (!known.has(lower) && lower !== 'here' && lower !== 'channel') return all;
    const isMe = S.me && (lower === S.me.username || lower === 'here' || lower === 'channel');
    return `${pre}<span class="mention${isMe ? ' me' : ''}">@${n}</span>${tail}`;
  });
  s = s.split('\n').map((line) => (line.startsWith('&gt; ') ? `<blockquote>${line.slice(5)}</blockquote>` : line)).join('\n');
  s = s.replace(/\n/g, '<br>').replace(/<\/blockquote><br>/g, '</blockquote>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => ph[+i]);
}

function highlightTerms(root: HTMLElement, terms: string[]): void {
  if (!terms.length) return;
  const re = new RegExp(`(${terms.map(reEsc).join('|')})`, 'gi');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const text = node.nodeValue ?? '';
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    const span = document.createElement('span');
    span.innerHTML = esc(text).replace(re, '<mark>$1</mark>');
    node.replaceWith(...span.childNodes);
  }
}

// ------------------------------------------------------------------ screens
function showScreen(id: 'auth' | 'onboard' | 'app'): void {
  for (const s of ['auth', 'onboard', 'app']) $('#' + s).classList.toggle('hidden', s !== id);
}

let authMode: 'login' | 'signup' = 'login';
function showAuth(): void {
  showScreen('auth');
  setTimeout(() => $<HTMLInputElement>('#auth-form [name=username]').focus(), 0);
}
$$('#auth .tab').forEach((t) => t.addEventListener('click', () => {
  authMode = t.dataset.mode === 'signup' ? 'signup' : 'login';
  $$('#auth .tab').forEach((x) => x.classList.toggle('active', x === t));
  $$('.signup-only').forEach((x) => x.classList.toggle('hidden', authMode !== 'signup'));
  $('#auth-submit').textContent = authMode === 'signup' ? 'Create account' : 'Sign in';
  $<HTMLInputElement>('#auth-form [name=password]').autocomplete = authMode === 'signup' ? 'new-password' : 'current-password';
  $('#auth-error').textContent = '';
}));
$<HTMLFormElement>('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  const f = new FormData(form);
  const body: SignupRequest = { username: field(f, 'username'), password: field(f, 'password') };
  if (authMode === 'signup') body.display_name = field(f, 'display_name');
  const submit = $<HTMLButtonElement>('#auth-submit');
  submit.disabled = true;
  try {
    const res = await api<AuthResponse>('POST', authMode === 'signup' ? '/auth/signup' : '/auth/login', body);
    S.me = res.user;
    form.reset();
    await afterLogin();
  } catch (err) {
    $('#auth-error').textContent = errStatus(err) === 401 ? 'Wrong username or password.' : errMsg(err);
  } finally {
    submit.disabled = false;
  }
});

function showOnboard(): void {
  showScreen('onboard');
  $('#onboard-name').textContent = me().display_name;
}
async function createWorkspace(name: string): Promise<Workspace> {
  const ws = await api<Workspace>('POST', '/workspaces', { name });
  S.workspaces = await api<Workspace[]>('GET', '/workspaces');
  showScreen('app');
  await openWorkspace(ws.id);
  return ws;
}
async function joinWorkspace(code: string): Promise<Workspace> {
  const ws = await api<Workspace>('POST', '/workspaces/join', { invite_code: code });
  S.workspaces = await api<Workspace[]>('GET', '/workspaces');
  showScreen('app');
  await openWorkspace(ws.id);
  return ws;
}
$<HTMLFormElement>('#onboard-create').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await createWorkspace(field(e.currentTarget as HTMLFormElement, 'name')); } catch (err) { $('#onboard-error').textContent = errMsg(err); }
});
$<HTMLFormElement>('#onboard-join').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await joinWorkspace(field(e.currentTarget as HTMLFormElement, 'invite_code').trim()); } catch (err) {
    $('#onboard-error').textContent = errStatus(err) === 404 ? 'No workspace with that invite code.' : errMsg(err);
  }
});
$('#onboard-logout').addEventListener('click', logout);

async function logout(): Promise<void> {
  try { await api<OkResponse>('POST', '/auth/logout'); } catch { /* ignore */ }
  if (S.sock) { S.sock.onclose = null; S.sock.close(); S.sock = null; }
  Object.assign(S, { me: null, workspaces: [], wsId: null, channels: [], chId: null, msgs: new Map(), panel: null });
  location.hash = '';
  showAuth();
}

async function boot(): Promise<void> {
  try { S.me = await api<User>('GET', '/me'); } catch { return showAuth(); }
  await afterLogin();
}

interface Route { ws?: number; ch?: number | null; }
function parseHash(): Route {
  const m = location.hash.match(/^#\/ws\/(\d+)(?:\/c\/(\d+))?/);
  return m ? { ws: +m[1], ch: m[2] ? +m[2] : null } : {};
}

async function afterLogin(): Promise<void> {
  S.workspaces = await api<Workspace[]>('GET', '/workspaces');
  connectSocket();
  if (!S.workspaces.length) return showOnboard();
  const route = parseHash();
  const saved = Number(localStorage.getItem('rslack.ws'));
  const ws = S.workspaces.find((w) => w.id === route.ws) || S.workspaces.find((w) => w.id === saved) || S.workspaces[0];
  showScreen('app');
  await openWorkspace(ws.id, route.ws === ws.id ? route.ch : null);
}

// ------------------------------------------------------------------ workspace & sidebar
const chan = (id: number | null | undefined): ChannelSummary | undefined => S.channels.find((c) => c.id === id);
const member = (id: number): Member | undefined => S.members.find((m) => m.id === id);
const chanLabel = (c: ViewChannel): string => (c.is_dm ? (c.dm_user ? c.dm_user.display_name : 'Direct message') : c.name);
/** The other person in a DM (or yourself, for a DM with yourself). */
const dmPeer = (c: ViewChannel): UserBrief | User => c.dm_user || me();

function renderMe(): void {
  $('#me-name').textContent = me().display_name;
  $('#me-avatar').outerHTML = avatar(me(), 'sm').replace('class="avatar sm"', 'id="me-avatar" class="avatar sm"');
}

async function openWorkspace(id: number, chId?: number | null): Promise<void> {
  renderMe();
  S.wsId = id;
  localStorage.setItem('rslack.ws', String(id));
  closePanel();
  S.msgs.clear();
  [S.channels, S.members] = await Promise.all([
    api<ChannelSummary[]>('GET', `/workspaces/${id}/channels`),
    api<Member[]>('GET', `/workspaces/${id}/members`),
  ]);
  for (const m of S.members) if (m.online) S.online.add(m.id);
  const ws = S.workspaces.find((w) => w.id === id);
  $('#ws-title').textContent = ws ? ws.name : '';
  renderRail();
  renderSidebar();
  const target = chan(chId) || S.channels.find((c) => c.name === 'general' && !c.is_dm) || S.channels[0];
  if (target) await openChannel(target.id);
}

async function refreshChannels(): Promise<void> {
  if (!S.wsId) return;
  const [channels, members] = await Promise.all([
    api<ChannelSummary[]>('GET', `/workspaces/${S.wsId}/channels`),
    api<Member[]>('GET', `/workspaces/${S.wsId}/members`),
  ]);
  S.channels = channels;
  S.members = members;
  for (const m of members) if (m.online) S.online.add(m.id); else S.online.delete(m.id);
  renderSidebar();
  if (S.chId && S.preview && chan(S.chId)) { S.preview = null; renderHeader(); mountMainComposer(); }
}

function renderRail(): void {
  $('#rail').innerHTML = S.workspaces.map((w) => `
    <button class="ws-icon ${w.id === S.wsId ? 'active' : ''}" data-ws="${w.id}" title="${esc(w.name)}"
      >${esc(initials(w.name))}</button>`).join('')
    + '<button class="ws-icon add" id="add-ws" title="Create or join a workspace">+</button>';
}
$('#rail').addEventListener('click', (e) => {
  const b = tgt(e).closest<HTMLElement>('[data-ws]');
  if (b && Number(b.dataset.ws) !== S.wsId) openWorkspace(Number(b.dataset.ws));
  if (tgt(e).closest('#add-ws')) addWorkspaceModal();
});

function renderSidebar(): void {
  const sideItem = (c: ChannelSummary): string => {
    const unread = c.unread_count > 0;
    const badge = c.mention_count > 0 ? `<span class="badge">${c.mention_count}</span>` : '';
    const icon = c.is_dm
      ? `<span class="avatar-wrap">${avatar(dmPeer(c), 'xs')}${presenceDot(dmPeer(c).id)}</span>`
      : `<span class="hash">${c.is_private ? '🔒' : '#'}</span>`;
    const label = c.is_dm && c.dm_user && c.dm_user.id === me().id ? `${esc(me().display_name)} <span class="muted">(you)</span>` : esc(chanLabel(c));
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
  const li = tgt(e).closest<HTMLElement>('[data-ch]');
  if (li) openChannel(Number(li.dataset.ch));
  const t = tgt(e).closest<HTMLElement>('.side-toggle');
  if (t) {
    const k = t.dataset.section ?? '';
    S.collapsed[k] = !S.collapsed[k];
    t.classList.toggle('collapsed', S.collapsed[k]);
    renderSidebar();
  }
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
  openMenu(e.currentTarget as HTMLElement, [
    ['Invite people to ' + (ws ? ws.name : ''), inviteModal],
    ['Create a channel', createChannelModal],
    ['Browse channels', browseModal],
    null,
    ['Create or join a workspace', addWorkspaceModal],
    ['Sign out', logout],
  ]);
});

// ------------------------------------------------------------------ channel view
function current(): ViewChannel | null { return chan(S.chId) || S.preview; }

interface OpenOpts { flash?: number; keepFocus?: boolean; }
async function openChannel(id: number, opts: OpenOpts = {}): Promise<void> {
  S.chId = id;
  let c: ViewChannel | undefined = chan(id);
  S.preview = null;
  if (!c) {
    const browse = await api<BrowseRow[]>('GET', `/workspaces/${S.wsId}/channels/browse`);
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
  const data = await api<MessagePage>('GET', `/channels/${id}/messages?limit=50`);
  if (S.chId !== id) return;
  S.msgs.set(id, { list: data.messages, hasMore: data.has_more });
  renderMessages({ bottom: true });
  if (opts.flash) flashMessage(opts.flash);
  markRead();
  if (!opts.keepFocus) setTimeout(() => { const ta = $opt<HTMLTextAreaElement>('#composer-wrap textarea'); if (ta) ta.focus(); }, 0);
}

function renderHeader(): void {
  const c = current();
  if (!c) return;
  if (c.is_dm) {
    const u = dmPeer(c);
    $('#chan-name').innerHTML = `<span class="avatar-wrap" style="margin-right:8px;vertical-align:-4px">${avatar(u, 'sm')}${presenceDot(u.id)}</span>${esc(u.display_name)}`;
  } else {
    $('#chan-name').textContent = `${c.is_private ? '🔒 ' : '# '}${c.name}`;
  }
  const topic = $<HTMLButtonElement>('#chan-topic');
  topic.textContent = c.topic || (c.is_dm ? `@${dmPeer(c).username}` : 'Add a topic');
  topic.disabled = !!c.is_dm || !!S.preview;
  $('#members-count').textContent = String(c.member_count ?? '');
  $('#members-btn').classList.toggle('hidden', !!c.is_dm);
}
$('#chan-topic').addEventListener('click', topicModal);
$('#members-btn').addEventListener('click', membersModal);

function isNearBottom(el: HTMLElement): boolean { return el.scrollHeight - el.scrollTop - el.clientHeight < 120; }

function renderMessages({ bottom = false, keepFrom = null }: { bottom?: boolean; keepFrom?: 'top' | null } = {}): void {
  const box = $('#messages');
  const st = S.chId === null ? undefined : S.msgs.get(S.chId);
  const c = current();
  if (!st || !c) return;
  const wasNear = isNearBottom(box);
  const prevHeight = box.scrollHeight, prevTop = box.scrollTop;
  let html = '';
  if (st.hasMore) html += '<button class="btn load-more" data-act="older">Load older messages</button>';
  else html += c.is_dm
    ? `<div class="chan-intro">${avatar(dmPeer(c))}<h2 style="margin-top:10px">${esc(dmPeer(c).display_name)}</h2><p class="muted">This is the very beginning of your direct message history with <b>@${esc(dmPeer(c).username)}</b>.</p></div>`
    : `<div class="chan-intro"><h2>${c.is_private ? '🔒' : '#'} ${esc(c.name)}</h2><p class="muted">This is the very beginning of the <b>${c.is_private ? '🔒' : '#'}${esc(c.name)}</b> channel.${c.topic ? ' ' + esc(c.topic) : ''}</p></div>`;
  let prev: Message | null = null, newShown = false;
  for (const m of st.list) {
    if (!prev || dayKey(prev.created_at) !== dayKey(m.created_at)) {
      html += `<div class="day-divider"><span>${esc(dayLabel(m.created_at))}</span></div>`;
      prev = null;
    }
    if (!newShown && S.lastReadAtOpen && m.id > S.lastReadAtOpen && m.user_id !== me().id) {
      html += '<div class="new-divider">New</div>';
      newShown = true;
      prev = null;
    }
    const compact = !!prev && prev.user_id === m.user_id && !prev.deleted && m.created_at - prev.created_at < 5 * 60 * 1000;
    html += msgHtml(m, { compact });
    prev = m;
  }
  box.innerHTML = html;
  if (bottom || (keepFrom === null && wasNear)) box.scrollTop = box.scrollHeight;
  else if (keepFrom === 'top') box.scrollTop = box.scrollHeight - prevHeight + prevTop;
  else box.scrollTop = prevTop;
}

const ICON_ATTRS = 'viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
  emoji: `<svg ${ICON_ATTRS}><circle cx="10" cy="10" r="7"/><path d="M7 12c.7 1 1.8 1.6 3 1.6s2.3-.6 3-1.6"/><circle cx="7.6" cy="8.2" r=".6" fill="currentColor"/><circle cx="12.4" cy="8.2" r=".6" fill="currentColor"/></svg>`,
  thread: `<svg ${ICON_ATTRS}><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v6a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3h0A1.5 1.5 0 0 1 4 11.5z"/></svg>`,
  edit: `<svg ${ICON_ATTRS}><path d="M12.5 4.5l3 3L7 16H4v-3z"/></svg>`,
  trash: `<svg ${ICON_ATTRS}><path d="M4 6h12M8 6V4.5h4V6M6 6l.7 9.5h6.6L14 6"/></svg>`,
};

function attachmentHtml(a: Attachment): string {
  return a.content_type.startsWith('image/') && !a.content_type.includes('svg')
    ? `<a href="${esc(a.url)}" target="_blank" rel="noopener"><img class="att-img" src="${esc(a.url)}" alt="${esc(a.filename)}" loading="lazy"></a>`
    : `<a class="att-file" href="${esc(a.url)}" target="_blank" rel="noopener" download="${esc(a.filename)}"><span class="ico">📄</span><span class="meta"><b>${esc(a.filename)}</b><span class="muted">${fmtSize(a.size)}</span></span></a>`;
}

function msgHtml(m: Message, { compact = false, inThread = false }: { compact?: boolean; inThread?: boolean } = {}): string {
  const mine = m.user_id === me().id;
  const u: Person = { username: m.username, display_name: m.display_name };
  const body = m.deleted
    ? '<div class="msg-body deleted">This message was deleted.</div>'
    : `<div class="msg-body">${m.body ? fmt(m.body) : ''}${m.edited_at ? '<span class="edited">(edited)</span>' : ''}</div>`;
  const atts = !m.deleted && m.attachments.length ? `<div class="attachments">${m.attachments.map(attachmentHtml).join('')}</div>` : '';
  const reacts = m.reactions.length ? `<div class="reactions">${m.reactions.map((r) => {
    const names = r.user_ids.map((id) => (id === me().id ? 'You' : member(id)?.display_name || 'someone')).join(', ');
    return `<button class="reaction ${r.user_ids.includes(me().id) ? 'mine' : ''}" data-act="react" data-emoji="${esc(r.emoji)}" title="${esc(names)} reacted with ${esc(r.emoji)}">${esc(r.emoji)}<span class="n">${r.count}</span></button>`;
  }).join('')}<button class="reaction add" data-act="pick" title="Add reaction">+</button></div>` : '';
  const thread = !inThread && m.reply_count > 0
    ? `<button class="thread-link" data-act="thread"><b>${m.reply_count} ${m.reply_count === 1 ? 'reply' : 'replies'}</b><span class="muted">Last reply ${esc(relTime(m.last_reply_at ?? m.created_at))}</span></button>`
    : '';
  const canThread = !inThread && !m.parent_id && !m.deleted;
  const actions = m.deleted ? '' : `<div class="msg-actions">
      <button data-act="quick" data-emoji="👍" title="React 👍">👍</button>
      <button data-act="quick" data-emoji="🎉" title="React 🎉">🎉</button>
      <button data-act="pick" title="Add reaction">${ICONS.emoji}</button>
      ${canThread ? `<button data-act="thread" title="Reply in thread">${ICONS.thread}</button>` : ''}
      ${mine ? `<button data-act="edit" title="Edit message">${ICONS.edit}</button><button data-act="delete" title="Delete message">${ICONS.trash}</button>` : ''}
    </div>`;
  const head = compact
    ? `<span class="msg-gutter-time">${esc(fmtTime(m.created_at))}</span>`
    : `<div class="msg-head"><span class="msg-author">${esc(m.display_name)}</span><span class="msg-time" title="${esc(new Date(m.created_at).toLocaleString())}">${esc(fmtTime(m.created_at))}</span></div>`;
  return `<div class="msg ${compact ? 'compact' : ''} ${!m.deleted && !mine && mentionsMe(m.body) ? 'mentions-me' : ''}" data-id="${m.id}">
    ${compact ? '<div></div>' : avatar(u)}
    <div class="msg-main">${head}${body}${atts}${reacts}${thread}</div>${actions}</div>`;
}

function findMsg(id: number): Message | null {
  for (const st of S.msgs.values()) { const m = st.list.find((x) => x.id === id); if (m) return m; }
  if (S.thread) {
    if (S.thread.parent.id === id) return S.thread.parent;
    const r = S.thread.replies.find((x) => x.id === id);
    if (r) return r;
  }
  return null;
}

function flashMessage(id: number): void {
  const el = $opt(`#messages .msg[data-id="${id}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1700);
}

async function markRead(): Promise<void> {
  const c = chan(S.chId);
  const st = S.chId === null ? undefined : S.msgs.get(S.chId);
  if (!c || !st || !st.list.length || document.visibilityState !== 'visible') return;
  const last = Math.max(...st.list.map((m) => m.id));
  if (last <= c.last_read_id && !c.unread_count) return;
  c.last_read_id = Math.max(c.last_read_id, last);
  c.unread_count = 0;
  c.mention_count = 0;
  renderSidebar();
  try { await api<OkResponse>('POST', `/channels/${c.id}/read`, { message_id: last }); } catch { /* best effort */ }
}
document.addEventListener('visibilitychange', markRead);
window.addEventListener('focus', markRead);

async function onMessageAction(e: MouseEvent): Promise<void> {
  const btn = tgt(e).closest<HTMLElement>('[data-act]');
  if (!btn) return;
  if (btn.dataset.act === 'older') return loadOlder();
  const el = btn.closest<HTMLElement>('.msg');
  if (!el) return;
  const id = Number(el.dataset.id);
  const m = findMsg(id);
  if (!m) return;
  switch (btn.dataset.act) {
    case 'react': case 'quick': return react(m, btn.dataset.emoji ?? '');
    case 'pick': return openEmojiPicker(btn, (emoji) => react(m, emoji));
    case 'thread': return openThread(m.parent_id || m.id);
    case 'edit': return startEdit(el, m);
    case 'delete': return confirmDelete(m);
    default:
  }
}
$('#messages').addEventListener('click', onMessageAction);
$('#panel-body').addEventListener('click', onMessageAction);

async function loadOlder(): Promise<void> {
  const st = S.chId === null ? undefined : S.msgs.get(S.chId);
  if (!st || !st.list.length) return;
  const data = await api<MessagePage>('GET', `/channels/${S.chId}/messages?limit=50&before=${st.list[0].id}`);
  st.list = data.messages.concat(st.list);
  st.hasMore = data.has_more;
  renderMessages({ keepFrom: 'top' });
}

async function react(m: Message, emoji: string): Promise<void> {
  if (!chan(m.channel_id)) { toast('Join the channel to react'); return; }
  try {
    const res = await api<ReactionResponse>('POST', `/messages/${m.id}/reactions`, { emoji });
    m.reactions = res.reactions;
    rerenderMessage(m);
  } catch (err) { toast(errMsg(err)); }
}

function rerenderMessage(m: Message): void {
  if (m.parent_id ? S.thread && S.thread.parent.id === m.parent_id : S.thread && S.thread.parent.id === m.id) renderPanel();
  if (!m.parent_id && m.channel_id === S.chId) renderMessages();
}

function startEdit(el: HTMLElement, m: Message): void {
  const bodyEl = $opt('.msg-body', el);
  if (!bodyEl || $opt('.edit-box', el)) return;
  const box = document.createElement('div');
  box.className = 'edit-box';
  box.innerHTML = '<textarea class="field"></textarea><div class="row"><button class="btn" data-x="cancel">Cancel</button><button class="btn primary" data-x="save">Save</button></div>';
  const ta = $<HTMLTextAreaElement>('textarea', box);
  ta.value = m.body;
  bodyEl.replaceWith(box);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  const done = (): void => rerenderMessage(m);
  const save = async (): Promise<void> => {
    const body = ta.value.trim();
    if (body === m.body) return done();
    try { Object.assign(m, await api<Message>('PATCH', `/messages/${m.id}`, { body })); } catch (err) { toast(errMsg(err)); }
    done();
  };
  box.addEventListener('click', (e) => {
    e.stopPropagation();
    const x = tgt(e).dataset.x;
    if (x === 'cancel') done();
    if (x === 'save') save();
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') done();
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
  });
}

function confirmDelete(m: Message): void {
  const md = openModal('Delete message', `<p>Are you sure you want to delete this message? This can't be undone.</p>
    <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary danger-fill" id="confirm-del">Delete</button></div>`);
  $('#confirm-del', md.el).addEventListener('click', async () => {
    try {
      await api<OkResponse>('DELETE', `/messages/${m.id}`);
      applyDelete({ message_id: m.id, channel_id: m.channel_id, parent_id: m.parent_id, has_replies: m.reply_count > 0 });
    } catch (err) { toast(errMsg(err)); }
    md.close();
  });
}

// ------------------------------------------------------------------ side panel: thread & search
function closePanel(): void {
  S.panel = null; S.threadId = null; S.thread = null; S.search = null;
  $('#panel').classList.add('hidden');
  $('#panel-composer').innerHTML = '';
}
$('#panel-close').addEventListener('click', closePanel);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal-root').children.length && !$('#popover-root').children.length && S.panel && !tgt(e).closest('.edit-box')) closePanel();
});

async function openThread(id: number): Promise<void> {
  S.panel = 'thread';
  S.threadId = id;
  S.search = null;
  const data = await api<ThreadResponse>('GET', `/messages/${id}/thread`);
  if (S.threadId !== id) return;
  S.thread = data;
  $('#panel').classList.remove('hidden');
  renderPanel({ bottom: true });
  const c = chan(data.parent.channel_id);
  $('#panel-composer').innerHTML = '';
  if (c) {
    mountComposer($('#panel-composer'), { channelId: c.id, parentId: id, placeholder: 'Reply…' });
    setTimeout(() => $<HTMLTextAreaElement>('#panel-composer textarea').focus(), 0);
  }
}

function renderPanel({ bottom = false }: { bottom?: boolean } = {}): void {
  const body = $('#panel-body');
  if (S.panel === 'thread' && S.thread) {
    const { parent, replies } = S.thread;
    const c: ViewChannel | null = chan(parent.channel_id) || S.preview;
    $('#panel-title').textContent = 'Thread';
    $('#panel-sub').textContent = c?.is_dm ? (c.dm_user ? c.dm_user.display_name : '') : `#${c?.name || ''}`;
    const near = isNearBottom(body);
    let html = msgHtml(parent, { inThread: true });
    html += `<div class="reply-sep">${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}</div>`;
    let prev: Message | null = null;
    for (const r of replies) {
      const compact = !!prev && prev.user_id === r.user_id && r.created_at - prev.created_at < 5 * 60 * 1000;
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

$<HTMLFormElement>('#search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $<HTMLInputElement>('#search-input').value.trim();
  if (!q) return;
  const res = await api<SearchResponse>('GET', `/workspaces/${S.wsId}/search?q=${encodeURIComponent(q)}`);
  S.panel = 'search';
  S.thread = null;
  S.threadId = null;
  S.search = { q, results: res.results };
  $('#panel').classList.remove('hidden');
  $('#panel-composer').innerHTML = '';
  renderPanel();
});
$('#panel-body').addEventListener('click', async (e) => {
  const r = tgt(e).closest<HTMLElement>('.search-result');
  if (!r || tgt(e).closest('[data-act]')) return;
  const ch = Number(r.dataset.ch), mid = Number(r.dataset.mid), parent = Number(r.dataset.parent) || null;
  await openChannel(ch, { flash: parent || mid, keepFocus: true });
  if (parent) openThread(parent);
});

// ------------------------------------------------------------------ composer
interface ComposerForm extends HTMLFormElement { _addFile?: (file: File) => void; }
interface PendingUpload { id: number | null; name: string; el: HTMLSpanElement; }
interface MentionState { start: number; sel: number; opts: Member[]; }

function mountMainComposer(): void {
  const wrap = $('#composer-wrap');
  wrap.innerHTML = '';
  const c = current();
  $('#join-bar').classList.toggle('hidden', !S.preview);
  if (S.preview) { $('#join-name').textContent = '#' + S.preview.name; return; }
  if (!c) return;
  const ph = c.is_dm ? `Message ${dmPeer(c).display_name}` : `Message ${c.is_private ? '🔒' : '#'}${c.name}`;
  mountComposer(wrap, { channelId: c.id, parentId: null, placeholder: ph });
}
$('#join-btn').addEventListener('click', async () => {
  const id = S.chId;
  if (id === null) return;
  await api<ChannelSummary>('POST', `/channels/${id}/join`);
  await refreshChannels();
  S.preview = null;
  await openChannel(id);
});

function mountComposer(container: HTMLElement, { channelId, parentId, placeholder }: { channelId: number; parentId: number | null; placeholder: string }): ComposerForm {
  const tpl = $<HTMLTemplateElement>('#composer-tpl');
  const node = (tpl.content.firstElementChild as HTMLElement).cloneNode(true) as ComposerForm;
  container.appendChild(node);
  const ta = $<HTMLTextAreaElement>('textarea', node);
  const send = $<HTMLButtonElement>('.send-btn', node);
  const preview = $('.attachments-preview', node);
  const fileInput = $<HTMLInputElement>('.file-input', node);
  ta.placeholder = placeholder;
  node.dataset.key = `${channelId}:${parentId || ''}`;
  const pending: PendingUpload[] = [];
  let lastTyping = 0;
  let mention: MentionState | null = null;

  const update = (): void => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
    send.disabled = !ta.value.trim() && !pending.some((p) => p.id);
  };
  update();

  const doSend = async (): Promise<void> => {
    const body = ta.value.trim();
    if (pending.some((p) => !p.id)) { toast('Wait for uploads to finish'); return; }
    const ids = pending.map((p) => p.id as number);
    if (!body && !ids.length) return;
    send.disabled = true;
    try {
      const m = await api<Message>('POST', `/channels/${channelId}/messages`, { body, parent_id: parentId, attachment_ids: ids });
      ta.value = '';
      lastTyping = 0; // next keystroke announces typing again
      pending.length = 0;
      preview.innerHTML = '';
      insertMessage(m, true);
    } catch (err) { toast(errMsg(err)); }
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
      const mine = st && [...st.list].reverse().find((m) => m.user_id === me().id && !m.deleted);
      const el = mine && $opt(`#messages .msg[data-id="${mine.id}"]`);
      if (mine && el) { e.preventDefault(); startEdit(el, mine); }
    }
  });

  ta.addEventListener('input', () => {
    update();
    const now = Date.now();
    if (ta.value && now - lastTyping > 2500 && S.sock && S.sock.readyState === WebSocket.OPEN) {
      lastTyping = now;
      sendEvent({ type: 'typing', channel_id: channelId, parent_id: parentId });
    }
    checkMention();
  });
  ta.addEventListener('blur', () => setTimeout(closeMention, 150));

  function wrapSel(mark: string, block = false): void {
    const { selectionStart: a, selectionEnd: b, value: v } = ta;
    const inner = v.slice(a, b) || (block ? 'code' : 'text');
    const open = block ? `${mark}\n` : mark, close = block ? `\n${mark}` : mark;
    ta.value = v.slice(0, a) + open + inner + close + v.slice(b);
    ta.focus();
    ta.setSelectionRange(a + open.length, a + open.length + inner.length);
    update();
  }
  function insertText(t: string): void {
    const { selectionStart: a, selectionEnd: b, value: v } = ta;
    ta.value = v.slice(0, a) + t + v.slice(b);
    ta.focus();
    ta.setSelectionRange(a + t.length, a + t.length);
    update();
  }
  $$('.fmt [data-wrap]', node).forEach((b) => b.addEventListener('click', () => wrapSel(b.dataset.wrap ?? '')));
  $$('.fmt [data-block]', node).forEach((b) => b.addEventListener('click', () => wrapSel(b.dataset.block ?? '', true)));
  $('.emoji-btn', node).addEventListener('click', (e) => openEmojiPicker(e.currentTarget as HTMLElement, insertText));
  $('.mention-btn', node).addEventListener('click', () => { insertText((ta.value && !/\s$/.test(ta.value.slice(0, ta.selectionStart)) ? ' @' : '@')); checkMention(); });
  $('.attach-btn', node).addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { [...(fileInput.files ?? [])].forEach(addFile); fileInput.value = ''; });
  ta.addEventListener('paste', (e) => { const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); files.forEach(addFile); } });
  node._addFile = addFile;

  function addFile(file: File): void {
    const el = document.createElement('span');
    const p: PendingUpload = { id: null, name: file.name, el };
    el.className = 'chip uploading';
    el.innerHTML = `📎 ${esc(file.name)} <span class="muted small">${fmtSize(file.size)}</span><button type="button" title="Remove">✕</button>`;
    preview.appendChild(el);
    pending.push(p);
    $('button', el).addEventListener('click', () => { pending.splice(pending.indexOf(p), 1); el.remove(); update(); });
    const fd = new FormData();
    fd.append('file', file, file.name);
    fetch('/api/uploads', { method: 'POST', body: fd, credentials: 'same-origin' })
      .then(async (r) => {
        const d = (await r.json().catch(() => ({}))) as Partial<Attachment & ApiErrorBody>;
        if (!r.ok) throw new Error(d.error || 'Upload failed');
        return d as Attachment;
      })
      .then((att) => { p.id = att.id; el.classList.remove('uploading'); update(); })
      .catch((err: unknown) => { toast(`${file.name}: ${errMsg(err)}`); pending.splice(pending.indexOf(p), 1); el.remove(); update(); });
  }

  function checkMention(): void {
    const upto = ta.value.slice(0, ta.selectionStart);
    const m = upto.match(/(^|\s)@([\w.-]*)$/);
    if (!m) return closeMention();
    const q = m[2].toLowerCase();
    const opts = S.members.filter((u) => u.username.startsWith(q) || u.display_name.toLowerCase().includes(q)).slice(0, 8);
    if (!opts.length) return closeMention();
    mention = { start: ta.selectionStart - m[2].length - 1, sel: 0, opts };
    renderMentionPop();
  }
  function renderMentionPop(): void {
    const ms = mention;
    if (!ms) return;
    const pop = showPopover(node, `<div class="mention-pop">${ms.opts.map((u, i) => `
      <div class="opt ${i === ms.sel ? 'sel' : ''}" data-i="${i}"><span class="avatar-wrap">${avatar(u, 'xs')}</span><b>${esc(u.display_name)}</b><span class="sub">@${esc(u.username)}</span></div>`).join('')}</div>`, { above: true });
    pop.addEventListener('mousedown', (e) => {
      const o = tgt(e).closest<HTMLElement>('.opt');
      if (o && mention) { e.preventDefault(); pickMention(mention.opts[Number(o.dataset.i)]); }
    });
  }
  function pickMention(u: Member): void {
    if (!mention) return;
    const v = ta.value;
    const before = v.slice(0, mention.start), after = v.slice(ta.selectionStart);
    ta.value = `${before}@${u.username} ${after}`;
    const pos = before.length + u.username.length + 2;
    ta.setSelectionRange(pos, pos);
    closeMention();
    ta.focus();
    update();
  }
  function closeMention(): void { if (mention) { mention = null; closePopover(); } }
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
    const comp = $opt<ComposerForm>('#composer-wrap .composer');
    const add = comp?._addFile;
    if (add) [...(e.dataTransfer?.files ?? [])].forEach(add);
  });
})();

function renderTyping(): void {
  const now = Date.now();
  for (const comp of $$('.composer')) {
    const set = S.typing.get(comp.dataset.key ?? '');
    const names = set ? [...set.entries()].filter(([, v]) => v.until > now).map(([, v]) => v.name) : [];
    const el = $('.typing', comp);
    el.textContent = names.length === 0 ? '' : names.length === 1 ? `${names[0]} is typing…`
      : names.length === 2 ? `${names[0]} and ${names[1]} are typing…` : 'Several people are typing…';
  }
}
setInterval(renderTyping, 1000);

// ------------------------------------------------------------------ realtime
function sendEvent(ev: ClientEvent): void {
  if (S.sock && S.sock.readyState === WebSocket.OPEN) S.sock.send(JSON.stringify(ev));
}

function connectSocket(): void {
  if (S.sock && S.sock.readyState <= WebSocket.OPEN) return;
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
  sock.onmessage = (e: MessageEvent<string>) => { try { handleEvent(JSON.parse(e.data) as ServerEvent); } catch (err) { console.error(err); } };
  sock.onclose = () => {
    if (S.sock !== sock) return;
    S.connected = 'lost';
    setConn('Reconnecting…', false);
    const delay = Math.min(10000, 500 * 2 ** S.sockRetry++);
    setTimeout(() => { if (S.me) connectSocket(); }, delay);
  };
}
setInterval(() => sendEvent({ type: 'ping' }), 25000);

function setConn(text: string, ok: boolean): void {
  $('#conn-status').textContent = text;
  $('#me-presence').classList.toggle('online', ok);
}

async function resync(): Promise<void> {
  try {
    await refreshChannels();
    if (S.chId) {
      const data = await api<MessagePage>('GET', `/channels/${S.chId}/messages?limit=50`);
      S.msgs.set(S.chId, { list: data.messages, hasMore: data.has_more });
      renderMessages();
    }
    if (S.panel === 'thread' && S.threadId) openThread(S.threadId);
  } catch { /* next reconnect will retry */ }
}

function insertMessage(m: Message, own = false): void {
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
      if (m.user_id !== me().id) markRead();
    }
  }
  const c = chan(m.channel_id);
  if (own && c) c.last_read_id = Math.max(c.last_read_id, m.id);
}

function replaceMessage(m: Message): void {
  const st = S.msgs.get(m.channel_id);
  if (st) { const i = st.list.findIndex((x) => x.id === m.id); if (i >= 0) st.list[i] = m; }
  if (S.thread) {
    if (S.thread.parent.id === m.id) S.thread.parent = m;
    const i = S.thread.replies.findIndex((x) => x.id === m.id);
    if (i >= 0) S.thread.replies[i] = m;
  }
  rerenderMessage(m);
}

/** Fields that turn a message into a "deleted" placeholder (fresh arrays each time). */
const tombstone = (): Pick<Message, 'deleted' | 'body' | 'attachments' | 'reactions'> => ({ deleted: true, body: '', attachments: [], reactions: [] });
function applyDelete(ev: DeleteInfo): void {
  const st = S.msgs.get(ev.channel_id);
  if (st) {
    const i = st.list.findIndex((x) => x.id === ev.message_id);
    if (i >= 0) {
      if (ev.has_replies) Object.assign(st.list[i], tombstone());
      else st.list.splice(i, 1);
    }
  }
  if (S.thread) {
    if (S.thread.parent.id === ev.message_id) Object.assign(S.thread.parent, tombstone());
    S.thread.replies = S.thread.replies.filter((r) => r.id !== ev.message_id);
    renderPanel();
  }
  if (ev.channel_id === S.chId) renderMessages();
}

function handleEvent(ev: ServerEvent): void {
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
      if (c && !m.parent_id && m.user_id !== me().id && !(m.channel_id === S.chId && document.visibilityState === 'visible')) {
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
      let set = S.typing.get(key);
      if (!set) { set = new Map(); S.typing.set(key, set); }
      set.set(ev.user_id, { name: ev.display_name, until: Date.now() + 4500 });
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
    case 'channels.changed': case 'workspace.member_joined':
      if (!ev.workspace_id || ev.workspace_id === S.wsId) refreshChannels();
      break;
    case 'channel.members_changed':
      refreshChannels().then(() => { if (ev.channel_id === S.chId) renderHeader(); });
      break;
    case 'workspaces.changed':
      api<Workspace[]>('GET', '/workspaces').then((w) => { S.workspaces = w; renderRail(); });
      break;
    case 'pong':
      break;
    default: {
      const unknown: never = ev;
      void unknown;
    }
  }
}

function renderPresence(): void {
  $$('[data-presence]').forEach((el) => el.classList.toggle('online', S.online.has(Number(el.dataset.presence))));
  for (const m of S.members) m.online = S.online.has(m.id);
}

// ------------------------------------------------------------------ popovers & modals
function showPopover(anchor: HTMLElement, html: string, { above = false }: { above?: boolean } = {}): HTMLElement {
  const root = $('#popover-root');
  root.innerHTML = `<div class="popover">${html}</div>`;
  const pop = root.firstElementChild as HTMLElement;
  const r = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  let top = above ? r.top - pr.height - 6 : r.bottom + 6;
  if (top + pr.height > innerHeight - 8) top = r.top - pr.height - 6;
  if (top < 8) top = 8;
  const left = Math.min(r.left, innerWidth - pr.width - 8);
  pop.style.top = `${top}px`;
  pop.style.left = `${Math.max(8, left)}px`;
  return pop;
}
function closePopover(): void { $('#popover-root').innerHTML = ''; }
document.addEventListener('mousedown', (e) => {
  const t = tgt(e);
  if (!t.closest('.popover') && !t.closest('[data-act="pick"]') && !t.closest('.emoji-btn') && !t.closest('#ws-menu-btn')) closePopover();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopover(); });

function openEmojiPicker(anchor: HTMLElement, onPick: (emoji: string) => void): void {
  const pop = showPopover(anchor, `<div class="emoji-grid">${EMOJI.map((e) => `<button data-e="${e}" title="${e}">${e}</button>`).join('')}</div>`);
  pop.addEventListener('click', (e) => { const b = tgt(e).closest<HTMLElement>('[data-e]'); if (b) { closePopover(); onPick(b.dataset.e ?? ''); } });
}

type MenuItem = [label: string, action: () => unknown] | null;
function openMenu(anchor: HTMLElement, items: MenuItem[]): void {
  const pop = showPopover(anchor, `<div class="menu">${items.map((it, i) => (it ? `<button data-i="${i}">${esc(it[0])}</button>` : '<hr>')).join('')}</div>`);
  pop.addEventListener('click', (e) => {
    const b = tgt(e).closest<HTMLElement>('[data-i]');
    const item = b ? items[Number(b.dataset.i)] : null;
    if (item) { closePopover(); item[1](); }
  });
}

interface Modal { el: HTMLElement; close: () => void; }
function openModal(title: string, html: string): Modal {
  const root = $('#modal-root');
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `<div class="modal" role="dialog" aria-label="${esc(title)}"><header><h2>${esc(title)}</h2><button class="icon-btn" data-close title="Close">✕</button></header><div class="body">${html}</div></div>`;
  root.appendChild(wrap);
  const close = (): void => { wrap.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  wrap.addEventListener('click', (e) => { if (tgt(e).closest('[data-close]')) close(); });
  const first = $opt<HTMLInputElement | HTMLTextAreaElement>('input, textarea', wrap);
  if (first) setTimeout(() => first.focus(), 0);
  return { el: wrap, close };
}

function createChannelModal(): void {
  const md = openModal('Create a channel', `<form id="cc-form">
    <label>Name<input name="name" placeholder="e.g. plan-budget" maxlength="80" required></label>
    <label>Topic <span class="muted small">(optional)</span><input name="topic" maxlength="250" placeholder="What's this channel about?"></label>
    <div class="toggle-row"><div><b>Make private</b><div class="muted small">Only invited people can see and join it.</div></div><input type="checkbox" name="is_private"></div>
    <div class="error" id="cc-err"></div>
    <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Create</button></div></form>`);
  $<HTMLFormElement>('#cc-form', md.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget as HTMLFormElement);
    try {
      const c = await api<ChannelSummary>('POST', `/workspaces/${S.wsId}/channels`, { name: field(f, 'name'), topic: field(f, 'topic'), is_private: f.get('is_private') === 'on' });
      md.close();
      await refreshChannels();
      openChannel(c.id);
    } catch (err) { $('#cc-err', md.el).textContent = errMsg(err); }
  });
}

async function browseModal(): Promise<void> {
  const rows = await api<BrowseRow[]>('GET', `/workspaces/${S.wsId}/channels/browse`);
  const md = openModal('Browse channels', `<input id="bc-filter" placeholder="Search channels"><ul class="list" id="bc-list"></ul>`);
  const render = (q = ''): void => {
    $('#bc-list', md.el).innerHTML = rows.filter((r) => r.name.includes(q.toLowerCase())).map((r) => `
      <li class="clickable" data-id="${r.id}"><span class="hash" style="font-size:18px">#</span>
        <div class="grow"><b>${esc(r.name)}</b><div class="sub">${r.joined ? '<b class="joined">✓ Joined</b> · ' : ''}${r.member_count} member${r.member_count === 1 ? '' : 's'}${r.topic ? ' · ' + esc(r.topic) : ''}</div></div>
        ${r.joined ? '<button class="btn" data-open>Open</button>' : '<button class="btn primary" data-join>Join</button>'}</li>`).join('') || '<li class="muted">No channels match.</li>';
  };
  render();
  $<HTMLInputElement>('#bc-filter', md.el).addEventListener('input', (e) => render((e.currentTarget as HTMLInputElement).value));
  $('#bc-list', md.el).addEventListener('click', async (e) => {
    const li = tgt(e).closest<HTMLElement>('[data-id]');
    if (!li) return;
    const id = Number(li.dataset.id);
    if (tgt(e).closest('[data-join]')) { await api<ChannelSummary>('POST', `/channels/${id}/join`); await refreshChannels(); }
    md.close();
    openChannel(id);
  });
}

function newDmModal(): void {
  const md = openModal('Direct messages', `<input id="dm-filter" placeholder="Find a person"><ul class="list" id="dm-people"></ul>`);
  const render = (q = ''): void => {
    q = q.toLowerCase();
    $('#dm-people', md.el).innerHTML = S.members.filter((u) => u.username.includes(q) || u.display_name.toLowerCase().includes(q)).map((u) => `
      <li class="clickable" data-id="${u.id}"><span class="avatar-wrap">${avatar(u)}${presenceDot(u.id)}</span>
        <div class="grow"><b>${esc(u.display_name)}</b>${u.id === me().id ? ' <span class="muted">(you)</span>' : ''}<div class="sub">@${esc(u.username)} · ${S.online.has(u.id) ? 'Active' : 'Away'}</div></div></li>`).join('');
  };
  render();
  $<HTMLInputElement>('#dm-filter', md.el).addEventListener('input', (e) => render((e.currentTarget as HTMLInputElement).value));
  $('#dm-people', md.el).addEventListener('click', async (e) => {
    const li = tgt(e).closest<HTMLElement>('[data-id]');
    if (!li) return;
    const c = await api<ChannelSummary>('POST', `/workspaces/${S.wsId}/dms`, { user_id: Number(li.dataset.id) });
    md.close();
    await refreshChannels();
    openChannel(c.id);
  });
}

async function membersModal(): Promise<void> {
  const c = current();
  if (!c || c.is_dm) return;
  const list = await api<UserBrief[]>('GET', `/channels/${c.id}/members`);
  const canAdd = !!chan(c.id);
  const md = openModal(`${c.is_private ? '🔒' : '#'} ${c.name} · ${list.length} member${list.length === 1 ? '' : 's'}`, `
    ${canAdd ? `<form id="am-form" style="display:flex;gap:8px"><input name="username" placeholder="Add someone by @username" list="am-users"><button class="btn primary">Add</button></form>
      <datalist id="am-users">${S.members.filter((m) => !list.some((x) => x.id === m.id)).map((m) => `<option value="${esc(m.username)}">${esc(m.display_name)}</option>`).join('')}</datalist>
      <div class="error" id="am-err"></div>` : ''}
    <ul class="list">${list.map((u) => `<li><span class="avatar-wrap">${avatar(u)}${presenceDot(u.id)}</span><div class="grow"><b>${esc(u.display_name)}</b>${u.id === me().id ? ' <span class="muted">(you)</span>' : ''}<div class="sub">@${esc(u.username)} · ${S.online.has(u.id) ? 'Active' : 'Away'}</div></div></li>`).join('')}</ul>
    ${canAdd && c.name !== 'general' ? '<div class="actions"><button class="btn danger" id="leave-btn">Leave channel</button></div>' : ''}`);
  const form = $opt<HTMLFormElement>('#am-form', md.el);
  if (form) form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api<AddMemberResponse>('POST', `/channels/${c.id}/members`, { username: field(form, 'username') });
      md.close();
      toast('Added to channel');
      refreshChannels().then(renderHeader);
    } catch (err) { $('#am-err', md.el).textContent = errStatus(err) === 404 ? 'No such user.' : errMsg(err); }
  });
  const leave = $opt('#leave-btn', md.el);
  if (leave) leave.addEventListener('click', async () => {
    await api<OkResponse>('POST', `/channels/${c.id}/leave`);
    md.close();
    await refreshChannels();
    const g = S.channels.find((x) => x.name === 'general') || S.channels[0];
    if (g) openChannel(g.id);
  });
}

function topicModal(): void {
  const c = chan(S.chId);
  if (!c || c.is_dm) return;
  const md = openModal('Edit topic', `<form id="tp-form"><input name="topic" maxlength="250" value="${esc(c.topic)}" placeholder="Add a topic">
    <div class="actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Save</button></div></form>`);
  $<HTMLFormElement>('#tp-form', md.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api<ChannelSummary>('PATCH', `/channels/${c.id}`, { topic: field(e.currentTarget as HTMLFormElement, 'topic') });
      c.topic = r.topic;
      renderHeader();
      md.close();
    } catch (err) { toast(errMsg(err)); }
  });
}

function inviteModal(): void {
  const ws = S.workspaces.find((w) => w.id === S.wsId);
  if (!ws) return;
  const md = openModal(`Invite people to ${ws.name}`, `<p class="muted">Share this invite code. Anyone with an account on this server can use it to join.</p>
    <div class="invite-box"><code id="inv-code">${esc(ws.invite_code)}</code><button class="btn primary" id="inv-copy">Copy</button></div>`);
  $('#inv-copy', md.el).addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(ws.invite_code); toast('Invite code copied'); } catch { toast('Copy failed — select the code manually'); }
  });
}

function addWorkspaceModal(): void {
  const md = openModal('Add a workspace', `<div class="onboard-grid" style="margin:6px 0 0">
    <form id="aw-create" class="stack"><h3>Create a workspace</h3><input name="name" placeholder="Workspace name" required maxlength="80"><button class="btn primary">Create</button></form>
    <form id="aw-join" class="stack"><h3>Join with invite code</h3><input name="invite_code" placeholder="Invite code" required><button class="btn">Join</button></form>
  </div><div class="error" id="aw-err"></div>`);
  $<HTMLFormElement>('#aw-create', md.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await createWorkspace(field(e.currentTarget as HTMLFormElement, 'name')); md.close(); } catch (err) { $('#aw-err', md.el).textContent = errMsg(err); }
  });
  $<HTMLFormElement>('#aw-join', md.el).addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await joinWorkspace(field(e.currentTarget as HTMLFormElement, 'invite_code').trim()); md.close(); } catch (err) {
      $('#aw-err', md.el).textContent = errStatus(err) === 404 ? 'No workspace with that invite code.' : errMsg(err);
    }
  });
}

window.addEventListener('hashchange', () => {
  const r = parseHash();
  if (r.ws && r.ws !== S.wsId && S.workspaces.some((w) => w.id === r.ws)) openWorkspace(r.ws, r.ch);
  else if (r.ch && r.ch !== S.chId) openChannel(r.ch);
});

boot();
