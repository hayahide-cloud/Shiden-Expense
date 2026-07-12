// 交通費（経路検索スクショ）取込のE2E検証
import { chromium } from "playwright";

const page_url = new URL("../docs/index.html", import.meta.url).href;

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

// OpenAIモック: 経路検索スクショの抽出結果（TRANSIT_PROMPTが使われたことも検証する）
let receivedPrompt = "";
let receivedImageCount = 0;
let apiCallCount = 0;
await page.route("https://api.openai.com/**", (route) => {
  apiCallCount++;
  const body = JSON.parse(route.request().postData());
  receivedPrompt = body.messages[0].content[0].text;
  receivedImageCount = body.messages[0].content.filter((c) => c.type === "image_url").length;
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        date: "", from: "西武新宿", to: "大手町", amount: 409, line: "東京メトロ東西線",
        // 徒歩区間はプロンプトで除外を指示しているため、モデルは交通機関の区間だけを返す想定
        legs: ["西武新宿駅→高田馬場駅", "高田馬場駅→大手町駅"],
        distance_km: 15.3,
      }) } }],
    }),
  });
});

await page.goto(page_url);
await page.waitForLoadState("domcontentloaded");
await page.evaluate(() => {
  localStorage.setItem("shiden_expense_settings", JSON.stringify({ apiKey: "sk-test", model: "gpt-5.4" }));
});

// --- 大項目の構成: 取込タブは「購入費・立替費」「交通費」「宿泊費」の3見出し ---
const headings = await page.evaluate(() =>
  Array.from(document.querySelectorAll("#capture-step > h2")).map((h) => h.textContent.trim())
);
assert(
  headings[0] === "購入費・立替費の精算" && headings[1] === "交通費の精算" && headings[2] === "宿泊費の精算",
  `取込タブ: 3つの大項目に分かれている（実際: ${JSON.stringify(headings)}）`
);

// --- 交通費の手入力: 勘定科目=交通費・日付=今日でフォームが開く ---
await page.click("#transit-manual-btn");
await page.waitForSelector("#form-step:not(.hidden)", { timeout: 5000 });
const manualToday = await page.evaluate(() => todayString());
assert((await page.inputValue("#f-category")) === "交通費", "交通費の手入力: 勘定科目が交通費で開く");
assert((await page.inputValue("#f-date")) === manualToday, "交通費の手入力: 日付が今日で開く");
await page.click("#cancel-btn");
await page.waitForSelector("#capture-step:not(.hidden)");

// --- 宿泊費の手入力: 勘定科目=宿泊費（日付は空＝購入費・立替費と同じ）でフォームが開く ---
await page.click("#hotel-manual-btn");
await page.waitForSelector("#form-step:not(.hidden)", { timeout: 5000 });
assert((await page.inputValue("#f-category")) === "宿泊費", "宿泊費の手入力: 勘定科目が宿泊費で開く");
assert((await page.inputValue("#f-date")) === "", "宿泊費の手入力: 日付は空のまま開く");
await page.click("#cancel-btn");
await page.waitForSelector("#capture-step:not(.hidden)");

// 経路スクショ風の画像（内容はOCRモックのため任意）を生成して選択する
const pngB64 = await page.evaluate(() => {
  const c = document.createElement("canvas");
  c.width = 600; c.height = 1200;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 600, 1200);
  ctx.fillStyle = "#222";
  ctx.font = "28px sans-serif";
  ctx.fillText("西武新宿 → 大手町", 40, 100);
  ctx.fillText("IC ¥409", 40, 160);
  return c.toDataURL("image/png").split(",")[1];
});
await page.setInputFiles("#transit-input", {
  name: "route.png", mimeType: "image/png", buffer: Buffer.from(pngB64, "base64"),
});

// まず連結結果の確認ステップが表示され、この時点ではAPIは呼ばれない
await page.waitForSelector("#transit-preview:not(.hidden)", { timeout: 10000 });
assert(apiCallCount === 0, `確認ステップ: 解析前はAPIが呼ばれない（実際: ${apiCallCount}回）`);
const previewImgSrc = await page.getAttribute("#transit-preview-img", "src");
assert(previewImgSrc && previewImgSrc.startsWith("blob:"), "確認ステップ: 連結画像が表示される");
const receiptBtnHidden = await page.evaluate(() => document.querySelector("#capture-step > .file-button").offsetParent === null);
assert(receiptBtnHidden, "確認ステップ: 撮影ボタン等は隠れる");

