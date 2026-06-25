# Work Package: WP3 — Interactive `/manage-skills` TUI and documentation

## Scope
Build the final interactive `/manage-skills` Pi custom TUI and user-facing documentation. Own the bounded searchable per-skill table, detail view, keyboard handling, immediate-save cycling/toggling, source-related detail actions, width-safe rendering, graceful missing-description behavior, and README/smoke updates for the delivered manager. The externally observable surfaces are the `/manage-skills` TUI, non-TUI command text as finalized here if adjusted, notifications/errors, autocomplete/help text, and README examples; they must use audience/domain language and avoid planning/work-package/staging terminology.

## Assigned Slices
### `.planning/skill-management-scope/slices/enforcement-and-scope.md`
Must satisfy:
- `SKILL-MGMT-005` — table/detail views show global default, started-folder override, effective state, and winning scope with started-folder override winning.
- `SKILL-MGMT-007` — per-skill rows disambiguate duplicate names by source/path, and detail/actions preserve source-level policy support without undermining the per-skill primary table.
- `SKILL-MGMT-008` — UI toggles/cycles save immediately; escape/back exits or returns without rollback; final non-TUI command behavior remains compact and clear.

Context only:
- `SKILL-MGMT-001` — UI must explain disabled skills as context-filtered/blocked according to enforcement mode.
- `SKILL-MGMT-002` — UI must distinguish manager-owned hidden resources where applicable.
- `SKILL-MGMT-003` — UI must distinguish external skills that are blocked/filtered but may remain visible in Pi-owned registries.
- `SKILL-MGMT-004` — the final user surface is `/manage-skills`, not `/skills`.
- `SKILL-MGMT-006` — UI saves through manager-owned policy state from WP1.

### `.planning/skill-management-scope/slices/manage-skills-tui.md`
Must satisfy:
- `SKILL-TUI-001` — main list stays compact without descriptions; detail view shows full descriptions and handles missing descriptions gracefully.
- `SKILL-TUI-002` — implement the accepted compact scrollable table plus per-skill detail view with the required columns, metadata, actions, enforcement mode, and scroll indicator.
- `SKILL-TUI-003` — implement a genuinely interactive custom TUI with keyboard navigation, search/filter, table cycling/toggling, detail open/back, immediate persistence, visible rerendering, and predictable escape behavior.

## Primary Paths
- `src/commands.ts`
- `src/index.ts`
- `src/skills.ts`
- `src/checkbox.ts`
- `src/autocomplete.ts`
- `README.md`
- `tests`
- `package.json`

## Verification Expectations
- Before implementing or verifying the TUI, load and apply `/home/lenin/.pi/pi-tui-widget-reference.md`; the interactive manager must use Pi's documented TUI component model/widgets/utilities such as `ctx.ui.custom()`, `Component`, keyboard helpers, and visible-width/truncation utilities rather than ad hoc static terminal output.
- Add and run focused TUI component tests with a mocked Pi UI/TUI host proving keyboard navigation, search/filter over the full list, table toggle/cycle, immediate save calls, detail view/back navigation, and escape/return behavior without focus traps.
- Verify save-failure behavior: failed policy writes surface an error, do not show durable success, and do not let Escape/back hide unsaved policy state as if it had persisted.
- Verify main table rows include skill name, global default, this-folder override (`inherit`, `enabled`, `disabled`), effective state, winning scope, and a hidden/blocked/filtering enforcement indication where useful, and do not render descriptions as row text.
- Verify detail view renders full description or a clear `(no description)` placeholder, source/package label, file path, global default, started-folder override, effective state and winning scope, enforcement mode, and actions for changing global state, changing/clearing folder override, and source-related state changes.
- Verify long lists are bounded by terminal height or overlay `maxHeight`, expose a scrollbar/position/result-count indicator, and never expand the overlay to render every installed skill.
- Verify width safety with narrow and wide terminal render widths using Pi TUI visible-width/truncation utilities; no rendered line may exceed the render width.
- Verify UI surface text, command output, errors, notifications, autocomplete/help, and README examples use audience-appropriate language and do not leak planning/work-package/staging terminology.
- Run `npm run smoke` plus the focused TUI tests; if the full interactive Pi TUI cannot be exercised headlessly, provide mocked component evidence and at least one smoke/manual path documenting `/manage-skills` opens the custom manager in TUI mode.
- Planner seeds do not limit verifier discovery; verifiers must inspect package scope, assigned Slices, changed code/diff, tests, and known failure modes for emergent triggered-risk rows.

## Proof
- `.tasks/manage-skills/proofs/WP3.proof.md`

## Package Verification Report
- `.tasks/manage-skills/reports/WP3.package-verification.md`

## Dependencies
- `WP1`
- `WP2`

## Notes
- Semgrep is disabled for this plan; do not require Semgrep helper setup, scans, network, or Semgrep artifacts.
- Required TUI implementation reference: `/home/lenin/.pi/pi-tui-widget-reference.md`. Use the documented widgets/component model as the implementation authority for the interactive manager.
- Serialization after WP2 is required because this package consumes the final command registration/enforcement surfaces and must verify the integrated user experience rather than an isolated mock command.
