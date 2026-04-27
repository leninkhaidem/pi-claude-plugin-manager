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
  <a href="#browsing-and-autocomplete">Browse</a> ·
  <a href="#skill-manager">Skills</a> ·
  <a href="#commands">Commands</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

</div>

---

`pi-claude-plugin-manager` adds standalone `/plugin` and `/skills` commands to Pi. It adapts Claude Code plugin marketplaces into Pi so you can add marketplaces, install plugins, enable or disable them, update them, uninstall them, and load their skills and slash-command markdown as Pi resources.

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

### Recommended: install the latest release

```bash
pi install git:github.com/leninkhaidem/pi-claude-plugin-manager@v0.3.0
```

Restart Pi or run:

```text
/reload
```

Then verify the commands are available:

```text
/plugin help
/skills help
```

### Install latest from `main`

Use this if you want the newest work instead of the pinned release:

```bash
pi install git:github.com/leninkhaidem/pi-claude-plugin-manager
```

### Install for one project only

```bash
pi install git:github.com/leninkhaidem/pi-claude-plugin-manager@v0.3.0 -l
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

### Plugin commands

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
/plugin marketplace browse [marketplace]
/plugin browse [marketplace]
/plugin install <plugin[@marketplace]> [--project]
/plugin update [plugin[@marketplace]]      # refreshes marketplaces before updating plugins
/plugin enable <plugin[@marketplace]>
/plugin disable <plugin[@marketplace]>
/plugin uninstall <plugin[@marketplace]> [--project|--all]
/plugin check-updates
/plugin reload
```

### Skill commands

```text
/skills help
/skills list
/skills toggle [skill-name]
/skills sources
/skills sources toggle [source-path]
/skills sources add <path>
/skills sources remove [path]
```

## Browsing and autocomplete

After adding a marketplace, browse its plugins without knowing plugin names up front:

```text
/plugin browse
/plugin browse <marketplace>
/plugin marketplace browse <marketplace>
```

In the interactive Pi TUI, browse lets you choose a marketplace, narrow large plugin lists with a filter, pick a plugin, and install it for user or project scope. In non-interactive mode, browse prints a readable marketplace/plugin list with install commands.

The `/plugin` and `/skills` commands provide argument autocomplete in the TUI. Type part of a command or identifier and press `Tab`:

```text
/plugin <Tab>
/plugin marketplace br<Tab>
/plugin install <Tab>
/plugin config set <Tab>
/skills <Tab>
/skills sources <Tab>
```

## Skill manager

The `/skills` command manages skills from **all** sources — Pi-native, plugins, and custom directories.

### Listing skills

```text
/skills list
```

Shows all skills grouped by source (Pi discovery paths, Pi packages, plugin marketplaces, custom sources) with enabled/disabled status.

### Toggling skills

Toggle individual skills or entire source directories. In the TUI, use the checkbox UI (space to toggle, enter to apply, escape to cancel):

```text
/skills toggle                   # Interactive checkbox in TUI
/skills toggle my-skill          # Toggle by name
/skills sources toggle           # Toggle entire sources in TUI
```

Disabled skills are stripped from the system prompt via the `before_agent_start` hook.

### Managing skill sources

View all skill discovery sources, including Pi's built-in paths:

```text
/skills sources                  # Interactive menu in TUI, or list sources
/skills sources add <path>       # Add a custom source directory
/skills sources remove [path]    # Remove a custom source
```

Sources include Pi's built-in paths (`~/.pi/agent/skills/`, `~/.agents/skills/`, `.pi/skills/`, `.agents/skills/`), installed Pi packages, Claude Code plugin marketplaces, and custom directories you add.

## Auto-update checks

On startup, the plugin manager checks for available updates from git-based marketplaces using a lightweight `git ls-remote` probe (no full fetch). Results are cached with a configurable TTL (default: 24 hours).

### Behavior modes

| Mode | Description |
| --- | --- |
| `notify` (default) | Non-blocking notification with update count |
| `prompt` | Interactive select: update all, select which, skip, or disable |
| `off` | No startup checks |

Configure with:

```text
/plugin config set updateCheckOnStartup notify
/plugin config set updateCheckOnStartup prompt
/plugin config set updateCheckOnStartup off
/plugin config set updateCheckTTL 3600000          # 1 hour
/plugin config set updateCheckEnabled false         # disable entirely
```

### Manual update check

Force-check for updates (ignores TTL):

```text
/plugin check-updates
```

In the TUI this shows an interactive checkbox to select which plugins to update.

## Updating

Use `/plugin update` to refresh marketplace metadata first, then update installed plugins from the refreshed marketplace entries:

```text
/plugin update
/plugin update <plugin[@marketplace]>
```

Targeted plugin updates refresh that plugin's marketplace before reinstalling the plugin.

## Configuration

Plugin manager config lives in:

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

| Key | Purpose | Default |
| --- | --- | --- |
| `claudeReadOnlyImports` | Enable/disable read-only imports from Claude Code. | `true` |
| `claudeDir` | Base Claude Code directory. | `~/.claude` |
| `claudePluginsDir` | Override for Claude Code plugin directory. | — |
| `claudeSettingsPath` | Override for Claude Code `settings.json`. | — |
| `claudeInstalledPluginsPath` | Override for `installed_plugins.json`. | — |
| `skillSources` | Additional directories to discover skills from. | `[]` |
| `updateCheckEnabled` | Enable/disable startup update checks. | `true` |
| `updateCheckTTL` | Minimum ms between update checks. | `86400000` (24h) |
| `updateCheckOnStartup` | Startup behavior: `notify`, `prompt`, or `off`. | `notify` |

Examples:

```text
/plugin config
/plugin config set claudeReadOnlyImports false
/plugin config set updateCheckOnStartup prompt
/plugin config set updateCheckTTL 3600000
/plugin config reset claudePluginsDir
```

In the TUI, `/plugin config` shows an interactive editor with key selection, descriptions, and appropriate input types.

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
- Marketplace add, update, remove, list, and browse.
- Claude plugin skills as Pi skills.
- Claude plugin command markdown as Pi prompt templates.
- Skill management across all sources (Pi-native, plugin, custom).
- Skill and source toggling with interactive checkbox UI.
- Auto-update checks with configurable TTL and notification modes.
- Interactive config editor in TUI.
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
