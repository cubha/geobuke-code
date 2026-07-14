// gbc init 설치 로직 (순수함수 — cli.ts main() 부작용 없이 단위테스트 가능).
// 키 주입은 셸이 아니라 gbc 코드(judge.ts resolveApiKey)가 처리한다 → hook 명령은
// 셸 무관 순수 형태라 native Windows(cmd.exe)/bash/zsh/Mac에서 동일하게 동작한다.

import type { Settings } from "./types.js";

/**
 * dev(도그푸딩) 설치용 hook 경로 placeholder. `gbc init --dev`가 절대경로(CLI_PATH) 대신 이걸
 * 구워, geobuke-code 자기 repo처럼 dist 위치가 옮겨다니는 클론에서도 hook이 깨지지 않게 한다
 * (CC 런타임이 ${CLAUDE_PROJECT_DIR}를 프로젝트 루트로 치환). npm 전역·외부 4곳 도그푸딩은 절대경로
 * 유지(기본동작 불변) — 이 placeholder는 명시 opt-in일 때만 쓰인다.
 */
export const DEV_PLACEHOLDER = "${CLAUDE_PROJECT_DIR}/dist/cli.js";

/**
 * gbc init이 설치하는 gbc 자체 스킬 이름(제품소스 skills/<name>/SKILL.md). 단일 소스 —
 * cmdInit의 설치 대상 목록과 TUI 스플래시 카드(0.9.3 D1)의 "기본 스킬" 표시가 이 배열을 공유한다
 * (두 곳이 각자 하드코딩하면 신규 스킬 추가 시 한쪽만 갱신되고 드리프트한다).
 */
export const GBC_SKILL_NAMES = ["gate", "gbc-mute", "gbc-monitor"] as const;

/**
 * PreToolUse hook의 *정식* 명령 집합(절대경로 + dev placeholder). stale/normalize 판정의 공통 기준.
 * read-time(hasStalePreToolUse)은 런타임 cliPath=절대경로뿐이라 이 repo가 dev인지 모른다 → 두 정식
 * 형태 중 하나면 stale 아님으로 봐야 placeholder를 구식으로 오판하지 않는다. substring이 아니라
 * 완전일치 집합이라, 서브명령명이 바뀌면 placeholder 형태도 함께 갱신돼 진짜 구식 감지는 유지된다.
 */
function canonicalPreCommands(cliPath: string): string[] {
  return [buildPreCommand(cliPath), buildPreCommand(DEV_PLACEHOLDER)];
}

/**
 * PreToolUse hook 명령 생성 — 셸 무관 순수 명령.
 * `node "<cliPath>" hook pre-tool-use` 형태만 생성한다. 키 주입(셸 prefix)·셸 확장 없음.
 * - cliPath는 큰따옴표로만 감싼다(공백 포함 경로 안전). 큰따옴표는 cmd.exe·POSIX sh 공통.
 * - 백슬래시를 이스케이프하지 않는다: Windows 경로(C:\...)의 구분자이며, settings.json에
 *   기록될 때 cli.ts의 JSON.stringify가 `\`→`\\` 처리를 담당한다(여기서 또 하면 이중).
 * - cliPath는 import.meta.url 기반 설치 경로(사용자 입력 아님)라 셸 인젝션 위험이 실질적으로
 *   없어 별도 메타문자 이스케이프를 두지 않는다(이전 shDquote 방어 제거 — 보안 재검토 반영).
 */
export function buildPreCommand(cliPath: string): string {
  return `node "${cliPath}" hook pre-tool-use`;
}

/**
 * 기존 PreToolUse hook 명령을 현재 표준(셸 무관 pure 명령)으로 정규화한다.
 * keyless 명령·옛 bash 키주입 prefix 명령을 모두 pure로 교체 → "모든 OS 동일 명령" 목표 달성.
 * settings를 제자리 수정하고 변경 건수를 반환한다(멱등: 이미 표준이면 0건).
 */
export function normalizeHooks(settings: Settings, cliPath: string): number {
  const canon = canonicalPreCommands(cliPath);
  let changed = 0;
  for (const entry of settings.hooks?.PreToolUse ?? []) {
    for (const h of entry.hooks ?? []) {
      // 이미 정식(절대 or placeholder)이면 건드리지 않는다 — dev placeholder를 절대경로로 덮어
      // 도그푸딩 설치를 깨뜨리지 않게. 진짜 구식(옛 bash 키주입 등)만 절대경로로 교체.
      if (h.command.includes("hook pre-tool-use") && !canon.includes(h.command)) {
        h.command = buildPreCommand(cliPath);
        changed++;
      }
    }
  }
  return changed;
}

