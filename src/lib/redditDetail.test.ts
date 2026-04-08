import test from "node:test";
import assert from "node:assert/strict";
import { mapRedditThreadJsonToDiscussionDetail, mapRedditThreadJsonToTopComments } from "./redditDetailMapping.ts";

test("mapRedditThreadJsonToDiscussionDetail parses post body and comments", () => {
  const detail = mapRedditThreadJsonToDiscussionDetail([
    {
      data: {
        children: [
          {
            kind: "t3",
            data: {
              id: "abc123",
              title: "Kyoto itinerary check",
              selftext:
                "We plan to stay near Kyoto Station and visit Arashiyama early. Wondering whether to keep Nara as a day trip.",
              author: "traveler",
              subreddit: "JapanTravel",
              url: "https://www.reddit.com/r/JapanTravel/comments/abc123/kyoto_itinerary_check/",
              permalink: "/r/JapanTravel/comments/abc123/kyoto_itinerary_check/",
              num_comments: 12,
              created_utc: 1710000000,
              score: 88,
            },
          },
        ],
      },
    },
    {
      data: {
        children: [
          {
            kind: "t1",
            data: {
              id: "c1",
              author: "localtip",
              body: "Arashiyama really works best before 8am and you should skip Nara on a short trip.",
              score: 120,
            },
          },
          {
            kind: "t1",
            data: {
              id: "c2",
              author: "stationfan",
              body: "Kyoto Station is a practical base if you need train flexibility.",
              score: 95,
            },
          },
        ],
      },
    },
  ], "Kyoto itinerary");

  assert.ok(detail);
  assert.equal(detail?.title, "Kyoto itinerary check");
  assert.equal(detail?.subreddit, "JapanTravel");
  assert.equal(detail?.commentCount, 12);
  assert.equal(detail?.topComments?.length, 2);
  assert.ok(detail?.summary);
  assert.ok((detail?.highlights?.length || 0) >= 1);
});

test("mapRedditThreadJsonToDiscussionDetail returns null for malformed data", () => {
  const detail = mapRedditThreadJsonToDiscussionDetail([
    { data: { children: [] } },
    { data: { children: [] } },
  ]);

  assert.equal(detail, null);
});

test("mapRedditThreadJsonToDiscussionDetail tolerates missing comments", () => {
  const detail = mapRedditThreadJsonToDiscussionDetail([
    {
      data: {
        children: [
          {
            kind: "t3",
            data: {
              id: "def456",
              title: "Shibuya travel notes",
              selftext: "Mostly deciding where to stay and how much time to spend around the station.",
              subreddit: "JapanTravelTips",
              url: "https://www.reddit.com/r/JapanTravelTips/comments/def456/shibuya_travel_notes/",
            },
          },
        ],
      },
    },
    { data: { children: [] } },
  ], "Shibuya");

  assert.ok(detail);
  assert.equal(detail?.topComments?.length, 0);
  assert.equal(detail?.body, "Mostly deciding where to stay and how much time to spend around the station.");
});

test("mapRedditThreadJsonToTopComments returns top-level comments by score", () => {
  const comments = mapRedditThreadJsonToTopComments([
    { data: { children: [] } },
    {
      data: {
        children: [
          {
            kind: "t1",
            data: {
              id: "low",
              author: "a",
              body: "Lower score useful comment.",
              score: 2,
            },
          },
          {
            kind: "more",
            data: {},
          },
          {
            kind: "t1",
            data: {
              id: "high",
              author: "b",
              body: "Higher score useful comment.",
              score: 20,
            },
          },
        ],
      },
    },
  ], 1);

  assert.equal(comments.length, 1);
  assert.equal(comments[0]?.id, "high");
});
