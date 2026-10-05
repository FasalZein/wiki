import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { isObject, type Vault } from "./store.ts";
import {
  importTextFile,
  recordObservation,
  resolveImportFile,
  SUPPORTED_TEXT_EXTENSIONS,
  type Extractor,
  type RecordResult,
} from "./sources.ts";
import { WikiError } from "./types.ts";

/**
 * Web and PDF extraction.
 *
 * `pandoc` and `pdftotext` are external programs on PATH. They are not npm
 * dependencies, and this module never installs them. A missing program is an
 * error. There is no fallback parser.
 *
 * Document bytes stay in the original blob. Extracted text is a separate blob.
 * `recordObservation` runs only after extraction succeeds, so a cancelled or
 * failed capture does not leave an observation.
 */

export interface CaptureOptions {
  requestId?: string;
  /** Caller-supplied retrieval time. The default is the UTC time of the response headers. */
  observedAt?: string;
  signal?: AbortSignal;
}

const PANDOC_ARGS = ["-f", "html-smart", "-t", "json", "--sandbox"] as const;
const PDFTOTEXT_ARGS = ["-enc", "UTF-8", "-eol", "unix", "-nopgbrk", "-", "-"] as const;

/**
 * Authoring rule: a charset declaration must be serialized completely within
 * the first 1024 bytes (HTML Standard, charset1024). The encoding sniffing
 * algorithm also encourages a prescan of only that prefix.
 */
const HTML_CHARSET_PRESCAN_BYTES = 1024;

/** Pandoc inline nodes whose `c` is the child inline array (API 1.23, inspected). */
const INLINE_SEQUENCE = new Set(["Emph", "Strong", "Underline", "Strikeout", "Superscript", "Subscript", "SmallCaps"]);

const versions = new Map<string, string>();

function cancelled(): WikiError {
  return new WikiError("unavailable", "capture cancelled before a source observation was recorded");
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelled();
}

function assertObservedAt(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Number.isNaN(Date.parse(value))) {
    throw new WikiError("invalid_input", `observed-at is not a time: ${JSON.stringify(value)}`);
  }
  return value;
}

function missingTool(command: string): WikiError {
  return new WikiError(
    "unavailable",
    `${command} is not on PATH. It is an external runtime dependency and is not installed by this command.`,
  );
}

function toolVersion(command: "pandoc" | "pdftotext"): string {
  const cached = versions.get(command);
  if (cached !== undefined) return cached;
  const args = command === "pandoc" ? ["--version"] : ["-v"];
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw missingTool(command);
    throw new WikiError("unavailable", `${command} failed to start: ${result.error.message}`);
  }
  const blob = `${result.stdout}\n${result.stderr}`;
  const match = command === "pandoc" ? /^pandoc\s+(\S+)/m.exec(blob) : /pdftotext version\s+(\S+)/.exec(blob);
  if (result.status !== 0 || match?.[1] === undefined) {
    throw new WikiError("unavailable", `${command} did not report a usable version:\n${blob.trim()}`);
  }
  versions.set(command, match[1]);
  return match[1];
}

interface ToolOutput {
  code: number | null;
  stdout: Buffer;
  stderr: string;
}

function runTool(command: string, args: readonly string[], input: Uint8Array, signal: AbortSignal | undefined): Promise<ToolOutput> {
  assertNotAborted(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], signal, windowsHide: true });
    if (!child.stdout || !child.stderr || !child.stdin) {
      reject(new WikiError("unavailable", `${command} stdio was not available`));
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on("error", () => undefined);
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(() => {
        if (error.name === "AbortError" || signal?.aborted) reject(cancelled());
        else if (error.code === "ENOENT") reject(missingTool(command));
        else reject(new WikiError("unavailable", `${command} failed to start: ${error.message}`));
      });
    });
    child.on("close", (code) => {
      finish(() => {
        if (signal?.aborted) reject(cancelled());
        else resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8") });
      });
    });
    child.stdin.end(input);
  });
}

function decodeUtf8(bytes: Uint8Array, what: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new WikiError("unsupported", `${what} returned bytes that are not UTF-8; refusing to invent text`);
  }
}

function encodingSupported(label: string): boolean {
  try {
    new TextDecoder(label);
    return true;
  } catch {
    return false;
  }
}

function decodeWith(bytes: Uint8Array, label: string): string {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label, { fatal: true });
  } catch {
    throw new WikiError("unsupported", `unsupported character encoding ${JSON.stringify(label)}; refusing to invent text`);
  }
  try {
    return decoder.decode(bytes);
  } catch {
    throw new WikiError("unsupported", `bytes are not valid ${label}; refusing to invent text`);
  }
}

function bomEncoding(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  return null;
}

