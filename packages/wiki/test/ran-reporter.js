// node --test reporter for run.js: prints how many tests ran. Each file's own summary counts the tests
// that matched the name pattern; the overall summary also counts a file that ran nothing as one test.
export default async function* ran(source) {
  let count = 0;
  for await (const event of source) {
    if (event.type === "test:summary" && event.data.file) count += event.data.counts.tests - event.data.counts.skipped - event.data.counts.todo;
  }
  yield String(count) + "\n";
}
