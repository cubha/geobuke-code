// 회귀 하네스: gate-spike의 cases.json을 production judge로 돌려 판정 품질을 확인한다.
// 트랜스포트는 judge가 자동 선택(ANTHROPIC_API_KEY 있으면 API, 없으면 claude -p).
// 사용: node dist/eval/regression.js [cases.json 경로]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { judge, selectedTransport } from "../judge.js";

interface Case {
  id: string;
  plan_spec: string;
  edit_diff: string;
  expected: "block" | "pass";
}

const here = dirname(fileURLToPath(import.meta.url));
const casesPath = process.argv[2] ?? join(here, "..", "..", "test", "cases.json");
const cases: Case[] = JSON.parse(readFileSync(casesPath, "utf8"));

console.log(`트랜스포트: ${selectedTransport()}  ·  케이스 ${cases.length}개  ·  파일 ${casesPath}\n`);

const results: Array<{ id: string; expected: string; got: string; ok: boolean; ms: number; reason: string }> = [];

for (const c of cases) {
  const t0 = Date.now();
  // 회귀는 defer 없는 기본 상태에서의 판정 품질을 본다.
  const v = await judge(c.plan_spec, c.edit_diff, []);
  const ms = Date.now() - t0;
  const ok = v.verdict === c.expected;
  results.push({ id: c.id, expected: c.expected, got: v.verdict, ok, ms, reason: v.reason });
  console.log(`${ok ? "✓" : "✗"} ${c.id}: exp=${c.expected} got=${v.verdict} (${ms}ms) — ${v.reason}`);
}

const tp = results.filter((r) => r.expected === "block" && r.got === "block").length;
const tn = results.filter((r) => r.expected === "pass" && r.got === "pass").length;
const fp = results.filter((r) => r.expected === "pass" && r.got === "block").length;
const fn = results.filter((r) => r.expected === "block" && r.got === "pass").length;
const avg = Math.round(results.reduce((s, r) => s + r.ms, 0) / results.length);
const pass = tp + tn;

console.log(`\n===== 결과 =====`);
console.log(`TP=${tp}(누락차단) TN=${tn}(정상통과) FP=${fp}(오탐) FN=${fn}(미탐)`);
console.log(`정확도 ${pass}/${results.length}  ·  평균지연 ${avg}ms`);

// 회귀 기준: 8/8 (스파이크 baseline). 미달 시 비정상 종료로 신호.
if (pass < results.length) {
  console.error(`\n⚠️ 회귀 실패: ${pass}/${results.length} (baseline 8/8 미달)`);
  process.exit(1);
}
console.log(`\n✅ 회귀 통과: baseline 유지`);
