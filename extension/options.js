// 設定画面。変更は「保存」を押したときにまとめて反映する（押すまでは、保存されない）。
// APIキー・トークンは裏方だけが持つ。この画面は「設定済みかどうか」しか受け取らない。
// 例外: ChatGPT のサインイン・サインアウトは、押した時点ですぐ実行される（「保存」は不要）。

const PROVIDERS = [
  { id: 'gemini', type: 'key', label: 'Gemini（Google）', hint: 'Google AI Studio（aistudio.google.com/apikey）で発行できます。無料枠があります。' },
  { id: 'openai', type: 'key', label: 'OpenAI（APIキー）', hint: 'platform.openai.com で発行します。API は有料（従量課金）です。' },
  { id: 'anthropic', type: 'key', label: 'Claude（Anthropic）', hint: 'console.anthropic.com で発行します。API は有料（従量課金）です。' },
  {
    id: 'chatgpt',
    type: 'signin',
    label: 'ChatGPT のプラン（サインイン）',
    hint:
      'APIキーの代わりに、ChatGPT の Plus / Pro などのプランの利用枠を使います（OpenAI の「Sign in with ChatGPT」）。' +
      '利用枠は ChatGPT・Codex と共有され、アプリごとの上限は ChatGPT の「設定 → 使用状況」で決められます。' +
      'OpenAI は、この仕組みを個人用・オープンソースのツール向けとして公開していますが、ブラウザの拡張機能での利用は、公式には明記されていません。',
  },
];

const $ = (id) => document.getElementById(id);
const send = (message) => chrome.runtime.sendMessage(message);

let state = null; // 保存済みの状態（裏方から受け取ったもの）
let draft = null; // 画面で編集中の内容（保存するまで、裏方には送らない）
const touched = new Set(); // 利用者が編集した項目（外から状態が変わっても、これらは上書きしない）
let closeArmed = false; // 未保存のまま「閉じる」を 1 回押した状態
let discarding = false; // 変更を破棄して閉じている途中
let saving = false;

const cloneDraft = (s) => ({ acknowledged: s.acknowledged, rememberKeys: s.rememberKeys, provider: s.provider, models: { ...s.models } });
const root = (id) => document.querySelector(`.provider[data-id="${id}"]`);
const typedKey = (id) => {
  const input = root(id).querySelector('.key');
  return input ? input.value.trim() : '';
};

function setProviderStatus(id, text, kind = '') {
  const node = root(id).querySelector('.status.action') || root(id).querySelector('.status');
  const isAction = node.classList.contains('action');
  node.textContent = text;
  node.className = `status${isAction ? ' action' : ''}${kind ? ` ${kind}` : ''}`;
}

function setSaveStatus(text, kind = '') {
  const node = $('save-status');
  node.textContent = text;
  node.className = `status${kind ? ` ${kind}` : ''}`;
}

function isDirty() {
  if (!state || !draft) return false;
  if (draft.acknowledged !== state.acknowledged || draft.rememberKeys !== state.rememberKeys || draft.provider !== state.provider) return true;
  if (PROVIDERS.some((p) => draft.models[p.id] !== state.models[p.id])) return true;
  return PROVIDERS.some((p) => typedKey(p.id) !== '');
}

function refreshDirty() {
  const dirty = isDirty();
  $('dirty').textContent = dirty ? '未保存の変更があります' : '';
  $('dirty').className = `dirty${dirty ? ' warn' : ''}`;
  closeArmed = false;
  $('close').textContent = '閉じる';
}

// 編集されたとき（保存済みのメッセージは、いったん消す）
function onEdited(field) {
  if (field) touched.add(field);
  setSaveStatus('');
  refreshDirty();
}

// ---------------------------------------------------------------- 提供元ごとの部品

