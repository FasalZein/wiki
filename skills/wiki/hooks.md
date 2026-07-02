# Auto-persist skill output (optional, one-time)

Loaded only when you're wiring auto-capture. Day-to-day artifact work never needs this.

`wiki hooks install --runtime <claude-code|codex|pi> [--global]` wires a native hook
into the runtime's config. When you invoke a skill that authors an artifact (the
`skill` field in `wiki.json` maps it to a kind), the hook reminds you to persist its
output via `wiki create <kind>` — so a skill's result lands in the vault, not just chat.
Install also writes a `UserPromptSubmit` entry: a persist reminder that fires at the
next user prompt, only while persist debt is outstanding — an authoring skill ran without
a stamped write being captured — then clears itself (once per debt). Turn-end events
(Stop/SessionEnd) are deliberately not wired: they fire at every turn end, where
work-in-flight is indistinguishable from done. A session that authored nothing gets no
reminder noise; `wiki create` runs outside the hook's sight, so if you already persisted
that way, ignore the one reminder.
`wiki hooks uninstall --runtime <r> [--global]` splices out only the
wiki entries. `wiki hooks list`/`status` report per runtime/scope which of the required
events are wired: all present is `wired`, some-but-not-all is `partial` (broken — it names
the MISSING events; re-run install to add them, it merges and never clobbers), none is
`not wired`. `wiki doctor --setup` surfaces the same partial state as a `partial-hook` issue.
For pi, enable the exact scoped bridge `@hsingjui/pi-hooks` in pi's `packages[]`
(install warns if it's absent; unscoped `pi-hooks` forks are lookalikes). On codex
and pi the hook only sees a `/skill:name` slash-command in the prompt, not a bare
mention — Claude Code instead fires a dedicated `Skill` tool event.
It captures; closing an artifact stays an explicit `wiki set <id> status closed`.

## Stamp-template authoring contract

The write hook (PostToolUse) captures on *frontmatter alone* — it sees every file write,
so it decides from what the draft declares, not from a skill identity. To have a draft
auto-filed into the vault on save, stamp its frontmatter with `template: <kind>` (a kind
in `wiki.json`, e.g. `template: slice`) and `project: <name>`; the hook then mints an id
and files it under that kind. A draft already carrying an `id:` whose prefix resolves to
a kind (e.g. `id: PRD-0007`) is also captured, and re-saving a stamped draft is idempotent
(filed once). A draft with neither `template:` nor `id:` is left alone (an ordinary write,
never captured); an `id:`/`template:` that names no registered kind is surfaced as a
warning, never silently dropped. `project:` may be omitted when the repo is linked — the
hook resolves it from the `wiki:begin` pointer block.
