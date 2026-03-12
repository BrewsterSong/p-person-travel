"use client";

import { LocationProvider } from "@/context/LocationContext";
import { ChatProvider } from "@/context/ChatContext";
import { PlaceProvider } from "@/context/PlaceContext";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <LocationProvider>
      <ChatProvider>
        <PlaceProvider>
          {children}
        </PlaceProvider>
      </ChatProvider>
    </LocationProvider>
  );
}
