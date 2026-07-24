// 0.10.6 A1/A2(TDD) — 저높이/저폭 터미널 반응형 강등 사다리. 사외 실기 스크린샷 보고(사이드바가
// 마스코트로 인해 늘어나 repos 패널이 잘림)의 근본원인은 강등 경로 부재였다(강등 대상 원본 진단:
// project_2026_07_24_full_refactoring.md). 이 계약은 computeHeaderRows/computeChatRegionRows
// 기존 산술을 재사용해 매직넘버 드리프트(PREVIEW_RESERVED_ROWS 전례) 없이 강등 여부를 판정한다.
//
// A1 초판은 sidebarContentRows를 보수적 상한(11)으로 내부 근사했으나, tmux 45행 실측(A2)에서 repo
// 6개(≤9, 흔한 경우)에도 마스코트가 불필요하게 숨겨지는 결함이 드러났다 — computeResponsiveLayout이
// sidebarContentRows를 호출부(app.tsx, computeSidebarListRows(repos.length))로부터 받도록 바꿔
// 정확한 개수를 반영한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeResponsiveLayout,
  computeSidebarListRows,
  SIDEBAR_MIN_COLUMNS,
  SIDEBAR_MASCOT_ROWS,
  SIDEBAR_CHROME_ROWS,
  SIDEBAR_MAX_VISIBLE_REPOS,
  SIDEBAR_HEADER_LABEL,
  SIDEBAR_HEADER_HINT,
  SIDEBAR_COLUMNS,
  MASCOT_S2,
  renderMascot,
  wrapSegmentLine,
} from "../dist/tui/format.js";

const WIDE = 200; // 폭 축은 문제 삼지 않는 케이스 기본값
const SIX_REPOS_ROWS = computeSidebarListRows(6); // 이 리포의 실제 등록 수(tmux 실측 케이스와 동일)

test("computeResponsiveLayout: 충분히 넓고 높으면 무강등(마스코트 표시·사이드바 표시·타이틀 그대로)", () => {
  const out = computeResponsiveLayout(60, WIDE, 1, 13, SIX_REPOS_ROWS, "full");
  assert.deepEqual(out, { effectiveTitleMode: "full", showMascot: true, showSidebar: true });
});

test("computeResponsiveLayout: 마스코트 포함 시 초과·제외 시 충분하면 1단(마스코트 숨김)만 발동", () => {
  const chrome = SIDEBAR_CHROME_ROWS + SIX_REPOS_ROWS;
  const needNoMascot = 13 + chrome;
  // computeChatRegionRows(rows,1,7) = rows-2-7 = rows-9 (full 헤더 7행 가정, 136열 이상)
  const rowsForNoMascotFit = needNoMascot + 9; // chatTotalRows == needNoMascot 되도록 역산
  const out = computeResponsiveLayout(rowsForNoMascotFit, WIDE, 1, 13, SIX_REPOS_ROWS, "full");
  assert.deepEqual(out, { effectiveTitleMode: "full", showMascot: false, showSidebar: true });
});

test("computeResponsiveLayout: 마스코트 숨겨도 부족하면 2단(타이틀 mini 강제)", () => {
  // 극저행 — mini(헤더1행)로도 간신히면서 여전히 mascot 없이도 빠듯한 케이스.
  const out = computeResponsiveLayout(12, WIDE, 1, 13, SIX_REPOS_ROWS, "full");
  assert.equal(out.effectiveTitleMode, "mini");
  assert.equal(out.showMascot, false);
  assert.equal(out.showSidebar, true);
});

test("computeResponsiveLayout: 사용자가 이미 mini를 선택했으면 mascot만 숨기고 mini 유지(강제 아님)", () => {
  const chrome = SIDEBAR_CHROME_ROWS + SIX_REPOS_ROWS;
  const needNoMascot = 13 + chrome;
  const rows = needNoMascot + 1; // mini 헤더=1행 → computeChatRegionRows(rows,1,1)=rows-2-1=rows-3
  const out = computeResponsiveLayout(rows, WIDE, 1, 13, SIX_REPOS_ROWS, "mini");
  assert.deepEqual(out, { effectiveTitleMode: "mini", showMascot: false, showSidebar: true });
});

