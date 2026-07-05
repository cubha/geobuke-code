#!/usr/bin/env node
// gbc — 거북이코드 CLI. zero-dep 인자 파싱(핫패스 보호).
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  lstatSync,
} from "node:fs";

import { runPreToolUse, runStop, runSessionStart } from "./hook.js";
import {
  loadPlanSpec,
  computeSpecHash,
  addSpecCase,
  readSpecCases,
  clearSpec,
  archiveSpec,
} from "./spec.js";
import { loadState, resetGate } from "./state.js";
import { addDefer, loadDefers, resolveDefer, startDefer, withdrawDefer, reopenDefer, isClosedStatus } from "./defer.js";
import { loadRepos, addRepo, removeRepo } from "./repos.js";
import { readPendingReview, clearPendingReview, resolveRefs } from "./review.js";
import { isStopHintMuted, setStopHintMuted, isGoldenCapture, setGoldenCapture } from "./config.js";
import { loadGolden, clearGolden, diffVerdict, summarizeReplay } from "./golden.js";
import type { ReplayOutcome } from "./golden.js";
import type { VerdictKind } from "./types.js";
import { selectedTransport } from "./judge.js";
import { runVerify } from "./verify.js";
import { scaffoldVerify } from "./scaffold.js";
import type { CaseVerdict } from "./types.js";
import { buildPreCommand, normalizeHooks, ensureSessionStartHook, DEV_PLACEHOLDER, assessRepoHealth } from "./install.js";
import { readProjectSettings } from "./notice.js";
import {
  isCacheStale,
  readVersionCache,
  refreshVersionCache,
} from "./version.js";
import { logEvent, parseEvents, computeMetrics, tagEventsWithRepo } from "./metrics.js";
import type { EventKind } from "./metrics.js";

const CLI_PATH = fileURLToPath(import.meta.url);
const PKG_ROOT = join(dirname(CLI_PATH), ".."); // dist/cli.js → 패키지 루트

/** 설치된 패키지 버전(업데이트 안내 비교 기준). 읽기 실패 시 "". */
function readPkgVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version as string) ?? "";
  } catch {
    return "";
  }
}
const PKG_VERSION = readPkgVersion();

/** ~/.gbc/api-key 존재 여부 — 있으면 hook에 키 주입(빠른 haiku 경로). */
function hasApiKey(): boolean {
  return existsSync(join(homedir(), ".gbc", "api-key"));
}
function stopCommand(hookPath: string): string {
  return `node "${hookPath}" hook stop`;
}

function nowIso(): string {
  try {
    return new Date().toISOString();
  } catch {
    return "";
  }
}

/**
 * 현재 작업단위 명세 해시 (CLI 이벤트의 specHash 상관 키).
 * 빈 spec은 ""(센티넬) — M1 churn 교차세션 합산 방지(computeMetrics가 제외).
 */
function curHash(cwd: string): string {
  const text = loadPlanSpec(cwd).text;
  return text.trim() === "" ? "" : computeSpecHash(text);
}

/** CLI 변이 이벤트를 events.jsonl에 기록(메트릭 상관용). specHash는 변이 전 값을 넘긴다. */
function logCli(cwd: string, kind: EventKind, specHash: string): void {
  logEvent(cwd, { at: nowIso(), session: "", specHash, kind });
}

function nowStamp(): string {
  try {
    return new Date().toISOString().replace(/[:.]/g, "-");
  } catch {
    return "backup";
  }
}

