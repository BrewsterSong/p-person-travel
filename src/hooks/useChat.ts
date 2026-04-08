"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { ChatMessage, DiscussionCard, Place, PlaceRecommendation } from "@/types/chat";
import type { Location } from "@/hooks/useLocation";
import { useLocationContext } from "@/context/LocationContext";
import { useAuthContext } from "@/context/AuthContext";
import { haversineMeters } from "@/lib/distance";
import {
  appendChatMessages,
  createChatSession,
  deserializeChatMessage,
  fetchChatMessagesPage,
  getChatSession,
  getLatestChatSession,
  getPreviousChatSession,
  getProfile,
  INITIAL_MESSAGE_PAGE_SIZE,
  OLDER_MESSAGE_PAGE_SIZE,
  serializeChatMessage,
  shouldRotateSession,
  type PersistedChatSession,
} from "@/lib/supabase/appData";

// 防范坑点1：移除 Markdown 代码块标记的安全解析函数
// 修复：先用正则提取大括号内容再解析，解决"开头有废话"导致的 JSON.parse 报错
function extractAndParseJSON(content: string): { intro: string; recommendations: PlaceRecommendation[]; rawText: string } {
  if (!content) return { intro: "帮你精选了这5家店：", recommendations: [], rawText: "" };

  try {
    // Step 1: 先移除 Markdown 代码块标记
    let cleaned = content
      .replace(/^```json\s*/, "")
      .replace(/^```\s*/, "")
      .replace(/```\s*$/, "")
      .trim();

    // Step 2: 用正则提取大括号内容（解决"开头有废话"导致的解析冲突）
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // 没有找到 JSON，直接返回原始文本
      return {
        intro: content,
        recommendations: [],
        rawText: content,
      };
    }

    const jsonStr = jsonMatch[0];
    const parsed = JSON.parse(jsonStr);

    const placesArray =
      Array.isArray(parsed.places) ? parsed.places :
      Array.isArray(parsed.recommendations) ? parsed.recommendations :
      [];

    return {
      intro: parsed.intro || "帮你精选了这5家店：",
      recommendations: placesArray,
      rawText: "",
    };
  } catch (error) {
    // 解析失败时，优雅降级：将原始文本作为对话内容返回
    return {
      intro: content,
      recommendations: [],
      rawText: content,
    };
  }
}

/**
 * 判断搜索意图是否包含住宿类型
 */
function isAccommodationIntent(includedTypes: string[]): boolean {
  return includedTypes.some(t =>
    t === "hotel" || t === "lodging" || t === "guest_house" || t === "hostel" || t === "resort"
  );
}

/**
 * 前端数据净化函数
 * 如果当前意图不包含住宿，则过滤掉所有包含 hotel/lodging 的地点
 * 确保发给 LLM 的是纯净数据
 */
function filterPlacesByIntent(places: Place[], includedTypes: string[]): Place[] {
  // 如果意图包含住宿，不过滤
  if (isAccommodationIntent(includedTypes)) {
    return places;
  }

  // 否则过滤掉“以住宿为主业”的地点。
  // 注意：很多综合体/商场会同时带有 hotel/lodging 等 types（例如综合体内有酒店），不能一刀切过滤 types。
  const filtered = places.filter(place => {
    const primaryType = (place.primaryType || "").toLowerCase();
    const types = (place.types || []).map(t => t.toLowerCase());

    // 一票否决：如果 primaryType 或 types 包含 hotel/lodging，则排除
    if (primaryType.includes("hotel") || primaryType.includes("lodging")) {
      return false;
    }

    return true;
  });

  return filtered;
}

function inferIncludedTypesFromUserMessage(message: string): string[] {
  const m = (message || "").toLowerCase();
  if (!m) return [];
  if (/(便利店|convenience|7-11|7eleven|seven eleven|罗森|lawson|全家|familymart)/i.test(m)) return ["convenience_store"];
  if (/(买手店|选品店|boutique|select shop|服装店|衣服|古着|vintage)/i.test(m)) return ["clothing_store", "store"];
  if (/(唱片店|黑胶|record store|vinyl)/i.test(m)) return ["store"];
  if (/(出片|机位|拍照|取景|打卡点)/i.test(m)) return ["tourist_attraction", "park"];
  if (/(酒店|住宿|民宿|hostel|hotel|lodging)/i.test(m)) return ["hotel", "lodging"];
  if (/(商场|购物|逛街|mall|shopping)/i.test(m)) return ["shopping_mall"];
  if (/(景点|打卡|观光|tourist|attraction|博物馆|museum|公园|park)/i.test(m)) return ["tourist_attraction"];
  if (/(酒吧|bar|鸡尾酒|cocktail)/i.test(m)) return ["bar"];
  if (/(咖啡|cafe)/i.test(m)) return ["cafe"];
  if (/(烤肉|烧肉)/i.test(m)) return ["korean_restaurant", "barbecue_restaurant"];
  if (/(烧烤|bbq|barbecue)/i.test(m)) return ["barbecue_restaurant"];
  if (/(餐厅|吃|美食|夜宵|宵夜|restaurant)/i.test(m)) return ["restaurant"];
  return [];
}

function isConvenienceStoreIntent(includedTypes: string[], userMessage: string): boolean {
  const types = (includedTypes || []).map((t) => String(t).toLowerCase());
  if (types.includes("convenience_store")) return true;
  return /(便利店|convenience|7-11|7eleven|seven eleven|罗森|lawson|全家|familymart)/i.test(userMessage || "");
}

function isRetailNearbyIntent(includedTypes: string[], userMessage: string): boolean {
  const types = (includedTypes || []).map((t) => String(t).toLowerCase());
  if (types.includes("convenience_store")) return true;
  if (types.includes("clothing_store")) return true;
  if (/(买手店|选品店|boutique|select shop|服装店|衣服|古着|vintage|唱片店|黑胶|record store|vinyl)/i.test(userMessage || "")) {
    return true;
  }
  return false;
}

function isOpenNowRequest(userMessage: string): boolean {
  const msg = (userMessage || "").trim();
  if (!msg) return false;
  return [
    /只看.*(?:营业|开门|开着)/,
    /(?:正在营业|营业中|还开|开着|开门|没打烊|没有打烊|未打烊|不打烊)/,
    /(?:不要|别|排除|不想要|不看).*打烊/,
    /(?:没有|没|未|不).*打烊/,
    /(?:现在|当前|此时|这会儿|马上).*(?:营业|开门|开着|能去)/,
    /(?:夜宵|宵夜)/,
    /open\s*now/i,
  ].some((re) => re.test(msg));
}

function filterPlacesByOpenNow(places: Place[]): Place[] {
  return places.filter((place) => place.openNow === true);
}

function normalizeClientTextQuery(params: { userMessage: string; textQuery: string }): string {
  const { userMessage, textQuery } = params;
  let q = (textQuery || userMessage || "").trim();

  // If user says "我在X附近/边上/旁边/周边/一带"，X 是位置上下文，不应变成搜索目标的一部分。
  // Example: "我在东京塔边上，有没有商场推荐可以逛逛" => "有没有商场推荐可以逛逛"
  q = q
    .replace(/^(?:我|现在)?在.+?(?:附近|周边|旁边|边上|一带)\s*[，,、]?\s*/i, "")
    .trim();

  // If it becomes too generic, fall back to original query.
  if (!q) q = (textQuery || "").trim() || (userMessage || "").trim();

  // Canonicalize a few high-signal intents to reduce "地标词"污染.
  if (/(咖啡|咖啡店|咖啡厅|咖啡馆|cafe|coffee)/i.test(userMessage) || /(咖啡|cafe|coffee)/i.test(q)) {
    return "cafe";
  }
  if (/(酒吧|bar|鸡尾酒|cocktail)/i.test(userMessage) || /(bar|cocktail)/i.test(q)) {
    return "bar";
  }
  if (/(烤肉|烧肉|烧烤|bbq|barbecue)/i.test(userMessage) || /(烤肉|烧肉|烧烤|bbq|barbecue)/i.test(q)) {
    return "barbecue restaurant";
  }
  if (
    /(餐厅|吃|美食|晚餐|午餐|早餐|夜宵|宵夜|restaurant|food)/i.test(userMessage) ||
    /(餐厅|restaurant|food)/i.test(q)
  ) {
    return "restaurant";
  }
  if (/(商场|购物|逛街|mall|shopping)/i.test(userMessage)) return "shopping mall";
  if (/(便利店|convenience|7-11|7eleven|seven eleven|罗森|lawson|全家|familymart)/i.test(userMessage)) return "convenience store";
  if (/(买手店|选品店|boutique|select shop|服装店|衣服|古着|vintage)/i.test(userMessage)) return "boutique";
  if (/(唱片店|黑胶|record store|vinyl)/i.test(userMessage)) return "record store";
  return q;
}

function filterPlacesByRadius(params: { places: Place[]; centerLat: number; centerLng: number; radius: number }): Place[] {
  const { places, centerLat, centerLng, radius } = params;
  const origin = { lat: centerLat, lng: centerLng };
  const max = Math.max(500, radius) * 1.1; // small cushion
  const kept = places.filter((p) => {
    if (!p.location) return false;
    const d = haversineMeters(origin, p.location);
    return Number.isFinite(d) && d <= max;
  });
  // If filtering is too aggressive, keep original list (Text Search sometimes returns sparse results).
  return kept.length >= Math.min(5, places.length) ? kept : places;
}

function filterPlacesByShoppingIntent(params: { places: Place[]; includedTypes: string[] }): Place[] {
  const { places, includedTypes } = params;
  const wantMall = includedTypes.some((t) => String(t).toLowerCase() === "shopping_mall");
  if (!wantMall) return places;
  const kept = places.filter((p) => {
    const pt = (p.primaryType || "").toLowerCase();
    const tys = (p.types || []).map((t) => String(t).toLowerCase());
    return pt === "shopping_mall" || tys.includes("shopping_mall");
  });
  return kept.length >= 3 ? kept : places;
}

function filterPlacesByConvenienceIntent(params: { places: Place[]; includedTypes: string[] }): Place[] {
  const { places, includedTypes } = params;
  const want = includedTypes.some((t) => String(t).toLowerCase() === "convenience_store");
  if (!want) return places;
  const kept = places.filter((p) => {
    const pt = (p.primaryType || "").toLowerCase();
    const tys = (p.types || []).map((t) => String(t).toLowerCase());
    return pt === "convenience_store" || tys.includes("convenience_store");
  });
  return kept.length >= 5 ? kept : places;
}

function filterPlacesByRestaurantIntent(params: { places: Place[]; includedTypes: string[]; strict?: boolean }): Place[] {
  const { places, includedTypes, strict = false } = params;
  const types = includedTypes.map((t) => String(t).toLowerCase());
  const want = types.some((t) =>
    t === "restaurant" ||
    t === "cafe" ||
    t === "bar" ||
    t.includes("restaurant")
  );
  if (!want) return places;

  const kept = places.filter((p) => {
    const placeTypes = [(p.primaryType || ""), ...(p.types || [])].map((t) => String(t).toLowerCase());
    return placeTypes.some((t) =>
      t === "restaurant" ||
      t === "cafe" ||
      t === "bar" ||
      t === "bakery" ||
      t === "meal_takeaway" ||
      t === "meal_delivery" ||
      t === "coffee_shop" ||
      t.includes("restaurant") ||
      t.includes("food")
    );
  });

  return strict ? kept : kept.length >= 3 ? kept : places;
}

function mergePlacesPreservingOrder(primary: Place[], fallback: Place[], limit?: number): Place[] {
  const merged: Place[] = [];
  const seen = new Set<string>();

  for (const place of [...primary, ...fallback]) {
    if (!place?.id || seen.has(place.id)) continue;
    seen.add(place.id);
    merged.push(place);
    if (typeof limit === "number" && merged.length >= limit) break;
  }

  return merged;
}

type CachedPlacesSearch = {
  v: number;
  places: Place[];
  nextPageToken: string | null;
  cachedAt: number;
};

const PLACES_CACHE_VERSION = 2;
const REASONS_CACHE_VERSION = 3;

const PLACEHOLDER_PHOTO_DATA_URI =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='300'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%23E5E7EB'/%3E%3Cstop offset='1' stop-color='%23CBD5E1'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='400' height='300' fill='url(%23g)'/%3E%3Ctext x='50%25' y='50%25' text-anchor='middle' dy='.35em' font-size='18' fill='%236B7280'%3E%E6%97%A0%E5%9B%BE%3C/text%3E%3C/svg%3E";

function hashString(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function roundCoord(n: number): string {
  return Number.isFinite(n) ? n.toFixed(5) : String(n);
}

function buildPlacesCacheKey(params: {
  textQuery: string;
  lat: number;
  lng: number;
  radius?: number;
  openNowOnly?: boolean;
}) {
  const { textQuery, lat, lng, radius = 5000, openNowOnly = false } = params;
  return `gmaps_search_${encodeURIComponent(textQuery)}_${roundCoord(lat)}_${roundCoord(lng)}_${radius}_${openNowOnly ? "open" : "any"}`;
}

function getCachedPlaces(cacheKey: string): CachedPlacesSearch | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(cacheKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedPlacesSearch> | null;
    if (!parsed || parsed.v !== PLACES_CACHE_VERSION) return null;
    if (!parsed || !Array.isArray(parsed.places)) return null;
    return {
      v: PLACES_CACHE_VERSION,
      places: parsed.places as Place[],
      nextPageToken: typeof parsed.nextPageToken === "string" ? parsed.nextPageToken : null,
      cachedAt: typeof parsed.cachedAt === "number" ? parsed.cachedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

function setCachedPlaces(cacheKey: string, payload: { places: Place[]; nextPageToken: string | null }) {
  if (typeof window === "undefined") return;
  try {
    const value: CachedPlacesSearch = { v: PLACES_CACHE_VERSION, ...payload, cachedAt: Date.now() };
    window.sessionStorage.setItem(cacheKey, JSON.stringify(value));
  } catch {
    // Best-effort cache; ignore quota/serialization errors.
  }
}

function isCachePayloadLikelyBroken(places: Place[]): boolean {
  if (!places || places.length === 0) return true;
  const allZeroReviews = places.every((p) => !p.userRatingsTotal || p.userRatingsTotal === 0);
  const allNoPhotos = places.every((p) => !p.photos || p.photos.length === 0);
  // If both are missing across the entire page, treat cache as unusable and refetch.
  return allZeroReviews && allNoPhotos;
}

function ensureCardSafePlace(place: Place): Place {
  const photos = Array.isArray(place.photos)
    ? place.photos.filter((p) => typeof p === "string" && p)
    : [];

  return {
    ...place,
    rating: typeof place.rating === "number" ? place.rating : 0,
    userRatingsTotal: typeof place.userRatingsTotal === "number" ? place.userRatingsTotal : 0,
    photos: photos.length > 0 ? photos : [PLACEHOLDER_PHOTO_DATA_URI],
  };
}

function isAlreadyTransformedPlaceArray(value: unknown): value is Place[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const firstUnknown = value[0] as unknown;
  if (!firstUnknown || typeof firstUnknown !== "object") return false;
  const first = firstUnknown as Record<string, unknown>;
  const hasBasicStrings =
    typeof first.id === "string" &&
    typeof first.name === "string" &&
    typeof first.address === "string";
  const photosAreStrings =
    !("photos" in first) ||
    (Array.isArray(first.photos) &&
      ((first.photos as unknown[]).length === 0 || typeof (first.photos as unknown[])[0] === "string"));
  return !!hasBasicStrings && !!photosAreStrings;
}

function normalizePlacesFromGoogle(rawPlaces: unknown): Place[] {
  return normalizePlacesFromGoogleWithMediaMode(rawPlaces, "proxy");
}

function normalizePlacesFromGoogleWithMediaMode(rawPlaces: unknown, mediaMode: "proxy" | "direct"): Place[] {
  if (isAlreadyTransformedPlaceArray(rawPlaces)) {
    return rawPlaces.map(ensureCardSafePlace);
  }
  if (!Array.isArray(rawPlaces)) return [];

  return (rawPlaces as unknown[]).map((placeUnknown: unknown) => {
    const place = (placeUnknown && typeof placeUnknown === "object")
      ? (placeUnknown as Record<string, unknown>)
      : ({} as Record<string, unknown>);

    const displayName = place.displayName as Record<string, unknown> | undefined;
    const displayNameText = typeof displayName?.text === "string" ? displayName.text : "";

    const locationObj = place.location as Record<string, unknown> | undefined;
    const lat =
      (typeof locationObj?.latitude === "number" ? locationObj.latitude : undefined) ??
      (typeof locationObj?.lat === "number" ? locationObj.lat : undefined);
    const lng =
      (typeof locationObj?.longitude === "number" ? locationObj.longitude : undefined) ??
      (typeof locationObj?.lng === "number" ? locationObj.lng : undefined);

    const currentOpeningHours = place.currentOpeningHours as Record<string, unknown> | undefined;

    const rawPhotos = place.photos as unknown;
    const photoUrls = Array.isArray(rawPhotos)
      ? (rawPhotos as unknown[])
          .slice(0, 3)
          .map((photoUnknown) => {
            if (typeof photoUnknown === "string") return photoUnknown;
            if (!photoUnknown || typeof photoUnknown !== "object") return "";
            const photo = photoUnknown as Record<string, unknown>;
            if (typeof photo.name === "string" && photo.name) {
              if (mediaMode === "direct") {
                const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
                return key
                  ? `https://places.googleapis.com/v1/${photo.name}/media?maxWidthPx=400&key=${key}`
                  : "";
              }
              return `/api/place-photo?name=${encodeURIComponent(photo.name)}&maxWidthPx=400`;
            }
            const getUrl = photo.getUrl;
            if (typeof getUrl === "function") {
              try {
                return (getUrl as () => string)();
              } catch {
                return "";
              }
            }
            return "";
          })
          .filter((u) => typeof u === "string" && u)
      : [];

    const mapped: Place = {
      id: typeof place.id === "string" ? place.id : "",
      name:
        displayNameText ||
        (typeof place.name === "string" ? place.name : ""),
      address:
        (typeof place.formattedAddress === "string" ? place.formattedAddress : "") ||
        (typeof place.address === "string" ? place.address : ""),
      location: typeof lat === "number" && typeof lng === "number" ? { lat, lng } : undefined,
      rating: typeof place.rating === "number" ? place.rating : 0,
      userRatingsTotal:
        (typeof place.userRatingCount === "number" ? place.userRatingCount : undefined) ??
        (typeof place.user_ratings_total === "number" ? place.user_ratings_total : undefined) ??
        (typeof place.userRatingsTotal === "number" ? place.userRatingsTotal : undefined) ??
        0,
      priceLevel: typeof place.priceLevel === "number" ? place.priceLevel : undefined,
      openNow:
        (typeof currentOpeningHours?.openNow === "boolean" ? currentOpeningHours.openNow : undefined) ??
        (typeof place.openNow === "boolean" ? place.openNow : undefined),
      photos: photoUrls,
      primaryType: typeof place.primaryType === "string" ? place.primaryType : "",
      types: Array.isArray(place.types) ? (place.types as string[]) : [],
    };

    return ensureCardSafePlace(mapped);
  });
}

