import { runTool } from "./extract-process.ts";
import { WikiError } from "./vault.ts";

const PDFTOTEXT_ARGS = ["-enc", "UTF-8", "-eol", "unix", "-nopgbrk", "-", "-"];
export async function extractPdf(bytes: Buffer, signal: AbortSignal): Promise<{ text: string; bytes: Buffer; version: string }> {
  const info = await runTool("pdftotext", ["-v"], Buffer.alloc(0), signal);
  let versionText: string;
  try { versionText = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat([info.stdout, Buffer.from("\n"), info.stderr])); }
  catch { throw new WikiError("unavailable", "pdftotext did not report a usable version as UTF-8; check the program on PATH"); }
  const version = /pdftotext version\s+(\S+)/.exec(versionText)?.[1];
  if (info.code !== 0 || !version) throw new WikiError("unavailable", "pdftotext did not report a usable version; check the program on PATH");
  const output = await runTool("pdftotext", PDFTOTEXT_ARGS, bytes, signal);
  if (output.code !== 0) {
    const detail = output.stderr.toString("utf8").trim();
    throw new WikiError("unsupported", "pdftotext could not read the PDF; refusing to invent its contents" + (detail ? ": " + detail : ""));
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(output.stdout); }
  catch { throw new WikiError("unsupported", "pdftotext returned bytes that are not UTF-8; refusing to invent text"); }
  return { text, bytes: output.stdout, version };
}
