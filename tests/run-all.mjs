// 全テストスイートを順に実行する（CI・ローカル共用）。1つでも失敗したら終了コード1
import { spawnSync } from "node:child_process";

const suites = [
  "test.mjs", "test-zip.mjs", "test-share.mjs", "test-enhance.mjs", "test-split.mjs",
  "test-tab-persist.mjs", "test-restore-form.mjs", "test-crop.mjs", "test-transit.mjs",
  "test-screencap.mjs", "test-pdf.mjs",
];

let failed = 0;
for (const suite of suites) {
  console.log(`\n===== ${suite} =====`);
  const r = spawnSync("node", [new URL(suite, import.meta.url).pathname], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}
console.log(failed === 0 ? "\nALL SUITES PASSED" : `\n${failed} SUITE(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
