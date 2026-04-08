import { getGoogleMapsServerApiKey } from "@/lib/googlePlaces";

const GOOGLE_TIMEZONE_URL = "https://maps.googleapis.com/maps/api/timezone/json";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const lat = typeof body.lat === "number" ? body.lat : null;
    const lng = typeof body.lng === "number" ? body.lng : null;

    if (lat === null || lng === null) {
      return Response.json({ error: "Missing lat/lng" }, { status: 400 });
    }

    const params = new URLSearchParams({
      location: `${lat},${lng}`,
      timestamp: String(Math.floor(Date.now() / 1000)),
      key: getGoogleMapsServerApiKey(),
    });

    const response = await fetch(`${GOOGLE_TIMEZONE_URL}?${params.toString()}`, {
      cache: "no-store",
    });

    const data = await response.json();

    if (!response.ok || data.status !== "OK") {
      return Response.json(
        { error: data.errorMessage || data.status || "Timezone lookup failed" },
        { status: 502 }
      );
    }

    return Response.json({
      timeZoneId: data.timeZoneId,
      timeZoneName: data.timeZoneName,
    });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Timezone lookup failed",
      },
      { status: 500 }
    );
  }
}