async function clientSearchPlaces(params: {
  textQuery: string;
  lat: number;
  lng: number;
  radius: number;
  nextPageToken?: string;
  openNowOnly?: boolean;
}): Promise<{ places: Place[]; nextPageToken: string | null }> {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    throw new Error("Missing NEXT_PUBLIC_GOOGLE_MAPS_API_KEY for dev fallback");
  }

  const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.priceLevel,places.currentOpeningHours,places.photos,places.primaryType,places.types,nextPageToken",
    },
    body: JSON.stringify(
      params.nextPageToken
        ? { pageToken: params.nextPageToken }
        : {
            textQuery: params.textQuery,
            locationBias: {
              circle: {
                center: {
                  latitude: params.lat,
                  longitude: params.lng,
                },
                radius: params.radius,
              },
            },
            ...(params.openNowOnly ? { openNow: true } : {}),
            maxResultCount: 20,
          }
    ),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error?.message || data?.error || "Direct Google Places request failed");
  }

  return {
    places: normalizePlacesFromGoogleWithMediaMode(data.places || [], "direct"),
    nextPageToken: data.nextPageToken || null,
  };
}

export interface ChatState {
  messages: (ChatMessage & { id: string })[];
  isLoading: boolean;
  isHydratingHistory: boolean;
  error: string | null;
  recommendedPlaces: Place[];
  allPlaces: Place[]; // 存储所有获取的地点（20个），用于"换一批"
  nextPageToken: string | null;
  activeSessionId: string | null;
  hasMoreHistory: boolean;
}

type LastPlacesSearchContext = {
  textQuery: string;
  latitude: number;
  longitude: number;
  radius: number;
  includedTypes: string[];
  places: Place[];
};

type SearchAnchor = {
  lat: number;
  lng: number;
  address?: string;
  timezone?: string;
  source?: Location["source"];
};

const LOCATION_SESSION_ROTATION_DISTANCE_METERS = 30_000;

type EnsureActiveChatSessionResult = {
  session: PersistedChatSession | null;
  startedFresh: boolean;
  rotationReason: "missing" | "timeout" | "location" | null;
  hasOlderHistory: boolean;
};

function locationFromSessionSnapshot(snapshot: PersistedChatSession["location_snapshot"]): Location | null {
  if (!snapshot || typeof snapshot !== "object") return null;

  const lat = snapshot.lat;
  const lng = snapshot.lng;
  if (typeof lat !== "number" || typeof lng !== "number") return null;

  return {
    lat,
    lng,
    address: typeof snapshot.address === "string" ? snapshot.address : undefined,
    timezone: typeof snapshot.timezone === "string" ? snapshot.timezone : undefined,
    source:
      snapshot.source === "browser" ||
      snapshot.source === "manual" ||
      snapshot.source === "profile" ||
      snapshot.source === "fallback"
        ? snapshot.source
        : undefined,
  };
}

function searchAnchorToLocation(anchor: SearchAnchor | null): Location | null {
  if (!anchor) return null;
  return {
    lat: anchor.lat,
    lng: anchor.lng,
    address: anchor.address,
    timezone: anchor.timezone,
    source: anchor.source,
  };
}

function searchAnchorFromContext(context: LastPlacesSearchContext | null): SearchAnchor | null {
  if (!context) return null;
  if (!Number.isFinite(context.latitude) || !Number.isFinite(context.longitude)) return null;
  return {
    lat: context.latitude,
    lng: context.longitude,
    source: "manual",
  };
}

function searchAnchorFromSnapshot(snapshot: unknown): SearchAnchor | null {
  if (!snapshot || typeof snapshot !== "object") return null;

  const candidate = snapshot as Record<string, unknown>;
  const lat = typeof candidate.lat === "number" ? candidate.lat : NaN;
  const lng = typeof candidate.lng === "number" ? candidate.lng : NaN;

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  return {
    lat,
    lng,
    address: typeof candidate.address === "string" ? candidate.address : undefined,
    timezone: typeof candidate.timezone === "string" ? candidate.timezone : undefined,
    source:
      candidate.source === "browser" ||
      candidate.source === "manual" ||
      candidate.source === "profile" ||
      candidate.source === "fallback"
        ? candidate.source
        : "manual",
  };
}

