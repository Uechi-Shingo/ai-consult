// 設定・APIキー・モデル一覧の保存。
// - 設定とモデル一覧（秘密ではない）: storage.local
// - APIキー: 「保存しておく」なら storage.local、そうでなければ storage.session（ブラウザを閉じると消える）

import { isChatModel } from '../providers/util.js';

// chatgpt は、APIキーではなく、ChatGPT のプランでサインインして使う提供元（OpenAI の Sign in with ChatGPT）
export const PROVIDER_IDS = ['gemini', 'openai', 'anthropic', 'chatgpt'];

const DEFAULTS = {
  provider: 'gemini',
  models: { gemini: '', openai: '', anthropic: '', chatgpt: '' },
  acknowledged: false, // 初回の注意事項を確認したか
  rememberKeys: true,
};
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

// 保存領域を、ページに差し込んだスクリプトからは読めないようにする（既定では読めてしまう領域がある）。
for (const area of [chrome.storage.local, chrome.storage.session]) {
  try {
    area.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch { /* 古いブラウザでは未対応。既定の動作のまま */ }
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = settings && typeof settings === 'object' ? settings : {};
  const models = { ...DEFAULTS.models };
  for (const p of PROVIDER_IDS) {
    if (s.models && typeof s.models[p] === 'string' && MODEL_ID.test(s.models[p])) models[p] = s.models[p];
  }
  return {
    provider: PROVIDER_IDS.includes(s.provider) ? s.provider : DEFAULTS.provider,
    models,
    acknowledged: s.acknowledged === true,
    rememberKeys: s.rememberKeys !== false,
  };
}

// patch: { provider?, models?: {gemini?,...}, acknowledged?, rememberKeys? }
export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, models: { ...current.models } };
  if (patch.provider !== undefined) {
    if (!PROVIDER_IDS.includes(patch.provider)) throw new Error('提供元が不正です。');
    next.provider = patch.provider;
  }
  if (patch.models && typeof patch.models === 'object') {
    for (const [p, m] of Object.entries(patch.models)) {
      if (PROVIDER_IDS.includes(p) && typeof m === 'string' && (m === '' || MODEL_ID.test(m))) next.models[p] = m;
    }
  }
  if (patch.acknowledged !== undefined) next.acknowledged = patch.acknowledged === true;
  if (patch.rememberKeys !== undefined) next.rememberKeys = patch.rememberKeys === true;

  if (next.rememberKeys !== current.rememberKeys) await moveKeys(next.rememberKeys);
  await chrome.storage.local.set({ settings: next });
  return next;
}

// ---------------------------------------------------------------- APIキー

async function moveKeys(toLocal) {
  const from = toLocal ? chrome.storage.session : chrome.storage.local;
  const to = toLocal ? chrome.storage.local : chrome.storage.session;
  const { apiKeys: moving = {} } = await from.get('apiKeys');
  const { apiKeys: existing = {} } = await to.get('apiKeys');
  await to.set({ apiKeys: { ...existing, ...moving } });
  await from.remove('apiKeys');
  // ChatGPT のサインイン情報（トークン）も、APIキーと同じ扱いで移す
  const { chatgptAuth } = await from.get('chatgptAuth');
  if (chatgptAuth) {
    await to.set({ chatgptAuth });
    await from.remove('chatgptAuth');
  }
}

async function keyArea() {
  const { rememberKeys } = await getSettings();
  return rememberKeys ? chrome.storage.local : chrome.storage.session;
}

// 秘密（APIキー・トークン）を置く保存領域。「保存しておく」の設定に従う。
export const secretArea = keyArea;

export async function getApiKey(provider) {
  const { apiKeys = {} } = await (await keyArea()).get('apiKeys');
  return typeof apiKeys[provider] === 'string' ? apiKeys[provider] : '';
}

export async function setApiKey(provider, key) {
  const area = await keyArea();
  const { apiKeys = {} } = await area.get('apiKeys');
  await area.set({ apiKeys: { ...apiKeys, [provider]: key } });
}

export async function deleteApiKey(provider) {
  const area = await keyArea();
  const { apiKeys = {} } = await area.get('apiKeys');
  delete apiKeys[provider];
  await area.set({ apiKeys });
}

// 各社のキーが設定済みかどうか（キー自体は返さない）
export async function configuredProviders() {
  const { apiKeys = {} } = await (await keyArea()).get('apiKeys');
  const out = {};
  for (const p of PROVIDER_IDS) out[p] = typeof apiKeys[p] === 'string' && apiKeys[p].length > 0;
  return out;
}

// ---------------------------------------------------------------- モデル一覧

export async function getModelLists() {
  const { modelLists } = await chrome.storage.local.get('modelLists');
  const out = {};
  for (const p of PROVIDER_IDS) {
    const list = modelLists && Array.isArray(modelLists[p]) ? modelLists[p] : [];
    // 以前に保存した一覧に、画像生成・音声用などが残っていても、ここで除く
    out[p] = list
      .filter((m) => m && typeof m.id === 'string' && MODEL_ID.test(m.id))
      .map((m) => ({ id: m.id, label: typeof m.label === 'string' ? m.label : m.id }))
      .filter((m) => isChatModel(m.id, m.label));
  }
  return out;
}

export async function setModelList(provider, list) {
  const all = await getModelLists();
  all[provider] = list;
  await chrome.storage.local.set({ modelLists: all });
}
