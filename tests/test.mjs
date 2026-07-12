// ExpenseWeb Liteの動作検証: コアロジックのアサーション + UIフローのスクリーンショット
import { chromium } from "playwright";

const page_url = new URL("../docs/index.html", import.meta.url).href;
const shots = new URL("./shots", import.meta.url).pathname;
import("node:fs").then((fs) => fs.mkdirSync(shots, { recursive: true }));

const iPhone = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};

let failures = 0;
function assert(cond, name) {
  if (cond) console.log(`PASS: ${name}`);
  else { console.error(`FAIL: ${name}`); failures++; }
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext(iPhone);
const page = await context.newPage();
page.on("pageerror", (err) => { console.error("PAGE ERROR:", err.message); failures++; });
page.on("console", (msg) => { if (msg.type() === "error") console.error("CONSOLE ERROR:", msg.text()); });

await page.goto(page_url);
await page.waitForLoadState("domcontentloaded");

// --- コアロジック検証 ---
const logic = await page.evaluate(() => {
  const results = {};
  results.reviewNone = computeNeedsReview("2026-07-06", "テスト商店", 1000, "交通費");
  results.reviewDateOnly = computeNeedsReview("", "テスト商店", 1000, "交通費");
  results.reviewMulti = computeNeedsReview("", "", 0, "交通費");
  results.csv = buildCsv([{
    created_at: "2026-07-06T12:00:00.000Z",
    date: "2026-07-06", vendor: "テスト,商店", amount: 1000,
    category: "交通費", memo: "テスト", needs_review: "", note: "7月定例会議",
  }]);
  return results;
});

assert(logic.reviewNone === "", "needs_review: 全項目ありなら空");
assert(logic.reviewDateOnly === "要確認: 日付が未検出", "needs_review: 日付のみ欠落");
assert(logic.reviewMulti === "要確認: 日付・支払先・金額が未検出", "needs_review: 複数欠落の固定順序");
assert(logic.csv.startsWith("﻿"), "CSV: BOM付き");
assert(logic.csv.includes("取込日時,領収書日付,支払先,金額,勘定科目,摘要,元ファイル名,要確認,備考"), "CSV: 9列ヘッダー（備考が末尾）");
assert(logic.csv.includes('"テスト,商店"'), "CSV: カンマ含む値のエスケープ");
assert(logic.csv.includes("(Shiden取込)"), "CSV: 元ファイル名マーカー");
assert(logic.csv.includes("7月定例会議"), "CSV: 備考列が出力される");

// --- UIフロー検証 ---
await page.screenshot({ path: `${shots}/1_capture.png` });

// 選択シートの並びをClaude同様にするためaccept="image/*,video/*"にしているが、
// OCR解析は画像のみ対応なので動画が選ばれたらJS側で弾く
await page.setInputFiles("#image-input", {
  name: "clip.mp4", mimeType: "video/mp4", buffer: Buffer.from("dummy"),
});
const editorHiddenAfterVideo = await page.locator("#crop-editor.hidden").count();
assert(editorHiddenAfterVideo === 1, "動画選択: 全画面エディタは開かない");
const videoErrorShown = await page.isVisible("#capture-message .banner.error");
assert(videoErrorShown, "動画選択: エラーメッセージが表示される");

// 手入力フローで保存
await page.click("#manual-btn");
await page.waitForSelector("#form-step:not(.hidden)");
assert(await page.isVisible("#review-banner"), "手入力: 要確認バナー表示（全項目空）");
const deleteHiddenOnNew = await page.locator("#delete-btn.hidden").count();
assert(deleteHiddenOnNew === 1, "新規: 削除ボタンは表示されない（既存明細の編集時のみ）");
await page.fill("#f-date", "2026-07-06");
await page.fill("#f-vendor", "割烹よし田");
await page.fill("#f-amount", "29720");
const amountDisplay = await page.inputValue("#f-amount");
assert(amountDisplay === "29,720", `金額入力: カンマ区切り表示（実際: ${amountDisplay}）`);
// 数字以外の文字は破棄され、既存のカンマは二重にならない
await page.fill("#f-amount", "abc1,2340xyz");
const amountSanitized = await page.inputValue("#f-amount");
assert(amountSanitized === "12,340", `金額入力: 数字以外を除去して再整形（実際: ${amountSanitized}）`);
await page.fill("#f-amount", "29720");
await page.selectOption("#f-category", "会議費");
await page.fill("#f-memo", "御食事代");
await page.screenshot({ path: `${shots}/2_form.png` });
await page.click("#save-btn");
await page.waitForSelector("#capture-step:not(.hidden)");

// 2件目（要確認あり: 金額0）
await page.click("#manual-btn");
await page.fill("#f-vendor", "コンビニ");
await page.selectOption("#f-category", "消耗品費");
await page.click("#save-btn");

// 一覧タブ
await page.click('nav button[data-panel="list"]');
await page.waitForSelector("#panel-list.active");
const itemCount = await page.locator(".receipt-item").count();
assert(itemCount === 2, `一覧: 2件表示（実際: ${itemCount}件）`);
const total = await page.textContent("#total-label");
assert(total === "¥29,720", `一覧: 合計金額表示（実際: ${total}）`);
const reviewCount = await page.locator(".receipt-item .review").count();
assert(reviewCount === 1, `一覧: 要確認表示は1件のみ（実際: ${reviewCount}件）`);
const noNoteTitle = await page.locator(".receipt-item", { hasText: "コンビニ" }).locator(".vendor-text").textContent();
assert(noNoteTitle === "未設定", `一覧: 依頼内容・用途が未記入なら「未設定」表示（実際: ${noNoteTitle}）`);
// --- 並び順: 既定は追加順（新しい順）。日付順に切り替えると日付なしは末尾へ ---
// 追加順: コンビニ（後に追加・日付なし）が先頭 / 日付順: 割烹よし田（2026-07-06）が先頭
const firstByCreated = await page.locator(".receipt-item .meta").first().textContent();
assert(firstByCreated.includes("コンビニ"), `並び順: 追加順では後から追加した行が先頭（実際: ${firstByCreated.split("\n")[1]}）`);
await page.selectOption("#sort-order", "date");
const firstByDate = await page.locator(".receipt-item .meta").first().textContent();
assert(firstByDate.includes("割烹よし田"), `並び順: 日付順では日付ありの行が先頭・日付なしは末尾（実際: ${firstByDate.split("\n")[1]}）`);
const sortSaved = await page.evaluate(() => localStorage.getItem("shiden_expense_sort_order"));
assert(sortSaved === "date", "並び順: 選択がlocalStorageに記録される");
await page.selectOption("#sort-order", "created"); // 以降のテストは追加順の前提のため戻す
// 種別の色分け: 交通費でない行は「購入・立替」バッジ、transitクラスなし
const purchaseBadge = await page.locator(".receipt-item .type-badge").first().textContent();
assert(purchaseBadge === "🧾 購入・立替", `一覧: 購入費・立替費のバッジ表示（実際: ${purchaseBadge}）`);
const exportCardVisible = await page.evaluate(() => document.getElementById("export-zip-btn").offsetParent !== null);
assert(exportCardVisible, "一覧: 絞り込み・エクスポートカードが表示されている");
const wrongTransitCount = await page.locator(".receipt-item.transit").count();
assert(wrongTransitCount === 0, `一覧: 交通費でない行にtransitクラスが付かない（実際: ${wrongTransitCount}件）`);
await page.screenshot({ path: `${shots}/3_list.png` });

// 月フィルタ（2026-07に絞る → 日付なしの2件目は除外される）
// 「絞り込み・エクスポート」カードは一旦UI非表示にしたが機能とテストは維持するため、force:trueで操作する
await page.fill("#month-filter", "2026-07", { force: true });
await page.dispatchEvent("#month-filter", "change");
const filtered = await page.locator(".receipt-item").count();
assert(filtered === 1, `月フィルタ: 2026-07で1件（実際: ${filtered}件）`);

// CSVダウンロード
await page.fill("#month-filter", "", { force: true });
await page.dispatchEvent("#month-filter", "change");
// display:noneの要素はforce:trueでもクリック座標を計算できずエラーになるため、
// ページ内で直接click()を呼ぶ
const downloadPromise = page.waitForEvent("download");
await page.evaluate(() => document.getElementById("export-btn").click());
const download = await downloadPromise;
assert(download.suggestedFilename() === "receipts_all.csv", `CSV: ファイル名（実際: ${download.suggestedFilename()}）`);

// 設定タブ
await page.click('nav button[data-panel="settings"]');
await page.waitForSelector("#panel-settings.active");
const modelDefault = await page.inputValue("#s-model");
assert(modelDefault === "gpt-5.4", `設定: モデル初期値gpt-5.4（実際: ${modelDefault}）`);

// プルダウンからモデルを選んで保存できる
await page.selectOption("#s-model", "gpt-4.1-mini");
await page.click("#settings-save-btn");
const savedModel = await page.evaluate(() => JSON.parse(localStorage.getItem("shiden_expense_settings")).model);
assert(savedModel === "gpt-4.1-mini", `設定: プルダウンで選んだモデルが保存される（実際: ${savedModel}）`);
await page.selectOption("#s-model", "gpt-5.4");
await page.click("#settings-save-btn");

// APIキーを未設定の状態から保存 → 入力欄は保存後に空へ戻り、末尾4文字だけplaceholderに出る
// （alertはリスナー未登録だとPlaywrightが自動でdismissする）
await page.fill("#s-apikey", "sk-test-abcd1234");
await page.click("#settings-save-btn");
const apiKeyValueAfterSave = await page.inputValue("#s-apikey");
assert(apiKeyValueAfterSave === "", `設定: 保存後にAPIキー入力欄が空になる（実際: ${apiKeyValueAfterSave}）`);
const apiKeyPlaceholder = await page.getAttribute("#s-apikey", "placeholder");
assert(apiKeyPlaceholder.includes("1234"), `設定: placeholderに末尾4文字が出る（実際: ${apiKeyPlaceholder}）`);

// 空欄のまま再保存しても既存のAPIキーは消えない（表示は毎回空欄にしているため）
await page.click("#settings-save-btn");
const savedApiKey = await page.evaluate(() => JSON.parse(localStorage.getItem("shiden_expense_settings")).apiKey);
assert(savedApiKey === "sk-test-abcd1234", `設定: 空欄のまま保存しても既存キーが保持される（実際: ${savedApiKey}）`);

await page.screenshot({ path: `${shots}/4_settings.png` });

// 削除フロー: 一覧の行をタップして編集画面を開き、削除ボタンで削除する
// （編集・削除ともに専用ボタンは一覧上になく、編集画面からのみ行う仕様）
page.on("dialog", (d) => d.accept());
await page.click('nav button[data-panel="list"]');
await page.locator(".receipt-item").first().click();
await page.waitForSelector("#form-step:not(.hidden)");
const deleteVisibleOnEdit = await page.isVisible("#delete-btn");
assert(deleteVisibleOnEdit, "編集: 既存明細では削除ボタンが表示される");
await page.click("#delete-btn");
await page.waitForSelector("#panel-list.active");
const afterDelete = await page.locator(".receipt-item").count();
assert(afterDelete === 1, `削除: 1件になる（実際: ${afterDelete}件）`);

// 編集フロー: 一覧の行をタップ → フォームに既存値 → 修正・備考追加 → 更新
await page.locator(".receipt-item").first().click();
await page.waitForSelector("#form-step:not(.hidden)");
const editTitle = await page.textContent("#form-title");
assert(editTitle === "明細を編集", `編集: フォームタイトル（実際: ${editTitle}）`);
const editVendor = await page.inputValue("#f-vendor");
assert(editVendor === "割烹よし田", `編集: 既存値がフォームに反映（実際: ${editVendor}）`);
await page.fill("#f-vendor", "割烹よし田 博多");
await page.fill("#f-note", "INPEX労組との会食");
await page.click("#save-btn");
await page.waitForSelector("#panel-list.active");
const editedCount = await page.locator(".receipt-item").count();
assert(editedCount === 1, `編集: 件数が増えない（実際: ${editedCount}件）`);
// 備考(note)がある場合は主見出し(.vendor)に備考、支払先はメタ情報側へ表示される
const editedTitle = await page.textContent(".receipt-item .vendor-text");
assert(editedTitle === "INPEX労組との会食", `編集: 備考ありは主見出しが備考になる（実際: ${editedTitle}）`);
const editedMeta = await page.textContent(".receipt-item .meta");
assert(editedMeta.includes("割烹よし田 博多"), `編集: 支払先がメタ情報に表示される（実際: ${editedMeta}）`);
// 勘定科目と摘要は別の行（「 / 」区切りの1行ではない）
assert(/会議費\n/.test(editedMeta) && !editedMeta.includes("会議費 / "),
  `一覧: 勘定科目と摘要が別行で表示される（実際: ${JSON.stringify(editedMeta)}）`);

// 依頼内容・用途は2行のtextareaで、改行を含めて保存できる。CSVでは引用符でエスケープされる
await page.locator(".receipt-item").first().click();
await page.waitForSelector("#form-step:not(.hidden)");
const noteTag = await page.evaluate(() => document.getElementById("f-note").tagName);
assert(noteTag === "TEXTAREA", `備考: 入力欄がtextareaになっている（実際: ${noteTag}）`);
await page.fill("#f-note", "INPEX労組との会食\n2次会分も含む");
await page.click("#save-btn");
await page.waitForSelector("#panel-list.active");
const savedNote = await page.evaluate(() => JSON.parse(localStorage.getItem("shiden_expense_receipts"))[0].note);
assert(savedNote === "INPEX労組との会食\n2次会分も含む", `備考: 改行を含めて保存される（実際: ${JSON.stringify(savedNote)}）`);
// 一覧の主見出しは改行がそのまま2行で表示される（white-space: pre-line）。
// 2行目以降の左端はアイコンの下ではなく本文の頭に揃う（ぶら下げインデント）
const noteDisplay = await page.evaluate(() => {
  const el = document.querySelector(".receipt-item .vendor-text");
  const clip = document.querySelector(".receipt-item .vendor .clip");
  return {
    ws: getComputedStyle(el).whiteSpace,
    text: el.textContent,
    indented: el.getBoundingClientRect().left > clip.getBoundingClientRect().right,
  };
});
assert(noteDisplay.ws === "pre-line" && noteDisplay.text.includes("\n"),
  `備考: 一覧表示で改行が反映される（white-space: ${noteDisplay.ws}）`);
assert(noteDisplay.indented, "備考: 本文がアイコンの右に独立して配置される（2行目の字下げ）");
const multilineCsv = await page.evaluate(() => buildCsv(JSON.parse(localStorage.getItem("shiden_expense_receipts"))));
assert(multilineCsv.includes('"INPEX労組との会食\n2次会分も含む"'), "備考: 改行を含むCSV列が引用符でエスケープされる");
const shareSubject = await page.evaluate(() => buildShareText(JSON.parse(localStorage.getItem("shiden_expense_receipts"))[0]).subject);
assert(!shareSubject.includes("\n") && shareSubject.includes("INPEX労組との会食"), `備考: 申請の件名は1行目のみ使い改行が入らない（実際: ${shareSubject}）`);

// 成功メッセージ（保存しました等）は数秒で自動的に消える。エラーは残る
await page.click('nav button[data-panel="capture"]');
await page.evaluate(() => showMessage("ok", "保存しました。テスト"));
const okShown = await page.isVisible("#capture-message .banner.ok");
assert(okShown, "メッセージ: 成功バナーが表示される");
await page.waitForSelector("#capture-message .banner.ok", { state: "detached", timeout: 6000 });
assert(true, "メッセージ: 成功バナーは数秒で自動的に消える");
await page.evaluate(() => showMessage("error", "エラー。テスト"));
await page.waitForTimeout(4500);
const errStillShown = await page.isVisible("#capture-message .banner.error");
assert(errStillShown, "メッセージ: エラーバナーは自動では消えない");
await page.evaluate(() => showMessage("", ""));

// 旧バージョンで保存された選択肢に無いモデル値は、読み込み時に既定値へ戻る
await page.evaluate(() => localStorage.setItem("shiden_expense_settings", JSON.stringify({ apiKey: "sk-test", model: "gpt-4o-mini" })));
await page.reload();
await page.waitForLoadState("domcontentloaded");
const fallbackModel = await page.inputValue("#s-model");
assert(fallbackModel === "gpt-5.4", `設定: 選択肢に無い保存値は既定値に戻る（実際: ${fallbackModel}）`);

await browser.close();
console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
