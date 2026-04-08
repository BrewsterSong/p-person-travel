export interface PlaceRecommendation {
  id: string;
  reason: string;
}

export interface DiscussionComment {
  id: string;
  author: string;
  body: string;
  score: number;
  createdUtc?: number;
}

export interface DiscussionCard {
  id: string;
  source: "reddit";
  title: string;
  cardType: "discussion";
  url: string;
  snippet: string;
  body?: string;
  subreddit: string;
  commentCount: number | null;
  ageText: string;
  displaySource: string;
  thumbnail?: string;
  query: string;
  destinationHints?: string[];
  permalink?: string;
  // Legacy-compatible optional fields
  summary?: string;
  author?: string;
  createdUtc?: number;
  score?: number;
  highlights?: string[];
  mentionedPlaces?: string[];
  topComments?: DiscussionComment[];
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  messageType?: "system" | "user" | "assistant";
  createdAt?: string;
  meta?: Record<string, unknown>;
  placesSnapshot?: Place[];
  // 消息内嵌的推荐地点
  recommendations?: PlaceRecommendation[];
  // 消息内嵌的旅行讨论卡
  discussions?: DiscussionCard[];
}

export interface Place {
  id: string;
  name: string;
  address: string;
  location?: { lat: number; lng: number };
  rating: number;
  userRatingsTotal: number;
  priceLevel?: number;
  openNow?: boolean;
  photos?: string[];
  reason?: string;
  // Type fields for filtering
  primaryType?: string;
  types?: string[];
  // Detail fields
  formattedPhoneNumber?: string;
  openingHours?: string[];
  reviews?: Review[];
  editorialSummary?: string;
}

export interface Review {
  authorName: string;
  rating: number;
  text: string;
  relativeTimeDescription: string;
}
