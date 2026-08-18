// 회귀 케이스 **입력 형상 계약** 락 (F-1 후속, 2026-08-13).
//
// 같은 구멍에 두 번 빠졌다:
//   · 0.12.0 F-13 — 골든 replay가 currentFileContent를 안 실어 cases.json이 최대 182B, flip0가 거짓안심
//   · 0.12.3 F-1  — eval 케이스20의 applied_context가 **요약형**("…적용 완료")인데 프로덕션
//                   formatAppliedContext는 **원시 코드형**만 낸다. 같은 spec/edit·temp0·3표본에서
//                   요약형 pass 3/3 vs 프로덕션형 block 3/3 — 즉 21/21 green이 **프로덕션이 절대
//                   낼 수 없는 입력** 위에 서 있었다.
//
// 둘 다 순수함수 단위테스트는 촘촘히 통과했다. "함수가 옳게 계산하는가"와 "프롬프트에 실제로 어떤
// 문자열이 가는가"는 다른 축이고, 후자는 기존 테스트가 원리적으로 못 잡는다. 세 번째를 막는 것은
// 케이스 추가가 아니라 **케이스 생성 경로의 변경**이다 — cases.json은 조립된 문자열을 손으로 적지
// 않고 **프로덕션 hook이 받는 것과 같은 raw 편집 입력**만 선언하고, 조립은 프로덕션 함수
// (buildAppliedEntry→formatAppliedContext)가 한다. 이 파일은 그 규율을 기계로 강제한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildAppliedEntry, formatAppliedContext, selectAppliedForJudge, verifyAppliedEntry } from "../dist/applied.js";

// eval 하네스가 실제로 쓰는 조립 seam은 **동적** import로 연다 — 정적이면 모듈 부재가 이 파일
// 전체를 죽여 나머지 계약 락의 판정을 가린다(RED 사유가 뭉개진다).
const EVAL_APPLIED_ROOT = "/repo";

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, "cases.json"), "utf8"));

test("형상 계약: 조립된 applied_context 문자열을 케이스에 직접 적을 수 없다(F-1 우회로 차단)", () => {
  const offenders = cases.filter((c) => typeof c.applied_context === "string");
  assert.deepEqual(
    offenders.map((c) => c.id),
    [],
    "applied_context는 손으로 적는 필드가 아니다 — applied_edits(raw 편집 입력)를 선언하면 " +
      "프로덕션 formatAppliedContext가 조립한다. 문자열을 직접 적으면 프로덕션이 낼 수 없는 형상이 " +
      "회귀 스위트에 들어와 green이 거짓안심이 된다(F-1).",
  );
});

test("형상 계약: 적용이력 신호를 가진 케이스가 최소 1건 존재한다(P2a 무신호 방지)", () => {
  const withApplied = cases.filter((c) => Array.isArray(c.applied_edits) && c.applied_edits.length > 0);
  assert.ok(
    withApplied.length >= 1,
    "적용이력을 싣는 케이스가 하나도 없으면 eval은 P2a 판정 경로에 무신호다(F-13과 동일 결함).",
  );
});

test("형상 계약: applied_edits는 프로덕션 buildAppliedEntry가 실제로 엔트리를 만들어내는 입력이어야 한다", async () => {
  const { evalAbsPath } = await import("../dist/eval/applied-input.js");
  for (const c of cases) {
    for (const [i, e] of (c.applied_edits ?? []).entries()) {
      const entry = buildAppliedEntry(
        e.tool ?? "Edit",
        { file_path: evalAbsPath(e.file), new_string: e.new_string, content: e.content },
        EVAL_APPLIED_ROOT,
        "2026-01-01T00:00:00.000Z",
      );
      assert.ok(
        entry !== null,
        `${c.id} applied_edits[${i}]: 프로덕션이 기록하지 않을 입력이다(게이트 대상 도구 아님 / ` +
          `file_path 없음 / 새 내용이 빈 편집). 이런 입력은 원장에 절대 들어가지 않으므로 케이스로 성립하지 않는다.`,
      );
      assert.equal(entry.file, e.file, `${c.id} applied_edits[${i}]: 경로 정규화 결과가 선언과 어긋난다`);
    }
  }
});

