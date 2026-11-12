#!/usr/bin/env python3
"""Build docs/rslack-guide.pdf: HTML pages rendered by headless Chrome.

Usage:  python3 docs/build_guide.py            (from the repo root or docs/)
Env:    CHROME=/path/to/chrome   (default: google-chrome, chromium, chromium-browser)
        KEEP_HTML=1              keep docs/build/guide.html for debugging

Inputs: docs/screenshots/*.png (from `npm run e2e`), docs/diagrams/*.svg
(from `npm run diagrams`), web/fonts/Inter.woff2, LICENSE. Standard library only.
"""
from __future__ import annotations

import base64
import fcntl
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
OUT = DOCS / "rslack-guide.pdf"
VERSION = "0.1.0"
REPO = "https://github.com/shubhxho/rslack"
SITE = "https://rslack.vercel.app"
RELEASE = f"{REPO}/releases/tag/v{VERSION}"
BIN_ASSET = f"rslack-v{VERSION}-x86_64-unknown-linux-gnu.tar.gz"

e = html.escape


def uri(p: Path) -> str:
    return p.resolve().as_uri()


def shot(name: str) -> str:
    return uri(DOCS / "screenshots" / f"{name}.png")


def diagram(name: str) -> str:
    svg = (DOCS / "diagrams" / f"{name}.svg").read_text(encoding="utf-8")
    svg = re.sub(r"^<\?xml[^>]*>", "", svg).strip()
    return f'<div class="diagram {name}">{svg}</div>'


def code(text: str) -> str:
    """Code block; lines starting with '#' are rendered as comments."""
    out = []
    for line in text.strip("\n").split("\n"):
        if line.lstrip().startswith("#"):
            out.append(f'<span class="c">{e(line)}</span>')
        else:
            out.append(e(line))
    return "<pre><code>" + "\n".join(out) + "</code></pre>"


def table(head: list[str], rows: list[list[str]], cls: str = "") -> str:
    th = "".join(f"<th>{h}</th>" for h in head)
    tr = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows)
    return f'<table class="{cls}"><thead><tr>{th}</tr></thead><tbody>{tr}</tbody></table>'


def c(s: str) -> str:
    return f"<code>{e(s)}</code>"


# --------------------------------------------------------------------------- pages
# Each entry: (section title for the contents page or None, kicker, html body).
PAGES: list[tuple[str | None, str, str]] = []


def page(title: str | None, kicker: str, body: str) -> None:
    PAGES.append((title, kicker, body))


def section_head(num: str, title: str, lead: str = "") -> str:
    return (f'<header class="sec"><span class="num">{num}</span><h1>{title}</h1>'
            + (f'<p class="lead">{lead}</p>' if lead else "") + "</header>")


# 01 Overview ---------------------------------------------------------------
page("Overview", "01", section_head("01", "Overview",
    "rslack is a self-hosted, Slack-style team chat that ships as one Rust binary. "
    "The JSON API, the WebSocket and the web UI are served from the same executable, and "
    "everything it stores lives in one SQLite file plus an uploads folder.") + f"""
<div class="stats">
  <div><b>1</b><span>binary, ~7 MB on Linux x86_64</span></div>
  <div><b>1</b><span>SQLite file (WAL + FTS5)</span></div>
  <div><b>29</b><span>Rust tests, plus a browser e2e run</span></div>
  <div><b>0</b><span>external services required</span></div>
</div>
<figure class="frame"><img src="{shot('03-main-light')}" alt=""></figure>
<p class="cap">The main view in the light theme: channel sidebar, a conversation with code, an image attachment and reactions, and an open thread.</p>
<div class="cols2 small-gap">
  <div><h3>Who it's for</h3><p>Small teams, clubs, labs and homelabs that want their own chat server without operating Postgres, Redis or a Node runtime. Back it up by copying a folder.</p></div>
  <div><h3>What it is not (yet)</h3><p>A drop-in Slack replacement for large organisations: v0.1 runs as a single node and has no roles, moderation tools or rate limiting. See <i>Limitations</i>.</p></div>
</div>
""")

# 02 Features ---------------------------------------------------------------
FEATURES = [
    ("Accounts", "Sign-up and login with argon2id password hashing. Random session tokens (244 bits); only their SHA-256 is stored. Cookie or Bearer auth; sessions last 30 days and logout revokes them."),
    ("Workspaces", "Create a workspace or join one with an invite code. Every workspace starts with #general and new members join it automatically."),
    ("Channels", "Public and private channels: create, browse, join, leave, set a topic, add people. Private channels return 404 to non-members, so their existence isn't revealed."),
    ("Direct messages", "1:1 DMs, including a DM with yourself for notes."),
    ("Realtime", "WebSocket events for new, edited and deleted messages, reactions, thread replies, typing, presence and membership changes."),
    ("Threads", "Reply to any top-level message in a side panel. The parent shows the reply count and when the last reply arrived."),
    ("Reactions", "Toggled per user, with who-reacted tooltips. The picker offers 32 common emoji; the API accepts any short emoji string."),
    ("Edit and delete", "Authors only. A deleted message that has replies stays as a placeholder so its thread survives."),
    ("Unreads and mentions", "Per-channel unread and mention badges, a \"New\" marker at the first unread message, and the total in the tab title."),
    ("Full-text search", "SQLite FTS5 with prefix matching. Terms are quoted (no query injection) and results only include channels you can read."),
    ("File uploads", "Drag, drop or paste. Images render inline; anything else downloads as an attachment with nosniff and a sandbox CSP. Downloads are access-checked."),
    ("Web UI", "Plain HTML and CSS plus a strictly typed TypeScript client compiled into the binary. Light and dark themes; markdown-lite formatting."),
]
feat_html = "".join(f"<div><h3>{t}</h3><p>{d}</p></div>" for t, d in FEATURES)
page("Features", "02", section_head("02", "Features",
    "Everything below was exercised by the two-user headless Chrome walkthrough in "
    f"{c('e2e/e2e.ts')}, which is also where every screenshot in this guide comes from.")
    + f'<div class="features">{feat_html}</div>')

