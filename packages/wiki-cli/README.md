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
