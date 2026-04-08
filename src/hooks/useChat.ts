"use client";

import { useState, useCallback, useRef } from "react";
import { ChatMessage, Place, PlaceRecommendation } from "@/types/chat";
import { useLocationContext } from "@/context/LocationContext";
import { haversineMeters } from "@/lib/distance";

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
      console.warn("No JSON found in response, returning original text");
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
    console.warn("JSON parse failed, returning original text:", content.substring(0, 100));
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
      console.log(`[Frontend Filter] 过滤掉: ${place.name} (primaryType: ${place.primaryType})`);
      return false;
    }

    return true;
  });

  console.log(`[Frontend Filter] 过滤前: ${places.length}, 过滤后: ${filtered.length}`);
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
  if (/(餐厅|吃|美食|restaurant)/i.test(m)) return ["restaurant"];
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
}) {
  const { textQuery, lat, lng, radius = 5000 } = params;
  return `gmaps_search_${encodeURIComponent(textQuery)}_${roundCoord(lat)}_${roundCoord(lng)}_${radius}`;
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
  error: string | null;
  recommendedPlaces: Place[];
  allPlaces: Place[]; // 存储所有获取的地点（20个），用于"换一批"
  nextPageToken: string | null;
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
    console.log("[generateReasonsForPlaces] cache=hit places=", places.length);
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
    if (rawText) {
      console.warn("[generateReasonsForPlaces] Model returned non-JSON; using local fallback reasons.");
    }
    console.log("[generateReasonsForPlaces] source=fallback places=", places.length);
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

  console.log("[generateReasonsForPlaces] source=llm recs=", recommendations.length);
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

// Simple location keyword detection
function extractLocationFromMessage(message: string): string | null {
  const patterns = [
    /我在(.+?)(?:附近|边上|旁边)/,
    /现在在(.+?)(?:附近|边上|旁边)/,
    /在(.+?)(?:附近|边上|旁边)/,
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
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
  const [state, setState] = useState<ChatState>({
    messages: [
      {
        id: "welcome",
        role: "assistant",
        content:
          "我是给 P 人准备的旅行助手。\n\n不用提前做攻略，也不用先查一堆店。你只要告诉我你此时此刻在哪、现在想干嘛，我就能按当前位置直接推荐附近去处。\n\n目前支持日本、泰国、香港、越南和韩国。\n\n比如你可以直接说：\n- 我在涩谷站附近，想吃烧肉\n- 我刚到尖沙咀，想找家咖啡店坐一下\n- 我在首尔圣水洞，想逛逛买手店\n- 我在胡志明市第一郡，附近有没有越南菜推荐",
      },
    ],
    isLoading: false,
    error: null,
    recommendedPlaces: [],
    allPlaces: [], // 存储所有获取的地点
    nextPageToken: null,
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

  // Cursor-based paging for "换一批". Stable across re-renders and avoids closure traps.
  const placeOffsetRef = useRef<number>(0);
  const shownPlaceIdsRef = useRef<Set<string>>(new Set());
  const exhaustedRef = useRef<boolean>(false);
  const loadMoreInFlightRef = useRef<boolean>(false);

  const resetPlaceCursor = useCallback(() => {
    placeOffsetRef.current = 0;
    shownPlaceIdsRef.current = new Set();
    exhaustedRef.current = false;
  }, []);

  const seedShownPlaces = useCallback((places: Place[]) => {
    // Mark already-rendered recommendations as shown so "换一批" never repeats them.
    const set = new Set(shownPlaceIdsRef.current);
    for (const place of places) set.add(place.id);
    shownPlaceIdsRef.current = set;
  }, []);

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
    const response = await fetch("/api/places", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nextPageToken: token }),
    });

    const data = await response.json();
    if (!response.ok) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[Places] Falling back to direct next-page request in development");
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
        console.error("Places search error:", data);
        if (process.env.NODE_ENV !== "production") {
          console.warn("[Places] Falling back to direct client request in development");
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
        console.log("[Places Cache] HIT", cacheKey);
        places = cached.places;
        nextPageToken = cached.nextPageToken;
      } else {
        if (cached && cached.places.length > 0) {
          console.log("[Places Cache] STALE", cacheKey);
          try {
            window.sessionStorage.removeItem(cacheKey);
          } catch {}
        } else {
          console.log("[Places Cache] MISS", cacheKey);
        }
        places = normalizePlacesFromGoogle(data.places || []).map((p) => ({
          ...p,
          reason: "",
        }));
        nextPageToken = data.nextPageToken || null;
      }

      console.log("Places proxy success, places:", places.length);
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
      } else if (process.env.NODE_ENV !== "production") {
        console.warn("[Places] Falling back to direct client request in development");
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
      }
    } catch (error) {
      console.error("doSearch error:", error);
    }
  }, []);

  const handleLocationUpdate = useCallback(async (message: string) => {
    const locationText = extractLocationFromMessage(message);
    if (locationText) {
      console.log("Detected location:", locationText);
      try {
        const result = await geocode(locationText);
        if (result) {
          console.log("Geocode result:", result);
          await updateLocation(result);
        }
      } catch (error) {
        console.error("Location update failed:", error);
      }
    }
  }, [geocode, updateLocation]);

  const sendMessage = useCallback(async (content: string) => {
    console.log("=== [sendMessage] 开始处理消息 ===");
    console.log("[sendMessage] 步骤1: 初始化状态");

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    const userMessage: ChatMessage & { id: string } = {
      id: `user-${Date.now()}`,
      role: "user",
      content,
    };

    setState((prev) => ({
      ...prev,
      messages: [...prev.messages, userMessage],
      isLoading: true,
      error: null,
    }));

    console.log("[sendMessage] 步骤2: 检测位置关键词");

    // Try to detect and update location from user message BEFORE calling AI
    const locationText = extractLocationFromMessage(content);
    let updatedLocation = null;
    if (locationText) {
      console.log("[sendMessage] 步骤3: 正在 Geocode:", locationText);
      updatedLocation = await geocode(locationText);
      if (updatedLocation) {
        console.log("[sendMessage] 步骤4: Geocode 成功", updatedLocation);
        await updateLocation(updatedLocation);
      } else {
        console.log("[sendMessage] 步骤4: Geocode 返回 null");
      }
    }

    // Use location from context or updated location
    const locToUse = updatedLocation || locationRef.current;
    console.log("[sendMessage] 步骤5: 使用位置", locToUse);

    try {
      const messages: ChatMessage[] = [
        ...messagesRef.current.map(({ role, content }) => ({ role, content })),
        { role: "user", content },
      ];

      console.log("[sendMessage] 步骤6: 调用 /api/chat");

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages,
          historyMessages: messagesRef.current
            .slice(-6)
            .map(({ role, content }) => ({ role, content })),
          location: locToUse ? { latitude: locToUse.lat, longitude: locToUse.lng } : null,
        }),
        signal: abortControllerRef.current.signal,
      });

      console.log("[sendMessage] 步骤7: /api/chat 返回", response.status);

      if (!response.ok) {
        throw new Error(`API error: ${response.statusText}`);
      }

      const data = await response.json();
      console.log("[sendMessage] 步骤8: 解析 JSON 响应", data);

      // If server needs client to search
      if (data.needClientSearch) {
        console.log("[sendMessage] 需要客户端搜索");

        const rawTextQuery = data.searchParams?.textQuery || "restaurant";
        const centerLat = data.searchParams.latitude;
        const centerLng = data.searchParams.longitude;
        const radius = data.searchParams.radius || 5000;

        // Backend may send a verbose query containing a landmark that is actually a location context.
        // Normalize it here so we don't accidentally recommend the landmark itself.
        const textQuery = normalizeClientTextQuery({ userMessage: content, textQuery: rawTextQuery });

        const cacheKey = buildPlacesCacheKey({
          textQuery,
          lat: centerLat,
          lng: centerLng,
          radius,
        });
        try {
          const cached = getCachedPlaces(cacheKey);
          let googleData: any = null;

          if (cached && cached.places.length > 0 && !isCachePayloadLikelyBroken(cached.places)) {
            console.log("[Places Cache] HIT", cacheKey);
            googleData = { places: cached.places, nextPageToken: cached.nextPageToken };
          } else {
            if (cached && cached.places.length > 0) {
              console.log("[Places Cache] STALE", cacheKey);
              try {
                window.sessionStorage.removeItem(cacheKey);
              } catch {}
            } else {
              console.log("[Places Cache] MISS", cacheKey);
            }
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
              }),
            });

            googleData = await googleResponse.json();
            if (!googleResponse.ok) {
              if (process.env.NODE_ENV !== "production") {
                console.warn("[Places] Falling back to direct client request in development");
                googleData = await clientSearchPlaces({
                  textQuery,
                  lat: centerLat,
                  lng: centerLng,
                  radius,
                });
              } else {
                throw new Error(googleData?.error || "Places proxy failed");
              }
            }
            console.log("Places proxy response:", googleData);
          }

          if (!googleData.places || googleData.places.length === 0) {
            setState((prev) => ({
              ...prev,
              messages: [...prev.messages, {
                id: `assistant-${Date.now()}`,
                role: "assistant",
                content: "抱歉，附近没有找到相关的餐厅。",
              }],
              isLoading: false,
            }));
            return;
          }

          // Transform places (添加 primaryType 和 types)
          // Note: cache HIT returns already-transformed Place[]; avoid double-mapping.
          let places = normalizePlacesFromGoogle(googleData.places);

          // Text Search may return far-away results even with locationBias. Keep results local.
          places = filterPlacesByRadius({ places, centerLat, centerLng, radius });

          console.log("Transformed places:", places.length);

          // Cache the full 20 places for same (textQuery + center coords).
          setCachedPlaces(cacheKey, {
            places,
            nextPageToken: googleData.nextPageToken || null,
          });

          // 🔴 前端数据净化：根据真实意图过滤酒店
          // 从后端返回的 searchParams 获取真实的 includedTypes
          const intentTypes =
            (Array.isArray(data.searchParams?.includedTypes) && data.searchParams.includedTypes.length > 0)
              ? data.searchParams.includedTypes
              : inferIncludedTypesFromUserMessage(content);
          console.log("[Frontend Filter] 真实意图类型 from backend:", intentTypes);

          let filteredPlaces = filterPlacesByIntent(places, intentTypes);
          filteredPlaces = filterPlacesByShoppingIntent({ places: filteredPlaces, includedTypes: intentTypes });
          filteredPlaces = filterPlacesByConvenienceIntent({ places: filteredPlaces, includedTypes: intentTypes });
          const filteredPlacesForDisplay =
            filteredPlaces.length >= 5 ? filteredPlaces : mergePlacesPreservingOrder(filteredPlaces, places);
          console.log(
            "[Frontend Filter] 发给 LLM 的纯净数据:",
            filteredPlaces.length,
            "个地点；展示回填后:",
            filteredPlacesForDisplay.length,
            "个地点"
          );

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
          const immediateReasonMap = new Map<string, string>();
          for (const p of topPlaces) {
            immediateReasonMap.set(p.id, getCachedReason(p) || buildFallbackReasonForPlace(p));
          }
          const intro = preferDistance ? "在你附近先挑了几家更顺路的：" : "为您找到以下几家高分好店：";
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
	          const assistantId = `assistant-${Date.now()}`;
	          resetPlaceCursor();
	          seedShownPlaces(recommendedPlaces);
	          setState((prev) => ({
	            ...prev,
	            messages: [...prev.messages, {
	              id: assistantId,
	              role: "assistant",
	              content: intro,
	              recommendations: recommendations,
	            }],
	            recommendedPlaces: recommendedPlaces,
	            allPlaces: mergePlacesPreservingOrder(prev.allPlaces, allPlacesData),
	            nextPageToken: googleData.nextPageToken || null,
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
          setState((prev) => ({
            ...prev,
            messages: [...prev.messages, {
              id: `assistant-${Date.now()}`,
              role: "assistant",
              content: `抱歉，搜索餐厅时出错：${googleError.message}。请稍后再试。`,
            }],
            isLoading: false,
          }));
          return;
        }
      }

      // 防范坑点2：等消息接收完毕后再解析 JSON（非流式可以直接处理）
      const { intro, recommendations } = extractAndParseJSON(data.content || "");

      console.log("[useChat] JSON 解析结果:", { intro, recommendations, hasPlaces: !!data.places });

      // 处理后端返回的 action 信号
      if (data.action === "load_more") {
        console.log("[sendMessage] 后端返回 action: load_more，调用 loadMoreRecommendations");
        const excludeIds = recommendedPlacesRef.current.map((p) => p.id);
        await loadMoreRecommendations(allPlacesRef.current, excludeIds);
        return;
      }

      const assistantMessage: ChatMessage & { id: string } = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: intro,
        recommendations: recommendations,
      };

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
                console.log("[useChat] 模糊匹配成功:", rec.id, "<->", pName);
                return { ...p, reason: rec.reason };
              }
            }

            console.log("[useChat] 匹配失败:", rec.id);
            return null;
          })
          .filter((p): p is Place => p !== null);

        console.log("[useChat] 匹配到推荐地点:", newRecommendedPlaces.length);
      }

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
        recommendedPlaces: newRecommendedPlaces,
        allPlaces: mergePlacesPreservingOrder(prev.allPlaces, allPlacesData),
        nextPageToken: data.nextPageToken || null,
        isLoading: false,
      }));

      // Also try to detect location from AI response
      if (data.content) {
        handleLocationUpdate(data.content);
      }
      console.log("[sendMessage] 步骤9: 发送成功完成");
    } catch (error: any) {
      if (error.name === "AbortError") {
        console.log("[sendMessage] AbortError: 请求被取消");
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
      console.log("[sendMessage] 步骤10: finally 块执行，确保 isLoading = false");
      setState((prev) => ({ ...prev, isLoading: false }));
    }
  }, [handleLocationUpdate, searchPlaces]);

  const clearMessages = useCallback(() => {
    resetPlaceCursor();
    setState((prev) => ({
      ...prev,
      messages: [prev.messages[0]],
      recommendedPlaces: [],
      allPlaces: [],
      nextPageToken: null,
    }));
  }, []);

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

      const response = await fetch("/api/places", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nextPageToken: currentToken }),
      });

      const data = await response.json();
      if (!response.ok) {
        if (process.env.NODE_ENV !== "production") {
          console.warn("[Places] Falling back to direct next-page request in development");
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
    console.log("=== [loadMoreRecommendations] 开始 ===");
    void _allPlaces;
    void _excludeIds;

    try {
      // Avoid race conditions from rapid clicking.
      if (loadMoreInFlightRef.current) {
        console.log("[loadMoreRecommendations] in-flight, ignoring");
        return;
      }
      loadMoreInFlightRef.current = true;

      setState((prev) => ({ ...prev, isLoading: true }));
      console.log("[loadMoreRecommendations] 步骤1: 设置 isLoading = true");

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

        console.log("[loadMoreRecommendations] 本地不足，拉取下一页，token:", token);
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
          setState((prev) => ({
            ...prev,
            messages: [...prev.messages, {
              id: `assistant-${Date.now()}`,
              role: "assistant",
              content: exhaustionText,
            }],
            isLoading: false,
          }));
          return;
        }
      }

      const assistantId = `assistant-${Date.now()}`;

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
          messages: [...prev.messages, {
            id: assistantId,
            role: "assistant",
            content: `再给你换一批，这次是${batch.length}家：`,
            recommendations,
          }],
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
      console.log("[loadMoreRecommendations] 完成：推荐", batch.length, "家；cursor =", placeOffsetRef.current);

    } catch (error: any) {
      console.error("[loadMoreRecommendations] 错误:", error);
      // 发生异常时也要确保 UI 更新
      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: "抱歉，获取推荐时出错了，请稍后再试。",
          recommendations: [],
        }],
        isLoading: false,
      }));
    } finally {
      loadMoreInFlightRef.current = false;
    }
  }, [appendPlacesDeduped, fetchNextPagePlaces]); // Keep stable; relies on refs for latest state.

  return {
    ...state,
    sendMessage,
    clearMessages,
    setRecommendedPlaces,
    searchPlaces,
    loadMorePlaces,
    loadMoreRecommendations,
  };
}
