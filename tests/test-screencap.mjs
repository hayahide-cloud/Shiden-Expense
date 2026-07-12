// 画面キャプチャ取込（PC限定）のE2E検証。
// getDisplayMediaをcanvas.captureStream()で差し替え、スクロールを模擬した
// 2フレームを「このページを追加」で取り込み、重なり連結→確認→解析まで通す
import { chromium } from "playwright";

let failures = 0;
function assert(cond, name) {
  if (cond) console.log(`PASS: ${name}`);
  else { console.error(`FAIL: ${name}`); failures++; }
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
// PC想定（デスクトップviewport・タッチなし）
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
page.on("pageerror", (err) => { console.error("PAGE ERROR:", err.message); failures++; });

let receivedImageCount = 0;
await page.route("https://api.openai.com/**", (route) => {
  const body = JSON.parse(route.request().postData());
  receivedImageCount = body.messages[0].content.filter((c) => c.type === "image_url").length;
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        date: "", from: "西日暮里", to: "広島", amount: 19560, line: "東海道新幹線",
        legs: ["西日暮里駅→東京駅", "東京駅→広島駅"],
      }) } }],
    }),
  });
});

// getDisplayMediaを差し替える（共有タブの代わりに、テストから描画できるキャンバスの映像を返す）
// あわせてCaptured Surface Control（共有タブの拡大・ホイール転送）も偽物に差し替える
await page.addInitScript(() => {
  window.__capSource = null;
  const ensure = () => {
    if (!window.__capSource) {
      const c = document.createElement("canvas");
      c.width = 800; c.height = 600;
      window.__capSource = c;
    }
    return window.__capSource;
  };
  window.addEventListener("DOMContentLoaded", ensure);
  window.__gdmOpts = null;
  navigator.mediaDevices.getDisplayMedia = async (opts) => {
    window.__gdmOpts = opts ?? null;
    return ensure().captureStream(15);
  };
  window.__forwardWheelEl = null;
  window.__focusBehavior = null;
  window.CaptureController = class extends EventTarget {
    constructor() { super(); this.zoomLevel = 100; }
    setFocusBehavior(v) { window.__focusBehavior = v; }
    getSupportedZoomLevels() { return [50, 75, 100, 110, 125, 150, 175, 200]; }
    async forwardWheel(el) { window.__forwardWheelEl = el; }
    async increaseZoomLevel() {
      const levels = this.getSupportedZoomLevels();
      const i = levels.indexOf(this.zoomLevel);
      this.zoomLevel = levels[Math.min(i + 1, levels.length - 1)];
      this.dispatchEvent(new Event("zoomlevelchange"));
    }
  };
});

await page.goto(new URL("../docs/index.html", import.meta.url).href);
await page.waitForLoadState("domcontentloaded");
await page.evaluate(() => {
  localStorage.setItem("shiden_expense_settings", JSON.stringify({ apiKey: "sk-test", model: "gpt-5.4" }));
});

// PC（ホバー可能）ではキャプチャボタンが表示される
const btnVisible = await page.isVisible("#screencap-btn");
assert(btnVisible, "画面キャプチャ: PCではボタンが表示される");

// 模擬コンテンツ: 縦1000pxの非周期コンテンツを、0-600 / 400-1000 の2画面でスクロール表示する
await page.evaluate(() => {
  const content = document.createElement("canvas");
  content.width = 800; content.height = 1000;
  const ctx = content.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 800, 1000);
  ctx.fillStyle = "#222";
  let seed = 3;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let y = 50;
  let n = 0;
  while (y < 980) {
    n++;
    ctx.font = `${18 + Math.floor(rand() * 12)}px sans-serif`;
    ctx.fillText(`経路詳細 ${n} — ${Math.floor(rand() * 9000)}円`, 20 + rand() * 80, y);
    ctx.fillRect(20 + rand() * 40, y + 10, 100 + rand() * 500, 1 + rand() * 3);
    y += 38 + rand() * 48;
  }
  window.__routeContent = content;
  window.__curY = null; // nullの間は黒画面（共有開始直後の状態を模擬）
  window.__scrollTo = (srcY) => {
    window.__curY = srcY;
  };
  // captureStreamはキャンバスへの描画が無いとフレームを流さないため、定期的に再描画する。
  // __curYがnullの間は黒画面を流す
  window.__redrawTimer = setInterval(() => {
    const ctx = window.__capSource.getContext("2d");
    if (window.__curY === null) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, 800, 600);
    } else {
      ctx.drawImage(window.__routeContent, 0, window.__curY, 800, 600, 0, 0, 800, 600);
    }
  }, 100);
});

