// 결정론 근거 주입(2026-08-07, 게이트 오탐 RCA — P2b, braintrust ⓓ). block 판정 재검토를 창 위치
// 추측(ⓐ 절단 윈도우)이 아니라 grep 실측 근거로 메운다. 이 파일은 순수 부품 + 근거수집기까지만
// 담는다 — 판정 배선(block 경로 2단계 재판정, Write 억제, fail-open 값검사)은 ST12가
// gate-core.ts에서 다룬다(이 파일은 judge를 호출하지 않는다).
import { IDENT_KEYWORDS, realGrep, parseGrepOutput, formatGrepContext, MAX_GREP_SYMBOLS, GREP_INCLUDE_EXTS, GREP_TIMEOUT_MS, canonicalPath } from "./scope.js";
import { redactSecrets } from "./extraction.js";
import type { GrepRunner, GrepMatch } from "./scope.js";

/** 케이스당 grep 심볼 상한(과다 grep 방지 — scope.ts MAX_GREP_SYMBOLS와 별도, 케이스 단위라 더 작다). */
const MAX_CASE_SYMBOLS = 5;

/**
 * 명세 산문에 흔히 섞이는 짧은 기술 약어 — 단독 토큰으로 나오면(`\b` 경계라 getUser 등 긴 식별자의
 * 일부는 안 걸림) grep 노이즈가 될 가능성이 높아 보수적으로 제외한다. RCA 실측 사례(metaCrypto.ts·
 * ensureFolderPath)엔 해당 없음 — 실사용에서 과다/과소 제외가 드러나면 조정 대상(추정 기반 초기값).
 */
const COMMON_TECH_WORDS = new Set([
  "api", "url", "uri", "css", "sql", "xml", "utf", "png", "jpg", "gif",
  "get", "put", "del", "add", "set", "map", "app", "env", "npm",
]);

/**
 * 파일명 **인식**용 정규식 — 넓게 잡는다. 여기 걸린 구간은 전부 마스킹되므로(아래 extractCaseSymbols
 * 1)단계) basename이 일반 식별자로 새어나가 무관한 매치를 근거로 올리는 것을 막는다.
 */
const FILE_TOKEN_RE = /\b[\w-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|h|cpp|cs|kt|swift|json|css|html|md)\b/g;
/**
 * 그 중 **실제로 grep 대상이 되는** 확장자 — `scope.ts`의 `GREP_INCLUDE_EXTS`를 그대로 쓴다(단일
 * 소스, 0.12.0 F-4). 이 집합 밖 확장자는 심볼로 내보내지 않는다: grep이 그 파일을 아예 스캔하지
 * 않으므로 **어떤 경우에도 매치가 나올 수 없는데** `MAX_GREP_SYMBOLS`(8) 예산만 먹고, 정작 매치
 * 가능한 심볼이 예산 소진으로 조회되지 못하는 일이 생긴다(ANALYSIS F-4·F-14).
 *
 * ⚠️ 반대 방향(`GREP_INCLUDE_EXTS`를 넓히기)은 채택하지 않았다 — `realGrep`은 `collectGrepContext`
 * (축A 파급반경·축B 사다리 사후판정)와 **공유**되므로, 넓히면 게이트와 무관한 scope 판정까지 동시에
 * 바뀐다. 좁히는 쪽은 판정 결과가 불변(제외되는 토큰은 원래 무매치)이라 파급이 없다.
 */
const GREPPABLE_EXT = new Set(GREP_INCLUDE_EXTS);
/** 일반 식별자 토큰 정규식 — ASCII 알파벳/숫자/밑줄, 3자 이상, 앞뒤 단어 경계(한국어 조사 등과 분리). */
const IDENT_TOKEN_RE = /\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g;

/**
 * 명세 케이스 텍스트(한국어 산문 + 섞인 영문 식별자/파일명)에서 grep 가능한 토큰을 순수 추출한다.
 * scope.ts의 `extractSymbols`는 코드 정의 패턴(`function foo(`, `const bar =`)을 찾는 정규식이라
 * "ensureFolderPath 비교 로직" 같은 한국어 명세 라인엔 매치가 안 나 무력하다(RCA 실측) — 별도 함수.
 * 파일명 토큰을 먼저 뽑아 그 구간을 식별자 정규식이 다시 쪼개 부분 매치를 만들지 않게 마스킹한다.
 */
