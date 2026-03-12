export interface PlaceRecommendation {
  id: string;
  reason: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  // 消息内嵌的推荐地点
  recommendations?: PlaceRecommendation[];
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
