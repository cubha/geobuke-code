#!/usr/bin/env node
// gbc — 거북이코드 CLI. zero-dep 인자 파싱(핫패스 보호).
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";

import { runPreToolUse, runStop, runSessionStart } from "./hook.js";
import { loadPlanSpec, computeSpecHash, addSpecCase, readSpecCases, clearSpec } from "./spec.js";
import { loadState, resetGate } from "./state.js";
import { addDefer, loadDefers, resolveDefer, startDefer, reopenDefer } from "./defer.js";
import { selectedTransport } from "./judge.js";
import { buildPreCommand, normalizeHooks, ensureSessionStartHook } from "./install.js";
import {
  isCacheStale,
  readVersionCache,
  refreshVersionCache,
} from "./version.js";
import { logEvent, parseEvents, computeMetrics } from "./metrics.js";
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
function stopCommand(): string {
  return `node "${CLI_PATH}" hook stop`;
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
  const claudeDir = join(cwd, ".claude");
  const settingsPath = join(claudeDir, "settings.json");
  const skillDestDir = join(claudeDir, "skills", "gate");
  const skillSrc = join(PKG_ROOT, "skills", "gate", "SKILL.md");

  if (!yes) {
    console.log(`🐢 gbc init — 다음을 수행합니다 (프로젝트 로컬만, 전역 ~/.claude 미변경):

  대상 프로젝트: ${cwd}
  1) ${settingsPath} 에 PreToolUse(Edit|Write) + Stop + SessionStart hook 추가 (머지·멱등)
     - 기존 settings.json 있으면 백업: settings.json.bak-<시각>
  2) ${join(skillDestDir, "SKILL.md")} 에 /gate 스킬 설치
  3) hook 명령: ${buildPreCommand(CLI_PATH)}
${
  hasApiKey()
    ? "     (~/.gbc/api-key 감지됨 → 빠른 haiku API 경로로 동작)"
    : "     (~/.gbc/api-key 없음 → claude -p 폴백. 빠른 경로 원하면 키 파일 생성)"
}
  실행하려면: gbc init --yes
`);
    return;
  }

  mkdirSync(skillDestDir, { recursive: true });

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
      hooks: [{ type: "command", command: buildPreCommand(CLI_PATH) }],
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
      hooks: [{ type: "command", command: stopCommand() }],
    });
    console.log(`  + Stop hook 추가`);
  } else {
    console.log(`  = Stop hook 이미 존재 (skip)`);
  }

  // SessionStart (멱등) — 세션 진입(startup|resume) 시 미해결 defer 알림
  if (ensureSessionStartHook(settings, CLI_PATH)) {
    console.log(`  + SessionStart hook 추가`);
  } else {
    console.log(`  = SessionStart hook 이미 존재 (skip)`);
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");

  // /gate 스킬 설치
  if (existsSync(skillSrc)) {
    copyFileSync(skillSrc, join(skillDestDir, "SKILL.md"));
    console.log(`  + /gate 스킬 설치`);
  }

  const transport = selectedTransport();
  console.log(`
✅ 설치 완료. 트랜스포트: ${transport}${
    transport === "cli"
      ? "  (ANTHROPIC_API_KEY 설정 시 직접 API로 ~1–3s, 미설정 시 claude -p 폴백 ~13–20s)"
      : ""
  }
   계획 명세는 .gbc/spec.md 에 작성하세요(없으면 시나리오 미지정으로 차단 → 도출·검증 루프 발동: 에이전트가 요청에서 시나리오를 도출해 사용자 검증 후 'gbc spec add'로 등록).`);

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
  const unresolved = defers.filter((d) => d.status !== "resolved");
  const inProgress = defers.filter((d) => d.status === "in_progress").length;

  console.log(`🐢 거북이 게이트 상태 — ${cwd}
  버전: ${PKG_VERSION || "(불명)"}
  트랜스포트: ${selectedTransport()}
  명세 소스: ${source} ${text ? `(${text.length}자)` : "(비어있음 → 모든 코드변경 차단)"}
  명세 해시: ${hash}
  작업단위 게이트: ${state && state.specHash === hash && state.gated ? "통과됨(이 단위 재게이트 안 함)" : "미통과(다음 편집에서 발동)"}
  defer: 전체 ${defers.length} / 미해결 ${unresolved.length} (진행중 ${inProgress} · 미착수 ${unresolved.length - inProgress})`);
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
    addDefer(cwd, item);
    logCli(cwd, "defer-add", curHash(cwd));
    console.log(`🐢 미룸 등록: ${item}`);
  } else if (sub === "list") {
    const defers = loadDefers(cwd);
    if (defers.length === 0) {
      console.log("(미룬 항목 없음)");
      return;
    }
    const label: Record<string, string> = {
      open: "미해결",
      in_progress: "진행중",
      resolved: "해결",
    };
    defers.forEach((d, i) => console.log(`${i + 1}. [${label[d.status]}] ${d.item}`));
  } else if (sub === "start" || sub === "resolve" || sub === "reopen") {
    const ref = args.slice(1).join(" ").trim();
    if (!ref) {
      console.error(`사용: gbc defer ${sub} <번호|텍스트|all>`);
      process.exit(1);
    }
    const fn = sub === "start" ? startDefer : sub === "resolve" ? resolveDefer : reopenDefer;
    const verb = sub === "start" ? "착수" : sub === "resolve" ? "해결" : "되돌림(open)";
    const changed = fn(cwd, ref);
    if (changed.length > 0) {
      logCli(cwd, `defer-${sub}`, curHash(cwd));
      console.log(`🐢 ${verb} ${changed.length}건: ${changed.map((d) => d.item).join(", ")}`);
    } else {
      console.log(`매칭되는 항목 없음(0건): ${ref}`);
    }
  } else {
    console.error("사용: gbc defer <add|list|start|resolve|reopen> ...");
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
    addSpecCase(cwd, item);
    logCli(cwd, "spec-add", beforeHash);
    console.log(`🐢 명세 등록: ${item}`);
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

// ---------- gbc gate ----------
function cmdGate(args: string[]): void {
  if (args[0] === "reset") {
    const cwd = process.cwd();
    logCli(cwd, "gate-reset", curHash(cwd));
    resetGate(cwd);
    console.log("🐢 작업단위 게이트 리셋 — 다음 편집에서 다시 발동합니다.");
  } else {
    console.error("사용: gbc gate reset");
    process.exit(1);
  }
}

// ---------- gbc metrics ----------
function cmdMetrics(args: string[]): void {
  const cwd = process.cwd();
  const eventsPath = join(cwd, ".gbc", "events.jsonl");
  const raw = existsSync(eventsPath) ? readFileSync(eventsPath, "utf8") : "";
  const m = computeMetrics(parseEvents(raw));

  if (args.includes("--json")) {
    console.log(JSON.stringify(m, null, 2));
    return;
  }

  console.log(`🐢 거북이 게이트 계측 — ${cwd}
  이벤트 총 ${m.totalEvents}건  (.gbc/events.jsonl)

  [M3] 재호출/iteration — 작업단위당 edit 반복
    작업단위 ${m.m3.workUnits} · 총 edit ${m.m3.totalEdits} · 평균 ${m.m3.avgEditsPerUnit}/단위 · 최대 ${m.m3.maxEditsPerUnit} · 반복(>1)단위 ${m.m3.multiEditUnits}

  [M2] 게이트 적중 vs 도중발견
    게이트 적중(차단 누락케이스) ${m.m2.gateCaught} · 차단 ${m.m2.blocks}회
    도중발견(defer 등록) ${m.m2.deferred} · 도중발견 비율 ${(m.m2.midDiscoveryRatio * 100).toFixed(1)}%

  [M1] post-gate 재작업
    게이트 리셋 ${m.m1.resets} · 통과후 churn ${m.m1.churnAfterPass}
    ⚠️ ${m.m1.note}`);
}

function usage(): void {
  console.log(`🐢 gbc — 거북이코드 구현-전 게이트

사용:
  gbc init [--yes]                    프로젝트에 hook + /gate 스킬 설치
  gbc status                          게이트 상태 + 로드된 명세 확인
  gbc defer add "<케이스>"             케이스를 명시적으로 미루기 (→ open)
  gbc defer list                      미룬 항목 목록 (상태: 미해결/진행중/해결)
  gbc defer start <번호|텍스트|all>    착수 표시 (open → 진행중)
  gbc defer resolve <번호|텍스트|all>  종결 표시 (→ 해결; 항상 사용자 점검 후)
  gbc defer reopen <번호|텍스트|all>   백로그로 되돌리기 (→ open)
  gbc spec add "<케이스>"              승인된 시나리오를 .gbc/spec.md에 등록
  gbc spec show                       등록된 케이스 목록
  gbc spec clear                      명세 비우기(작업단위 종료)
  gbc gate reset                      작업단위 게이트 리셋
  gbc metrics [--json]                계측 리포트(M1~M3, B-모드 관측 프록시)
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
    case "status":
      return cmdStatus();
    case "defer":
      return cmdDefer(rest);
    case "spec":
      return cmdSpec(rest);
    case "gate":
      return cmdGate(rest);
    case "metrics":
      return cmdMetrics(rest);
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
