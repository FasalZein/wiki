// Swap the selected note for a symlink at the protected open, after the CLI's lstat checks passed.
// Only the filesystem event is injected; the real CLI opens, refuses and reports.
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const vault = fs.realpathSync(process.env.WIKI_TEST_VAULT);
const note = path.join(vault, process.env.WIKI_TEST_NOTE);
const open = fs.openSync;
let swapped = false;
fs.openSync = function(file, flags, ...args) {
  if (!swapped && typeof flags === "number" && (flags & fs.constants.O_NOFOLLOW) && path.resolve(String(file)) === note) {
    swapped = true;
    const target = note + ".target";
    fs.renameSync(note, target);
    fs.symlinkSync(target, note);
  }
  return open.call(this, file, flags, ...args);
};
syncBuiltinESMExports();
process.on("exit", () => {
  if (!swapped) throw new Error("The protected note open never ran; the swap was not injected");
});
