# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned

- Claude plugin hooks are not executed yet.
- Claude plugin MCP servers, LSP servers, monitors, agents, and plugin settings are not imported yet.

## [0.3.0] - 2026-04-27

### Added

- **Skill manager** with `/skills` command for managing skills from all sources.
  - `/skills list` shows all skills (Pi-native, plugin, custom source) with enabled/disabled status.
  - `/skills toggle [skill-name]` toggles individual skills on/off via interactive checkbox UI or by name.
  - `/skills sources` shows all skill discovery sources (Pi paths, packages, plugin marketplaces, custom directories).
  - `/skills sources toggle` enables/disables entire source directories via checkbox UI.
  - `/skills sources add <path>` and `/skills sources remove` manage custom skill source directories.
  - Disabled skills are stripped from the system prompt via `before_agent_start` hook.
- **Interactive plugin config editor** when running `/plugin config` in TUI.
  - Select a config key to edit (with current value and description shown).
  - Boolean keys present true/false select; path keys present text input; enum keys present valid options.
  - Reset individual keys or all config with confirmation.
  - Config keys reference via help option.
- **Interactive checkbox toggle UI** for batch operations.
  - Space bar to toggle items, enter to apply, escape to cancel.
  - Shows `*` marker on changed items and pending change count.
  - Used in `/skills toggle`, `/skills sources toggle`, and `/plugin` → "Toggle plugins on/off".
- **Plugin toggle** via `/plugin` interactive menu → "Toggle plugins on/off" with checkbox UI.
- **Auto-update check on startup** for git-based marketplace plugins.
  - Lightweight probe via `git ls-remote` (no full fetch, ~1-2 seconds per marketplace).
  - Compares remote marketplace.json plugin versions against installed versions.
  - Results cached in `state.json` with configurable TTL (default 24 hours).
  - Runs in background on startup — does not block session start.
  - `notify` mode (default): non-blocking notification with update count.
  - `prompt` mode: interactive select with "Update all", "Select which", "Skip", "Disable" options.
  - `off` mode: no startup checks.
- **`/plugin check-updates`** command to force-check for updates (ignores TTL).
  - Shows available updates with old → new version comparison.
  - In TUI: interactive checkbox to select which plugins to update.
- New config keys: `updateCheckEnabled`, `updateCheckTTL`, `updateCheckOnStartup`, `skillSources`.
- New state fields: `disabledSkills`, `disabledSkillSources`, `lastUpdateCheckAt`, `lastUpdateCheckResults`.
- Tab autocomplete for `/skills` subcommands and `/plugin check-updates`.

### Changed

- Plugin and skill toggle operations no longer auto-prompt for reload. A non-blocking notification reminds the user to run `/reload` when ready, allowing batch changes before reloading.
- `/plugin config` now shows `skillSources` and update check config keys in the config output.
- Config `set` command properly handles boolean, numeric, and enum config key types.

## [0.2.0] - 2026-04-24

### Added

- Marketplace browsing with `/plugin browse [marketplace]` and `/plugin marketplace browse [marketplace]`.
- Interactive browse flow for selecting marketplaces, filtering large plugin lists, choosing plugins, and installing to user or project scope.
- `/plugin` argument autocomplete for subcommands, marketplace names, plugin specs, config keys, boolean values, and valid flags.
- Non-interactive browse output with install commands and marketplace diagnostics.

### Changed

- `/plugin update` now refreshes marketplaces before updating installed plugins, including targeted plugin updates.
- `/plugin help` and README now document browsing, autocomplete, and the marketplace-refresh behavior of plugin updates.

### Fixed

- Autocomplete safely quotes plugin specs that contain spaces and suppresses unsafe non-round-tripping specs.
- Smoke tests no longer depend on developer-local absolute Pi install paths or remove an existing `node_modules` tree.

## [0.1.0] - 2026-04-24

### Added

- A standalone Pi `/plugin` command for managing Claude Code plugin marketplaces without requiring Claude Code.
- Marketplace lifecycle commands for adding, listing, updating, and removing marketplace sources.
- Plugin lifecycle commands for installing, updating, enabling, disabling, uninstalling, listing, and reloading plugin resources.
- Pi-managed plugin state, marketplace checkouts, and install cache under `~/.pi/agent/claude-plugin-manager/`.
- Claude plugin `skills/` discovery as Pi skills.
- Claude plugin `commands/*.md` discovery as Pi prompt templates.
- Optional read-only discovery of existing Claude Code plugin installs from configurable Claude paths.
- User-scope and project-scope plugin installs.
- GitHub.com shorthand, public GitHub Enterprise shorthand, full Git URLs, and local marketplace paths.
- A smoke test that exercises the core marketplace and plugin lifecycle with an isolated Pi agent directory.

### Security

- Marketplace and plugin resource paths are resolved inside their declared roots before they are loaded.
- Existing Claude Code plugin imports are constrained to the configured Claude plugins directory and remain read only.
- Plugin cache cleanup avoids deleting shared cache paths that are still referenced by another installed entry.

### Documentation

- Installation guidance for pinned releases, latest `main`, project-local installs, and local development.
- Command reference, configuration reference, marketplace source examples, current coverage, and known limitations.

[Unreleased]: https://github.com/leninkhaidem/pi-claude-plugin-manager/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/leninkhaidem/pi-claude-plugin-manager/releases/tag/v0.3.0
[0.2.0]: https://github.com/leninkhaidem/pi-claude-plugin-manager/releases/tag/v0.2.0
[0.1.0]: https://github.com/leninkhaidem/pi-claude-plugin-manager/releases/tag/v0.1.0
