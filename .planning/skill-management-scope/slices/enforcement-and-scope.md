# Slice: Enforcement and Scope

## Purpose
- Capture the product/design obligations for making skill management reliable enough for implementation planning, especially disabled-skill enforcement and multi-scope policy behavior.

## Shared Understanding

### SKILL-MGMT-001 — Disabled skills must be absent from model context
Disabled skills must not be present in the effective system prompt/model context. This is the primary correctness requirement. It is acceptable if a disabled skill remains visible in Pi's startup `[Skills]` display or slash-command registry when Pi/package discovery owns that skill, as long as the skill is stripped from the model prompt and explicit `/skill:name` invocation is blocked.

Implementation-shaping detail: current extension APIs support `before_agent_start` prompt filtering and `input` interception before skill expansion. Existing manager code already filters disabled skill XML in `src/index.ts` via `filterDisabledSkillsFromPrompt(...)`; this should be retained or strengthened.

Verification expectations:
- A disabled skill's XML block is absent from the final prompt passed into an agent turn.
- `/skill:<disabled-name>` does not load the disabled skill content into the conversation.
- A disabled skill can still be visible in Pi's UI only when the manager cannot remove it from Pi-owned discovery, and this visibility is not treated as failure.

### SKILL-MGMT-002 — Manager-owned skills should be hidden at resource discovery when disabled
For skills contributed by this plugin manager, disabling should omit the skill path from `resources_discover` after reload. This removes those skills from Pi's loaded skills and slash-command registry instead of merely filtering the prompt.

Interface contract:
- When a managed skill or managed skill source is disabled, `resources_discover` must not return that disabled skill path.
- Re-enabling followed by reload must return the skill path again.
- Forbidden behavior: returning a disabled manager-owned skill path and relying only on prompt filtering when the manager has enough ownership to omit it.

Verification expectations:
- A fixture/managed skill disappears from `pi.getCommands()` after disable + reload.
- Source-level disable applies to every managed skill under that source.

### SKILL-MGMT-003 — External/Pi-native/package skills require policy enforcement instead of unregistering
External skills such as `ctx-index` may be loaded by Pi/package discovery outside this manager's `resources_discover` path. Current extension APIs provide `getCommands()` inspection but do not expose a command/skill unregister API. For those skills, the manager should enforce disablement by policy: strip from prompt and intercept `/skill:name` input before Pi expands the skill.

Implementation-shaping detail: Pi settings/package filters can hide package skills at load time, but that requires mutating Pi settings rather than only plugin-manager state. That may be useful later, but it is not required if context removal and invocation blocking are reliable.

Accepted tradeoff: the user accepted that visible startup/slash entries are acceptable as long as disabled skills are not in context.

Verification expectations:
- Disabling a Pi/package-native skill by name blocks `/skill:<name>` even if `pi.getCommands()` still lists it.
- Prompt filtering works by skill name and, when known, by skill path/source prefix.

### SKILL-MGMT-004 — User-facing command is `/manage-skills`; `/skills` is removed
The improved skill manager should use `/manage-skills` as the user-facing command name. The old `/skills` command should be removed rather than kept as a compatibility or deprecation alias.

Interface contract:
- Register `/manage-skills` for the skill manager UI/command surface.
- Do not keep `/skills` as an alias.
- Forbidden behavior: silently keeping `/skills` available after the rename.

Verification expectations:
- `/manage-skills` is available.
- `/skills` is not registered by this extension after the rename.

### SKILL-MGMT-005 — Skill policy has exactly two scopes
The skill manager only needs two policy scopes:
- **Global default** — the default skill state across Pi sessions.
- **Started folder** — the folder where Pi is started for the current session/context.

Precedence decision: started-folder policy overrides global default. More complex project/subtree/current-project layering is not required.

Implementation-shaping detail: the UI should make the effective state explainable by showing both the global default and whether the started folder overrides it. “Current folder” means `ctx.cwd` / the folder Pi was started in, not arbitrary nested folder matching.

Rejected alternative: multi-layer precedence across global, project, folder/subtree, and current-project was considered but narrowed by user decision to the two scopes above.

Verification expectations:
- With no started-folder override, effective skill state follows global default.
- With a started-folder override, effective state follows that folder override.
- UI explains the winning scope for each skill.

### SKILL-MGMT-006 — Policy persistence is user-manager state keyed by started folder
Persist both global skill defaults and started-folder overrides in the plugin manager's user state, not in repo-local files. Folder overrides should be keyed by normalized started-folder path.

