// scoring joinBySession 단정 (0.8.0 A2 ST1). extraction⨝events session_id 조인 — 진짜 M1 사후대조의
// 데이터 전제. 조인이 틀리면 위 채점 전부가 무의미하므로 이 순수 조인이 A2의 회귀락 1층이다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { joinBySession } from "../dist/scoring.js";

/** 최소 gate 이벤트 픽스처(hook발 — session 있음). */
function gateEv(over = {}) {
  return {
    at: over.at ?? "2026-07-08T10:00:00Z",
    session: over.session ?? "sess-A",
    specHash: over.specHash ?? "h1",
    kind: "gate",
    tool: over.tool ?? "Edit",
    decision: over.decision ?? "pass",
    ...over,
  };
}
/** CLI 이벤트 픽스처(session="" — CC 세션 모름). */
function cliEv(kind, over = {}) {
  return { at: over.at ?? "2026-07-08T10:01:00Z", session: "", specHash: over.specHash ?? "h1", kind, ...over };
}
/** extraction 레코드 픽스처. */
function rec(over = {}) {
  return {
    at: over.at ?? "2026-07-08T10:00:30Z",
    session: over.session ?? "sess-A",
    kind: over.kind ?? "tool_use",
    ...over,
  };
}

test("기본 조인: 같은 session의 gate 이벤트와 extraction 레코드가 한 SessionJoin으로 묶인다", () => {
  const joins = joinBySession(
    [gateEv({ session: "sess-A", decision: "block" }), gateEv({ session: "sess-A", at: "2026-07-08T10:02:00Z" })],
    [rec({ session: "sess-A", tool: "Write", file: "add.js" })],
  );
  assert.equal(joins.length, 1);
  assert.equal(joins[0].session, "sess-A");
  assert.equal(joins[0].events.length, 2);
  assert.equal(joins[0].records.length, 1);
  assert.equal(joins[0].records[0].file, "add.js");
});

test("scorable 태그: extraction 있는 세션만 true — B-모드(hook만) 세션은 false 정직 표기", () => {
  const joins = joinBySession(
    [gateEv({ session: "a-mode" }), gateEv({ session: "b-mode" })],
    [rec({ session: "a-mode" })],
  );
  const a = joins.find((j) => j.session === "a-mode");
  const b = joins.find((j) => j.session === "b-mode");
  assert.equal(a.scorable, true, "extraction 있는 세션 = 진짜 M1 채점 가능");
  assert.equal(b.scorable, false, "extraction 없는 세션 = B-모드, 채점 불가 정직 태그");
});

test("CLI 이벤트(session='')는 어떤 세션에도 귀속되지 않는다(조인키 부재)", () => {
  const joins = joinBySession(
    [gateEv({ session: "sess-A" }), cliEv("spec-add"), cliEv("gate-reset")],
    [],
  );
  assert.equal(joins.length, 1, "'' 세션은 SessionJoin으로 만들지 않음");
  assert.equal(joins[0].session, "sess-A");
  assert.equal(joins[0].events.length, 1, "CLI 이벤트는 세션에 미귀속");
});

test("extraction만 있는 세션(게이트 대상 도구 미사용)도 SessionJoin 생성 — events 빈 배열", () => {
  const joins = joinBySession([], [rec({ session: "read-only", kind: "assistant", text: "탐색만" })]);
  assert.equal(joins.length, 1);
  assert.equal(joins[0].session, "read-only");
  assert.deepEqual(joins[0].events, []);
  assert.equal(joins[0].scorable, true);
});

test("세션 내 events·records는 at 오름차순 정렬(시퀀스 분석 전제)", () => {
  const joins = joinBySession(
    [
      gateEv({ session: "s", at: "2026-07-08T10:05:00Z", decision: "pass" }),
      gateEv({ session: "s", at: "2026-07-08T10:01:00Z", decision: "block" }),
    ],
    [
      rec({ session: "s", at: "2026-07-08T10:04:00Z" }),
      rec({ session: "s", at: "2026-07-08T10:02:00Z" }),
    ],
  );
  assert.equal(joins[0].events[0].decision, "block", "이른 이벤트가 앞");
  assert.ok(joins[0].records[0].at < joins[0].records[1].at, "records도 at 정렬");
});

test("빈 입력 → 빈 배열(순수·무예외)", () => {
  assert.deepEqual(joinBySession([], []), []);
});

