import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { normalizeEdit, isGatedTool } from "../dist/normalize.js";
import { parseVerdict, buildUserMessage, failOpenVerdict } from "../dist/judge.js";
import { computeSpecHash, loadPlanSpec } from "../dist/spec.js";
import { addDefer, activeDeferItems, resolveDefer, unresolvedDefers } from "../dist/defer.js";
import { isGated, markGated, resetGate, loadState } from "../dist/state.js";
import { addSpecCase, readSpecCases, clearSpec } from "../dist/spec.js";
import { buildBlockReason, shouldCacheVerdict, buildSessionStartHint } from "../dist/hook.js";
import {
  buildPreCommand,
  normalizeHooks,
  buildSessionStartCommand,
  ensureSessionStartHook,
  hasStalePreToolUse,
  hasSessionStartHook,
} from "../dist/install.js";
import {
  buildInitStalenessNotice,
  wasNotified,
  markNotified,
  buildUpdateNotice,
} from "../dist/notice.js";
import {
  compareVersions,
  buildVersionNotice,
  isCacheStale,
  readVersionCache,
  writeVersionCache,
} from "../dist/version.js";
import { serializeEvent, parseEvents, computeMetrics, logEvent } from "../dist/metrics.js";
import { resolveApiKey, safeModel } from "../dist/judge.js";
import { normalizeCase, MAX_CASE } from "../dist/text.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "gbc-test-"));
}

test("isGatedTool: Edit/Write/MultiEdit만 게이트 대상", () => {
  assert.equal(isGatedTool("Edit"), true);
  assert.equal(isGatedTool("Write"), true);
  assert.equal(isGatedTool("MultiEdit"), true);
  assert.equal(isGatedTool("Read"), false);
  assert.equal(isGatedTool("Bash"), false);
});

test("normalizeEdit: Edit는 -/+ diff로", () => {
  const out = normalizeEdit("Edit", { file_path: "a.ts", old_string: "x", new_string: "y" });
  assert.match(out, /a\.ts/);
  assert.match(out, /- x/);
  assert.match(out, /\+ y/);
});

test("normalizeEdit: Write는 전체 작성", () => {
  const out = normalizeEdit("Write", { file_path: "b.ts", content: "hello" });
  assert.match(out, /전체 작성/);
  assert.match(out, /\+ hello/);
});

test("normalizeEdit: MultiEdit는 각 편집 나열", () => {
  const out = normalizeEdit("MultiEdit", {
    file_path: "c.ts",
    edits: [
      { old_string: "a", new_string: "b" },
      { old_string: "c", new_string: "d" },
    ],
  });
  assert.match(out, /편집 1/);
  assert.match(out, /편집 2/);
});

test("parseVerdict: JSON 추출 + block/pass 정규화", () => {
  const v = parseVerdict('쓰레기 {"verdict":"block","missing":["x"],"reason":"r"} 뒤');
  assert.equal(v.verdict, "block");
  assert.deepEqual(v.missing, ["x"]);
  assert.equal(v.reason, "r");
});

test("parseVerdict: 알 수 없는 verdict는 pass로", () => {
  const v = parseVerdict('{"verdict":"maybe"}');
  assert.equal(v.verdict, "pass");
});

test("failOpenVerdict: 판정 실패 시 failOpen=true pass 반환(사유 포함)", () => {
  const v = failOpenVerdict(new Error("network down"));
  assert.equal(v.verdict, "pass");
  assert.equal(v.failOpen, true);
  assert.match(v.reason, /fail-open/);
  assert.match(v.reason, /network down/);
});

test("parseVerdict: 정상 판정 결과엔 failOpen 미설정(falsy)", () => {
  const v = parseVerdict('{"verdict":"pass","missing":[],"reason":"ok"}');
  assert.ok(!v.failOpen);
});

test("buildUserMessage: defer 없으면 (없음)", () => {
  const m = buildUserMessage("plan", "edit", []);
  assert.match(m, /\(없음\)/);
});

test("buildUserMessage: defer 항목 나열", () => {
  const m = buildUserMessage("plan", "edit", ["케이스A"]);
  assert.match(m, /- 케이스A/);
});

test("computeSpecHash: 동일 입력 동일 해시, 변경 시 다른 해시", () => {
  assert.equal(computeSpecHash("abc"), computeSpecHash("abc"));
  assert.notEqual(computeSpecHash("abc"), computeSpecHash("abd"));
});

