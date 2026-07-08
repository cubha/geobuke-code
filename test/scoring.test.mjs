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