test("세션 간 순서 = 첫 관측 시각 오름차순(리포트 안정성 — scope-critic 권고 회귀락)", () => {
  const joins = joinBySession(
    [gateEv({ session: "late", at: "2026-07-08T12:00:00Z" }), gateEv({ session: "early", at: "2026-07-08T09:00:00Z" })],
    [rec({ session: "mid", at: "2026-07-08T10:30:00Z" })],
  );
  assert.deepEqual(
    joins.map((j) => j.session),
    ["early", "mid", "late"],
    "이벤트든 레코드든 첫 관측이 이른 세션이 앞",
  );
});

// ===== selectScoringCandidates (ST2 순수 후보선별) =====
import { selectScoringCandidates } from "../dist/scoring.js";

/** SessionJoin 픽스처 빌더 — joinBySession 산출 형상 그대로. */
function join(session, events, records, scorable = true) {
  return { session, events, records, scorable };
}

test("후보 선별: pass 앵커 직전 게이트된 편집 1건 + 앵커 이후 편집 포함, file 없는 tool_use 제외", () => {
  const j = join(
    "s",
    [gateEv({ session: "s", at: "2026-07-08T10:00:10Z", decision: "pass", specHash: "hX" })],
    [
      rec({ session: "s", at: "2026-07-08T10:00:08Z", tool: "Write", file: "add.js" }), // 게이트된 편집(앵커 2s 전)
      rec({ session: "s", at: "2026-07-08T10:00:20Z", tool: "Bash" }), // file 없음 → 제외
      rec({ session: "s", at: "2026-07-08T10:00:30Z", tool: "Edit", file: "add.js" }), // 앵커 이후
    ],
  );
  const cands = selectScoringCandidates([j]);
  assert.equal(cands.length, 1);
  assert.equal(cands[0].session, "s");
  assert.equal(cands[0].anchorAt, "2026-07-08T10:00:10Z");
  assert.equal(cands[0].specHash, "hX", "앵커 gate 이벤트의 specHash");
  assert.deepEqual(
    cands[0].edits.map((e) => e.at),
    ["2026-07-08T10:00:08Z", "2026-07-08T10:00:30Z"],
    "직전 게이트된 편집 + 앵커 이후 편집만",
  );
});

test("앵커 직전 편집이 여럿이면 가장 가까운 1건만(그 앞은 앵커 전 다른 작업)", () => {
  const j = join(
    "s",
    [gateEv({ session: "s", at: "2026-07-08T10:00:10Z", decision: "pass" })],
    [
      rec({ session: "s", at: "2026-07-08T09:59:00Z", tool: "Write", file: "old.js" }),
      rec({ session: "s", at: "2026-07-08T10:00:09Z", tool: "Write", file: "add.js" }),
    ],
  );
  const cands = selectScoringCandidates([j]);
  assert.equal(cands[0].edits.length, 1);
  assert.equal(cands[0].edits[0].file, "add.js", "가장 가까운 선행 편집만");
});

test("cached도 적용 판정으로 앵커가 된다(캐시 통과 = 게이트 허용)", () => {
  const j = join(
    "s",
    [gateEv({ session: "s", at: "2026-07-08T10:00:10Z", decision: "cached" })],
    [rec({ session: "s", at: "2026-07-08T10:00:09.9Z", tool: "Write", file: "x.js" })],
  );
  assert.equal(selectScoringCandidates([j]).length, 1);
});

test("다중 작업단위 세션: specHash 전환점마다 별도 후보 분리 — 2번째 단위 편집이 1번째 명세로 오채점되지 않음 (scope-critic 범위확대)", () => {
  const j = join(
    "s",
    [
      gateEv({ session: "s", at: "2026-07-08T10:00:10Z", decision: "pass", specHash: "h1" }),
      gateEv({ session: "s", at: "2026-07-08T10:05:10Z", decision: "pass", specHash: "h2" }), // done→spec-add 후 새 작업단위
    ],
    [
      rec({ session: "s", at: "2026-07-08T10:00:08Z", tool: "Write", file: "a.js" }), // h1의 게이트된 편집
      rec({ session: "s", at: "2026-07-08T10:01:00Z", tool: "Edit", file: "a.js" }), // h1 후속
      rec({ session: "s", at: "2026-07-08T10:05:08Z", tool: "Write", file: "b.js" }), // h2의 게이트된 편집
      rec({ session: "s", at: "2026-07-08T10:06:00Z", tool: "Edit", file: "b.js" }), // h2 후속
    ],
  );
  const cands = selectScoringCandidates([j]);
  assert.equal(cands.length, 2, "specHash 전환 = 작업단위 경계 = 후보 분리");
  assert.equal(cands[0].specHash, "h1");
  assert.deepEqual(cands[0].edits.map((e) => e.file), ["a.js", "a.js"], "h1 후보에 h2 편집 미혼입");
  assert.equal(cands[1].specHash, "h2");
  assert.deepEqual(cands[1].edits.map((e) => e.file), ["b.js", "b.js"], "h2의 게이트된 편집+후속만");
});

