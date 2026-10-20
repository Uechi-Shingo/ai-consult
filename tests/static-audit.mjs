// 静的な監査: 権限・通信先・CSP・禁止された書き方・キーの埋め込みを、ソースから機械的に確認する。
// 実行: node tests/static-audit.mjs
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extDir = path.resolve(process.argv[2] || path.join(here, '..', 'extension'));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'ok' : 'NG'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
}
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

const API_HOSTS = ['generativelanguage.googleapis.com', 'api.openai.com', 'api.anthropic.com'];
// ChatGPT のプランでのサインイン用: 認可・トークンの交換先と、戻り先（ループバック。拡張機能は待ち受けず、移動を観測する）
const AUTH_HOST = 'auth.openai.com';
const CALLBACK_HOST = '127.0.0.1';
const NETWORK_HOSTS = [...API_HOSTS, AUTH_HOST];

// ---- manifest
const manifest = JSON.parse(readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
check('Manifest V3', manifest.manifest_version === 3);

// バージョンは変更のたびに上げ、CHANGELOG.md の先頭の項目と一致させる（再読み込みできたかの確認に使うため）
const changelogPath = path.join(extDir, '..', 'CHANGELOG.md');
const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : '';
const latestInChangelog = (/^## (\d+\.\d+\.\d+)\s*$/m.exec(changelog) || [])[1];
check('バージョンが x.y.z の形式', /^\d+\.\d+\.\d+$/.test(manifest.version), String(manifest.version));
check(
  'CHANGELOG.md の先頭の項目が、manifest のバージョンと一致している（バージョンを上げたら、変更履歴も書く）',
  latestInChangelog === manifest.version,
  `manifest: ${manifest.version} / CHANGELOG の先頭: ${latestInChangelog || '（見つからない）'}`,
);
check(
  '権限は想定した 6 つだけ（sidePanel / activeTab / scripting / storage / contextMenus / webRequest）',
  sameSet(manifest.permissions || [], ['sidePanel', 'activeTab', 'scripting', 'storage', 'contextMenus', 'webRequest']),
  JSON.stringify(manifest.permissions),
);
check(
  '常時のホスト権限は、3 社の API・サインイン先（auth.openai.com）・サインインの戻り先（ループバックの 1 つの URL）だけ',
  sameSet(manifest.host_permissions || [], [
    ...NETWORK_HOSTS.map((h) => `https://${h}/*`),
    `http://${CALLBACK_HOST}:1455/auth/callback*`,
  ]),
  JSON.stringify(manifest.host_permissions),
);
check(
  '全サイトの権限は「任意（利用者が許可したときだけ）」にとどまる',
  sameSet(manifest.optional_host_permissions || [], ['<all_urls>']) && !(manifest.host_permissions || []).includes('<all_urls>'),
  JSON.stringify(manifest.optional_host_permissions),
);
// アイコン: manifest に書かれたファイルが実在し、PNG で、書かれたサイズどおりの大きさであること
const iconProblems = [];
const iconEntries = [
  ...Object.entries(manifest.icons || {}),
  ...Object.entries((manifest.action && manifest.action.default_icon) || {}),
];
for (const [size, file] of iconEntries) {
  const full = path.join(extDir, file);
  if (!existsSync(full)) {
    iconProblems.push(`${file}: ファイルがありません`);
    continue;
  }
  const buf = readFileSync(full);
  const isPng = buf.length > 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!isPng) iconProblems.push(`${file}: PNG ではありません`);
  else if (buf.readUInt32BE(16) !== Number(size) || buf.readUInt32BE(20) !== Number(size)) {
    iconProblems.push(`${file}: 大きさが ${buf.readUInt32BE(16)}×${buf.readUInt32BE(20)} で、${size} ではありません`);
  }
}
check(
  'アイコン（16・48・128）が、manifest に書かれ、実在する PNG で、書かれたとおりの大きさ',
  ['16', '48', '128'].every((s) => manifest.icons && manifest.icons[s]) && iconProblems.length === 0,
  iconProblems.join('\n        ') || JSON.stringify(manifest.icons),
);
check('常駐の content script を持たない', manifest.content_scripts === undefined);
check('外部のページから呼べる口（externally_connectable / web_accessible_resources）を持たない',
  manifest.externally_connectable === undefined && manifest.web_accessible_resources === undefined);

const csp = (manifest.content_security_policy && manifest.content_security_policy.extension_pages) || '';
const directive = (name) => (csp.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name} `)) || '').split(/\s+/).slice(1);
check("CSP: script-src は 'self' だけ", sameSet(directive('script-src'), ["'self'"]), csp);
check(
  'CSP: connect-src は、3 社の API と auth.openai.com だけ',
  sameSet(directive('connect-src'), NETWORK_HOSTS.map((h) => `https://${h}`)),
  csp,
);
check("CSP: default-src は 'none'", sameSet(directive('default-src'), ["'none'"]), csp);
check("CSP に 'unsafe-eval' / 'unsafe-inline' を含まない", !/unsafe-(eval|inline)/.test(csp), csp);

