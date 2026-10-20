# 配布用の zip と、改ざん確認用の SHA-256 チェックサムを作ります。
#
# 使い方（PowerShell）:
#   .\tools\make-release.ps1 -RepoUrl https://github.com/<ユーザー名>/<リポジトリ名>
#   ブラウザでの通し確認も行う場合: .\tools\make-release.ps1 -RepoUrl ... -BrowserPath "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
#
# 作られるもの:
#   dist\ai-consult-<バージョン>.zip             … 配る zip（README.txt・manual.md・LICENSE・CHANGELOG.md・extension フォルダ）
#   dist\ai-consult-<バージョン>.zip.sha256.txt  … zip の SHA-256（受け取る人が照合する）
#   releases\                                    … Git 管理用。最新版の zip と SHA-256 だけを置く（古い版は、Git の履歴に残る）
#   README.md のダウンロード欄（<!-- release:start --> と <!-- release:end --> の間）を更新する
#
# main ブランチでだけ実行してください（releases の zip はバイナリで、複数のブランチから取り込むと衝突するため）。
param(
  [string]$OutDir = (Join-Path $PSScriptRoot '..\dist'),
  # 公式の入手先（GitHub のリポジトリ URL）。指定すると、ダウンロード欄を、押すとそのまま保存できるリンクにする（なりすまし・改変版対策）。
  [string]$RepoUrl = '',
  # 指定すると、実際のブラウザでの通し確認（tests\e2e.mjs と tests\e2e-chatgpt.mjs）も行う。
  [string]$BrowserPath = ''
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ext = Join-Path $root 'extension'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js が見つかりません。配布前の安全確認（監査・テスト）に使います。'
}

# 1. 配布前の安全確認。ひとつでも失敗したら、配布物は作らない。
Write-Host '== 安全確認（静的監査・自動テスト）' -ForegroundColor Cyan
& node (Join-Path $root 'tests\static-audit.mjs') | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'tests\static-audit.mjs が失敗しました。配布物は作りません。' }
& node --test (Join-Path $root 'tests\unit.mjs') | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'tests\unit.mjs が失敗しました。配布物は作りません。' }
if ($BrowserPath) {
  foreach ($script in @('tests\e2e.mjs', 'tests\e2e-chatgpt.mjs')) {
    & node (Join-Path $root $script) $BrowserPath | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "$script が失敗しました。配布物は作りません。" }
  }
} else {
  Write-Host '（ブラウザでの通し確認は、-BrowserPath を指定したときだけ行います）' -ForegroundColor DarkGray
}

