// Usage: start rslack on :8099 with an empty data dir, then `npm i && node e2e.mjs`.
// Env: BASE (server URL), CHROME (browser binary), OUT (screenshot dir).
import { chromium } from 'playwright-core';
const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const OUT = process.env.OUT || new URL('../docs/screenshots', import.meta.url).pathname;
const PW = 'correct-horse-42';
const log = (...a) => console.log('[e2e]', ...a);
const errors = [];

const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const mk = async (theme) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: theme });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('401')) errors.push(`console: ${m.text()}`); });
  return page;
};
const A = await mk('light');
const B = await mk('dark');

async function signup(page, username, display, shot) {
  await page.goto(BASE);
  await page.click('#auth .tab[data-mode=signup]');
  await page.fill('#auth-form [name=username]', username);
  await page.fill('#auth-form [name=display_name]', display);
  await page.fill('#auth-form [name=password]', PW);
  if (shot) await page.screenshot({ path: `${OUT}/01-signup.png` });
  await page.click('#auth-submit');
  await page.waitForSelector('#onboard:not(.hidden)');
}

async function send(page, text, scope = '#composer-wrap') {
  const ta = page.locator(`${scope} textarea`);
  await ta.click();
  await ta.fill(text);
  await ta.press('Enter');
}

// 1. Sign up two users
await signup(A, 'alice', 'Alice Chen', true);
log('alice signed up');
await A.screenshot({ path: `${OUT}/02-onboarding.png` });
await A.fill('#onboard-create [name=name]', 'Acme Robotics');
await A.click('#onboard-create button');
await A.waitForSelector('#app:not(.hidden) #channel-list li.active');
const code = await A.evaluate(async () => (await (await fetch('/api/workspaces')).json())[0].invite_code);
log('workspace created, invite', code);

await signup(B, 'bob', 'Bob Martinez');
await B.fill('#onboard-join [name=invite_code]', code);
await B.click('#onboard-join button');
await B.waitForSelector('#app:not(.hidden) #channel-list li.active');
log('bob joined');

// 2. Alice creates #engineering via the modal
await A.click('#new-channel-btn');
await A.fill('#cc-form [name=name]', 'engineering');
await A.fill('#cc-form [name=topic]', 'Backend, infra and release planning');
await A.waitForTimeout(400);
await A.screenshot({ path: `${OUT}/07-create-channel.png` });
await A.click('#cc-form .btn.primary');
await A.waitForFunction(() => document.querySelector('#chan-name').textContent.includes('engineering'));
log('channel created');

// 3. Bob browses and joins
await B.click('#browse-btn');
await B.waitForSelector('#bc-list [data-join]');
await B.click('#bc-list li:has-text("engineering") [data-join]');
await B.waitForFunction(() => document.querySelector('#chan-name').textContent.includes('engineering'));
log('bob joined #engineering');

// 4. Exchange messages (realtime)
await send(A, 'Morning team! 👋 The **v0.1** release build is green on Linux, macOS and Windows.');
await B.waitForSelector('#messages .msg-body:has-text("release build is green")');
log('bob received alice message in realtime');
await send(B, 'Nice work @alice! Can you take a look at `src/realtime.rs` before we tag it?');
await A.waitForSelector('#messages .msg.mentions-me');
log('alice sees mention highlight');
await send(A, 'On it. Fan-out is just:\n```\nfor tx in conns.values() { let _ = tx.send(msg.clone()); }\n```');
await send(A, 'Checklist: _migrations_ ✔ ~flaky test~ fixed ✔ docs → https://github.com/shubhxho/rslack');

// attachment from Bob
await B.setInputFiles('#composer-wrap .file-input', new URL('./build-metrics.png', import.meta.url).pathname);
await B.waitForSelector('#composer-wrap .chip:not(.uploading)');
await send(B, 'Latency chart from the load test 📈');
await A.waitForSelector('#messages img.att-img');
log('image attachment delivered');

// 5. Thread: Bob replies to Alice's first message
const first = B.locator('#messages .msg', { hasText: 'release build is green' });
await first.hover();
await first.locator('[data-act=thread]').first().click();
await B.waitForSelector('#panel:not(.hidden) #panel-composer textarea');
await send(B, 'Let\'s tag it after lunch — I\'ll write the changelog.', '#panel-composer');
await A.waitForSelector('#messages .thread-link:has-text("1 reply")');
log('alice sees thread reply count');
await A.locator('#messages .thread-link').first().click();
await A.waitForSelector('#panel-body .msg-body:has-text("changelog")');
await send(A, 'Sounds good 🚀', '#panel-composer');
await B.waitForSelector('#panel-body .msg-body:has-text("Sounds good")');
log('thread reply realtime both ways');

