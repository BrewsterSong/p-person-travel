import { NextRequest, NextResponse } from "next/server";
import { getRedditTopComments } from "@/lib/redditComments";

export async function GET(request: NextRequest) {
  try {
    const url = request.nextUrl.searchParams.get("url")?.trim() || "";
    const limit = Number(request.nextUrl.searchParams.get("limit") || 5);

    if (!url) {
      return NextResponse.json({ error: "url is required" }, { status: 400 });
    }

    const comments = await getRedditTopComments(url, { limit });
    return NextResponse.json({ comments });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    console.error("[api/reddit/comments] error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