test("형상 계약: eval이 judge에 싣는 문자열이 프로덕션 formatAppliedContext 출력과 바이트 동일하다(원장 재검증 포함, 0.12.4 ST4)", async () => {
  const mod = await import("../dist/eval/applied-input.js");
  assert.equal(mod.EVAL_APPLIED_ROOT, EVAL_APPLIED_ROOT, "eval 조립 루트가 계약과 다르다");
  for (const c of cases) {
    if (!Array.isArray(c.applied_edits) || c.applied_edits.length === 0) continue;
    const built = mod.buildEvalAppliedContext(c.applied_edits, c.applied_file_states);
    const entries = c.applied_edits.map((e, i) =>
      buildAppliedEntry(
        e.tool ?? "Edit",
        { file_path: mod.evalAbsPath(e.file), new_string: e.new_string, content: e.content },
        EVAL_APPLIED_ROOT,
        `2026-01-01T00:0${i}:00.000Z`,
      ),
    );
    // 0.12.4 ST3과 동일 재검증을 여기서 독립적으로 재현한다(mod.buildEvalAppliedContext 내부
    // 구현을 베끼는 게 아니라, 프로덕션 selectAppliedForJudge/verifyAppliedEntry를 직접 호출해
    // "그 함수들을 쓰면 이 문자열이 나온다"를 증명한다 — 내부 구현이 바뀌어도 계약은 유효하다).
    const verify = (e) => verifyAppliedEntry(e, c.applied_file_states?.[e.file] ?? null);
    const selected = selectAppliedForJudge(entries, { verify });
    const expectedText = formatAppliedContext(selected).text || undefined;
    assert.equal(
      built,
      expectedText,
      `${c.id}: eval이 judge에 싣는 문자열은 프로덕션 조립+재검증 함수의 출력 그 자체여야 한다`,
    );
    if (built === undefined) continue; // 전량 stale로 걸러진 케이스(예: 22번)는 섹션 자체가 생략된다
    // 프로덕션 계약 형상: "N. [파일] <코드>" · 마지막 엔트리에만 " (최신)"
    assert.match(built, /^1\. \[[^\]]+\] /, `${c.id}: 프로덕션 라인 형상(N. [파일] …)이 아니다`);
    assert.ok(built.includes(" (최신)"), `${c.id}: 최신 엔트리 표시가 없다`);
  }
});

test("형상 계약: P2a 인과격리쌍(적용이력 O=pass / X=block)이 eval에 존재한다", () => {
  const treat = cases.filter((c) => (c.applied_edits ?? []).length > 0 && c.expected === "pass");
  const ctrl = cases.filter((c) => (c.applied_edits ?? []).length === 0 && c.expected === "block");
  assert.ok(treat.length >= 1, "적용이력이 실린 pass 기대 케이스(처치군)가 없다");
  assert.ok(ctrl.length >= 1, "적용이력 없는 block 기대 케이스(대조군)가 없다");
});

// ── 0.12.4 ST4 — 원장 stale 대칭쌍(security-auditor Critical의 eval 커버리지) ──
// P2a 처치군(20번)이 "원장이 살아있으면 pass"를 증명한다면, 이 대칭쌍은 "원장이 stale이면 (원장이
// 아예 없는 것과 동일하게) 다시 block"을 증명한다. 판정 자체는 LLM 호출 없이도 구조로 증명되는
// 명제다(필터 후 케이스22 입력이 케이스21과 구조적으로 동일해진다) — 그래서 이 테스트는 eval(LLM
// 호출)이 아니라 여기서 결정론으로 먼저 잠근다. eval 쪽은 그 구조 동일성 위에서 모델이 실제로 옳게
// block하는지(회귀)만 잰다.
// ── 0.12.4 ST6 — evidence_context(P2b grep 근거) 형상계약 전환 ──
// current_file·old_strings는 조사 결과 이미 raw(프로덕션 readCurrentFile/tool_input 그대로)라
// 전환 불필요했다. evidence_context만 F-1과 정확히 같은 패턴이었다 — cases.json이
// `formatGrepContext→formatEvidenceContext`의 **조립 산출물**(`"케이스: <label>\n<file:line: text>"`)
// 을 손으로 적고 있었다. applied_edits와 동형으로: raw grep 매치만 선언하고 조립은 프로덕션
// 함수가 한다(src/eval/evidence-input.ts).

