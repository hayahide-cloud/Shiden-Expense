// PDF領収書の取込（pdf.jsによる画像化→OCR→証憑保存）のE2E検証
import { chromium } from "playwright";

let failures = 0;
function assert(cond, name) {
  if (cond) console.log(`PASS: ${name}`);
  else { console.error(`FAIL: ${name}`); failures++; }
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
});
const page = await context.newPage();
page.on("pageerror", (err) => { console.error("PAGE ERROR:", err.message); failures++; });

let receivedPrompt = "";
await page.route("https://api.openai.com/**", (route) => {
  const body = JSON.parse(route.request().postData());
  receivedPrompt = body.messages[0].content[0].text;
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        date: "2026-07-09", date_to: "2026-07-10", vendor: "楽天トラベル（ホテルグランヴィア広島）",
        amount: 13200, category: "会議費", memo: "宿泊料金",
      }) } }],
    }),
  });
});

await page.goto(new URL("../docs/index.html", import.meta.url).href);
await page.waitForLoadState("domcontentloaded");
await page.evaluate(() => {
  localStorage.setItem("shiden_expense_settings", JSON.stringify({ apiKey: "sk-test", model: "gpt-5.4" }));
});

// 最小構成の1ページPDF（テキスト入り）。xrefは省略形だがpdf.jsのリカバリで読める
const pdfSource = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 62>>stream
BT /F1 24 Tf 50 780 Td (RAKUTEN TRAVEL RECEIPT 13200) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R/Size 6>>
`;
const pdfBuffer = Buffer.from(pdfSource, "latin1");

// --- 宿泊費の入口からPDFを取込: 画像化→レシートOCR→科目は宿泊費に固定 ---
await page.setInputFiles("#hotel-input", {
  name: "rakuten.pdf", mimeType: "application/pdf", buffer: pdfBuffer,
});
await page.waitForSelector("#form-step:not(.hidden)", { timeout: 20000 });
const croppedDuringPdf = await page.evaluate(() => document.body.classList.contains("crop-fullscreen"));
assert(!croppedDuringPdf, "PDF: トリミングエディタを経由せず直接フォームが開く");
assert(receivedPrompt.includes("店舗レシートまたは領収書"), "PDF: レシートOCRプロンプトで解析される");
assert((await page.inputValue("#f-category")) === "宿泊費",
  `PDF: 宿泊費の入口からは科目が宿泊費に固定される（実際: ${await page.inputValue("#f-category")}）`);
assert((await page.inputValue("#f-amount")) === "13,200", "PDF: 金額が自動入力される");
assert((await page.inputValue("#f-vendor")) === "楽天トラベル（ホテルグランヴィア広島）", "PDF: 支払先が自動入力される");
assert((await page.inputValue("#f-date")) === "2026-07-09", "PDF: 日付（チェックイン日）が入る");
assert((await page.inputValue("#f-date-to")) === "2026-07-10", "PDF: 宿泊終了日（チェックアウト日）が自動で入る");
// 画像化された証憑のプレビューが表示されている
const previewShown = await page.isVisible("#edit-preview");
assert(previewShown, "PDF: 画像化された証憑のプレビューが表示される");
const previewDims = await page.evaluate(async () => {
  const bmp = await createImageBitmap(currentImage);
  return { w: bmp.width, h: bmp.height, type: currentImage.type };
});
// A4（595x842pt）は拡大率上限3倍で1785x2526に描画される（幅1800px相当・上限3倍の仕様）
assert(previewDims.type === "image/png" && previewDims.w === 1785 && Math.abs(previewDims.h - 2526) <= 3,
  `PDF: A4が幅約1800pxのPNGに画像化される（実際: ${previewDims.w}x${previewDims.h} ${previewDims.type}）`);

// 保存して証憑が添付されることを確認
await page.fill("#f-note", "PDFテスト");
await page.click("#save-btn");
await page.waitForSelector("#capture-step:not(.hidden)");
const savedPdfRow = await page.evaluate(async () => {
  const rows = JSON.parse(localStorage.getItem("shiden_expense_receipts"));
  const r = rows.find((x) => x.note === "PDFテスト");
  const blob = await getImage(r.id).catch(() => null);
  return { filename: r.filename, category: r.category, date_to: r.date_to, hasImage: !!blob, type: blob ? blob.type : "" };
});
assert(savedPdfRow.filename.endsWith(".png") && savedPdfRow.hasImage && savedPdfRow.type === "image/png",
  `PDF: 保存で証憑画像（PNG）が添付される（実際: ${savedPdfRow.filename} / ${savedPdfRow.type}）`);
assert(savedPdfRow.category === "宿泊費" && savedPdfRow.date_to === "2026-07-10", "PDF: 科目・宿泊終了日が保存される");

// --- 購入費の入口からPDF: 科目はOCRの判定（モックは会議費）が使われる ---
await page.setInputFiles("#image-input", {
  name: "receipt.pdf", mimeType: "application/pdf", buffer: pdfBuffer,
});
await page.waitForSelector("#form-step:not(.hidden)", { timeout: 20000 });
assert((await page.inputValue("#f-category")) === "会議費",
  `PDF: 購入費の入口では科目はOCRの判定になる（実際: ${await page.inputValue("#f-category")}）`);
await page.click("#cancel-btn");
await page.waitForSelector("#capture-step:not(.hidden)");

// --- 写真の後付けでもPDFを受け付ける（手入力明細への添付） ---
await page.click("#manual-btn");
await page.waitForSelector("#form-step:not(.hidden)");
await page.fill("#f-note", "PDF後付けテスト");
await page.click("#save-btn");
await page.waitForSelector("#capture-step:not(.hidden)");
await page.click('nav button[data-panel="list"]');
await page.waitForSelector("#panel-list.active");
await page.locator(".receipt-item", { hasText: "PDF後付けテスト" }).click();
await page.waitForSelector("#form-step:not(.hidden)");
await page.waitForFunction(() => document.getElementById("edit-add-photo").offsetParent !== null, { timeout: 5000 });
await page.evaluate(() => showMessage("", ""));
await page.setInputFiles("#edit-photo-input", {
  name: "late.pdf", mimeType: "application/pdf", buffer: pdfBuffer,
});
await page.waitForFunction(
  () => document.querySelector("#capture-message .banner.ok")?.textContent.includes("PDFを解析して反映"),
  { timeout: 20000 }
);
assert((await page.inputValue("#f-amount")) === "13,200", "PDF後付け: 金額が自動入力される");
assert((await page.inputValue("#f-note")) === "PDF後付けテスト", "PDF後付け: 依頼内容・用途は保持される");
await page.click("#save-btn");
await page.waitForSelector("#panel-list.active");
const lateRow = await page.evaluate(async () => {
  const rows = JSON.parse(localStorage.getItem("shiden_expense_receipts"));
  const r = rows.find((x) => x.note === "PDF後付けテスト");
  const blob = await getImage(r.id).catch(() => null);
  return { filename: r.filename, hasImage: !!blob };
});
assert(lateRow.filename.endsWith(".png") && lateRow.hasImage, "PDF後付け: 保存で証憑画像が添付される");

await browser.close();
console.log(failures === 0 ? "\nALL PDF TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