page(None, "02", f"""
<h2 class="pt">Features in pictures</h2>
<div class="gallery">
  <figure><div class="frame"><img src="{shot('04-main-dark')}" alt=""></div><figcaption><b>Dark theme.</b> Follows the OS setting; toggle in the bottom-left.</figcaption></figure>
  <figure><div class="frame"><img src="{shot('06-search')}" alt=""></div><figcaption><b>Search.</b> FTS5 prefix search with highlighted matches, scoped to channels you can read.</figcaption></figure>
  <figure><div class="frame"><img src="{shot('08-unread-dark')}" alt=""></div><figcaption><b>Unread badges.</b> Channels and DMs with new messages are bold and counted.</figcaption></figure>
  <figure><div class="frame"><img src="{shot('07-create-channel')}" alt=""></div><figcaption><b>Create a channel.</b> Public, or private and invite-only.</figcaption></figure>
  <figure><div class="frame"><img src="{shot('01-signup')}" alt=""></div><figcaption><b>Sign up.</b> Username, display name and a password of at least 8 characters.</figcaption></figure>
  <figure><div class="frame"><img src="{shot('02-onboarding')}" alt=""></div><figcaption><b>Onboarding.</b> Create a workspace, or join one with an invite code.</figcaption></figure>
</div>
""")

# 03 Architecture -----------------------------------------------------------
page("Architecture", "03", section_head("03", "Architecture",
    "One process, three surfaces: embedded static assets, a REST API and a WebSocket. "
    "Writes are committed to SQLite before an in-process hub fans them out.")
    + diagram("architecture") + """
<div class="cols2">
  <div><h3>The write path</h3><p>A REST handler authenticates the caller, checks access, <b>commits to SQLite</b>, and then hands a JSON event to the <code>Hub</code>. The hub looks up the audience (the channel's members, or the workspace for presence) and pushes the event to every open socket those users have.</p></div>
  <div><h3>Why it's simple to reason about</h3><p>The WebSocket only carries server events, plus <code>typing</code> and <code>ping</code> from clients. Nothing reaches a client before it is persisted, and a client that reconnects simply re-fetches its current view.</p></div>
</div>
""")

page(None, "03", '<h2 class="pt">One message, end to end</h2>'
    '<p class="lead narrow">Alice posts in a channel Bob is a member of. The REST response and the WebSocket event carry the same serialized <code>Message</code>.</p>'
    + diagram("write-path") + """
<div class="cols2">
  <div><h3>Ordering</h3><p>SQLite runs in WAL mode with a single writer, so message ids are strictly increasing per database. Clients use them for pagination (<code>before=</code>) and read markers (<code>last_read_id</code>).</p></div>
  <div><h3>Typing and presence</h3><p>Typing events are relayed without touching the database. Presence is tracked per connection: you're online while any tab holds a socket, and offline when the last one closes.</p></div>
</div>
""" + '<h3 class="mt">Source layout</h3>' + table(["Path", "Responsibility"], [
    [c("src/lib.rs"), "Router, state, start and serve"],
    [c("src/auth.rs"), "Password hashing, sessions, the AuthUser extractor, cookies"],
    [c("src/access.rs"), "Membership and visibility rules"],
    [c("src/{workspaces,channels,messages}.rs"), "REST handlers"],
    [c("src/{search,uploads}.rs"), "FTS5 search; upload storage and download"],
    [c("src/realtime.rs"), "Hub, WebSocket handler, Origin checks"],
    [c("frontend/src/*.ts"), "Typed web client; esbuild compiles it to web/app.js, embedded with rust-embed"],
    [c("migrations/"), "SQL schema, applied automatically at startup"],
], "compact"))

# 04 Data model -------------------------------------------------------------
page("Data model", "04", section_head("04", "Data model",
    "Nine tables and one FTS5 index in a single SQLite database. Foreign keys cascade, so "
    "deleting a channel removes its messages, reactions and memberships.")
    + diagram("data-model") + """
<div class="cols2 dm-notes">
  <div><h3>Notes</h3><ul>
    <li><code>sessions.token_hash</code> is SHA-256 of the bearer token; the token itself is never stored.</li>
    <li>Threads are self-references: <code>messages.parent_id</code>.</li>
    <li>DMs are channels with <code>is_dm = 1</code> and exactly two members (or one, for a DM with yourself).</li></ul></div>
  <div><h3>&nbsp;</h3><ul>
    <li><code>channel_members.last_read_id</code> drives unread and mention counts and only moves forward.</li>
    <li><code>messages_fts</code> is an external-content FTS5 table kept in sync by insert, update and delete triggers.</li>
    <li>Uploaded files live on disk under random <code>storage_name</code>s.</li></ul></div>
</div>
""")

# 05 Install ----------------------------------------------------------------
page("Install", "05", section_head("05", "Install",
    "Three ways to run rslack. All of them end with a server on one port and a data directory.") + f"""
<div class="steps">
<div><h3><span class="n">A</span>Prebuilt binary (Linux x86_64)</h3>
<p>Download <code>{BIN_ASSET}</code> and its <code>.sha256</code> from the <a href="{RELEASE}">v{VERSION} release</a>. Requires glibc 2.34 or newer (Debian 12, Ubuntu 22.04, RHEL 9 and later).</p>
{code(f'''sha256sum -c {BIN_ASSET}.sha256
tar xzf {BIN_ASSET}
./rslack-v{VERSION}-x86_64-unknown-linux-gnu/rslack --data-dir ./data
# → http://127.0.0.1:8080''')}</div>
<div><h3><span class="n">B</span>From source with Cargo</h3>
<p>Needs Rust 1.88 or newer. Node is <b>not</b> required: the compiled web client is committed.</p>
{code(f'''git clone {REPO}
cd rslack
cargo build --release
./target/release/rslack            # data in ./data''')}</div>
<div><h3><span class="n">C</span>Docker</h3>
<p>A two-stage <code>Dockerfile</code> (Rust builder, then non-root <code>debian:bookworm-slim</code>) and a <code>docker-compose.yml</code> with every setting documented.</p>
{code('''docker compose up -d               # http://localhost:8080
# data persists in the rslack-data volume''')}
<p class="note">The Docker files were written and reviewed, but the image has not been built yet because Docker was unavailable on the build machine.</p></div>
</div>
<h3 class="mt">First run</h3>
<p>Open the server in a browser, create an account and a workspace, then share the workspace's invite code (workspace menu → <i>Invite people</i>). Check liveness with <code>GET /healthz</code>, which returns <code>ok</code>.</p>
""")

