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
    fpCandidate: outcome === "overridden" || outcome === "abandoned",
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
