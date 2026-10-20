// 裏方（Service Worker）。APIキーを持つのはここだけで、パネルやページには渡さない。
//   - アイコン・右クリックからパネルを開閉する
//   - 各社 API への通信（ストリーミング）と、使用量の上限
//   - ページ本文の取り出し（scripting）
import * as anthropic from './providers/anthropic.js';
import * as chatgpt from './providers/chatgpt.js';
import { ProviderError } from './providers/errors.js';
import * as gemini from './providers/gemini.js';
import * as openai from './providers/openai.js';
import { pickDefaultModel } from './providers/util.js';
import * as chatgptSession from './lib/chatgpt-session.js';
import { readTab } from './lib/page.js';
import { SYSTEM_PROMPT, buildMessages, reserveBudget, sanitizeRequest } from './lib/request.js';
import {
  configuredProviders,
  deleteApiKey,
  getApiKey,
  getModelLists,
  getSettings,
  setApiKey,
  setModelList,
  setSettings,
} from './lib/settings.js';

const PROVIDERS = { gemini, openai, anthropic, chatgpt };
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const IDLE_TIMEOUT_MS = 90000; // 応答が途切れて、この時間が過ぎたら待つのをやめる
const LIST_TIMEOUT_MS = 20000;
const RETRY_DELAYS_MS = [1500, 3500]; // 混雑（5xx）・一時的な制限のとき、自動で再試行する回数と待ち時間
const MAX_RETRY_WAIT_MS = 15000; // 「何秒後に」と言われても、これを超える待ちは再試行せず利用者に任せる

// 中断（停止ボタン）されたら、すぐに待つのをやめる
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });

// ---------------------------------------------------------------- パネルの開閉

// 開閉の状態は、裏方では持たない。
// 裏方（Service Worker）は、しばらく使われないと眠って記憶を失い、起き直したクリックで「開いているか」を
// 取り違えて、パネルが閉じなくなることがあった。そこで、クリックのたびに
//   1. open() を呼ぶ（すでに開いていれば、何も起きない）
//   2. 「クリックした時刻」つきの toggle-request をパネルへ送る
// だけにして、閉じる判断はパネルが自分で行う（クリックより前から開いていたなら、自分で閉じる）。
async function setupPanel() {
  try {
    // ボタンのクリックは自分で受ける（自動で開く設定だと、activeTab が付かない可能性がある）
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch { /* 古いブラウザでは未対応 */ }
}
setupPanel();

chrome.runtime.onInstalled.addListener(() => {
  setupPanel();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'ask-page',
      title: 'このページについてAIに相談',
      contexts: ['page', 'selection'],
    });
  });
});

const notifyPanel = (message) => {
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch { /* 受け手（パネル）がいない */ }
};

// アイコンのクリック。open() は、ユーザー操作の同期区間のうちに呼ぶ（await を挟まない）。
function handleActionClick(tab) {
  const windowId = tab.windowId;
  const at = Date.now();
  chrome.sidePanel.open({ windowId }).catch(() => {});
  notifyPanel({ type: 'toggle-request', windowId, at });
}
chrome.action.onClicked.addListener(handleActionClick);
globalThis.handleActionClick = handleActionClick; // 自動テストから、クリックと同じ処理を呼ぶため

// 右クリック「このページについてAIに相談」: 開いて、このタブを読み直してもらう。
// 右クリックの項目の実行でも activeTab が付与される。
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'ask-page' || !tab) return;
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  notifyPanel({ type: 'refresh-context', tabId: tab.id, windowId: tab.windowId });
});

// ---------------------------------------------------------------- ChatGPT サインインの戻り先の検知

// 公式の戻り先は 127.0.0.1 の HTTP ループバック。拡張機能は待ち受けを持たないので、
// そこへの移動（リクエスト）を観測して、code などを取り出す。観測だけで、通信の内容は変更しない。
// 裏方が眠っている間にログインが進んでも、このイベントで起こされる（待ち受け状態は保存領域にある）。
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (chatgpt.isCallbackUrl(details.url)) onChatGptCallback(details.url, details.tabId);
  },
  { urls: [`${chatgpt.REDIRECT_URI}*`], types: ['main_frame'] },
);

async function onChatGptCallback(url, tabId) {
  const result = await chatgptSession.onCallback(url, tabId);
  if (result.handled && result.ok) {
    try {
      await refreshModels('chatgpt'); // サインインできたら、使えるモデルの一覧も取得する
    } catch { /* 一覧は、設定画面の「一覧を更新」でも取得できる */ }
  }
}

// ---------------------------------------------------------------- 設定・キー

