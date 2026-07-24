// 0.9.0 A3a ST5 — A-③ 라이브 메트릭 패널(⌃M). .gbc/events.jsonl을 fs.watch로 지켜보다 변경 시
// computeMetrics(기존 순수함수 재사용)로 재계산 — cmdMetrics(cli.ts)와 동일한 단일-repo 비-all 경로.
import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { computeMetrics, readEventsMerged, eventsPath, type Metrics } from "../../metrics.js";
import { extractionPath, parseExtraction } from "../../extraction.js";
import { computeRealM1, classifyBlockOutcome, joinBySession, loadScores, type RealM1 } from "../../scoring.js";
import { BORDER_COLOR, PANEL_TITLE_COLOR } from "./theme.js";

function load(cwd: string): { m: Metrics; real: RealM1 } {
  // readEventsMerged(0.10.6 A4) — 로테이션된 .1 세대가 있으면 현행 세대와 병합해 읽는다.
  const events = readEventsMerged(cwd);
  const exPath = extractionPath(cwd);
  const records = parseExtraction(existsSync(exPath) ? readFileSync(exPath, "utf8") : "");
  const real = computeRealM1(joinBySession(events, records), classifyBlockOutcome(events), loadScores(cwd));
  return { m: computeMetrics(events), real };
}

export function MetricsPanel({ cwd }: { cwd: string }) {
  const [data, setData] = useState<{ m: Metrics; real: RealM1 } | null>(null);

  useEffect(() => {
    setData(load(cwd));
    // 로테이션 발생 시(events.jsonl이 rename되고 같은 경로에 새 파일이 만들어지는 순간) fs.watch가
    // 그 교체를 놓칠 가능성이 있다(OS별 inotify/rename 처리 차이, 0.10.6 A4 알려진 한계) — 다음
    // append에서 이어지는 변경은 정상 감지되므로 패널이 영구히 정체되진 않는다.
    let watcher: FSWatcher | null = null;
    try {
      watcher = watch(eventsPath(cwd), () => setData(load(cwd)));
    } catch {
      // 파일 아직 없음(이벤트 0건) — 패널은 초기 로드값(0건)으로 표시, watch 재시도는 안 함(패널 재오픈 시 갱신).
    }
    return () => watcher?.close();
  }, [cwd]);

  if (!data) return null;
  const { real } = data;
  const pct = (r: number | null) => (r === null ? "—" : `${(r * 100).toFixed(1)}%`);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={BORDER_COLOR} paddingX={1}>
      <Text color={PANEL_TITLE_COLOR} bold>
        📊 라이브 메트릭 <Text color="gray">— .gbc/events.jsonl</Text>
      </Text>
      <Text>
        <Text color="green">진짜 M1</Text> 위반율 {pct(real.violation.rate)} <Text color="gray">({real.violation.scored} scored · {real.violation.unscored} unscored)</Text>
        {"   "}오탐율 <Text color={real.falsePositive.rate && real.falsePositive.rate > 0 ? "yellow" : "green"}>{pct(real.falsePositive.rate)}</Text>{" "}
        <Text color="gray">({real.falsePositive.fpCandidates}/{real.falsePositive.totalBlocks})</Text>
      </Text>
      <Text color="gray">
        M2 게이트 적중 {data.m.m2.gateCaught} · 도중발견 {data.m.m2.deferred} M3 재작업단위 {data.m.m3.multiEditUnits}/{data.m.m3.workUnits}
      </Text>
    </Box>
  );
}
