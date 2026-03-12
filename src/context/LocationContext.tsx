"use client";

import { createContext, useContext, ReactNode } from "react";
import { useLocation, Location, LocationState } from "@/hooks/useLocation";

interface LocationContextType extends LocationState {
  updateLocation: (location: Location) => Promise<void>;
  geocode: (address: string) => Promise<Location | null>;
  detectMultipleLocations: (address: string) => Promise<Location[]>;
  defaultLocation: Location;
}

const LocationContext = createContext<LocationContextType | null>(null);

export function LocationProvider({ children }: { children: ReactNode }) {
  const locationState = useLocation();

  return (
    <LocationContext.Provider value={locationState}>
      {children}
    </LocationContext.Provider>
  );
}

export function useLocationContext() {
  const context = useContext(LocationContext);
  if (!context) {
    throw new Error("useLocationContext must be used within LocationProvider");
  }
  return context;
}