function modelRow(p) {
  const row = document.createElement('div');
  row.className = 'row';
  const label = document.createElement('label');
  label.textContent = 'モデル ';
  const model = document.createElement('select');
  model.className = 'model';
  label.append(model);
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'refresh';
  refresh.textContent = '一覧を更新';
  row.append(label, refresh);

  model.addEventListener('change', () => {
    draft.models[p.id] = model.value;
    onEdited(`models.${p.id}`);
  });
  refresh.addEventListener('click', async () => {
    refresh.disabled = true;
    setProviderStatus(p.id, 'モデル一覧を取得しています…');
    const res = await send({ type: 'refresh-models', provider: p.id });
    refresh.disabled = false;
    if (res && res.ok) {
      state = res;
      syncDraft();
      render();
      setProviderStatus(p.id, `モデル一覧を更新しました（${res.count} 件）。`, 'ok');
    } else {
      setProviderStatus(p.id, (res && res.message) || '更新できませんでした。', 'error');
    }
  });
  return row;
}

function buildKeyProvider(p) {
  const el = document.createElement('div');
  el.className = 'provider';
  el.dataset.id = p.id;

  const h = document.createElement('h3');
  h.textContent = p.label;
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = p.hint;

  const keyRow = document.createElement('div');
  keyRow.className = 'row';
  const input = document.createElement('input');
  input.type = 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.className = 'key';
  input.setAttribute('aria-label', `${p.label} のAPIキー`);
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'delete';
  del.textContent = '保存済みのキーを削除';
  keyRow.append(input, del);

  const note = document.createElement('p');
  note.className = 'hint';
  note.textContent = '入力したキーは、「保存」を押したときに接続を確認してから保存します。';

  const status = document.createElement('p');
  status.className = 'status';

  el.append(h, hint, keyRow, note, status, modelRow(p));

  input.addEventListener('input', () => onEdited());
  del.addEventListener('click', async () => {
    const res = await send({ type: 'delete-key', provider: p.id });
    if (res && res.ok) {
      state = res;
      syncDraft();
      render();
      setProviderStatus(p.id, 'APIキーを削除しました。', 'ok');
    } else {
      setProviderStatus(p.id, (res && res.message) || '削除できませんでした。', 'error');
    }
  });
  return el;
}

function buildSignIn(p) {
  const el = document.createElement('div');
  el.className = 'provider';
  el.dataset.id = p.id;

  const h = document.createElement('h3');
  h.textContent = p.label;
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = p.hint;

  const stateLine = document.createElement('p');
  stateLine.className = 'status state';

  const row = document.createElement('div');
  row.className = 'row';
  const signIn = document.createElement('button');
  signIn.type = 'button';
  signIn.className = 'signin primary';
  signIn.textContent = 'ChatGPT でサインイン';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'cancel';
  cancel.textContent = '待ち受けをやめる';
  const signOut = document.createElement('button');
  signOut.type = 'button';
  signOut.className = 'signout';
  signOut.textContent = 'サインアウト';
  row.append(signIn, cancel, signOut);

  const note = document.createElement('p');
  note.className = 'hint';
  note.textContent =
    'サインインは、押すとすぐ実行されます（「保存」は不要）。別のタブで OpenAI のログイン画面が開くので、ログインして承認してください。' +
    'サインアウトは、この拡張機能に保存した情報を消します。ChatGPT 側の接続は、ChatGPT の「設定 → セキュリティとログイン」で解除できます。';

  const action = document.createElement('p');
  action.className = 'status action';

  el.append(h, hint, stateLine, row, note, action, modelRow(p));

  signIn.addEventListener('click', async () => {
    signIn.disabled = true;
    setProviderStatus(p.id, 'ログイン画面を開いています…');
    const res = await send({ type: 'chatgpt-sign-in' });
    if (res && res.ok) {
      state = res;
      syncDraft();
      render();
      setProviderStatus(p.id, '');
    } else {
      signIn.disabled = false;
      setProviderStatus(p.id, (res && res.message) || 'サインインを始められませんでした。', 'error');
    }
  });
  cancel.addEventListener('click', async () => {
    const res = await send({ type: 'chatgpt-cancel' });
    if (res && res.ok) {
      state = res;
      syncDraft();
      render();
    }
  });
  signOut.addEventListener('click', async () => {
    const res = await send({ type: 'chatgpt-sign-out' });
    if (res && res.ok) {
      state = res;
      syncDraft();
      render();
      setProviderStatus(p.id, 'サインアウトしました（この拡張機能に保存した情報を消しました）。', 'ok');
    }
  });
  return el;
}