// 「解析する」で初めてOCRが実行され、確認・修正フォームが開く
await page.click("#transit-analyze-btn");
await page.waitForSelector("#form-step:not(.hidden)", { timeout: 10000 });
assert(apiCallCount === 1, `解析: ボタン押下でAPIが1回呼ばれる（実際: ${apiCallCount}回）`);
assert(receivedPrompt.includes("経路検索アプリのスクリーンショット"), "交通費: 専用プロンプトが使われる");
assert(receivedPrompt.includes("徒歩の区間は除外する"), "交通費: プロンプトで徒歩区間の除外を指示している");
assert(receivedPrompt.includes("distance_km"), "交通費: プロンプトで距離（概算）の出力を指示している");
assert(receivedPrompt.includes("乗車順に全て挙げる"), "交通費: プロンプトで全路線の列挙を指示している");
assert((await page.inputValue("#f-category")) === "交通費", "交通費: 勘定科目が交通費になる");
assert((await page.inputValue("#f-amount")) === "409", `交通費: 運賃が金額に入る（実際: ${await page.inputValue("#f-amount")}）`);
assert((await page.inputValue("#f-vendor")) === "東京メトロ東西線", `交通費: 支払先が路線名になる（実際: ${await page.inputValue("#f-vendor")}）`);
// 行程（区間の内訳）が1行1区間で摘要に入る（摘要は文字数制限なし・改行可のtextarea）
const memoTag = await page.evaluate(() => document.getElementById("f-memo").tagName);
assert(memoTag === "TEXTAREA", `摘要: 入力欄がtextareaになっている（実際: ${memoTag}）`);
const memoLegs = await page.inputValue("#f-memo");
// 10km以上は整数に丸めて表示される（15.3 → 約15km。概算精度に合わせた見せ方）
assert(memoLegs === "西武新宿駅→高田馬場駅\n高田馬場駅→大手町駅\n距離: 約15km",
  `交通費: 行程＋距離（概算・約付き）が摘要に入る（実際: ${JSON.stringify(memoLegs)}）`);
assert(memoLegs.length > 20, "摘要: 20文字を超えても切り詰められない");
// 依頼内容・用途は空のまま（出張の用件等を書く欄として残す）
assert((await page.inputValue("#f-note")) === "", "交通費: 依頼内容・用途は空のまま");
// 日付が読めないスクショでは空のまま（勝手に今日を入れない）。要確認バナーで入力を促す
assert((await page.inputValue("#f-date")) === "", `交通費: 日付が読めなければ空のまま（実際: ${await page.inputValue("#f-date")}）`);
const transitReview = await page.textContent("#review-banner");
assert(transitReview.includes("日付"), `交通費: 日付が空のとき要確認バナーが出る（実際: ${transitReview}）`);
// スクショが証憑画像として表示されている（既定で表示）
const previewShown = await page.isVisible("#edit-preview");
assert(previewShown, "交通費: スクショが証憑画像として表示される");
// トリミングエディタは開かない（スクショは補正不要のため直接OCR）
const fullscreenDuringTransit = await page.evaluate(() => document.body.classList.contains("crop-fullscreen"));
assert(!fullscreenDuringTransit, "交通費: トリミングエディタは開かない");

// 保存して一覧・画像を確認
await page.click("#save-btn");
await page.waitForSelector("#capture-step:not(.hidden)");
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("shiden_expense_receipts"))[0]);
assert(saved.category === "交通費" && saved.amount === 409, "保存: 交通費明細として保存される");
const savedImage = await page.evaluate(async () => {
  const rows = JSON.parse(localStorage.getItem("shiden_expense_receipts"));
  const blob = await getImage(rows[0].id).catch(() => null);
  return blob ? { size: blob.size, type: blob.type, filename: rows[0].filename } : null;
});
assert(savedImage && savedImage.size > 0, "保存: スクショが証憑画像として保存される");
assert(savedImage.type === "image/png" && savedImage.filename.endsWith(".png"),
  `保存: 連結スクショはPNG（無劣化）で保存される（実際: ${savedImage.type} / ${savedImage.filename}）`);

// --- 一覧の色分け: 交通費の行はtransitクラス＋「🚃 交通費」バッジで区別される ---
await page.click('nav button[data-panel="list"]');
await page.waitForSelector("#panel-list.active");
const transitItemCount = await page.locator(".receipt-item.transit").count();
assert(transitItemCount === 1, `一覧: 交通費の行にtransitクラスが付く（実際: ${transitItemCount}件）`);
const transitBadge = await page.textContent(".receipt-item.transit .type-badge");
assert(transitBadge === "🚃 交通費", `一覧: 交通費バッジが表示される（実際: ${transitBadge}）`);
await page.click('nav button[data-panel="capture"]');
await page.waitForSelector("#panel-capture.active");

