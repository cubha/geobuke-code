// 0.10.0 A3b ST1 — src/tui/tabs.ts 순수 탭 레지스트리(reducer) 단정.
// 렌더-비의존: repoId로 키잉된 탭 상태만 추적한다. 기존 TuiState(model.ts)는 "현재 포커스된 탭의
// 라이브 뷰"를 그대로 표현하고 무변경 — tabs.ts는 그 위에 얹히는 별도 레지스트리(가산적 설계,
// R1 핵심 리팩터 우려를 낮은 리스크로 흡수: 기존 approval/streaming reducer를 건드리지 않는다).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTabRegistry,
  ensureTab,
  removeTab,
  setActiveTab,
  updateTabStatus,
  getActiveTab,
  isValidTransition,
} from "../dist/tui/tabs.js";

test("createTabRegistry: 초기 repo 하나로 시작, activeTabId=그 repo, status=no-session", () => {
  const r = createTabRegistry("/repo/a");
  assert.equal(r.activeTabId, "/repo/a");
  assert.deepEqual(Object.keys(r.tabs), ["/repo/a"]);
  assert.equal(r.tabs["/repo/a"].status, "no-session");
  assert.equal(r.tabs["/repo/a"].sessionId, null);
});

test("ensureTab: 없는 repoId면 no-session 탭 추가, activeTabId는 무변경", () => {
  let r = createTabRegistry("/repo/a");
  r = ensureTab(r, "/repo/b");
  assert.deepEqual(Object.keys(r.tabs).sort(), ["/repo/a", "/repo/b"]);
  assert.equal(r.activeTabId, "/repo/a", "ensureTab만으로는 포커스 이동 없음(opt-in Enter가 별도)");
  assert.equal(r.tabs["/repo/b"].status, "no-session");
});

test("ensureTab: 이미 있는 repoId면 no-op(기존 상태 보존)", () => {
  let r = createTabRegistry("/repo/a");
  r = updateTabStatus(r, "/repo/a", { status: "streaming", sessionId: "sess-1" });
  const before = r;
  r = ensureTab(r, "/repo/a");
  assert.equal(r, before, "동일 참조 반환 — 불필요한 리렌더 방지");
});

test("removeTab: 탭 제거, activeTabId가 제거 대상이면 남은 첫 탭으로 이동", () => {
  let r = createTabRegistry("/repo/a");
  r = ensureTab(r, "/repo/b");
  r = setActiveTab(r, "/repo/b");
  r = removeTab(r, "/repo/b");
  assert.deepEqual(Object.keys(r.tabs), ["/repo/a"]);
  assert.equal(r.activeTabId, "/repo/a", "포커스가 남은 탭으로 안전 이동");
});

test("removeTab: 마지막 탭은 제거되지 않는다(항상 최소 1탭 유지)", () => {
  let r = createTabRegistry("/repo/a");
  r = removeTab(r, "/repo/a");
  assert.deepEqual(Object.keys(r.tabs), ["/repo/a"], "유일 탭 제거 시도는 no-op");
});

test("setActiveTab: 존재하는 repoId로만 이동, 없는 repoId는 no-op", () => {
  let r = createTabRegistry("/repo/a");
  r = ensureTab(r, "/repo/b");
  r = setActiveTab(r, "/repo/b");
  assert.equal(r.activeTabId, "/repo/b");
  const before = r;
  r = setActiveTab(r, "/repo/nonexistent");
  assert.equal(r, before, "미등록 탭으로 전환 시도는 no-op(존재하지 않는 탭 크래시 방지)");
});

test("updateTabStatus: 지정 탭만 부분 갱신, 다른 탭은 완전히 무관(교차오염 없음의 핵심 단정)", () => {
  let r = createTabRegistry("/repo/a");
  r = ensureTab(r, "/repo/b");
  r = updateTabStatus(r, "/repo/a", { status: "streaming", sessionId: "sess-a" });
  assert.equal(r.tabs["/repo/a"].status, "streaming");
  assert.equal(r.tabs["/repo/a"].sessionId, "sess-a");
  assert.equal(r.tabs["/repo/b"].status, "no-session", "b는 a의 갱신에 절대 영향받지 않는다");
  assert.equal(r.tabs["/repo/b"].sessionId, null);
});

test("updateTabStatus: 존재하지 않는 repoId는 no-op(방어)", () => {
  const r0 = createTabRegistry("/repo/a");
  const r1 = updateTabStatus(r0, "/repo/nonexistent", { status: "dead" });
  assert.equal(r1, r0);
});

