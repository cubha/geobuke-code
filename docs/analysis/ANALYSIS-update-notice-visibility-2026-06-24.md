# 업데이트 notice 가시성 — 3-현상 구조 분석 보고서

> 분석일: 2026-06-24
> 프로젝트: geobuke-code (gbc) — 업데이트 notice 가시성 갭
> 분석 관점: 회사 native Windows 0.2.7 환경에서 "신버전 notice가 안 뜬다"의 3-현상 정상/결함 확정 + 0.2.10 수정 범위 도출

---

## 0. 요약 (결론 먼저)

3가지 현상은 **독립 결함이 아니라 하나의 인과 사슬**이다.

```
[#1] SessionStart hook 미등록(구버전 init 코호트)
      → 자동 refresh 채널 소멸(PreToolUse는 refresh 안 함=read-only)
      → version-check.json 캐시 0.2.6 영구 고착
                                         │
[#2] 그 hook 누락을 알리는 ②init-staleness notice가
      cached-skip 경로(hook.ts:168-178)에서 emit 누락
      → "재init 하세요" 안내가 사용자에게 안 보임
      → 사용자가 재init 안 함 → #1의 hook이 영영 복구 안 됨 (악순환)
                                         │
[#3] SessionStart notice는 stdout→모델 컨텍스트라 사용자 배너 아님
      → 모델은 받지만(인용 확인됨) 화면엔 안 뜸
      → 사용자 가시 채널은 PreToolUse systemMessage 단 하나뿐
      → 그 단일 채널마저 cached-skip(#2)에서 막힘
```

**핵심**: 가시 채널은 **PreToolUse `systemMessage` 하나**뿐인데, 평상 작업은 대부분 cached-skip이라 그 하나가 거의 안 열린다. **cached-skip 경로에 `maybeUpdateNotice` emit 한 줄을 추가하면 #2 직접 해소 + #1 근본(재init 안내 노출→hook 복구→refresh 부활)까지 연쇄 해소**된다.

---

## 1. 현상별 정상/결함 확정

### #1 — 캐시 0.2.6 고착 (latest=0.2.9, 설치=0.2.7) → **🔴 결함(구조적 단일채널 의존)**

**메커니즘(코드 확인):**
- 캐시 갱신(`refreshVersionCache`, version.ts:82)을 호출하는 곳은 **딱 3곳**: ⓐSessionStart hook(hook.ts:426 `isCacheStale`시) · ⓑ`gbc status` · ⓒ`gbc update`.
- **PreToolUse는 캐시를 refresh하지 않는다** — `buildUpdateNotice`(notice.ts:88)는 `readVersionCache`만 호출(read-only). 0.2.7 설계 의도 "hook 핫패스에 동기 네트워크 금지"(version.ts:2)의 결과.
- 따라서 **유일한 자동 채널은 SessionStart hook**. 그런데 이 hook은 **0.2.2에서 도입**되었고, install.ts:90 주석대로 **0.2.1 이하 init 코호트엔 미등록**.

**확정된 갈래:** `ctx.cliPath` 미전달 갈래는 **기각** — `CLI_PATH = fileURLToPath(import.meta.url)`(cli.ts:31)로 항상 유효, `runSessionStart({cliPath, version})`(cli.ts:483)로 항상 전달. 네트워크 실패 갈래도 **기각** — 사용자가 `gbc status`로 0.2.9 갱신에 성공(네트워크·refresh 정상 실증). 남는 갈래는 **SessionStart hook 자체가 회사 settings.json에 미등록**(설치 0.2.7이지만 `npm i -g`는 재init을 안 하므로 구버전 init 상태 잔존) → 자동 refresh가 한 번도 안 돎 → 마지막 수동 `gbc status`(0.2.6 시점) 이후 고착.

> ⚠️ 회사 머신 settings.json은 이 repo에서 직접 검증 불가(별도 환경). 단 "0.2.7 설치 + 0.2.6 며칠 고착 + status로는 갱신됨"의 증상 조합은 위 갈래와 정합. **확인 명령**: 회사에서 `gbc status` 출력의 "SessionStart hook: 등록/미등록" 또는 settings.json에 `hook session-start` 문자열 grep.

**왜 결함인가:** 자동 refresh가 단일 채널(SessionStart hook)에 의존하고, 그 채널이 없는 코호트에선 **사용자가 수동 명령을 칠 때까지 캐시가 영구 stale**. 게다가 그 사실을 알릴 notice마저 #2로 막혀 자가복구 불가.

### #2 — 게이트 통과됨이라 edit 후 PreToolUse 미발동 → **게이트 미발동=🟢정상 / notice 누락=🔴결함**

