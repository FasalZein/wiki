#!/usr/bin/env node
// Node >=22.18 runs TypeScript sources with built-in type stripping.
// This file is the only code that touches process state: argv, env, interrupt signals, exit code and streams.
import { run } from "../src/cli.ts";

const result = await run(process.argv.slice(2), {
  env: process.env,
  // Signal handlers exist only while the command subscribes (search and capture extraction), as before.
  interrupts: (listener) => {
    process.on("SIGINT", listener); process.on("SIGTERM", listener);
    return () => { process.removeListener("SIGINT", listener); process.removeListener("SIGTERM", listener); };
  },
});
process.exitCode = result.code;
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
