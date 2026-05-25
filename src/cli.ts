#!/usr/bin/env bun
// Wiki CLI — placeholder entry point.
//
// This file is intentionally empty pending PRD-001 implementation.
// All commands defined in ADR-0015 will be implemented as slices under PRD-001.
//
// See: ~/Knowledge/projects/wiki-v2/adrs/0015-cli-verb-surface.md

const args = Bun.argv.slice(2);

if (args[0] === "--version") {
  console.log("wiki 0.0.0 (pre-implementation)");
  process.exit(0);
}

console.error("wiki: not yet implemented. See PRD-001.");
process.exit(1);
