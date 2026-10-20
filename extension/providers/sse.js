// Server-Sent Events（text/event-stream）を、1 イベントずつに分解する。
// 各社の応答は「event: 名前」「data: JSON」の行が空行で区切られて流れてくる。

const SEPARATOR = /\r\n\r\n|\n\n|\r\r/;

function parseBlock(block) {
  let event = '';
  const data = [];
  for (const line of block.split(/\r\n|\n|\r/)) {
    if (!line || line.startsWith(':')) continue; // 空行・コメント
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return { event, data: data.join('\n') };
}

// body: fetch の応答の ReadableStream
export async function* parseSse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let m = SEPARATOR.exec(buffer); m; m = SEPARATOR.exec(buffer)) {
        const block = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        const ev = parseBlock(block);
        if (ev.data) yield ev;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const ev = parseBlock(buffer);
      if (ev.data) yield ev;
    }
  } finally {
    try { await reader.cancel(); } catch { /* すでに閉じている */ }
  }
}