function extractLastExplicitLocationHint(messages: Array<ChatMessage & { id: string }>) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "user") continue;

    const meta = message.meta;
    if (meta && typeof meta === "object") {
      const explicitLocation = searchAnchorFromSnapshot((meta as Record<string, unknown>).explicitLocation);
      if (explicitLocation) {
        return { anchor: explicitLocation, locationText: null as string | null };
      }

      const explicitLocationText = (meta as Record<string, unknown>).explicitLocationText;
      if (typeof explicitLocationText === "string" && explicitLocationText.trim()) {
        return { anchor: null as SearchAnchor | null, locationText: explicitLocationText.trim() };
      }
    }

    const locationText = extractLocationFromMessage(message.content);
    if (locationText) {
      return { anchor: null as SearchAnchor | null, locationText };
    }
  }

  return null;
}

function extractLastPlacesSearchContext(messages: Array<ChatMessage & { id: string }>): LastPlacesSearchContext | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;

    const meta = message.meta;
    if (!meta || typeof meta !== "object") continue;

    const searchContext = (meta as Record<string, unknown>).searchContext;
    if (!searchContext || typeof searchContext !== "object") continue;

    const candidate = searchContext as Record<string, unknown>;
    const textQuery = typeof candidate.textQuery === "string" ? candidate.textQuery : "";
    const latitude = typeof candidate.latitude === "number" ? candidate.latitude : NaN;
    const longitude = typeof candidate.longitude === "number" ? candidate.longitude : NaN;
    const radius = typeof candidate.radius === "number" ? candidate.radius : 5000;
    const includedTypes = Array.isArray(candidate.includedTypes)
      ? candidate.includedTypes.filter((value): value is string => typeof value === "string")
      : [];

    if (!textQuery || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      continue;
    }

    const snapshots = Array.isArray(message.placesSnapshot)
      ? message.placesSnapshot.map(normalizePlaceSnapshot).filter((place): place is Place => place !== null)
      : [];

    return {
      textQuery,
      latitude,
      longitude,
      radius,
      includedTypes,
      places: snapshots,
    };
  }

  return null;
}

function resolveLatestSearchContext(
  messages: Array<ChatMessage & { id: string }>,
  refContext: LastPlacesSearchContext | null
): LastPlacesSearchContext | null {
  return extractLastPlacesSearchContext(messages) || refContext;
}

function didSessionLocationChange(session: PersistedChatSession | null, nextLocation: Location | null) {
  if (!session || !nextLocation) return false;

  const previousLocation = locationFromSessionSnapshot(session.location_snapshot);
  if (!previousLocation) return false;

  return haversineMeters(previousLocation, nextLocation) >= LOCATION_SESSION_ROTATION_DISTANCE_METERS;
}

function normalizePlaceSnapshot(place: unknown): Place | null {
  if (!place || typeof place !== "object") return null;

  const candidate = place as Partial<Place>;
  if (typeof candidate.id !== "string" || typeof candidate.name !== "string") return null;

  return {
    id: candidate.id,
    name: candidate.name,
    address: typeof candidate.address === "string" ? candidate.address : "",
    location:
      candidate.location &&
      typeof candidate.location === "object" &&
      typeof candidate.location.lat === "number" &&
      typeof candidate.location.lng === "number"
        ? { lat: candidate.location.lat, lng: candidate.location.lng }
        : undefined,
    rating: typeof candidate.rating === "number" ? candidate.rating : 0,
    userRatingsTotal:
      typeof candidate.userRatingsTotal === "number" ? candidate.userRatingsTotal : 0,
    priceLevel: typeof candidate.priceLevel === "number" ? candidate.priceLevel : undefined,
    openNow: typeof candidate.openNow === "boolean" ? candidate.openNow : undefined,
    photos: Array.isArray(candidate.photos)
      ? candidate.photos.filter((photo): photo is string => typeof photo === "string")
      : undefined,
    reason: typeof candidate.reason === "string" ? candidate.reason : undefined,
    primaryType: typeof candidate.primaryType === "string" ? candidate.primaryType : undefined,
    types: Array.isArray(candidate.types)
      ? candidate.types.filter((type): type is string => typeof type === "string")
      : undefined,
  };
}

function extractPlacesFromMessages(messages: Array<ChatMessage & { id: string }>) {
  const allPlacesMap = new Map<string, Place>();
  let latestRecommendedPlaces: Place[] = [];

  for (const message of messages) {
    const snapshots = Array.isArray(message.placesSnapshot)
      ? message.placesSnapshot.map(normalizePlaceSnapshot).filter((place): place is Place => place !== null)
      : [];

    for (const place of snapshots) {
      if (!allPlacesMap.has(place.id)) {
        allPlacesMap.set(place.id, place);
      }
    }

    if (!message.recommendations || message.recommendations.length === 0 || snapshots.length === 0) {
      continue;
    }

    const snapshotMap = new Map(snapshots.map((place) => [place.id, place] as const));
    const resolved = message.recommendations
      .map((rec): Place | null => {
        const place = snapshotMap.get(rec.id);
        if (!place) return null;
        return {
          ...place,
          reason: rec.reason || place.reason || "",
        };
      })
      .filter((place): place is Place => place !== null);

    if (resolved.length > 0) {
      latestRecommendedPlaces = resolved;
    }
  }

  return {
    allPlaces: Array.from(allPlacesMap.values()),
    recommendedPlaces: latestRecommendedPlaces,
  };
}

function buildGuestWelcomeMessage(): ChatMessage & { id: string } {
  return {
    id: "welcome",
    role: "assistant",
    messageType: "assistant",
    createdAt: new Date().toISOString(),
    content:
      "我是给 P 人准备的旅行助手。\n\n不用提前做攻略，也不用先查一堆店。你只要告诉我你此时此刻在哪、现在想干嘛，我就能按当前位置直接推荐附近去处。\n\n目前支持日本、泰国、香港、越南和韩国。\n\n比如你可以直接说：\n- 我在涩谷站附近，想吃烧肉\n- 我刚到尖沙咀，想找家咖啡店坐一下\n- 我在首尔圣水洞，想逛逛买手店\n- 我在胡志明市第一郡，附近有没有越南菜推荐",
  };
}

function buildReasonCacheKey(place: Place) {
  // Cache by stable place id so the same place can reuse copy across repeated searches and refreshes.
  return `llm_reason_v${REASONS_CACHE_VERSION}_${place.id}`;
}

function buildLegacyReasonCacheKey(place: Place) {
  const sig = [
    place.id,
    place.primaryType || "",
    String(place.priceLevel ?? ""),
    place.address || "",
  ].join("|");
  return `llm_reason_v${REASONS_CACHE_VERSION}_${Math.abs(hashString(sig))}`;
}

function getClientStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return window.sessionStorage;
  }
}

function getCachedReason(place: Place): string | null {
  try {
    if (typeof window === "undefined") return null;
    const storage = getClientStorage();
    const key = buildReasonCacheKey(place);
    const legacyKey = buildLegacyReasonCacheKey(place);
    const raw =
      storage?.getItem(key) ??
      window.sessionStorage.getItem(key) ??
      storage?.getItem(legacyKey) ??
      window.sessionStorage.getItem(legacyKey);
    return raw && typeof raw === "string" ? raw : null;
  } catch {
    return null;
  }
}

function setCachedReason(place: Place, reason: string) {
  try {
    if (typeof window === "undefined") return;
    const key = buildReasonCacheKey(place);
    getClientStorage()?.setItem(key, reason);
    window.sessionStorage.setItem(key, reason);
  } catch {
    // ignore
  }
}

function humanizePrimaryTypeForReason(t: string): string {
  const s = (t || "").trim().toLowerCase();
  if (!s) return "";
  const map: Record<string, string> = {
    cafe: "咖啡店",
    restaurant: "餐厅",
    yakiniku_restaurant: "烧肉店",
    japanese_restaurant: "日料店",
    sushi_restaurant: "寿司店",
    ramen_restaurant: "拉面店",
    korean_restaurant: "韩餐",
    chinese_restaurant: "中餐",
    italian_restaurant: "意大利餐厅",
    bar: "酒吧",
    bakery: "面包店",
    dessert_shop: "甜品店",
  };
  return map[s] || s.replace(/_/g, " ");
}

function buildFallbackReasonForPlace(p: Place): string {
  const price = typeof p.priceLevel === "number" && p.priceLevel > 0 ? "$".repeat(p.priceLevel) : "";
  const typeRaw = (p.primaryType || "").trim();
  const type = humanizePrimaryTypeForReason(typeRaw);
  const addr = (p.address || "").trim();
  const addrShort = addr ? addr.split(",")[0].slice(0, 14) : "";

  const bits: string[] = [];
  if (type) bits.push(type);
  if (addrShort) bits.push(`在${addrShort}附近`);
  if (price) bits.push(`预算大概${price}`);

  const scene =
    typeRaw && typeRaw.includes("cafe") ? "想歇脚喝咖啡、轻松聊聊天" :
    typeRaw && typeRaw.includes("yakiniku") ? "想认真吃一顿烧肉，约会或小聚都合适" :
    type ? `想找${type}类型的一家好店` :
    "想找一家好店";

  const variants = [
    {
      open: "如果你现在就想找一家顺路又不容易踩雷的，",
      mid: "我会把它放进你的备选里。",
      close: "点进去看一眼位置和预算范围，合适就可以直接冲。",
    },
    {
      open: "想在附近吃得舒服一点的话，",
      mid: "这家可以先收藏。",
      close: "如果你比较挑类型，就按自己的偏好把它和同类对比一下再决定。",
    },
    {
      open: "你要是想快速做决定，",
      mid: "这家属于值得先点开看看的那种。",
      close: "我建议你先看下位置是否顺路，再决定要不要排进今晚的行程。",
    },
  ];
  const idx = Math.abs(hashString(p.id || "x")) % variants.length;
  const core = bits.length ? bits.join("，") : "目前可用信息不多";
  return `${variants[idx].open}${scene}${variants[idx].mid}${core}。${variants[idx].close}`;
}