// --- 複数枚の分割スクショ: OCRには全枚渡り、証憑は縦に連結した1枚になる ---
const makeShot = async (text) => {
  const b64 = await page.evaluate((t) => {
    const c = document.createElement("canvas");
    c.width = 600; c.height = 800;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 600, 800);
    ctx.fillStyle = "#222";
    ctx.font = "28px sans-serif";
    ctx.fillText(t, 40, 100);
    return c.toDataURL("image/png").split(",")[1];
  }, text);
  return Buffer.from(b64, "base64");
};
await page.setInputFiles("#transit-input", [
  { name: "route1.png", mimeType: "image/png", buffer: await makeShot("上半分: 西武新宿→大手町") },
  { name: "route2.png", mimeType: "image/png", buffer: await makeShot("下半分: IC ¥409") },
]);
await page.waitForSelector("#transit-preview:not(.hidden)", { timeout: 10000 });
// 重なりを検出できなかった継ぎ目は、解析前の確認ステップでwarn表示される
const seamWarnShown = await page.isVisible("#capture-message .banner.warn");
const seamWarnText = seamWarnShown ? await page.textContent("#capture-message .banner.warn") : "";
assert(seamWarnShown && seamWarnText.includes("重なりを検出できなかった継ぎ目が1カ所"),
  `フォールバック通知: 解析前に継ぎ目の数入りでwarn表示される（実際: ${seamWarnText}）`);
await page.click("#transit-analyze-btn");
await page.waitForSelector("#form-step:not(.hidden)", { timeout: 10000 });
assert(receivedImageCount === 2, `複数枚: OCRに2枚とも渡される（実際: ${receivedImageCount}枚）`);
const stitchedDims = await page.evaluate(async () => {
  const bmp = await createImageBitmap(currentImage);
  return { w: bmp.width, h: bmp.height };
});
// 重なり無しでも、2枚に共通する固定部分（この画像では上下の無地領域）が
// 継ぎ目で取り除かれるため、単純合計(1600)より少し短い1枚になる
assert(
  stitchedDims.w === 600 && stitchedDims.h < 1600 && stitchedDims.h >= 1100,
  `複数枚: 証憑画像が縦連結された1枚になる（実際: ${stitchedDims.w}x${stitchedDims.h}）`
);
await page.click("#cancel-btn");
await page.waitForSelector("#capture-step:not(.hidden)");

// --- 重なりのある分割スクショ: 重複部分が検出され、きれいに1枚へ繋がる ---
// 縦2000pxの連続コンテンツを 0-1100 / 700-1800 の2枚に分割し（700-1100が重複）、
// 各スクショの上端60pxにはiOSのステータスバー相当の固定UIを重ねる。
// 正しく繋がれば「重複400px」と「2枚目のステータスバー」が消え、高さは約1800pxになる
const overlapShots = await page.evaluate(() => {
  const content = document.createElement("canvas");
  content.width = 600; content.height = 2000;
  const ctx = content.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 600, 2000);
  ctx.fillStyle = "#222";
  // 実際のアプリ画面と同様、行ごとに内容・位置・太さが異なる非周期なコンテンツにする
  // （等間隔の同一行だと、1画面ずれた位置でも一致してしまい照合テストにならない）
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let y = 50;
  let lineNo = 0;
  while (y < 1950) {
    lineNo++;
    ctx.font = `${18 + Math.floor(rand() * 14)}px sans-serif`;
    ctx.fillText(`駅${lineNo} 経路案内 ${Math.floor(rand() * 9000 + 1000)}円 徒歩${Math.floor(rand() * 20)}分`, 20 + rand() * 60, y);
    ctx.fillRect(20 + rand() * 40, y + 12, 80 + rand() * 460, 1 + rand() * 4);
    y += 35 + rand() * 55;
  }
  const shot = (srcY, h) => {
    const c = document.createElement("canvas");
    c.width = 600; c.height = h;
    const sctx = c.getContext("2d");
    sctx.drawImage(content, 0, srcY, 600, h, 0, 0, 600, h);
    // ステータスバー相当の固定UI（どのスクショにも同じものが写る）
    sctx.fillStyle = "#111";
    sctx.fillRect(0, 0, 600, 60);
    sctx.fillStyle = "#fff";
    sctx.font = "20px sans-serif";
    sctx.fillText("14:22        5G", 20, 38);
    return c.toDataURL("image/png").split(",")[1];
  };
  return [shot(0, 1100), shot(700, 1100)];
});
await page.setInputFiles("#transit-input", [
  { name: "ov1.png", mimeType: "image/png", buffer: Buffer.from(overlapShots[0], "base64") },
  { name: "ov2.png", mimeType: "image/png", buffer: Buffer.from(overlapShots[1], "base64") },
]);
await page.waitForSelector("#transit-preview:not(.hidden)", { timeout: 10000 });
const warnAtPreview = await page.locator("#capture-message .banner.warn").count();
assert(warnAtPreview === 0, "重なり連結: 検出成功時は確認ステップでもwarnが出ない");
// 一度キャンセルすると選択前に戻り、再選択できる
await page.click("#transit-cancel-btn");
const previewHiddenAfterCancel = await page.locator("#transit-preview.hidden").count();
assert(previewHiddenAfterCancel === 1, "確認ステップ: キャンセルで選択前に戻る");
await page.setInputFiles("#transit-input", [
  { name: "ov1.png", mimeType: "image/png", buffer: Buffer.from(overlapShots[0], "base64") },
  { name: "ov2.png", mimeType: "image/png", buffer: Buffer.from(overlapShots[1], "base64") },
]);
await page.waitForSelector("#transit-preview:not(.hidden)", { timeout: 10000 });
await page.click("#transit-analyze-btn");
await page.waitForSelector("#form-step:not(.hidden)", { timeout: 10000 });
const overlapDims = await page.evaluate(async () => {
  const bmp = await createImageBitmap(currentImage);
  return { w: bmp.width, h: bmp.height };
});
assert(
  overlapDims.w === 600 && Math.abs(overlapDims.h - 1800) <= 6,
  `重なり連結: 重複部分が取り除かれて約1800pxになる（実際: ${overlapDims.w}x${overlapDims.h}）`
);
const warnOnSuccess = await page.locator("#capture-message .banner.warn").count();
assert(warnOnSuccess === 0, "重なり連結: 検出に成功した場合はwarnが出ない");
await page.click("#cancel-btn");
await page.waitForSelector("#capture-step:not(.hidden)");

