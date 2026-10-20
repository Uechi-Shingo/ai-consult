// 実際の Chromium 系ブラウザ（Brave / Chrome / Edge）に拡張機能を読み込み、画面から相談できるまでを確かめる。
// 一時的なプロファイルで「画面付き」で起動する（サイドパネルは画面の部品のため、headless では確かめられない）。
// 普段使いのブラウザの設定・拡張機能・APIキーには触れません。数十秒間、ウィンドウが 1 つ開いて自動で閉じます。
//
// 各社の API への通信は、裏方（Service Worker）の fetch を偽物に差し替えて確かめる。実際の通信・課金は発生しない。
//
// 実行: node tests/e2e.mjs "<ブラウザの exe のパス>"
//   例: node tests/e2e.mjs "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
//
// 確かめられないこと: ツールバーのアイコンを実際にクリックしたときの開閉と activeTab（ブラウザ本体の画面操作のため）。
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const browserPath = process.argv[2];
const extDir = path.resolve(process.argv[3] || path.join(here, '..', 'extension'));
if (!browserPath) {
  console.error('使い方: node tests/e2e.mjs "<ブラウザの exe のパス>" [extension フォルダ]');
  process.exit(2);
}

// 偽のキー（秘密情報の検出ツールに誤検知されないよう、実行時に組み立てる）
const KEYS = {
  gemini: ['AIza', 'TEST', '-gemini-', 'key-0000000001'].join(''),
  openai: ['sk', '-test-', 'openai-', 'key-0000000002'].join(''),
  anthropic: ['sk', '-ant-', 'test-', 'anthropic-', 'key-0000000003'].join(''),
};

