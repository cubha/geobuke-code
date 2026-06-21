#!/bin/sh
# npm 배포 — npm_token.txt에서 토큰을 읽어 1회성 인증으로 publish.
# 영속 .npmrc(시크릿)나 전역 npm config를 남기지 않는다(임시 파일 사용 후 삭제).
# 사용: sh scripts/publish.sh   (추가 인자는 npm publish로 전달, 예: --dry-run)
set -e

cd "$(dirname "$0")/.."

TOKEN_FILE="npm_token.txt"
if [ ! -f "$TOKEN_FILE" ]; then
  echo "❌ 토큰 파일 없음: $TOKEN_FILE — npm Granular 토큰(Bypass 2FA)을 넣어주세요." >&2
  exit 1
fi

# 공백/개행 제거
TOKEN="$(tr -d '[:space:]' < "$TOKEN_FILE")"
if [ -z "$TOKEN" ]; then
  echo "❌ 토큰이 비어있음: $TOKEN_FILE" >&2
  exit 1
fi

# 토큰을 임시 npmrc에만 기록(리포 밖, 종료 시 삭제) — 값이 로그/추적에 남지 않게.
TMP_NPMRC="$(mktemp)"
trap 'rm -f "$TMP_NPMRC"' EXIT
printf '//registry.npmjs.org/:_authToken=%s\n' "$TOKEN" > "$TMP_NPMRC"

echo "🐢 npm publish (geobuke-code) — 토큰 확인됨(값 미출력)"
npm publish --userconfig "$TMP_NPMRC" "$@"
