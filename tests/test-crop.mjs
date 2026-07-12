// 手動トリミングエディタ（四隅ドラッグUI）のE2E検証
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

await page.route("https://api.openai.com/**", (route) => {
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        date: "2026-07-07", vendor: "トリミング商店", amount: 2500,
        category: "会議費", memo: "テスト",
      }) } }],
    }),
  });
});

await page.goto(page_url);
await page.waitForLoadState("domcontentloaded");
await page.evaluate(() => {
  localStorage.setItem("shiden_expense_settings", JSON.stringify({ apiKey: "sk-test", model: "gpt-5.4" }));
});

// 背景付きのレシート風合成画像（800x600、紙は60,50-740,550）をページ内で生成してファイル選択に流す
const pngB64 = await page.evaluate(() => {
  const canvas = document.createElement("canvas");
  canvas.width = 800; canvas.height = 600;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgb(120,110,100)";
  ctx.fillRect(0, 0, 800, 600);
  ctx.fillStyle = "rgb(240,238,235)";
  ctx.fillRect(60, 50, 680, 500);
  ctx.fillStyle = "rgb(50,48,46)";
  ctx.font = "28px sans-serif";
  ctx.fillText("領収書 テスト商店", 100, 120);
  ctx.fillText("合計 ¥2,500", 100, 180);
  return canvas.toDataURL("image/png").split(",")[1];
});
await page.setInputFiles("#image-input", {
  name: "receipt.png", mimeType: "image/png", buffer: Buffer.from(pngB64, "base64"),
});

// トリミングエディタが表示され、初期四隅が背景検出で紙の範囲に置かれる
await page.waitForSelector("#crop-editor:not(.hidden)", { timeout: 5000 });
assert(true, "画像選択: トリミングエディタが表示される");
// 全画面編集フェーズ: ヘッダー・ナビが隠れ、解析ボタンはスクロール不要で画面内に見えている
const fullscreenState = await page.evaluate(() => ({
  bodyClass: document.body.classList.contains("crop-fullscreen"),
  headerHidden: document.querySelector("header").offsetParent === null,
  navHidden: document.querySelector("nav").offsetParent === null,
}));
assert(fullscreenState.bodyClass, "全画面: bodyにcrop-fullscreenが付く");
assert(fullscreenState.headerHidden && fullscreenState.navHidden, "全画面: ヘッダーとナビが隠れる");
const analyzeBox = await page.locator("#analyze-btn").boundingBox();
assert(
  analyzeBox && analyzeBox.y >= 0 && analyzeBox.y + analyzeBox.height <= 844,
  `全画面: 解析ボタンがスクロール無しで画面内に見える（y: ${analyzeBox && analyzeBox.y.toFixed(0)}）`
);
await page.waitForFunction(() => !document.getElementById("analyze-btn").disabled);
const initialQuad = await page.evaluate(() => cropQuad.map((p) => ({ x: p.x, y: p.y })));
assert(
  initialQuad[0].x === 0.15 && initialQuad[0].y === 0.10 && initialQuad[2].x === 0.85 && initialQuad[2].y === 0.90,
  `初期四隅: 常に横15%・縦10%内側の固定位置（実際: ${initialQuad[0].x},${initialQuad[0].y}）`
);

// 補正のON/OFFチェックが表示され、既定はどちらもOFF（元の写真のまま）
const shadowChecked = await page.isChecked("#opt-shadow");
const contrastChecked = await page.isChecked("#opt-contrast");
assert(!shadowChecked && !contrastChecked, "補正設定: 影消去・コントラスト補正は既定でOFF");
// チェックを切り替えると、エディタの画像プレビューに補正が即時反映される
const canvasDataOff = await page.evaluate(() => {
  const c = document.getElementById("crop-canvas");
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += d[i];
  return sum;
});
// ONにすると設定に保存され、リロード後も引き継がれる
await page.check("#opt-shadow");
await page.waitForTimeout(200);
const canvasDataOn = await page.evaluate(() => {
  const c = document.getElementById("crop-canvas");
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += d[i];
  return sum;
});
assert(canvasDataOn !== canvasDataOff, "即時プレビュー: 補正のON/OFFで表示中の画像が変わる");
const savedShadowOn = await page.evaluate(() => JSON.parse(localStorage.getItem("shiden_expense_settings")).removeShadow);
assert(savedShadowOn === true, `補正設定: ONが設定に保存される（実際: ${savedShadowOn}）`);