# 06 Configuration ----------------------------------------------------------
CONFIG = [
    ["--host", "RSLACK_HOST", "127.0.0.1", "Bind address; 0.0.0.0 for all interfaces"],
    ["-p, --port", "RSLACK_PORT", "8080", "TCP port"],
    ["--data-dir", "RSLACK_DATA_DIR", "./data", "Holds rslack.db (SQLite, WAL) and uploads/"],
    ["--max-upload-mb", "RSLACK_MAX_UPLOAD_MB", "10", "Per-file upload limit"],
    ["--secure-cookies", "RSLACK_SECURE_COOKIES", "false", "Add Secure to the session cookie; enable behind HTTPS"],
    ["--allow-signup", "RSLACK_ALLOW_SIGNUP", "true", "Set to false to close registration"],
    ["--public-origin", "RSLACK_PUBLIC_ORIGIN", "(none)", "Comma-separated public origins accepted by the WebSocket Origin check"],
    ["--cookie-samesite", "RSLACK_COOKIE_SAMESITE", "lax", "lax, strict or none (none forces Secure; Partitioned)"],
]
page("Configuration", "06", section_head("06", "Configuration",
    "Every option is a CLI flag and an environment variable. Flags win over the environment.")
    + table(["Flag", "Environment", "Default", "Meaning"], [[c(a), c(b), c(d0), m] for a, b, d0, m in CONFIG], "config")
    + """
<div class="cols2 mt">
  <div><h3>Logging</h3><p><code>RUST_LOG</code> controls verbosity, default <code>rslack=info</code>. Logs go to stderr in a compact one-line format.</p>
  <h3>Backups</h3><p>Stop the server and copy the data directory, or keep it running and use SQLite's online backup, then copy <code>uploads/</code>:</p>""" + code('sqlite3 data/rslack.db ".backup backup.db"') + """</div>
  <div><h3>Example: a public server</h3>""" + code('''RSLACK_HOST=0.0.0.0 \\
RSLACK_PORT=8080 \\
RSLACK_DATA_DIR=/srv/rslack \\
RSLACK_SECURE_COOKIES=true \\
RSLACK_ALLOW_SIGNUP=false \\
RSLACK_PUBLIC_ORIGIN=https://chat.example.com \\
  rslack''') + """<p>Close sign-ups after your team has registered; existing users keep working.</p></div>
</div>
""")

# 07 Reverse proxy & HF Spaces ------------------------------------------------
page("Reverse proxy and Hugging Face Spaces", "07", section_head("07", "Reverse proxy and Hugging Face Spaces",
    "rslack speaks plain HTTP. Put TLS in front of it, and make sure the proxy forwards WebSocket upgrades on /api/ws.")
    + """
<div class="cols2">
<div><h3>Origin checks</h3>
<p>To stop cross-site WebSocket hijacking, a handshake is accepted only when its <code>Origin</code> host matches one of:</p>
<ol><li>the <code>Host</code> header,</li><li>the first <code>X-Forwarded-Host</code> value,</li><li>an entry in <code>RSLACK_PUBLIC_ORIGIN</code> (exact, case-insensitive).</li></ol>
<p>If your proxy rewrites <code>Host</code> and doesn't send <code>X-Forwarded-Host</code>, set <code>RSLACK_PUBLIC_ORIGIN</code>.</p></div>
<div><h3>Caddy</h3>""" + code('''chat.example.com {
    reverse_proxy 127.0.0.1:8080
}''') + """<h3>nginx</h3>""" + code('''location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    client_max_body_size 12m;
}''') + """</div>
</div>
<h3 class="mt">Hugging Face Docker Space</h3>
<p>The repository's companion Space bundle builds rslack from source and runs it on port 7860. The Space proxy rewrites <code>Host</code> and serves the app inside a cross-site iframe on huggingface.co, so the bundle sets:</p>
""" + table(["Setting", "Value", "Why"], [
    [c("RSLACK_PUBLIC_ORIGIN"), c("https://<user>-rslack.hf.space"), "Accept the Space's public origin on WebSocket handshakes"],
    [c("RSLACK_SECURE_COOKIES"), c("true"), "The Space is served over HTTPS"],
    [c("RSLACK_COOKIE_SAMESITE"), c("none"), "Login works inside the huggingface.co iframe (adds Partitioned)"],
    [c("--data-dir"), c("/data"), "Persistent storage if enabled; falls back to /tmp/rslack-data, which is lost on restart"],
], "compact") + """
<p class="note">Docker Spaces on the free CPU tier require a Hugging Face PRO subscription at the time of writing, so no public demo Space is running yet.</p>
""")

