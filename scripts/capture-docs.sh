#!/usr/bin/env bash
#
# Regenerates every screenshot and terminal capture embedded in README.md.
#
# The point is that the proof in the README is reproducible rather than
# asserted: run this and the images are rebuilt from real investigations.
#
#   ./scripts/capture-docs.sh
#
# Requires Google Chrome (macOS path below; override with CHROME=/path/to/chrome).
set -euo pipefail

cd "$(dirname "$0")/.."

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PORT="${PORT:-3000}"
BASE="http://localhost:${PORT}"

if [ ! -x "$CHROME" ]; then
  echo "Chrome not found at: $CHROME" >&2
  echo "Set CHROME=/path/to/chrome and re-run." >&2
  exit 1
fi

mkdir -p docs/screenshots docs/output

echo "==> building"
npx next build >/dev/null

echo "==> starting server on :${PORT}"
npx next start -p "$PORT" >/tmp/capture-server.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  curl -fs -o /dev/null "${BASE}/api/health" && break
  sleep 1
done

shot() { # name url height
  echo "    $1.png"
  "$CHROME" --headless --disable-gpu --hide-scrollbars --no-sandbox \
    --window-size="1340,$3" --virtual-time-budget=30000 \
    --screenshot="docs/screenshots/$1.png" "$2" >/dev/null 2>&1
}

echo "==> screenshots"
shot "00-compare"                 "${BASE}/?incident=INC-5003&compare=1&run=1" 1700
shot "01-ui-incident-list"        "${BASE}/" 820
shot "02-multi-agent-red-herring" "${BASE}/?incident=INC-5003&approach=multi-agent&run=1" 2050
shot "03-single-agent-same-case"  "${BASE}/?incident=INC-5003&approach=single-agent&run=1" 1450
shot "04-inconclusive"            "${BASE}/?incident=INC-5010&approach=multi-agent&run=1" 1500

echo "==> layout check"
node scripts/measure-layout.mjs "${BASE}/?incident=INC-5003&compare=1&run=1" 430 900 >/dev/null \
  && echo "    no horizontal overflow at 430px" \
  || echo "    WARNING: layout overflows at 430px"

echo "==> terminal captures"
npx vitest run --reporter=dot 2>&1 | tail -8 > docs/output/tests.txt
npx tsx src/cli.ts list 2>&1 | head -20 > docs/output/list.txt
npx tsx src/cli.ts eval --fast --repeats=3 --sweep --out=EVALUATION.md 2>/dev/null > docs/output/eval.txt
npx tsx src/cli.ts investigate -- INC-5003 --fast --trace 2>&1 \
  | grep -E "wave|task_start|critic |replan|terminate" | head -24 > docs/output/trace.txt
npx tsx src/cli.ts investigate -- INC-5003 --fast --trace 2>&1 \
  | grep -E "score H" | head -3 > docs/output/scoring.txt

echo "==> done"
ls -1 docs/screenshots docs/output
