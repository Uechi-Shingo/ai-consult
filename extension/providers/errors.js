// 各社 API のエラーを、利用者に分かる言葉と「種類」に分類する。
//
// kind:
//   auth     キーが無効・権限なし
//   quota    無料枠や残高を使い切った（待っても直らない）
//   rate     短時間に多すぎた（少し待てば直る）
//   model    モデルが存在しない
//   server   相手側の障害・混雑
//   network  通信できない
//   content  内容を理由に回答が止められた
//   invalid  依頼の形式が不正
//   nokey / consent / timeout / other

const LABELS = { gemini: 'Gemini', openai: 'OpenAI', anthropic: 'Claude', chatgpt: 'ChatGPT' };

export class ProviderError extends Error {
  constructor(message, kind = 'other', extra = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

export function providerLabel(provider) {
  return LABELS[provider] || provider;
}

// 「何秒待ってから、もう一度」という指示（Retry-After ヘッダー、または Gemini の retryDelay）を、ミリ秒で返す。
function retryAfterFrom(bodyText, retryAfterHeader) {
  let ms = 0;
  const seconds = Number(retryAfterHeader);
  if (Number.isFinite(seconds) && seconds > 0) ms = seconds * 1000;
  const m = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(String(bodyText || ''));
  if (m) ms = Math.max(ms, Number(m[1]) * 1000);
  return ms;
}

export function classifyHttpError(provider, status, bodyText, model, retryAfterHeader = null) {
  const label = providerLabel(provider);
  const retryAfterMs = retryAfterFrom(bodyText, retryAfterHeader);
  let detail = '';
  let code = '';
  try {
    const json = JSON.parse(bodyText);
    // Gemini: {error:{message,status}} / OpenAI: {error:{message,type,code}} / Anthropic: {type:'error',error:{type,message}}
    const err = json && typeof json.error === 'object' && json.error ? json.error : json;
    detail = String(err.message ?? '').slice(0, 300);
    code = String(err.code ?? err.type ?? err.status ?? '');
  } catch {
    detail = String(bodyText || '').slice(0, 300);
  }
  const text = `${code} ${detail}`;

  // ChatGPT のプラン（サインイン）は、API キーではなくトークンなので、言い方を変える
  const viaSignIn = provider === 'chatgpt';
  if (status === 401 || (status === 400 && /API key not valid|API_KEY_INVALID/i.test(text))) {
    return new ProviderError(
      viaSignIn
        ? 'ChatGPT のサインインが無効になりました。設定画面で、サインインし直してください。'
        : `${label} の API キーが無効です。設定画面でキーを確認してください。`,
      'auth',
      { status },
    );
  }
  if (status === 403) {
    return new ProviderError(
      viaSignIn
        ? `ChatGPT のプランの利用枠を、この条件では使えません。${detail}`
        : `${label} の API キーに権限がないか、この条件では利用できません。${detail}`,
      'auth',
    );
  }
  if (status === 404) {
    return new ProviderError(`モデル「${model}」が見つかりません。設定画面でモデルを選び直してください。`, 'model');
  }
  if (status === 429 || (status === 400 && /credit balance|insufficient_quota|billing/i.test(text))) {
    if (/insufficient_quota|exceeded your current quota|PerDay|per day|credit balance|billing|plan and billing/i.test(text)) {
      return new ProviderError(`${label} の利用枠（無料枠または残高）を使い切りました。`, 'quota');
    }
    const wait = retryAfterMs ? `（約 ${Math.ceil(retryAfterMs / 1000)} 秒後）` : '';
    return new ProviderError(`${label} への依頼が多すぎます。少し待ってから、もう一度お試しください。${wait}`, 'rate', { retryAfterMs });
  }
  if (status === 529 || status >= 500) {
    // 相手側が返した理由（例: 「モデルが混み合っています」）を、そのまま添える
    const reason = detail ? `返答: ${detail.slice(0, 160)}` : '';
    return new ProviderError(
      `${label} 側でエラーまたは混雑が発生しています (${status})。${reason ? `${reason} ` : ''}しばらくしてから、もう一度お試しください。`,
      'server',
      { retryAfterMs },
    );
  }
  return new ProviderError(`${label} への依頼が受け付けられませんでした (${status})。${detail}`, 'invalid');
}

// fetch して、ステータスが 2xx でなければ分類済みのエラーを投げる。
export async function fetchOrThrow(provider, model, url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    if (init.signal && init.signal.aborted) throw e; // 中断は呼び出し側で扱う
    throw new ProviderError('ネットワークに接続できませんでした。接続を確認してください。', 'network');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw classifyHttpError(provider, res.status, body, model, res.headers.get('retry-after'));
  }
  return res;
}
