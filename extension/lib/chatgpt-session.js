// ChatGPT のプランでのサインインの状態と流れ。
//   - サインインを始める（認可の画面を別のタブで開く）
//   - 戻り先の検知結果を処理する（state の照合 → code をトークンに交換）
//   - アクセストークンを返す（期限が近ければ、更新してから。更新は同時に 1 回だけ）
// トークンは、APIキーと同じ扱い（「保存しておく」なら storage.local、そうでなければ storage.session）。
import * as chatgpt from '../providers/chatgpt.js';
import { ProviderError } from '../providers/errors.js';
import { secretArea } from './settings.js';

const S = chrome.storage.session;
const L = chrome.storage.local;
const REFRESH_MARGIN_MS = 60 * 1000; // 有効期限の 1 分前になったら、更新する

async function readAuth() {
  const { chatgptAuth } = await (await secretArea()).get('chatgptAuth');
  return chatgptAuth && typeof chatgptAuth.accessToken === 'string' ? chatgptAuth : null;
}
const writeAuth = async (auth) => (await secretArea()).set({ chatgptAuth: auth });
async function clearAuth() {
  await L.remove('chatgptAuth');
  await S.remove('chatgptAuth');
}

async function readReg() {
  const { chatgptReg } = await L.get('chatgptReg');
  return chatgptReg && typeof chatgptReg === 'object' ? chatgptReg : {};
}

const setLast = (ok, message) => S.set({ chatgptLast: { at: Date.now(), ok, message } });

// ---------------------------------------------------------------- サインインを始める

export async function startSignIn() {
  const reg = await readReg();
  let hostId = reg.hostId;
  if (!hostId) {
    hostId = `urn:uuid:${crypto.randomUUID()}`;
    await L.set({ chatgptReg: { ...reg, hostId } });
  }
  const req = await chatgpt.createAuthRequest({ clientId: reg.clientId || '', hostId, email: reg.email || '' });
  // 戻り先が速く来ても取りこぼさないよう、タブを開く前に、待ち受け状態を保存する
  await S.set({
    chatgptPending: { state: req.state, nonce: req.nonce, verifier: req.verifier, usedClientId: req.usedClientId, startedAt: Date.now(), tabId: null },
  });
  await S.remove('chatgptLast');
  const tab = await chrome.tabs.create({ url: req.url });
  const { chatgptPending } = await S.get('chatgptPending');
  if (chatgptPending && chatgptPending.state === req.state) await S.set({ chatgptPending: { ...chatgptPending, tabId: tab.id } });
}

export async function cancelSignIn() {
  const { chatgptPending } = await S.get('chatgptPending');
  if (chatgptPending && chatgptPending.tabId !== null) chrome.tabs.remove(chatgptPending.tabId).catch(() => {});
  await S.remove('chatgptPending');
}

// ---------------------------------------------------------------- 戻り先の処理

let processing = false;

// 戻り先を検知したときに呼ぶ。戻り値: { handled, ok }
export async function onCallback(url, tabId) {
  if (processing) return { handled: false, ok: false };
  processing = true;
  try {
    const { chatgptPending: pending } = await S.get('chatgptPending');
    if (!pending) return { handled: false, ok: false };
    const parsed = chatgpt.parseCallback(url, pending);
    if (parsed.kind === 'ignore') return { handled: false, ok: false }; // 待ち受けは続ける

    await chrome.tabs.remove(pending.tabId ?? tabId).catch(() => {}); // 「接続できません」の画面を見せない
    await S.remove('chatgptPending');

    if (parsed.kind === 'error') {
      const text =
        parsed.error === 'access_denied'
          ? 'サインインの承認が拒否されました。'
          : `サインインを完了できませんでした（${parsed.error}）。`;
      await setLast(false, text);
      return { handled: true, ok: false };
    }

    // 発行された client_id は、交換の前に保存する（交換に失敗しても、登録をやり直さないため）
    const reg = await readReg();
    await L.set({ chatgptReg: { ...reg, clientId: parsed.clientId } });
    try {
      const auth = await chatgpt.exchangeCode({ code: parsed.code, clientId: parsed.clientId, verifier: pending.verifier, nonce: pending.nonce });
      if (!auth.scopes.includes(chatgpt.PLAN_SCOPE)) {
        await setLast(false, 'ChatGPT プランの利用枠を使う権限が、付与されませんでした。');
        return { handled: true, ok: false };
      }
      await writeAuth(auth);
      await L.set({ chatgptReg: { ...reg, clientId: parsed.clientId, email: auth.email } });
      await setLast(true, 'サインインしました。');
      return { handled: true, ok: true };
    } catch (e) {
      await setLast(false, (e && e.message) || 'サインインを完了できませんでした。');
      return { handled: true, ok: false };
    }
  } finally {
    processing = false;
  }
}