// ---------- gbc init ----------
async function cmdInit(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const yes = args.includes("--yes") || args.includes("-y");
  // --dev: hook 명령에 절대경로(CLI_PATH) 대신 ${CLAUDE_PROJECT_DIR} placeholder를 굽는다.
  // geobuke-code 자기 repo 도그푸딩 전용(dist 위치가 옮겨다녀도 안 깨짐). 기본(false)은 절대경로.
  const dev = args.includes("--dev");
  // --no-register: 크로스-repo 레지스트리(~/.gbc/repos.json) 자동등록 opt-out(기본=등록).
  const noRegister = args.includes("--no-register");
  const hookPath = dev ? DEV_PLACEHOLDER : CLI_PATH;
  const claudeDir = join(cwd, ".claude");
  const settingsPath = join(claudeDir, "settings.json");
  // 설치 대상 스킬들(제품소스 skills/<name>/SKILL.md → .claude/skills/<name>/SKILL.md).
  const skillNames = ["gate", "gbc-mute", "gbc-monitor"];

  if (!yes) {
    console.log(`🐢 gbc init — 다음을 수행합니다 (프로젝트 로컬만, 전역 ~/.claude 미변경):

  대상 프로젝트: ${cwd}
  1) ${settingsPath} 에 PreToolUse(Edit|Write) + Stop + SessionStart hook 추가 (머지·멱등)
     - 기존 settings.json 있으면 백업: settings.json.bak-<시각>
  2) ${join(claudeDir, "skills")} 에 ${skillNames.map((n) => `/${n}`).join(", ")} 스킬 설치
  3) hook 명령: ${buildPreCommand(hookPath)}${dev ? "  (--dev: ${CLAUDE_PROJECT_DIR} placeholder)" : ""}
  4) ${noRegister ? "크로스-repo 레지스트리 등록 생략 (--no-register)" : "이 repo를 크로스-repo 레지스트리(~/.gbc/repos.json)에 등록 (opt-out: --no-register)"}
${
  hasApiKey()
    ? "     (~/.gbc/api-key 감지됨 → 빠른 haiku API 경로로 동작)"
    : "     (~/.gbc/api-key 없음 → claude -p 폴백. 빠른 경로 원하면 키 파일 생성)"
}
  실행하려면: gbc init --yes
`);
    return;
  }

  mkdirSync(claudeDir, { recursive: true });

  // settings.json 머지
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    const backup = `${settingsPath}.bak-${nowStamp()}`;
    copyFileSync(settingsPath, backup);
    console.log(`  백업: ${backup}`);
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {
      console.error(`  ⚠️ 기존 settings.json 파싱 실패 — 중단(수동 확인 필요). 백업은 보존됨.`);
      process.exit(1);
    }
  }

  const hooks = (settings.hooks ??= {}) as Record<string, unknown[]>;
  const serialized = JSON.stringify(settings);

  // PreToolUse (멱등). 신규면 추가, 이미 있으면 옛 명령(keyless·bash 키주입)을 pure로 정규화.
  if (!serialized.includes("hook pre-tool-use")) {
    (hooks.PreToolUse ??= []).push({
      matcher: "Edit|Write|MultiEdit",
      hooks: [{ type: "command", command: buildPreCommand(hookPath) }],
    });
    console.log(`  + PreToolUse hook 추가`);
  } else {
    const n = normalizeHooks(settings, CLI_PATH);
    if (n > 0) console.log(`  ↑ PreToolUse hook 정규화 (${n}건, 셸 무관 명령으로)`);
    else console.log(`  = PreToolUse hook 이미 표준 (skip)`);
  }

  // Stop (멱등)
  if (!serialized.includes("hook stop")) {
    (hooks.Stop ??= []).push({
      hooks: [{ type: "command", command: stopCommand(hookPath) }],
    });
    console.log(`  + Stop hook 추가`);
  } else {
    console.log(`  = Stop hook 이미 존재 (skip)`);
  }

  // SessionStart (멱등) — 세션 진입(startup|resume) 시 미해결 defer 알림
  if (ensureSessionStartHook(settings, hookPath)) {
    console.log(`  + SessionStart hook 추가`);
  } else {
    console.log(`  = SessionStart hook 이미 존재 (skip)`);
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");

  // 스킬 설치 (gate + gbc-mute)
  for (const name of skillNames) {
    const src = join(PKG_ROOT, "skills", name, "SKILL.md");
    if (existsSync(src)) {
      const destDir = join(claudeDir, "skills", name);
      mkdirSync(destDir, { recursive: true });
      copyFileSync(src, join(destDir, "SKILL.md"));
      console.log(`  + /${name} 스킬 설치`);
    }
  }

  const transport = selectedTransport();
  console.log(`
✅ 설치 완료. 트랜스포트: ${transport}${
    transport === "cli"
      ? "  (ANTHROPIC_API_KEY 설정 시 직접 API로 ~1–3s, 미설정 시 claude -p 폴백 ~13–20s)"
      : ""
  }
   계획 명세는 .gbc/spec.md 에 작성하세요(없으면 시나리오 미지정으로 차단 → 도출·검증 루프 발동: 에이전트가 요청에서 시나리오를 도출해 사용자 검증 후 'gbc spec add'로 등록).`);

  // 크로스-repo 레지스트리 자동등록(~/.gbc/repos.json, 멱등 dedup) — 등록된 타 repo의 미해결
  // defer를 SessionStart에 환기(0.2.9 buildCrossRepoHint)하려면 레지스트리가 차 있어야 한다.
  // 이 repo 자신은 cwd 제외라 즉시 가시성 0이지만, N개 누적되면 서로의 잔여를 환기(passive fill).
  // ~/.gbc append만(별 네임스페이스) → 프로젝트 .claude/settings.json 미접촉(install-safe 보존).
  // --no-register로 opt-out. 등록 실패는 init 본체를 깨지 않는다(best-effort).
  if (!noRegister) {
    try {
      addRepo(cwd);
      console.log(`  + 크로스-repo 레지스트리 등록 (~/.gbc/repos.json, opt-out: --no-register)`);
    } catch {
      /* 레지스트리 쓰기 실패는 무시(fail-silent) */
    }
  }

  // 설치 직후 버전 캐시 seed — 신버전 안내(①)가 "설치만 하고 init 안 한" 코호트에도
  // 신뢰성 있게 동작하도록(SessionStart 없는 환경의 유일한 seed 지점일 수 있음). best-effort.
  try {
    if (process.env.GBC_NO_UPDATE_NOTICE !== "1" && isCacheStale(readVersionCache())) {
      await refreshVersionCache();
    }
  } catch {
    /* 갱신 실패는 무시(fail-silent) */
  }
}

// ---------- gbc status ----------
async function cmdStatus(): Promise<void> {
  // 버전 캐시가 stale면 갱신(status는 대화형이라 짧은 대기 허용). 실패는 무시.
  try {
    if (process.env.GBC_NO_UPDATE_NOTICE !== "1" && isCacheStale(readVersionCache())) {
      await refreshVersionCache();
    }
  } catch {
    /* 갱신 실패 무시 */
  }
  const cwd = process.cwd();
  const { text, source } = loadPlanSpec(cwd);
  const hash = computeSpecHash(text);
  const state = loadState(cwd);
  const defers = loadDefers(cwd);
  const unresolved = defers.filter((d) => !isClosedStatus(d.status));
  const inProgress = defers.filter((d) => d.status === "in_progress").length;

  console.log(`🐢 거북이 게이트 상태 — ${cwd}
  버전: ${PKG_VERSION || "(불명)"}
  트랜스포트: ${selectedTransport()}
  명세 소스: ${source} ${text ? `(${text.length}자)` : "(비어있음 → 모든 코드변경 차단)"}
  명세 해시: ${hash}
  작업단위 게이트: ${state && state.specHash === hash && state.gated ? "통과됨(이 단위 재게이트 안 함)" : "미통과(다음 편집에서 발동)"}
  defer: 전체 ${defers.length} / 미해결 ${unresolved.length} (진행중 ${inProgress} · 미착수 ${unresolved.length - inProgress})
  Stop 리마인드: ${isStopHintMuted(cwd) ? "🔕 음소거 (해제: /gbc-mute)" : "🔔 켜짐"}`);
  if (unresolved.length > 0) {
    console.log(
      unresolved
        .map((d, i) => `    ${i + 1}. ${d.status === "in_progress" ? "▶[진행중] " : ""}${d.item}`)
        .join("\n"),
    );
  }
  // 신버전 업데이트 안내(buildVersionNotice)는 여기서 출력하지 않는다 — 안내 자리는
  // SessionStart·PreToolUse 자동 채널 전용이고, status는 명시 진단 명령이라 나그 부적절.
  // (캐시 stale-refresh는 위에서 유지: SessionStart seed 신선도 목적, 표시와 무관.)
}