// 9枚以上はエラーで弾く
const nine = [];
for (let i = 0; i < 9; i++) nine.push({ name: `s${i}.png`, mimeType: "image/png", buffer: await makeShot(`page ${i}`) });
await page.setInputFiles("#transit-input", nine);
await page.waitForSelector("#capture-message .banner.error", { timeout: 5000 });
const tooManyMsg = await page.textContent("#capture-message .banner.error");
assert(tooManyMsg.includes("8枚まで"), `複数枚: 9枚以上はエラーで弾く（実際: ${tooManyMsg}）`);
await page.evaluate(() => showMessage("", ""));

// --- クリップボード貼り付けによる取込（PC向け） ---
// 1回目の貼り付けで確認ステップが開き、2回目は「次のページ」として追加連結される
// ページごとに内容がはっきり異なる画像にする（ほぼ同一だと「同じ内容」として
// 正しく重ねられてしまい、追加連結のテストにならない）
const pasteImage = async (w, h, text, seedBase) => {
  await page.evaluate(async ([w, h, t, seedBase]) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#222";
    let seed = seedBase;
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    let y = 60;
    while (y < h - 40) {
      ctx.font = `${18 + Math.floor(rand() * 14)}px sans-serif`;
      ctx.fillText(`${t} ${Math.floor(rand() * 9000)}`, 20 + rand() * 80, y);
      ctx.fillRect(20 + rand() * 40, y + 10, 80 + rand() * 400, 1 + rand() * 3);
      y += 40 + rand() * 50;
    }
    const blob = await new Promise((ok) => c.toBlob(ok, "image/png"));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "pasted.png", { type: "image/png" }));
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt }));
  }, [w, h, text, seedBase]);
};
await pasteImage(600, 700, "貼り付け1ページ目", 11);
await page.waitForSelector("#transit-preview:not(.hidden)", { timeout: 10000 });
const pastedCount1 = await page.evaluate(() => transitCanvases.length);
assert(pastedCount1 === 1, `貼り付け: 1回目で確認ステップが開く（実際: ${pastedCount1}枚）`);
// 連結Blobの差し替わりまで待つ（transitCanvasesの更新はBlob生成より先に行われるため、
// 枚数だけを見て即読み出すと古い1枚目のBlobを読んでしまう）
await page.evaluate(() => { window.__blobBefore = transitStitchedBlob; });
await pasteImage(600, 700, "貼り付け2ページ目", 99991);
await page.waitForFunction(
  () => transitCanvases && transitCanvases.length === 2 && transitStitchedBlob !== window.__blobBefore,
  { timeout: 10000 }
);
const pastedDims = await page.evaluate(async () => {
  const bmp = await createImageBitmap(transitStitchedBlob);
  return { w: bmp.width, h: bmp.height, count: transitCanvases.length };
});
assert(pastedDims.count === 2 && pastedDims.h > 700,
  `貼り付け: 2回目は次のページとして追加連結される（実際: ${pastedDims.count}枚 / ${pastedDims.w}x${pastedDims.h}）`);
