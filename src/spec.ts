import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { gbcDir } from "./store.js";
import { normalizeCase } from "./text.js";

const MAX_SPEC = 12000; // 명세 텍스트 절단 (프롬프트 비대화 방지)

/**
 * 계획 명세를 디스크에서 로드한다. (advisor④: durable 소스만 — 라이브 SubTask는 영속 X)
 * 우선순위: GBC_SPEC_FILE > .gbc/spec.md > "" (빈 명세 = 시나리오 미지정 → 통증#2 차단)
 *
 * .gbc/spec.md가 단일 정본(canonical). 다른 파일(예: 하네스의 scratch.md)을 명세로 쓰려면
 * GBC_SPEC_FILE로 명시 지정한다 — gbc가 소유 안 한 파일을 자동 폴백하지 않는다(0.2.2:
 * scratch.md 자동 폴백 제거. 진행추적 파일을 시나리오 명세로 오인하던 거짓음성 차단).
 *
 * 느슨 매칭은 게이트 LLM이 담당한다(체크리스트 라인/SubTask 항목). 로더는 텍스트만 제공.
 */
export function loadPlanSpec(cwd: string): { text: string; source: string } {
  const candidates: string[] = [];
  if (process.env.GBC_SPEC_FILE) {
    // W1: 상대경로는 프로젝트 cwd 기준으로 해석한다(hook 프로세스의 cwd가 아니라). 절대경로는 그대로.
    const resolved = resolve(cwd, process.env.GBC_SPEC_FILE);
    // 컨테인먼트는 '차단'이 아니라 '경고만' — GBC_SPEC_FILE은 0.2.2에서 의도한 escape-hatch라
    // cwd 밖 공유 명세를 명시 지정하는 정당 용례가 있다. env는 신뢰 경계 밖이 아니므로
    // 막기보다, 예기치 않게 프로젝트 밖을 가리킬 때 사용자에게 보이게만 한다(stderr).
    if (!resolved.startsWith(cwd + sep)) {
      console.error(
        `🐢 gbc: GBC_SPEC_FILE이 프로젝트 밖을 가리킵니다(${resolved}). 의도한 것인지 확인하세요.`,
      );
    }
    candidates.push(resolved);
  }
  candidates.push(join(cwd, ".gbc", "spec.md"));

  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf8");
        const text = raw.length > MAX_SPEC ? raw.slice(0, MAX_SPEC) + "\n…(절단됨)" : raw;
        return { text, source: path };
      } catch {
        // 읽기 실패는 다음 후보로
      }
    }
  }
  return { text: "", source: "(없음)" };
}

/** 명세 해시 — 작업단위 식별용. 명세가 바뀌면 새 작업단위로 간주해 재게이트. */
export function computeSpecHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// --- spec.md 쓰기 (gbc spec 서브커맨드 백엔드) ---
// 도출→검증→등록 루프에서, 사용자 승인된 시나리오를 durable 명세로 기록한다.
// 주 경로는 에이전트가 .gbc/spec.md를 직접 작성하는 것이고, 이 CLI는 한 줄 케이스 추가용 보조.

function specPath(cwd: string): string {
  return join(gbcDir(cwd), "spec.md");
}

/**
 * 케이스 한 줄을 .gbc/spec.md에 append. 파일 없으면 헤더와 함께 생성.
 * 입력은 한 줄로 정규화한다: 줄바꿈→공백(readSpecCases 단일라인 매칭과 정합),
 * 길이 상한 절단(에이전트가 멀티라인/장문 출력을 그대로 add해도 안전).
 *
 * 중복 감지(ST2): 정규화 텍스트가 기존 케이스와 동일하면 등록하지 않고 false 반환
 * (drift 진단 2026-06-26의 2차 증상 — 같은 케이스가 시점만 달리 더미에 누적되던 것 차단).
 * @returns 새로 등록했으면 true, 정규화 동일 케이스가 이미 있어 skip했으면 false.
 */
