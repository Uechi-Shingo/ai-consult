// サイドパネルの画面。
// パネルはウィンドウに 1 つで、全タブで共有される。そのため会話は「タブごと」に持ち、
// タブを切り替えたら、そのタブの会話に差し替える（storage.session に保存。ブラウザを閉じると消える）。
import { renderMarkdown } from './lib/markdown.js';

const LABELS = { gemini: 'Gemini', openai: 'OpenAI（APIキー）', anthropic: 'Claude', chatgpt: 'ChatGPT プラン' };
const PROVIDER_ORDER = ['gemini', 'openai', 'anthropic', 'chatgpt'];
const SUGGESTIONS = ['このページを要約して', '重要なポイントを箇条書きで教えて', '専門用語をやさしく説明して'];
const MAX_INPUT_CHARS = 20000;
const bornAt = Date.now(); // このパネルが開かれた時刻（アイコンのクリックより前から開いていたかの判定に使う）

const $ = (id) => document.getElementById(id);
const el = {
  provider: $('provider'),
  model: $('model'),
  contextText: $('context-text'),
  reread: $('reread'),
  permission: $('permission'),
  permissionText: $('permission-text'),
  grantAll: $('grant-all'),
  messages: $('messages'),
  onboarding: $('onboarding'),
  onboardingText: $('onboarding-text'),
  onboardingBtn: $('onboarding-btn'),
  chips: $('chips'),
  input: $('input'),
  send: $('send'),
  stop: $('stop'),
  newChat: $('new-chat'),
  openOptions: $('open-options'),
};

const app = {
  windowId: null,
  tabId: null,
  state: null, // 裏方の get-state の結果（キー自体は含まれない）
  convs: new Map(), // tabId -> 会話
  port: null,
  requests: new Map(), // requestId -> { tabId, msgId }
};

// ---------------------------------------------------------------- 会話

const convKey = (tabId) => `conv:${tabId}`;
const stripHash = (u) => String(u || '').split('#')[0];
let idCounter = 0;
const nextId = () => `m${Date.now().toString(36)}${(idCounter++).toString(36)}`;

function newConv(tabId) {
  return { tabId, messages: [], context: null, url: null, loading: false, busy: false, requestId: null, notice: '', synced: false };
}

async function getConv(tabId) {
  const existing = app.convs.get(tabId);
  if (existing) return existing;
  const key = convKey(tabId);
  let stored = null;
  try {
    stored = (await chrome.storage.session.get(key))[key];
  } catch { /* 読めなければ空の会話から始める */ }
  const again = app.convs.get(tabId); // 待っている間に、別の呼び出しが作っていた場合
  if (again) return again;
  const conv = newConv(tabId);
  if (stored && Array.isArray(stored.messages)) {
    conv.messages = stored.messages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
      .map((m) => ({ id: m.id || nextId(), role: m.role, text: m.text, error: m.error || null, notice: m.notice || '', stopped: !!m.stopped }));
    conv.context = stored.context || null;
    conv.url = stored.url || null;
  }
  app.convs.set(tabId, conv);
  return conv;
}

function persist(conv) {
  const data = {
    messages: conv.messages
      .filter((m) => !m.streaming)
      .map(({ id, role, text, error, notice, stopped }) => ({ id, role, text, error, notice, stopped })),
    context: conv.context,
    url: conv.url,
  };
  chrome.storage.session.set({ [convKey(conv.tabId)]: data }).catch(() => {});
}

const isCurrent = (conv) => conv.tabId === app.tabId;

// ---------------------------------------------------------------- ページの読み取り

