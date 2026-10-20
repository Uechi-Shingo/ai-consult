// 試作: 「Sign in with ChatGPT」の戻り先を、拡張機能が検知して、トークンを取得できるかを確かめる。
//   1. 認可の画面を開く（PKCE・state・nonce を付ける）
//   2. ログイン後の戻り先（http://127.0.0.1:1455/auth/callback?code=…）を、複数の方法で検知する
//   3. code をトークンに交換する
//   4. トークンで、モデル一覧の取得と、短い質問ができるか確かめる
// トークンは storage.session（ブラウザを閉じると消える）にだけ置き、画面には伏せ字でしか出さない。
import * as C from './config.js';

const S = chrome.storage.session;
const L = chrome.storage.local;
for (const area of [S, L]) {
  try {
    area.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch { /* 古いブラウザでは未対応 */ }
}

// ---------------------------------------------------------------- 小道具

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomB64url = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256b64url = async (text) => b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
const mask = (t) => (t ? `${String(t).slice(0, 6)}…（${String(t).length} 文字）` : '');

function jwtPayload(jwt) {
  try {
    const part = String(jwt).split('.')[1];
    const bin = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}

// 状態の更新は、順番が崩れないよう直列にする
let chain = Promise.resolve();
const EMPTY = () => ({ log: [], detections: [], pending: null, models: null, lastChat: null });
function update(fn) {
  chain = chain
    .then(async () => {
      const cur = (await S.get('spike')).spike || EMPTY();
      const next = (await fn(cur)) || cur;
      await S.set({ spike: next });
    })
    .catch(() => {});
  return chain;
}
const log = (text) =>
  update((s) => {
    s.log = [...s.log, { at: Date.now(), text }].slice(-80);
    return s;
  });

// ---------------------------------------------------------------- 1. 認可の画面を開く

async function startSignIn() {
  const local = await L.get(['hostId', 'clientId', 'email']);
  let hostId = local.hostId;
  if (!hostId) {
    hostId = `urn:uuid:${crypto.randomUUID()}`;
    await L.set({ hostId });
  }
  const verifier = randomB64url(32);
  const state = randomB64url(32);
  const nonce = randomB64url(32);
  const params = new URLSearchParams({
    client_id: local.clientId || 'dynamic_agent_client',
    response_type: 'code',
    redirect_uri: C.REDIRECT_URI,
    scope: C.SCOPES,
    resource: C.RESOURCE,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: await sha256b64url(verifier),
    ext_agent_host_id: hostId,
  });
  if (!local.clientId) params.set('agent_name_hint', C.APP_NAME); // 初回の登録のときだけ
  if (local.email) params.set('login_hint', local.email);

  // 戻り先が極めて速く来ても取りこぼさないよう、タブを開く前に、待ち受け状態を保存する
  await update((s) => {
    s.pending = { state, nonce, verifier, startedAt: Date.now(), usedClientId: local.clientId || null, tabId: null };
    s.detections = [];
    s.log = [...s.log, { at: Date.now(), text: `認可の画面を開きます（client_id=${local.clientId || 'dynamic_agent_client'}）` }].slice(-80);
    return s;
  });
  const tab = await chrome.tabs.create({ url: `${C.AUTH_AUTHORIZE_URL}?${params}` });
  await update((s) => {
    if (s.pending && s.pending.state === state) s.pending.tabId = tab.id;
    return s;
  });
}

// ---------------------------------------------------------------- 2. 戻り先の検知

const isCallback = (u) =>
  typeof u === 'string' && u.startsWith(C.REDIRECT_URI) && (u.length === C.REDIRECT_URI.length || '?#'.includes(u[C.REDIRECT_URI.length]));

let processing = false;

// 同じ戻り先を、複数の方法が検知する。どの方法で検知できたかを記録し、処理は 1 回だけ行う。
function onCallback(url, via, tabId) {
  update((s) => {
    if (!s.detections.some((d) => d.via === via)) s.detections = [...s.detections, { via, at: Date.now() }];
    return s;
  });
  if (processing) return;
  processing = true;
  handleCallback(url, via, tabId)
    .catch((e) => log(`戻り先の処理でエラー: ${e && e.message ? e.message : e}`))
    .finally(() => {
      processing = false;
    });
}

const WATCH = `${C.REDIRECT_URI}*`;
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (isCallback(d.url)) onCallback(d.url, 'webRequest.onBeforeRequest', d.tabId);
  },
  { urls: [WATCH], types: ['main_frame'] },
);
chrome.webNavigation.onBeforeNavigate.addListener(
  (d) => {
    if (d.frameId === 0 && isCallback(d.url)) onCallback(d.url, 'webNavigation.onBeforeNavigate', d.tabId);
  },
  { url: [{ urlPrefix: C.REDIRECT_URI }] },
);
chrome.webNavigation.onErrorOccurred.addListener(
  (d) => {
    if (d.frameId === 0 && isCallback(d.url)) onCallback(d.url, 'webNavigation.onErrorOccurred', d.tabId);
  },
  { url: [{ urlPrefix: C.REDIRECT_URI }] },
);
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  const u = info.url || (tab && tab.url);
  if (isCallback(u)) onCallback(u, 'tabs.onUpdated', tabId);
});

