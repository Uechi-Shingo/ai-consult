// 「Sign in with ChatGPT」（オープンソース向けのトークン共有）の接続先と設定。
// 出典: OpenAI の公式ドキュメント（developers.openai.com/siwc/token-sharing-open-source）
export const AUTH_AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
export const AUTH_TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
export const API_BASE = 'https://api.openai.com/v1';
export const RESOURCE = 'https://api.openai.com/v1';

// 戻り先は、127.0.0.1 の HTTP ループバックだけが、公式に使える形。
// 拡張機能は待ち受けを持たないため、このアドレスへの移動を「検知」して、中身（code など）を取り出す。
// 初回の登録のときから、同じ形（スキーム・ホスト・パス）を使い続ける必要がある（ポートだけは変えられる）。
export const LOOPBACK_PORT = 1455;
export const REDIRECT_URI = `http://127.0.0.1:${LOOPBACK_PORT}/auth/callback`;

export const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
// ChatGPT の承認画面に表示されるアプリ名。仕様の文字数・文字種が不明なため、無難な英数字にしてある。
export const APP_NAME = 'AI Consult (spike)';
