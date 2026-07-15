// 0.9.0 A3a ST3 — src/tui/format.ts 순수 포맷터(마스코트 half-block·statusline·게이트줄·경량 md/diff) 단정.
// Ground Truth: gbc-tui-design.html(statusline 표·키맵 표·A-①~A-④ 게이트줄 문구) +
// project_0_9_0_tui_stack_decision.md(C1 확정·<60열 C4 폴백·트루컬러+ANSI16 폴백).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PALETTE,
  MASCOT_S2,
  MASCOT_C4,
  renderMascot,
  selectMascot,
  abbreviateDir,
  formatUsageBar,
  formatStatusline,
  formatGateLine,
  formatMarkdownLite,
  joinTextSegments,
  SPINNER_FRAMES,
  formatSpinnerLine,
  WORDMARK_GEOBUKE,
  formatWelcomeCard,
  renderWordmark,
  formatTagline,
  SPLASH_WIDE_MIN_COLUMNS,
  SPLASH_HERO_MIN_COLUMNS,
  WELCOME_LINE,
} from "../dist/tui/format.js";
import { createInitialState, reduce } from "../dist/tui/model.js";

// ── 마스코트 ──

test("MASCOT_S2: 30×16(카와이 재설계 — 원/타원 래스터화+실루엣 윤곽선, 2026-07-14 사용자 승인), 등껍질 스컷+얼굴 요소 포함", () => {
  assert.equal(MASCOT_S2.length, 16);
  assert.equal(MASCOT_S2[0].length, 30);
  assert.ok(MASCOT_S2.some((row) => row.includes("S")), "등껍질 스컷 중간톤(S)이 있어야 함");
  assert.ok(MASCOT_S2.some((row) => row.includes("P")), "볼터치(P)가 있어야 카와이 얼굴");
  assert.ok(MASCOT_S2.some((row) => row.includes("W")), "눈 하이라이트(W)가 있어야 함");
});

test("MASCOT_S2/C4: 모든 행 길이가 동일하고, '.' 아니면 PALETTE에 정의된 키만 사용", () => {
  for (const matrix of [MASCOT_S2, MASCOT_C4]) {
    const width = matrix[0].length;
    for (const row of matrix) {
      assert.equal(row.length, width, "행 길이 불일치");
      for (const ch of row) {
        if (ch !== ".") assert.ok(ch in PALETTE, `미정의 팔레트 키 '${ch}'`);
      }
    }
  }
});

test("renderMascot(truecolor): 행 수 = ceil(matrix.length/2), 각 줄 리셋으로 종료, 트루컬러 이스케이프 포함", () => {
  const lines = renderMascot(MASCOT_S2, "truecolor");
  assert.equal(lines.length, Math.ceil(MASCOT_S2.length / 2));
  for (const line of lines) assert.ok(line.endsWith("\x1b[0m"), "각 줄은 리셋으로 종료");
  assert.ok(lines.some((l) => l.includes("38;2;")), "트루컬러 fg 이스케이프 포함");
});

