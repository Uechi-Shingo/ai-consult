# ChatGPT サインイン試作

OpenAI の「Sign in with ChatGPT」（ChatGPT の Plus / Pro の利用枠を、対応アプリで使う仕組み）を、
**ブラウザの拡張機能から使えるか**を確かめるための、小さな試作です。メインの拡張機能（`../extension`）とは別物です。

## 確かめること

| # | 内容 | 状態 |
| --- | --- | --- |
| 1 | 公式の仕様どおりの認可リクエスト（PKCE・state・nonce・ホスト ID）を作れる | 偽サーバーで確認済み |
| 2 | 拡張機能が、ログイン後の戻り先（`http://127.0.0.1:1455/auth/callback?code=…`）を、待ち受けなしで検知できる | 偽サーバーで確認済み（Brave 155） |
| 3 | code をトークンに交換できる（更新も） | 偽サーバーで確認済み |
| 4 | 公式の OpenAI のサーバーが、この流れを受け付ける | **確認済み**（2026-10-16、Brave 155、本物の OpenAI） |
| 5 | トークンでモデル一覧を取得し、短い質問ができる（利用枠から引かれる） | **確認済み**（モデル 7 件、質問に回答、`response.completed` を確認） |
| 6 | トークンの更新（リフレッシュトークン）を、本物のサーバーで行える | 未確認（偽サーバーでのみ確認。メインの拡張機能への組み込み後に確認） |

### 本物の OpenAI での結果（2026-10-16）

- 戻り先を検知できた方法: `webRequest.onBeforeRequest` ✓ / `webNavigation.onBeforeNavigate` ✓ / `webNavigation.onErrorOccurred` ✓ / `tabs.onUpdated` ・
  （偽サーバーでは `onBeforeNavigate` は検知されなかった。本物では検知された。`webRequest` は、どちらでも検知できた）
- 発行された client_id は `oaiapp_…`。付与された権限は、`chatgpt.tokens.use.direct` を含む 6 つすべて
- アクセストークンの有効期限は約 60 分。リフレッシュトークンあり
- モデル一覧: 7 件（`gpt-6.1-sol` など）。質問は `store: false` / `stream: true` で成功

## 手元で確かめる手順（約 3 分）

ログインと承認は、あなたの手で行います（この試作や私が、パスワードを扱うことはありません）。

1. `brave://extensions` を開き、「デベロッパー モード」をオンにする
2. 「パッケージ化されていない拡張機能を読み込む」→ このフォルダの **`extension`** を選ぶ
   （このリポジトリの `spike-chatgpt-signin\extension`）
3. ツールバーの拡張機能のアイコン「ChatGPTサインイン試作」をクリック → 試作のページが開く
4. 「**1. ChatGPT でサインイン**」を押す → 新しいタブで、OpenAI のログイン画面が開く
5. ログインして、承認画面の内容を読み、よければ承認する
6. 承認後、そのタブが自動で閉じ、試作のページに「取得できました」と出る
7. 「**4. 一覧を取得**」→ 「**5. 送る**」を押す（ChatGPT の利用枠を、ごく少量使います）

### 結果を教えてください

試作のページ全体のスクリーンショット（または、次の項目）を送ってください。トークンの値は、画面に出ません。

- **2. 戻り先の検知:** どの方法に ✓ が付いたか
- **3. トークンの取得:** 状態、付与された権限（`chatgpt.tokens.use.direct` があるか）、有効期限
- **4・5:** モデル一覧が出たか。質問が「完了しました」になったか、失敗したときはその文面
- **経過:** 失敗したときの、HTTP のステータスとエラーの文面

### 注意

- **Codex CLI のログインを、同時に行わないでください。** どちらも、戻り先に 1455 番を使うためです。
- 承認画面には、何を許可するのかが表示されます。内容を確かめてから、承認してください。
- 試作が終わったら、ページ下部の「この拡張機能に保存したものを消す」を押してください。
  ChatGPT 側の接続は、ChatGPT の「設定 → セキュリティとログイン」から解除できます。
- トークンは、ブラウザを閉じると消える領域にだけ置いています。

## 自動確認

偽の OpenAI サーバー（認可・トークン・API）を手元で立てて、実際のブラウザで、上の 1〜3 と、更新・拒否・state 不一致を確かめます。
数十秒、ブラウザのウィンドウが開いて、自動で閉じます。

```powershell
node tests/e2e.mjs "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
```

結果（Brave 155）: 17 / 17 件成功。戻り先を検知できた方法は、次のとおりです。

| 方法 | 検知 |
| --- | --- |
| `webRequest.onBeforeRequest`（`webRequest` 権限と、`127.0.0.1` へのホスト権限が必要） | ✓ |
| `webNavigation.onErrorOccurred` | ✓ |
| `tabs.onUpdated` | ✓ |
| `webNavigation.onBeforeNavigate` | ・（サーバーのリダイレクト先は、新しい移動として扱われないため） |

## 仕様の出典

- <https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt>
- <https://developers.openai.com/siwc/token-sharing-open-source/sign-in>
- <https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference>

公式ドキュメントは、**拡張機能での利用には触れていません**（許可も禁止も書かれていません）。
公式に保証された使い方ではないため、仕様の変更で動かなくなる可能性があります。
