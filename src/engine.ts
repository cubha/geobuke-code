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
import type { Options, SDKMessage, SDKUserMessage, HookCallback, CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { ExtractionRecord } from "./extraction.js";
import { appendExtraction } from "./extraction.js";
import { nowIso } from "./time.js";

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
  /**
   * ST4(0.9.0 A3a) TUI 관측 seam — SDK 메시지마다 호출(부작용 허용, 반환값 무시). extraction
   * sink와 별개 경로: 이 콜백이 던지거나 없어도 기존 추출·과금 집계 흐름은 무변경이다.
   */
  onMessage?: (msg: SDKMessage) => void;
  /**
   * ST1(0.9.2) Esc 중단 seam — SDK Options.abortController(sdk.d.ts:1283)에 그대로 전달한다.
   * 호출부(app.tsx)가 Esc 키에서 .abort()를 호출하면 query()가 던지고, runEngine이 이를
   * 일반 오류와 구분해 EngineResult.aborted로 반환한다(사용자 의도한 취소 ≠ 실패).
   */
  abortController?: AbortController;
  /**
   * ST4(0.9.2) EPERM 우회 seam — SDK Options.pathToClaudeCodeExecutable(sdk.d.ts:1686)에 그대로
   * 전달한다. SDK는 기본적으로 optionalDependency로 설치된 번들 claude.exe를 자식 프로세스로 spawn
   * 하는데, 사내 보안정책이 이를 차단하면 EPERM이 난다(회사가 이미 허용한 별도 설치 경로를 여기로
   * 지정해 우회). 호출부(cli.ts/app.tsx)가 GBC_CLAUDE_PATH 환경변수를 읽어 전달한다(ST5).
   */
  claudeExecutablePath?: string;
  /**
   * ST3(0.9.4 T2) — SDK Options.includePartialMessages(sdk.d.ts:1587)에 그대로 전달한다. true면
   * query()가 stream_event(SDKPartialAssistantMessage, content_block_delta) 메시지를 추가로
   * yield한다 — TUI(ST5)가 이걸로 어시스턴트 응답을 점진 렌더한다(DeltaAssembler 소비). headless
   * `gbc run`(runEngine)은 완성된 assistant 메시지만 쓰므로 기본 미배선(undefined/false는 옵션에
   * 아예 안 실어보낸다 — SDK에 굳이 false를 명시할 이유 없음).
   */
  includePartialMessages?: boolean;
  /**
   * 0.10.0 A3b ST2 — SDK Options.resume(sdk.d.ts:1759)에 그대로 전달한다. 지정된 session_id의
   * 대화 이력을 로드해 이어간다 — opt-in 탭이 "프로세스는 종료해도 대화는 이어진다"는 계약을
   * 지키는 메커니즘(탭 계약="대화 연속성", 프로세스 상주 아님). 미지정이면 기존과 동일하게 새
   * 대화로 시작한다.
   */
  resume?: string;
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
  /** 결과가 에러였는지(SDKResultError·result.is_error·iteration throw). */
  isError: boolean;
  /** iteration이 throw했을 때의 사유(부분 결과와 함께 반환) — 정상 종료면 undefined. */
  error?: string;
  /** ST1(0.9.2) — abortController.abort()로 인한 종료(사용자 의도한 취소, isError/error와 배타). */
  aborted?: boolean;
  /** 0.10.0 A3b ST2 — resume 시도가 실패해 새 세션으로 재시도된 결과임을 알림(호출부가 "새 세션
   *  시작" 경계 배너를 띄우는 신호, ST5). previousSessionId는 실패한 resume 대상 — 배너 문구가
   *  "어느 세션이 끊겼는지"까지 말할 수 있게(단순 boolean이면 나중에 형태를 다시 바꿔야 했을 정보,
   *  이미 손에 있는 값이라 지금 실어둔다 — scope-critic 지적). 재시도 없이 정상 진행됐으면 미포함. */
  resumeFallback?: { previousSessionId: string };
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
export function mapSdkMessage(msg: SDKMessage): ExtractionRecord[] {
  const m = msg as {
    type?: string;
    subtype?: string;
    session_id?: string;
    total_cost_usd?: number;
    num_turns?: number;
    message?: { content?: unknown };
  };
  const session = m.session_id;
  if (!session) return []; // 조인키 없음 → 관측 불가로 skip(session_id 단독 조인 정책)
  const at = nowIso();

  if (m.type === "result") {
    const text = `subtype=${m.subtype ?? "?"} cost=${m.total_cost_usd ?? 0} turns=${m.num_turns ?? 0}`;
    return [{ at, session, kind: "result", text }];
  }

  const content = m.message?.content;
  if ((m.type === "assistant" || m.type === "user") && Array.isArray(content)) {
    const out: ExtractionRecord[] = [];
    for (const raw of content as ContentBlockLike[]) {
      if (!raw || typeof raw !== "object") continue;
      if (raw.type === "tool_use") {
        out.push({
          at,
          session,
          kind: "tool_use",
          tool: typeof raw.name === "string" ? raw.name : undefined,
          file: typeof raw.input?.file_path === "string" ? raw.input.file_path : undefined,
          // 인자 스니펫 — serializeRecord가 redact+캡(민감정보/폭주 차단).
          text: raw.input ? JSON.stringify(raw.input) : undefined,
        });
      } else if (raw.type === "text" && typeof raw.text === "string") {
        out.push({ at, session, kind: "assistant", text: raw.text });
      } else if (raw.type === "tool_result") {
        const t = typeof raw.text === "string" ? raw.text : JSON.stringify(raw);
        out.push({ at, session, kind: "tool_result", text: t });
      }
    }
    return out;
  }

  return []; // system/status/partial 등 노이즈
}

/**
 * A-mode 엔진 실행 — query()를 격리 옵션으로 구동하고 스트림을 extraction sink로 흘리며 ⓑ(인증·과금)를
 * 수집한다. agent-sdk 미설치면 dynamic import가 throw → 호출부(gbc run, ST6)가 설치 안내로 감싼다.
 */
/**
 * query() 옵션 빌드(순수 — 회귀락 대상). 두 불변식을 코드로 고정한다:
 *  · settingSources: [] — anti-recursion. 프로젝트 .claude/settings.json(gbc 자신의 PreToolUse stdin
 *    hook)을 로드하면 도구 호출마다 게이트가 이중발화/재귀한다. 이 빈 배열이 그걸 막는 *불변식*이다.
 *  · apiKey 미주입 — SDK 자체 인증 우선순위(구독 vs 키)를 관측해야 ⓑ가 측정된다(하드코딩 금지).
 * ST6 회귀 테스트가 이 함수를 쳐서 두 불변식이 깨지지 않았음을 매 빌드 확인한다.
 */
export function buildEngineOptions(opts: EngineOptions): Options {
  return {
    cwd: opts.cwd,
    settingSources: [],
    // ⚠️ auto-memory 격리 불변식(0.10.0 A3b 실기검증 이슈①, braintrust 4렌즈 만장일치+실측 확정):
    // settingSources:[]는 auto-memory(~/.claude/projects/<repo>/memory/)를 제어하지 않는다(SDK 공식
    // 문서 명시 — settingSources는 settings.json/CLAUDE.md/skills/hooks만 제어). 이걸 안 끄면 spawn된
    // 세션이 판정대상 repo의 memory/MEMORY.md를 읽고(+쓰고) 응답한다 — TUI 세션이 사용자의 Claude
    // Code 프로젝트 메모리를 조용히 갱신하는 쓰기 역류가 특히 위험. `settings:{autoMemoryEnabled:false}`
    // 가 SDK 공식 격리 패턴이며, 헤드리스 `claude -p --settings '{"autoMemoryEnabled":false}'` 실측으로
    // 차단 효과를 직접 확인했다(2026-07-16).
    settings: { autoMemoryEnabled: false },
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
    ...(opts.preToolUse ? { hooks: { PreToolUse: [{ hooks: [opts.preToolUse] }] } } : {}),
    ...(opts.canUseTool ? { canUseTool: opts.canUseTool } : {}),
    ...(opts.abortController ? { abortController: opts.abortController } : {}),
    ...(opts.claudeExecutablePath ? { pathToClaudeCodeExecutable: opts.claudeExecutablePath } : {}),
    ...(opts.includePartialMessages ? { includePartialMessages: true } : {}),
    ...(opts.resume ? { resume: opts.resume } : {}),
  };
}

export async function runEngine(opts: EngineOptions): Promise<EngineResult> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const options = buildEngineOptions(opts);

  const result: EngineResult = {
    sessionId: "",
    costUsd: 0,
    numTurns: 0,
    auth: null,
    records: 0,
    isError: false,
  };

  // ⚠️ query()는 결과 메시지를 yield한 *뒤* 에러 조건(예: error_max_turns)에서 throw할 수 있다(ST7 실측).
  // 그 경우에도 이미 수집한 ⓑ(cost·auth)·부분 extraction을 유실하지 않도록, iteration을 감싸 부분 결과를
  // 반환한다(rethrow 금지). 호출부(gbc run)는 isError로 판단하고 측정치를 그대로 출력한다.
  try {
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
      if (opts.onMessage) {
        try {
          opts.onMessage(msg);
        } catch {
          // TUI 관측 콜백의 오류가 엔진 루프(추출·과금 집계)를 절대 끊지 않는다.
        }
      }
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
  } catch (e) {
    // abortController.abort()로 인한 종료는 사용자가 의도한 취소지 실패가 아니다 — isError로
    // 뭉뚱그리면 bridge.ts가 "🐢 오류: ..."를 표시해 정상 동작을 실패처럼 보이게 한다(ST2가 소비).
    // aborted/isError 배타는 계약(EngineResult 주석)일 뿐 아니라 여기서 강제한다 — for-await 루프가
    // 이미 result 메시지로 isError를 세팅한 뒤(예: error_max_turns) abort가 겹쳐 throw되는 경우
    // 명시적으로 리셋하지 않으면 둘 다 true인 상태가 남아, 이 필드를 새로 소비하는 코드가 배타를
    // 가정하면 재발한다(scope-critic 발견, 2026-07-13 ST1 판정 DECISION_CHANGED:yes).
    if (opts.abortController?.signal.aborted) {
      result.aborted = true;
      result.isError = false;
      result.error = undefined;
    } else {
      result.isError = true;
      result.error = String(e).slice(0, 300);
    }
  }
  return result;
}

