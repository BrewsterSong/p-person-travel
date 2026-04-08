import crypto from "crypto";
import type { DiscussionCard } from "@/types/chat";
import { getServerCacheJson, setServerCacheJson } from "./serverCache";
import { searchGoogleWithSerpApi } from "./providers/serpapi";
import { buildRedditDiscoveryQueries, mapSerpApiResultsToDiscussions } from "./redditDiscovery";

const REDDIT_DISCOVERY_CACHE_TTL_SECONDS = 10 * 60;

function hashKey(input: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export async function searchRedditDiscussions(
  query: string,
  options: { limit?: number } = {}
): Promise<DiscussionCard[]> {
  const normalizedQuery = String(query || "").trim();
  const limit = Math.max(1, Math.min(options.limit || 6, 10));
  if (!normalizedQuery) return [];

  const cacheKey = `reddit_serp_search_${hashKey({ query: normalizedQuery, limit })}`;
  const cached = await getServerCacheJson<DiscussionCard[]>(cacheKey);
  if (cached) return cached;

  const searchQueries = buildRedditDiscoveryQueries(normalizedQuery);
  if (searchQueries.length === 0) return [];

  const resultBatches = await Promise.all(
    searchQueries.map((searchQuery) =>
      searchGoogleWithSerpApi({
        query: searchQuery,
        num: Math.max(limit, 5),
      })
    )
  );

  const merged = resultBatches.flat();
  const discussions = mapSerpApiResultsToDiscussions(merged, normalizedQuery).slice(0, limit);

  await setServerCacheJson({
    key: cacheKey,
    value: discussions,
    ttlSeconds: REDDIT_DISCOVERY_CACHE_TTL_SECONDS,
  });

  return discussions;
}