// 貼り付けからでも解析へ進める
await page.click("#transit-analyze-btn");
await page.waitForSelector("#form-step:not(.hidden)", { timeout: 10000 });
assert((await page.inputValue("#f-category")) === "交通費", "貼り付け: 解析して交通費フォームが開く");
// 明細フォーム表示中の貼り付けは反応しない（編集の邪魔をしない）
const canvasesBefore = await page.evaluate(() => (transitCanvases ? transitCanvases.length : 0));
await pasteImage(600, 700, "編集中の貼り付け", 555);
await page.waitForTimeout(500);
const canvasesAfter = await page.evaluate(() => (transitCanvases ? transitCanvases.length : 0));
assert(canvasesBefore === canvasesAfter, "貼り付け: 明細フォーム表示中は反応しない");
await page.click("#cancel-btn");
await page.waitForSelector("#capture-step:not(.hidden)");

// 画像以外のファイルは弾く
await page.setInputFiles("#transit-input", {
  name: "memo.txt", mimeType: "text/plain", buffer: Buffer.from("not an image"),
});
await page.waitForSelector("#capture-message .banner.error", { timeout: 5000 });
assert(true, "交通費: 画像以外はエラーメッセージで弾く");

// --- 宿泊費の撮影取込: 撮影フローは購入費と共通だが、勘定科目が宿泊費に固定される ---
// （APIモックは交通費用のJSONを返す＝レシート項目としては全て空になるが、
//   入口の固定が効いて宿泊費になることを確認できる）
await page.setInputFiles("#hotel-input", {
  name: "hotel.png", mimeType: "image/png", buffer: Buffer.from(pngB64, "base64"),
});
await page.waitForFunction(() => document.body.classList.contains("crop-fullscreen"), { timeout: 5000 });
assert(true, "宿泊費: 撮影後にトリミングエディタが開く（購入費と同じフロー）");
await page.waitForFunction(() => !document.getElementById("analyze-btn").disabled);
await page.click("#analyze-btn");
await page.waitForSelector("#form-step:not(.hidden)", { timeout: 10000 });
assert((await page.inputValue("#f-category")) === "宿泊費",
  `宿泊費: OCRの判定によらず勘定科目が宿泊費に固定される（実際: ${await page.inputValue("#f-category")}）`);
// 保存して一覧の色分け（ローズのバッジ）を確認
await page.fill("#f-amount", "12800");
await page.click("#save-btn");
await page.waitForSelector("#capture-step:not(.hidden)");
await page.click('nav button[data-panel="list"]');
await page.waitForSelector("#panel-list.active");
const hotelItemCount = await page.locator(".receipt-item.hotel").count();
assert(hotelItemCount === 1, `一覧: 宿泊費の行にhotelクラスが付く（実際: ${hotelItemCount}件）`);
const hotelBadge = await page.textContent(".receipt-item.hotel .type-badge");
assert(hotelBadge === "🏨 宿泊費", `一覧: 宿泊費バッジが表示される（実際: ${hotelBadge}）`);

// --- 一覧からの再解析: 保存済みの証憑画像でOCRをやり直し、フォームを上書きする ---
await page.locator(".receipt-item.transit").click();
await page.waitForSelector("#form-step:not(.hidden)");
await page.waitForFunction(() => document.getElementById("reanalyze-btn").offsetParent !== null, { timeout: 5000 });
assert(true, "再解析: 証憑画像つき明細の編集で再解析ボタンが表示される");
// 値を書き換えてから再解析し、OCR結果で上書きされることを確認する
const dateBeforeReanalyze = await page.inputValue("#f-date");
await page.fill("#f-amount", "1");
await page.fill("#f-vendor", "書き換えた支払先");
await page.fill("#f-note", "大会出張");
await page.evaluate(() => showMessage("", "")); // 直前の「保存しました」バナーを消してから押す
await page.click("#reanalyze-btn");
await page.waitForFunction(
  () => document.querySelector("#capture-message .banner.ok")?.textContent.includes("再解析"),
  { timeout: 10000 }
);
assert((await page.inputValue("#f-amount")) === "409", `再解析: 金額がOCR結果で上書きされる（実際: ${await page.inputValue("#f-amount")}）`);
assert((await page.inputValue("#f-vendor")) === "東京メトロ東西線", "再解析: 支払先がOCR結果で上書きされる");
assert((await page.inputValue("#f-memo")).includes("距離: 約15km"), "再解析: 摘要が行程＋距離で上書きされる");
// 日付が読み取れないスクショ（モックはdate空）では、今日ではなく既存の日付を据え置く
assert((await page.inputValue("#f-date")) === dateBeforeReanalyze, "再解析: 日付が読めない場合は既存の日付を据え置く");
// 依頼内容・用途は利用者の記入のため上書きされない
assert((await page.inputValue("#f-note")) === "大会出張", "再解析: 依頼内容・用途は保持される");
assert((await page.inputValue("#f-category")) === "交通費", "再解析: 交通費明細は経路プロンプトで解析され科目が保たれる");
// 画像がある明細では「写真を追加して解析」の入口は出ない
const addPhotoHiddenWithImage = await page.evaluate(() => document.getElementById("edit-add-photo").offsetParent === null);
assert(addPhotoHiddenWithImage, "写真の後付け: 画像のある明細では入口が出ない");
await page.click("#cancel-btn");
await page.waitForSelector("#panel-list.active");

