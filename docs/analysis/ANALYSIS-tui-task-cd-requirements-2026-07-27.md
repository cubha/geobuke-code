# 0.11.0 Task C + Task D 요구사항 구현 검증 보고서

> 분석일: 2026-07-27
> 프로젝트: geobuke-code TUI — 미출시(unshipped) 배치 전체 (`origin/main..HEAD` 33커밋)
> 분석 관점: `/analyze` — 요구사항표(gbc spec) 기준 구현결과 검증. 오류·누락 대상 점검.
> 방법: `.gbc/spec.archive`(Task C, done 처리됨) + `.gbc/spec.md`(Task D, 현재 활성)에서 원문 요구사항 22개 항목을 추출 → 6개 영역으로 분리 → 영역별 독립 검증 에이전트(코드+테스트+`git diff origin/main..HEAD` 근거, 신뢰 없이 처음부터 재확인) 병렬 실행 → 핵심 발견 2건은 보고자가 직접 코드 재확인.
>
> **후속 처리(2026-07-27, 커밋 `aff5bcc`): §3의 회귀 3건 전부 수정 완료.** 각 수정은 scope-critic 개별 검토(3회 전부 DECISION_CHANGED: no) + `verify.sh --full` 851/851 + security-auditor DEEP 발행게이트(Crit0/Warn0/Info1)를 통과했다. 상세는 각 §3 항목 말미의 "적용 결과" 참조.

---

## 1. 요약

| 영역 | 요구항목 수 | PASS | PARTIAL | FAIL | 비고 |
|---|---|---|---|---|---|
| G1. in-flight 제출 큐잉 (Task C-1) | 4 | 2 | 2 | 0 | **회귀 2건 발견(아래 §3)** |
| G2. statusline 토큰 (Task C-5) | 5 | 5 | 0 | 0 | 이상 없음 |
| G3. 도구 승인 diff 프리뷰 (Task C-2) | 3 | 2 | 1 | 0 | **회귀 1건 발견(아래 §3)** |
| G4. prompt history 영속화 (Task C-3) | 2 | 2 | 0 | 0 | 이상 없음 |
| G5. 채팅 말풍선 UI (Task C-4) | 1 | 1 | 0 | 0 | 이상 없음 |
| G6. 승인 오귀속 근본수정 (Task D) | 7 | 7 | 0 | 0 | 이상 없음(1번은 7번에 흡수된 구버전 문구) |
| **합계** | **22** | **19** | **3** | **0** | |

**결론: 요구사항 자체의 미구현(FAIL)은 없다.** 그러나 검증 과정에서 요구사항표에 없던 **회귀 3건**을 발견했고, 그중 2건은 재현 조건이 이 프로젝트가 이미 겪은 바 있는 실제 장애 클래스(세션 생성 실패)와 직결돼 있어 무시할 수 없는 심각도였다. **3건 전부 같은 세션에서 수정·검증·커밋 완료(`aff5bcc`)** — 상세는 §3.

`npm run build`(tsc) + `node --test test/**/*.test.mjs` 849/849 — 전 영역 공통으로 재확인, 전부 PASS(단위테스트 자체는 정직하다 — 아래 버그들은 **통합 경로**에서만 드러나며 기존 단위테스트가 커버하지 않는 지점이다).

---

## 2. 영역별 요구사항 검증 상세

### G1 — in-flight 제출 큐잉 (Task C-1)

| # | 요구사항 | 판정 | 근거 |
|---|---|---|---|
| 1 | streaming 판정을 tab status로 교체 | **PARTIAL** | `isRepoStreaming`(tabs.ts:96-98) 정상 배선(app.tsx:1082,1128), TAB_SWITCHED streaming 필드 정상(model.ts:127-136). **단, 세션 생성 실패 시 영구 고착 회귀 — §3-A** |
| 2 | repoId별 queue.ts + 배경탭 데이터 보존 | **PASS** | `queue.ts` 순수 함수+불변식 테스트 8/8, 배경탭 scrollback은 activeTabId 무관하게 항상 append(app.tsx:579 결함1 근본수정 계승) |
| 3 | submit() 종료 시 순차 drain + 비활성탭 TURN_START 미반영 | **PASS** | `runTurnThenDrain`(app.tsx:769-781)이 `submit()`의 activeTabId 가드(656,741)에 편승 |
| 4 | 대기건수 표시 + Esc로 큐 비우기 + 취소원문 에코 | **PARTIAL** | 표시(app.tsx:1386)·Esc clear+echo(1080-1101) 정상. **단, §3-A와 같은 원인으로 Esc 무력화 케이스 존재** |