# 08 REST API -----------------------------------------------------------------
API = [
    ("POST", "/auth/signup", "{username, password, display_name?}", "Create an account → {user, token}"),
    ("POST", "/auth/login", "{username, password}", "Log in → {user, token}"),
    ("POST", "/auth/logout", "", "Revoke the current session"),
    ("GET", "/me", "", "The current User"),
    ("GET", "/workspaces", "", "Your workspaces"),
    ("POST", "/workspaces", "{name}", "Create a workspace (with #general)"),
    ("POST", "/workspaces/join", "{invite_code}", "Join a workspace"),
    ("GET", "/workspaces/:id/members", "", "Members with online status"),
    ("GET", "/workspaces/:id/channels", "", "Your channels and DMs with unread_count, mention_count, last_read_id"),
    ("POST", "/workspaces/:id/channels", "{name, topic?, is_private?}", "Create a channel"),
    ("GET", "/workspaces/:id/channels/browse", "", "Public channels with a joined flag"),
    ("POST", "/workspaces/:id/dms", "{user_id}", "Get or create a DM"),
    ("GET", "/workspaces/:id/search", "?q=", "Full-text search → {results: [{message, channel}]}"),
    ("PATCH", "/channels/:id", "{topic}", "Set the topic"),
    ("POST", "/channels/:id/join · /leave", "", "Join or leave a channel"),
    ("GET", "/channels/:id/members", "", "Channel members"),
    ("POST", "/channels/:id/members", "{user_id | username}", "Add a member (how people get into private channels)"),
    ("GET", "/channels/:id/messages", "?before=&limit=", "Top-level messages, oldest first → {messages, has_more}"),
    ("POST", "/channels/:id/messages", "{body, parent_id?, attachment_ids?}", "Post; a thread reply when parent_id is set"),
    ("POST", "/channels/:id/read", "{message_id}", "Advance your read marker (never moves back)"),
    ("PATCH", "/messages/:id", "{body}", "Edit (author only)"),
    ("DELETE", "/messages/:id", "", "Delete (author only)"),
    ("GET", "/messages/:id/thread", "", "{parent, replies}"),
    ("POST", "/messages/:id/reactions", "{emoji}", "Toggle → {added, reactions}"),
    ("POST", "/uploads", "multipart file", "Upload → Attachment; attach via attachment_ids"),
    ("GET", "/files/:id", "", "Download (access-checked)"),
    ("GET", "/ws", "", "Open the WebSocket"),
]
rows = [[f'<span class="m m-{m.lower()}">{m}</span>', c(p), c(b) if b else "", d] for m, p, b, d in API]
page("REST API reference", "08", section_head("08", "REST API reference",
    "All endpoints live under /api and speak JSON. Authenticate with the rslack_session cookie "
    "or Authorization: Bearer &lt;token&gt;. Errors are {\"error\": \"…\"} with status 400, 401, 403, 404, 409 or 413.")
    + table(["", "Path", "Body / query", "Returns / does"], rows[:15], "api"))

page(None, "08", '<h2 class="pt">REST API reference, continued</h2>'
    + table(["", "Path", "Body / query", "Returns / does"], rows[15:], "api")
    + """<h3 class="mt">Example: a bot posting a message</h3>""" + code('''TOKEN=$(curl -s localhost:8080/api/auth/login -H 'content-type: application/json' \\
  -d '{"username":"ci-bot","password":"a-long-password"}' | jq -r .token)
curl -s localhost:8080/api/channels/7/messages -H "authorization: Bearer $TOKEN" \\
  -H 'content-type: application/json' -d '{"body":"Deploy finished"}\'''') + """
<p class="note">Timestamps are Unix milliseconds. Message bodies are limited to 8,000 characters. Uploads are capped by <code>RSLACK_MAX_UPLOAD_MB</code> (413 when exceeded).</p>""")

page(None, "08", """<h2 class="pt">Core types</h2>
<p class="lead narrow">These mirror the serde structs in the Rust code and are declared once, in <code>frontend/src/types.ts</code>, for the web client and the e2e test.</p>
<div class="cols2">
<div>""" + code('''interface User {
  id: number; username: string;
  display_name: string; created_at: number;
}
interface ChannelSummary {
  id: number; workspace_id: number;
  name: string; topic: string;
  is_private: boolean; is_dm: boolean;
  created_by: number; created_at: number;
  last_read_id: number;
  unread_count: number;
  mention_count: number;
  member_count: number;
  dm_user: UserBrief | null;
}''') + """</div><div>""" + code('''interface Message {
  id: number; channel_id: number;
  user_id: number; username: string;
  display_name: string;
  parent_id: number | null;
  body: string; deleted: boolean;
  created_at: number;
  edited_at: number | null;
  reply_count: number;
  last_reply_at: number | null;
  reactions: Reaction[];
  attachments: Attachment[];
}''') + """</div></div>
<p class="note">Every field is serialized by serde with the same name. Optional Rust fields (<code>Option&lt;T&gt;</code>) arrive as <code>null</code>, never omitted.</p>
""")

# 09 WebSocket ----------------------------------------------------------------
WS = [
    ("hello", "user_id, online_user_ids", "Sent once after connecting"),
    ("presence", "user_id, online", "A workspace peer came online or went offline"),
    ("message.new", "channel_id, message", "A message or thread reply was posted"),
    ("message.updated", "channel_id, message", "Edited, or its reply count changed"),
    ("message.deleted", "channel_id, message_id, parent_id, has_replies", "Deleted; kept as a placeholder when has_replies"),
    ("reaction.updated", "channel_id, message_id, parent_id, reactions", "The full reaction list after a toggle"),
    ("typing", "channel_id, parent_id, user_id, username, display_name", "Relayed to the channel's other members"),
    ("channel.updated", "channel_id, topic", "Topic changed"),
    ("channel.read", "channel_id, message_id", "You read a channel in another tab"),
    ("channels.changed", "workspace_id", "Re-fetch the channel list"),
    ("channel.members_changed", "channel_id, user_id, joined", "Someone joined or left"),
    ("workspace.member_joined", "workspace_id, user_id", "A new member joined a workspace"),
    ("workspaces.changed", "", "Re-fetch your workspaces"),
    ("pong", "", "Reply to ping"),
]
page("WebSocket events", "09", section_head("09", "WebSocket events",
    "Connect to /api/ws with the session cookie (browsers) or a Bearer header (other clients). "
    "Every frame is a JSON object with a type field.")
    + table(["Server → client", "Fields", "Meaning"], [[c(t), e(f), d] for t, f, d in WS], "ws")
    + """
<div class="cols2 mt">
<div><h3>Client → server</h3>""" + code('''{"type":"typing","channel_id":7,"parent_id":null}
{"type":"ping"}''') + """<p>The web client pings every 25 seconds and reconnects with exponential backoff (0.5 s to 10 s), re-fetching its view after a reconnect.</p></div>
<div><h3>Typed in the client</h3>""" + code('''type ServerEvent = HelloEvent
  | PresenceEvent | MessageNewEvent
  | MessageDeletedEvent | TypingEvent
  | ... ; // 14 variants in all''') + """<p>The event handler switches on <code>type</code> with an exhaustive <code>never</code> check, so a new server event fails the typecheck until it is handled.</p></div>
</div>
""")

