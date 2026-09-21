#!/bin/bash
# Full local verification against the real server: fresh database on a simulated Railway volume, phase-1 scenario,
# graceful stop (SIGTERM, like a Railway redeploy), start again from the same volume, phase-2 persistence check.
#   ./test/run-local.sh      (run it detached if your shell kills long jobs:  setsid nohup ./test/run-local.sh > /tmp/runlocal.log 2>&1 &)
set -u
cd "$(dirname "$0")/.."
VOL=/tmp/kb-volume; PIDF=/tmp/kb-server.pid
export PORT=8787 OWNER_SECRET=test-owner-secret-123 OPENAI_API_KEY=sk-test-mock-key OPENAI_MODEL=mock-model OPENAI_BASE_URL=http://127.0.0.1:8899/v1 RAILWAY_VOLUME_MOUNT_PATH=$VOL
stop() { [ -f $PIDF ] && kill -TERM "$(cat $PIDF)" 2>/dev/null; for i in 1 2 3 4 5 6 7 8; do [ -f $PIDF ] && kill -0 "$(cat $PIDF)" 2>/dev/null && sleep 1; done; rm -f $PIDF; }
start() { (nohup node --disable-warning=ExperimentalWarning server.js > /tmp/kb-server.log 2>&1 & echo $! > $PIDF); for i in $(seq 1 30); do sleep 1; curl -s -m 3 http://127.0.0.1:$PORT/health >/dev/null 2>&1 && return 0; done; echo "server did not start"; cat /tmp/kb-server.log; exit 3; }
stop; rm -rf $VOL; mkdir -p $VOL
start
echo "##### health"; curl -s http://127.0.0.1:$PORT/health; echo
echo "##### PHASE 1: full scenario on a fresh database"
node test/e2e.mjs; P1=$?
stop
node --disable-warning=ExperimentalWarning -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('$VOL/kitbash.db');d.exec('DELETE FROM owner_attempts');d.close()"   # clear the lockout the test deliberately triggered
echo; echo "##### server stopped with SIGTERM and started again on the same volume"
start
echo "##### PHASE 2: same tokens, same data after restart"
node test/e2e.mjs --phase=verify; P2=$?
stop
echo; echo "phase1 exit=$P1 phase2 exit=$P2"; exit $((P1 + P2))