async function readContext(conv) {
  conv.loading = true;
  if (isCurrent(conv)) renderContextBar();
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'read-page', tabId: conv.tabId });
  } catch {
    res = null;
  }
  conv.loading = false;
  if (res && res.ok) {
    conv.context = res;
    conv.url = res.url;
  } else {
    let kind = (res && res.kind) || 'other';
    // 「全サイトの許可」がすでに付いているのに「許可がない」と返るページは、許可では解決しない種類のページ
    // （空白のページ・エラー画面・ファイルなど）。許可のボタンを出しても、意味がない。
    if (kind === 'permission' && (await hasAllSites())) kind = 'unreadable';
    conv.context = {
      ok: false,
      kind,
      message: (res && res.message) || 'ページを読み取れませんでした。',
      detail: (res && res.detail) || '',
    };
  }
  persist(conv);
  if (isCurrent(conv)) renderContextBar();
}

async function hasAllSites() {
  try {
    return await chrome.permissions.contains({ origins: ['<all_urls>'] });
  } catch {
    return false;
  }
}

// 読み直して、ページが別のページに変わっていたら、新しい相談にする。
async function syncContext(conv) {
  const before = conv.url;
  await readContext(conv);
  if (!conv.busy && before && conv.url && stripHash(before) !== stripHash(conv.url) && conv.messages.length > 0) {
    conv.messages = [];
    conv.notice = 'ページが変わったため、新しい相談になりました。';
    persist(conv);
  }
}

// ---------------------------------------------------------------- 描画

function canSendProblem() {
  const s = app.state;
  if (!s) return { kind: 'loading', text: '読み込み中です…' };
  if (!s.acknowledged) return { kind: 'ack', text: '最初に、設定画面で注意事項を確認し、APIキーを入力してください。' };
  if (!s.configured[s.provider]) {
    const any = PROVIDER_ORDER.some((p) => s.configured[p]);
    const what = s.provider === 'chatgpt' ? 'にサインインしていません' : 'のAPIキーが未設定です';
    const fix = s.provider === 'chatgpt' ? 'サインインしてください' : '入力してください';
    return {
      kind: 'nokey',
      text: any
        ? `${LABELS[s.provider]} ${what}。上で別の提供元を選ぶか、設定画面で${fix}。`
        : `使える提供元がありません。設定画面で、APIキーを入力するか、ChatGPT にサインインしてください。`,
    };
  }
  if (!s.models[s.provider]) return { kind: 'model', text: 'モデルが選ばれていません。上で選んでください。' };
  return null;
}

function renderSelectors() {
  const s = app.state;
  el.provider.textContent = '';
  el.model.textContent = '';
  if (!s) return;
  const configured = PROVIDER_ORDER.filter((p) => s.configured[p]);
  if (configured.length === 0) {
    const o = new Option('APIキー未設定', '');
    o.disabled = true;
    el.provider.append(o);
    el.provider.disabled = true;
    el.model.disabled = true;
    return;
  }
  el.provider.disabled = false;
  el.model.disabled = false;
  for (const p of configured) el.provider.append(new Option(LABELS[p], p));
  if (configured.includes(s.provider)) el.provider.value = s.provider;
  const list = s.modelLists[s.provider] || [];
  for (const m of list) el.model.append(new Option(m.label || m.id, m.id));
  const cur = s.models[s.provider];
  if (cur && !list.some((m) => m.id === cur)) el.model.append(new Option(cur, cur));
  if (cur) el.model.value = cur;
}

