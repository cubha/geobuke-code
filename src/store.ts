import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** .gbc 디렉토리 경로 보장 */
export function gbcDir(cwd: string): string {
  const dir = join(cwd, ".gbc");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
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
