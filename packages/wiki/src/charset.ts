import { MIMEType } from "node:util";
import { WikiError } from "./vault.ts";

// Adapted from the former Node core package (removed in #41; see git history).
// HTML declarations must end within the first 1024 bytes
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
  if (Buffer.from([0xef, 0xbb, 0xbf]).equals(bytes.subarray(0, 3))) return "utf-8";
  if (Buffer.from([0xff, 0xfe]).equals(bytes.subarray(0, 2))) return "utf-16le";
  if (Buffer.from([0xfe, 0xff]).equals(bytes.subarray(0, 2))) return "utf-16be";
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

function attributeValue(source: string, position: number): { value: string; end: number } | undefined {
  const quote = source.charAt(position);
  if (["\"", "'"].includes(quote)) {
    const end = source.indexOf(quote, position + 1);
    // The complete tag scan guarantees a closing quote for each quoted value.
    if (end === -1) return undefined;
    return { value: source.slice(position + 1, end), end: end + 1 };
  }
  const start = position;
  while (position < source.length && !HTML_SPACE.test(source.charAt(position))) position++;
  return { value: source.slice(start, position), end: position };
}

function attributes(source: string): Map<string, string> {
  const attrs = new Map<string, string>();
  let position = 0;
  while (position < source.length) {
    position += /^[\t\n\f\r /]*/.exec(source.slice(position))![0].length;
    const name = /^[^\t\n\f\r /=]+/.exec(source.slice(position));
    if (!name) { position++; continue; }
    position += name[0].length;
    position += /^[\t\n\f\r ]*/.exec(source.slice(position))![0].length;
    let value = "";
    if (source.charAt(position) === "=") {
      position++;
      position += /^[\t\n\f\r ]*/.exec(source.slice(position))![0].length;
      const parsed = attributeValue(source, position);
      if (!parsed) return attrs;
      value = parsed.value;
      position = parsed.end;
    }
    const key = name[0].toLowerCase();
    if (!attrs.has(key)) attrs.set(key, value);
  }
  return attrs;
}

function tagEnd(source: string, start: number): number {
  let quote: string | undefined;
  for (let position = start; position < source.length; position++) {
    const char = source.charAt(position);
    if (quote !== undefined) { if (char === quote) quote = undefined; }
    else if (['"', "'"].includes(char)) quote = char;
    else if (char === ">") return position;
  }
  return -1;
}

function scanMarkup(head: string, position: number): { end: number; name: string; attributeStart: number } {
  if (head.startsWith("<!--", position)) {
    const end = head.indexOf("-->", position + 4);
    return { end: end === -1 ? -1 : end + 2, name: "", attributeStart: position };
  }
  const tag = /^<([a-z][^\t\n\f\r />]*|[!/?])/i.exec(head.slice(position));
  if (!tag) return { end: position, name: "", attributeStart: position };
  // Consume whole tags: a quoted > cannot complete a declaration.
  return { end: tagEnd(head, position + 1), name: tag[1]!.toLowerCase(), attributeStart: position + tag[0].length };
}

function declaredCharset(attrs: Map<string, string>): string | null {
  const direct = attrs.get("charset");
  if (direct) return direct.toLowerCase();
  if (attrs.get("http-equiv")?.toLowerCase() !== "content-type") return null;
  const found = attrs.get("content")?.match(/charset\s*=\s*["']?\s*([^\s;"']+)/i);
  return found?.[1] ? found[1].toLowerCase() : null;
}

function metaCharset(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, HTML_CHARSET_PRESCAN_BYTES)).toString("latin1");
  let position = 0;
  while ((position = head.indexOf("<", position)) !== -1) {
    const tag = scanMarkup(head, position);
    if (tag.end === -1) return null;
    position = tag.end + 1;
    if (tag.name !== "meta") continue;
    const charset = declaredCharset(attributes(head.slice(tag.attributeStart, tag.end)));
    if (charset) return charset;
  }
  return null;
}

function htmlCharset(bytes: Uint8Array): string {
  const meta = metaCharset(bytes);
  if (meta) {
    if (!encodingSupported(meta)) throw new WikiError("unsupported", `unsupported character encoding ${JSON.stringify(meta)}; refusing to invent text`);
    return meta;
  }
  return "utf-8";
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
  if (html) return htmlCharset(bytes);
  return "utf-8";
}

export function decodeWebText(bytes: Buffer, transport: string | null, html: boolean): string {
  return decodeWith(bytes, chooseCharset(bytes, transport, html));
}
