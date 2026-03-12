"use client";

import { useState, useEffect, useCallback } from "react";

export interface Location {
  lat: number;
  lng: number;
  address?: string;
}

export interface LocationState {
  location: Location | null;
  loading: boolean;
  error: string | null;
  isSupported: boolean;
  isInServiceArea: boolean;
}

// Thailand and Japan bounds (rough bounding boxes)
const THAILAND_BOUNDS = {
  north: 20.5,
  south: 5.5,
  east: 105.9,
  west: 97.3,
};

const JAPAN_BOUNDS = {
  north: 45.5,
  south: 24.0,
  east: 146.0,
  west: 122.0,
};

function isInServiceArea(lat: number, lng: number): boolean {
  // Check Thailand
  if (
    lat >= THAILAND_BOUNDS.south &&
    lat <= THAILAND_BOUNDS.north &&
    lng >= THAILAND_BOUNDS.west &&
    lng <= THAILAND_BOUNDS.east
  ) {
    return true;
  }

  // Check Japan
  if (
    lat >= JAPAN_BOUNDS.south &&
    lat <= JAPAN_BOUNDS.north &&
    lng >= JAPAN_BOUNDS.west &&
    lng <= JAPAN_BOUNDS.east
  ) {
    return true;
  }

  return false;
}

// Default fallback location (Bangkok)
const DEFAULT_LOCATION: Location = {
  lat: 13.736717,
  lng: 100.561119,
  address: "曼谷市中心",
};

export function useLocation() {
  const [state, setState] = useState<LocationState>({
    location: null,
    loading: true,
    error: null,
    isSupported: false,
    isInServiceArea: false,
  });

  const getCurrentPosition = useCallback(() => {
    return new Promise<Location>((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("Geolocation is not supported"));
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          const { latitude, longitude } = position.coords;
          resolve({ lat: latitude, lng: longitude });
        },
        (error) => {
          reject(error);
        },
        {
          timeout: 10000,
          maximumAge: 300000, // 5 minutes cache
        }
      );
    });
  }, []);

  const reverseGeocode = useCallback(async (lat: number, lng: number): Promise<string> => {
    const clientFallback = async () => {
      const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
      if (!apiKey) return "";
      const response = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}&language=zh-CN`
      );
      const data = await response.json();
      return data.results?.[0]?.formatted_address || "";
    };

    try {
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
  }, []);

  const geocode = useCallback(async (address: string): Promise<Location | null> => {
    const clientFallback = async (): Promise<Location | null> => {
      const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
      if (!apiKey) return null;
      const response = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}&language=zh-CN`
      );
      const data = await response.json();
      if (data.results?.[0]) {
        const location = data.results[0].geometry.location;
        return { lat: location.lat, lng: location.lng, address: data.results[0].formatted_address };
      }
      return null;
    };

    try {
      const response = await fetch("/api/geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const data = await response.json();
      if (response.ok && typeof data.lat === "number" && typeof data.lng === "number") {
        return {
          lat: data.lat,
          lng: data.lng,
          address: data.address,
        };
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
  }, []);

  const detectMultipleLocations = useCallback(async (address: string): Promise<Location[]> => {
    const clientFallback = async (): Promise<Location[]> => {
      const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
      if (!apiKey) return [];
      const response = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}&language=zh-CN`
      );
      const data = await response.json();
      return Array.isArray(data.results)
        ? data.results.map((result: any) => ({
            lat: result.geometry.location.lat,
            lng: result.geometry.location.lng,
            address: result.formatted_address,
          }))
        : [];
    };

    try {
      const response = await fetch("/api/geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, allowMultiple: true }),
      });
      const data = await response.json();
      if (response.ok && Array.isArray(data.multiple)) {
        return data.multiple;
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
  }, []);

  const updateLocation = useCallback(async (newLocation: Location) => {
    const inServiceArea = isInServiceArea(newLocation.lat, newLocation.lng);
    let address = newLocation.address;

    if (!address) {
      address = await reverseGeocode(newLocation.lat, newLocation.lng);
    }

    setState({
      location: { ...newLocation, lat: newLocation.lat, lng: newLocation.lng, address },
      loading: false,
      error: null,
      isSupported: true,
      isInServiceArea: inServiceArea,
    });
  }, [reverseGeocode]);

  useEffect(() => {
    // Check if geolocation is supported
    const isSupported = typeof navigator !== "undefined" && "geolocation" in navigator;

    if (!isSupported) {
      setState({
        location: DEFAULT_LOCATION,
        loading: false,
        error: "Geolocation is not supported",
        isSupported: false,
        isInServiceArea: true, // Assume in service area for manual input
      });
      return;
    }

    // Try to get current position
    getCurrentPosition()
      .then(async (pos) => {
        const inServiceArea = isInServiceArea(pos.lat, pos.lng);
        const address = await reverseGeocode(pos.lat, pos.lng);

        setState({
          location: { ...pos, address },
          loading: false,
          error: null,
          isSupported: true,
          isInServiceArea: inServiceArea,
        });
      })
      .catch(async (error) => {
        // Fallback to default location
        console.warn("Geolocation failed:", error.message);
        setState({
          location: DEFAULT_LOCATION,
          loading: false,
          error: "无法获取定位，已回退至曼谷市中心",
          isSupported: true,
          isInServiceArea: true,
        });
      });
  }, [getCurrentPosition, reverseGeocode]);

  return {
    ...state,
    updateLocation,
    geocode,
    detectMultipleLocations,
    defaultLocation: DEFAULT_LOCATION,
  };
}
