// モデル一覧の絞り込み・並べ替えと、既定のモデルの選び方。

// この相談機能（文章でのやりとり）に使えない・使わないモデルを示す語。
// 名前を「-」「_」「.」などで区切った単語として一致を見る（「live」が別の単語の一部に当たる誤判定を避けるため）。
const EXCLUDED_TOKENS = new Set([
  // 画像・動画の生成
  'image', 'images', 'imagen', 'veo', 'sora', 'dall', 'banana', 'nano',
  // 音声（読み上げ・文字起こし・音声対話・リアルタイム）
  'tts', 'audio', 'speech', 'transcribe', 'whisper', 'live', 'realtime', 'dialog',
  // 文章のやりとりではないもの
  'embedding', 'embeddings', 'moderation', 'search', 'aqa', 'robotics', 'computer',
  'codex', 'instruct', 'davinci', 'babbage',
]);

export function isChatModel(id, label = '') {
  const tokens = String(id).toLowerCase().split(/[-_.:/]+/);
  if (tokens.some((t) => EXCLUDED_TOKENS.has(t))) return false;
  // 表示名にだけ用途が書かれている場合（例: 「Nano Banana」）
  if (/nano\s*banana|image\s*generation|text[- ]to[- ]speech|native\s*audio/i.test(String(label))) return false;
  return true;
}

export function filterChatModels(list) {
  return list.filter((m) => isChatModel(m.id, m.label));
}

// 名前に含まれる数字（バージョン）が大きいものを先にする。日付が取れない一覧（Gemini）用。
export function sortNewestFirst(models) {
  const key = (id) => (id.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  return [...models].sort((a, b) => {
    const ka = key(a.id);
    const kb = key(b.id);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      const d = (kb[i] ?? -1) - (ka[i] ?? -1);
      if (d) return d;
    }
    return a.id.localeCompare(b.id);
  });
}

// ページへの質問は、速くて安いモデルで十分なことが多いので、軽量なモデルを既定にする。
const PREFERRED = {
  gemini: [/flash-lite/i, /flash/i],
  openai: [/mini/i, /^gpt/i],
  anthropic: [/haiku/i, /sonnet/i],
};

export function pickDefaultModel(provider, list) {
  if (!Array.isArray(list) || list.length === 0) return '';
  const stable = list.filter((m) => !/preview|exp/i.test(m.id));
  const pool = stable.length ? stable : list;
  for (const re of PREFERRED[provider] || []) {
    const hit = pool.find((m) => re.test(m.id));
    if (hit) return hit.id;
  }
  return pool[0].id;
}