// ---------- gbc defer ----------
function cmdDefer(args: string[]): void {
  const cwd = process.cwd();
  const sub = args[0];
  if (sub === "add") {
    const item = args.slice(1).join(" ").trim();
    if (!item) {
      console.error('사용: gbc defer add "<케이스 설명>"');
      process.exit(1);
    }
    if (addDefer(cwd, item).added) {
      logCli(cwd, "defer-add", curHash(cwd));
      console.log(`🐢 미룸 등록: ${item}`);
    } else {
      console.log(`🐢 이미 미해결로 미룬 항목 — 중복 등록 skip: ${item}`);
    }
  } else if (sub === "mute" || sub === "unmute") {
    const muted = sub === "mute";
    setStopHintMuted(cwd, muted);
    if (muted) {
      console.log(
        "🔕 Stop 리마인드 음소거됨 — 대화 종료마다 뜨던 defer 알림을 끕니다.\n" +
          "   (SessionStart 진입 시엔 계속 표시 · 해제는 'gbc defer unmute')",
      );
    } else {
      console.log("🔔 Stop 리마인드 음소거 해제됨 — 대화 종료 시 미해결 defer 알림이 다시 표시됩니다.");
    }
  } else if (sub === "list") {
    const defers = loadDefers(cwd);
    if (isStopHintMuted(cwd)) {
      console.log("🔕 Stop 리마인드 음소거 중 (해제: gbc defer unmute)");
    }
    if (defers.length === 0) {
      console.log("(미룬 항목 없음)");
      return;
    }
    const label: Record<string, string> = {
      open: "미해결",
      in_progress: "진행중",
      resolved: "해결",
      withdrawn: "철회",
    };
    defers.forEach((d, i) => console.log(`${i + 1}. [${label[d.status]}] ${d.item}`));
  } else if (sub === "start" || sub === "resolve" || sub === "withdraw" || sub === "reopen") {
    const ref = args.slice(1).join(" ").trim();
    if (!ref) {
      console.error(`사용: gbc defer ${sub} <번호|텍스트|all>`);
      process.exit(1);
    }
    const fn =
      sub === "start"
        ? startDefer
        : sub === "resolve"
          ? resolveDefer
          : sub === "withdraw"
            ? withdrawDefer
            : reopenDefer;
    const verb =
      sub === "start"
        ? "착수"
        : sub === "resolve"
          ? "해결"
          : sub === "withdraw"
            ? "철회(완료 아님)"
            : "되돌림(open)";
    const changed = fn(cwd, ref);
    if (changed.length > 0) {
      logCli(cwd, `defer-${sub}`, curHash(cwd));
      console.log(`🐢 ${verb} ${changed.length}건: ${changed.map((d) => d.item).join(", ")}`);
    } else {
      console.log(`매칭되는 항목 없음(0건): ${ref}`);
    }
  } else {
    console.error("사용: gbc defer <add|list|start|resolve|withdraw|reopen|mute|unmute> ...");
    process.exit(1);
  }
}

// ---------- gbc spec ----------
function cmdSpec(args: string[]): void {
  const cwd = process.cwd();
  const sub = args[0];
  if (sub === "add") {
    const item = args.slice(1).join(" ").trim();
    if (!item) {
      console.error('사용: gbc spec add "<케이스/시나리오>"');
      process.exit(1);
    }
    const beforeHash = curHash(cwd); // 변이 전 해시 = 수정 대상 작업단위와 상관
    if (addSpecCase(cwd, item)) {
      logCli(cwd, "spec-add", beforeHash);
      console.log(`🐢 명세 등록: ${item}`);
    } else {
      console.log(`🐢 이미 등록된 케이스 — 중복 등록 skip: ${item}`);
    }
  } else if (sub === "show") {
    const cases = readSpecCases(cwd);
    if (cases.length === 0) {
      console.log("(등록된 케이스 없음 — .gbc/spec.md 비어있음)");
      return;
    }
    cases.forEach((c, i) => console.log(`${i + 1}. ${c}`));
  } else if (sub === "clear") {
    const beforeHash = curHash(cwd);
    clearSpec(cwd);
    logCli(cwd, "spec-clear", beforeHash);
    console.log("🐢 명세 비움 — 다음 작업단위로 깨끗이 넘어갑니다.");
  } else {
    console.error("사용: gbc spec <add|show|clear> ...");
    process.exit(1);
  }
}

// ---------- gbc done ----------
/**
 * 작업단위 명시 종료(ST3). spec.md 본문을 아카이브→비우고 게이트를 리셋한다.
 * drift 근본수정: "완료" 이벤트 부재로 옛 케이스가 누적·부활하던 것을, 명시적 완료 신호로 닫는다.
 * gate reset 로직(resetGate)은 변경하지 않고 그대로 호출만 한다(재게이트 의미 보존).
 * defer는 건드리지 않는다 — 미해결 defer는 작업단위를 넘어 이월되는 별도 수명주기다.
 */
