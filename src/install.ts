// gbc init 설치 로직 (순수함수 — cli.ts main() 부작용 없이 단위테스트 가능).
// 키 주입은 셸이 아니라 gbc 코드(judge.ts resolveApiKey)가 처리한다 → hook 명령은
// 셸 무관 순수 형태라 native Windows(cmd.exe)/bash/zsh/Mac에서 동일하게 동작한다.

import { existsSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Settings, HookCmd } from "./types.js";

// 리팩토링(2026-07-24) — normalizeHooks·hasStalePreToolUse·hasSessionStartHook·hasPreToolUseGate·
// ensureSessionStartHook 5개 함수가 각각 복붙하던 "settings.hooks?.<event> 이중 for-loop 순회"를
// 공용화(R1). event별 hook 목록 순회는 이 두 헬퍼(forEachHookCmd/findHookCmd)만 경유한다 — 향후
// 이벤트 타입 추가·조건 변경 시 단일 지점만 갱신하면 되므로 드리프트를 구조적으로 차단한다.
function forEachHookCmd(settings: Settings, event: string, fn: (h: HookCmd) => void): void {
  for (const entry of settings.hooks?.[event] ?? []) {
    for (const h of entry.hooks ?? []) fn(h);
  }
}

function findHookCmd(settings: Settings, event: string, predicate: (command: string) => boolean): HookCmd | undefined {
  let found: HookCmd | undefined;
  forEachHookCmd(settings, event, (h) => {
    if (!found && predicate(h.command)) found = h;
  });
  return found;
}

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
/**
 * PreToolUse 명령이 **이미 유효한가** — 정규화(쓰기)와 stale 감지(읽기)가 공유하는 단일 술어.
 * 두 곳이 각자 판정하면 "정규화는 안 하는데 stale이라고 나그하는" 모순이 생긴다(회귀락으로 고정).
 *
 * 유효한 형태는 셋이다:
 *   ⓐ 현재 cliPath 절대경로 · ⓑ ${CLAUDE_PROJECT_DIR} placeholder(자기참조 도그푸딩)
 *   ⓒ **실존하는 다른 cli.js를 가리키는 절대경로**(교차참조 도그푸딩 — 0.14.0 추가)
 *
 * ⓒ가 필요한 이유(실측): 워크스페이스 도그푸딩은 각 repo의 hook이 *개발 중인 repo*의 dist를
 * 절대경로로 가리킨다(등록된 5개 repo 전부가 그랬다). ⓐⓑ만 인정하면 이 형태가 전부 정규화
 * 대상이 되고, `gbc update --all`이 한 번에 전 repo의 도그푸딩 배선을 전역 경로로 갈아치운다 —
 * 무증상으로. 종전엔 사람이 repo 하나씩 의도적으로 init해서 드러나지 않던 갭이다.
 *
 * 판정 기준을 "실존"으로 둔 것은 자가치유를 위해서다: 가리키던 dist가 사라지면(repo 삭제·경로
 * 변경) 그 hook은 어차피 죽은 것이므로 다음 init이 전역 경로로 되살린다.
 * prefix가 붙은 옛 형태(bash 키주입 등)는 정규식이 완전일치라 여기서 걸러지지 않는다 —
 * 진짜 구식 감지는 그대로 살아있다.
 */
function isValidPreCommand(command: string, cliPath: string): boolean {
  if (canonicalPreCommands(cliPath).includes(command)) return true;
  const m = /^node "(.+)" hook pre-tool-use$/.exec(command);
  return m !== null && existsSync(m[1]);
}

export function normalizeHooks(settings: Settings, cliPath: string): number {
  let changed = 0;
  forEachHookCmd(settings, "PreToolUse", (h) => {
    // 이미 유효(절대 or placeholder or 실존 cli.js)면 건드리지 않는다 — 도그푸딩 설치를
    // 깨뜨리지 않게. 진짜 구식(옛 bash 키주입 등)·죽은 경로만 절대경로로 교체.
    if (h.command.includes("hook pre-tool-use") && !isValidPreCommand(h.command, cliPath)) {
      h.command = buildPreCommand(cliPath);
      changed++;
    }
  });
  return changed;
}

/** SessionStart hook 명령 — 셸 무관 순수 명령(buildPreCommand와 동일 규약). */
export function buildSessionStartCommand(cliPath: string): string {
  return `node "${cliPath}" hook session-start`;
}

