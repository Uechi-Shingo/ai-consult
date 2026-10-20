// ChatGPT のプランでのサインイン（4 つ目の提供元）の通し確認。
// 出荷するままの manifest（権限は最小）で、実際のブラウザ（画面付き・一時プロファイル）に読み込み、
// OpenAI の代わりに、手元の偽サーバー（認可・トークン・API）を使って、次を確かめる。
//   設定画面でのサインイン → 戻り先の検知 → トークンの保存 → モデル一覧 → パネルでの質問
//   トークンの更新（同時に呼んでも 1 回）・更新できないときの再サインイン・利用枠の上限・サインアウト
// 本物の OpenAI へは通信しません。
//
// 実行: node tests/e2e-chatgpt.mjs "<ブラウザの exe のパス>"
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const browserPath = process.argv[2];
const extDir = path.resolve(path.join(here, '..', 'extension'));
if (!browserPath) {
  console.error('使い方: node tests/e2e-chatgpt.mjs "<ブラウザの exe のパス>"');
  process.exit(2);
}

// 1455 番に、すでに何かが待ち受けていると、この確認は成り立たない（Codex のログイン中など）
const portBusy = await new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port: 1455 });
  s.on('connect', () => {
    s.destroy();
    resolve(true);
  });
  s.on('error', () => resolve(false));
});
if (portBusy) {
  console.error('127.0.0.1:1455 で、すでに何かが待ち受けています。それを止めてから、もう一度実行してください。');
  process.exit(2);
}

// ---------------------------------------------------------------- 偽サーバー

const ISSUED_CLIENT = 'oaiapp_test_client';
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const mock = {
  mode: 'ok', // 認可: ok | deny
  refreshMode: 'ok', // 更新: ok | invalid_grant | terminal（refresh_token_expired）
  responsesMode: 'ok', // 質問: ok | limit | unauthorized（常に 401）
  unauthorizedOnce: false, // 次の質問だけ 401 を返す
  authorize: [],
  tokens: [], // トークンのリクエスト（フォーム）
  api: [], // API への依頼
  nonce: '',
  counter: 0,
};

