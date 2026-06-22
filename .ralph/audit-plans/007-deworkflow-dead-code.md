# Plan 007 — Remove de-workflow dead code

Target commit: `5dbf09f`. Each removal below was grep-confirmed to have no runtime consumer.
Re-confirm with the grep given before deleting; if a consumer now exists, STOP and report.

This is pure deletion — the lean win. Four independent removals; do all four.

## 7a — `test_command` flag/field/usage (TDD-gate leftover)
The TDD gates were removed in ADR-0034; `test_command` is now stored and echoed but NEVER
executed (`grep -rn "test_command\|testCommand" src` shows only storage/echo, no run site).
Worse, the usage text still says "the TDD gates run", which no longer exist.

Remove:
- `src/config/project.ts:9` — the `test_command: string;` member of `ProjectConfig`.
- `src/config/project.ts:68` — the `test_command: isNonEmptyString(...) ? ... : "bun test",`
  line in `loadProjectConfig`'s returned object.
- `src/cli/verbs/project.ts:53` — `const testCommand = stringValue(...) ?? "bun test";`
- `src/cli/verbs/project.ts:76` — drop `test_command: ${testCommand}\n` from the `_project.md`
  frontmatter template string.
- `src/cli/verbs/project.ts:87,88` — drop the `test_command: ${testCommand}` / "change
  repo/test_command" mentions from the two `console.error` lines (keep the `repo` parts).
- `src/cli/usage.ts:215` — drop ` [--test-command <cmd>]` from the usage string.
- `src/cli/usage.ts:218` — delete the `"--test-command": "command the TDD gates run..."` entry.
- `src/cli/usage.ts:220` — drop ` --test-command 'npm ...'` from the example.
- Update the comment at `src/cli/verbs/project.ts:50-51,75` that references `test_command`.

**Watch:** `grep -rn "test_command" tests/` — if a test asserts `test_command` appears in
`_project.md` output, update it to expect its absence.

## 7b — `appendField` dead export
`grep -rn "appendField" src` shows zero call sites outside its own definition; only a test
references it. Remove:
- `src/artifacts/store.ts:138-151` — the entire `export async function appendField(...)`.
- `src/artifacts/store.ts:48` — `export type AppendFieldInput = SetFieldInput;` (no other ref).
- `tests/artifacts.test.ts` — the test block starting at the `appendField` usage (~line 186)
  and remove `appendField` from the import on line 6.

## 7c — `research.sources` no-op config
`WikiConfig.research.sources` is parsed and defaulted but never consumed (the only
`getConfig()` reader, `config/vault.ts:51`, touches `.vault.root`; research paths come from
the PROJECT-level `research_path`, not this field). Remove:
- `src/config/types.ts:3` — the `research: { sources: string[] };` member of `WikiConfig`.
- `src/config/config.ts:31` — the `const sources = ...` line.
- `src/config/config.ts:35` — the `research: { sources },` in the returned object.
- `src/config/config.ts:42` — the `research: { sources: defaultResearchSources },` default
  (and the `defaultResearchSources` binding if it's now unused — check and remove).

**Watch:** `grep -rn "\.research" src tests` to confirm nothing else reads it before deleting.

## 7d — orphan `js-yaml` type shim
`tests/js-yaml.d.ts` declares `module "js-yaml"`, but `js-yaml` is not a dependency and is
imported nowhere (the repo uses `gray-matter`). Delete the file:
- `rm tests/js-yaml.d.ts`

## Out of scope — do NOT touch
- `dedup.ts` and the "advisory" wording (intentional, ADR-0010 superseded — NOT dead).
- The `phase`/`lifecycle` synonyms in `src/search/query-builder.ts` (they're retrieval
  query-expansion aliases for historical vault content, not removed-workflow branches — leave).
- `gray-matter` / `smol-toml` deps (both live).

## Verification
`bun run build && bunx tsc --noEmit && bun test tests/` — all green. tsc will flag any
reference you missed (e.g. a leftover use of a removed type) — that's the safety net; fix
until clean.

## Test plan
No NEW tests — this is deletion. The existing suite plus tsc is the gate. If 7a's "watch"
grep finds a `_project.md` assertion, update it.

## Maintenance note
After this, `_project.md` no longer carries `test_command`; if the optional TDD pack ever
returns (ADR-0034 consequences note it "could return later as an optional pack"), it should
own its own config field rather than reviving this inert one.
