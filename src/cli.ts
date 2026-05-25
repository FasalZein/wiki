#!/usr/bin/env bun
import { dispatch } from "./cli/dispatch";

if (Bun.argv[2] === "--version") {
  console.log("wiki 0.0.0 (pre-implementation)");
  process.exit(0);
}

try {
  const result = await dispatch(Bun.argv.slice(2));
  process.exit(result.code);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(10);
}
