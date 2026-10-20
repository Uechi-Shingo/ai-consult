import { ProviderError, fetchOrThrow } from './errors.js';
import { parseSse } from './sse.js';

const BASE = 'https://api.anthropic.com/v1';
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const MAX_TOKENS = 4096; // 必須の項目。古い軽量モデルの上限（4096）に合わせてある

export const id = 'anthropic';
export const label = 'Claude';

// ブラウザ（拡張機能）から直接呼ぶには、anthropic-dangerous-direct-browser-access が必要。
function headers(apiKey) {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

export async function* stream({ apiKey, model, system, messages, signal }) {
  if (!MODEL_ID.test(model)) throw new ProviderError('モデル名に使えない文字が含まれています。', 'model');
  const body = {
    model,
    max_tokens: MAX_TOKENS,
    system,
    messages: messages.map((m) => ({ role: m.role, content: m.text })),
    stream: true,
  };
  const res = await fetchOrThrow(id, model, `${BASE}/messages`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify(body),
    signal,
  });

  for await (const ev of parseSse(res.body)) {
    let json;
    try {
      json = JSON.parse(ev.data);
    } catch {
      continue;
    }
    switch (json.type || ev.event) {
      case 'content_block_delta':
        if (json.delta && json.delta.type === 'text_delta' && json.delta.text) yield { text: json.delta.text };
        break;
      case 'message_delta':
        if (json.delta && json.delta.stop_reason === 'max_tokens') {
          yield { notice: '回答が長さの上限に達して、途中で終わりました。' };
        } else if (json.delta && json.delta.stop_reason === 'refusal') {
          yield { notice: 'Claude が回答を控えました。' };
        }
        break;
      case 'error': {
        const err = json.error || {};
        const kind = err.type === 'overloaded_error' ? 'server' : err.type === 'rate_limit_error' ? 'rate' : 'server';
        throw new ProviderError(String(err.message || 'Claude でエラーが発生しました。').slice(0, 300), kind);
      }
      default:
        break;
    }
  }
}

export async function listModels(apiKey, signal) {
  const res = await fetchOrThrow(id, '', `${BASE}/models?limit=100`, { headers: headers(apiKey), signal });
  const json = await res.json();
  const rows = (json.data || [])
    .filter((m) => typeof m.id === 'string' && MODEL_ID.test(m.id))
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return rows.map((m) => ({ id: m.id, label: m.display_name || m.id }));
}