// --- 写真の後付け: 手入力の交通費明細に、後から経路スクショを追加して解析・添付 ---
await page.click('nav button[data-panel="capture"]');
await page.waitForSelector("#panel-capture.active");
await page.click("#transit-manual-btn");
await page.waitForSelector("#form-step:not(.hidden)");
await page.fill("#f-note", "後付けテスト");
await page.click("#save-btn");
await page.waitForSelector("#capture-step:not(.hidden)");
await page.click('nav button[data-panel="list"]');
await page.waitForSelector("#panel-list.active");
await page.locator(".receipt-item", { hasText: "後付けテスト" }).click();
await page.waitForSelector("#form-step:not(.hidden)");
await page.waitForFunction(() => document.getElementById("edit-add-photo").offsetParent !== null, { timeout: 5000 });
assert(true, "写真の後付け: 画像なし明細の編集で入口が表示される");
await page.evaluate(() => showMessage("", ""));
await page.setInputFiles("#edit-photo-input", {
  name: "late.png", mimeType: "image/png", buffer: Buffer.from(pngB64, "base64"),
});
await page.waitForFunction(
  () => document.querySelector("#capture-message .banner.ok")?.textContent.includes("解析して反映"),
  { timeout: 10000 }
);
assert((await page.inputValue("#f-amount")) === "409", `写真の後付け: 金額が自動入力される（実際: ${await page.inputValue("#f-amount")}）`);
assert((await page.inputValue("#f-memo")).includes("距離: 約15km"), "写真の後付け: 摘要（行程＋距離）が自動入力される");
assert((await page.inputValue("#f-note")) === "後付けテスト", "写真の後付け: 依頼内容・用途は保持される");
const addPhotoAfter = await page.evaluate(() => document.getElementById("edit-add-photo").offsetParent === null);
assert(addPhotoAfter, "写真の後付け: 解析後は入口が消えプレビューに切り替わる");
await page.click("#save-btn");
await page.waitForSelector("#panel-list.active");
const lateRow = await page.evaluate(async () => {
  const rows = JSON.parse(localStorage.getItem("shiden_expense_receipts"));
  const r = rows.find((x) => x.note === "後付けテスト");
  const blob = await getImage(r.id).catch(() => null);
  return { filename: r.filename, hasImage: !!blob, type: blob ? blob.type : "" };
});
assert(lateRow.filename.endsWith(".png") && lateRow.hasImage && lateRow.type === "image/png",
  `写真の後付け: 保存で証憑画像（PNG）が添付される（実際: ${lateRow.filename} / ${lateRow.type}）`);

