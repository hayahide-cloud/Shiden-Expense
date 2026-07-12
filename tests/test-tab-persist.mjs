// 画面更新後もタブの表示位置が維持されることの検証
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

// 既定は取込タブ
assert(await page.locator("#panel-capture.active").count() === 1, "初期表示: 取込タブが既定");

// リロード後のタブ復元はDOMContentLoaded後の非同期処理のため、即時チェックではなく出現を待つ

// 設定タブに切り替えてリロード → 設定タブのまま
await page.click('nav button[data-panel="settings"]');
await page.waitForSelector("#panel-settings.active");
await page.reload();
await page.waitForSelector("#panel-settings.active", { timeout: 5000 });
assert(true, "リロード後も設定タブが維持される");
await page.waitForSelector('nav button[data-panel="settings"].active', { timeout: 5000 });
assert(true, "リロード後もナビの選択状態が設定タブになっている");

// 一覧タブに切り替えてリロード → 一覧タブのまま
await page.click('nav button[data-panel="list"]');
await page.waitForSelector("#panel-list.active");
await page.reload();
await page.waitForSelector("#panel-list.active", { timeout: 5000 });
assert(true, "リロード後も一覧タブが維持される");

// 取込タブに戻してリロード → 取込タブのまま
await page.click('nav button[data-panel="capture"]');
await page.waitForSelector("#panel-capture.active");
await page.reload();
await page.waitForSelector("#panel-capture.active", { timeout: 5000 });
assert(true, "取込タブに戻してリロードしても取込タブが維持される");

await browser.close();
console.log(failures === 0 ? "\nALL TAB PERSIST TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
