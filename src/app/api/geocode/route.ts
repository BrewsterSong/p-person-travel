import { NextRequest, NextResponse } from "next/server";
import { getGoogleMapsServerApiKey } from "@/lib/googlePlaces";

const GOOGLE_GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

export async function POST(request: NextRequest) {
  try {
    const { address, lat, lng, allowMultiple = false } = await request.json();
    const apiKey = getGoogleMapsServerApiKey();
    const params = new URLSearchParams({
      key: apiKey,
      language: "zh-CN",
    });

    if (typeof address === "string" && address.trim()) {
      params.set("address", address.trim());
    } else if (typeof lat === "number" && typeof lng === "number") {
      params.set("latlng", `${lat},${lng}`);
    } else {
      return NextResponse.json({ error: "Address or lat/lng is required" }, { status: 400 });
    }

    const response = await fetch(`${GOOGLE_GEOCODE_URL}?${params.toString()}`, {
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(3500),
    });
    const data = await response.json();

    if (data.status !== "OK" || !Array.isArray(data.results) || data.results.length === 0) {
      return NextResponse.json(
        { error: data.status || "Geocoding failed" },
        { status: 400 }
      );
    }

    const results = data.results.map((result: any) => ({
      lat: result.geometry?.location?.lat,
      lng: result.geometry?.location?.lng,
      address: result.formatted_address,
    }));

    return NextResponse.json({
      ...results[0],
      multiple: allowMultiple && results.length > 1 ? results : null,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Internal server error";
    console.error("Geocode proxy error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