// ---------------------------------------------------------------- 描画

// 外から状態が変わったとき（別のタブでのサインイン完了など）、編集していない項目だけを、保存済みの内容に合わせる
function syncDraft() {
  if (!draft) {
    draft = cloneDraft(state);
    return;
  }
  const fresh = cloneDraft(state);
  for (const key of ['acknowledged', 'rememberKeys', 'provider']) if (!touched.has(key)) draft[key] = fresh[key];
  for (const p of PROVIDERS) if (!touched.has(`models.${p.id}`)) draft.models[p.id] = fresh.models[p.id];
}

function renderSignInState(el) {
  const c = state.chatgpt || {};
  const line = el.querySelector('.status.state');
  let text;
  let kind = '';
  if (c.pending) {
    text = 'ログイン画面（別のタブ）で、ログインして承認してください。待ち受け中です…';
  } else if (c.signedIn) {
    text = `サインイン済み: ${c.email || '（アカウント不明）'}${c.hasPlanScope ? '' : '（利用枠の権限がありません）'}`;
    kind = c.hasPlanScope ? 'ok' : 'error';
  } else if (c.last && !c.last.ok) {
    text = `サインインできませんでした: ${c.last.message}`;
    kind = 'error';
  } else {
    text = 'サインインしていません。';
  }
  line.textContent = text;
  line.className = `status state${kind ? ` ${kind}` : ''}`;
  el.querySelector('.signin').disabled = !!c.pending;
  el.querySelector('.cancel').hidden = !c.pending;
  el.querySelector('.signout').hidden = !c.signedIn;
}

function render() {
  if (!state) return;
  if (!draft) draft = cloneDraft(state);
  $('ack').checked = draft.acknowledged;
  $('remember').checked = draft.rememberKeys;

  for (const p of PROVIDERS) {
    const el = root(p.id);
    const configured = state.configured[p.id];
    if (p.type === 'key') {
      el.querySelector('.key').placeholder = configured ? '（保存済み。変更するときだけ入力）' : 'APIキーを貼り付け';
      el.querySelector('.delete').disabled = !configured;
    } else {
      renderSignInState(el);
    }
    const select = el.querySelector('.model');
    select.textContent = '';
    const list = state.modelLists[p.id] || [];
    for (const m of list) select.append(new Option(m.label || m.id, m.id));
    const cur = draft.models[p.id];
    if (cur && !list.some((m) => m.id === cur)) select.append(new Option(cur, cur));
    if (cur) select.value = cur;
    select.disabled = !configured || list.length === 0;
    el.querySelector('.refresh').disabled = !configured;
  }

  const def = $('default-provider');
  def.textContent = '';
  const configuredList = PROVIDERS.filter((p) => state.configured[p.id]);
  if (configuredList.length === 0) {
    const o = new Option('（APIキーを保存するか、サインインすると選べます）', '');
    o.disabled = true;
    def.append(o);
    def.disabled = true;
  } else {
    def.disabled = false;
    for (const p of configuredList) def.append(new Option(p.label, p.id));
    if (configuredList.some((p) => p.id === draft.provider)) def.value = draft.provider;
  }
  refreshDirty();
}

// ---------------------------------------------------------------- 保存・閉じる

function setBusy(busy) {
  saving = busy;
  for (const id of ['save', 'save-close', 'close']) $(id).disabled = busy;
}