// 誤操作でリロードされても、選択した写真がトリミングエディタごと復元される
await page.reload();
await page.waitForLoadState("domcontentloaded");
await page.waitForSelector("#crop-editor:not(.hidden)", { timeout: 5000 });
await page.waitForFunction(() => !document.getElementById("analyze-btn").disabled);
assert(true, "リロード: 解析前の選択写真がエディタごと復元される");
const shadowAfterReload = await page.isChecked("#opt-shadow");
assert(shadowAfterReload === true, "補正設定: リロード後もONが引き継がれる");
await page.uncheck("#opt-shadow"); // 以降のテストのため既定(OFF)に戻す

// ハンドルをドラッグすると四隅が動く（Pointer Events）
const handle = page.locator('.crop-handle[data-corner="0"]');
const box = await handle.boundingBox();
const stageBox = await page.locator("#crop-stage").boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(stageBox.x + stageBox.width * 0.3, stageBox.y + stageBox.height * 0.25, { steps: 5 });
// ドラッグ中は拡大鏡が表示される
const loupeVisibleDuringDrag = await page.isVisible("#crop-loupe");
assert(loupeVisibleDuringDrag, "拡大鏡: ドラッグ中に表示される");
const loupeHasContent = await page.evaluate(() => {
  const loupe = document.getElementById("crop-loupe");
  const data = loupe.getContext("2d").getImageData(0, 0, loupe.width, loupe.height).data;
  let nonBlack = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 40 || data[i + 1] > 40 || data[i + 2] > 40) nonBlack++;
  }
  return nonBlack > (data.length / 4) * 0.1;
});
assert(loupeHasContent, "拡大鏡: 画像の拡大部分が描画されている");
// 拡大鏡は指（＝角の現在位置）の真上に追従する（D=120, GAP=26）
const follow = await page.evaluate(() => {
  const stage = document.getElementById("crop-stage");
  const loupe = document.getElementById("crop-loupe");
  const cssW = stage.clientWidth;
  const cssH = parseFloat(document.getElementById("crop-canvas").style.height);
  const p = cropQuad[0];
  return {
    left: parseFloat(loupe.style.left),
    top: parseFloat(loupe.style.top),
    expectedLeft: p.x * cssW - 60,
    expectedTop: p.y * cssH - 146,
  };
});
assert(
  Math.abs(follow.left - follow.expectedLeft) < 2 && Math.abs(follow.top - follow.expectedTop) < 2,
  `拡大鏡: 指の真上に追従する（実際: ${follow.left.toFixed(0)},${follow.top.toFixed(0)} 期待: ${follow.expectedLeft.toFixed(0)},${follow.expectedTop.toFixed(0)}）`
);
await page.mouse.up();
const loupeHiddenAfterDrag = await page.locator("#crop-loupe.hidden").count();
assert(loupeHiddenAfterDrag === 1, "拡大鏡: ドラッグ終了で消える");
const draggedQuad = await page.evaluate(() => cropQuad.map((p) => ({ x: p.x, y: p.y })));
assert(
  Math.abs(draggedQuad[0].x - 0.3) < 0.03 && Math.abs(draggedQuad[0].y - 0.25) < 0.03,
  `ドラッグ: 左上ハンドルの移動が四隅に反映される（実際: ${draggedQuad[0].x.toFixed(2)},${draggedQuad[0].y.toFixed(2)}）`
);

// 当たり判定: ハンドルは120px四方。見た目の丸(30px)から外れた位置からでも掴める。
// 全画面フェーズにはスクロールが無いため、画像上のタッチは全面無効(touch-action: none)
const touchActions = await page.evaluate(() => ({
  stage: getComputedStyle(document.getElementById("crop-stage")).touchAction,
  handle: getComputedStyle(document.querySelector(".crop-handle")).touchAction,
}));
assert(touchActions.stage === "none", `タッチ: 画像上の誤操作スクロールを全面無効化（実際: ${touchActions.stage}）`);
assert(touchActions.handle === "none", `タッチ: ハンドル上もスクロール無効（実際: ${touchActions.handle}）`);