// ---------------------------------------------------------------- アクセストークン

let refreshing = null;

// force: 期限がまだ先でも更新する（サーバーに 401 と言われたときなど、手元の期限を信用できない場合）
async function doRefresh(force = false) {
  const current = await readAuth();
  if (!current) throw new ProviderError('ChatGPT にサインインしていません。設定画面で、サインインしてください。', 'nokey');
  // 別の呼び出しがすでに更新していれば、それを使う
  if (!force && current.expiresAt - Date.now() > REFRESH_MARGIN_MS) return current;
  if (!current.refreshToken) {
    await clearAuth();
    throw new ProviderError('ChatGPT のサインインの有効期限が切れました。設定画面で、サインインし直してください。', 'auth');
  }
  try {
    const next = await chatgpt.refreshTokens(current);
    await writeAuth(next); // アクセストークンと、新しいリフレッシュトークンを、まとめて入れ替える
    return next;
  } catch (e) {
    // 一時的な失敗（通信・混雑）では、サインインを消さない。無効になった場合だけ消す。
    if (e instanceof ProviderError && e.reauth) await clearAuth();
    throw e;
  }
}

function refreshOnce(force) {
  // 更新するたびにリフレッシュトークンが入れ替わる。同時に 2 回更新すると、片方が無効になるため、1 回にまとめる。
  if (!refreshing) {
    refreshing = doRefresh(force).finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

export async function getAccessToken() {
  const auth = await readAuth();
  if (!auth) throw new ProviderError('ChatGPT にサインインしていません。設定画面で、サインインしてください。', 'nokey');
  if (auth.expiresAt - Date.now() > REFRESH_MARGIN_MS) return auth.accessToken;
  return (await refreshOnce(false)).accessToken;
}

// サーバーが、手元では有効なはずのトークンを 401 で断ったとき。更新してから、もう一度使えるようにする。
// 更新も断られれば（サインインを取り消された・期限切れ）、サインイン済みの状態を解いて、サインインし直しを案内する。
export async function forceRefresh() {
  return (await refreshOnce(true)).accessToken;
}

// ---------------------------------------------------------------- 状態・サインアウト

export async function status() {
  const auth = await readAuth();
  const { chatgptPending: pending, chatgptLast: last } = await S.get(['chatgptPending', 'chatgptLast']);
  const reg = await readReg();
  return {
    signedIn: !!auth,
    email: (auth && auth.email) || reg.email || '',
    hasPlanScope: !!auth && auth.scopes.includes(chatgpt.PLAN_SCOPE),
    expiresAt: auth ? auth.expiresAt : 0,
    pending: !!pending,
    last: last || null,
  };
}

// この拡張機能に保存したものを消す（ChatGPT 側の接続は、ChatGPT の設定から解除する）
export async function signOut() {
  await cancelSignIn();
  await clearAuth();
  await S.remove('chatgptLast');
  const reg = await readReg();
  await L.set({ chatgptReg: { hostId: reg.hostId } }); // ホスト ID は、この拡張機能のインストールを表すので残す
}
