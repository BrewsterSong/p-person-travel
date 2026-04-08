import crypto from "crypto";
import type { DiscussionCard } from "@/types/chat";
import { getServerCacheJson, setServerCacheJson } from "./serverCache";
import { mapRedditThreadJsonToDiscussionDetail, type RedditThreadJson } from "./redditDetailMapping";
import { searchGoogleWithSerpApi } from "./providers/serpapi";
import { mapSerpApiResultsToDiscussions } from "./redditDiscovery";

const REDDIT_DETAIL_CACHE_TTL_SECONDS = 10 * 60;

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
  jsonUrl.searchParams.set("limit", "10");
  return jsonUrl.toString();
}

export async function getRedditDiscussionDetail(url: string, query = ""): Promise<DiscussionCard | null> {
  return getRedditDiscussionDetailWithSeed(url, { query });
}

export async function getRedditDiscussionDetailWithSeed(
  url: string,
  options: {
    query?: string;
    seed?: Partial<DiscussionCard>;
  } = {}
): Promise<DiscussionCard | null> {
  const normalizedUrl = String(url || "").trim();
  if (!normalizedUrl) return null;
  const query = options.query || "";

  const cacheKey = `reddit_detail_${hashKey({ url: normalizedUrl, query })}`;
  const cached = await getServerCacheJson<DiscussionCard | null>(cacheKey);
  if (cached) return cached;

  try {
    const response = await fetch(deriveJsonUrl(normalizedUrl), {
      next: { revalidate: REDDIT_DETAIL_CACHE_TTL_SECONDS },
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; P-Person-Travel/0.1)",
      },
      signal: AbortSignal.timeout(1800),
    });

    if (!response.ok) {
      throw new Error(`Reddit detail request failed: ${response.status}`);
    }

    const thread = (await response.json()) as RedditThreadJson;
    const detail = mapRedditThreadJsonToDiscussionDetail(thread, query);

    await setServerCacheJson({
      key: cacheKey,
      value: detail,
      ttlSeconds: REDDIT_DETAIL_CACHE_TTL_SECONDS,
    });

    return detail;
  } catch {
    const seed = options.seed
      ? ({
          id: options.seed.id || hashKey(normalizedUrl).slice(0, 16),
          source: "reddit",
          cardType: "discussion",
          title: options.seed.title || "Reddit discussion",
          url: normalizedUrl,
          permalink: normalizedUrl,
          snippet: options.seed.snippet || options.seed.summary || "",
          body: options.seed.body || options.seed.snippet || options.seed.summary || "",
          subreddit: options.seed.subreddit || "",
          commentCount:
            typeof options.seed.commentCount === "number" || options.seed.commentCount === null
              ? options.seed.commentCount
              : null,
          ageText: options.seed.ageText || "",
          displaySource: options.seed.displaySource || "Reddit",
          thumbnail: options.seed.thumbnail,
          query,
          destinationHints: options.seed.destinationHints || [],
          summary: options.seed.summary || options.seed.snippet || "",
          highlights: options.seed.highlights || (options.seed.snippet ? [options.seed.snippet] : []),
          mentionedPlaces: options.seed.mentionedPlaces || options.seed.destinationHints || [],
          topComments: options.seed.topComments || [],
        } satisfies DiscussionCard)
      : null;

    if (seed) {
      await setServerCacheJson({
        key: cacheKey,
        value: seed,
        ttlSeconds: REDDIT_DETAIL_CACHE_TTL_SECONDS,
      });
      return seed;
    }

    const fallbackQuery = query ? `${query} site:reddit.com` : `"${normalizedUrl}"`;
    const fallbackResults = await searchGoogleWithSerpApi({
      query: fallbackQuery,
      num: 5,
    });
    const mapped = mapSerpApiResultsToDiscussions(fallbackResults, query);
    const matched = mapped.find((item) => item.url === normalizedUrl) || mapped[0] || null;

    const fallbackDetail = matched
      ? {
          ...matched,
          body: matched.snippet,
          summary: matched.snippet,
          highlights: matched.snippet ? [matched.snippet] : [],
          mentionedPlaces: matched.destinationHints || [],
          topComments: [],
        }
      : null;

    await setServerCacheJson({
      key: cacheKey,
      value: fallbackDetail,
      ttlSeconds: REDDIT_DETAIL_CACHE_TTL_SECONDS,
    });

    return fallbackDetail;
  }
}
