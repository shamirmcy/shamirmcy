#!/bin/bash
cd "$(dirname "$0")"
docker compose down
echo "KM DocH stopped."
read -r -p "Press Enter to close."