// ============================================================================
// 0.9.4 T1 — EngineSession: 매 제출마다 새 프로세스를 spawn하는 runEngine과 달리, 단일
// query({prompt: AsyncIterable<SDKUserMessage>})를 세션 내내 유지해 대화 연속성을 확보한다
// (ST0 스파이크 실측: 동일 session_id로 다턴 진행 시 모델이 이전 턴을 실제로 기억함을 확인).
// ============================================================================

/**
 * outgoing prompt AsyncIterable<SDKUserMessage> 구현체 — submit()마다 push()로 한 건씩 밀어넣는다.
 * SDK가 이 스트림을 계속 consume하며 세션 프로세스를 살려두므로(streamInput 문서: "multi-turn
 * conversations"), close() 전까지는 next()가 다음 push를 무기한 대기한다(async 제너레이터의 정상
 * 유휴 상태 — 타임아웃은 EngineSession 소비측 책임).
 */
export class PushableStream implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private waiters: Array<(r: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(msg: SDKUserMessage): void {
    if (this.closed) return; // 종료된 스트림에 밀어넣는 건 무시(재개 없음 — close는 편도)
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: msg, done: false });
    else this.queue.push(msg);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift() as SDKUserMessage, done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/**
 * 0.9.4 ST2 — promise를 워치독 타임아웃과 경합시킨다. SDK ProcessTransport.write()가 죽은 stdin에
 * 침묵 드랍(예외 없음, 실측)하는 사례의 방어선: 세션이 죽으면 submit()의 대기 promise가 영원히
 * 안 풀릴 수 있어, 유한 시간 뒤엔 onTimeout()의 값으로 대신 정리한다. 원래 promise가 먼저 끝나면
 * 그 값 그대로(워치독 개입 없음). 타임아웃 후 원래 promise가 뒤늦게 resolve해도 이미 반환된 값에는
 * 영향 없다(호출부가 그 결과를 버림 — throw도 leak도 없음).
 */
