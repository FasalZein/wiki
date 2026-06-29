// Bun test preload (configured in bunfig.toml [test].preload).
//
// SLICE-0126: the write path (mintAndWrite) now fires an incremental `qmd update`
// on every create/capture. A real `qmd` binary is usually on PATH and owns real
// collections (e.g. wiki-v2) in ~/.cache/qmd — so a create-path test that does not
// pin its own QMD_COMMAND would re-index the REAL vault. Default QMD_COMMAND to a
// no-op fake so no test reaches the real index; tests that need to observe qmd
// behavior still set their own QMD_COMMAND, which takes precedence.
import { join } from "node:path";

if (process.env.QMD_COMMAND === undefined) {
  process.env.QMD_COMMAND = join(import.meta.dir, "fixtures", "noop-qmd.sh");
}