await page.click("#screencap-btn");
await page.waitForSelector("#screencap-panel:not(.hidden)", { timeout: 5000 });
assert(true, "画面キャプチャ: 共有開始でキャプチャ画面が開く");
const fileBtnHiddenDuringCap = await page.evaluate(() => document.querySelector("#capture-step > .file-button").offsetParent === null);
assert(fileBtnHiddenDuringCap, "画面キャプチャ: 取込中は他の入口が隠れる");

// 共有開始直後の黒画面は取り込まれない（先頭に黒ページが入る事故の防止）
await page.waitForTimeout(1300);
const countWhileBlack = await page.evaluate(() => document.getElementById("screencap-count").textContent);
assert(countWhileBlack === "0", `画面キャプチャ: 黒画面は取り込まれない（実際: ${countWhileBlack}）`);
// 手動追加も黒画面中はエラーになる
await page.click("#screencap-add-btn");
await page.waitForSelector("#capture-message .banner.error", { timeout: 5000 });
assert(true, "画面キャプチャ: 黒画面の手動追加はエラー表示");
await page.evaluate(() => showMessage("", ""));

// コンテンツが映れば1ページ目が自動で入り、スクロール後に2ページ目も自動で入る
await page.evaluate(() => window.__scrollTo(0));
await page.waitForFunction(() => document.getElementById("screencap-count").textContent === "1", { timeout: 8000 });
assert(true, "画面キャプチャ: 1ページ目が自動で取り込まれる");

await page.evaluate(() => window.__scrollTo(400)); // 200px重なるようにスクロール
await page.waitForFunction(() => document.getElementById("screencap-count").textContent === "2", { timeout: 8000 });
assert(true, "画面キャプチャ: スクロール後に2ページ目が自動で取り込まれる");

// --- 共有タブの拡大（Captured Surface Control対応時のみボタン表示） ---
const zoomBtnVisible = await page.evaluate(() => document.getElementById("screencap-zoom-btn").offsetParent !== null);
assert(zoomBtnVisible, "拡大ボタン: 対応ブラウザでは表示される");
const manualHintHidden = await page.evaluate(() => document.getElementById("screencap-manual-zoom-hint").offsetParent === null);
assert(manualHintHidden, "拡大ボタン: 対応ブラウザでは手動ズームの案内は出ない");
const gdmHasController = await page.evaluate(() => !!(window.__gdmOpts && window.__gdmOpts.controller));
assert(gdmHasController, "拡大ボタン: getDisplayMediaにCaptureControllerが渡される");
const focusBehavior = await page.evaluate(() => window.__focusBehavior);
assert(focusBehavior === "no-focus-change", `フォーカス制御: 共有開始時にタブへ切り替わらない指定が入る（実際: ${focusBehavior}）`);
await page.click("#screencap-zoom-btn");
const zoomState = await page.evaluate(() => ({
  level: window.__gdmOpts.controller.zoomLevel,
  wheelToVideo: window.__forwardWheelEl === document.getElementById("screencap-video"),
  btnText: document.getElementById("screencap-zoom-btn").textContent,
}));
assert(zoomState.level === 150, `拡大ボタン: 150%まで段階的に拡大される（実際: ${zoomState.level}%）`);
assert(zoomState.wheelToVideo, "拡大ボタン: プレビューへのホイール転送が有効になる");
assert(zoomState.btnText.includes("150"), `拡大ボタン: 表示が現在の拡大率を示す（実際: ${zoomState.btnText}）`);
// 拡大前の2ページは縮尺が合わないため破棄され、今の画面が新しい1ページ目として入り直す
await page.waitForFunction(() => document.getElementById("screencap-count").textContent === "1", { timeout: 8000 });
assert(true, "拡大ボタン: 拡大すると取り込み直しになり、今の画面が1ページ目として入り直す");
// 拡大後もスクロールすれば取込が続く
await page.evaluate(() => window.__scrollTo(0));
await page.waitForFunction(() => document.getElementById("screencap-count").textContent === "2", { timeout: 8000 });
assert(true, "拡大ボタン: 拡大後もスクロールで取込が続く");

