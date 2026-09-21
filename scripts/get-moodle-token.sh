#!/usr/bin/env bash
# Get a Moodle web-service token and write it to .env — the password is read
# silently, never echoed, never stored, never passed on the command line.
#
#   bash scripts/get-moodle-token.sh
set -euo pipefail

URL="${MOODLE_SITE:?set MOODLE_SITE to your Moodle base URL, e.g. https://moodle.example.edu}"
SERVICE="${MOODLE_SERVICE:-moodle_mobile_app}"
ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"

read -r -p "Moodle username (your email): " USERNAME
read -r -s -p "Moodle password (not shown, not saved): " PASSWORD
echo

RESPONSE=$(curl -s "$URL/login/token.php" \
  --data-urlencode "username=$USERNAME" \
  --data-urlencode "password=$PASSWORD" \
  --data-urlencode "service=$SERVICE")
unset PASSWORD

TOKEN=$(printf '%s' "$RESPONSE" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("token",""))')

if [ -z "$TOKEN" ]; then
  echo "No token returned. Moodle said:"
  printf '%s\n' "$RESPONSE" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$RESPONSE"
  echo
  echo "errorcode 'enabledservice'  -> the mobile service is off, or not authorised for your account: ask your Moodle admin"
  echo "errorcode 'invalidlogin'    -> wrong username or password"
  exit 1
fi

umask 077
cat > "$ENV_FILE" <<ENV
MOODLE_URL=$URL/webservice/rest/server.php
MOODLE_TOKEN=$TOKEN
ENV
echo "Token written to $ENV_FILE (chmod 600). It is not printed here."
