// 0.10.1 SubTask4 — 사이드바 repos 커서추종 윈도잉 순수 코어. computeChatViewport(대화창, 하단
// 고정+오프셋 스크롤)와 계약이 달라 별도 함수다: 사이드바는 "커서를 항상 창 안에 보이게" 축이다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSidebarWindow } from "../dist/tui/format.js";

test("computeSidebarWindow: 전체가 maxVisible 이하 → 전량표시·above/below 0", () => {
  const w = computeSidebarWindow(6, 2, 9);
  assert.deepEqual(w, { start: 0, end: 6, aboveCount: 0, belowCount: 0 });
});

test("computeSidebarWindow: 커서가 창 안이면(스크롤 전) 창은 최상단 고정", () => {
  const w = computeSidebarWindow(12, 8, 9);
  assert.equal(w.start, 0);
  assert.equal(w.end, 9);
  assert.equal(w.aboveCount, 0);
});

test("computeSidebarWindow: 커서가 아래 경계를 넘으면 창이 따라 내려간다", () => {
  const w = computeSidebarWindow(12, 9, 9);
  assert.equal(w.start, 1);
  assert.equal(w.end, 10);
  assert.ok(w.start <= 9 && 9 < w.end, "커서가 창 안에 있어야 한다");
});

test("computeSidebarWindow: 마지막 항목 커서 → 창이 하단 끝에서 클램프", () => {
  const w = computeSidebarWindow(12, 11, 9);
  assert.equal(w.start, 3);
  assert.equal(w.end, 12);
  assert.equal(w.belowCount, 0);
});

test("computeSidebarWindow: 커서가 다시 위로 돌아가면 창도 따라 올라간다", () => {
  const w = computeSidebarWindow(12, 0, 9);
  assert.equal(w.start, 0);
  assert.equal(w.end, 9);
  assert.equal(w.aboveCount, 0);
  assert.equal(w.belowCount, 3);
});

test("computeSidebarWindow: 음수 커서는 0으로 클램프", () => {
  const w = computeSidebarWindow(12, -5, 9);
  assert.equal(w.start, 0);
  assert.equal(w.end, 9);
});

test("computeSidebarWindow: 과대 커서는 total-1로 클램프", () => {
  const w = computeSidebarWindow(12, 999, 9);
  assert.equal(w.start, 3);
  assert.equal(w.end, 12);
});

test("computeSidebarWindow: total=0 → 빈 창, 방어(에러 없이)", () => {
  const w = computeSidebarWindow(0, 0, 9);
  assert.deepEqual(w, { start: 0, end: 0, aboveCount: 0, belowCount: 0 });
});

test("computeSidebarWindow: maxVisible<=0 방어 — 빈 창, 크래시 없음", () => {
  const w = computeSidebarWindow(12, 3, 0);
  assert.equal(w.start, 0);
  assert.equal(w.end, 0);
  assert.equal(w.belowCount, 12);
});