// ---------------------------------------------------------------- 3. code をトークンに交換する

async function postForm(url, fields) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(fields),
  });
  let json = null;
  try {
    json = await res.json();
  } catch { /* JSON でない */ }
  return { status: res.status, ok: res.ok, json };
}

function toTokens(json, clientId, previous) {
  const scopes = String(json.scope || (previous && previous.scopes.join(' ')) || '').split(/\s+/).filter(Boolean);
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || (previous && previous.refreshToken) || '',
    idToken: json.id_token || (previous && previous.idToken) || '',
    expiresAt: Date.now() + Number(json.expires_in) * 1000,
    scopes,
    clientId,
  };
}

async function handleCallback(url, via, tabId) {
  const spike = (await S.get('spike')).spike || EMPTY();
  const p = spike.pending;
  if (!p) {
    await log(`サインインを始めていないのに、戻り先を検知しました（${via}）。無視します。`);
    return;
  }
  await log(`戻り先を検知しました（${via}）`);
  const q = new URL(url).searchParams;

  // state は、1 回だけ現れ、完全に一致すること。違う場合は、待ち受けを続ける。
  const states = q.getAll('state');
  if (states.length !== 1 || states[0] !== p.state) {
    await log('state が一致しないため、この戻り先は無視します。');
    return;
  }
  const closeTab = () => chrome.tabs.remove(p.tabId ?? tabId).catch(() => {});

  if (q.get('error')) {
    await closeTab();
    await update((s) => {
      s.pending = null;
      return s;
    });
    await log(`サインインが完了しませんでした（error=${q.get('error')}）。`);
    return;
  }
  const codes = q.getAll('code');
  if (codes.length !== 1) {
    await closeTab();
    await update((s) => {
      s.pending = null;
      return s;
    });
    await log('戻り先に code がありません。');
    return;
  }
  const returned = q.get('client_id');
  const clientId = returned || p.usedClientId;
  if (!clientId || clientId === 'dynamic_agent_client' || !/^[a-zA-Z0-9_-]{1,200}$/.test(clientId)) {
    await closeTab();
    await update((s) => {
      s.pending = null;
      return s;
    });
    await log('発行された client_id を取得できませんでした（registration_incomplete）。');
    return;
  }
  if (p.usedClientId && returned && returned !== p.usedClientId) {
    await closeTab();
    await update((s) => {
      s.pending = null;
      return s;
    });
    await log('保存してある client_id と、戻り先の client_id が違うため、中止しました。');
    return;
  }

  await closeTab(); // 「接続できません」の画面を、利用者に見せない
  await L.set({ clientId }); // 登録は、交換の前に保存する（交換に失敗しても、登録をやり直さないため）
  await log(`client_id が発行されました: ${clientId}`);

  const r = await postForm(C.AUTH_TOKEN_URL, {
    grant_type: 'authorization_code',
    client_id: clientId,
    code: codes[0],
    code_verifier: p.verifier,
    redirect_uri: C.REDIRECT_URI,
    resource: C.RESOURCE,
  });
  await update((s) => {
    s.pending = null;
    return s;
  });
  if (!r.ok || !r.json || !r.json.access_token) {
    const detail = r.json ? `${r.json.error || ''} ${r.json.error_description || ''}`.trim() : '';
    await log(`トークンの交換に失敗しました（HTTP ${r.status}）${detail ? `: ${detail}` : ''}`);
    return;
  }

  const tokens = toTokens(r.json, clientId, null);
  const payload = jwtPayload(r.json.id_token);
  const checks = [];
  if (payload) {
    checks.push(`nonce ${payload.nonce === p.nonce ? '一致' : '不一致'}`);
    checks.push(`iss=${payload.iss}`);
    if (payload.nonce !== p.nonce) {
      await log('ID トークンの nonce が一致しないため、中止しました。');
      return;
    }
    if (payload.email) await L.set({ email: payload.email });
  } else {
    checks.push('ID トークンを読み取れませんでした');
  }
  await S.set({ tokens });
  await log(`トークンを取得しました。付与された権限: ${tokens.scopes.join(' ')}（${checks.join(' / ')}）`);
  if (!tokens.scopes.includes(C.PLAN_SCOPE)) {
    await log(`注意: ${C.PLAN_SCOPE} が付与されていません。ChatGPT プランの利用枠は使えません。`);
  }
}

