// A-mode 엔진 (0.7.0 A1 ST3) — @anthropic-ai/claude-agent-sdk query()를 in-process로 구동한다.
// 격리 규율(B경로 zero-dep 유지):
//  · agent-sdk는 optionalDependencies(설치 안 돼도 B-모드 hook 정상). engine.ts는 hook.ts가 import하지
//    않으므로 B-모드 핫패스에서 절대 로드되지 않는다(런타임 격리는 import 그래프로 보장).
//  · 런타임 심볼(query)은 lazy dynamic import — 프로세스가 gbc run에 진입할 때만 로드.
//  · 타입은 `import type`(erased) — 컴파일 시 타입안전, dist엔 흔적 없음. 소비자 dist엔 dynamic import만 남는다.
// ⚠️ 인증/과금(ⓑ 측정): apiKey를 *주입하지 않는다*. SDK가 자기 우선순위(구독 인증 vs API 키)로 해석하게
//    둬야 "agent-sdk가 무엇으로 과금되나"를 실측할 수 있다(하드코딩하면 ⓑ가 사문화). resolveApiKey 미사용.
// ⚠️ settingSources:[](anti-recursion 불변식): query()가 프로젝트 .claude/settings.json을 로드하면 그 안의
//    gbc 자신의 PreToolUse stdin hook이 실려 도구 호출마다 게이트가 이중발화/재귀한다. 명시적으로 미로드.
import type { Options, SDKMessage, HookCallback, CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { ExtractionRecord } from "./extraction.js";
import { appendExtraction } from "./extraction.js";

/** runEngine 입력. preToolUse(ST4)·canUseTool(ST5)는 seam으로 주입 — 미지정 시 미배선(순수 관측 실행). */
export interface EngineOptions {
  prompt: string;
  cwd: string;
  model?: string;
  maxTurns?: number;
  /** ST4 SDK PreToolUse 콜백 어댑터(evaluateGate 배선). */
  preToolUse?: HookCallback;
  /** ST5 canUseTool 사람-pause primitive. */
  canUseTool?: CanUseTool;
}

/** runEngine 결과 — 사이클 요약 + ⓑ 인증·과금 실측 필드. */
export interface EngineResult {
  sessionId: string;
  /** 총 과금(USD) — SDKResultSuccess.total_cost_usd. ⓑ 과금 측정. */
  costUsd: number;
  numTurns: number;
  /** 인증 상태(SDKAuthStatusMessage) — 구독인증/키 판별 단서. ⓑ 인증 측정. 미관측이면 null. */
  auth: { authenticating: boolean; output: string[]; error?: string } | null;
  /** extraction.jsonl에 기록된 레코드 수. */
  records: number;
  /** 결과가 에러였는지(SDKResultError 또는 result.is_error). */
  isError: boolean;
}

/** 콘텐츠 블록 최소 형상(BetaMessage.content 원소 — 우리가 읽는 필드만). */
interface ContentBlockLike {
  type?: string;
  text?: string;
  name?: string;
  input?: { file_path?: string } & Record<string, unknown>;
}

/**
 * SDK 메시지 1건을 extraction 레코드 0개 이상으로 매핑한다(순수 — I/O 없음, session_id는 msg에서).
 * 고신호만 추출(진짜 M1 축): assistant의 tool_use(모델이 무슨 도구를)·text, result(사이클 종료·과금),
 * user의 tool_result. system/status/partial 등 노이즈는 []. session이 없으면(관측 불가) 그 메시지는 skip.
 */
export function mapSdkMessage(_msg: SDKMessage): ExtractionRecord[] {
  throw new Error("mapSdkMessage: not implemented (ST3 RED)");
}

/**
 * A-mode 엔진 실행 — query()를 격리 옵션으로 구동하고 스트림을 extraction sink로 흘리며 ⓑ(인증·과금)를
 * 수집한다. agent-sdk 미설치면 dynamic import가 throw → 호출부(gbc run, ST6)가 설치 안내로 감싼다.
 */
export async function runEngine(opts: EngineOptions): Promise<EngineResult> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const options: Options = {
    cwd: opts.cwd,
    // anti-recursion: 프로젝트/로컬/유저 설정을 로드하지 않는다(gbc 자신의 stdin hook 이중발화 차단).
    settingSources: [],
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
    ...(opts.preToolUse ? { hooks: { PreToolUse: [{ hooks: [opts.preToolUse] }] } } : {}),
    ...(opts.canUseTool ? { canUseTool: opts.canUseTool } : {}),
    // apiKey 미주입(ⓑ) — SDK 자체 인증 우선순위 관측.
  };

  const result: EngineResult = {
    sessionId: "",
    costUsd: 0,
    numTurns: 0,
    auth: null,
    records: 0,
    isError: false,
  };

  for await (const msg of query({ prompt: opts.prompt, options })) {
    const m = msg as SDKMessage & {
      session_id?: string;
      total_cost_usd?: number;
      num_turns?: number;
      is_error?: boolean;
      isAuthenticating?: boolean;
      output?: string[];
      error?: string;
      subtype?: string;
    };
    if (m.session_id) result.sessionId = m.session_id;
    for (const rec of mapSdkMessage(msg)) {
      appendExtraction(opts.cwd, rec);
      result.records++;
    }
    if (m.type === "result") {
      result.costUsd = m.total_cost_usd ?? 0;
      result.numTurns = m.num_turns ?? 0;
      result.isError = m.subtype !== "success" || m.is_error === true;
    }
    if (m.type === "auth_status") {
      result.auth = { authenticating: Boolean(m.isAuthenticating), output: m.output ?? [], error: m.error };
    }
  }
  return result;
}