function contentTypeOf(header: string | null): { mediaType: string; charset: string | null } {
  if (header === null || header.trim() === "") return { mediaType: "application/octet-stream", charset: null };
  const [rawType, ...params] = header.split(";");
  const mediaType = (rawType ?? "").trim().toLowerCase();
  let charset: string | null = null;
  for (const param of params) {
    const eq = param.indexOf("=");
    if (eq === -1) continue;
    const key = param.slice(0, eq).trim().toLowerCase();
    if (key !== "charset" || charset !== null) continue;
    let value = param.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (value !== "") charset = value.toLowerCase();
  }
  return { mediaType, charset };
}

function attributes(source: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of source.matchAll(/([^\s/="'>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = match[1]?.toLowerCase();
    if (!name || attrs.has(name)) continue;
    attrs.set(name, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

function metaCharset(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, HTML_CHARSET_PRESCAN_BYTES)).toString("latin1");
  for (const match of head.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = attributes(match[1] ?? "");
    const direct = attrs.get("charset");
    if (direct) return direct.toLowerCase();
    if (attrs.get("http-equiv")?.toLowerCase() !== "content-type") continue;
    const found = attrs.get("content")?.match(/charset\s*=\s*["']?\s*([^\s;"']+)/i);
    if (found?.[1]) return found[1].toLowerCase();
  }
  return null;
}

function chooseCharset(bytes: Uint8Array, transport: string | null, html: boolean): string {
  const bom = bomEncoding(bytes);
  if (bom) return bom;
  if (transport) {
    if (encodingSupported(transport)) return transport;
    if (!html) {
      throw new WikiError("unsupported", `unsupported character encoding ${JSON.stringify(transport)}; refusing to invent text`);
    }
  }
  if (html) {
    const meta = metaCharset(bytes);
    if (meta) {
      if (!encodingSupported(meta)) {
        throw new WikiError("unsupported", `unsupported character encoding ${JSON.stringify(meta)}; refusing to invent text`);
      }
      return meta;
    }
  }
  return "utf-8";
}

function arrayAt(value: unknown, index: number): unknown {
  if (!Array.isArray(value)) throw new WikiError("unsupported", "pandoc AST node has an unexpected shape; refusing to invent text");
  return value[index];
}

function asBlocks(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new WikiError("unsupported", "pandoc AST blocks are not a list; refusing to invent text");
  return value;
}

function joinBlocks(parts: string[]): string {
  return parts.filter((part) => part !== "").join("\n");
}

function renderInlines(value: unknown, limitations: Set<string>): string {
  if (!Array.isArray(value)) throw new WikiError("unsupported", "pandoc AST inlines are not a list; refusing to invent text");
  let text = "";
  for (const node of value) {
    if (!isObject(node) || typeof node.t !== "string") {
      throw new WikiError("unsupported", "pandoc AST inline is not an object; refusing to invent text");
    }
    const tag = node.t;
    if (tag === "Str") {
      if (typeof node.c !== "string") throw new WikiError("unsupported", "pandoc Str node is not text; refusing to invent text");
      text += node.c;
    } else if (tag === "Space") text += " ";
    else if (tag === "SoftBreak" || tag === "LineBreak") text += "\n";
    else if (tag === "Code") {
      const code = arrayAt(node.c, 1);
      if (typeof code !== "string") throw new WikiError("unsupported", "pandoc Code node has an unexpected shape; refusing to invent text");
      text += code;
    } else if (INLINE_SEQUENCE.has(tag)) {
      // Emph, Strong, and the other nodes in this set store children directly on `c`.
      text += renderInlines(node.c, limitations);
    } else if (tag === "Link" || tag === "Span" || tag === "Image" || tag === "Quoted") {
      // These nodes store attributes or a quote type at `c[0]` and inlines at `c[1]`.
      text += renderInlines(arrayAt(node.c, 1), limitations);
    } else if (tag === "RawInline") {
      limitations.add("omitted RawInline; raw HTML was not extracted or executed");
    } else {
      throw new WikiError("unsupported", `pandoc AST inline ${tag} is not extracted; refusing to drop or invent its text`);
    }
  }
  return text;
}

function renderTable(value: unknown, limitations: Set<string>): string {
  // Table captions are blocks, not cells; the cell walker alone loses their text.
  const caption = renderBlocks(arrayAt(arrayAt(value, 1), 1), limitations);
  const lines: string[] = caption === "" ? [] : [caption];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      const cell = node[4];
      if (node.length === 5 && Array.isArray(cell) && cell.every((item) => isObject(item) && typeof item.t === "string")) {
        const text = renderBlocks(cell, limitations);
        if (text !== "") lines.push(text);
        return;
      }
      for (const item of node) visit(item);
      return;
    }
    if (isObject(node)) {
      for (const item of Object.values(node)) visit(item);
    }
  };
  visit(value);
  return joinBlocks(lines);
}

function renderFigure(value: unknown, limitations: Set<string>): string {
  const captionWrap = arrayAt(value, 1);
  const caption = Array.isArray(captionWrap) ? captionWrap[1] : [];
  return joinBlocks([renderBlocks(caption, limitations), renderBlocks(arrayAt(value, 2), limitations)]);
}

function renderBlock(block: unknown, limitations: Set<string>): string {
  if (!isObject(block) || typeof block.t !== "string") {
    throw new WikiError("unsupported", "pandoc AST block is not an object; refusing to invent text");
  }
  const tag = block.t;
  const body = block.c;
  switch (tag) {
    case "Para":
    case "Plain":
      return renderInlines(body, limitations);
    case "Header":
      return renderInlines(arrayAt(body, 2), limitations);
    case "CodeBlock": {
      const code = arrayAt(body, 1);
      if (typeof code !== "string") throw new WikiError("unsupported", "pandoc CodeBlock has an unexpected shape; refusing to invent text");
      return code.endsWith("\n") ? code.slice(0, -1) : code;
    }
    case "BlockQuote":
      return renderBlocks(body, limitations);
    case "Div":
      return renderBlocks(arrayAt(body, 1), limitations);
    case "BulletList":
      return joinBlocks(asBlocks(body).map((item) => renderBlocks(item, limitations)));
    case "OrderedList":
      return joinBlocks(asBlocks(arrayAt(body, 1)).map((item) => renderBlocks(item, limitations)));
    case "LineBlock":
      return joinBlocks(asBlocks(body).map((item) => renderInlines(item, limitations)));
    case "Table":
      return renderTable(body, limitations);
    case "Figure":
      return renderFigure(body, limitations);
    case "HorizontalRule":
      return "";
    case "RawBlock":
      limitations.add("omitted RawBlock; raw HTML was not extracted or executed");
      return "";
    default:
      throw new WikiError("unsupported", `pandoc AST block ${tag} is not extracted; refusing to drop or invent its text`);
  }
}

function renderBlocks(value: unknown, limitations: Set<string>): string {
  return joinBlocks(asBlocks(value).map((block) => renderBlock(block, limitations)));
}

function renderTitle(meta: unknown, limitations: Set<string>): string {
  if (!isObject(meta) || !isObject(meta.title)) return "";
  const title = meta.title;
  if (title.t === "MetaInlines") return renderInlines(title.c, limitations);
  if (title.t === "MetaBlocks") return renderBlocks(title.c, limitations);
  if (title.t === "MetaString" && typeof title.c === "string") return title.c;
  throw new WikiError("unsupported", `pandoc title node ${String(title.t)} is not extracted; refusing to drop or invent its text`);
}

/** Turn one Pandoc JSON document into searchable text. Raw HTML is omitted and named, never executed. */
export function renderPandocDocument(ast: unknown): { text: string; limitations: string[] } {
  if (!isObject(ast)) throw new WikiError("unsupported", "pandoc JSON is not an object; refusing to invent text");
  const limitations = new Set<string>();
  const text = joinBlocks([renderTitle(ast.meta, limitations), renderBlocks(ast.blocks, limitations)]);
  return { text, limitations: [...limitations] };
}

async function pandocText(html: string, signal: AbortSignal | undefined): Promise<{ text: string; limitations: string[]; version: string }> {
  const version = toolVersion("pandoc");
  const output = await runTool("pandoc", PANDOC_ARGS, new TextEncoder().encode(html), signal);
  if (output.code !== 0) {
    throw new WikiError("unsupported", `pandoc could not read the HTML; refusing to invent text${output.stderr.trim() ? `: ${output.stderr.trim()}` : ""}`);
  }
  let ast: unknown;
  try {
    ast = JSON.parse(decodeUtf8(output.stdout, "pandoc"));
  } catch (error) {
    if (error instanceof WikiError) throw error;
    throw new WikiError("unsupported", "pandoc did not return JSON; refusing to invent text");
  }
  const rendered = renderPandocDocument(ast);
  return { text: rendered.text, limitations: rendered.limitations, version };
}

function extractor(name: string, version: string, extra: { charset?: string; limitations?: readonly string[] } = {}): Extractor {
  const result: Extractor = { name, version };
  if (extra.charset !== undefined) result.charset = extra.charset;
  if (extra.limitations !== undefined && extra.limitations.length > 0) result.limitations = extra.limitations;
  return result;
}

async function extractPdf(bytes: Uint8Array, signal: AbortSignal | undefined): Promise<{ text: string; extractor: Extractor }> {
  const version = toolVersion("pdftotext");
  const output = await runTool("pdftotext", PDFTOTEXT_ARGS, bytes, signal);
  if (output.code !== 0) {
    const detail = output.stderr.trim();
    throw new WikiError("unsupported", `pdftotext could not read the PDF; refusing to invent its contents${detail ? `: ${detail}` : ""}`);
  }
  return { text: decodeUtf8(output.stdout, "pdftotext"), extractor: extractor("pdftotext", version) };
}

function httpUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WikiError("invalid_input", `web capture URL is not valid: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WikiError("invalid_input", `web capture accepts only http and https URLs, not ${url.protocol}`);
  }
  return url.href;
}

async function extractWebBody(
  bytes: Uint8Array,
  header: string | null,
  signal: AbortSignal | undefined,
): Promise<{ text: string; mediaType: string; extractor: Extractor }> {
  const { mediaType, charset: transport } = contentTypeOf(header);
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") {
    const charset = chooseCharset(bytes, transport, true);
    const html = decodeWith(bytes, charset);
    const rendered = await pandocText(html, signal);
    return {
      text: rendered.text,
      mediaType,
      extractor: extractor("pandoc", rendered.version, { charset, limitations: rendered.limitations }),
    };
  }
  if (mediaType === "text/plain") {
    const charset = chooseCharset(bytes, transport, false);
    return {
      text: decodeWith(bytes, charset),
      mediaType,
      extractor: extractor("text-decoder", process.versions.node, { charset }),
    };
  }
  if (mediaType === "application/pdf") {
    const extracted = await extractPdf(bytes, signal);
    return { text: extracted.text, mediaType, extractor: extracted.extractor };
  }
  throw new WikiError("unsupported", `no extractor for media type ${mediaType}; refusing to invent text`);
}

/** Fetch one URL and retain the response bytes plus extracted text. Does not follow page links. */
export async function captureWeb(vault: Vault, rawUrl: string, options: CaptureOptions = {}): Promise<RecordResult> {
  const observedAt = assertObservedAt(options.observedAt);
  const url = httpUrl(rawUrl);
  assertNotAborted(options.signal);
  let response: Response;
  try {
    response = await fetch(url, { signal: options.signal, redirect: "follow" });
  } catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw cancelled();
    throw new WikiError("unavailable", `web capture failed for ${url}: ${(error as Error).message}`);
  }
  if (response.status < 200 || response.status > 299) {
    await response.body?.cancel();
    throw new WikiError(
      "unavailable",
      `web capture of ${url} failed with HTTP ${response.status} at ${response.url}; no text was extracted`,
    );
  }
  const retrievedAt = observedAt ?? new Date().toISOString();
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw cancelled();
    throw new WikiError("unavailable", `web capture failed while reading ${response.url}: ${(error as Error).message}`);
  }
  assertNotAborted(options.signal);
  const extracted = await extractWebBody(bytes, response.headers.get("content-type"), options.signal);
  assertNotAborted(options.signal);
  return recordObservation(vault, {
    locator: { kind: "web", url, finalUrl: response.url === url ? null : response.url, httpStatus: response.status },
    original: { bytes, mediaType: extracted.mediaType },
    extracted: { text: extracted.text, extractor: extracted.extractor },
    observedAt: retrievedAt,
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
  });
}

/** Import a PDF. Original bytes and pdftotext output are stored separately. */
export async function importPdfFile(vault: Vault, file: string, options: CaptureOptions = {}): Promise<RecordResult> {
  assertObservedAt(options.observedAt);
  assertNotAborted(options.signal);
  const real = resolveImportFile(file);
  const bytes = fs.readFileSync(real);
  const extracted = await extractPdf(bytes, options.signal);
  assertNotAborted(options.signal);
  return recordObservation(vault, {
    locator: { kind: "pdf", path: real },
    original: { bytes, mediaType: "application/pdf" },
    extracted: { text: extracted.text, extractor: extracted.extractor },
    ...(options.observedAt === undefined ? {} : { observedAt: options.observedAt }),
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
  });
}

/** Choose the text or PDF importer from the file extension. Other types are an explicit limitation. */
export async function importDocumentFile(vault: Vault, file: string, options: CaptureOptions = {}): Promise<RecordResult> {
  assertNotAborted(options.signal);
  const real = resolveImportFile(file);
  const ext = path.extname(real).toLowerCase();
  if (SUPPORTED_TEXT_EXTENSIONS.includes(ext)) return importTextFile(vault, real, options.requestId);
  if (ext === ".pdf") return importPdfFile(vault, real, options);
  const supported = [...SUPPORTED_TEXT_EXTENSIONS, ".pdf"].join(", ");
  throw new WikiError("unsupported", `import supports ${supported}; no extractor for ${ext || "files without extension"} (${real})`);
}