// ---------------------------------------------------------------- 4. トークンの使用

async function currentTokens() {
  return (await S.get('tokens')).tokens || null;
}

async function refreshTokens() {
  const t = await currentTokens();
  if (!t || !t.refreshToken) return { ok: false, message: 'リフレッシュトークンがありません。' };
  const r = await postForm(C.AUTH_TOKEN_URL, {
    grant_type: 'refresh_token',
    client_id: t.clientId,
    refresh_token: t.refreshToken,
    resource: C.RESOURCE,
  });
  if (!r.ok || !r.json || !r.json.access_token) {
    const detail = r.json ? `${r.json.error || ''} ${r.json.error_description || ''}`.trim() : '';
    await log(`トークンの更新に失敗しました（HTTP ${r.status}）${detail ? `: ${detail}` : ''}`);
    return { ok: false, message: `更新に失敗しました（HTTP ${r.status}）` };
  }
  await S.set({ tokens: toTokens(r.json, t.clientId, t) });
  await log('トークンを更新しました（リフレッシュトークンも新しくなります）。');
  return { ok: true };
}

// 有効期限が近ければ、更新してから使う
async function usableToken() {
  let t = await currentTokens();
  if (!t) return null;
  if (t.expiresAt - Date.now() < 60000) {
    const r = await refreshTokens();
    if (!r.ok) return null;
    t = await currentTokens();
  }
  return t;
}

async function listModels() {
  const t = await usableToken();
  if (!t) return { ok: false, message: 'サインインしていないか、トークンを更新できませんでした。' };
  const res = await fetch(`${C.API_BASE}/models`, { headers: { authorization: `Bearer ${t.accessToken}` } });
  if (!res.ok) {
    await log(`モデル一覧の取得に失敗しました（HTTP ${res.status}）`);
    return { ok: false, message: `モデル一覧を取得できませんでした（HTTP ${res.status}）` };
  }
  const json = await res.json();
  const models = (json.models || [])
    .filter((m) => m && typeof m.slug === 'string' && m.visibility === 'list')
    .map((m) => ({ slug: m.slug, name: m.display_name || m.slug }));
  await update((s) => {
    s.models = models;
    return s;
  });
  await log(`モデル一覧を取得しました（表示用 ${models.length} 件）`);
  return { ok: true, count: models.length };
}