### G2 — statusline 토큰 (Task C-5, D-1/D-7 usagePct 포함)

5개 항목 전부 PASS. `EngineSession.getContextUsage()` 노출+resume폴백 위임(engine.ts:456,639-646,724-726), `Partial<Statusline>` 부재시 필드생략(bridge.ts:60-65), `12.3k/200k` 병기+좁은폭 강등(format.ts:863-871, Segments.tsx 단일 Text 래핑+overflow hidden), 턴종료 1회 호출(finally 블록 구조적 강제, app.tsx:668-670,749-758), percentage 그대로 pass-through(bridge.ts:64). `usagePct`가 이전엔 writer 0개인 죽은 게이지였다는 사실도 `git log -S`로 재확인(회귀 아니라 결함수정).

### G3 — 도구 승인 diff 프리뷰 (Task C-2)

| # | 요구사항 | 판정 | 근거 |
|---|---|---|---|
| 1 | formatToolPreview 4종(Edit/Write/MultiEdit/Bash) | **PASS** | diff.ts:60-79, 4종 전부 테스트됨 |
| 2 | ApprovalState.preview가 kind와 독립적으로 표시 | **PARTIAL** | 저장은 kind-독립(model.ts:26-33)이나 **렌더는 `kind==="generic"`에만 국한**(ApprovalBox.tsx:55) — spec-add는 의도적으로 derivedCase를 우선 표시(app.tsx:1195-1197 주석)하는 설계 결정이라 결함은 아니나, 요구사항 문구("kind와 독립적으로 표시한다")와 실제 동작(표시는 kind에 종속)이 불일치 |
| 3 | ApprovalBox 렌더+예산 반영+박스높이 불변 | **PASS** | 예산계산(app.tsx:1203)과 렌더(ApprovalBox.tsx:61)가 동일 함수·동일 인자(`formatToolPreviewVisual`)로 drift 없음. `chatViewportRows`가 `inputContentRows` 증가분을 흡수(app.tsx:1224-1227)+외곽 `overflow="hidden"` 이중 안전판. 1행 안전측 과대예약(spec-add용 상수 3을 generic에도 재사용) 확인했으나 넘치는 방향이 아니라 결함 아님 |

**추가 발견(요구사항 밖, §3-B로 승격)**: preview 없을 때 reason 텍스트로 폴백하는 분기(ApprovalBox.tsx:74-78)가 프로덕션에서 죽은 코드 — Edit/Write/MultiEdit/Bash 외 도구(WebFetch·MCP 등)의 canUseTool 승인이 빈 본문으로 뜬다.

### G4 — prompt history 영속화 (Task C-3)

2개 항목 전부 PASS. repoId별 격리(editor.ts:193-203, app.tsx:285 매 렌더 activeTabId 파생)+탭전환 시 교차오염 없음, `~/.gbc/prompt-history.json` 원자쓰기(store.ts:102-106 temp+rename, 다른 모듈과 일관)+100건 상한(FIFO 정상)+`GBC_NO_PROMPT_HISTORY` 양쪽 진입점 전부 차단. fail-open(쓰기 try/catch)까지 확인.

### G5 — 채팅 말풍선 UI (Task C-4)

1개 항목 PASS. `ChatEntry.role`은 요구사항표가 지목한 `model.ts`가 아니라 `ChatBox.tsx:22-29`+`scrollback.ts:11`에 정의돼 있으나(파일 추정만 틀림, 기능은 정확) `decorateBubble`(format.ts:279-286, 우측정렬만·사용자 승인 Option B)+30컬럼 임계값이 실기 tmux 5해상도 기록(28열에서만 강등)과 산술까지 정확히 일치. role 일관성(system/assistant 예외없음)·높이예산 drift 없음도 확인.