const readBody = (req) =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  // 拡張機能は、この偽サーバーへのホスト権限を持たないので、CORS で通信を許す（ページの移動には不要）
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, accept',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  const json = (status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify(obj));
  };

  if (url.pathname === '/a') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>テストページA</title><body><main><p>これはページAの本文です。</p></main></body>');
    return;
  }

  if (url.pathname === '/api/accounts/authorize') {
    const q = Object.fromEntries(url.searchParams);
    mock.authorize.push(q);
    mock.nonce = q.nonce;
    const cb = new URL(q.redirect_uri);
    cb.searchParams.set('state', q.state);
    if (mock.mode === 'deny') {
      cb.searchParams.set('error', 'access_denied');
    } else {
      cb.searchParams.set('code', `CODE_TEST_${mock.authorize.length}`);
      cb.searchParams.set('client_id', ISSUED_CLIENT);
      cb.searchParams.set('scope', 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke');
    }
    res.writeHead(302, { location: cb.toString() });
    res.end();
    return;
  }

  if (url.pathname === '/api/accounts/oauth/token') {
    const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
    mock.tokens.push(form);
    if (form.grant_type === 'refresh_token' && mock.refreshMode !== 'ok') {
      const code = mock.refreshMode === 'terminal' ? 'refresh_token_expired' : 'invalid_grant';
      json(400, { error: code, error_description: 'refresh token expired' });
      return;
    }
    mock.counter += 1;
    const n = mock.counter;
    const now = Math.floor(Date.now() / 1000);
    const payload = { iss: 'https://auth.openai.com', aud: ISSUED_CLIENT, sub: 'user_test', email: 'mock@example.com', nonce: mock.nonce, iat: now, exp: now + 3600 };
    json(200, {
      token_type: 'Bearer',
      access_token: `ACCESS_TEST_${n}`,
      refresh_token: `REFRESH_TEST_${n}`,
      id_token: `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify(payload))}.sig`,
      expires_in: 3600,
      scope: 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke',
    });
    return;
  }

  if (url.pathname === '/v1/models') {
    mock.api.push({ url: req.url, method: req.method, headers: req.headers, body: null });
    json(200, {
      models: [
        { slug: 'gpt-test-sol', display_name: 'GPT Test Sol', visibility: 'list' },
        { slug: 'gpt-test-hidden', display_name: 'Hidden', visibility: 'hide' },
        { slug: 'gpt-test-luna', display_name: 'GPT Test Luna', visibility: 'list' },
      ],
    });
    return;
  }

  if (url.pathname === '/v1/responses') {
    const body = JSON.parse((await readBody(req)) || 'null');
    mock.api.push({ url: req.url, method: req.method, headers: req.headers, body });
    if (mock.responsesMode === 'unauthorized' || mock.unauthorizedOnce) {
      mock.unauthorizedOnce = false;
      json(401, { error: { message: 'token revoked or expired' } });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', ...cors });
    const ev = (type, extra) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
    if (mock.responsesMode === 'limit') {
      res.end(ev('response.failed', { response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } }));
      return;
    }
    res.write(ev('response.output_text.delta', { delta: 'ChatGPT' }));
    res.write(ev('response.output_text.delta', { delta: 'プランの回答です' }));
    res.end(ev('response.completed', { response: {} }));
    return;
  }

  res.writeHead(404);
  res.end('not found');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const mockBase = `http://127.0.0.1:${server.address().port}`;

// ---------------------------------------------------------------- 接続先だけを偽サーバーに向けた、拡張機能のコピー（権限は、出荷するまま）

const extCopy = mkdtempSync(path.join(os.tmpdir(), 'ai-consult-chatgpt-ext-'));
cpSync(extDir, extCopy, { recursive: true });
const providerPath = path.join(extCopy, 'providers', 'chatgpt.js');
let providerSrc = readFileSync(providerPath, 'utf8');
const swap = (from, to) => {
  if (!providerSrc.includes(from)) throw new Error(`書き換え対象が見つかりません: ${from}`);
  providerSrc = providerSrc.replace(from, to);
};
swap("export const AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';", `export const AUTHORIZE_URL = '${mockBase}/api/accounts/authorize';`);
swap("export const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';", `export const TOKEN_URL = '${mockBase}/api/accounts/oauth/token';`);
swap("export const API_BASE = 'https://api.openai.com/v1';", `export const API_BASE = '${mockBase}/v1';`);
writeFileSync(providerPath, providerSrc);
const manifestPath = path.join(extCopy, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages.replace('connect-src ', `connect-src ${mockBase} `);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

// ---------------------------------------------------------------- ブラウザの起動と CDP

const profile = mkdtempSync(path.join(os.tmpdir(), 'ai-consult-chatgpt-profile-'));
const child = spawn(
  browserPath,
  [
    `--user-data-dir=${profile}`,
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1200,800',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
);

let nextId = 1;
const pending = new Map();
let buffer = '';
child.stdio[4].on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let i;
  while ((i = buffer.indexOf('\0')) >= 0) {
    const raw = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!raw) continue;
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
    }
  }
});
function cdp(method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`タイムアウト: ${method}`));
    }, 30000);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function evaluate(sessionId, expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(fn, timeoutMs = 10000, stepMs = 150) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch {
      v = null;
    }
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(stepMs);
  }
}
const allTargets = async () => (await cdp('Target.getTargets')).targetInfos;
const findTarget = async (pred) => (await allTargets()).find(pred);
async function attach(targetId) {
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  await cdp('Runtime.enable', {}, sessionId);
  return sessionId;
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'ok' : 'NG'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
}

