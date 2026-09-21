#!/bin/bash
# Browser tests for the Team tab against the real server, each on a fresh database:
#   ui_connector.py   Kitbash as a Claude artifact: `mcp` capability bridged (with a real OAuth token) to this server
#   ui_standalone.py  Kitbash opened from this server itself (what you get on your Railway URL); no stubs at all
# Needs: python3 + playwright (chromium). Run detached:  setsid nohup ./test/run-ui.sh > /tmp/runui.log 2>&1 &
set -u
cd "$(dirname "$0")/.."
VOL=/tmp/kb-ui-volume; PIDF=/tmp/kb-ui-server.pid; MPID=/tmp/kb-ui-mock.pid
export PORT=8787 OWNER_SECRET=test-owner-secret-123 OPENAI_API_KEY=sk-test-mock-key OPENAI_MODEL=mock-model OPENAI_BASE_URL=http://127.0.0.1:8899/v1 RAILWAY_VOLUME_MOUNT_PATH=$VOL
stop() { for f in $PIDF $MPID; do [ -f $f ] && kill "$(cat $f)" 2>/dev/null; rm -f $f; done; sleep 1; }
run() {
  stop; rm -rf $VOL; mkdir -p $VOL
  (nohup node --disable-warning=ExperimentalWarning server.js > /tmp/kb-ui-server.log 2>&1 & echo $! > $PIDF)
  for i in $(seq 1 30); do sleep 1; curl -s -m 3 http://127.0.0.1:$PORT/health >/dev/null 2>&1 && break; done
  (nohup node test/uiserver.mjs > /tmp/kb-ui-mock.log 2>&1 & echo $! > $MPID)
  for i in $(seq 1 20); do sleep 1; grep -q ready /tmp/kb-ui-mock.log 2>/dev/null && break; done
  echo "########## $1"; python3 test/$1; return $?
}
run ui_connector.py; A=$?
run ui_standalone.py; B=$?
stop; echo; echo "connector exit=$A standalone exit=$B"; exit $((A + B))