- **게이트 미발동 자체는 설계 의도(정상)**: cached-skip(hook.ts:168-178)은 "작업단위당 judge 1회" 핫패스 최적화. 이미 통과한 단위는 재판정 없이 `exit(0)`. 작은 edit이라 미발동한 게 아니라 **이미 통과된 작업단위라 캐시 히트**한 것.
- **단, 이 경로가 `maybeUpdateNotice` 없이 `exit(0)`하는 것은 결함**: pass(hook.ts:223)·block(hook.ts:253) 경로엔 `maybeUpdateNotice` emit이 있으나 cached-skip엔 없음. 평상 작업은 대부분 cached-skip이라 **가시 배너가 거의 안 열림**. notice의 dedup은 세션당 1회(notified.json)라 cached-skip에서 emit해도 중복 위험 없음.

### #3 — SessionStart 메시지 받았는데 edit 전 비출력 → **🟡 부분 의도/부분 갭(채널 한계)**

- SessionStart는 `process.stdout.write(parts)`(hook.ts:443) → CC 하네스가 **모델 컨텍스트(additionalContext)로 주입**. 모델은 받음(라이브: 모델이 "신버전 0.2.9" 인용). 그러나 **사용자 가시 배너가 아님** — 이건 CC SessionStart hook 출력 표시 방식의 한계지 gbc 버그가 아님.
- 결론: **사용자 가시 채널은 PreToolUse `systemMessage` 단 하나**. SessionStart는 가시 레버가 아니므로, 가시성 확보의 실질 레버는 #2 수정.

---

## 2. 근본 원인 (1줄)

**가시 채널이 PreToolUse `systemMessage` 단 하나인데, 평상 작업은 대부분 cached-skip이라 그 단일 채널이 닫혀 있다.** + 자동 refresh도 SessionStart hook 단일 채널 의존이라, hook 누락 코호트는 notice·refresh 둘 다 막혀 자가복구 불가.

---

## 3. 0.2.10 수정 범위

### 즉시 (필수, Quick Win) — cached-skip에 notice emit

`src/hook.ts:168-178` cached-skip 경로에 `maybeUpdateNotice` emit 추가:

```ts
if (!specEmpty && isGated(cwd, specHash)) {
  logEvent(cwd, { at: nowIso(), session, specHash: logHash, kind: "gate", tool: toolName, decision: "cached" });
  const n = maybeUpdateNotice(cwd, session, ctx);
  if (n) emit({ systemMessage: n });   // permissionDecision 없음 → cached-pass 동작 불변
  process.exit(0);
}
```

- **효과**: #2 직접 해소. 매 세션 첫 편집(통과된 단위여도)에서 배너 1회 보장(세션당 dedup).
- **#1 연쇄 해소**: 이 배너에 ②init-staleness("SessionStart hook 미등록 → `gbc init --yes`")가 실려 노출 → 사용자 재init → SessionStart hook 복구 → 자동 refresh 부활.
- **#3**: SessionStart 비가시 한계를 PreToolUse 가시 채널로 우회.
- **핫패스 영향**: 미미. 이미 state.json을 읽는 경로이고, `maybeUpdateNotice`는 캐시 read + notified.json read 1회. **네트워크 없음**(emit은 캐시만 읽음).

### 검토 (선택) — 자동 refresh 단일채널 완화

- **하지 말 것**: PreToolUse에 `refreshVersionCache` 추가 = 0.2.7 설계 원칙(핫패스 동기 네트워크 금지) 위배. 편집 1.5s 지연 유발. **기각.**
- **대안**: ②init-staleness notice가 재init을 유도하므로 SessionStart hook 복구가 정공법. 추가 채널 불필요. 단 `gbc update`/`gbc status`가 refresh를 항상 수행하는지 재확인 정도.

### 테스트

- 기존 75/75 보존.
- 신규 회귀: cached-skip(isGated true) 경로에서 미통지 세션이면 `maybeUpdateNotice` 결과를 emit, 통지된 세션이면 emit 안 함(dedup) 검증.

---

## 4. 리스크

| 항목 | 평가 | 근거 |
|---|---|---|
| 게이트 동작 변경 | 🟢 없음 | `systemMessage` 단독(permissionDecision 없음) → cached-pass 통과 동작 불변 |
| 핫패스 성능 | 🟢 무시 | 캐시 read 2회, 네트워크 없음 |
| 노이즈 | 🟢 낮음 | 세션당 1회 dedup(notified.json) |
| 회사 #1 즉시 해소 | 🟡 간접 | 재init 유도 경유(즉시 아님). 즉시 원하면 회사서 `gbc init --yes` 1회 |

---

## 5. 권장 액션

1. **0.2.10 구현**: cached-skip notice emit (위 코드) + 회귀 테스트.
2. **회사 환경 즉시 처치**(코드 무관): `gbc init --yes` 1회 → SessionStart hook 등록 → 자동 refresh 부활. (+ `gbc status`로 캐시 즉시 0.2.9 동기화)
3. **확인 명령**(가설 검증): 회사 settings.json에 `hook session-start` 존재 여부 grep → 미등록이면 #1 갈래 확정.

---

> 이 보고서는 Claude Code `/analyze` 스킬로 생성되었습니다. (3-에이전트 풀스캔 대신 협소-결함 진단에 맞춰 코드 경로 직접 추적으로 적응)
