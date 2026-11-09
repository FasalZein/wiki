import { spawn } from "node:child_process";
import { WikiError } from "./vault.ts";

// Cooperative direct-child lifecycle shared by PDF and HTML extraction.
export function assertCaptureActive(signal: AbortSignal): void {
  if (signal.aborted) throw new WikiError("unavailable", "Source capture cancelled; no source note or retained assets published");
}

/** Resolve only after close, including on abort/start failure, so output cannot race child cleanup. */
export function runTool(command: "pandoc" | "pdftotext", args: readonly string[], input: Buffer, signal: AbortSignal): Promise<{ code: number | null; stdout: Buffer; stderr: Buffer }> {
  assertCaptureActive(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let failure: NodeJS.ErrnoException | undefined;
    const abort = () => { child.kill("SIGTERM"); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    // Early process exit can close stdin before it consumes the input. Its exit status is authoritative.
    child.stdin.on("error", () => undefined);
    child.on("error", (error: NodeJS.ErrnoException) => { failure = error; });
    child.on("close", code => {
      signal.removeEventListener("abort", abort);
      try {
        assertCaptureActive(signal);
        if (failure) throw new WikiError("unavailable", failure.code === "ENOENT"
          ? command + " is not on PATH. Supply this external runtime dependency explicitly; capture does not install programs or use a parser/OCR fallback."
          : command + " failed to start: " + failure.message);
        resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      } catch (error) { reject(error); }
    });
    child.stdin.end(input);
  });
}
