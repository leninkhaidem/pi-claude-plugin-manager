# Manage Skills Specification

## Overview
Provide a reliable `/manage-skills` command for managing skill enablement across global defaults and the current started folder, ensuring disabled skills are absent from effective model context and cannot be invoked accidentally.

## Conceptualize Inputs
- Index: `.planning/skill-management-scope/index.md`

## Authoritative Slices
- `.planning/skill-management-scope/slices/enforcement-and-scope.md`
- `.planning/skill-management-scope/slices/manage-skills-tui.md`

## Requirements
- REQ-1: Register `/manage-skills` as the primary skill manager command and remove `/skills` rather than aliasing or deprecating it.
- REQ-2: Disabled skills must be absent from the effective system prompt/model context.
- REQ-3: Explicit `/skill:<name>` invocation for disabled skills must be blocked before skill expansion; when duplicate slash names exist, name-based slash blocking necessarily blocks all same-name invocations.
- REQ-4: Manager-owned disabled skill paths and manager-owned disabled source paths must be omitted from `resources_discover` after reload; re-enabled paths must reappear after reload.
- REQ-5: Externally owned Pi-native/package skills may remain visible in Pi startup displays or slash registries only when the manager cannot unregister them, but they must still be prompt-filtered and blocked on invocation.
- REQ-6: Skill policy has exactly two scopes: global default and started folder. Started-folder policy overrides global default.
- REQ-7: Skill policy persists in manager-owned user state under the plugin manager state path, keyed by normalized started-folder path for folder overrides. The feature must not write skill policy into repo-local files.
- REQ-8: Policy identity must prefer stable path/source identity where available and use skill-name fallback where needed for external slash blocking. Row-level policy must disambiguate duplicate skill names by source/path.
- REQ-9: Source-level policy and enforcement remain supported, while the primary interactive table is per-skill.
- REQ-10: Existing `disabledSkills` and `disabledSkillSources` state must migrate into the new global default disabled policy without dropping current disablements. Migration must be one-time/idempotent so legacy disables are not re-applied after a user re-enables a migrated skill/source.
- REQ-11: Toggle and cycle operations save immediately. Escape/back exits or returns to the previous view without rolling back already saved changes. If a save fails, the UI must surface the error, avoid showing durable success, and not let navigation hide unsaved policy state.
- REQ-12: Non-TUI `/manage-skills` must fail gracefully or provide compact help/status and must not emulate the full interactive manager.
- REQ-13: TUI `/manage-skills` must be a genuinely interactive Pi custom TUI, not static output, markdown output, or a simple select-prompt workflow.
- REQ-14: The TUI must use a bounded, scrollable compact per-skill table plus per-skill detail view. The table shows skill name, global default, this-folder override, effective state, winning scope, and a scroll indicator; descriptions appear only in detail view.
- REQ-15: Detail view must show full description or a graceful missing-description placeholder, source/package label, path, global state, started-folder override, effective state and winning scope, enforcement mode, and actions for global/folder/source-related state changes.
- REQ-16: `/skill:<name>` input blocking must parse slash invocations precisely and fail closed for disabled skills without substring false positives; verification must cover whitespace/trailing args, empty or malformed names, and duplicate-name blocking before expansion.

## Acceptance Criteria
- AC-1: Given a disabled manager-owned skill or source, after reload `resources_discover` omits the disabled managed skill path, and re-enabling followed by reload returns it.
- AC-2: Given a disabled external/Pi-native/package skill, `/skill:<name>` is blocked and the skill XML is absent from the prompt even if Pi still lists the slash command.
- AC-3: Given no started-folder override, effective state follows the global default; given a started-folder override, effective state follows that override and the UI shows `folder` as the winner.
- AC-4: Given existing legacy `disabledSkills` and `disabledSkillSources` state, first read/migration preserves those disables as global default policy exactly once, and a later user re-enable is not undone by repeated reads/restarts.
- AC-5: `/manage-skills` is registered, `/skills` is not registered by this extension, and related autocomplete/docs no longer promote `/skills`.
- AC-6: In TUI mode, `/manage-skills` opens an interactive searchable table with bounded visible rows, keyboard navigation, immediate-save cycling/toggling, detail open/back, predictable escape behavior, and truthful save-failure handling.
- AC-7: The main table does not render descriptions; the detail view renders full descriptions when present and `(no description)` or equivalent when absent.
- AC-8: Long skill lists are not expanded to the full viewport; scrolling/search operates over all matching skills and exposes position/result count.
- AC-9: Non-TUI `/manage-skills` emits compact actionable help/status rather than a static full manager.

## Constraints
- Semgrep is disabled for this plan; no Semgrep helper setup, network, clone/pull, scans, scan evidence, or Semgrep artifacts are required.
- Skill policy must remain personal manager-owned user state and must not be persisted into repository-local `.pi` files.
- The only policy scopes are global default and started folder; do not add project/subtree/current-project precedence layers.
- Started folder means the Pi session `ctx.cwd` / started folder, normalized consistently.
- Effective state is derived feedback, not a third policy layer.
- Implementations must preserve exact interface contracts and forbidden behaviors from the authoritative Slices.
- Custom TUI rendering must be width-safe and avoid over-wide lines.

## Work Packages
- `packages/WP1.md` — Policy model, migration, and skill inventory
- `packages/WP2.md` — Enforcement hooks and command surface
- `packages/WP3.md` — Interactive `/manage-skills` TUI and documentation

## Code References
- `src/state.ts` — manager-owned state path, default/read/write state behavior.
- `src/types.ts` — persisted state and command result types.
- `src/skills.ts` — skill metadata, source grouping, prompt filtering, and current enabled/disabled logic.
- `src/discovery.ts` — manager-owned resource discovery and disabled skill filtering.
- `src/index.ts` — command registration and Pi lifecycle hooks.
- `src/commands.ts` — current `/skills` command handling and UI helpers.
- `src/autocomplete.ts` — command argument autocomplete for `/plugin` and current `/skills` surface.
- `src/checkbox.ts` — existing custom TUI component pattern.
- `README.md` — user-facing command and skill-manager documentation.
- `tests/smoke.sh` — end-to-end smoke coverage harness.
- `spikes/skill-manager-spike.ts` — accepted spike evidence for discovery hiding, slash blocking, and prompt filtering.
- `spikes/skill-manager-spike-smoke.sh` — accepted smoke evidence for the spike behavior.

## Out of Scope
- Full removal of externally owned Pi/package skills from Pi startup `[Skills]` displays or slash registries is deferred by approved tradeoff when this manager does not own discovery/unregistration; prompt filtering and invocation blocking remain required.
- Multi-layer policy across project, subtree, current-project, or arbitrary folder matching is rejected/narrowed by approved user decision; only global default and started-folder override are in scope.
- Mutating Pi settings/package filters to hide package skills at load time is not required for this feature.
- Repo-local shared/team skill policy is out of scope by approved storage decision.