// 戻り値: すべて保存できたら true
async function saveAll() {
  if (saving) return false;
  setBusy(true);
  setSaveStatus('保存しています…');
  for (const p of PROVIDERS) setProviderStatus(p.id, '');
  let ok = true;
  const initial = state;

  // 1) 設定（変更した項目だけを送る。キーの保存で自動選択されたモデルを、上書きしないため）
  const patch = {};
  if (draft.acknowledged !== initial.acknowledged) patch.acknowledged = draft.acknowledged;
  if (draft.rememberKeys !== initial.rememberKeys) patch.rememberKeys = draft.rememberKeys;
  if (draft.provider !== initial.provider) patch.provider = draft.provider;
  const models = {};
  for (const p of PROVIDERS) if (draft.models[p.id] !== initial.models[p.id]) models[p.id] = draft.models[p.id];
  if (Object.keys(models).length) patch.models = models;
  if (Object.keys(patch).length) {
    const res = await send({ type: 'set-settings', patch });
    if (res && res.ok) state = res;
    else {
      ok = false;
      setSaveStatus((res && res.message) || '設定を保存できませんでした。', 'error');
    }
  }

  // 2) 入力されたキー（接続を確認してから保存する）
  for (const p of PROVIDERS.filter((x) => x.type === 'key')) {
    const key = typedKey(p.id);
    if (!key) continue;
    setProviderStatus(p.id, '接続を確認しています…');
    const res = await send({ type: 'save-key', provider: p.id, apiKey: key });
    if (res && res.ok) {
      root(p.id).querySelector('.key').value = '';
      state = res;
      setProviderStatus(p.id, `保存しました（利用できるモデル ${res.count} 件）。`, 'ok');
    } else {
      ok = false;
      setProviderStatus(p.id, `保存できませんでした: ${(res && res.message) || '不明なエラー'}`, 'error');
    }
  }

  // 3) 保存した内容を、編集中の内容にも反映する（保存できなかったキーの入力は、そのまま残る）
  touched.clear();
  draft = cloneDraft(state);
  render();
  setBusy(false);
  if (ok) setSaveStatus('保存しました。', 'ok');
  else if (!$('save-status').classList.contains('error')) {
    setSaveStatus('保存できなかった項目があります。上の表示を確認してください。', 'error');
  }
  return ok;
}

async function closeTab() {
  discarding = true;
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab && tab.id !== undefined) {
      await chrome.tabs.remove(tab.id);
      return;
    }
  } catch { /* 下で window.close() を試す */ }
  window.close();
}

$('save').addEventListener('click', () => {
  saveAll();
});

$('save-close').addEventListener('click', async () => {
  if (await saveAll()) closeTab();
});

$('close').addEventListener('click', () => {
  if (isDirty() && !closeArmed) {
    closeArmed = true;
    $('close').textContent = '変更を破棄して閉じる';
    setSaveStatus('未保存の変更があります。保存するには「保存して閉じる」を、破棄するには、もう一度このボタンを押してください。', 'error');
    return;
  }
  closeTab();
});

// タブの「×」などで閉じようとしたとき、未保存の変更があれば確認を出す
window.addEventListener('beforeunload', (e) => {
  if (!discarding && isDirty()) {
    e.preventDefault();
    e.returnValue = '';
  }
});

$('ack').addEventListener('change', (e) => {
  draft.acknowledged = e.target.checked;
  onEdited('acknowledged');
});
$('remember').addEventListener('change', (e) => {
  draft.rememberKeys = e.target.checked;
  onEdited('rememberKeys');
});
$('default-provider').addEventListener('change', (e) => {
  draft.provider = e.target.value;
  onEdited('provider');
});

// 別のタブでのサインイン完了など、画面の外で状態が変わったとき
async function reloadState() {
  if (saving) return;
  const res = await send({ type: 'get-state' });
  if (res && res.ok) {
    state = res;
    syncDraft();
    render();
  }
}
chrome.storage.onChanged.addListener((changes, area) => {
  const relevant =
    (area === 'session' && (changes.chatgptPending || changes.chatgptLast || changes.chatgptAuth)) ||
    (area === 'local' && (changes.chatgptAuth || changes.chatgptReg || changes.modelLists));
  if (relevant) reloadState();
});

(async function init() {
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  const holder = $('providers');
  for (const p of PROVIDERS) {
    const card = document.createElement('div');
    card.className = 'card';
    card.append(p.type === 'signin' ? buildSignIn(p) : buildKeyProvider(p));
    holder.append(card);
  }
  const res = await send({ type: 'get-state' });
  if (res && res.ok) {
    state = res;
    draft = cloneDraft(state);
    render();
  }
})();
