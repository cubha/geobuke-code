// 0.11.0 ST2-1 — src/tui/diff.ts 순수부 단정. 도구 승인 프롬프트에 Edit/Write/MultiEdit/Bash의
// 실제 변경내용을 보여주기 위한 포맷터(지금까지는 decisionReason 문구만 보여 사용자가 무엇을
// 승인하는지 알 수 없었다 — bridge.ts classifyApprovalRequest는 spec-add만 특별취급했다).
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatToolPreview, formatToolPreviewVisual, isToolPreviewSupported } from "../dist/tui/diff.js";

function texts(segLines) {
  return segLines.map((line) => line.map((s) => s.text).join(""));
}

test("formatToolPreview: Edit — file_path + old_string(−)·new_string(+) 라인", () => {
  const out = formatToolPreview(
    "Edit",
    { file_path: "src/a.ts", old_string: "foo", new_string: "bar" },
    10,
  );
  const t = texts(out);
  assert.equal(t[0], "src/a.ts");
  assert.equal(t[1], "− foo");
  assert.equal(t[2], "+ bar");
});

test("formatToolPreview: Edit — old_string/new_string 톤이 danger/accent", () => {
  const out = formatToolPreview("Edit", { file_path: "x", old_string: "a", new_string: "b" }, 10);
  assert.equal(out[1][0].tone, "danger");
  assert.equal(out[2][0].tone, "accent");
});

test("formatToolPreview: Write — file_path + content head", () => {
  const out = formatToolPreview("Write", { file_path: "new.txt", content: "line1\nline2\nline3" }, 10);
  const t = texts(out);
  assert.deepEqual(t, ["new.txt", "line1", "line2", "line3"]);
});

// scope-critic 지적(Task C-2 검토) — "N건 편집" 요약 1줄만으로는 무엇이 바뀌는지 전혀 알 수 없다
// (형태 known·역비용 낮음 판정, stub→제대로 개선). 첫 편집의 실제 diff를 보여주고 나머지는 카운트로.
test("formatToolPreview: MultiEdit — file_path + 첫 편집 diff(−/+) + 나머지 건수 요약", () => {
  const out = formatToolPreview(
    "MultiEdit",
    { file_path: "b.ts", edits: [{ old_string: "1", new_string: "2" }, { old_string: "3", new_string: "4" }, { old_string: "5", new_string: "6" }] },
    10,
  );
  const t = texts(out);
  assert.equal(t[0], "b.ts");
  assert.equal(t[1], "− 1");
  assert.equal(t[2], "+ 2");
  assert.match(t[3], /…2건 추가 편집/);
});

test("formatToolPreview: MultiEdit — edits가 1건이면 '추가 편집' 요약 없음", () => {
  const out = formatToolPreview("MultiEdit", { file_path: "b.ts", edits: [{ old_string: "1", new_string: "2" }] }, 10);
  const t = texts(out);
  assert.deepEqual(t, ["b.ts", "− 1", "+ 2"]);
});

test("formatToolPreview: MultiEdit — edits가 빈 배열이면 file_path만", () => {
  const out = formatToolPreview("MultiEdit", { file_path: "b.ts", edits: [] }, 10);
  assert.deepEqual(texts(out), ["b.ts"]);
});

test("formatToolPreview: Bash — command을 줄 단위 그대로", () => {
  const out = formatToolPreview("Bash", { command: "echo hi\necho bye" }, 10);
  assert.deepEqual(texts(out), ["echo hi", "echo bye"]);
});

test("formatToolPreview: rowBudget 초과 시 head에서 잘리고 '…N행 생략' 마커가 붙는다", () => {
  const out = formatToolPreview("Bash", { command: "1\n2\n3\n4\n5" }, 3);
  assert.equal(out.length, 3);
  assert.deepEqual(texts(out.slice(0, 2)), ["1", "2"]);
  assert.match(texts(out)[2], /…3행 생략/);
});

test("formatToolPreview: rowBudget<=0 — 빈 배열(예산 없음)", () => {
  assert.deepEqual(formatToolPreview("Bash", { command: "x" }, 0), []);
});

test("formatToolPreview: 알 수 없는 도구명 — 빈 배열(app.tsx가 isToolPreviewSupported로 미리 걸러 preview 자체를 null로 둔다)", () => {
  assert.deepEqual(formatToolPreview("SomeUnknownTool", { x: 1 }, 10), []);
});

test("formatToolPreview: Edit에서 file_path/old_string/new_string 누락 시 크래시 없이 빈 문자열로 취급", () => {
  assert.doesNotThrow(() => formatToolPreview("Edit", {}, 10));
});