export function extractCaseSymbols(caseText: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const key = raw.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(raw);
  };

  // 1) 파일명 토큰 먼저 — "metaCrypto.ts" 전체를 하나의 토큰으로 보존.
  // 인덱스 기반 마스킹(scope-critic 실측 지적, 2026-08-08): String.replace(문자열, ...)는
  // *첫 매치만* 치환한다 — 같은 파일명이 텍스트에 두 번 나오면 두 번째는 안 지워져 뒤 식별자
  // 정규식이 "metaCrypto"만 다시 뽑는 부분매치가 새어나갔다. matchAll의 m.index로 문자 배열을
  // 직접 지워 모든 출현을 마스킹한다.
  const chars = caseText.split("");
  for (const m of caseText.matchAll(FILE_TOKEN_RE)) {
    // 마스킹은 확장자와 무관하게 **항상** — grep 대상이 아니어도 basename("auth"·"config")이 아래
    // 식별자 정규식에 다시 잡히면 무관한 파일의 매치를 근거로 올리게 된다(F-4 주석 참조).
    if (GREPPABLE_EXT.has(m[1].toLowerCase())) add(m[0]);
    for (let i = m.index; i < m.index + m[0].length; i++) chars[i] = " ";
  }
  const masked = chars.join("");

  // 2) 남은 텍스트에서 일반 식별자 토큰.
  for (const m of masked.matchAll(IDENT_TOKEN_RE)) {
    const name = m[0];
    const lower = name.toLowerCase();
    if (IDENT_KEYWORDS.has(lower) || COMMON_TECH_WORDS.has(lower)) continue;
    add(name);
  }

  return out.slice(0, MAX_CASE_SYMBOLS);
}

/**
 * 2차 판정에 실리는 `[관련 코드 근거(grep)]` **총량** 상한(0.12.0 F-9). `formatGrepContext`는
 * 케이스 1건당 `MAX_SCOPE_CONTEXT_CHARS`(4000)만 캡했고 케이스들을 이어붙이는 지점엔 캡이 없었다.
 * `missing`은 개수 제한이 없는 데다(judge `parseVerdict`) 심볼 캐시 때문에 여러 케이스가 **같은
 * 매치 목록을 복제**해 갖는다 — 10건이면 최대 40KB가 프롬프트에 실렸다.
 *
 * 값은 `judge.ts`의 `MAX_CURRENT_FILE`(8000)과 동급으로 맞춘다: 근거는 재판정의 존재 이유이므로
 * 파일 상태보다 작아선 안 되고, 그렇다고 그것을 압도해서도 안 된다.
 */
export const MAX_EVIDENCE_CONTEXT_CHARS = 8000;

/**
 * 근거 블록에 실리는 **케이스 라벨** 길이 상한(0.12.0 F-9 보강). 라벨은 모델이 반환한 missing
 * 항목 원문인데 `parseVerdict`가 길이를 캡하지 않아, 장문 서술이 오면 라벨만으로 총량 상한을
 * 넘길 수 있다 — "첫 1건은 상한을 넘어도 담는다"는 예외와 결합하면 상한 선언 자체가 무의미해진다.
 */
export const MAX_EVIDENCE_CASE_LABEL = 200;

/**
 * 이번 편집이 **지우는** self-file 줄 범위(0.12.0 F-8). P2b는 편집이 적용되기 *전*의 파일을
 * grep하므로, Edit이 케이스 구현 코드를 삭제하는 편집일 때 그 코드가 아직 디스크에 남아 있어
 * "이미 구현됨"으로 근거에 실린다 — `GATE_SYSTEM` ★★ 규칙(덮어쓰기로 삭제되는 회귀는 여전히
 * missing)과 정면 충돌하며 정답인 block을 pass로 논증하게 만든다. Write는 gate-core가
 * `isOverwriteEdit`로 P2b 자체를 억제하므로, 이 함수는 그 가드의 **Edit/MultiEdit 대칭축**이다.
 */
export interface DeletionScope {
  /** cwd 기준 상대경로(정규화) — grep 매치의 file과 대조할 키. */
  file: string;
  /** 이 편집으로 사라지는 줄 번호(1-based). */
  lines: Set<number>;
}

/**
 * grep 출력 경로(`./src/a.ts`)와 tool_input 경로(절대·상대 혼재)를 같은 키로 정규화.
 * `scope.ts`의 `canonicalPath`를 **그대로 재사용**한다(0.12.0, security-auditor 지적) — 자체 구현
 * (resolve+relative의 순수 lexical 비교)은 심링크를 해소하지 않아, grep(`-r`은 디렉터리 심링크를
 * 따라가지 않아 실경로를 보고한다)과 편집 경로가 어긋나면 삭제-근거 필터가 조용히 fail-open했다.
 */
function relKey(cwd: string, filePath: string): string {
  return canonicalPath(cwd, filePath);
}

