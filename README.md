<div align="center">

# Claude Plugin Manager for Pi

**Use Claude Code plugin marketplaces directly inside Pi — no Claude Code install required.**

<p>
  <a href="https://github.com/leninkhaidem/pi-claude-plugin-manager/releases"><img alt="GitHub Release" src="https://img.shields.io/github/v/release/leninkhaidem/pi-claude-plugin-manager?sort=semver&style=for-the-badge&color=7c3aed"></a>
  <img alt="Pi Extension" src="https://img.shields.io/badge/Pi-extension-111827?style=for-the-badge&labelColor=7c3aed">
  <img alt="Claude Code Marketplaces" src="https://img.shields.io/badge/Claude%20Code-marketplaces-111827?style=for-the-badge&labelColor=f97316">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-111827?style=for-the-badge&labelColor=3178c6">
</p>

<p>
  <a href="#installation">Installation</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#commands">Commands</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

</div>

---

`pi-claude-plugin-manager` adds a standalone `/plugin` command to Pi. It adapts Claude Code plugin marketplaces into Pi so you can add marketplaces, install plugins, enable or disable them, update them, uninstall them, and load their skills and slash-command markdown as Pi resources.

It also has an optional read-only bridge for existing Claude Code installs, so plugins already installed under `~/.claude/plugins` can appear in Pi without copying or mutating Claude Code state.

## Why this exists

Claude Code plugins already have a useful marketplace and plugin layout. Pi has its own package system and resource loader. This extension sits between them:

| Claude plugin component | Pi behavior |
| --- | --- |
| `skills/**/SKILL.md` | Loaded as Pi skills |
| `commands/*.md` | Loaded as Pi prompt templates |
| Marketplace `plugins[]` | Installable with `/plugin install` |
| Claude Code installed plugins | Optional read-only import |
| Hooks, MCP, LSP, monitors, agents | Not executed yet |

## Installation

> [!IMPORTANT]
> Pi packages run extension code with local system access. Review third-party packages before installing them.

### Recommended: install the first release

```bash
pi install git:github.com/leninkhaidem/pi-claude-plugin-manager@v0.1.0
```

Restart Pi or run:

```text
/reload
```

Then verify the command is available:

```text
/plugin help
```

### Install latest from `main`

Use this if you want the newest work instead of the pinned release:

```bash
pi install git:github.com/leninkhaidem/pi-claude-plugin-manager
```

### Install for one project only

```bash
pi install git:github.com/leninkhaidem/pi-claude-plugin-manager@v0.1.0 -l
```

Project-local installs write to `.pi/settings.json`, which can be shared with a repository.

### Local development install

```bash
git clone https://github.com/leninkhaidem/pi-claude-plugin-manager.git
cd pi-claude-plugin-manager
npm run smoke
pi install "$PWD"
```

## Quick start

Install a Claude plugin marketplace, then install a plugin from it:

```text
/plugin marketplace add leninkhaidem/super-developer
/plugin install super-developer@super-developer-marketplace
/plugin reload
```

Use the loaded Pi skills as usual:

```text
/skill:implementation-plan
/skill:implement
/skill:review-code
```

## Storage model

Pi-managed state lives in Pi's agent directory:

```text
~/.pi/agent/claude-plugin-manager/state.json
~/.pi/agent/claude-plugin-manager/config.json
~/.pi/agent/claude-plugin-manager/cache/
~/.pi/agent/claude-plugin-manager/marketplaces/
```

Existing Claude Code installs are read only by default from:

```text
~/.claude/plugins/installed_plugins.json
~/.claude/settings.json
~/.claude/plugins/cache/
```

Those paths are configurable; see [Configuration](#configuration).

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

Claude Code read-only imports are configured in:

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

| Key | Purpose |
| --- | --- |
| `claudeReadOnlyImports` | Enables or disables read-only imports from Claude Code installs. |
| `claudeDir` | Base Claude Code directory. Defaults to `~/.claude`. |
| `claudePluginsDir` | Override for Claude Code's plugin directory. |
| `claudeSettingsPath` | Override for Claude Code `settings.json`. |
| `claudeInstalledPluginsPath` | Override for `installed_plugins.json`. |

Examples:

```text
/plugin config
/plugin config set claudeReadOnlyImports false
/plugin config set claudeDir ~/.claude
/plugin config set claudePluginsDir /custom/claude/plugins
/plugin config reset claudePluginsDir
```

## Marketplace sources

GitHub.com shorthand:

```text
/plugin marketplace add leninkhaidem/super-developer
```

Public GitHub Enterprise repositories:

```text
/plugin marketplace add https://github.enterprise.example.com/org/plugins.git
/plugin marketplace add github.enterprise.example.com/org/plugins
```

Local marketplace while developing:

```text
/plugin marketplace add /path/to/marketplace
/plugin marketplace add /path/to/marketplace#branch-or-ref
```

## Current coverage

### Supported

- Standalone Pi-managed marketplaces.
- User-scope and project-scope plugin installs.
- Plugin enable, disable, update, and uninstall.
- Marketplace add, update, remove, and list.
- Claude plugin skills as Pi skills.
- Claude plugin command markdown as Pi prompt templates.
- Optional read-only import from Claude Code's existing install state.
- Public GitHub, GitHub Enterprise, full Git URLs, and local marketplace paths.

### Not supported yet

- Executing Claude plugin hooks.
- Starting Claude plugin MCP servers.
- Starting LSP servers or monitors.
- Importing Claude plugin agents.
- Applying Claude plugin settings.

## Development

The extension entrypoint is `index.ts`; implementation lives under `src/`.

```bash
npm run smoke
```

The smoke test creates an isolated Pi agent directory and a fixture marketplace, then exercises marketplace add, install, list, disable, enable, and uninstall.

For local dogfooding, this repository can be used as the live Pi extension source:

```text
~/.pi/agent/extensions/claude-plugin-manager -> ~/work-repos/pi-claude-plugin-manager
```

## Removing the old adapter

If the old `npm:pi-claude-plugins` import-only adapter is still installed, it may also expose plugins from `~/.claude/plugins`. This manager includes that read-only import behavior, so keeping both may produce duplicate resources or collision warnings.

```bash
pi remove npm:pi-claude-plugins
```
