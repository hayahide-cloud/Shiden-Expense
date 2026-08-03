// GitHub同期（Hayahide-Logリポジトリへの保存・更新・削除・復元）の検証。
// api.github.comをインメモリの疑似リポジトリでモックし、実際のネットワークは使わない
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

// ===== 疑似リポジトリ（Contents API / Git Trees APIの必要最小限を実装） =====
const repoFiles = new Map(); // path -> { sha, base64 }
let shaCounter = 0;
let putCount = 0;
let apiDown = false; // trueの間は全リクエストを500で落とす（同期失敗→追いつきの検証用）

function handleGh(route) {
  const req = route.request();
  if (apiDown) return route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
  const u = new URL(req.url());
  const pathname = decodeURIComponent(u.pathname);
  const repoRoot = "/repos/hayahide-cloud/Hayahide-Log";
  const json = (status, body) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  if (pathname === repoRoot && req.method() === "GET") {
    return json(200, { default_branch: "main" });
  }
  if (pathname === `${repoRoot}/git/trees/main` && req.method() === "GET") {
    const tree = [...repoFiles.keys()].map((p) => ({ path: p, type: "blob" }));
    return json(200, { tree });
  }
  if (pathname.startsWith(`${repoRoot}/contents/`)) {
    const filePath = pathname.slice(`${repoRoot}/contents/`.length);
    const existing = repoFiles.get(filePath);
    if (req.method() === "GET") {
      if (!existing) return json(404, { message: "Not Found" });
      if ((req.headers()["accept"] || "").includes("raw")) {
        return route.fulfill({ status: 200, contentType: "application/octet-stream", body: Buffer.from(existing.base64, "base64") });
      }
      return json(200, { sha: existing.sha, content: existing.base64 });
    }
    if (req.method() === "PUT") {
      const body = JSON.parse(req.postData());
      // 実物と同じく、既存ファイルの上書きには正しいshaが必要
      if (existing && body.sha !== existing.sha) return json(422, { message: "sha mismatch" });
      if (!existing && body.sha) return json(422, { message: "sha provided for new file" });
      const sha = `sha_${++shaCounter}`;
      repoFiles.set(filePath, { sha, base64: body.content });
      putCount++;
      return json(existing ? 200 : 201, { content: { sha } });
    }
    if (req.method() === "DELETE") {
      const body = JSON.parse(req.postData());
      if (!existing) return json(404, { message: "Not Found" });
      if (body.sha !== existing.sha) return json(422, { message: "sha mismatch" });
      repoFiles.delete(filePath);
      return json(200, { content: null });
    }
  }
  return json(404, { message: `unhandled: ${req.method()} ${pathname}` });
}

// 疑似リポジトリの状態が条件を満たすまで待つ（自動同期は投げっぱなしで走るため）
async function waitFor(cond, name, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  console.error(`TIMEOUT: ${name}`);
  return false;
}

const decodeFile = (entry) => Buffer.from(entry.base64, "base64");

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
page.on("pageerror", (err) => { console.error("PAGE ERROR:", err.message); failures++; });
page.on("dialog", (d) => d.accept());
await page.route("https://api.github.com/**", handleGh);
// OCRは本テストの対象外なので固定レスポンスを返す
await page.route("https://api.openai.com/**", (route) => {
  route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        date: "2026-07-10", vendor: "タクシー会社", amount: 3400, category: "交通費", memo: "移動",
      }) } }],
    }),
  });
});

await page.goto(page_url);
await page.waitForLoadState("domcontentloaded");
await page.evaluate(() => {
  localStorage.setItem("shiden_expense_settings", JSON.stringify({
    apiKey: "sk-test", model: "gpt-5.4",
    ghToken: "github_pat_test", ghRepo: "hayahide-cloud/Hayahide-Log",
  }));
});

// --- ケース1: 手入力の保存でプレースホルダPNG（CSV埋め込み済み）が自動アップロードされる ---
await page.click("#manual-btn");
await page.fill("#f-vendor", "手入力商店");
await page.fill("#f-amount", "1200");
await page.selectOption("#f-category", "雑費");
await page.click("#save-btn");
assert(await waitFor(() => repoFiles.size === 1, "保存後にアップロードされる"), "手入力保存: リポジトリにファイルが1件できる");