test("renderMascot(ansi16): ANSI 16색 코드 사용, 38;2 트루컬러 코드는 없음", () => {
  const lines = renderMascot(MASCOT_S2, "ansi16");
  assert.equal(lines.length, Math.ceil(MASCOT_S2.length / 2));
  assert.ok(!lines.some((l) => l.includes("38;2;")), "ansi16 모드엔 트루컬러 코드 없어야 함");
  assert.ok(lines.some((l) => /\x1b\[9?\d+m/.test(l)), "ANSI 16색 코드 포함");
});

test("renderMascot: 완전 투명 셀('.','.')은 공백 1칸(색 없음)", () => {
  const lines = renderMascot(["..", ".."], "truecolor");
  assert.equal(lines.length, 1);
  assert.equal(lines[0], "\x1b[0m \x1b[0m \x1b[0m");
});

test("selectMascot: 60열 미만은 C4, 60열 이상은 S2", () => {
  assert.equal(selectMascot(40), MASCOT_C4);
  assert.equal(selectMascot(59), MASCOT_C4);
  assert.equal(selectMascot(60), MASCOT_S2);
  assert.equal(selectMascot(120), MASCOT_S2);
});

// ── statusline ──

test("abbreviateDir: 폭 안이면 그대로, 초과하면 '…/마지막세그먼트'로 축약", () => {
  assert.equal(abbreviateDir("~/workspace/geobuke-code", 40), "~/workspace/geobuke-code");
  assert.equal(abbreviateDir("~/workspace/geobuke-code", 15), "…/geobuke-code");
});

test("formatUsageBar: 채움 블록 수가 퍼센트에 비례, 0%/100%/범위밖 클램프", () => {
  assert.equal(formatUsageBar(0), "▱▱▱▱▱▱▱▱▱▱ 0%");
  assert.equal(formatUsageBar(100), "▰▰▰▰▰▰▰▰▰▰ 100%");
  assert.equal(formatUsageBar(47), "▰▰▰▰▰▱▱▱▱▱ 47%", "목업 예시값(A-① 47%)과 동일");
  assert.equal(formatUsageBar(-5), "▱▱▱▱▱▱▱▱▱▱ 0%", "음수 클램프");
  assert.equal(formatUsageBar(150), "▰▰▰▰▰▰▰▰▰▰ 100%", "100 초과 클램프");
});

test("formatStatusline: dirty면 branch에 '*', usagePct<80은 accent·>=80은 warn, costUsd는 항상 표시(model.ts Statusline과 동일 계약)", () => {
  const base = { dir: "~/workspace/geobuke-code", branch: "main", dirty: false, model: "sonnet", usagePct: 47, costUsd: 0.42 };
  const segs = formatStatusline(base);
  assert.ok(segs.some((s) => s.text === "main"));
  const usage = segs.find((s) => s.text.startsWith("▰") || s.text.startsWith("▱"));
  assert.ok(usage);
  assert.equal(usage.tone, "accent");
  assert.ok(segs.some((s) => s.text === "$0.42"));

  const dirty = formatStatusline({ ...base, dirty: true });
  assert.ok(dirty.some((s) => s.text === "main*"));

  const warn = formatStatusline({ ...base, usagePct: 85 });
  const warnUsage = warn.find((s) => s.text.includes("%"));
  assert.equal(warnUsage.tone, "warn", "80%+ 경고색(A-② 목업 55%는 accent, 여기선 85%로 임계 초과 확인)");

  const zero = formatStatusline({ ...base, costUsd: 0 });
  assert.ok(zero.some((s) => s.text === "$0.00"), "engine.ts는 항상 number(구독 인증도 0으로 강제) — null 분기는 실제 생산자가 없어 제거함");
});

test("formatStatusline: lastTurnMs(0.9.2 ST15) — 0/미지정이면 세그먼트 생략, >0이면 초 단위 표시", () => {
  const base = { dir: "d", branch: "main", dirty: false, model: "m", usagePct: 0, costUsd: 0 };
  const withoutTurn = formatStatusline({ ...base, lastTurnMs: 0 });
  assert.ok(!withoutTurn.some((s) => /\ds$/.test(s.text)), "턴 없음 — 경과시간 세그먼트 없음");
  const withTurn = formatStatusline({ ...base, lastTurnMs: 12345 });
  assert.ok(withTurn.some((s) => s.text === "12.3s"), "소수 1자리 초 단위");
});

test("formatStatusline: lastTtftMs(0.9.4 ST7) — 0/미지정이면 세그먼트 생략, >0이면 'ttft 1.7s' 형식", () => {
  const base = { dir: "d", branch: "main", dirty: false, model: "m", usagePct: 0, costUsd: 0 };
  const without = formatStatusline({ ...base, lastTtftMs: 0 });
  assert.ok(!without.some((s) => s.text.startsWith("ttft")), "TTFT 없음 — 세그먼트 생략");
  const withTtft = formatStatusline({ ...base, lastTtftMs: 1660 });
  assert.ok(withTtft.some((s) => s.text === "ttft 1.7s"), "소수 1자리 초 단위, ttft 접두로 lastTurnMs와 구분");
});

// ── 게이트 줄 ──

test("formatGateLine: idle(초기) — 'gated ✓' + spec/defer 카운트", () => {
  const s = createInitialState();
  const segs = formatGateLine({ ...s, specCount: 4, deferCount: 2 });
  const text = joinTextSegments(segs);
  assert.match(text, /gated ✓/);
  assert.match(text, /spec 4케이스/);
  assert.match(text, /defer 2/);
});

test("formatGateLine: pass + streaming — 'esc 중단' 힌트 포함", () => {
  let s = createInitialState();
  s = reduce(s, { type: "TURN_START" });
  s = reduce(s, { type: "GATE_RESULT", status: "pass", specCount: 4, deferCount: 2 });
  const text = joinTextSegments(formatGateLine(s));
  assert.match(text, /🐢 pass/);
  assert.match(text, /esc 중단/);
});

test("formatGateLine: pass + 미스트리밍 — 'esc 중단' 없음", () => {
  let s = createInitialState();
  s = reduce(s, { type: "GATE_RESULT", status: "pass", specCount: 4, deferCount: 2 });
  const text = joinTextSegments(formatGateLine(s));
  assert.doesNotMatch(text, /esc 중단/);
});

test("formatGateLine: block(승인 대기) — BLOCK danger 세그먼트, canUseTool 일시정지 문구", () => {
  let s = createInitialState();
  s = reduce(s, { type: "APPROVAL_REQUESTED", reason: "명세에 없는 파일 편집" });
  const segs = formatGateLine(s);
  const blockSeg = segs.find((seg) => seg.text.includes("BLOCK"));
  assert.ok(blockSeg);
  assert.equal(blockSeg.tone, "danger");
  assert.match(joinTextSegments(segs), /승인 대기 중.*canUseTool/);
});

test("formatGateLine: 패널 토글 힌트가 열림 상태에 따라 '메트릭'↔'닫기' 전환", () => {
  let s = createInitialState();
  const closedText = joinTextSegments(formatGateLine(s));
  assert.match(closedText, /⌃M 메트릭/);
  assert.match(closedText, /⌃R repos/);
  assert.match(closedText, /⌃S skills/);
  s = reduce(s, { type: "TOGGLE_PANEL", panel: "metrics" });
  const openText = joinTextSegments(formatGateLine(s));
  assert.match(openText, /⌃M 닫기/);
  assert.match(openText, /⌃R repos/, "다른 패널 힌트는 그대로");
});

test("formatGateLine: skills 패널 열림 — '⌃S 닫기'로 전환", () => {
  let s = createInitialState();
  s = reduce(s, { type: "TOGGLE_PANEL", panel: "skills" });
  assert.match(joinTextSegments(formatGateLine(s)), /⌃S 닫기/);
});

// exitConfirmArmed(0.9.2 ST10/scope-critic 발견) — pushLine 스크롤백은 후속 출력에 밀려나 사라지므로,
// 상시 노출 채널인 게이트 줄에 warn 세그먼트로 반영한다. gateStatus/승인 상태와 무관하게 최우선 노출.
test("formatGateLine: exitConfirmArmed=true — 최우선 warn 세그먼트로 상시 노출", () => {
  let s = createInitialState();
  s = reduce(s, { type: "CTRL_C_PRESSED" });
  const segs = formatGateLine(s);
  assert.equal(segs[0].text, "⌃C 한 번 더=종료");
  assert.equal(segs[0].tone, "warn");
});

test("formatGateLine: exitConfirmArmed=false(기본) — armed 세그먼트 없음", () => {
  const segs = formatGateLine(createInitialState());
  assert.ok(!segs.some((s) => s.text.includes("종료")));
});

test("formatGateLine: exitConfirmArmed=true + BLOCK(승인 대기) 동시 상태에서도 armed 세그먼트가 앞에 옴", () => {
  let s = createInitialState();
  s = reduce(s, { type: "CTRL_C_PRESSED" });
  s = reduce(s, { type: "APPROVAL_REQUESTED", reason: "명세에 없는 파일 편집" });
  const segs = formatGateLine(s);
  assert.equal(segs[0].text, "⌃C 한 번 더=종료");
  assert.ok(segs.some((seg) => seg.text.includes("BLOCK")));
});

// ── 경량 마크다운/diff ──

test("formatMarkdownLite: 헤딩은 #제거+accent, 일반 텍스트는 plain", () => {
  const segs = formatMarkdownLite("## 제목\n본문 텍스트");
  assert.equal(segs[0].text, "제목");
  assert.equal(segs[0].tone, "accent");
  assert.equal(segs[1].text, "본문 텍스트");
  assert.equal(segs[1].tone, "plain");
});

test("formatMarkdownLite: ```diff 펜스 안 +/- 라인만 accent/danger, 파일헤더(+++/---)는 제외", () => {
  const diff = ["```diff", "+++ b/file.ts", "--- a/file.ts", "+added line", "-removed line", " context", "```"].join("\n");
  const segs = formatMarkdownLite(diff);
  assert.equal(segs[0].tone, "dim", "펜스 오픈 라인");
  assert.equal(segs[1].tone, "code", "+++ 파일헤더는 diff 강조 대상 아님");
  assert.equal(segs[2].tone, "code", "--- 파일헤더는 diff 강조 대상 아님");
  assert.equal(segs[3].tone, "accent");
  assert.equal(segs[4].tone, "danger");
  assert.equal(segs[5].tone, "code");
  assert.equal(segs[6].tone, "dim", "펜스 클로즈 라인");
});

test("formatMarkdownLite: 펜스 밖 bare +/-는 diff로 오판하지 않는다(마크다운 불릿리스트 오탐 방지 — ST3 자체검토 확정 수정)", () => {
  const md = ["- 항목 하나", "- 항목 둘", "+1 정정합니다", "일반 문장"].join("\n");
  const segs = formatMarkdownLite(md);
  for (const seg of segs) assert.equal(seg.tone, "plain", `펜스 밖은 diff 강조 없이 항상 plain: "${seg.text}"`);
});

test("formatMarkdownLite: 코드펜스 내부(비-diff 언어)는 code 톤으로 원문 그대로(마크다운 파싱 안 함)", () => {
  const md = "```\n# 이건헤딩아님\n```";
  const segs = formatMarkdownLite(md);
  assert.equal(segs[0].tone, "dim", "펜스 라인 자체");
  assert.equal(segs[1].text, "# 이건헤딩아님", "펜스 안은 원문 그대로");
  assert.equal(segs[1].tone, "code");
  assert.equal(segs[2].tone, "dim");
});

test("joinTextSegments: 기본 구분자 ' · ', 커스텀 구분자 지원", () => {
  const segs = [{ text: "a", tone: "plain" }, { text: "b", tone: "plain" }];
  assert.equal(joinTextSegments(segs), "a · b");
  assert.equal(joinTextSegments(segs, " | "), "a | b");
});

test("포맷터는 입력을 변형하지 않는다(순수성)", () => {
  const s = createInitialState();
  const frozen = JSON.stringify(s);
  formatGateLine(s);
  assert.equal(JSON.stringify(s), frozen);
  const statusData = { dir: "d", branch: "b", dirty: false, model: "m", usagePct: 1, costUsd: 1 };
  const frozenStatus = JSON.stringify(statusData);
  formatStatusline(statusData);
  assert.equal(JSON.stringify(statusData), frozenStatus);
});

// ── 스피너 (0.9.2 ST7 — 스트리밍 중 로딩 인디케이터. tick·elapsedMs는 호출부(app.tsx setInterval)가
// 넘긴다(Date.now() 등 시간 API를 이 순수 포맷터가 직접 쓰지 않음 — 결정론 유지). ──

test("SPINNER_FRAMES: braille 프레임 배열, 2개 이상", () => {
  assert.ok(Array.isArray(SPINNER_FRAMES));
  assert.ok(SPINNER_FRAMES.length >= 2);
  for (const f of SPINNER_FRAMES) assert.equal(typeof f, "string");
});

test("formatSpinnerLine: tick이 프레임 개수를 넘기면 순환(모듈로)", () => {
  const first = formatSpinnerLine(0, 0);
  const wrapped = formatSpinnerLine(SPINNER_FRAMES.length, 0);
  assert.equal(first, wrapped, "한 바퀴 돈 tick은 동일 프레임을 재사용");
});

test("formatSpinnerLine: 경과초를 정수 초 단위로 표시(올림/내림 아닌 내림)", () => {
  assert.match(formatSpinnerLine(0, 0), /0s/);
  assert.match(formatSpinnerLine(0, 3000), /3s/);
  assert.match(formatSpinnerLine(0, 3999), /3s/, "1초 미만 반올림 없이 내림");
});

test("formatSpinnerLine: 순수성 — 같은 입력엔 항상 같은 출력", () => {
  assert.equal(formatSpinnerLine(2, 5000), formatSpinnerLine(2, 5000));
});

// ── 워드마크 + 안내카드 (0.9.2 ST13 — figlet "ANSI Shadow" 폰트로 생성한 정적 문자열, zero-dep
// 임베드. 런타임 figlet 의존성 없음 — 빌드타임에 한 번 생성한 상수를 그대로 배선. ──

test("WORDMARK_GEOBUKE: 모든 행 폭이 동일, 박스drawing 문자 포함", () => {
  const width = WORDMARK_GEOBUKE[0].length;
  for (const row of WORDMARK_GEOBUKE) assert.equal(row.length, width, "행 폭 불일치");
  assert.ok(WORDMARK_GEOBUKE.some((row) => /[█╗╝║═╔╚]/.test(row)), "box-drawing 문자 포함");
});

// 0.9.3 D1 — formatWelcomeCard가 기본 스킬 3종 섹션을 받도록 확장(스플래시 시안 최종 확정,
// 아티팩트 cb7c6b1c 장면01). 키맵도 시안대로 2줄로 분리(⌃M/⌃R/⌃S 한 줄 + shift+↵/esc/⌃C 한 줄 —
// 기존 1줄 구현엔 "shift+↵ 개행" 안내 자체가 없었다: 콘텐츠 누락이었지 압축이 아니었다).
const SKILLS = [
  { name: "gate", blurb: "defer·spec·verify 게이트 관리" },
  { name: "gbc-monitor", blurb: "운영 현황 조회(관측 전용)" },
  { name: "gbc-mute", blurb: "defer 리마인드 on/off" },
];

test("formatWelcomeCard: 게이트 요약 2줄 + 기본 스킬 섹션(헤딩+스킬수만큼) + 키맵 2줄", () => {
  const rows = formatWelcomeCard(8, 2, SKILLS);
  assert.equal(rows.length, 2 + 1 + SKILLS.length + 2, "게이트요약2 + 스킬헤딩1 + 스킬3 + 키맵2");
  assert.match(joinTextSegments(rows[0]), /게이트 활성/);
  const line2 = joinTextSegments(rows[1]);
  assert.match(line2, /spec 8케이스/);
  assert.match(line2, /defer 2/);
  assert.match(joinTextSegments(rows[2]), /기본 스킬/);
  assert.match(joinTextSegments(rows[3]), /\/gate/);
  assert.match(joinTextSegments(rows[3]), /defer·spec·verify 게이트 관리/);
  assert.match(joinTextSegments(rows[4]), /\/gbc-monitor/);
  assert.match(joinTextSegments(rows[5]), /\/gbc-mute/);
  const keymap1 = joinTextSegments(rows[6]);
  assert.match(keymap1, /⌃M/);
  assert.match(keymap1, /⌃R/);
  assert.match(keymap1, /⌃S/);
  const keymap2 = joinTextSegments(rows[7]);
  assert.match(keymap2, /shift\+↵/);
  assert.match(keymap2, /esc 중단/);
  assert.match(keymap2, /⌃C 종료\(2회\)/);
});

test("formatWelcomeCard: 스킬 이름 세그먼트는 accent 톤(패널 강조와 일관)", () => {
  const rows = formatWelcomeCard(0, 0, SKILLS);
  const skillRow = rows[3];
  const nameSeg = skillRow.find((s) => s.text === "/gate");
  assert.equal(nameSeg.tone, "accent");
});

test("formatWelcomeCard: 스킬 목록 비어있어도 헤딩+키맵은 유지(빈 목록 방어)", () => {
  const rows = formatWelcomeCard(0, 0, []);
  assert.equal(rows.length, 2 + 1 + 0 + 2);
});

test("formatWelcomeCard: 순수성 — 같은 입력엔 항상 같은 출력", () => {
  assert.deepEqual(formatWelcomeCard(0, 0, SKILLS), formatWelcomeCard(0, 0, SKILLS));
});

// ── 워드마크 그라데이션 + 태그라인 (0.9.3 D1 — 승인 시안 대비 구현 누락 복원) ──
// 시안(https://claude.ai/code/artifact/cb7c6b1c-f254-415e-991a-a43d2a2e1f33) 장면01:
// 행별 6단 그린 그라데이션(#a7f3c9→#86efac→#5fe694→#4ade80→#2f9e63→#1c7a48).
// 기존 구현(app.tsx)은 WORDMARK_GEOBUKE 6행 전부에 단일 tone:"accent"만 입혀 단색이었다.

test("renderWordmark(truecolor): 6줄, 각 줄 리셋 종료, 트루컬러 포함, 행마다 서로 다른 색(그라데이션)", () => {
  const lines = renderWordmark("truecolor");
  assert.equal(lines.length, 6);
  for (const line of lines) {
    assert.ok(line.includes("38;2;"), "트루컬러 fg 이스케이프 포함");
    assert.ok(line.endsWith("\x1b[0m"), "리셋으로 종료");
  }
  const fgCodes = lines.map((l) => l.match(/38;2;\d+;\d+;\d+/)[0]);
  assert.equal(new Set(fgCodes).size, 6, "6행 전부 서로 다른 색이어야 그라데이션(현 결함=단색 회귀 방지)");
});

test("renderWordmark(truecolor): 정확한 그라데이션 hex 순서(시안 사양)", () => {
  const HEX = ["a7f3c9", "86efac", "5fe694", "4ade80", "2f9e63", "1c7a48"];
  const lines = renderWordmark("truecolor");
  HEX.forEach((hex, i) => {
    const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
    assert.ok(lines[i].startsWith(`\x1b[38;2;${r};${g};${b}m`), `${i}행은 #${hex}로 시작해야 함`);
  });
});

test("renderWordmark(ansi16): 트루컬러 코드 없음, 상위 3행/하위 3행 2단 근사(서로 다른 코드)", () => {
  const lines = renderWordmark("ansi16");
  assert.equal(lines.length, 6);
  for (const line of lines) assert.ok(!line.includes("38;2;"));
  const topCode = lines[0].match(/\x1b\[(\d+)m/)[1];
  const botCode = lines[5].match(/\x1b\[(\d+)m/)[1];
  assert.notEqual(topCode, botCode, "상단(밝은 그린)과 하단(짙은 그린)은 다른 ansi16 코드");
  assert.equal(lines[0].match(/\x1b\[(\d+)m/)[1], lines[1].match(/\x1b\[(\d+)m/)[1], "상위 3행은 동일 코드(2단 근사)");
});

test("renderWordmark: 각 줄 내용은 WORDMARK_GEOBUKE 원문을 보존(색만 입힘, 문자는 불변)", () => {
  const lines = renderWordmark("truecolor");
  lines.forEach((line, i) => {
    const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
    assert.equal(stripped, WORDMARK_GEOBUKE[i]);
  });
});

test("formatTagline: 버전 문자열을 그대로 보간, 하드코딩 없음", () => {
  assert.equal(formatTagline("0.9.3"), "거북이코드 v0.9.3 · 계획↔구현↔검증 게이트");
  assert.equal(formatTagline("1.2.3"), "거북이코드 v1.2.3 · 계획↔구현↔검증 게이트");
});

// 0.9.3 D2 — WELCOME_LINE(시안 요구 ⑦)이 D1/D2 1차 구현에서 누락됐던 것을 복원(자체 재검토 발견).
test("WELCOME_LINE: 시안 확정 문구와 정확히 일치", () => {
  assert.equal(WELCOME_LINE, "🐢 무엇이든 입력하세요 — 게이트가 계획 없는 구현을 지켜줍니다.");
});

// ── 반응형 임계값 분리 (0.9.3 D1) — 마스코트 폴백(60열)과 워드마크+2컬럼 병치(96열)는
// 서로 다른 레이아웃 결정이라 단일 임계값을 공유하면 안 된다(60~95열에서 워드마크 없이
// 마스코트 S2+카드 세로스택이라는 중간 상태가 필요 — 시안 요구 ⑧ 3단 반응형).
// 96은 카와이 S2(30폭) 재설계로 2컬럼 폭 예산(3+30+6+54=93)이 늘어나 84→96으로 상향한 값.
test("SPLASH_WIDE_MIN_COLUMNS(마스코트)과 SPLASH_HERO_MIN_COLUMNS(워드마크+병치)는 별개 값", () => {
  assert.equal(SPLASH_WIDE_MIN_COLUMNS, 60);
  assert.equal(SPLASH_HERO_MIN_COLUMNS, 96);
  assert.ok(SPLASH_HERO_MIN_COLUMNS > SPLASH_WIDE_MIN_COLUMNS);
});
