import { NextRequest, NextResponse } from "next/server";
import { getGoogleMapsServerApiKey } from "@/lib/googlePlaces";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const name = searchParams.get("name");
    const maxWidthPx = Number(searchParams.get("maxWidthPx") || "400");

    if (!name) {
      return NextResponse.json({ error: "Photo name is required" }, { status: 400 });
    }

    const upstreamUrl = new URL(`https://places.googleapis.com/v1/${name}/media`);
    upstreamUrl.searchParams.set("maxWidthPx", String(Number.isFinite(maxWidthPx) ? maxWidthPx : 400));

    const response = await fetch(upstreamUrl.toString(), {
      headers: {
        "X-Goog-Api-Key": getGoogleMapsServerApiKey(),
      },
      next: { revalidate: 86400 },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json(
        { error: `Google Place Photo error: ${errorText}` },
        { status: response.status }
      );
    }

    const contentType = response.headers.get("content-type") || "image/jpeg";
    const arrayBuffer = await response.arrayBuffer();
    return new NextResponse(arrayBuffer, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800",
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Internal server error";
    console.error("Place photo proxy error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
