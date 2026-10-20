// ChatGPT のプラン（Plus / Pro など）の利用枠を使う提供元。OpenAI の「Sign in with ChatGPT」（トークン共有）。
// 仕様の出典: developers.openai.com/siwc/token-sharing-open-source
//
// 公式の手順は、ローカルのプログラムが 127.0.0.1 で待ち受けて、戻り先を受け取る形。
// 拡張機能は待ち受けを持てないので、戻り先への移動を webRequest で「検知」して、code を取り出す（lib/chatgpt-session.js）。
import { ProviderError, fetchOrThrow } from './errors.js';
import { parseSse } from './sse.js';

export const id = 'chatgpt';
export const label = 'ChatGPT プラン';

export const AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
export const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
export const API_BASE = 'https://api.openai.com/v1';
export const RESOURCE = 'https://api.openai.com/v1';
// 初回の登録から、同じ形（スキーム・ホスト・パス）を使い続ける必要がある。
export const REDIRECT_URI = 'http://127.0.0.1:1455/auth/callback';
export const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
// 承認画面に表示される名前。文字数・文字種の仕様が不明なため、無難な英数字にしている。
export const APP_NAME = 'AI Consult';

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

// ---------------------------------------------------------------- 小道具

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomB64url = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
export const sha256b64url = async (text) => b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

export function jwtPayload(jwt) {
  try {
    const part = String(jwt).split('.')[1];
    const bin = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- サインイン（認可の依頼・戻り先の解析）

// 認可の画面の URL と、あとで照合する値（state・nonce・PKCE の検証子）を作る。
export async function createAuthRequest({ clientId = '', hostId, email = '' }) {
  const verifier = randomB64url(32);
  const state = randomB64url(32);
  const nonce = randomB64url(32);
  const params = new URLSearchParams({
    client_id: clientId || 'dynamic_agent_client', // 初回だけ。発行された client_id を保存して、以後はそれを使う
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: await sha256b64url(verifier),
    ext_agent_host_id: hostId,
  });
  if (!clientId) params.set('agent_name_hint', APP_NAME);
  if (email) params.set('login_hint', email);
  return { url: `${AUTHORIZE_URL}?${params}`, state, nonce, verifier, usedClientId: clientId || null };
}

export function isCallbackUrl(u) {
  return (
    typeof u === 'string' &&
    u.startsWith(REDIRECT_URI) &&
    (u.length === REDIRECT_URI.length || '?#'.includes(u[REDIRECT_URI.length]))
  );
}

// 戻り先の URL を解析する。
//   ignore: この依頼のものではない（state が違う）。待ち受けを続ける
//   error:  サインインが完了しなかった
//   ok:     { code, clientId }
export function parseCallback(urlString, pending) {
  let q;
  try {
    q = new URL(urlString).searchParams;
  } catch {
    return { kind: 'ignore' };
  }
  const states = q.getAll('state');
  if (states.length !== 1 || states[0] !== pending.state) return { kind: 'ignore' };
  if (q.get('error')) return { kind: 'error', error: q.get('error') };
  const codes = q.getAll('code');
  if (codes.length !== 1) return { kind: 'error', error: 'missing_code' };
  const clientIds = q.getAll('client_id');
  if (clientIds.length > 1) return { kind: 'error', error: 'registration_incomplete' };
  const returned = clientIds[0] || '';
  const clientId = returned || pending.usedClientId || '';
  if (!clientId || clientId === 'dynamic_agent_client' || !/^[a-zA-Z0-9_-]{1,200}$/.test(clientId)) {
    return { kind: 'error', error: 'registration_incomplete' };
  }
  if (pending.usedClientId && returned && returned !== pending.usedClientId) return { kind: 'error', error: 'client_mismatch' };
  return { kind: 'ok', code: codes[0], clientId };
}

// ---------------------------------------------------------------- トークン

async function postForm(fields) {
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(fields),
    });
  } catch {
    throw new ProviderError('ChatGPT のサインイン先（auth.openai.com）に接続できませんでした。接続を確認してください。', 'network');
  }
  let json = null;
  try {
    json = await res.json();
  } catch { /* JSON ではない */ }
  return { res, json };
}

// 公式ドキュメント（errors-and-recovery）が「使えないリフレッシュトークン」としているコード。
// これらが返ったら、サインインし直すしかない（一時的な通信・サーバーの障害では、消さない）。
const TERMINAL_CODES = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);

function tokenError(status, json) {
  const code = json && typeof json.error === 'string' ? json.error : '';
  const detail = json && typeof json.error_description === 'string' ? json.error_description.slice(0, 160) : '';
  if (TERMINAL_CODES.has(code)) {
    return new ProviderError('ChatGPT のサインインの有効期限が切れました。設定画面で、サインインし直してください。', 'auth', { reauth: true });
  }
  if (status >= 500) return new ProviderError(`ChatGPT のサインイン先でエラーが発生しました (${status})。しばらくしてからお試しください。`, 'server');
  return new ProviderError(`ChatGPT のサインインを完了できませんでした (${status})。${code}${detail ? `: ${detail}` : ''}`, 'auth');
}

function toAuth(json, { clientId, email = '', previous = null }) {
  const expiresIn = Number(json.expires_in);
  if (!(expiresIn > 0)) throw new ProviderError('ChatGPT のサインインの応答が、想定した形ではありません（expires_in）。', 'auth');
  const scopeText = typeof json.scope === 'string' ? json.scope : previous ? previous.scopes.join(' ') : '';
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : previous ? previous.refreshToken : '',
    idToken: typeof json.id_token === 'string' && json.id_token ? json.id_token : previous ? previous.idToken : '',
    expiresAt: Date.now() + expiresIn * 1000,
    earliestRefreshAt: typeof json.earliest_refresh_at === 'number' ? json.earliest_refresh_at * 1000 : 0,
    scopes: scopeText.split(/\s+/).filter(Boolean),
    clientId,
    email,
    savedAt: Date.now(),
  };
}

