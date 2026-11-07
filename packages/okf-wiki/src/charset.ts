import { WikiError } from "./vault.ts";

// Adapted from wiki-core; HTML declarations must end within the first 1024 bytes
// (HTML Standard charset1024). Never decode beyond that prefix for sniffing.
const HTML_CHARSET_PRESCAN_BYTES = 1024;

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

export function contentTypeOf(header: string | null): { mediaType: string; charset: string | null } {
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
  // Skip comments in the original byte prefix; do not join text around removed comments.
  for (const match of head.matchAll(/<!--[\s\S]*?(?:-->|$)|<meta\b([^>]*)>/gi)) {
    if (match[1] === undefined) continue;
    const attrs = attributes(match[1]);
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

export function decodeWebText(bytes: Buffer, transport: string | null, html: boolean): string {
  return decodeWith(bytes, chooseCharset(bytes, transport, html));
}