function cmdDone(): void {
  const cwd = process.cwd();
  const beforeHash = curHash(cwd);
  const archived = archiveSpec(cwd);
  logCli(cwd, "done", beforeHash);
  resetGate(cwd);
  if (archived) {
    console.log(`🐢 작업단위 종료 — 명세 아카이브: ${archived}`);
  } else {
    console.log("🐢 작업단위 종료 — 비울 명세가 없습니다(이미 비어 있음).");
  }
  console.log("   게이트 리셋 완료. 다음 작업단위는 새 명세로 시작하세요('gbc spec add').");
}

// ---------- gbc verify ----------
/** 케이스 판정 1줄 심볼. */
function verifySymbol(c: CaseVerdict): string {
  if (c.level === "verified") return c.status === "pass" ? "✅ verified" : "❌ verified·실패";
  if (c.level === "reviewed") return c.status === "pass" ? "🟡 reviewed" : "🟠 reviewed·미충족";
  return "⚪ unverifiable";
}

/**
 * 사후 결과검증(post-impl verify) — spec 케이스를 증거와 대조해 판정 사다리로 리포트한다.
 * gbc는 테스트를 *실행하지 않고* 표준 결과(JUnit XML)를 읽거나 LLM 독해(reviewed)로 판정한다.
 * failed·unverifiable 케이스는 defer 후보로 *제안만* 한다 — 자동 등록·pending-review 재사용 안 함
 * (자동 defer는 누적병 재발+"defer=사람 선언" 원칙 위반 → 사람이 분류).
 */
/**
 * gbc verify --init — 러너 감지→JUnit 배선 스캐폴딩(0.6.0 ST-B+C). 기록은 .gbc/ 하위 템플릿만,
 * 사용자 파일(package.json 등)은 수정하지 않는다. 실행도 하지 않는다(안내 출력만 — RCE 불변식 보존).
 */
function cmdVerifyInit(): void {
  const cwd = process.cwd();
  const plan = scaffoldVerify(cwd);
  console.log(`🐢 verify 배선 스캐폴딩 — 감지 러너: ${plan.runner}`);
  for (const f of plan.files) console.log(`  📄 생성: ${f.rel}`);
  for (const line of plan.instructions) console.log(`  ${line}`);
  console.log(
    `  이후: 러너를 위 배선으로 실행해 결과를 만들고, spec 케이스에 '::test <테스트명>' 바인딩 후 'gbc verify'.`,
  );
}

async function cmdVerify(args: string[] = []): Promise<void> {
  if (args[0] === "--init") return cmdVerifyInit();
  const cwd = process.cwd();
  const report = await runVerify(cwd);
  logCli(cwd, "verify", curHash(cwd));

  if (report.cases.length === 0) {
    console.log(
      "🐢 검증할 spec 케이스가 없습니다.\n" +
        "   .gbc/spec.md에 케이스 등록 후 검증 바인딩을 붙이세요: '<케이스> ::test <테스트명>' 또는 '::file <경로>'.",
    );
    return;
  }

  const by = (l: CaseVerdict["level"]) => report.cases.filter((c) => c.level === l).length;
  console.log(`🐢 사후 결과검증 — ${cwd}
  케이스 ${report.cases.length} · ✅verified ${by("verified")} · 🟡reviewed ${by("reviewed")} · ⚪unverifiable ${by("unverifiable")}`);
  // provenance 신선도(0.6.0) — stale이면 이미 runVerify가 unverifiable로 강등했다(경고는 원인 고지).
  const p = report.provenance;
  if (p.stale) {
    console.log(
      `  ⚠️ 결과파일이 마지막 편집보다 오래됨(결과 ${p.junitMtime} < 편집 ${p.lastEditAt}) — verified를 unverifiable로 강등. 러너 재실행 후 다시 verify하세요.`,
    );
  } else if (by("verified") > 0 && p.unknown) {
    console.log("  ⓘ verified 신선도 미평가(편집 이벤트 없음) — 코드 변경 후엔 러너를 재실행하고 verify하세요.");
  } else if (by("verified") > 0) {
    // "마지막 편집"=gate pass/cached/failopen 집계 — ask-승인된 block 편집은 미포함(절대 보증 아님).
    console.log(`  ⓘ verified 신선 — 결과(${p.junitMtime}) ≥ 마지막 관측 편집(${p.lastEditAt}). (게이트 관측 기준 — 절대 보증 아님)`);
  }
  console.log("");
  for (const c of report.cases) {
    console.log(`  ${verifySymbol(c)}  ${c.case}\n      └ ${c.evidence}`);
  }

  // 미해결 후보 = 실패(verified·fail / reviewed·미충족) + 미검증(unverifiable). 제안만.
  const candidates = report.cases.filter((c) => c.status === "fail" || c.level === "unverifiable");
  if (candidates.length === 0) {
    console.log("\n✅ 모든 케이스가 verified/reviewed 통과.");
    return;
  }
  console.log(`\n→ 미해결 후보 ${candidates.length}건 — 자동 등록 안 함(사람이 분류):`);
  // 케이스에 쌍따옴표가 있으면 복붙 시 셸 따옴표 파싱이 깨진다(security-auditor S3) → 이스케이프.
  for (const c of candidates) console.log(`    gbc defer add "${c.case.replace(/"/g, '\\"')}"`);
  console.log(
    "  (검증 강화: 케이스에 '::test <테스트명>'[러너 결과] 또는 '::file <경로>'[코드 독해] 바인딩 추가)\n" +
      "  ⚠️ reviewed/unverifiable는 동작 증명이 아니다 — verified만 테스트 실행으로 증명된 통과.",
  );
}

// ---------- gbc gate ----------
async function cmdGate(args: string[]): Promise<void> {
  const cwd = process.cwd();
  if (args[0] === "reset") {
    logCli(cwd, "gate-reset", curHash(cwd));
    resetGate(cwd);
    console.log("🐢 작업단위 게이트 리셋 — 다음 편집에서 다시 발동합니다.");
  } else if (args[0] === "review") {
    cmdGateReview(cwd, args.slice(1));
  } else if (args[0] === "snapshot") {
    await cmdGateSnapshot(cwd, args.slice(1));
  } else {
    console.error("사용: gbc gate <reset|review|snapshot>");
    process.exit(1);
  }
}