async function main() {
  const version = await cdp('Browser.getVersion');
  console.log(`ブラウザ: ${version.product}\n偽サーバー: ${mockBase}\n`);

  let extId;
  try {
    ({ id: extId } = await cdp('Extensions.loadUnpacked', { path: extCopy }));
  } catch (e) {
    check('拡張機能を読み込めた（出荷するままの権限・CSP）', false, e.message);
    return;
  }
  check('拡張機能を読み込めた（出荷するままの権限・CSP）', !!extId, `ID: ${extId}`);

  const sw = await waitFor(() => findTarget((t) => t.type === 'service_worker' && t.url.includes(extId)), 15000);
  const swS = await attach(sw.targetId);
  const localGet = (key) => evaluate(swS, `chrome.storage.local.get(${JSON.stringify(key)})`);
  const sessionGet = (key) => evaluate(swS, `chrome.storage.session.get(${JSON.stringify(key)})`);

  // ---- 設定画面
  const { targetId: optTarget } = await cdp('Target.createTarget', { url: `chrome-extension://${extId}/options.html` });
  const opt = await attach(optTarget);
  const O = (expr) => evaluate(opt, expr);
  await waitFor(() => O(`document.querySelectorAll('.provider').length === 4 && !document.getElementById('default-provider').disabled !== undefined`));
  await sleep(300);
  const card = (rest) => `document.querySelector('.provider[data-id="chatgpt"] ${rest}')`;
  const stateLine = () => O(`${card('.status.state')}.textContent`);
  const save = async () => {
    await O(`document.getElementById('save').click()`);
    await sleep(600);
  };

  check('設定画面に「ChatGPT のプラン（サインイン）」があり、最初は未サインイン', (await stateLine()).includes('サインインしていません'), await stateLine());

  // 注意事項を確認する（質問を送るために必要）
  await O(`(() => { const c = document.getElementById('ack'); c.checked = true; c.dispatchEvent(new Event('change')); })()`);
  await save();

  // ---- サインイン（戻り先の検知まで）
  await O(`${card('.signin')}.click()`);
  const signedIn = await waitFor(async () => (await stateLine()).includes('サインイン済み'), 20000);
  const a1 = mock.authorize[0] || {};
  check('認可の依頼: 初回の登録の形・PKCE（S256）・state・nonce・戻り先・権限・resource',
    a1.client_id === 'dynamic_agent_client' && a1.response_type === 'code' && a1.redirect_uri === 'http://127.0.0.1:1455/auth/callback' &&
      a1.scope === 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' && a1.resource === 'https://api.openai.com/v1' &&
      a1.code_challenge_method === 'S256' && /^[A-Za-z0-9_-]{43}$/.test(a1.code_challenge || '') && /^urn:uuid:/.test(a1.ext_agent_host_id || '') &&
      !!a1.agent_name_hint && !!a1.state && !!a1.nonce,
    JSON.stringify(a1));
  check('待ち受けのない 127.0.0.1:1455 への移動を、webRequest だけで検知して、サインインできた（出荷するままの権限）', !!signedIn, await stateLine());
  const stateText = await stateLine();
  check('サインイン済みの表示に、アカウントが出る', stateText.includes('mock@example.com') && !stateText.includes('利用枠の権限がありません'), stateText);

  const t1 = mock.tokens[0] || {};
  const pkceOk = createHash('sha256').update(t1.code_verifier || '').digest('base64url') === a1.code_challenge;
  check('トークンの交換: フォームの項目が正しく、PKCE の検証子が challenge と一致',
    t1.grant_type === 'authorization_code' && t1.client_id === ISSUED_CLIENT && t1.code === 'CODE_TEST_1' &&
      t1.redirect_uri === 'http://127.0.0.1:1455/auth/callback' && t1.resource === 'https://api.openai.com/v1' && pkceOk,
    JSON.stringify(t1));

  const leftover = (await allTargets()).filter((t) => t.url.includes(':1455') || t.url.startsWith('chrome-error://'));
  check('ログイン用のタブは、検知後に閉じられ、「接続できません」の画面が残らない', leftover.length === 0, JSON.stringify(leftover.map((t) => t.url)));

  const models = await waitFor(async () => {
    const opts = await O(`[...${card('.model')}.options].map((o) => o.value)`);
    return opts.length ? opts : null;
  });
  const modelSel = await O(`${card('.model')}.value`);
  check('サインインできたら、モデル一覧（表示用のみ）が取得され、先頭のモデルが選ばれる',
    JSON.stringify(models) === JSON.stringify(['gpt-test-sol', 'gpt-test-luna']) && modelSel === 'gpt-test-sol', `${JSON.stringify(models)} / ${modelSel}`);

  const stored = (await localGet('chatgptAuth')).chatgptAuth;
  check('トークンは裏方の保存領域に保存され、設定画面の表示には出ない',
    stored?.accessToken === 'ACCESS_TEST_1' && stored.refreshToken === 'REFRESH_TEST_1' &&
      !(await O('document.body.innerText')).includes('ACCESS_TEST_1') && !(await O('document.body.innerText')).includes('REFRESH_TEST_1'),
    JSON.stringify(Object.keys(stored || {})));

  // ---- 使う提供元を ChatGPT にして、パネルを開く
  await O(`(() => { const s = document.getElementById('default-provider'); s.value = 'chatgpt'; s.dispatchEvent(new Event('change')); })()`);
  await save();

  const windowId = await O(`chrome.windows.getCurrent().then((w) => w.id)`);
  await O(`(() => {
    const b = document.createElement('button');
    b.id = '__open_panel';
    b.textContent = 'open';
    b.style.position = 'fixed';
    b.style.top = '0';
    b.style.left = '0';
    b.style.width = '120px';
    b.style.height = '40px';
    b.style.zIndex = '99999';
    b.addEventListener('click', () => {
      chrome.sidePanel.open({ windowId: ${windowId} }).then(() => { window.__opened = true; }, (e) => { window.__opened = 'error: ' + e.message; });
    });
    document.body.append(b);
  })()`);
  const rect = await O(`(() => { const r = document.getElementById('__open_panel').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await cdp('Target.activateTarget', { targetId: optTarget });
  await sleep(300);
  const mouse = { x: rect.x, y: rect.y, button: 'left', clickCount: 1 };
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...mouse }, opt);
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...mouse }, opt);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...mouse }, opt);
  const panelT = await waitFor(() => findTarget((t) => t.url.includes(`${extId}/sidepanel.html`)), 8000);
  if (!panelT) {
    check('サイドパネルを開けた', false, String(await O('window.__opened')));
    return;
  }
  const panel = await attach(panelT.targetId);
  const P = (expr) => evaluate(panel, expr);
  const text = (sel) => P(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ''`);
  await waitFor(async () => (await P(`document.getElementById('provider').value`)) === 'chatgpt');
  const providerLabels = await P(`[...document.getElementById('provider').options].map((o) => o.value + ':' + o.textContent)`);
  check('パネルの提供元に「ChatGPT プラン」が並び、選ばれている',
    (await P(`document.getElementById('provider').value`)) === 'chatgpt' && providerLabels.some((l) => l.startsWith('chatgpt:ChatGPT')) &&
      (await P(`document.getElementById('model').value`)) === 'gpt-test-sol',
    JSON.stringify(providerLabels));

  const tabA = await cdp('Target.createTarget', { url: `${mockBase}/a` });
  await cdp('Target.activateTarget', { targetId: tabA.targetId });
  await waitFor(async () => !(await P(`document.getElementById('permission').hidden`)), 10000);

  const ask = (q) => P(`(() => { document.getElementById('input').value = ${JSON.stringify(q)}; document.getElementById('send').click(); })()`);
  const idle = () => waitFor(() => P(`document.getElementById('stop').hidden`), 10000);
  const lastResponses = () => mock.api.filter((r) => r.url.startsWith('/v1/responses')).pop();

  // ---- 質問
  await ask('この記事の要点は？');
  const answered = await waitFor(async () => (await text('#messages .msg.assistant .body')).includes('ChatGPTプランの回答です'), 10000);
  await idle();
  const r1 = lastResponses();
  check('パネルで質問すると、回答が表示される', !!answered, await text('#messages'));
  check('質問の依頼: Bearer・store が false・stream が true・選んだモデル・システム指示・質問',
    r1?.headers.authorization === 'Bearer ACCESS_TEST_1' && r1.body.store === false && r1.body.stream === true && r1.body.model === 'gpt-test-sol' &&
      String(r1.body.instructions || '').includes('信用できないデータ') && JSON.stringify(r1.body.input).includes('この記事の要点は？'),
    JSON.stringify(r1?.body).slice(0, 300));

  // ---- 「保存しておく」をオフにすると、トークンもセッション側へ移る
  await O(`(() => { const c = document.getElementById('remember'); c.checked = false; c.dispatchEvent(new Event('change')); })()`);
  await save();
  const moved = { local: (await localGet('chatgptAuth')).chatgptAuth, session: (await sessionGet('chatgptAuth')).chatgptAuth };
  check('「保存しておく」をオフにすると、ChatGPT のトークンも、ディスクの保存領域から消えてセッション側に移る',
    !moved.local && moved.session?.accessToken === 'ACCESS_TEST_1', JSON.stringify({ local: !!moved.local, session: !!moved.session }));
  await O(`(() => { const c = document.getElementById('remember'); c.checked = true; c.dispatchEvent(new Event('change')); })()`);
  await save();

  // ---- トークンの更新: 期限が近いとき、同時に使っても、更新は 1 回だけ
  await evaluate(swS, `(async () => {
    const { chatgptAuth } = await chrome.storage.local.get('chatgptAuth');
    chatgptAuth.expiresAt = Date.now() + 5000;
    await chrome.storage.local.set({ chatgptAuth });
    return true;
  })()`);
  const before = mock.tokens.length;
  const both = await O(`Promise.all([
    chrome.runtime.sendMessage({ type: 'refresh-models', provider: 'chatgpt' }),
    chrome.runtime.sendMessage({ type: 'refresh-models', provider: 'chatgpt' }),
    chrome.runtime.sendMessage({ type: 'refresh-models', provider: 'chatgpt' }),
  ]).then((rs) => rs.map((r) => r.ok))`);
  const refreshes = mock.tokens.slice(before);
  check('トークンの期限が近いと、使う前に更新される。同時に 3 回使っても、更新は 1 回だけ（リフレッシュトークンが無効にならない）',
    both.every(Boolean) && refreshes.length === 1 && refreshes[0].grant_type === 'refresh_token' && refreshes[0].refresh_token === 'REFRESH_TEST_1' &&
      refreshes[0].client_id === ISSUED_CLIENT && refreshes[0].resource === 'https://api.openai.com/v1',
    JSON.stringify({ both, refreshes }));
  const afterRefresh = (await localGet('chatgptAuth')).chatgptAuth;
  check('更新後は、新しいアクセストークンとリフレッシュトークンに入れ替わる',
    afterRefresh?.accessToken === 'ACCESS_TEST_2' && afterRefresh.refreshToken === 'REFRESH_TEST_2', JSON.stringify(afterRefresh && Object.keys(afterRefresh)));

  await ask('更新後の質問');
  await waitFor(async () => (await P(`document.querySelectorAll('#messages .msg.assistant').length`)) === 2, 10000);
  await idle();
  check('更新後の質問には、新しいアクセストークンが使われる', lastResponses()?.headers.authorization === 'Bearer ACCESS_TEST_2', lastResponses()?.headers.authorization);

  // ---- サーバーが、手元では有効なはずのトークンを 401 で断ったら、1 度だけ更新して、同じ質問をやり直す
  const tokensBefore401 = mock.tokens.length;
  const responsesBefore401 = mock.api.filter((r) => r.url.startsWith('/v1/responses')).length;
  mock.unauthorizedOnce = true;
  await ask('401 のテスト');
  await waitFor(async () => (await P(`document.querySelectorAll('#messages .msg.assistant').length`)) === 3, 10000);
  await idle();
  const after401 = mock.api.filter((r) => r.url.startsWith('/v1/responses'));
  const newRefresh = mock.tokens.slice(tokensBefore401);
  check('401 のときは、1 度だけトークンを更新して、同じ質問をやり直し、回答が表示される',
    after401.length - responsesBefore401 === 2 && newRefresh.length === 1 && newRefresh[0].grant_type === 'refresh_token' &&
      lastResponses()?.headers.authorization === 'Bearer ACCESS_TEST_3' && (await text('#messages .msg.assistant:last-child .body')).includes('ChatGPTプランの回答です'),
    JSON.stringify({ responses: after401.length - responsesBefore401, refreshes: newRefresh.length, auth: lastResponses()?.headers.authorization }));

  // ---- 利用枠の上限
  mock.responsesMode = 'limit';
  await ask('上限のテスト');
  const limited = await waitFor(async () => (await text('#messages .extra.error')).includes('利用枠'), 10000);
  check('プランの利用枠の上限に達したときは、そのことが分かる言葉で表示される', !!limited, await text('#messages .extra.error'));
  mock.responsesMode = 'ok';
  await idle();

  // ---- 更新できなくなったら、サインイン済みの表示が消え、再サインインを案内する。再サインインでは、登録を引き継ぐ。
  await evaluate(swS, `(async () => {
    const { chatgptAuth } = await chrome.storage.local.get('chatgptAuth');
    chatgptAuth.expiresAt = Date.now() + 5000;
    await chrome.storage.local.set({ chatgptAuth });
    return true;
  })()`);
  mock.refreshMode = 'terminal'; // refresh_token_expired（公式が「使えないリフレッシュトークン」とするコードの 1 つ）
  await P(`document.getElementById('new-chat').click()`);
  await ask('期限切れのテスト');
  const expired = await waitFor(async () => (await text('#messages .extra.error')).includes('サインイン'), 10000);
  const signedOutNow = await waitFor(async () => (await stateLine()).includes('サインインしていません'), 8000);
  check('更新できない（refresh_token_expired）とき、サインインし直すよう案内し、サインイン済みの状態を解く',
    !!expired && !!signedOutNow && !(await localGet('chatgptAuth')).chatgptAuth, `${await text('#messages .extra.error')} / ${await stateLine()}`);
  mock.refreshMode = 'ok';

  await O(`${card('.signin')}.click()`);
  const again = await waitFor(async () => (await stateLine()).includes('サインイン済み'), 20000);
  const a2 = mock.authorize[mock.authorize.length - 1] || {};
  check('再サインインでは、発行された client_id を再利用し、アプリ名は送らず、login_hint でアカウントを示す',
    !!again && a2.client_id === ISSUED_CLIENT && a2.agent_name_hint === undefined && a2.login_hint === 'mock@example.com' && a2.ext_agent_host_id === a1.ext_agent_host_id,
    JSON.stringify(a2));

  // ---- ChatGPT 側で接続を解除された場合（401 で、更新も断られる）: サインインし直しを案内し、状態を解く
  mock.responsesMode = 'unauthorized';
  mock.refreshMode = 'terminal';
  await P(`document.getElementById('new-chat').click()`);
  await ask('接続を解除されたときのテスト');
  const revoked = await waitFor(async () => (await text('#messages .extra.error')).includes('サインイン'), 10000);
  const clearedAfter401 = await waitFor(async () => (await stateLine()).includes('サインインしていません'), 8000);
  check('サーバーに 401 で断られ、更新も断られたら、サインインし直すよう案内し、サインイン済みの状態を解く',
    !!revoked && !!clearedAfter401 && !(await localGet('chatgptAuth')).chatgptAuth, `${await text('#messages .extra.error')} / ${await stateLine()}`);
  mock.responsesMode = 'ok';
  mock.refreshMode = 'ok';
  await O(`${card('.signin')}.click()`);
  await waitFor(async () => (await stateLine()).includes('サインイン済み'), 20000);

  // ---- 拒否
  await O(`${card('.signout')}.click()`);
  await waitFor(async () => (await stateLine()).includes('サインインしていません'), 8000);
  const afterOut = { auth: (await localGet('chatgptAuth')).chatgptAuth, reg: (await localGet('chatgptReg')).chatgptReg };
  check('サインアウトすると、トークンと登録（client_id・アカウント）が消える（ホスト ID だけ残る）',
    !afterOut.auth && !afterOut.reg?.clientId && !afterOut.reg?.email && /^urn:uuid:/.test(afterOut.reg?.hostId || ''), JSON.stringify(afterOut));
  const providerGone = await waitFor(async () => !(await P(`[...document.getElementById('provider').options].some((o) => o.value === 'chatgpt')`)), 8000);
  check('サインアウトすると、パネルの提供元から「ChatGPT プラン」が消える', !!providerGone);

  mock.mode = 'deny';
  const tokensBefore = mock.tokens.length;
  await O(`${card('.signin')}.click()`);
  const denied = await waitFor(async () => (await stateLine()).includes('拒否'), 15000);
  check('承認が拒否されたら、トークンを取りに行かず、そのことを表示する（待ち受けも終わる）',
    !!denied && mock.tokens.length === tokensBefore && (await O(`!${card('.signin')}.disabled`)), `${await stateLine()} / ${mock.tokens.length - tokensBefore}`);
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  console.error('\n実行中にエラー:', e.stack || e.message);
} finally {
  try {
    await cdp('Browser.close');
  } catch { /* 終了処理 */ }
  await sleep(500);
  child.kill();
  server.close();
  await sleep(500);
  for (const dir of [profile, extCopy]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch { /* 一時フォルダの削除に失敗しても無視 */ }
  }
}

const ng = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - ng} / ${results.length} 件成功`);
process.exit(failed || ng ? 1 : 0);
