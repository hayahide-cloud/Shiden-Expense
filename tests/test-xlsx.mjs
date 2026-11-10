// Excelエクスポート（組合の精算書フォーマット: 旅費・購入・証憑シート）の検証。
// 生成した.xlsx（無圧縮ZIP）をNode側で展開し、シート構成・セル配置・数式・証憑の対応を確認する。
// さらにPython(openpyxl)とLibreOffice(再計算)でも開けることを別工程で確認する（run後に実行）
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
// セル参照のXML断片を取り出す（inlineStr / 数値 / 数式）
function cell(xml, ref) {
  const m = new RegExp(`<c r="${ref}"[^>]*?(?:/>|>([\\s\\S]*?)</c>)`).exec(xml);
  if (!m) return null;
  const inner = m[1] ?? "";
  const t = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner);
  const v = /<v>([^<]*)<\/v>/.exec(inner);
  const f = /<f>([^<]*)<\/f>/.exec(inner);
  return { text: t ? t[1] : null, value: v ? v[1] : null, formula: f ? f[1].replace(/&quot;/g, '"') : null };
}
const serial = (ymd) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return String(Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000));
};

// OCRモック: 経路プロンプトなら経路JSON、レシートならその時点のreceiptMockを返す
let receiptMock = {};
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
page.on("pageerror", (err) => { console.error("PAGE ERROR:", err.message); failures++; });
await page.route("https://api.openai.com/**", (route) => {
  const prompt = JSON.parse(route.request().postData()).messages[0].content[0].text;
  const content = prompt.includes("経路検索アプリ")
    ? { date: "2026-10-14", from: "東京駅", to: "泉外旭川駅", amount: 18460, line: "JR東北新幹線・奥羽本線",
        legs: ["東京駅→秋田駅", "秋田駅→泉外旭川駅"], distance_km: 600 }
    : receiptMock;
  route.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }) });
});
await page.goto(page_url);
await page.waitForLoadState("domcontentloaded");
await page.evaluate(() => {
  localStorage.setItem("shiden_expense_settings", JSON.stringify({
    apiKey: "sk-test", model: "gpt-5.4", claimantName: "五十嵐　駿秀", claimantDept: "中央本部",
  }));
});
await page.reload();
await page.waitForLoadState("domcontentloaded");

// テスト用の証憑画像を生成する（Excel上で画像が見えることを目視確認できるよう中身を描く）
const makePng = (w, h, title, color) => page.evaluate(([w, h, title, color]) => {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = color; ctx.fillRect(0, 0, w, 90);
  ctx.fillStyle = "#222"; ctx.font = "bold 40px sans-serif"; ctx.fillText(title, 30, 160);
  ctx.font = "28px sans-serif";
  for (let i = 0; i < 6; i++) ctx.fillText(`明細行 ${i + 1}　　　　¥${(i + 1) * 1000}`, 30, 240 + i * 50);
  return c.toDataURL("image/png").split(",")[1];
}, [w, h, title, color]);
const hotelPng = Buffer.from(await makePng(800, 1000, "秋田キャッスルホテル 領収書", "#fb7185"), "base64");
const receiptPng = Buffer.from(await makePng(800, 1000, "セブンイレブン レシート", "#fbbf24"), "base64");

// --- 明細1: 交通費（経路スクショ・距離600km） ---
const routePng = await makePng(600, 1200, "東京駅 → 泉外旭川駅", "#2dd4bf");
await page.setInputFiles("#transit-input", { name: "route.png", mimeType: "image/png", buffer: Buffer.from(routePng, "base64") });
await page.waitForSelector("#transit-preview:not(.hidden)", { timeout: 10000 });
await page.click("#transit-analyze-btn");
await page.waitForSelector("#form-step:not(.hidden)", { timeout: 15000 });
await page.selectOption("#f-category", "春闘方針案説明会");
await page.fill("#f-note", "2027春闘 方針案説明会（秋田）");
await page.click("#save-btn");
await page.waitForSelector("#capture-step:not(.hidden)");

// --- 明細2: 宿泊（同じ科目・日付が重なる → 同じ出張ブロックへ） ---
receiptMock = { date: "2026-10-14", date_to: "2026-10-16", vendor: "秋田キャッスルホテル", amount: 12000, memo: "宿泊" };
await page.setInputFiles("#hotel-input", { name: "hotel.png", mimeType: "image/png", buffer: hotelPng });
await page.waitForSelector("#crop-editor:not(.hidden)", { timeout: 5000 });
await page.waitForFunction(() => !document.getElementById("analyze-btn").disabled);
await page.click("#analyze-btn");
await page.waitForSelector("#form-step:not(.hidden)", { timeout: 15000 });
await page.selectOption("#f-category", "春闘方針案説明会");
await page.click("#save-btn");
await page.waitForSelector("#capture-step:not(.hidden)");

