// 회귀 하네스: gate-spike의 cases.json을 production judge로 돌려 판정 품질을 확인한다.
// scope-cases.json이 있으면 judgeScope(축A/rung) 회귀도 함께 잰다(0.5.2 골든셋 보강).
// 트랜스포트는 judge가 자동 선택(ANTHROPIC_API_KEY 있으면 API, 없으면 claude -p).
// 사용: node dist/eval/regression.js [cases.json 경로]
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { judge, judgeScope, selectedTransport } from "../judge.js";
import { buildEvalAppliedContext } from "./applied-input.js";
import type { EvalAppliedEdit } from "./applied-input.js";
import { buildEvalEvidenceContext } from "./evidence-input.js";
import type { EvalEvidenceCase } from "./evidence-input.js";
import type { ScopeQueueEntry } from "../types.js";

interface Case {
  id: string;
  plan_spec: string;
  edit_diff: string;
  expected: "block" | "pass";
  /** 0.9.3 ST3/ST5 — [현재 파일 상태] 골든 커버리지(fa-support 도그푸딩 오탐 케이스). 생략 시 미제공. */
  current_file?: string;
  /**
   * 2026-08-07 RCA 후속 — true면 이 케이스의 결과는 baseline 하드게이트(pass<results.length→exit1)
   * 분모에서 제외되고 별도 known-fail로 보고만 된다. 8000바이트 절단 결함(P3)·grep 근거주입(P2b)
   * 착수 전/도중에는 실패가 "회귀"가 아니라 "아직 안 고친 알려진 결함"이라 릴리스를 막으면 안 되기
   * 때문 — 단 결과는 항상 로그에 찍혀 언제 해소됐는지(GREEN 전환) 관측 가능하다.
   */
  expectedFailing?: boolean;
  /**
   * 0.12.0 F-13 — P2b 근거주입 2단계 판정을 eval에서 재현하기 위한 필드.
   *
   * ⚠️ **조립된 문자열이 아니라 raw grep 매치를 선언한다**(0.12.4 ST6, F-1 패턴 재적용). 처음엔
   * 조립 결과를 손으로 적는 `evidence_context: string`이었는데, applied_context와 정확히 같은
   * 구멍이었다 — evidence-input.ts가 프로덕션 함수(formatGrepContext→formatEvidenceContext)로
   * 조립하므로 형상 불일치가 구조적으로 불가능하다. test/eval-cases.test.mjs가 이 규율을 락한다.
   */
  evidence_cases?: EvalEvidenceCase[];
  /**
   * 0.12.1 P3 — 편집의 raw old_string(들). 있으면 judge의 editOldStrings로 그대로 실어 head+윈도우
   * 절단을 eval에서 재현한다. 이 필드 없이는 eval도 head-only 절단만 재현해 이 배치의 판정 로직
   * 변경(P3)에 무신호다. gate-core.ts의 evaluateGate와 동일 계약 — 위치 매칭은 current_file 원문
   * 안에서 정확히 일치하는 substring이어야 한다(clip된 edit_diff가 아니라 raw 텍스트).
   */
  old_strings?: string[];
  /**
   * 0.12.3 P2a — [이 작업단위에서 이미 적용된 편집] 섹션을 eval에서 재현하기 위한 필드.
   *
   * ⚠️ **조립된 문자열이 아니라 raw 편집 입력**을 선언한다(F-1, 2026-08-13). 처음엔 조립 결과를
   * 손으로 적는 `applied_context: string`이었는데, 사람이 쓴 요약형("…적용 완료")과 프로덕션
   * formatAppliedContext가 내는 원시 코드형이 달라 **eval이 프로덕션이 낼 수 없는 입력을 재고
   * 있었다**(실측: 요약형 pass 3/3 vs 프로덕션형 block 3/3 — 21/21 green이 거짓안심). 이제
   * applied-input.ts가 프로덕션 함수(buildAppliedEntry→formatAppliedContext)로 조립하므로
   * 형상 불일치가 구조적으로 불가능하다. test/eval-cases.test.mjs가 이 규율을 락한다.
   */
  applied_edits?: EvalAppliedEdit[];
  /**
   * 0.12.4 ST4 — 원장 생존 재검증(security-auditor Critical)을 eval에서 재현하기 위한 필드.
   * key=`applied_edits[].file`과 같은 상대경로, value=그 파일의 **현재 디스크 상태**(생존 판정용).
   * 선언 안 하면 그 파일은 재검증 시 unverifiable(읽기 실패 취급) — alive로 함부로 가정하지 않는다.
   * 이 필드 없이는 eval도 골든 replay가 한 번 겪은 무신호(F-13)를 이 배치의 유일한 판정 로직
   * 변경(원장 재검증) 축에서 재현한다.
   */
  applied_file_states?: Record<string, string>;
}

const here = dirname(fileURLToPath(import.meta.url));
const casesPath = process.argv[2] ?? join(here, "..", "..", "test", "cases.json");
const cases: Case[] = JSON.parse(readFileSync(casesPath, "utf8"));