const [manualPath] = [...repoFiles.keys()];
const month = new Date().toISOString().slice(0, 7);
assert(manualPath.startsWith(`shiden-expense/${month}/`) && manualPath.endsWith(".png"),
  `手入力保存: パスが shiden-expense/年-月/…png（実際: ${manualPath}）`);
const manualBytes = decodeFile(repoFiles.get(manualPath));
assert(manualBytes.includes("ShidenExpense"), "手入力保存: PNGに明細CSVチャンクが埋め込まれている");
assert(manualBytes.includes(Buffer.from("手入力商店", "utf8")), "手入力保存: 埋め込みCSVに支払先が含まれる");

// 設定タブの同期状態表示
await page.click('nav button[data-panel="settings"]');
await waitFor(async () => (await page.textContent("#gh-sync-status")).includes("同期済み"), "状態表示の更新");
assert((await page.textContent("#gh-sync-status")).includes("同期済み"), "設定タブ: 同期済みと表示される");

// --- ケース2: 写真付き保存も同期され、編集すると同じパスが上書きされる ---
await page.click('nav button[data-panel="capture"]');
await page.setInputFiles("#transit-photo-input", { name: "taxi.png", mimeType: "image/png", buffer: tinyPng });
await page.waitForSelector("#crop-editor:not(.hidden)");
await page.click("#analyze-btn");
await page.waitForSelector("#form-step:not(.hidden)", { timeout: 15000 });
await page.fill("#f-vendor", "タクシー会社");
await page.fill("#f-amount", "3400");
await page.fill("#f-date", "2026-07-10");
await page.click("#save-btn");
assert(await waitFor(() => repoFiles.size === 2, "2件目のアップロード"), "写真付き保存: リポジトリが2件になる");

const photoPath = [...repoFiles.keys()].find((p) => p !== manualPath);
const photoShaBefore = repoFiles.get(photoPath).sha;
assert(decodeFile(repoFiles.get(photoPath)).includes(Buffer.from("タクシー会社", "utf8")),
  "写真付き保存: 埋め込みCSVに支払先が含まれる");

// 編集して金額を変更 → 同じパスに再アップロード（ファイル数は増えない）
await page.click('nav button[data-panel="list"]');
await page.locator(".receipt-item", { hasText: "タクシー会社" }).click();
await page.waitForSelector("#form-step:not(.hidden)");
await page.fill("#f-amount", "3900");
await page.click("#save-btn");
assert(await waitFor(() => repoFiles.get(photoPath)?.sha !== photoShaBefore, "編集後の再アップロード"),
  "編集: 同じパスのファイルが更新される（shaが変わる）");
assert(repoFiles.size === 2, `編集: ファイル数は増えない（実際: ${repoFiles.size}件）`);
assert(decodeFile(repoFiles.get(photoPath)).includes(Buffer.from("3900", "utf8")),
  "編集: 埋め込みCSVが編集後の金額に更新されている");

// --- ケース3: 明細の個別削除はリポジトリ側も削除する ---
await page.locator(".receipt-item", { hasText: "手入力商店" }).click();
await page.waitForSelector("#form-step:not(.hidden)");
await page.click("#delete-btn");
assert(await waitFor(() => repoFiles.size === 1 && !repoFiles.has(manualPath), "削除の同期"),
  "個別削除: リポジトリ側のファイルも削除される");

// --- ケース4: API障害中の保存は「未同期」に積まれ、手動同期で追いつく ---
apiDown = true;
await page.click('nav button[data-panel="capture"]');
await page.click("#manual-btn");
await page.fill("#f-vendor", "障害中商店");
await page.fill("#f-amount", "500");
await page.selectOption("#f-category", "消耗品費");
await page.click("#save-btn");
await page.waitForSelector("#capture-step:not(.hidden)");
await page.click('nav button[data-panel="settings"]');
await waitFor(async () => (await page.textContent("#gh-sync-status")).includes("未同期"), "未同期表示");
assert((await page.textContent("#gh-sync-status")).includes("未同期: 1件"),
  `障害中: 未同期1件と表示される（実際: ${await page.textContent("#gh-sync-status")}）`);
