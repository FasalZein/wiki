# Plan 001 — Path-traversal containment for `--project` and artifact `id`

Target commit: `5dbf09f`. If `src/artifacts/paths.ts` or `src/artifacts/store.ts` have
drifted substantially from the excerpts below, STOP and report instead of guessing.

## Why
This CLI turns a `--project` name and an artifact `id` into filesystem paths with no
validation. A project name or id containing `../` (or an absolute path) escapes the
vault root. `wiki project create "../../evil"` is the worst case: it `mkdir`s and writes
`_project.md` **outside the vault, unmitigated**. Reads and `relocateArtifact` writes are
also steerable via a crafted id.

## Current code (read these, confirm they match)
- `src/artifacts/paths.ts:10` — `projectPath(vaultRoot, project)` → `join(vaultRoot, "projects", project)`, no sanitization.
- `src/cli/verbs/project.ts:55-77` — `createProject` builds `projPath = projectPath(vaultRoot, name)` from the raw positional `name`, then `mkdir`s folders and `Bun.write`s `_project.md`. The only guard is a `stat` existence check (does NOT constrain location).
- `src/cli/resolve-project.ts:33-36` — `resolveProject` returns an explicit `--project` value **verbatim**.
- `src/artifacts/store.ts:288-290` — `resolveArtifactPath` does `join(directory, \`${id}.md\`)` with an unvalidated `id` (reached by `readArtifact` and the `--supersedes`/`--parent-prd`/`--related-to`/`doc retitle|recategorize` id inputs).
- `src/artifacts/store.ts:202-237` — `relocateArtifact` builds `fileName = \`${input.id}-${slugifyTitle(nextTitle)}.md\`` (id NOT slugified) and writes to a join of it; it also `Bun.write`s the destination then `rm`s the old file **without checking the destination doesn't already hold a different artifact** (the folded-in CORRECTNESS-05 overwrite bug).

## What to change

### 1. Add one containment helper in `src/artifacts/paths.ts`
A single guard reused for both project names and ids. Keep it tiny and pure:

```ts
/** Reject a path segment that could escape its parent directory. Project names and
 *  artifact ids are turned into file paths; neither may contain separators or `..`.
 *  ponytail: one guard for both — separators + dot-segments + empties is the whole
 *  traversal surface for a join()-built path. */
export function assertSafeSegment(value: string, label: string): void {
  if (
    value.length === 0 ||
    value.includes("/") ||
    value.includes("\\") ||
    value === "." ||
    value === ".." ||
    value.includes("\0")
  ) {
    throw new Error(`invalid ${label}: ${JSON.stringify(value)} (no path separators or '..')`);
  }
}
```
Then call it inside `projectPath` BEFORE the join, so EVERY project-path consumer is
covered at the seam:
```ts
export function projectPath(vaultRoot: string, project: string): string {
  assertSafeSegment(project, "project name");
  return join(vaultRoot, "projects", project);
}
```

### 2. Validate the artifact `id` before joining it
In `src/artifacts/store.ts`, at the top of `resolveArtifactPath` (line ~289) and at the
top of `relocateArtifact` (line ~203), call `assertSafeSegment(id, "artifact id")`
(import it from `./paths`). This covers both the read path and the relocate write path.

### 3. Refuse a colliding relocate destination (folded CORRECTNESS-05)
In `relocateArtifact`, just before `await writeArtifact(destination, content)` (line ~234):
```ts
if (destination !== existing.path && (await Bun.file(destination).exists())) {
  throw new ArtifactValidationError([
    { field: "id", reason: `destination already exists: ${destination}` },
  ]);
}
```
(`ArtifactValidationError` is already imported/used in this file.)

## Out of scope — do NOT touch
- `slugifyTitle` (already reduces titles to `[a-z0-9-]`; titles are safe).
- `--category` / kind (already allowlisted via `isDocCategory` / `ARTIFACTS[kind]`).
- The `doctor.ts` / `config/project.ts:28` `join(...,"projects")` sites (they build the
  projects DIR or deeper paths, not a single project segment — leave them; plan 006 handles helper reuse).
- Do NOT add a full path-canonicalization/`realpath` layer — that's over-engineering. The
  segment guard is sufficient and matches the lean ethos.

## Verification
1. `bun run build && bunx tsc --noEmit` — clean.
2. `bun test tests/` — all green (currently 238).
3. New tests pass (below).

## Test plan
Follow the style of `tests/artifacts.test.ts` (temp-vault fixtures) and `tests/cli-*.test.ts`.
Add a `tests/path-containment.test.ts`:
- `assertSafeSegment` rejects `"../x"`, `"a/b"`, `".."`, `""`, accepts `"wiki-v2"`, `"PRD-0009"`, `"SLICE-0054-foo"`.
- `createProject` / the `project create` CLI path with name `"../escape"` returns a nonzero code and writes nothing outside the vault (assert no dir created at the escaped path).
- `readArtifact` with id `"../../etc/passwd"` throws (does not read outside the artifact dir).
- `relocateArtifact` to a destination equal to an existing different artifact's path throws `ArtifactValidationError`.
- A normal create + read + retitle still works (regression guard).

## Maintenance note
Future kinds/verbs that take a project name or id get containment for free as long as they
go through `projectPath()` / `resolveArtifactPath()`. If a new verb builds a project path by
hand, it must call `assertSafeSegment` — that's the rule plan 006 consolidates.
