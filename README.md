# Claude Plugin Manager for Pi

Standalone Pi extension that adds a Claude-Code-like `/plugin` command without requiring Claude Code to be installed.

It stores its own state and config under:

```text
~/.pi/agent/claude-plugin-manager/state.json
~/.pi/agent/claude-plugin-manager/config.json
```

This repository is the source of truth. The live user extension path is expected to point here:

```text
~/.pi/agent/extensions/claude-plugin-manager -> ~/work-repos/pi-claude-plugin-manager
```

## What it does

- Adds Claude plugin marketplaces from GitHub, Git URLs, or local paths.
- Installs plugins from those marketplaces into a Pi-owned cache.
- Enables, disables, updates, and uninstalls installed plugins.
- Exposes installed Claude plugin `skills/` as Pi skills.
- Exposes installed Claude plugin `commands/*.md` as Pi prompt templates.
- Also reads enabled Claude Code installs from `~/.claude/plugins/installed_plugins.json` in read-only mode, so existing Claude Code plugins are available in Pi without importing or copying them.

## What it does not do yet

- Does not execute Claude plugin hooks.
- Does not start Claude plugin MCP servers.
- Does not start LSP servers or monitors.
- Does not import Claude agents yet.
- Does not require `~/.claude` or Claude Code's installed plugin state for Pi-managed installs.
- If `~/.claude/plugins/installed_plugins.json` exists, it is used read-only as an additional import source.

## Usage

```text
/plugin marketplace add leninkhaidem/super-developer
/plugin install super-developer@super-developer-marketplace
/plugin reload
```

Then use the loaded Pi skills, for example:

```text
/skill:implementation-plan
/skill:implement
/skill:review-code
```

## Commands

```text
/plugin help
/plugin list
/plugin config [show]
/plugin config set <key> <value>
/plugin config reset [key]
/plugin marketplace list
/plugin marketplace add <github-owner/repo | git-url | local-path[#ref]>
/plugin marketplace update [marketplace]
/plugin marketplace remove <marketplace>
/plugin install <plugin[@marketplace]> [--project]
/plugin update [plugin[@marketplace]]
/plugin enable <plugin[@marketplace]>
/plugin disable <plugin[@marketplace]>
/plugin uninstall <plugin[@marketplace]> [--project|--all]
/plugin reload
```

## Configuration

Claude Code read-only imports are configurable in:

```text
~/.pi/agent/claude-plugin-manager/config.json
```

Default config:

```json
{
  "claudeReadOnlyImports": true,
  "claudeDir": "~/.claude"
}
```

Supported keys:

```text
claudeReadOnlyImports
claudeDir
claudePluginsDir
claudeSettingsPath
claudeInstalledPluginsPath
```

Examples:

```text
/plugin config
/plugin config set claudeReadOnlyImports false
/plugin config set claudeDir ~/.claude
/plugin config set claudePluginsDir /custom/claude/plugins
/plugin config reset claudePluginsDir
```

## GitHub Enterprise

Public GitHub Enterprise repositories are supported. Use a full Git URL or host shorthand:

```text
/plugin marketplace add https://github.enterprise.example.com/org/plugins.git
/plugin marketplace add github.enterprise.example.com/org/plugins
```

The two-part shorthand `owner/repo` still means public GitHub.com.

## Development

The extension entrypoint is the root `index.ts`, which delegates to modules under `src/`.

Run the local smoke test with an isolated Pi agent dir and fixture marketplace:

```bash
npm run smoke
```

## Notes

If the old `npm:pi-claude-plugins` import-only adapter is still installed, it may also expose plugins from `~/.claude/plugins`. This manager now includes that read-only import behavior itself. If both adapters load the same plugin, Pi may show skill collision warnings. Remove the old adapter when you are ready to rely only on this manager:

```bash
pi remove npm:pi-claude-plugins
```
