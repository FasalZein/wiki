import { describe, expect, test } from "bun:test";
import matter from "gray-matter";

import { renderArtifact } from "../src/artifacts/render";

// renderArtifact now takes the template BODY (frontmatter already stripped by the
// Kind); pass the body directly instead of a full ---frontmatter--- template.
function renderedBody(body: string, values: Record<string, unknown>): string {
  return matter(renderArtifact(body, values)).content;
}

describe("renderArtifact each-blocks", () => {
  test("expands an each-block over list values with {{this}}", () => {
    const out = renderedBody("{{#each acceptance}}- [ ] {{this}}\n{{/each}}", {
      acceptance: ["first criterion", "second criterion"],
    });
    expect(out).toContain("- [ ] first criterion\n- [ ] second criterion\n");
    expect(out).not.toContain("{{");
  });

  test("renders the else branch when the list is empty", () => {
    const out = renderedBody(
      "{{#each slices}}- [[{{this}}]]\n{{else}}_None yet. Run `wiki slice create --prd {{id}}` to add._{{/each}}",
      { slices: [], id: "PRD-0009" },
    );
    expect(out).toContain("_None yet. Run `wiki slice create --prd PRD-0009` to add._");
    expect(out).not.toContain("{{");
  });

  test("renders the else branch when the field is missing", () => {
    const out = renderedBody("{{#each tags}}`{{this}}` {{else}}_none_{{/each}}", {});
    expect(out).toContain("_none_");
    expect(out).not.toContain("{{");
  });

  test("renders nothing for an empty list without an else branch", () => {
    const out = renderedBody(
      "## Acceptance criteria\n\n{{#each acceptance}}- [ ] {{this}}\n{{/each}}\n## Todo",
      { acceptance: [] },
    );
    expect(out).toContain("## Acceptance criteria");
    expect(out).toContain("## Todo");
    expect(out).not.toContain("{{");
  });

  test("expands wiki links for link_list values", () => {
    const out = renderedBody("{{#each blocked_by}}- [[{{this}}]]\n{{else}}None — can start immediately.\n{{/each}}", {
      blocked_by: ["SLICE-0001", "SLICE-0002"],
    });
    expect(out).toContain("- [[SLICE-0001]]\n- [[SLICE-0002]]\n");
    expect(out).not.toContain("{{");
  });
});
