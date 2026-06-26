// 거북이코드 게이트 공통 타입

/** 게이트 판정 결과 */
export type VerdictKind = "block" | "pass";

export interface Verdict {
  verdict: VerdictKind;
  /** 누락된(다뤄지지도 명시 defer되지도 않은) 계획 케이스 목록 */
  missing: string[];
  /** 한 줄 사유 */
  reason: string;
  /**
   * 판정 호출 실패로 안전 통과(fail-open)된 결과인지.
   * true면 정상 통과가 아니므로 hook이 작업단위 캐시(markGated)에서 제외하고 계측한다.
   */
  failOpen?: boolean;
}

/** Claude Code PreToolUse hook이 전달하는 tool_input (Edit/Write/MultiEdit) */
export interface EditToolInput {
  file_path?: string;
  old_string?: string;
  new_string?: string;
  content?: string;
  edits?: Array<{ old_string: string; new_string: string }>;
}

/**
 * defer 항목 수명주기 상태 (0.2.5+).
 * - open: 미룸 등록·미착수 (이전 resolved:false)
 * - in_progress: 착수해 진행 중 (신규 — start로 진입, 게이트 판정엔 open과 동일하게 '미해결'로 취급)
 * - resolved: 사용자 점검 후 종결 (이전 resolved:true)
 */
export type DeferStatus = "open" | "in_progress" | "resolved";

/** 명시적으로 미룬 항목 (defer-registry 엔트리) */
export interface DeferEntry {
  /** 미룬 케이스/항목 설명 */
  item: string;
  /** 등록 시각 (ISO) */
  at: string;
  /** 수명주기 상태 — 단일 소스(옛 resolved:boolean은 읽을 때 자동 승격, 저장은 status로 통일) */
  status: DeferStatus;
}

/** 디스크에서 읽은 원시 엔트리 — 옛 {resolved:boolean} 포맷 하위호환 수용용 */
export interface RawDeferEntry {
  item: string;
  at: string;
  status?: DeferStatus;
  /** @deprecated 0.2.4 이하 포맷 — 읽을 때만 status로 승격, 저장 시 제거 */
  resolved?: boolean;
}

/**
 * 펜딩-검토 레코드 (.gbc/pending-review.json) — 게이트 block이 도출한 침묵-누락 케이스를
 * 사람-승인 체크리스트로 회수하기 위해 기록. `gbc gate review`가 읽어 번호 체크리스트로 제시.
 */
export interface PendingReview {
  /** block으로 도출된 누락 케이스들(체크리스트 항목, 1-base 번호로 표시) */
  missing: string[];
  /** block 사유 한 줄(판정 reason) */
  reason: string;
  /** 명세 소스(.gbc/spec.md 등) */
  source: string;
  /** 기록 시각 (ISO) */
  at: string;
}

/** 골든셋 케이스의 기대 판정(캡처 시점 judge 출력) */
export interface GoldenExpected {
  verdict: VerdictKind;
  missing: string[];
  reason: string;
}

/**
 * 골든셋 케이스 (.gbc/golden.json) — 게이트 판정 드리프트 회귀락(A2)의 단위.
 * ⚠️ edit는 정규화된 *편집 본문*이다 — events.jsonl이 privacy 불변식으로 절대 저장 안 하는 내용을
 *    여기엔 opt-in으로 로컬 저장한다(.gbc/는 gitignore). 커밋=본문 노출이라 로컬 pre-flight 전용.
 */
export interface GoldenCase {
  /** tool+edit+spec 안정 해시(upsert 디둑 키) */
  id: string;
  /** 캡처 시각 (ISO) */
  at: string;
  /** Edit/Write/MultiEdit */
  tool: string;
  /** 정규화된 편집 본문(judge 재실행 입력) */
  edit: string;
  /** 캡처 시점 명세 스냅샷 */
  spec: string;
  /** 캡처 시점 활성 defer 스냅샷 */
  defers: string[];
  /** 캡처 시점 완료(resolved) defer 스냅샷 — judge [이미 완료된 항목] 입력 재현용(선택, 하위호환) */
  resolved?: string[];
  /** 캡처 시점 judge 출력(드리프트 비교 기준) */
  expected: GoldenExpected;
}

/**
 * 사후 결과검증(post-impl verify) 판정 강도 — 사다리.
 * - verified: 테스트 실행 결과(JUnit)가 케이스를 통과/실패로 증명(강).
 * - reviewed: 러너 없이 LLM이 최종 코드를 독해해 케이스 주소화를 판정(경량·약). *동작 증명 아님*.
 * - unverifiable: 증거(테스트결과/파일)가 없어 정직하게 미검증(바닥) — 거짓 pass/block 금지.
 *   (게이트 fail-open 철학의 미러: 모르면 통과시키지도 막지도 않고 '모름'을 보고한다.)
 */
export type VerifyLevel = "verified" | "reviewed" | "unverifiable";

/** spec 케이스↔증거 바인딩 종류 (케이스 접미사 ::test/::file 파싱 결과) */
export type BindingKind = "test" | "file" | "none";

/**
 * reviewed 경로(LLM 최종코드 독해) 판정.
 * - pass/fail: 모델이 코드를 읽고 케이스 주소화 여부를 판정(독해, *동작 증명 아님*).
 * - unverifiable: 검토 호출 실패·응답 파싱 불가 → 정직하게 미검증.
 *   ⚠️ 게이트의 failOpenVerdict(verdict:"pass")를 절대 복사하지 않는다 — reviewed의 fail-open은
 *   'pass'가 아니라 'unverifiable'이어야 거짓 확신을 막는다(사다리 핵심 가드).
 */
export interface ReviewVerdict {
  status: "pass" | "fail" | "unverifiable";
  reason: string;
}

/** spec 케이스의 검증 바인딩 — `<케이스 본문> ::test <테스트명>` 또는 `... ::file <경로>` 파싱 결과 */
export interface CaseBinding {
  /** 바인딩 접미사를 제거한 케이스 본문 */
  text: string;
  kind: BindingKind;
  /** test명 또는 file 경로 (kind==="none"이면 "") */
  ref: string;
}

/** 한 케이스의 사후검증 판정 */
export interface CaseVerdict {
  /** 케이스 본문(바인딩 접미사 제거) */
  case: string;
  level: VerifyLevel;
  /** verified/reviewed일 때 pass|fail, unverifiable이면 none */
  status: "pass" | "fail" | "none";
  /** 판정 근거 한 줄(매칭된 test명·파일·사유) */
  evidence: string;
  /** 증거 소스 (예: "junit:results.xml", "review:src/x.ts", "none") */
  source: string;
}

/** 사후검증 리포트 (.gbc/verify-results.xml 등 증거를 읽어 케이스별 판정한 집계) */
export interface VerifyReport {
  cases: CaseVerdict[];
  /** 생성 시각 (ISO) */
  at: string;
}

/** 작업단위 게이트 상태 (.gbc/state.json) */
export interface GateState {
  /** 현재 작업단위를 식별하는 계획 명세 해시 */
  specHash: string;
  /** 이 작업단위가 이미 게이트(pass)를 통과했는지 */
  gated: boolean;
  /** 마지막 판정 사유 (디버그/표시용) */
  lastReason?: string;
  /** 갱신 시각 */
  at: string;
}
