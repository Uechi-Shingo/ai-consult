// 試作の画面。状態は裏方が持ち、この画面は表示と操作だけを行う（トークンは受け取らない）。
const $ = (id) => document.getElementById(id);
const send = (message) => chrome.runtime.sendMessage(message);

const DETECTORS = [
  ['webRequest.onBeforeRequest', 'リクエストの観測（webRequest）'],
  ['webNavigation.onBeforeNavigate', 'ナビゲーションの開始（webNavigation.onBeforeNavigate）'],
  ['webNavigation.onErrorOccurred', 'ナビゲーションの失敗（webNavigation.onErrorOccurred）'],
  ['tabs.onUpdated', 'タブの更新（tabs.onUpdated）'],
];

const fmtTime = (ms) => new Date(ms).toLocaleTimeString();

function li(text, cls) {
  const item = document.createElement('li');
  item.textContent = text;
  if (cls) item.className = cls;
  return item;
}

function setStatus(id, text, kind = '') {
  const node = $(id);
  node.textContent = text;
  node.className = `status${kind ? ` ${kind}` : ''}`;
}

function render(v) {
  $('redirect').textContent = v.redirectUri;

  // 1
  $('start').disabled = !!v.pending;
  $('cancel').disabled = !v.pending;
  if (v.pending) setStatus('start-status', 'OpenAI のログイン画面（別のタブ）で、ログインして承認してください。待ち受け中です…');
  else if (v.token) setStatus('start-status', 'サインイン済みです。', 'ok');
  else setStatus('start-status', '');

  // 2
  const list = $('detections');
  list.textContent = '';
  for (const [via, label] of DETECTORS) {
    const hit = v.detections.find((d) => d.via === via);
    list.append(li(`${hit ? '✓' : '・'} ${label}${hit ? `（${fmtTime(hit.at)}）` : ''}`, hit ? 'ok' : 'muted'));
  }

  // 3
  const dl = $('token');
  dl.textContent = '';
  const row = (k, val, cls) => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = val;
    if (cls) dd.className = cls;
    dl.append(dt, dd);
  };
  if (v.token) {
    row('状態', '取得できました', 'ok');
    row('アカウント', v.email || '（取得できませんでした）');
    row('発行された client_id', v.clientId || '（なし）');
    row('アクセストークン', v.token.accessTokenHint);
    row('有効期限', `${fmtTime(v.token.expiresAt)} まで（あと約 ${Math.max(0, Math.round((v.token.expiresAt - Date.now()) / 60000))} 分）`);
    row('リフレッシュトークン', v.token.hasRefresh ? 'あり' : 'なし', v.token.hasRefresh ? 'ok' : 'error');
    row('付与された権限', v.token.scopes.join(' '));
    row('プランの利用枠（chatgpt.tokens.use.direct）', v.token.hasPlanScope ? '付与されています' : '付与されていません', v.token.hasPlanScope ? 'ok' : 'error');
  } else {
    row('状態', 'まだ取得していません', 'muted');
  }
  $('refresh').disabled = !v.token || !v.token.hasRefresh;
  $('models').disabled = !v.token;
  $('chat').disabled = !v.token;

  // 4
  const models = v.models || [];
  const ml = $('model-list');
  ml.textContent = '';
  for (const m of models) ml.append(li(`${m.name}（${m.slug}）`));
  const select = $('model');
  const prev = select.value;
  select.textContent = '';
  for (const m of models) select.append(new Option(`${m.name}（${m.slug}）`, m.slug));
  if (models.some((m) => m.slug === prev)) select.value = prev;

  // 5
  if (v.lastChat) {
    $('answer').textContent = v.lastChat.answer || '（回答の文字は届きませんでした）';
    setStatus(
      'chat-status',
      v.lastChat.completed
        ? `完了しました（response.completed を確認 / モデル: ${v.lastChat.model}）`
        : `完了しませんでした（${v.lastChat.errorCode || '不明'}）`,
      v.lastChat.completed ? 'ok' : 'error',
    );
  }

  // 経過
  const lg = $('log');
  lg.textContent = '';
  for (const e of [...v.log].reverse()) lg.append(li(`${fmtTime(e.at)}  ${e.text}`));
}

async function refresh() {
  const v = await send({ type: 'view' });
  if (v && v.ok) render(v);
}

async function act(button, statusId, message, busyText) {
  button.disabled = true;
  if (statusId) setStatus(statusId, busyText || '処理しています…');
  const res = await send(message);
  if (statusId) {
    if (res && res.ok) setStatus(statusId, '', '');
    else setStatus(statusId, (res && res.message) || '失敗しました。', 'error');
  }
  await refresh();
  return res;
}

$('start').addEventListener('click', async () => {
  $('start').disabled = true;
  await send({ type: 'start' });
  await refresh();
});
$('cancel').addEventListener('click', () => act($('cancel'), 'start-status', { type: 'cancel' }));
$('refresh').addEventListener('click', async () => {
  const res = await act($('refresh'), 'token-status', { type: 'refresh' }, '更新しています…');
  if (res && res.ok) setStatus('token-status', 'トークンを更新しました。', 'ok');
});
$('models').addEventListener('click', async () => {
  const res = await act($('models'), 'models-status', { type: 'models' }, '取得しています…');
  if (res && res.ok) setStatus('models-status', `${res.count} 件`, 'ok');
});
$('chat').addEventListener('click', async () => {
  const model = $('model').value;
  if (!model) {
    setStatus('chat-status', '先に、モデル一覧を取得して、モデルを選んでください。', 'error');
    return;
  }
  $('answer').textContent = '';
  await act($('chat'), 'chat-status', { type: 'chat', model, text: $('question').value }, '送信しています…');
});
$('sign-out').addEventListener('click', () => act($('sign-out'), null, { type: 'sign-out' }));

chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === 'session' && (changes.spike || changes.tokens)) || (area === 'local' && (changes.clientId || changes.email))) refresh();
});

refresh();
setInterval(refresh, 30000); // 有効期限の表示を更新する