/** PostToolUse hook 명령(0.12.3 P2a) — 셸 무관 순수 명령(buildPreCommand와 동일 규약). */
export function buildPostToolUseCommand(cliPath: string): string {
  return `node "${cliPath}" hook post-tool-use`;
}

/**
 * (read-only) PreToolUse hook 명령이 현재 표준(pure)과 다른 구버전인지. normalizeHooks의
 * 감지부만 떼어낸 비파괴 술어 — ②init-staleness 안내가 settings를 수정하지 않고 판단하게 한다.
 */
export function hasStalePreToolUse(settings: Settings, cliPath: string): boolean {
  // 판정은 normalizeHooks와 **같은 술어**(isValidPreCommand)를 공유한다 — dev placeholder도,
  // 실존하는 교차참조 dist도 정식이므로 stale 아님. 절대경로 런타임에서 placeholder를 구식으로
  // 오판해 'gbc init' 재실행을 헛권하던 false-positive 차단(B-잔여 #3의 실제 증상)의 연장선.
  return (
    findHookCmd(
      settings,
      "PreToolUse",
      (c) => c.includes("hook pre-tool-use") && !isValidPreCommand(c, cliPath),
    ) !== undefined
  );
}

/** (read-only) SessionStart hook(session-start 명령)이 등록돼 있는지. 0.2.1 이하 init엔 없음. */
export function hasSessionStartHook(settings: Settings): boolean {
  return findHookCmd(settings, "SessionStart", (c) => c.includes("hook session-start")) !== undefined;
}

/** (read-only) PostToolUse hook(post-tool-use 명령)이 등록돼 있는지(0.12.3 P2a). 0.12.2 이하 init엔 없음. */
export function hasPostToolUseHook(settings: Settings): boolean {
  return findHookCmd(settings, "PostToolUse", (c) => c.includes("hook post-tool-use")) !== undefined;
}

/**
 * (read-only) PreToolUse 게이트 hook('hook pre-tool-use' 명령)이 등록돼 있는지 — cliPath 무관.
 * hasStalePreToolUse가 *명령 freshness*(cliPath 의존)를 보는 반면, 이건 *존재 자체*만 본다.
 * 크로스-repo 건강성 판정에 쓴다: 타 repo의 정식 cliPath를 알 수 없으므로(각 설치경로 상이) freshness는
 * 검사 불가지만, '게이트 hook이 아예 없음'(=게이트 조용히 죽음)은 cliPath 없이도 결정론적으로 잡힌다.
 */
export function hasPreToolUseGate(settings: Settings): boolean {
  return findHookCmd(settings, "PreToolUse", (c) => c.includes("hook pre-tool-use")) !== undefined;
}

/**
 * repo 건강성 — gateDead=gbc 프로젝트인데 게이트 hook 부재, missingSession=SessionStart hook 부재,
 * missingPostToolUse=PostToolUse hook 부재(0.12.3 P2a — 작업단위 적용이력 원장이 안 쌓이는 신호).
 */
export interface RepoHealth {
  gateDead: boolean;
  missingSession: boolean;
  missingPostToolUse: boolean;
}

/**
 * 크로스-repo 게이트 건강성을 settings로 판정(cliPath 무관·결정론적). isGbcProject=false(.gbc 없음)면
 * 게이트 대상이 아니라 전부 false. 명령 freshness(stale)는 *의도적으로* 검사하지 않는다 — 각 repo
 * 설치경로가 달라 현재 런타임 cliPath로 타 repo를 stale 판정하면 false-positive가 된다(B1 트림 결정).
 */
export function assessRepoHealth(settings: Settings, isGbcProject: boolean): RepoHealth {
  if (!isGbcProject) return { gateDead: false, missingSession: false, missingPostToolUse: false };
  return {
    gateDead: !hasPreToolUseGate(settings),
    missingSession: !hasSessionStartHook(settings),
    missingPostToolUse: !hasPostToolUseHook(settings),
  };
}

/** `gbc update`가 재init을 돌릴(또는 건너뛸) 대상 1건. reason은 skip일 때만 채운다. */
export interface UpdateTarget {
  path: string;
  action: "init" | "skip";
  reason?: string;
}

