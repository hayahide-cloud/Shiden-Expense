// 「明細を編集」「内容を確認・修正」が画面更新後も復元されることの検証
import { chromium } from "playwright";

const page_url = new URL("../docs/index.html", import.meta.url).href;
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

let failures = 0;
function assert(cond, name) {
  if (cond) console.log(`PASS: ${name}`);
  else { console.error(`FAIL: ${name}`); failures++; }
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
page.on("pageerror", (err) => { console.error("PAGE ERROR:", err.message); failures++; });
await page.route("https://api.openai.com/**", (route) => {
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        date: "2026-07-06", vendor: "テスト商店", amount: 1500,
        category: "会議費", memo: "打合せ茶菓子",
      }) } }],
    }),
  });
});
await page.goto(page_url);
await page.waitForLoadState("domcontentloaded");
await page.evaluate(() => {
  localStorage.setItem("shiden_expense_settings", JSON.stringify({ apiKey: "sk-test", model: "gpt-5.4" }));
});

// --- ケース1: 既存明細(明細を編集)を開いたままリロードすると同じ明細の編集画面に戻る ---
await page.click("#manual-btn");
await page.fill("#f-vendor", "居酒屋つぼ八");
await page.fill("#f-amount", "8000");
await page.selectOption("#f-category", "交際費");
await page.click("#save-btn");
await page.waitForSelector("#capture-step:not(.hidden)");

await page.click('nav button[data-panel="list"]');
await page.locator(".receipt-item", { hasText: "居酒屋つぼ八" }).click();
await page.waitForSelector("#form-step:not(.hidden)");
const titleBeforeReload = await page.textContent("#form-title");
assert(titleBeforeReload === "明細を編集", `編集中: フォームタイトル（実際: ${titleBeforeReload}）`);

await page.reload();
await page.waitForLoadState("domcontentloaded");
await page.waitForSelector("#form-step:not(.hidden)", { timeout: 5000 });
const titleAfterReload = await page.textContent("#form-title");
assert(titleAfterReload === "明細を編集", `リロード後: 同じ明細の編集画面が復元される（実際: ${titleAfterReload}）`);
const vendorAfterReload = await page.inputValue("#f-vendor");
assert(vendorAfterReload === "居酒屋つぼ八", `リロード後: 明細の内容が復元される（実際: ${vendorAfterReload}）`);
await page.click("#cancel-btn");
await page.waitForSelector("#panel-list.active");

// --- ケース2: OCR解析直後(内容を確認・修正、未保存)にリロードすると下書きが復元される ---
await page.click('nav button[data-panel="capture"]');
await page.setInputFiles("#image-input", { name: "receipt.png", mimeType: "image/png", buffer: tinyPng });
await page.click("#analyze-btn");
await page.waitForSelector("#form-step:not(.hidden)", { timeout: 10000 });
assert((await page.inputValue("#f-vendor")) === "テスト商店", "解析直後: OCR結果がフォームに反映");

await page.reload();
await page.waitForLoadState("domcontentloaded");
await page.waitForSelector("#form-step:not(.hidden)", { timeout: 5000 });
const titleAfterDraftReload = await page.textContent("#form-title");
assert(titleAfterDraftReload === "内容を確認・修正", `下書き復元: フォームタイトル（実際: ${titleAfterDraftReload}）`);
const vendorAfterDraftReload = await page.inputValue("#f-vendor");
assert(vendorAfterDraftReload === "テスト商店", `下書き復元: OCR結果の支払先が復元される（実際: ${vendorAfterDraftReload}）`);
const amountAfterDraftReload = await page.inputValue("#f-amount");
assert(amountAfterDraftReload === "1,500", `下書き復元: 金額が復元される（実際: ${amountAfterDraftReload}）`);
// 証憑画像もIndexedDBの下書きから復元され、既定で表示される
await page.waitForSelector("#image-toggle-wrap:not(.hidden)", { timeout: 5000 });
await page.waitForSelector("#edit-preview:not(.hidden)", { timeout: 5000 });
const draftImgSrc = await page.getAttribute("#edit-preview", "src");
assert(draftImgSrc && draftImgSrc.startsWith("blob:"), `下書き復元: 証憑画像も復元される（実際: ${draftImgSrc}）`);

// 保存すると下書きは消え、次にリロードしても復元されない
await page.click("#save-btn");
await page.waitForSelector("#capture-step:not(.hidden)");
await page.reload();
await page.waitForLoadState("domcontentloaded");
const formHiddenAfterSaveAndReload = await page.locator("#form-step.hidden").count();
assert(formHiddenAfterSaveAndReload === 1, "保存後: 下書きが消え、リロードしてもフォームが開かない");

await browser.close();
console.log(failures === 0 ? "\nALL RESTORE-FORM TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
