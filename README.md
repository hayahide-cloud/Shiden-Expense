# Shiden Expense（旧: ExpenseWeb）

`ExpenseVBA`（Excel VBA版・経費精算システム）のモバイル用コンパニオンWebアプリ。

スマホで領収書を撮影 → OpenAI Vision APIでOCR取込 → 明細として記録する。
ExpenseVBAを置き換えるものではなく**併用**する。月次集計・仕訳出力は引き続きExcel側（ExpenseVBA）で行う。

本リポジトリには2つの実装がある。**現在の運用はサーバーレス版（Shiden Expense）**。

| | Shiden Expense（`docs/`） | フル構成（`frontend/` + `backend/`） |
|---|---|---|
| 状態 | **運用中** | 実装済み・デプロイ保留（将来のセルフホスト移行先） |
| ホスティング | GitHub Pages（無料） | Railway or 自宅サーバー |
| サーバー | 不要（ブラウザから直接OpenAI API呼び出し） | FastAPI + PostgreSQL |
| データ保存先 | 端末内（localStorage） | PostgreSQL |
| コスト | OpenAI API利用料のみ | ＋ホスティング費 |

## Shiden Expense（サーバーレス版）

`docs/index.html` 1ファイルで完結する静的Webアプリ。紫基調のダークテーマ。

- 撮影 → その場でOCR（OpenAI Vision API直呼び） → 編集フォーム → 端末内に保存
- 証憑画像も端末内（IndexedDB）に保存。長辺1800pxのJPEGに自動縮小
- **手動トリミング（iOSの「書類をスキャン」風・全画面の編集フェーズ）**: 写真を選択すると
  ヘッダー・下部ナビを隠した全画面の編集画面に切り替わる。画像は画面内に完全に収まる
  サイズで表示されるためスクロールが存在せず、「解析する」「キャンセル」ボタンと
  補正のON/OFFは常に画面下部に見えている。画像の上に四隅の
  ドラッグハンドルを表示し、領収書の角に合わせて切り抜ける。初期位置は常に
  横15%・縦10%内側の固定位置（以前は背景との輝度差による自動検出を行っていたが、
  実写では明るい机・床を紙と誤検出することが多く、毎回同じ位置に出る予測可能な
  動作の方が合わせやすいため廃止）。切り抜き範囲の確定は人間が行うため、
  金額等が欠落する事故が起きない。
  傾けて撮った紙も解析時に射影変換（自前実装・逆写像＋バイリニア補間）でまっすぐに
  補正される。ドラッグ中は指で隠れる角の周辺を拡大鏡（約2.5倍・十字線つき）で表示する。
  さらに影消去（ブロック最大輝度による照明マップ推定→白基準の正規化。スキャナーアプリの
  「影消去」と同じ原理）と、明るさ・コントラストの自動補正（オートレベル）を
  ONにすると、影のかかった紙も均一な白にしてからOCR・保存に使える
  （どちらも既定はOFF＝元の写真のまま）。補正のON/OFFチェックを切り替えると
  編集中の画像プレビューへ即時反映され、その場で結果を確認できる（実際の保存・OCR用の
  補正は切り抜き後の高解像度画像に対して行う）。切り抜きは高解像度の元画像（長辺3600px）に対して
  行い、保存・送信用の1800px上限は切り抜き後に適用するため、切り抜いても粗くならない
- **交通費の取込（経路スクショ）**: Googleマップ等の経路検索アプリのスクリーンショットを
  選ぶと、運賃（IC運賃優先）・区間・路線名をOCRで読み取り、勘定科目「交通費」・
  摘要「出発地→到着地」の明細として確認・修正フォームに反映する。スクショは紙と違い
  傾き・影が無いため、トリミング編集をスキップして直接解析する。日付が写っていない
  場合は当日の日付を既定にする。スクショ自体は証憑画像として保存される
- 一覧・月フィルタ・合計表示
- 「取込」「一覧」「設定」タブは、画面を更新（リロード）しても直前まで開いていた
  タブのまま表示される（localStorageに記録）
- 「明細を編集」「内容を確認・修正」の画面も、開いたまま画面が更新されても復元される。
  編集中の既存明細はIDを記録して再度開き直す。OCR解析直後・手入力途中の未保存内容は
  下書きとしてlocalStorage（項目）＋IndexedDB（証憑画像）に保持し、保存またはキャンセル
  で消える。iOSがバックグラウンドでタブを再読み込みしてしまう場合でも、OCR解析の
  API呼び出し分の結果や入力内容が無駄にならないようにするための対応
- **ZIPエクスポート（CSV＋証憑画像）**: CSVの「元ファイル名」列とZIP内の画像ファイル
  （`日付_支払先_金額_ID.jpg`）が1対1で紐づく。経費精算の証憑提出にそのまま使える