export function withWatchdog<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(onTimeout());
    }, ms);
    p.then((v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    });
  });
}

/**
 * 0.10.0 A3b ST6 — pause()/resume()으로 일시정지 가능한 워치독. withWatchdog과 동일 계약(정상
 * promise가 이기면 그 값, 아니면 onTimeout() 값)이되, pause() 중엔 경과시간이 카운트에서 빠진다 —
 * canUseTool 승인 대기(사람이 응답할 때까지 수 초~수 분)가 정상 상태인데도 워치독이 "응답 없음
 * (세션 사망)"으로 오판해 백그라운드 탭을 진짜로 죽여버리는 걸 막는다.
 * resume()은 remaining을 리셋하지 않는다(pause 이전까지의 소진분은 그대로 유지) — 그렇지 않으면
 * pause/resume 자체가 워치독을 무한 연장하는 우회로가 된다.
 */
export function createPausableWatchdog<T>(
  p: Promise<T>,
  ms: number,
  onTimeout: () => T,
): { promise: Promise<T>; pause: () => void; resume: () => void } {
  let settled = false;
  let paused = false;
  let remaining = ms;
  let armedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;

  let resolveOuter!: (v: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveOuter = resolve;
  });

  const finish = (v: T) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    resolveOuter(v);
  };

  const arm = () => {
    armedAt = Date.now();
    timer = setTimeout(() => finish(onTimeout()), remaining);
  };
  arm();

  p.then((v) => finish(v));

  return {
    promise,
    pause: () => {
      if (settled || paused) return;
      paused = true;
      if (timer) clearTimeout(timer);
      remaining = Math.max(0, remaining - (Date.now() - armedAt));
    },
    resume: () => {
      if (settled || !paused) return;
      paused = false;
      arm();
    },
  };
}

