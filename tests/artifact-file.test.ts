import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openArtifact, readFrontmatter, serializeArtifact } from "../src/artifacts/artifact-file";
import type { Schema } from "../src/schema/types";

// The ArtifactFile module (ADR-0045 item 2), tested in-process — the narrowed
// write, the field read, and the revalidating write, no subprocess, no vault.

const dirs: string[] = [];
async function fixture(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "artifact-file-"));
  dirs.push(dir);
  const path = join(dir, "X-1-thing.md");
  await writeFile(path, content);
  return path;
}
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

// Canonical on-disk shape: no blank line after the frontmatter (renderArtifact
// trimStarts), so the body round-trips verbatim through the narrowed write.
const BODY = "## Section\n\nprose here\n";
const CANONICAL = `---\nid: X-1\ntitle: The Thing\nstatus: active\nupdated: '2020-01-01'\n---\n${BODY}`;

describe("openArtifact read", () => {
  test(".data / .body / .field", async () => {
    const file = await openArtifact(await fixture(CANONICAL));
    expect(file.data.id).toBe("X-1");
    expect(file.field("title")).toBe("The Thing");
    expect(file.body).toBe(BODY);
  });

  test(".field is undefined for a missing or non-string field", async () => {
    const file = await openArtifact(await fixture(CANONICAL));
    expect(file.field("nope")).toBeUndefined();
  });
});

describe("rewriteFrontmatter (narrowed write)", () => {
  test("merges the patch, re-stamps updated, keeps the body verbatim", async () => {
    const path = await fixture(CANONICAL);
    const file = await openArtifact(path);
    const written = await file.rewriteFrontmatter({ superseded_by: "X-2" });

    expect(written.superseded_by).toBe("X-2");
    expect(written.title).toBe("The Thing"); // untouched keys survive the merge
    const today = new Date().toISOString().slice(0, 10);
    expect(written.updated).toBe(today);

    const reread = await openArtifact(path);
    expect(reread.field("superseded_by")).toBe("X-2");
    expect(reread.field("updated")).toBe(today);
    expect(reread.body).toBe(BODY); // body verbatim
  });

  test("does NOT validate against a schema — a stale target still writes", async () => {
    // A pre-schema artifact: only an id, none of today's required fields. A
    // revalidating write would reject it; the narrowed write must not.
    const stale = "---\nid: X-9\nlegacy_only: kept\n---\n## Old\n\nbody\n";
    const path = await fixture(stale);
    const file = await openArtifact(path);
    await file.rewriteFrontmatter({ superseded_by: "X-2" });

    const reread = await openArtifact(path);
    expect(reread.field("superseded_by")).toBe("X-2");
    expect(reread.field("legacy_only")).toBe("kept"); // stale field passes through
    expect(reread.body).toBe("## Old\n\nbody\n");
  });
});

describe("replaceValidated (revalidating write)", () => {
  const schema: Schema = {
    template: "thing",
    version: 1,
    fields: [{ name: "title", type: "string", required: true, constraints: { min: 3 } }],
  };

  test("rejects an invalid record and leaves the file untouched", async () => {
    const path = await fixture(CANONICAL);
    const before = await readFile(path, "utf8");
    const file = await openArtifact(path);
    const result = await file.replaceValidated(schema, { title: "no" }); // < min 3

    expect(result.ok).toBe(false);
    expect(await readFile(path, "utf8")).toBe(before); // no write on failure
  });

  test("writes the normalized record when valid", async () => {
    const path = await fixture(CANONICAL);
    const file = await openArtifact(path);
    const result = await file.replaceValidated(schema, { title: "long enough" });

    expect(result.ok).toBe(true);
    const reread = await openArtifact(path);
    expect(reread.field("title")).toBe("long enough");
    expect(reread.field("updated")).toBe(new Date().toISOString().slice(0, 10));
  });
});

describe("serializeArtifact / readFrontmatter round-trip", () => {
  test("serialize is idempotent through a parse", () => {
    const first = serializeArtifact({ id: "X-1", title: "The Thing" }, BODY);
    const { data, body } = readFrontmatter(first);
    expect(serializeArtifact(data, body)).toBe(first);
  });
});