# 10 Security -----------------------------------------------------------------
SEC = [
    ("Passwords", "argon2id with a random salt per user (argon2 crate defaults). Minimum length 8."),
    ("Sessions", "Two random UUIDv4s (244 bits) per token; the database stores only SHA-256(token). 30-day expiry; logout deletes the row."),
    ("Cookies", "HttpOnly, SameSite=Lax by default; Secure when enabled; SameSite=None forces Secure and Partitioned."),
    ("Access control", "Every channel, message, thread, reaction, search and file request checks membership. Private channels answer 404 to outsiders."),
    ("WebSocket", "Requires a valid session, and an Origin that matches Host, X-Forwarded-Host or RSLACK_PUBLIC_ORIGIN; otherwise 403."),
    ("Events", "Broadcasts go only to the channel's members, so private-channel events never reach outsiders (covered by a test)."),
    ("Search", "User input is split into terms, each quoted and prefix-matched, so FTS5 syntax cannot be injected."),
    ("Uploads", "Random storage names; filenames are stripped of paths. Only PNG, JPEG, GIF and WebP render inline; everything else is application/octet-stream as an attachment. All files get nosniff and a sandbox CSP."),
    ("Rendering", "The client HTML-escapes all user content before applying markdown-lite; links get rel=\"noopener noreferrer\"."),
    ("SQL", "All queries use sqlx bind parameters."),
]
page("Security model", "10", section_head("10", "Security model",
    "What rslack defends against in v0.1, and what it leaves to the operator.")
    + table(["Area", "Behaviour"], [[f"<b>{a}</b>", b] for a, b in SEC], "sec")
    + """
<div class="callout"><h3>Operator responsibilities</h3><ul>
<li>Terminate TLS in front of rslack and set <code>RSLACK_SECURE_COOKIES=true</code>.</li>
<li>Add rate limiting at the proxy: v0.1 has none on login or the API.</li>
<li>Treat invite codes as secrets: anyone with an account and the code can join, and codes can't be rotated yet.</li>
<li>Back up the data directory; there is no built-in replication.</li></ul></div>
""")

# 11 Testing ------------------------------------------------------------------
TESTS = [
    ("Unit (9)", "Channel-name normalisation and validation; FTS query quoting (3); upload filename stripping; hub presence per connection; Origin checks direct and behind a proxy."),
    ("API integration (15)", "Signup, login, logout and validation; disabled signups; cookie attributes; workspaces and invites; public and private channels; DMs; posting, editing, deleting and pagination; threads; reactions; unread and mention counts; search access control; uploads (access, limits, content types); serving the UI and /healthz."),
    ("WebSocket integration (5)", "Two clients receiving each other's broadcasts and typing; presence reaching new workspace peers; private-channel isolation; auth and Origin enforcement; Origin behind a reverse proxy."),
    ("Browser e2e (18 checks)", "Two headless Chrome users: signup, workspace, invite, channel, realtime message, mention highlight, image upload, threads both ways, reactions, edit, typing, DM unread badge, read clearing, search, presence, reload persistence."),
    ("TypeScript", "Strict typecheck of the web client and the e2e and diagram scripts; CI rebuilds web/app.js and fails if the committed bundle is stale."),
]
page("Testing", "11", section_head("11", "Testing",
    "Integration tests start the real server on an ephemeral port with a temporary data directory, then talk to it over HTTP and WebSocket.")
    + table(["Suite", "Covers"], [[f"<b>{a}</b>", b] for a, b in TESTS], "tests")
    + """<h3 class="mt">Run everything</h3>""" + code('''cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test                         # 29 tests

npm ci                             # TypeScript tooling (optional for Rust builds)
npm run typecheck                  # strict tsc, web client + scripts
npm run build:web                  # frontend/src/*.ts → web/app.js

RSLACK_DATA_DIR=$(mktemp -d) RSLACK_PORT=8099 ./target/release/rslack &
npm run e2e                        # also refreshes docs/screenshots/''')
    + """<p>CI runs fmt, clippy, tests and a release build on Linux, macOS and Windows, a <code>cargo check</code> on the MSRV (Rust 1.88), and the TypeScript job.</p>
""")

# 12 Limitations --------------------------------------------------------------
LIM = [
    ("Single node", "The realtime hub is in memory, so replicas behind a load balancer won't see each other's events. SQLite means one writer; fine for small and medium teams, untested at large scale (no load tests yet)."),
    ("No roles or moderation", "No admin UI, kicking or banning, and no deleting channels or workspaces. Owners are recorded but have no extra powers."),
    ("No rate limiting", "Neither login nor the API is rate limited."),
    ("Accounts", "No email, password reset or 2FA. Password and display-name changes aren't exposed yet."),
    ("Unread counting", "Only top-level messages count; there is no Threads inbox. Mention detection is a substring match on @username."),
    ("DMs", "1:1 only; no group DMs."),
    ("Search", "Word-prefix FTS5 with no from:/in: filters; at most 50 results."),
    ("Uploads", "Never-attached uploads aren't cleaned up; deleting a message hides but doesn't delete its files; no thumbnails."),
    ("Notifications", "No push or desktop notifications and no link previews."),
    ("UI coverage", "Tested in headless Chrome only. Narrow windows work but it isn't a mobile design; accessibility hasn't been audited."),
    ("Presence", "Per connection: online while any tab has a socket; no away or idle state."),
    ("Docker", "The image hasn't been built yet."),
]
page("Limitations", "12", section_head("12", "Limitations",
    "Known gaps in v0.1, listed so they aren't a surprise.")
    + table(["Area", "Gap"], [[f"<b>{a}</b>", b] for a, b in LIM], "lim"))

# 13 Roadmap ------------------------------------------------------------------
ROAD = [
    ("v0.2 · Operate safely", ["Rate limiting for login and writes", "Invite code rotation and expiry", "Workspace roles: owner, admin, member", "Password and display-name changes"]),
    ("v0.3 · Daily use", ["Threads inbox and unread replies", "Group DMs", "Search filters: from:, in:, before:", "Image thumbnails and upload cleanup"]),
    ("Later · Scale and reach", ["Desktop and Web Push notifications", "Link unfurling", "Optional Postgres backend with a pub/sub hub for multiple nodes", "Accessibility audit and a mobile layout"]),
]
road_html = "".join(f'<div class="road"><h3>{t}</h3><ul>' + "".join(f"<li>{i}</li>" for i in items) + "</ul></div>" for t, items in ROAD)
page("Roadmap", "13", section_head("13", "Roadmap",
    "Direction, not promises. Items are ordered by how much they reduce risk for people running rslack today.")
    + f'<div class="roadmap">{road_html}</div>'
    + f"""<div class="callout mt"><h3>Contributing</h3><p>Issues and pull requests are welcome at <a href="{REPO}">{REPO.replace('https://', '')}</a>. Keep <code>cargo test</code>, clippy and <code>npm run typecheck</code> green, and run the e2e walkthrough for UI changes.</p></div>""")