export function addSpecCase(cwd: string, item: string): boolean {
  const normalized = normalizeCase(item);
  if (readSpecCases(cwd).some((c) => c === normalized)) return false;
  const path = specPath(cwd);
  const line = `- [ ] ${normalized}\n`;
  if (existsSync(path)) {
    appendFileSync(path, line, "utf8");
  } else {
    writeFileSync(path, `# 작업 명세\n\n${line}`, "utf8");
  }
  return true;
}

/** 현재 spec.md의 케이스(체크리스트 라인) 텍스트만 추출. */
export function readSpecCases(cwd: string): string[] {
  const path = specPath(cwd);
  if (!existsSync(path)) return [];
  const cases: string[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const m = raw.match(/^\s*-\s*\[[ xX]\]\s*(.+?)\s*$/);
    if (m) cases.push(m[1]);
  }
  return cases;
}

/** 작업단위 완료 시 spec.md를 비운다 (다음 작업단위로 깨끗이 넘어가기). */
export function clearSpec(cwd: string): void {
  writeFileSync(specPath(cwd), "", "utf8");
}

/** 파일명 안전 타임스탬프(ISO의 ':' '.'을 '-'로). Date 금지 환경 방어(빈 문자열 폴백). */
function nowStamp(): string {
  try {
    return new Date().toISOString().replace(/[:.]/g, "-");
  } catch {
    return "nodate";
  }
}

/**
 * 작업단위 종료(ST3 — gbc done): spec.md 본문을 .gbc/spec.archive/<specHash>-<stamp>.md로
 * 보존한 뒤 비운다. 본문이 비어 있으면 아카이브할 것이 없어 null 반환(clearSpec도 생략).
 *
 * drift 근본수정(2026-06-26): 시스템에 작업단위 "완료" 이벤트가 없어 spec.md가 append 전용으로
 * 영구 누적되고, 과거 완료 케이스가 새 작업단위 등록 시 형제로 부활하던 결함을 닫는다. 이 함수가
 * 그 명시적 완료 이벤트의 데이터 동작이다(게이트 리셋은 호출부 cmdDone이 별도로 — resetGate 불변).
 * @returns 아카이브 파일 경로(보존했으면), 비울 본문이 없으면 null.
 */
/**
 * spec.archive 보존상한(0.5.3 — 0.4.2 보안 S2 해소): 아카이브 파일이 무기한 누적되지 않게
 * 최신 keep개만 남기고 오래된 것부터 삭제한다. 파일명 = <hash 16자>-<ISO stamp>.md 라
 * 시간순은 stamp 부분(slice(17))으로 정렬한다(hash 프리픽스는 시간과 무관).
 * @returns 삭제한 파일명 목록(오래된 순). 디렉토리 부재·읽기 실패는 no-op(fail-silent).
 */
export function pruneSpecArchive(dir: string, keep: number): string[] {
  try {
    const files = readdirSync(dir)
      .filter((n) => n.endsWith(".md"))
      .sort((a, b) => (a.slice(17) < b.slice(17) ? -1 : 1)); // 오래된 것 앞
    if (files.length <= keep) return [];
    const doomed = files.slice(0, files.length - keep);
    const removed: string[] = [];
    for (const n of doomed) {
      try {
        unlinkSync(join(dir, n));
        removed.push(n);
      } catch {
        /* 개별 삭제 실패는 건너뜀 — 상한은 다음 아카이브 때 재시도됨 */
      }
    }
    return removed;
  } catch {
    return [];
  }
}

export function archiveSpec(cwd: string): string | null {
  const path = specPath(cwd);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  if (raw.trim() === "") return null;
  const dir = join(gbcDir(cwd), "spec.archive");
  mkdirSync(dir, { recursive: true });
  const archivePath = join(dir, `${computeSpecHash(raw)}-${nowStamp()}.md`);
  writeFileSync(archivePath, raw, "utf8");
  // 보존상한(기본 20, GBC_ARCHIVE_KEEP 조정) — 방금 쓴 파일 포함 최신 keep개만 남긴다.
  const keep = Number(process.env.GBC_ARCHIVE_KEEP ?? 20);
  if (Number.isFinite(keep) && keep > 0) pruneSpecArchive(dir, keep);
  clearSpec(cwd);
  return archivePath;
}
