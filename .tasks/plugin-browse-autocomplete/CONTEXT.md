# Plugin Browse and Autocomplete

## Overview
Add first-time-user discovery for Claude plugin marketplaces in Pi by pairing a browsable marketplace/plugin flow with argument autocomplete for `/plugin`.

## Design Decisions
- Add browse now, not later: user explicitly wants browsing and autocomplete together.
- Preserve `/plugin` as the only top-level command; expose browse as `/plugin browse` and `/plugin marketplace browse` aliases.
- Support TUI and non-TUI: TUI gets selection flows, print mode gets readable markdown output.
- Autocomplete uses current manager state and marketplace manifests only; no network fetches during completion.
- Autocomplete should live behind an exported helper so Pi can register it and smoke tests can exercise it without TUI internals.
- TUI browse should reuse existing `ctx.ui.select`, `ctx.ui.input`, and `ctx.ui.confirm` primitives rather than introducing custom UI widgets.
- TUI filtering is an optional one-shot search input followed by a filtered select; no live-search widget is required.
- Canonical plugin specs use exact manifest names and existing `<plugin>@<marketplace>` semantics; specs are usable only when parsing them returns the original plugin and marketplace names exactly.
- Ambiguous/non-round-tripping specs are shown as non-installable in browse output and excluded from install actions and completions.
- Marketplace manifest read failures use one shared policy: browse output reports the affected marketplace and continues; autocomplete omits that marketplace.
- Autocomplete uses Pi's `getArgumentCompletions(argumentPrefix)` string, which Pi replaces as a whole when a completion is applied.
- Autocomplete item values must therefore be full `/plugin` argument replacements, preserving prior tokens and completing the current token.
- Browse select options are capped by `PLUGIN_BROWSE_SELECT_LIMIT = 50`; larger result sets show counts and ask users to narrow with a filter.
- Autocomplete results are prefix-filtered, deterministically sorted, and capped by `PLUGIN_AUTOCOMPLETE_LIMIT = 50`.
- Autocomplete marketplace data uses an in-memory cache keyed by marketplace path/name/update metadata and is invalidated by marketplace state changes.
- Config completions should use a shared config-key metadata export instead of duplicating hardcoded key lists.

## Architecture
- Entry point: `src/index.ts` registers `/plugin` and its `getArgumentCompletions` hook.
- Command routing: `src/commands.ts` handles top-level and marketplace subcommands.
- Marketplace data: `src/marketplace.ts` already loads marketplace records and plugin entries.
- Formatting/UI helpers: `src/format.ts` owns user-facing command output.
- Autocomplete helper: new `src/autocomplete.ts` keeps completion logic testable outside the TUI.
- Tests: `tests/smoke.sh` already creates a fixture marketplace and exercises lifecycle commands.

## Constraints
- Do not require Claude Code.
- Keep non-interactive `pi -p` behavior useful.
- Avoid network calls during autocomplete; use already-added marketplaces and local state only.
- Keep plugin specs unambiguous as `<plugin>@<marketplace>` when needed.
- Maintain existing commands and aliases.
- Empty browse states must guide users toward adding a marketplace first.

## Out of Scope
- Remote marketplace search before a marketplace is added.
- Executing unsupported Claude plugin features such as hooks, MCP, LSP, monitors, agents, or settings.