### G6 — 승인 오귀속 근본수정 (Task D)

7개 항목 전부 PASS(1번은 구버전 문구, 7번이 최종 정확한 버전으로 대체 — 이미 알려진 사실). `approval-queue.ts` 순수 큐, `activateApproval` activeTabId 가드+`reseedApprovalForTab` 우회 안전성(호출부 2곳 모두 확정된 목적지 repoId 전달 확인), `drainApprovals` 3지점(submit 직후/onEnded/optOutTab) 전부 배선, Sidebar 배지, ApprovalBox dead code 제거, usagePct pass-through 전부 코드 근거로 확인. 부가 발견: Sidebar 배지는 `~/.gbc/repos.json` 등록 repo만 대상이라 미등록 opt-in 탭은 배지가 안 뜨는 기존 특성(이 배치 범위 밖, 결함 아님). `.gbc/spec.md`가 아직 `[ ]` 상태로 `gbc done` 미실행(코드는 완료, 프로세스 마무리만 남음).

---

## 3. 발견된 회귀 (요구사항표에 없던 결함 — 보고자 직접 코드 재확인 완료)

### §3-A. [🔴 High] 세션 생성 실패 시 탭 상태가 "streaming"에 영구 고착 — Req1/Req4 동시 훼손

**위치**: `src/tui/app.tsx:646-763` (`submit`)

`submit()`은 `try` 진입 전 662행에서 무조건 `setTabs(... {status:"streaming"})`을 먼저 세팅한다. `getOrCreateSession(repoId)`가 던지면(engine.ts 주석이 명시하는 실제 장애 클래스: agent-sdk lazy dynamic import 실패, spawn EPERM — **이 프로젝트의 기존 필드 리포트(`project_field_report_eperm_0_9_3.md`)에 실제로 발생한 사례**) `catch`(730-739)로 빠지는데, 이 블록은 `pushLine`으로 에러 배너만 띄울 뿐 **`setTabs`를 한 번도 호출하지 않는다**. `finally`(740-760)도 activeTabId 가드 안쪽이라 배경탭이면 아예 안 돈다.

결과: 그 repo의 tab status가 `"streaming"`으로 영구 고정된다. Req1이 교체한 판정 함수 `isRepoStreaming`이 이제 그 repo에 대해 영원히 `true`를 반환 → 이후 모든 제출이 `runTurnThenDrain`을 호출하는 정상 경로 대신 큐잉 분기(app.tsx:1128-1131)로만 빠진다 → `submit()` 자체가 다시는 호출되지 않으므로 상태를 되돌릴 방법이 없다 → 탭을 닫는 것도 불가능(마지막 탭이면 `removeTab`이 거부, tabs.ts:58). 앱 재시작 전까지 그 repo는 영구히 먹통이 된다.

**회귀인 이유**: 교체 전 `state.streaming`(전역 boolean) 방식은 `finally`가 무조건(activeTabId 무관하게) `TURN_END`를 디스패치해 자연 치유됐다. 새 tab-status 방식은 이 자연치유 경로를 제거했다.

**부수 영향(Req4)**: 이 상태에선 Esc를 눌러도(`sessionsRef.current.get(repoId)`가 `undefined`라 `interrupt()`는 무해한 no-op) 큐는 비워지지만 **status는 "streaming"에서 안 풀린다** — Esc로 한 번 비워도 다음 제출부터 다시 큐잉만 반복된다.

**권장 수정**: `catch` 블록에서도 `setTabs(prev => updateTabStatus(prev, repoId, { status: "dead" }))`를 호출해 상태를 되돌린다(성공 시 "alive"/실패 시 "dead"로 귀결시키는 기존 정상경로의 두 분기와 대칭).

