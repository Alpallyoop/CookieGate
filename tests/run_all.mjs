// Runs every CookieGate test suite against src/ and fails if any suite fails.
//   npm install   (once, for jsdom)
//   npm test
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITES = [
  "engine_parity_tests.mjs",
  "popup_headless_tests.mjs",
  "suppression/suppression_gate_regex_tests.mjs",
  "suppression/suppression_gate_unit_tests.mjs",
  "suppression/suppression_gate_tests.mjs",
  "v018_regression_tests.mjs",
];
let failed = 0;
for (const s of SUITES) {
  const r = spawnSync(process.execPath, [join(HERE, s)], { encoding: "utf8", timeout: 180000 });
  const out = (r.stdout || "") + (r.stderr || "");
  const summary = (out.trim().split("\n").filter((l) => /passed/.test(l)).pop() || "no summary").trim();
  const good = r.status === 0 && !/\bFAIL\b/.test(out);
  if (!good) failed++;
  console.log(`${good ? "OK  " : "FAIL"}  ${s.padEnd(46)} ${summary}`);
  if (!good) console.log(out.split("\n").filter((l) => /FAIL|Error/.test(l)).slice(0, 15).join("\n"));
}
console.log(failed ? `\n${failed} suite(s) failed` : "\nall suites passed");
process.exit(failed ? 1 : 0);
