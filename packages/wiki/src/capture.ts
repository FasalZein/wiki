import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { extractPdf } from "./pdf.ts";
import { assertCaptureActive } from "./extract-process.ts";
import { fetchResource, extractWeb } from "./web.ts";
import { loadRegistry, safeName, schemaDiagnostics, type Diagnostic } from "./registry.ts";
import { containedEntry, WikiError, type Vault } from "./vault.ts";
import { parseNoteText } from "./frontmatter.ts";
import type { HeldLock } from "./mutation.ts";
import { publish, ValidationError } from "./publication.ts";
import { missingHeadings, parseMarkdown } from "./markdown.ts";

export interface TextCaptureRequest {
  input: string; scope: string; title: string; description: string; slug: string;
}
export interface CaptureAsset { path: string; bytes: Buffer; digest: string }
export interface TextCaptureCandidate {
  path: string; sourceMarkdown: string; digest: string;
  assets: [CaptureAsset, CaptureAsset];
}
export class CaptureValidationError extends ValidationError {
  constructor(diagnostics: Diagnostic[]) { super(diagnostics, "Source capture validation failed; inspect diagnostics and repair the registry or request explicitly"); }
}
const digest = (bytes: Buffer | string) => "sha256:" + createHash("sha256").update(bytes).digest("hex");

function isCaptureScope(scope: string): boolean {
  return scope === "personal" || scope.startsWith("projects/") && safeName(scope.slice(9));
}

function validateCaptureLocation(request: TextCaptureRequest, source: ReturnType<typeof loadRegistry>["types"][number]): void {
  if (!isCaptureScope(request.scope)) throw new WikiError("usage", "Capture requires explicit personal or projects/<safe-project> scope");
  if (source.record.scopes && !source.record.scopes.includes(request.scope)) throw new WikiError("usage", "Source type is not allowed in scope " + request.scope);
  if (!safeName(request.slug)) throw new WikiError("usage", "Capture requires an explicit safe non-reserved lowercase hyphenated slug");
}

/** Read-only preparation. The publisher must recheck under the mutation lock before effects.
 * No implicit size limit: the selected document and rendered source are held in memory.
 */
function planCapture(vault: Vault, request: TextCaptureRequest) {
  const registry = loadRegistry(vault.root);
  if (registry.diagnostics.length) throw new CaptureValidationError(registry.diagnostics);
  const source = registry.types.find(type => type.record.name === "source");
  if (!source) throw new WikiError("usage", "Capture requires a registered source type; explicitly register source before capture; no registry repair performed");
  validateCaptureLocation(request, source);
  const relative = request.scope + "/" + source.record.folder + "/" + request.slug + ".md";
  const assetDirectory = request.scope + "/assets/" + request.slug;
  for (const destination of [relative, assetDirectory]) if (vault.entry(destination).stat) throw new WikiError("conflict", "Existing capture destination: " + destination);
  return { request, source, relative, assetDirectory };
}

interface CapturedResource {
  original: Buffer; resource: string; finalResource?: string; retrieved: string;
  mediaType: string; extension: string;
}

