// 회귀 하네스: gate-spike의 cases.json을 production judge로 돌려 판정 품질을 확인한다.
// scope-cases.json이 있으면 judgeScope(축A/rung) 회귀도 함께 잰다(0.5.2 골든셋 보강).
// 트랜스포트는 judge가 자동 선택(ANTHROPIC_API_KEY 있으면 API, 없으면 claude -p).
// 사용: node dist/eval/regression.js [cases.json 경로]
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { judge, judgeScope, selectedTransport } from "../judge.js";
import type { ScopeQueueEntry } from "../types.js";

interface Case {
  id: string;
  plan_spec: string;
  edit_diff: string;
  expected: "block" | "pass";
  /** 0.9.3 ST3/ST5 — [현재 파일 상태] 골든 커버리지(fa-support 도그푸딩 오탐 케이스). 생략 시 미제공. */
  current_file?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const casesPath = process.argv[2] ?? join(here, "..", "..", "test", "cases.json");
const cases: Case[] = JSON.parse(readFileSync(casesPath, "utf8"));

console.log(`트랜스포트: ${selectedTransport()}  ·  케이스 ${cases.length}개  ·  파일 ${casesPath}\n`);

const results: Array<{ id: string; expected: string; got: string; ok: boolean; ms: number; reason: string }> = [];

for (const c of cases) {
  const t0 = Date.now();
  // 회귀는 defer 없는 기본 상태에서의 판정 품질을 본다.
  const v = await judge(c.plan_spec, c.edit_diff, [], [], { currentFileContent: c.current_file });
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

// 회귀 기준: 전건 통과(baseline은 스파이크 8/8에서 시작해 0.9.3 ST5에서 fa-support 4유형 3건 추가).
// 미달 시 비정상 종료로 신호.
if (pass < results.length) {
  console.error(`\n⚠️ 회귀 실패: ${pass}/${results.length} (baseline ${results.length}/${results.length} 미달)`);
  process.exit(1);
}
console.log(`\n✅ 회귀 통과: baseline 유지`);

// ===== scope(축A/rung) 회귀 — 0.5.2 골든셋 보강 =====
// 축A·rung2는 "탐색 없인 판정 불가"라 grepContext를 케이스에 정답라벨과 함께 담는다(스파이크
// 시나리오 정식 편입). expect는 허용값 배열(모델 분산 흡수 — 스파이크서 컨텍스트 조건 100%였던
// 판정만 단일값). H1(무컨텍스트 하드가드)은 파서 결정론이라 모델 응답 무관 통과해야 한다.
interface ScopeCase {
  id: string;
  plan_spec: string;
  edits: ScopeQueueEntry[];
  grepContext: string;
  filesWithContext: string[];
  expect: { axisA?: string[]; rung?: string[]; rungNot?: string[]; degraded?: boolean };
}

const scopePath = join(here, "..", "..", "test", "scope-cases.json");
if (existsSync(scopePath)) {
  const scopeCases: ScopeCase[] = JSON.parse(readFileSync(scopePath, "utf8"));
  console.log(`\n===== scope 회귀 (축A/rung) — ${scopeCases.length}케이스 =====`);
  let scopePass = 0;
  for (const c of scopeCases) {
    const t0 = Date.now();
    const entries = c.edits.map((e) => ({ ...e, specHash: "", at: "" }));
    // 측정 하네스는 Stop UX 예산과 무관 — CLI 트랜스포트(18~30s/호출)도 측정 가능하게 상향.
    const [v] = await judgeScope(entries, c.grepContext, new Set(c.filesWithContext), {
      planSpec: c.plan_spec,
      timeoutMs: 60000,
    });
    const ms = Date.now() - t0;
    const axisOk = !c.expect.axisA || c.expect.axisA.includes(v.axisA);
    const rungOk =
      (!c.expect.rung || c.expect.rung.includes(v.rung)) &&
      (!c.expect.rungNot || !c.expect.rungNot.includes(v.rung));
    const degradedOk = c.expect.degraded === undefined || v.degraded === c.expect.degraded;
    const ok = axisOk && rungOk && degradedOk;
    if (ok) scopePass++;
    console.log(
      `${ok ? "✓" : "✗"} ${c.id}: axisA=${v.axisA} rung=${v.rung} degraded=${v.degraded} (${ms}ms)` +
        (ok ? "" : `  — 기대 ${JSON.stringify(c.expect)}`),
    );
  }
  console.log(`\nscope 정확도 ${scopePass}/${scopeCases.length}`);
  if (scopePass < scopeCases.length) {
    console.error(`⚠️ scope 회귀 실패: ${scopePass}/${scopeCases.length}`);
    process.exit(1);
  }
  console.log(`✅ scope 회귀 통과`);
}