test("형상 계약: 조립된 evidence_context 문자열을 케이스에 직접 적을 수 없다(F-1 패턴 재적용)", () => {
  const offenders = cases.filter((c) => typeof c.evidence_context === "string");
  assert.deepEqual(
    offenders.map((c) => c.id),
    [],
    "evidence_context는 손으로 적는 필드가 아니다(폐기됨) — evidence_cases(raw grep 매치)를 " +
      "선언하면 프로덕션 formatGrepContext→formatEvidenceContext가 조립한다. applied_context와 " +
      "동일한 이유로 폐기: 손으로 쓰면 프로덕션이 낼 수 없는 형상이 회귀 스위트에 들어온다.",
  );
});

test("형상 계약: eval이 judge에 싣는 evidenceContext가 프로덕션 formatGrepContext→formatEvidenceContext 출력과 바이트 동일하다", async () => {
  const { formatGrepContext } = await import("../dist/scope.js");
  const { formatEvidenceContext } = await import("../dist/evidence.js");
  const mod = await import("../dist/eval/evidence-input.js");
  for (const c of cases) {
    if (!Array.isArray(c.evidence_cases) || c.evidence_cases.length === 0) continue;
    const built = mod.buildEvalEvidenceContext(c.evidence_cases);
    const evidence = c.evidence_cases
      .map((ec) => {
        const context = formatGrepContext(ec.matches ?? []);
        return { case: ec.case, context, matched: context !== "", budgetSkipped: false };
      })
      .filter((e) => e.matched);
    const expected = evidence.length === 0 ? undefined : formatEvidenceContext(evidence).text || undefined;
    assert.equal(
      built,
      expected,
      `${c.id}: eval이 judge에 싣는 evidenceContext는 프로덕션 조립 함수의 출력 그 자체여야 한다`,
    );
  }
});

test("형상 계약: 근거주입(P2b) 신호를 가진 케이스가 최소 1건 존재한다(무신호 방지)", () => {
  const withEvidence = cases.filter((c) => Array.isArray(c.evidence_cases) && c.evidence_cases.length > 0);
  assert.ok(withEvidence.length >= 1, "근거주입을 싣는 케이스가 하나도 없으면 eval은 P2b 판정 경로에 무신호다.");
});

test("형상 계약: old_strings는 current_file의 리터럴 substring이어야 한다(P3 앵커 윈도우 계약)", () => {
  // old_strings[i]가 current_file 밖 문자열이면 P3(0.12.1) 앵커 윈도우 병합이 위치를 못 찾아
  // head-only로 조용히 퇴화한다 — 케이스가 P3을 테스트한다고 믿지만 실제론 아무것도 안 잠근다.
  for (const c of cases) {
    if (!Array.isArray(c.old_strings) || typeof c.current_file !== "string") continue;
    for (const [i, s] of c.old_strings.entries()) {
      assert.ok(
        c.current_file.includes(s),
        `${c.id} old_strings[${i}]: current_file 안에 리터럴로 존재하지 않는다 — P3 앵커 매칭이 무신호가 된다`,
      );
    }
  }
});

test("형상 계약: 원장 stale 대칭쌍이 eval에 존재하고, 필터 후 입력이 무원장 대조군과 구조적으로 동일하다", async () => {
  const mod = await import("../dist/eval/applied-input.js");
  const staleCases = cases.filter((c) => (c.applied_edits ?? []).length > 0 && c.applied_file_states && c.expected === "block");
  assert.ok(staleCases.length >= 1, "원장이 있었지만 stale이라 block을 유지해야 하는 케이스가 없다(P2a 재검증 미커버)");
  for (const c of staleCases) {
    const built = mod.buildEvalAppliedContext(c.applied_edits, c.applied_file_states);
    assert.equal(
      built,
      undefined,
      `${c.id}: applied_file_states가 원장 코드와 전혀 겹치지 않으므로(stale 대칭쌍의 전제) ` +
        `필터 후 appliedContext는 undefined여야 한다 — 아니면 이 케이스가 실제로 stale을 테스트하지 않는다.`,
    );
  }
});
