"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuthContext } from "@/context/AuthContext";
import { saveProfileLocation } from "@/lib/supabase/appData";

export interface Location {
  lat: number;
  lng: number;
  address?: string;
  timezone?: string;
  source?: "browser" | "manual" | "profile" | "fallback";
}

export interface LocationState {
  location: Location | null;
  loading: boolean;
  error: string | null;
  isSupported: boolean;
  isInServiceArea: boolean;
  timezone: string | null;
}

export interface UpdateLocationOptions {
  persist?: boolean;
}

const SUPPORTED_REGION_BOUNDS = [
  { name: "Thailand", north: 20.5, south: 5.5, east: 105.9, west: 97.3 },
  { name: "Japan", north: 45.5, south: 24.0, east: 146.0, west: 122.0 },
  { name: "Hong Kong", north: 22.6, south: 22.15, east: 114.5, west: 113.8 },
  { name: "Vietnam", north: 23.5, south: 8.0, east: 109.8, west: 102.0 },
  { name: "South Korea", north: 38.7, south: 33.0, east: 131.0, west: 124.5 },
];

function isInServiceArea(lat: number, lng: number): boolean {
  return SUPPORTED_REGION_BOUNDS.some((region) =>
    lat >= region.south &&
    lat <= region.north &&
    lng >= region.west &&
    lng <= region.east
  );
}

const DEFAULT_LOCATION: Location = {
  lat: 13.736717,
  lng: 100.561119,
  address: "曼谷市中心",
  timezone: "Asia/Bangkok",
  source: "fallback",
};

const LOCATION_SOURCE_PRIORITY: Record<NonNullable<Location["source"]>, number> = {
  fallback: 0,
  profile: 1,
  browser: 2,
  manual: 3,
};

const GEOCODE_QUERY_ALIASES: Record<string, string[]> = {
  "晴空塔": ["东京晴空塔", "东京天空树", "Tokyo Skytree", "東京スカイツリー"],
  "东京晴空塔": ["东京天空树", "Tokyo Skytree", "東京スカイツリー"],
  "东京天空树": ["东京晴空塔", "Tokyo Skytree", "東京スカイツリー"],
  "skytree": ["Tokyo Skytree", "东京晴空塔", "东京天空树", "東京スカイツリー"],
};

function buildGeocodeQueries(address: string): string[] {
  const base = (address || "").trim();
  if (!base) return [];

  const queries = [base];
  const lowerBase = base.toLowerCase();

  for (const [key, aliases] of Object.entries(GEOCODE_QUERY_ALIASES)) {
    if (base.includes(key) || lowerBase.includes(key.toLowerCase())) {
      queries.push(...aliases);
    }
  }

  return Array.from(new Set(queries.map((query) => query.trim()).filter(Boolean)));
}

function normalizeLocationSource(source: string | null | undefined): Location["source"] {
  if (source === "manual" || source === "browser" || source === "profile" || source === "fallback") {
    return source;
  }
  return "profile";
}