const c1Before = await page.evaluate(() => ({ ...cropQuad[1] }));
const c1Css = await page.evaluate(() => {
  const rect = document.getElementById("crop-stage").getBoundingClientRect();
  return { x: rect.left + cropQuad[1].x * rect.width, y: rect.top + cropQuad[1].y * rect.height };
});
await page.mouse.move(c1Css.x - 45, c1Css.y + 45); // 見た目の丸(半径15px)の外・当たり判定(±60px)の内
await page.mouse.down();
await page.mouse.move(c1Css.x - 70, c1Css.y + 70, { steps: 3 });
await page.mouse.up();
const c1After = await page.evaluate(() => ({ ...cropQuad[1] }));
assert(
  c1After.x !== c1Before.x || c1After.y !== c1Before.y,
  "当たり判定: 見た目の丸から45px離れた位置からでも掴める（120px四方の当たり判定）"
);

// 四隅を紙の範囲ちょうどに設定して解析→切り抜き結果が紙のサイズになる
await page.evaluate(() => {
  cropQuad = [
    { x: 60 / 800, y: 50 / 600 }, { x: 740 / 800, y: 50 / 600 },
    { x: 740 / 800, y: 550 / 600 }, { x: 60 / 800, y: 550 / 600 },
  ];
  renderCropEditor();
});
await page.click("#analyze-btn");
await page.waitForSelector("#form-step:not(.hidden)", { timeout: 10000 });
assert((await page.inputValue("#f-vendor")) === "トリミング商店", "解析: トリミング後の画像でOCRが実行される");

const croppedDims = await page.evaluate(async () => {
  const bmp = await createImageBitmap(currentImage);
  return { w: bmp.width, h: bmp.height };
});
assert(
  croppedDims.w === 680 && croppedDims.h === 500,
  `切り抜き: 保存用画像が指定した四隅の範囲になる（実際: ${croppedDims.w}x${croppedDims.h}）`
);

// 保存された証憑画像もトリミング済みのものになっている
await page.click("#save-btn");
await page.waitForSelector("#capture-step:not(.hidden)");
const savedDims = await page.evaluate(async () => {
  const rows = JSON.parse(localStorage.getItem("shiden_expense_receipts"));
  const blob = await getImage(rows[0].id);
  const bmp = await createImageBitmap(blob);
  return { w: bmp.width, h: bmp.height };
});
assert(savedDims.w === 680 && savedDims.h === 500, `保存: 証憑画像もトリミング済み（実際: ${savedDims.w}x${savedDims.h}）`);

// --- 明細CSVの埋め込み: 証憑PNGのiTXtチャンクに明細が入り、画像が壊れない ---
const embedded = await page.evaluate(async () => {
  const rows = JSON.parse(localStorage.getItem("shiden_expense_receipts"));
  const blob = await getImage(rows[0].id);
  const csv = await extractCsvFromPng(blob);
  const bmp = await createImageBitmap(blob); // チャンク挿入後もPNGとしてデコードできること
  return { type: blob.type, csv, w: bmp.width, h: bmp.height };
});
assert(embedded.type === "image/png", `埋め込み: 証憑はPNGで保存される（実際: ${embedded.type}）`);
assert(embedded.csv && embedded.csv.includes("トリミング商店") && embedded.csv.includes("2500"),
  `埋め込み: 証憑PNGから明細CSVを取り出せる（実際: ${(embedded.csv || "").slice(0, 60)}...）`);
assert(embedded.csv.includes("領収書日付"), "埋め込み: CSVヘッダー行も含まれる");
assert(embedded.w === 680 && embedded.h === 500, "埋め込み: 画像自体は壊れずデコードできる");

// 明細を編集して保存すると、埋め込みCSVも更新される
await page.click('nav button[data-panel="list"]');
await page.waitForSelector("#panel-list.active");
await page.locator(".receipt-item").first().click();
await page.waitForSelector("#form-step:not(.hidden)");
await page.fill("#f-amount", "9999");
await page.click("#save-btn");
await page.waitForSelector("#panel-list.active");
const reEmbedded = await page.evaluate(async () => {
  const rows = JSON.parse(localStorage.getItem("shiden_expense_receipts"));
  const blob = await getImage(rows[0].id);
  return await extractCsvFromPng(blob);
});
assert(reEmbedded && reEmbedded.includes("9999") && !reEmbedded.includes(",2500,"),
  "埋め込み: 明細の編集保存で埋め込みCSVも更新される（旧チャンクは置き換え）");
