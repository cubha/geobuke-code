// gbc init 설치 로직 (순수함수 — cli.ts main() 부작용 없이 단위테스트 가능).
// 키 주입은 셸이 아니라 gbc 코드(judge.ts resolveApiKey)가 처리한다 → hook 명령은
// 셸 무관 순수 형태라 native Windows(cmd.exe)/bash/zsh/Mac에서 동일하게 동작한다.

interface HookCmd {
  type: string;
  command: string;
}
interface HookEntry {
  matcher?: string;
  hooks: HookCmd[];
}
interface Settings {
  hooks?: Record<string, HookEntry[]>;
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
  const target = buildPreCommand(cliPath);
  let changed = 0;
  for (const entry of settings.hooks?.PreToolUse ?? []) {
    for (const h of entry.hooks ?? []) {
      if (h.command.includes("hook pre-tool-use") && h.command !== target) {
        h.command = target;
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
  const target = buildPreCommand(cliPath);
  for (const entry of settings.hooks?.PreToolUse ?? []) {
    for (const h of entry.hooks ?? []) {
      if (h.command.includes("hook pre-tool-use") && h.command !== target) return true;
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
