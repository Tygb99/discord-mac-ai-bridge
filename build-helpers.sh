#!/bin/bash
# Build the two Pickle helpers next to their sources (helpers/pickle-send, helpers/pickle-fetch).
set -euo pipefail
cd "$(dirname "$0")/helpers"
for t in pickle-send pickle-fetch; do
  swiftc -O -o "$t" "$t.swift"
done
echo "built: $(pwd)/pickle-send $(pwd)/pickle-fetch"