// 金額を元に戻して以降のテストへ影響しないようにする
await page.locator(".receipt-item").first().click();
await page.waitForSelector("#form-step:not(.hidden)");
await page.fill("#f-amount", "2500");
await page.click("#save-btn");
await page.waitForSelector("#panel-list.active");

// --- PNGからの復元: 埋め込みCSVで明細と証憑をまとめて戻せる ---
const pngBytes = await page.evaluate(async () => {
  const rows = JSON.parse(localStorage.getItem("shiden_expense_receipts"));
  const blob = await getImage(rows[0].id);
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
});
// 全明細が消えた状況を模擬してから復元する
await page.evaluate(() => localStorage.setItem("shiden_expense_receipts", "[]"));
await page.click('nav button[data-panel="settings"]');
await page.waitForSelector("#panel-settings.active");
// 設定タブに保存領域の使用量が表示される
await page.waitForFunction(() => document.getElementById("storage-info").textContent.includes("保存領域"), { timeout: 5000 });
assert(true, "設定: 保存領域の使用量・永続化状態が表示される");
await page.setInputFiles("#restore-input", {
  name: "backup.png", mimeType: "image/png", buffer: Buffer.from(pngBytes),
});
await page.waitForFunction(() => document.getElementById("restore-result").textContent.includes("1件を復元"), { timeout: 10000 });
const restoredRow = await page.evaluate(async () => {
  const rows = JSON.parse(localStorage.getItem("shiden_expense_receipts"));
  const r = rows[0];
  const blob = await getImage(r.id).catch(() => null);
  const csv = blob ? await extractCsvFromPng(blob) : null;
  return { count: rows.length, vendor: r.vendor, amount: r.amount, category: r.category, hasImage: !!blob, embedded: !!csv, filename: r.filename };
});
assert(restoredRow.count === 1 && restoredRow.vendor === "トリミング商店" && restoredRow.amount === 2500 && restoredRow.category === "会議費",
  `復元: 明細の各項目が戻る（実際: ${JSON.stringify(restoredRow)}）`);
assert(restoredRow.hasImage && restoredRow.embedded, "復元: 証憑画像も埋め込み付きで戻る");
// 同じPNGをもう一度選ぶと重複としてスキップされ、件数は増えない
await page.setInputFiles("#restore-input", {
  name: "backup.png", mimeType: "image/png", buffer: Buffer.from(pngBytes),
});
await page.waitForFunction(() => document.getElementById("restore-result").textContent.includes("重複1件"), { timeout: 10000 });
const countAfterDup = await page.evaluate(() => JSON.parse(localStorage.getItem("shiden_expense_receipts")).length);
assert(countAfterDup === 1, "復元: 重複はスキップされ件数が増えない");

await page.click('nav button[data-panel="capture"]');
await page.waitForSelector("#panel-capture.active");

// 保存後はエディタが閉じ、次の撮影に備えてリセットされる
const editorHiddenAfterSave = await page.locator("#crop-editor.hidden").count();
assert(editorHiddenAfterSave === 1, "保存後: トリミングエディタが閉じる");
const fullscreenAfterSave = await page.evaluate(() => document.body.classList.contains("crop-fullscreen"));
assert(!fullscreenAfterSave, "保存後: 全画面が解除されている");

// 保存で写真の下書きも消えるため、リロードしてもエディタは復元されない
await page.reload();
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(300);
const editorHiddenAfterReload = await page.locator("#crop-editor.hidden").count();
assert(editorHiddenAfterReload === 1, "保存後: リロードしても写真は復元されない（下書きが消えている）");

