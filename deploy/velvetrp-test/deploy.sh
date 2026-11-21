#!/usr/bin/env bash
# VelvetRP test deploy. Builds velvetrp:test-$TAG from ./src and runs:
#   velvetrp-test-gw  OpenCode Go loopback gateway; owns the netns and published ports
#   velvetrp-test     the app, sharing the gateway netns
#
# The published ports stay on loopback and the tailnet address only. The app
# binds 0.0.0.0 inside that netns so docker-proxy can reach it. HOST=127.0.0.1
# is only visible to in-netns healthchecks and breaks the published port.
#
# First install starts the gateway if it is not running. A later run replaces
# only the app container and leaves the gateway and velvetrp-test-data alone.
#
#   TAG=<sha7> ./deploy.sh
#   TAG=<sha7> SKIP_BUILD=1 ./deploy.sh
#   DRY_RUN=1 TAG=<sha7> ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"
TAG="${TAG:?set TAG}"
PORT=8797
APP_HOST=0.0.0.0
IMAGE="velvetrp:test-$TAG"
TSIP="$(tailscale ip -4 | head -1)"
APP_RUNNING=0
GW_RUNNING=0
docker inspect -f "{{.State.Status}}" velvetrp-test >/dev/null 2>&1 && APP_RUNNING=1 || true
docker inspect -f "{{.State.Status}}" velvetrp-test-gw >/dev/null 2>&1 && GW_RUNNING=1 || true
PREV_IMAGE="$(docker inspect -f "{{.Config.Image}}" velvetrp-test 2>/dev/null || true)"

echo "plan: image=$IMAGE skip_build=${SKIP_BUILD:-0} gw_running=$GW_RUNNING app_running=$APP_RUNNING prev_image=${PREV_IMAGE:-none}"
echo "plan: publish 127.0.0.1:$PORT and tailnet:$PORT ; app bind $APP_HOST:$PORT in gateway netns"
echo "plan: volume velvetrp-test-data kept; gateway $([ "$GW_RUNNING" = 1 ] && echo stays || echo will-be-started)"

if [ "${DRY_RUN:-}" = 1 ]; then
  echo "DRY_RUN: no changes"
  exit 0
fi

if [ "${SKIP_BUILD:-}" != 1 ]; then
  docker build -q -t "$IMAGE" src >/dev/null
fi
docker image inspect "$IMAGE" >/dev/null
docker volume create velvetrp-test-data >/dev/null

if [ "$GW_RUNNING" != 1 ]; then
  docker run -d --name velvetrp-test-gw --restart unless-stopped \
    --env-file gateway.env -v "$PWD/gateway/gw.mjs:/gw/gw.mjs:ro" \
    -p "127.0.0.1:$PORT:$PORT" -p "$TSIP:$PORT:$PORT" \
    node:22-bookworm-slim node /gw/gw.mjs >/dev/null
fi

if [ -n "${PREV_IMAGE:-}" ] && [ "$PREV_IMAGE" != "$IMAGE" ]; then
  printf "%s\n" "$PREV_IMAGE" > ROLLBACK_IMAGE
fi

if [ "$APP_RUNNING" = 1 ]; then
  docker rm -f velvetrp-test >/dev/null
fi
docker run -d --name velvetrp-test --restart unless-stopped \
  --network container:velvetrp-test-gw \
  --env-file app.env -e PORT="$PORT" -e HOST="$APP_HOST" \
  -v velvetrp-test-data:/data "$IMAGE" >/dev/null

ok=0
for i in $(seq 1 40); do
  s="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' velvetrp-test)"
  if [ "$s" = healthy ]; then ok=1; break; fi
  if [ "$s" = exited ] || [ "$s" = restarting ]; then
    echo "app $s"
    docker logs --tail 30 velvetrp-test >&2 || true
    exit 2
  fi
  sleep 2
done
test "$ok" = 1
echo "started $IMAGE on port $PORT (HOST=$APP_HOST in gateway netns)"