/**
 * 편집 대상 파일에서 이번 편집이 삭제하는 줄을 산출한다(순수). old_string이 하나도 없으면 null
 * (= 억제할 것 없음). **줄 단위 생존 비교**를 쓴다: old_string 범위에 걸친 파일 줄 중 그 내용이
 * new_string에도 그대로 나타나면 삭제가 아니다(수정·삽입 편집은 근거를 그대로 유지).
 *
 * MultiEdit은 편집들이 순차 적용돼 뒤 편집의 old_string 오프셋이 앞 편집으로 밀리지만, 여기선
 * **편집 전 원본**에서만 찾는다 — 못 찾은 편집은 조용히 건너뛴다. 근사이되 방향이 안전한 근사다:
 * 놓치면 근거가 남아 pass 쪽으로 기울 수 있으나, 그 경우는 이미 앞 편집이 같은 구간을 건드린
 * 상황이라 대개 상위 범위가 먼저 삭제로 잡힌다. 반대로 과잉 억제(근거 제거→block 유지)는
 * gbc thesis상 미탐보다 나은 쪽이라 경계선에서는 억제 쪽으로 기운다.
 */
export function computeDeletionScope(
  cwd: string,
  filePath: string,
  currentFileContent: string,
  edits: Array<{ old_string?: string; new_string?: string }>,
): DeletionScope | null {
  const real = edits.filter((e) => e.old_string);
  if (real.length === 0) return null;
  const fileLines = currentFileContent.split("\n");
  const lines = new Set<number>();
  for (const e of real) {
    const idx = currentFileContent.indexOf(e.old_string!);
    if (idx < 0) continue; // 앞 편집으로 이미 밀린 MultiEdit 항목 — 원본에 없으면 건너뛴다(위 doc)
    const startLine = currentFileContent.slice(0, idx).split("\n").length; // 1-based
    const endLine = startLine + e.old_string!.split("\n").length - 1;
    const survivors = new Set(
      (e.new_string ?? "").split("\n").map((l) => l.trim()).filter((l) => l.length > 0),
    );
    for (let ln = startLine; ln <= endLine; ln++) {
      const text = (fileLines[ln - 1] ?? "").trim();
      if (text.length === 0) continue; // 빈 줄은 근거가 될 수 없으므로 표시할 필요도 없음
      if (!survivors.has(text)) lines.add(ln);
    }
  }
  return { file: relKey(cwd, filePath), lines };
}

/**
 * 근거수집 전체의 **벽시계** 예산(ms, 0.12.0 F-5). 심볼 개수 예산(`MAX_GREP_SYMBOLS`=8)만으로는
 * 지연이 유계가 아니다 — `realGrep` 1회가 `GREP_TIMEOUT_MS`(4000)까지 갈 수 있어 최악 8회 = 32초,
 * 그 뒤에 2차 judge 호출(CLI 폴백이면 30초)까지 붙는다. PreToolUse는 사용자의 편집을 붙잡고 있는
 * hot path라 개수가 아니라 시간을 캡해야 한다.
 *
 * 값 근거: 정상 repo에서 grep 8회는 통상 2초 미만이라 이 예산은 **병적인 경우에만** 발동한다
 * (평상시 동작 불변). 반대로 상한을 이보다 키우면 `judge` 2회와 합쳐 훅 전체가 1분을 넘긴다.
 *
 * ⚠️ 이 값은 **진짜 하드 상한**이어야 한다(scope-critic 실측 지적, 2026-08-09). 검사를 "grep 호출
 * 전"에만 두면 경계 직전에 시작한 grep이 `GREP_TIMEOUT_MS`만큼 더 돌아 실제 상한이 8s+4s=12s가
 * 된다. 검사를 호출 *직후*로 옮겨도 이미 시작된 grep은 못 멈추므로 상한은 그대로다 — 그래서
 * **남은 예산이 grep 1회 최악값보다 작으면 아예 시작하지 않는다**(아래 START_DEADLINE_MS).
 */
export const EVIDENCE_TIME_BUDGET_MS = 8000;

/**
 * 새 grep을 **시작해도 되는** 마지막 시점(경과 ms). 이 시각을 넘겨 시작한 grep은 최악의 경우
 * `EVIDENCE_TIME_BUDGET_MS`를 넘겨서 끝나므로 시작 자체를 막는다 — 선언한 예산이 곧 실제 상한.
 */
const START_DEADLINE_MS = EVIDENCE_TIME_BUDGET_MS - GREP_TIMEOUT_MS;