function renderContextBar() {
  const conv = app.convs.get(app.tabId);
  el.permission.hidden = true;
  el.reread.hidden = true;
  el.contextText.title = '';
  if (!conv) {
    el.contextText.textContent = '';
    return;
  }
  if (conv.loading) {
    el.contextText.textContent = 'ページを読み取り中…';
    return;
  }
  const c = conv.context;
  if (!c) {
    el.contextText.textContent = '';
    return;
  }
  el.reread.hidden = false;
  el.contextText.classList.toggle('wrap', !c.ok); // 失敗の説明は、長くても折り返して全部見せる
  if (c.ok) {
    const parts = [c.title || c.url || '（無題のページ）', `約${c.textLength.toLocaleString()}文字`];
    if (c.truncated) parts.push('長いため先頭のみ');
    if (c.selection) parts.push('選択範囲あり');
    el.contextText.textContent = parts.join(' · ');
    el.contextText.title = c.url || '';
    return;
  }
  el.contextText.title = c.detail || '';
  if (c.kind === 'internal') {
    el.contextText.textContent = `${c.message} ページの内容なしで質問できます。`;
  } else if (c.kind === 'unreadable') {
    el.contextText.textContent =
      'このページは、許可があっても拡張機能からは読み取れない種類のページです（ブラウザの内部ページ・空白のページ・エラー画面・ファイルなど）。ページの内容なしで質問できます。';
  } else if (c.kind === 'permission') {
    el.contextText.textContent = 'このページの内容は読み取れていません。';
    el.permission.hidden = false;
    el.permissionText.textContent =
      'このページを読み取る許可がありません。ページ上で右クリックして「このページについてAIに相談」を選ぶと、そのページだけ読み取れます。常に読み取るには、下のボタンで許可してください。';
  } else {
    el.contextText.textContent = c.message || 'このページの内容は読み取れていません。';
  }
}

function renderOnboarding() {
  const problem = canSendProblem();
  const show = !!problem && problem.kind !== 'loading';
  el.onboarding.hidden = !show;
  if (show) el.onboardingText.textContent = problem.text;
}

function updateControls() {
  const conv = app.convs.get(app.tabId);
  const busy = !!(conv && conv.busy);
  const problem = canSendProblem();
  el.send.hidden = busy;
  el.stop.hidden = !busy;
  el.send.disabled = !!problem;
  el.input.disabled = !conv;
  el.chips.textContent = '';
  if (conv && !busy && !problem && conv.messages.length === 0) {
    for (const text of SUGGESTIONS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.addEventListener('click', () => onSend(text));
      el.chips.append(b);
    }
  }
}

const nearBottom = () => el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 80;
const scrollToBottom = () => {
  el.messages.scrollTop = el.messages.scrollHeight;
};

function errorActions(conv, m) {
  const actions = document.createElement('div');
  actions.className = 'actions';
  const add = (label, handler) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', handler);
    actions.append(b);
  };
  const kind = m.error.kind;
  if (!['auth', 'nokey', 'consent', 'model'].includes(kind)) add('もう一度送る', () => retry(conv, m));
  if (['auth', 'nokey', 'consent', 'model'].includes(kind)) add('設定を開く', () => chrome.runtime.openOptionsPage());
  if (['quota', 'rate', 'server', 'timeout', 'network'].includes(kind) && app.state) {
    // 同じ提供元の別のモデル（混雑や無料枠は、モデルごとに違うことがある）
    const s = app.state;
    const others = (s.modelLists[s.provider] || []).filter((x) => x.id !== s.models[s.provider]).slice(0, 3);
    for (const mdl of others) add(`${mdl.label || mdl.id}で続ける`, () => switchModelAndRetry(conv, m, mdl.id));
    // 別の提供元（設定済みのものだけ。有料のものへは、押したときだけ切り替わる）
    for (const p of PROVIDER_ORDER) {
      if (p !== app.state.provider && app.state.configured[p] && app.state.models[p]) {
        add(`${LABELS[p]}で続ける`, () => switchProviderAndRetry(conv, m, p));
      }
    }
  }
  return actions;
}

function fillMessage(wrap, conv, m) {
  const body = wrap.querySelector('.body');
  wrap.classList.toggle('streaming', !!m.streaming);
  if (m.role === 'user') {
    body.textContent = m.text;
    return;
  }
  if (m.text) renderMarkdown(body, m.text);
  else body.textContent = m.status || ''; // 回答が届く前は、再試行などの状況を出す
  const old = wrap.querySelector('.extra');
  if (old) old.remove();
  const notes = [];
  if (m.notice) notes.push(m.notice);
  if (m.stopped) notes.push('（停止しました）');
  if (m.error || notes.length) {
    const extra = document.createElement('div');
    extra.className = `extra${m.error ? ' error' : ''}`;
    extra.textContent = m.error ? m.error.message : notes.join(' ');
    if (m.error) extra.append(errorActions(conv, m));
    wrap.append(extra);
  }
}