// ---- ソースの走査
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
const files = walk(extDir);
const rel = (f) => path.relative(extDir, f).split(path.sep).join('/');
const sources = files.filter((f) => /\.(js|html)$/.test(f)).map((f) => ({ file: rel(f), text: readFileSync(f, 'utf8') }));

const FORBIDDEN = [
  [/\binnerHTML\b/, 'innerHTML'],
  [/\bouterHTML\b/, 'outerHTML'],
  [/\binsertAdjacentHTML\b/, 'insertAdjacentHTML'],
  [/\bdocument\.write\b/, 'document.write'],
  [/\beval\s*\(/, 'eval('],
  [/\bnew\s+Function\b/, 'new Function'],
  [/\bimportScripts\s*\(/, 'importScripts('],
];
for (const [re, label] of FORBIDDEN) {
  const hits = sources.filter((s) => s.file.endsWith('.js') && re.test(s.text)).map((s) => s.file);
  check(`禁止された書き方を使っていない: ${label}`, hits.length === 0, hits.join(', '));
}

const htmlProblems = [];
for (const s of sources.filter((x) => x.file.endsWith('.html'))) {
  for (const m of s.text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\bsrc="[^"h][^"]*"/.test(m[1]) || m[2].trim()) htmlProblems.push(`${s.file}: インラインまたは外部のスクリプト`);
  }
  if (/\son[a-z]+\s*=/i.test(s.text)) htmlProblems.push(`${s.file}: インラインのイベントハンドラ`);
  if (/\sstyle\s*=/i.test(s.text)) htmlProblems.push(`${s.file}: style 属性`);
}
check('HTML にインラインのスクリプト・イベントハンドラ・style 属性がない', htmlProblems.length === 0, htmlProblems.join('\n        '));

// ---- 通信先・fetch の場所
const urlProblems = [];
for (const s of sources) {
  for (const m of s.text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
    if (!NETWORK_HOSTS.includes(m[1]) && m[1] !== CALLBACK_HOST) urlProblems.push(`${s.file}: ${m[0]}`);
  }
}
check(
  'ソースに書かれた URL は、3 社の API・auth.openai.com・サインインの戻り先（127.0.0.1）だけ',
  urlProblems.length === 0,
  urlProblems.join('\n        '),
);

const fetchUsers = sources.filter((s) => /\bfetch\s*\(/.test(s.text)).map((s) => s.file);
check(
  'fetch を呼ぶのは providers/ だけ（画面・裏方の本体は直接通信しない）',
  fetchUsers.every((f) => f.startsWith('providers/')),
  fetchUsers.join(', '),
);

// ---- 秘密の埋め込み
const secretHits = sources
  .filter((s) => /AIza[0-9A-Za-z_-]{30,}|sk-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{10,}/.test(s.text))
  .map((s) => s.file);
check('APIキーらしい文字列が埋め込まれていない', secretHits.length === 0, secretHits.join(', '));

// ---- import の解決
const importProblems = [];
for (const s of sources.filter((x) => x.file.endsWith('.js'))) {
  for (const m of s.text.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const target = path.resolve(extDir, path.dirname(s.file), m[1]);
    if (!existsSync(target)) importProblems.push(`${s.file}: ${m[1]}`);
  }
}
check('import がすべて実在するファイルを指している', importProblems.length === 0, importProblems.join('\n        '));

const ng = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - ng} / ${results.length} 件成功`);
process.exit(ng ? 1 : 0);
