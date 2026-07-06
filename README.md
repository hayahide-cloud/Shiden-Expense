# ExpenseWeb

`ExpenseVBA`（Excel VBA版・経費精算システム）のモバイル用コンパニオンWebアプリ。

スマホでレシートを撮影 → OpenAI Vision APIでOCR取込 → 明細として記録する。
ExpenseVBAを置き換えるものではなく**併用**する。月次集計・仕訳出力は引き続きExcel側（ExpenseVBA）で行う。

本リポジトリには2つの実装がある。**現在の運用はLite版**。

| | ExpenseWeb Lite（`docs/`） | ExpenseWeb フル構成（`frontend/` + `backend/`） |
|---|---|---|
| 状態 | **運用中** | 実装済み・デプロイ保留（将来のセルフホスト移行先） |
| ホスティング | GitHub Pages（無料） | Railway or 自宅サーバー |
| サーバー | 不要（ブラウザから直接OpenAI API呼び出し） | FastAPI + PostgreSQL |
| データ保存先 | 端末内（localStorage） | PostgreSQL |
| コスト | OpenAI API利用料のみ | ＋ホスティング費 |

## ExpenseWeb Lite（サーバーレス版）

`docs/index.html` 1ファイルで完結する静的Webアプリ。紫基調のダークテーマ。

- 撮影 → その場でOCR（OpenAI Vision API直呼び） → 編集フォーム → 端末内に保存
- 一覧・月フィルタ・合計表示・CSVエクスポート（UTF-8 BOM付き8列、ExpenseVBAの明細シートと同一列順）
- APIキー・明細データは端末のlocalStorageにのみ保存（サーバーに一切送信されない。送信先はOpenAIのみ）
- iOS Safariの「ホーム画面に追加」でアプリのように起動（PWA manifest対応）

### 公開手順（GitHub Pages）

1. リポジトリをPublicに変更（Settings → General → Danger Zone → Change visibility）
   ※コード内に秘密情報は一切含まれない（APIキーは利用者が端末上で入力する方式）
2. Settings → Pages → Source: 「Deploy from a branch」→ Branch: `main` / フォルダ: `/docs` → Save
3. 数分後、`https://hayahide-cloud.github.io/ExpenseWeb/` で公開される
4. iPhoneのSafariでアクセス → 設定タブでAPIキーを入力 → 共有ボタン → 「ホーム画面に追加」

### 使い方

1. 「取込」タブでレシートを撮影 → 解析 → 内容確認・修正 → 保存
2. 月末に「一覧」タブで対象月を選び「CSVエクスポート」→ 共有シートからOneDriveへ保存
3. PC側でExpenseVBAの明細シートへ取り込む

## 位置づけ

| | ExpenseVBA | ExpenseWeb |
|---|---|---|
| 環境 | 会社PC（Excel VBA） | スマホ（Webブラウザ） |
| 役割 | 月次集計・仕訳出力 | レシート撮影・OCR取込 |
| データ連携 | — | CSVエクスポート→Excelへ手動取込 |

## フル構成の技術スタック（デプロイ保留中）

Next.js（frontend） + FastAPI（backend） + PostgreSQL、Railwayでホスティング。
`hayahide-cloud/M.T.Works-hub`の`docs/RAILWAY_STACK_GUIDE.md`（紫電パレットで確立したパターン）に準拠。

## 構成

```
ExpenseWeb/
├── docs/        ExpenseWeb Lite（サーバーレス版・GitHub Pages公開用）★運用中
├── frontend/    Next.js App Router（撮影・一覧・CSVエクスポート画面）
├── backend/     FastAPI（OCR解析・DB・CSV出力API）
└── CLAUDE.md
```

## ローカル開発

### backend

```bash
docker run -d -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16

cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

DATABASE_URL=postgresql://postgres:dev@localhost/expenseweb alembic upgrade head
DATABASE_URL=postgresql://postgres:dev@localhost/expenseweb \
  ADMIN_USERNAME=admin ADMIN_PASSWORD=devpass \
  OPENAI_API_KEY=sk-xxxx OPENAI_MODEL=gpt-5.4 \
  uvicorn app.main:app --reload
```

テスト（OpenAI呼び出しはモック、実課金なし）:

```bash
cd backend
pytest
```

### frontend

```bash
cd frontend
npm install
API_BASE_URL=http://localhost:8000/api/v1 \
  ADMIN_USERNAME=admin ADMIN_PASSWORD=devpass \
  npm run dev
```

ブラウザで `http://localhost:3000` を開き、Basic認証（admin / devpass）でログインする。

## Railwayへのデプロイ手順

`docs/RAILWAY_STACK_GUIDE.md`のRailwayセットアップ手順（3サービス構成）に準拠。

1. [railway.app](https://railway.app) で新規プロジェクト作成 → GitHubリポジトリ（`hayahide-cloud/ExpenseWeb`）を接続
2. サービスを3つ追加
   - **PostgreSQL**（Railwayテンプレート、自動作成）
   - **backend**（Root Directory: `backend`）
     - Build Command: `pip install -r requirements.txt && alembic upgrade head`
     - Start Command: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
     - 環境変数: `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `OPENAI_API_KEY`, `OPENAI_MODEL=gpt-5.4`
   - **frontend**（Root Directory: `frontend`）
     - Build Command: `npm ci && npm run build`
     - Start Command: `npm start`
     - 環境変数: `API_BASE_URL=http://${{backend.RAILWAY_PRIVATE_DOMAIN}}/api/v1`, `ADMIN_USERNAME`（backendと同じ）, `ADMIN_PASSWORD`（backendと同じ）
3. frontendサービス → Settings → Networking → 「Generate Domain」で公開URLを発行
4. 発行されたURLにスマホのSafariでアクセスし、Basic認証でログイン後、「ホーム画面に追加」でアプリのように起動できる

## 使い方

1. `/capture` でレシート写真を撮影 →「解析する」→ 抽出結果を確認・修正 →「保存」
2. `/receipts` で一覧確認・月フィルタ・CSVエクスポート
3. エクスポートしたCSVを、ExpenseVBAの明細シートへコピー＆ペーストで取り込む（自動連携は未対応、手動ブリッジ）

## セキュリティ

- 単一オーナー専用の非公開ツール。全ページ・全APIをBasic認証で保護
- レシート画像はサーバーに保存しない（解析後は破棄。ストレージコスト増加を避けるため）
