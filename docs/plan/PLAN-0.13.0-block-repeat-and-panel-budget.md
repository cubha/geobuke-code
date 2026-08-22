# PLAN — 0.13.0 (P4 block-repeat 근사매칭 + Task A TUI 패널 세로예산)

생성: 2026-08-21 · 소스: 세션 대화(요구사항 원문) + planner 산출 구현계획
용도: `/verify-impl` 축A 기준선. 구현 후 사후 덤프이므로 **요구사항·계획은 확정 당시 원문 기준**이며 이 파일에서 새로 추가하지 않았다.

## 요구사항 (사용자 요청 원문 기준)

- **R1.** 0.13.0 구현계획을 `/plan`으로 수립한다.
- **R2.** 수립된 SubTask를 **파일 독립성 기준**으로 분류해, 병렬 대상은 `/team-dev`, 직렬 대상은 `/sh-dev-loop`로 진행한다.
- **R3.** 두 파이프라인 모두 `--tdd --auto` 플래그로 진행한다(적격 SubTask 자동 `[TDD]` 태그 · SubTask별 승인 게이트 없음).
- **R4.** (배치 범위 확정, 직전 턴 로드맵 조정에서 확정) 0.13.0의 내용은 **P4(block-repeat 재검토)** + **Task A(TUI 패널 세로예산)** 두 축이다.

## 구현계획 (planner 산출 + 메인 세션 검수 확정)

### 병렬 배치 — `/team-dev` Group1 (의존 없음)

- **P4-1** `[TDD]` — 토크나이저 + 바이그램 커버리지 술어 + **실채굴 코퍼스 픽스처**
  → `src/text.ts`(신규 export `tokenizeCase`/`coverageRatio`/`isAnnouncedRepeat` + `REPEAT_COVERAGE_MIN`), 신규 `test/fixtures/block-repeat-corpus.json`, `test/unit.test.mjs` append
  - 코퍼스는 실측 이벤트(`/mnt/d/workspace/fa-support/.gbc/events.jsonl` 라인 1222~1228, specHash `a0cddd870403eeb8`) `missing[]` **원문 그대로** — 재구성·의역 금지
  - 토크나이저는 `/`·`,`·`·`·괄호를 구분자로 처리(`scanContractReminders/scanScheduleReminders가`가 갈라져야 매칭 성립)
  - `REPEAT_COVERAGE_MIN`은 이 코퍼스로 캘리브레이션하고 **근거를 주석에 남길 것**
  - RED는 **함수 미존재로 인한 실패**여야 함(import 오류 = 무효 RED)
- **P4-2** `[TDD]` — `PendingReview` 누적 이력(`seen`) + 하위호환 형상가드
  → `src/types.ts`(`seen?: string[]`), `src/review.ts`(`mergeAnnounced`: prior.specHash 다르면 초기화, 같으면 정규화 중복제거 누적 + 상한 후 오래된 것부터 폐기), `test/unit.test.mjs` append
  - `gbc gate reset --hard`(`cli.ts:576`, `clearPendingReview` 호출)가 `seen`도 함께 지우는지 **테스트로 락**
- **A-1** `[TDD]` — 패널 세로예산 순수함수
  → `src/tui/format.ts`에 `PANEL_CHROME_ROWS`(테두리2+제목1=3) + `computePanelCapacity(availableRows, itemCount, hardMax?)`
  - `body = max(0, availableRows - PANEL_CHROME_ROWS)`; `itemCount <= body`면 그대로, 아니면 `max(1, body-2)`(▲▼ worst-case 2 예약, `computeSidebarListRows`와 동일 관례); `hardMax` 지정 시 `min`
  - `availableRows<=0` / `itemCount=0` 경계에서 **크래시 없이** 0/1 반환
  - `test/tui-format.test.mjs` append

### 병렬 배치 — `/team-dev` Group2 (A-1 완료 후, UI라 TDD 태그 없음)

