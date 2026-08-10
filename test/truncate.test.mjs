// [현재 파일 상태] 절단 전략(0.12.1 P3) — head 고정분 + 편집앵커 주변 윈도우 병합, 줄 경계 정렬.
// RCA(project_gate_false_positive_rca): head-only 절단이 절단면 뒤쪽 정당 기구현 형제를 놓쳐
// 미탐을 유발하던 문제(0.12.0 F-2 근거주입 P2b와는 별개 축 — 이건 [현재 파일 상태] 자체의 개선).
import { test } from "node:test";
import assert from "node:assert/strict";
import { truncateCurrentFile, mergeRanges, HEAD_BUDGET, WINDOW_RADIUS } from "../dist/truncate.js";

/** 줄 i = "L" + i를 3자리 zero-pad(4자) — 줄 시작 오프셋 = i*5(줄4자+개행1자), 개행 위치 = i*5+4. */
function makeLines(n) {
  return Array.from({ length: n }, (_, i) => `L${String(i).padStart(3, "0")}`).join("\n");
}

test("truncateCurrentFile: 예산 이내면 절단 없이 원문 그대로", () => {
  const content = makeLines(5); // 24자
  const r = truncateCurrentFile(content, [], { totalBudget: 24, headBudget: 10, windowRadius: 3 });
  assert.equal(r.text, content);
  assert.equal(r.truncated, false);
});

test("truncateCurrentFile: 앵커 없으면 head 고정분만(줄 경계 정렬) — 기존 head-only 특성화와 동형", () => {
  const content = makeLines(50); // 249자
  const r = truncateCurrentFile(content, [], { totalBudget: 50, headBudget: 22, windowRadius: 3 });
  assert.equal(r.truncated, true);
  // headBudget=22는 줄 경계가 아님(줄 폭 5의 배수가 아님) → 뒤로 당겨져 20(줄4개분)에서 정렬됨
  assert.equal(r.text, "L000\nL001\nL002\nL003\n\n…(절단됨)");
  assert.doesNotMatch(r.text, /L004/, "정렬된 head 경계 밖 줄은 포함되지 않는다");
});

test("truncateCurrentFile: 앵커 주변 윈도우가 절단면 뒤쪽에서도 포함되고 줄 경계에 정렬된다", () => {
  const content = makeLines(50); // 249자
  const r = truncateCurrentFile(content, ["L030"], { totalBudget: 60, headBudget: 22, windowRadius: 3 });
  assert.match(r.text, /L030/, "윈도우가 앵커 라인을 포함해야 함");
  assert.doesNotMatch(r.text, /L029/, "윈도우가 줄 경계 밖(반경 밖) 이웃 줄까지 삼키면 안 됨");
  assert.match(r.text, /…\(중간 생략\)/, "head와 윈도우 사이 간격은 중간 생략 마커로 표시");
  assert.equal(r.text.endsWith("\n…(절단됨)"), true, "윈도우 뒤로도 파일이 남아있으면 절단 마커 유지");
});

test("truncateCurrentFile: head 범위 안의 앵커는 별도 윈도우를 만들지 않는다(중복 방지)", () => {
  const content = makeLines(50);
  const withAnchor = truncateCurrentFile(content, ["L002"], { totalBudget: 50, headBudget: 22, windowRadius: 3 });
  const withoutAnchor = truncateCurrentFile(content, [], { totalBudget: 50, headBudget: 22, windowRadius: 3 });
  assert.equal(withAnchor.text, withoutAnchor.text, "head 내부 앵커는 head-only 결과와 동일해야 함");
  assert.doesNotMatch(withAnchor.text, /…\(중간 생략\)/, "head와 겹치는 윈도우는 별도 구간을 만들지 않음");
});

