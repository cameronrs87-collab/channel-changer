#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is not installed on this computer."
  echo "  Download the LTS version from https://nodejs.org , install it, then double-click start.command again."
  echo
  read -r -p "  Press Enter to close."
  exit 1
fi
echo "  Starting Channel Changer. The big screen opens in your browser in a moment."
echo "  Keep this window open during the show. Close it to stop."
echo
node server.js