- CSVのみのエクスポートも可能（UTF-8 BOM付き8列、ExpenseVBAの明細シートと同一列順）
- 一覧の行をタップすると編集画面が開く（証憑画像・取込日時は維持）。会議名・案件を
  記録する備考欄あり。「申請」「証憑画像を保存」「この明細を削除」もすべて編集画面に集約
  （一覧上にはボタンを置かず、誤タップを防いでいる）
- **「申請」ボタン**: Web共有API（`navigator.share`）で証憑画像＋明細をメール等に共有できる。
  対応環境ではメールアプリの作成画面が証憑画像添付済み・本文入力済みの状態で開く
  （宛先は仕様上事前入力できないため利用者が入力する）。非対応環境では`mailto:`にフォールバック
  - 共有先アプリが本文・添付を正しく展開しないことがある（例: Windows版新しいOutlookで
    添付が空ファイルになる・本文/件名が反映されない事例を確認済み。受信側アプリの実装の
    問題でこちら側では制御不可）ため、共有と同時に本文を自動でクリップボードにもコピーする
  - 各明細に「証憑画像を保存」ボタンを用意し、共有がうまくいかない場合は証憑画像を直接
    ダウンロードして手動添付できるようにしている
- **按分計算**（編集画面）: 複数人での飲み会等を一旦立て替えた後、1人あたりの請求額を
  出す機能。金額と人数から`Math.floor(金額 / 人数)`で1人分を計算し、端数は立て替えた
  本人が持つ前提（他の人には請求しない）。人数の既定値は1で、1＝按分なしの通常登録、
  2以上＝按分として記録、0は無効。2以上のときだけ一覧・編集画面・CSV
  （末尾に「按分人数」「1人あたり請求額」の2列を追加）・「申請」の共有本文に反映される。
  明細の金額欄自体はレシート記載の合計金額のまま変更しない
- APIキー・明細・画像はすべて端末内にのみ保存（サーバーに一切送信されない。送信先はOpenAIのみ）
- 設定タブに「OpenAIの利用状況を見る」リンクあり。OpenAIはAPIキー経由でクレジット残高を
  取得する公式APIを提供していないため（非公式・非推奨のエンドポイントのみ）、アプリ内に
  数値を表示する実装はせず、公式の利用状況ページを別タブで開く方式にとどめている
- iOS Safariの「ホーム画面に追加」でアプリのように起動（PWA manifest対応）

### 公開手順（GitHub Pages）

1. リポジトリをPublicに変更（Settings → General → Danger Zone → Change visibility）
   ※コード内に秘密情報は一切含まれない（APIキーは利用者が端末上で入力する方式）
2. Settings → Pages → Source: 「Deploy from a branch」→ Branch: `main` / フォルダ: `/docs` → Save
3. 数分後、`https://hayahide-cloud.github.io/Shiden-Expense/` で公開される
4. iPhoneのSafariでアクセス → 設定タブでAPIキーを入力 → 共有ボタン → 「ホーム画面に追加」

### 使い方

1. 「取込」タブで領収書を撮影 → 解析 → 内容確認・修正 → 保存
2. 月末に「一覧」タブで対象月を選び「ZIPエクスポート（CSV＋証憑画像）」→ 共有シートからOneDriveへ保存
3. PC側でZIPを展開し、CSVをExpenseVBAの明細シートへ取り込む。`images/`内の証憑画像は
   CSVの「元ファイル名」列で明細行と紐づく
4. エクスポート後、「設定」タブの「全明細を削除」で端末内を整理する（任意）

## 位置づけ

| | ExpenseVBA | Shiden Expense |
|---|---|---|
| 環境 | 会社PC（Excel VBA） | スマホ（Webブラウザ） |
| 役割 | 月次集計・仕訳出力 | 領収書撮影・OCR取込 |
| データ連携 | — | CSVエクスポート→Excelへ手動取込 |

## フル構成の技術スタック（デプロイ保留中）

Next.js（frontend） + FastAPI（backend） + PostgreSQL、Railwayでホスティング。
`hayahide-cloud/M.T.Works-hub`の`docs/RAILWAY_STACK_GUIDE.md`（紫電パレットで確立したパターン）に準拠。

## 構成

```
Shiden-Expense/
├── docs/        Shiden Expense（サーバーレス版・GitHub Pages公開用）★運用中
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

1. [railway.app](https://railway.app) で新規プロジェクト作成 → GitHubリポジトリ（`hayahide-cloud/Shiden-Expense`）を接続
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

1. `/capture` で領収書写真を撮影 →「解析する」→ 抽出結果を確認・修正 →「保存」
2. `/receipts` で一覧確認・月フィルタ・CSVエクスポート
3. エクスポートしたCSVを、ExpenseVBAの明細シートへコピー＆ペーストで取り込む（自動連携は未対応、手動ブリッジ）

## セキュリティ

- 単一オーナー専用の非公開ツール。全ページ・全APIをBasic認証で保護
- 領収書画像はサーバーに保存しない（解析後は破棄。ストレージコスト増加を避けるため）
