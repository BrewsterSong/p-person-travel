import { NextRequest, NextResponse } from "next/server";
import { getRedditDiscussionDetailWithSeed } from "@/lib/redditDetail";

export async function GET(request: NextRequest) {
  try {
    const url = request.nextUrl.searchParams.get("url")?.trim() || "";
    const query = request.nextUrl.searchParams.get("query")?.trim() || "";
    const title = request.nextUrl.searchParams.get("title")?.trim() || "";
    const snippet = request.nextUrl.searchParams.get("snippet")?.trim() || "";
    const subreddit = request.nextUrl.searchParams.get("subreddit")?.trim() || "";
    const ageText = request.nextUrl.searchParams.get("ageText")?.trim() || "";
    const displaySource = request.nextUrl.searchParams.get("displaySource")?.trim() || "";
    const thumbnail = request.nextUrl.searchParams.get("thumbnail")?.trim() || undefined;
    const commentCountRaw = request.nextUrl.searchParams.get("commentCount");
    const commentCount =
      commentCountRaw === null || commentCountRaw === ""
        ? null
        : Number.isFinite(Number(commentCountRaw))
          ? Number(commentCountRaw)
          : null;

    if (!url) {
      return NextResponse.json({ error: "url is required" }, { status: 400 });
    }

    const discussion = await getRedditDiscussionDetailWithSeed(url, {
      query,
      seed: {
        title,
        snippet,
        summary: snippet,
        subreddit,
        ageText,
        displaySource,
        thumbnail,
        commentCount,
      },
    });
    if (!discussion) {
      return NextResponse.json({ error: "Discussion detail not found" }, { status: 404 });
    }

    return NextResponse.json({ discussion });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    console.error("[api/reddit/detail] error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
