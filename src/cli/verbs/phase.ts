import { loadPhaseDoc } from "../phase-docs";
import type { CliResult } from "../dispatch";

export async function handlePhase(args: string[]): Promise<CliResult> {
  const [subverb, name] = args;
  if (subverb !== "doc") {
    console.error(`unknown phase subverb: ${subverb ?? ""}`.trim());
    return { code: 1 };
  }
  if (name === undefined) {
    console.error("missing required field: name");
    return { code: 1 };
  }
  const doc = await loadPhaseDoc(process.cwd(), name);
  if (doc === null) {
    console.error(`phase doc not found: ${name}`);
    return { code: 1 };
  }
  process.stdout.write(doc);
  if (!doc.endsWith("\n")) process.stdout.write("\n");
  return { code: 0 };
}
