import { NextRequest, NextResponse } from "next/server";
import { searchRedditDiscussions } from "@/lib/reddit";

export async function GET(request: NextRequest) {
  try {
    const query = request.nextUrl.searchParams.get("query")?.trim() || "";
    const limit = Number(request.nextUrl.searchParams.get("limit") || 6);

    if (!query) {
      return NextResponse.json({ error: "query is required" }, { status: 400 });
    }

    const discussions = await searchRedditDiscussions(query, { limit });

    return NextResponse.json({ discussions });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    console.error("[api/reddit/search] error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
