import { readFileSync, writeFileSync, existsSync, mkdirSync, rmdirSync, lstatSync, renameSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { homedir } from "node:os";

/**
 * 어휘 컨테인먼트(경로 문자열 비교) — abs가 cwd 자신이거나 cwd 하위인지(junit.ts·verify.ts 공용
 * 추출, 2026-07-24 리팩토링 R1). resolve()는 어휘 연산이라 cwd 내부 심링크가 밖을 가리키는 것은
 * 못 막는다 — 호출부가 lstatSync 등으로 별도 방어해야 한다(1차 관문일 뿐).
 */
export function isWithinCwd(abs: string, cwd: string): boolean {
  return abs === cwd || abs.startsWith(cwd + sep);
}

/**
 * JSON을 객체로 읽는다 — non-object(null·배열 등)는 defaultValue로 방어(repos.ts readVerifyRunMap·
 * session-map.ts readMap 공용 추출, 2026-07-24 리팩토링 R1). 다른 프로세스가 쓰는 글로벌 파일이라
 * 형상을 무조건 신뢰하지 않는다는 관례(W4)의 공통 1차 관문 — 값 단위 타입 필터링(문자열만 허용 등)은
 * 호출부가 각자 이어서 수행한다.
 */
export function readJsonObject<T extends Record<string, unknown>>(path: string, defaultValue: T): T {
  const raw = readJson<unknown>(path, defaultValue);
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as T) : defaultValue;
}

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

/**
 * 원자적 쓰기(0.10.0 A3b ST8) — repos.json/verify-run.json/session-map.json은 다른 프로세스(gbc
 * CLI 단발 호출·TUI 장수 프로세스)가 동시에 쓸 수 있는 글로벌 파일이다. writeFileSync(path, data)로
 * 대상 파일을 직접 덮어쓰면, 쓰는 도중(특히 큰 페이로드가 여러 write syscall로 쪼개질 때) 다른
 * 프로세스가 torn(잘린) JSON을 읽을 수 있다. 같은 디렉토리에 temp로 먼저 쓰고 rename()으로 교체하면
 * — rename은 POSIX에서 원자적(같은 파일시스템 내)이라 — 읽는 쪽은 항상 "이전 완전한 내용" 또는
 * "새 완전한 내용" 둘 중 하나만 본다. temp 파일명에 pid를 넣어 서로 다른 프로세스가 동시에 써도
 * temp끼리 충돌하지 않는다(단일 프로세스 내부는 동기 실행이라 애초에 겹칠 수 없음).
 */
export function writeJson(path: string, data: unknown): void {
  const tmpPath = join(dirname(path), `.${basenameOf(path)}.tmp-${process.pid}`);
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmpPath, path);
}

/** 크로스플랫폼 경로 마지막 세그먼트 추출(공용, hook.ts 크로스-repo 힌트와 동일 목적으로 재사용). */
export function basenameOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

// ===== 최소 크로스프로세스 락(0.10.0 A3b ST8) =====
// temp+rename(위 writeJson)은 torn read(쓰는 도중 깨진 내용 읽기)만 막는다 — repos.ts의
// addRepo/removeRepo, session-map.ts의 setLastSessionId/clearLastSessionId처럼 "읽고→고치고→쓰는"
// 시퀀스 전체를 다른 프로세스(gbc CLI 단발 호출 vs TUI 장수 프로세스)가 끼어들면 lost-update(먼저
// 쓴 쪽의 변경이 나중 rename에 덮여 사라짐)가 여전히 가능하다(scope-critic 지적). mkdirSync는 POSIX·
// Windows 공통으로 "디렉토리가 이미 있으면 EEXIST" 원자성이 보장돼, 별도 의존성 없이 락 프리미티브로
// 쓸 수 있다.

// 최악의 경우 이 시간까지만 대기 — 그 이상은 fail-open(무기한 차단 금지). TUI는 이 대기 동안 이벤트
// 루프가 완전히 블로킹되므로(동기 busy-spin, scope-critic 지적) 500ms보다 짧게 잡아 화면 무응답
// 체감을 줄인다 — 경합 자체가 희귀 이벤트(TUI 저장 vs CLI 단발 호출이 정확히 같은 순간)라 값을
// 줄여도 lost-update 방지 효과는 거의 그대로 유지된다.
const LOCK_TIMEOUT_MS = 150;
const LOCK_RETRY_SPIN_MS = 5;

/** 동기 스핀 대기(짧고 유한) — 이 코드베이스 전체가 동기 I/O라 진짜 sleep이 없다. */
function spinWait(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* 의도적 busy-wait — LOCK_TIMEOUT_MS로 총 상한이 걸려 있다 */
  }
}

/**
 * path에 대한 read-modify-write 전체를 락으로 감싼다. 락 획득 실패(타임아웃)는 **fail-open**으로
 * 그냥 진행한다 — 이 락은 최선의 보호이지 게이트가 아니다(gbc의 fail-open 원칙과 동형, judge.ts
 * failOpenVerdict 참조): 락 파일이 죽은 프로세스 것으로 stale해도 이 프로그램이 영구히 멈추면 안 된다.
 */
export function withStoreLock<T>(path: string, fn: () => T): T {
  const lockDir = `${path}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) break; // fail-open
      spinWait(LOCK_RETRY_SPIN_MS);
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lockDir);
    } catch {
      // 이미 없거나(경합) 정리 실패 — 다음 락 획득자가 mkdirSync로 다시 만들 뿐 무해.
    }
  }
}
