#!/usr/bin/env bash
# Restore or stop only the VelvetRP test *app* container.
# The gateway (velvetrp-test-gw) and volume (velvetrp-test-data) stay in place.
#
#   ./ROLLBACK.sh              replace the app with the image in ROLLBACK_IMAGE
#                              (or PREV_TAG / PREV_IMAGE)
#   ./ROLLBACK.sh --stop       remove the app container; do not start another
#   ./ROLLBACK.sh --purge      also remove the gateway, volume, and velvetrp:test-* images
#
# The rollback app uses the same published-port setup as deploy.sh: bind
# 0.0.0.0 inside the gateway netns; ports stay loopback/tailnet-only.
set -euo pipefail
cd "$(dirname "$0")"
PORT=8797
APP_HOST=0.0.0.0

if [ "${1:-}" = "--purge" ]; then
  docker rm -f velvetrp-test velvetrp-test-gw 2>/dev/null || true
  docker volume rm velvetrp-test-data 2>/dev/null || true
  docker images --format "{{.Repository}}:{{.Tag}}" | grep "^velvetrp:test-" | xargs -r docker rmi
  echo "velvetrp test deploy removed (app, gateway, volume, images)"
  exit 0
fi

if [ "${DRY_RUN:-}" = 1 ]; then
  echo "plan: remove app container velvetrp-test only; gateway and volume stay"
  if [ "${1:-}" = "--stop" ]; then
    echo "plan: --stop, no replacement container"
  else
    img="${PREV_IMAGE:-}"
    [ -z "$img" ] && [ -n "${PREV_TAG:-}" ] && img="velvetrp:test-$PREV_TAG"
    [ -z "$img" ] && [ -f ROLLBACK_IMAGE ] && img="$(cat ROLLBACK_IMAGE)"
    echo "plan: restart app from ${img:-MISSING_ROLLBACK_IMAGE} with HOST=$APP_HOST"
  fi
  echo "DRY_RUN: no changes"
  exit 0
fi

docker rm -f velvetrp-test 2>/dev/null || true

if [ "${1:-}" = "--stop" ]; then
  echo "app container removed; gateway and volume kept"
  exit 0
fi

img="${PREV_IMAGE:-}"
[ -z "$img" ] && [ -n "${PREV_TAG:-}" ] && img="velvetrp:test-$PREV_TAG"
[ -z "$img" ] && [ -f ROLLBACK_IMAGE ] && img="$(cat ROLLBACK_IMAGE)"
if [ -z "$img" ]; then
  echo "set PREV_TAG, PREV_IMAGE, or write ROLLBACK_IMAGE" >&2
  exit 2
fi
docker image inspect "$img" >/dev/null
if ! docker inspect -f "{{.State.Status}}" velvetrp-test-gw 2>/dev/null | grep -q running; then
  echo "gateway velvetrp-test-gw is not running; start it with deploy.sh first" >&2
  exit 3
fi
docker run -d --name velvetrp-test --restart unless-stopped \
  --network container:velvetrp-test-gw \
  --env-file app.env -e PORT="$PORT" -e HOST="$APP_HOST" \
  -v velvetrp-test-data:/data "$img" >/dev/null

ok=0
for i in $(seq 1 40); do
  s="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' velvetrp-test)"
  if [ "$s" = healthy ]; then ok=1; break; fi
  if [ "$s" = exited ] || [ "$s" = restarting ]; then
    echo "rollback app $s" >&2
    exit 2
  fi
  sleep 2
done
test "$ok" = 1
echo "restored app $img (gateway and volume kept)"