/**
 * 골든셋 캡처 + 판정 드리프트 회귀락(A2). 캡처는 opt-in(hook이 judge 출력을 .gbc/golden.json에 로컬
 * 저장 — edit 본문 포함이라 gitignore·로컬 pre-flight 전용). replay는 각 케이스를 judge temp 0으로
 * 재판정해 캡처 시점과 비교, 판정 뒤집힘(decisionFlip)이 있으면 exit 1(로컬 회귀 게이트).
 */
async function cmdGateSnapshot(cwd: string, args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "on") {
    setGoldenCapture(cwd, true);
    console.log(
      "🐢 골든셋 캡처 ON — 이제 judge가 평가하는 cache-miss 편집이 .gbc/golden.json에 기록됩니다.\n" +
        "   ⚠️ 캡처되는 편집 본문은 'gbc gate snapshot replay' 시 Anthropic API(haiku)로 전송됩니다.\n" +
        "   (특정 편집을 캡처하려면 'gbc gate reset' 후 그 편집 수행. 끄기: gbc gate snapshot off)",
    );
  } else if (sub === "off") {
    setGoldenCapture(cwd, false);
    console.log("🐢 골든셋 캡처 OFF.");
  } else if (sub === "status" || sub === undefined) {
    const cases = loadGolden(cwd);
    console.log(
      `🐢 골든셋 — 캡처 ${isGoldenCapture(cwd) ? "ON" : "OFF"} · 케이스 ${cases.length}건 (.gbc/golden.json, 로컬 전용)`,
    );
  } else if (sub === "list") {
    const cases = loadGolden(cwd);
    if (cases.length === 0) {
      console.log("골든셋 비어 있음. 'gbc gate snapshot on'으로 캡처를 시작하세요.");
      return;
    }
    console.log(`🐢 골든셋 ${cases.length}건:`);
    for (const c of cases) {
      const head = c.edit.replace(/\s+/g, " ").trim().slice(0, 60);
      console.log(`  [${c.expected.verdict}] ${c.tool} ${c.id}  "${head}…"`);
    }
  } else if (sub === "clear") {
    clearGolden(cwd);
    console.log("🐢 골든셋 비움.");
  } else if (sub === "replay") {
    await cmdGateSnapshotReplay(cwd, args.slice(1));
  } else {
    console.error("사용: gbc gate snapshot <on|off|status|list|clear|replay>");
    process.exit(1);
  }
}

/** golden 케이스를 judge temp 0으로 재판정해 드리프트를 본다. --samples N=모달 판정(잔여 노이즈 흡수). */
async function cmdGateSnapshotReplay(cwd: string, args: string[]): Promise<void> {
  const cases = loadGolden(cwd);
  if (cases.length === 0) {
    console.log("골든셋 비어 있음 — replay할 케이스 없음. 'gbc gate snapshot on' 후 편집을 캡처하세요.");
    return;
  }
  const si = args.indexOf("--samples");
  let samples = si >= 0 ? Math.max(1, Number.parseInt(args[si + 1] ?? "1", 10) || 1) : 1;
  // 모달 판정은 동수(tie)면 pass로 떨어져 block-기대 케이스의 드리프트를 *놓친다* → 짝수면 홀수로
  // 올려 tie를 원천 제거(다수결은 본래 홀수 표본을 요구). 기본 1은 홀수라 무영향.
  if (samples % 2 === 0) {
    console.log(`  (--samples ${samples}=짝수 → 동수 방지 위해 ${samples + 1}로 조정)`);
    samples += 1;
  }
  const { judge } = await import("./judge.js");

  console.log(
    `🐢 골든셋 replay — ${cases.length}건${samples > 1 ? ` · ${samples}-sample 모달` : ""} (judge temp 0; CLI 폴백은 best-effort)`,
  );
  const outcomes: ReplayOutcome[] = [];
  for (const c of cases) {
    // N-sample 모달 판정 — temp 0도 bit-stable 아니라, 다수결로 잔여 비결정을 흡수한다.
    const votes: Record<VerdictKind, number> = { pass: 0, block: 0 };
    let lastMissing: string[] = [];
    for (let i = 0; i < samples; i++) {
      const v = await judge(c.spec, c.edit, c.defers, c.resolved ?? [], { temperature: 0 });
      votes[v.verdict]++;
      lastMissing = v.missing;
    }
    const actual: VerdictKind = votes.block > votes.pass ? "block" : "pass";
    const diff = diffVerdict(c.expected, { verdict: actual, missing: lastMissing });
    outcomes.push({ id: c.id, tool: c.tool, expected: c.expected.verdict, actual, diff });
    const mark = diff.decisionFlip ? "❌FLIP" : diff.missingChanged ? "·missing변화" : "✓";
    console.log(`  ${mark} ${c.tool} ${c.id}: ${c.expected.verdict}→${actual}`);
  }

  const s = summarizeReplay(outcomes);
  console.log(
    `\n결과: 일치 ${s.matched}/${s.total} · 판정뒤집힘 ${s.flips} · (정보용 missing변화 ${s.missingOnly})`,
  );
  if (s.flips > 0) {
    console.log(
      `❌ 드리프트 감지 — ${s.flips}건 판정 뒤집힘. 모델/프롬프트/SDK 변화로 게이트 판정이 바뀌었습니다.`,
    );
    process.exit(1);
  }
  console.log("✅ 드리프트 없음 — 캡처 시점과 동일 판정.");
}

