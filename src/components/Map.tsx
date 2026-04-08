"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocationContext } from "@/context/LocationContext";
import { Place } from "@/types/chat";

interface RouteInfo {
  polyline: string;
  distance: string;
  duration: string;
}

interface MapProps {
  places?: Place[];
  selectedPlace?: Place | null;
  hoveredPlace?: Place | null;
  zoom?: number;
}

declare global {
  interface Window {
    google: typeof google;
    initMap?: () => void;
  }
}

export default function Map({
  places = [],
  selectedPlace = null,
  hoveredPlace = null,
  zoom = 14,
}: MapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<google.maps.Map | null>(null);
  // Google Maps runtime APIs and published typings are inconsistent in this project.
  // Keep marker refs loosely typed so production build is not blocked by library declaration drift.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markersRef = useRef<any[]>([]);
  const infoWindowRef = useRef<google.maps.InfoWindow | null>(null);
  const directionsServiceRef = useRef<google.maps.DirectionsService | null>(null);
  const directionsRendererRef = useRef<google.maps.DirectionsRenderer | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const originMarkerRef = useRef<any | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const destinationMarkerRef = useRef<any | null>(null);
  const { location, loading, isInServiceArea } = useLocationContext();
  const [isLoaded, setIsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [routeDisplayInfo, setRouteDisplayInfo] = useState<RouteInfo | null>(null);
  const [travelMode, setTravelMode] = useState<"DRIVING" | "WALKING" | "TRANSIT">("DRIVING");
  const [routeNotice, setRouteNotice] = useState<string>("");
  const [allRouteInfo, setAllRouteInfo] = useState<{
    DRIVING?: RouteInfo;
    WALKING?: RouteInfo;
    TRANSIT?: RouteInfo;
  }>({});
  const hasRenderablePlaces = places.some((place) => place.location?.lat && place.location?.lng);

  const googleTravelMode = useCallback((mode: "DRIVING" | "WALKING" | "TRANSIT") => {
    if (mode === "WALKING") return "walking";
    if (mode === "TRANSIT") return "transit";
    return "driving";
  }, []);

  const googleMapsDirectionsHref = useCallback(() => {
    if (!location || !selectedPlace?.location) return "";
    return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(`${location.lat},${location.lng}`)}&destination=${encodeURIComponent(`${selectedPlace.location.lat},${selectedPlace.location.lng}`)}&travelmode=${encodeURIComponent(googleTravelMode(travelMode))}`;
  }, [googleTravelMode, location, selectedPlace?.location, travelMode]);

  const applyRouteStyle = useCallback((mode: "DRIVING" | "WALKING" | "TRANSIT") => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const renderer = directionsRendererRef.current as any;
    if (!renderer) return;

    const base = {
      strokeColor: "#2563EB",
      strokeWeight: 6,
      strokeOpacity: 0.95,
    };

    if (mode === "WALKING") {
      // Render as a highlighted dashed line by hiding the solid stroke and using repeated icons.
      renderer.setOptions({
        polylineOptions: {
          ...base,
          strokeOpacity: 0,
          icons: [
            {
              icon: {
                path: "M 0,-1 0,1",
                strokeOpacity: 1,
                scale: 4,
              },
              offset: "0",
              repeat: "16px",
            },
          ],
        },
      });
      return;
    }

    if (mode === "TRANSIT") {
      renderer.setOptions({
        polylineOptions: {
          ...base,
          strokeColor: "#111827",
          strokeOpacity: 0.9,
        },
      });
      return;
    }

    renderer.setOptions({ polylineOptions: base });
  }, []);

  const ensureRouteMarkers = useCallback(() => {
    if (!isLoaded || !window.google || !mapInstance.current) return;
    // The official typings lag behind the runtime enums exposed on window.google.maps.
    // Normalize access through a loose alias so production build doesn't fail on enum members.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapsApi = window.google.maps as any;

    // Create once; positions are updated per-route.
    if (!originMarkerRef.current) {
      originMarkerRef.current = new window.google.maps.Marker({
        map: mapInstance.current,
        zIndex: 999,
        title: "我当前位置",
        // Simple iOS-like dot.
        icon: {
          path: mapsApi.SymbolPath.CIRCLE,
          scale: 6,
          fillColor: "#2563EB",
          fillOpacity: 1,
          strokeColor: "#FFFFFF",
          strokeOpacity: 1,
          strokeWeight: 3,
        } as never,
      } as never);
    }

    if (!destinationMarkerRef.current) {
      destinationMarkerRef.current = new window.google.maps.Marker({
        map: mapInstance.current,
        zIndex: 1000,
        title: selectedPlace?.name || "目的地",
        // Use default pin icon (more recognizable than a dot).
      } as never);
    }
  }, [isLoaded, selectedPlace?.name]);

  const clearRouteMarkers = useCallback(() => {
    if (originMarkerRef.current) originMarkerRef.current.setMap(null);
    if (destinationMarkerRef.current) destinationMarkerRef.current.setMap(null);
    originMarkerRef.current = null;
    destinationMarkerRef.current = null;
  }, []);

  const directionsHref = useMemo(() => googleMapsDirectionsHref(), [googleMapsDirectionsHref]);

  // Load Google Maps script
  useEffect(() => {
    if (window.google && window.google.maps) {
      setIsLoaded(true);
      return;
    }

    const script = document.createElement("script");
    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

    if (!apiKey || apiKey === "your_google_maps_api_key_here") {
      setError("Please add NEXT_PUBLIC_GOOGLE_MAPS_API_KEY to .env.local");
      return;
    }

    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&callback=initMap`;
    script.async = true;
    script.defer = true;

    window.initMap = () => {
      setIsLoaded(true);
    };

    script.onerror = () => {
      setError("Failed to load Google Maps");
    };

    document.head.appendChild(script);

    return () => {
      if (window.initMap) {
        delete window.initMap;
      }
    };
  }, []);

  // Initialize or update map
  useEffect(() => {
    if (!isLoaded || !mapRef.current || !window.google) return;

    // Create map if not exists
    if (!mapInstance.current) {
      const defaultCenter = location
        ? { lat: location.lat, lng: location.lng }
        : { lat: 13.736717, lng: 100.561119 };

      mapInstance.current = new window.google.maps.Map(mapRef.current, {
        center: defaultCenter,
        zoom: zoom,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
      });

      // Initialize DirectionsService and DirectionsRenderer
      directionsServiceRef.current = new window.google.maps.DirectionsService();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      directionsRendererRef.current = new window.google.maps.DirectionsRenderer({
        map: mapInstance.current,
        suppressMarkers: true,
        polylineOptions: {
          strokeColor: "#2563EB",
          strokeWeight: 6,
          strokeOpacity: 0.95,
        },
      } as any);
    } else if (location) {
      // Update center when location changes
      mapInstance.current.setCenter({ lat: location.lat, lng: location.lng });
    }
  }, [isLoaded, zoom, location]);

  // Request route when a place is selected - using Google Maps DirectionsService
  useEffect(() => {
    // Wait for map to be loaded
    if (!isLoaded) {
      return;
    }

    // Clear route when no place is selected
    if (!selectedPlace) {
      if (directionsRendererRef.current) {
        directionsRendererRef.current.setDirections({ routes: [] } as any);
      }
      setRouteDisplayInfo(null);
      setAllRouteInfo({});
      setRouteNotice("");
      clearRouteMarkers();
      return;
    }

    // Check if we have valid coordinates
    if (!selectedPlace.location?.lat || !selectedPlace.location?.lng) {
      return;
    }

    if (!location) {
      return;
    }

    if (!directionsServiceRef.current || !directionsRendererRef.current) {
      return;
    }

    // Fetch routes for all travel modes
    const modes: Array<"DRIVING" | "WALKING" | "TRANSIT"> = ["DRIVING", "WALKING", "TRANSIT"];
    const newAllRouteInfo: typeof allRouteInfo = {};

    if (!selectedPlace.location) return;

    let completed = 0;
    modes.forEach((mode) => {
      const request = {
        origin: { lat: location.lat, lng: location.lng },
        destination: { lat: selectedPlace.location!.lat, lng: selectedPlace.location!.lng },
        travelMode: mode,
      };

      directionsServiceRef.current!.route(request, (result: any, status: any) => {
        if (status === "OK" && result) {
          const leg = result.routes[0]?.legs[0];
          newAllRouteInfo[mode] = {
            polyline: "",
            distance: leg?.distance?.text || "",
            duration: leg?.duration?.text || "",
          };
        }
        completed++;
        if (completed === modes.length) {
          setAllRouteInfo(newAllRouteInfo);
          setRouteDisplayInfo((prev) => {
            return (
              newAllRouteInfo[travelMode] ||
              prev ||
              newAllRouteInfo.DRIVING ||
              newAllRouteInfo.WALKING ||
              newAllRouteInfo.TRANSIT ||
              null
            );
          });
          if (!newAllRouteInfo[travelMode]) {
            setRouteNotice(travelMode === "TRANSIT" ? "公交路线暂不可用，先为你显示其他路线。" : "该出行方式暂不可用。");
          } else {
            setRouteNotice("");
          }
          // Display the selected mode route on map (do not reuse last callback's request).
          const selectedRequest = {
            origin: { lat: location.lat, lng: location.lng },
            destination: { lat: selectedPlace.location!.lat, lng: selectedPlace.location!.lng },
            travelMode: travelMode,
          };
          applyRouteStyle(travelMode);
          ensureRouteMarkers();
          originMarkerRef.current?.setPosition({ lat: location.lat, lng: location.lng });
          destinationMarkerRef.current?.setPosition({ lat: selectedPlace.location!.lat, lng: selectedPlace.location!.lng });
          destinationMarkerRef.current?.setTitle(selectedPlace.name);
          directionsServiceRef.current!.route(selectedRequest, (result2: any, status2: any) => {
            if (status2 === "OK" && result2) {
              directionsRendererRef.current!.setDirections(result2);
            }
          });

          // Keep both endpoints in view.
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const bounds = new (window.google.maps as any).LatLngBounds();
            bounds.extend({ lat: location.lat, lng: location.lng } as any);
            bounds.extend({ lat: selectedPlace.location!.lat, lng: selectedPlace.location!.lng } as any);
            (mapInstance.current as any)?.fitBounds(bounds, 64);
          } catch {
            // ignore
          }
        }
      });
    });
  }, [applyRouteStyle, clearRouteMarkers, ensureRouteMarkers, isLoaded, location, selectedPlace, travelMode]);

  // Update displayed route when travel mode changes
  useEffect(() => {
    if (!selectedPlace || !location || !isLoaded || !directionsServiceRef.current || !directionsRendererRef.current) {
      return;
    }

    const newRouteInfo = allRouteInfo[travelMode];
    if (!newRouteInfo || !selectedPlace.location) {
      // Keep showing the last available route info so the header doesn't disappear.
      if (Object.keys(allRouteInfo).length > 0) {
        setRouteNotice(travelMode === "TRANSIT" ? "公交路线暂不可用" : "该出行方式暂不可用");
      }
      return;
    }
    setRouteNotice("");

    // Update display info
    setRouteDisplayInfo(newRouteInfo);

    // Update route on map
    const request = {
      origin: { lat: location.lat, lng: location.lng },
      destination: { lat: selectedPlace.location.lat, lng: selectedPlace.location.lng },
      travelMode: travelMode,
    };

    applyRouteStyle(travelMode);
    ensureRouteMarkers();
    originMarkerRef.current?.setPosition({ lat: location.lat, lng: location.lng });
    destinationMarkerRef.current?.setPosition({ lat: selectedPlace.location.lat, lng: selectedPlace.location.lng });
    destinationMarkerRef.current?.setTitle(selectedPlace.name);

    directionsServiceRef.current.route(request, (result: any, status: any) => {
      if (status === "OK" && result) {
        directionsRendererRef.current!.setDirections(result);
      }
    });

    // Ensure bounds remain reasonable when switching modes.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bounds = new (window.google.maps as any).LatLngBounds();
      bounds.extend({ lat: location.lat, lng: location.lng } as any);
      bounds.extend({ lat: selectedPlace.location.lat, lng: selectedPlace.location.lng } as any);
      (mapInstance.current as any)?.fitBounds(bounds, 64);
    } catch {
      // ignore
    }
  }, [applyRouteStyle, allRouteInfo, ensureRouteMarkers, isLoaded, location, selectedPlace, travelMode]);

  // Add markers for places
  useEffect(() => {
    if (!isLoaded || !mapInstance.current || !window.google) return;

    // Clear existing markers
    markersRef.current.forEach((marker) => marker.setMap(null));
    markersRef.current = [];

    // When a place is selected and showing route, hide other markers
    if (selectedPlace) {
      return;
    }

    // Add new markers for each place
    places.forEach((place) => {
      const lat = place.location?.lat;
      const lng = place.location?.lng;
      if (!lat || !lng) return;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mapsApi = window.google.maps as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const marker: any = new window.google.maps.Marker({
        position: { lat, lng },
        map: mapInstance.current!,
        title: place.name,
        animation: mapsApi.Animation.DROP,
        // Store place ID for hover matching
        label: place.name.substring(0, 1),
      } as any);

      // Create info window content
      const infoContent = `
        <div style="padding: 8px; max-width: 200px;">
          <h3 style="font-weight: bold; margin-bottom: 4px;">${place.name}</h3>
          <div style="color: #666; font-size: 12px;">
            ${place.rating ? `★ ${place.rating.toFixed(1)} (${place.userRatingsTotal})` : ''}
          </div>
          ${place.address ? `<div style="font-size: 11px; color: #888; margin-top: 4px;">${place.address}</div>` : ''}
        </div>
      `;

      marker.addListener("click", () => {
        if (!infoWindowRef.current) {
          infoWindowRef.current = new window.google.maps.InfoWindow();
        }
        infoWindowRef.current.setContent(infoContent);
        (infoWindowRef.current as any).open(mapInstance.current!, marker);
      });

      // Store marker with place reference
      (marker as any).placeId = place.id;
      markersRef.current.push(marker);
    });

    // Fit bounds to show all markers if there are any
    if (places.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bounds = new (window.google.maps as any).LatLngBounds();
      let hasValidMarkers = false;

      places.forEach((place) => {
        if (place.location?.lat && place.location?.lng) {
          bounds.extend({ lat: place.location.lat, lng: place.location.lng });
          hasValidMarkers = true;
        }
      });

      if (hasValidMarkers) {
        (mapInstance.current as any).fitBounds(bounds, { top: 50, right: 50, bottom: 50, left: 50 });
      }
    }
  }, [isLoaded, places, selectedPlace]);

  // Handle hover highlighting
  useEffect(() => {
    if (!isLoaded || !window.google) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapsApi = window.google.maps as any;

    markersRef.current.forEach((marker) => {
      const markerPlaceId = (marker as any).placeId;
      const isHovered = hoveredPlace && markerPlaceId === hoveredPlace.id;

      if (isHovered) {
        marker.setAnimation(mapsApi.Animation.BOUNCE);
        marker.setZIndex(1000);
        marker.setOpacity(1);
        // Pan to the marker
        mapInstance.current?.panTo(marker.getPosition()!);
      } else {
        marker.setAnimation(null);
        marker.setZIndex(null);
        marker.setOpacity(1);
      }
    });
  }, [hoveredPlace, isLoaded]);

  // Show error state
  if (error) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-gray-200">
        <div className="text-red-500 text-center p-4">
          <p className="font-semibold">Map Error</p>
          <p className="text-sm">{error}</p>
        </div>
      </div>
    );
  }

  // Show loading
  if (!isLoaded || loading) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-gray-200">
        <div className="text-gray-500">Loading map...</div>
      </div>
    );
  }

  // Show empty state when not in service area
  if (!isInServiceArea && location && !selectedPlace && !hasRenderablePlaces) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center bg-gray-100 px-4 py-6 md:px-6 md:py-8">
        <div className="relative mb-4 h-32 w-32 md:mb-6 md:h-48 md:w-48">
          <svg viewBox="0 0 200 200" className="w-full h-full">
            <circle cx="100" cy="100" r="80" fill="#E5E7EB" />
            <ellipse cx="100" cy="100" rx="80" ry="30" fill="none" stroke="#9CA3AF" strokeWidth="2" />
            <ellipse cx="100" cy="100" rx="80" ry="30" fill="none" stroke="#9CA3AF" strokeWidth="2" transform="rotate(60 100 100)" />
            <ellipse cx="100" cy="100" rx="80" ry="30" fill="none" stroke="#9CA3AF" strokeWidth="2" transform="rotate(-60 100 100)" />
            <line x1="20" y1="100" x2="180" y2="100" stroke="#9CA3AF" strokeWidth="2" />
            <line x1="100" y1="20" x2="100" y2="180" stroke="#9CA3AF" strokeWidth="2" />
            <line x1="60" y1="60" x2="140" y2="140" stroke="#EF4444" strokeWidth="8" strokeLinecap="round" />
            <line x1="140" y1="60" x2="60" y2="140" stroke="#EF4444" strokeWidth="8" strokeLinecap="round" />
          </svg>
        </div>

        <h3 className="mb-2 text-center text-lg font-semibold text-gray-800 md:text-xl">此区域暂不提供服务</h3>
        <p className="mb-4 max-w-xs text-center text-sm text-gray-600 md:text-base">
          目前支持泰国、日本、香港、越南和韩国
        </p>

        <div className="max-w-sm rounded-lg bg-white p-4 shadow-md">
          <p className="mb-2 text-sm text-gray-600">
            <span className="font-medium text-blue-600">💡 提示：</span>
            你可以在下方对话框输入具体位置来手动定位
          </p>
        </div>
      </div>
    );
  }

  // Show map
  return (
    <div className="w-full h-full relative">
      <div ref={mapRef} className="w-full h-full" />

      {/* Location indicator */}
      {location && !selectedPlace && (
        <div className="absolute left-3 top-3 z-10 max-w-[calc(100%-1.5rem)] rounded-lg bg-white px-3 py-2 text-xs shadow-md md:left-4 md:top-4 md:text-sm">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            <span className="truncate text-gray-700">
              {location.address || "定位中..."}
            </span>
          </div>
        </div>
      )}

      {/* Route info overlay */}
      {selectedPlace && location && (
        <div className="absolute left-3 right-3 top-3 z-10 rounded-2xl border border-white/50 bg-white/85 px-3 py-3 shadow-lg backdrop-blur-md md:left-4 md:right-4 md:top-4 md:px-4 md:py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-xs text-gray-600 md:text-sm">
                我的位置 <span className="text-gray-400 mx-1">→</span> <span className="text-gray-900 font-medium">{selectedPlace.name}</span>
              </p>
              {routeDisplayInfo ? (
                <p className="mt-1 text-sm font-semibold text-gray-900 md:text-base">
                  {routeDisplayInfo.duration} <span className="text-gray-400 mx-1">·</span> {routeDisplayInfo.distance}
                </p>
              ) : (
                <p className="mt-1 animate-pulse text-sm font-semibold text-gray-900 md:text-base">
                  路线计算中...
                </p>
              )}
              {routeNotice ? (
                <p className="mt-1 text-xs text-amber-700">{routeNotice}</p>
              ) : null}
            </div>
          </div>

          {/* Segmented control */}
          <div className="mt-3 flex gap-1 rounded-2xl border border-gray-200 bg-white/70 p-1">
            {(() => {
              const loaded = Object.keys(allRouteInfo).length > 0;
              const canUse = (mode: "DRIVING" | "WALKING" | "TRANSIT") => !loaded || !!allRouteInfo[mode];
              const onPick = (mode: "DRIVING" | "WALKING" | "TRANSIT") => {
                if (!canUse(mode)) {
                  setRouteNotice(mode === "TRANSIT" ? "公交路线暂不可用" : "该出行方式暂不可用");
                  return;
                }
                setRouteNotice("");
                setTravelMode(mode);
              };
              const btnBase = "flex-1 flex items-center justify-center gap-1 md:gap-2 py-2 rounded-xl text-xs md:text-sm font-medium transition-colors border";
              const btnDisabled = "text-gray-400 cursor-not-allowed border-transparent bg-transparent";
              return (
                <>
                  <button
                    onClick={() => onPick("DRIVING")}
                    disabled={!canUse("DRIVING")}
                    className={`${btnBase} ${
                      travelMode === "DRIVING"
                        ? "bg-blue-50 text-blue-700 border-blue-200 shadow-sm"
                        : (canUse("DRIVING") ? "text-gray-700 hover:bg-white/80 border-transparent" : btnDisabled)
                    }`}
                  >
                    <span className="text-sm md:text-base">🚗</span>
                    <span>{allRouteInfo.DRIVING?.duration || "驾驶"}</span>
                  </button>
                  <button
                    onClick={() => onPick("WALKING")}
                    disabled={!canUse("WALKING")}
                    className={`${btnBase} ${
                      travelMode === "WALKING"
                        ? "bg-blue-50 text-blue-700 border-blue-200 shadow-sm"
                        : (canUse("WALKING") ? "text-gray-700 hover:bg-white/80 border-transparent" : btnDisabled)
                    }`}
                  >
                    <span className="text-sm md:text-base">🚶</span>
                    <span>{allRouteInfo.WALKING?.duration || "步行"}</span>
                  </button>
                  <button
                    onClick={() => onPick("TRANSIT")}
                    disabled={!canUse("TRANSIT")}
                    className={`${btnBase} ${
                      travelMode === "TRANSIT"
                        ? "bg-blue-50 text-blue-700 border-blue-200 shadow-sm"
                        : (canUse("TRANSIT") ? "text-gray-700 hover:bg-white/80 border-transparent" : btnDisabled)
                    }`}
                  >
                    <span className="text-sm md:text-base">🚌</span>
                    <span>{allRouteInfo.TRANSIT?.duration || "公交"}</span>
                  </button>
                </>
              );
            })()}
          </div>

          {/* Deep link */}
          <a
            href={directionsHref || undefined}
            target="_blank"
            rel="noreferrer"
            className={`mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-semibold transition-colors ${
              directionsHref ? "bg-blue-600 text-white hover:bg-blue-700" : "bg-gray-200 text-gray-500 pointer-events-none"
            }`}
          >
            <span>↗</span>
            <span>在 Google Maps 中打开</span>
          </a>
        </div>
      )}
    </div>
  );
}
