# Slice: Manage Skills TUI

## Purpose
- Capture settled product/design requirements for the `/manage-skills` terminal UI before implementation planning.

## Shared Understanding

### SKILL-TUI-001 — Main list stays compact; descriptions appear in detail view only
Skill descriptions should appear in the selected skill's detail view only, not in the main skill list. The main list should remain compact and scannable.

Implementation-shaping detail: the detail view should show the full skill description alongside source/path, global default, started-folder override, effective state, and enforcement mode. Missing descriptions should degrade gracefully with a clear placeholder such as `(no description)` rather than layout breakage.

Accepted tradeoff: users get less upfront description text in the main list, but the list remains easier to scan and compare.

Verification expectations:
- Main `/manage-skills` list does not render descriptions as row text.
- Selecting/opening a skill detail view shows the full description when available.
- Missing descriptions do not break layout.

### SKILL-TUI-002 — `/manage-skills` uses an accepted compact table plus detail-view layout
The accepted `/manage-skills` TUI direction is a compact main table plus per-skill detail view. The concrete mock-up below is product/design authority for later planning; future agents should preserve the same information architecture unless the user explicitly revises it.

Critical implementation requirement: this must be an interactive TUI, not a static printed report, markdown output, or plain select prompt.

Main table mock-up:

```text
╭──────────────────────────── Manage Skills ────────────────────────────╮
│ Scope: Global defaults + this folder override                         │
│ Folder: /home/lenin/work-repos/pi-claude-plugin-manager               │
│                                                                        │
│ Search: ctx_                                                           │
│                                                                        │
│ Skill              Global       This folder        Effective           │
│ ─────────────────────────────────────────────────────────────────────  │
│ ❯ ctx-index         enabled      disabled           disabled  folder    │
│   ctx-search        enabled      inherit            enabled   global    │
│   graphify          enabled      inherit            enabled   global    │
│   librarian         enabled      inherit            enabled   global    │
│                                                                        │
│ ↑↓ select • tab column • space cycle • enter details • / search • esc  │
╰────────────────────────────────────────────────────────────────────────╯
```

Detail view mock-up:

```text
╭──────────────────────────── Skill: ctx-index ──────────────────────────╮
│ Source: npm:context-mode                                                │
│ Path: ~/.pi/agent/npm/node_modules/context-mode/skills/ctx-index/SKILL.md│
│                                                                        │
│ Description                                                            │
│   Index a local file or directory into context-mode's persistent FTS5   │
│   knowledge base so future ctx_search calls can retrieve snippets.      │
│                                                                        │
│ Global default      enabled                                             │
│ This folder         disabled                                            │
│ Effective state     disabled by this folder                             │
│ Enforcement         prompt-filtered + /skill blocked                    │
│                                                                        │
│ Actions                                                                │
│   Remove folder override                                                │
│   Disable globally                                                      │
│   Enable globally                                                       │
│                                                                        │
│ enter select • esc back                                                 │
╰────────────────────────────────────────────────────────────────────────╯
```

Main table requirements:
- Columns must show skill name, global default state, started-folder override state, effective state, and winning scope/source.
- Started-folder override values must include `inherit`, `enabled`, and `disabled`.
- Effective state is read-oriented feedback showing the winning result, not an independent third policy layer.
- Winning scope/source should make it obvious whether the effective state came from `global` or `folder`.
- Where useful, show enforcement status such as `hidden` for manager-owned omitted resources or `blocked` for Pi/package-owned skills that remain visible but are filtered/blocked.

Scrolling / large-list contract:
- The compact table must be scrollable and must not render hundreds of skills into the entire viewport.
- Use a bounded visible row count based on terminal height / overlay `maxHeight`.
- Show a scrollbar or scroll indicator for long lists, including current position and/or result count.
- Search/filter must operate over the full skill list, not only visible rows.
- Forbidden behavior: expanding the overlay to display every skill when many skills are installed.

Detail view requirements:
- Detail view opens from a selected skill and shows metadata/actions that would clutter the table.
- Detail view must expose full description, source/package label, file path, global default value, started-folder override value, effective state and winning scope, enforcement mode, and actions for changing global state, changing/clearing folder override, and related state changes.

Interface contract:
- Main list rows must make effective state explainable without opening details.
- Detail view must expose full description and enforcement mode.
- Folder override values must include `inherit`, `enabled`, and `disabled`.
- Forbidden behavior: separate global/folder screens as the primary design, because the accepted direction is side-by-side comparison in one scrollable list.

Implementation-shaping note: likely use `ctx.ui.custom()` with a custom width-safe table component rather than only `SettingsList`, because each row has multiple policy columns and needs a visible scrollbar/scroll indicator. Use pi-tui width utilities (`visibleWidth`, `truncateToWidth`) and explicit keyboard handling.

Verification expectations:
- User can see global, folder, effective state, and winning scope in one table row.
- User can open details for full description and path/source metadata.
- Long skill lists are bounded to the modal viewport and expose a scrollbar/scroll indicator.
- Key handling supports navigation, toggling, search/filter, detail open, and escape/back without trapping focus.

### SKILL-TUI-003 — TUI behavior must be genuinely interactive
`/manage-skills` must provide a genuinely interactive terminal UI. It should not be implemented as a static list followed by separate commands, a markdown report, or a sequence of simple prompts.

Required interactive behaviors:
- Navigate the skill table with keyboard input.
- Search/filter skills in place.
- Toggle/cycle policy values from the table without leaving the UI.
- Open a selected skill's detail view.
- Return from detail view to the table.
- Persist changes through the UI interaction flow.
- Exit/cancel predictably with Escape/back behavior.

Interface contract:
- The command should use Pi's custom TUI surface, e.g. `ctx.ui.custom()`, for the main manager experience.
- The UI must own keyboard handling for the table/detail workflow and request rerenders after state changes.
- Forbidden behavior: implementing `/manage-skills` as only `ctx.ui.select(...)`, static `emit(...)` output, or a non-interactive command list.

Verification expectations:
- A user can manage skill states without typing follow-up subcommands for each action.
- UI state updates visibly after toggles/search/navigation.
- Escape/back never traps focus and always returns to the expected previous screen or exits.

## Source References
- `/home/lenin/.pi/pi-tui-widget-reference.md` — TUI implementation reference for `ctx.ui.custom`, overlay sizing, keyboard handling, width-safe rendering, `SelectList`, and custom component rules.
- `/home/lenin/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs/tui.md` — Pi TUI component patterns and extension bridge guidance.

## Non-Goals / Deferred Scope
- None for the accepted table + detail-view layout.

## Acceptance / Verification Expectations
- Later planning should include TUI behavior tests or a smoke path for opening the manager, navigating to details, and verifying description placement.
- The UI should be width-safe and should not emit over-wide lines.

## Questions to Resolve Before Planning
- None.