/** 케이스 1건의 grep 근거수집 결과. */
export interface CaseEvidence {
  /** 원문 케이스 텍스트(verdict.missing의 항목 그대로). */
  case: string;
  /** formatGrepContext 포맷 — 매치 없으면 "". */
  context: string;
  /** context가 비어있지 않은지(ST12가 재판정 여부를 이 값으로 결정 — 매치 0이면 재판정 생략). */
  matched: boolean;
  /**
   * 이 케이스의 심볼 중 예산 소진으로 **조회조차 못 한** 것이 있는가(0.12.0 F-14). 예산은 두 축
   * — 개수(`MAX_GREP_SYMBOLS`)와 시간(`EVIDENCE_TIME_BUDGET_MS`, F-5) — 이고 둘 다 같은 값으로
   * 마감한다. `matched:false`만으로는 "grep했는데 매치 없음"과 "못 봤음"이 구분되지 않는데,
   * 소진 순서가 `missing[]` 배열 순서(= 모델의 자유서술 출력 순서)에 좌우돼 결정론적이지도 않다.
   * 이 값이 없으면 "근거가 진짜 없어서 block 유지"와 "예산이 모자라 유지"를 사후 구분할 수 없다.
   */
  budgetSkipped: boolean;
  /**
   * budgetSkipped의 **사유**(scope-critic 지적, 2026-08-09) — `count`=심볼 개수 예산 소진,
   * `time`=벽시계 예산 소진. 해소 방법이 서로 다르다: count는 케이스/심볼이 많았다는 뜻(상한
   * 조정 대상), time은 repo·grep이 느리다는 뜻(환경). 한 boolean으로 뭉치면 F-14로 얻은
   * "왜 못 봤는가"의 절반이 다시 사라진다. 스킵이 없으면 undefined.
   */
  budgetSkipReason?: "count" | "time";
}

/**
 * 매치된 케이스들을 2차 판정 프롬프트용 근거 블록으로 조립한다(순수). 총량이
 * `MAX_EVIDENCE_CONTEXT_CHARS`를 넘으면 **케이스 단위로** 앞쪽부터 담고 나머지는 버리되, 몇 건이
 * 생략됐는지 표기한다 — 문자 단위로 자르면 근거 라인이 중간에서 끊겨 모델이 "구현이 여기까지만
 * 있다"로 오독할 수 있다. 첫 케이스 하나가 이미 상한을 넘더라도 그 1건은 담는다: 근거가 0이면
 * 재판정을 돌릴 이유 자체가 사라져 status quo(원 block 유지)와 다를 바 없어지기 때문이다.
 */
export function formatEvidenceContext(matched: CaseEvidence[]): { text: string; dropped: number } {
  const blocks: string[] = [];
  let total = 0;
  let dropped = 0;
  for (const e of matched) {
    // 라벨 캡 — judge `parseVerdict`가 `j.missing.map(String)`으로 길이 제한 없이 문자열화하므로
    // 모델이 장문을 반환하면 라벨만으로 상한을 넘을 수 있고, 아래 "첫 1건은 무조건" 예외와
    // 결합하면 선언한 상한이 무의미해진다(scope-critic 실측 지적, 2026-08-09).
    const label = e.case.length > MAX_EVIDENCE_CASE_LABEL ? e.case.slice(0, MAX_EVIDENCE_CASE_LABEL) + "…" : e.case;
    // 시크릿 마스킹(0.12.0, security-auditor W1) — 근거는 **저장소 전역** grep 결과라
    // `currentFileContent`(편집 대상 1개 파일)보다 노출면이 넓다. 소스에 하드코딩된 키가 심볼
    // 매치로 걸리면 그대로 외부 API 프롬프트와 `.gbc/golden.json`에 실린다. 값만 가리고 줄·경로는
    // 보존해 근거로서의 쓸모는 그대로 둔다(`extraction.ts`의 검증된 패턴 재사용).
    const block = `케이스: ${label}\n${redactSecrets(e.context)}`;
    // 첫 건은 상한을 넘더라도 통과(위 doc 참조) — blocks가 비어있을 때만.
    if (blocks.length > 0 && total + block.length + 2 > MAX_EVIDENCE_CONTEXT_CHARS) {
      dropped++;
      continue;
    }
    blocks.push(block);
    total += block.length + 2;
  }
  if (blocks.length === 0) return { text: "", dropped: 0 };
  const note = dropped > 0 ? `\n\n…(근거 ${dropped}건 생략 — 총량 상한 ${MAX_EVIDENCE_CONTEXT_CHARS}자 초과)` : "";
  return { text: blocks.join("\n\n") + note, dropped };
}