/** `gbc gate review` 인자에서 --spec/--defer 뒤의 비-플래그 토큰을 각각 모아 ref 문자열로. */
function parseReviewArgs(args: string[]): { specRefs: string; deferRefs: string } {
  let cur: "spec" | "defer" | null = null;
  const spec: string[] = [];
  const defer: string[] = [];
  for (const a of args) {
    if (a === "--spec") {
      cur = "spec";
    } else if (a === "--defer") {
      cur = "defer";
    } else if (a.startsWith("--")) {
      cur = null; // 알 수 없는 플래그 — 수집 중단
    } else if (cur === "spec") {
      spec.push(a);
    } else if (cur === "defer") {
      defer.push(a);
    }
  }
  return { specRefs: spec.join(" "), deferRefs: defer.join(" ") };
}

/**
 * 게이트 block이 도출한 펜딩 누락 케이스를 사람-승인 체크리스트로 일괄 분류한다(A1).
 * - 인자 없음: 번호 체크리스트만 표시(검토 모드).
 * - --spec/--defer refs: 승인→spec.md 등록 / 미룸→defer 등록(겹치면 spec 우선), 후 펜딩 비움.
 */
function cmdGateReview(cwd: string, args: string[]): void {
  const pending = readPendingReview(cwd);
  if (!pending || pending.missing.length === 0) {
    console.log("🐢 검토할 펜딩 누락 케이스가 없습니다. (게이트 block 시 도출된 누락 케이스가 여기 모입니다)");
    return;
  }

  const { specRefs, deferRefs } = parseReviewArgs(args);

  // 분류 ref 없음 = 체크리스트만(검토 모드)
  if (specRefs === "" && deferRefs === "") {
    console.log(
      `🐢 펜딩 누락 케이스 ${pending.missing.length}건 (사유: ${pending.reason} · 소스: ${pending.source}):`,
    );
    pending.missing.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
    console.log(
      `→ 분류: gbc gate review --spec <번호|텍스트|all> --defer <번호|텍스트|all>\n` +
        `  (승인→spec.md / 미룸→defer. 겹치면 spec 우선. 분류 후 펜딩은 비워지고, 재편집 시 등록 기준으로 재판정)`,
    );
    return;
  }

  const { toSpec, toDefer } = resolveRefs(pending.missing, specRefs, deferRefs);
  if (toSpec.length === 0 && toDefer.length === 0) {
    console.error("ref가 어떤 펜딩 케이스에도 매칭되지 않았습니다 — 'gbc gate review'로 번호를 확인하세요.");
    process.exit(1);
  }

  const beforeHash = curHash(cwd); // 변이 전 해시 = 게이트된 작업단위와 상관(M1 churn)
  const specAdded: string[] = [];
  const specDup: string[] = [];
  for (const c of toSpec) {
    if (addSpecCase(cwd, c)) {
      logCli(cwd, "spec-add", beforeHash);
      specAdded.push(c);
    } else {
      specDup.push(c);
    }
  }
  const deferAdded: string[] = [];
  const deferDup: string[] = [];
  for (const c of toDefer) {
    if (addDefer(cwd, c).added) {
      logCli(cwd, "defer-add", beforeHash);
      deferAdded.push(c);
    } else {
      deferDup.push(c);
    }
  }
  clearPendingReview(cwd);

  if (specAdded.length > 0) console.log(`🐢 명세 등록 ${specAdded.length}건: ${specAdded.join(", ")}`);
  if (deferAdded.length > 0) console.log(`🐢 미룸 등록 ${deferAdded.length}건: ${deferAdded.join(", ")}`);
  if (specDup.length + deferDup.length > 0) {
    console.log(`🐢 중복 skip ${specDup.length + deferDup.length}건: ${[...specDup, ...deferDup].join(", ")}`);
  }
  console.log("→ 검토 완료(펜딩 비움). 같은 편집을 재시도하면 등록된 케이스 기준으로 재판정됩니다.");
}

// ---------- gbc metrics ----------
function cmdMetrics(args: string[]): void {
  const cwd = process.cwd();
  const all = args.includes("--all");

  // --all: 등록된 각 repo의 events.jsonl을 repo경로로 태깅 후 병합(specHash 해시충돌 차단).
  // M1 churn축은 specHash 단독키라, 태깅 없이 합치면 repo간 boilerplate spec 해시가 충돌해
  // 한 repo의 통과 뒤 다른 repo의 변이가 churn으로 오집계된다(M2/M3는 session-UUID 키라 안전).
  let events;
  let scope: string;
  let source: string;
  if (all) {
    const merged = [];
    let included = 0;
    let skipped = 0;
    for (const repo of loadRepos()) {
      const abs = resolve(repo);
      try {
        // 단일 lstatSync로 symlink 거부 — existsSync+lstatSync 분리는 TOCTOU 경합창을 연다(보안검토 W1).
        // lstat은 링크를 따라가지 않아 symlink면 isDirectory()=false, 부재면 throw→catch로 skip.
        if (!lstatSync(abs).isDirectory()) {
          skipped++;
          continue;
        }
        const p = join(abs, ".gbc", "events.jsonl");
        if (!existsSync(p)) {
          skipped++;
          continue;
        }
        merged.push(...tagEventsWithRepo(parseEvents(readFileSync(p, "utf8")), abs));
        included++;
      } catch {
        skipped++; // repo별 읽기 실패는 조용히 skip(fail-silent)
      }
    }
    events = merged;
    scope = `전체 ${included}개 repo 병합${skipped ? ` (${skipped}개 skip: 부재/이벤트없음)` : ""}`;
    source = "등록 repo들의 .gbc/events.jsonl(repo 태깅 병합)";
  } else {
    const eventsPath = join(cwd, ".gbc", "events.jsonl");
    events = parseEvents(existsSync(eventsPath) ? readFileSync(eventsPath, "utf8") : "");
    scope = cwd;
    source = ".gbc/events.jsonl";
  }

  const m = computeMetrics(events);

  if (args.includes("--json")) {
    console.log(JSON.stringify(m, null, 2));
    return;
  }

  console.log(`🐢 거북이 게이트 계측 — ${scope}
  이벤트 총 ${m.totalEvents}건  (${source})

  [M3] 재호출/iteration — 작업단위당 edit 반복
    작업단위 ${m.m3.workUnits} · 총 edit ${m.m3.totalEdits} · 평균 ${m.m3.avgEditsPerUnit}/단위 · 최대 ${m.m3.maxEditsPerUnit} · 반복(>1)단위 ${m.m3.multiEditUnits}

  [M2] 게이트 적중 vs 도중발견
    게이트 적중(차단 누락케이스) ${m.m2.gateCaught} · 차단 ${m.m2.blocks}회
    도중발견(defer 등록) ${m.m2.deferred} · 도중발견 비율 ${(m.m2.midDiscoveryRatio * 100).toFixed(1)}%

  [M1] post-gate 재작업
    게이트 리셋 ${m.m1.resets} · 통과후 churn ${m.m1.churnAfterPass}
    ⚠️ ${m.m1.note}

  [scope] 축A 파급반경 · 축B 최소구현 사다리 (사후 판정)
    판정 ${m.scope.total}건 · 파급반경 broken ${m.scope.rippleBroken} · 사다리 걸림 ${m.scope.rungHits} · 탐색불가 미평가 ${m.scope.degraded}`);
}

