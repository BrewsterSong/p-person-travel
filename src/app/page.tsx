"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { useChatContext } from "@/context/ChatContext";
import { usePlaceContext } from "@/context/PlaceContext";
import Map from "@/components/Map";
import Chat from "@/components/Chat";
import { Place } from "@/types/chat";

export default function Home() {
  const { recommendedPlaces } = useChatContext();
  const { selectedPlace } = usePlaceContext();
  const [hoveredPlace, setHoveredPlace] = useState<Place | null>(null);
  const [mapPlaces, setMapPlaces] = useState<Place[]>([]);
  const [mobileMapHeight, setMobileMapHeight] = useState(38);
  const [desktopMapWidth, setDesktopMapWidth] = useState(50);
  const [isDraggingDivider, setIsDraggingDivider] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Clear route when no place is selected
  const handlePlaceSelected = useCallback((place: Place | null) => {
    // This is handled by Map component now
    void place;
  }, []);

  const handleMapPlacesChange = useCallback((places: Place[]) => {
    setMapPlaces(places);
  }, []);

  const updateMobileMapHeight = useCallback((clientY: number) => {
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const next = ((clientY - rect.top) / rect.height) * 100;
    const clamped = Math.max(24, Math.min(68, next));
    setMobileMapHeight(clamped);
  }, []);

  const updateDesktopMapWidth = useCallback((clientX: number) => {
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const next = ((clientX - rect.left) / rect.width) * 100;
    const clamped = Math.max(28, Math.min(72, next));
    setDesktopMapWidth(clamped);
  }, []);

  useEffect(() => {
    const syncViewportMode = () => {
      setIsDesktop(window.innerWidth >= 768);
    };

    syncViewportMode();
    window.addEventListener("resize", syncViewportMode);
    return () => window.removeEventListener("resize", syncViewportMode);
  }, []);

  useEffect(() => {
    if (!isDraggingDivider) return;

    const handlePointerMove = (event: PointerEvent) => {
      if (isDesktop) {
        updateDesktopMapWidth(event.clientX);
        return;
      }
      updateMobileMapHeight(event.clientY);
    };

    const handlePointerUp = () => {
      setIsDraggingDivider(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [isDesktop, isDraggingDivider, updateDesktopMapWidth, updateMobileMapHeight]);

  const placesForMap = mapPlaces.length > 0 ? mapPlaces : recommendedPlaces;

  return (
    <div
      ref={containerRef}
      className={`flex h-dvh w-screen flex-col overflow-hidden md:h-screen md:flex-row ${isDraggingDivider ? "select-none" : ""}`}
    >
      {/* Left Panel - Google Map */}
      <div
        className="w-full md:h-full"
        style={
          isDesktop
            ? { width: `${desktopMapWidth}%` }
            : { height: `calc(${mobileMapHeight}dvh - 10px)` }
        }
      >
        <Map
          places={placesForMap}
          selectedPlace={selectedPlace}
          hoveredPlace={hoveredPlace}
        />
      </div>

      <div className="relative flex h-8 w-full items-center justify-center bg-white md:hidden">
        <button
          type="button"
          aria-label="拖动调整地图和聊天区域高度"
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            setIsDraggingDivider(true);
            updateMobileMapHeight(event.clientY);
          }}
          onPointerCancel={() => setIsDraggingDivider(false)}
          onLostPointerCapture={() => setIsDraggingDivider(false)}
          className="flex h-8 w-full items-center justify-center touch-none"
          style={{ touchAction: "none", WebkitUserSelect: "none" }}
        >
          <span className={`h-1.5 w-16 rounded-full transition-colors ${isDraggingDivider ? "bg-blue-400" : "bg-gray-300"}`} />
        </button>
      </div>

      <div className="hidden h-full w-5 items-center justify-center bg-white md:flex">
        <button
          type="button"
          aria-label="拖动调整地图和聊天区域宽度"
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            setIsDraggingDivider(true);
            updateDesktopMapWidth(event.clientX);
          }}
          className="flex h-full w-5 items-center justify-center touch-none"
          style={{ touchAction: "none", cursor: "col-resize" }}
        >
          <span className="h-14 w-1.5 rounded-full bg-gray-300" />
        </button>
      </div>

      {/* Right Panel - AI Chat */}
      <Chat
        onPlaceSelected={handlePlaceSelected}
        onPlaceHover={setHoveredPlace}
        onMapPlacesChange={handleMapPlacesChange}
      />
    </div>
  );
}