test("getActiveTab: activeTabId에 해당하는 TabState를 반환", () => {
  let r = createTabRegistry("/repo/a");
  r = updateTabStatus(r, "/repo/a", { status: "streaming", sessionId: "sess-1" });
  r = updateTabStatus(r, "/repo/a", { status: "awaiting-approval" });
  assert.equal(getActiveTab(r).status, "awaiting-approval");
  assert.equal(getActiveTab(r).repoId, "/repo/a");
});

// ===== 상태 전이 규칙 (scope-critic 지적, ST1 확장) =====
// updateTabStatus가 임의 status로의 부분갱신을 무조건 허용하면, dead 전이 후에도 sessionId가
// 남아 "죽었는데 세션ID는 살아있다"는 모호한 상태가 생긴다(lazy spawn 재진입 판단을 흐림).
// 여기서 두 가지를 강제한다: ① 정의된 전이표 밖의 전이는 no-op(방어) ② dead·no-session 전이는
// sessionId를 무조건 null로 원자 정리(호출측이 깜빡해도 격리가 깨지지 않도록).

test("isValidTransition: 상태 다이어그램 — no-session→streaming, streaming↔awaiting-approval, 아무거나→dead, dead→streaming 재진입", () => {
  assert.equal(isValidTransition("no-session", "streaming"), true);
  assert.equal(isValidTransition("no-session", "awaiting-approval"), false);
  assert.equal(isValidTransition("streaming", "awaiting-approval"), true);
  assert.equal(isValidTransition("awaiting-approval", "streaming"), true);
  assert.equal(isValidTransition("streaming", "dead"), true);
  assert.equal(isValidTransition("awaiting-approval", "dead"), true);
  assert.equal(isValidTransition("alive", "dead"), true);
  assert.equal(isValidTransition("dead", "streaming"), true, "respawn 재진입 허용");
  assert.equal(isValidTransition("dead", "awaiting-approval"), false, "죽은 탭이 곧장 승인대기로 갈 수는 없음");
});

test("updateTabStatus: 정의되지 않은 전이(no-session→awaiting-approval)는 no-op", () => {
  const r0 = createTabRegistry("/repo/a");
  const r1 = updateTabStatus(r0, "/repo/a", { status: "awaiting-approval" });
  assert.equal(r1, r0, "no-session에서 승인대기로 직행은 불가능한 전이 — 방어적으로 무시");
});

test("updateTabStatus: streaming→dead 전이 시 sessionId가 patch에 남아있어도 강제로 null 정리", () => {
  let r = createTabRegistry("/repo/a");
  r = updateTabStatus(r, "/repo/a", { status: "streaming", sessionId: "sess-1" });
  r = updateTabStatus(r, "/repo/a", { status: "dead", sessionId: "sess-1" });
  assert.equal(r.tabs["/repo/a"].status, "dead");
  assert.equal(r.tabs["/repo/a"].sessionId, null, "죽은 탭에 살아있는 sessionId가 남으면 안 됨(재진입 판단 오염)");
});

test("updateTabStatus: dead에서 streaming으로 재진입(respawn) 허용", () => {
  let r = createTabRegistry("/repo/a");
  r = updateTabStatus(r, "/repo/a", { status: "streaming", sessionId: "sess-1" });
  r = updateTabStatus(r, "/repo/a", { status: "dead" });
  r = updateTabStatus(r, "/repo/a", { status: "streaming", sessionId: "sess-2" });
  assert.equal(r.tabs["/repo/a"].status, "streaming");
  assert.equal(r.tabs["/repo/a"].sessionId, "sess-2");
});

test("updateTabStatus: status 없는 patch(lastActivityAt만 갱신)는 전이 검증 없이 그대로 병합", () => {
  let r = createTabRegistry("/repo/a");
  r = updateTabStatus(r, "/repo/a", { status: "streaming", sessionId: "sess-1" });
  r = updateTabStatus(r, "/repo/a", { lastActivityAt: 12345 });
  assert.equal(r.tabs["/repo/a"].lastActivityAt, 12345);
  assert.equal(r.tabs["/repo/a"].status, "streaming", "status 미지정 patch는 status 불변");
  assert.equal(r.tabs["/repo/a"].sessionId, "sess-1", "무관 필드 보존");
});

test("createTabRegistry/updateTabStatus는 입력을 변형하지 않는다(불변성 계약)", () => {
  const r0 = createTabRegistry("/repo/a");
  const frozen = JSON.stringify(r0);
  updateTabStatus(r0, "/repo/a", { status: "dead" });
  assert.equal(JSON.stringify(r0), frozen);
});