async function publicState() {
  let settings = await getSettings();
  const modelLists = await getModelLists();
  // 選ばれているモデルが一覧にない（以前の一覧に含まれていた画像・音声用など）ときは、既定のモデルに直す
  const fix = {};
  for (const p of Object.keys(modelLists)) {
    const list = modelLists[p];
    if (list.length && !list.some((m) => m.id === settings.models[p])) fix[p] = pickDefaultModel(p, list);
  }
  if (Object.keys(fix).length) settings = await setSettings({ models: fix });
  const configured = await configuredProviders();
  const chatgptStatus = await chatgptSession.status();
  configured.chatgpt = chatgptStatus.signedIn; // ChatGPT は、キーではなく、サインインの有無
  return {
    acknowledged: settings.acknowledged,
    provider: settings.provider,
    models: settings.models,
    rememberKeys: settings.rememberKeys,
    configured,
    modelLists,
    chatgpt: chatgptStatus,
  };
}

// 提供元ごとの「通信に使う資格」。ChatGPT は、必要なら更新したアクセストークン。それ以外は APIキー。
async function credentialFor(provider) {
  if (provider === 'chatgpt') return chatgptSession.getAccessToken();
  return getApiKey(provider);
}

const redact = (text, secret) => (secret ? String(text).split(secret).join('[APIキー]') : String(text));

async function ensureModelSelected(provider, list) {
  const settings = await getSettings();
  if (!list.some((m) => m.id === settings.models[provider])) {
    await setSettings({ models: { [provider]: pickDefaultModel(provider, list) } });
  }
}

async function saveKey(provider, rawKey) {
  const impl = PROVIDERS[provider];
  if (!impl) throw new ProviderError('提供元が不正です。', 'invalid');
  if (provider === 'chatgpt') throw new ProviderError('ChatGPT は、APIキーではなく、サインインで使います。', 'invalid');
  const apiKey = String(rawKey || '').trim();
  if (!/^[\x21-\x7E]{8,512}$/.test(apiKey)) {
    throw new ProviderError('APIキーの形式が正しくありません（英数字と記号のみ、空白を含まない文字列です）。', 'invalid');
  }
  let list;
  try {
    // 保存の前に、実際に一覧を取得して接続を確かめる
    list = await impl.listModels(apiKey, AbortSignal.timeout(LIST_TIMEOUT_MS));
  } catch (e) {
    if (e instanceof ProviderError) throw new ProviderError(redact(e.message, apiKey), e.kind);
    throw new ProviderError('接続を確認できませんでした。ネットワークを確認してください。', 'network');
  }
  if (!list.length) throw new ProviderError(`${impl.label} で使えるモデルが見つかりませんでした。`, 'model');
  await setApiKey(provider, apiKey);
  await setModelList(provider, list);
  await ensureModelSelected(provider, list);
  return { ok: true, count: list.length, ...(await publicState()) };
}

async function refreshModels(provider) {
  const impl = PROVIDERS[provider];
  if (!impl) throw new ProviderError('提供元が不正です。', 'invalid');
  const apiKey = await credentialFor(provider);
  if (!apiKey) throw new ProviderError(`${impl.label} の API キーが設定されていません。`, 'nokey');
  let list;
  try {
    list = await impl.listModels(apiKey, AbortSignal.timeout(LIST_TIMEOUT_MS));
  } catch (e) {
    if (e instanceof ProviderError) throw new ProviderError(redact(e.message, apiKey), e.kind);
    throw new ProviderError('モデル一覧を取得できませんでした。', 'network');
  }
  await setModelList(provider, list);
  if (list.length) await ensureModelSelected(provider, list);
  return { ok: true, count: list.length, ...(await publicState()) };
}

// ---------------------------------------------------------------- 画面からの依頼（1 回きりの応答）

const HANDLERS = {
  'get-state': async () => ({ ok: true, ...(await publicState()) }),
  'set-settings': async (msg) => {
    await setSettings(msg.patch && typeof msg.patch === 'object' ? msg.patch : {});
    return { ok: true, ...(await publicState()) };
  },
  'save-key': (msg) => saveKey(msg.provider, msg.apiKey),
  'delete-key': async (msg) => {
    if (!PROVIDERS[msg.provider] || msg.provider === 'chatgpt') throw new ProviderError('提供元が不正です。', 'invalid');
    await deleteApiKey(msg.provider);
    return { ok: true, ...(await publicState()) };
  },
  'refresh-models': (msg) => refreshModels(msg.provider),
  // ChatGPT のプランでのサインイン。認可の画面を別のタブで開く。結果は、戻り先の検知のあとに、保存領域の変化で伝わる。
  'chatgpt-sign-in': async () => {
    await chatgptSession.startSignIn();
    return { ok: true, ...(await publicState()) };
  },
  'chatgpt-cancel': async () => {
    await chatgptSession.cancelSignIn();
    return { ok: true, ...(await publicState()) };
  },
  'chatgpt-sign-out': async () => {
    await chatgptSession.signOut();
    return { ok: true, ...(await publicState()) };
  },
  'read-page': async (msg) => {
    if (!Number.isInteger(msg.tabId)) throw new ProviderError('タブの指定が不正です。', 'invalid');
    return readTab(msg.tabId);
  },
};

// 自分の拡張機能のページ（パネル・設定画面）からの依頼だけを受け付ける。
const isOwnPage = (sender) =>
  sender && sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));

