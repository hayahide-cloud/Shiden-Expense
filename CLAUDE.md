# CLAUDE.md（Shiden Expense）

本リポジトリはM.T.Worksエコシステムの一プロジェクト（旧名: ExpenseWeb。2026-07に紫電ブランドへ改名）。
全体の運用ルール・オーナーの嗜好は `hayahide-cloud/M.T.Works-hub` の CLAUDE.md を正本とする。

## このプロジェクト固有のルール

- **ExpenseVBAを置き換えない**。スマホでの撮影・OCR取込を担うコンパニオンであり、
  月次集計・仕訳出力は引き続き`hayahide-cloud/ExpenseVBA`（Excel VBA）側が担当する
- OCRのプロンプト・抽出スキーマ（date/vendor/amount/category/memo）・「要確認」判定順序は
  ExpenseVBAの`src/modReceiptOCR.bas`と同一に保つ（Excel側とWeb側で抽出品質・データ意味論を揃えるため）
- モデルは`OPENAI_MODEL`環境変数、既定値`gpt-5.4`。`gpt-4o-mini`にフォールバックしない
  （手書き数字の誤読が多いと実機検証済み）。`gpt-5.5`は`model_not_found`で使用不可と判明済みなので使わない
- レシート画像はサーバーに保存しない（ExpenseVBAもファイル名参照のみで画像を保存しない設計に合わせる）
- 勘定科目は固定6値（交通費・会議費・消耗品費・交際費・通信費・雑費）。マスタテーブル化はしない
- ディレクトリ構成・Basic認証パターン・Railwayデプロイ手順は
  `hayahide-cloud/M.T.Works-hub`の`docs/RAILWAY_STACK_GUIDE.md`に準拠する
- ただし本アプリは単一オーナー専用の非公開データのみを扱うため、紫電パレットの
  「公開閲覧+管理者のみ認証」パターンとは異なり、**全ページ・全APIをBasic認証で保護**する
  （`frontend/src/middleware.ts`が全ルートで認証チャレンジを行う）

## Shiden Expense（docs/index.html）のルール

- UIに関わる変更をpushする時は、`docs/index.html`内の`APP_VERSION`定数を必ず更新する。
  設定タブに表示され、GitHub PagesのCDNキャッシュ（約10分）で旧バージョンが
  表示されていないかをオーナーが実機で確認するために使う

## 作業完了時の確認

- `backend/app/services/vision_service.py`のプロンプトを変更したら、ExpenseVBA側の
  `modReceiptOCR.bas`も同期すべきか確認する（逆も同様）
- スキーマ変更時はAlembicマイグレーションを追加し、`README.md`のセットアップ手順が
  古くなっていないか確認する
- M.T.Works-hub側の`CURRENT_STATUS.md`のExpenseVBA/Shiden Expenseセクション更新が必要か確認する