/** 세션이 죽었을 때(watchdog 만료 또는 프로세스 소멸)의 표준 EngineResult(순수). aborted(사용자 의도
 *  취소)와는 다른 채널 — 사용자가 아무것도 안 눌렀는데 세션이 사라진 경우다. */
export function buildSessionEndedResult(
  sessionId: string,
  auth: EngineResult["auth"],
  reason: string,
): EngineResult {
  return {
    sessionId,
    costUsd: 0,
    numTurns: 0,
    auth,
    records: 0,
    isError: true,
    error: `SESSION_ENDED: ${reason}`,
  };
}

/**
 * onEnded를 발화해야 하는지 판정한다(순수, ST5) — 세션이 *유휴 상태에서* 죽었고(대기 중이던
 * submit()이 없었음) *의도된 close()가 아닐 때만* true. 대기 중인 submit()이 있었다면 그 submit()의
 * 반환값(SESSION_ENDED)이 이미 유일한 통지 채널이라(app.tsx 기존 로직) 여기서 또 부르면 배너가
 * 중복 표시된다 — onEnded의 존재 이유는 "아무도 안 물어봤는데 죽은" 경우를 커버하는 것뿐이다.
 */
export function shouldNotifyEnded(hadPendingResolve: boolean, closedIntentionally: boolean): boolean {
  return !hadPendingResolve && !closedIntentionally;
}

/** SDK가 요구하는 SDKUserMessage 최소 형상으로 사용자 프롬프트 텍스트를 감싼다(ST0 스파이크로 실증된 형상). */
export function makeUserMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  } as SDKUserMessage;
}

