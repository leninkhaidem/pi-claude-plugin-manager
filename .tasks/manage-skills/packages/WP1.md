# Work Package: WP1 — Policy model, migration, and skill inventory

## Scope
Create the durable skill-policy domain model and migration path that all later enforcement and UI code consumes. Own manager-state schema changes, normalized started-folder keys, global/default plus folder override evaluation, legacy `disabledSkills` / `disabledSkillSources` migration into global disabled policy, identity selection by path/source/name fallback, and skill/source inventory objects rich enough to explain effective state and disambiguate duplicate names. Do not register `/manage-skills`, intercept slash input, or build the TUI in this package.

## Assigned Slices
### `.planning/skill-management-scope/slices/enforcement-and-scope.md`
Must satisfy:
- `SKILL-MGMT-005` — implement exactly two policy scopes and started-folder-over-global effective-state evaluation in the policy model.
- `SKILL-MGMT-006` — persist policy in manager-owned user state keyed by normalized started-folder path and never repo-local policy files.
- `SKILL-MGMT-007` — preserve legacy disablements during migration, prefer path/source identity when available, keep name fallback data for slash blocking, and represent source-level policy without losing per-skill row identity.

Context only:
- `SKILL-MGMT-001` — downstream enforcement consumes the policy evaluator to remove disabled skills from context.
- `SKILL-MGMT-002` — downstream resource discovery consumes policy decisions for manager-owned omitted paths.
- `SKILL-MGMT-003` — downstream external enforcement consumes name fallback and source/path identity.
- `SKILL-MGMT-004` — downstream command registration owns the command rename.
- `SKILL-MGMT-008` — downstream command/TUI owns immediate-save and non-TUI behavior using this persistence layer.

## Primary Paths
- `src/state.ts`
- `src/types.ts`
- `src/skills.ts`
- `src/discovery.ts`
- `src/utils.ts`
- `tests`

## Verification Expectations
- Add and run focused state/policy tests or smoke assertions proving legacy `disabledSkills` and `disabledSkillSources` migrate into global disabled policy without dropping disables, including malformed/missing state defaults.
- Verify migration is one-time/idempotent via a schema/migration marker or equivalent behavior: after a migrated skill/source is re-enabled, subsequent reads/restarts must not resurrect the legacy disabled entry.
- Verify normalized started-folder path keys are used consistently so equivalent started-folder paths resolve to the same override and a different folder does not inherit another folder override except through global defaults.
- Verify effective state follows global default when folder override is `inherit`/absent and follows the started-folder override when present; effective state remains derived and is not persisted as a third layer.
- Verify skill identity prefers path/source identity when available, preserves source-level policy, and exposes duplicate-name rows with enough source/path metadata for later UI disambiguation.
- Inspect persisted state writes for manager-owned `~/.pi/agent/claude-plugin-manager/state.json` behavior and confirm no repo-local `.pi` skill-policy writes are introduced.
- Run `npm run smoke` after focused tests, or document any environment-only smoke limitation with equivalent targeted command evidence.
- Planner seeds do not limit verifier discovery; verifiers must inspect package scope, assigned Slices, changed code/diff, tests, and known failure modes for emergent triggered-risk rows.

## Proof
- `.tasks/manage-skills/proofs/WP1.proof.md`

## Package Verification Report
- `.tasks/manage-skills/reports/WP1.package-verification.md`

## Dependencies
- None.

## Notes
- Semgrep is disabled for this plan; do not require Semgrep helper setup, scans, network, or Semgrep artifacts.
- This package is first because later enforcement and TUI work must share one policy/effective-state model rather than independently encoding precedence.