test("loadPlanSpec: scratch.md는 명세 소스에서 제외 (0.2.2 단일정본화)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gbc-spec-src-"));
  try {
    // scratch.md만 있어도 명세로 안 읽음 → 빈 텍스트 + source "(없음)"
    writeFileSync(join(dir, "scratch.md"), "# 진행현황\n- 작업중", "utf8");
    const r1 = loadPlanSpec(dir);
    assert.equal(r1.text, "");
    assert.match(r1.source, /없음/);

    // .gbc/spec.md가 정본
    mkdirSync(join(dir, ".gbc"), { recursive: true });
    writeFileSync(join(dir, ".gbc", "spec.md"), "케이스 A", "utf8");
    const r2 = loadPlanSpec(dir);
    assert.equal(r2.text, "케이스 A");
    assert.match(r2.source, /spec\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPlanSpec: GBC_SPEC_FILE가 .gbc/spec.md보다 우선 (0.2.2 명시 override = 유일 마이그레이션 경로)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gbc-spec-env-"));
  const override = join(dir, "my-plan.md");
  const prev = process.env.GBC_SPEC_FILE;
  try {
    mkdirSync(join(dir, ".gbc"), { recursive: true });
    writeFileSync(join(dir, ".gbc", "spec.md"), "정본 케이스", "utf8");
    writeFileSync(override, "override 케이스", "utf8");
    process.env.GBC_SPEC_FILE = override;
    const r = loadPlanSpec(dir);
    assert.equal(r.text, "override 케이스"); // env override가 .gbc/spec.md를 이긴다
    assert.equal(r.source, override);
  } finally {
    if (prev === undefined) delete process.env.GBC_SPEC_FILE;
    else process.env.GBC_SPEC_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPlanSpec: GBC_SPEC_FILE 상대경로는 cwd 기준으로 해석 (W1, hook 프로세스 cwd 아님)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gbc-spec-rel-"));
  const prev = process.env.GBC_SPEC_FILE;
  try {
    // 상대 파일명을 dir 안에 둔다. 테스트 프로세스의 cwd는 프로젝트 루트라 dir과 다르다.
    writeFileSync(join(dir, "rel-plan.md"), "상대 케이스", "utf8");
    process.env.GBC_SPEC_FILE = "rel-plan.md"; // 상대경로
    const r = loadPlanSpec(dir);
    assert.equal(r.text, "상대 케이스"); // process.cwd가 아닌 인자 cwd(dir) 기준 해석
  } finally {
    if (prev === undefined) delete process.env.GBC_SPEC_FILE;
    else process.env.GBC_SPEC_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPlanSpec: cwd 밖 절대경로 GBC_SPEC_FILE은 차단 아닌 경고만(escape-hatch 보존, W1)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gbc-spec-out-"));
  const outside = mkdtempSync(join(tmpdir(), "gbc-shared-"));
  const shared = join(outside, "shared-plan.md");
  const prev = process.env.GBC_SPEC_FILE;
  try {
    writeFileSync(shared, "공유 명세", "utf8");
    process.env.GBC_SPEC_FILE = shared; // cwd 밖 절대경로 — 정당한 명시 지정
    const r = loadPlanSpec(dir);
    assert.equal(r.text, "공유 명세"); // 막지 않고 그대로 읽는다(경고만)
    assert.equal(r.source, resolve(dir, shared));
  } finally {
    if (prev === undefined) delete process.env.GBC_SPEC_FILE;
    else process.env.GBC_SPEC_FILE = prev;
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("defer-registry: add → active → resolve 흐름", () => {
  const dir = tmp();
  try {
    addDefer(dir, "비밀번호 8자 검증");
    addDefer(dir, "중복 이메일 차단");
    assert.deepEqual(activeDeferItems(dir).sort(), ["비밀번호 8자 검증", "중복 이메일 차단"].sort());
    // 텍스트 부분 매칭 해결
    const r = resolveDefer(dir, "비밀번호");
    assert.ok(r);
    assert.equal(activeDeferItems(dir).length, 1);
    assert.equal(unresolvedDefers(dir).length, 1);
    // 인덱스 해결
    resolveDefer(dir, "2");
    assert.equal(activeDeferItems(dir).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spec-store: addSpecCase → readSpecCases → clearSpec 흐름", () => {
  const dir = tmp();
  try {
    addSpecCase(dir, "로그인 빈 자격증명 거부");
    addSpecCase(dir, "중복 이메일 인라인 에러");
    const cases = readSpecCases(dir);
    assert.equal(cases.length, 2);
    assert.ok(cases.some((c) => c.includes("빈 자격증명")));
    assert.ok(cases.some((c) => c.includes("중복 이메일")));
    // clear 후 케이스 0
    clearSpec(dir);
    assert.equal(readSpecCases(dir).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addSpecCase: 멀티라인·장문 입력을 한 줄로 정규화", () => {
  const dir = tmp();
  try {
    addSpecCase(dir, "케이스\n둘째 줄\n셋째 줄");
    let cases = readSpecCases(dir);
    assert.equal(cases.length, 1); // 줄바꿈→공백 → 한 줄로 합쳐짐
    assert.match(cases[0], /케이스 둘째 줄 셋째 줄/);
    // 길이 상한(500자) 절단
    addSpecCase(dir, "x".repeat(1000));
    cases = readSpecCases(dir);
    assert.ok(cases[1].length <= 500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizeCase: trim + 줄바꿈→공백 + 길이 상한 절단 (단일 소스)", () => {
  assert.equal(normalizeCase("  앞뒤 공백  "), "앞뒤 공백");
  assert.equal(normalizeCase("줄1\n줄2\n줄3"), "줄1 줄2 줄3");
  assert.equal(normalizeCase("a\n\n\nb"), "a b"); // 연속 개행도 단일 공백
  assert.equal(normalizeCase("x".repeat(1000)).length, MAX_CASE); // 500자 절단
});

test("addDefer: 멀티라인·장문 입력을 한 줄로 정규화 (spec add와 대칭, W2)", () => {
  const dir = tmp();
  try {
    addDefer(dir, "미룬케이스\n둘째 줄\n셋째 줄");
    const items = activeDeferItems(dir);
    assert.equal(items.length, 1);
    assert.match(items[0], /미룬케이스 둘째 줄 셋째 줄/); // 줄바꿈→공백
    assert.doesNotMatch(items[0], /\n/); // 개행 제거됨
    // 길이 상한(500자) 절단 — spec add와 동일 상한
    addDefer(dir, "y".repeat(1000));
    assert.ok(activeDeferItems(dir)[1].length <= 500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shouldCacheVerdict: 명세 있는 정상 pass만 캐시, fail-open·block·빈명세는 캐시 안 함", () => {
  // 명세 있고(specEmpty=false) 정상 pass → 캐시
  assert.equal(shouldCacheVerdict({ verdict: "pass", missing: [], reason: "ok" }, false), true);
  // fail-open pass는 캐시 제외 (일시 장애가 작업단위 내내 게이트 무력화 방지)
  assert.equal(
    shouldCacheVerdict({ verdict: "pass", missing: [], reason: "x", failOpen: true }, false),
    false,
  );
  assert.equal(shouldCacheVerdict({ verdict: "block", missing: [], reason: "y" }, false), false);
  // 빈 명세 pass는 절대 캐시 안 함 — 빈-spec hash는 상수라 캐시 시 게이트 영구 우회(06-22 결함)
  assert.equal(shouldCacheVerdict({ verdict: "pass", missing: [], reason: "ok" }, true), false);
});

test("buildSessionStartHint: 미해결 defer 있으면 목록 표면화, 없으면 빈 문자열", () => {
  // 잔여 없음 → 무출력(빈 문자열)
  assert.equal(buildSessionStartHint([]), "");
  // 미해결 항목 → 건수 + 목록
  const hint = buildSessionStartHint([
    { item: "케이스 X 미룸", at: "t", resolved: false },
    { item: "케이스 Y 미룸", at: "t", resolved: false },
  ]);
  assert.match(hint, /미해결 defer 2건/);
  assert.match(hint, /케이스 X 미룸/);
  assert.match(hint, /케이스 Y 미룸/);
});

test("buildSessionStartCommand: 셸 무관 pure 명령 (session-start)", () => {
  assert.equal(
    buildSessionStartCommand("/x/dist/cli.js"),
    'node "/x/dist/cli.js" hook session-start',
  );
});

test("ensureSessionStartHook: matcher startup|resume로 멱등 등록", () => {
  const s = {};
  assert.equal(ensureSessionStartHook(s, "/x/dist/cli.js"), true); // 신규 추가
  assert.equal(s.hooks.SessionStart[0].matcher, "startup|resume");
  assert.equal(
    s.hooks.SessionStart[0].hooks[0].command,
    'node "/x/dist/cli.js" hook session-start',
  );
  // 멱등 — 두 번째 호출은 추가 안 함
  assert.equal(ensureSessionStartHook(s, "/x/dist/cli.js"), false);
  assert.equal(s.hooks.SessionStart.length, 1);
});

test("buildBlockReason: 시나리오 미지정이면 도출·등록 루프를 지시", () => {
  const r = buildBlockReason(
    { verdict: "block", missing: [], reason: "시나리오 미지정" },
    true, // specEmpty
    ".gbc/spec.md",
  );
  assert.match(r, /도출/); // 에이전트에게 시나리오 도출 지시
  assert.match(r, /gbc spec add/); // 등록 경로 안내
  assert.doesNotMatch(r, /gbc defer add/); // 누락 경로 메시지는 아님
});

test("buildBlockReason: 침묵 누락이면 defer 등록을 안내", () => {
  const r = buildBlockReason(
    { verdict: "block", missing: ["중복 이메일"], reason: "형제 케이스 누락" },
    false, // specEmpty
    "scratch.md",
  );
  assert.match(r, /gbc defer add/);
  assert.match(r, /중복 이메일/); // 누락 케이스 표시
});

test("buildPreCommand: 셸 무관 순수 명령 (키 prefix·셸 확장 없음)", () => {
  const cmd = buildPreCommand("/home/u/dist/cli.js");
  assert.equal(cmd, 'node "/home/u/dist/cli.js" hook pre-tool-use');
  assert.doesNotMatch(cmd, /ANTHROPIC_API_KEY/); // 셸 키주입 없음(코드가 키 해석)
  assert.doesNotMatch(cmd, /\$\(/); // $(cat ...) 셸 확장 없음
});

test("buildPreCommand: Windows 경로 백슬래시 보존 (이중 이스케이프 금지)", () => {
  // 난 WSL이라 native Windows 실행은 못 하지만, Windows 경로 입력→출력으로 요구를 검증한다.
  const cmd = buildPreCommand("C:\\Users\\me\\dist\\cli.js");
  assert.equal(cmd, 'node "C:\\Users\\me\\dist\\cli.js" hook pre-tool-use');
  assert.doesNotMatch(cmd, /\\\\/); // 백슬래시가 \\로 안 깨짐 (JSON.stringify가 파일기록 시 처리)
});

test("normalizeHooks: 기존 hook(keyless·옛 bash 키주입)을 pure 명령으로 정규화(멱등)", () => {
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: "Edit|Write|MultiEdit",
          // 옛 bash 키주입 prefix 형태
          hooks: [
            {
              type: "command",
              command:
                'ANTHROPIC_API_KEY="$(cat "$HOME/.gbc/api-key")" node "/x/dist/cli.js" hook pre-tool-use',
            },
          ],
        },
      ],
    },
  };
  const n = normalizeHooks(settings, "/x/dist/cli.js");
  assert.equal(n, 1); // 1건 정규화
  assert.equal(
    settings.hooks.PreToolUse[0].hooks[0].command,
    'node "/x/dist/cli.js" hook pre-tool-use',
  );
  assert.doesNotMatch(settings.hooks.PreToolUse[0].hooks[0].command, /ANTHROPIC_API_KEY/);
  // 이미 pure → 재정규화 안 함(멱등)
  assert.equal(normalizeHooks(settings, "/x/dist/cli.js"), 0);
});

// ---------- ②init-staleness 감지 + 업데이트 안내 (ST3) ----------
const CLI = "/x/dist/cli.js";
function pureSettings() {
  return {
    hooks: {
      PreToolUse: [
        { matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: `node "${CLI}" hook pre-tool-use` }] },
      ],
      SessionStart: [
        { matcher: "startup|resume", hooks: [{ type: "command", command: `node "${CLI}" hook session-start` }] },
      ],
    },
  };
}
function staleSettings() {
  // 옛 bash 키주입 PreToolUse + SessionStart 누락 (0.2.1 이하 init 코호트)
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "Edit|Write|MultiEdit",
          hooks: [
            { type: "command", command: `ANTHROPIC_API_KEY="$(cat "$HOME/.gbc/api-key")" node "${CLI}" hook pre-tool-use` },
          ],
        },
      ],
    },
  };
}

test("hasStalePreToolUse / hasSessionStartHook: read-only 감지(비파괴)", () => {
  const pure = pureSettings();
  assert.equal(hasStalePreToolUse(pure, CLI), false);
  assert.equal(hasSessionStartHook(pure), true);
  const stale = staleSettings();
  assert.equal(hasStalePreToolUse(stale, CLI), true);
  assert.equal(hasSessionStartHook(stale), false);
  // 감지는 settings를 수정하지 않는다(normalizeHooks와 달리)
  assert.equal(stale.hooks.PreToolUse[0].hooks[0].command.includes("ANTHROPIC_API_KEY"), true);
});

test("buildInitStalenessNotice: 구버전/누락이면 init 재실행 안내, 최신이면 빈 문자열", () => {
  assert.equal(buildInitStalenessNotice(pureSettings(), CLI), ""); // 최신 → 무출력
  const n1 = buildInitStalenessNotice(staleSettings(), CLI);
  assert.match(n1, /gbc init/);
  assert.match(n1, /SessionStart/); // 누락 사유 명시
  // PreToolUse는 pure지만 SessionStart만 누락된 코호트도 감지
  const onlyMissingSession = { hooks: { PreToolUse: pureSettings().hooks.PreToolUse } };
  assert.match(buildInitStalenessNotice(onlyMissingSession, CLI), /gbc init/);
});

test("notice dedup: 세션당 1회 (markNotified 후 같은 세션은 wasNotified=true)", () => {
  const dir = tmp();
  try {
    assert.equal(wasNotified(dir, "S1"), false); // 최초
    markNotified(dir, "S1");
    assert.equal(wasNotified(dir, "S1"), true); // 같은 세션 → 이미 알림
    assert.equal(wasNotified(dir, "S2"), false); // 다른 세션 → 다시 알림 대상
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildUpdateNotice: GBC_NO_UPDATE_NOTICE=1 opt-out, 아니면 staleness 포함", () => {
  const prev = process.env.GBC_NO_UPDATE_NOTICE;
  try {
    process.env.GBC_NO_UPDATE_NOTICE = "1";
    assert.equal(buildUpdateNotice(staleSettings(), CLI, "0.2.3"), ""); // opt-out
    delete process.env.GBC_NO_UPDATE_NOTICE;
    assert.match(buildUpdateNotice(staleSettings(), CLI, "0.2.3"), /gbc init/); // staleness 포함
  } finally {
    if (prev === undefined) delete process.env.GBC_NO_UPDATE_NOTICE;
    else process.env.GBC_NO_UPDATE_NOTICE = prev;
  }
});

// ---------- ①version notice (ST4) ----------
test("compareVersions: major.minor.patch 숫자 비교, 비숫자는 0(거짓 안내 방지)", () => {
  assert.equal(compareVersions("0.2.2", "0.2.3"), -1);
  assert.equal(compareVersions("0.2.3", "0.2.3"), 0);
  assert.equal(compareVersions("0.3.0", "0.2.9"), 1);
  assert.equal(compareVersions("1.0.0", "0.9.9"), 1);
  assert.equal(compareVersions("0.2.3", "0.2.3-beta.1"), 0); // prerelease 무시(코어 동일)
  assert.equal(compareVersions("abc", "0.2.3"), 0); // 비숫자 → 비교 불가 → 0
});

test("buildVersionNotice: 캐시 최신 > 현재일 때만 안내(캐시만, 네트워크 없음)", () => {
  assert.match(buildVersionNotice("0.2.2", { latest: "0.2.3", checkedAt: 0 }), /신버전 0\.2\.3/);
  assert.equal(buildVersionNotice("0.2.3", { latest: "0.2.3", checkedAt: 0 }), ""); // 동일 → 무
  assert.equal(buildVersionNotice("0.2.4", { latest: "0.2.3", checkedAt: 0 }), ""); // 상위 → 무
  assert.equal(buildVersionNotice("0.2.2", null), ""); // 캐시 없음 → 무
});

test("isCacheStale: 캐시 없음 또는 24h 초과면 stale", () => {
  const now = 1_000_000_000_000;
  assert.equal(isCacheStale(null, now), true);
  assert.equal(isCacheStale({ latest: "0.2.3", checkedAt: now }, now), false);
  assert.equal(isCacheStale({ latest: "0.2.3", checkedAt: now - 25 * 3600 * 1000 }, now), true);
  assert.equal(isCacheStale({ latest: "0.2.3", checkedAt: now - 1000 }, now), false);
});

test("version cache: write → read 라운드트립", () => {
  const home = tmp();
  try {
    mkdirSync(join(home, ".gbc"), { recursive: true });
    writeVersionCache({ latest: "0.9.9", checkedAt: 12345 }, home);
    const back = readVersionCache(home);
    assert.equal(back.latest, "0.9.9");
    assert.equal(back.checkedAt, 12345);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeVersionCache: ~/.gbc 없어도 디렉토리 생성 후 기록(신규 설치 코호트, 회귀가드)", () => {
  const home = tmp(); // .gbc 미리 만들지 않음 — api-key 없는 신규 설치 상황
  try {
    writeVersionCache({ latest: "1.2.3", checkedAt: 999 }, home);
    const back = readVersionCache(home);
    assert.ok(back, "캐시가 기록되어야 함(.gbc 자동 생성)");
    assert.equal(back.latest, "1.2.3");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("buildUpdateNotice: 신버전 캐시 있으면 version 라인 포함(ST4 통합)", () => {
  const home = tmp();
  const prev = process.env.GBC_NO_UPDATE_NOTICE;
  try {
    delete process.env.GBC_NO_UPDATE_NOTICE;
    mkdirSync(join(home, ".gbc"), { recursive: true });
    writeVersionCache({ latest: "0.9.9", checkedAt: Date.now() }, home);
    // 최신 settings(staleness 없음)인데도 version 안내는 떠야 한다
    const n = buildUpdateNotice(pureSettings(), CLI, "0.2.3", home);
    assert.match(n, /신버전 0\.9\.9/);
  } finally {
    if (prev === undefined) delete process.env.GBC_NO_UPDATE_NOTICE;
    else process.env.GBC_NO_UPDATE_NOTICE = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("serializeEvent: 한 줄 JSON으로 직렬화 + parseEvents 라운드트립", () => {
  const e = {
    at: "2026-06-21T00:00:00.000Z",
    session: "sess-1",
    specHash: "abc",
    kind: "gate",
    tool: "Edit",
    decision: "block",
    missing: ["중복 이메일", "비번 길이"],
    deferCount: 0,
    specCount: 2,
  };
  const line = serializeEvent(e);
  assert.equal(line.includes("\n"), false); // 단일 라인
  const back = parseEvents(line);
  assert.equal(back.length, 1);
  assert.equal(back[0].kind, "gate");
  assert.equal(back[0].decision, "block");
  assert.deepEqual(back[0].missing, ["중복 이메일", "비번 길이"]);
  assert.equal(back[0].specCount, 2);
});

test("serializeEvent: 과대 missing[]을 캡해 라인 길이 4096 미만 보장", () => {
  const e = {
    at: "2026-06-21T00:00:00.000Z",
    session: "s",
    specHash: "h",
    kind: "gate",
    decision: "block",
    missing: Array.from({ length: 200 }, (_, i) => "x".repeat(500) + i),
  };
  const line = serializeEvent(e);
  assert.ok(line.length < 4096, `라인 길이 ${line.length} < 4096`);
  // 캡 후에도 유효 JSON으로 파싱돼야 함
  const back = parseEvents(line);
  assert.equal(back.length, 1);
});

test("parseEvents: 멀티라인 jsonl 파싱 + 깨진/빈 줄 skip", () => {
  const raw = [
    JSON.stringify({ at: "t1", session: "", specHash: "h", kind: "defer-add" }),
    "", // 빈 줄
    "{깨진 json", // 파싱 실패
    JSON.stringify({ at: "t2", session: "", specHash: "h", kind: "spec-add" }),
    "   ", // 공백 줄
  ].join("\n");
  const evs = parseEvents(raw);
  assert.equal(evs.length, 2);
  assert.deepEqual(
    evs.map((e) => e.kind),
    ["defer-add", "spec-add"],
  );
});

test("parseEvents: 빈/공백 입력은 빈 배열", () => {
  assert.deepEqual(parseEvents(""), []);
  assert.deepEqual(parseEvents("   \n  \n"), []);
});

test("computeMetrics M3: 작업단위(session)별 edit 반복 집계", () => {
  const evs = [
    // session A: 3 edits (block, block, pass)
    { at: "t1", session: "A", specHash: "h1", kind: "gate", decision: "block", missing: ["x"] },
    { at: "t2", session: "A", specHash: "h1", kind: "gate", decision: "block", missing: [] },
    { at: "t3", session: "A", specHash: "h1", kind: "gate", decision: "pass" },
    // session B: 1 edit (pass)
    { at: "t4", session: "B", specHash: "h2", kind: "gate", decision: "pass" },
  ];
  const m = computeMetrics(evs);
  assert.equal(m.m3.workUnits, 2);
  assert.equal(m.m3.totalEdits, 4);
  assert.equal(m.m3.avgEditsPerUnit, 2); // 4/2
  assert.equal(m.m3.maxEditsPerUnit, 3);
  assert.equal(m.m3.multiEditUnits, 1); // A만 >1
});

test("computeMetrics M2: 게이트적중(Σmissing) vs 도중발견(defer-add)", () => {
  const evs = [
    { at: "t1", session: "A", specHash: "h", kind: "gate", decision: "block", missing: ["a", "b"] },
    { at: "t2", session: "A", specHash: "h", kind: "gate", decision: "block", missing: ["c"] },
    { at: "t3", session: "", specHash: "h", kind: "defer-add" },
    { at: "t4", session: "A", specHash: "h", kind: "gate", decision: "pass" },
  ];
  const m = computeMetrics(evs);
  assert.equal(m.m2.gateCaught, 3); // a,b,c
  assert.equal(m.m2.blocks, 2);
  assert.equal(m.m2.deferred, 1);
  assert.equal(m.m2.midDiscoveryRatio, 0.25); // 1/(3+1)
});

test("computeMetrics M1: first pass 이후 churn만 계수(이전 변이 제외)", () => {
  const evs = [
    { at: "t1", session: "", specHash: "h", kind: "spec-add" }, // pass 이전 → 제외
    { at: "t2", session: "A", specHash: "h", kind: "gate", decision: "pass" }, // 경계
    { at: "t3", session: "", specHash: "h", kind: "spec-add" }, // 이후 → churn
    { at: "t4", session: "", specHash: "h", kind: "gate-reset" }, // 이후 → churn + reset
    { at: "t5", session: "", specHash: "h2", kind: "spec-add" }, // pass 없는 specHash → 제외
  ];
  const m = computeMetrics(evs);
  assert.equal(m.m1.resets, 1);
  assert.equal(m.m1.churnAfterPass, 2); // t3 spec-add + t4 gate-reset
  assert.match(m.m1.note, /A-mode/);
});

test("computeMetrics M1: 빈 specHash('')는 churn에서 제외(교차세션 합산 방지)", () => {
  // 빈-스펙 작업단위는 specHash=""로 기록됨 — 무관 세션 이벤트가 한 버킷에 합산되면 안 됨
  const evs = [
    { at: "t1", session: "A", specHash: "", kind: "gate", decision: "pass" },
    { at: "t2", session: "", specHash: "", kind: "defer-add" },
    { at: "t3", session: "", specHash: "", kind: "gate-reset" },
    { at: "t4", session: "", specHash: "", kind: "spec-add" },
  ];
  const m = computeMetrics(evs);
  assert.equal(m.m1.churnAfterPass, 0); // "" 버킷 전체 제외
  assert.equal(m.m1.resets, 1); // resets 자체 카운트는 유지
  // 비어있지 않은 specHash는 정상 churn 집계
  const evs2 = [
    { at: "t1", session: "A", specHash: "h", kind: "gate", decision: "pass" },
    { at: "t2", session: "", specHash: "h", kind: "spec-add" },
  ];
  assert.equal(computeMetrics(evs2).m1.churnAfterPass, 1);
});

test("computeMetrics: 빈 입력 안전(0, 0으로 나눔 없음)", () => {
  const m = computeMetrics([]);
  assert.equal(m.totalEvents, 0);
  assert.equal(m.m3.avgEditsPerUnit, 0);
  assert.equal(m.m2.midDiscoveryRatio, 0);
  assert.equal(m.m1.churnAfterPass, 0);
});

test("logEvent: events.jsonl에 append → parseEvents/computeMetrics 라운드트립", () => {
  const dir = tmp();
  try {
    logEvent(dir, { at: "t1", session: "S", specHash: "h", kind: "gate", tool: "Edit", decision: "block", missing: ["케이스A"] });
    logEvent(dir, { at: "t2", session: "S", specHash: "h", kind: "gate", tool: "Edit", decision: "pass" });
    logEvent(dir, { at: "t3", session: "", specHash: "h", kind: "defer-add" });
    const raw = readFileSync(join(dir, ".gbc", "events.jsonl"), "utf8");
    const evs = parseEvents(raw);
    assert.equal(evs.length, 3);
    const m = computeMetrics(evs);
    assert.equal(m.m3.totalEdits, 2); // gate 이벤트 2건
    assert.equal(m.m2.gateCaught, 1); // 케이스A
    assert.equal(m.m2.deferred, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("logEvent: GBC_NO_METRICS=1이면 기록 안 함(opt-out)", () => {
  const dir = tmp();
  const prev = process.env.GBC_NO_METRICS;
  process.env.GBC_NO_METRICS = "1";
  try {
    logEvent(dir, { at: "t1", session: "S", specHash: "h", kind: "gate", decision: "pass" });
    let exists = true;
    try {
      readFileSync(join(dir, ".gbc", "events.jsonl"), "utf8");
    } catch {
      exists = false;
    }
    assert.equal(exists, false); // 파일 미생성
  } finally {
    if (prev === undefined) delete process.env.GBC_NO_METRICS;
    else process.env.GBC_NO_METRICS = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveApiKey: env 우선 (ANTHROPIC_API_KEY 있으면 그 값)", () => {
  const key = resolveApiKey({
    env: { ANTHROPIC_API_KEY: "sk-env" },
    homeDir: "/nonexistent",
    readFile: () => {
      throw new Error("파일 안 읽어야 함");
    },
  });
  assert.equal(key, "sk-env");
});

test("resolveApiKey: env 없으면 ~/.gbc/api-key 파일에서(+ trailing newline trim)", () => {
  const key = resolveApiKey({
    env: {},
    homeDir: "/home/u",
    readFile: (p) => {
      assert.match(p.replace(/\\/g, "/"), /\/home\/u\/\.gbc\/api-key$/);
      return "sk-file\n"; // bash $(cat)와 달리 readFileSync는 안 벗기므로 코드가 trim
    },
  });
  assert.equal(key, "sk-file"); // 개행 제거됨
});

test("resolveApiKey: env도 파일도 없으면 null (파일 읽기 실패 안전)", () => {
  const key = resolveApiKey({
    env: {},
    homeDir: "/home/u",
    readFile: () => {
      throw new Error("ENOENT");
    },
  });
  assert.equal(key, null);
});

test("resolveApiKey: 파일이 공백뿐이면 null", () => {
  const key = resolveApiKey({ env: {}, homeDir: "/h", readFile: () => "  \n " });
  assert.equal(key, null);
});

test("safeModel: 셸 안전 토큰만 통과, 메타문자는 기본값(W3 win32 argv 인젝션 차단)", () => {
  assert.equal(safeModel("claude-haiku-4-5"), "claude-haiku-4-5");
  assert.equal(safeModel("a.b-c_1"), "a.b-c_1"); // 영숫자/./-/_ 허용
  assert.equal(safeModel("haiku; rm -rf /"), "claude-haiku-4-5"); // ; 공백 → 기본값
  assert.equal(safeModel("$(whoami)"), "claude-haiku-4-5"); // 명령치환 → 기본값
  assert.equal(safeModel("a|b"), "claude-haiku-4-5"); // 파이프 → 기본값
  assert.equal(safeModel(""), "claude-haiku-4-5"); // 빈 값 → 기본값
});

test("gate-state: markGated/isGated/reset 작업단위 1회 캐시", () => {
  const dir = tmp();
  try {
    const h1 = computeSpecHash("spec v1");
    assert.equal(isGated(dir, h1), false);
    markGated(dir, h1, "ok");
    assert.equal(isGated(dir, h1), true);
    // 명세가 바뀌면(다른 해시) 미게이트로 간주 → 재게이트
    const h2 = computeSpecHash("spec v2");
    assert.equal(isGated(dir, h2), false);
    // 리셋하면 다시 미게이트
    markGated(dir, h1, "ok");
    resetGate(dir);
    assert.equal(isGated(dir, h1), false);
    assert.ok(loadState(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