# 14 License ------------------------------------------------------------------
license_text = (ROOT / "LICENSE").read_text(encoding="utf-8").strip()
page("License", "14", section_head("14", "License") + f"""
<pre class="license">{e(license_text)}</pre>
<h3 class="mt">Third-party</h3>
<p>The web UI and this guide use a Latin subset of the <b>Inter</b> typeface by Rasmus Andersson, © 2016 The Inter Project Authors, licensed under the SIL Open Font License 1.1 (<code>web/fonts/LICENSE-Inter.txt</code>). Rust dependencies are listed in <code>Cargo.lock</code> and keep their own licenses (mostly MIT or Apache-2.0).</p>
<p class="end">rslack v{VERSION} · {SITE.replace('https://', '')} · {REPO.replace('https://', '')}</p>
""")

# --------------------------------------------------------------------------- assembly
FIRST_CONTENT_PAGE = 3  # 1 = cover, 2 = contents


def contents() -> str:
    items = []
    for i, (title, kicker, _) in enumerate(PAGES):
        if title:
            items.append(f'<li><span class="k">{kicker}</span><span class="t">{title}</span>'
                         f'<span class="dots"></span><span class="p">{i + FIRST_CONTENT_PAGE}</span></li>')
    return f"""<section class="page contents"><div class="inner">
<p class="eyebrow">rslack guide</p><h1 class="big">Contents</h1>
<ol class="toc">{''.join(items)}</ol>
<div class="links"><div><span>Website</span><a href="{SITE}">{SITE.replace('https://', '')}</a></div>
<div><span>Source</span><a href="{REPO}">{REPO.replace('https://', '')}</a></div>
<div><span>Release</span><a href="{RELEASE}">v{VERSION}</a></div></div>
</div>{footer(2)}</section>"""


def footer(n: int) -> str:
    return f'<footer class="pf"><span>rslack · The guide · v{VERSION}</span><span>{n:02d}</span></footer>'


def cover() -> str:
    return f"""<section class="page cover"><div class="inner">
<div class="brand"><img src="{uri(ROOT / 'web' / 'favicon.svg')}" alt="">rslack</div>
<p class="eyebrow"><i></i>Version {VERSION} · MIT</p>
<h1 class="title">Team chat in<br>one binary.</h1>
<p class="sub">The rslack guide: features, architecture, installation, configuration, API reference, security model and roadmap.</p>
<figure class="frame cover-shot"><img src="{shot('04-main-dark')}" alt=""></figure>
<div class="meta"><span>Self-hosted · Rust · SQLite</span><span>{SITE.replace('https://', '')}</span></div>
</div></section>"""