// ---------- gbc update ----------
/**
 * 전역 최신 설치 + (현재 프로젝트면) 재init을 한 번에. 자동 silent 업데이트가 아니라 명시 명령 —
 * 사용자가 nag를 보고 'gbc update' 한 줄로 갱신한다(매번 두 명령 외울 필요 제거).
 * ★재init은 '새로 깔린' 바이너리를 fresh spawn해야 신규 스킬·hook이 반영된다(현재 실행 중인 건 구버전).
 */
function cmdUpdate(args: string[]): void {
  const cwd = process.cwd();
  const dry = args.includes("--dry-run");
  const isProject = existsSync(join(cwd, ".gbc"));
  const steps = ["npm i -g geobuke-code@latest", ...(isProject ? ["gbc init --yes"] : [])];

  if (dry) {
    console.log("🐢 gbc update — 실행 예정(--dry-run):");
    steps.forEach((s) => console.log(`  $ ${s}`));
    if (!isProject)
      console.log("  (현재 폴더에 .gbc 없음 → init 생략. 프로젝트에서 'gbc init --yes' 실행)");
    return;
  }

  console.log(`🐢 gbc update — 전역 최신 설치${isProject ? " + 현재 프로젝트 재init" : ""}`);

  // 1) 전역 최신 설치. shell:true + 고정 명령 문자열(사용자 입력 없음 → 인젝션 무관, 크로스플랫폼).
  const r1 = spawnSync("npm i -g geobuke-code@latest", { stdio: "inherit", shell: true });
  if (r1.status !== 0) {
    console.error(
      "❌ 전역 설치 실패. 권한 문제면 관리자 권한(Windows)·sudo 또는 수동 'npm i -g geobuke-code@latest'.",
    );
    process.exit(1);
  }

  // 2) gbc 프로젝트면 재init — 신규 스킬(gbc-mute 등)·최신 hook 반영.
  if (isProject) {
    const r2 = spawnSync("gbc init --yes", { stdio: "inherit", shell: true, cwd });
    if (r2.status !== 0) {
      console.error("⚠️ 전역 설치는 됐으나 'gbc init --yes' 실패 — 프로젝트에서 수동 실행하세요.");
      process.exit(1);
    }
  } else {
    console.log("ℹ️ 현재 폴더는 gbc 프로젝트 아님(.gbc 없음) → 각 프로젝트에서 'gbc init --yes' 실행하세요.");
  }
  console.log("✅ gbc update 완료.");
}

/**
 * 크로스-repo 레지스트리 관리(0.2.9). 등록된 타 repo의 미해결 defer가 SessionStart에 환기된다.
 * 글로벌 ~/.gbc/repos.json. 경로 생략 시 현재 폴더(cwd).
 */
function cmdRepos(args: string[]): void {
  const [sub, ...rest] = args;
  if (sub === "add") {
    const abs = resolve(rest[0] ?? process.cwd());
    const repos = addRepo(abs);
    const gated = existsSync(join(abs, ".gbc"));
    console.log(
      `📁 등록: ${abs}${gated ? "" : "  ⚠️ (.gbc 없음 — gbc init 전이면 표면화될 defer 없음)"}`,
    );
    console.log(`   현재 ${repos.length}개 등록됨.`);
  } else if (sub === "remove" || sub === "rm") {
    const abs = resolve(rest[0] ?? process.cwd());
    const before = loadRepos().length;
    const repos = removeRepo(abs);
    console.log(repos.length < before ? `🗑️  해제: ${abs}` : `(미등록 경로: ${abs})`);
    console.log(`   현재 ${repos.length}개 등록됨.`);
  } else if (sub === "list" || sub === undefined) {
    const repos = loadRepos();
    if (repos.length === 0) {
      console.log("등록된 repo 없음. 'gbc repos add [경로]'로 추가(경로 생략 시 현재 폴더).");
      return;
    }
    console.log(`📁 등록된 repo ${repos.length}개:`);
    let anyStale = false;
    for (const r of repos) {
      // 단일 lstatSync로 부재/symlink를 한 번에 판정 — existsSync+lstatSync 분리는 TOCTOU 경합창을
      // 연다(보안검토 W1). lstat은 링크를 안 따라가 symlink면 isDir=false; 부재/권한오류는 throw→
      // exists=false. gated가 true여야만 loadDefers·readProjectSettings로 그 경로를 읽으므로, 이
      // 가드가 두 외부 읽기를 함께 막는다(cmdMetrics --all·buildCrossRepoHint와 동일 표준).
      let exists = false;
      let isDir = false;
      try {
        isDir = lstatSync(r).isDirectory();
        exists = true;
      } catch {
        /* 부재/권한오류 → exists=false */
      }
      const gated = isDir && existsSync(join(r, ".gbc"));
      const unresolved = gated ? loadDefers(r).filter((d) => !isClosedStatus(d.status)).length : 0;
      const mark = !exists
        ? "✗부재"
        : !isDir
          ? "⚠️심링크거부"
          : !gated
            ? "·gbc없음"
            : unresolved
              ? `●미해결${unresolved}`
              : "○깨끗";
      // 게이트 건강성(B1) — gbc 프로젝트면 hook 등록 상태로 '게이트 조용히 죽음/구식 코호트'를 표면화.
      // (회사 repo 게이트 미작동 미스터리 차단). 명령 freshness는 cliPath 의존이라 크로스-repo 미검출.
      let health = "";
      if (gated) {
        const h = assessRepoHealth(readProjectSettings(r), true);
        const flags = [h.gateDead ? "⚠️게이트hook부재" : "", h.missingSession ? "⚠️SessionStart누락" : ""].filter(Boolean);
        if (flags.length) {
          health = "  " + flags.join(" ");
          anyStale = true;
        }
      }
      console.log(`  [${mark}] ${r}${health}`);
    }
    if (anyStale) {
      console.log(
        "\n⚠️ 게이트 hook 부재/SessionStart 누락 repo는 해당 repo에서 'gbc init --yes' 재실행으로 복구하세요.",
      );
      console.log(
        "   (크로스-repo는 hook *등록 여부*만 검사 — 명령 freshness[설치경로 의존]는 각 repo에서 'gbc status'로 확인)",
      );
    }
  } else {
    console.log("사용법: gbc repos [add|remove|list] [경로]");
  }
}

