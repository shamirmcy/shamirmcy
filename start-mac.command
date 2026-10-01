#!/bin/bash
cd "$(dirname "$0")"
echo "Starting KM DocH. The first start downloads and builds everything and can take 5-10 minutes..."
if ! docker compose up --build -d; then
  echo
  echo "Could not start. Make sure Docker Desktop is installed and running, then try again."
  read -r -p "Press Enter to close."
  exit 1
fi
echo "Waiting for the server to be ready..."
until curl -s -f -o /dev/null http://localhost:3000/healthz; do sleep 3; done
open http://localhost:3000/dev
echo
echo "KM DocH is running: http://localhost:3000/dev"
echo "To stop it, double-click stop-mac.command"
read -r -p "Press Enter to close this window (KM DocH keeps running)."
