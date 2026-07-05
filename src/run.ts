// gbc verify --run (0.6.0 ST-D) — 신뢰 소스 고정 러너 명령의 해석·실행.
// 설계·위협모델: docs/design/DESIGN-verify-run-2026-07-05.md (advisor 재검증 반영).
// ⚠️ 불변식: 실행 명령의 소스는 정확히 2개 — CLI 인자(사용자 타이핑)·홈 pin(~/.gbc/verify-run.json).
// resolveRunCommand는 spec/defer/판정 출력을 *파라미터로 받지 않는다* — spec-유래 문자열이 명령행에
// 오르는 경로를 코드 형상으로 차단한다(spec.md=PR 기여 파일 → spec-derived 실행=공급망 RCE).
import { spawn } from "node:child_process";

/** 러너 kill-timeout(기본 10분) — judge 30s와 자릿수가 다른 장기 작업. */
export const RUN_TIMEOUT_MS = 600000;

/** --run 인자 해석 결과. */
export interface RunResolution {
  /** 실행할 명령(신뢰 소스 유래) — 없으면 null(안내 후 exit 1). */
  cmd: string | null;
  /** --save 지정 여부(인자 필수). */
  save: boolean;
  /** 명령 출처 — 실행 전 에코용(가시성=공짜 방어, advisor #2). */
  source: "arg" | "pin" | "none";
  /** 해석 오류(예: --save에 명령 인자 없음) — 있으면 실행하지 않는다. */
  error?: string;
}

/**
 * `gbc verify --run` 뒤 인자를 해석한다(순수). 우선순위: CLI 인자 > 홈 pin.
 * 여러 토큰은 공백 join(따옴표 없이 `--run npm test`도 허용 — 전부 사용자 타이핑=신뢰 소스).
 */
export function resolveRunCommand(rest: string[], pin: string | null): RunResolution {
  const save = rest.includes("--save");
  const tokens = rest.filter((t) => t !== "--save");
  const argCmd = tokens.join(" ").trim();
  if (argCmd) return { cmd: argCmd, save, source: "arg" };
  if (save) return { cmd: null, save, source: "none", error: "--save는 명령 인자가 필요합니다" };
  if (pin) return { cmd: pin, save: false, source: "pin" };
  return { cmd: null, save: false, source: "none" };
}

/** 러너 실행 결과 — exit code는 게이트하지 않는다(판정은 JUnit XML 몫). */
export interface RunOutcome {
  /** spawn·timeout 계층의 성패(러너 exit≠0은 ok:true + reason 기록) */
  ok: boolean;
  reason?: string;
}

/**
 * 신뢰 소스 명령을 실행한다 — shell:true(크로스플랫폼·파이프)·stdio inherit(출력 무캡처·LLM 미전송).
 * GBC_RUN_ACTIVE=1 전파로 재귀 --run 차단(advisor #6b). 한계: kill은 셸만 죽임(손자 고아 가능 —
 * run-start mtime 검사가 다음 verify에서 stale로 회수, 설계 §5).
 */
export function runRunnerCommand(
  cmd: string,
  cwd: string,
  timeoutMs: number = Number(process.env.GBC_RUN_TIMEOUT_MS ?? RUN_TIMEOUT_MS),
): Promise<RunOutcome> {
  return new Promise((res) => {
    let child;
    try {
      child = spawn(cmd, {
        shell: true,
        cwd,
        stdio: "inherit",
        env: { ...process.env, GBC_RUN_ACTIVE: "1" },
      });
    } catch (e) {
      res({ ok: false, reason: e instanceof Error ? e.message : String(e) });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      res({ ok: false, reason: `timeout ${timeoutMs}ms — 러너 강제 종료` });
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      res({ ok: false, reason: e.message });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      res({ ok: true, reason: code === 0 ? undefined : `러너 exit ${code}(실패 테스트는 XML로 판정)` });
    });
  });
}