Implementation-shaping detail: the likely destination is the existing plugin manager state path under `~/.pi/agent/claude-plugin-manager/state.json`, extending the current state schema rather than creating project `.pi` files. This keeps skill preferences personal and avoids mutating repositories.

Accepted tradeoff: folder overrides do not travel with the repo or become shared team configuration. The user accepted this tradeoff.

Interface contract:
- Global defaults and folder overrides are stored in manager-owned user state.
- Started-folder override keys must use normalized folder paths so equivalent paths resolve consistently.
- Forbidden behavior: writing skill override policy into repo-local `.pi` files without a later explicit user decision.

Verification expectations:
- Changing a global default persists across Pi sessions.
- Changing a started-folder override persists when Pi is restarted in that same folder.
- Starting Pi in a different folder does not accidentally inherit another folder's override except through global defaults.

### SKILL-MGMT-007 — Skill/source identity and migration defaults
Policy identity should prefer stable path/source identity when available, with skill name as the fallback needed for external `/skill:name` blocking. Row-level policy in `/manage-skills` targets the selected skill identity/path when available. Slash-command blocking by skill name necessarily blocks all same-name slash invocations when duplicate names exist because Pi invokes skills by command name.

Source-level policy/enforcement remains supported. The primary TUI table is per-skill, but source-level policy should still be represented in the data model and enforcement path. Source-level actions may appear in detail/actions or related source controls; they must not undermine the accepted per-skill table layout.

Migration requirement: existing `disabledSkills` and `disabledSkillSources` state should migrate into the new global default policy as disabled skill/source entries. This preserves existing user disablements when upgrading.

Interface contract:
- Preserve current disable state during migration.
- Use path/source identity where available; use name fallback for external slash blocking.
- Duplicate skill names must not silently produce a misleading row-level outcome; the UI/detail should expose enough source/path information to disambiguate.
- Forbidden behavior: dropping existing `disabledSkills` / `disabledSkillSources` during schema migration.

Verification expectations:
- Existing disabled skill paths remain effectively disabled after migration.
- Existing disabled source paths remain effectively disabled after migration.
- Duplicate-name rows can be distinguished by source/path in detail view.

### SKILL-MGMT-008 — Save and non-TUI command defaults
`/manage-skills` changes should save immediately as the user toggles/cycles values. Escape/back exits or returns to the previous view but does not roll back changes already saved.

`/manage-skills` is primarily an interactive TUI command. In non-TUI mode, it should emit a clear unsupported/help/status message rather than attempting to emulate the full interactive manager. `/skills` remains removed.

Interface contract:
- Toggle/cycle operations persist immediately to manager state.
- Escape/back behavior must be predictable and must not imply rollback.
- Non-TUI invocation must fail gracefully or provide compact help/status without static full-manager behavior.
- Forbidden behavior: treating Escape as rollback after changes were already persisted.

Verification expectations:
- A saved toggle survives leaving the UI and re-opening it.
- Escape from table/detail does not corrupt state.
- Non-TUI `/manage-skills` behavior is clear and does not register `/skills`.

## Source References
- `spikes/skill-manager-spike.ts` — Demonstrates resource omission for manager-owned fixture skill, input blocking for disabled skill invocation, and prompt filtering fallback.
- `spikes/skill-manager-spike-smoke.sh` — Smoke test for the spike enforcement behavior.
- `src/index.ts` — Registers `/skills`, contributes `resources_discover`, and filters disabled skill XML before agent start.
- `src/discovery.ts` — Current resource discovery filters individual disabled skills but has suspected gaps for disabled skill sources.
- `src/skills.ts` — Current skill/source listing and prompt filtering logic.
- `/home/lenin/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` — Documents extension hooks and their limitations/relevant behavior.
- `/home/lenin/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs/settings.md` — Documents package/local resource filters that can hide resources at load time.

## Non-Goals / Deferred Scope
- Full removal of externally owned Pi/package skills from Pi's startup `[Skills]` list is not required for correctness if context removal and invocation blocking are reliable.
- Multi-layer policy across project/subtree/current-project scopes is out of scope; only global default and started-folder override are required.
- Implementation planning and `.tasks/` artifacts remain outside Conceptualize; route through implementation planning when ready.

## Acceptance / Verification Expectations
- Later implementation must include tests or smoke coverage for: manager-owned disabled skill omitted from discovery, external disabled skill blocked on `/skill:name`, disabled source prefix enforcement, and prompt/context filtering.
- The TUI/command UX should clearly communicate when a skill is "hidden" versus merely "blocked/filtered" due to Pi ownership limitations.
- Scope conflict behavior must be deterministic: started-folder override wins over global default, and the UI must show that effective source.

## Questions to Resolve Before Planning
- None.
