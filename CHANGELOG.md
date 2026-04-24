# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned

- Claude plugin hooks are not executed yet.
- Claude plugin MCP servers, LSP servers, monitors, agents, and plugin settings are not imported yet.

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

[Unreleased]: https://github.com/leninkhaidem/pi-claude-plugin-manager/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/leninkhaidem/pi-claude-plugin-manager/releases/tag/v0.2.0
[0.1.0]: https://github.com/leninkhaidem/pi-claude-plugin-manager/releases/tag/v0.1.0
