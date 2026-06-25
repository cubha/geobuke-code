import { join } from "node:path";
import { gbcDir, readJson, writeJson } from "./store.js";

/**
 * 프로젝트 로컬 토글 설정 (.gbc/config.json).
 * ★ state.json(작업단위 게이트 스코프)과 분리한다 — state는 'gbc gate reset'에 초기화되므로
 *   사용자 선호(mute 등)를 거기 두면 게이트 리셋마다 조용히 풀리는 버그가 된다.
 */
interface GbcConfig {
  /** Stop hook(대화 종료마다 발화) defer 리마인드 음소거. SessionStart 진입 알림은 영향 없음. */
  stopHintMuted?: boolean;
  /** 골든셋 캡처 모드(A2). on이면 hook이 judge 출력을 .gbc/golden.json에 기록(opt-in, 로컬). */
  captureGolden?: boolean;
}

function configPath(cwd: string): string {
  return join(gbcDir(cwd), "config.json");
}

function readConfig(cwd: string): GbcConfig {
  return readJson<GbcConfig>(configPath(cwd), {});
}

/** Stop hook defer 리마인드가 음소거 상태인지. 파일/키 부재 시 false(기본=노출). */
export function isStopHintMuted(cwd: string): boolean {
  return readConfig(cwd).stopHintMuted === true;
}

/** Stop hook defer 리마인드 음소거 토글을 영속 저장(수동 unmute 전까지 유지). */
export function setStopHintMuted(cwd: string, muted: boolean): void {
  const cfg = readConfig(cwd);
  cfg.stopHintMuted = muted;
  writeJson(configPath(cwd), cfg);
}

/** 골든셋 캡처 모드인지. 파일/키 부재 시 false(기본=캡처 안 함). */
export function isGoldenCapture(cwd: string): boolean {
  return readConfig(cwd).captureGolden === true;
}

/** 골든셋 캡처 모드 토글을 영속 저장(수동 off 전까지 유지). */
export function setGoldenCapture(cwd: string, on: boolean): void {
  const cfg = readConfig(cwd);
  cfg.captureGolden = on;
  writeJson(configPath(cwd), cfg);
}
