import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadRegistry, openVault, safeName, schemaDiagnostics, type Diagnostic } from "./registry.ts";
import { containedEntry, WikiError } from "./vault.ts";
import { missingHeadings, parseMarkdown } from "./markdown.ts";

export interface TextCaptureRequest {
  input: string; scope: string; title: string; description: string; slug: string;
}
export interface CaptureAsset { path: string; bytes: Buffer; digest: string }
export interface TextCaptureCandidate {
  path: string; sourceMarkdown: string; digest: string;
  assets: [CaptureAsset, CaptureAsset];
}
export class CaptureValidationError extends WikiError {
  readonly diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) {
    super("usage", "Source capture validation failed; inspect diagnostics and repair the registry or request explicitly");
    this.diagnostics = diagnostics;
  }
}
const digest = (bytes: Buffer | string) => "sha256:" + createHash("sha256").update(bytes).digest("hex");

/** Read-only preparation. The publisher must recheck under the mutation lock before effects.
 * No implicit size limit: the selected document and rendered source are held in memory.
 */
export function prepareTextCapture(vault: string, request: TextCaptureRequest): TextCaptureCandidate {
  const root = openVault(vault);
  const registry = loadRegistry(root);
  if (registry.diagnostics.length) throw new CaptureValidationError(registry.diagnostics);
  const source = registry.types.find(type => type.record.name === "source");
  if (!source) throw new WikiError("usage", "Capture requires a registered source type; explicitly register source before capture; no registry repair performed");
  if (request.scope !== "personal" && !(request.scope.startsWith("projects/") && safeName(request.scope.slice(9)))) throw new WikiError("usage", "Capture requires explicit personal or projects/<safe-project> scope");
  if (source.record.scopes && !source.record.scopes.includes(request.scope)) throw new WikiError("usage", "Source type is not allowed in scope " + request.scope);
  if (!safeName(request.slug)) throw new WikiError("usage", "Capture requires an explicit safe non-reserved lowercase hyphenated slug");
  const relative = request.scope + "/" + source.record.folder + "/" + request.slug + ".md";
  const assetDirectory = request.scope + "/assets/" + request.slug;
  for (const destination of [relative, assetDirectory]) if (containedEntry(root, destination).stat) throw new WikiError("conflict", "Existing capture destination: " + destination);
  const extension = path.extname(request.input).toLowerCase();
  if (![".txt", ".text", ".md", ".markdown"].includes(extension)) throw new WikiError("unsupported", "Unsupported text capture extension: " + (extension || "<none>") + "; use .txt, .text, .md, or .markdown");
  const input = path.resolve(request.input);
  // POSIX FIFOs must not wait for a writer before descriptor-based validation.
  const fd = fs.openSync(input, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  let original: Buffer;
  try {
    if (!fs.fstatSync(fd).isFile()) throw new WikiError("unsupported", "Text capture input must be a regular file");
    original = fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(original); }
  catch { throw new WikiError("unsupported", "Text capture input is not valid UTF-8; no source note published"); }
  const extracted = Buffer.from(text, "utf8");
  const assets: TextCaptureCandidate["assets"] = [
    { path: assetDirectory + "/original" + extension, bytes: original, digest: digest(original) },
    { path: assetDirectory + "/extracted.txt", bytes: extracted, digest: digest(extracted) },
  ];
  const retrieved = new Date().toISOString();
  const data = { type: "source", title: request.title, description: request.description, created: retrieved,
    resource: pathToFileURL(input).href, retrieved,
    original: assets[0].path, original_sha256: assets[0].digest,
    extracted: assets[1].path, extracted_sha256: assets[1].digest,
    extractor: "okf-wiki:utf8", extractor_version: "1", media_type: extension === ".md" || extension === ".markdown" ? "text/markdown" : "text/plain" };
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