// --- 宿泊期間: 宿泊費のみ「宿泊終了日」を記入でき、一覧・CSV・申請に反映される ---
await page.click('nav button[data-panel="capture"]');
await page.waitForSelector("#panel-capture.active");
// 交通費の手入力では宿泊終了日欄は出ない
await page.click("#transit-manual-btn");
await page.waitForSelector("#form-step:not(.hidden)");
const dateToHiddenForTransit = await page.evaluate(() => document.getElementById("date-to-wrap").offsetParent === null);
assert(dateToHiddenForTransit, "宿泊期間: 交通費では終了日欄が出ない");
await page.click("#cancel-btn");
await page.waitForSelector("#capture-step:not(.hidden)");
// 宿泊費の手入力では出る
await page.click("#hotel-manual-btn");
await page.waitForSelector("#form-step:not(.hidden)");
const dateToVisibleForHotel = await page.evaluate(() => document.getElementById("date-to-wrap").offsetParent !== null);
assert(dateToVisibleForHotel, "宿泊期間: 宿泊費では終了日欄が表示される");
await page.fill("#f-note", "宿泊期間テスト");
await page.fill("#f-amount", "26400");
await page.fill("#f-date", "2026-07-08");
// 開始日より前の終了日はエラーで保存できない
await page.fill("#f-date-to", "2026-07-06");
await page.click("#save-btn");
await page.waitForSelector("#capture-message .banner.error", { timeout: 5000 });
const stillEditing = await page.evaluate(() => !document.getElementById("form-step").classList.contains("hidden"));
assert(stillEditing, "宿泊期間: 終了日が開始日より前だとエラーで保存されない");
// 正しい期間なら保存でき、一覧が期間表示になる
await page.fill("#f-date-to", "2026-07-10");
await page.click("#save-btn");
await page.waitForSelector("#capture-step:not(.hidden)");
await page.click('nav button[data-panel="list"]');
await page.waitForSelector("#panel-list.active");
const hotelMeta = await page.locator(".receipt-item", { hasText: "宿泊期間テスト" }).locator(".meta").textContent();
assert(hotelMeta.includes("2026-07-08 〜 2026-07-10"), `宿泊期間: 一覧が期間表示になる（実際: ${hotelMeta.split("\n")[0]}）`);
// CSVの末尾列「宿泊終了日」に入り、申請文の日付も期間になる
const rangeOut = await page.evaluate(() => {
  const rows = JSON.parse(localStorage.getItem("shiden_expense_receipts"));
  const r = rows.find((x) => x.note === "宿泊期間テスト");
  return { csv: buildCsv([r]), share: buildShareText(r) };
});
assert(rangeOut.csv.includes("終了日") && rangeOut.csv.includes(",2026-07-10,\r\n"),
  "宿泊期間: CSVの終了日列に出力される");
assert(rangeOut.share.body.includes("日付: 2026-07-08〜2026-07-10"), "宿泊期間: 申請文の日付が期間になる");

// --- タクシー等のレシート撮影（交通費の撮影入口）: レシートOCR＋科目は交通費に固定 ---
await page.click('nav button[data-panel="capture"]');
await page.waitForSelector("#panel-capture.active");
await page.setInputFiles("#transit-photo-input", {
  name: "taxi.png", mimeType: "image/png", buffer: Buffer.from(pngB64, "base64"),
});
await page.waitForFunction(() => document.body.classList.contains("crop-fullscreen"), { timeout: 5000 });
assert(true, "タクシー: 撮影後にトリミングエディタが開く（レシートと同じフロー）");
await page.waitForFunction(() => !document.getElementById("analyze-btn").disabled);
await page.click("#analyze-btn");
await page.waitForSelector("#form-step:not(.hidden)", { timeout: 10000 });
assert(receivedPrompt.includes("店舗レシートまたは領収書"), "タクシー: レシートOCRプロンプトで解析される");
assert((await page.inputValue("#f-category")) === "交通費",
  `タクシー: 勘定科目が交通費に固定される（実際: ${await page.inputValue("#f-category")}）`);
assert((await page.inputValue("#f-amount")) === "409", "タクシー: 金額が自動入力される");
await page.fill("#f-note", "タクシーテスト");
await page.click("#save-btn");
await page.waitForSelector("#capture-step:not(.hidden)");
const taxiRow = await page.evaluate(() => {
  const rows = JSON.parse(localStorage.getItem("shiden_expense_receipts"));
  return rows.find((x) => x.note === "タクシーテスト");
});
assert(taxiRow.filename.endsWith(".png"), `タクシー: 証憑もPNGで保存される（実際: ${taxiRow.filename}）`);
assert(taxiRow.img_kind === "receipt", `タクシー: 種別がreceiptとして記録される（実際: ${taxiRow.img_kind}）`);
// 交通費でも証憑がJPEG（レシート写真）の明細は、再解析でもレシートOCRが使われる
await page.click('nav button[data-panel="list"]');
await page.waitForSelector("#panel-list.active");
await page.locator(".receipt-item", { hasText: "タクシーテスト" }).click();
await page.waitForSelector("#form-step:not(.hidden)");
await page.waitForFunction(() => document.getElementById("reanalyze-btn").offsetParent !== null, { timeout: 5000 });
await page.evaluate(() => showMessage("", ""));
await page.click("#reanalyze-btn");
await page.waitForFunction(
  () => document.querySelector("#capture-message .banner.ok")?.textContent.includes("再解析"),
  { timeout: 10000 }
);
assert(receivedPrompt.includes("店舗レシートまたは領収書"), "タクシー: 再解析もレシートOCRで行われる（img_kindによる判別）");
assert((await page.inputValue("#f-category")) === "交通費", "タクシー: 再解析後も科目は交通費のまま");
await page.click("#cancel-btn");
await page.waitForSelector("#panel-list.active");

