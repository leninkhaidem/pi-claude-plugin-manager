#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

AGENT="$TMP/agent"
MARKETPLACE="$TMP/marketplace"
EXTENSION="$ROOT/index.ts"

mkdir -p \
  "$MARKETPLACE/.claude-plugin" \
  "$MARKETPLACE/plugins/demo/.claude-plugin" \
  "$MARKETPLACE/plugins/demo/skills/demo-skill" \
  "$MARKETPLACE/plugins/demo/commands"

cat > "$MARKETPLACE/.claude-plugin/marketplace.json" <<'JSON'
{
  "name": "fixture-marketplace",
  "description": "Fixture marketplace",
  "plugins": [
    {
      "name": "demo",
      "version": "1.0.0",
      "source": "plugins/demo",
      "description": "Demo plugin"
    }
  ]
}
JSON

cat > "$MARKETPLACE/plugins/demo/.claude-plugin/plugin.json" <<'JSON'
{
  "name": "demo",
  "version": "1.0.0",
  "description": "Demo manifest",
  "skills": "skills",
  "commands": "commands"
}
JSON

cat > "$MARKETPLACE/plugins/demo/skills/demo-skill/SKILL.md" <<'EOF_SKILL'
---
name: demo-skill
description: Demo skill
---
Demo skill body.
EOF_SKILL

cat > "$MARKETPLACE/plugins/demo/commands/demo.md" <<'EOF_PROMPT'
# Demo command
EOF_PROMPT

run_pi() {
  PI_OFFLINE=1 PI_CODING_AGENT_DIR="$AGENT" \
    pi --no-extensions --no-skills --no-prompt-templates -e "$EXTENSION" -p "$1" 2>&1
}

run_pi "/plugin config set claudeReadOnlyImports false" >/dev/null
run_pi "/plugin marketplace add $MARKETPLACE" | grep -q "Added marketplace fixture-marketplace"
run_pi "/plugin marketplace list" | grep -q "fixture-marketplace"
run_pi "/plugin install demo@fixture-marketplace" | grep -q "Installed demo@fixture-marketplace"
run_pi "/plugin list" | grep -q "✓ demo@fixture-marketplace"
run_pi "/plugin disable demo@fixture-marketplace" | grep -q "Disabled demo@fixture-marketplace"
run_pi "/plugin list" | grep -q "○ demo@fixture-marketplace"
run_pi "/plugin enable demo@fixture-marketplace" | grep -q "Enabled demo@fixture-marketplace"

node - "$AGENT" <<'NODE'
const fs = require('fs');
const path = require('path');
const agent = process.argv[2];
const state = JSON.parse(fs.readFileSync(path.join(agent, 'claude-plugin-manager/state.json'), 'utf8'));
const entry = state.plugins['demo@fixture-marketplace']?.[0];
if (!entry) throw new Error('missing installed entry');
if (!fs.existsSync(path.join(entry.installPath, 'skills/demo-skill/SKILL.md'))) throw new Error('missing skill');
if (!fs.existsSync(path.join(entry.installPath, 'commands/demo.md'))) throw new Error('missing command');
if (state.enabledPlugins['demo@fixture-marketplace'] !== true) throw new Error('expected plugin enabled');
NODE

run_pi "/plugin uninstall demo@fixture-marketplace" | grep -q "demo@fixture-marketplace (user)"
run_pi "/plugin list" | grep -q "No plugins installed"

echo "smoke ok"