// 同じ画面のままでは追加されない（重複取込しない）
await page.waitForTimeout(1200);
const countStable = await page.evaluate(() => document.getElementById("screencap-count").textContent);
assert(countStable === "2", `画面キャプチャ: 画面が変わらなければ追加されない（実際: ${countStable}）`);
assert(true, "画面キャプチャ: 手動追加も使える");

// --- 解像度変化: 共有タブを表に出した瞬間の高解像度化を模擬 ---
// 低解像度時代のページは破棄され、変化後のフレームが即・新しい1ページ目になる
await page.evaluate(() => {
  window.__capSource.width = 1000;
  window.__capSource.height = 750;
  // 以降の再描画は1000x750で行われる（redrawTimerは__capSourceの寸法で描く）
  const ctx = window.__capSource.getContext("2d");
  window.__redrawTimer && clearInterval(window.__redrawTimer);
  window.__redrawTimer = setInterval(() => {
    if (window.__curY === null) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, 1000, 750);
    } else {
      ctx.drawImage(window.__routeContent, 0, window.__curY, 800, 600, 0, 0, 1000, 750);
    }
  }, 100);
});
// 2ページ→取り直しで1ページに戻り、変化直後の画面が新しい1ページ目になる
await page.waitForFunction(() => document.getElementById("screencap-count").textContent === "1", { timeout: 8000 });
assert(true, "画面キャプチャ: 解像度変化で取り直し、直後の画面が1ページ目として即取り込まれる");
// 新解像度でスクロールすれば2ページ目も入る（取り直し時点はスクロール400の画面）
await page.evaluate(() => window.__scrollTo(100));
await page.waitForFunction(() => document.getElementById("screencap-count").textContent === "2", { timeout: 8000 });
assert(true, "画面キャプチャ: 解像度変化後もスクロールで取込が続く");
// 元の寸法・状態に戻して以降のテストを続ける
await page.evaluate(() => {
  window.__capSource.width = 800;
  window.__capSource.height = 600;
  const ctx = window.__capSource.getContext("2d");
  window.__redrawTimer && clearInterval(window.__redrawTimer);
  window.__redrawTimer = setInterval(() => {
    if (window.__curY === null) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, 800, 600);
    } else {
      ctx.drawImage(window.__routeContent, 0, window.__curY, 800, 600, 0, 0, 800, 600);
    }
  }, 100);
  window.__scrollTo(0);
});
await page.waitForFunction(() => document.getElementById("screencap-count").textContent === "1", { timeout: 8000 });
await page.evaluate(() => window.__scrollTo(400));
await page.waitForFunction(() => document.getElementById("screencap-count").textContent === "2", { timeout: 8000 });
await page.click("#screencap-add-btn");
await page.waitForFunction(() => document.getElementById("screencap-count").textContent === "3", { timeout: 8000 });

// --- 最終画面の確実な取込: 自動取込の変化判定（閾値1）に満たない小さな変化を
//     コンテンツに加える。自動では取り込まれないが、「連結して確認へ」を押した
//     瞬間に今の画面が最後のページとして取り込まれる（最下部の欠け防止） ---
await page.evaluate(() => {
  // 24x24の黒点 ≒ 縮小グレースケールでの平均輝度差0.3程度（閾値1未満・0.05超）
  const ctx = window.__routeContent.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(700, 940, 24, 24);
});
await page.waitForTimeout(800);
const countBeforeDone = await page.evaluate(() => document.getElementById("screencap-count").textContent);
assert(countBeforeDone === "3", `最終画面取込: 小さな変化は自動では取り込まれない（実際: ${countBeforeDone}）`);

