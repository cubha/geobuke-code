// 0.10.4 ST1 — src/tui/scrollback.ts 순수 per-repo 스크롤백 버퍼 단정.
// 결함1(repo 전환 시 대화 스크롤백 소실) 근본수정의 코어: 단일 배열 대신 repoId로 키잉된
// Record<repoId, ScrollEntry[]>로 전환해, 비활성 탭에 쌓이는 메시지도 유실 없이 보존한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendText, appendSegments, getBuffer } from "../dist/tui/scrollback.js";

test("getBuffer: 미존재 repo는 빈 배열(크래시 없음)", () => {
  const buffers = {};
  assert.deepEqual(getBuffer(buffers, "/repo/a"), []);
});

test("appendText: 새 repo에 첫 엔트리 추가", () => {
  const buffers = {};
  const next = appendText(buffers, "/repo/a", 1, "hello", "plain", 500);
  assert.deepEqual(getBuffer(next, "/repo/a"), [{ id: 1, kind: "text", text: "hello", tone: "plain" }]);
});

test("appendText: 비활성 repo(다른 repo가 활성이어도) 해당 repo 버퍼에 그대로 보존", () => {
  let buffers = {};
  buffers = appendText(buffers, "/repo/a", 1, "a1", "plain", 500);
  buffers = appendText(buffers, "/repo/b", 2, "b1", "plain", 500);
  buffers = appendText(buffers, "/repo/a", 3, "a2", "plain", 500);
  assert.deepEqual(getBuffer(buffers, "/repo/a").map((e) => e.text), ["a1", "a2"]);
  assert.deepEqual(getBuffer(buffers, "/repo/b").map((e) => e.text), ["b1"], "다른 repo append가 b를 건드리지 않는다");
});

test("appendSegments: segments variant 추가·조회", () => {
  const buffers = {};
  const segs = [{ text: "❯ ", tone: "accent" }, { text: "hi", tone: "plain" }];
  const next = appendSegments(buffers, "/repo/a", 1, segs, 500);
  assert.deepEqual(getBuffer(next, "/repo/a"), [{ id: 1, kind: "segments", segments: segs }]);
});

test("상한 트림: repo별 독립 — a가 상한을 넘겨 트림돼도 b는 무영향", () => {
  let buffers = {};
  for (let i = 0; i < 5; i++) buffers = appendText(buffers, "/repo/a", i, `a${i}`, "plain", 3);
  buffers = appendText(buffers, "/repo/b", 100, "b0", "plain", 3);
  const a = getBuffer(buffers, "/repo/a");
  assert.equal(a.length, 3, "상한 3을 넘지 않는다");
  assert.deepEqual(a.map((e) => e.text), ["a2", "a3", "a4"], "오래된 것부터 버리고 최신 3개만 남긴다");
  assert.deepEqual(getBuffer(buffers, "/repo/b").map((e) => e.text), ["b0"], "b는 트림 대상이 아니므로 무영향");
});

test("불변성: append가 원본 buffers 객체·배열을 변이하지 않는다", () => {
  const buffers = { "/repo/a": [{ id: 1, kind: "text", text: "a1", tone: "plain" }] };
  const before = JSON.parse(JSON.stringify(buffers));
  const next = appendText(buffers, "/repo/a", 2, "a2", "plain", 500);
  assert.deepEqual(buffers, before, "원본 buffers는 append 후에도 변하지 않는다");
  assert.notEqual(next, buffers, "새 객체를 반환한다");
  assert.equal(getBuffer(next, "/repo/a").length, 2);
});

test("appendText: maxEntries<=0이어도 크래시 없이 빈 배열로 수렴", () => {
  let buffers = {};
  buffers = appendText(buffers, "/repo/a", 1, "a1", "plain", 0);
  assert.deepEqual(getBuffer(buffers, "/repo/a"), []);
});