# 2. 配布物を組み立てる（zip の中身: README.txt・manual.md・LICENSE・CHANGELOG.md と extension フォルダ）
$manifest = Get-Content (Join-Path $ext 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $manifest.version
$name = "ai-consult-$version"

$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("$name-" + [guid]::NewGuid().ToString('N'))
$pkg = Join-Path $stage $name
New-Item -ItemType Directory -Force -Path $pkg | Out-Null
Copy-Item -Recurse -Force $ext (Join-Path $pkg 'extension')

# 使い方・仕組み・安全面の説明（README.md）を、manual.md として同梱する。
# README.md の「ダウンロード欄」は、zip の SHA-256 を含むため、zip の中には入れない（自己参照になるので、取り除く）。
$readmePath = Join-Path $root 'README.md'
$readmeText = [System.IO.File]::ReadAllText($readmePath, [System.Text.Encoding]::UTF8)
$releaseBlock = '(?s)<!-- release:start -->.*?<!-- release:end -->\r?\n?'
$manual = [regex]::Replace($readmeText, $releaseBlock, '')
[System.IO.File]::WriteAllText((Join-Path $pkg 'manual.md'), $manual, (New-Object System.Text.UTF8Encoding($false)))

# ライセンス（MIT）を同梱する。MIT は、複製物にライセンスの文面を含めることを条件にしているため。
Copy-Item (Join-Path $root 'LICENSE') (Join-Path $pkg 'LICENSE')
# 変更履歴を同梱する（静的な監査が、先頭の版が manifest のバージョンと一致することを確認する）。
Copy-Item (Join-Path $root 'CHANGELOG.md') (Join-Path $pkg 'CHANGELOG.md')

$readme = @"
AIに相談  バージョン $version

■ これは何？
  ブラウザ(Brave / Chrome など)で、いま見ているページについて、AI に相談できるサイドパネルの拡張機能です。
  次の 4 つから、パネルの上部で切り替えて使えます。
    ・Gemini（Google。APIキーが必要。無料枠あり）
    ・OpenAI（APIキーが必要。有料）
    ・Claude（Anthropic。APIキーが必要。有料）
    ・ChatGPT のプラン（Plus / Pro など。APIキーは不要で、ChatGPT アカウントでサインインします）

■ 入れ方
  1. この zip を展開し、できたフォルダを「移動・削除しない場所」に置く（例: ドキュメント）
  2. ブラウザで brave://extensions（Chrome は chrome://extensions）を開く
  3. 右上の「デベロッパーモード」をオンにする
  4. 「パッケージ化されていない拡張機能を読み込む」→ このフォルダの中の「extension」フォルダを選ぶ
  5. 拡張機能の「詳細」→「拡張機能のオプション」を開き、注意事項を読んでチェックを入れる
  6. 使う提供元の APIキーを入力して「保存」を押す。ChatGPT のプランを使う場合は「ChatGPT でサインイン」を押して承認する
  7. 相談したいページで、ツールバーの拡張機能のアイコンをクリックする（もう一度クリックすると閉じる）

■ とても大事なこと
  - 鍵は「あなた専用」です。配布した人のキーやアカウントは使えません。各社のサイトで、ご自身で作成してください。
  - APIキー・サインイン情報を、他の人に教えない・画面ごと共有しない・メールやチャットに貼らないでください。
  - 質問を送ると、表示中のページの本文が、選んだ提供元（Google・OpenAI・Anthropic）に送信されます。
    メール・社内文書・個人情報や機密情報を含むページでは使わないでください。
  - Gemini の無料枠では、送った内容が Google の製品改善に使われ、人が確認することがあります。
  - OpenAI・Claude の API は有料（従量課金）です。ChatGPT や Claude.ai の契約とは別に、キーと残高が必要です。
  - ChatGPT のプランで使うと、質問した分だけ、ご契約の利用枠が減ります。OpenAI の公式ドキュメントは、
    ブラウザの拡張機能での利用に触れていません。仕様変更で使えなくなる可能性があります。

■ 配布物が改ざんされていないか確認する（おすすめ）
  PowerShell で次を実行し、配布した人から別の方法で受け取った SHA-256 の値と一致することを確認します。
    Get-FileHash .\ai-consult-$version.zip -Algorithm SHA256

■ 詳しい説明
  同梱の manual.md（使い方・仕組み・安全面）を、テキストエディタやブラウザで開いてご覧ください。

■ 変更履歴
  同梱の CHANGELOG.md を参照してください。

■ ライセンス
  MIT License（同梱の LICENSE を参照）。無保証で提供します。個人が作成した非公式のツールで、各社とは関係がありません。
"@
# Windows のメモ帳でも文字化けしないよう、BOM 付き UTF-8 で書く
[System.IO.File]::WriteAllText((Join-Path $pkg 'README.txt'), $readme, (New-Object System.Text.UTF8Encoding($true)))

# 3. zip にして、SHA-256 を記録する
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$zip = Join-Path (Resolve-Path $OutDir).Path "$name.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
# zip の規格どおり、フォルダ区切りは「/」にする（Mac や他の解凍ソフトでも正しく展開できるように）
$fileStream = [System.IO.File]::Open($zip, [System.IO.FileMode]::Create)
$archive = New-Object System.IO.Compression.ZipArchive($fileStream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  Get-ChildItem $pkg -Recurse -File | ForEach-Object {
    $entryName = $_.FullName.Substring($stage.Length + 1).Replace('\', '/')
    $entry = $archive.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
    $entryStream = $entry.Open()
    $source = [System.IO.File]::OpenRead($_.FullName)
    try { $source.CopyTo($entryStream) } finally { $source.Dispose(); $entryStream.Dispose() }
  }
} finally {
  $archive.Dispose()
  $fileStream.Dispose()
}
Remove-Item -Recurse -Force $stage

$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
$sumFile = "$zip.sha256.txt"
[System.IO.File]::WriteAllText($sumFile, "$hash *$(Split-Path $zip -Leaf)`r`n", (New-Object System.Text.UTF8Encoding($false)))

# 4. Git 管理用: リポジトリ直下の releases\ に、最新版の zip と SHA-256 だけを置き、README のダウンロード欄を更新する。
#    古い版は、Git の履歴に残る。
$releasesDir = Join-Path $root 'releases'
New-Item -ItemType Directory -Force -Path $releasesDir | Out-Null
Get-ChildItem $releasesDir -Filter 'ai-consult-*' -File | Remove-Item -Force
Copy-Item $zip $releasesDir
Copy-Item $sumFile $releasesDir

$zipLeaf = Split-Path $zip -Leaf
$readmeUpdated = $false
$pattern = '(?s)<!-- release:start -->.*?<!-- release:end -->'
if ($readmeText -match $pattern) {
  # RepoUrl があれば、押すとそのままダウンロードが始まるリンクにする（なければ、リポジトリ内のファイルへのリンク）
  $zipLink = if ($RepoUrl) { "$($RepoUrl.TrimEnd('/'))/raw/main/releases/$zipLeaf" } else { "releases/$zipLeaf" }
  $repoLine = ''
  if ($RepoUrl) {
    $repoLine = "`n> **公式の入手先:** <$($RepoUrl.TrimEnd('/'))>`n> これ以外の場所で配布されているものは、改変されている可能性があります。入手先を確認してください。`n"
  }
  $block = @"
<!-- release:start -->
$repoLine
| | |
| --- | --- |
| 最新バージョン | **$version**（$(Get-Date -Format 'yyyy年M月d日') 更新） |
| ダウンロード | [``$zipLeaf``]($zipLink) |
| SHA-256 | ``$hash`` |
<!-- release:end -->
"@
  $block = $block.TrimEnd("`r", "`n")
  $new = [regex]::Replace($readmeText, $pattern, { param($m) $block })
  [System.IO.File]::WriteAllText($readmePath, $new, (New-Object System.Text.UTF8Encoding($false)))
  $readmeUpdated = $true
}

Write-Host ''
Write-Host '== 完成' -ForegroundColor Green
Write-Host "  zip    : $zip"
Write-Host "  SHA-256: $hash"
Write-Host "  releases: $(Join-Path $releasesDir $zipLeaf)（Git 管理用。最新版だけを置きます）"
Write-Host "  README  : $(if ($readmeUpdated) { 'README.md のダウンロード欄を更新しました' } else { 'README.md に <!-- release:start --> の目印がないため、更新していません' })"
Write-Host ''
Write-Host 'Git で公開するとき: git add -A → git commit -m "変更の説明" → git push'
Write-Host '配るときは、zip と SHA-256 の値を「別の経路」でも送ると、すり替えに気づきやすくなります。'