// --- 往復区分: 交通費のみ表示され、一覧・CSV・申請文に反映される ---
await page.click('nav button[data-panel="capture"]');
await page.waitForSelector("#panel-capture.active");
// 購入費の手入力では出ない
await page.click("#manual-btn");
await page.waitForSelector("#form-step:not(.hidden)");
const tripHiddenForPurchase = await page.evaluate(() => document.getElementById("trip-type-wrap").offsetParent === null);
assert(tripHiddenForPurchase, "往復区分: 交通費以外では欄が出ない");
await page.click("#cancel-btn");
await page.waitForSelector("#capture-step:not(.hidden)");
// 交通費の手入力では出る
await page.click("#transit-manual-btn");
await page.waitForSelector("#form-step:not(.hidden)");
const tripVisibleForTransit = await page.evaluate(() => document.getElementById("trip-type-wrap").offsetParent !== null);
assert(tripVisibleForTransit, "往復区分: 交通費では欄が表示される");
await page.fill("#f-note", "往復テスト");
await page.fill("#f-amount", "19760");
// 「往復」を選ぶと片道運賃が2倍になり、計算式が摘要に1行残る（見える自動計算）
await page.selectOption("#f-trip-type", "往復");
assert((await page.inputValue("#f-amount")) === "39,520",
  `往復区分: 往復を選ぶと金額が2倍になる（実際: ${await page.inputValue("#f-amount")}）`);
assert((await page.inputValue("#f-memo")).includes("往復: ¥19,760 × 2 = ¥39,520"),
  `往復区分: 計算式が摘要に明示される（実際: ${await page.inputValue("#f-memo")}）`);
// 往復をやめると計算式の行から片道運賃に戻る
await page.selectOption("#f-trip-type", "復路");
assert((await page.inputValue("#f-amount")) === "19,760", "往復区分: 往復をやめると片道運賃に戻る");
assert(!(await page.inputValue("#f-memo")).includes("往復:"), "往復区分: 計算式の行も消える");
// 選び直しても二重に2倍にならない（計算式の行が既にあればスキップ）
await page.selectOption("#f-trip-type", "往復");
assert((await page.inputValue("#f-amount")) === "39,520", "往復区分: 選び直しで再計算される");
await page.selectOption("#f-trip-type", "往復").catch(() => {});
assert((await page.inputValue("#f-amount")) === "39,520", "往復区分: 二重に2倍にならない");
// 往復を選ぶと「復路の日付」欄が出る（宿泊費では宿泊終了日として共用）
const dateToVisibleRoundTrip = await page.evaluate(() => document.getElementById("date-to-wrap").offsetParent !== null);
assert(dateToVisibleRoundTrip, "往復区分: 往復を選ぶと復路の日付欄が表示される");
const dateToLabel = await page.textContent("#date-to-label");
assert(dateToLabel === "復路の日付（任意）", `往復区分: ラベルが復路の日付になる（実際: ${dateToLabel}）`);
await page.fill("#f-date", "2026-07-08");
await page.fill("#f-date-to", "2026-07-10");
await page.click("#save-btn");
await page.waitForSelector("#capture-step:not(.hidden)");
await page.click('nav button[data-panel="list"]');
await page.waitForSelector("#panel-list.active");
const tripMeta = await page.locator(".receipt-item", { hasText: "往復テスト" }).locator(".meta").textContent();
assert(tripMeta.includes("交通費（往復）"), `往復区分: 一覧の科目行に（往復）が付く（実際: ${tripMeta}）`);
const tripOut = await page.evaluate(() => {
  const rows = JSON.parse(localStorage.getItem("shiden_expense_receipts"));
  const r = rows.find((x) => x.note === "往復テスト");
  return { csv: buildCsv([r]), share: buildShareText(r).body, trip: r.trip_type };
});
assert(tripOut.trip === "往復", "往復区分: 明細に保存される");
assert(tripOut.csv.includes("往復区分") && tripOut.csv.endsWith(",2026-07-10,往復\r\n"), "往復区分: CSVの終了日・往復区分列に出力される");
assert(tripMeta.includes("2026-07-08 〜 2026-07-10"), `往復区分: 一覧が期間表示になる（実際: ${tripMeta.split("\n")[0]}）`);
assert(tripOut.share.includes("往復区分: 往復"), "往復区分: 申請文に出力される");

await browser.close();
console.log(failures === 0 ? "\nALL TRANSIT TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