test("같은 specHash 연속 적용판정(pass→cached)은 한 작업단위 = 후보 1건", () => {
  const j = join(
    "s",
    [
      gateEv({ session: "s", at: "2026-07-08T10:00:10Z", decision: "pass", specHash: "h1" }),
      gateEv({ session: "s", at: "2026-07-08T10:02:10Z", decision: "cached", specHash: "h1" }),
    ],
    [
      rec({ session: "s", at: "2026-07-08T10:00:08Z", tool: "Write", file: "a.js" }),
      rec({ session: "s", at: "2026-07-08T10:02:08Z", tool: "Edit", file: "a.js" }),
    ],
  );
  const cands = selectScoringCandidates([j]);
  assert.equal(cands.length, 1, "동일 해시 연속 판정은 병합");
  assert.equal(cands[0].edits.length, 2);
});

test("적용 판정 없는 세션(block만)·scorable=false 세션·편집 0건 세션은 후보 제외", () => {
  const blockOnly = join(
    "b",
    [gateEv({ session: "b", decision: "block" })],
    [rec({ session: "b", tool: "Write", file: "y.js" })],
  );
  const notScorable = join("n", [gateEv({ session: "n", decision: "pass" })], [], false);
  const noEdits = join(
    "e",
    [gateEv({ session: "e", decision: "pass" })],
    [rec({ session: "e", kind: "assistant", text: "말만" })],
  );
  assert.deepEqual(selectScoringCandidates([blockOnly, notScorable, noEdits]), []);
});

// ===== classifyBlockOutcome (ST3 오탐율 행동신호) =====
import { classifyBlockOutcome } from "../dist/scoring.js";

test("resolved-spec: block→spec-add→(재block→spec-add)→같은 세션 pass = 게이트 정상작동, 오탐 아님 (s1 코퍼스 형상)", () => {
  const cls = classifyBlockOutcome([
    gateEv({ session: "s", at: "2026-07-08T10:00:00Z", decision: "block" }),
    cliEv("spec-add", { at: "2026-07-08T10:00:30Z" }),
    gateEv({ session: "s", at: "2026-07-08T10:01:00Z", decision: "block" }),
    cliEv("spec-clear", { at: "2026-07-08T10:01:20Z" }),
    cliEv("spec-add", { at: "2026-07-08T10:01:30Z" }),
    gateEv({ session: "s", at: "2026-07-08T10:02:00Z", decision: "pass" }),
  ]);
  assert.equal(cls.length, 2, "block마다 1건");
  assert.equal(cls[0].outcome, "resolved-spec");
  assert.equal(cls[1].outcome, "resolved-spec");
  assert.ok(cls.every((c) => c.fpCandidate === false));
});

test("self-corrected: spec 변화 없이 같은 세션 pass = 모호(정상도 오탐도 아님)", () => {
  const cls = classifyBlockOutcome([
    gateEv({ session: "s", at: "2026-07-08T10:00:00Z", decision: "block" }),
    gateEv({ session: "s", at: "2026-07-08T10:01:00Z", decision: "pass" }),
  ]);
  assert.equal(cls[0].outcome, "self-corrected");
  assert.equal(cls[0].fpCandidate, false, "모호는 오탐 후보로 세지 않음(과대집계 방지)");
});

test("overridden: 이후 적용 판정 없이 gate-reset = 오탐 후보", () => {
  const cls = classifyBlockOutcome([
    gateEv({ session: "s", at: "2026-07-08T10:00:00Z", decision: "block" }),
    cliEv("gate-reset", { at: "2026-07-08T10:00:30Z" }),
  ]);
  assert.equal(cls[0].outcome, "overridden");
  assert.equal(cls[0].fpCandidate, true);
});

test("overridden: 같은 세션 bypass도 게이트 무시 = 오탐 후보", () => {
  const cls = classifyBlockOutcome([
    gateEv({ session: "s", at: "2026-07-08T10:00:00Z", decision: "block" }),
    { at: "2026-07-08T10:00:30Z", session: "s", specHash: "h1", kind: "bypass", tool: "Edit" },
  ]);
  assert.equal(cls[0].outcome, "overridden");
});

