// 按分計算機能の検証
import { chromium } from "playwright";

const page_url = new URL("../docs/index.html", import.meta.url).href;

let failures = 0;
function assert(cond, name) {
  if (cond) console.log(`PASS: ${name}`);
  else { console.error(`FAIL: ${name}`); failures++; }
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
page.on("pageerror", (err) => { console.error("PAGE ERROR:", err.message); failures++; });
await page.goto(page_url);
await page.waitForLoadState("domcontentloaded");

await page.click("#manual-btn");
await page.waitForSelector("#form-step:not(.hidden)");

const panelHiddenInitially = await page.locator("#split-panel.hidden").count();
assert(panelHiddenInitially === 1, "按分: 初期状態では閉じている");

await page.click("#split-toggle-btn");
await page.waitForSelector("#split-panel:not(.hidden)");
const toggleLabelOpen = await page.textContent("#split-toggle-btn");
assert(toggleLabelOpen === "👥 按分計算を閉じる", `按分: 開くとラベルが変わる（実際: ${toggleLabelOpen}）`);

await page.fill("#f-amount", "10000");
await page.fill("#split-people", "3");
const result1 = await page.textContent("#split-result");
assert(result1 === "1人あたり ¥3,333（端数¥1は自分持ち）", `按分: 端数ありの計算（実際: ${result1}）`);

// 割り切れる場合は端数の注記が出ない
await page.fill("#f-amount", "9000");
const result2 = await page.textContent("#split-result");
assert(result2 === "1人あたり ¥3,000", `按分: 割り切れる場合は端数注記なし（実際: ${result2}）`);

// 人数が空の場合は結果を出さない
await page.fill("#split-people", "");
const result3 = await page.textContent("#split-result");
assert(result3 === "", `按分: 人数未入力では結果を出さない（実際: ${result3}）`);

// 1は通常動作（按分なし）、0は無効
await page.fill("#split-people", "1");
const result1person = await page.textContent("#split-result");
assert(result1person === "1人＝按分なし（通常の登録）", `按分: 1人は通常動作の案内を出す（実際: ${result1person}）`);
await page.fill("#split-people", "0");
const result0person = await page.textContent("#split-result");
assert(result0person === "0人は指定できません", `按分: 0人は無効の案内を出す（実際: ${result0person}）`);

await page.click("#split-toggle-btn");
const panelHiddenAfterClose = await page.locator("#split-panel.hidden").count();
assert(panelHiddenAfterClose === 1, "按分: 再クリックで閉じる");

// フォームを閉じて再度開くと按分状態がリセットされる（既定値は1＝通常動作）
await page.click("#split-toggle-btn");
await page.fill("#split-people", "4");
await page.click("#cancel-btn");
await page.click("#manual-btn");
const peopleValueAfterReopen = await page.inputValue("#split-people");
assert(peopleValueAfterReopen === "1", `按分: フォームを開き直すと既定値1にリセットされる（実際: ${peopleValueAfterReopen}）`);
const panelHiddenAfterReopen = await page.locator("#split-panel.hidden").count();
assert(panelHiddenAfterReopen === 1, "按分: 開き直すとパネルも閉じた状態に戻る");

// 1人のまま保存すると按分は記録されない（通常の明細になる）
await page.fill("#f-vendor", "一人メシ食堂");
await page.fill("#f-amount", "1200");
await page.selectOption("#f-category", "会議費");
await page.click("#split-toggle-btn"); // パネルを開く（既定値1のまま）
await page.click("#save-btn");
await page.waitForSelector("#capture-step:not(.hidden)");
const soloRow = await page.evaluate(() =>
  JSON.parse(localStorage.getItem("shiden_expense_receipts")).find((r) => r.vendor === "一人メシ食堂")
);
assert(soloRow.split_people === null, `按分: 1人のまま保存すると記録されない（実際: ${soloRow.split_people}）`);
await page.click('nav button[data-panel="list"]');
const soloMeta = await page.locator(".receipt-item", { hasText: "一人メシ食堂" }).locator(".meta").textContent();
assert(!soloMeta.includes("按分"), "按分: 1人の明細は一覧に按分表示が出ない");
await page.click('nav button[data-panel="capture"]');

// --- 按分の記録・復元・一覧表示・CSV出力の検証 ---

// 5人で按分した明細を保存する。計算後にパネルを閉じてから保存する操作が自然なため、
// 閉じた状態でも記録されることを確認する（パネルの表示状態を記録条件にしていた過去の
// バグで、閉じてから保存すると按分情報が消えてしまっていた）
await page.click("#manual-btn");
await page.fill("#f-vendor", "居酒屋たぬき");
await page.fill("#f-amount", "29720");
await page.selectOption("#f-category", "交際費");
await page.click("#split-toggle-btn");
await page.fill("#split-people", "5");
await page.click("#split-toggle-btn"); // パネルを閉じてから保存する
await page.click("#save-btn");
await page.waitForSelector("#capture-step:not(.hidden)");

// 一覧に按分の記録が表示される
await page.click('nav button[data-panel="list"]');
const splitItem = page.locator(".receipt-item", { hasText: "居酒屋たぬき" });
const splitMeta = await splitItem.locator(".meta").textContent();
assert(splitMeta.includes("👥 5人で按分 → ¥5,944/人"), `一覧: 按分の記録が表示される（実際: ${splitMeta}）`);
const splitAmountLabel = await splitItem.locator(".split-amount").textContent();
assert(splitAmountLabel === "¥5,944/人", `一覧: 金額の右側にも1人あたりの金額が別色で表示される（実際: ${splitAmountLabel}）`);

// 編集画面を開き直すと按分人数・計算結果が復元される
await splitItem.click();
await page.waitForSelector("#form-step:not(.hidden)");
const panelVisibleOnEdit = await page.locator("#split-panel:not(.hidden)").count();
assert(panelVisibleOnEdit === 1, "按分: 記録済みの明細では編集時にパネルが開いた状態で復元される");
const restoredPeople = await page.inputValue("#split-people");
assert(restoredPeople === "5", `按分: 人数が復元される（実際: ${restoredPeople}）`);
const restoredResult = await page.textContent("#split-result");
assert(restoredResult === "1人あたり ¥5,944", `按分: 計算結果が復元される（実際: ${restoredResult}）`);

// 「申請」ボタンで共有する本文にも按分の記録が含まれる
const shareBody = await page.evaluate(async () => {
  const calls = [];
  navigator.share = async (data) => { calls.push(data); };
  navigator.canShare = undefined;
  document.getElementById("share-btn").click();
  await new Promise((resolve) => setTimeout(resolve, 200));
  return calls[0]?.text;
});
assert(shareBody?.includes("按分: 5人で ¥5,944/人"), `申請: 本文に按分の記録が含まれる（実際: ${shareBody}）`);

await page.click("#cancel-btn");

// CSVエクスポートに按分人数・1人あたり請求額の列が出力される
await page.click('nav button[data-panel="list"]');
const downloadPromise = page.waitForEvent("download");
await page.evaluate(() => document.getElementById("export-btn").click());
const download = await downloadPromise;
const csvPath = new URL("./split_export.csv", import.meta.url).pathname;
await download.saveAs(csvPath);
const fs = await import("node:fs");
const csvText = fs.readFileSync(csvPath, "utf-8");
assert(csvText.includes("按分人数,1人あたり請求額"), "CSV: 按分の列がヘッダーに出力される");
const dataLine = csvText.split("\r\n").find((line) => line.includes("居酒屋たぬき"));
// 末尾は宿泊終了日列（宿泊費以外は空欄）
assert(dataLine?.endsWith(",5,5944,,"), `CSV: 按分人数・1人あたり請求額の値が出力される（実際: ${dataLine}）`);

await browser.close();
console.log(failures === 0 ? "\nALL SPLIT TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
