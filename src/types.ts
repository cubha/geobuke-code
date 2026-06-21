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

/** 명시적으로 미룬 항목 (defer-registry 엔트리) */
export interface DeferEntry {
  /** 미룬 케이스/항목 설명 */
  item: string;
  /** 등록 시각 (ISO) */
  at: string;
  /** 해결 여부 */
  resolved: boolean;
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