- **A-3** — `SkillsPanel`(`src/tui/ui/SkillsPanel.tsx`): `availableRows?: number` prop 추가, `computePanelCapacity` + `computeSidebarWindow`(cursor=0 고정)로 윈도잉, ▲/▼ 위·아래 N개 인디케이터
- **A-4** — `HelpPanel`(`src/tui/ui/HelpPanel.tsx`): 동일 패턴. `SHORTCUT_ROWS`를 컴포넌트 밖 export로 분리
- **A-5** — `ReposPanel`(`src/tui/ui/ReposPanel.tsx`): `REPOS_PANEL_MAX_VISIBLE=9` 하드코딩을 `computePanelCapacity(availableRows, entries.length, 9)`로 교체(**hardMax=9는 Alt+1..9 단축키 상한이라 유지**), `availableRows` prop 추가(미지정 시 기존 동작 보존 기본값)
- **A-6** — `MetricsPanel`(`src/tui/ui/MetricsPanel.tsx`): 두 `<Text>`에 `wrap="truncate"` 추가. `availableRows` prop은 받되(향후 확장 대비) 현재는 클리핑 로직 불요

### 직렬 배치 — `/sh-dev-loop` (team-dev 병합분 위에서 순차)

- **A-2** — `src/tui/app.tsx`가 4개 패널에 `availableRows={chatViewportRows}` 하달
  - `chatViewportRows`는 ChatBox가 `contentRows = max(1, viewportRows)`로 **실제 클리핑하는 바로 그 값** → 예산과 실렌더가 구조적으로 일치
- **P4-3** `[TDD]` — block-repeat 판별을 완전일치 **OR** 근사매칭으로 확장 + 누적 이력 배선
  → `src/gate-core.ts` ⑧ block 분기: `mergeAnnounced`로 `seen` 누적, `exactRepeat || approxRepeat`, `env.GBC_REPEAT_MATCH !== "exact"` escape hatch
  - **`sameMissingSet` 함수 자체는 절대 수정 금지** — `evidenceFlip`(P2b 계측)이 공유하는 술어. 대신 그 근처 주석에 "두 곳이 의도적으로 다른 술어를 쓴다"를 명시
  - `src/metrics.ts` `GateEvent`에 `repeatMatch?: "exact" | "covered"` 추가, block-repeat 이벤트에 채움(값 없으면 키 생략 — 기존 `appliedStale` 관례)
  - **회귀락**: 기존 block-repeat 테스트 5건 + evidenceFlip 테스트 3건이 **수정 없이 그대로 green**
  - RED→GREEN 커밋 분리
- **P4-4** — 문서화
  - `README.md`에 근사매칭 확장 한 단락
  - `docs/analysis/ANALYSIS-block-repeat-rootfix-2026-08-20.md` 신규: 실측 근거·`REPEAT_COVERAGE_MIN=0.8` 캘리브레이션·Tier1/Tier2 설계 이유·`sameMissingSet` 불변 이유 + **오탐율(진짜M1) 상승 예상 이유**(억제 증가 → `scoring.ts`의 `repeated-unresolved`가 오탐 후보로 계수 → baseline UPR 61%/IPR 16%와 `repeatMatch`로 분리 집계 필요, 단순 비교 금지)
  - `CHANGELOG.md` 0.13.0 섹션 신설

### 검증 요구

- SubTask마다 `bash verify.sh --no-build` + `scope-critic`(병렬, 호출마다 JSONL 1줄 로그)
- 전체 완료 후 `bash verify.sh --full` + `npm run eval`(**무변경이 정상 신호** — P4는 judge 미경유) + golden replay flip0

## 제외 합의 (이 배치에 포함하지 않기로 한 것)

- **X1.** tmux 실렌더 검증(Task A) — 실 TTY 필요, 자동화 불가. CHANGELOG에 미포함 사실 명시하기로 함.
- **X2.** `ApprovalBox` 세로예산 — 승인 큐는 항목 수가 구조적으로 작아 대상 제외(planner 브리핑 검수 시 근거 확인).
- **X3.** SkillsPanel/HelpPanel 스크롤 배선(커서 이동) — 윈도잉만 범위, cursor=0 고정.
