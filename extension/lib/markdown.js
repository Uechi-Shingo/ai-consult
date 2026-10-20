// モデルの出力（信用できない入力）を、HTML の文字列を経由せず、DOM の部品として組み立てる小さな Markdown 描画。
// 対応: 見出し / 段落 / 箇条書き（入れ子）/ 番号付き / コードブロック / 引用 / 表 / 水平線 /
//       インライン: `code` **太字** *斜体* [リンク](https://…) と、そのままの https:// の URL
// リンクは http(s) のみ。生の HTML は解釈せず、そのまま文字として表示する。

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(__[^_\n]+?__)|(\*[^*\s][^*\n]*?\*)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))|(https?:\/\/[^\s<>]+)/g;
const TRAILING = /[.,;:!?)\]}。、）」』]+$/;

function makeLink(href, label) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return document.createTextNode(label);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return document.createTextNode(label);
  const a = document.createElement('a');
  a.href = url.href;
  a.textContent = label;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function appendInline(parent, text) {
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    const token = m[0];
    if (m[1]) {
      const code = document.createElement('code');
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else if (m[2] || m[3]) {
      const strong = document.createElement('strong');
      appendInline(strong, token.slice(2, -2));
      parent.append(strong);
    } else if (m[4]) {
      const em = document.createElement('em');
      appendInline(em, token.slice(1, -1));
      parent.append(em);
    } else if (m[5]) {
      const mm = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(token);
      parent.append(mm ? makeLink(mm[2], mm[1]) : token);
    } else if (m[6]) {
      const tail = TRAILING.exec(token);
      const url = tail ? token.slice(0, tail.index) : token;
      parent.append(makeLink(url, url));
      if (tail) parent.append(tail[0]);
    }
    last = m.index + token.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

const FENCE = /^\s*```/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s*>/;
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const isBlank = (line) => /^\s*$/.test(line);
const tableCells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const startsTable = (lines, i) => i + 1 < lines.length && lines[i].includes('|') && TABLE_SEP.test(lines[i + 1]);
const startsBlock = (lines, i) =>
  FENCE.test(lines[i]) || HEADING.test(lines[i]) || HR.test(lines[i]) || QUOTE.test(lines[i]) || ITEM.test(lines[i]) || startsTable(lines, i);

function parseList(lines, start, root) {
  const stack = []; // { indent, list, lastLi }
  let i = start;
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]);
    if (!m) break;
    const indent = m[1].replace(/\t/g, '    ').length;
    const ordered = /\d/.test(m[2]);
    while (stack.length && indent < stack[stack.length - 1].indent) stack.pop();
    let top = stack[stack.length - 1];
    if (!top || indent > top.indent) {
      const list = document.createElement(ordered ? 'ol' : 'ul');
      if (top && top.lastLi) top.lastLi.append(list);
      else root.append(list);
      top = { indent, list, lastLi: null };
      stack.push(top);
    }
    const li = document.createElement('li');
    appendInline(li, m[3]);
    top.list.append(li);
    top.lastLi = li;
    i++;
  }
  return i;
}

function parseTable(lines, start, root) {
  const header = tableCells(lines[start]);
  let i = start + 2;
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const cell of header) {
    const th = document.createElement('th');
    appendInline(th, cell);
    hr.append(th);
  }
  thead.append(hr);
  const tbody = document.createElement('tbody');
  while (i < lines.length && lines[i].includes('|') && !isBlank(lines[i])) {
    const tr = document.createElement('tr');
    for (const cell of tableCells(lines[i])) {
      const td = document.createElement('td');
      appendInline(td, cell);
      tr.append(td);
    }
    tbody.append(tr);
    i++;
  }
  table.append(thead, tbody);
  wrap.append(table);
  root.append(wrap);
  return i;
}

export function renderMarkdown(root, source) {
  root.textContent = '';
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }

    if (FENCE.test(line)) {
      // 閉じられていなくても、そこまでをコードとして描く（ストリーミング中の見た目のため）
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++;
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = buf.join('\n');
      pre.append(code);
      root.append(pre);
      continue;
    }

    let m = HEADING.exec(line);
    if (m) {
      const h = document.createElement(`h${Math.min(m[1].length + 2, 6)}`); // # → h3（パネルは狭いので小さめ）
      appendInline(h, m[2].replace(/\s+#+\s*$/, ''));
      root.append(h);
      i++;
      continue;
    }

    if (HR.test(line)) {
      root.append(document.createElement('hr'));
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const buf = [];
      while (i < lines.length && QUOTE.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      const bq = document.createElement('blockquote');
      renderMarkdown(bq, buf.join('\n'));
      root.append(bq);
      continue;
    }

    if (startsTable(lines, i)) {
      i = parseTable(lines, i, root);
      continue;
    }

    m = ITEM.exec(line);
    if (m) {
      i = parseList(lines, i, root);
      continue;
    }

    // 段落: 空行・別の種類のブロックが始まるまで。行末の改行は、そのまま改行として表示する。
    const p = document.createElement('p');
    let first = true;
    while (i < lines.length && !isBlank(lines[i]) && (first || !startsBlock(lines, i))) {
      if (!first) p.append(document.createElement('br'));
      appendInline(p, lines[i].replace(/\s+$/, ''));
      first = false;
      i++;
    }
    root.append(p);
  }
}
