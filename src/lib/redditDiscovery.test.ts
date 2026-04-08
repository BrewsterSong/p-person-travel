import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRedditDiscoveryQueries,
  mapSerpApiResultToDiscussion,
  mapSerpApiResultsToDiscussions,
} from "./redditDiscovery.ts";

test("buildRedditDiscoveryQueries builds sensible site:reddit.com variants", () => {
  const queries = buildRedditDiscoveryQueries("Bangkok");
  assert.deepEqual(queries, [
    "Bangkok itinerary site:reddit.com",
    "Bangkok travel site:reddit.com",
  ]);
});

test("mapSerpApiResultToDiscussion maps a normal Reddit result", () => {
  const discussion = mapSerpApiResultToDiscussion(
    {
      title: "Best Bangkok itinerary for 4 days - Reddit",
      link: "https://www.reddit.com/r/ThailandTourism/comments/abc123/best_bangkok_itinerary_for_4_days/",
      snippet: "Great thread covering neighborhoods, BTS strategy, and when to use boats.",
      source: "Reddit · r/ThailandTourism",
      displayed_link: "Reddit · r/ThailandTourism · 80+ comments · 5 months ago",
      thumbnail: "https://example.com/thumb.jpg",
    },
    "Bangkok"
  );

  assert.ok(discussion);
  assert.equal(discussion?.source, "reddit");
  assert.equal(discussion?.cardType, "discussion");
  assert.equal(discussion?.subreddit, "ThailandTourism");
  assert.equal(discussion?.commentCount, 80);
  assert.equal(discussion?.ageText, "5 months ago");
  assert.equal(discussion?.thumbnail, "https://example.com/thumb.jpg");
});

test("mapSerpApiResultToDiscussion tolerates missing displayed_link", () => {
  const discussion = mapSerpApiResultToDiscussion(
    {
      title: "Shibuya travel tips",
      link: "https://www.reddit.com/r/JapanTravel/comments/def456/shibuya_travel_tips/",
      snippet: "Useful area guide for first-time visitors.",
      source: "Reddit · r/JapanTravel",
    },
    "Shibuya"
  );

  assert.ok(discussion);
  assert.equal(discussion?.commentCount, null);
  assert.equal(discussion?.ageText, "");
  assert.equal(discussion?.thumbnail, undefined);
});

test("mapSerpApiResultsToDiscussions returns empty array for empty results", () => {
  assert.deepEqual(mapSerpApiResultsToDiscussions([], "Kyoto itinerary"), []);
});

test("mapSerpApiResultsToDiscussions keeps no-image results and dedupes links", () => {
  const discussions = mapSerpApiResultsToDiscussions(
    [
      {
        title: "Kyoto itinerary check",
        link: "https://www.reddit.com/r/JapanTravel/comments/ghi789/kyoto_itinerary_check/",
        snippet: "Planning 3 days around Kyoto Station.",
        source: "Reddit · r/JapanTravel",
      },
      {
        title: "Kyoto itinerary check duplicate",
        link: "https://www.reddit.com/r/JapanTravel/comments/ghi789/kyoto_itinerary_check/",
        snippet: "Duplicate result",
      },
    ],
    "Kyoto itinerary"
  );

  assert.equal(discussions.length, 1);
  assert.equal(discussions[0]?.thumbnail, undefined);
  assert.equal(discussions[0]?.snippet, "Planning 3 days around Kyoto Station.");
});
