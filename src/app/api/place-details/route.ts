import { NextRequest, NextResponse } from "next/server";
import { Place } from "@/types/chat";
import { getGoogleMapsServerApiKey, normalizePlaceDetails } from "@/lib/googlePlaces";

const GOOGLE_PLACES_V1_BASE_URL = "https://places.googleapis.com/v1";
const GOOGLE_PLACES_LEGACY_BASE_URL = "https://maps.googleapis.com/maps/api/place/details/json";

async function fetchLegacyReviews(placeId: string, apiKey: string) {
  const params = new URLSearchParams({
    place_id: placeId,
    language: "zh-CN",
    fields:
      "reviews",
    key: apiKey,
  });

  const response = await fetch(`${GOOGLE_PLACES_LEGACY_BASE_URL}?${params.toString()}`, {
    next: { revalidate: 300 },
    signal: AbortSignal.timeout(3500),
  });

  if (!response.ok) return [];
  const data = await response.json();
  return Array.isArray(data?.result?.reviews) ? data.result.reviews : [];
}

export async function POST(request: NextRequest) {
  try {
    const { placeId, place } = await request.json();

    if (!placeId) {
      return NextResponse.json({ error: "Place ID is required" }, { status: 400 });
    }

    const summaryPlace = (place || {}) as Place;
    const apiKey = getGoogleMapsServerApiKey();
    const response = await fetch(`${GOOGLE_PLACES_V1_BASE_URL}/places/${placeId}`, {
      method: "GET",
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask":
          "id,displayName,formattedAddress,location,rating,userRatingCount,priceLevel,currentOpeningHours,photos,primaryType,types,reviews,editorialSummary,nationalPhoneNumber,internationalPhoneNumber",
      },
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(3500),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json(
        { error: `Google Place Details error: ${errorText}` },
        { status: response.status }
      );
    }

    const details = await response.json();
    const fallbackReviews =
      Array.isArray(details?.reviews) && details.reviews.length > 0
        ? []
        : await fetchLegacyReviews(placeId, apiKey);

    const normalized = normalizePlaceDetails(summaryPlace, details, fallbackReviews);

    return NextResponse.json({ place: normalized });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Internal server error";
    console.error("Place details proxy error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
