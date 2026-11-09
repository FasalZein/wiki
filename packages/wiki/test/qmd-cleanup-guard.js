// Inject only the nondeterministic native close-failure boundary, after real SDK I/O.
import Database from "better-sqlite3";
const close = Database.prototype.close;
Database.prototype.close = function () {
  const result = close.call(this);
  if (process.env.OKF_QMD_FAIL_CLOSE === "yes") {
    process.env.OKF_QMD_FAIL_CLOSE = "observed";
    throw new Error("injected native SQLITE_IOERR on close");
  }
  return result;
};