/**
 * result 메시지 하나를 EngineResult 조각(costUsd·numTurns·isError·aborted·sessionId)으로 재해석한다(순수).
 * ⚠️ interrupt() 유래 result 재해석(ST0 스파이크 실측, load-bearing): query.interrupt()는 throw하지
 * 않고 result{subtype:"error_during_execution", is_error:true}를 *정상 yield*로 종료한다 — 기존
 * runEngine의 abortController 경로(throw→catch에서 signal.aborted로 판별)와는 다른 신호 채널이다.
 * wasInterrupted(EngineSession이 "직전에 우리가 interrupt()를 호출했다"를 추적하는 로컬 플래그)가
 * true일 때만 이 result를 실패가 아닌 aborted로 재해석한다 — 레이스로 interrupt 직후 정상 success가
 * 오면(non-blocking이라 가능) 오염 없이 그대로 success 처리한다(아래 세 번째 분기).
 */
export function buildEngineResultFromResult(
  m: { subtype?: string; total_cost_usd?: number; num_turns?: number; is_error?: boolean; session_id?: string },
  wasInterrupted: boolean,
): Pick<EngineResult, "sessionId" | "costUsd" | "numTurns" | "isError" | "aborted"> {
  const costUsd = m.total_cost_usd ?? 0;
  const numTurns = m.num_turns ?? 0;
  const sessionId = m.session_id ?? "";
  const rawIsError = m.subtype !== "success" || m.is_error === true;

  if (wasInterrupted && rawIsError) {
    return { sessionId, costUsd, numTurns, isError: false, aborted: true };
  }
  return { sessionId, costUsd, numTurns, isError: rawIsError };
}

/** createEngineSession() 반환 핸들 — 세션 프로세스 하나를 여러 submit() 호출에 걸쳐 재사용한다. */
export interface EngineSession {
  readonly sessionId: string;
  /** 프롬프트 1건을 세션에 밀어넣고 이번 턴의 result까지 기다려 EngineResult로 반환한다. */
  submit(prompt: string): Promise<EngineResult>;
  /**
   * 진행 중인 턴을 중단한다(Esc). ST0 스파이크 실측대로 즉시 resolve(non-blocking)되며, 뒤따르는
   * result는 submit()의 Promise가 buildEngineResultFromResult로 aborted 재해석해 받는다.
   */
  interrupt(): Promise<void>;
  /** 세션 프로세스를 종료한다(이후 submit() 호출은 재개 없이 즉시 에러 EngineResult를 반환). */
  close(): void;
}

export type EngineSessionOptions = Omit<EngineOptions, "prompt"> & {
  /**
   * ST2 워치독(ms, 기본 5분) — submit() 응답 상한. SDK ProcessTransport.write()가 죽은 stdin에
   * 침묵 드랍하는 실측 사례의 방어선: 이 시간 내 result가 안 오면 세션을 SESSION_ENDED로 정리한다.
   * 정상적인 장시간 턴(도구 체인 다수)을 오탐하지 않도록 넉넉히 잡혀 있다.
   */
  watchdogMs?: number;
  /**
   * 0.10.0 A3b ST5 — 세션이 *예기치 않게* 죽는 순간(워치독 타임아웃·스트림 예외·result 없이 자연
   * 종료) 호출된다. 대기 중인 submit()이 있었는지와 무관하게 항상 발화한다 — 백그라운드(유휴) 탭이
   * 조용히 죽어도(다음 submit 전까지 아무도 모르는 상태) 즉시 생존배지·경계배너 갱신이 가능하게
   * 하는 유일한 채널. `close()`로 인한 *의도된* 종료는 발화하지 않는다(사용자가 opt-out한 것을
   * "세션이 죽었다"로 오보하면 안 됨 — closedIntentionally 가드).
   */
  onEnded?: (info: { reason: string; sessionId: string }) => void;
};

const DEFAULT_WATCHDOG_MS = 5 * 60 * 1000;

/**
 * ⚠️ 이 함수 자체(I/O 루프 구동)는 단위테스트 대상이 아니다 — runEngine과 동일한 이유(SDK 프로세스
 * 스폰은 비결정 I/O, ST0 스파이크가 그 자리의 수동 실측이다). PushableStream·buildEngineResultFromResult·
 * makeUserMessage 세 순수 조각이 TDD 대상이었고, 이 함수는 그 조각들을 실제 query()에 배선만 한다.
 */
