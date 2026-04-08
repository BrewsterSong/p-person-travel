import { Place, Review } from "@/types/chat";

type GooglePlaceLike = Record<string, unknown>;

const SERVER_GOOGLE_MAPS_API_KEY =
  process.env.GOOGLE_MAPS_API_KEY ||
  process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ||
  "";

export function getGoogleMapsServerApiKey(): string {
  if (!SERVER_GOOGLE_MAPS_API_KEY) {
    throw new Error("Missing GOOGLE_MAPS_API_KEY");
  }
  return SERVER_GOOGLE_MAPS_API_KEY;
}

export function buildPlacePhotoProxyUrl(photoName: string, maxWidthPx: number = 400): string {
  const params = new URLSearchParams({
    name: photoName,
    maxWidthPx: String(maxWidthPx),
  });
  return `/api/place-photo?${params.toString()}`;
}

function normalizePhotoUrls(rawPhotos: unknown, maxWidthPx: number): string[] {
  if (!Array.isArray(rawPhotos)) return [];
  return rawPhotos
    .slice(0, 5)
    .map((photo) => {
      if (!photo || typeof photo !== "object") return "";
      const record = photo as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name : "";
      if (!name) return "";
      return buildPlacePhotoProxyUrl(name, maxWidthPx);
    })
    .filter((url): url is string => !!url);
}

export function normalizePlaceSummary(rawPlace: GooglePlaceLike): Place {
  const displayName = rawPlace.displayName as Record<string, unknown> | undefined;
  const location = rawPlace.location as Record<string, unknown> | undefined;
  const currentOpeningHours = rawPlace.currentOpeningHours as Record<string, unknown> | undefined;

  const latitude =
    typeof location?.latitude === "number"
      ? location.latitude
      : typeof location?.lat === "number"
        ? location.lat
        : undefined;
  const longitude =
    typeof location?.longitude === "number"
      ? location.longitude
      : typeof location?.lng === "number"
        ? location.lng
        : undefined;

  return {
    id: typeof rawPlace.id === "string" ? rawPlace.id : "",
    name:
      (typeof displayName?.text === "string" ? displayName.text : "") ||
      (typeof rawPlace.name === "string" ? rawPlace.name : ""),
    address:
      (typeof rawPlace.formattedAddress === "string" ? rawPlace.formattedAddress : "") ||
      (typeof rawPlace.address === "string" ? rawPlace.address : ""),
    location:
      typeof latitude === "number" && typeof longitude === "number"
        ? { lat: latitude, lng: longitude }
        : undefined,
    rating: typeof rawPlace.rating === "number" ? rawPlace.rating : 0,
    userRatingsTotal:
      (typeof rawPlace.userRatingCount === "number" ? rawPlace.userRatingCount : undefined) ??
      (typeof rawPlace.userRatingsTotal === "number" ? rawPlace.userRatingsTotal : undefined) ??
      (typeof rawPlace.user_ratings_total === "number" ? rawPlace.user_ratings_total : undefined) ??
      0,
    priceLevel: typeof rawPlace.priceLevel === "number" ? rawPlace.priceLevel : undefined,
    openNow:
      typeof currentOpeningHours?.openNow === "boolean"
        ? currentOpeningHours.openNow
        : typeof rawPlace.openNow === "boolean"
          ? rawPlace.openNow
          : undefined,
    photos: normalizePhotoUrls(rawPlace.photos, 400),
    primaryType: typeof rawPlace.primaryType === "string" ? rawPlace.primaryType : "",
    types: Array.isArray(rawPlace.types) ? (rawPlace.types as string[]) : [],
  };
}

function normalizeReview(review: Record<string, unknown>): Review {
  const textValue = review.text;
  const textObject = textValue && typeof textValue === "object" ? (textValue as Record<string, unknown>) : null;

  return {
    authorName:
      (typeof review.authorName === "string" ? review.authorName : "") ||
      (typeof review.author_name === "string" ? review.author_name : "") ||
      "匿名用户",
    rating:
      (typeof review.rating === "number" ? review.rating : undefined) ??
      0,
    text:
      (textObject && typeof textObject.text === "string" ? textObject.text : "") ||
      (textObject && typeof textObject.plainText === "string" ? textObject.plainText : "") ||
      (typeof textValue === "string" ? textValue : "") ||
      (typeof review.content === "string" ? review.content : ""),
    relativeTimeDescription:
      (typeof review.relativeTimeDescription === "string" ? review.relativeTimeDescription : "") ||
      (typeof review.relative_time_description === "string" ? review.relative_time_description : ""),
  };
}

export function normalizePlaceDetails(
  summaryPlace: Place,
  details: GooglePlaceLike,
  fallbackReviews: Review[] = []
): Place {
  const currentOpeningHours = details.currentOpeningHours as Record<string, unknown> | undefined;
  const editorialSummary = details.editorialSummary as Record<string, unknown> | undefined;
  const detailPhotos = normalizePhotoUrls(details.photos, 800).slice(0, 5);
  const reviews = Array.isArray(details.reviews)
    ? (details.reviews as Record<string, unknown>[]).slice(0, 5).map(normalizeReview)
    : fallbackReviews;

  return {
    ...summaryPlace,
    name:
      (typeof (details.displayName as Record<string, unknown> | undefined)?.text === "string"
        ? ((details.displayName as Record<string, unknown>).text as string)
        : "") || summaryPlace.name,
    address:
      (typeof details.formattedAddress === "string" ? details.formattedAddress : "") || summaryPlace.address,
    rating:
      (typeof details.rating === "number" ? details.rating : undefined) ?? summaryPlace.rating,
    userRatingsTotal:
      (typeof details.userRatingCount === "number" ? details.userRatingCount : undefined) ??
      summaryPlace.userRatingsTotal,
    priceLevel:
      (typeof details.priceLevel === "number" ? details.priceLevel : undefined) ?? summaryPlace.priceLevel,
    openNow:
      (typeof currentOpeningHours?.openNow === "boolean" ? currentOpeningHours.openNow : undefined) ??
      summaryPlace.openNow,
    editorialSummary:
      (typeof editorialSummary?.overview === "string" ? editorialSummary.overview : "") ||
      summaryPlace.editorialSummary,
    openingHours: Array.isArray(currentOpeningHours?.weekdayDescriptions)
      ? (currentOpeningHours?.weekdayDescriptions as string[])
      : summaryPlace.openingHours,
    formattedPhoneNumber:
      (typeof details.internationalPhoneNumber === "string" ? details.internationalPhoneNumber : "") ||
      (typeof details.nationalPhoneNumber === "string" ? details.nationalPhoneNumber : "") ||
      summaryPlace.formattedPhoneNumber,
    photos: detailPhotos.length > 0 ? detailPhotos : summaryPlace.photos,
    reviews,
    primaryType:
      (typeof details.primaryType === "string" ? details.primaryType : "") || summaryPlace.primaryType,
    types: Array.isArray(details.types) ? (details.types as string[]) : summaryPlace.types,
  };
}
