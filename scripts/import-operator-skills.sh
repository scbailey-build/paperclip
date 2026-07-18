#!/usr/bin/env bash
# Import a folder of markdown skills (e.g. the Claude desktop-app library at
# ~/.claude/skills) into a Paperclip company's skills library.
#
# Usage:
#   scripts/import-operator-skills.sh <company-id> [skills-dir] [api-url]
#
# Defaults: skills-dir=~/.claude/skills, api-url=http://127.0.0.1:3100/api
# Requires: curl, jq. Auth: run against a local_trusted instance, or set
# PAPERCLIP_API_KEY for a bearer token.
set -euo pipefail

COMPANY_ID="${1:?usage: import-operator-skills.sh <company-id> [skills-dir] [api-url]}"
SKILLS_DIR="${2:-$HOME/.claude/skills}"
API_URL="${3:-http://127.0.0.1:3100/api}"

[ -d "$SKILLS_DIR" ] || { echo "skills dir not found: $SKILLS_DIR" >&2; exit 1; }

AUTH=()
if [ -n "${PAPERCLIP_API_KEY:-}" ]; then
  AUTH=(-H "Authorization: Bearer $PAPERCLIP_API_KEY")
fi

echo "Importing skills from $SKILLS_DIR into company $COMPANY_ID ..."
RESULT=$(jq -n --arg source "$SKILLS_DIR" '{source: $source}' |
  curl -sS -X POST "$API_URL/companies/$COMPANY_ID/skills/import" \
    -H 'Content-Type: application/json' "${AUTH[@]}" -d @-)

echo "$RESULT" | jq -r '"Imported: \(.imported | length) skill(s)"'
echo "$RESULT" | jq -r '.imported[].slug' | sed 's/^/  + /'
WARNINGS=$(echo "$RESULT" | jq -r '.warnings | length')
if [ "$WARNINGS" != "0" ]; then
  echo "Warnings ($WARNINGS):"
  echo "$RESULT" | jq -r '.warnings[]' | sed 's/^/  ! /'
fi