apiDown = false;
await page.click("#gh-sync-btn");
assert(await waitFor(() => repoFiles.size === 2, "手動同期での追いつき"), "復旧後: 今すぐ同期で未同期分がアップロードされる");
await waitFor(async () => (await page.textContent("#gh-sync-status")).includes("同期済み"), "同期済み表示");

// --- ケース5: 端末データ消失（機種変更相当）→ リポジトリから全件復元できる ---
// 明細・画像・sha表を直接消して「新しい端末」を再現する（設定＝トークンだけは引き継ぐ想定）
const putsBeforeClear = putCount;
await page.evaluate(async () => {
  localStorage.removeItem("shiden_expense_receipts");
  localStorage.removeItem("shiden_expense_gh_sha");
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase("shiden_expense");
    req.onsuccess = req.onerror = req.onblocked = resolve;
  });
});
await page.reload();
await page.waitForLoadState("domcontentloaded");
await page.click('nav button[data-panel="settings"]');
await page.click("#gh-restore-btn"); // confirmは自動承諾
await page.waitForFunction(() => JSON.parse(localStorage.getItem("shiden_expense_receipts") || "[]").length === 2, null, { timeout: 15000 });
const restored = await page.evaluate(() => JSON.parse(localStorage.getItem("shiden_expense_receipts")));
assert(restored.length === 2, `復元: 2件戻る（実際: ${restored.length}件）`);
assert(restored.every((r) => r.gh_synced && r.gh_path), "復元: 復元行は同期済み扱いで元のパスを引き継ぐ");
const vendors = restored.map((r) => r.vendor).sort();
assert(JSON.stringify(vendors) === JSON.stringify(["タクシー会社", "障害中商店"]),
  `復元: 支払先が一致（実際: ${vendors.join(", ")}）`);

// 復元しただけでは再アップロードされない（二重登録の防止）
await new Promise((r) => setTimeout(r, 800));
assert(putCount === putsBeforeClear, "復元: 復元だけでは再アップロードが発生しない");

// 復元した行を編集すると、元のパスがそのまま上書きされる
const taxiPathBefore = [...repoFiles.keys()].sort().join("|");
await page.click('nav button[data-panel="list"]');
await page.locator(".receipt-item", { hasText: "タクシー会社" }).click();
await page.waitForSelector("#form-step:not(.hidden)");
await page.fill("#f-amount", "4100");
await page.click("#save-btn");
assert(await waitFor(() => {
  const p = [...repoFiles.values()].some((f) => decodeFile(f).includes(Buffer.from("4100", "utf8")));
  return p && repoFiles.size === 2;
}, "復元後の編集"), "復元後の編集: 元のパスが上書きされ、ファイル数は増えない");
assert([...repoFiles.keys()].sort().join("|") === taxiPathBefore, "復元後の編集: パス構成が変わらない");

// --- ケース6: 削除はミラー型 ---
// 個別削除は既にケース3で確認済み。全明細削除でもリポジトリ側が全て消えることを確認する
await page.click('nav button[data-panel="settings"]');
await page.click("#clear-btn"); // confirmは自動承諾
await page.waitForFunction(() => JSON.parse(localStorage.getItem("shiden_expense_receipts") || "[]").length === 0);
assert(await waitFor(() => repoFiles.size === 0, "全明細削除の同期"),
  "全明細削除: リポジトリ側の明細も全て削除される");

// 空のリポジトリから復元しても何も復活しない
await page.click("#gh-restore-btn");
await page.waitForFunction(() => document.getElementById("gh-restore-result").textContent.includes("復元"), null, { timeout: 15000 });
const afterEmptyRestore = await page.evaluate(() => JSON.parse(localStorage.getItem("shiden_expense_receipts") || "[]"));
assert(afterEmptyRestore.length === 0, "全明細削除後の復元: 削除済みの明細が復活しない");

await browser.close();
console.log(failures === 0 ? "\nALL GITHUB-SYNC TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
