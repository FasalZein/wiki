---
source: wiki-v2
---
# Admin: migration

Reference doc for moving v1 vault content into wiki-v2. There is no automated
migration command yet — this is a manual, project-by-project process.

## Projects to migrate

- wiki-forge
- cloak
- code-forge

## Steps per project

### 1. Create the v2 project

```
wiki project create <name>
```

### 2. Map v1 folders to v2 structure

| v1 location     | v2 destination                | Notes                          |
|-----------------|-------------------------------|--------------------------------|
| `specs/`        | `projects/<name>/prds/`       | Each spec becomes a PRD        |
| `forge/slices/` | `projects/<name>/slices/`     | Slice schema has new fields    |
| `forge/`        | archive or discard            | State files are not migrated   |
| `research/`     | stays external                | Not part of wiki-v2 vault      |
| `decisions/`    | `projects/<name>/decisions/`  | Field renames apply            |

### 3. Migrate frontmatter to v2 schema

Common field mappings (v1 -> v2):

| v1 field         | v2 field           | Notes                              |
|------------------|--------------------|------------------------------------|
| `spec_id`        | `id`               | Pattern changes to `PRD-NNN`       |
| `spec_status`    | `status`           | Values: draft/ready/in-progress/closed/superseded |
| `slice_status`   | `status`           | Values: planned/red/green/closed/blocked |
| `depends_on`     | `blocked_by`       | Now a link_list, not a string      |
| `test_evidence`  | `red_log_ref` / `green_log_ref` | Split into two fields   |
| `tags`           | `domain_terms`     | Must reference domain-language.md  |

After updating frontmatter, validate each artifact:

```
wiki validate <artifact-file>
```

For field updates, use Obsidian primitives directly:

```
obsidian property:set <artifact-file> <field> <value>
```

### 4. Verify

```
wiki doctor
```

Doctor reports schema violations, missing required fields, and broken links.
Fix all reported issues before considering the project migrated.

Manual review: open each PRD and slice in Obsidian to confirm rendering and
Dataview queries pick them up correctly.

## What to discard

- v1 state files (`.forge-state`, `.forge-lock`)
- v1 lock files (`forge.lock`)
- v1 session logs (replaced by wiki handover artifacts)
- Orphan template copies that don't match v2 templates