function errorResult(e) {
  return { ok: false, kind: (e && e.kind) || 'other', message: String((e && e.message) || e).slice(0, 400) };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isOwnPage(sender) || !msg || typeof msg.type !== 'string') return;
  const handler = HANDLERS[msg.type];
  if (!handler) return;
  handler(msg).then(sendResponse, (e) => sendResponse(errorResult(e)));
  return true; // 非同期で応答する
});

// ---------------------------------------------------------------- 相談（ストリーミング）

async function runAsk(port, msg, controllers) {
  const requestId = msg.requestId;
  const post = (m) => {
    try {
      port.postMessage({ requestId, ...m });
    } catch { /* パネルが閉じた */ }
  };
  const controller = new AbortController();
  controllers.set(requestId, controller);
  let apiKey = '';
  let timedOut = false;
  let idleTimer = null;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, IDLE_TIMEOUT_MS);
  };

  try {
    const settings = await getSettings();
    if (!settings.acknowledged) throw new ProviderError('最初に、設定画面で注意事項を確認してください。', 'consent');
    const impl = PROVIDERS[msg.provider];
    if (!impl) throw new ProviderError('提供元が不正です。', 'invalid');
    apiKey = await credentialFor(msg.provider); // ChatGPT のときは、必要なら更新したアクセストークン
    if (!apiKey) throw new ProviderError(`${impl.label} の API キーが設定されていません。設定画面で入力してください。`, 'nokey');
    const model = typeof msg.model === 'string' && MODEL_ID.test(msg.model) ? msg.model : settings.models[msg.provider];
    if (!model) throw new ProviderError('モデルが選ばれていません。設定画面で選んでください。', 'model');

    const request = sanitizeRequest(msg);
    const { messages, chars } = buildMessages(request);
    await reserveBudget(chars);

    let received = 0;
    let authRetried = false;
    for (let attempt = 0; ; attempt++) {
      try {
        armIdle();
        for await (const chunk of impl.stream({ apiKey, model, system: SYSTEM_PROMPT, messages, signal: controller.signal })) {
          armIdle();
          if (chunk.text) {
            received += chunk.text.length;
            post({ type: 'delta', text: chunk.text });
          }
          if (chunk.notice) post({ type: 'notice', text: chunk.notice });
        }
        break;
      } catch (e) {
        // ChatGPT のトークンを、サーバーが 401 で断ったとき: 1 度だけ、強制的に更新して、同じ依頼をやり直す。
        // 更新も断られれば、forceRefresh が、サインインし直しを案内するエラーを投げる。
        if (
          msg.provider === 'chatgpt' &&
          !authRetried &&
          e instanceof ProviderError &&
          e.kind === 'auth' &&
          e.status === 401 &&
          received === 0 &&
          !controller.signal.aborted
        ) {
          authRetried = true;
          apiKey = await chatgptSession.forceRefresh();
          attempt -= 1; // この再送は、混雑の再試行の回数に数えない
          continue;
        }
        // 回答が 1 文字も届いていない段階の「混雑・一時的な制限」だけ、自動で再試行する
        // （途中まで届いた回答をやり直すと、表示が重複・食い違うため）
        const retryable =
          e instanceof ProviderError &&
          received === 0 &&
          !controller.signal.aborted &&
          attempt < RETRY_DELAYS_MS.length &&
          (e.kind === 'server' || (e.kind === 'rate' && (e.retryAfterMs || 0) <= MAX_RETRY_WAIT_MS));
        if (!retryable) throw e;
        const wait = Math.min(Math.max(RETRY_DELAYS_MS[attempt], e.retryAfterMs || 0), MAX_RETRY_WAIT_MS);
        clearTimeout(idleTimer);
        post({ type: 'status', text: `${impl.label} が混み合っています。再試行しています（${attempt + 1}/${RETRY_DELAYS_MS.length}）…` });
        await sleep(wait, controller.signal);
      }
    }
    post({ type: 'done', chars: received });
  } catch (e) {
    if (timedOut) {
      post({ type: 'error', kind: 'timeout', message: '応答が途中で止まりました。もう一度お試しください。' });
    } else if (controller.signal.aborted) {
      post({ type: 'aborted' });
    } else if (e instanceof ProviderError) {
      post({ type: 'error', kind: e.kind, message: redact(e.message, apiKey) });
    } else {
      post({ type: 'error', kind: 'network', message: `通信中にエラーが発生しました: ${redact((e && e.message) || e, apiKey).slice(0, 200)}` });
    }
  } finally {
    clearTimeout(idleTimer);
    controllers.delete(requestId);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'chat' || !isOwnPage(port.sender)) {
    port.disconnect();
    return;
  }
  const controllers = new Map();
  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg.requestId !== 'string') return;
    if (msg.type === 'ask') runAsk(port, msg, controllers);
    else if (msg.type === 'cancel') {
      const c = controllers.get(msg.requestId);
      if (c) c.abort();
    }
  });
  port.onDisconnect.addListener(() => {
    for (const c of controllers.values()) c.abort();
  });
});