test("abandoned: block 후 아무 후속 없음(재시도 포기) = 오탐 후보 (s2 코퍼스 형상)", () => {
  const cls = classifyBlockOutcome([gateEv({ session: "s", at: "2026-07-08T10:00:00Z", decision: "block" })]);
  assert.equal(cls[0].outcome, "abandoned");
  assert.equal(cls[0].fpCandidate, true);
});

test("세션 경계: 타 세션 pass는 이 세션 block을 해소하지 않는다", () => {
  const cls = classifyBlockOutcome([
    gateEv({ session: "a", at: "2026-07-08T10:00:00Z", decision: "block" }),
    gateEv({ session: "b", at: "2026-07-08T10:01:00Z", decision: "pass" }),
  ]);
  const a = cls.find((c) => c.session === "a");
  assert.equal(a.outcome, "abandoned", "타 세션 pass로 resolved 처리 금지");
});

test("ambiguous: 시간창에 타 세션 gate 혼입 시 정직 표기(CLI 이벤트 귀속 불확실 — scope-critic 방어 권고)", () => {
  const cls = classifyBlockOutcome([
    gateEv({ session: "a", at: "2026-07-08T10:00:00Z", decision: "block" }),
    gateEv({ session: "b", at: "2026-07-08T10:00:20Z", decision: "pass" }), // 타 세션 활동 혼입
    cliEv("spec-add", { at: "2026-07-08T10:00:30Z" }), // 어느 세션의 spec-add인지 불확실
    gateEv({ session: "a", at: "2026-07-08T10:01:00Z", decision: "pass" }),
  ]);
  const a = cls.find((c) => c.session === "a");
  assert.equal(a.ambiguous, true, "타 세션 gate 혼입 = CLI 귀속 불확실");
  const solo = classifyBlockOutcome([
    gateEv({ session: "a", at: "2026-07-08T10:00:00Z", decision: "block" }),
    cliEv("spec-add", { at: "2026-07-08T10:00:30Z" }),
    gateEv({ session: "a", at: "2026-07-08T10:01:00Z", decision: "pass" }),
  ]);
  assert.equal(solo[0].ambiguous, false, "단독 세션은 명확");
});

// 0.9.3 ST2 — block-repeat(동일 missing 셋 재발화 강등)의 사후 분류. self-corrected(수정으로 해소)와
// 절대 섞이면 안 된다 — 형제 케이스가 "여전히 미해소"라는 점에서 self-corrected와 정반대다.
// scope-critic 지적(2026-07-14): 미분기 시 self-corrected(fpCandidate=false)로 흡수돼 오탐 신호가
// 조용히 은폐된다(가장 심각한 형태의 오분류 — "고쳐졌다"는 거짓 신호).
test("repeated-unresolved: block 후 같은 세션 block-repeat = 미해소인 채 통과 — self-corrected와 구분, 오탐 후보로 유지", () => {
  const cls = classifyBlockOutcome([
    gateEv({ session: "s", at: "2026-07-08T10:00:00Z", decision: "block" }),
    gateEv({ session: "s", at: "2026-07-08T10:01:00Z", decision: "block-repeat" }),
  ]);
  assert.equal(cls[0].outcome, "repeated-unresolved");
  assert.notEqual(cls[0].outcome, "self-corrected", "미해소를 '수정으로 해소'로 오분류하면 안 됨");
  assert.equal(cls[0].fpCandidate, true, "abandoned·overridden과 동렬로 오탐 후보 유지(신호 은폐 금지)");
});

test("repeated-unresolved: block→block-repeat→(세션 끝, 후속 없음)도 동일 분류 — 세션이 재발화로 끝나도 미해소 신호 유실 안 됨", () => {
  const cls = classifyBlockOutcome([
    gateEv({ session: "s", at: "2026-07-08T10:00:00Z", decision: "block" }),
    gateEv({ session: "s", at: "2026-07-08T10:01:00Z", decision: "block-repeat" }),
  ]);
  assert.equal(cls.length, 1, "block-repeat 자체는 새 관측 창(anchor)을 열지 않는다");
  assert.equal(cls[0].outcome, "repeated-unresolved");
});

test("computeRealM1: repeatedUnresolved 카운트가 falsePositive 요약에 노출된다", () => {
  const m = computeRealM1([], [cls("repeated-unresolved"), cls("resolved-spec")], []);
  assert.equal(m.falsePositive.repeatedUnresolved, 1);
  assert.equal(m.falsePositive.fpCandidates, 1);
});