**적용 결과(2026-07-27, `aff5bcc`)**: 권장 수정 그대로 적용. `catch` 블록 끝에 `setTabs(prev => updateTabStatus(prev, repoId, { status: "dead" }))` 추가. scope-critic이 `tabs.ts` TRANSITIONS 표에서 `streaming→dead`가 유효 전이임과 `getOrCreateSession`이 성공 시에만 `sessionsRef`에 세션을 set한다는 사실(catch 진입 시 정리할 세션 엔트리 자체가 없음)을 확인해 DECISION_CHANGED: no. security-auditor가 "dead" 전이가 승인 큐를 승인 없이 우회 통과시키는 경로를 만들지 추가 검증(생성 없음 확인).

### §3-B. [🟡 Medium] 탭 종료 시 submitQueue 미정리 — orphan → 유령 재전송

**위치**: `src/tui/app.tsx:826-849` (`optOutTab`)

`optOutTab`은 승인 큐(`drainApprovals`)는 명시적으로 비우면서, 같은 함수 안에서 세션을 닫고 탭을 제거하는 동안 **제출 큐(`submitQueue`)는 건드리지 않는다**. `queue.ts`의 `clearRepo`는 구현+단위테스트(8/8)까지 돼 있지만 **`app.tsx`에 import조차 안 돼 있다**(63행 import 목록에 없음, `grep clearRepo src/tui/app.tsx` 무결과).

시나리오: A탭에서 스트리밍 중 후속 프롬프트를 큐잉해두고, 드레인되기 전에 A탭을 닫는다 → 그 repoId 아래 메시지가 `submitQueue`에 영원히 남는다(입력창 하단 카운트는 활성 탭 것만 보여주므로 화면엔 안 보임) → 나중에 같은 repoId가 다시 탭으로 열리고 사용자가 전혀 무관한 새 프롬프트를 idle 상태에서 제출하면, `runTurnThenDrain`의 드레인 루프가 **과거에 큐잉됐던 그 메시지를 사용자 모르게 자동으로 재전송**한다.

**권장 수정**: `optOutTab`에 `setSubmitQueue(prev => clearRepo(prev, repoId))`(및 `queueRef.current` 동기화) 1줄 추가 — `drainApprovals`와 대칭되는 위치.

**적용 결과(2026-07-27, `aff5bcc`)**: 권장 수정 그대로 적용(`clearRepo` import 추가 + `queueRef.current`/`setSubmitQueue` 쌍 갱신). scope-critic이 모든 `setSubmitQueue` 호출부가 `queueRef.current`와 동기 쌍으로 갱신되는 기존 관례와 일치함을 전수 확인해 DECISION_CHANGED: no. 탭 종료 시 에코 없이 조용히 버리는 것도 "탭 닫기 = 명시적 폐기 의도"로 Esc취소(에코 있음)와의 비일관이 아니라는 판단.

### §3-C. [🟡 Medium] Edit/Write/MultiEdit/Bash 외 도구 승인 시 reason 텍스트 소실

**위치**: `src/tui/app.tsx:519` (`makeInkCanUseTool`) + `src/tui/ui/ApprovalBox.tsx:55,74-78`

`app.tsx:519`가 canUseTool이 발동하는 **모든** 도구에 대해 `preview: { toolName, input }`을 무조건 채운다. `formatToolPreview`(diff.ts)는 Edit/Write/MultiEdit/Bash 외 도구명에는 빈 배열을 반환(diff.ts:78)하는데, `diff.ts` 자신의 헤더 주석은 "그 외 도구는 빈 배열(app.tsx가 기존 reason 표시로 폴백한다)"이라고 주장한다 — 하지만 `preview`가 이제 절대 `null`이 되지 않으므로 `ApprovalBox.tsx:74-78`의 reason 폴백 분기는 **도달 불가능한 죽은 코드**다. 결과적으로 WebFetch·MCP 도구 등 4종 밖의 canUseTool 승인은 헤더 한 줄(`도구 실행 승인 요청 — <ToolName>`)만 뜨고 **본문이 완전히 빈 채로** 렌더된다 — 이전엔 `decisionReason`이라도 보였던 것에서 후퇴.

