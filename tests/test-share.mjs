// 「申請」ボタン(Web共有API連携)の検証。
// navigator.share/canShareは実ブラウザのUIダイアログを伴うため、page.evaluateで
// モックに差し替えて呼び出し引数を検証する。
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
await context.grantPermissions(["clipboard-read", "clipboard-write"]);
const page = await context.newPage();
page.on("pageerror", (err) => { console.error("PAGE ERROR:", err.message); failures++; });

await page.goto(new URL("../docs/index.html", import.meta.url).href);
await page.waitForLoadState("domcontentloaded");

// テスト1: 証憑画像あり＋備考ありの明細で、ファイル共有APIに正しい引数が渡るか
const shareWithFile = await page.evaluate(async () => {
  const calls = [];
  navigator.share = async (data) => { calls.push(data); };
  navigator.canShare = () => true;

  // IndexedDBにダミー画像を用意
  const fakeBlob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" });
  await putImage("share01", fakeBlob);

  const receipt = {
    id: "share01", date: "2026-06-22", vendor: "大衆酒場ビートル 蒲田東口店",
    amount: 31120, category: "会議費", memo: "飲食代", note: "蒲田情報交換会",
    filename: "20260622_大衆酒場ビートル_31120円_re01.jpg",
  };
  await shareReceipt(receipt);

  const call = calls[0];
  return {
    called: calls.length === 1,
    title: call?.title,
    text: call?.text,
    fileName: call?.files?.[0]?.name,
    fileType: call?.files?.[0]?.type,
    fileSize: call?.files?.[0]?.size,
  };
});

assert(shareWithFile.called, "共有: navigator.shareが1回呼ばれる");
assert(shareWithFile.title === "経費申請: 蒲田情報交換会（2026-06-22）", `共有: 件名に備考が使われる（実際: ${shareWithFile.title}）`);
assert(shareWithFile.text.includes("支払先: 大衆酒場ビートル 蒲田東口店"), "共有: 本文に支払先を含む");
assert(shareWithFile.text.includes("金額: ¥31,120"), "共有: 本文の金額がカンマ区切り");
assert(shareWithFile.text.includes("備考: 蒲田情報交換会"), "共有: 本文に備考を含む");
assert(shareWithFile.fileName === "20260622_大衆酒場ビートル_31120円_re01.jpg", `共有: 画像ファイル名が一致（実際: ${shareWithFile.fileName}）`);
assert(shareWithFile.fileType === "image/jpeg", "共有: 画像MIMEタイプがjpeg");
assert(shareWithFile.fileSize === 4, "共有: 画像サイズが一致");

// 共有と同時に本文がクリップボードにもコピーされている（共有先アプリが本文を
// 正しく展開しない場合の保険）。トーストで結果も通知される
const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
assert(clipboardText.includes("支払先: 大衆酒場ビートル 蒲田東口店"), "共有: 本文がクリップボードにもコピーされる");
const toastText = await page.textContent("#toast");
assert(toastText.includes("共有しました"), `共有: トーストで結果を通知（実際: ${toastText}）`);

// テスト2: 備考なし・証憑画像なし(手入力)の明細では、件名に支払先が使われファイルは渡らない
const shareNoImage = await page.evaluate(async () => {
  const calls = [];
  navigator.share = async (data) => { calls.push(data); };
  navigator.canShare = () => true;

  const receipt = {
    id: "share02", date: "2026-06-20", vendor: "文房具店", amount: 500,
    category: "消耗品費", memo: "ノート", note: "", filename: "(手入力)",
  };
  await shareReceipt(receipt);
  const call = calls[0];
  return { called: calls.length === 1, title: call?.title, hasFiles: !!call?.files };
});
assert(shareNoImage.called, "共有(画像なし): navigator.shareが呼ばれる");
assert(shareNoImage.title === "経費申請: 文房具店（2026-06-20）", `共有(画像なし): 件名に支払先が使われる（実際: ${shareNoImage.title}）`);
assert(!shareNoImage.hasFiles, "共有(画像なし): filesが渡らない");

// テスト3: ユーザーが共有シートをキャンセル(AbortError)しても例外が外に漏れない
const abortResult = await page.evaluate(async () => {
  navigator.share = async () => { const e = new Error("cancelled"); e.name = "AbortError"; throw e; };
  navigator.canShare = () => false;
  try {
    await shareReceipt({ id: "share03", date: "", vendor: "テスト", amount: 0, category: "", memo: "", note: "", filename: "(手入力)" });
    return { threw: false };
  } catch (err) {
    return { threw: true, message: err.message };
  }
});
assert(!abortResult.threw, "共有: キャンセル(AbortError)時に例外が外へ漏れない");

await browser.close();
console.log(failures === 0 ? "\nALL SHARE TESTS PASSED" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
