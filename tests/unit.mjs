// 部品ごとの自動テスト（ブラウザ不要）。通信は偽の fetch に差し替える。
// 実行: node --test tests/unit.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderError, classifyHttpError } from '../extension/providers/errors.js';
import { parseSse } from '../extension/providers/sse.js';
import { filterChatModels, isChatModel, pickDefaultModel, sortNewestFirst } from '../extension/providers/util.js';
import * as anthropic from '../extension/providers/anthropic.js';
import * as chatgpt from '../extension/providers/chatgpt.js';
import * as gemini from '../extension/providers/gemini.js';
import * as openai from '../extension/providers/openai.js';
import { classifyReadError } from '../extension/lib/page.js';
import { LIMITS, buildMessages, sanitizeRequest } from '../extension/lib/request.js';

const enc = new TextEncoder();

function streamOf(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === 'string' ? enc.encode(c) : c);
      controller.close();
    },
  });
}

async function collect(iterable) {
  const out = [];
  for await (const x of iterable) out.push(x);
  return out;
}

// fetch を差し替えて、送られた依頼を記録する
function mockFetch(responder) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const headers = {};
    new Headers(init.headers || {}).forEach((v, k) => {
      headers[k] = v;
    });
    let body = null;
    if (init.body) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = String(init.body); // フォームなど、JSON ではない本文
      }
    }
    calls.push({ url: String(url), headers, body });
    return responder(String(url), init);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const sseResponse = (chunks) => new Response(streamOf(chunks), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const sse = (obj, event) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(obj)}\n\n`;

// ---------------------------------------------------------------- SSE

test('SSE: チャンクの境界・CRLF・コメント・複数行 data を正しく分解する', async () => {
  const text = ': ping\r\n\r\nevent: a\r\ndata: 1\r\n\r\ndata: x\ndata: y\n\nevent: b\ndata: 2\n\n';
  const bytes = enc.encode(text);
  // 1 バイトずつに分割しても、同じ結果になること
  const chunks = [...bytes].map((b) => new Uint8Array([b]));
  const events = await collect(parseSse(streamOf(chunks)));
  assert.deepEqual(events, [
    { event: 'a', data: '1' },
    { event: '', data: 'x\ny' },
    { event: 'b', data: '2' },
  ]);
});

test('SSE: マルチバイト文字がチャンクの途中で切れても壊れない', async () => {
  const bytes = enc.encode('data: こんにちは世界\n\n');
  const events = await collect(parseSse(streamOf([bytes.slice(0, 8), bytes.slice(8, 15), bytes.slice(15)])));
  assert.deepEqual(events, [{ event: '', data: 'こんにちは世界' }]);
});

test('SSE: 最後の空行がなくても、残りを返す', async () => {
  const events = await collect(parseSse(streamOf(['data: last'])));
  assert.deepEqual(events, [{ event: '', data: 'last' }]);
});

// ---------------------------------------------------------------- Gemini

test('Gemini: 依頼の形式（URL にキーを載せない・ヘッダー・役割の変換）', async () => {
  const body = sse({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] });
  const m = mockFetch(() => sseResponse([body]));
  try {
    const out = await collect(
      gemini.stream({
        apiKey: 'KEY-123456',
        model: 'gemini-test',
        system: 'SYS',
        messages: [{ role: 'user', text: 'Q1' }, { role: 'assistant', text: 'A1' }, { role: 'user', text: 'Q2' }],
      }),
    );
    assert.deepEqual(out, [{ text: 'OK' }]);
    const call = m.calls[0];
    assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse');
    assert.ok(!call.url.includes('KEY-123456'));
    assert.equal(call.headers['x-goog-api-key'], 'KEY-123456');
    assert.deepEqual(call.body.systemInstruction, { parts: [{ text: 'SYS' }] });
    assert.deepEqual(call.body.contents.map((c) => c.role), ['user', 'model', 'user']);
  } finally {
    m.restore();
  }
});

test('Gemini: 考え中のメモ（thought）は出さず、MAX_TOKENS は通知にする', async () => {
  const m = mockFetch(() =>
    sseResponse([
      sse({ candidates: [{ content: { parts: [{ text: '考え中', thought: true }, { text: '答え' }] } }] }),
      sse({ candidates: [{ content: { parts: [{ text: '続き' }] }, finishReason: 'MAX_TOKENS' }] }),
    ]),
  );
  try {
    const out = await collect(gemini.stream({ apiKey: 'k-1234567', model: 'm', system: 's', messages: [{ role: 'user', text: 'q' }] }));
    assert.deepEqual(out.map((x) => x.text).filter(Boolean), ['答え', '続き']);
    assert.ok(out.some((x) => x.notice));
  } finally {
    m.restore();
  }
});

test('Gemini: 内容を理由に止められたら content エラー', async () => {
  const m = mockFetch(() => sseResponse([sse({ promptFeedback: { blockReason: 'SAFETY' } })]));
  try {
    await assert.rejects(
      collect(gemini.stream({ apiKey: 'k-1234567', model: 'm', system: 's', messages: [{ role: 'user', text: 'q' }] })),
      (e) => e instanceof ProviderError && e.kind === 'content',
    );
  } finally {
    m.restore();
  }
});

test('Gemini: モデル一覧は generateContent 対応の gemini だけを、新しい順に返す', async () => {
  const m = mockFetch(() =>
    new Response(
      JSON.stringify({
        models: [
          { name: 'models/gemini-2.5-flash', displayName: 'G 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-3.5-flash', displayName: 'G 3.5 Flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
          { name: 'models/gemini-embedding', supportedGenerationMethods: ['embedContent'] },
          // generateContent に対応していても、画像生成・音声用は除く
          { name: 'models/gemini-2.5-flash-image', displayName: 'Nano Banana', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-2.5-flash-preview-tts', displayName: 'Gemini 2.5 Flash TTS', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-2.5-flash-native-audio-preview', displayName: 'Native Audio', supportedGenerationMethods: ['generateContent'] },
        ],
      }),
      { status: 200 },
    ),
  );
  try {
    const list = await gemini.listModels('k-1234567');
    assert.deepEqual(list.map((x) => x.id), ['gemini-3.5-flash', 'gemini-2.5-flash']);
  } finally {
    m.restore();
  }
});

// ---------------------------------------------------------------- OpenAI

test('OpenAI: Responses API の依頼の形式（store: false・stream・役割）と、差分の取り出し', async () => {
  const m = mockFetch(() =>
    sseResponse([
      sse({ type: 'response.output_text.delta', delta: 'Hel' }, 'response.output_text.delta'),
      sse({ type: 'response.output_text.delta', delta: 'lo' }, 'response.output_text.delta'),
      sse({ type: 'response.completed', response: {} }, 'response.completed'),
    ]),
  );
  try {
    const out = await collect(
      openai.stream({ apiKey: 'sk-test-1234567', model: 'gpt-test', system: 'SYS', messages: [{ role: 'user', text: 'Q' }] }),
    );
    assert.equal(out.map((x) => x.text).join(''), 'Hello');
    const call = m.calls[0];
    assert.equal(call.url, 'https://api.openai.com/v1/responses');
    assert.equal(call.headers.authorization, 'Bearer sk-test-1234567');
    assert.equal(call.body.stream, true);
    assert.equal(call.body.store, false);
    assert.equal(call.body.instructions, 'SYS');
    assert.deepEqual(call.body.input, [{ role: 'user', content: 'Q' }]);
  } finally {
    m.restore();
  }
});

test('OpenAI: response.failed はエラーにする', async () => {
  const m = mockFetch(() => sseResponse([sse({ type: 'response.failed', response: { error: { message: 'boom' } } })]));
  try {
    await assert.rejects(
      collect(openai.stream({ apiKey: 'sk-test-1234567', model: 'm', system: 's', messages: [{ role: 'user', text: 'q' }] })),
      (e) => e instanceof ProviderError && e.message === 'boom',
    );
  } finally {
    m.restore();
  }
});

test('OpenAI: モデル一覧は会話用だけを、新しい順に返す', async () => {
  const m = mockFetch(() =>
    new Response(
      JSON.stringify({
        data: [
          { id: 'gpt-old', created: 1 },
          { id: 'gpt-new-mini', created: 5 },
          { id: 'text-embedding-3-small', created: 9 },
          { id: 'whisper-1', created: 9 },
          { id: 'gpt-4o-realtime-preview', created: 9 },
        ],
      }),
      { status: 200 },
    ),
  );
  try {
    const list = await openai.listModels('sk-test-1234567');
    assert.deepEqual(list.map((x) => x.id), ['gpt-new-mini', 'gpt-old']);
  } finally {
    m.restore();
  }
});

// ---------------------------------------------------------------- Claude

test('Claude: ヘッダー（ブラウザ直接アクセス）・max_tokens・system・差分の取り出し', async () => {
  const m = mockFetch(() =>
    sseResponse([
      sse({ type: 'message_start', message: {} }, 'message_start'),
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Cl' } }, 'content_block_delta'),
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'aude' } }, 'content_block_delta'),
      sse({ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }, 'message_delta'),
      sse({ type: 'message_stop' }, 'message_stop'),
    ]),
  );
  try {
    const out = await collect(
      anthropic.stream({ apiKey: 'sk-ant-test-1234567', model: 'claude-test', system: 'SYS', messages: [{ role: 'user', text: 'Q' }] }),
    );
    assert.equal(out.map((x) => x.text).filter(Boolean).join(''), 'Claude');
    assert.ok(out.some((x) => x.notice));
    const call = m.calls[0];
    assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(call.headers['x-api-key'], 'sk-ant-test-1234567');
    assert.equal(call.headers['anthropic-version'], '2023-06-01');
    assert.equal(call.headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.equal(call.body.system, 'SYS');
    assert.equal(call.body.stream, true);
    assert.ok(Number.isInteger(call.body.max_tokens) && call.body.max_tokens > 0);
  } finally {
    m.restore();
  }
});

test('Claude: error イベントは混雑なら server、レート制限なら rate', async () => {
  for (const [type, kind] of [['overloaded_error', 'server'], ['rate_limit_error', 'rate']]) {
    const m = mockFetch(() => sseResponse([sse({ type: 'error', error: { type, message: 'x' } }, 'error')]));
    try {
      await assert.rejects(
        collect(anthropic.stream({ apiKey: 'sk-ant-test-1234567', model: 'm', system: 's', messages: [{ role: 'user', text: 'q' }] })),
        (e) => e instanceof ProviderError && e.kind === kind,
      );
    } finally {
      m.restore();
    }
  }
});

// ---------------------------------------------------------------- エラーの分類

test('HTTP エラーの分類', () => {
  const kind = (provider, status, body) => classifyHttpError(provider, status, JSON.stringify(body), 'm').kind;
  assert.equal(kind('gemini', 400, { error: { message: 'API key not valid. Please pass a valid API key.' } }), 'auth');
  assert.equal(kind('openai', 401, { error: { message: 'Incorrect API key', code: 'invalid_api_key' } }), 'auth');
  assert.equal(kind('anthropic', 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), 'auth');
  assert.equal(kind('gemini', 404, { error: { message: 'not found' } }), 'model');
  assert.equal(kind('gemini', 429, { error: { message: 'Quota exceeded ... PerDay ...', status: 'RESOURCE_EXHAUSTED' } }), 'quota');
  assert.equal(kind('gemini', 429, { error: { message: 'Quota exceeded ... PerMinute ...' } }), 'rate');
  assert.equal(kind('openai', 429, { error: { message: 'You exceeded your current quota', type: 'insufficient_quota' } }), 'quota');
  assert.equal(kind('openai', 429, { error: { message: 'Rate limit reached', type: 'requests' } }), 'rate');
  assert.equal(kind('anthropic', 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } }), 'quota');
  assert.equal(kind('anthropic', 529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), 'server');
  assert.equal(classifyHttpError('gemini', 500, 'not json', 'm').kind, 'server');
});

test('HTTP エラー: 503 は相手の返答を添え、「何秒後に」の指示を取り出す', () => {
  const e503 = classifyHttpError(
    'gemini',
    503,
    JSON.stringify({ error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } }),
    'm',
  );
  assert.equal(e503.kind, 'server');
  assert.ok(e503.message.includes('503'));
  assert.ok(e503.message.includes('The model is overloaded'), '相手の返答が、そのまま添えられる');

  const gemini429 = classifyHttpError(
    'gemini',
    429,
    JSON.stringify({ error: { code: 429, message: 'Quota exceeded ... PerMinute ...', details: [{ '@type': 'RetryInfo', retryDelay: '7s' }] } }),
    'm',
  );
  assert.equal(gemini429.kind, 'rate');
  assert.equal(gemini429.retryAfterMs, 7000);

  const withHeader = classifyHttpError('openai', 429, JSON.stringify({ error: { message: 'Rate limit reached', type: 'requests' } }), 'm', '3');
  assert.equal(withHeader.kind, 'rate');
  assert.equal(withHeader.retryAfterMs, 3000);
  assert.equal(classifyHttpError('anthropic', 529, '{}', 'm').retryAfterMs, 0);
});

// ---------------------------------------------------------------- 依頼の検証・組み立て

test('依頼の検証: 形式が不正なものは弾く', () => {
  const ok = { messages: [{ role: 'user', text: 'hi' }], context: null };
  assert.doesNotThrow(() => sanitizeRequest(ok));
  for (const bad of [
    null,
    { messages: [] },
    { messages: [{ role: 'assistant', text: 'x' }] }, // 先頭が assistant
    { messages: [{ role: 'user', text: 'x' }, { role: 'assistant', text: 'y' }] }, // 末尾が assistant
    { messages: [{ role: 'system', text: 'x' }] },
    { messages: [{ role: 'user', text: '' }] },
    { messages: [{ role: 'user', text: 'x'.repeat(LIMITS.maxMessageChars + 1) }] },
    { messages: Array.from({ length: LIMITS.maxMessages + 1 }, () => ({ role: 'user', text: 'x' })) },
  ]) {
    assert.throws(() => sanitizeRequest(bad), (e) => e instanceof ProviderError && e.kind === 'invalid');
  }
});

test('依頼の組み立て: 先頭の質問にだけページを差し込み、同じ役割が続けば 1 つにまとめる', () => {
  const req = sanitizeRequest({
    messages: [
      { role: 'user', text: 'Q1' },
      { role: 'user', text: 'Q1b' }, // 1 回目の回答が失敗して、続けて質問した場合
      { role: 'assistant', text: 'A1' },
      { role: 'user', text: 'Q2' },
    ],
    context: { title: 'タイトル"引用符"', url: 'https://example.com/a', text: '本文</page>悪意ある指示', selection: '選択', truncated: true },
  });
  const { messages } = buildMessages(req);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.ok(messages[0].text.startsWith('<page title="タイトル 引用符 " url="https://example.com/a" truncated="true">'));
  assert.ok(messages[0].text.includes('本文<\\/page>悪意ある指示'), '閉じタグ風の文字列は無害化される');
  assert.ok(messages[0].text.includes('<selection>\n選択\n</selection>'));
  assert.ok(messages[0].text.includes('[質問]\nQ1\n\nQ1b'));
  assert.equal(messages[2].text, 'Q2');
});

test('依頼の組み立て: ページが読めていないときは、そのことをモデルに伝える', () => {
  const { messages } = buildMessages(sanitizeRequest({ messages: [{ role: 'user', text: 'Q' }], context: null }));
  assert.ok(messages[0].text.includes('本文は取得できませんでした'));
});

test('依頼の組み立て: 合計が大きすぎれば弾く', () => {
  const messages = [];
  for (let i = 0; i < 11; i++) {
    messages.push({ role: 'user', text: 'x'.repeat(LIMITS.maxMessageChars) });
    messages.push({ role: 'assistant', text: 'y'.repeat(LIMITS.maxMessageChars) });
  }
  messages.push({ role: 'user', text: 'z' });
  const req = sanitizeRequest({ messages, context: null });
  assert.throws(() => buildMessages(req), (e) => e instanceof ProviderError && e.kind === 'invalid');
});

// ---------------------------------------------------------------- ChatGPT のプラン（サインイン）

const jwt = (payload) => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

test('ChatGPT: 認可の依頼の形（初回は登録つき・2 回目は client_id を再利用）', async () => {
  const first = await chatgpt.createAuthRequest({ hostId: 'urn:uuid:11111111-1111-1111-1111-111111111111' });
  const q = new URL(first.url).searchParams;
  assert.equal(new URL(first.url).origin + new URL(first.url).pathname, chatgpt.AUTHORIZE_URL);
  assert.equal(q.get('client_id'), 'dynamic_agent_client');
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('redirect_uri'), 'http://127.0.0.1:1455/auth/callback');
  assert.equal(q.get('scope'), 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct');
  assert.equal(q.get('resource'), 'https://api.openai.com/v1');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(q.get('code_challenge'), await chatgpt.sha256b64url(first.verifier), 'challenge は検証子の SHA-256');
  assert.equal(q.get('state'), first.state);
  assert.equal(q.get('nonce'), first.nonce);
  assert.notEqual(first.state, first.nonce);
  assert.equal(q.get('ext_agent_host_id'), 'urn:uuid:11111111-1111-1111-1111-111111111111');
  assert.ok(q.get('agent_name_hint'));
  assert.equal(q.get('login_hint'), null);

  const again = await chatgpt.createAuthRequest({ clientId: 'oaiapp_abc', hostId: 'urn:uuid:x', email: 'a@example.com' });
  const q2 = new URL(again.url).searchParams;
  assert.equal(q2.get('client_id'), 'oaiapp_abc');
  assert.equal(q2.get('agent_name_hint'), null, '登録済みのときは、アプリ名を送らない');
  assert.equal(q2.get('login_hint'), 'a@example.com');
});

test('ChatGPT: 戻り先の判定と解析（state・error・client_id の規則）', () => {
  const R = 'http://127.0.0.1:1455/auth/callback';
  assert.equal(chatgpt.isCallbackUrl(`${R}?code=x`), true);
  assert.equal(chatgpt.isCallbackUrl(R), true);
  assert.equal(chatgpt.isCallbackUrl(`${R}/extra`), false);
  assert.equal(chatgpt.isCallbackUrl('http://127.0.0.1:1456/auth/callback?code=x'), false);
  assert.equal(chatgpt.isCallbackUrl('http://localhost:1455/auth/callback?code=x'), false, 'localhost は使わない');

  const pending = { state: 'S1', usedClientId: null };
  assert.deepEqual(chatgpt.parseCallback(`${R}?code=C&state=S1&client_id=oaiapp_1`, pending), { kind: 'ok', code: 'C', clientId: 'oaiapp_1' });
  assert.equal(chatgpt.parseCallback(`${R}?code=C&state=WRONG&client_id=oaiapp_1`, pending).kind, 'ignore');
  assert.equal(chatgpt.parseCallback(`${R}?code=C&state=S1&state=S1&client_id=oaiapp_1`, pending).kind, 'ignore', 'state は 1 回だけ');
  assert.deepEqual(chatgpt.parseCallback(`${R}?error=access_denied&state=S1`, pending), { kind: 'error', error: 'access_denied' });
  assert.equal(chatgpt.parseCallback(`${R}?state=S1&client_id=oaiapp_1`, pending).error, 'missing_code');
  assert.equal(chatgpt.parseCallback(`${R}?code=A&code=B&state=S1&client_id=oaiapp_1`, pending).error, 'missing_code');
  assert.equal(chatgpt.parseCallback(`${R}?code=C&state=S1`, pending).error, 'registration_incomplete', '初回は client_id が必須');
  assert.equal(chatgpt.parseCallback(`${R}?code=C&state=S1&client_id=dynamic_agent_client`, pending).error, 'registration_incomplete');
  assert.equal(chatgpt.parseCallback(`${R}?code=C&state=S1&client_id=bad%20id`, pending).error, 'registration_incomplete');
  // 2 回目: client_id は省略されてよいが、違うものなら拒否する
  const reauth = { state: 'S2', usedClientId: 'oaiapp_1' };
  assert.equal(chatgpt.parseCallback(`${R}?code=C&state=S2`, reauth).clientId, 'oaiapp_1');
  assert.equal(chatgpt.parseCallback(`${R}?code=C&state=S2&client_id=oaiapp_2`, reauth).error, 'client_mismatch');
});

test('ChatGPT: コードの交換・更新の形、nonce の照合、無効な更新は再サインインを求める', async () => {
  const claims = { iss: 'https://auth.openai.com', sub: 'u', email: 'me@example.com', nonce: 'N1' };
  const bodyOf = (init) => Object.fromEntries(new URLSearchParams(String(init.body)));
  let seen = [];
  const m = mockFetch((url, init) => {
    seen.push({ url, form: bodyOf(init), headers: init.headers });
    return new Response(
      JSON.stringify({
        token_type: 'Bearer',
        access_token: 'AT1',
        refresh_token: 'RT1',
        id_token: jwt(claims),
        expires_in: 3600,
        scope: 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke',
      }),
      { status: 200 },
    );
  });
  try {
    const auth = await chatgpt.exchangeCode({ code: 'CODE', clientId: 'oaiapp_1', verifier: 'VER', nonce: 'N1' });
    assert.equal(seen[0].url, chatgpt.TOKEN_URL);
    assert.deepEqual(seen[0].form, {
      grant_type: 'authorization_code',
      client_id: 'oaiapp_1',
      code: 'CODE',
      code_verifier: 'VER',
      redirect_uri: 'http://127.0.0.1:1455/auth/callback',
      resource: 'https://api.openai.com/v1',
    });
    assert.equal(auth.accessToken, 'AT1');
    assert.equal(auth.refreshToken, 'RT1');
    assert.equal(auth.email, 'me@example.com');
    assert.ok(auth.scopes.includes('chatgpt.tokens.use.direct'));
    assert.ok(auth.expiresAt > Date.now() + 3500 * 1000);

    await assert.rejects(
      chatgpt.exchangeCode({ code: 'CODE', clientId: 'oaiapp_1', verifier: 'VER', nonce: 'OTHER' }),
      (e) => e instanceof ProviderError && /nonce/.test(e.message),
    );

    seen = [];
    const next = await chatgpt.refreshTokens(auth);
    assert.deepEqual(seen[0].form, { grant_type: 'refresh_token', client_id: 'oaiapp_1', refresh_token: 'RT1', resource: 'https://api.openai.com/v1' });
    assert.equal(next.email, 'me@example.com', '更新後も、アカウントの情報を引き継ぐ');
  } finally {
    m.restore();
  }

  // 公式が「使えないリフレッシュトークン」としているコードは、すべて、サインインし直しを求める
  for (const code of ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']) {
    const bad = mockFetch(() => new Response(JSON.stringify({ error: code, error_description: 'expired' }), { status: 400 }));
    try {
      await assert.rejects(
        chatgpt.refreshTokens({ clientId: 'oaiapp_1', refreshToken: 'old', scopes: [], email: '', idToken: '' }),
        (e) => e instanceof ProviderError && e.kind === 'auth' && e.reauth === true,
        code,
      );
    } finally {
      bad.restore();
    }
  }

  // 一時的な障害（5xx）や、client の設定の問題（invalid_client）では、サインインを消さない
  for (const [status, body] of [[503, { error: 'temporarily_unavailable' }], [401, { error: 'invalid_client' }]]) {
    const soft = mockFetch(() => new Response(JSON.stringify(body), { status }));
    try {
      await assert.rejects(
        chatgpt.refreshTokens({ clientId: 'oaiapp_1', refreshToken: 'old', scopes: [], email: '', idToken: '' }),
        (e) => e instanceof ProviderError && !e.reauth,
        String(status),
      );
    } finally {
      soft.restore();
    }
  }
});

test('ChatGPT: 質問の依頼の形（Bearer・store:false・stream:true）と、利用枠の上限の分類', async () => {
  const m = mockFetch(() =>
    sseResponse([
      sse({ type: 'response.output_text.delta', delta: 'あ' }, 'response.output_text.delta'),
      sse({ type: 'response.output_text.delta', delta: 'い' }, 'response.output_text.delta'),
      sse({ type: 'response.completed', response: {} }, 'response.completed'),
    ]),
  );
  try {
    const out = await collect(chatgpt.stream({ apiKey: 'AT-1', model: 'gpt-6.1-sol', system: 'SYS', messages: [{ role: 'user', text: 'Q' }] }));
    assert.equal(out.map((x) => x.text).join(''), 'あい');
    assert.ok(!out.some((x) => x.notice), '完了を確認できたときは、注意を出さない');
    const call = m.calls[0];
    assert.equal(call.url, 'https://api.openai.com/v1/responses');
    assert.equal(call.headers.authorization, 'Bearer AT-1');
    assert.equal(call.body.store, false);
    assert.equal(call.body.stream, true);
    assert.equal(call.body.model, 'gpt-6.1-sol');
    assert.equal(call.body.instructions, 'SYS');
  } finally {
    m.restore();
  }

  for (const [code, kind] of [
    ['subscription_sharing_usage_limit_exceeded', 'quota'],
    ['subscription_sharing_usage_unavailable', 'quota'],
    ['something_else', 'server'],
  ]) {
    const f = mockFetch(() => sseResponse([sse({ type: 'response.failed', response: { error: { code, message: 'm' } } })]));
    try {
      await assert.rejects(
        collect(chatgpt.stream({ apiKey: 'AT-1', model: 'm', system: 's', messages: [{ role: 'user', text: 'q' }] })),
        (e) => e instanceof ProviderError && e.kind === kind,
        code,
      );
    } finally {
      f.restore();
    }
  }
});

test('ChatGPT: instructions を受け付けないときは、developer メッセージで送り直す', async () => {
  let n = 0;
  const m = mockFetch(() => {
    n += 1;
    if (n === 1) return new Response(JSON.stringify({ error: { message: 'Unsupported parameter: instructions' } }), { status: 400 });
    return sseResponse([sse({ type: 'response.output_text.delta', delta: 'ok' }), sse({ type: 'response.completed', response: {} })]);
  });
  try {
    const out = await collect(chatgpt.stream({ apiKey: 'AT', model: 'm', system: 'SYS', messages: [{ role: 'user', text: 'Q' }] }));
    assert.equal(out.map((x) => x.text).join(''), 'ok');
    assert.equal(m.calls.length, 2);
    assert.equal(m.calls[1].body.instructions, undefined);
    assert.deepEqual(m.calls[1].body.input[0], { role: 'developer', content: 'SYS' });
  } finally {
    m.restore();
  }

  // 401 のときは、送り直さず、サインインし直しを案内する
  const unauth = mockFetch(() => new Response('{}', { status: 401 }));
  try {
    await assert.rejects(
      collect(chatgpt.stream({ apiKey: 'AT', model: 'm', system: 's', messages: [{ role: 'user', text: 'q' }] })),
      (e) => e instanceof ProviderError && e.kind === 'auth' && e.message.includes('サインイン'),
    );
    assert.equal(unauth.calls.length, 1);
  } finally {
    unauth.restore();
  }
});

test('ChatGPT: モデル一覧は、visibility が list のものだけを、サーバーの順序のまま返す', async () => {
  const m = mockFetch(() =>
    new Response(
      JSON.stringify({
        models: [
          { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list' },
          { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide' },
          { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', visibility: 'list' },
        ],
      }),
      { status: 200 },
    ),
  );
  try {
    const list = await chatgpt.listModels('AT-1');
    assert.deepEqual(list, [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
    ]);
    assert.equal(m.calls[0].url, 'https://api.openai.com/v1/models');
    assert.equal(m.calls[0].headers.authorization, 'Bearer AT-1');
  } finally {
    m.restore();
  }
});

// ---------------------------------------------------------------- その他

test('モデルの絞り込み: 画像生成（Nano Banana）・音声・埋め込みなどは除き、会話用は残す', () => {
  const excluded = [
    ['gemini-2.5-flash-image', 'Nano Banana'],
    ['gemini-3-pro-image-preview', 'Nano Banana Pro'],
    ['gemini-2.0-flash-preview-image-generation', ''],
    ['gemini-2.5-flash-preview-tts', ''],
    ['gemini-2.5-flash-native-audio-preview-09-2025', ''],
    ['gemini-live-2.5-flash-preview', ''],
    ['gemini-embedding-001', ''],
    ['gemini-2.5-computer-use-preview', ''],
    ['imagen-4.0-generate-001', ''],
    ['veo-3.0-generate-preview', ''],
    ['gpt-image-1', ''],
    ['gpt-4o-mini-tts', ''],
    ['gpt-4o-transcribe', ''],
    ['gpt-4o-audio-preview', ''],
    ['gpt-realtime', ''],
    ['gpt-5-codex', ''],
    ['text-embedding-3-small', ''],
    ['omni-moderation-latest', ''],
    ['whisper-1', ''],
    ['dall-e-3', ''],
    ['unknown-model-x', 'Nano Banana 2'], // 表示名にだけ書かれている場合
  ];
  for (const [id, label] of excluded) assert.equal(isChatModel(id, label), false, `${id} は除かれるべき`);
  const kept = [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-3.5-pro',
    'gemini-flash-latest',
    'gemini-2.5-flash-lite-preview-09-2025',
    'gpt-5',
    'gpt-5-mini',
    'chatgpt-4o-latest',
    'o3-mini',
    'claude-sonnet-4-5',
    'claude-haiku-4-5-20251001',
    'delivery-model', // 「live」を部分的に含むだけの名前（「deLIVEry」）は、除かない
  ];
  for (const id of kept) assert.equal(isChatModel(id), true, `${id} は残るべき`);
  assert.deepEqual(filterChatModels([{ id: 'gemini-2.5-flash-image', label: 'Nano Banana' }, { id: 'gemini-2.5-flash', label: 'Flash' }]).map((m) => m.id), ['gemini-2.5-flash']);
});

test('モデルの並べ替えと既定の選択', () => {
  const sorted = sortNewestFirst([{ id: 'gemini-2.5-flash' }, { id: 'gemini-3.5-pro' }, { id: 'gemini-3.5-flash' }]);
  assert.deepEqual(sorted.map((m) => m.id), ['gemini-3.5-flash', 'gemini-3.5-pro', 'gemini-2.5-flash']);
  assert.equal(pickDefaultModel('gemini', [{ id: 'gemini-4-pro' }, { id: 'gemini-4-flash' }, { id: 'gemini-3-flash-lite' }]), 'gemini-3-flash-lite');
  assert.equal(pickDefaultModel('openai', [{ id: 'gpt-9' }, { id: 'gpt-9-mini' }]), 'gpt-9-mini');
  assert.equal(pickDefaultModel('anthropic', [{ id: 'claude-x-sonnet' }, { id: 'claude-x-haiku' }]), 'claude-x-haiku');
  assert.equal(pickDefaultModel('gemini', [{ id: 'gemini-9-flash-preview' }, { id: 'gemini-8-pro' }]), 'gemini-8-pro', 'preview より正式版を優先');
  assert.equal(pickDefaultModel('gemini', []), '');
});

test('ページ読み取りの失敗の分類', () => {
  assert.equal(classifyReadError('Cannot access a chrome:// URL').kind, 'internal');
  assert.equal(classifyReadError('Cannot access contents of the page. Extension manifest must request permission to access the respective host.').kind, 'permission');
  assert.equal(classifyReadError('No tab with id: 12').kind, 'gone');
  assert.equal(classifyReadError('something else').kind, 'other');
});