test("computeResponsiveLayout: 저폭(<SIDEBAR_MIN_COLUMNS)이면 사이드바 자체를 숨긴다(ⓑ 신규 강등축)", () => {
  const out = computeResponsiveLayout(60, SIDEBAR_MIN_COLUMNS - 1, 1, 13, SIX_REPOS_ROWS, "full");
  assert.equal(out.showSidebar, false);
  assert.equal(out.showMascot, false);
});

test("computeResponsiveLayout: 저폭 강등은 사용자 titleMode를 건드리지 않는다", () => {
  const out = computeResponsiveLayout(60, SIDEBAR_MIN_COLUMNS - 1, 1, 13, SIX_REPOS_ROWS, "full");
  assert.equal(out.effectiveTitleMode, "full");
});

test("computeResponsiveLayout: 경계값(SIDEBAR_MIN_COLUMNS 정확히)은 사이드바를 유지한다", () => {
  const out = computeResponsiveLayout(60, SIDEBAR_MIN_COLUMNS, 1, 13, SIX_REPOS_ROWS, "full");
  assert.equal(out.showSidebar, true);
});

// tmux 45행 실측 회귀 — repo 6개(SIDEBAR_MAX_VISIBLE_REPOS=9 미만, 인디케이터 없음)로 실행했을 때
// 사이드바 안에 마스코트(8행)가 들어갈 여유 공간이 화면에 뻔히 보이는데도, sidebarContentRows를
// 보수적 상한(11)으로 근사하던 A1 초판은 마스코트를 불필요하게 숨겼다. 실제 개수(6)를 쓰면 무강등이
// 맞다는 것을 이 케이스로 고정한다.
test("computeResponsiveLayout: repo가 적으면(≤9) 보수적 상한이 아니라 실제 개수로 판정한다(tmux 45행 실측 회귀)", () => {
  const rows = 45;
  const cardRows = 13;
  const bandRows = 1; // rows>=30 → 프레임 활성
  const out = computeResponsiveLayout(rows, WIDE, bandRows, cardRows, SIX_REPOS_ROWS, "full");
  assert.deepEqual(out, { effectiveTitleMode: "full", showMascot: true, showSidebar: true });
});

test("computeSidebarListRows: 0개면 1행(빈 상태 안내)", () => {
  assert.equal(computeSidebarListRows(0), 1);
});

test("computeSidebarListRows: 상한 이하면 인디케이터 없이 그 개수 그대로", () => {
  assert.equal(computeSidebarListRows(6), 6);
  assert.equal(computeSidebarListRows(SIDEBAR_MAX_VISIBLE_REPOS), SIDEBAR_MAX_VISIBLE_REPOS);
});

test("computeSidebarListRows: 상한 초과면 상한+인디케이터 최대 2(커서 위치 무관 worst-case 고정)", () => {
  assert.equal(computeSidebarListRows(SIDEBAR_MAX_VISIBLE_REPOS + 1), SIDEBAR_MAX_VISIBLE_REPOS + 2);
  assert.equal(computeSidebarListRows(100), SIDEBAR_MAX_VISIBLE_REPOS + 2);
});

test("SIDEBAR_MASCOT_ROWS는 실제 renderMascot(MASCOT_S2) 출력 행수와 일치한다(드리프트 가드)", () => {
  assert.equal(SIDEBAR_MASCOT_ROWS, renderMascot(MASCOT_S2).length);
});

// tmux 80×24 실측(0.10.6 A2)에서 헤더 텍스트가 사이드바 내부폭(30열)을 넘겨 3행으로 줄바꿈되는데
// 최초 구현은 "헤더=1행"으로 가정해 사이드바 하단 테두리가 잘렸다 — 이제 wrapSegmentLine 실측으로
// 드리프트를 구조적으로 차단한다(테두리2+헤더 실측 행수, 헤더=1행 가정 아님).
test("SIDEBAR_CHROME_ROWS=테두리2+헤더 실측 줄바꿈 행수(하드코딩 1행 가정 아님, tmux 실측 회귀 방지)", () => {
  const headerRows = wrapSegmentLine(
    [{ text: `${SIDEBAR_HEADER_LABEL} ${SIDEBAR_HEADER_HINT}`, tone: "plain" }],
    SIDEBAR_COLUMNS - 4,
  ).length;
  assert.equal(SIDEBAR_CHROME_ROWS, 2 + headerRows);
  assert.ok(headerRows > 1, "헤더 텍스트가 30열 폭에서 실제로 줄바꿈되는지 확인(1행이면 이 가드가 무의미)");
});
