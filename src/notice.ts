// 업데이트 안내 — ②init-staleness(결정론적, 네트워크 없음) + ①version(캐시 비교, ST4에서 추가).
// PreToolUse cache-miss 경로 + SessionStart + gbc status에서 호출, 세션당 1회 dedup.
// 게이트 판정과 완전 독립 — 안내 실패가 게이트 결정에 절대 영향 주지 않는다(fail-silent).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gbcDirPath, ensureGbcDir } from "./store.js";
import { nowIso } from "./time.js";
import { hasStalePreToolUse, hasSessionStartHook } from "./install.js";
import { readVersionCache, buildVersionNotice } from "./version.js";

import type { Settings } from "./types.js";

/** 프로젝트 로컬 .claude/settings.json 읽기(없거나 깨지면 빈 객체). read-only. */
export function readProjectSettings(cwd: string): Settings {
  try {
    return JSON.parse(readFileSync(join(cwd, ".claude", "settings.json"), "utf8")) as Settings;
  } catch {
    return {};
  }
}

/**
 * ②init-staleness: settings.json 상태로 hook 구버전/누락을 감지해 'gbc init --yes' 재실행을
 * 안내한다. 버전 숫자가 아니라 실제 hook 상태로 판단 → 정말 필요한 프로젝트만 알린다.
 * - SessionStart 미등록: 0.2.1 이하 init 코호트(가장 흔한 staleness). PreToolUse 경로로만 도달 가능.
 * - PreToolUse 명령 구식: 옛 bash 키주입 prefix 등.
 * 둘 다 아니면 "".
 *
 * ⚠️ 이 함수는 `settings`(호출부가 읽어온 .claude/settings.json)의 **정확성을 전제**한다 — 순수
 * 함수 자신은 어느 cwd에서 읽었는지 모른다. 0.12.2 이전엔 하위 stray .gbc가 resolveProjectRoot를
 * 가로채(SubTask2 이전) hook.ts가 엉뚱한(설정 없는) 디렉토리의 settings.json을 읽어 진짜 루트에
 * SessionStart hook이 있어도 "미등록"으로 오탐했다(이 세션의 발단 버그). 근본수정은 **여기가 아니라**
 * store.ts의 resolveProjectRoot(isRealGateRoot 술어)에 있다 — 이 함수의 계약(정확한 settings가
 * 들어오면 정확히 판단한다)은 원래도 맞았다. 회귀락: hook.test 계열의 daily-news-dispatch 재현 테스트.
 */
export function buildInitStalenessNotice(settings: Settings, cliPath: string): string {
  const stale = hasStalePreToolUse(settings, cliPath);
  const missingSession = !hasSessionStartHook(settings);
  if (!stale && !missingSession) return "";
  const reasons: string[] = [];
  if (missingSession) reasons.push("SessionStart hook 미등록");
  if (stale) reasons.push("PreToolUse hook 명령 구식");
  return (
    `🐢 거북이 게이트 — 이 프로젝트 hook이 최신이 아닙니다(${reasons.join(", ")}). ` +
    `'gbc init --yes' 재실행을 권장합니다(머지·멱등·백업).`
  );
}

function notifiedPath(cwd: string): string {
  return join(gbcDirPath(cwd), "notified.json");
}

/** 이 세션에서 이미 안내했는지 — 같은 session_id면 true. dedup(세션당 1회). fail-silent. */
export function wasNotified(cwd: string, session: string): boolean {
  try {
    const j = JSON.parse(readFileSync(notifiedPath(cwd), "utf8")) as { session?: string };
    return j.session === session;
  } catch {
    return false;
  }
}

/** 이 세션을 '안내함'으로 기록. 기록 실패는 무시(안내가 게이트를 방해하지 않게). */
export function markNotified(cwd: string, session: string): void {
  try {
    ensureGbcDir(cwd);
    writeFileSync(notifiedPath(cwd), JSON.stringify({ session, at: nowIso() }));
  } catch {
    /* 안내 기록 실패는 무시(fail-silent) */
  }
}

/**
 * 업데이트 안내 조합 문자열(②init-staleness + ①신버전). 없으면 "".
 * GBC_NO_UPDATE_NOTICE=1이면 항상 "". 네트워크 없음 — version은 캐시(~/.gbc/version-check.json)만 읽는다.
 */
export function buildUpdateNotice(
  settings: Settings,
  cliPath: string,
  currentVersion: string,
  home?: string,
): string {
  if (process.env.GBC_NO_UPDATE_NOTICE === "1") return "";
  const lines: string[] = [];
  const stale = buildInitStalenessNotice(settings, cliPath);
  if (stale) lines.push(stale);
  const version = buildVersionNotice(currentVersion, readVersionCache(home));
  if (version) lines.push(version);
  return lines.join("\n");
}
