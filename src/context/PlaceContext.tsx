"use client";

import { createContext, useContext, useRef, useState, ReactNode } from "react";
import { Place } from "@/types/chat";

interface PlaceContextType {
  selectedPlace: Place | null;
  setSelectedPlace: (place: Place | null) => void;
  selectPlace: (place: Place) => Promise<void>;
}

const PlaceContext = createContext<PlaceContextType | null>(null);
const PLACE_DETAILS_CACHE_VERSION = 2;
const PLACE_DETAILS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function isTimeoutLikeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return /aborted due to timeout|timeout|fetch failed/i.test(message);
}

function getClientStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return window.sessionStorage;
  }
}

function buildPlaceDetailsCacheKey(placeId: string) {
  return `place_details_v${PLACE_DETAILS_CACHE_VERSION}_${placeId}`;
}

function getCachedPlaceDetails(placeId: string): Place | null {
  try {
    const key = buildPlaceDetailsCacheKey(placeId);
    const raw = getClientStorage()?.getItem(key) ?? window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { v?: number; cachedAt?: number; place?: Place } | null;
    if (!parsed || parsed.v !== PLACE_DETAILS_CACHE_VERSION || !parsed.place) return null;
    const cachedAt = typeof parsed.cachedAt === "number" ? parsed.cachedAt : 0;
    if (Date.now() - cachedAt > PLACE_DETAILS_CACHE_TTL_MS) return null;
    return parsed.place;
  } catch {
    return null;
  }
}

function setCachedPlaceDetails(place: Place) {
  try {
    const key = buildPlaceDetailsCacheKey(place.id);
    const value = JSON.stringify({
      v: PLACE_DETAILS_CACHE_VERSION,
      cachedAt: Date.now(),
      place,
    });
    getClientStorage()?.setItem(key, value);
    window.sessionStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

export function PlaceProvider({ children }: { children: ReactNode }) {
  const [selectedPlace, setSelectedPlace] = useState<Place | null>(null);
  const inFlightRef = useRef<Map<string, Promise<Place | null>>>(new Map());

  const selectPlace = async (place: Place) => {
    console.log("[PlaceContext] selectPlace called for:", place.name);
    // Open the detail drawer immediately with summary data, then hydrate it.
    setSelectedPlace(place);
    const cached = getCachedPlaceDetails(place.id);
    if (cached) {
      console.log("[PlaceContext] Using cached place details for:", place.name);
      setSelectedPlace({ ...place, ...cached });
      return;
    }

    const existing = inFlightRef.current.get(place.id);
    if (existing) {
      const detailed = await existing;
      if (detailed) setSelectedPlace((prev) => (prev?.id === place.id ? detailed : prev));
      return;
    }

    const loadPromise = (async (): Promise<Place | null> => {
    try {
      const response = await fetch("/api/place-details", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ placeId: place.id, place }),
      });

      const data = await response.json();
      if (!response.ok || !data?.place) {
        throw new Error(data?.error || "Failed to get place details");
      }

      const detailedPlace: Place = data.place;
      setCachedPlaceDetails(detailedPlace);

      console.log("[PlaceContext] Setting selectedPlace to:", detailedPlace.name);
      setSelectedPlace((prev) => (prev?.id === place.id ? detailedPlace : prev));
      console.log("[PlaceContext] setSelectedPlace called");
      return detailedPlace;
    } catch (error) {
      if (isTimeoutLikeError(error)) {
        console.warn("[PlaceContext] Place details timed out, using fallback data");
      } else {
        console.warn("[PlaceContext] Failed to get place details, trying fallback:", error);
      }
      if (process.env.NODE_ENV !== "production") {
        try {
          const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
          if (apiKey) {
            const response = await fetch(`https://places.googleapis.com/v1/places/${place.id}`, {
              method: "GET",
              headers: {
                "X-Goog-Api-Key": apiKey,
                "X-Goog-FieldMask":
                  "id,displayName,formattedAddress,location,rating,userRatingCount,priceLevel,currentOpeningHours,photos,primaryType,types,reviews,editorialSummary,nationalPhoneNumber,internationalPhoneNumber",
              },
            });
            const data = await response.json();
            if (response.ok) {
              const detailedPlace: Place = {
                ...place,
                name: data.displayName?.text || place.name,
                address: data.formattedAddress || place.address,
                rating: data.rating || place.rating,
                userRatingsTotal: data.userRatingCount || place.userRatingsTotal,
                priceLevel: data.priceLevel,
                openNow: data.currentOpeningHours?.openNow,
                editorialSummary: data.editorialSummary?.overview,
                openingHours: data.currentOpeningHours?.weekdayDescriptions,
                formattedPhoneNumber: data.internationalPhoneNumber || data.nationalPhoneNumber,
                photos: data.photos?.slice(0, 5).map((photo: any) =>
                  `https://places.googleapis.com/v1/${photo.name}/media?maxWidthPx=800&key=${apiKey}`
                ) || place.photos,
                reviews: data.reviews?.slice(0, 5).map((review: any) => ({
                  authorName: review.authorName || "匿名用户",
                  rating: review.rating || 0,
                  text: review.text?.text || review.text?.plainText || review.text || review.content || "",
                  relativeTimeDescription: review.relativeTimeDescription || review.relative_time_description || "",
                })) || [],
              };
              setCachedPlaceDetails(detailedPlace);
              setSelectedPlace((prev) => (prev?.id === place.id ? detailedPlace : prev));
              return detailedPlace;
            }
          }
        } catch (fallbackError) {
          console.warn("[PlaceContext] Client-side place details fallback failed:", fallbackError);
        }
      }
      console.log("[PlaceContext] Keeping summary place in detail drawer:", place.name);
      return null;
    } finally {
      inFlightRef.current.delete(place.id);
    }
    })();

    inFlightRef.current.set(place.id, loadPromise);
    await loadPromise;
  };

  return (
    <PlaceContext.Provider value={{ selectedPlace, setSelectedPlace, selectPlace }}>
      {children}
    </PlaceContext.Provider>
  );
}

export function usePlaceContext() {
  const context = useContext(PlaceContext);
  if (!context) {
    throw new Error("usePlaceContext must be used within PlaceProvider");
  }
  return context;
}
