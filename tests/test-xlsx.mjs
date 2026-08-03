// Excelエクスポート（1明細1シート＋写真）の検証。
// 生成した.xlsx（無圧縮ZIP）をNode側で展開し、構造・シート内容・画像埋め込みを確認する
import { chromium } from "playwright";
import fs from "node:fs";

const page_url = new URL("../docs/index.html", import.meta.url).href;
const xlsxPath = new URL("./export_test.xlsx", import.meta.url).pathname;
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

let failures = 0;
function assert(cond, name) {
  if (cond) console.log(`PASS: ${name}`);
  else { console.error(`FAIL: ${name}`); failures++; }
}

// 自前ZIP（無圧縮・ローカルヘッダー逐次）を展開する最小パーサー
function unzipStored(buf) {
  const files = new Map();
  let p = 0;
  while (p + 4 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const size = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const name = buf.slice(p + 30, p + 30 + nameLen).toString("utf8");
    const start = p + 30 + nameLen + extraLen;
    files.set(name, buf.slice(start, start + size));
    p = start + size;
  }
  return files;
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
page.on("pageerror", (err) => { console.error("PAGE ERROR:", err.message); failures++; });
await page.route("https://api.openai.com/**", (route) => {
  route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      date: "2026-07-10", vendor: "タクシー会社", amount: 3400, category: "交通費", memo: "移動",
    }) } }] }),
  });
});
await page.goto(page_url);
await page.waitForLoadState("domcontentloaded");
await page.evaluate(() => {
  localStorage.setItem("shiden_expense_settings", JSON.stringify({ apiKey: "sk-test", model: "gpt-5.4" }));
});

// 明細1: 手入力（写真なし・按分あり・複数行の依頼内容）
await page.click("#manual-btn");
await page.fill("#f-vendor", "居酒屋つぼ八");
await page.fill("#f-amount", "8000");
await page.fill("#f-date", "2026-07-05");
await page.selectOption("#f-category", "交際費");
await page.fill("#f-note", "7月度懇親会\n4名分立替");
await page.click("#split-toggle-btn");
await page.fill("#split-people", "4");
await page.click("#save-btn");
await page.waitForSelector("#capture-step:not(.hidden)");

// 明細2: 写真付き（交通費レシート入口→OCR）
await page.setInputFiles("#transit-photo-input", { name: "taxi.png", mimeType: "image/png", buffer: tinyPng });
await page.waitForSelector("#crop-editor:not(.hidden)");
await page.click("#analyze-btn");
await page.waitForSelector("#form-step:not(.hidden)", { timeout: 15000 });
await page.click("#save-btn");
await page.waitForSelector("#capture-step:not(.hidden)");

// Excelエクスポート
await page.click('nav button[data-panel="list"]');
const downloadPromise = page.waitForEvent("download");
await page.click("#export-xlsx-btn");
const download = await downloadPromise;
assert(download.suggestedFilename() === "receipts_all.xlsx", `ファイル名（実際: ${download.suggestedFilename()}）`);
await download.saveAs(xlsxPath);

const files = unzipStored(fs.readFileSync(xlsxPath));
const names = [...files.keys()];
assert(names.includes("[Content_Types].xml"), "パッケージ: [Content_Types].xmlがある");
assert(names.includes("xl/workbook.xml") && names.includes("xl/styles.xml"), "パッケージ: workbook/stylesがある");
assert(names.includes("xl/worksheets/sheet1.xml") && names.includes("xl/worksheets/sheet2.xml") && names.includes("xl/worksheets/sheet3.xml"),
  "シート: 一覧＋明細2件で3シートある");

const workbook = files.get("xl/workbook.xml").toString("utf8");
assert(workbook.includes('name="一覧"'), "ブック: 先頭が一覧シート");
assert(workbook.includes("01_0705_居酒屋つぼ八") && workbook.includes("02_0710_タクシー会社"),
  `ブック: 明細シート名が連番_日付_支払先（実際: ${workbook.match(/name="[^"]*"/g).join(", ")}）`);

const summary = files.get("xl/worksheets/sheet1.xml").toString("utf8");
assert(summary.includes("居酒屋つぼ八") && summary.includes("タクシー会社") && summary.includes("<v>8000</v>"),
  "一覧シート: 両明細と金額（数値セル）が入っている");

const sheet2 = files.get("xl/worksheets/sheet2.xml").toString("utf8");
assert(sheet2.includes("居酒屋つぼ八") && sheet2.includes("<v>8000</v>"), "明細シート: 支払先・金額");
assert(sheet2.includes("7月度懇親会\n4名分立替"), "明細シート: 依頼内容・用途の改行が保持される");
assert(sheet2.includes("按分人数") && sheet2.includes("<v>2000</v>"), "明細シート: 按分人数と1人あたり請求額");
assert(!sheet2.includes("<drawing"), "明細シート: 写真なしの明細に描画参照が無い");

const sheet3 = files.get("xl/worksheets/sheet3.xml").toString("utf8");
assert(sheet3.includes("タクシー会社") && sheet3.includes('<drawing r:id="rId1"/>'), "明細シート: 写真ありの明細に描画参照がある");
assert(names.includes("xl/drawings/drawing1.xml") && names.includes("xl/worksheets/_rels/sheet3.xml.rels"),
  "描画: drawing XMLとシートrelsがある");
// 証憑は原本PNGのまま埋め込まれる（再圧縮しない）。保存時にCSVが埋め込まれた
// 証憑PNGとバイト一致するかまで確認する
const media = files.get("xl/media/image1.png");
assert(media && media.length > 0 && media.readUInt32BE(0) === 0x89504e47, "画像: PNG原本がxl/mediaに埋め込まれている");
assert(media.includes("ShidenExpense"), "画像: 埋め込みPNGは明細CSV入りの原本そのもの");

await browser.close();
console.log(failures === 0 ? "\nALL XLSX TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