function messageElement(conv, m) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${m.role}`;
  wrap.dataset.id = m.id;
  const body = document.createElement('div');
  body.className = 'body';
  wrap.append(body);
  fillMessage(wrap, conv, m);
  return wrap;
}

function renderMessages() {
  const conv = app.convs.get(app.tabId);
  el.messages.textContent = '';
  if (!conv) return;
  if (conv.notice) {
    const note = document.createElement('div');
    note.className = 'system';
    note.textContent = conv.notice;
    el.messages.append(note);
  }
  for (const m of conv.messages) el.messages.append(messageElement(conv, m));
  scrollToBottom();
}

const pendingUpdates = new Set();
function scheduleMessageUpdate(conv, m) {
  if (!isCurrent(conv) || pendingUpdates.has(m.id)) return;
  pendingUpdates.add(m.id);
  requestAnimationFrame(() => {
    pendingUpdates.delete(m.id);
    if (!isCurrent(conv)) return;
    const wrap = el.messages.querySelector(`[data-id="${CSS.escape(m.id)}"]`);
    if (!wrap) return;
    const stick = nearBottom();
    fillMessage(wrap, conv, m);
    if (stick) scrollToBottom();
  });
}

function renderAll() {
  renderSelectors();
  renderContextBar();
  renderMessages();
  renderOnboarding();
  updateControls();
}

// ---------------------------------------------------------------- 裏方との通信

function ensurePort() {
  if (app.port) return app.port;
  const port = chrome.runtime.connect({ name: 'chat' });
  port.onMessage.addListener(onPortMessage);
  port.onDisconnect.addListener(() => {
    if (app.port === port) app.port = null;
    for (const requestId of [...app.requests.keys()]) {
      finishRequest(requestId, { error: { kind: 'network', message: '裏方との接続が切れました。もう一度送信してください。' } });
    }
  });
  app.port = port;
  return port;
}

function finishRequest(requestId, { error = null, stopped = false } = {}) {
  const req = app.requests.get(requestId);
  if (!req) return;
  app.requests.delete(requestId);
  const conv = app.convs.get(req.tabId);
  if (!conv) return;
  const m = conv.messages.find((x) => x.id === req.msgId);
  conv.busy = false;
  conv.requestId = null;
  if (m) {
    m.streaming = false;
    if (error) m.error = error;
    if (stopped) m.stopped = true;
    if (isCurrent(conv)) {
      const wrap = el.messages.querySelector(`[data-id="${CSS.escape(m.id)}"]`);
      if (wrap) fillMessage(wrap, conv, m);
    }
  }
  persist(conv);
  if (isCurrent(conv)) updateControls();
}

function onPortMessage(msg) {
  const req = app.requests.get(msg.requestId);
  if (!req) return;
  const conv = app.convs.get(req.tabId);
  const m = conv && conv.messages.find((x) => x.id === req.msgId);
  if (!conv || !m) return;
  switch (msg.type) {
    case 'delta':
      m.status = '';
      m.text += msg.text;
      scheduleMessageUpdate(conv, m);
      break;
    case 'status':
      m.status = msg.text;
      scheduleMessageUpdate(conv, m);
      break;
    case 'notice':
      m.notice = msg.text;
      scheduleMessageUpdate(conv, m);
      break;
    case 'done':
      finishRequest(msg.requestId);
      break;
    case 'aborted':
      finishRequest(msg.requestId, { stopped: true });
      break;
    case 'error':
      finishRequest(msg.requestId, { error: { kind: msg.kind || 'other', message: msg.message || 'エラーが発生しました。' } });
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------- 送信

function startRequest(conv) {
  const s = app.state;
  const provider = s.provider;
  const model = s.models[provider];
  const assistant = { id: nextId(), role: 'assistant', text: '', streaming: true, error: null, notice: '', stopped: false };
  // 履歴: 失敗した回答（本文なし）は含めない。同じ役割が続く場合は、裏方がまとめる。
  const history = conv.messages.filter((m) => !m.error && !m.streaming && m.text).map(({ role, text }) => ({ role, text }));
  conv.messages.push(assistant);

  const c = conv.context;
  const context = c && c.ok ? { title: c.title, url: c.url, text: c.text, selection: c.selection, truncated: c.truncated } : null;
  const requestId = crypto.randomUUID();
  conv.busy = true;
  conv.requestId = requestId;
  app.requests.set(requestId, { tabId: conv.tabId, msgId: assistant.id });
  try {
    ensurePort().postMessage({ type: 'ask', requestId, provider, model, messages: history, context });
  } catch {
    finishRequest(requestId, { error: { kind: 'network', message: '裏方に接続できませんでした。もう一度お試しください。' } });
  }
  if (isCurrent(conv)) {
    renderMessages();
    updateControls();
  }
}

async function onSend(textOverride) {
  const conv = app.convs.get(app.tabId);
  if (!conv || conv.busy) return;
  const text = (typeof textOverride === 'string' ? textOverride : el.input.value).trim();
  if (!text) return;
  if (canSendProblem()) {
    renderOnboarding();
    return;
  }
  if (text.length > MAX_INPUT_CHARS) {
    conv.notice = `質問が長すぎます（${MAX_INPUT_CHARS.toLocaleString()}文字まで）。`;
    renderMessages();
    return;
  }
  el.input.value = '';
  autosize();
  conv.notice = '';
  // 最初の質問のときは、ページが変わっている可能性があるので読み直してから送る
  if (conv.messages.length === 0) await readContext(conv);
  conv.messages.push({ id: nextId(), role: 'user', text });
  startRequest(conv);
}

function retry(conv, failed) {
  if (conv.busy) return;
  conv.messages = conv.messages.filter((m) => m !== failed);
  persist(conv);
  startRequest(conv);
}

async function switchModelAndRetry(conv, failed, modelId) {
  const provider = app.state.provider;
  const res = await chrome.runtime.sendMessage({ type: 'set-settings', patch: { models: { [provider]: modelId } } });
  if (res && res.ok) {
    app.state = res;
    renderSelectors();
    retry(conv, failed);
  }
}

async function switchProviderAndRetry(conv, failed, provider) {
  const res = await chrome.runtime.sendMessage({ type: 'set-settings', patch: { provider } });
  if (res && res.ok) {
    app.state = res;
    renderSelectors();
    renderOnboarding();
    retry(conv, failed);
  }
}

function cancelCurrent() {
  const conv = app.convs.get(app.tabId);
  if (conv && conv.busy && conv.requestId && app.port) {
    try {
      app.port.postMessage({ type: 'cancel', requestId: conv.requestId });
    } catch { /* すでに切れている */ }
  }
}

function autosize() {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, 140)}px`;
}

