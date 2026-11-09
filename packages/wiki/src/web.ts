import { assertCaptureActive } from "./extract-process.ts";
import { extractPdf } from "./pdf.ts";
import { extractHtml } from "./html.ts";
import { contentTypeOf, decodeWebText } from "./charset.ts";
import { WikiError } from "./vault.ts";

// Fetch Standard HTTP-redirect fetch step 3: at most 20 redirects.
const FETCH_REDIRECT_LIMIT = 20;
function httpUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new WikiError("unsupported", "Web capture requires a valid HTTP/HTTPS URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new WikiError("unsupported", "Web capture accepts only HTTP/HTTPS resources and redirect destinations");
  if (url.username || url.password) throw new WikiError("unsupported", "Web capture does not accept URL credentials; select a resource without credentials");
  return url;
}

async function redirectDestination(response: Response, current: string, redirects: number): Promise<string> {
  await response.body?.cancel();
  const location = response.headers.get("location");
  if (location === null) throw new WikiError("unavailable", "Web capture redirect has no Location; no source published");
  if (redirects === FETCH_REDIRECT_LIMIT) throw new WikiError("unavailable", "Web capture exceeded the Fetch Standard redirect limit; no source published");
  return httpUrl(new URL(location, current).href).href;
}

async function captureResponse(response: Response, requested: string, current: string, signal: AbortSignal) {
  const retrieved = new Date().toISOString();
  const original = Buffer.from(await response.arrayBuffer());
  assertCaptureActive(signal);
  const { mediaType, charset } = contentTypeOf(response.headers.get("content-type"));
  const extension = mediaType === "application/pdf" ? ".pdf" : mediaType === "text/html" ? ".html" : mediaType === "application/xhtml+xml" ? ".xhtml" : ".txt";
  return { original, retrieved, resource: requested, finalResource: current === requested ? undefined : current, mediaType, charset, extension };
}

function webRequestFailure(error: unknown, signal: AbortSignal): never {
  assertCaptureActive(signal);
  if (error instanceof WikiError) throw error;
  throw new WikiError("unavailable", "Web capture request/body failed; no source published: " + (error instanceof Error ? error.message : String(error)));
}

/** One explicit resource and its redirects only. No cookies, auth, or subresource requests. */
export async function fetchResource(raw: string, signal: AbortSignal) {
  const requested = httpUrl(raw).href;
  let current = requested;
  try {
    for (let redirects = 0; ; redirects++) {
      assertCaptureActive(signal);
      const response = await fetch(current, { signal, redirect: "manual", credentials: "omit" });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        current = await redirectDestination(response, current, redirects);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new WikiError("unavailable", "Web capture failed with HTTP " + response.status + "; no source published");
      }
      return await captureResponse(response, requested, current, signal);
    }
  } catch (error) {
    webRequestFailure(error, signal);
  }
}

export async function extractWeb(original: Buffer, mediaType: string, charset: string | null, signal: AbortSignal) {
  if (mediaType === "application/pdf") return { ...await extractPdf(original, signal), extractor: "pdftotext" };
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") return extractHtml(decodeWebText(original, charset, true), signal);
  if (mediaType === "text/plain") {
    const text = decodeWebText(original, charset, false);
    return { text, bytes: Buffer.from(text, "utf8"), extractor: "text-decoder", version: process.versions.node };
  }
  throw new WikiError("unsupported", "No extractor for media type " + mediaType + "; refusing to invent text");
}
