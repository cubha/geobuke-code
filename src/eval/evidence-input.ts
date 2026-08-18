// eval 회귀 케이스의 **근거주입(P2b grep) 입력 조립 seam** (F-1 패턴 재적용, 0.12.4 ST6).
//
// applied-input.ts와 동형 이유 — cases.json은 조립된 evidence_context 문자열을 적지 않는다.
// 프로덕션 근거수집(collectCaseEvidence)이 실제로 만나는 것과 같은 raw grep 매치(file·line·text)만
// 케이스별로 선언하고, 조립은 프로덕션 함수(formatGrepContext → formatEvidenceContext)가 한다.
// 손으로 조립하면 F-1이 재현된다: 사람이 쓴 형상이 프로덕션이 절대 낼 수 없는 것일 수 있고,
// test/eval-cases.test.mjs가 낸 green이 그 위에 서면 거짓안심이 된다.
import { formatGrepContext } from "../scope.js";
import { formatEvidenceContext } from "../evidence.js";
import type { GrepMatch } from "../scope.js";
import type { CaseEvidence } from "../evidence.js";

/** 케이스 1건의 raw grep 매치(근거수집이 실제로 만나는 것과 같은 모양). */
export interface EvalEvidenceCase {
  /** 원문 케이스 텍스트(judge missing[] 항목과 같은 문자열 — CaseEvidence.case와 동형). */
  case: string;
  /** grep 매치. 생략·빈 배열이면 이 케이스는 매치 0(P2b가 실사용에서 그 케이스를 재판정에서 뺀다). */
  matches?: GrepMatch[];
}

/**
 * `[관련 코드 근거(grep)]` 원문을 **프로덕션 조립 함수로** 만든다. matched(context가 비어있지
 * 않음)인 케이스가 하나도 없으면 undefined — gate-core.ts evaluateGate의 P2b 진입조건(매치 0이면
 * 재판정 자체를 생략)과 동일 계약을 eval에서도 지킨다.
 */
export function buildEvalEvidenceContext(cases: EvalEvidenceCase[] | undefined): string | undefined {
  if (!cases || cases.length === 0) return undefined;
  const evidence: CaseEvidence[] = cases
    .map((c) => {
      const context = formatGrepContext(c.matches ?? []);
      return { case: c.case, context, matched: context.length > 0, budgetSkipped: false };
    })
    .filter((e) => e.matched);
  if (evidence.length === 0) return undefined;
  return formatEvidenceContext(evidence).text || undefined;
}