async function generateReasonsForPlaces(places: Place[]): Promise<{ intro: string; recommendations: PlaceRecommendation[] } | null> {
  if (!places || places.length === 0) return null;

  // Session cache: if we've already generated reasons for these places, reuse immediately.
  const cachedById = new Map<string, string>();
  for (const p of places) {
    const cached = getCachedReason(p);
    if (cached) cachedById.set(p.id, cached);
  }

  const missing = places.filter((p) => !cachedById.has(p.id));
  if (missing.length === 0) {
    return {
      intro: "已为你补齐推荐文案：",
      recommendations: places.map((p) => ({ id: p.id, reason: cachedById.get(p.id) || "" })),
    };
  }

  // Ask backend to produce strict JSON. Backend will preserve this prompt even when location=null.
  const missingListText = missing
    .map((p, i) => {
      const price = typeof p.priceLevel === "number" && p.priceLevel > 0 ? "$".repeat(p.priceLevel) : "未知";
      const type = p.primaryType || "未知";
      return [
        `${i + 1}. ${p.name}`,
        `   - ID: ${p.id}`,
        `   - 地址: ${p.address}`,
        `   - 价格: ${price}`,
        `   - 类型: ${type}`,
      ].join("\n");
    })
    .join("\n\n");

  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        {
          role: "system",
          content: `你是一个专业的餐厅推荐助手。你的任务不是“挑选”，而是为我提供的店铺列表逐一生成推荐理由。

店铺列表（这是唯一信息来源）：
${missingListText}

🔴 严格规则（必须遵守）：
1) 只输出严格 JSON，不要任何解释、问候或 markdown 代码块。
2) 输出必须符合以下 JSON 结构（字段名必须完全一致）：
{"intro":"一句话总述","places":[{"id":"原样复制店铺ID","reason":"80-130字中文自然段"}]}
3) places 数组必须包含且仅包含上面列表里的这${missing.length}家店，数量必须等于 ${missing.length}，顺序必须与列表一致。
4) 每个对象的 id 必须原样复制对应店铺的 ID，绝对不要改写、翻译或编造。
5) reason 写 80-130 字中文“自然段”，读起来像人在安利：
   - 只写一段自然语言，不要用“亮点：/适合：/提醒：”等结构化标签，不要分点，不要刻意分号堆叠。
   - 只能基于列表字段（地址/价格/类型）进行描述和推断，不要脑补“招牌菜/服务/排队/环境/景点”等未提供信息。
   - 用户界面已经展示了评分和评价数：reason 里绝对不要出现任何“评分/几分/评价/多少条”等字样或数字复述。可以用“口碑在线/人气旺/热度高”等不带数字的表达。
6) 用户界面已经展示了店名：reason 里绝对不要重复店名或 ID（不要出现“【...】”或直接写店名）。`,
        },
        {
          role: "user",
          content: "请为以上店铺逐一生成推荐理由并按指定 JSON 返回。",
        },
      ],
      location: null,
    }),
  });

  const data = await response.json();
  if (!response.ok) return null;

  const { intro, recommendations, rawText } = extractAndParseJSON(data.content || "");
  // Be tolerant: LLM may return partial results; caller will merge by id.
  if (!recommendations || recommendations.length === 0) {
    // Graceful degradation: if the model ignored JSON constraints, never keep skeleton forever.
    // Generate safe, field-grounded copy locally.
    // Cache fallback copy too, so we don't repeatedly wait on a failing LLM in this session.
    for (const p of places) {
      const r = buildFallbackReasonForPlace(p);
      cachedById.set(p.id, r);
      setCachedReason(p, r);
    }
    return {
      intro: "先把这几家店的亮点帮你写成种草小句子（基于可用字段生成）：",
      recommendations: places.map((p) => ({ id: p.id, reason: cachedById.get(p.id) || "" })),
    };
  }

  // Persist LLM reasons into session cache.
  for (const rec of recommendations) {
    const p = missing.find((x) => x.id === rec.id);
    if (p && rec.reason) {
      cachedById.set(rec.id, rec.reason);
      setCachedReason(p, rec.reason);
    }
  }

  return {
    intro: intro || `再给你换一批，这次是${places.length}家：`,
    recommendations: places.map((p) => ({
      id: p.id,
      reason: cachedById.get(p.id) || recommendations.find((r) => r.id === p.id)?.reason || "",
    })),
  };
}

const SYSTEM_PROMPT = `你是 P-Person Travel Assistant，一个面向不想提前做旅行计划的 P 人的即时旅行助手。

## 你的能力
1. 根据用户的位置和需求推荐餐厅/美食
2. 理解自然语言条件（如"半小时内"、"便宜"、"评分高"）
3. 严禁编造餐厅名称，所有结果必须基于真实 API 返回

## 回复要求
- 用中文回复用户
- 语气亲切自然
- 直接用自然语言回复，不需要 JSON 格式

## 当用户请求餐厅推荐时
你需要：
1. 用自然语言确认用户的需求
2. 告诉用户你正在搜索推荐`;

function sanitizeExtractedLocation(candidate: string): string | null {
  const cleaned = candidate
    .replace(/^(?:我在|现在在|在)/, "")
    .replace(/(?:想吃|想喝|想逛|推荐|有没有|有吗|拉面店|拉面|餐厅|咖啡店|咖啡|买手店|逛逛).*$/i, "")
    .replace(/[，,、。？！!?\s]+$/g, "")
    .trim();

  if (!cleaned) return null;
  if (/^(?:附近|周边|边上|旁边|这边|这里|这儿)$/.test(cleaned)) return null;
  if (cleaned.length > 30) return null;
  return cleaned;
}

// Simple location keyword detection
function extractLocationFromMessage(message: string): string | null {
  const patterns = [
    /我在(.+?)(?:附近|边上|旁边)/,
    /现在在(.+?)(?:附近|边上|旁边)/,
    /在(.+?)(?:附近|边上|旁边)/,
    /^(.+?)(?:附近|周边|一带)(?:的|\b)/,
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match && match[1]) {
      const sanitized = sanitizeExtractedLocation(match[1]);
      if (sanitized) return sanitized;
    }
  }

  const locationWords = ["芭提雅", "京都", "东京", "大阪", "曼谷", "清迈", "新宿", "涩谷"];
  for (const word of locationWords) {
    if (message.includes(word)) {
      return word;
    }
  }

  return null;
}

// Check if user is asking for restaurant recommendations
function isRestaurantRequest(message: string): boolean {
  const keywords = [
    "吃", "餐厅", "饭店", "美食", "日料", "泰国菜", "日本料理",
    "韩餐", "西餐", "早餐", "午餐", "晚餐", "推荐", "附近",
    "便宜", "好吃", "美味", "想找", "要找", "帮我找"
  ];
  return keywords.some(keyword => message.includes(keyword));
}

