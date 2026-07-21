// 0.10.x 대화창 박스 상주(최종시안 ff0eb0b1 장면01·02, 사용자 지시로 0.10.2 당김 2026-07-21) —
// 시각행 윈도잉 순수 코어 계약. braintrust 선결 ⓑ "시각 행 기준 윈도잉 = 단일 실패점": 논리줄이
// 아니라 표시폭(string-width) 기준으로 사전 랩해야 CJK 혼입 시 잔상이 재발하지 않는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import stringWidth from "string-width";
import {
  wrapSegmentLine,
  computeChatViewport,
  computeChatRegionRows,
  CHAT_SCROLLBACK_MAX_ENTRIES,
} from "../dist/tui/format.js";

// ── wrapSegmentLine ──

test("wrapSegmentLine: 폭 이내 한 줄은 그대로 1행", () => {
  const out = wrapSegmentLine([{ text: "hello", tone: "plain" }], 10);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], [{ text: "hello", tone: "plain" }]);
});

test("wrapSegmentLine: ASCII 하드랩 — 각 시각행 표시폭이 width를 절대 넘지 않는다", () => {
  const out = wrapSegmentLine([{ text: "a".repeat(25), tone: "plain" }], 10);
  assert.equal(out.length, 3);
  for (const line of out) {
    const w = line.reduce((acc, s) => acc + stringWidth(s.text), 0);
    assert.ok(w <= 10, `행 폭 ${w} > 10`);
  }
  assert.equal(out[0][0].text.length, 10);
  assert.equal(out[2][0].text.length, 5);
});

test("wrapSegmentLine: CJK(2폭) 경계 — 문자 중간에서 쪼개지 않고 폭 기준으로 넘긴다", () => {
  // '가'=2폭 → 폭 5엔 2자(4폭)까지만 들어가고 3번째는 다음 행
  const out = wrapSegmentLine([{ text: "가나다", tone: "plain" }], 5);
  assert.equal(out.length, 2);
  assert.equal(out[0][0].text, "가나");
  assert.equal(out[1][0].text, "다");
});

test("wrapSegmentLine: 세그먼트 경계를 가로질러도 톤이 보존된다", () => {
  const out = wrapSegmentLine(
    [
      { text: "aaaa", tone: "accent" },
      { text: "bbbb", tone: "dim" },
    ],
    6,
  );
  assert.equal(out.length, 2);
  // 1행: accent 4 + dim 2 / 2행: dim 2 — 각 조각의 톤이 원 세그먼트를 따른다
  assert.deepEqual(out[0], [
    { text: "aaaa", tone: "accent" },
    { text: "bb", tone: "dim" },
  ]);
  assert.deepEqual(out[1], [{ text: "bb", tone: "dim" }]);
});

test("wrapSegmentLine: 빈 입력 → 빈 시각행 1개(스크롤백의 공백 줄 보존)", () => {
  const out = wrapSegmentLine([{ text: "", tone: "plain" }], 10);
  assert.equal(out.length, 1);
});

test("wrapSegmentLine: width<=0 방어 — 무한루프 없이 원본 1행 반환", () => {
  const out = wrapSegmentLine([{ text: "abc", tone: "plain" }], 0);
  assert.equal(out.length, 1);
});

// ── computeChatViewport ──

test("computeChatViewport: offset=0 → 최신(마지막) viewRows개", () => {
  const v = computeChatViewport(100, 10, 0);
  assert.equal(v.start, 90);
  assert.equal(v.end, 100);
  assert.equal(v.aboveCount, 90);
  assert.equal(v.belowCount, 0);
});

test("computeChatViewport: 스크롤 offset만큼 위로 — below에 잘린 아래 줄 수", () => {
  const v = computeChatViewport(100, 10, 25);
  assert.equal(v.start, 65);
  assert.equal(v.end, 75);
  assert.equal(v.belowCount, 25);
});

test("computeChatViewport: offset 과대 → 최상단 클램프(음수 start 금지)", () => {
  const v = computeChatViewport(20, 10, 999);
  assert.equal(v.start, 0);
  assert.equal(v.end, 10);
  assert.equal(v.aboveCount, 0);
  assert.equal(v.belowCount, 10);
});

test("computeChatViewport: 전체가 viewport보다 적으면 전량 표시·스크롤 무효", () => {
  const v = computeChatViewport(5, 10, 3);
  assert.equal(v.start, 0);
  assert.equal(v.end, 5);
  assert.equal(v.aboveCount, 0);
  assert.equal(v.belowCount, 0);
});

// ── computeChatRegionRows ──

test("computeChatRegionRows: rows−밴드2−헤더−안전여유1", () => {
  // 44행·밴드1·헤더10(스플래시) → 44-2-10-1=31
  assert.equal(computeChatRegionRows(44, 1, 10), 31);
});

test("computeChatRegionRows: 저행 터미널 바닥 클램프(최소 8)", () => {
  assert.equal(computeChatRegionRows(10, 1, 10), 8);
});

// ── 버퍼 상한 상수 ──

test("CHAT_SCROLLBACK_MAX_ENTRIES: 양의 유한 상한(무한 증식 방지 계약)", () => {
  assert.ok(Number.isInteger(CHAT_SCROLLBACK_MAX_ENTRIES) && CHAT_SCROLLBACK_MAX_ENTRIES > 0);
});