/**
 * `gbc update [--all]`이 어느 경로에 재init을 돌릴지 산정한다(순수함수 — 스폰·쓰기 없음).
 *
 * 순회 자체는 프로세스 스폰이라 결정론 테스트가 어렵다. 그래서 "어디에 돌릴지"만 떼어내
 * 검증 가능하게 둔다(evaluateGate가 judge·collectCaseEvidence를 deps로 뺀 것과 같은 원칙).
 *
 * - `repos`는 호출부가 정한다: `--all`이면 loadRepos(), 아니면 [] — 이 함수는 플래그를 모른다.
 * - **cwd가 항상 먼저**다. 레지스트리에 cwd가 이미 있어도 두 번 돌지 않는다(실측 레지스트리가
 *   실제로 자기 자신을 포함한다). dedup 키는 resolve된 절대경로.
 * - 건너뛰기는 세 가지: 디렉토리 자체가 없음(레지스트리 stale 항목 — 실측으로 존재한다) ·
 *   **디렉토리가 아님(심링크 포함)** · `.gbc`가 없어 gbc 프로젝트가 아님.
 *   전부 **조용히 빠뜨리지 않고 사유를 남긴다**.
 *   등록만 해두고 init한 적 없는 repo를 여기서 init해버리면 사용자가 의도하지 않은 곳에
 *   hook을 심게 되므로, 판단 기준은 "이미 gbc 프로젝트인가"다.
 *
 * ⚠️ **단일 `lstatSync`로 부재·심링크를 한 번에 판정한다**(발행 전 보안검토 W4). `repos.json`은
 * 다른 프로세스가 쓸 수 있는 전역 파일이라 신뢰하지 않는다는 것이 이 저장소의 관례이고,
 * cmdMetrics --all·doctor·gate-core 등이 전부 같은 방식으로 심링크를 거부한다. 여기만
 * `existsSync`를 쓰면 그 관례에서 이탈하는데, **이 경로의 결과는 읽기가 아니라 쓰기+스폰**이라
 * (`gbc init --yes`가 그 디렉토리에 settings.json·스킬을 심는다) 오히려 더 엄격해야 한다.
 * `existsSync`+`lstatSync` 분리를 쓰지 않는 이유도 관례와 동일 — 두 번 보면 그 사이가 TOCTOU 창이다.
 */
export function planUpdateTargets(cwd: string, repos: string[]): UpdateTarget[] {
  const seen = new Set<string>();
  const out: UpdateTarget[] = [];
  for (const raw of [cwd, ...repos]) {
    const path = resolve(raw);
    if (seen.has(path)) continue;
    seen.add(path);
    let isDir: boolean;
    try {
      isDir = lstatSync(path).isDirectory(); // 심링크면 false(따라가지 않는다), 부재면 throw
    } catch {
      isDir = false;
      out.push({ path, action: "skip", reason: "디렉토리 없음(레지스트리 stale 항목)" });
      continue;
    }
    if (!isDir) {
      out.push({ path, action: "skip", reason: "디렉토리 아님(심링크 등 — 안전상 제외)" });
    } else if (!existsSync(join(path, ".gbc"))) {
      out.push({ path, action: "skip", reason: "gbc 프로젝트 아님(.gbc 없음)" });
    } else {
      out.push({ path, action: "init" });
    }
  }
  return out;
}

/**
 * SessionStart hook을 멱등 등록한다. matcher "startup|resume"로 신규 진입·재개에만 발화
 * (compact마다 반복 노이즈 방지). 이미 'hook session-start' 명령이 있으면 추가하지 않는다.
 * settings를 제자리 수정하고, 새로 추가했으면 true(이미 있으면 false)를 반환한다.
 */
export function ensureSessionStartHook(settings: Settings, cliPath: string): boolean {
  if (findHookCmd(settings, "SessionStart", (c) => c.includes("hook session-start"))) return false;
  const hooks = (settings.hooks ??= {});
  (hooks.SessionStart ??= []).push({
    matcher: "startup|resume",
    hooks: [{ type: "command", command: buildSessionStartCommand(cliPath) }],
  });
  return true;
}

/**
 * PostToolUse hook을 멱등 등록한다(0.12.3 P2a — 작업단위 적용이력 기록, ensureSessionStartHook과
 * 동일 규약). PreToolUse와 같은 matcher(Edit|Write|MultiEdit)로 편집 성공 시에만 발화. 이미
 * 'hook post-tool-use' 명령이 있으면 추가하지 않는다.
 */
export function ensurePostToolUseHook(settings: Settings, cliPath: string): boolean {
  if (findHookCmd(settings, "PostToolUse", (c) => c.includes("hook post-tool-use"))) return false;
  const hooks = (settings.hooks ??= {});
  (hooks.PostToolUse ??= []).push({
    matcher: "Edit|Write|MultiEdit",
    hooks: [{ type: "command", command: buildPostToolUseCommand(cliPath) }],
  });
  return true;
}
