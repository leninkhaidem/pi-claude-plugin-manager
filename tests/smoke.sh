#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
CREATED_NODE_MODULES_DIR=""
CREATED_MARIOZECHNER_LINK=""
cleanup() {
  rm -rf "$TMP"
  if [[ -n "$CREATED_MARIOZECHNER_LINK" ]]; then rm -f "$ROOT/node_modules/@mariozechner"; fi
  if [[ -n "$CREATED_NODE_MODULES_DIR" ]]; then rm -rf "$ROOT/node_modules"; fi
}
trap cleanup EXIT

AGENT="$TMP/agent"
MARKETPLACE="$TMP/marketplace"
EXTENSION="$ROOT/index.ts"

mkdir -p \
  "$MARKETPLACE/.claude-plugin" \
  "$MARKETPLACE/plugins/demo/.claude-plugin" \
  "$MARKETPLACE/plugins/demo/skills/demo-skill" \
  "$MARKETPLACE/plugins/demo/commands" \
  "$MARKETPLACE/plugins/browse-demo/.claude-plugin" \
  "$MARKETPLACE/plugins/browse-demo/skills/browse-demo-skill" \
  "$MARKETPLACE/plugins/browse-demo/commands"

python3 - "$MARKETPLACE/.claude-plugin/marketplace.json" <<'PY'
import json, sys
plugins = [
    {
        "name": "demo",
        "version": "1.0.0",
        "source": "plugins/demo",
        "description": "Demo plugin",
        "category": "fixture",
        "keywords": ["demo", "smoke"],
    },
    {
        "name": "browse-demo",
        "version": "1.0.0",
        "source": "plugins/browse-demo",
        "description": "Browse flow demo plugin",
        "category": "fixture",
        "keywords": ["browse", "smoke"],
    },
    {
        "name": "space plugin",
        "version": "1.0.0",
        "source": "plugins/space-plugin",
        "description": "Plugin with a space in its name",
        "category": "fixture",
        "keywords": ["space"],
    },
    {
        "name": "--flaggy",
        "version": "1.0.0",
        "source": "plugins/flaggy",
        "description": "Non-installable flag-like plugin name",
        "category": "fixture",
        "keywords": ["flag"],
    },
]
for i in range(1, 56):
    plugins.append({
        "name": f"dummy-{i:02d}",
        "version": "1.0.0",
        "source": f"plugins/dummy-{i:02d}",
        "description": f"Dummy plugin {i:02d}",
        "category": "dummy",
        "keywords": ["dummy"],
    })
with open(sys.argv[1], "w", encoding="utf8") as f:
    json.dump({"name": "fixture-marketplace", "description": "Fixture marketplace", "plugins": plugins}, f, indent=2)
    f.write("\n")
PY

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

cat > "$MARKETPLACE/plugins/browse-demo/.claude-plugin/plugin.json" <<'JSON'
{
  "name": "browse-demo",
  "version": "1.0.0",
  "description": "Browse demo manifest",
  "skills": "skills",
  "commands": "commands"
}
JSON

cat > "$MARKETPLACE/plugins/browse-demo/skills/browse-demo-skill/SKILL.md" <<'EOF_SKILL'
---
name: browse-demo-skill
description: Browse demo skill
---
Browse demo skill body.
EOF_SKILL

cat > "$MARKETPLACE/plugins/browse-demo/commands/browse-demo.md" <<'EOF_PROMPT'
# Browse demo command
EOF_PROMPT

run_pi() {
  PI_OFFLINE=1 PI_CODING_AGENT_DIR="$AGENT" \
    pi --no-extensions --no-skills --no-prompt-templates -e "$EXTENSION" -p "$1" 2>&1
}

run_pi "/plugin config set claudeReadOnlyImports false" >/dev/null
run_pi "/plugin help" | grep -q "/plugin browse \[marketplace\]"
run_pi "/plugin marketplace add $MARKETPLACE" | grep -q "Added marketplace fixture-marketplace"
run_pi "/plugin marketplace list" | grep -q "fixture-marketplace"
run_pi "/plugin browse fixture-marketplace" | grep -q "/plugin install demo@fixture-marketplace"
run_pi "/plugin marketplace browse fixture-marketplace" | grep -q "browse-demo@fixture-marketplace"
run_pi "/plugin install demo@fixture-marketplace" | grep -q "Installed demo@fixture-marketplace"
run_pi "/plugin list" | grep -q "✓ demo@fixture-marketplace"
run_pi "/plugin disable demo@fixture-marketplace" | grep -q "Disabled demo@fixture-marketplace"
run_pi "/plugin list" | grep -q "○ demo@fixture-marketplace"
run_pi "/plugin enable demo@fixture-marketplace" | grep -q "Enabled demo@fixture-marketplace"
run_pi "/plugin update demo@fixture-marketplace" | grep -q "after refreshing 1 marketplace"
run_pi "/plugin update" | grep -q "Updated 1 marketplace"

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

NPM_GLOBAL_ROOT="$(npm root -g)"
MARIOZECHNER_ROOT="$NPM_GLOBAL_ROOT/@mariozechner"
PI_PACKAGE_ROOT="$MARIOZECHNER_ROOT/pi-coding-agent"
JITI_REGISTER="$PI_PACKAGE_ROOT/node_modules/@mariozechner/jiti/lib/jiti-register.mjs"
if [[ ! -d "$MARIOZECHNER_ROOT" || ! -f "$JITI_REGISTER" ]]; then
  echo "Could not resolve Pi's global @mariozechner packages from npm root: $NPM_GLOBAL_ROOT" >&2
  exit 1
fi
if [[ ! -e "$ROOT/node_modules" ]]; then
  mkdir "$ROOT/node_modules"
  CREATED_NODE_MODULES_DIR=1
fi
if [[ ! -e "$ROOT/node_modules/@mariozechner" ]]; then
  ln -s "$MARIOZECHNER_ROOT" "$ROOT/node_modules/@mariozechner"
  CREATED_MARIOZECHNER_LINK=1
fi
JITI_FS_CACHE="$TMP/jiti-cache" PI_CODING_AGENT_DIR="$AGENT" node --import "$JITI_REGISTER" "$ROOT/tests/mock-ui-browse.mjs" | grep -q "mock ui browse ok"
JITI_FS_CACHE="$TMP/jiti-cache" PI_CODING_AGENT_DIR="$AGENT" node --import "$JITI_REGISTER" "$ROOT/tests/autocomplete-smoke.mjs" | grep -q "autocomplete smoke ok"

run_pi "/plugin uninstall demo@fixture-marketplace" | grep -q "demo@fixture-marketplace (user)"
run_pi "/plugin uninstall browse-demo@fixture-marketplace" | grep -q "browse-demo@fixture-marketplace (user)"
run_pi "/plugin list" | grep -q "No plugins installed"

echo "smoke ok"