export function useChat() {
  const { user, client, isLoading: isAuthLoading } = useAuthContext();
  const [state, setState] = useState<ChatState>({
    messages: [buildGuestWelcomeMessage()],
    isLoading: false,
    isHydratingHistory: false,
    error: null,
    recommendedPlaces: [],
    allPlaces: [], // 存储所有获取的地点
    nextPageToken: null,
    activeSessionId: null,
    hasMoreHistory: false,
  });

  const { updateLocation, geocode, location } = useLocationContext();
  const abortControllerRef = useRef<AbortController | null>(null);

  // 使用 ref 来存储最新的 messages 和 location，避免无限循环
  const messagesRef = useRef(state.messages);
  messagesRef.current = state.messages;

  const locationRef = useRef(location);
  locationRef.current = location;

  // Keep latest cached places for "换一批" even when sendMessage callback has stale closures.
  const allPlacesRef = useRef<Place[]>(state.allPlaces);
  allPlacesRef.current = state.allPlaces;

  const recommendedPlacesRef = useRef<Place[]>(state.recommendedPlaces);
  recommendedPlacesRef.current = state.recommendedPlaces;

  const nextPageTokenRef = useRef<string | null>(state.nextPageToken);
  nextPageTokenRef.current = state.nextPageToken;
  const activeSessionIdRef = useRef<string | null>(state.activeSessionId);
  activeSessionIdRef.current = state.activeSessionId;
  const lastPlacesSearchContextRef = useRef<LastPlacesSearchContext | null>(null);
  const lastSearchAnchorRef = useRef<SearchAnchor | null>(null);
  const oldestLoadedSessionRef = useRef<PersistedChatSession | null>(null);

  // Cursor-based paging for "换一批". Stable across re-renders and avoids closure traps.
  const placeOffsetRef = useRef<number>(0);
  const shownPlaceIdsRef = useRef<Set<string>>(new Set());
  const exhaustedRef = useRef<boolean>(false);
  const loadMoreInFlightRef = useRef<boolean>(false);

  const buildInitialSystemMessage = useCallback((timezone?: string | null) => ({
    id: `system-${Date.now()}`,
    role: "system" as const,
    messageType: "system" as const,
    content: "已为你准备好新的即时旅行对话。",
    meta: { timezone: timezone ?? null, systemKind: "welcome" },
    createdAt: new Date().toISOString(),
  }), []);

  const buildInitialAssistantMessage = useCallback(() => ({
    id: `assistant-${Date.now()}`,
    role: "assistant" as const,
    messageType: "assistant" as const,
    content:
      "告诉我你现在在哪、想做什么，我会直接按当前位置帮你推荐附近去处。",
    createdAt: new Date().toISOString(),
  }), []);

  const buildRenewedSystemMessage = useCallback((timezone?: string | null) => ({
    id: `system-${Date.now()}`,
    role: "system" as const,
    messageType: "system" as const,
    content: "距离上次对话已经有一段时间了，我先按你当前的位置重新开始。",
    meta: { timezone: timezone ?? null, systemKind: "renewed" },
    createdAt: new Date().toISOString(),
  }), []);

  const buildLocationSwitchedSystemMessage = useCallback(() => ({
    id: `system-${Date.now()}`,
    role: "system" as const,
    messageType: "system" as const,
    content: "已切换地点，开启新对话",
    meta: { systemKind: "location-switched" },
    createdAt: new Date().toISOString(),
  }), []);

  const buildRenewedAssistantMessage = useCallback(() => ({
    id: `assistant-${Date.now()}`,
    role: "assistant" as const,
    messageType: "assistant" as const,
    content: "这次想吃点什么、逛什么，或者想去哪一带看看？",
    createdAt: new Date().toISOString(),
  }), []);

  const resetPlaceCursor = useCallback(() => {
    placeOffsetRef.current = 0;
    shownPlaceIdsRef.current = new Set();
    exhaustedRef.current = false;
    lastPlacesSearchContextRef.current = null;
    lastSearchAnchorRef.current = null;
    oldestLoadedSessionRef.current = null;
  }, []);

  const setFreshChatState = useCallback((
    messages: Array<ChatMessage & { id: string }>,
    sessionId: string | null,
    hasMoreHistory: boolean,
    oldestSession?: PersistedChatSession | null
  ) => {
    resetPlaceCursor();
    oldestLoadedSessionRef.current = oldestSession ?? null;
    const { allPlaces, recommendedPlaces } = extractPlacesFromMessages(messages);
    const lastSearchContext = extractLastPlacesSearchContext(messages);
    if (lastSearchContext) {
      lastPlacesSearchContextRef.current = lastSearchContext;
      lastSearchAnchorRef.current = {
        lat: lastSearchContext.latitude,
        lng: lastSearchContext.longitude,
        source: "manual",
      };
    }
    if (allPlaces.length > 0) {
      shownPlaceIdsRef.current = new Set(allPlaces.map((place) => place.id));
    }
    setState((prev) => ({
      ...prev,
      messages,
      recommendedPlaces,
      allPlaces,
      nextPageToken: null,
      activeSessionId: sessionId,
      hasMoreHistory,
      isHydratingHistory: false,
      error: null,
    }));
  }, [resetPlaceCursor]);

  const appendMessagesToSession = useCallback(async (
    sessionId: string,
    messagesToPersist: Array<ChatMessage & { id: string }>
  ) => {
    if (!client || !user || messagesToPersist.length === 0) return messagesToPersist;
    const persisted = await appendChatMessages(
      client,
      messagesToPersist.map((message) =>
        serializeChatMessage(message, { sessionId, userId: user.id })
      )
    );
    return persisted.map(deserializeChatMessage);
  }, [client, user]);

  const ensureActiveChatSession = useCallback(async (options?: {
    location?: Location | null;
    rotateOnLocationChange?: boolean;
    skipBootstrap?: boolean;
  }): Promise<EnsureActiveChatSessionResult> => {
    if (!client || !user) {
      return { session: null, startedFresh: false, rotationReason: null, hasOlderHistory: false };
    }

    const targetLocation = options?.location ?? locationRef.current;

    const profile = await getProfile(client, user.id);
    const activeSessionId = profile?.active_session_id || null;
    const hadActiveSession = !!activeSessionId;
    let session =
      hadActiveSession
        ? await getChatSession(client, activeSessionId)
        : await getLatestChatSession(client, user.id);
    const hadAnySession = !!session;
    const rotatedByTimeout = !!session && shouldRotateSession(session);
    const rotatedByLocation =
      !!session &&
      options?.rotateOnLocationChange === true &&
      didSessionLocationChange(session, targetLocation);
    const shouldStartFresh = !session || rotatedByTimeout || rotatedByLocation;

    if (shouldStartFresh) {
      if (session) {
        try {
          // Best-effort close of the previous session.
          await client
            .from("chat_sessions")
            .update({
              status: "closed",
              ended_at: new Date().toISOString(),
            })
            .eq("id", session.id);
        } catch (error) {
          console.warn("[chat] Failed to close previous session:", error);
        }
      }

      session = await createChatSession(client, {
        userId: user.id,
        location: targetLocation,
      });

      if (!options?.skipBootstrap) {
        const bootstrapMessages =
          !hadAnySession
            ? [buildInitialSystemMessage(targetLocation?.timezone), buildInitialAssistantMessage()]
            : rotatedByLocation
              ? [buildLocationSwitchedSystemMessage(), buildRenewedAssistantMessage()]
              : [buildRenewedSystemMessage(targetLocation?.timezone), buildRenewedAssistantMessage()];

        const persistedBootstrap = await appendMessagesToSession(session.id, bootstrapMessages);
        setFreshChatState(persistedBootstrap, session.id, hadAnySession, session);
      } else {
        resetPlaceCursor();
        oldestLoadedSessionRef.current = session;
      }

      return {
        session,
        startedFresh: true,
        rotationReason: !hadAnySession ? "missing" : rotatedByLocation ? "location" : "timeout",
        hasOlderHistory: hadAnySession,
      };
    }

    oldestLoadedSessionRef.current = session;
    setState((prev) => ({
      ...prev,
      activeSessionId: session?.id ?? null,
    }));

    return { session, startedFresh: false, rotationReason: null, hasOlderHistory: false };
  }, [
    appendMessagesToSession,
    buildInitialAssistantMessage,
    buildInitialSystemMessage,
    buildLocationSwitchedSystemMessage,
    buildRenewedAssistantMessage,
    buildRenewedSystemMessage,
    client,
    resetPlaceCursor,
    setFreshChatState,
    user,
  ]);

  const seedShownPlaces = useCallback((places: Place[]) => {
    // Mark already-rendered recommendations as shown so "换一批" never repeats them.
    const set = new Set(shownPlaceIdsRef.current);
    for (const place of places) set.add(place.id);
    shownPlaceIdsRef.current = set;
  }, []);

  useEffect(() => {
    if (isAuthLoading) return;

    if (!user || !client) {
      resetPlaceCursor();
      setState((prev) => ({
        ...prev,
        messages: [buildGuestWelcomeMessage()],
        recommendedPlaces: [],
        allPlaces: [],
        nextPageToken: null,
        activeSessionId: null,
        hasMoreHistory: false,
        isHydratingHistory: false,
        isLoading: false,
        error: null,
      }));
      return;
    }

    let cancelled = false;

    const bootstrapHistory = async () => {
      setState((prev) => ({ ...prev, isHydratingHistory: true }));

      try {
        const { session } = await ensureActiveChatSession();
        if (!session || cancelled) {
          setState((prev) => ({ ...prev, isHydratingHistory: false }));
          return;
        }

        const sessionLocation = locationFromSessionSnapshot(session.location_snapshot);

        const rows = await fetchChatMessagesPage(client, {
          sessionId: session.id,
          limit: INITIAL_MESSAGE_PAGE_SIZE,
        });

        if (cancelled) return;

        if (rows.length === 0) {
          const previousSession = session.last_message_at
            ? await getPreviousChatSession(client, {
                userId: user.id,
                beforeLastMessageAt: session.last_message_at,
                excludeSessionId: session.id,
              })
            : null;
          const bootstrapMessages = [buildInitialSystemMessage(location?.timezone), buildInitialAssistantMessage()];
          const persistedBootstrap = await appendMessagesToSession(session.id, bootstrapMessages);
          setFreshChatState(persistedBootstrap, session.id, !!previousSession, session);
          if (sessionLocation) {
            await updateLocation(sessionLocation, { persist: false });
          }
          return;
        }

        const previousSession = session.last_message_at
          ? await getPreviousChatSession(client, {
              userId: user.id,
              beforeLastMessageAt: session.last_message_at,
              excludeSessionId: session.id,
            })
          : null;
        const hydratedMessages = rows.map(deserializeChatMessage);
        const restoredSearchContext = extractLastPlacesSearchContext(hydratedMessages);
        const explicitLocationHint =
          restoredSearchContext ? null : extractLastExplicitLocationHint(hydratedMessages);
        let restoredExplicitAnchor: SearchAnchor | null = explicitLocationHint?.anchor ?? null;
        if (!restoredExplicitAnchor && explicitLocationHint?.locationText) {
          try {
            const geocodedLocation = await geocode(explicitLocationHint.locationText);
            if (geocodedLocation) {
              restoredExplicitAnchor = {
                lat: geocodedLocation.lat,
                lng: geocodedLocation.lng,
                address: geocodedLocation.address,
                timezone: geocodedLocation.timezone,
                source: geocodedLocation.source ?? "manual",
              };
            }
          } catch (error) {
            console.warn("[chat] Failed to restore explicit location hint:", error);
          }
        }
        setFreshChatState(
          hydratedMessages,
          session.id,
          rows.length >= INITIAL_MESSAGE_PAGE_SIZE || !!previousSession,
          session
        );
        const restoredAnchor = restoredSearchContext
          ? searchAnchorToLocation({
              lat: restoredSearchContext.latitude,
              lng: restoredSearchContext.longitude,
              source: "manual",
            })
          : null;
        if (!restoredSearchContext && restoredExplicitAnchor) {
          lastSearchAnchorRef.current = restoredExplicitAnchor;
        }
        const locationToRestore =
          restoredAnchor ||
          searchAnchorToLocation(restoredExplicitAnchor) ||
          sessionLocation;
        if (locationToRestore) {
          await updateLocation(locationToRestore, { persist: false });
        }
      } catch (error) {
        console.warn("[chat] Failed to bootstrap history:", error);
        if (!cancelled) {
          setState((prev) => ({ ...prev, isHydratingHistory: false }));
        }
      }
    };

    void bootstrapHistory();

    return () => {
      cancelled = true;
    };
  }, [
    buildGuestWelcomeMessage,
    buildInitialAssistantMessage,
    buildInitialSystemMessage,
    client,
    ensureActiveChatSession,
    isAuthLoading,
    location?.timezone,
    resetPlaceCursor,
    setFreshChatState,
    geocode,
    updateLocation,
    user,
  ]);

  const appendPlacesDeduped = useCallback((incoming: Place[]) => {
    if (!incoming || incoming.length === 0) return;
    setState((prev) => {
      const existingIds = new Set(prev.allPlaces.map((p) => p.id));
      const merged = [...prev.allPlaces];
      for (const place of incoming) {
        if (!existingIds.has(place.id)) merged.push(place);
      }
      return { ...prev, allPlaces: merged };
    });
  }, []);

  const fetchNextPagePlaces = useCallback(async (token: string) => {
    if (process.env.NODE_ENV !== "production") {
      const fallback = await clientSearchPlaces({
        textQuery: "restaurant",
        lat: 0,
        lng: 0,
        radius: 5000,
        nextPageToken: token,
      });
      return {
        places: fallback.places.map((place) => ({ ...place, reason: "" })),
        nextPageToken: fallback.nextPageToken,
      };
    }

    const response = await fetch("/api/places", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nextPageToken: token }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error || "Failed to load next page");
    }

    const newPlaces: Place[] = normalizePlacesFromGoogle(data.places || []).map((place) => ({
      ...place,
      reason: "",
    }));

    return {
      places: newPlaces,
      nextPageToken: data.nextPageToken || null,
    };
  }, []);

  // Call Google Places API from client browser
  const searchPlaces = useCallback(async (query: string) => {
    const loc = location;

    if (!loc) {
      console.error("No location available for search");
      return;
    }

    try {
      if (process.env.NODE_ENV !== "production") {
        const fallback = await clientSearchPlaces({
          textQuery: query || "restaurant",
          lat: loc.lat,
          lng: loc.lng,
          radius: 5000,
        });
        const fallbackPlaces = fallback.places.map((p) => ({ ...p, reason: "" }));
        setCachedPlaces(buildPlacesCacheKey({
          textQuery: query || "restaurant",
          lat: loc.lat,
          lng: loc.lng,
          radius: 5000,
        }), {
          places: fallbackPlaces,
          nextPageToken: fallback.nextPageToken,
        });
        setState(prev => ({ ...prev, recommendedPlaces: fallbackPlaces.filter((p) => p.rating >= 3.0) }));
        return fallbackPlaces;
      }

      // Get API config from our server
      const response = await fetch("/api/places", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lat: loc.lat,
          lng: loc.lng,
          radius: 5000,
          keyword: query, // Pass the search query
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        return [];
      }

      const cacheKey = buildPlacesCacheKey({
        textQuery: query || "restaurant",
        lat: loc.lat,
        lng: loc.lng,
        radius: 5000,
      });

      const cached = getCachedPlaces(cacheKey);
      let places: Place[] = [];
      let nextPageToken: string | null = null;
      if (cached && cached.places.length > 0 && !isCachePayloadLikelyBroken(cached.places)) {
        places = cached.places;
        nextPageToken = cached.nextPageToken;
      } else {
        if (cached && cached.places.length > 0) {
          try {
            window.sessionStorage.removeItem(cacheKey);
          } catch {}
        }
        places = normalizePlacesFromGoogle(data.places || []).map((p) => ({
          ...p,
          reason: "",
        }));
        nextPageToken = data.nextPageToken || null;
      }

      setCachedPlaces(cacheKey, { places, nextPageToken });

      // Filter by rating
      const filteredPlaces = places.filter((p: Place) => p.rating >= 3.0);

      setState(prev => ({
        ...prev,
        recommendedPlaces: filteredPlaces,
      }));

      return filteredPlaces;
    } catch (error) {
      console.error("Search places error:", error);
      return [];
    }
  }, [location]);

  // Search with specific location (not dependent on current location)
  const doSearch = useCallback(async (loc: { lat: number; lng: number }, keyword?: string) => {
    if (!loc) return;

    try {
      if (process.env.NODE_ENV !== "production") {
        const fallback = await clientSearchPlaces({
          textQuery: keyword || "restaurant",
          lat: loc.lat,
          lng: loc.lng,
          radius: 5000,
        });
        setState(prev => ({
          ...prev,
          recommendedPlaces: fallback.places
            .map((p) => ({ ...p, reason: "" }))
            .filter((p: Place) => p.rating >= 3.0),
        }));
        return;
      }

      const response = await fetch("/api/places", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lat: loc.lat,
          lng: loc.lng,
          radius: 5000,
          keyword: keyword,
        }),
      });

      const data = await response.json();
      if (response.ok && data.places) {
        const places: Place[] = normalizePlacesFromGoogle(data.places)
          .map((p) => ({ ...p, reason: "" }))
          .filter((p: Place) => p.rating >= 3.0);

        setState(prev => ({ ...prev, recommendedPlaces: places }));
      }
    } catch (error) {
      console.error("doSearch error:", error);
    }
  }, []);

  const sendMessage = useCallback(async (content: string) => {
    const optimisticUserMessage: ChatMessage & { id: string } = {
      id: `user-pending-${Date.now()}`,
      role: "user",
      messageType: "user",
      content,
      createdAt: new Date().toISOString(),
    };

    setState((prev) => ({
      ...prev,
      messages: [...prev.messages, optimisticUserMessage],
      isLoading: true,
      error: null,
    }));

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    // Try to detect and update location from user message BEFORE calling AI
    const locationText = extractLocationFromMessage(content);
    let updatedLocation = null;
    if (locationText) {
      updatedLocation = await geocode(locationText);
      if (updatedLocation) {
        lastSearchAnchorRef.current = {
          lat: updatedLocation.lat,
          lng: updatedLocation.lng,
          address: updatedLocation.address,
          timezone: updatedLocation.timezone,
          source: updatedLocation.source,
        };
        await updateLocation(updatedLocation);
      }
    }

    try {
      const latestSearchContext = resolveLatestSearchContext(
        messagesRef.current as Array<ChatMessage & { id: string }>,
        lastPlacesSearchContextRef.current
      );
      if (latestSearchContext) {
        lastPlacesSearchContextRef.current = latestSearchContext;
      }
      const searchContextAnchor =
        searchAnchorToLocation(searchAnchorFromContext(latestSearchContext)) ||
        searchAnchorToLocation(lastSearchAnchorRef.current);
      const sessionResult = await ensureActiveChatSession({
        location: updatedLocation || searchContextAnchor || locationRef.current,
        rotateOnLocationChange: !!locationText,
        skipBootstrap: true,
      });
      const session = sessionResult.session;
      const anchorLocation =
        searchContextAnchor ||
        searchAnchorToLocation(lastSearchAnchorRef.current);
      const sessionLocation = locationFromSessionSnapshot(session?.location_snapshot ?? null);
      const locToUse = updatedLocation || anchorLocation || sessionLocation || locationRef.current;

      if (process.env.NODE_ENV !== "production") {
        console.info("[chat][location-resolution]", {
          content,
          locationText,
          updatedLocation,
          anchorLocation,
          sessionLocation,
          currentLocation: locationRef.current,
          locToUse,
          lastSearchContext: latestSearchContext
            ? {
                textQuery: latestSearchContext.textQuery,
                latitude: latestSearchContext.latitude,
                longitude: latestSearchContext.longitude,
                radius: latestSearchContext.radius,
              }
            : null,
        });
      }

      if (
        !locationText &&
        anchorLocation &&
        (!locationRef.current ||
          haversineMeters(anchorLocation, locationRef.current) >= 50)
      ) {
        try {
          await updateLocation(anchorLocation, { persist: false });
        } catch (locationError) {
          console.warn("[sendMessage] Failed to restore search anchor location:", locationError);
        }
      } else if (
        !locationText &&
        !anchorLocation &&
        sessionLocation &&
        (!locationRef.current ||
          haversineMeters(sessionLocation, locationRef.current) >= 50)
      ) {
        try {
          await updateLocation(sessionLocation, { persist: false });
        } catch (locationError) {
          console.warn("[sendMessage] Failed to restore session location:", locationError);
        }
      }

      const shouldResetModelContext = sessionResult.startedFresh;
      const boundaryMessages =
        shouldResetModelContext && sessionResult.rotationReason === "location"
          ? [(() => {
              const boundary = buildLocationSwitchedSystemMessage();
              const userCreatedAt = optimisticUserMessage.createdAt || new Date().toISOString();
              const userCreatedAtMs = new Date(userCreatedAt).getTime();
              if (Number.isFinite(userCreatedAtMs)) {
                boundary.createdAt = new Date(userCreatedAtMs - 1).toISOString();
              }
              return boundary;
            })()]
          : [];
      const userMessageBase: ChatMessage & { id: string } = {
        id: `user-${Date.now()}`,
        role: "user",
        messageType: "user",
        content,
        meta: locationText
          ? {
              explicitLocationText: locationText,
              explicitLocation: updatedLocation
                ? {
                    lat: updatedLocation.lat,
                    lng: updatedLocation.lng,
                    address: updatedLocation.address ?? null,
                    timezone: updatedLocation.timezone ?? null,
                    source: updatedLocation.source ?? "manual",
                  }
                : null,
            }
          : undefined,
        createdAt: optimisticUserMessage.createdAt,
      };
      const persistedUserMessages =
        session && client && user
          ? await appendMessagesToSession(session.id, [...boundaryMessages, userMessageBase])
          : [...boundaryMessages, userMessageBase];
      const userMessage = persistedUserMessages[persistedUserMessages.length - 1] || userMessageBase;
      const persistedBoundaryMessages = persistedUserMessages.slice(0, -1);

      setState((prev) => {
        if (shouldResetModelContext) {
          return {
            ...prev,
            messages: [...persistedBoundaryMessages, userMessage],
            recommendedPlaces: [],
            allPlaces: [],
            nextPageToken: null,
            activeSessionId: session?.id ?? prev.activeSessionId,
            hasMoreHistory: sessionResult.hasOlderHistory,
          };
        }

        return {
          ...prev,
          messages: prev.messages.map((message) =>
            message.id === optimisticUserMessage.id ? userMessage : message
          ),
          activeSessionId: session?.id ?? prev.activeSessionId,
        };
      });

      const messages: ChatMessage[] = [
        ...(shouldResetModelContext
          ? []
          : messagesRef.current.map(({ role, content }) => ({ role, content }))),
        { role: "user", content },
      ];
      const historyMessages = shouldResetModelContext
        ? []
        : messagesRef.current
            .slice(-6)
            .map(({ role, content }) => ({ role, content }));

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages,
          historyMessages,
          location: locToUse ? { latitude: locToUse.lat, longitude: locToUse.lng } : null,
        }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.statusText}`);
      }

      let data = await response.json();
      if (
        locationText &&
        updatedLocation &&
        data?.searchParams &&
        typeof data.searchParams === "object"
      ) {
        data = {
          ...data,
          searchParams: {
            ...data.searchParams,
            latitude: updatedLocation.lat,
            longitude: updatedLocation.lng,
          },
        };
      }

      if (isOpenNowRequest(content) && !locationText) {
        const lastSearch = resolveLatestSearchContext(
          messagesRef.current as Array<ChatMessage & { id: string }>,
          lastPlacesSearchContextRef.current
        );
        if (lastSearch) {
          lastPlacesSearchContextRef.current = lastSearch;
        }
        if (lastSearch) {
          const localOpenNowPlaces = filterPlacesByOpenNow(
            filterPlacesByRestaurantIntent({
              places: lastSearch.places,
              includedTypes: lastSearch.includedTypes,
              strict: true,
            })
          )
            .slice()
            .sort((a, b) => {
              if ((b.rating || 0) !== (a.rating || 0)) return (b.rating || 0) - (a.rating || 0);
              return (b.userRatingsTotal || 0) - (a.userRatingsTotal || 0);
            });

          if (localOpenNowPlaces.length > 0) {
            const topPlaces = localOpenNowPlaces.slice(0, 5);
            const recommendations: PlaceRecommendation[] = topPlaces.map((place) => ({
              id: place.id,
              reason: getCachedReason(place) || buildFallbackReasonForPlace(place),
            }));
            const recommendedPlaces = topPlaces.map((place) => ({
              ...place,
              reason: recommendations.find((item) => item.id === place.id)?.reason || "",
            }));
            const assistantBase: ChatMessage & { id: string } = {
              id: `assistant-${Date.now()}`,
              role: "assistant",
              messageType: "assistant",
              content: "为您找到以下几家正在营业的高分好店：",
              meta: {
                openNowOnly: true,
                disableLoadMore: true,
                searchContext: {
                  textQuery: lastSearch.textQuery,
                  latitude: lastSearch.latitude,
                  longitude: lastSearch.longitude,
                  radius: lastSearch.radius,
                  includedTypes: lastSearch.includedTypes,
                },
              },
              placesSnapshot: recommendedPlaces,
              recommendations,
              createdAt: new Date().toISOString(),
            };
            const persistedAssistant =
              session && client && user
                ? (await appendMessagesToSession(session.id, [assistantBase]))[0] || assistantBase
                : assistantBase;

            resetPlaceCursor();
            seedShownPlaces(recommendedPlaces);
            setState((prev) => ({
              ...prev,
              messages: [...prev.messages, persistedAssistant],
              recommendedPlaces,
              allPlaces: mergePlacesPreservingOrder(prev.allPlaces, localOpenNowPlaces),
              nextPageToken: null,
              isLoading: false,
            }));
            return;
          }

          data = {
            needClientSearch: true,
            userMessage: content,
            searchParams: {
              latitude: lastSearch.latitude,
              longitude: lastSearch.longitude,
              radius: lastSearch.radius,
              textQuery: lastSearch.textQuery,
              includedTypes: lastSearch.includedTypes,
              openNowOnly: true,
            },
          };
        }
      }

      // If server needs client to search
      if (data.needClientSearch) {
        const rawTextQuery = data.searchParams?.textQuery || "restaurant";
        const centerLat = data.searchParams.latitude;
        const centerLng = data.searchParams.longitude;
        const radius = data.searchParams.radius || 5000;

        if (typeof centerLat === "number" && typeof centerLng === "number") {
          lastSearchAnchorRef.current = {
            lat: centerLat,
            lng: centerLng,
            source: "manual",
          };
          const currentLocation = locationRef.current;
          const locationDrifted =
            !currentLocation ||
            Math.abs(currentLocation.lat - centerLat) > 0.0001 ||
            Math.abs(currentLocation.lng - centerLng) > 0.0001;

          if (locationDrifted) {
            try {
              await updateLocation({ lat: centerLat, lng: centerLng, source: "manual" }, { persist: false });
            } catch (locationError) {
              console.warn("[sendMessage] Failed to sync map location from search center:", locationError);
            }
          }
        }

        // Backend may send a verbose query containing a landmark that is actually a location context.
        // Normalize it here so we don't accidentally recommend the landmark itself.
        const textQuery = normalizeClientTextQuery({ userMessage: content, textQuery: rawTextQuery });
        const openNowOnly = data.searchParams?.openNowOnly === true || isOpenNowRequest(content);

        const cacheKey = buildPlacesCacheKey({
          textQuery,
          lat: centerLat,
          lng: centerLng,
          radius,
          openNowOnly,
        });
        try {
          const cached = getCachedPlaces(cacheKey);
          let googleData: any = null;

          if (cached && cached.places.length > 0 && !isCachePayloadLikelyBroken(cached.places)) {
            googleData = { places: cached.places, nextPageToken: cached.nextPageToken };
          } else {
            if (cached && cached.places.length > 0) {
              try {
                window.sessionStorage.removeItem(cacheKey);
              } catch {}
            }
            if (process.env.NODE_ENV !== "production") {
              googleData = await clientSearchPlaces({
                textQuery,
                lat: centerLat,
                lng: centerLng,
                radius,
                openNowOnly,
              });
            } else {
              const googleResponse = await fetch("/api/places", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  lat: centerLat,
                  lng: centerLng,
                  radius,
                  textQuery,
                  openNowOnly,
                }),
              });

              googleData = await googleResponse.json();
              if (!googleResponse.ok) {
                throw new Error(googleData?.error || "Places proxy failed");
              }
            }
          }

          if (!googleData.places || googleData.places.length === 0) {
            const emptyAssistantBase = {
              id: `assistant-${Date.now()}`,
              role: "assistant" as const,
              messageType: "assistant" as const,
              content: "抱歉，附近没有找到相关的餐厅。",
              createdAt: new Date().toISOString(),
            };
            const emptyAssistant =
              session && client && user
                ? (await appendMessagesToSession(session.id, [emptyAssistantBase]))[0] || emptyAssistantBase
                : emptyAssistantBase;
            setState((prev) => ({
              ...prev,
              messages: [...prev.messages, emptyAssistant],
              isLoading: false,
            }));
            return;
          }

          // Transform places (添加 primaryType 和 types)
          // Note: cache HIT returns already-transformed Place[]; avoid double-mapping.
          let places = normalizePlacesFromGoogle(googleData.places);

          // Text Search may return far-away results even with locationBias. Keep results local.
          places = filterPlacesByRadius({ places, centerLat, centerLng, radius });

          // 🔴 前端数据净化：根据真实意图过滤酒店
          // 从后端返回的 searchParams 获取真实的 includedTypes
          const intentTypes =
            (Array.isArray(data.searchParams?.includedTypes) && data.searchParams.includedTypes.length > 0)
              ? data.searchParams.includedTypes
              : inferIncludedTypesFromUserMessage(content);

          const applySearchFilters = (source: Place[]) => {
            let next = filterPlacesByIntent(source, intentTypes);
            next = filterPlacesByShoppingIntent({ places: next, includedTypes: intentTypes });
            next = filterPlacesByConvenienceIntent({ places: next, includedTypes: intentTypes });
            next = filterPlacesByRestaurantIntent({ places: next, includedTypes: intentTypes, strict: openNowOnly });
            if (openNowOnly) {
              next = filterPlacesByOpenNow(next);
            }
            return next;
          };

          let nextPageToken = googleData.nextPageToken || null;
          if (openNowOnly && nextPageToken) {
            let filteredForPaging = applySearchFilters(places);
            let extraPagesFetched = 0;
            while (filteredForPaging.length < 5 && nextPageToken && extraPagesFetched < 2) {
              const nextPage = await fetchNextPagePlaces(nextPageToken);
              const nextPlaces = filterPlacesByRadius({
                places: nextPage.places,
                centerLat,
                centerLng,
                radius,
              });
              places = mergePlacesPreservingOrder(places, nextPlaces);
              nextPageToken = nextPage.nextPageToken;
              filteredForPaging = applySearchFilters(places);
              extraPagesFetched += 1;
            }
          }

          setCachedPlaces(cacheKey, {
            places,
            nextPageToken,
          });

          let filteredPlaces = applySearchFilters(places);
          const filteredPlacesForDisplay =
            openNowOnly
              ? filteredPlaces
              : filteredPlaces.length >= 5 ? filteredPlaces : mergePlacesPreservingOrder(filteredPlaces, places);
          lastPlacesSearchContextRef.current = {
            textQuery,
            latitude: centerLat,
            longitude: centerLng,
            radius,
            includedTypes: intentTypes,
            places: filteredPlacesForDisplay,
          };

          const preferDistance = isRetailNearbyIntent(intentTypes, content);

          // Frontend instant render:
          // - convenience store: rank by distance first (rating isn't a good proxy)
          // - others: rank by rating
          const candidates = preferDistance
            ? filteredPlacesForDisplay
                .slice()
                .sort((a: Place, b: Place) => {
                  const da = a.location ? haversineMeters({ lat: centerLat, lng: centerLng }, a.location) : Number.POSITIVE_INFINITY;
                  const db = b.location ? haversineMeters({ lat: centerLat, lng: centerLng }, b.location) : Number.POSITIVE_INFINITY;
                  return da - db;
                })
            : filteredPlacesForDisplay
                .filter((p: Place) => typeof p.rating === "number" && p.rating >= 3.0)
                .slice()
                .sort((a: Place, b: Place) => {
                  if ((b.rating || 0) !== (a.rating || 0)) return (b.rating || 0) - (a.rating || 0);
                  return (b.userRatingsTotal || 0) - (a.userRatingsTotal || 0);
                });

          const topPlaces = candidates.slice(0, 5);
          if (openNowOnly && topPlaces.length === 0) {
            const emptyAssistantBase = {
              id: `assistant-${Date.now()}`,
              role: "assistant" as const,
              messageType: "assistant" as const,
              content: "附近暂时没筛到明确显示为正在营业、且符合这次条件的地方。你可以放宽一下条件，或者让我按评分先给你一批可能合适的。",
              createdAt: new Date().toISOString(),
            };
            const emptyAssistant =
              session && client && user
                ? (await appendMessagesToSession(session.id, [emptyAssistantBase]))[0] || emptyAssistantBase
                : emptyAssistantBase;
            setState((prev) => ({
              ...prev,
              messages: [...prev.messages, emptyAssistant],
              isLoading: false,
            }));
            return;
          }
          const immediateReasonMap = new Map<string, string>();
          for (const p of topPlaces) {
            immediateReasonMap.set(p.id, getCachedReason(p) || buildFallbackReasonForPlace(p));
          }
          const intro = openNowOnly
            ? "为您找到以下几家正在营业的高分好店："
            : preferDistance ? "在你附近先挑了几家更顺路的：" : "为您找到以下几家高分好店：";
	          const recommendations: PlaceRecommendation[] = topPlaces.map((p) => ({
	            id: p.id,
	            reason: immediateReasonMap.get(p.id) || "",
	          }));

	          const recommendedPlaces: Place[] = topPlaces.map((p) => ({
	            ...p,
	            reason: immediateReasonMap.get(p.id) || "",
	          }));

          // 保存所有地点到 allPlaces（用于"换一批"功能）
          // Use filteredPlaces to avoid leaking irrelevant hotel/lodging results into "换一批".
          const allPlacesData: Place[] = filteredPlacesForDisplay.map((p) => ({
            ...p,
            reason: "",
          }));

	          // 一次性更新所有状态
	          // New search session: reset cursor and replace old place caches after new data is ready.
	          const assistantBase: ChatMessage & { id: string } = {
              id: `assistant-${Date.now()}`,
              role: "assistant",
              messageType: "assistant",
              content: intro,
              meta: {
                openNowOnly,
                disableLoadMore: openNowOnly,
                searchContext: {
                  textQuery,
                  latitude: centerLat,
                  longitude: centerLng,
                  radius,
                  includedTypes: intentTypes,
                },
              },
              placesSnapshot: recommendedPlaces,
              recommendations: recommendations,
              createdAt: new Date().toISOString(),
            };
            const persistedAssistant =
              session && client && user
                ? (await appendMessagesToSession(session.id, [assistantBase]))[0] || assistantBase
                : assistantBase;
	          const assistantId = persistedAssistant.id;
	          resetPlaceCursor();
	          seedShownPlaces(recommendedPlaces);
	          setState((prev) => ({
	            ...prev,
	            messages: [...prev.messages, persistedAssistant],
	            recommendedPlaces: recommendedPlaces,
	            allPlaces: mergePlacesPreservingOrder(prev.allPlaces, allPlacesData),
	            nextPageToken: openNowOnly ? null : nextPageToken,
	            isLoading: false,
	          }));

	          // Lazy-load LLM descriptions after cards are visible.
	          // Do not block UI; update only if the message still exists.
	          void (async () => {
	            const llm = await generateReasonsForPlaces(topPlaces);
	            if (!llm || !llm.recommendations || llm.recommendations.length === 0) return;
	            const reasonMap = new Map<string, string>();
	            for (const rec of llm.recommendations) reasonMap.set(rec.id, rec.reason);

	            setState((prev) => {
	              const nextMessages = prev.messages.map((m) => {
	                if (m.id !== assistantId) return m;
	                const nextRecs = (m.recommendations || []).map((r) => ({
	                  ...r,
	                  reason: reasonMap.get(r.id) || r.reason || "",
	                }));
	                return { ...m, recommendations: nextRecs };
	              });

	              const nextRecommendedPlaces = prev.recommendedPlaces.map((p) => {
	                const r = reasonMap.get(p.id);
	                return r ? { ...p, reason: r } : p;
	              });

	              return { ...prev, messages: nextMessages, recommendedPlaces: nextRecommendedPlaces };
	            });
	          })();

	          return;
	        } catch (googleError: any) {
	          console.error("Google API error:", googleError);
          const errorAssistantBase = {
            id: `assistant-${Date.now()}`,
            role: "assistant" as const,
            messageType: "assistant" as const,
            content: `抱歉，搜索餐厅时出错：${googleError.message}。请稍后再试。`,
            createdAt: new Date().toISOString(),
          };
          const errorAssistant =
            session && client && user
              ? (await appendMessagesToSession(session.id, [errorAssistantBase]))[0] || errorAssistantBase
              : errorAssistantBase;
          setState((prev) => ({
            ...prev,
            messages: [...prev.messages, errorAssistant],
            isLoading: false,
          }));
          return;
        }
      }

      // 防范坑点2：等消息接收完毕后再解析 JSON（非流式可以直接处理）
      const { intro, recommendations } = extractAndParseJSON(data.content || "");
      const discussions: DiscussionCard[] = Array.isArray(data.discussions) ? data.discussions : [];

      // 处理后端返回的 action 信号
      if (data.action === "load_more") {
        const excludeIds = recommendedPlacesRef.current.map((p) => p.id);
        await loadMoreRecommendations(allPlacesRef.current, excludeIds);
        return;
      }

      // 只有当有 recommendations 时才更新 recommendedPlaces
      // 否则保持为空，让卡片在消息气泡内显示
      let newRecommendedPlaces: Place[] = [];

      if (data.places && Array.isArray(data.places) && recommendations.length > 0) {
        // 构建地点映射（增强容错：支持 ID 和名称匹配）
        const placesList = data.places.map((place: any) => [place.id, {
          ...place,
          photos: place.photos || [],
        }]);
        const placesMap = new Map(placesList);

        // 匹配推荐（模糊匹配：支持大小写不敏感、部分匹配）
        newRecommendedPlaces = recommendations
          .map(rec => {
            // 1. 尝试 ID 精确匹配
            let place = placesMap.get(rec.id);
            if (place) {
              return { ...place, reason: rec.reason };
            }

            // 2. 模糊匹配：店名可能存在语言/大小写差异
            const recIdLower = rec.id.toLowerCase();
            for (const [id, p] of placesList) {
              const pName = p.displayName?.text || p.displayName || p.name || "";
              const pNameLower = pName.toLowerCase();

              // 模糊匹配：双向包含 + 大小写不敏感
              if (
                pNameLower.includes(recIdLower) ||
                recIdLower.includes(pNameLower) ||
                pName === rec.id ||
                rec.id === pName
              ) {
                return { ...p, reason: rec.reason };
              }
            }

            return null;
          })
          .filter((p): p is Place => p !== null);
      }

      const assistantMessageBase: ChatMessage & { id: string } = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        messageType: "assistant",
        content: intro || (discussions.length > 0 ? "我整理了几条 Reddit 旅行讨论，先给你看讨论卡。" : ""),
        placesSnapshot: newRecommendedPlaces,
        recommendations: recommendations,
        discussions,
        createdAt: new Date().toISOString(),
      };
      const assistantMessage =
        session && client && user
          ? (await appendMessagesToSession(session.id, [assistantMessageBase]))[0] || assistantMessageBase
          : assistantMessageBase;

      // 保存所有地点到 allPlaces（用于"换一批"功能）
      let allPlacesData: Place[] = [];
      if (data.places && Array.isArray(data.places)) {
        allPlacesData = data.places.map((place: any) => ({
          id: place.id,
          name: place.displayName?.text || place.name,
          address: place.formattedAddress,
          location: place.location,
          rating: place.rating || 0,
          userRatingsTotal: place.userRatingCount || 0,
          priceLevel: place.priceLevel,
          openNow: place.openNow,
          photos: place.photos || [],
          reason: "",
        }));
      }

      // 一次性更新所有状态，避免分步更新导致闪烁
      if (allPlacesData.length > 0) {
        resetPlaceCursor();
        if (newRecommendedPlaces.length > 0) seedShownPlaces(newRecommendedPlaces);
      }
      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, assistantMessage],
        recommendedPlaces: discussions.length > 0 ? [] : newRecommendedPlaces,
        allPlaces: mergePlacesPreservingOrder(prev.allPlaces, allPlacesData),
        nextPageToken: data.nextPageToken || null,
        isLoading: false,
      }));

    } catch (error: any) {
      if (error.name === "AbortError") {
        setState((prev) => ({ ...prev, isLoading: false }));
        return;
      }

      console.error("Chat error:", error);
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: error.message || "请求失败，请重试",
      }));
    } finally {
      // 确保 isLoading 总是被重置，并触发状态同步
      setState((prev) => ({ ...prev, isLoading: false }));
    }
  }, [appendMessagesToSession, buildLocationSwitchedSystemMessage, client, ensureActiveChatSession, geocode, searchPlaces, updateLocation, user]);

  const clearMessages = useCallback(() => {
    resetPlaceCursor();
    setState((prev) => ({
      ...prev,
      messages: [buildGuestWelcomeMessage()],
      recommendedPlaces: [],
      allPlaces: [],
      nextPageToken: null,
      activeSessionId: null,
      hasMoreHistory: false,
      isHydratingHistory: false,
      isLoading: false,
      error: null,
    }));
  }, [resetPlaceCursor]);

  const loadOlderMessages = useCallback(async () => {
    if (!client || !user || state.messages.length === 0) return;

    try {
      const oldestSession = oldestLoadedSessionRef.current;
      if (!oldestSession) return;

      const earliest = state.messages[0]?.createdAt;
      if (!earliest) return;

      const rows = await fetchChatMessagesPage(client, {
        sessionId: oldestSession.id,
        limit: OLDER_MESSAGE_PAGE_SIZE,
        beforeCreatedAt: earliest,
      });

      let olderMessages = rows.map(deserializeChatMessage);
      let nextOldestSession = oldestSession;
      let hasMoreHistory = rows.length >= OLDER_MESSAGE_PAGE_SIZE;

      if (rows.length < OLDER_MESSAGE_PAGE_SIZE && oldestSession.last_message_at) {
        const previousSession = await getPreviousChatSession(client, {
          userId: user.id,
          beforeLastMessageAt: oldestSession.last_message_at,
          excludeSessionId: oldestSession.id,
        });

        if (previousSession) {
          const previousRows = await fetchChatMessagesPage(client, {
            sessionId: previousSession.id,
            limit: OLDER_MESSAGE_PAGE_SIZE,
          });
          olderMessages = [
            ...previousRows.map(deserializeChatMessage),
            ...olderMessages,
          ];
          nextOldestSession = previousSession;
          hasMoreHistory = previousRows.length >= OLDER_MESSAGE_PAGE_SIZE;

          if (!hasMoreHistory && previousSession.last_message_at) {
            const evenOlderSession = await getPreviousChatSession(client, {
              userId: user.id,
              beforeLastMessageAt: previousSession.last_message_at,
              excludeSessionId: previousSession.id,
            });
            hasMoreHistory = !!evenOlderSession;
          }
        }
      }

      if (olderMessages.length === 0) {
        setState((prev) => ({ ...prev, hasMoreHistory: false }));
        return;
      }

      oldestLoadedSessionRef.current = nextOldestSession;
      setState((prev) => {
        const mergedMessages = [...olderMessages, ...prev.messages];
        const { allPlaces, recommendedPlaces } = extractPlacesFromMessages(mergedMessages);
        return {
          ...prev,
          messages: mergedMessages,
          allPlaces,
          recommendedPlaces: recommendedPlaces.length > 0 ? recommendedPlaces : prev.recommendedPlaces,
          hasMoreHistory,
        };
      });
    } catch (error) {
      console.warn("[chat] Failed to load older messages:", error);
    }
  }, [client, state.messages, user]);

  const setRecommendedPlaces = useCallback((places: Place[]) => {
    setState((prev) => ({
      ...prev,
      recommendedPlaces: places,
    }));
  }, []);

  // 加载更多地点（分页获取新地点）
  const loadMorePlaces = useCallback(async () => {
    const currentToken = state.nextPageToken;
    if (!currentToken) return;

    try {
      setState((prev) => ({ ...prev, isLoading: true }));

      if (process.env.NODE_ENV !== "production") {
        const fallback = await clientSearchPlaces({
          textQuery: "restaurant",
          lat: 0,
          lng: 0,
          radius: 5000,
          nextPageToken: currentToken,
        });
        setState((prev) => ({
          ...prev,
          recommendedPlaces: [...prev.recommendedPlaces, ...fallback.places],
          nextPageToken: fallback.nextPageToken,
          isLoading: false,
        }));
        return;
      }

      const response = await fetch("/api/places", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nextPageToken: currentToken }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to load more places");
      }

      if (data.places && data.places.length > 0) {
        const newPlaces = normalizePlacesFromGoogle(data.places);

        setState((prev) => ({
          ...prev,
          recommendedPlaces: [...prev.recommendedPlaces, ...newPlaces],
          nextPageToken: data.nextPageToken || null,
          isLoading: false,
        }));
      } else {
        setState((prev) => ({ ...prev, nextPageToken: null, isLoading: false }));
      }
    } catch (error) {
      console.error("Load more error:", error);
      setState((prev) => ({ ...prev, isLoading: false }));
    }
  }, [state.nextPageToken]);

  // 换一批：从已有的地点中选择不同的推荐
  const loadMoreRecommendations = useCallback(async (_allPlaces: Place[], _excludeIds: string[]) => {
    void _allPlaces;
    void _excludeIds;

    try {
      // Avoid race conditions from rapid clicking.
      if (loadMoreInFlightRef.current) {
        return;
      }
      loadMoreInFlightRef.current = true;

      setState((prev) => ({ ...prev, isLoading: true }));

      const exhaustionText = "附近评分最高的好店已经全部为您展示完毕啦，换个区域或者搜索词试试吧！(๑˃̵ᴗ˂̵)و";

      // Always use the latest caches; ignore possibly stale args.
      let currentAllPlaces = allPlacesRef.current;
      let newlyFetched: Place[] = [];

      if (exhaustedRef.current) {
        setState((prev) => ({ ...prev, isLoading: false }));
        return;
      }

      const shown = shownPlaceIdsRef.current;

      const mergeDedupLocal = (base: Place[], incoming: Place[]) => {
        if (!incoming || incoming.length === 0) return base;
        const ids = new Set(base.map((p) => p.id));
        const merged = [...base];
        for (const p of incoming) {
          if (!ids.has(p.id)) {
            ids.add(p.id);
            merged.push(p);
          }
        }
        return merged;
      };

      let offset = placeOffsetRef.current;
      const batch: Place[] = [];
      const picked = new Set<string>();

      const tryAddFromChunk = (chunk: Place[]) => {
        for (const p of chunk) {
          if (batch.length >= 5) return;
          if (!p?.id) continue;
          if (shown.has(p.id)) continue;
          if (picked.has(p.id)) continue;
          picked.add(p.id);
          batch.push(p);
        }
      };

      // Cursor mechanism: consume in fixed 5-sized slices (offset += 5).
      // If we can't build a full batch, transparently paginate and continue.
      while (batch.length < 5) {
        if (offset < currentAllPlaces.length) {
          const chunk = currentAllPlaces.slice(offset, offset + 5);
          offset += 5;
          tryAddFromChunk(chunk);
          continue;
        }

        const token = nextPageTokenRef.current;
        if (!token) break;

        const next = await fetchNextPagePlaces(token);
        newlyFetched = newlyFetched.concat(next.places);
        currentAllPlaces = mergeDedupLocal(currentAllPlaces, next.places);
        nextPageTokenRef.current = next.nextPageToken;
        setState((prev) => ({ ...prev, nextPageToken: next.nextPageToken }));
      }

      // Persist cursor position regardless of success to prevent repeating slices.
      placeOffsetRef.current = offset;

      if (batch.length < 5) {
        const refillPool = currentAllPlaces.filter((p) => p?.id && !picked.has(p.id));
        for (const p of refillPool) {
          if (batch.length >= 5) break;
          batch.push(p);
          picked.add(p.id);
        }
      }

      if (batch.length < 5) {
        exhaustedRef.current = true;
        if (batch.length === 0) {
          const exhaustionMessageBase = {
            id: `assistant-${Date.now()}`,
            role: "assistant" as const,
            messageType: "assistant" as const,
            content: exhaustionText,
            createdAt: new Date().toISOString(),
          };
          const exhaustionMessage =
            activeSessionIdRef.current && client && user
              ? (await appendMessagesToSession(activeSessionIdRef.current, [exhaustionMessageBase]))[0] || exhaustionMessageBase
              : exhaustionMessageBase;
          setState((prev) => ({
            ...prev,
            messages: [...prev.messages, exhaustionMessage],
            isLoading: false,
          }));
          return;
        }
      }

      // Placeholder reasons first; cards render immediately with skeleton UI.
      const immediateReasonMap = new Map<string, string>();
      for (const p of batch) {
        immediateReasonMap.set(p.id, getCachedReason(p) || buildFallbackReasonForPlace(p));
      }

      const recommendations: PlaceRecommendation[] = batch.map((p) => ({
        id: p.id,
        reason: immediateReasonMap.get(p.id) || "",
      }));
      const matchedPlaces: Place[] = batch.map((p) => ({
        ...p,
        reason: immediateReasonMap.get(p.id) || "",
      }));
      const refreshMessageBase: ChatMessage & { id: string } = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        messageType: "assistant",
        content: `再给你换一批，这次是${batch.length}家：`,
        placesSnapshot: matchedPlaces,
        recommendations,
        createdAt: new Date().toISOString(),
      };
      const refreshMessage =
        activeSessionIdRef.current && client && user
          ? (await appendMessagesToSession(activeSessionIdRef.current, [refreshMessageBase]))[0] || refreshMessageBase
          : refreshMessageBase;
      const assistantId = refreshMessage.id;

      // Mark as shown to guarantee global de-dup across repeated clicks when possible.
      const nextShown = new Set(shown);
      for (const p of batch) nextShown.add(p.id);
      shownPlaceIdsRef.current = nextShown;

      setState((prev) => {
        // Ensure all recommended ids exist in allPlaces before rendering cards.
        const ids = new Set(prev.allPlaces.map((p) => p.id));
        const mergedAllPlaces = [...prev.allPlaces];
        for (const p of newlyFetched) {
          if (!ids.has(p.id)) {
            ids.add(p.id);
            mergedAllPlaces.push(p);
          }
        }
        for (const p of batch) {
          if (!ids.has(p.id)) {
            ids.add(p.id);
            mergedAllPlaces.push(p);
          }
        }

        return {
          ...prev,
          allPlaces: mergedAllPlaces,
          messages: [...prev.messages, refreshMessage],
          recommendedPlaces: matchedPlaces,
          isLoading: false,
        };
      });

      // Lazy-load LLM descriptions after cards are visible.
      void (async () => {
        const llm = await generateReasonsForPlaces(batch);
        if (!llm || !llm.recommendations || llm.recommendations.length === 0) return;
        const reasonMap = new Map<string, string>();
        for (const rec of llm.recommendations) reasonMap.set(rec.id, rec.reason);

        setState((prev) => {
          const nextMessages = prev.messages.map((m) => {
            if (m.id !== assistantId) return m;
            const nextRecs = (m.recommendations || []).map((r) => ({
              ...r,
              reason: reasonMap.get(r.id) || r.reason || "",
            }));
            return { ...m, recommendations: nextRecs };
          });

          const nextRecommendedPlaces = prev.recommendedPlaces.map((p) => {
            const r = reasonMap.get(p.id);
            return r ? { ...p, reason: r } : p;
          });

          return { ...prev, messages: nextMessages, recommendedPlaces: nextRecommendedPlaces };
        });
      })();

    } catch (error: any) {
      console.error("[loadMoreRecommendations] 错误:", error);
      // 发生异常时也要确保 UI 更新
      const errorMessageBase = {
        id: `assistant-${Date.now()}`,
        role: "assistant" as const,
        messageType: "assistant" as const,
        content: "抱歉，获取推荐时出错了，请稍后再试。",
        recommendations: [],
        createdAt: new Date().toISOString(),
      };
      const errorMessage =
        activeSessionIdRef.current && client && user
          ? (await appendMessagesToSession(activeSessionIdRef.current, [errorMessageBase]))[0] || errorMessageBase
          : errorMessageBase;
      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, errorMessage],
        isLoading: false,
      }));
    } finally {
      loadMoreInFlightRef.current = false;
    }
  }, [appendMessagesToSession, client, fetchNextPagePlaces, user]); // Keep stable; relies on refs for latest state.

  return {
    ...state,
    sendMessage,
    clearMessages,
    setRecommendedPlaces,
    searchPlaces,
    loadOlderMessages,
    loadMorePlaces,
    loadMoreRecommendations,
  };
}