// 0.9.3 ST4(scope-critic 확대수정) — gate-ack(오탐 인정)이 SPEC_CHANGE_KINDS에 섞여 "정상작동
// (resolved-spec)"으로 은폐되던 것을 별도 outcome으로 분리. ack는 resolved-spec과 정반대 의미다.
test("acknowledged-fp: block 후 같은 CLI 시간창에 gate-ack = 오탐 인정 — resolved-spec과 구분, fpCandidate 유지", () => {
  const cls_ = classifyBlockOutcome([
    gateEv({ session: "s", at: "2026-07-08T10:00:00Z", decision: "block" }),
    cliEv("gate-ack", { at: "2026-07-08T10:00:30Z" }),
    gateEv({ session: "s", at: "2026-07-08T10:01:00Z", decision: "pass" }),
  ]);
  assert.equal(cls_[0].outcome, "acknowledged-fp");
  assert.notEqual(cls_[0].outcome, "resolved-spec", "오탐 인정을 '명세 보강으로 정상 해소'로 오분류하면 안 됨");
  assert.equal(cls_[0].fpCandidate, true, "ack는 오탐이 확정된 신호 — self-corrected처럼 숨기면 안 됨");
});

test("acknowledged-fp: spec-add와 gate-ack이 같은 창에서 함께 일어나도 ack가 우선(오탐 인정이 명세보강보다 확정적 신호)", () => {
  const cls_ = classifyBlockOutcome([
    gateEv({ session: "s", at: "2026-07-08T10:00:00Z", decision: "block" }),
    cliEv("spec-add", { at: "2026-07-08T10:00:20Z" }),
    cliEv("gate-ack", { at: "2026-07-08T10:00:30Z" }),
    gateEv({ session: "s", at: "2026-07-08T10:01:00Z", decision: "pass" }),
  ]);
  assert.equal(cls_[0].outcome, "acknowledged-fp");
});

test("computeRealM1: acknowledgedFp 카운트가 falsePositive 요약에 노출된다", () => {
  const m = computeRealM1([], [cls("acknowledged-fp"), cls("resolved-spec")], []);
  assert.equal(m.falsePositive.acknowledgedFp, 1);
  assert.equal(m.falsePositive.fpCandidates, 1);
});

test("failed-open: block 후 같은 세션 failopen = 판정실패 통과 — 오탐도 정상도 아닌 별도 분류 (scope-critic: 미분기 시 abandoned 오분류→오탐율 부풀림)", () => {
  const cls = classifyBlockOutcome([
    gateEv({ session: "s", at: "2026-07-08T10:00:00Z", decision: "block" }),
    cliEv("spec-add", { at: "2026-07-08T10:00:30Z" }), // spec 보강했어도 재판정이 실패했으면 resolved 아님
    gateEv({ session: "s", at: "2026-07-08T10:01:00Z", decision: "failopen" }),
  ]);
  assert.equal(cls[0].outcome, "failed-open");
  assert.equal(cls[0].fpCandidate, false, "판정불능은 오탐 후보로 세지 않음");
});

test("computeRealM1: failed-open은 오탐율 분모에서도 제외(판정불능 희석 방지 — unscored 제외 규율 미러)", () => {
  const m = computeRealM1([], [cls("abandoned"), cls("failed-open")], []);
  assert.equal(m.falsePositive.totalBlocks, 2);
  assert.equal(m.falsePositive.failedOpen, 1);
  assert.equal(m.falsePositive.fpCandidates, 1);
  assert.equal(m.falsePositive.rate, 1, "1/(2-1) — failed-open 제외 분모");
});

test("block 없는 이벤트만 → 빈 배열", () => {
  assert.deepEqual(classifyBlockOutcome([gateEv({ decision: "pass" }), cliEv("spec-add")]), []);
});

// ===== computeRealM1 (ST4 집계) =====
import { computeRealM1 } from "../dist/scoring.js";

function cls(outcome, over = {}) {
  return {
    session: over.session ?? "s",
    at: over.at ?? "2026-07-08T10:00:00Z",
    outcome,
    fpCandidate:
      outcome === "overridden" ||
      outcome === "abandoned" ||
      outcome === "repeated-unresolved" ||
      outcome === "acknowledged-fp",
    ambiguous: over.ambiguous ?? false,
  };
}
function score(verdict, over = {}) {
  return { session: over.session ?? "s", verdict, uncovered: over.uncovered ?? [], reason: over.reason };
}