**권장 수정**: `app.tsx:519`에서 `formatToolPreview`가 실제로 내용을 생성하는 4개 도구명일 때만 `preview`를 채우고, 아니면 `null`로 둬 기존 reason 폴백이 다시 살아나게 한다. 또는 `diff.ts`의 주석이 틀렸다는 걸 인지하고 `formatToolPreview`에 "지원 안 되는 도구명이면 무조건 reason 텍스트 자체를 프리뷰 라인으로" 넣는 방식으로 통합.

**적용 결과(2026-07-27, `aff5bcc`)**: 첫 번째 대안(preview null 폴백) 채택. `diff.ts`에 `isToolPreviewSupported(toolName)` 신설(지원 4종의 단일 소스, `formatToolPreview`의 switch문과 동기화 — 신규 테스트 `test/tui-diff.test.mjs` 2건), `app.tsx`의 preview 생성 지점에서 지원 도구만 채우고 아니면 `null`. `QueuedApproval.preview` 타입을 `ToolCallPreview|null`로 확장. scope-critic·security-auditor 둘 다 "정보 후퇴가 아니라 회복"으로 확인(빈 헤더만 뜨던 것 → reason 텍스트 복원). scope-critic이 지적한 잔여 리스크(`PREVIEW_SUPPORTED_TOOLS`와 `formatToolPreview` switch가 물리적으로 분리돼 향후 도구 추가 시 drift 가능)는 이 수정 이전부터 있던 구조이고 새로 만든 문제가 아니라 DECISION_CHANGED: no — 백로그로만 기록.

---

## 4. 문서/프로세스 정합성 (결함 아님, 정리 권고)

- `.gbc/spec.md` 7개 항목이 전부 `[ ]`(미체크) 상태 — 구현은 완료됐으나 `gbc done`이 아직 실행되지 않음. §3 수정 반영 후 일괄 `gbc done` 권고.
- `.gbc/spec.md` 1번 항목("계산해") 문구가 7번("그대로 전달")에 의해 대체된 구버전 — `gbc done`으로 자연 정리됨.
- G3 요구사항 2번의 "kind와 독립적으로 표시" 문구는 실제 최종 설계(spec-add는 derivedCase 우선)와 다르다 — 결함이 아니라 요구사항 원문 자체가 최종 결정 전에 쓰인 것. 정정 불필요(아카이브된 완료 스펙이라 재작성 실익 없음), 이 보고서가 정확한 최종 동작의 기록.

---

## 5. 권장 조치 — 전부 완료

| 우선순위 | 항목 | 근거 | 상태 |
|---|---|---|---|
| 1 (즉시) | §3-A 세션생성실패 시 탭 상태 미복구 | 이 프로젝트가 이미 실측한 장애 클래스(EPERM)와 직결, 사용자 액션으로도 복구 불가(재시작만 유일한 탈출구) | ✅ `aff5bcc` |
| 2 (즉시) | §3-B optOutTab submitQueue 미정리 | 사용자 모르게 과거 메시지가 재전송되는 조용한 오작동 — 신뢰성 문제 | ✅ `aff5bcc` |
| 3 (권장) | §3-C non-4-tool 승인 시 빈 본문 | 사용자가 무엇을 승인하는지 못 보고 승인/거부해야 하는 상황 — UX 회귀, 보안 판단에도 영향 | ✅ `aff5bcc` |

세 건 모두 국소 수정(각 함수 내 1~수 줄)이었으며 기존 아키텍처(activeTabId 가드, drain 3지점, kind 분기) 재설계 없이 해소됐다. 검증: scope-critic 3회(전부 DECISION_CHANGED: no) + `verify.sh --full` 851/851 + security-auditor DEEP 발행게이트(Crit0/Warn0/Info1, 범위 밖 참고사항만).

---

> 이 보고서는 Claude Code `/analyze` 스킬 + 6개 독립 검증 서브에이전트(병렬)로 생성됐다. §3의 발견은 서브에이전트 보고 후 보고자가 `app.tsx` 코드를 직접 재확인해 실재를 검증했다.