/**
 * missing 케이스 배열 전체에 대해 grep 근거를 수집한다(비결정 I/O). **self-file 포함** —
 * `collectGrepContext`(scope.ts, 축A/rung2용)는 자기 파일을 제외하지만 여기선 정반대다: 8000바이트
 * 절단면 뒤쪽에 형제가 *같은 파일*에 이미 구현돼 있는 경우(RCA 실측 db.ts 사례)가 이 함수가 다루는
 * 핵심 갈래이기 때문 — 그래서 별도 함수다(collectGrepContext 재사용 아님, 그 함수의 필터링 로직
 * 자체가 이 용도엔 정반대 방향이라 부분 재사용이 더 위험하다).
 *
 * grep 심볼 총 예산은 `MAX_GREP_SYMBOLS`(scope.ts 재사용, 현재 8)로 캡한다 — missing이 여러 건이면
 * 케이스별 `extractCaseSymbols`(최대 5개/케이스)가 누적되어 무한정 커질 수 있으므로, 전체 케이스에
 * 걸쳐 실제 grep 호출 수를 이 총량으로 제한한다(2026-08-07, ST10에서 이월된 결정 — scope-critic 지적).
 */
export async function collectCaseEvidence(
  cwd: string,
  missing: string[],
  opts: { grep?: GrepRunner; deletion?: DeletionScope | null; now?: () => number } = {},
): Promise<CaseEvidence[]> {
  const grep = opts.grep ?? realGrep;
  const now = opts.now ?? Date.now; // 주입 가능 — 시간 예산을 결정론 테스트로 잠그기 위해
  const deletion = opts.deletion ?? null;
  // F-8 — 이번 편집이 지우는 self-file 줄은 "이미 구현됨" 근거가 될 수 없다(위 computeDeletionScope
  // doc). 캐시 저장 시점에 한 번만 거른다: deletion은 이 호출 전체에서 상수라 케이스마다 다시
  // 걸러도 결과가 같고, 캐시된 배열이 이미 걸러져 있어야 뒤 케이스들도 자동으로 정합한다.
  const keep = (m: GrepMatch) =>
    !deletion || relKey(cwd, m.file) !== deletion.file || !deletion.lines.has(m.line);
  // 심볼→매치 캐시(케이스 간 공유) — 같은 심볼이 여러 케이스에 걸쳐 나와도 grep은 한 번만 돌고,
  // 캐시된 결과가 그 심볼을 참조하는 모든 케이스에 정확히 기여한다(순서 무관). 예산은 실제 grep
  // *호출 수*(캐시 미스)로만 카운트 — 이미 캐시된 심볼은 몇 번을 참조해도 예산을 안 쓴다.
  const cache = new Map<string, GrepMatch[]>();
  let grepCalls = 0;
  const startedAt = now();
  const out: CaseEvidence[] = [];
  for (const caseText of missing) {
    const matches: GrepMatch[] = [];
    let budgetSkipped = false;
    let budgetSkipReason: "count" | "time" | undefined;
    for (const sym of extractCaseSymbols(caseText)) {
      let symMatches = cache.get(sym);
      if (symMatches === undefined) {
        // 예산 = 개수(MAX_GREP_SYMBOLS) **또는** 시간(EVIDENCE_TIME_BUDGET_MS). 둘 다 "조회조차 못
        // 함"이라 같은 budgetSkipped로 마감한다(F-14 — "매치 없음"과 구분되는 것이 요점이고, 어느
        // 예산에 걸렸는지는 소진 자체보다 덜 중요하다). 시간 검사는 grepCalls>0일 때만 — 한 번도
        // 못 보고 끝나면 근거가 0이라 재판정을 돌릴 이유 자체가 사라진다(matched 공집합과 동일).
        const outOfCount = grepCalls >= MAX_GREP_SYMBOLS;
        const outOfTime = grepCalls > 0 && now() - startedAt > START_DEADLINE_MS;
        if (outOfCount || outOfTime) {
          budgetSkipped = true;
          budgetSkipReason ??= outOfCount ? "count" : "time";
          continue;
        }
        grepCalls++;
        const raw = await grep(sym, cwd);
        // self-file **전체** 필터는 없다(핵심 차이, 위 doc) — 이번 편집이 지우는 줄만 F-8로 뺀다.
        symMatches = parseGrepOutput(raw).matches.filter(keep);
        cache.set(sym, symMatches);
      }
      matches.push(...symMatches);
    }
    const context = formatGrepContext(matches);
    out.push({
      case: caseText,
      context,
      matched: context.length > 0,
      budgetSkipped,
      ...(budgetSkipReason ? { budgetSkipReason } : {}),
    });
  }
  return out;
}