test("오탐율 집계: 분모=총 block, 분자=오탐후보(overridden+abandoned), outcome별 breakdown", () => {
  const m = computeRealM1(
    [],
    [cls("resolved-spec"), cls("resolved-spec"), cls("abandoned"), cls("overridden", { ambiguous: true })],
    [],
  );
  assert.equal(m.falsePositive.totalBlocks, 4);
  assert.equal(m.falsePositive.fpCandidates, 2);
  assert.equal(m.falsePositive.rate, 0.5);
  assert.equal(m.falsePositive.resolvedSpec, 2);
  assert.equal(m.falsePositive.overridden, 1);
  assert.equal(m.falsePositive.abandoned, 1);
  assert.equal(m.falsePositive.selfCorrected, 0);
  assert.equal(m.falsePositive.ambiguous, 1);
});

test("위반율 집계: 분모=채점완료(violated+compliant)만 — unscored는 분모 제외(과소평가 방지)", () => {
  const m = computeRealM1([], [], [score("violated"), score("compliant"), score("unscored")]);
  assert.equal(m.violation.scored, 2);
  assert.equal(m.violation.violated, 1);
  assert.equal(m.violation.unscored, 1);
  assert.equal(m.violation.rate, 0.5, "1/2 — unscored 미포함");
});

test("0건 정직 바닥: 채점 0건·block 0건이면 rate=null(0% 뻥튀기 금지)", () => {
  const m = computeRealM1([], [], []);
  assert.equal(m.violation.rate, null);
  assert.equal(m.falsePositive.rate, null);
});

test("sessions 분모 투명성: 전체 세션 수와 scorable(A-mode) 수 병기", () => {
  const m = computeRealM1(
    [
      { session: "a", events: [], records: [{ at: "t", session: "a", kind: "tool_use" }], scorable: true },
      { session: "b", events: [], records: [], scorable: false },
    ],
    [],
    [],
  );
  assert.equal(m.sessions.total, 2);
  assert.equal(m.sessions.scorable, 1);
});

// ===== score 판정 순수부 (ST2 — buildScoreMessage/parseScoreVerdict) =====
import { buildScoreMessage, parseScoreVerdict, judgeM1Violation } from "../dist/judge.js";

test("buildScoreMessage: 명세와 편집 묶음이 본문에 포함된다", () => {
  const m = buildScoreMessage("케이스 A 로그인\n케이스 B 중복", "Write add.js: function add…");
  assert.match(m, /케이스 A 로그인/);
  assert.match(m, /Write add\.js/);
});

test("parseScoreVerdict: violated JSON → uncovered·reason 보존", () => {
  const v = parseScoreVerdict('{"verdict":"violated","uncovered":["케이스 B 중복"],"reason":"B 미커버"}');
  assert.equal(v.verdict, "violated");
  assert.deepEqual(v.uncovered, ["케이스 B 중복"]);
  assert.equal(v.reason, "B 미커버");
});

test("parseScoreVerdict: compliant JSON(펜스 낀 텍스트 속) → 추출 파싱", () => {
  const v = parseScoreVerdict('결과는 다음과 같습니다:\n```json\n{"verdict":"compliant","uncovered":[],"reason":"전부 커버"}\n```');
  assert.equal(v.verdict, "compliant");
});

test("parseScoreVerdict: 파싱불가·미지 verdict는 unscored(어떤 실패도 compliant로 안 떨어짐)", () => {
  assert.equal(parseScoreVerdict("완전 산문 응답").verdict, "unscored");
  assert.equal(parseScoreVerdict('{"verdict":"pass"}').verdict, "unscored", "미지 값도 unscored");
  assert.equal(parseScoreVerdict("").verdict, "unscored");
});

test("judgeM1Violation: mock invoke 라운드트립 + 호출 실패는 unscored(compliant 복사 금지)", async () => {
  const ok = await judgeM1Violation("케이스 A", "edits", {
    invoke: async () => '{"verdict":"violated","uncovered":["케이스 A"],"reason":"r"}',
  });
  assert.equal(ok.verdict, "violated");
  const fail = await judgeM1Violation("케이스 A", "edits", {
    invoke: async () => {
      throw new Error("타임아웃");
    },
  });
  assert.equal(fail.verdict, "unscored", "호출 실패 = 정직한 미채점");
  assert.match(fail.reason, /실패/);
});
