import { readFileSync, writeFileSync, existsSync, mkdirSync, lstatSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/** .gbc 디렉토리 경로 보장 */
export function gbcDir(cwd: string): string {
  const dir = join(cwd, ".gbc");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * cwd에서 조상 디렉토리로 올라가며 .gbc가 있는 프로젝트 루트를 찾는다(0.9.3 ST1).
 *
 * 근본원인(fa-support 도그푸딩 오탐 리포트, 2026-07-13): loadPlanSpec은 cwd/.gbc/spec.md만 보고
 * 조상 walk-up이 없다 — 순차 파이프라인 중 hook 진입 시점의 cwd가 프로젝트 루트 하위 디렉토리면
 * "명세 소스: (없음)"으로 오판(명세가 없는 게 아니라 못 찾은 것). git이 .git을 찾는 것과 동일한
 * 관례를 .gbc에 적용한다.
 *
 * - **read-only**: 이 함수는 아무것도 만들지 않는다(mkdir는 gbcDir()가 여전히 전담 — 관심사 분리 유지).
 * - 홈 디렉토리는 후보에서 제외한다: `~/.gbc`는 api-key 등 gbc *전역* 데이터용(resolveApiKey 관례)이라
 *   프로젝트 명세 루트로 오인하면 안 된다.
 * - `.gbc`가 심링크면 신뢰하지 않고 계속 올라간다 — lstatSync는 심링크를 따라가지 않으므로
 *   isDirectory()가 자연히 false가 되어 걸러진다.
 * - 어디서도 못 찾으면 원래 cwd를 그대로 반환한다(신규 프로젝트의 gbcDir mkdir 동작 불변).
 */
export function resolveProjectRoot(cwd: string, opts: { homeDir?: string } = {}): string {
  const home = opts.homeDir ?? homedir();
  const original = cwd;
  let dir = cwd;
  for (;;) {
    if (dir === home) break; // 홈 자신은 절대 후보에 넣지 않는다(전역 ~/.gbc 오인 방지)
    const marker = join(dir, ".gbc");
    try {
      if (lstatSync(marker).isDirectory()) return dir;
    } catch {
      /* 없음 또는 접근 실패 — 다음 조상으로 */
    }
    const parent = dirname(dir);
    if (parent === dir) break; // 파일시스템 루트 도달
    dir = parent;
  }
  return original;
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * 배열 파일 판독의 형상 가드(0.6.1 R3) — 부재/파손뿐 아니라 *valid-JSON 비배열*도 fallback으로
 * 흡수한다. readJson<T[]>(path, [])는 JSON.parse 성공한 객체를 T[]로 캐스팅만 해, 이후 .map이
 * throw→exit1 비정형 fail-open(failopen.log·계측 누락)으로 새던 결함의 근원 통일.
 * (scope.ts readScopeQueue·repos.ts loadRepos에 산개돼 있던 Array.isArray 가드의 단일 소스.)
 */
export function readJsonArray<T>(path: string): T[] {
  const raw = readJson<unknown>(path, []);
  return Array.isArray(raw) ? (raw as T[]) : [];
}

export function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}
