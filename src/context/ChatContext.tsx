"use client";

import { createContext, useContext, ReactNode } from "react";
import { useChat, ChatState } from "@/hooks/useChat";
import { Place } from "@/types/chat";

interface ChatContextType extends ChatState {
  sendMessage: (content: string) => Promise<void>;
  clearMessages: () => void;
  setRecommendedPlaces: (places: Place[]) => void;
  loadOlderMessages: () => Promise<void>;
  loadMorePlaces: () => Promise<void>;
  loadMoreRecommendations: (allPlaces: Place[], excludeIds: string[]) => Promise<void>;
}

const ChatContext = createContext<ChatContextType | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const chatState = useChat();

  return (
    <ChatContext.Provider value={chatState}>
      {children}
    </ChatContext.Provider>
  );
}

export function useChatContext() {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error("useChatContext must be used within ChatProvider");
  }
  return context;
}
