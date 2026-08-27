// 0.13.1 ST2 — `gbc done`이 pendingReview를 지우지 않던 위생 불일치 근본수정.
// clearPendingReview는 gate reset --hard(cli.ts)와 spec-add 배치(cli.ts)에서만 호출되고 done
// 경로엔 없었다(판정 오염은 아님 — Tier1/2 모두 specHash 스코프라 무해하지만, reset --hard와의
// 비대칭이 다음 감사자를 헷갈리게 하고 M-1 도그푸딩 관측을 옛 펜딩으로 오염시킨다).
// cmdDone이 부수효과를 인라인으로 나열하면 "pendingReview도 지우는지"가 다시 사후 검출로만
// 잡힌다(feedback_regression_input_shape_contract 계열) — 한 함수로 묶어 계약을 코드로 고정한다.
import { archiveSpec } from "./spec.js";
import { resetGate } from "./state.js";
import { clearApplied } from "./applied.js";
import { clearPendingReview } from "./review.js";

/**
 * 작업단위 명시 종료의 전체 부수효과 — spec 아카이브 → 게이트 리셋 → 적용이력 원장 정리 →
 * pendingReview 정리. 순서 불변(archiveSpec는 리셋·정리보다 먼저 — beforeHash 캡처는 호출부 책임).
 * defer는 건드리지 않는다(작업단위를 넘어 이월되는 별도 수명주기).
 *
 * ⛔ `gate reset --hard`(cli.ts cmdGate)는 이 함수를 재사용하지 않는다 — 겹치는 부수효과가 3개라
 * 통합 제안이 반복해서 나오지만(0.13.1 게이트 hook scope 점검이 실제로 제안했다), **의도가 반대**다:
 * reset은 명세를 그대로 둔 채 판정만 되돌려 *같은 작업단위를 다시 발동*시키는 것이고, done은 명세를
 * 아카이브해 *작업단위를 끝내는* 것이다. 통합하면 단순 리셋이 spec.md를 통째로 비우는 회귀가 된다.
 */
export function closeWorkUnit(cwd: string): string | null {
  const archived = archiveSpec(cwd);
  resetGate(cwd);
  clearApplied(cwd);
  clearPendingReview(cwd);
  return archived;
}