// §3-C(2026-07-27 /analyze 회귀수정) — 지원 도구 4종의 단일 소스. app.tsx가 이 함수로 미리 걸러야
// 4종 밖 도구(WebFetch·MCP 등) 승인에서 reason 텍스트 폴백이 죽은 코드가 되지 않는다.
test("isToolPreviewSupported: Edit/Write/MultiEdit/Bash는 true", () => {
  assert.equal(isToolPreviewSupported("Edit"), true);
  assert.equal(isToolPreviewSupported("Write"), true);
  assert.equal(isToolPreviewSupported("MultiEdit"), true);
  assert.equal(isToolPreviewSupported("Bash"), true);
});

test("isToolPreviewSupported: 그 외 도구명은 false", () => {
  assert.equal(isToolPreviewSupported("WebFetch"), false);
  assert.equal(isToolPreviewSupported("mcp__example__tool"), false);
  assert.equal(isToolPreviewSupported(""), false);
});

// 보안수정(2026-07-27, /ship 사전 QUICK 검토 Critical) — 도구 입력 원문(외부에서 온 파일 콘텐츠·
// bash 명령 등)이 가공 없이 승인 프롬프트에 렌더되면, ANSI 이스케이프가 섞여 있을 때 y/n/e/d
// 선택지 줄을 가리거나 화면을 조작해 사용자가 무엇을 승인하는지 오판하게 만들 수 있다.
test("formatToolPreview: Write content의 ESC(0x1b) 이스케이프 시퀀스가 제거된다", () => {
  const out = formatToolPreview("Write", { file_path: "a.txt", content: "safe\x1b[2J\x1b[31mDANGER" }, 10);
  const t = texts(out);
  assert.ok(!t.some((line) => line.includes("\x1b")), `ESC가 남아있음: ${JSON.stringify(t)}`);
  assert.ok(t.some((line) => line.includes("safe") && line.includes("DANGER")));
});

test("formatToolPreview: Bash command의 캐리지리턴·기타 C0 제어문자가 제거된다", () => {
  // 구현체와 동일한 정규식을 검증에 재사용하면 그 정규식 자체의 결함(예: CR 누락)을 못 잡는
  // 동어반복이 된다(security-auditor DEEP 지적, 2026-07-27) — 기대 출력 문자열을 직접 명시한다.
  const out = formatToolPreview("Bash", { command: "echo hi\r\x07\x0bmore" }, 10);
  assert.deepEqual(texts(out), ["echo himore"]);
});

test("formatToolPreview: Bash command의 캐리지리턴(CR) 단독도 제거된다(개행이 아니라 같은 줄 덮어쓰기라 특히 위험)", () => {
  const out = formatToolPreview("Bash", { command: "a\rb" }, 10);
  assert.deepEqual(texts(out), ["ab"]);
});

test("formatToolPreview: Edit old_string/new_string의 이스케이프도 제거되고 탭·개행은 보존", () => {
  const out = formatToolPreview("Edit", { file_path: "a.ts", old_string: "a\x1b[0mb", new_string: "c\tд" }, 10);
  const t = texts(out);
  assert.ok(!t.some((line) => line.includes("\x1b")));
  assert.ok(t.some((line) => line.includes("\t")), "탭 문자는 보존돼야 함");
});

// ── formatToolPreviewVisual (scope-critic 지적 — 논리줄 rowBudget과 폭 랩 후 시각행수가 어긋날 수
// 있어, app.tsx(행수 예산 계산)와 ApprovalBox.tsx(실제 렌더)가 동일한 함수를 호출해 절대 drift가
// 없게 한다. 최종 반환은 이미 폭으로 wrap된 시각행이며, 전체 개수가 rowBudget을 절대 넘지 않는다 —
// 긴 diff 한 줄이 여러 시각행으로 wrap돼도 rowBudget을 초과해 승인 선택지 줄을 밀어내지 않는다). ──

test("formatToolPreviewVisual: 좁은 폭에서 긴 줄이 wrap돼도 최종 시각행수가 rowBudget을 넘지 않는다", () => {
  const out = formatToolPreviewVisual(
    "Write",
    { file_path: "x", content: "가나다라마바사아자차카타파하가나다라마바사아자차카타파하가나다라마바사아자차" }, // 폭 10에서 여러 줄로 wrap됨
    5,
    10,
  );
  assert.ok(out.length <= 5, `rowBudget=5인데 ${out.length}행 나옴`);
});

test("formatToolPreviewVisual: rowBudget 초과 시 마지막 행이 생략 마커", () => {
  const out = formatToolPreviewVisual("Bash", { command: "1\n2\n3\n4\n5\n6\n7\n8" }, 4, 20);
  assert.equal(out.length, 4);
  assert.match(out[3].map((s) => s.text).join(""), /생략/);
});

test("formatToolPreviewVisual: 예산 내로 충분하면 truncate() 마커 없이 그대로", () => {
  const out = formatToolPreviewVisual("Bash", { command: "echo hi" }, 10, 40);
  assert.deepEqual(out.map((l) => l.map((s) => s.text).join("")), ["echo hi"]);
});