function readRegularCaptureFile(input: string, pdf: boolean): Buffer {
  // POSIX FIFOs must not wait for a writer before descriptor-based validation.
  const fd = fs.openSync(input, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  let original: Buffer;
  try {
    if (!fs.fstatSync(fd).isFile()) throw new WikiError("unsupported", (pdf ? "PDF" : "Text") + " capture input must be a regular file");
    original = fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
  return original;
}

function localMediaType(extension: string): string {
  if (extension === ".pdf") return "application/pdf";
  return [".md", ".markdown"].includes(extension) ? "text/markdown" : "text/plain";
}

function readCapture(vault: Vault, request: TextCaptureRequest, pdf = false): ReturnType<typeof planCapture> & CapturedResource {
  const planned = planCapture(vault, request);
  const extension = path.extname(request.input).toLowerCase();
  if (!(pdf ? [".pdf"] : [".txt", ".text", ".md", ".markdown"]).includes(extension)) throw new WikiError("unsupported", "Unsupported text capture extension: " + (extension || "<none>") + "; use .txt, .text, .md, or .markdown");
  const input = path.resolve(request.input);
  const original = readRegularCaptureFile(input, pdf);
  return { ...planned, extension, original, retrieved: new Date().toISOString(),
    resource: pathToFileURL(input).href,
    mediaType: localMediaType(extension) };
}

export function prepareTextCapture(vault: Vault, request: TextCaptureRequest): TextCaptureCandidate {
  const captured = readCapture(vault, request);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(captured.original); }
  catch { throw new WikiError("unsupported", "Text capture input is not valid UTF-8; no source note published"); }
  return renderCapture(captured, { text, bytes: Buffer.from(text, "utf8"), extractor: "wiki:utf8", version: "1" });
}

/** The same captured buffer feeds retention and extraction; never reopen or refetch. */
export async function prepareCapture(vault: Vault, request: TextCaptureRequest, signal: AbortSignal): Promise<TextCaptureCandidate> {
  assertCaptureActive(signal);
  if (/^[a-z][a-z0-9+.-]*:/i.test(request.input)) {
    const planned = planCapture(vault, request);
    const fetched = await fetchResource(request.input, signal);
    const extracted = await extractWeb(fetched.original, fetched.mediaType, fetched.charset, signal);
    assertCaptureActive(signal);
    return renderCapture({ ...planned, ...fetched }, extracted);
  }
  if (path.extname(request.input).toLowerCase() !== ".pdf") return prepareTextCapture(vault, request);
  const captured = readCapture(vault, request, true);
  const extracted = await extractPdf(captured.original, signal);
  assertCaptureActive(signal);
  return renderCapture(captured, { ...extracted, extractor: "pdftotext" });
}

function captureLimitations(extraction: { limitations?: string[] }, extension: string, text: string): { limitations?: string[] } {
  return extraction.limitations?.length ? { limitations: extraction.limitations } : extension === ".pdf" && text.trim() === "" ? { limitations: ["PDF has no extracted text layer; no OCR performed"] } : {};
}

function renderCapture(captured: ReturnType<typeof readCapture>, extraction: { text: string; bytes: Buffer; extractor: string; version: string; limitations?: string[] }): TextCaptureCandidate {
  const { request, source, relative, assetDirectory, extension, resource, finalResource, mediaType, original, retrieved } = captured;
  const { text, bytes: extracted } = extraction;
  const assets: TextCaptureCandidate["assets"] = [
    { path: assetDirectory + "/original" + extension, bytes: original, digest: digest(original) },
    { path: assetDirectory + "/extracted.txt", bytes: extracted, digest: digest(extracted) },
  ];
  const data = { type: "source", title: request.title, description: request.description, created: retrieved,
    resource, retrieved, ...(finalResource === undefined ? {} : { final_resource: finalResource }),
    original: assets[0].path, original_sha256: assets[0].digest,
    extracted: assets[1].path, extracted_sha256: assets[1].digest,
    ...captureLimitations(extraction, extension, text),
    extractor: extraction.extractor, extractor_version: extraction.version, media_type: mediaType };
  if (!source.validate(data)) throw new CaptureValidationError(schemaDiagnostics(relative, source.validate.errors));
  // Longer than every run, including indented/trailing-space closing attempts.
  let longestRun = 2;
  for (const match of text.matchAll(/~+/g)) longestRun = Math.max(longestRun, match[0].length);
  const fence = "~".repeat(longestRun + 1);
  const links = "[Original](" + path.posix.relative(path.posix.dirname(relative), assets[0].path) + ") · [Extracted text](" + path.posix.relative(path.posix.dirname(relative), assets[1].path) + ")";
  const body = links + "\n\n## Extracted Text\n\n" + fence + "text\n" + text + (text.endsWith("\n") ? "" : "\n") + fence + "\n";
  const absent = missingHeadings(parseMarkdown(body), source.record.requiredHeadings, "source");
  if (absent.length) throw new WikiError("usage", "Source capture: " + absent.join("; "));
  const sourceMarkdown = "---\n" + Object.entries(data).map(([key, value]) => key + ": " + JSON.stringify(value)).join("\n") + "\n---\n" + body;
  return { path: relative, sourceMarkdown, digest: digest(sourceMarkdown), assets };
}


/** Revalidate the current registry and whole prospective vault, then publish under the held lock. */
export function publishTextCapture(lock: HeldLock, candidate: TextCaptureCandidate) {
  const root = lock.root;
  const { frontmatter } = parseNoteText(candidate.sourceMarkdown);
  const directory = path.posix.dirname(candidate.assets[0].path);
  for (const destination of [candidate.path, directory]) if (containedEntry(root, destination).stat) throw new WikiError("conflict", "Existing capture destination: " + destination);
  const files = [...candidate.assets, { path: candidate.path, bytes: Buffer.from(candidate.sourceMarkdown, "utf8"), digest: candidate.digest }];
  const { paths, digests } = publish(lock, { kind: "capture", directory, files, path: candidate.path, markdown: candidate.sourceMarkdown, assets: candidate.assets, digest: candidate.digest,
    duplicate: "Duplicate normalized title at " + candidate.path }).written;
  return { ...frontmatter, path: candidate.path, digest: candidate.digest, written: true as const, paths, digests,
    assets: candidate.assets.map(asset => ({ path: asset.path, digest: asset.digest })) };
}
