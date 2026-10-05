# wiki-cli

Standalone Node CLI for the knowledge core. It does not start Pi or a background service.

```text
node packages/wiki-cli/bin/wiki-cli.js --vault <dir> <command>
```

Global options are `--vault <dir>` (or `WIKI_VAULT`) and `--json`. There is no default vault.

## External programs

Web HTML capture and PDF import shell out to programs on `PATH`. They are not npm dependencies. This CLI does not install them and does not fall back to another parser.

| Program | Used for | Required flags |
| --- | --- | --- |
| `pandoc` | HTML and XHTML text | `-f html-smart -t json --sandbox` |
| `pdftotext` (Poppler) | PDF text | `-enc UTF-8 -eol unix -nopgbrk` |

`--sandbox` is mandatory. Without it, Pandoc can request an iframe URL from the captured page. With it, those URLs are not fetched. Script elements are not executed. Link and image URLs in the page are not fetched.

If either program is missing, capture exits 7 and names the program. Nothing is written to the vault.

These commands were exercised on macOS with Pandoc 3.8.3 and pdftotext 26.04.0 under Node 26. Windows was not tested. Paths recorded for file imports are absolute paths from `realpath`.

## Commands added for sources

```text
capture text <file> [--request-id <id>]
capture pdf <file> [--request-id <id>]
capture file <file> [--request-id <id>]
capture web <url> [--request-id <id>] [--observed-at <iso>]
```

`capture file` imports `.txt`, `.text`, `.md`, `.markdown`, and `.pdf`. Any other extension is refused. The refusal names the extension and does not invent text.

`capture web` accepts only `http:` and `https:` URLs. It fetches one response. It does not follow links in the page. A redirect stores the requested URL and, when different, the final URL. Status codes outside 200–299 are failures. The body of an error response is not stored as text.

`--observed-at` sets the recorded retrieval time. The default is the UTC time when the response headers arrive.

Original bytes and extracted text are stored as separate content digests. The same request id with the same content does not rewrite the observation. The same id with different content is a conflict. Two request ids keep two observations even when the bytes match.

## Text extraction limits

HTML charset handling follows the HTML Standard in two places:

- A transport `charset` that this Node build can decode wins over a `<meta>` charset.
- A `<meta>` charset is read only from the first 1024 bytes. Authors must place that declaration inside those bytes. A declaration after that prefix is ignored, and the bytes are then decoded as UTF-8. Invalid UTF-8 fails instead of being guessed.

Pandoc's HTML reader drops script and style contents before this CLI sees them. Those strings are not retained and are not run. Iframe fallback text is kept, and the iframe URL is not fetched. If Pandoc still emits a `RawBlock` or `RawInline`, the observation records that omission and the raw markup is not copied into the extracted text.

An unknown Pandoc block or inline type fails the capture. The failure names the type. Text from that region is not dropped silently and is not invented.

A valid PDF with no text layer imports as empty extracted text. A corrupt PDF fails and does not invent text. This CLI does not OCR scanned pages.

Cancellation is the process `SIGINT` or `SIGTERM` signal, which aborts the HTTP fetch and the extractor process. A cancelled capture does not record an observation. There is no retry loop and no size or time limit inside the tool.

## Local runtime and Markdown

Run the private packages from this repository with its declared dependencies available. Node must be at least 22.18.0. Node 26.3.0 was tested. Node runs the source TypeScript with built-in type stripping; there is no compilation or root `dist` output. A published package, a global install, and Windows execution are not verified.

The core uses the existing `gray-matter` 4.0.3 YAML engine (`js-yaml` safe loading, 3.14.2 in the tested installation). It parses only YAML frontmatter. Language-tagged JavaScript frontmatter is never evaluated. Normal YAML comments, quoted escapes and unrelated nested properties are supported. Note IDs and authorities must be strings. The note digest covers exact file bytes, including frontmatter and whitespace; meaningful external edits do not depend on modification time.

## Referenced notes

```text
capture note <note-id> [--request-id <id>]
```

This captures exact Markdown bytes of a note in the selected vault. The observation records its stable note ID and full file digest. `source show <observation-id> --text` returns those retained Markdown bytes as text, including frontmatter. A rename keeps the identity. A content edit invalidates the old snapshot's consistency with the current note. A missing referenced note reports unavailable evidence. Capture does not inherit the referenced note's trust status or turn a personal idea into an externally proven claim.

Use `capture text` or `capture file` for an imported document snapshot that does not track subsequent edits to its original path. Use `capture note` for a citation whose current note revision must remain consistent with the reviewed snapshot. No dependency graph or recursive trust calculation runs during reads.

## Evidence boundaries

A code observation binds to the canonical local repository path, configured reference, immutable commit and source path. Remapping a repository key or reference needs a new review even if file bytes match. An unchanged source at a later commit on the same binding can remain consistent with the reviewed content. Reads never fetch a remote repository.

Checks record caller-asserted provenance, not authenticated identity or owner approval. `authenticated` must remain `false`; a damaged record cannot assert otherwise. Missing or malformed relevant records, unsupported schemas, lost snapshots and inconsistent byte counts cannot produce attested status. Existing early pilot code observations without the required repository binding path are invalid evidence; there is no migration or guessed binding repair in this slice.

Replaying an identical request keeps its original recording time. Different content or other provenance under that ID conflicts. Use a new request ID for a distinct observation or review, including a new review of identical bytes. If the latest recording time has conflicting check outcomes, the read reports invalid evidence with an ambiguous-ordering reason. A genuinely later review can resolve that ordering. Request spelling cannot break a conflict in favor of positive evidence.

Check recording retains immutable evidence and does not overwrite Markdown. This is not an automatic publication feature or a guarantee of coordination with Obsidian writers.