// --- 高解像度画像: 切り抜きは元解像度に対して行われ、1800px上限は切り抜き後に適用される ---
// （先に1800pxへ縮小してから切り抜くと2000px幅の紙が1500pxに落ちてしまう。
//   修正後は切り抜き後にmin(2000,1800)=1800px幅が保たれる）
const bigPngB64 = await page.evaluate(() => {
  const canvas = document.createElement("canvas");
  canvas.width = 2400; canvas.height = 1800;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgb(90,80,70)";
  ctx.fillRect(0, 0, 2400, 1800);
  ctx.fillStyle = "rgb(245,243,240)";
  ctx.fillRect(200, 150, 2000, 1500);
  return canvas.toDataURL("image/png").split(",")[1];
});
await page.setInputFiles("#image-input", {
  name: "big.png", mimeType: "image/png", buffer: Buffer.from(bigPngB64, "base64"),
});
await page.waitForSelector("#crop-editor:not(.hidden)", { timeout: 5000 });
await page.waitForFunction(() => !document.getElementById("analyze-btn").disabled);
await page.evaluate(() => {
  cropQuad = [
    { x: 200 / 2400, y: 150 / 1800 }, { x: 2200 / 2400, y: 150 / 1800 },
    { x: 2200 / 2400, y: 1650 / 1800 }, { x: 200 / 2400, y: 1650 / 1800 },
  ];
  renderCropEditor();
});
await page.click("#analyze-btn");
await page.waitForSelector("#form-step:not(.hidden)", { timeout: 10000 });
const bigDims = await page.evaluate(async () => {
  const bmp = await createImageBitmap(currentImage);
  return { w: bmp.width, h: bmp.height };
});
assert(
  bigDims.w === 1800 && bigDims.h === 1350,
  `高解像度: 切り抜き後に1800px上限が適用され解像度が保たれる（実際: ${bigDims.w}x${bigDims.h}）`
);
await page.click("#cancel-btn");

// --- 縦長の写真でも画像置き場に完全に収まり、スクロール不要で操作できる ---
const tallPngB64 = await page.evaluate(() => {
  const canvas = document.createElement("canvas");
  canvas.width = 700; canvas.height = 2000;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgb(120,110,100)";
  ctx.fillRect(0, 0, 700, 2000);
  ctx.fillStyle = "rgb(245,243,240)";
  ctx.fillRect(100, 100, 500, 1800);
  return canvas.toDataURL("image/png").split(",")[1];
});
await page.setInputFiles("#image-input", {
  name: "tall.png", mimeType: "image/png", buffer: Buffer.from(tallPngB64, "base64"),
});
await page.waitForSelector("#crop-editor:not(.hidden)", { timeout: 5000 });
await page.waitForFunction(() => !document.getElementById("analyze-btn").disabled);
const fitCheck = await page.evaluate(() => {
  const canvas = document.getElementById("crop-canvas");
  const stage = document.getElementById("crop-stage");
  const wrap = document.getElementById("crop-stage-wrap");
  const stageRect = stage.getBoundingClientRect();
  const wrapRect = wrap.getBoundingClientRect();
  return {
    cssH: canvas.clientHeight,
    maxH: wrap.clientHeight,
    centered: stageRect.left - wrapRect.left > 10 && wrapRect.right - stageRect.right > 10,
  };
});
assert(fitCheck.cssH <= fitCheck.maxH + 2, `縦長画像: 画像置き場の高さに収まる（実際: ${fitCheck.cssH}px / 上限: ${fitCheck.maxH}px）`);
assert(fitCheck.centered, "縦長画像: 中央寄せで表示される");
const tallAnalyzeBox = await page.locator("#analyze-btn").boundingBox();
assert(
  tallAnalyzeBox && tallAnalyzeBox.y + tallAnalyzeBox.height <= 844,
  `縦長画像: 解析ボタンがスクロール無しで画面内に見える（下端: ${tallAnalyzeBox && (tallAnalyzeBox.y + tallAnalyzeBox.height).toFixed(0)}）`
);

// 下のハンドルの当たり判定(120px四方)が補正チェックの上に重なっていても、
// チェックボックス側が前面(z-index)にあり問題なくタップできる
let checkboxTappable = true;
try {
  await page.uncheck("#opt-shadow", { timeout: 3000 });
  await page.check("#opt-shadow", { timeout: 3000 });
} catch {
  checkboxTappable = false;
}
assert(checkboxTappable, "補正チェック: ハンドルの当たり判定と重なってもタップできる");

// どの角からも120px以上離れた位置（縦長画像の中央）を触っても、四隅は動かない
const tallStageBox = await page.locator("#crop-stage").boundingBox();
const quadBeforeFar = await page.evaluate(() => JSON.stringify(cropQuad));
await page.mouse.move(tallStageBox.x + tallStageBox.width * 0.5, tallStageBox.y + tallStageBox.height * 0.5);
await page.mouse.down();
await page.mouse.move(tallStageBox.x + tallStageBox.width * 0.5, tallStageBox.y + tallStageBox.height * 0.55, { steps: 3 });
await page.mouse.up();
const quadAfterFar = await page.evaluate(() => JSON.stringify(cropQuad));
assert(quadBeforeFar === quadAfterFar, "当たり判定: ハンドルの外のタッチでは四隅が動かない");