// ---------------------------------------------------------------- 状態・タブの切り替え

async function loadState() {
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'get-state' });
  } catch {
    res = null;
  }
  if (res && res.ok) {
    app.state = res;
    renderSelectors();
    renderOnboarding();
    updateControls();
  }
}

async function showTab(tabId) {
  app.tabId = tabId;
  const conv = await getConv(tabId);
  if (app.tabId !== tabId) return; // 待っている間に、さらに切り替わった
  renderAll();
  if (!conv.synced) {
    conv.synced = true;
    await syncContext(conv);
    if (isCurrent(conv)) renderAll();
  }
}

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (windowId === app.windowId) showTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete' || !tab || tab.windowId !== app.windowId) return;
  const conv = app.convs.get(tabId);
  if (!conv || conv.loading || !conv.synced) return; // まだ見ていないタブは、表示したときに読む
  syncContext(conv).then(() => {
    if (isCurrent(conv)) renderAll();
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  app.convs.delete(tabId);
  chrome.storage.session.remove(convKey(tabId)).catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  // 設定・モデル一覧・APIキー・ChatGPT のサインイン情報が変わったら、状態を取り直す
  const secrets = changes.apiKeys || changes.chatgptAuth;
  if ((area === 'local' && (changes.settings || changes.modelLists || secrets)) || (area === 'session' && secrets)) {
    loadState();
  }
});

