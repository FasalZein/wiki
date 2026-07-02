/**
 * The artifact DOCUMENT (ADR-0045 item 2): a markdown file that is a frontmatter
 * record plus a body. `openArtifact(path)` is the single seam that owns the
 * frontmatter read (`.data`/`.body`/`.field`) and the two writes, so gray-matter
 * is imported here instead of at a dozen call sites, and each write invariant has
 * exactly one implementation.
 *
 * Two writes, deliberately distinct:
 *  - {@link ArtifactFile.rewriteFrontmatter} — the NARROWED write (PRD-0020):
 *    merge a patch onto the existing frontmatter, re-stamp `updated`, keep the
 *    body verbatim, and do NOT re-validate against today's schema. A target
 *    authored under an older schema can still be superseded / scrubbed / relocated
 *    — the write marks or moves it, it does not repair it.
 *  - {@link ArtifactFile.replaceValidated} — the REVALIDATING write used by
 *    `set`/`set-fields`: validate the full record against the schema first, and
 *    write only the normalized result.
 *
 * Custom-transform writers (a fresh render, a pruned link set, a re-ordered
 * frontmatter) that fit neither shape use {@link serializeArtifact} — the one
 * `matter.stringify` wrapper — with the body they already hold.
 */

import matter from "gray-matter";
import { readFile } from "node:fs/promises";

import { validate } from "../schema/validate";
import type { NormalizedRecord, Schema } from "../schema/types";

/** Today as `YYYY-MM-DD` — the `updated` stamp both writes share. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The `matter.stringify` wrapper (frontmatter first). The one place gray-matter
 *  serializes an artifact, so byte behaviour — key order, body handling — is
 *  defined once. `body` is written verbatim; callers trim it if their contract
 *  requires it (renderArtifact and the narrowed writes trimStart). */
export function serializeArtifact(data: Record<string, unknown>, body: string): string {
  return matter.stringify(body, data);
}

/** Parse frontmatter + body from content already in hand (no file read). Used by
 *  sites that hold the string — an in-memory fmt pipeline, a just-read draft. */
export function readFrontmatter(content: string): { data: Record<string, unknown>; body: string } {
  const parsed = matter(content);
  return { data: parsed.data as Record<string, unknown>, body: parsed.content };
}

/** A parsed artifact document bound to its path, exposing the frontmatter read and
 *  the two writes. `body` is the raw `matter` content (verbatim); the narrowed
 *  writes trimStart it to match the canonical rendered shape. */
export class ArtifactFile {
  readonly data: Record<string, unknown>;
  readonly body: string;

  constructor(readonly path: string, content: string) {
    const parsed = readFrontmatter(content);
    this.data = parsed.data;
    this.body = parsed.body;
  }

  /** A frontmatter value when it is a string, else undefined. */
  field(name: string): string | undefined {
    const value = this.data[name];
    return typeof value === "string" ? value : undefined;
  }

  /**
   * The narrowed write: merge `patch` onto the existing frontmatter, re-stamp
   * `updated`, keep the body verbatim, and DO NOT validate against today's schema
   * (the PRD-0020 stale-target invariant). Writes to `targetPath` when given (a
   * relocate lands the merged record at a new path), else in place. Returns the
   * written frontmatter record so callers can report it without re-reading.
   */
  async rewriteFrontmatter(patch: Record<string, unknown>, targetPath?: string): Promise<NormalizedRecord> {
    const data = { ...this.data, ...patch, updated: today() } as NormalizedRecord;
    await Bun.write(targetPath ?? this.path, serializeArtifact(data, this.body.trimStart()));
    return data;
  }

  /**
   * The revalidating write: validate `fields` (with a fresh `updated`) against
   * `schema` and, only when valid, write the normalized result back in place. The
   * caller inspects the returned result and maps a failure to its own error.
   */
  async replaceValidated(schema: Schema, fields: Record<string, unknown>): Promise<ReturnType<typeof validate>> {
    const result = validate(schema, { ...fields, updated: today() });
    if (result.ok) {
      await Bun.write(this.path, serializeArtifact(result.value, this.body.trimStart()));
    }
    return result;
  }
}

/** Open and parse the artifact document at `path`. Rejects (does not swallow) a
 *  read failure — callers that treat a missing file as a soft outcome catch it. */
export async function openArtifact(path: string): Promise<ArtifactFile> {
  return new ArtifactFile(path, await readFile(path, "utf8"));
}