function usage(): void {
  console.log(`🐢 gbc — 거북이코드 구현-전 게이트

사용:
  gbc init [--yes] [--no-register]    프로젝트에 hook + /gate · /gbc-mute · /gbc-monitor 스킬 설치
                                      (--no-register: 크로스-repo 레지스트리 자동등록 생략)
  gbc update [--dry-run]              전역 최신 설치 + 현재 프로젝트 재init (한방 갱신)
  gbc status                          게이트 상태 + 로드된 명세 확인
  gbc defer add "<케이스>"             케이스를 명시적으로 미루기 (→ open)
  gbc defer list                      미룬 항목 목록 (상태: 미해결/진행중/해결)
  gbc defer start <번호|텍스트|all>    착수 표시 (open → 진행중)
  gbc defer resolve <번호|텍스트|all>  종결 표시 (→ 해결; 항상 사용자 점검 후)
  gbc defer reopen <번호|텍스트|all>   백로그로 되돌리기 (→ open)
  gbc defer mute                      대화 종료(Stop)마다 뜨는 defer 알림 끄기 (영속)
  gbc defer unmute                    Stop defer 알림 다시 켜기
  gbc spec add "<케이스>"              승인된 시나리오를 .gbc/spec.md에 등록
  gbc spec show                       등록된 케이스 목록
  gbc spec clear                      명세 비우기(아카이브 없이)
  gbc done                            작업단위 명시 종료(명세 아카이브→비움 + 게이트 리셋)
  gbc verify                          사후 결과검증(verified>reviewed>unverifiable) — 케이스↔증거 대조
                                      (바인딩: '<케이스> ::test <테스트명>' / '::file <경로>')
  gbc verify --init                   러너 감지→JUnit 리포터 배선 스캐폴딩(러너 없으면 node:test 제로설치 템플릿)
  gbc gate reset                      작업단위 게이트만 리셋(명세 보존·같은 단위 재게이트)
  gbc gate review                     block이 도출한 누락 케이스 체크리스트 보기
  gbc gate review --spec <ref> --defer <ref>
                                      누락 케이스 일괄 분류(승인→spec / 미룸→defer)
  gbc gate snapshot <on|off|status|list|clear>
                                      골든셋 캡처 토글·상태(판정 드리프트 회귀락, 로컬 전용)
  gbc gate snapshot replay [--samples N]
                                      골든 케이스 재판정(temp 0)·드리프트 시 exit 1
  gbc metrics [--all] [--json]        계측 리포트(M1~M3, B-모드 관측 프록시; --all=등록 repo 병합)
  gbc repos add [경로]                크로스-repo 레지스트리에 추가(생략 시 현재 폴더)
  gbc repos list                      등록된 repo + 미해결 defer 수
  gbc repos remove [경로]             레지스트리에서 제거
  gbc hook pre-tool-use               (내부) PreToolUse hook
  gbc hook stop                       (내부) Stop hook
  gbc hook session-start              (내부) SessionStart hook (미해결 defer 알림)
`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "hook":
      if (rest[0] === "pre-tool-use") return runPreToolUse({ cliPath: CLI_PATH, version: PKG_VERSION });
      if (rest[0] === "stop") return runStop();
      if (rest[0] === "session-start")
        return runSessionStart({ cliPath: CLI_PATH, version: PKG_VERSION });
      console.error("사용: gbc hook <pre-tool-use|stop|session-start>");
      process.exit(1);
      break;
    case "init":
      return cmdInit(rest);
    case "update":
      return cmdUpdate(rest);
    case "status":
      return cmdStatus();
    case "defer":
      return cmdDefer(rest);
    case "spec":
      return cmdSpec(rest);
    case "gate":
      return cmdGate(rest);
    case "done":
      return cmdDone();
    case "verify":
      return cmdVerify(rest);
    case "metrics":
      return cmdMetrics(rest);
    case "repos":
      return cmdRepos(rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return usage();
    default:
      console.error(`알 수 없는 명령: ${cmd}`);
      usage();
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`gbc 오류: ${String(e)}`);
  process.exit(1);
});
