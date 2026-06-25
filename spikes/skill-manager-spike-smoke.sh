#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

AGENT="$TMP/agent"
PROJECT="$TMP/project"
EXTENSION="$ROOT/spikes/skill-manager-spike.ts"
mkdir -p "$PROJECT"

run_pi() {
  local prompt="$1"
  (
    cd "$PROJECT"
    PI_OFFLINE=1 PI_CODING_AGENT_DIR="$AGENT" \
      pi --no-extensions --no-prompt-templates -e "$EXTENSION" -p "$prompt" 2>&1
  )
}

run_pi "/skill-spike reset" | grep -q "Reset spike state"

INITIAL_STATUS="$(run_pi "/skill-spike status")"
echo "$INITIAL_STATUS" | grep -q "resource_discover enabled for fixture: yes"
echo "$INITIAL_STATUS" | grep -q "slash command present: yes"
echo "$INITIAL_STATUS" | grep -q "base prompt options skill present (pre-filter): yes"

run_pi "/skill-spike disable" | grep -q "Disabled skill policy for spike-managed"

DISABLED_STATUS="$(run_pi "/skill-spike status")"
echo "$DISABLED_STATUS" | grep -q "effective disabled: yes"
echo "$DISABLED_STATUS" | grep -q "resource_discover enabled for fixture: no"
echo "$DISABLED_STATUS" | grep -q "slash command present: yes\|slash command present: no"
echo "$DISABLED_STATUS" | grep -q "base prompt options skill present (pre-filter): no"

BLOCKED_OUTPUT="$(run_pi "/skill:spike-managed")"
echo "$BLOCKED_OUTPUT" | grep -q "Blocked disabled skill invocation: /skill:spike-managed"

run_pi "/skill-spike reset" | grep -q "Reset spike state"
run_pi "/skill-spike disable-source" | grep -q "Disabled source policy"

SOURCE_DISABLED_STATUS="$(run_pi "/skill-spike status")"
echo "$SOURCE_DISABLED_STATUS" | grep -q "disabled by source path: yes"
echo "$SOURCE_DISABLED_STATUS" | grep -q "resource_discover enabled for fixture: no"

# Optional real-world assertion: if ctx-index exists in the current developer environment,
# disabling it should block invocation even though Pi may still list/register it.
if run_pi "/skill-spike status ctx-index" | grep -q "slash command present: yes"; then
  run_pi "/skill-spike disable ctx-index" | grep -q "Disabled skill policy for ctx-index"
  CTX_STATUS="$(run_pi "/skill-spike status ctx-index")"
  echo "$CTX_STATUS" | grep -q "resource_discover can hide this skill: no"
  echo "$CTX_STATUS" | grep -q "effective disabled: yes"
  CTX_BLOCKED_OUTPUT="$(run_pi "/skill:ctx-index")"
  echo "$CTX_BLOCKED_OUTPUT" | grep -q "Blocked disabled skill invocation: /skill:ctx-index"
fi

echo "skill manager spike smoke ok"
