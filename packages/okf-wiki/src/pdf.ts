import { spawn } from "node:child_process";
import { WikiError } from "./vault.ts";

// Adapted from wiki-core extraction, without evidence/storage policy.
const PDFTOTEXT_ARGS = ["-enc", "UTF-8", "-eol", "unix", "-nopgbrk", "-", "-"];
export function assertCaptureActive(signal: AbortSignal): void {
  if (signal.aborted) throw new WikiError("unavailable", "Source capture cancelled; no source note or retained assets published");
}

/** Resolve only after close, including on abort/start failure, so output cannot race child cleanup. */
function runTool(args: readonly string[], input: Buffer, signal: AbortSignal): Promise<{ code: number | null; stdout: Buffer; stderr: Buffer }> {
  assertCaptureActive(signal);
  return new Promise((resolve, reject) => {
    const child = spawn("pdftotext", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let failure: NodeJS.ErrnoException | undefined;
    const abort = () => { child.kill("SIGTERM"); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    // Early process exit can close stdin before it consumes the PDF. Its exit status is authoritative.
    child.stdin.on("error", () => undefined);
    child.on("error", (error: NodeJS.ErrnoException) => { failure = error; });
    child.on("close", code => {
      signal.removeEventListener("abort", abort);
      try {
        assertCaptureActive(signal);
        if (failure) throw new WikiError("unavailable", failure.code === "ENOENT"
          ? "pdftotext is not on PATH. Supply this external runtime dependency explicitly; capture does not install programs or use a parser/OCR fallback."
          : "pdftotext failed to start: " + failure.message);
        resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      } catch (error) { reject(error); }
    });
    child.stdin.end(input);
  });
}

export async function extractPdf(bytes: Buffer, signal: AbortSignal): Promise<{ text: string; bytes: Buffer; version: string }> {
  const info = await runTool(["-v"], Buffer.alloc(0), signal);
  let versionText: string;
  try { versionText = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat([info.stdout, Buffer.from("\n"), info.stderr])); }
  catch { throw new WikiError("unavailable", "pdftotext did not report a usable version as UTF-8; check the program on PATH"); }
  const version = /pdftotext version\s+(\S+)/.exec(versionText)?.[1];
  if (info.code !== 0 || !version) throw new WikiError("unavailable", "pdftotext did not report a usable version; check the program on PATH");
  const output = await runTool(PDFTOTEXT_ARGS, bytes, signal);
  if (output.code !== 0) {
    const detail = output.stderr.toString("utf8").trim();
    throw new WikiError("unsupported", "pdftotext could not read the PDF; refusing to invent its contents" + (detail ? ": " + detail : ""));
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(output.stdout); }
  catch { throw new WikiError("unsupported", "pdftotext returned bytes that are not UTF-8; refusing to invent text"); }
  return { text, bytes: output.stdout, version };
}