/**
 * 전체 실행 상한(0.12.0 F-7). `verify.sh --eval`은 `VERIFY_TIMEOUT_EVAL`(900s) 가드를 두지만
 * **실제 발행 게이트는 `package.json`의 `prepublishOnly`**(build && test && eval)이고 그쪽엔 아무
 * 가드가 없었다 — 키 없는 CLI 폴백에서 케이스당 최대 30s라 응답이 안 오면 `npm publish`가 무한정
 * 매달린다. 셸 `timeout` 명령에 의존하면 macOS·Windows에서 깨지므로 하네스 자신이 상한을 쥔다.
 * `unref()` — 이 타이머가 이벤트 루프를 살려두어 정상 종료를 막지 않게 한다(판정이 다 끝나면
 * 대기 중인 다른 작업이 없어 프로세스가 즉시 끝나야 한다).
 */
const EVAL_TIMEOUT_MS = Number(process.env.GBC_EVAL_TIMEOUT_MS ?? 900_000);

console.log(`트랜스포트: ${selectedTransport()}  ·  케이스 ${cases.length}개  ·  파일 ${casesPath}\n`);

const results: Array<{ id: string; expected: string; got: string; ok: boolean; ms: number; reason: string; expectedFailing: boolean }> = [];

// 타임아웃 감시는 results 선언 **뒤**에 둔다 — 발화 시 누적 결과를 요약해 출력해야 하기 때문
// (scope-critic 지적, 2026-08-09: 그냥 죽으면 어디까지 통과했는지 알 수 없어 원인 추적이 막힌다).
// `unref()`로 이벤트 루프는 붙잡지 않으므로 정상 완주 시엔 아무 영향이 없고, 아래 scope 회귀
// 구간까지 같은 상한이 덮인다(둘 다 이 타이머보다 뒤에서 await된다).
const evalDeadline = setTimeout(() => {
  const done = results.length;
  const ok = results.filter((r) => r.ok).length;
  console.error(
    `\n⚠️ eval 전체 타임아웃(${EVAL_TIMEOUT_MS}ms) 초과 — 중단합니다.\n` +
      `   진행: ${done}/${cases.length}케이스 완료(통과 ${ok}) · 미완 ${cases.length - done}건\n` +
      `   ${done > 0 ? `마지막 완료: ${results[done - 1].id}` : "첫 케이스도 완료되지 않음"}\n` +
      `   트랜스포트=${selectedTransport()} · 키 없는 CLI 폴백은 케이스당 최대 30s라 느립니다.\n` +
      `   상한 조정: GBC_EVAL_TIMEOUT_MS=<ms>`,
  );
  process.exit(1);
}, EVAL_TIMEOUT_MS);
evalDeadline.unref();

for (const c of cases) {
  const t0 = Date.now();
  // 회귀는 defer 없는 기본 상태에서의 판정 품질을 본다.
  const v = await judge(c.plan_spec, c.edit_diff, [], [], {
    currentFileContent: c.current_file,
    evidenceContext: buildEvalEvidenceContext(c.evidence_cases),
    editOldStrings: c.old_strings,
    // 조립은 프로덕션 함수가 한다(F-1) — 케이스가 문자열을 손으로 적지 않는다.
    appliedContext: buildEvalAppliedContext(c.applied_edits, c.applied_file_states),
  });
  const ms = Date.now() - t0;
  const ok = v.verdict === c.expected;
  results.push({ id: c.id, expected: c.expected, got: v.verdict, ok, ms, reason: v.reason, expectedFailing: !!c.expectedFailing });
  const mark = c.expectedFailing ? (ok ? "✓(해소됨!)" : "⚠known-fail") : ok ? "✓" : "✗";
  console.log(`${mark} ${c.id}: exp=${c.expected} got=${v.verdict} (${ms}ms) — ${v.reason}`);
}

// known-fail(expectedFailing) 케이스는 하드게이트 분모에서 제외 — P2b/P3 착수 전 알려진 결함이
// 릴리스를 막지 않게 하되, 결과는 항상 로그·별도 요약에 남겨 해소 시점을 관측 가능하게 한다.
const hard = results.filter((r) => !r.expectedFailing);
const knownFail = results.filter((r) => r.expectedFailing);

const tp = hard.filter((r) => r.expected === "block" && r.got === "block").length;
const tn = hard.filter((r) => r.expected === "pass" && r.got === "pass").length;
const fp = hard.filter((r) => r.expected === "pass" && r.got === "block").length;
const fn = hard.filter((r) => r.expected === "block" && r.got === "pass").length;
const avg = Math.round(results.reduce((s, r) => s + r.ms, 0) / results.length);
const pass = tp + tn;

console.log(`\n===== 결과 =====`);
console.log(`TP=${tp}(누락차단) TN=${tn}(정상통과) FP=${fp}(오탐) FN=${fn}(미탐)`);
console.log(`정확도 ${pass}/${hard.length}  ·  평균지연 ${avg}ms`);
if (knownFail.length > 0) {
  console.log(
    `\nknown-fail(비차단, P2b/P3 대상) ${knownFail.length}건: ` +
      knownFail.map((r) => `${r.ok ? "✓해소" : "✗예상대로실패"} ${r.id}`).join(", "),
  );
}

// 회귀 기준: 전건 통과(baseline은 스파이크 8/8에서 시작해 0.9.3 ST5에서 fa-support 4유형 3건 추가).
// knownFail은 분모에서 제외(2026-08-07 RCA — 위 hard 필터 참조). 미달 시 비정상 종료로 신호.
if (pass < hard.length) {
  console.error(`\n⚠️ 회귀 실패: ${pass}/${hard.length} (baseline ${hard.length}/${hard.length} 미달)`);
  process.exit(1);
}
console.log(`\n✅ 회귀 통과: baseline 유지(hard ${hard.length}건)`);

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
