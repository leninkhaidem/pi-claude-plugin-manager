# Work Package: WP2 — Enforcement hooks and command surface

## Scope
Wire the policy model into Pi extension surfaces that enforce disabled skills and expose the renamed command. Own `/manage-skills` registration, `/skills` removal, autocomplete rename/removal, non-TUI compact help/status behavior, `resources_discover` filtering for manager-owned disabled skills and sources, `before_agent_start` prompt filtering by path/source/name where available, and `input` interception that blocks disabled `/skill:<name>` before expansion. Do not build the final interactive table/detail TUI here; WP3 owns the custom TUI experience.

## Assigned Slices
### `.planning/skill-management-scope/slices/enforcement-and-scope.md`
Must satisfy:
- `SKILL-MGMT-001` — disabled skills are absent from effective model context and disabled `/skill:<name>` cannot load skill content.
- `SKILL-MGMT-002` — disabled manager-owned skill/source paths are omitted from `resources_discover` after reload and reappear when enabled.
- `SKILL-MGMT-003` — external/Pi-native/package disabled skills are prompt-filtered and slash-blocked rather than treated as unregisterable.
- `SKILL-MGMT-004` — register `/manage-skills` and remove `/skills` rather than keeping an alias.
- `SKILL-MGMT-008` — provide graceful compact non-TUI `/manage-skills` behavior and preserve immediate-save semantics exposed by the policy layer.

Context only:
- `SKILL-MGMT-005` — command/status output and enforcement must use started-folder-over-global policy decisions from WP1.
- `SKILL-MGMT-006` — enforcement must read/write only manager-owned user state through WP1 APIs.
- `SKILL-MGMT-007` — slash blocking by name and path/source filtering depend on WP1 identity and migration data.

### `.planning/skill-management-scope/slices/manage-skills-tui.md`
Context only:
- `SKILL-TUI-002` — `/manage-skills` command wiring must leave the primary TUI experience to WP3's accepted table/detail design.
- `SKILL-TUI-003` — command wiring must not regress into a static/select-only full manager.

## Primary Paths
- `src/index.ts`
- `src/commands.ts`
- `src/autocomplete.ts`
- `src/discovery.ts`
- `src/skills.ts`
- `src/state.ts`
- `README.md`
- `tests/smoke.sh`
- `spikes/skill-manager-spike.ts`
- `spikes/skill-manager-spike-smoke.sh`

## Verification Expectations
- Verify `/manage-skills` is registered by the extension, `/skills` is not registered by this extension, and autocomplete/help/docs no longer promote `/skills`.
- Add and run focused enforcement coverage proving a manager-owned disabled skill path is omitted from `resources_discover` after disable + reload semantics and reappears after re-enable + reload semantics; include source-level disable applying to every managed skill under that source.
- Add and run focused coverage proving an external/Pi-native/package disabled skill is blocked on `/skill:<name>` before expansion even when `pi.getCommands()` may still list it; duplicate-name blocking by name must be explicit and not silently represented as row-specific slash behavior.
- Verify `/skill:<name>` blocking parses invocations precisely and fail-closed for disabled skills: cover whitespace/trailing args, empty or malformed names, substring false positives, and duplicate-name blocking before Pi skill expansion.
- Add and run focused prompt-filter coverage proving disabled skill XML blocks are removed from the final prompt by path/source and by name fallback when available, while enabled skills remain.
- Verify non-TUI `/manage-skills` emits compact actionable help/status or a clear unsupported message and does not attempt to print/emulate the full interactive manager.
- Verify enforcement failure modes are fail-closed for disabled skills where policy is readable, while state read errors remain observable and do not fake successful disablement.
- Run `npm run smoke` and any new targeted smoke script(s) for the renamed command/enforcement paths.
- Planner seeds do not limit verifier discovery; verifiers must inspect package scope, assigned Slices, changed code/diff, tests, and known failure modes for emergent triggered-risk rows.

## Proof
- `.tasks/manage-skills/proofs/WP2.proof.md`

## Package Verification Report
- `.tasks/manage-skills/reports/WP2.package-verification.md`

## Dependencies
- `WP1`

## Notes
- Semgrep is disabled for this plan; do not require Semgrep helper setup, scans, network, or Semgrep artifacts.
- Serialization after WP1 is required because enforcement must consume the same persisted policy/effective-state APIs and migration behavior.
- WP3 will replace or extend the TUI-mode handler with the final interactive UI; this package must avoid exposing internal staging language to users.
