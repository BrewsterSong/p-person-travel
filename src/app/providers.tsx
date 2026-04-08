"use client";

import { AuthProvider } from "@/context/AuthContext";
import { LocationProvider } from "@/context/LocationContext";
import { ChatProvider } from "@/context/ChatContext";
import { PlaceProvider } from "@/context/PlaceContext";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <LocationProvider>
        <ChatProvider>
          <PlaceProvider>
            {children}
          </PlaceProvider>
        </ChatProvider>
      </LocationProvider>
    </AuthProvider>
  );
}
