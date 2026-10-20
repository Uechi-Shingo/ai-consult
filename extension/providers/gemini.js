import { ProviderError, fetchOrThrow } from './errors.js';
import { parseSse } from './sse.js';
import { isChatModel, sortNewestFirst } from './util.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export const id = 'gemini';
export const label = 'Gemini';

// messages: [{role:'user'|'assistant', text}]  →  {text} / {notice} を順に返す
export async function* stream({ apiKey, model, system, messages, signal }) {
  if (!MODEL_ID.test(model)) throw new ProviderError('モデル名に使えない文字が含まれています。', 'model');
  const url = `${BASE}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] })),
  };
  // キーは URL ではなくヘッダーで渡す（URL はログや履歴に残りうるため）
  const res = await fetchOrThrow(id, model, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal,
  });

  let stopReason = null;
  for await (const ev of parseSse(res.body)) {
    let json;
    try {
      json = JSON.parse(ev.data);
    } catch {
      continue;
    }
    if (json.error) {
      throw new ProviderError(String(json.error.message || 'Gemini でエラーが発生しました。').slice(0, 300), 'server');
    }
    if (json.promptFeedback && json.promptFeedback.blockReason) {
      throw new ProviderError(`Gemini が内容を理由に回答を止めました（${json.promptFeedback.blockReason}）。`, 'content');
    }
    const cand = json.candidates && json.candidates[0];
    if (!cand) continue;
    const parts = (cand.content && cand.content.parts) || [];
    // thought: true は「考え中のメモ」。回答には含めない
    const text = parts.map((p) => (typeof p.text === 'string' && !p.thought ? p.text : '')).join('');
    if (text) yield { text };
    if (cand.finishReason && cand.finishReason !== 'STOP') {
      if (cand.finishReason === 'MAX_TOKENS') yield { notice: '回答が長さの上限に達して、途中で終わりました。' };
      else stopReason = cand.finishReason;
    }
  }
  if (stopReason) throw new ProviderError(`Gemini が回答を途中で止めました（${stopReason}）。`, 'content');
}

export async function listModels(apiKey, signal) {
  const res = await fetchOrThrow(id, '', `${BASE}?pageSize=1000`, { headers: { 'x-goog-api-key': apiKey }, signal });
  const json = await res.json();
  const out = [];
  for (const m of json.models || []) {
    const methods = m.supportedGenerationMethods;
    if (!Array.isArray(methods) || !methods.includes('generateContent')) continue;
    const modelId = String(m.name || '').replace(/^models\//, '');
    if (!/^gemini/i.test(modelId) || !MODEL_ID.test(modelId)) continue;
    // 画像生成（Nano Banana）・音声用などは、generateContent に対応していても、相談には使わない
    if (!isChatModel(modelId, m.displayName)) continue;
    out.push({ id: modelId, label: m.displayName || modelId });
  }
  return sortNewestFirst(out);
}