/** SessionStart hook 명령 — 셸 무관 순수 명령(buildPreCommand와 동일 규약). */
export function buildSessionStartCommand(cliPath: string): string {
  return `node "${cliPath}" hook session-start`;
}

/**
 * (read-only) PreToolUse hook 명령이 현재 표준(pure)과 다른 구버전인지. normalizeHooks의
 * 감지부만 떼어낸 비파괴 술어 — ②init-staleness 안내가 settings를 수정하지 않고 판단하게 한다.
 */
export function hasStalePreToolUse(settings: Settings, cliPath: string): boolean {
  const canon = canonicalPreCommands(cliPath);
  for (const entry of settings.hooks?.PreToolUse ?? []) {
    for (const h of entry.hooks ?? []) {
      // dev placeholder도 정식이므로 stale 아님 — 절대경로 런타임에서 placeholder를 구식으로 오판해
      // 'gbc init' 재실행을 헛권하던 false-positive 차단(B-잔여 #3의 실제 증상).
      if (h.command.includes("hook pre-tool-use") && !canon.includes(h.command)) return true;
    }
  }
  return false;
}

/** (read-only) SessionStart hook(session-start 명령)이 등록돼 있는지. 0.2.1 이하 init엔 없음. */
export function hasSessionStartHook(settings: Settings): boolean {
  for (const entry of settings.hooks?.SessionStart ?? []) {
    for (const h of entry.hooks ?? []) {
      if (h.command.includes("hook session-start")) return true;
    }
  }
  return false;
}

/**
 * (read-only) PreToolUse 게이트 hook('hook pre-tool-use' 명령)이 등록돼 있는지 — cliPath 무관.
 * hasStalePreToolUse가 *명령 freshness*(cliPath 의존)를 보는 반면, 이건 *존재 자체*만 본다.
 * 크로스-repo 건강성 판정에 쓴다: 타 repo의 정식 cliPath를 알 수 없으므로(각 설치경로 상이) freshness는
 * 검사 불가지만, '게이트 hook이 아예 없음'(=게이트 조용히 죽음)은 cliPath 없이도 결정론적으로 잡힌다.
 */
export function hasPreToolUseGate(settings: Settings): boolean {
  for (const entry of settings.hooks?.PreToolUse ?? []) {
    for (const h of entry.hooks ?? []) {
      if (h.command.includes("hook pre-tool-use")) return true;
    }
  }
  return false;
}

/** repo 건강성 — gateDead=gbc 프로젝트인데 게이트 hook 부재, missingSession=SessionStart hook 부재. */
export interface RepoHealth {
  gateDead: boolean;
  missingSession: boolean;
}

/**
 * 크로스-repo 게이트 건강성을 settings로 판정(cliPath 무관·결정론적). isGbcProject=false(.gbc 없음)면
 * 게이트 대상이 아니라 둘 다 false. 명령 freshness(stale)는 *의도적으로* 검사하지 않는다 — 각 repo
 * 설치경로가 달라 현재 런타임 cliPath로 타 repo를 stale 판정하면 false-positive가 된다(B1 트림 결정).
 */
export function assessRepoHealth(settings: Settings, isGbcProject: boolean): RepoHealth {
  if (!isGbcProject) return { gateDead: false, missingSession: false };
  return {
    gateDead: !hasPreToolUseGate(settings),
    missingSession: !hasSessionStartHook(settings),
  };
}

/**
 * SessionStart hook을 멱등 등록한다. matcher "startup|resume"로 신규 진입·재개에만 발화
 * (compact마다 반복 노이즈 방지). 이미 'hook session-start' 명령이 있으면 추가하지 않는다.
 * settings를 제자리 수정하고, 새로 추가했으면 true(이미 있으면 false)를 반환한다.
 */
export function ensureSessionStartHook(settings: Settings, cliPath: string): boolean {
  for (const entry of settings.hooks?.SessionStart ?? []) {
    for (const h of entry.hooks ?? []) {
      if (h.command.includes("hook session-start")) return false;
    }
  }
  const hooks = (settings.hooks ??= {});
  (hooks.SessionStart ??= []).push({
    matcher: "startup|resume",
    hooks: [{ type: "command", command: buildSessionStartCommand(cliPath) }],
  });
  return true;
}
