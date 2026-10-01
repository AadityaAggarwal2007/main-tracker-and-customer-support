#!/usr/bin/env bash
# Runs the live golden conversations on the server (the model key lives only there) using
# THIS checkout's code, so a change is tested BEFORE it is deployed. It copies src/ and
# scripts/ai-tests/ to a temp folder on the server, runs there, and deletes the folder.
# Reads the live prompt and saved answers; writes nothing to the database.
#   bash scripts/ai-tests/run-on-vps.sh [--filter id] [--repeat 2] [--show]
set -euo pipefail
cd "$(dirname "$0")/../.."
REMOTE=/tmp/ai-tests-run-$$
ssh shiptrack-vps "rm -rf $REMOTE && mkdir -p $REMOTE/scripts"
COPYFILE_DISABLE=1 tar cz src/lib scripts/ai-tests | ssh shiptrack-vps "tar xz -C $REMOTE"
ssh shiptrack-vps "cd $REMOTE && DUMP=${DUMP:-} THINK=${THINK:-} FORCE_MODEL=${FORCE_MODEL:-} NODE_PATH=/var/www/tracker/node_modules node scripts/ai-tests/run.js --live $*; code=\$?; rm -rf $REMOTE; exit \$code"