// --- 写真選択のキャンセル: 選んだ写真を破棄でき、リロードしても復元されない ---
const cancelVisibleWithEditor = await page.isVisible("#crop-cancel-btn");
assert(cancelVisibleWithEditor, "キャンセル: 写真選択中はキャンセルボタンが表示される");
await page.click("#crop-cancel-btn");
const editorHiddenAfterCancel = await page.locator("#crop-editor.hidden").count();
assert(editorHiddenAfterCancel === 1, "キャンセル: エディタが閉じて選択前の状態に戻る");
const fullscreenAfterCancel = await page.evaluate(() => document.body.classList.contains("crop-fullscreen"));
assert(!fullscreenAfterCancel, "キャンセル: 全画面が解除されヘッダー・ナビが戻る");
const navVisibleAfterCancel = await page.evaluate(() => document.querySelector("nav").offsetParent !== null);
assert(navVisibleAfterCancel, "キャンセル: 下部ナビが再表示される");
const manualVisibleAfterCancel = await page.isVisible("#manual-btn");
assert(manualVisibleAfterCancel, "キャンセル: 手入力ボタンが見えている");
await page.reload();
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(300);
const editorHiddenAfterCancelReload = await page.locator("#crop-editor.hidden").count();
assert(editorHiddenAfterCancelReload === 1, "キャンセル: リロードしても破棄した写真は復元されない");

// --- 写真の後付け（レシート系）: 手入力明細に写真を追加→トリミング→解析→編集中フォームへ反映 ---
await page.click("#manual-btn");
await page.waitForSelector("#form-step:not(.hidden)");
await page.fill("#f-note", "レシート後付けテスト");
await page.click("#save-btn");
await page.waitForSelector("#capture-step:not(.hidden)");
await page.click('nav button[data-panel="list"]');
await page.waitForSelector("#panel-list.active");
await page.locator(".receipt-item", { hasText: "レシート後付けテスト" }).click();
await page.waitForSelector("#form-step:not(.hidden)");
await page.waitForFunction(() => document.getElementById("edit-add-photo").offsetParent !== null, { timeout: 5000 });
await page.setInputFiles("#edit-photo-input", {
  name: "late-receipt.png", mimeType: "image/png", buffer: Buffer.from(pngB64, "base64"),
});
// レシート系はトリミングエディタを経由する
await page.waitForSelector("#crop-editor:not(.hidden)", { timeout: 5000 });
assert(true, "写真の後付け: レシート系はトリミングエディタが開く");
await page.waitForFunction(() => !document.getElementById("analyze-btn").disabled);
await page.click("#analyze-btn");
await page.waitForFunction(
  () => document.querySelector("#capture-message .banner.ok")?.textContent.includes("解析して反映"),
  { timeout: 10000 }
);
// 新規フォームを開き直さず、編集中の明細（タイトル・依頼内容）を保ったまま反映される
assert((await page.textContent("#form-title")) === "明細を編集", "写真の後付け: 編集中の明細のまま反映される");
assert((await page.inputValue("#f-note")) === "レシート後付けテスト", "写真の後付け: 依頼内容・用途は保持される");
assert((await page.inputValue("#f-vendor")) === "トリミング商店", "写真の後付け: 支払先が自動入力される");
assert((await page.inputValue("#f-amount")) === "2,500", `写真の後付け: 金額が自動入力される（実際: ${await page.inputValue("#f-amount")}）`);
await page.click("#save-btn");
await page.waitForSelector("#panel-list.active");
const lateReceipt = await page.evaluate(async () => {
  const rows = JSON.parse(localStorage.getItem("shiden_expense_receipts"));
  const r = rows.find((x) => x.note === "レシート後付けテスト");
  const blob = await getImage(r.id).catch(() => null);
  return { filename: r.filename, hasImage: !!blob, type: blob ? blob.type : "" };
});
assert(lateReceipt.filename.endsWith(".png") && lateReceipt.hasImage && lateReceipt.type === "image/png",
  `写真の後付け: 保存で証憑画像（PNG）が添付される（実際: ${lateReceipt.filename} / ${lateReceipt.type}）`);

await browser.close();
console.log(failures === 0 ? "\nALL CROP TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
