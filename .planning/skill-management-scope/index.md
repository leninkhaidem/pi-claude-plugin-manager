# Conceptualize Index: Skill Management Scope

Workspace: `.planning/skill-management-scope/`

## Summary
- Improve skill management so disabled skills are kept out of model context and cannot be invoked accidentally.
- Renaming the user-facing manager command to `/manage-skills` is desired for the eventual feature.
- Skill enable/disable policy only needs two scopes: global default and the folder Pi was started in.
- Skill policy persists in plugin-manager user state, keyed by normalized started-folder path.

## Current Direction
- Treat "not in model context" as the primary correctness bar; full removal from Pi's startup skill list/slash registry is desirable only where the extension controls resource discovery.

## Slices
- `.planning/skill-management-scope/slices/enforcement-and-scope.md` — Captures skill toggle enforcement semantics and scope-model decisions needed before implementation planning.
- `.planning/skill-management-scope/slices/manage-skills-tui.md` — Captures settled `/manage-skills` TUI requirements including the concrete scrollable table/detail mock-up.

## Durable Shared Understanding
- Disabled skills must not appear in the agent's effective system prompt/context.
- If a disabled skill remains visible in Pi's startup `[Skills]` list or slash autocomplete because Pi/package discovery owns it, that is acceptable as long as invocation is blocked and the skill is absent from context.
- Plugin-manager-owned skills can be hidden after reload by filtering the extension's contributed `resources_discover` paths.
- External/Pi-native/package skills may need policy enforcement through prompt filtering and `/skill:name` input interception rather than unregistering core Pi commands.

## Research and Source References
- `spikes/skill-manager-spike.ts` — Spike evidence for manager-owned resource hiding, disabled slash-command blocking, and prompt filtering fallback.
- `spikes/skill-manager-spike-smoke.sh` — Smoke test confirming spike behavior.
- `/home/lenin/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` — Extension APIs available: `resources_discover`, `input`, `before_agent_start`, `getCommands()`, and `ctx.reload()`.
- `/home/lenin/.local/lib/node_modules/@earendil-works/pi-coding-agent/docs/settings.md` — Pi settings/package filters can exclude package/local skill resources at load time.
- `src/index.ts`, `src/discovery.ts`, `src/skills.ts`, `src/commands.ts` — Current manager paths for `/skills`, resource discovery, prompt filtering, and skill/source toggle commands.

## Open Questions
- None.

## Planning Handoff
- Later planning must inspect every Slice in full, especially `.planning/skill-management-scope/slices/enforcement-and-scope.md` and `.planning/skill-management-scope/slices/manage-skills-tui.md`.
- Scope precedence is simplified: started-folder overrides global default. Policy storage is manager-owned user state. The `/manage-skills` TUI must be genuinely interactive, using the accepted scrollable table + detail-view workflow. `/skills` is removed rather than kept as an alias.
