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
  computeInputLayout,
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

// 0.11.0 계약 교체(명세 변경): 정적 고정 레이아웃에서 대화 박스는 하단 밴드에 정확히 붙는다 —
// 기존 "안전여유 1행"은 measureElement 추종 시절 오차 흡수용이었고, 정적 산술에선 오차 자체가
// 없어 1행을 낭비하지 않는다. rows−밴드2−헤더 그대로.
test("computeChatRegionRows: rows−밴드2−헤더 (정적 레이아웃, 안전여유 없음)", () => {
  // 44행·밴드1·헤더7(압축 워드마크) → 44-2-7=35
  assert.equal(computeChatRegionRows(44, 1, 7), 35);
});

test("computeChatRegionRows: 저행 터미널 바닥 클램프(최소 8)", () => {
  assert.equal(computeChatRegionRows(10, 1, 10), 8);
});

// ── 버퍼 상한 상수 ──

test("CHAT_SCROLLBACK_MAX_ENTRIES: 양의 유한 상한(무한 증식 방지 계약)", () => {
  assert.ok(Number.isInteger(CHAT_SCROLLBACK_MAX_ENTRIES) && CHAT_SCROLLBACK_MAX_ENTRIES > 0);
});

// ── wrapSegmentLine \n 하드브레이크 (0.10.3 — 현장 이슈②: 멀티라인 pushLine 행수 계산 붕괴) ──
// EPERM 안내(startup-diagnostics.ts) 같은 \n 포함 문자열이 한 엔트리로 들어오면, 기존엔 \n이 폭 0
// 일반문자로 텍스트에 남아 Ink가 실제 개행으로 렌더 — "시각행 1개"로 계산된 항목이 화면에선 여러
// 행을 차지해 박스가 예산을 초과했다(타이틀 잘림·잔상). 이제 \n은 행 분리자다(출력에 안 남음).

test("wrapSegmentLine: \\n은 하드브레이크 — 행이 분리되고 개행 문자는 출력에 남지 않는다", () => {
  const out = wrapSegmentLine([{ text: "가로줄1\n가로줄2\n셋", tone: "plain" }], 40);
  assert.equal(out.length, 3);
  assert.equal(out[0][0].text, "가로줄1");
  assert.equal(out[1][0].text, "가로줄2");
  assert.equal(out[2][0].text, "셋");
  for (const line of out) for (const seg of line) assert.ok(!seg.text.includes("\n"));
});

test("wrapSegmentLine: 연속 \\n\\n은 빈 시각행 1개를 보존한다(단락 구분)", () => {
  const out = wrapSegmentLine([{ text: "a\n\nb", tone: "plain" }], 10);
  assert.equal(out.length, 3);
  assert.equal(out[0][0].text, "a");
  assert.deepEqual(out[1], []);
  assert.equal(out[2][0].text, "b");
});

test("wrapSegmentLine: \\n 분리 후 각 행도 표시폭 랩을 따른다(하드브레이크+소프트랩 조합)", () => {
  const out = wrapSegmentLine([{ text: `${"a".repeat(15)}\nbb`, tone: "plain" }], 10);
  assert.equal(out.length, 3);
  assert.equal(out[0][0].text, "a".repeat(10));
  assert.equal(out[1][0].text, "a".repeat(5));
  assert.equal(out[2][0].text, "bb");
});

test("wrapSegmentLine: 후행 \\n은 빈 꼬리 행을 만들지 않는다(행 종결자 의미)", () => {
  const out = wrapSegmentLine([{ text: "abc\n", tone: "plain" }], 10);
  assert.equal(out.length, 1);
  assert.equal(out[0][0].text, "abc");
});

test("wrapSegmentLine: \\n 하드브레이크에서도 세그먼트 톤이 보존된다", () => {
  const out = wrapSegmentLine(
    [
      { text: "빨강\n", tone: "danger" },
      { text: "회색", tone: "dim" },
    ],
    20,
  );
  assert.equal(out.length, 2);
  assert.equal(out[0][0].tone, "danger");
  assert.equal(out[1][0].tone, "dim");
});

// ── computeInputLayout (0.10.3 — 한글 IME: 실커서를 캐럿 위치에 노출하기 위한 단일 소스) ──

test("computeInputLayout: 빈 입력 — 프롬프트 1행, 캐럿은 프롬프트 뒤(폭 2)", () => {
  const out = computeInputLayout([""], 0, 0, 30);
  assert.deepEqual(out.lines, ["❯ "]);
  assert.equal(out.caretRow, 0);
  assert.equal(out.caretCol, 2);
});

test("computeInputLayout: 커서 끝 — 캐럿이 텍스트 표시폭 끝(한글 2폭 반영)", () => {
  const out = computeInputLayout(["한글ab"], 0, 4, 30);
  assert.equal(out.lines.length, 1);
  assert.equal(out.caretRow, 0);
  assert.equal(out.caretCol, 2 + 2 + 2 + 2); // 프롬프트2 + 한2 + 글2 + a1+b1
});

test("computeInputLayout: 커서 중간 — slice 기준 표시폭 오프셋", () => {
  const out = computeInputLayout(["한글ab"], 0, 1, 30); // '한' 뒤
  assert.equal(out.caretCol, 2 + 2);
});

test("computeInputLayout: 랩 경계 — 캐럿이 랩된 다음 시각행으로 따라간다", () => {
  // 폭 10: "❯ "(2) + a×8 = 10 → 9번째 a부터 다음 행
  const out = computeInputLayout(["a".repeat(12)], 0, 12, 10);
  assert.equal(out.lines.length, 2);
  assert.equal(out.lines[0], "❯ " + "a".repeat(8));
  assert.equal(out.lines[1], "a".repeat(4));
  assert.equal(out.caretRow, 1);
  assert.equal(out.caretCol, 4);
});

test("computeInputLayout: 멀티라인 — 둘째 논리행은 들여쓰기 프리픽스, 캐럿 행 오프셋 누적", () => {
  const out = computeInputLayout(["ab", "cd"], 1, 2, 30);
  assert.deepEqual(out.lines, ["❯ ab", "  cd"]);
  assert.equal(out.caretRow, 1);
  assert.equal(out.caretCol, 2 + 2);
});

test("computeInputLayout: 시각행 수 = 렌더 행수 계약(행수예산과 단일 소스)", () => {
  const out = computeInputLayout(["가".repeat(20)], 0, 0, 10);
  // "❯ "+가20(40폭)=42폭, 폭 10 → 행당 한글 4~5자 → 총 5행 이상, 각 행 표시폭 ≤10
  for (const ln of out.lines) {
    const w = Array.from(ln).reduce((acc, ch) => acc + stringWidth(ch), 0);
    assert.ok(w <= 10, `행 폭 ${w} > 10`);
  }
  assert.equal(out.caretRow, 0);
  assert.equal(out.caretCol, 2);
});
