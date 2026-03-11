/**
 * Dedupe news items: canonical URL and content hash (title + body fingerprint).
 */

import { createHash } from "crypto";

export interface NormalizedFeedItem {
  url: string;
  title: string;
  body: string;
  summary: string | null;
  publishedAt: Date | null;
}

/**
 * Normalize URL for dedupe (lowercase, strip fragment, strip trailing slash).
 */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    let path = u.pathname.replace(/\/+$/, "") || "/";
    u.pathname = path;
    return u.toString().toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Build content fingerprint from title + body for near-duplicate detection.
 */
export function contentFingerprint(title: string, body: string): string {
  const t = (title || "").trim().toLowerCase().replace(/\s+/g, " ");
  const b = (body || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 2000);
  return createHash("sha256").update(t + "\n" + b).digest("hex");
}

/**
 * Dedupe hash stored in DB: combine canonical URL + content fingerprint so same URL or same content is deduped.
 */
export function dedupeHash(item: NormalizedFeedItem): string {
  const url = normalizeUrl(item.url);
  const fp = contentFingerprint(item.title, item.body);
  return createHash("sha256").update(url + "|" + fp).digest("hex");
}
