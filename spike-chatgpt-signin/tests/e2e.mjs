// 試作の自動確認。OpenAI の代わりに、手元の偽サーバー（認可・トークン・API）を使い、
// 実際の Chromium 系ブラウザ（画面付き・一時プロファイル）で、次を確かめる。
//   ・認可のリクエストの形（PKCE・state・nonce・ホスト ID など）が、公式の仕様どおりか
//   ・待ち受けのない http://127.0.0.1:1455/auth/callback への移動を、拡張機能が検知して code を取り出せるか
//   ・code → トークンの交換、更新、モデル一覧、質問（store:false / stream:true）
// 本物の OpenAI へは通信しません（ログインと承認は、利用者が手動で行う）。
//
// 実行: node tests/e2e.mjs "<ブラウザの exe のパス>"
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
  console.error('使い方: node tests/e2e.mjs "<ブラウザの exe のパス>"');
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

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const mock = {
  mode: 'ok', // ok | deny | badstate
  authorize: [], // 受け取った認可リクエストのクエリ
  tokens: [], // 受け取ったトークンのリクエスト（フォーム）
  api: [], // API への依頼（URL・ヘッダー・本文）
  challenge: '',
  nonce: '',
  counter: 0,
};
const ISSUED_CLIENT = 'oaiapp_test_client';

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const json = (status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (url.pathname === '/api/accounts/authorize') {
    const q = Object.fromEntries(url.searchParams);
    mock.authorize.push(q);
    mock.challenge = q.code_challenge;
    mock.nonce = q.nonce;
    const cb = new URL(q.redirect_uri);
    if (mock.mode === 'deny') {
      cb.searchParams.set('error', 'access_denied');
      cb.searchParams.set('state', q.state);
    } else {
      cb.searchParams.set('code', `CODE_TEST_${mock.authorize.length}`);
      cb.searchParams.set('state', mock.mode === 'badstate' ? 'WRONG_STATE' : q.state);
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
    mock.counter += 1;
    const n = mock.counter;
    const idPayload = {
      iss: 'https://auth.openai.com',
      aud: ISSUED_CLIENT,
      sub: 'user_test',
      email: 'tester@example.com',
      nonce: mock.nonce,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const idToken = `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify(idPayload))}.sig`;
    json(200, {
      token_type: 'Bearer',
      access_token: `ACCESS_TEST_${n}`,
      refresh_token: `REFRESH_TEST_${n}`,
      id_token: idToken,
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
      ],
    });
    return;
  }

  if (url.pathname === '/v1/responses') {
    const body = JSON.parse((await readBody(req)) || 'null');
    mock.api.push({ url: req.url, method: req.method, headers: req.headers, body });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (type, extra) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
    res.write(ev('response.output_text.delta', { delta: '2' }));
    res.write(ev('response.output_text.delta', { delta: 'です' }));
    res.end(ev('response.completed', { response: {} }));
    return;
  }

  res.writeHead(404);
  res.end('not found');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const mockBase = `http://127.0.0.1:${server.address().port}`;

// ---------------------------------------------------------------- 接続先を偽サーバーに向けた拡張機能のコピー

const extCopy = mkdtempSync(path.join(os.tmpdir(), 'siwc-spike-ext-'));
cpSync(extDir, extCopy, { recursive: true });
const cfgPath = path.join(extCopy, 'config.js');
let cfg = readFileSync(cfgPath, 'utf8');
cfg = cfg
  .replace('https://auth.openai.com/api/accounts/authorize', `${mockBase}/api/accounts/authorize`)
  .replace('https://auth.openai.com/api/accounts/oauth/token', `${mockBase}/api/accounts/oauth/token`)
  .replace("export const API_BASE = 'https://api.openai.com/v1';", `export const API_BASE = '${mockBase}/v1';`);
writeFileSync(cfgPath, cfg);
const manifestPath = path.join(extCopy, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.content_security_policy.extension_pages = manifest.content_security_policy.extension_pages.replace(
  'connect-src ',
  `connect-src ${mockBase} `,
);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

// ---------------------------------------------------------------- ブラウザの起動と CDP

const profile = mkdtempSync(path.join(os.tmpdir(), 'siwc-spike-profile-'));
const child = spawn(
  browserPath,
  [
    `--user-data-dir=${profile}`,
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1100,800',
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

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'ok' : 'NG'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
}
const info = (name, detail) => console.log(`  --  ${name}\n        ${detail}`);

async function main() {
  const version = await cdp('Browser.getVersion');
  console.log(`ブラウザ: ${version.product}\n偽サーバー: ${mockBase}\n`);

  const { id: extId } = await cdp('Extensions.loadUnpacked', { path: extCopy });
  check('拡張機能を読み込めた', !!extId, `ID: ${extId}`);
  const { targetId } = await cdp('Target.createTarget', { url: `chrome-extension://${extId}/spike.html` });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  await cdp('Runtime.enable', {}, sessionId);
  const E = (expr) => evaluate(sessionId, expr);
  await waitFor(() => E(`document.getElementById('start') && !document.getElementById('start').disabled`));
  const text = (id) => E(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const click = (id) => E(`document.getElementById(${JSON.stringify(id)}).click()`);

  // ---- 1. 初回のサインイン（登録つき）
  await click('start');
  const got = await waitFor(async () => (await text('token')).includes('取得できました'), 20000);
  const a1 = mock.authorize[0] || {};
  const expectedScope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
  check('認可の依頼: 初回の登録の形（dynamic_agent_client・ホスト ID・アプリ名）',
    a1.client_id === 'dynamic_agent_client' && a1.response_type === 'code' && /^urn:uuid:[0-9a-f-]{36}$/.test(a1.ext_agent_host_id || '') &&
      !!a1.agent_name_hint && a1.login_hint === undefined,
    JSON.stringify(a1));
  check('認可の依頼: 戻り先・権限・resource・PKCE（S256）・state・nonce',
    a1.redirect_uri === 'http://127.0.0.1:1455/auth/callback' && a1.scope === expectedScope && a1.resource === 'https://api.openai.com/v1' &&
      a1.code_challenge_method === 'S256' && /^[A-Za-z0-9_-]{43}$/.test(a1.code_challenge || '') &&
      (a1.state || '').length >= 43 && (a1.nonce || '').length >= 43 && a1.state !== a1.nonce,
    JSON.stringify(a1));

  check('待ち受けのない 127.0.0.1:1455 への移動を検知して、トークンを取得できた', !!got, await text('log'));
  const detected = await E(`[...document.querySelectorAll('#detections li')].map((li) => li.textContent)`);
  info('戻り先を検知できた方法', detected.join(' | '));
  check('少なくとも 1 つの方法で、戻り先を検知できた', detected.some((d) => d.startsWith('✓')), detected.join(' | '));

  const t1 = mock.tokens[0] || {};
  const challengeOk = createHash('sha256').update(t1.code_verifier || '').digest('base64url') === a1.code_challenge;
  check('トークンの交換: フォームの項目と、PKCE の検証子が、認可の依頼の challenge と一致',
    t1.grant_type === 'authorization_code' && t1.client_id === ISSUED_CLIENT && t1.code === 'CODE_TEST_1' &&
      t1.redirect_uri === 'http://127.0.0.1:1455/auth/callback' && t1.resource === 'https://api.openai.com/v1' && challengeOk,
    JSON.stringify(t1));

  const tokenView = await text('token');
  check('画面に、権限・有効期限・アカウントが出て、トークンは伏せ字になっている',
    tokenView.includes('chatgpt.tokens.use.direct') && tokenView.includes('付与されています') && tokenView.includes('tester@example.com') &&
      !tokenView.includes('ACCESS_TEST_1') && tokenView.includes('文字）'),
    tokenView);

  const leftover = (await allTargets()).filter((t) => t.url.includes(':1455') || t.url.startsWith('chrome-error://'));
  check('ログイン用のタブは、検知後に閉じられ、「接続できません」の画面が残らない', leftover.length === 0, JSON.stringify(leftover.map((t) => t.url)));

  // ---- 2. モデル一覧・質問
  await click('models');
  await waitFor(async () => (await text('model-list')).includes('gpt-test-sol'));
  const modelsText = await text('model-list');
  check('モデル一覧を取得できる（visibility が list のものだけ）', modelsText.includes('gpt-test-sol') && !modelsText.includes('Hidden'), modelsText);
  const mReq = mock.api.find((r) => r.url.startsWith('/v1/models'));
  check('モデル一覧の依頼に、アクセストークンの Bearer が付く', mReq?.headers.authorization === 'Bearer ACCESS_TEST_1', JSON.stringify(mReq?.headers));

  await click('chat');
  const answered = await waitFor(async () => (await text('chat-status')).includes('完了しました'), 10000);
  const cReq = mock.api.find((r) => r.url.startsWith('/v1/responses'));
  check('質問を送ると、回答が届き、response.completed を確認できる', !!answered && (await text('answer')).includes('2です'), `${await text('chat-status')} / ${await text('answer')}`);
  check('質問の依頼: store が false、stream が true、モデルは一覧の slug、Bearer 付き',
    cReq?.body?.store === false && cReq.body.stream === true && cReq.body.model === 'gpt-test-sol' &&
      cReq.headers.authorization === 'Bearer ACCESS_TEST_1' && Array.isArray(cReq.body.input),
    JSON.stringify(cReq?.body));

  // ---- 3. 更新（リフレッシュトークン）
  await click('refresh');
  await waitFor(() => mock.tokens.length >= 2, 10000);
  await sleep(500);
  const t2 = mock.tokens[1] || {};
  check('トークンの更新: grant_type=refresh_token・client_id・refresh_token・resource を送る',
    t2.grant_type === 'refresh_token' && t2.client_id === ISSUED_CLIENT && t2.refresh_token === 'REFRESH_TEST_1' && t2.resource === 'https://api.openai.com/v1',
    JSON.stringify(t2));

  // ---- 4. 2 回目のサインイン（登録を引き継ぐ）
  await click('start');
  await waitFor(async () => mock.authorize.length >= 2, 10000);
  await sleep(1500);
  const a2 = mock.authorize[1] || {};
  check('2 回目の認可の依頼: 発行された client_id を再利用し、アプリ名は送らず、login_hint でアカウントを示す',
    a2.client_id === ISSUED_CLIENT && a2.agent_name_hint === undefined && a2.login_hint === 'tester@example.com' && a2.ext_agent_host_id === a1.ext_agent_host_id,
    JSON.stringify(a2));

  // ---- 5. 失敗系
  await click('sign-out');
  await sleep(500);
  const signedOut = await text('token');
  check('「保存したものを消す」で、トークンが画面から消える', signedOut.includes('まだ取得していません'), signedOut);

  mock.mode = 'deny';
  await click('start');
  const denied = await waitFor(async () => (await text('log')).includes('access_denied'), 15000);
  check('承認が拒否されたとき（error=access_denied）は、トークンを取りに行かず、待ち受けを終える',
    !!denied && mock.tokens.length === 3 /* ここまでの交換 3 回（初回・更新・2 回目）から増えない */ && (await E(`!document.getElementById('start').disabled`)),
    `${await text('log')} / token requests: ${mock.tokens.length}`);

  mock.mode = 'badstate';
  const before = mock.tokens.length;
  await click('start');
  const ignored = await waitFor(async () => (await text('log')).includes('state が一致しない'), 15000);
  await sleep(500);
  check('state が違う戻り先は無視し、トークンの交換をしない（待ち受けは続く）',
    !!ignored && mock.tokens.length === before && (await E(`document.getElementById('start').disabled`)), await text('log'));
  await click('cancel');
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