async function chat(model, text) {
  const t = await usableToken();
  if (!t) return { ok: false, message: 'サインインしていないか、トークンを更新できませんでした。' };
  const res = await fetch(`${C.API_BASE}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${t.accessToken}` },
    // 公式の仕様: store は false、stream は true が必須
    body: JSON.stringify({ model, input: [{ role: 'user', content: text }], store: false, stream: true }),
  });
  if (!res.ok) {
    let body = '';
    try {
      body = (await res.text()).slice(0, 300);
    } catch { /* 読めない */ }
    await log(`質問の送信に失敗しました（HTTP ${res.status}）: ${body}`);
    return { ok: false, message: `送信できませんでした（HTTP ${res.status}）${body ? `: ${body}` : ''}` };
  }
  // SSE を読み、回答の文字・完了・エラーを集める
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  let completed = false;
  let errorCode = '';
  const handle = (block) => {
    let data = '';
    for (const line of block.split(/\r?\n/)) if (line.startsWith('data:')) data += line.slice(5).trimStart();
    if (!data || data === '[DONE]') return;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    if (json.type === 'response.output_text.delta' && typeof json.delta === 'string') answer += json.delta;
    else if (json.type === 'response.completed') completed = true;
    else if (json.type === 'response.failed') errorCode = (json.response && json.response.error && json.response.error.code) || 'failed';
    else if (json.type === 'response.incomplete') errorCode = 'incomplete';
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let m;
    while ((m = /\r?\n\r?\n/.exec(buffer))) {
      handle(buffer.slice(0, m.index));
      buffer = buffer.slice(m.index + m[0].length);
    }
  }
  if (buffer.trim()) handle(buffer);
  const result = { model, answer, completed, errorCode, at: Date.now() };
  await update((s) => {
    s.lastChat = result;
    return s;
  });
  await log(
    completed
      ? `質問に回答が返りました（response.completed を確認）`
      : `質問の応答が完了しませんでした（${errorCode || '不明'}）`,
  );
  return { ok: true, ...result };
}

async function signOut() {
  await S.remove('tokens');
  await update((s) => {
    s.models = null;
    s.lastChat = null;
    s.pending = null;
    return s;
  });
  await L.remove(['clientId', 'email']);
  await log('この拡張機能に保存したトークンと登録を消しました。ChatGPT 側の接続は、ChatGPT の設定（セキュリティとログイン）で解除できます。');
}

// ---------------------------------------------------------------- 画面との通信

async function view() {
  const s = (await S.get('spike')).spike || EMPTY();
  const { tokens } = await S.get('tokens');
  const local = await L.get(['clientId', 'email', 'hostId']);
  return {
    ok: true,
    redirectUri: C.REDIRECT_URI,
    authorizeUrl: C.AUTH_AUTHORIZE_URL,
    pending: s.pending ? { startedAt: s.pending.startedAt } : null,
    detections: s.detections,
    log: s.log,
    models: s.models,
    lastChat: s.lastChat,
    email: local.email || '',
    clientId: local.clientId || '',
    hostId: local.hostId || '',
    token: tokens
      ? {
          scopes: tokens.scopes,
          expiresAt: tokens.expiresAt,
          hasPlanScope: tokens.scopes.includes(C.PLAN_SCOPE),
          hasRefresh: !!tokens.refreshToken,
          accessTokenHint: mask(tokens.accessToken),
        }
      : null,
  };
}

const HANDLERS = {
  view: async () => view(),
  start: async () => {
    await startSignIn();
    return { ok: true };
  },
  cancel: async () => {
    await update((s) => {
      s.pending = null;
      return s;
    });
    await log('サインインの待ち受けをやめました。');
    return { ok: true };
  },
  refresh: () => refreshTokens(),
  models: () => listModels(),
  chat: (msg) => chat(String(msg.model || ''), String(msg.text || '').slice(0, 2000)),
  'sign-out': async () => {
    await signOut();
    return { ok: true };
  },
};

const isOwnPage = (sender) =>
  sender && sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isOwnPage(sender) || !msg || typeof msg.type !== 'string') return;
  const handler = HANDLERS[msg.type];
  if (!handler) return;
  handler(msg).then(sendResponse, (e) => sendResponse({ ok: false, message: String((e && e.message) || e).slice(0, 300) }));
  return true;
});

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('spike.html');
  const [existing] = await chrome.tabs.query({ url });
  if (existing) await chrome.tabs.update(existing.id, { active: true });
  else await chrome.tabs.create({ url });
});
