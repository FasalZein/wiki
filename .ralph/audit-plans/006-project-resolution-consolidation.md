# Plan 006 — Consolidate the project-resolution seam

Target commit: `5dbf09f`. Read each cited file before editing; if the resolution blocks have
drifted, STOP and report.

## Why
Two divergent answers to "does this project exist and where is it":
- `status`/`search`/`doc`/`create` use `loadProjectConfig` + `projectErrorMessage` (lists
  available projects, suggests `wiki project create`) and exit **10**.
- `fmt`/`sync` hand-roll it: a terse `"missing required field: project"` and exit **1**.

And 9 sites inline `join(vaultRoot, "projects", project)` instead of the existing
`projectPath()` helper. This is genuine duplication (and after plan 001, `projectPath()` is
also where path containment lives — so inlining the join SKIPS the guard).

## Part A — Route project-dir joins through `projectPath()`
`projectPath(vaultRoot, project)` is exported from `src/artifacts/paths.ts`. Replace these
inline `join(vaultRoot, "projects", <project>)` calls with it (import `projectPath` where
needed):
- `src/cli/verbs/status.ts:27`
- `src/cli/verbs/search.ts:57`, `:79`, `:99`
- `src/cli/verbs/doc.ts:54`
- `src/cli/verbs/create.ts:158`
- `src/cli/verbs/fmt.ts:36`
- `src/cli/verbs/sync.ts:20`
- `src/cli/resolve-project.ts:21`
- `src/cli/verbs/project.ts:105`

DO NOT touch: `src/bootstrap/doctor.ts:51,67,103` (these build the projects DIR or deeper
`docs/`/`_project.md` paths, not a single project segment) and `src/config/project.ts:28`
(lists the projects dir). They are not the same join.

## Part B — Converge `fmt` and `sync` onto the actionable resolution pattern
The convergent winner is the `status.ts` pattern (better UX, used by more verbs). Replicate it.

Exemplar — `src/cli/verbs/status.ts:27-36`:
```ts
  const projectPath = join(vaultRoot, "projects", project);
  try {
    await loadProjectConfig(projectPath);
  } catch (error) {
    if (error instanceof ProjectConfigError) {
      console.error(await projectErrorMessage(vaultRoot, project));
      return { code: 10 };
    }
    throw error;
  }
```

Current `fmt` (`src/cli/verbs/fmt.ts:29-37`) and `sync` (`src/cli/verbs/sync.ts:13-20`) both
do `resolveProject` → terse `console.error("missing required field: project...")` →
`return { code: 1 }`, then `assertProjectStructure`. Change them to:
- keep `resolveProject(parsed)`; if `project === undefined` keep the existing terse "pass
  --project or link the repo" message + `return { code: 1 }` (that path is "no project given
  at all", distinct from "project doesn't exist" — leave it as exit 1).
- where they currently build `projectPath` and call `assertProjectStructure`, REPLACE the
  bare `assertProjectStructure` with the `loadProjectConfig` + `ProjectConfigError` →
  `projectErrorMessage` + `return { code: 10 }` block above, so a NONEXISTENT `--project`
  gives the actionable listing and exit 10 like the other verbs. (`loadProjectConfig`
  throwing `ProjectConfigError` covers the missing-`_project.md` case; if `fmt`/`sync` need
  the full structure assertion too, keep `assertProjectStructure` AFTER the loadProjectConfig
  check.)
- import `loadProjectConfig`, `ProjectConfigError`, `projectErrorMessage` from
  `../../config/project` (sync.ts already imports `loadProjectConfig`; add the other two).

## Out of scope — do NOT touch
- The "no --project at all" terse message + exit 1 (that's a different, correct case).
- `doctor.ts` / `config/project.ts:28` joins (see Part A).
- Do NOT invent a new resolution abstraction — this is pure consolidation onto the existing
  `projectPath()` helper and the existing `status.ts` pattern.

## Verification
`bun run build && bunx tsc --noEmit && bun test tests/` — all green.
**Watch:** any existing test asserting `fmt`/`sync` returns `code: 1` for a NONEXISTENT
project must change to `code: 10`. Search: `grep -rn "code: 1" tests/ | grep -i "fmt\|sync"`
and update those assertions to match the new behavior (this is an intended behavior change).

## Test plan
If a `fmt`/`sync` "nonexistent project" test exists, update its expected code to 10 and assert
the message now lists available projects. If none exists, add a small one to the relevant
CLI test file mirroring how `tests/` already drives `fmt`/`sync`.

## Maintenance note
After this, `projectPath()` is the single seam for project-dir paths (and path containment,
post-plan-001), and exit 10 = "named project doesn't exist" across all verbs. New verbs should
follow the `status.ts` pattern.