export async function createEngineSession(opts: EngineSessionOptions): Promise<EngineSession> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  let sessionId = "";
  let auth: EngineResult["auth"] = null;
  let recordsThisTurn = 0;
  let pendingResolve: ((r: EngineResult) => void) | null = null;
  let interruptRequested = false;
  let ended = false;
  let endReason: string | undefined;
  let closedIntentionally = false;
  // ST6(0.10.0 A3b) — 지금 진행 중인 submit()의 워치독. canUseTool 승인 대기 동안 이걸 pause해,
  // 사람이 응답할 때까지의 정상 대기시간이 "응답 없음(세션 사망)"으로 오판되지 않게 한다.
  let activeWatchdog: { pause: () => void; resume: () => void } | null = null;

  // canUseTool 승인 구간을 워치독 pause/resume으로 감싼다 — 호출부(app.tsx)의 canUseTool 자체는
  // 손대지 않고 이 세션 안에서만 계측한다. canUseTool 미지정이면 감쌀 것도 없다(passthrough).
  const innerCanUseTool = opts.canUseTool;
  const wrappedCanUseTool: CanUseTool | undefined = innerCanUseTool
    ? async (toolName, input, toolOpts) => {
        activeWatchdog?.pause();
        try {
          return await innerCanUseTool(toolName, input, toolOpts);
        } finally {
          activeWatchdog?.resume();
        }
      }
    : undefined;

  const options = buildEngineOptions({ ...opts, canUseTool: wrappedCanUseTool } as EngineOptions);
  const input = new PushableStream();
  const q = query({ prompt: input, options });

  const settle = (result: EngineResult) => {
    if (!pendingResolve) return; // 대기 중인 submit()이 없으면(세션 유휴) 버린다 — 다음 submit이 새로 기다림
    const resolve = pendingResolve;
    pendingResolve = null;
    resolve(result);
  };

  void (async () => {
    try {
      for await (const msg of q) {
        const m = msg as SDKMessage & {
          session_id?: string;
          isAuthenticating?: boolean;
          output?: string[];
          error?: string;
        };
        if (m.session_id) sessionId = m.session_id;
        if (opts.onMessage) {
          try {
            opts.onMessage(msg);
          } catch {
            // TUI 관측 콜백의 오류가 세션 루프(추출·과금 집계)를 끊지 않는다(runEngine과 동일 규율).
          }
        }
        for (const rec of mapSdkMessage(msg)) {
          appendExtraction(opts.cwd, rec);
          recordsThisTurn++;
        }
        if (m.type === "auth_status") {
          auth = { authenticating: Boolean(m.isAuthenticating), output: m.output ?? [], error: m.error };
        }
        if (m.type === "result") {
          const wasInterrupted = interruptRequested;
          interruptRequested = false;
          const piece = buildEngineResultFromResult(m as { subtype?: string; total_cost_usd?: number; num_turns?: number; is_error?: boolean; session_id?: string }, wasInterrupted);
          settle({
            sessionId: piece.sessionId || sessionId,
            costUsd: piece.costUsd,
            numTurns: piece.numTurns,
            auth,
            records: recordsThisTurn,
            isError: piece.isError,
            ...(piece.aborted ? { aborted: true } : {}),
          });
          recordsThisTurn = 0;
        }
      }
      // 루프가 예외 없이 자연 종료(Query AsyncGenerator가 done:true 반환) — 이것도 SESSION_ENDED다.
      // catch로 안 오면 안전하다고 가정하면 안 된다는 게 ST2의 핵심 발견: 대기 중인 submit()이
      // 있는데 다음 result 없이 스트림이 그냥 끝나면 그 promise는 영원히 안 풀린다(watchdog 없이는).
      {
        const hadPendingResolve = pendingResolve !== null;
        endReason = hadPendingResolve
          ? "세션 프로세스가 예기치 않게 종료됨(결과 없이 스트림 종료)"
          : "세션 프로세스가 유휴 상태에서 예기치 않게 종료됨";
        if (hadPendingResolve) settle(buildSessionEndedResult(sessionId, auth, endReason));
        // ST5 — 유휴 상태의 예기치 않은 죽음(대기 중인 submit() 없음)만 onEnded로 알린다(shouldNotifyEnded).
        if (shouldNotifyEnded(hadPendingResolve, closedIntentionally)) {
          opts.onEnded?.({ reason: endReason, sessionId });
        }
      }
    } catch (e) {
      // abortController 경로(runEngine)와 달리 스트리밍 입력 모드에서 interrupt()는 이 catch로
      // 오지 않는다(정상 result로 종료 — 위 buildEngineResultFromResult가 처리). 여기 도달하면
      // 세션 프로세스 자체가 죽은 것(ST2 SESSION_ENDED 감지 대상).
      const hadPendingResolve = pendingResolve !== null;
      endReason = String(e).slice(0, 300);
      settle(buildSessionEndedResult(sessionId, auth, endReason));
      if (shouldNotifyEnded(hadPendingResolve, closedIntentionally)) {
        opts.onEnded?.({ reason: endReason, sessionId });
      }
    } finally {
      ended = true;
    }
  })();

  return {
    get sessionId() {
      return sessionId;
    },
    async submit(prompt: string): Promise<EngineResult> {
      if (ended) {
        return buildSessionEndedResult(sessionId, auth, endReason ?? "세션이 이미 종료됨");
      }
      const raw = new Promise<EngineResult>((resolve) => {
        pendingResolve = resolve;
        input.push(makeUserMessage(prompt));
      });
      const watchdogMs = opts.watchdogMs ?? DEFAULT_WATCHDOG_MS;
      // ST6 — pause 가능한 워치독을 이번 submit() 동안만 activeWatchdog에 걸어둔다. canUseTool
      // 래퍼가 이걸 보고 승인 대기 구간의 경과시간을 카운트에서 뺀다(shared closure, 승인이 이
      // submit() 도중에만 일어나므로 시점 겹침 없음 — 다음 submit()이 새 워치독으로 교체한다).
      const watchdog = createPausableWatchdog(raw, watchdogMs, () => {
        // raw는 이미 abandon됐을 뿐 leak은 아니다(createPausableWatchdog가 뒤늦은 resolve를 조용히
        // 버림) — 다만 세션 자체는 더 이상 신뢰할 수 없으므로 ended로 확정하고 프로세스 정리를 시도한다.
        if (!ended) {
          ended = true;
          endReason = `watchdog timeout(${watchdogMs}ms) — 세션 응답 없음(프로세스가 죽었을 가능성)`;
          pendingResolve = null;
          try {
            q.close();
          } catch {
            // 이미 죽은 프로세스 정리 시도 — 실패해도 무해(우리는 이미 ended로 확정했다).
          }
        }
        return buildSessionEndedResult(sessionId, auth, endReason ?? "watchdog timeout");
      });
      activeWatchdog = watchdog;
      const result = await watchdog.promise;
      activeWatchdog = null;
      return result;
    },
    async interrupt(): Promise<void> {
      interruptRequested = true;
      await q.interrupt();
    },
    close(): void {
      // ST5 — 의도된 종료(사용자 opt-out 등)임을 표시. 이후 스트림 루프가 자연 종료해도
      // shouldNotifyEnded가 false를 내 onEnded가 "세션이 죽었다"고 오보하지 않는다.
      closedIntentionally = true;
      input.close();
      q.close();
    },
  };
}

