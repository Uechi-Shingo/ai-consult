// 表示中のタブから、ページの本文を取り出す。
import { LIMITS } from './request.js';

// ページに一時的に注入して実行する関数。ページ側で動くため、外の変数・import は使えない（自己完結させる）。
function extractPage(maxChars, maxSelection) {
  const bodyText = document.body ? document.body.innerText || '' : '';
  // 本文の入れ物（article / main）が、ページ全体の文字の半分以上を占めるなら、それを使う。
  // メニューやフッターの文字を減らすため。そうでなければ、取りこぼしを避けて body 全体を使う。
  let best = null;
  for (const el of document.querySelectorAll('article, main, [role="main"]')) {
    const len = (el.innerText || '').length;
    if (!best || len > best.len) best = { el, len };
  }
  const useBest = best && bodyText.length > 0 && best.len >= bodyText.length * 0.5;
  let text = useBest ? best.el.innerText : bodyText;
  text = text.replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  let truncated = false;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  const selection = window.getSelection ? String(window.getSelection()).trim().slice(0, maxSelection) : '';
  return {
    title: document.title || '',
    url: location.href,
    text,
    textLength: text.length,
    truncated,
    selection,
  };
}

// 読み取りの失敗を、利用者に伝えられる種類に分ける。
//   internal    ブラウザの内部ページ・ストアなど（拡張機能からは読めない）
//   permission  このページを読む許可がない
//   gone        タブが閉じられた
// detail は、ブラウザが返した元のエラー文（画面で原因を確かめるため）
export function classifyReadError(message) {
  const m = String(message || '');
  const detail = m.slice(0, 300);
  if (/chrome:\/\/|brave:\/\/|edge:\/\/|about:|chrome-extension:|extensions gallery|chromewebstore|chrome\.google\.com\/webstore/i.test(m)) {
    return { kind: 'internal', message: 'ブラウザの内部ページ（brave:// など）は読み取れません。', detail };
  }
  if (/Cannot access contents of the page|must request permission|Missing host permission/i.test(m)) {
    return { kind: 'permission', message: 'このページを読み取る許可がありません。', detail };
  }
  if (/No tab with id|tab was closed|Frame with ID/i.test(m)) {
    return { kind: 'gone', message: 'タブが見つかりません。', detail };
  }
  return { kind: 'other', message: `ページを読み取れませんでした。${m.slice(0, 200)}`, detail };
}

export async function readTab(tabId) {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractPage,
      args: [LIMITS.maxContextChars, LIMITS.maxSelectionChars],
    });
    if (!injection || !injection.result) {
      return { ok: false, kind: 'other', message: 'ページの内容を取得できませんでした。' };
    }
    return { ok: true, ...injection.result };
  } catch (e) {
    return { ok: false, ...classifyReadError(e && e.message ? e.message : e) };
  }
}
