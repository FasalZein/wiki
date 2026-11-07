import { MIMEType } from "node:util";
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
  let mime: MIMEType;
  try { mime = new MIMEType(header); }
  catch { throw new WikiError("unsupported", "Invalid Content-Type; refusing to invent text"); }
  const charset = mime.params.get("charset");
  return { mediaType: mime.essence, charset: charset ? charset.toLowerCase() : null };
}

const HTML_SPACE = /[\t\n\f\r ]/;

function attributes(source: string): Map<string, string> {
  const attrs = new Map<string, string>();
  let position = 0;
  while (position < source.length) {
    while (HTML_SPACE.test(source.charAt(position)) || source.charAt(position) === "/") position++;
    const start = position;
    while (position < source.length && !/[\t\n\f\r /=]/.test(source.charAt(position))) position++;
    if (position === start) { position++; continue; }
    const name = source.slice(start, position).toLowerCase();
    while (HTML_SPACE.test(source.charAt(position))) position++;
    let value = "";
    if (source.charAt(position) === "=") {
      position++;
      while (HTML_SPACE.test(source.charAt(position))) position++;
      const quote = source.charAt(position);
      if (quote === '"' || quote === "'") {
        const end = source.indexOf(quote, position + 1);
        // The complete tag scan guarantees a closing quote for each quoted value.
        if (end === -1) return attrs;
        value = source.slice(position + 1, end);
        position = end + 1;
      } else {
        const start = position;
        while (position < source.length && !HTML_SPACE.test(source.charAt(position))) position++;
        value = source.slice(start, position);
      }
    }
    if (!attrs.has(name)) attrs.set(name, value);
  }
  return attrs;
}

function tagEnd(source: string, start: number): number {
  let quote: string | undefined;
  for (let position = start; position < source.length; position++) {
    const char = source.charAt(position);
    if (quote !== undefined) { if (char === quote) quote = undefined; }
    else if (char === '"' || char === "'") quote = char;
    else if (char === ">") return position;
  }
  return -1;
}

function metaCharset(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, HTML_CHARSET_PRESCAN_BYTES)).toString("latin1");
  let position = 0;
  while ((position = head.indexOf("<", position)) !== -1) {
    if (head.startsWith("<!--", position)) {
      const end = head.indexOf("-->", position + 4);
      if (end === -1) return null;
      position = end + 3;
      continue;
    }
    const tag = /^<([a-z][^\t\n\f\r />]*)/i.exec(head.slice(position));
    if (!tag && !/^<[!/?]/.test(head.slice(position))) { position++; continue; }
    // Consume whole tags, including other tags' quoted attributes. A quoted >
    // cannot complete a declaration, and a real end outside the prefix is ignored.
    const end = tagEnd(head, position + 1);
    if (end === -1) return null;
    const start = position;
    position = end + 1;
    if (tag?.[1]?.toLowerCase() !== "meta") continue;
    const attrs = attributes(head.slice(start + tag[0].length, end));
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
