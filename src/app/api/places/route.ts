import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getGoogleMapsServerApiKey, normalizePlaceSummary } from "@/lib/googlePlaces";
import { getServerCacheJson, setServerCacheJson } from "@/lib/serverCache";

const GOOGLE_PLACES_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK =
  "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.priceLevel,places.currentOpeningHours,places.photos,places.primaryType,places.types,nextPageToken";
const PLACES_CACHE_TTL_SECONDS = 10 * 60;

function hashKey(input: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

async function searchPlaces(params: {
  lat: number;
  lng: number;
  radius: number;
  textQuery: string;
  openNowOnly?: boolean;
}) {
  const response = await fetch(GOOGLE_PLACES_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": getGoogleMapsServerApiKey(),
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify({
      textQuery: params.textQuery,
      locationBias: {
        circle: {
          center: {
            latitude: params.lat,
            longitude: params.lng,
          },
          radius: params.radius,
        },
      },
      ...(params.openNowOnly ? { openNow: true } : {}),
      maxResultCount: 20,
    }),
    next: { revalidate: 300 },
    signal: AbortSignal.timeout(3500),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google Places search failed: ${errorText}`);
  }

  const data = await response.json();
  return {
    places: Array.isArray(data?.places) ? data.places.map(normalizePlaceSummary) : [],
    nextPageToken: typeof data?.nextPageToken === "string" ? data.nextPageToken : null,
  };
}

async function getNextPage(nextPageToken: string) {
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const response = await fetch(GOOGLE_PLACES_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": getGoogleMapsServerApiKey(),
      "X-Goog-FieldMask": FIELD_MASK,
    },
    body: JSON.stringify({ pageToken: nextPageToken }),
    next: { revalidate: 300 },
    signal: AbortSignal.timeout(3500),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google Places next page failed: ${errorText}`);
  }

  const data = await response.json();
  return {
    places: Array.isArray(data?.places) ? data.places.map(normalizePlaceSummary) : [],
    nextPageToken: typeof data?.nextPageToken === "string" ? data.nextPageToken : null,
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      lat,
      lng,
      radius = 5000,
      keyword,
      textQuery,
      nextPageToken,
      openNowOnly,
    } = body as {
      lat?: number;
      lng?: number;
      radius?: number;
      keyword?: string;
      textQuery?: string;
      nextPageToken?: string;
      openNowOnly?: boolean;
    };

    if (nextPageToken) {
      const cacheKey = `places_next_${hashKey({ nextPageToken })}`;
      const cached = await getServerCacheJson<Awaited<ReturnType<typeof getNextPage>>>(cacheKey);
      if (cached) return NextResponse.json(cached);

      const result = await getNextPage(nextPageToken);
      await setServerCacheJson({ key: cacheKey, value: result, ttlSeconds: PLACES_CACHE_TTL_SECONDS });
      return NextResponse.json(result);
    }

    if (typeof lat !== "number" || typeof lng !== "number") {
      return NextResponse.json({ error: "Location is required" }, { status: 400 });
    }

    const query = textQuery || keyword || "restaurant";
    const cacheKey = `places_search_${hashKey({ lat, lng, radius, query, openNowOnly: openNowOnly === true })}`;
    const cached = await getServerCacheJson<Awaited<ReturnType<typeof searchPlaces>>>(cacheKey);
    if (cached) return NextResponse.json(cached);

    const result = await searchPlaces({
      lat,
      lng,
      radius,
      textQuery: query,
      openNowOnly: openNowOnly === true,
    });
    await setServerCacheJson({ key: cacheKey, value: result, ttlSeconds: PLACES_CACHE_TTL_SECONDS });

    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Internal server error";
    console.error("Places proxy error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