// 6. Reactions
const bobMsg = A.locator('#messages .msg', { hasText: 'Can you take a look' });
await bobMsg.hover();
await bobMsg.locator('.msg-actions [data-act=quick][data-emoji="🎉"]').click();
await B.waitForSelector('#messages .msg:has-text("Can you take a look") .reaction:has-text("🎉")');
const aliceMsg = B.locator('#messages .msg', { hasText: 'release build is green' });
await aliceMsg.hover();
await aliceMsg.locator('.msg-actions [data-act=pick]').click();
await B.click('.popover .emoji-grid [data-e="🚀"]');
await A.waitForSelector('#messages .msg:has-text("release build is green") .reaction:has-text("🚀")');
await aliceMsg.hover();
await aliceMsg.locator('.msg-actions [data-act=quick][data-emoji="👍"]').click();
await A.waitForSelector('#messages .msg:has-text("release build is green") .reaction:has-text("👍")');
log('reactions synced');

// 7. Edit a message (Alice) and check Bob sees "(edited)"
const chk = A.locator('#messages .msg', { hasText: 'Checklist' });
await chk.hover();
await chk.locator('[data-act=edit]').click();
await A.fill('.edit-box textarea', 'Checklist: _migrations_ ✔ ~flaky test~ fixed ✔ docs → https://github.com/shubhxho/rslack (README done)');
await A.press('.edit-box textarea', 'Enter');
await B.waitForSelector('#messages .msg:has-text("README done") .edited');
log('edit synced');

// 8. Typing indicator: Bob types in main composer without sending
await B.click('#panel-close');
await B.locator('#composer-wrap textarea').click();
await B.keyboard.type('Also, should we add rate limiting', { delay: 15 });
await A.waitForSelector('#composer-wrap .typing:has-text("Bob Martinez is typing")');
log('typing indicator shown');
await A.mouse.move(5, 5);
await A.screenshot({ path: `${OUT}/03-main-light.png` });

await B.locator('#composer-wrap textarea').fill('');

// 9. DM + unread badge: Alice DMs Bob while Bob is in #general
await B.click('#channel-list li:has-text("general")');
await A.click('#new-dm-btn');
await A.click('#dm-people li:has-text("Bob Martinez")');
await A.waitForFunction(() => document.querySelector('#chan-name').textContent.includes('Bob'));
await send(A, 'Hey Bob, quick question about the deploy window — got a sec?');
await B.waitForSelector('#dm-list li.unread .badge');
await send(A, 'Also, coffee ☕ at 3?');
await A.click('#channel-list li:has-text("engineering")');
await B.waitForFunction(() => document.querySelector('#dm-list .badge')?.textContent === '2');
log('DM unread badge = 2 on bob');
await send(A, 'Heads up @bob: staging gets wiped at 5pm.');
await B.waitForSelector('#channel-list li:has-text("engineering") .badge');
await B.mouse.move(5, 5);
await B.screenshot({ path: `${OUT}/08-unread-dark.png` });

// 10. Bob opens DM: badge clears
await B.click('#dm-list li:has-text("Alice")');
await B.waitForSelector('#messages .msg-body:has-text("coffee")');
await B.waitForFunction(() => !document.querySelector('#dm-list li.active .badge'));
log('unread cleared on open');
await send(B, 'Sure — and yes to coffee ☕');

// 11. Bob opens #engineering with thread + dark screenshot of main view
await B.click('#channel-list li:has-text("engineering")');
await B.waitForSelector('#messages .thread-link');
await B.locator('#messages .thread-link').first().click();
await B.waitForSelector('#panel-body .msg-body:has-text("Sounds good")');
await B.mouse.move(5, 5);
await B.screenshot({ path: `${OUT}/04-main-dark.png` });
const pb = await B.locator('#panel').boundingBox();
await B.screenshot({ path: `${OUT}/05-thread-dark.png`, clip: { x: pb.x, y: 0, width: pb.width, height: 900 } });

// 12. Search
await A.fill('#search-input', 'tag');
await A.press('#search-input', 'Enter');
await A.waitForSelector('#panel-body .search-result mark');
const nResults = await A.locator('#panel-body .search-result').count();
log('search results', nResults);
await A.mouse.move(5, 5);
await A.screenshot({ path: `${OUT}/06-search.png` });

// 13. Presence: Bob goes offline -> Alice's DM dot turns grey
const onlineBefore = await A.locator('#dm-list [data-presence].online').count();
if (onlineBefore < 1) throw new Error('expected bob to show online in alice DM list');
await B.context().close();
await A.waitForFunction(() => document.querySelectorAll('#dm-list [data-presence].online').length === 0, null, { timeout: 5000 });
log(`presence: online dots before=${onlineBefore}, after bob closed=0`);

// 14. Persistence: reload Alice, messages still there
await A.reload();
await A.waitForSelector('#messages .msg-body:has-text("staging gets wiped")');
log('persisted across reload');

await browser.close();
if (errors.length) { console.log('BROWSER ERRORS:\n' + errors.join('\n')); process.exit(1); }
log('ALL OK');