// ---- 確認用のローカルページ（外部ネットワークは使わない）
const pages = {
  '/a': { title: 'テストページA', body: 'これはページAの本文です。バナナの育て方について書かれています。'.repeat(20) },
  '/b': { title: 'テストページB', body: 'これはページBの本文です。りんごの保存方法について書かれています。'.repeat(20) },
  '/c': { title: 'テストページC', body: 'これはページCの本文です。みかんの選び方について書かれています。'.repeat(20) },
};
const server = http.createServer((req, res) => {
  const page = pages[req.url] || pages['/a'];
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><title>${page.title}</title><body><main><h1>${page.title}</h1><p>${page.body}</p></main></body>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// ---- 確認用に、全サイトを読み取れる権限を最初から付けた拡張機能のコピーを使う
// （本物の拡張機能では、activeTab または利用者の許可が必要。許可のダイアログは自動操作できないため）
const extCopy = mkdtempSync(path.join(os.tmpdir(), 'ai-consult-ext-'));
cpSync(extDir, extCopy, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(extCopy, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('<all_urls>');
delete manifest.optional_host_permissions;
writeFileSync(path.join(extCopy, 'manifest.json'), JSON.stringify(manifest, null, 2));

const profile = mkdtempSync(path.join(os.tmpdir(), 'ai-consult-profile-'));
const child = spawn(
  browserPath,
  [
    `--user-data-dir=${profile}`,
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1200,800',
    // 他のウィンドウに隠れても、描画やタイマーが止まらないようにする
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
);

// ---- CDP over pipe（メッセージは NUL 区切りの JSON）
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

async function evaluate(sessionId, expression, { userGesture = false } = {}) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

async function waitFor(fn, timeoutMs = 8000, stepMs = 150) {
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

const findTarget = async (pred) => {
  const { targetInfos } = await cdp('Target.getTargets');
  return targetInfos.find(pred);
};
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

// ---- 裏方の fetch を偽物に差し替える（各社 API のホストへの通信だけ）
const MOCK_SOURCE = `(() => {
  globalThis.__requests = [];
  globalThis.__routes = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input && input.url ? input.url : input);
    const isApi = url.includes('generativelanguage.googleapis.com') || url.includes('api.openai.com') || url.includes('api.anthropic.com');
    if (!isApi) return realFetch(input, init);
    const headers = {};
    new Headers(init.headers || {}).forEach((v, k) => { headers[k] = v; });
    let body = null;
    try { body = init.body ? JSON.parse(init.body) : null; } catch { body = null; }
    globalThis.__requests.push({ url, method: init.method || 'GET', headers, body });
    const idx = globalThis.__routes.findIndex((r) => url.includes(r.includes));
    if (idx < 0) return new Response('{"error":{"message":"no mock route"}}', { status: 599 });
    const route = globalThis.__routes[idx];
    if (route.once !== false) globalThis.__routes.splice(idx, 1);
    if (route.hang) {
      // 本物の fetch と同じく、すでに中断済みなら、すぐに失敗する（「停止」が、通信を始める前に押された場合）
      return new Promise((_, reject) => {
        const abort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (init.signal && init.signal.aborted) abort();
        else if (init.signal) init.signal.addEventListener('abort', abort, { once: true });
      });
    }
    if (route.status && route.status >= 400) return new Response(route.body || '', { status: route.status });
    const enc = new TextEncoder();
    const chunks = route.chunks || [];
    const stream = new ReadableStream({
      async start(controller) {
        for (const c of chunks) { controller.enqueue(enc.encode(c)); await new Promise((r) => setTimeout(r, 5)); }
        controller.close();
      },
    });
    if (route.json) return new Response(JSON.stringify(route.json), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return 'mocked';
})()`;

const sseFor = {
  gemini: (texts) => texts.map((t) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: t }], role: 'model' } }] })}\n\n`),
  openai: (texts) => [
    ...texts.map((t) => `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: t })}\n\n`),
    'event: response.completed\ndata: {"type":"response.completed","response":{}}\n\n',
  ],
  anthropic: (texts) => [
    ...texts.map((t) => `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })}\n\n`),
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ],
};
const STREAM_URL = {
  gemini: ':streamGenerateContent',
  openai: 'api.openai.com/v1/responses',
  anthropic: 'api.anthropic.com/v1/messages',
};

async function main() {
  const version = await cdp('Browser.getVersion');
  console.log(`ブラウザ: ${version.product}\n拡張機能: ${extDir}\n`);

  // 1. 読み込み
  let extId;
  try {
    ({ id: extId } = await cdp('Extensions.loadUnpacked', { path: extCopy }));
    check('拡張機能を読み込めた（manifest・CSP・ES モジュールの裏方が受理された）', !!extId, `ID: ${extId}`);
  } catch (e) {
    check('拡張機能を読み込めた', false, e.message);
    return;
  }
  const sw = await waitFor(() => findTarget((t) => t.type === 'service_worker' && t.url.includes(extId)), 15000);
  if (!sw) {
    check('裏方（Service Worker）が起動した', false, '見つかりませんでした');
    return;
  }
  const swS = await attach(sw.targetId);
  await evaluate(swS, MOCK_SOURCE);
  const addRoute = (route) => evaluate(swS, `globalThis.__routes.push(${JSON.stringify(route)}), true`);
  const requests = () => evaluate(swS, 'JSON.parse(JSON.stringify(globalThis.__requests))');
  const lastRequest = async (part) => (await requests()).filter((r) => r.url.includes(part)).pop();

  // 2. 設定画面: Gemini のキーを保存して接続テスト
  await addRoute({
    includes: 'generativelanguage.googleapis.com/v1beta/models?',
    json: {
      models: [
        { name: 'models/gemini-test-flash-lite', displayName: 'Gemini Test Flash Lite', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-test-pro', displayName: 'Gemini Test Pro', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
        // generateContent に対応していても、相談には使わないもの（画像生成・音声）
        { name: 'models/gemini-test-flash-image', displayName: 'Nano Banana', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-test-flash-preview-tts', displayName: 'Gemini Test TTS', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-test-native-audio-dialog', displayName: 'Gemini Test Audio', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-live-test', displayName: 'Gemini Live Test', supportedGenerationMethods: ['generateContent'] },
      ],
    },
  });
  const { targetId: optTarget } = await cdp('Target.createTarget', { url: `chrome-extension://${extId}/options.html` });
  const opt = await attach(optTarget);
  const O = (expr) => evaluate(opt, expr);
  await waitFor(() => O(`document.querySelectorAll('.provider').length === 4`));
  const providerSel = (p, rest) => `document.querySelector('.provider[data-id="${p}"] ${rest}')`;
  const typeKey = (provider) =>
    O(`(() => { const i = ${providerSel(provider, '.key')}; i.value = ${JSON.stringify(KEYS[provider])}; i.dispatchEvent(new Event('input')); })()`);
  const clickSave = () => O(`document.getElementById('save').click()`);
  async function saveKeyViaUi(provider) {
    await typeKey(provider);
    await clickSave();
    return waitFor(async () => (await O(`${providerSel(provider, '.status')}.textContent`)).includes('保存しました'));
  }

  // 入力しただけでは保存されない。「保存」を押して、はじめて接続を確認して保存される
  await typeKey('gemini');
  const dirtyText = await O(`document.getElementById('dirty').textContent`);
  const beforeSave = await evaluate(swS, `chrome.storage.local.get('apiKeys')`);
  check('キーを入力しただけでは保存されず、「未保存の変更があります」と表示される',
    dirtyText.includes('未保存') && !(beforeSave.apiKeys && beforeSave.apiKeys.gemini), `${dirtyText} / ${JSON.stringify(beforeSave)}`);
  await clickSave();
  const savedGemini = await waitFor(async () => (await O(`${providerSel('gemini', '.status')}.textContent`)).includes('保存しました'));
  const savedNote = await O(`document.getElementById('save-status').textContent`);
  check('「保存」を押すと保存され、保存したことと未保存の表示の消去が分かる',
    !!savedGemini && savedNote.includes('保存しました') && (await O(`document.getElementById('dirty').textContent`)) === '', savedNote);
  const listReq = await lastRequest('v1beta/models?');
  check('設定画面でキーを保存すると、接続テスト（モデル一覧の取得）が行われる',
    !!savedGemini && !!listReq && listReq.headers['x-goog-api-key'] === KEYS.gemini && !listReq.url.includes(KEYS.gemini),
    JSON.stringify(listReq));
  const modelOpts = await O(`[...${providerSel('gemini', '.model')}.options].map((o) => o.value)`);
  const modelSel = await O(`${providerSel('gemini', '.model')}.value`);
  check('モデル一覧は会話用だけが並ぶ（画像生成「Nano Banana」・音声用・埋め込みは出ない）。軽量なモデルが既定で選ばれる',
    JSON.stringify(modelOpts) === JSON.stringify(['gemini-test-flash-lite', 'gemini-test-pro']) && modelSel === 'gemini-test-flash-lite',
    `${JSON.stringify(modelOpts)} / 選択: ${modelSel}`);
  const stored = await evaluate(swS, `chrome.storage.local.get(['apiKeys', 'settings'])`);
  check('キーは裏方の保存領域に保存され、設定画面の入力欄には残らない',
    stored.apiKeys?.gemini === KEYS.gemini && (await O(`${providerSel('gemini', '.key')}.value`)) === '');

  // 以前に保存した一覧に画像生成・音声用が残っていても、表示から除かれ、選択も直される
  await evaluate(swS, `(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({
      modelLists: { gemini: [
        { id: 'gemini-test-flash-image', label: 'Nano Banana' },
        { id: 'gemini-test-flash-lite', label: 'Gemini Test Flash Lite' },
      ] },
      settings: { ...settings, models: { ...settings.models, gemini: 'gemini-test-flash-image' } },
    });
    return true;
  })()`);
  const healed = await O(`chrome.runtime.sendMessage({ type: 'get-state' })`);
  check('保存済みの一覧に画像生成用が残っていても、表示から除かれ、選択中のモデルも会話用に直される',
    JSON.stringify(healed.modelLists.gemini.map((m) => m.id)) === JSON.stringify(['gemini-test-flash-lite']) && healed.models.gemini === 'gemini-test-flash-lite',
    JSON.stringify({ list: healed.modelLists.gemini, model: healed.models.gemini }));

  // 「保存しておく」をオフにして保存すると、キーがディスク側の保存領域から消えてセッション側へ移る
  await O(`(() => { const c = document.getElementById('remember'); c.checked = false; c.dispatchEvent(new Event('change')); })()`);
  const notYet = await evaluate(swS, `chrome.storage.local.get('apiKeys')`);
  check('チェックを変えただけでは、まだ反映されない', notYet.apiKeys?.gemini === KEYS.gemini);
  await clickSave();
  await sleep(500);
  const moved = await evaluate(swS, `(async () => ({ local: (await chrome.storage.local.get('apiKeys')).apiKeys, session: (await chrome.storage.session.get('apiKeys')).apiKeys }))()`);
  check('「保存しておく」をオフにして保存すると、キーはディスクの保存領域から消えてセッション側に移る',
    !(moved.local && moved.local.gemini) && moved.session?.gemini === KEYS.gemini, JSON.stringify(Object.keys(moved.local || {})));
  await O(`(() => { const c = document.getElementById('remember'); c.checked = true; c.dispatchEvent(new Event('change')); })()`);
  await clickSave();
  await sleep(500);

  // 3. パネルを開く（sidePanel.open() はユーザー操作の中でしか呼べない）
  // CDP の userGesture 指定ではユーザー操作と認められないため、実際のマウス操作でボタンを押す。
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
      chrome.sidePanel.open({ windowId: ${windowId} }).then(
        () => { window.__openResult = 'opened'; },
        (e) => { window.__openResult = 'error: ' + e.message; },
      );
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
  await waitFor(() => O('window.__openResult !== undefined'), 4000);
  const opened = await O('window.__openResult');
  const panelT = await waitFor(() => findTarget((t) => t.url.includes(`${extId}/sidepanel.html`)), 8000);
  check('サイドパネルを開けた', opened === 'opened' && !!panelT, `open: ${opened}`);
  if (!panelT) return;
  const panel = await attach(panelT.targetId);
  const P = (expr) => evaluate(panel, expr);
  const text = (sel) => P(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ''`);
  await waitFor(() => P(`document.getElementById('provider').options.length > 0`));

  // バージョンが、パネルと設定画面に表示される（再読み込みできたかを、利用者が確かめられる）
  const shownVersion = await waitFor(async () => (await text('#version')) !== '');
  check('バージョンが、パネルと設定画面に表示される',
    (await text('#version')) === `v${manifest.version}` && (await O(`document.getElementById('version').textContent`)) === `v${manifest.version}`,
    `${await text('#version')} / ${manifest.version}`);
  void shownVersion;

  // 注意事項を確認するまでは、送れない
  const onboardingShown = await waitFor(() => P(`!document.getElementById('onboarding').hidden`));
  const onboardingText = await text('#onboarding-text');
  check('注意事項を確認するまでは、案内が出て送信できない', !!onboardingShown && onboardingText.includes('注意事項'), onboardingText);
  await O(`(() => { const c = document.getElementById('ack'); c.checked = true; c.dispatchEvent(new Event('change')); })()`);
  await sleep(500);
  check('チェックを入れただけでは、保存されず、パネルの案内も消えない',
    !(await P(`document.getElementById('onboarding').hidden`)) && !(await evaluate(swS, `chrome.storage.local.get('settings')`)).settings?.acknowledged);
  await clickSave();
  const onboardingHidden = await waitFor(() => P(`document.getElementById('onboarding').hidden`));
  check('「保存」を押すと、パネルの案内が消える', !!onboardingHidden);

  // 4. タブ A を開く → ページが読み取られる
  const tabA = await cdp('Target.createTarget', { url: `${base}/a` });
  await cdp('Target.activateTarget', { targetId: tabA.targetId });
  const ctxA = await waitFor(async () => (await text('#context-text')).includes('テストページA'), 10000);
  const ctxTextA = await text('#context-text');
  check('タブを開くと、ページのタイトルと文字数がパネルに表示される', !!ctxA && ctxTextA.includes('約'), ctxTextA);

  // 5. Gemini に質問 → ストリーミング表示・依頼の内容
  const ask = (q) => P(`(() => { document.getElementById('input').value = ${JSON.stringify(q)}; document.getElementById('send').click(); })()`);
  const idle = () => waitFor(() => P(`document.getElementById('stop').hidden && !document.getElementById('send').disabled`), 10000);
  await addRoute({
    includes: STREAM_URL.gemini,
    chunks: sseFor.gemini(['こんにちは', '、**世界**です。\n\n- 項目1\n- 項目2']),
  });
  await ask('この記事の要点は？');
  await waitFor(async () => (await text('#messages .msg.assistant .body')).includes('項目2'), 10000);
  await idle();
  const shown = await P(`(() => {
    const b = document.querySelector('#messages .msg.assistant .body');
    return { text: b.textContent, strong: [...b.querySelectorAll('strong')].map((x) => x.textContent), li: b.querySelectorAll('li').length };
  })()`);
  check('回答が Markdown として表示される（太字・箇条書き）',
    shown.text.includes('こんにちは、世界です。') && shown.strong[0] === '世界' && shown.li === 2, JSON.stringify(shown));

  const gReq = await lastRequest(STREAM_URL.gemini);
  const firstPart = gReq?.body?.contents?.[0]?.parts?.[0]?.text || '';
  check('Gemini への依頼: URL・キーのヘッダー・モデル・システム指示',
    !!gReq && gReq.url.includes('/models/gemini-test-flash-lite:streamGenerateContent?alt=sse') && gReq.headers['x-goog-api-key'] === KEYS.gemini &&
      !gReq.url.includes(KEYS.gemini) && JSON.stringify(gReq.body).includes('信用できないデータ') && !JSON.stringify(gReq.body).includes(KEYS.gemini),
    JSON.stringify(gReq?.headers));
  check('Gemini への依頼: 最初の質問に、ページの本文と質問が入っている',
    firstPart.includes('<page title="テストページA"') && firstPart.includes('ページAの本文') && firstPart.includes('[質問]\nこの記事の要点は？') &&
      gReq.body.contents.length === 1,
    firstPart.slice(0, 200));
  check('パネルの画面に、APIキーが表示されていない', !(await P('document.body.innerText')).includes(KEYS.gemini));

  // 6. タブ B ではタブ A の会話が混ざらず、A に戻ると会話が復元される
  const tabB = await cdp('Target.createTarget', { url: `${base}/b` });
  await cdp('Target.activateTarget', { targetId: tabB.targetId });
  await waitFor(async () => (await text('#context-text')).includes('テストページB'), 10000);
  await sleep(300);
  const countB = await P(`document.querySelectorAll('#messages .msg').length`);
  check('別のタブに切り替えると、そのタブの会話に差し替わる（前のタブの会話が混ざらない）', countB === 0, `メッセージ数: ${countB}`);
  await cdp('Target.activateTarget', { targetId: tabA.targetId });
  await waitFor(async () => (await text('#context-text')).includes('テストページA'), 10000);
  const restored = await waitFor(async () => (await P(`document.querySelectorAll('#messages .msg').length`)) === 2);
  check('元のタブに戻ると、そのタブの会話が復元される', !!restored);

  // 7. エラー表示（キー無効）
  await cdp('Target.activateTarget', { targetId: tabB.targetId });
  await waitFor(async () => (await text('#context-text')).includes('テストページB'), 10000);
  await addRoute({ includes: STREAM_URL.gemini, status: 401, body: JSON.stringify({ error: { code: 401, message: 'API key not valid. Please pass a valid API key.' } }) });
  await ask('りんごについて教えて');
  const errShown = await waitFor(async () => (await text('#messages .extra.error')).includes('無効'));
  const errButtons = await P(`[...document.querySelectorAll('#messages .extra.error button')].map((b) => b.textContent)`);
  check('キーが無効なときは、分かる言葉のエラーと「設定を開く」が出る', !!errShown && errButtons.includes('設定を開く'), JSON.stringify(errButtons));

  // 8. OpenAI・Claude のキーを保存
  await addRoute({
    includes: 'api.openai.com/v1/models',
    json: { data: [{ id: 'gpt-test', created: 1 }, { id: 'gpt-test-mini', created: 2 }, { id: 'text-embedding-3', created: 9 }, { id: 'whisper-1', created: 9 }] },
  });
  await addRoute({
    includes: 'api.anthropic.com/v1/models',
    json: {
      data: [
        { id: 'claude-test-sonnet', display_name: 'Claude Test Sonnet', created_at: '2026-02-01T00:00:00Z' },
        { id: 'claude-test-haiku', display_name: 'Claude Test Haiku', created_at: '2026-01-01T00:00:00Z' },
      ],
    },
  });
  const savedOpenai = await saveKeyViaUi('openai');
  const savedAnthropic = await saveKeyViaUi('anthropic');
  const oOpts = await O(`[...${providerSel('openai', '.model')}.options].map((o) => o.value)`);
  const aSel = await O(`${providerSel('anthropic', '.model')}.value`);
  check('OpenAI・Claude のキーを保存でき、モデル一覧（会話用のみ）と既定のモデルが選ばれる',
    !!savedOpenai && !!savedAnthropic && JSON.stringify(oOpts) === JSON.stringify(['gpt-test-mini', 'gpt-test']) && aSel === 'claude-test-haiku',
    `${JSON.stringify(oOpts)} / ${aSel}`);
  const aReq = await lastRequest('api.anthropic.com/v1/models');
  check('Claude へのモデル一覧の依頼に、ブラウザ直接アクセスのヘッダーが付いている',
    aReq?.headers['anthropic-dangerous-direct-browser-access'] === 'true' && aReq.headers['x-api-key'] === KEYS.anthropic &&
      aReq.headers['anthropic-version'] === '2023-06-01',
    JSON.stringify(aReq?.headers));

  // 9. 利用枠切れ → 別の提供元で続ける
  await waitFor(async () => (await P(`[...document.getElementById('provider').options].map((o) => o.value).join(',')`)) === 'gemini,openai,anthropic');
  await P(`document.querySelectorAll('#messages .msg').length`); // 画面が更新されるのを待つ
  await cdp('Target.activateTarget', { targetId: tabB.targetId });
  await addRoute({
    includes: STREAM_URL.gemini,
    status: 429,
    body: JSON.stringify({ error: { code: 429, message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 20, PerDay', status: 'RESOURCE_EXHAUSTED' } }),
  });
  await P(`document.getElementById('new-chat').click()`); // 7 の失敗した会話を消して、きれいな状態から
  await ask('りんごの保存方法は？');
  const quotaShown = await waitFor(async () => (await text('#messages .extra.error')).includes('利用枠'));
  const quotaButtons = await P(`[...document.querySelectorAll('#messages .extra.error button')].map((b) => b.textContent)`);
  check('無料枠切れのときは、別の提供元で続けるボタンが出る',
    !!quotaShown && quotaButtons.includes('OpenAI（APIキー）で続ける') && quotaButtons.includes('Claudeで続ける'), JSON.stringify(quotaButtons));

  await addRoute({ includes: STREAM_URL.openai, chunks: sseFor.openai(['OpenAI', 'の回答です']) });
  await P(`[...document.querySelectorAll('#messages .extra.error button')].find((b) => b.textContent === 'OpenAI（APIキー）で続ける').click()`);
  const oShown = await waitFor(async () => (await text('#messages .msg.assistant .body')).includes('OpenAIの回答です'), 10000);
  const oReq = await lastRequest(STREAM_URL.openai);
  check('「OpenAI（APIキー）で続ける」で、同じ質問が OpenAI に送られ、回答が表示される', !!oShown && !!oReq);
  check('OpenAI への依頼: 認証・モデル・stream・store: false・ページの本文',
    oReq?.headers.authorization === `Bearer ${KEYS.openai}` && oReq.body.model === 'gpt-test-mini' && oReq.body.stream === true &&
      oReq.body.store === false && oReq.body.input[0].role === 'user' && oReq.body.input[0].content.includes('ページBの本文') &&
      oReq.body.instructions.includes('信用できないデータ'),
    JSON.stringify(oReq?.body).slice(0, 300));
  const providerNow = await P(`document.getElementById('provider').value`);
  check('提供元の切り替えが、パネルの選択に反映される', providerNow === 'openai', providerNow);

  // 10. Claude で、続けて質問（会話の履歴が送られる）
  await idle();
  await P(`(() => { const s = document.getElementById('provider'); s.value = 'anthropic'; s.dispatchEvent(new Event('change')); })()`);
  await waitFor(async () => (await P(`document.getElementById('model').value`)) === 'claude-test-haiku');
  await addRoute({ includes: STREAM_URL.anthropic, chunks: sseFor.anthropic(['Claude', 'です']) });
  await ask('もう少し詳しく');
  const cShown = await waitFor(async () => (await text('#messages .msg:last-child .body')).includes('Claudeです'), 10000);
  const cReq = await lastRequest(STREAM_URL.anthropic);
  check('Claude への依頼: 認証ヘッダー・max_tokens・system・履歴（役割が交互）',
    !!cShown && cReq?.headers['x-api-key'] === KEYS.anthropic && cReq.headers['anthropic-version'] === '2023-06-01' &&
      cReq.headers['anthropic-dangerous-direct-browser-access'] === 'true' && Number.isInteger(cReq.body.max_tokens) &&
      typeof cReq.body.system === 'string' && JSON.stringify(cReq.body.messages.map((m) => m.role)) === JSON.stringify(['user', 'assistant', 'user']),
    JSON.stringify(cReq?.body?.messages?.map((m) => m.role)));

  // 11. 停止
  await idle();
  await addRoute({ includes: STREAM_URL.anthropic, hang: true });
  await ask('停止のテスト');
  const busy = await waitFor(() => P(`!document.getElementById('stop').hidden`));
  await P(`document.getElementById('stop').click()`);
  const stopped = await waitFor(() => P(`document.getElementById('stop').hidden`));
  const stoppedText = await P(`[...document.querySelectorAll('#messages .extra')].map((e) => e.textContent).join('|')`);
  const stopDiag = async () =>
    JSON.stringify({
      busy: !!busy,
      stopped: !!stopped,
      stoppedText,
      panel: await P(`({
        stopHidden: document.getElementById('stop').hidden,
        sendDisabled: document.getElementById('send').disabled,
        onboarding: document.getElementById('onboarding').hidden ? '' : document.getElementById('onboarding-text').textContent,
        provider: document.getElementById('provider').value,
        model: document.getElementById('model').value,
        messages: document.getElementById('messages').innerText.slice(-300),
      })`),
      requests: (await requests()).slice(-3).map((r) => r.url.slice(0, 60)),
    });
  check('応答待ちのときに「停止」でき、停止したことが表示される', !!busy && !!stopped && stoppedText.includes('停止'), !(busy && stopped && stoppedText.includes('停止')) ? await stopDiag() : '');

  // 12. 回答に HTML やスクリプトが含まれていても、実行・要素化されない
  await addRoute({
    includes: STREAM_URL.anthropic,
    chunks: sseFor.anthropic([
      '<img src=x onerror="window.__xss=1">\n\n[bad](javascript:alert(1)) と [good](https://example.com/x)\n\n`<script>window.__xss=2</script>`',
    ]),
  });
  await ask('危険な出力のテスト');
  await waitFor(async () => (await text('#messages .msg:last-child .body')).includes('good'), 10000);
  await idle();
  const xss = await P(`(() => {
    const b = document.querySelector('#messages .msg:last-child .body');
    const good = b.querySelector('a[href="https://example.com/x"]');
    return {
      img: document.querySelectorAll('#messages img').length,
      script: document.querySelectorAll('#messages script').length,
      jsLinks: document.querySelectorAll('#messages a[href^="javascript"]').length,
      executed: typeof window.__xss !== 'undefined',
      goodRel: good ? good.rel : null,
      literal: b.textContent.includes('<img src=x onerror='),
    };
  })()`);
  check('回答中の HTML・javascript: リンクは要素にならず、リンクは noopener 付きで開く',
    xss.img === 0 && xss.script === 0 && xss.jsLinks === 0 && !xss.executed && xss.literal && /noopener/.test(xss.goodRel || ''),
    JSON.stringify(xss));

  // 画面の見た目を目で確かめたいとき用: E2E_SCREENSHOT_DIR を指定すると、会話が表示されたパネルを、画像で保存する
  if (process.env.E2E_SCREENSHOT_DIR) {
    mkdirSync(process.env.E2E_SCREENSHOT_DIR, { recursive: true });
    const shot = await cdp('Page.captureScreenshot', { format: 'png' }, panel);
    writeFileSync(path.join(process.env.E2E_SCREENSHOT_DIR, 'panel.png'), Buffer.from(shot.data, 'base64'));
  }

  // 11b. パネルの角の「×」ボタン: 見える位置にあり、名前が付いている
  const closeBtn = await P(`(() => {
    const b = document.getElementById('close-panel');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const header = document.querySelector('header').getBoundingClientRect();
    return { label: b.getAttribute('aria-label'), text: b.textContent, w: r.width, h: r.height, insideHeader: r.top >= header.top && r.bottom <= header.bottom && r.right <= innerWidth };
  })()`);
  check('パネルの上部に、「×」の閉じるボタンがあり、名前（パネルを閉じる）が付いていて、はみ出していない',
    !!closeBtn && closeBtn.label === 'パネルを閉じる' && closeBtn.text === '×' && closeBtn.w >= 24 && closeBtn.h >= 24 && closeBtn.insideHeader,
    JSON.stringify(closeBtn));

  // 12b. 混雑（5xx）のときは、自動で再試行する。待っている間は「再試行しています」と表示する
  await idle();
  const reqCount = async () => (await requests()).filter((r) => r.url.includes(STREAM_URL.anthropic)).length;
  const overloaded = JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
  const countBefore = await reqCount();
  await addRoute({ includes: STREAM_URL.anthropic, status: 529, body: overloaded });
  await addRoute({ includes: STREAM_URL.anthropic, status: 529, body: overloaded });
  await addRoute({ includes: STREAM_URL.anthropic, chunks: sseFor.anthropic(['混雑のあと', '成功しました']) });
  await ask('再試行のテスト');
  const retryShown = await waitFor(async () => (await text('#messages .msg:last-child .body')).includes('再試行'), 6000);
  const recovered = await waitFor(async () => (await text('#messages .msg:last-child .body')).includes('混雑のあと成功しました'), 15000);
  const retried = (await reqCount()) - countBefore;
  check('混雑（529）のときは自動で再試行し、待つ間は「再試行しています」と表示され、成功すれば回答が表示される',
    !!retryShown && !!recovered && retried === 3, `再試行の表示: ${!!retryShown} / 回答: ${!!recovered} / 依頼の回数: ${retried}`);

  // 12c. 混雑が続くときは、あきらめて、理由つきのエラーと「別のモデル・別の提供元で続ける」を出す
  await idle();
  const countBefore2 = await reqCount();
  for (let i = 0; i < 3; i++) await addRoute({ includes: STREAM_URL.anthropic, status: 529, body: overloaded });
  await ask('混雑が続くテスト');
  const gaveUp = await waitFor(async () => (await text('#messages .extra.error')).includes('529'), 20000);
  const giveUpText = await text('#messages .extra.error');
  const giveUpButtons = await P(`[...document.querySelectorAll('#messages .extra.error button')].map((b) => b.textContent)`);
  const tried = (await reqCount()) - countBefore2;
  check('混雑が続くときは、相手の返答つきのエラーと、別のモデル・別の提供元で続けるボタンが出る（再試行は 2 回まで）',
    !!gaveUp && tried === 3 && giveUpText.includes('Overloaded') &&
      giveUpButtons.includes('Claude Test Sonnetで続ける') && giveUpButtons.includes('OpenAI（APIキー）で続ける'),
    `${giveUpText.slice(0, 120)} / 依頼 ${tried} 回 / ${JSON.stringify(giveUpButtons)}`);

  await addRoute({ includes: STREAM_URL.anthropic, chunks: sseFor.anthropic(['別のモデルの回答です']) });
  await P(`[...document.querySelectorAll('#messages .extra.error button')].find((b) => b.textContent === 'Claude Test Sonnetで続ける').click()`);
  const altShown = await waitFor(async () => (await text('#messages .msg:last-child .body')).includes('別のモデルの回答です'), 10000);
  const altReq = await lastRequest(STREAM_URL.anthropic);
  check('「別のモデルで続ける」で、そのモデルに切り替えて、同じ質問が再送される',
    !!altShown && altReq?.body?.model === 'claude-test-sonnet' && (await P(`document.getElementById('model').value`)) === 'claude-test-sonnet',
    `model=${altReq?.body?.model}`);
  await idle();

  // 13. 画面からの外部通信・インラインスクリプトは CSP で止まる
  const csp = await P(`(async () => {
    const violations = [];
    document.addEventListener('securitypolicyviolation', (e) => violations.push(e.effectiveDirective));
    const out = {};
    try { await fetch('https://example.com/', { mode: 'no-cors' }); out.external = 'allowed'; } catch { out.external = 'blocked'; }
    const s = document.createElement('script');
    s.textContent = 'window.__pwned = 1';
    document.body.append(s);
    out.inline = window.__pwned === 1;
    await new Promise((r) => setTimeout(r, 200));
    out.violations = violations;
    return out;
  })()`);
  check('パネルから 3 社以外への通信は遮断され、インラインスクリプトは実行されない',
    csp.external === 'blocked' && csp.inline === false && csp.violations.includes('connect-src'), JSON.stringify(csp));

  // 14. ブラウザの内部ページは、読み取れないことを案内する
  const tabI = await cdp('Target.createTarget', { url: 'chrome://version' });
  await cdp('Target.activateTarget', { targetId: tabI.targetId });
  const internalShown = await waitFor(async () => (await text('#context-text')).includes('内部ページ'), 10000);
  check('ブラウザの内部ページでは、「読み取れない」ことが案内される', !!internalShown, await text('#context-text'));

  // 14b. 全サイトの許可があっても読めないページ（空白のページ）では、許可のボタンを出さず、理由を説明する
  const tabBlank = await cdp('Target.createTarget', { url: 'about:blank' });
  await cdp('Target.activateTarget', { targetId: tabBlank.targetId });
  const blankShown = await waitFor(async () => {
    const t = await text('#context-text');
    return t.includes('読み取れない種類') || t.includes('内部ページ');
  }, 10000);
  const blankInfo = await P(`({ text: document.getElementById('context-text').textContent, tip: document.getElementById('context-text').title, grantHidden: document.getElementById('permission').hidden })`);
  check('許可があっても読めないページでは、「許可」のボタンを出さずに、読めない理由を説明する',
    !!blankShown && blankInfo.grantHidden === true, JSON.stringify(blankInfo));

  // 15. ページが別のページに変わったら、新しい相談になる
  await cdp('Target.activateTarget', { targetId: tabA.targetId });
  await waitFor(async () => (await P(`document.querySelectorAll('#messages .msg').length`)) > 0);
  const tabAS = await attach(tabA.targetId);
  await cdp('Page.navigate', { url: `${base}/c` }, tabAS);
  const reset = await waitFor(async () => (await P(`document.querySelectorAll('#messages .msg').length`)) === 0 && (await text('#context-text')).includes('テストページC'), 10000);
  const sys = await text('#messages .system');
  check('同じタブで別のページに移動すると、新しい相談になる（古い会話を引きずらない）', !!reset && sys.includes('ページが変わった'), sys);

  // 16. 設定画面の閉じ方: 未保存のときは確認し、保存して閉じる・そのまま閉じるができる
  const targetExists = async (id) => !!(await findTarget((t) => t.targetId === id));
  const openOptions = async () => {
    const { targetId } = await cdp('Target.createTarget', { url: `chrome-extension://${extId}/options.html` });
    const session = await attach(targetId);
    await waitFor(() => evaluate(session, `document.querySelectorAll('.provider').length === 4 && !document.getElementById('ack').disabled`));
    await sleep(300);
    return { targetId, session };
  };
  const press = async (o, id) => {
    await cdp('Target.activateTarget', { targetId: o.targetId });
    await evaluate(o.session, `document.getElementById(${JSON.stringify(id)}).click()`);
  };

  const o1 = await openOptions();
  await evaluate(o1.session, `(() => { const c = document.getElementById('ack'); c.checked = !c.checked; c.dispatchEvent(new Event('change')); })()`);
  await press(o1, 'close');
  await sleep(500);
  const warned = await evaluate(o1.session, `({ text: document.getElementById('save-status').textContent, label: document.getElementById('close').textContent })`);
  check('未保存のまま「閉じる」を押すと、閉じずに確認が出る', (await targetExists(o1.targetId)) && warned.text.includes('未保存') && warned.label.includes('破棄'), JSON.stringify(warned));
  await press(o1, 'close');
  const closedByDiscard = await waitFor(async () => !(await targetExists(o1.targetId)), 5000);
  const ackAfterDiscard = (await evaluate(swS, `chrome.storage.local.get('settings')`)).settings.acknowledged;
  check('もう一度「閉じる」を押すと、変更を破棄して閉じる（保存されない）', !!closedByDiscard && ackAfterDiscard === true, `acknowledged=${ackAfterDiscard}`);

  const o2 = await openOptions();
  await evaluate(o2.session, `(() => { const c = document.getElementById('ack'); c.checked = false; c.dispatchEvent(new Event('change')); })()`);
  await press(o2, 'save-close');
  const closedBySave = await waitFor(async () => !(await targetExists(o2.targetId)), 8000);
  const ackAfterSave = (await evaluate(swS, `chrome.storage.local.get('settings')`)).settings.acknowledged;
  check('「保存して閉じる」で、保存してから閉じる', !!closedBySave && ackAfterSave === false, `acknowledged=${ackAfterSave}`);

  const o3 = await openOptions();
  await evaluate(o3.session, `(() => { const c = document.getElementById('ack'); c.checked = true; c.dispatchEvent(new Event('change')); })()`);
  await press(o3, 'save-close');
  await waitFor(async () => !(await targetExists(o3.targetId)), 8000);
  const o4 = await openOptions();
  await press(o4, 'close');
  const closedClean = await waitFor(async () => !(await targetExists(o4.targetId)), 5000);
  check('変更がなければ、「閉じる」で、そのまま閉じる', !!closedClean);

  // 17. アイコンのクリックで、開いていたパネルが閉じる（裏方の記憶に頼らず、パネルが自分で閉じる）
  const isPanelTarget = (t) => t.url.includes(`${extId}/sidepanel.html`);
  const openedBefore = await findTarget(isPanelTarget);
  // 裏方に、アイコンのクリックと同じ処理を行わせる。open() はユーザー操作がないため拒否されるが、閉じる合図は届く。
  await evaluate(swS, `(handleActionClick({ windowId: ${windowId} }), true)`);
  const closedByClick = await waitFor(async () => !(await findTarget(isPanelTarget)), 6000);
  check('アイコンのクリックの処理で、開いていたパネルが閉じる（開閉の状態を、裏方の記憶に頼らない）',
    !!openedBefore && !!closedByClick, `開いていた: ${!!openedBefore} / 閉じた: ${!!closedByClick}`);

  // 閉じたあとで、もう一度開ける。新しく開いたパネルは、クリックより前の合図では閉じない。
  await cdp('Target.activateTarget', { targetId: optTarget });
  await sleep(300);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...mouse }, opt);
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...mouse }, opt);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...mouse }, opt);
  const reopened = await waitFor(() => findTarget(isPanelTarget), 8000);
  await sleep(800);
  await evaluate(swS, `chrome.runtime.sendMessage({ type: 'toggle-request', windowId: ${windowId}, at: Date.now() - 60000 }).catch(() => {}), true`);
  await sleep(1500);
  const stillOpen = await findTarget(isPanelTarget);
  check('閉じたあとで、もう一度開ける。そのあとに届いた「より前の時刻のクリック」の合図では、閉じない',
    !!reopened && !!stillOpen, `開いた: ${!!reopened} / 残っている: ${!!stillOpen}`);

  // 18. パネルの「×」ボタンを押すと、パネルが閉じる
  const panel2 = await attach(stillOpen.targetId);
  await waitFor(() => evaluate(panel2, `!!document.getElementById('close-panel')`));
  await evaluate(panel2, `document.getElementById('close-panel').click()`);
  const closedByButton = await waitFor(async () => !(await findTarget(isPanelTarget)), 6000);
  check('パネルの「×」ボタンを押すと、パネルが閉じる', !!closedByButton);
}

let failed = false;
try {
  await main();
} catch (e) {
  failed = true;
  console.error('\n実行中にエラー:', e.stack || e.message);
} finally {
  try { await cdp('Browser.close'); } catch { /* 終了処理 */ }
  await sleep(500);
  child.kill();
  server.close();
  await sleep(500);
  for (const dir of [profile, extCopy]) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* 一時フォルダの削除に失敗しても無視 */ }
  }
}

const ng = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - ng} / ${results.length} 件成功`);
process.exit(failed || ng ? 1 : 0);
