// 画像パイプライン（初期四隅検出・射影変換・コントラスト自動補正）のロジック検証
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

// --- ケース2: 初期四隅は画像の内容に関わらず、常に横15%・縦10%内側の固定位置 ---
const initQuad = await page.evaluate(() => initialCropQuad());
assert(
  initQuad[0].x === 0.15 && initQuad[0].y === 0.10 && initQuad[2].x === 0.85 && initQuad[2].y === 0.90,
  `初期四隅: 常に横15%・縦10%内側の固定位置（実際: ${initQuad[0].x},${initQuad[0].y}）`
);

// --- ケース3: 射影変換。傾いた四角形がまっすぐな長方形に補正される ---
const warpResult = await page.evaluate(() => {
  // 暗い背景に、傾いた明るい四角形（紙）を描く
  const width = 600, height = 600;
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgb(30,30,30)";
  ctx.fillRect(0, 0, width, height);
  // 傾いた四角形の4頂点（TL,TR,BR,BL）
  const quad = [
    { x: 150, y: 100 }, { x: 480, y: 160 },
    { x: 430, y: 520 }, { x: 100, y: 450 },
  ];
  ctx.fillStyle = "rgb(220,220,220)";
  ctx.beginPath();
  ctx.moveTo(quad[0].x, quad[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(quad[i].x, quad[i].y);
  ctx.closePath();
  ctx.fill();

  const out = warpQuadToRect(canvas, quad, 1800);
  const data = out.getContext("2d").getImageData(0, 0, out.width, out.height).data;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += data[i];
  return { w: out.width, h: out.height, avg: sum / (data.length / 4) };
});
assert(warpResult.w > 300 && warpResult.h > 300, `射影変換: 出力サイズが四角形の辺長に対応（実際: ${warpResult.w}x${warpResult.h}）`);
// 傾いた紙がまっすぐに補正されれば、出力はほぼ全面が紙（明るい）になる
assert(warpResult.avg > 200, `射影変換: 出力のほぼ全面が紙になる（平均輝度: ${warpResult.avg.toFixed(1)}）`);

// --- ケース4: 長方形の四隅なら単純な切り抜きと同じ結果になる ---
const identityResult = await page.evaluate(() => {
  const canvas = document.createElement("canvas");
  canvas.width = 400; canvas.height = 300;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgb(100,150,200)";
  ctx.fillRect(0, 0, 400, 300);
  const out = warpQuadToRect(canvas, [
    { x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 },
  ], 1800);
  return { w: out.width, h: out.height };
});
assert(identityResult.w === 400 && identityResult.h === 300, `射影変換: 全体指定なら元サイズのまま（実際: ${identityResult.w}x${identityResult.h}）`);

// --- ケース5: コントラスト自動補正で輝度レンジが引き伸ばされる ---
const contrastResult = await page.evaluate(() => {
  // 狭い輝度レンジ(120〜180)しか使っていない低コントラスト画像
  const canvas = document.createElement("canvas");
  canvas.width = 200; canvas.height = 200;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgb(180,180,180)";
  ctx.fillRect(0, 0, 200, 200);
  ctx.fillStyle = "rgb(120,120,120)";
  for (let i = 0; i < 20; i++) ctx.fillRect(10 + i * 9, 30, 4, 140);
  autoEnhanceContrast(canvas);
  const data = ctx.getImageData(0, 0, 200, 200).data;
  let min = 255, max = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] < min) min = data[i];
    if (data[i] > max) max = data[i];
  }
  return { min, max };
});
assert(contrastResult.max - contrastResult.min > 200, `コントラスト補正: 輝度レンジが拡張される（実際: ${contrastResult.min}〜${contrastResult.max}）`);

// --- ケース6: 影消去。照明勾配のある紙が均一な白に近づき、文字は黒いまま残る ---
const shadowResult = await page.evaluate(() => {
  // 左が明るく右が暗い（影がかかった）紙を再現。左右に黒い文字ブロックを置く
  const width = 800, height = 400;
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");
  const grad = ctx.createLinearGradient(0, 0, width, 0);
  grad.addColorStop(0, "rgb(240,240,238)");
  grad.addColorStop(1, "rgb(130,130,128)"); // 右側に強い影
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "rgb(30,30,30)";
  ctx.fillRect(80, 150, 120, 40);   // 左の文字ブロック
  ctx.fillRect(600, 150, 120, 40);  // 右（影の中）の文字ブロック

  removeShadow(canvas);
  const data = ctx.getImageData(0, 0, width, height).data;
  const lumAt = (x, y) => {
    const i = (y * width + x) * 4;
    return data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
  };
  return {
    paperLeft: lumAt(80, 60),
    paperRight: lumAt(700, 60),
    textLeft: lumAt(140, 170),
    textRight: lumAt(660, 170),
  };
});
assert(shadowResult.paperRight > 215, `影消去: 影の中の紙が白く持ち上がる（実際: ${shadowResult.paperRight.toFixed(0)}）`);
assert(Math.abs(shadowResult.paperLeft - shadowResult.paperRight) < 25, `影消去: 紙面の明るさが均一になる（左${shadowResult.paperLeft.toFixed(0)} / 右${shadowResult.paperRight.toFixed(0)}）`);
assert(shadowResult.textLeft < 110 && shadowResult.textRight < 110, `影消去: 文字は黒いまま残る（左${shadowResult.textLeft.toFixed(0)} / 右${shadowResult.textRight.toFixed(0)}）`);

await browser.close();
console.log(failures === 0 ? "\nALL ENHANCE TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