// --- 明細3: 購入（写真あり） ---
receiptMock = { date: "2026-10-20", vendor: "セブンイレブン 赤坂店", amount: 1500, memo: "コピー用紙" };
await page.setInputFiles("#image-input", { name: "receipt.png", mimeType: "image/png", buffer: receiptPng });
await page.waitForSelector("#crop-editor:not(.hidden)", { timeout: 5000 });
await page.waitForFunction(() => !document.getElementById("analyze-btn").disabled);
await page.click("#analyze-btn");
await page.waitForSelector("#form-step:not(.hidden)", { timeout: 15000 });
await page.selectOption("#f-category", "事務用消耗品費");
await page.fill("#f-note", "事務用品の購入");
await page.click("#save-btn");
await page.waitForSelector("#capture-step:not(.hidden)");

// --- 明細4: 購入（手入力・写真なし） ---
await page.click("#manual-btn");
await page.fill("#f-date", "2026-10-23");
await page.fill("#f-vendor", "居酒屋たぬき");
await page.fill("#f-amount", "21600");
await page.selectOption("#f-category", "本部会議費");
await page.fill("#f-note", "作戦会議 懇親会");
await page.click("#save-btn");
await page.waitForSelector("#capture-step:not(.hidden)");

// --- エクスポート ---
await page.click('nav button[data-panel="list"]');
const downloadPromise = page.waitForEvent("download");
await page.click("#export-xlsx-btn");
const download = await downloadPromise;
assert(download.suggestedFilename() === "seisansho_all.xlsx", `ファイル名（実際: ${download.suggestedFilename()}）`);
await download.saveAs(xlsxPath);