CSS = """
@font-face { font-family: "Inter"; src: url("__FONT__") format("woff2"); font-weight: 400 700; }
@page { size: A4; margin: 0; }
:root { --text:#111; --text-2:#5f5f5f; --text-3:#9a9a9a; --border:#e6e6e6; --bg-2:#fafafa; --accent:#e5480b; --accent-soft:#fdeee7;
  --mono: "JetBrains Mono", "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font: 9.6pt/1.55 "Inter", system-ui, sans-serif; color: var(--text); font-feature-settings: "cv11","ss01"; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { width: 210mm; height: 297mm; position: relative; overflow: hidden; page-break-after: always; break-after: page; }
.page:last-child { page-break-after: auto; break-after: auto; }
.inner { position: absolute; inset: 20mm 20mm 22mm 20mm; }
.pf { position: absolute; left: 20mm; right: 20mm; bottom: 11mm; display: flex; justify-content: space-between; font-size: 7.5pt; color: var(--text-3); border-top: 1px solid var(--border); padding-top: 3mm; font-variant-numeric: tabular-nums; }
a { color: inherit; text-decoration: underline; text-decoration-color: #cfcfcf; text-underline-offset: 2px; }
h1, h2, h3 { font-weight: 500; letter-spacing: -.02em; margin: 0; }
h3 { font-size: 10.5pt; font-weight: 600; letter-spacing: -.01em; margin: 0 0 1.6mm; }
p { margin: 0 0 2.6mm; }
ul, ol { margin: 0 0 2.6mm; padding-left: 4.5mm; }
li { margin: .6mm 0; }
code { font-family: var(--mono); font-size: .86em; background: var(--bg-2); border: 1px solid var(--border); border-radius: 3px; padding: 0 1.2mm; white-space: nowrap; }
pre { font: 7.6pt/1.6 var(--mono); background: var(--bg-2); border: 1px solid var(--border); border-radius: 2.5mm; padding: 3.2mm 4mm; margin: 0 0 3mm; white-space: pre-wrap; word-break: break-word; }
pre code { background: none; border: 0; padding: 0; font-size: inherit; white-space: inherit; }
pre .c { color: var(--text-3); }
.mt { margin-top: 5mm; }
.note { font-size: 8.4pt; color: var(--text-2); }
.lead { font-size: 11pt; line-height: 1.5; color: var(--text-2); max-width: 150mm; margin: 4mm 0 0; }
.lead.narrow { margin: 0 0 6mm; max-width: 140mm; }
header.sec { margin-bottom: 8mm; padding-bottom: 6mm; border-bottom: 1px solid var(--border); }
header.sec .num { display: block; font-size: 8pt; color: var(--accent); font-weight: 600; letter-spacing: .08em; margin-bottom: 3mm; font-variant-numeric: tabular-nums; }
header.sec h1 { font-size: 26pt; line-height: 1.05; letter-spacing: -.035em; }
h2.pt { font-size: 18pt; letter-spacing: -.03em; margin: 0 0 5mm; }
.cols2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8mm; }
.cols2.small-gap { gap: 6mm; margin-top: 2mm; }
.frame { margin: 0; border: 1px solid var(--border); border-radius: 2.5mm; overflow: hidden; background: var(--bg-2); }
.frame img { display: block; width: 100%; height: auto; }
.cap { font-size: 8.2pt; color: var(--text-2); margin: 2.4mm 0 6mm; }
/* tables */
table { width: 100%; border-collapse: collapse; font-size: 8.4pt; margin: 0 0 3mm; }
th { text-align: left; font-weight: 500; color: var(--text-3); font-size: 7.4pt; text-transform: uppercase; letter-spacing: .06em; padding: 0 3mm 2mm 0; border-bottom: 1px solid #d6d6d6; }
td { padding: 2.1mm 3mm 2.1mm 0; border-bottom: 1px solid var(--border); vertical-align: top; }
td code { white-space: normal; word-break: break-word; }
table.api { font-size: 7.7pt; } table.api td { padding: 1.45mm 2.5mm 1.45mm 0; } table.api td:first-child { width: 13mm; }
table.api td:nth-child(2) { width: 52mm; } table.api td:nth-child(3) { width: 44mm; }
.m { font: 600 6.6pt/1 var(--mono); letter-spacing: .02em; padding: .9mm 1.3mm; border-radius: 1.2mm; border: 1px solid var(--border); color: var(--text-2); }
.m-post { color: var(--accent); border-color: #f5c6b2; }
table.config td:nth-child(1) { width: 32mm; } table.config td:nth-child(2) { width: 46mm; } table.config td:nth-child(3) { width: 20mm; }
table.ws td { padding-top: 1.6mm; padding-bottom: 1.6mm; } table.ws td:first-child { width: 44mm; } table.ws td:nth-child(2) { width: 58mm; color: var(--text-2); font-family: var(--mono); font-size: 7.3pt; }
table.sec td:first-child, table.tests td:first-child, table.lim td:first-child { width: 38mm; }
table.compact td:first-child { width: 58mm; }
td code { white-space: nowrap; }
/* stats */
.stats { display: grid; grid-template-columns: repeat(4, 1fr); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); margin: 0 0 7mm; }
.stats div { padding: 4mm 4mm 4mm 0; display: flex; flex-direction: column; }
.stats div + div { padding-left: 4mm; border-left: 1px solid var(--border); }
.stats b { font-size: 20pt; font-weight: 500; letter-spacing: -.03em; line-height: 1.1; }
.stats span { font-size: 7.8pt; color: var(--text-2); }
/* features */
.features { display: grid; grid-template-columns: 1fr 1fr; border-top: 1px solid var(--border); }
.features > div { padding: 3.6mm 6mm 3.6mm 0; border-bottom: 1px solid var(--border); }
.features > div:nth-child(even) { padding-left: 6mm; padding-right: 0; border-left: 1px solid var(--border); }
.features h3 { margin-bottom: 1mm; }
.features p { margin: 0; color: var(--text-2); font-size: 8.8pt; }
.gallery { display: grid; grid-template-columns: 1fr 1fr; gap: 7mm 6mm; }
.gallery figure { margin: 0; }
.gallery figcaption { font-size: 8pt; color: var(--text-2); margin-top: 2.2mm; }
.gallery figcaption b { color: var(--text); font-weight: 600; }
/* diagrams */
.diagram { border: 1px solid var(--border); border-radius: 2.5mm; padding: 5mm; margin: 0 0 7mm; display: flex; justify-content: center; background: #fff; }
.diagram svg { width: 100% !important; max-width: 100% !important; height: auto !important; }
.diagram.data-model svg { max-height: 132mm; }
.dm-notes li { font-size: 8.4pt; margin: .3mm 0; }
.diagram.write-path svg { max-height: 95mm; }
.diagram.architecture svg { max-height: 120mm; }
/* steps */
.steps > div { padding: 0 0 4mm; margin-bottom: 4mm; border-bottom: 1px solid var(--border); }
.steps > div:last-child { border-bottom: 0; margin-bottom: 0; }
.steps .n { display: inline-grid; place-items: center; width: 5.2mm; height: 5.2mm; border-radius: 50%; border: 1px solid var(--text); font-size: 7.5pt; margin-right: 2.5mm; vertical-align: 1px; }
.callout { border: 1px solid var(--border); border-left: 2px solid var(--accent); border-radius: 0 2.5mm 2.5mm 0; padding: 4mm 5mm 2mm; background: var(--bg-2); margin-top: 6mm; }
.roadmap { display: grid; grid-template-columns: repeat(3, 1fr); border-top: 1px solid var(--border); }
.road { padding: 4mm 5mm 4mm 0; }
.road + .road { padding-left: 5mm; border-left: 1px solid var(--border); }
.road ul { color: var(--text-2); padding-left: 4mm; }
.road:first-child h3::before { content: ""; display: inline-block; width: 1.6mm; height: 1.6mm; border-radius: 50%; background: var(--accent); margin-right: 2mm; vertical-align: 1px; }
pre.license { font-size: 7.6pt; white-space: pre-wrap; }
.end { margin-top: 10mm; font-size: 8pt; color: var(--text-3); }
/* cover */
.cover .inner { inset: 22mm 20mm 20mm 20mm; }
.brand { display: flex; align-items: center; gap: 3mm; font-weight: 600; font-size: 12pt; letter-spacing: -.01em; }
.brand img { width: 8mm; height: 8mm; }
.eyebrow { font-size: 8.5pt; color: var(--text-2); margin: 30mm 0 6mm; display: flex; align-items: center; gap: 2.5mm; }
.eyebrow i { width: 2mm; height: 2mm; border-radius: 50%; background: var(--accent); }
.title { font-size: 46pt; line-height: 1; letter-spacing: -.045em; font-weight: 500; }
.sub { font-size: 12pt; line-height: 1.5; color: var(--text-2); max-width: 130mm; margin: 7mm 0 0; }
.cover-shot { margin-top: 14mm; }
.meta { position: absolute; left: 0; right: 0; bottom: 0; display: flex; justify-content: space-between; font-size: 8pt; color: var(--text-3); border-top: 1px solid var(--border); padding-top: 3mm; }
/* contents */
.contents .eyebrow { margin: 0 0 4mm; }
.big { font-size: 34pt; letter-spacing: -.04em; line-height: 1; margin-bottom: 14mm; }
.toc { list-style: none; padding: 0; margin: 0; border-top: 1px solid var(--border); }
.toc li { display: flex; align-items: baseline; gap: 4mm; padding: 3.1mm 0; border-bottom: 1px solid var(--border); margin: 0; font-size: 11pt; }
.toc .k { width: 9mm; color: var(--accent); font-size: 8pt; font-weight: 600; font-variant-numeric: tabular-nums; }
.toc .t { font-weight: 500; letter-spacing: -.01em; }
.toc .dots { flex: 1; }
.toc .p { color: var(--text-2); font-variant-numeric: tabular-nums; font-size: 9pt; }
.links { position: absolute; left: 0; right: 0; bottom: 0; display: grid; grid-template-columns: repeat(3, 1fr); gap: 6mm; font-size: 8.5pt; }
.links span { display: block; color: var(--text-3); font-size: 7.4pt; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 1mm; }
"""


