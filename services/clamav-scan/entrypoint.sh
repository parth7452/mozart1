#!/bin/sh
# Starts clamd (through the base image's own init, which also runs freshclam) and
# the HTTP front door, and takes the container down if either one stops.
#
# A container where only clamd is up would answer a TCP health check while
# scanning nothing; one where only the front door is up would answer /health
# with 503 forever. Both are worse than exiting and being restarted.
set -eu

/init &
CLAMD_PID=$!

node /srv/server.mjs &
HTTP_PID=$!

term() {
  kill "$CLAMD_PID" "$HTTP_PID" 2>/dev/null || true
  wait "$CLAMD_PID" "$HTTP_PID" 2>/dev/null || true
  exit 0
}
trap term TERM INT

# busybox sh has no `wait -n`, so poll. A second is far below any restart budget.
while kill -0 "$CLAMD_PID" 2>/dev/null && kill -0 "$HTTP_PID" 2>/dev/null; do
  sleep 1
done

echo "a supervised process exited; stopping the container" >&2
kill "$CLAMD_PID" "$HTTP_PID" 2>/dev/null || true
exit 1
