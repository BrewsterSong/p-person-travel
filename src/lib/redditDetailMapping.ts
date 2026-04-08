import type { DiscussionCard, DiscussionComment } from "@/types/chat";

export type RedditJsonChild<T> = {
  kind?: string;
  data?: T;
};

export type RedditJsonListing<T> = {
  data?: {
    children?: Array<RedditJsonChild<T>>;
  };
};

export type RedditPostJson = {
  id?: string;
  title?: string;
  selftext?: string;
  author?: string;
  subreddit?: string;
  url?: string;
  permalink?: string;
  created_utc?: number;
  score?: number;
  num_comments?: number;
  thumbnail?: string;
  preview?: {
    images?: Array<{
      source?: {
        url?: string;
      };
    }>;
  };
};

export type RedditCommentJson = {
  id?: string;
  author?: string;
  body?: string;
  score?: number;
  created_utc?: number;
  replies?: RedditJsonListing<RedditCommentJson> | string;
};

export type RedditThreadJson = [RedditJsonListing<RedditPostJson>, RedditJsonListing<RedditCommentJson>];

function cleanText(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanMultilineText(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\r/g, "")
    .trim();
}

function normalizeComment(raw: RedditCommentJson): DiscussionComment | null {
  const body = cleanText(raw.body || "");
  if (!raw.id || !body || body === "[deleted]" || body === "[removed]") return null;
  return {
    id: raw.id,
    author: raw.author || "unknown",
    body,
    score: typeof raw.score === "number" ? raw.score : 0,
    createdUtc: typeof raw.created_utc === "number" ? raw.created_utc : undefined,
  };
}

export function collectTopLevelComments(children: Array<RedditJsonChild<RedditCommentJson>>): DiscussionComment[] {
  return children
    .filter((child) => child.kind === "t1")
    .map((child) => normalizeComment(child.data || {}))
    .filter((comment): comment is DiscussionComment => !!comment)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
}

export function mapRedditThreadJsonToTopComments(thread: RedditThreadJson, limit = 5): DiscussionComment[] {
  const commentChildren = thread?.[1]?.data?.children || [];
  return collectTopLevelComments(commentChildren).slice(0, limit);
}

function splitIntoCandidateSentences(text: string): string[] {
  return cleanMultilineText(text)
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?。！？])\s+/))
    .map((line) => cleanText(line.replace(/^[-*•]\s*/, "")))
    .filter(Boolean);
}

const HIGHLIGHT_KEYWORDS = [
  "stay",
  "hotel",
  "hostel",
  "base",
  "train",
  "station",
  "airport",
  "drive",
  "car",
  "bus",
  "day trip",
  "itinerary",
  "pass",
  "avoid",
  "crowd",
  "sunrise",
  "sunset",
  "rush",
  "book",
  "route",
  "住宿",
  "酒店",
  "交通",
  "换乘",
  "路线",
  "避坑",
  "行程",
  "早上",
  "晚上",
];

function buildHighlights(body: string, comments: DiscussionComment[]): string[] {
  const pool = [
    ...splitIntoCandidateSentences(body),
    ...comments.flatMap((comment) => splitIntoCandidateSentences(comment.body)),
  ];

  const seen = new Set<string>();
  const highlights: string[] = [];

  for (const candidate of pool) {
    if (candidate.length < 25 || candidate.length > 180) continue;
    const normalized = candidate.toLowerCase();
    const isTravelRelevant = HIGHLIGHT_KEYWORDS.some((keyword) => normalized.includes(keyword));
    if (!isTravelRelevant && highlights.length >= 2) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    highlights.push(candidate);
    if (highlights.length >= 4) break;
  }

  return highlights;
}

const PLACE_STOPWORDS = new Set([
  "Day",
  "First",
  "October",
  "Japan",
  "Tips",
  "Road",
  "Trip",
  "Travel",
  "Station",
  "Market",
]);

function extractMentionedPlaces(texts: string[]): string[] {
  const joined = texts.join(" ");
  const matches = joined.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g) || [];
  const seen = new Set<string>();
  const places: string[] = [];

  for (const raw of matches) {
    const value = cleanText(raw);
    if (!value || PLACE_STOPWORDS.has(value)) continue;
    const lowered = value.toLowerCase();
    if (seen.has(lowered)) continue;
    seen.add(lowered);
    places.push(value);
    if (places.length >= 6) break;
  }

  return places;
}

function buildSummary(title: string, body: string, comments: DiscussionComment[]): string {
  const firstSentence = splitIntoCandidateSentences(body)[0] || comments[0]?.body || "";
  const summary = cleanText(`${title}. ${firstSentence}`);
  if (!summary) return title;
  return summary.length > 220 ? `${summary.slice(0, 217).trim()}...` : summary;
}

function normalizeThumbnail(post: RedditPostJson): string | undefined {
  const preview = cleanText(post.preview?.images?.[0]?.source?.url || "");
  const thumbnail = cleanText(post.thumbnail || "");
  const candidate = preview || thumbnail;
  if (!candidate || !/^https?:\/\//i.test(candidate)) return undefined;
  if (["self", "default", "nsfw", "spoiler", "image"].includes(candidate)) return undefined;
  return candidate;
}

export function mapRedditThreadJsonToDiscussionDetail(thread: RedditThreadJson, query = ""): DiscussionCard | null {
  const post = thread?.[0]?.data?.children?.[0]?.data;
  if (!post?.id || !post.title) return null;

  const commentChildren = thread?.[1]?.data?.children || [];
  const topComments = collectTopLevelComments(commentChildren).slice(0, 3);
  const body = cleanMultilineText(post.selftext || "");
  const permalink = post.permalink
    ? `https://www.reddit.com${post.permalink}`
    : cleanText(post.url || "");

  return {
    id: post.id,
    source: "reddit",
    cardType: "discussion",
    title: cleanText(post.title),
    url: cleanText(post.url || permalink),
    permalink,
    snippet: cleanText(splitIntoCandidateSentences(body)[0] || ""),
    body,
    subreddit: post.subreddit || "",
    commentCount: typeof post.num_comments === "number" ? post.num_comments : topComments.length,
    ageText: "",
    displaySource: post.subreddit ? `Reddit · r/${post.subreddit}` : "Reddit",
    thumbnail: normalizeThumbnail(post),
    query,
    destinationHints: extractMentionedPlaces([cleanText(post.title), body]),
    summary: buildSummary(cleanText(post.title), body, topComments),
    author: post.author || "unknown",
    createdUtc: typeof post.created_utc === "number" ? post.created_utc : undefined,
    score: typeof post.score === "number" ? post.score : 0,
    highlights: buildHighlights(body, topComments),
    mentionedPlaces: extractMentionedPlaces([cleanText(post.title), body, ...topComments.map((item) => item.body)]),
    topComments,
  };
}