test("truncateCurrentFile: 서로 가까운 두 앵커의 윈도우는 하나로 병합된다(중간 생략 마커 없음)", () => {
  const content = makeLines(50);
  // L030(150)·L032(160) — 반경 5로 겹치는 윈도우
  const r = truncateCurrentFile(content, ["L030", "L032"], { totalBudget: 80, headBudget: 22, windowRadius: 5 });
  assert.match(r.text, /L030/);
  assert.match(r.text, /L031/, "병합된 구간이면 사이 줄도 자연히 포함됨");
  assert.match(r.text, /L032/);
  const middleOmitCount = (r.text.match(/…\(중간 생략\)/g) ?? []).length;
  assert.equal(middleOmitCount, 1, "head↔윈도우 사이 1건만 — 두 윈도우끼리는 병합되어 추가 생략 마커가 없어야 함");
});

test("truncateCurrentFile: 예산 초과 시 문서 뒤쪽 윈도우부터(남는 예산 부족) 드롭된다", () => {
  const content = makeLines(80); // 399자
  // 서로 멀리 떨어진 두 앵커, 둘 다 넣으면(윈도우 각 15자) 남는 예산(20자)을 초과 — 문서상 앞선 것만 남아야 함
  const r = truncateCurrentFile(content, ["L020", "L070"], { totalBudget: 40, headBudget: 20, windowRadius: 8 });
  assert.match(r.text, /L020/, "예산이 허용하는 앞쪽 윈도우는 포함");
  assert.doesNotMatch(r.text, /L070/, "예산 초과분(뒤쪽 윈도우)은 드롭");
});

test("truncateCurrentFile: 존재하지 않는 앵커는 무시된다(윈도우 미생성, 에러 없음)", () => {
  const content = makeLines(50);
  const r = truncateCurrentFile(content, ["NO_SUCH_ANCHOR_XYZ"], { totalBudget: 50, headBudget: 22, windowRadius: 3 });
  const withoutAnchor = truncateCurrentFile(content, [], { totalBudget: 50, headBudget: 22, windowRadius: 3 });
  assert.equal(r.text, withoutAnchor.text);
});

test("mergeRanges: 겹치거나 맞닿은 구간을 하나로 합친다", () => {
  const merged = mergeRanges([{ start: 10, end: 20 }, { start: 15, end: 25 }, { start: 25, end: 30 }, { start: 100, end: 110 }]);
  assert.deepEqual(merged, [{ start: 10, end: 30 }, { start: 100, end: 110 }]);
});

test("mergeRanges: 순서가 섞여 들어와도 정렬 후 병합", () => {
  const merged = mergeRanges([{ start: 50, end: 60 }, { start: 0, end: 5 }]);
  assert.deepEqual(merged, [{ start: 0, end: 5 }, { start: 50, end: 60 }]);
});

test("mergeRanges: 빈 배열", () => {
  assert.deepEqual(mergeRanges([]), []);
});

test("truncateCurrentFile: headBudget 안에 개행이 전혀 없어도(단일행 minified 파일) head가 소실되지 않는다(scope-critic 지적)", () => {
  const content = "x".repeat(30) + "\n" + "y".repeat(30); // 첫 30자 구간엔 개행 없음
  const r = truncateCurrentFile(content, [], { totalBudget: 20, headBudget: 10, windowRadius: 3 });
  assert.equal(r.truncated, true);
  assert.ok(r.text.length > 0, "head가 완전히 비어버리면 안 됨");
  assert.match(r.text, /^x{10}/, "줄 경계 정렬이 불가능하면 원래 상한(headBudget) 그대로 사용");
});

test("HEAD_BUDGET/WINDOW_RADIUS: MAX_CURRENT_FILE(8000) 예산 안에서 head+최소 1개 윈도우가 항상 성립하는 크기", async () => {
  const { MAX_CURRENT_FILE } = await import("../dist/judge.js");
  assert.ok(HEAD_BUDGET < MAX_CURRENT_FILE, "head가 전체 예산을 다 먹으면 윈도우가 설 자리가 없다");
  assert.ok(HEAD_BUDGET + WINDOW_RADIUS * 2 <= MAX_CURRENT_FILE, "head+윈도우 1개 최대폭이 전체 예산 이내");
});