// 連結して確認ステップへ。重なり200pxが検出されれば高さは約1000pxになる。
// ボタンは押した直後に「結合中...」表示になる（クリックハンドラが同期的に書き換える）。
// 押した瞬間に今の画面（黒点入り）が4ページ目として同期的に取り込まれる
const doneClickState = await page.evaluate(() => {
  const btn = document.getElementById("screencap-done-btn");
  btn.click();
  return { btnText: btn.textContent, count: document.getElementById("screencap-count").textContent };
});
assert(doneClickState.btnText.includes("結合中"), `連結ボタン: 処理中は「結合中...」表示（実際: ${doneClickState.btnText}）`);
assert(doneClickState.count === "4", `最終画面取込: 連結時に今の画面が必ず取り込まれる（実際: ${doneClickState.count}ページ）`);
await page.waitForSelector("#transit-preview:not(.hidden)", { timeout: 10000 });
const capPanelClosed = await page.locator("#screencap-panel.hidden").count();
assert(capPanelClosed === 1, "画面キャプチャ: 連結後はキャプチャ画面が閉じる");
const dims = await page.evaluate(async () => {
  const bmp = await createImageBitmap(transitStitchedBlob);
  return { w: bmp.width, h: bmp.height };
});
assert(
  dims.w === 800 && Math.abs(dims.h - 1000) <= 8,
  `画面キャプチャ: 重なりが検出され約1000pxに連結される（実際: ${dims.w}x${dims.h}）`
);

// 解析まで通る
await page.click("#transit-analyze-btn");
await page.waitForSelector("#form-step:not(.hidden)", { timeout: 10000 });
assert((await page.inputValue("#f-category")) === "交通費", "画面キャプチャ: 解析して交通費フォームが開く");
// OCRには元の3ページではなく、重複除去済みの連結画像の分割（この寸法では1枚）が渡る
assert(receivedImageCount === 1, `画面キャプチャ: OCRには連結画像の分割が渡る（実際: ${receivedImageCount}枚）`);
await page.click("#cancel-btn");
await page.waitForSelector("#capture-step:not(.hidden)");

// キャンセルで何も残らない
await page.click("#screencap-btn");
await page.waitForSelector("#screencap-panel:not(.hidden)", { timeout: 5000 });
await page.click("#screencap-cancel-btn");
const panelHidden = await page.locator("#screencap-panel.hidden").count();
assert(panelHidden === 1, "画面キャプチャ: キャンセルで閉じて選択前に戻る");
const streamStopped = await page.evaluate(() => document.getElementById("screencap-video").srcObject === null);
assert(streamStopped, "画面キャプチャ: キャンセルで映像ストリームが解放される");

// --- 幅1920px超のキャプチャは取込時に1920px幅へ縮小される（メモリ対策。
//     連結出力の幅上限が1920pxのため最終品質は変わらない） ---
await page.evaluate(() => {
  window.__capSource.width = 2400;
  window.__capSource.height = 900;
  const ctx = window.__capSource.getContext("2d");
  window.__redrawTimer && clearInterval(window.__redrawTimer);
  window.__redrawTimer = setInterval(() => {
    ctx.drawImage(window.__routeContent, 0, window.__curY ?? 0, 800, 600, 0, 0, 2400, 900);
  }, 100);
});
await page.click("#screencap-btn");
await page.waitForSelector("#screencap-panel:not(.hidden)", { timeout: 5000 });
await page.waitForFunction(() => document.getElementById("screencap-count").textContent === "1", { timeout: 8000 });
await page.click("#screencap-done-btn");
await page.waitForSelector("#transit-preview:not(.hidden)", { timeout: 10000 });
const scaledDims = await page.evaluate(async () => {
  const bmp = await createImageBitmap(transitStitchedBlob);
  return { w: bmp.width, h: bmp.height };
});
assert(
  scaledDims.w === 1920 && scaledDims.h === 720,
  `画面キャプチャ: 1920px超のフレームは取込時に縮小される（実際: ${scaledDims.w}x${scaledDims.h}）`
);
await page.click("#transit-cancel-btn");
await page.waitForSelector("#capture-step:not(.hidden)");

// ページ未追加のまま「連結して確認へ」はエラーメッセージ
// （再描画を止めて黒画面にし、自動取込も連結時の最終画面取込も発生しない状態にする）
await page.evaluate(() => {
  clearInterval(window.__redrawTimer);
  const ctx = window.__capSource.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, window.__capSource.width, window.__capSource.height);
});
await page.click("#screencap-btn");
await page.waitForSelector("#screencap-panel:not(.hidden)", { timeout: 5000 });
await page.click("#screencap-done-btn");
await page.waitForSelector("#capture-message .banner.error", { timeout: 5000 });
assert(true, "画面キャプチャ: 0ページで連結しようとするとエラー表示");
await page.click("#screencap-cancel-btn");

await browser.close();
console.log(failures === 0 ? "\nALL SCREENCAP TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
