// ①신버전 안내 — npm 최신 버전을 캐시에 두고 SessionStart/PreToolUse/status에서 비교만 한다.
// hook 핫패스에 동기 네트워크를 들이지 않는다: 표시는 캐시만 읽고, 갱신은 안전한 지점
// (SessionStart·status)에서 짧은 타임아웃 fetch로만. 실패는 조용히 무시(게이트 무관, fail-silent).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const PKG = "geobuke-code";
const TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 1500;

export interface VersionCache {
  latest: string;
  checkedAt: number;
}

export function cachePath(home: string = homedir()): string {
  return join(home, ".gbc", "version-check.json");
}

/**
 * semver 비교(숫자 major.minor.patch만). a<b면 -1, 같으면 0, a>b면 1.
 * prerelease/빌드메타·비숫자는 비교 불가로 보고 0(안내 안 함 → 거짓 안내 방지).
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split("-")[0].split(".");
  const pb = b.split("-")[0].split(".");
  for (let i = 0; i < 3; i++) {
    const x = Number(pa[i] ?? 0);
    const y = Number(pb[i] ?? 0);
    if (Number.isNaN(x) || Number.isNaN(y)) return 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

export function readVersionCache(home?: string): VersionCache | null {
  try {
    const j = JSON.parse(readFileSync(cachePath(home), "utf8")) as VersionCache;
    if (typeof j.latest === "string" && typeof j.checkedAt === "number") return j;
    return null;
  } catch {
    return null;
  }
}

export function writeVersionCache(cache: VersionCache, home?: string): void {
  try {
    const path = cachePath(home);
    // ~/.gbc가 없을 수 있다(api-key 없는 신규 설치 = ① 안내의 주 타깃) → 디렉토리 보장 후 기록.
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache));
  } catch {
    /* 캐시 기록 실패는 무시(fail-silent) */
  }
}

/** 캐시가 없거나 TTL(24h) 초과면 stale. now는 주입 가능(테스트). */
export function isCacheStale(cache: VersionCache | null, now: number = Date.now()): boolean {
  if (!cache) return true;
  return now - cache.checkedAt > TTL_MS;
}

/**
 * 신버전 안내 문자열(캐시만 비교, 네트워크 없음). cache.latest > current일 때만 안내, 아니면 "".
 * 캐시 없음/비교불가/동일·하위면 "".
 */
export function buildVersionNotice(current: string, cache: VersionCache | null): string {
  if (!cache || !cache.latest || !current) return "";
  if (compareVersions(current, cache.latest) >= 0) return "";
  return (
    `🐢 거북이코드 신버전 ${cache.latest} 사용 가능(현재 ${current}). ` +
    `갱신: 'gbc update'(전역 최신 + 현재 프로젝트 재init) 또는 수동 'npm i -g geobuke-code@latest → gbc init --yes'`
  );
}

/**
 * npm 레지스트리에서 최신 버전을 받아 캐시에 쓴다(짧은 타임아웃, 비차단·fail-silent).
 * spawn(npm) 대신 fetch — Windows .cmd 실행 문제를 피한다. 실패·타임아웃은 조용히 무시.
 */
export async function refreshVersionCache(home?: string, now: number = Date.now()): Promise<void> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(`https://registry.npmjs.org/${PKG}/latest`, { signal: ctrl.signal });
      if (!resp.ok) return;
      const j = (await resp.json()) as { version?: string };
      if (j && typeof j.version === "string") {
        writeVersionCache({ latest: j.version, checkedAt: now }, home);
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    /* 네트워크 실패·타임아웃·파싱 실패 모두 무시(fail-silent) */
  }
}