// code をトークンに交換する。nonce が一致しない応答は、受け付けない。
export async function exchangeCode({ code, clientId, verifier, nonce }) {
  const { res, json } = await postForm({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
    resource: RESOURCE,
  });
  if (!res.ok || !json || typeof json.access_token !== 'string') throw tokenError(res.status, json);
  const claims = jwtPayload(json.id_token);
  if (!claims) throw new ProviderError('ChatGPT のサインインの応答（ID トークン）を読み取れませんでした。', 'auth');
  if (claims.nonce !== nonce) {
    throw new ProviderError('ChatGPT のサインインの応答が、今回の依頼のものではありません（nonce の不一致）。中止しました。', 'auth');
  }
  return toAuth(json, { clientId, email: typeof claims.email === 'string' ? claims.email : '' });
}

// リフレッシュトークンで、アクセストークンを更新する。リフレッシュトークンは、更新のたびに新しくなる。
export async function refreshTokens(auth) {
  const { res, json } = await postForm({
    grant_type: 'refresh_token',
    client_id: auth.clientId,
    refresh_token: auth.refreshToken,
    resource: RESOURCE,
  });
  if (!res.ok || !json || typeof json.access_token !== 'string') throw tokenError(res.status, json);
  return toAuth(json, { clientId: auth.clientId, email: auth.email, previous: auth });
}

// ---------------------------------------------------------------- モデル一覧・質問

// 利用枠の上限などの失敗を、利用者に分かる言葉にする
function failureError(err) {
  const code = (err && err.code) || '';
  if (code === 'subscription_sharing_usage_limit_exceeded') {
    return new ProviderError(
      'ChatGPT のプランの利用枠（アプリごとの上限、またはプラン全体の上限）に達しました。ChatGPT の「設定 → 使用状況」で、上限と残りを確認してください。',
      'quota',
    );
  }
  if (code === 'subscription_sharing_usage_unavailable') {
    return new ProviderError('ChatGPT のプランの利用枠を、いま利用できません。ChatGPT の「設定 → 使用状況」を確認してください。', 'quota');
  }
  return new ProviderError(String((err && err.message) || 'ChatGPT でエラーが発生しました。').slice(0, 300), 'server');
}

// 回答の差分を順に返す。1 回の依頼ぶん。
async function* streamOnce({ accessToken, model, body, signal }) {
  const res = await fetchOrThrow(id, model, `${API_BASE}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
    signal,
  });
  let completed = false;
  for await (const ev of parseSse(res.body)) {
    if (ev.data === '[DONE]') break;
    let json;
    try {
      json = JSON.parse(ev.data);
    } catch {
      continue;
    }
    switch (json.type || ev.event) {
      case 'response.output_text.delta':
      case 'response.refusal.delta':
        if (typeof json.delta === 'string' && json.delta) yield { text: json.delta };
        break;
      case 'response.completed':
        completed = true;
        break;
      case 'response.incomplete': {
        const reason = json.response && json.response.incomplete_details && json.response.incomplete_details.reason;
        yield { notice: reason === 'max_output_tokens' ? '回答が長さの上限に達して、途中で終わりました。' : '回答が途中で終わりました。' };
        break;
      }
      case 'response.failed':
        throw failureError(json.response && json.response.error);
      case 'error':
        throw failureError(json.error || json);
      default:
        break;
    }
  }
  // 公式の仕様: response.completed を受け取ってはじめて、成功とみなす
  if (!completed) yield { notice: '回答の完了を確認できませんでした。途中で切れた可能性があります。' };
}

// apiKey には、アクセストークンが入る（裏方が、必要なら更新してから渡す）
export async function* stream({ apiKey, model, system, messages, signal }) {
  if (!MODEL_ID.test(model)) throw new ProviderError('モデル名に使えない文字が含まれています。', 'model');
  // 公式の仕様: store は false、stream は true が必須
  const base = { model, input: messages.map((m) => ({ role: m.role, content: m.text })), store: false, stream: true };
  let yielded = false;
  try {
    for await (const chunk of streamOnce({ accessToken: apiKey, model, body: { ...base, instructions: system }, signal })) {
      yielded = true;
      yield chunk;
    }
  } catch (e) {
    // instructions を受け付けない場合に備えて、システム指示を、入力の先頭の developer メッセージとして送り直す
    if (!(e instanceof ProviderError && e.kind === 'invalid' && !yielded)) throw e;
    const withDeveloper = { ...base, input: [{ role: 'developer', content: system }, ...base.input] };
    yield* streamOnce({ accessToken: apiKey, model, body: withDeveloper, signal });
  }
}

// アカウントが使えるモデル。サーバーの順序のまま、表示用（visibility が list）のものだけ。
export async function listModels(accessToken, signal) {
  const res = await fetchOrThrow(id, '', `${API_BASE}/models`, { headers: { authorization: `Bearer ${accessToken}` }, signal });
  const json = await res.json();
  return (json.models || [])
    .filter((m) => m && typeof m.slug === 'string' && m.visibility === 'list' && MODEL_ID.test(m.slug))
    .map((m) => ({ id: m.slug, label: m.display_name || m.slug }));
}