const files = unzipStored(fs.readFileSync(xlsxPath));
const workbook = files.get("xl/workbook.xml").toString("utf8");
const sheetNames = [...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
assert(JSON.stringify(sheetNames) === JSON.stringify(["旅費", "1", "購入", "2"]),
  `シート構成: 旅費→証憑1→購入→証憑2 の順（実際: ${sheetNames.join(", ")}）`);
assert(workbook.includes("_xlnm.Print_Area") && workbook.includes("'旅費'!$A$1:$K$30") && files.get("xl/worksheets/sheet1.xml").toString("utf8").includes("fitToWidth=\"1\""), "印刷範囲: 旅費 A1:K30・横幅1ページに収める設定");

// 旅費シート（sheet1）
const travel = files.get("xl/worksheets/sheet1.xml").toString("utf8");
assert(cell(travel, "A1")?.text === "旅費/日当/休暇補償　精算書", "旅費: タイトル");
assert(cell(travel, "F1")?.text === "五十嵐　駿秀" && cell(travel, "H1")?.text === "中央本部" && cell(travel, "K1")?.text === "INPEX労働組合",
  "旅費: 氏名・所属・団体名が設定から入る");
assert(cell(travel, "D4")?.text === "150km以上の移動有無" && cell(travel, "K4")?.text === "証憑No" && cell(travel, "C5")?.text === " 精算総額",
  "旅費: 2段ヘッダーの文言");
assert(travel.includes('<mergeCell ref="E4:E5"/>') && travel.includes('<mergeCell ref="F4:G5"/>') && travel.includes('<mergeCell ref="N4:N11"/>'),
  "旅費: ヘッダー・注意書きの結合セル");
assert(cell(travel, "A6")?.value === serial("2026-10-14") && cell(travel, "A7")?.value === serial("2026-10-16"),
  `旅費: 出発日=交通費の日付、帰着日=宿泊終了日（実際: ${cell(travel, "A6")?.value}, ${cell(travel, "A7")?.value}）`);
assert(cell(travel, "C6")?.text === "春闘方針案説明会", "旅費: 予算科目");
assert(cell(travel, "D6")?.text === "○" && cell(travel, "D7")?.value === "9000",
  `旅費: 600km→150km以上○、日当=3,000円×3日（実際: ${cell(travel, "D6")?.text}, ${cell(travel, "D7")?.value}）`);
assert(cell(travel, "F6")?.text === "東京駅" && cell(travel, "G6")?.text === "秋田駅" && cell(travel, "F7")?.text === "秋田駅" && cell(travel, "G7")?.text === "泉外旭川駅",
  "旅費: 行程が区間（発→着）に分解される");
assert(cell(travel, "H6")?.value === "18460" && cell(travel, "H7") && cell(travel, "H7").value === null,
  "旅費: 明細の金額は区間1行目に入る");
assert(cell(travel, "I6")?.text === "秋田キャッスルホテル" && cell(travel, "I7")?.value === "1" && cell(travel, "J7")?.value === "12000",
  "旅費: 宿泊がホテル名・人数・実費額に入る（同じ出張に統合）");
assert(cell(travel, "B7")?.text === "2027春闘 方針案説明会（秋田）", "旅費: 用務内容に依頼内容・用途が入る");
assert(cell(travel, "K6")?.text === "1", "旅費: 証憑No=1");
assert(cell(travel, "C7")?.formula === 'IF(H6="","",D7+SUM(H6:H10)+J7)', `旅費: 精算総額の数式（実際: ${cell(travel, "C7")?.formula}）`);
assert(cell(travel, "C12")?.formula === 'IF(H11="","",D12+SUM(H11:H15)+J12)', "旅費: 空ブロックにも数式がある");
assert(travel.includes("<formula1>&quot;○,×&quot;</formula1>") && travel.includes("鉄道,タクシー,バス,車,船,他"), "旅費: 入力規則（○×・分類）");
assert(cell(travel, "N4")?.text.startsWith("・都市鉄道・バスの交通費については、証憑は不要です"), "旅費: 記入上の注意が転記される");

// 証憑シート1（sheet2）: 交通費スクショ＋宿泊レシートの2枚
const ev1 = files.get("xl/worksheets/sheet2.xml").toString("utf8");
assert(cell(ev1, "A1")?.value === "1" && cell(ev1, "B1")?.text === "（証憑PDFを貼付）", "証憑1: 番号と見出し");
const drawing1 = files.get("xl/drawings/drawing1.xml").toString("utf8");
assert((drawing1.match(/<xdr:pic>/g) || []).length === 2, "証憑1: 同じ出張の画像2枚（経路スクショ＋宿泊領収書）が貼られる");
assert(files.has("xl/media/image1.png") && files.has("xl/media/image2.png"), "証憑1: 画像が原本PNGで埋め込まれる");
// 縦横比: 表示サイズ（EMU）が原画像の比率と一致する（セル範囲指定ではなくサイズ指定で貼るため引き伸ばされない）
const firstExt = /<xdr:oneCellAnchor>[\s\S]*?<xdr:ext cx="(\d+)" cy="(\d+)"/.exec(drawing1);
assert(firstExt && Math.abs(Number(firstExt[1]) / Number(firstExt[2]) - 600 / 1200) < 0.005,
  `証憑1: 経路スクショ(600x1200)の縦横比が保たれる（実際: ${firstExt ? (firstExt[1] / firstExt[2]).toFixed(4) : "なし"}）`);

// 購入シート（sheet3）
const purchase = files.get("xl/worksheets/sheet3.xml").toString("utf8");
assert(cell(purchase, "A1")?.text === "購入精算書" && cell(purchase, "D1")?.text === "五十嵐　駿秀", "購入: タイトル・氏名");
assert(cell(purchase, "A4")?.value === serial("2026-10-20") && cell(purchase, "B4")?.text === "事務用消耗品費" && cell(purchase, "C4")?.text === "事務用品の購入",
  "購入: 日付順に1行1件（発注日・科目・依頼内容）");
assert(cell(purchase, "D4")?.value === "1" && cell(purchase, "E4")?.value === "1500" && cell(purchase, "F4")?.formula === 'IF(E4="","",D4*E4)',
  "購入: 数量1・単価=金額・金額は数式");
assert(cell(purchase, "G4")?.text === "2" && cell(purchase, "G5")?.text === "-", "購入: 証憑Noは通し番号、写真なしは「-」");
assert(cell(purchase, "H4")?.text === "セブンイレブン 赤坂店 / コピー用紙", "購入: 備考に支払先・摘要");
assert(cell(purchase, "B5")?.text === "本部会議費" && cell(purchase, "E5")?.value === "21600", "購入: 手入力明細");
assert(cell(purchase, "F23")?.formula === "SUM(F4:F22)" && cell(purchase, "E23")?.text === "合計：", "購入: 合計行（19行分の明細枠の直後）");
assert(purchase.includes('sqref="B4:B22"') && purchase.includes("<formula1>$A$30:$A$61</formula1>") && cell(purchase, "A30")?.text === "定期大会" && cell(purchase, "A61")?.text === "修繕費",
  "購入: 予算科目のドロップダウン（原本と同じA30:A61の32科目）");
assert(purchase.includes('state="frozen"'), "購入: ヘッダー行の固定");

// 証憑シート2（sheet4）
const ev2 = files.get("xl/worksheets/sheet4.xml").toString("utf8");
assert(cell(ev2, "A1")?.value === "2" && (files.get("xl/drawings/drawing2.xml").toString("utf8").match(/<xdr:pic>/g) || []).length === 1,
  "証憑2: 購入レシート1枚");

// スタイル
const styles = files.get("xl/styles.xml").toString("utf8");
assert(styles.includes("[$-411]ge.mm.dd;@") && styles.includes("[$-411]ge.m.d;@") && styles.includes("#,##0_);[Red](#,##0)") && styles.includes("&quot;No.&quot;General"),
  "書式: 和暦日付・金額・No.の表示形式");
assert(styles.includes("HG丸ｺﾞｼｯｸM-PRO") && styles.includes("游ゴシック"), "書式: フォント");

await browser.close();
console.log(failures === 0 ? "\nALL XLSX TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
