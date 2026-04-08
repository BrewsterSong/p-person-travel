import crypto from "crypto";
import type { DiscussionCard } from "@/types/chat";
import type { GoogleOrganicResult } from "./providers/serpapi";

const QUERY_STOPWORDS = new Set([
  "travel",
  "trip",
  "itinerary",
  "guide",
  "tips",
  "where",
  "to",
  "stay",
  "reddit",
  "site:reddit.com",
  "攻略",
  "行程",
  "住哪",
  "住宿",
]);

function hashKey(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function cleanText(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function buildBaseDiscoveryTerm(query: string): string {
  return cleanText(query.replace(/site:reddit\.com/gi, ""));
}

export function buildRedditDiscoveryQueries(query: string): string[] {
  const base = buildBaseDiscoveryTerm(query);
  if (!base) return [];

  const looksSpecific =
    /(itinerary|where to stay|road trip|travel|guide|tips|住宿|攻略|行程|住哪|自驾)/i.test(base);

  const candidates = looksSpecific
    ? [`${base} site:reddit.com`]
    : [
        `${base} itinerary site:reddit.com`,
        `${base} travel site:reddit.com`,
      ];

  return Array.from(new Set(candidates.map((item) => cleanText(item))));
}

function extractSubredditFromSource(source: string, url: string): string {
  const fromSource = source.match(/r\/([A-Za-z0-9_]+)/i)?.[1];
  if (fromSource) return fromSource;

  try {
    const parsed = new URL(url);
    const pathMatch = parsed.pathname.match(/\/r\/([A-Za-z0-9_]+)/i);
    return pathMatch?.[1] || "";
  } catch {
    return "";
  }
}

function parseCommentCount(text: string): number | null {
  const match = text.match(/(\d[\d,+]*)\s*\+?\s*comments?/i);
  if (!match) return null;
  const value = Number(match[1].replace(/[+,]/g, ""));
  return Number.isFinite(value) ? value : null;
}

function parseAgeText(text: string): string {
  const parts = text
    .split("·")
    .map((part) => cleanText(part))
    .filter(Boolean);

  const agePart = parts.find((part) =>
    /\b(minutes?|hours?|days?|weeks?|months?|years?)\s+ago\b/i.test(part)
  );

  return agePart || "";
}

function extractDestinationHints(query: string, title: string): string[] {
  const tokens = `${query} ${title}`
    .split(/[\s,./\-|:()]+/)
    .map((token) => cleanText(token))
    .filter((token) => token.length > 1);

  const hints: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    const lowered = token.toLowerCase();
    if (QUERY_STOPWORDS.has(lowered)) continue;
    if (seen.has(lowered)) continue;
    seen.add(lowered);
    hints.push(token);
    if (hints.length >= 4) break;
  }

  return hints;
}

function normalizeThumbnail(thumbnail: string | undefined): string | undefined {
  const value = cleanText(thumbnail || "");
  if (!value) return undefined;
  return /^https?:\/\//i.test(value) ? value : undefined;
}

export function mapSerpApiResultToDiscussion(result: GoogleOrganicResult, query: string): DiscussionCard | null {
  const title = cleanText(result.title || "");
  const url = cleanText(result.link || "");
  if (!title || !url || !/reddit\.com/i.test(url)) return null;

  const snippet = cleanText(result.snippet || "");
  const displaySource = cleanText(result.source || result.displayed_link || "Reddit");
  const subreddit = extractSubredditFromSource(displaySource, url);
  const displayedLink = cleanText(result.displayed_link || "");
  const commentCount = parseCommentCount(displayedLink);
  const ageText = parseAgeText(displayedLink);

  return {
    id: hashKey(url),
    source: "reddit",
    cardType: "discussion",
    title,
    url,
    permalink: url,
    snippet,
    subreddit,
    commentCount,
    ageText,
    displaySource,
    thumbnail: normalizeThumbnail(result.thumbnail),
    query,
    destinationHints: extractDestinationHints(query, title),
    summary: snippet,
  };
}

export function mapSerpApiResultsToDiscussions(results: GoogleOrganicResult[], query: string): DiscussionCard[] {
  if (!Array.isArray(results) || results.length === 0) return [];

  const discussions: DiscussionCard[] = [];
  const seen = new Set<string>();

  for (const result of results) {
    const mapped = mapSerpApiResultToDiscussion(result, query);
    if (!mapped) continue;
    if (seen.has(mapped.url)) continue;
    seen.add(mapped.url);
    discussions.push(mapped);
  }

  return discussions;
}
