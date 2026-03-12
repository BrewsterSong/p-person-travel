"use client";

import { useState, useRef, useCallback } from "react";
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

  // Log whenever selectedPlace changes
  const prevSelectedPlaceRef = useRef<string | null>(null);
  if (selectedPlace?.name !== prevSelectedPlaceRef.current) {
    console.log("[Home] selectedPlace changed to:", selectedPlace?.name || null);
    prevSelectedPlaceRef.current = selectedPlace?.name || null;
  }

  // Clear route when no place is selected
  const handlePlaceSelected = useCallback((place: Place | null) => {
    // This is handled by Map component now
    void place;
  }, []);

  const handleMapPlacesChange = useCallback((places: Place[]) => {
    setMapPlaces(places);
  }, []);

  const placesForMap = mapPlaces.length > 0 ? mapPlaces : recommendedPlaces;

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      {/* Left Panel - Google Map */}
      <div className="w-1/2 h-full">
        <Map
          places={placesForMap}
          selectedPlace={selectedPlace}
          hoveredPlace={hoveredPlace}
        />
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
