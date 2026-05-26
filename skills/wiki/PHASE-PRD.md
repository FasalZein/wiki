---
based-on: mattpocock/skills/engineering/to-prd@b8be62f
fork-rationale: Preserves product-requirement structure while routing all writes through wiki PRD commands.
---
# Phase: PRD

Goal: create or refine a product requirement that can drive slices.

1. State the user problem, desired outcome, and non-goals.
2. Write acceptance criteria as observable behavior.
3. Link decisions and source material that affect scope.
4. Use `wiki prd create`, `wiki prd set`, and `wiki prd publish`; never edit the PRD file directly.
5. Publish only when the next slice can be cut without guessing.
