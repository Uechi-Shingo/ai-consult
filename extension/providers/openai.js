import { ProviderError, fetchOrThrow } from './errors.js';
import { parseSse } from './sse.js';
import { isChatModel } from './util.js';

const BASE = 'https://api.openai.com/v1';
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

export const id = 'openai';
export const label = 'OpenAI';

// Responses API をストリーミングで使う。store: false で、OpenAI 側に応答を保存させない。
export async function* stream({ apiKey, model, system, messages, signal }) {
  if (!MODEL_ID.test(model)) throw new ProviderError('モデル名に使えない文字が含まれています。', 'model');
  const body = {
    model,
    instructions: system,
    input: messages.map((m) => ({ role: m.role, content: m.text })),
    stream: true,
    store: false,
  };
  const res = await fetchOrThrow(id, model, `${BASE}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  });

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
      case 'response.incomplete': {
        const reason = json.response && json.response.incomplete_details && json.response.incomplete_details.reason;
        yield { notice: reason === 'max_output_tokens' ? '回答が長さの上限に達して、途中で終わりました。' : '回答が途中で終わりました。' };
        break;
      }
      case 'response.failed': {
        const err = json.response && json.response.error;
        throw new ProviderError(String((err && err.message) || 'OpenAI でエラーが発生しました。').slice(0, 300), 'server');
      }
      case 'error':
        throw new ProviderError(String(json.message || (json.error && json.error.message) || 'OpenAI でエラーが発生しました。').slice(0, 300), 'server');
      default:
        break;
    }
  }
}

export async function listModels(apiKey, signal) {
  const res = await fetchOrThrow(id, '', `${BASE}/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal });
  const json = await res.json();
  // 会話用（gpt-* / chatgpt-* / o 系）だけ。画像・音声・リアルタイム・埋め込みなどは除く
  const rows = (json.data || [])
    .filter((m) => typeof m.id === 'string' && /^(gpt-|chatgpt-|o\d)/i.test(m.id) && isChatModel(m.id) && MODEL_ID.test(m.id))
    .sort((a, b) => (b.created || 0) - (a.created || 0));
  return rows.map((m) => ({ id: m.id, label: m.id }));
}