def build_html() -> str:
    body = [cover(), contents()]
    for i, (_title, _kicker, content) in enumerate(PAGES):
        n = i + FIRST_CONTENT_PAGE
        body.append(f'<section class="page"><div class="inner">{content}</div>{footer(n)}</section>')
    css = CSS.replace("__FONT__", uri(ROOT / "web" / "fonts" / "Inter.woff2"))
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>rslack guide v{VERSION}</title>'
            f"<style>{css}</style></head><body>{''.join(body)}</body></html>")


def find_chrome() -> str:
    for cand in [os.environ.get("CHROME"), "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]:
        if cand and shutil.which(cand):
            return shutil.which(cand)  # type: ignore[return-value]
    sys.exit("Chrome/Chromium not found; set CHROME=/path/to/chrome")


class Cdp:
    """Minimal Chrome DevTools Protocol client over --remote-debugging-pipe (stdlib only).

    Chrome's `--print-to-pdf` CLI flag hangs in some headless containers, and the
    protocol also lets us wait for web fonts before printing.
    """

    def __init__(self, chrome: str, profile: Path) -> None:
        r_chrome, w_ours = os.pipe()   # we write → chrome reads on fd 3
        r_ours, w_chrome = os.pipe()   # chrome writes on fd 4 → we read
        def setup() -> None:
            # Move both ends out of the way first so dup2 onto 3/4 can't clobber them.
            a = fcntl.fcntl(r_chrome, fcntl.F_DUPFD, 10)
            b = fcntl.fcntl(w_chrome, fcntl.F_DUPFD, 10)
            os.dup2(a, 3)
            os.dup2(b, 4)
        self.proc = subprocess.Popen(
            [chrome, "--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-pipe",
             "--no-first-run", "--no-default-browser-check", f"--user-data-dir={profile}", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=open(profile.parent / "chrome.log", "wb"), preexec_fn=setup, close_fds=False)
        os.close(r_chrome)
        os.close(w_chrome)
        self.w = os.fdopen(w_ours, "wb", buffering=0)
        self.r = os.fdopen(r_ours, "rb", buffering=0)
        self.buf = b""
        self.next_id = 0
        self.events: list[dict] = []

    def _read_msg(self) -> dict:
        while b"\0" not in self.buf:
            chunk = self.r.read(1 << 16)
            if not chunk:
                raise RuntimeError("chrome closed the DevTools pipe")
            self.buf += chunk
        raw, self.buf = self.buf.split(b"\0", 1)
        return json.loads(raw)

    def call(self, method: str, params: dict | None = None, session: str | None = None) -> dict:
        self.next_id += 1
        msg: dict = {"id": self.next_id, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        self.w.write(json.dumps(msg).encode() + b"\0")
        while True:
            m = self._read_msg()
            if m.get("id") == self.next_id:
                if "error" in m:
                    raise RuntimeError(f"{method}: {m['error']}")
                return m.get("result", {})
            self.events.append(m)

    def wait_event(self, name: str, timeout: float = 60) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if any(ev.get("method") == name for ev in self.events):
                return
            self.events.append(self._read_msg())
        raise TimeoutError(name)

    def close(self) -> None:
        try:
            self.call("Browser.close")
        except Exception:
            pass
        self.proc.wait(timeout=20)


def print_pdf(html_path: Path, out: Path, profile: Path) -> None:
    cdp = Cdp(find_chrome(), profile)
    try:
        target = cdp.call("Target.createTarget", {"url": "about:blank"})["targetId"]
        sid = cdp.call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
        cdp.call("Page.enable", session=sid)
        cdp.events.clear()
        cdp.call("Page.navigate", {"url": html_path.as_uri()}, session=sid)
        cdp.wait_event("Page.loadEventFired")
        cdp.call("Runtime.evaluate", {"expression": "document.fonts.ready.then(() => document.fonts.size)",
                                      "awaitPromise": True}, session=sid)
        res = cdp.call("Page.printToPDF", {"printBackground": True, "preferCSSPageSize": True,
                                           "displayHeaderFooter": False, "marginTop": 0, "marginBottom": 0,
                                           "marginLeft": 0, "marginRight": 0}, session=sid)
        out.write_bytes(base64.b64decode(res["data"]))
    finally:
        cdp.close()


def main() -> None:
    for need in [DOCS / "diagrams" / "architecture.svg", DOCS / "screenshots" / "03-main-light.png"]:
        if not need.exists():
            sys.exit(f"missing {need.relative_to(ROOT)}: run `npm run diagrams` / `npm run e2e` first")
    html_doc = build_html()
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "guide.html"
        src.write_text(html_doc, encoding="utf-8")
        if os.environ.get("KEEP_HTML"):
            (DOCS / "build").mkdir(exist_ok=True)
            shutil.copy(src, DOCS / "build" / "guide.html")
        print_pdf(src, OUT, Path(tmp) / "profile")
    pages = 2 + len(PAGES)
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB, {pages} pages expected)")


if __name__ == "__main__":
    main()
