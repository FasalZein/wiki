import { type CheckRecord, latestCheck, loadChecks } from "./checks.ts";
import { readAtCommit, type ResolvedRepo, resolveRepo } from "./code.ts";
import { loadNote } from "./notes.ts";
import { evidenceDigest, loadObservation, type SourceLocator, verifyObservationBlobs } from "./sources.ts";
import { sha256, type Vault } from "./store.ts";
import { type Authority, type Digest, type TrustStatus, WikiError } from "./types.ts";

/** Per-source result. `current` means the bound snapshot still matches its source. */
export type SourceState = "current" | "retained" | "changed" | "unavailable" | "invalid";

export interface SourceStatus {
  observationId: string;
  /** Digest the check bound to. */
  digest: Digest;
  state: SourceState;
  reason: string;
  locator: SourceLocator | null;
  /** Retrieval or capture time of the retained snapshot. */
  observedAt: string | null;
}

export interface ReadResult {
  id: string;
  path: string;
  authority: Authority;
  title: string | null;
  /** Digest of the exact bytes `body` came from; `status` describes this content. */
  digest: Digest;
  body: string;
  status: TrustStatus;
  reasons: string[];
  check: Pick<CheckRecord, "id" | "outcome" | "checker" | "recordedAt" | "noteDigest"> | null;
  sources: SourceStatus[];
  /** Repositories resolved during this read, once each, with local-only scope. */
  repos: ResolvedRepo[];
}

/** Frontmatter keys that look like trust claims. They are reported and never trusted. */
const HAND_AUTHORED_TRUST_KEYS = ["status", "trust", "verified", "attested", "checked", "evidence"];

export function readNote(vault: Vault, id: string): ReadResult {
  const note = loadNote(vault, id);
  const reasons: string[] = [];
  for (const key of HAND_AUTHORED_TRUST_KEYS) {
    if (key in note.frontmatter) reasons.push(`ignored hand-authored frontmatter field "${key}"; trust comes only from the evidence log`);
  }
  const base = {
    id: note.id,
    path: note.path,
    authority: note.authority,
    title: note.title,
    digest: note.digest,
    body: note.body,
  };
  const result = (status: TrustStatus, check: CheckRecord | null, sources: SourceStatus[], repos: ResolvedRepo[]): ReadResult => ({
    ...base,
    status,
    reasons,
    check: check && {
      id: check.id,
      outcome: check.outcome,
      checker: check.checker,
      recordedAt: check.recordedAt,
      noteDigest: check.noteDigest,
    },
    sources,
    repos,
  });

  if (note.authority === "personal") {
    reasons.push("owner-authored note; no external evidence required");
    return result("owner-authored", null, [], []);
  }
  if (note.authority === "record") {
    reasons.push(`dated historical record${note.frontmatter.created ? ` created ${note.frontmatter.created}` : ""}`);
    return result("historical", null, [], []);
  }
  if (note.frontmatter.superseded_by) {
    reasons.push(`superseded by ${note.frontmatter.superseded_by}`);
    return result("superseded", null, [], []);
  }

  let check: CheckRecord | null;
  try {
    check = latestCheck(loadChecks(vault, note.id));
  } catch (error) {
    reasons.push(`evidence log unusable: ${(error as Error).message}`);
    return result("invalid", null, [], []);
  }
  if (!check) {
    reasons.push("no check recorded");
    return result("unchecked", null, [], []);
  }

  const repos = new Map<string, ResolvedRepo>();
  const sources = check.sources.map((binding) => sourceStatus(vault, binding, repos));
  const states = new Set(sources.map((s) => s.state));
  const noteChanged = check.noteDigest !== note.digest;
  if (noteChanged) reasons.push(`note content changed since check ${check.id} (checked ${check.noteDigest})`);
  for (const s of sources) if (s.state !== "current" && s.state !== "retained") reasons.push(`${s.observationId}: ${s.reason}`);

  let status: TrustStatus;
  if (states.has("invalid")) status = "invalid";
  else if (states.has("unavailable")) status = "unavailable";
  else if (noteChanged || states.has("changed")) status = "changed";
  else status = check.outcome === "contradicts" ? "contradicted" : "attested";
  if (status === "attested") {
    reasons.push(`checked by ${check.checker.name} (${check.checker.method}, asserted, not authenticated) at ${check.recordedAt}`);
  }
  return result(status, check, sources, [...repos.values()]);
}

function sourceStatus(vault: Vault, binding: CheckRecord["sources"][number], repos: Map<string, ResolvedRepo>): SourceStatus {
  const out = (state: SourceState, reason: string, locator: SourceLocator | null = null, observedAt: string | null = null): SourceStatus => ({
    observationId: binding.observationId,
    digest: binding.digest,
    state,
    reason,
    locator,
    observedAt,
  });
  let observation;
  try {
    observation = loadObservation(vault, binding.observationId);
    verifyObservationBlobs(vault, observation);
  } catch (error) {
    if (error instanceof WikiError) return out("invalid", error.message);
    throw error;
  }
  const { locator, observedAt } = observation;
  if (evidenceDigest(observation) !== binding.digest) {
    return out("invalid", "observation digest differs from the digest the check bound to", locator, observedAt);
  }
  if (locator.kind !== "code") {
    return out("retained", `retained snapshot from ${observedAt}; not re-fetched or re-imported by this read`, locator, observedAt);
  }
  let repo = repos.get(locator.repo);
  if (!repo) {
    repo = resolveRepo(vault, locator.repo);
    repos.set(locator.repo, repo);
  }
  if (!repo.ok) return out("unavailable", repo.reason, locator, observedAt);
  const bytes = readAtCommit(repo, locator.path);
  if (bytes === null) return out("changed", `${locator.path} is missing at ${repo.ref} (${repo.commit})`, locator, observedAt);
  if (sha256(bytes) !== binding.digest) {
    return out("changed", `${locator.path} differs at ${repo.ref} (${repo.commit}) from checked commit ${locator.commit}`, locator, observedAt);
  }
  return out("current", `${locator.path} matches at ${repo.ref} (${repo.commit})`, locator, observedAt);
}
