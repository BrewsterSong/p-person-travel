import crypto from "crypto";
import type { DiscussionComment } from "@/types/chat";
import { getServerCacheJson, setServerCacheJson } from "./serverCache";
import { mapRedditThreadJsonToTopComments, type RedditThreadJson } from "./redditDetailMapping";

const REDDIT_COMMENTS_CACHE_TTL_SECONDS = 10 * 60;

function hashKey(input: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function deriveJsonUrl(url: string): string {
  const parsed = new URL(url);
  let pathname = parsed.pathname;
  if (!pathname.endsWith(".json")) {
    pathname = pathname.replace(/\/$/, "");
    pathname = `${pathname}.json`;
  }

  const jsonUrl = new URL(parsed.origin);
  jsonUrl.pathname = pathname;
  jsonUrl.searchParams.set("raw_json", "1");
  jsonUrl.searchParams.set("sort", "top");
  jsonUrl.searchParams.set("limit", "20");
  return jsonUrl.toString();
}

export async function getRedditTopComments(
  url: string,
  options: { limit?: number } = {}
): Promise<DiscussionComment[]> {
  const normalizedUrl = String(url || "").trim();
  const limit = Math.max(1, Math.min(options.limit || 5, 10));
  if (!normalizedUrl) return [];

  const cacheKey = `reddit_top_comments_${hashKey({ url: normalizedUrl, limit })}`;
  const cached = await getServerCacheJson<DiscussionComment[]>(cacheKey);
  if (cached) return cached;

  try {
    const response = await fetch(deriveJsonUrl(normalizedUrl), {
      next: { revalidate: REDDIT_COMMENTS_CACHE_TTL_SECONDS },
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; P-Person-Travel/0.1)",
      },
      signal: AbortSignal.timeout(1500),
    });

    if (!response.ok) {
      throw new Error(`Reddit comments request failed: ${response.status}`);
    }

    const thread = (await response.json()) as RedditThreadJson;
    const comments = mapRedditThreadJsonToTopComments(thread, limit);
    await setServerCacheJson({
      key: cacheKey,
      value: comments,
      ttlSeconds: REDDIT_COMMENTS_CACHE_TTL_SECONDS,
    });
    return comments;
  } catch {
    await setServerCacheJson({
      key: cacheKey,
      value: [],
      ttlSeconds: 60,
    });
    return [];
  }
}