export function useLocation() {
  const { user, client, profile } = useAuthContext();
  const [state, setState] = useState<LocationState>({
    location: null,
    loading: true,
    error: null,
    isSupported: false,
    isInServiceArea: false,
    timezone: null,
  });
  const currentLocationRef = useRef<Location | null>(null);
  const locationRequestRef = useRef({ id: 0, priority: -1 });

  useEffect(() => {
    currentLocationRef.current = state.location;
  }, [state.location]);

  const getCurrentPosition = useCallback(() => {
    return new Promise<Location>((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("Geolocation is not supported"));
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          const { latitude, longitude } = position.coords;
          resolve({ lat: latitude, lng: longitude, source: "browser" });
        },
        (error) => reject(error),
        {
          timeout: 10000,
          maximumAge: 300000,
        }
      );
    });
  }, []);

  const runMapsGeocoder = useCallback(async (request: Record<string, unknown>): Promise<Array<{ formatted_address?: string; geometry?: { location?: { lat: (() => number) | number; lng: (() => number) | number } } }>> => {
    const maps = typeof window !== "undefined" ? (window.google?.maps as any) : undefined;
    if (!maps?.Geocoder) return [];

    return await new Promise((resolve) => {
      const geocoder = new maps.Geocoder();
      geocoder.geocode(request, (results: any, status: any) => {
        if (status === "OK" && Array.isArray(results)) {
          resolve(results);
          return;
        }
        resolve([]);
      });
    });
  }, []);

  const resolveTimezone = useCallback(async (lat: number, lng: number): Promise<string> => {
    const clientFallback = async () => {
      const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
      if (!apiKey) return "";
      const response = await fetch(
        `https://maps.googleapis.com/maps/api/timezone/json?location=${lat},${lng}&timestamp=${Math.floor(Date.now() / 1000)}&key=${apiKey}`
      );
      const data = await response.json();
      return typeof data.timeZoneId === "string" ? data.timeZoneId : "";
    };

    try {
      if (process.env.NODE_ENV !== "production") {
        const timezone = await clientFallback();
        if (timezone) return timezone;
      }

      const response = await fetch("/api/timezone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat, lng }),
      });
      const data = await response.json();
      if (response.ok && typeof data.timeZoneId === "string") {
        return data.timeZoneId;
      }
    } catch (error) {
      console.warn("Timezone lookup failed:", error);
    }
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_LOCATION.timezone || "UTC";
  }, []);

  const reverseGeocode = useCallback(async (lat: number, lng: number): Promise<string> => {
    const clientFallback = async () => {
      const mapsResults = await runMapsGeocoder({
        location: { lat, lng },
        language: "zh-CN",
      });
      if (mapsResults[0]?.formatted_address) {
        return mapsResults[0].formatted_address;
      }

      const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
      if (!apiKey) return "";
      const response = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}&language=zh-CN`
      );
      const data = await response.json();
      return data.results?.[0]?.formatted_address || "";
    };

    try {
      if (process.env.NODE_ENV !== "production") return await clientFallback();

      const response = await fetch("/api/geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat, lng }),
      });
      const data = await response.json();
      if (response.ok && typeof data.address === "string") {
        return data.address;
      }
      if (process.env.NODE_ENV !== "production") return await clientFallback();
    } catch (error) {
      console.error("Geocoding error:", error);
      if (process.env.NODE_ENV !== "production") {
        try {
          return await clientFallback();
        } catch {}
      }
    }
    return "";
  }, [runMapsGeocoder]);

  const geocode = useCallback(async (address: string): Promise<Location | null> => {
    const queries = buildGeocodeQueries(address);

    const clientFallback = async (): Promise<Location | null> => {
      const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
      for (const query of queries) {
        const mapsResults = await runMapsGeocoder({
          address: query,
          language: "zh-CN",
        });
        if (mapsResults[0]?.geometry?.location) {
          const loc = mapsResults[0].geometry.location;
          const lat = typeof loc.lat === "function" ? loc.lat() : (loc as { lat: number }).lat;
          const lng = typeof loc.lng === "function" ? loc.lng() : (loc as { lng: number }).lng;
          const timezone = await resolveTimezone(lat, lng);
          return {
            lat,
            lng,
            address: mapsResults[0].formatted_address,
            timezone,
            source: "manual",
          };
        }

        if (!apiKey) continue;
        const response = await fetch(
          `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${apiKey}&language=zh-CN`
        );
        const data = await response.json();
        if (data.results?.[0]) {
          const loc = data.results[0].geometry.location;
          const timezone = await resolveTimezone(loc.lat, loc.lng);
          return {
            lat: loc.lat,
            lng: loc.lng,
            address: data.results[0].formatted_address,
            timezone,
            source: "manual",
          };
        }
      }

      return null;
    };

    try {
      if (process.env.NODE_ENV !== "production") return await clientFallback();

      for (const query of queries) {
        const response = await fetch("/api/geocode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: query }),
        });
        const data = await response.json();
        if (response.ok && typeof data.lat === "number" && typeof data.lng === "number") {
          return {
            lat: data.lat,
            lng: data.lng,
            address: data.address,
            timezone: await resolveTimezone(data.lat, data.lng),
            source: "manual",
          };
        }
      }

      if (process.env.NODE_ENV !== "production") return await clientFallback();
    } catch (error) {
      console.error("Geocoding error:", error);
      if (process.env.NODE_ENV !== "production") {
        try {
          return await clientFallback();
        } catch {}
      }
    }
    return null;
  }, [resolveTimezone, runMapsGeocoder]);

  const detectMultipleLocations = useCallback(async (address: string): Promise<Location[]> => {
    const clientFallback = async (): Promise<Location[]> => {
      const mapsResults = await runMapsGeocoder({
        address,
        language: "zh-CN",
      });
      if (mapsResults.length > 0) {
        return Promise.all(
          mapsResults.map(async (result) => {
            const loc = result.geometry?.location;
            const lat = loc ? (typeof loc.lat === "function" ? loc.lat() : (loc as { lat: number }).lat) : 0;
            const lng = loc ? (typeof loc.lng === "function" ? loc.lng() : (loc as { lng: number }).lng) : 0;
            return {
              lat,
              lng,
              address: result.formatted_address,
              timezone: await resolveTimezone(lat, lng),
              source: "manual" as const,
            };
          })
        );
      }

      const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
      if (!apiKey) return [];
      const response = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}&language=zh-CN`
      );
      const data = await response.json();
      if (!Array.isArray(data.results)) return [];

      return Promise.all(
        data.results.map(async (result: { geometry?: { location?: { lat: number; lng: number } }; formatted_address?: string }) => ({
          lat: result.geometry?.location?.lat ?? 0,
          lng: result.geometry?.location?.lng ?? 0,
          address: result.formatted_address,
          timezone: await resolveTimezone(
            result.geometry?.location?.lat ?? 0,
            result.geometry?.location?.lng ?? 0
          ),
          source: "manual" as const,
        }))
      );
    };

    try {
      if (process.env.NODE_ENV !== "production") return await clientFallback();

      const response = await fetch("/api/geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, allowMultiple: true }),
      });
      const data = await response.json();
      if (response.ok && Array.isArray(data.multiple)) {
        return Promise.all(
          data.multiple.map(async (item: Location) => ({
            ...item,
            timezone: item.timezone || await resolveTimezone(item.lat, item.lng),
            source: "manual" as const,
          }))
        );
      }
      if (process.env.NODE_ENV !== "production") return await clientFallback();
    } catch (error) {
      console.error("Geocoding error:", error);
      if (process.env.NODE_ENV !== "production") {
        try {
          return await clientFallback();
        } catch {}
      }
    }
    return [];
  }, [resolveTimezone, runMapsGeocoder]);

  const applyLocationState = useCallback(async (
    nextLocation: Location,
    nextError: string | null = null,
    options?: UpdateLocationOptions
  ) => {
    const currentLocation = currentLocationRef.current;
    const currentPriority = currentLocation?.source ? LOCATION_SOURCE_PRIORITY[currentLocation.source] : -1;
    const nextSource = nextLocation.source ?? "profile";
    const nextPriority = LOCATION_SOURCE_PRIORITY[nextSource];

    if (
      currentLocation &&
      currentPriority > nextPriority
    ) {
      return currentLocation;
    }

    const latestRequest = locationRequestRef.current;
    if (latestRequest.priority > nextPriority) {
      return currentLocation ?? nextLocation;
    }

    const requestId = latestRequest.id + 1;
    locationRequestRef.current = {
      id: requestId,
      priority: nextPriority,
    };

    const timezone = nextLocation.timezone || await resolveTimezone(nextLocation.lat, nextLocation.lng);
    const address = nextLocation.address || await reverseGeocode(nextLocation.lat, nextLocation.lng);
    const location = {
      ...nextLocation,
      address,
      timezone,
    };

    const latestLocation = currentLocationRef.current;
    const latestPriority = latestLocation?.source ? LOCATION_SOURCE_PRIORITY[latestLocation.source] : -1;
    const latestCompletedRequest = locationRequestRef.current;
    if (
      latestLocation &&
      (latestPriority > nextPriority ||
        (latestCompletedRequest.id !== requestId && latestCompletedRequest.priority >= nextPriority))
    ) {
      return latestLocation;
    }

    setState({
      location,
      loading: false,
      error: nextError,
      isSupported: true,
      isInServiceArea: isInServiceArea(location.lat, location.lng),
      timezone,
    });
    currentLocationRef.current = location;

    if (options?.persist !== false && user && client) {
      try {
        await saveProfileLocation(client, user.id, location);
      } catch (error) {
        console.warn("Failed to persist profile location:", error);
      }
    }

    return location;
  }, [client, resolveTimezone, reverseGeocode, user]);

  const updateLocation = useCallback(async (newLocation: Location, options?: UpdateLocationOptions) => {
    await applyLocationState(newLocation, null, options);
  }, [applyLocationState]);

  useEffect(() => {
    const isSupported = typeof navigator !== "undefined" && "geolocation" in navigator;

    const loadInitialLocation = async () => {
      const profileLocation =
        profile?.last_lat !== null &&
        profile?.last_lat !== undefined &&
        profile?.last_lng !== null &&
        profile?.last_lng !== undefined
          ? {
              lat: profile.last_lat,
              lng: profile.last_lng,
              address: profile.last_address ?? undefined,
              timezone: profile.last_timezone ?? undefined,
              source: normalizeLocationSource(profile.last_location_source),
            }
          : null;

      if (profileLocation) {
        await applyLocationState(profileLocation);

        if (isSupported) {
          void (async () => {
            try {
              const pos = await getCurrentPosition();
              const distanceMoved =
                Math.abs(pos.lat - profileLocation.lat) > 0.0001 ||
                Math.abs(pos.lng - profileLocation.lng) > 0.0001;
              if (distanceMoved) {
                await applyLocationState({ ...pos, source: "browser" });
              }
            } catch (error) {
              console.warn("Background geolocation refresh failed:", error instanceof Error ? error.message : error);
            }
          })();
        }
        return;
      }

      if (!isSupported) {
        await applyLocationState(DEFAULT_LOCATION, "Geolocation is not supported");
        return;
      }

      try {
        const pos = await getCurrentPosition();
        await applyLocationState({ ...pos, source: "browser" });
      } catch (error) {
        console.warn("Geolocation failed:", error instanceof Error ? error.message : error);
        await applyLocationState(DEFAULT_LOCATION, "无法获取定位，已回退至曼谷市中心");
      }
    };

    void loadInitialLocation();
  }, [applyLocationState, getCurrentPosition, profile]);

  return {
    ...state,
    updateLocation,
    geocode,
    detectMultipleLocations,
    defaultLocation: DEFAULT_LOCATION,
  };
}