// ============================================================================
// 0.10.0 A3b ST2 — repoId 원자 결박 + resume 그레이스풀 폴백. opt-in 탭이 여러 repo를 오갈 때
// "이 탭의 세션은 반드시 이 탭의 repo에서만 동작한다"를 구조로 강제하고(LLM 재유입 경로 1·2와
// 같은 급의 cwd 오라우팅 방지), resume이 회사 환경 CLI 버전과 호환되지 않을 가능성(ST0 스파이크가
// 이 sandbox에서 실측하지 못한 잔여 리스크)을 빌드타임 분기 없이 런타임에서 흡수한다.
// ============================================================================

/**
 * 탭(repoId)별 세션 생성 옵션을 조립한다(순수) — cwd는 항상 repoId 그 자체로 강제한다. base에
 * 다른 cwd가 실려 있어도(여러 탭이 옵션 객체를 재사용하다 뒤섞이는 실수) repoId가 이긴다 —
 * "세션 팩토리 원자 결박"의 회귀락. base.cwd는 애초에 받지 않는다(타입으로 실수를 배제).
 */
export function buildSessionOptionsForRepo(
  repoId: string,
  base: Omit<EngineSessionOptions, "cwd">,
): EngineSessionOptions {
  return { ...base, cwd: repoId };
}

