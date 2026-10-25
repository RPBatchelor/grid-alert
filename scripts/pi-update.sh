#!/usr/bin/env sh
# Update the running pilot to the latest code on GitHub and restart it. History in ./data is kept.
# Usage (on the Pi, in the project folder):  ./scripts/pi-update.sh
set -eu
cd "$(dirname "$0")/.."

echo "Fetching latest code…"
git pull --ff-only

GIT_COMMIT="$(git rev-parse --short HEAD)"
export GIT_COMMIT
echo "Building version ${GIT_COMMIT} (this takes a few minutes on a Pi)…"
docker compose build app

echo "Restarting…"
docker compose up -d
docker image prune -f >/dev/null

echo "Done. Health:"
sleep 5
curl -fsS http://localhost:8080/api/health && echo
