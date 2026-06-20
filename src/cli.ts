#!/usr/bin/env node
// gbc — 거북이코드 CLI. zero-dep 인자 파싱(핫패스 보호).
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";

import { runPreToolUse, runStop } from "./hook.js";
import { loadPlanSpec, computeSpecHash, addSpecCase, readSpecCases, clearSpec } from "./spec.js";
import { loadState, resetGate } from "./state.js";
import { addDefer, loadDefers, resolveDefer } from "./defer.js";
import { selectedTransport } from "./judge.js";

const CLI_PATH = fileURLToPath(import.meta.url);
const PKG_ROOT = join(dirname(CLI_PATH), ".."); // dist/cli.js → 패키지 루트

function preCommand(): string {
  return `node "${CLI_PATH}" hook pre-tool-use`;
}
function stopCommand(): string {
  return `node "${CLI_PATH}" hook stop`;
}

function nowStamp(): string {
  try {
    return new Date().toISOString().replace(/[:.]/g, "-");
  } catch {
    return "backup";
  }
}

// ---------- gbc init ----------
function cmdInit(args: string[]): void {
  const cwd = process.cwd();
  const yes = args.includes("--yes") || args.includes("-y");
  const claudeDir = join(cwd, ".claude");
  const settingsPath = join(claudeDir, "settings.json");
  const skillDestDir = join(claudeDir, "skills", "gate");
  const skillSrc = join(PKG_ROOT, "skills", "gate", "SKILL.md");

  if (!yes) {
    console.log(`🐢 gbc init — 다음을 수행합니다 (프로젝트 로컬만, 전역 ~/.claude 미변경):

  대상 프로젝트: ${cwd}
  1) ${settingsPath} 에 PreToolUse(Edit|Write) + Stop hook 추가 (머지·멱등)
     - 기존 settings.json 있으면 백업: settings.json.bak-<시각>
  2) ${join(skillDestDir, "SKILL.md")} 에 /gate 스킬 설치
  3) hook 명령: ${preCommand()}

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

  // PreToolUse (멱등: 이미 'hook pre-tool-use' 있으면 skip)
  if (!serialized.includes("hook pre-tool-use")) {
    (hooks.PreToolUse ??= []).push({
      matcher: "Edit|Write|MultiEdit",
      hooks: [{ type: "command", command: preCommand() }],
    });
    console.log(`  + PreToolUse hook 추가`);
  } else {
    console.log(`  = PreToolUse hook 이미 존재 (skip)`);
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
   계획 명세는 scratch.md 또는 .gbc/spec.md 에 작성하세요(없으면 시나리오 미지정으로 차단).`);
}

// ---------- gbc status ----------
function cmdStatus(): void {
  const cwd = process.cwd();
  const { text, source } = loadPlanSpec(cwd);
  const hash = computeSpecHash(text);
  const state = loadState(cwd);
  const defers = loadDefers(cwd);
  const unresolved = defers.filter((d) => !d.resolved);

  console.log(`🐢 거북이 게이트 상태 — ${cwd}
  트랜스포트: ${selectedTransport()}
  명세 소스: ${source} ${text ? `(${text.length}자)` : "(비어있음 → 모든 코드변경 차단)"}
  명세 해시: ${hash}
  작업단위 게이트: ${state && state.specHash === hash && state.gated ? "통과됨(이 단위 재게이트 안 함)" : "미통과(다음 편집에서 발동)"}
  defer: 전체 ${defers.length} / 미해결 ${unresolved.length}`);
  if (unresolved.length > 0) {
    console.log(unresolved.map((d, i) => `    ${i + 1}. ${d.item}`).join("\n"));
  }
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
    console.log(`🐢 미룸 등록: ${item}`);
  } else if (sub === "list") {
    const defers = loadDefers(cwd);
    if (defers.length === 0) {
      console.log("(미룬 항목 없음)");
      return;
    }
    defers.forEach((d, i) =>
      console.log(`${i + 1}. [${d.resolved ? "해결" : "미해결"}] ${d.item}`),
    );
  } else if (sub === "resolve") {
    const ref = args.slice(1).join(" ").trim();
    const r = resolveDefer(cwd, ref);
    console.log(r ? `🐢 해결 표시: ${r.item}` : `매칭되는 미룬 항목 없음: ${ref}`);
  } else {
    console.error("사용: gbc defer <add|list|resolve> ...");
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
    addSpecCase(cwd, item);
    console.log(`🐢 명세 등록: ${item}`);
  } else if (sub === "show") {
    const cases = readSpecCases(cwd);
    if (cases.length === 0) {
      console.log("(등록된 케이스 없음 — .gbc/spec.md 비어있음)");
      return;
    }
    cases.forEach((c, i) => console.log(`${i + 1}. ${c}`));
  } else if (sub === "clear") {
    clearSpec(cwd);
    console.log("🐢 명세 비움 — 다음 작업단위로 깨끗이 넘어갑니다.");
  } else {
    console.error("사용: gbc spec <add|show|clear> ...");
    process.exit(1);
  }
}

// ---------- gbc gate ----------
function cmdGate(args: string[]): void {
  if (args[0] === "reset") {
    resetGate(process.cwd());
    console.log("🐢 작업단위 게이트 리셋 — 다음 편집에서 다시 발동합니다.");
  } else {
    console.error("사용: gbc gate reset");
    process.exit(1);
  }
}

function usage(): void {
  console.log(`🐢 gbc — 거북이코드 구현-전 게이트

사용:
  gbc init [--yes]                    프로젝트에 hook + /gate 스킬 설치
  gbc status                          게이트 상태 + 로드된 명세 확인
  gbc defer add "<케이스>"             케이스를 명시적으로 미루기
  gbc defer list                      미룬 항목 목록
  gbc defer resolve <번호|텍스트>      미룬 항목 해결
  gbc spec add "<케이스>"              승인된 시나리오를 .gbc/spec.md에 등록
  gbc spec show                       등록된 케이스 목록
  gbc spec clear                      명세 비우기(작업단위 종료)
  gbc gate reset                      작업단위 게이트 리셋
  gbc hook pre-tool-use               (내부) PreToolUse hook
  gbc hook stop                       (내부) Stop hook
`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "hook":
      if (rest[0] === "pre-tool-use") return runPreToolUse();
      if (rest[0] === "stop") return runStop();
      console.error("사용: gbc hook <pre-tool-use|stop>");
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