async function closeSelf() {
  try {
    if (typeof chrome.sidePanel.close === 'function') {
      await chrome.sidePanel.close({ windowId: app.windowId });
      return;
    }
  } catch { /* 下で window.close() を試す */ }
  window.close();
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id || !msg || msg.windowId !== app.windowId) return;
  if (msg.type === 'toggle-request') {
    // アイコンがクリックされた。クリックより前から開いていたパネルは、自分で閉じる。
    // （そのクリックで新しく開かれたパネルは、閉じない。開閉の判断を、裏方の記憶に頼らないため）
    if (Number.isFinite(msg.at) && bornAt < msg.at) closeSelf();
  } else if (msg.type === 'refresh-context' && Number.isInteger(msg.tabId)) {
    (async () => {
      const conv = await getConv(msg.tabId);
      conv.synced = true;
      await syncContext(conv);
      if (app.tabId !== msg.tabId) await showTab(msg.tabId);
      else renderAll();
    })();
  }
});

// ---------------------------------------------------------------- 操作

el.send.addEventListener('click', () => onSend());
el.stop.addEventListener('click', cancelCurrent);
el.input.addEventListener('input', autosize);
el.input.addEventListener('keydown', (e) => {
  // 日本語入力の変換確定の Enter では送信しない
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    onSend();
  }
});

el.newChat.addEventListener('click', () => {
  const conv = app.convs.get(app.tabId);
  if (!conv) return;
  cancelCurrent();
  conv.messages = [];
  conv.notice = '';
  persist(conv);
  renderAll();
});

$('close-panel').addEventListener('click', closeSelf); // 会話は、タブごとに保存されているので、閉じても消えない
el.openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());
el.onboardingBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());

el.reread.addEventListener('click', async () => {
  const conv = app.convs.get(app.tabId);
  if (!conv) return;
  await syncContext(conv);
  if (isCurrent(conv)) renderAll();
});

el.grantAll.addEventListener('click', async () => {
  // 結果を、必ず画面に出す（何も変わらないように見えるのを避ける）
  el.grantAll.disabled = true;
  el.permissionText.textContent = '許可を確認しています…（ブラウザの確認が出たら、「許可」を選んでください）';
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
  } catch (e) {
    el.permissionText.textContent = `許可を要求できませんでした: ${e && e.message ? e.message : e}`;
    el.grantAll.disabled = false;
    return;
  }
  el.grantAll.disabled = false;
  if (!granted) {
    el.permissionText.textContent =
      '許可されませんでした。ブラウザの確認が出ていないか、拒否された可能性があります。確認は、ツールバーの拡張機能のアイコンの近くに出ます。';
    return;
  }
  el.permissionText.textContent = '許可されました。ページを読み直しています…';
  const conv = app.convs.get(app.tabId);
  if (conv) {
    await readContext(conv);
    if (isCurrent(conv)) renderAll();
  }
});

el.provider.addEventListener('change', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'set-settings', patch: { provider: el.provider.value } });
  if (res && res.ok) {
    app.state = res;
    renderAll();
  }
});

el.model.addEventListener('change', async () => {
  const provider = app.state.provider;
  const res = await chrome.runtime.sendMessage({ type: 'set-settings', patch: { models: { [provider]: el.model.value } } });
  if (res && res.ok) {
    app.state = res;
    renderAll();
  }
});

// ---------------------------------------------------------------- 起動

(async function init() {
  const win = await chrome.windows.getCurrent();
  app.windowId = win.id;
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  await loadState();
  const [tab] = await chrome.tabs.query({ active: true, windowId: app.windowId });
  if (tab) await showTab(tab.id);
  else renderAll();
})();