/**
 * resume 시도가 SESSION_ENDED로 실패했는지 판정한다(순수). true면 resume 없는 fresh 세션으로
 * 재시도해야 한다(createEngineSessionWithResumeFallback의 판단 근거) — SESSION_ENDED가 아닌 다른
 * 실패(네트워크 오류 등)는 resume과 무관하므로 폴백 대상이 아니다(그대로 사용자에게 실패로 보고).
 */
export function isResumeFailure(result: EngineResult): boolean {
  return result.isError && result.error?.startsWith("SESSION_ENDED") === true;
}

/**
 * resume 그레이스풀 폴백 래퍼(ST0 결정사항) — opts.resume이 있으면 그 세션ID로 이어가길 시도하되,
 * 첫 submit()이 SESSION_ENDED(회사 환경 CLI 버전이 resume을 지원하지 않는 등 어떤 사유든)로
 * 실패하면 즉시 resume 없는 새 세션을 만들어 같은 프롬프트로 1회 재시도한다 — 호출부(app.tsx)는
 * 이 재시도를 몰라도 된다. 재시도 이후에는(대화가 이미 새로 시작됐으므로) 더 이상 폴백하지 않는다
 * (fellBack 플래그) — 무한 재시도를 방지하고, 두 번째 실패는 있는 그대로 보고한다.
 * resumeFallback은 EngineResult에 실려 호출부가 "새 세션으로 시작됨" 배너(ST5)를 띄우는 신호다.
 * ⚠️ opts.cwd는 반드시 repoId여야 한다(buildSessionOptionsForRepo로 준비된 옵션을 넘길 것) — 이
 * 함수는 그 계약을 스스로 강제하지 않는다(재검증 비용 대비 실익이 낮음: 호출부가 세션 하나를 만들
 * 때마다 항상 buildSessionOptionsForRepo를 거치는 게 유일한 진입 경로가 될 것이므로). 어기면 폴백
 * 세션의 preToolUse/canUseTool/onMessage가 잘못된 repo 컨텍스트로 재바인딩된 채 동작한다.
 * ⚠️ createEngineSession(순수 아님, 실 SDK I/O)을 경유해서만 세션을 만든다 — 직접 query()를 새로
 * 배선하면 buildEngineOptions의 불변식(settingSources:[]·apiKey 미주입)이 이 경로에서만 깨질 수 있다.
 */
export async function createEngineSessionWithResumeFallback(
  opts: EngineSessionOptions,
): Promise<EngineSession> {
  if (!opts.resume) return createEngineSession(opts);

  let current = await createEngineSession(opts);
  let fellBack = false;

  return {
    get sessionId() {
      return current.sessionId;
    },
    async submit(prompt: string): Promise<EngineResult> {
      const result = await current.submit(prompt);
      if (fellBack || !isResumeFailure(result)) return result;
      fellBack = true;
      const previousSessionId = opts.resume as string;
      const { resume: _resume, ...fresh } = opts;
      current = await createEngineSession(fresh);
      const retry = await current.submit(prompt);
      return { ...retry, resumeFallback: { previousSessionId } };
    },
    async interrupt(): Promise<void> {
      await current.interrupt();
    },
    close(): void {
      current.close();
    },
  };
}
