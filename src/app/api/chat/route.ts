import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getGoogleMapsServerApiKey, normalizePlaceSummary } from "@/lib/googlePlaces";

const API_KEY = process.env.SILICONFLOW_API_KEY;
const BASE_URL = process.env.SILICONFLOW_BASE_URL || "https://api.siliconflow.cn/v1";
// Model routing:
// - Keep default model for general chat + intent logic.
// - Use a smaller/faster model for strict-JSON "data transformation" tasks (e.g. per-place reasons).
const DEFAULT_CHAT_MODEL = process.env.SILICONFLOW_CHAT_MODEL || "deepseek-ai/DeepSeek-V3";
// JSON-only tasks (e.g. generating per-place reasons) must be extremely reliable.
// Default to the same model as general chat unless explicitly overridden.
const JSON_TASK_MODEL = process.env.SILICONFLOW_JSON_MODEL || DEFAULT_CHAT_MODEL;

type CacheEntry<T> = { value: T; expiresAt: number };
const LLM_CACHE_TTL_MS = Number(process.env.LLM_CACHE_TTL_MS || 10 * 60 * 1000); // default: 10min
const LLM_CACHE_MAX = Number(process.env.LLM_CACHE_MAX || 500);
const llmCache = new Map<string, CacheEntry<unknown>>();

function hashKey(input: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function cacheGet<T>(key: string): T | null {
  const hit = llmCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    llmCache.delete(key);
    return null;
  }
  return hit.value as T;
}

function cacheSet<T>(key: string, value: T, ttlMs: number = LLM_CACHE_TTL_MS) {
  // Simple cap: drop oldest insertion order when size exceeds limit.
  if (llmCache.size >= LLM_CACHE_MAX) {
    const firstKey = llmCache.keys().next().value as string | undefined;
    if (firstKey) llmCache.delete(firstKey);
  }
  llmCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function parseJsonLenient(text: string): unknown | null {
  const raw = (text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Common LLM "JSON-like" issues: trailing commas, single quotes, unquoted keys, smart quotes, Python booleans.
    let repaired = raw
      .replace(/[\u201C\u201D]/g, "\"")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/\bTrue\b/g, "true")
      .replace(/\bFalse\b/g, "false")
      .replace(/\bNone\b/g, "null")
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, "$1\"$2\":");

    // Replace single-quoted strings with double-quoted strings.
    repaired = repaired.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_m, g1: string) => {
      const escaped = String(g1).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
      return `"${escaped}"`;
    });

    try {
      return JSON.parse(repaired);
    } catch {
      return null;
    }
  }
}

function extractFirstJsonObject(text: string): unknown | null {
  if (!text) return null;
  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  // Balanced-brace extraction: find the first complete JSON object and parse it.
  // This is resilient to the model adding pre/post text.
  for (let start = cleaned.indexOf("{"); start !== -1; start = cleaned.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];

      if (inString) {
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === "\\\\") {
          escape = true;
          continue;
        }
        if (ch === "\"") {
          inString = false;
        }
        continue;
      }

      if (ch === "\"") {
        inString = true;
        continue;
      }

      if (ch === "{") depth++;
      if (ch === "}") depth--;

      if (depth === 0 && i > start) {
        const candidate = cleaned.slice(start, i + 1);
        const parsed = parseJsonLenient(candidate);
        if (parsed) return parsed;
        break; // try the next '{'
      }
    }
  }

  return null;
}

function wantsJsonOutput(messages: unknown[]): boolean {
  // Frontend sometimes calls /api/chat with location=null but with a strict JSON-only system prompt.
  // In that case, we must not override the prompt with "normal chat" behavior.
  return (messages || []).some((m) => {
    if (!m || typeof m !== "object") return false;
    const record = m as Record<string, unknown>;
    const content = typeof record.content === "string" ? record.content : "";
    return (
      content.includes("只输出 JSON") ||
      content.includes("严格遵循以下输出格式") ||
      content.includes("\"intro\"") ||
      content.includes("\"places\"")
    );
  });
}

type HistoryMessage = { role: string; content: string };

const LOAD_MORE_PATTERNS: RegExp[] = [
  /换一批/i,
  /还有吗/i,
  /再推荐/i,
  /再来.*(?:个|些|几个)/i,
  /还有别的/i,
  /其他推荐/i,
  /再找/i,
  /换一批推荐/i,
  /more\b/i,
  /another/i,
];

function isLoadMoreMessage(userMessage: string): boolean {
  return LOAD_MORE_PATTERNS.some((re) => re.test(userMessage));
}

function isAppendConstraintMessage(userMessage: string): boolean {
  const msg = userMessage.trim();
  if (!msg) return false;
  if (isLoadMoreMessage(msg)) return false;

  // Common "follow-up constraints" patterns.
  const patterns: RegExp[] = [
    /远一点|近一点|离我(远|近)/,
    /便宜|贵一点|性价比|预算|人均|价格/,
    /安静|清静|不吵|氛围|约会|适合/,
    /户外|露台|室外|景观/,
    /\$?\s*\d+\s*(?:-\s*\d+)?\s*(?:刀|美元|usd|美金|￥|元|rmb)?/i,
  ];
  return patterns.some((re) => re.test(msg));
}

function inferBaseQueryFromHistory(history: HistoryMessage[]): string {
  // Pick the latest user message that looks like an initial search query (not "load more").
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== "user") continue;
    const c = (m.content || "").trim();
    if (!c) continue;
    if (isLoadMoreMessage(c)) continue;

    // Heuristic: restaurant/cafe intent or explicit location phrasing.
    const restaurantKeywords = ["吃", "餐厅", "饭店", "美食", "日料", "泰国菜", "日本料理", "韩餐", "西餐", "早餐", "午餐", "晚餐", "推荐", "附近", "咖啡", "cafe", "restaurant", "food"];
    const looksLikeSearch =
      restaurantKeywords.some((k) => c.toLowerCase().includes(k.toLowerCase())) ||
      /我在|现在在|在.+附近/.test(c);

    if (looksLikeSearch) return c;
  }
  return "";
}

function isPlaceSearchRequest(message: string): boolean {
  const m = (message || "").trim().toLowerCase();
  if (!m) return false;
  // Broad: any query that likely expects cards on map.
  const keywords = [
    // Food & drink
    "吃", "餐厅", "饭店", "美食", "日料", "日本料理", "韩餐", "西餐", "早餐", "午餐", "晚餐", "咖啡", "cafe", "restaurant", "food",
    "酒吧", "bar", "cocktail", "鸡尾酒",
    // Shopping
    "商场", "购物", "逛街", "mall", "shopping",
    // Convenience store
    "便利店", "convenience", "7-11", "7eleven", "seven eleven", "罗森", "lawson", "全家", "familymart",
    // Retail niches
    "买手店", "选品店", "boutique", "select shop", "服装店", "衣服", "古着", "vintage",
    "唱片店", "黑胶", "record store", "vinyl",
    // Photo spot
    "出片", "机位", "拍照", "取景", "打卡点",
    // Stay
    "酒店", "住宿", "民宿", "hostel", "hotel", "lodging",
    // Attractions
    "景点", "打卡", "观光", "博物馆", "museum", "公园", "park",
    // Generic
    "附近", "推荐", "帮我找", "想找", "要找",
  ];
  return keywords.some((k) => m.includes(k.toLowerCase()));
}

function inferIncludedTypesForClientSearch(message: string): string[] {
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

function inferRadiusForClientSearch(message: string): number {
  const types = inferIncludedTypesForClientSearch(message);
  if (types.includes("convenience_store")) return 1500;
  if (types.includes("clothing_store")) return 3000;
  if (types.includes("shopping_mall")) return 5000;
  if (types.includes("tourist_attraction")) return 5000;
  return 5000;
}

type QueryConversionResult =
  | { action: "load_more" }
  | { needClientSearch: true; searchParams: { textQuery: string } }
  | { needClientSearch: false };

function isRestaurantLikeMessage(message: string): boolean {
  const restaurantKeywords = [
    "吃", "餐厅", "饭店", "美食", "日料", "泰国菜", "日本料理", "韩餐",
    "西餐", "早餐", "午餐", "晚餐", "推荐", "附近", "便宜", "好吃",
    "咖啡", "cafe", "restaurant", "food",
  ];
  return restaurantKeywords.some((k) => message.toLowerCase().includes(k.toLowerCase()));
}

async function runQueryConversionEngine(params: {
  historyMessages: HistoryMessage[];
  userMessage: string;
}): Promise<QueryConversionResult | null> {
  const { historyMessages, userMessage } = params;

  // We already have a local regex interceptor for this in the main handler, but keep this guard anyway.
  if (isLoadMoreMessage(userMessage)) return { action: "load_more" };

  const cacheKey = `conv_${hashKey({ model: DEFAULT_CHAT_MODEL, historyMessages, userMessage })}`;
  const cached = cacheGet<QueryConversionResult>(cacheKey);
  if (cached) return cached;

  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: DEFAULT_CHAT_MODEL,
      messages: [
        {
          role: "system",
          content: `你现在是一个底层的【查询转换引擎】。你的唯一任务是将用户的自然语言输入转化为系统可识别的 JSON 信号。
禁止任何问候、解释或建议。禁止输出任何 Markdown 格式。
根据对话历史和最新输入，判断用户的意图：
- 如果用户是在要求翻页（如：换一批、还有吗）：必须返回 {"action": "load_more"}
- 如果用户是追加了新条件（仅限：远/近、预算/价格、安静/氛围、户外/露台等可由关键词表达的约束）：必须从历史中提取地点和类别，合并新条件生成新的搜索词，并返回 {"needClientSearch": true, "searchParams": {"textQuery": "合并后的新搜索词"}}
  - 不要生成“排队/人少/实时拥挤”等无法从 Google Places 字段直接获得的约束词。
你的输出必须是以 '{' 开始，以 '}' 结束的合法 JSON 字符串。

如果无法判断，返回 {"needClientSearch": false}。
`,
        },
        ...historyMessages,
        { role: "user", content: userMessage },
      ],
      temperature: 0,
    }),
  });

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "";
  const parsed = extractFirstJsonObject(content);
  if (!parsed || typeof parsed !== "object") return null;

  const record = parsed as Record<string, unknown>;

  if (record.action === "load_more") {
    const out: QueryConversionResult = { action: "load_more" };
    cacheSet(cacheKey, out);
    return out;
  }

  if (record.needClientSearch === true) {
    const sp = record.searchParams as Record<string, unknown> | undefined;
    const textQuery = sp?.textQuery;
    if (typeof textQuery === "string" && textQuery.trim()) {
      const out: QueryConversionResult = { needClientSearch: true, searchParams: { textQuery: textQuery.trim() } };
      cacheSet(cacheKey, out);
      return out;
    }
    return null;
  }

  if (record.needClientSearch === false) {
    const out: QueryConversionResult = { needClientSearch: false };
    cacheSet(cacheKey, out);
    return out;
  }

  return null;
}

// Google Places API 类型映射表
// 优先级：精确匹配关键词 > LLM 推断
const TYPE_MAPPINGS: Record<string, string[]> = {
  // 餐饮类 - 咖啡相关（最高优先级）
  "咖啡": ["cafe"],
  "咖啡店": ["cafe"],
  "咖啡厅": ["cafe"],
  "咖啡馆": ["cafe"],
  "cafe": ["cafe"],
  "喝咖啡": ["cafe"],
  "找个咖啡": ["cafe"],
  "下午茶": ["cafe", "bakery", "dessert_shop"],
  "甜品": ["bakery", "dessert_shop", "cake_shop"],
  "蛋糕": ["bakery", "cake_shop", "dessert_shop"],
  "面包": ["bakery"],
  "甜点": ["dessert_shop", "bakery", "cake_shop"],
  "早餐": ["restaurant", "cafe", "bakery"],
  "早茶": ["restaurant", "cafe"],

  // 正餐类
  "餐厅": ["restaurant"],
  "饭店": ["restaurant"],
  "美食": ["restaurant"],
  "日料": ["japanese_restaurant"],
  "日本料理": ["japanese_restaurant"],
  "寿司": ["sushi_restaurant"],
  "拉面": ["ramen_restaurant"],
  "韩国料理": ["korean_restaurant"],
  "韩餐": ["korean_restaurant"],
  "烤肉": ["korean_restaurant", "barbecue_restaurant"],
  "泰国菜": ["thai_restaurant"],
  "越南菜": ["vietnamese_restaurant"],
  "印度菜": ["indian_restaurant"],
  "西餐": ["european_restaurant", "italian_restaurant", "french_restaurant"],
  "意大利餐": ["italian_restaurant"],
  "法餐": ["french_restaurant"],
  "美式": ["american_restaurant"],
  "汉堡": ["fast_food_restaurant", "hamburger_restaurant"],
  "披萨": ["pizza_restaurant"],
  "川菜": ["sichuan_restaurant"],
  "湘菜": ["hunan_restaurant"],
  "粤菜": ["cantonese_restaurant"],
  "火锅": ["hot_pot_restaurant"],
  "麻辣烫": ["noodle_restaurant", "soup_restaurant"],
  "烧烤": ["barbecue_restaurant"],
  "面馆": ["noodle_restaurant"],
  "饺子": ["dumpling_restaurant"],
  "快餐": ["fast_food_restaurant"],
  "自助餐": ["buffet_restaurant"],

  // 住宿类
  "酒店": ["hotel", "lodging"],
  "住宿": ["hotel", "lodging"],
  "民宿": ["lodging", "guest_house"],
  "宾馆": ["hotel", "lodging"],
  "酒店下午茶": ["cafe", "restaurant"], // 特殊场景

  // 娱乐休闲类
  "酒吧": ["bar", "night_club"],
  "夜店": ["night_club", "bar"],
  "KTV": ["karaoke"],
  "唱歌": ["karaoke"],
  "健身房": ["gym", "fitness_center"],
  "运动": ["gym", "fitness_center", "sports_activity_location"],
  "购物": ["shopping_mall", "store", "clothing_store"],
  "商场": ["shopping_mall"],
  "超市": ["supermarket", "grocery_or_supermarket"],
  "便利店": ["convenience_store"],
  "罗森": ["convenience_store"],
  "全家": ["convenience_store"],
  "7-11": ["convenience_store"],
  "买手店": ["clothing_store", "store"],
  "选品店": ["clothing_store", "store"],
  "古着": ["clothing_store", "store"],
  "唱片店": ["store"],
  "黑胶": ["store"],

  // 景点类
  "景点": ["tourist_attraction", "park"],
  "公园": ["park", "tourist_attraction"],
  "博物馆": ["museum"],
  "美术馆": ["museum", "art_gallery"],
  "海滩": ["beach", "tourist_attraction"],
  "出片": ["tourist_attraction", "park"],
  "机位": ["tourist_attraction", "park"],
};

// 目标类型对应的"污染"类型（需要排除的）
const POLLUTING_TYPES: Record<string, string[]> = {
  "cafe": ["hotel", "lodging", "shopping_mall"], // 咖啡店搜索结果中排除酒店
  "bakery": ["hotel", "lodging"],
  "dessert_shop": ["hotel", "lodging"],
  "restaurant": [], // 餐厅一般不需要排除
  "japanese_restaurant": [],
  "korean_restaurant": [],
};

// 判断用户是否明确要求"酒店下午茶"等特殊场景
function hasExplicitHotelContext(userMessage: string): boolean {
  const hotelKeywords = ["酒店", "下午茶", "住宿", "民宿", "宾馆", "lodging"];
  const afternoonTeaKeywords = ["下午茶", "tea", "甜点"];

  const hasHotel = hotelKeywords.some(k => userMessage.includes(k));
  const hasAfternoonTea = afternoonTeaKeywords.some(k => userMessage.toLowerCase().includes(k.toLowerCase()));

  return hasHotel && hasAfternoonTea;
}

// 判断意图是否包含住宿类型
function isAccommodationIntent(includedTypes: string[]): boolean {
  return includedTypes.some(t =>
    t === "hotel" || t === "lodging" || t === "guest_house" || t === "hostel" || t === "resort"
  );
}

/**
 * 基于意图的动态重排算法 (Intent-Aware Re-ranking)
 *
 * 评分规则：
 * - primaryType 命中意图类型（includedTypes）：+100 分
 * - types 包含意图类型：+20 分
 * - 一票否决：如果意图不包含住宿，但 types 包含 hotel/lodging：-1000 分
 *   （除非意图本身就是找住宿）
 * - 基础分数：0 分
 *
 * 过滤规则：
 * - 分数 < 0 的地点直接剔除
 * - 按分数降序排列
 */
function calculateRelevanceScore(
  place: any,
  includedTypes: string[],
  intentTypes: string[]
): number {
  let score = 0;
  const placePrimaryType = (place.primaryType || "").toLowerCase();
  const placeTypes = (place.types || []).map((t: string) => t.toLowerCase());

  // 检查是否是一票否决情况
  // 如果意图不包含住宿，但地点包含 hotel/lodging，则扣 1000 分
  const hasAccommodationType = placeTypes.some((t: string) =>
    t === "hotel" || t === "lodging"
  );
  const isIntentAccommodation = isAccommodationIntent(includedTypes);

  if (hasAccommodationType && !isIntentAccommodation) {
    // 一票否决：非住宿意图但地点是住宿类型
    score -= 1000;
    console.log(`  [VETO] ${place.name}: has hotel/lodging in types, score = ${score}`);
    return score;
  }

  // 动态加分：primaryType 命中意图类型 +100 分
  for (const intentType of intentTypes) {
    const lowerIntentType = intentType.toLowerCase();
    if (placePrimaryType.includes(lowerIntentType)) {
      score += 100;
      console.log(`  [+100] ${place.name}: primaryType "${placePrimaryType}" matches "${lowerIntentType}"`);
      break; // primaryType 只加一次分
    }
  }

  // 动态加分：types 包含意图类型 +20 分
  for (const intentType of intentTypes) {
    const lowerIntentType = intentType.toLowerCase();
    for (const placeType of placeTypes) {
      if (placeType.includes(lowerIntentType)) {
        score += 20;
        console.log(`  [+20] ${place.name}: types contains "${lowerIntentType}"`);
        break; // 每个 intentType 只加一次
      }
    }
  }

  console.log(`  [SCORE] ${place.name}: final score = ${score}`);
  return score;
}

/**
 * 执行意图感知重排
 * - 计算每个地点的相关性分数
 * - 过滤分数 < 0 的地点
 * - 按分数降序排列
 */
function reRankByIntent(
  places: any[],
  includedTypes: string[],
  intentTypes: string[]
): any[] {
  console.log("=== Intent-Aware Re-ranking ===");

  // 计算每个地点的分数
  const scoredPlaces = places.map(place => ({
    ...place,
    _relevanceScore: calculateRelevanceScore(place, includedTypes, intentTypes),
  }));

  // 打印所有地点的分数
  console.log("All places with scores:");
  scoredPlaces.forEach((p: any) => {
    console.log(`  ${p.name}: score=${p._relevanceScore}, primaryType=${p.primaryType}`);
  });

  // 过滤分数 < 0 的地点，并按分数降序排列
  const filteredAndSorted = scoredPlaces
    .filter(p => p._relevanceScore >= 0)
    .sort((a, b) => b._relevanceScore - a._relevanceScore);

  console.log(`After filtering (score >= 0): ${filteredAndSorted.length} places remain`);
  filteredAndSorted.forEach((p: any, i: number) => {
    console.log(`  ${i + 1}. ${p.name} (score: ${p._relevanceScore})`);
  });

  return filteredAndSorted;
}

// Search places using Google Places API Text Search
async function searchNearbyPlaces(
  lat: number,
  lng: number,
  textQuery: string = "restaurant",
  radius: number = 5000
) {
  const url = "https://places.googleapis.com/v1/places:searchText";

  const requestBody: any = {
    textQuery: textQuery,
    locationBias: {
      circle: {
        center: {
          latitude: lat,
          longitude: lng,
        },
        radius: radius,
      },
    },
    maxResultCount: 20,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": getGoogleMapsServerApiKey(),
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.priceLevel,places.currentOpeningHours,places.photos,places.primaryType,places.types",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Google Places API error: ${error}`);
  }

  const data = await response.json();

  // Transform to simplified format (include primaryType for business validation)
  const places = (data.places || []).map((place: any) => normalizePlaceSummary(place));

  return { places, nextPageToken: data.nextPageToken || null };
}

// Step 1: 使用 LLM 解析用户需求，生成精准的 includedTypes
async function analyzeUserIntent(userMessage: string): Promise<{
  includedTypes: string[];
  targetTypes: string[];
  isHotelAfternoonTea: boolean;
  reasoning: string;
}> {
  // 首先尝试精确匹配
  for (const [keyword, types] of Object.entries(TYPE_MAPPINGS)) {
    if (userMessage.toLowerCase().includes(keyword.toLowerCase())) {
      const isHotelAfternoonTea = keyword === "酒店下午茶" || (keyword === "下午茶" && hasExplicitHotelContext(userMessage));
      return {
        includedTypes: types,
        targetTypes: types,
        isHotelAfternoonTea,
        reasoning: `关键词匹配: ${keyword}`,
      };
    }
  }

  // 如果没有精确匹配，使用 LLM 来推断
  const intentCacheKey = `intent_${hashKey({ model: DEFAULT_CHAT_MODEL, userMessage: userMessage.trim().toLowerCase() })}`;
  const intentCached = cacheGet<{
    includedTypes: string[];
    targetTypes: string[];
    isHotelAfternoonTea: boolean;
    reasoning: string;
  }>(intentCacheKey);
  if (intentCached) return intentCached;

  const llmResponse = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: DEFAULT_CHAT_MODEL,
      messages: [
        {
          role: "system",
          content: `你是一个旅行助手，专门将用户需求映射到 Google Places API 的标准类型。

🔴 紧急规则 - 必须严格遵守：
1. 如果用户输入包含"咖啡"（任何形式：咖啡、咖啡店、咖啡厅、喝咖啡、cafe），必须返回 ["cafe"]！绝对不能返回 restaurant 或其他类型！
2. 如果用户输入包含"餐厅"或"吃饭"，返回 ["restaurant"]
3. 如果用户输入包含"日料"或"日本料理"，返回 ["japanese_restaurant"]

可用的 Google Places 类型包括：
- 餐饮类：restaurant, cafe, bakery, dessert_shop, cake_shop, fast_food_restaurant, sushi_restaurant, japanese_restaurant, korean_restaurant, italian_restaurant, chinese_restaurant, thai_restaurant, vietnamese_restaurant, indian_restaurant, american_restaurant, european_restaurant, hot_pot_restaurant, barbecue_restaurant, noodle_restaurant, dumpling_restaurant, pizza_restaurant, hamburger_restaurant, ramen_restaurant, buffet_restaurant, soup_restaurant
- 住宿类：hotel, lodging, guest_house, hostel, resort
- 休闲娱乐类：bar, night_club, karaoke, gym, fitness_center, shopping_mall, store, clothing_store
- 景点类：tourist_attraction, park, museum, art_gallery, beach, zoo, aquarium

输出要求（严格 JSON 格式）：
{
  "targetTypes": ["cafe"],
  "reasoning": "简短说明"
}

只返回 JSON，不要任何解释！`,
        },
        {
          role: "user",
          content: userMessage,
        },
      ],
      temperature: 0.3,
    }),
  });

  const data = await llmResponse.json();
  let content = data.choices?.[0]?.message?.content || "";

  try {
    const cleanJson = content
      .replace(/^```json\s*/, "")
      .replace(/^```\s*/, "")
      .replace(/```\s*$/, "")
      .trim();
    const parsed = JSON.parse(cleanJson);

    const out = {
      includedTypes: parsed.targetTypes || ["restaurant"],
      targetTypes: parsed.targetTypes || ["restaurant"],
      isHotelAfternoonTea: hasExplicitHotelContext(userMessage),
      reasoning: parsed.reasoning || "LLM 推断",
    };
    cacheSet(intentCacheKey, out, 24 * 60 * 60 * 1000); // 24h
    return out;
  } catch (e) {
    // 🔴 解析失败时的 fallback 策略：根据用户输入的关键词推断
    // 如果包含"咖啡"相关关键词，默认用 cafe
    const lowerMsg = userMessage.toLowerCase();
    let fallbackTypes = ["restaurant"];

    if (lowerMsg.includes("咖啡") || lowerMsg.includes("cafe") || lowerMsg.includes("喝咖啡")) {
      fallbackTypes = ["cafe"];
    } else if (lowerMsg.includes("日料") || lowerMsg.includes("日本料理")) {
      fallbackTypes = ["japanese_restaurant"];
    } else if (lowerMsg.includes("韩国") || lowerMsg.includes("韩餐")) {
      fallbackTypes = ["korean_restaurant"];
    }

    console.log("⚠️ LLM parse failed, using fallback:", fallbackTypes);
    const out = {
      includedTypes: fallbackTypes,
      targetTypes: fallbackTypes,
      isHotelAfternoonTea: hasExplicitHotelContext(userMessage),
      reasoning: "LLM 解析失败，使用 fallback",
    };
    cacheSet(intentCacheKey, out, 60 * 60 * 1000); // 1h
    return out;
  }
}

// Step 2: 根据 primaryType 过滤地点（强制主业务校验）
function filterPlacesByPrimaryType(
  places: any[],
  targetTypes: string[],
  isHotelAfternoonTea: boolean
): any[] {
  // 如果是"酒店下午茶"场景，不过滤酒店
  if (isHotelAfternoonTea) {
    return places;
  }

  // 获取需要排除的污染类型
  const pollutingTypes = new Set<string>();
  for (const targetType of targetTypes) {
    const pollution = POLLUTING_TYPES[targetType] || [];
    pollution.forEach(t => pollutingTypes.add(t));
  }

  // 过滤：如果地点的 primaryType 在污染类型列表中，且不是目标类型，则排除
  return places.filter(place => {
    const primaryType = place.primaryType?.toLowerCase() || "";

    // 如果是污染类型，排除
    for (const pollType of pollutingTypes) {
      if (primaryType.includes(pollType)) {
        return false;
      }
    }

    // 如果 primaryType 不在目标类型中，也排除（严格匹配）
    // 但如果是 cafe 搜索，酒店内的 cafe 应该保留
    if (targetTypes.length > 0 && !isHotelAfternoonTea) {
      const isMatch = targetTypes.some(t =>
        primaryType.includes(t) || place.types?.some((ty: string) => ty.includes(t))
      );
      if (!isMatch) {
        return false;
      }
    }

    return true;
  });
}

function isSelfIntroMessage(message: string): boolean {
  const m = (message || "").trim().toLowerCase();
  if (!m) return false;
  // Conservative matching to avoid hijacking real queries.
  const patterns = [
    /你是谁/,
    /你能做什么/,
    /怎么用/,
    /使用说明/,
    /help\b/,
    /\bwhat can you do\b/,
    /\bwho are you\b/,
  ];
  return patterns.some((p) => p.test(m));
}

function buildSelfIntro(): string {
  return [
    "我是一个基于地图的旅行助手，擅长把“你想找什么 + 在哪里”变成一份可点可看的地点清单。",
    "",
    "我能做的事：",
    "1. 根据你的位置或你说的地名（例如“涩谷站附近”）推荐附近店铺，并展示成卡片列表（距离、营业状态等在卡片上）。",
    "2. 你可以继续追加条件（比如“更便宜点/远一点/安静点”），我会继承上下文再帮你重新搜一轮。",
    "3. 你可以说“换一批/还有吗”查看更多结果。",
    "4. 点卡片可以看店铺详情与评价摘要（文案会懒加载并缓存，避免反复等待）。",
    "",
    "快速开始：",
    "- 直接发：我在xx附近，想吃/想喝/想逛xx",
    "- 或者：给我推荐xx（我会问你位置或用你提供的地名）",
  ].join("\n");
}

export async function POST(request: NextRequest) {
  try {
    const { messages, location, historyMessages } = await request.json();

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json(
        { error: "Invalid messages format" },
        { status: 400 }
      );
    }

    console.log("=== Chat with Places API ===");

    // Get user's latest message
    const userMessage = messages[messages.length - 1]?.content || "";
    console.log("User message:", userMessage);

    if (isSelfIntroMessage(userMessage)) {
      return NextResponse.json({ content: buildSelfIntro() });
    }

    // 正则拦截"换一批"意图
    const loadMorePatterns = [
      /换一批/i,
      /还有吗/i,
      /再推荐/i,
      /再来.*(?:个|些|几个)/i,
      /还有别的/i,
      /其他推荐/i,
      /再找/i,
      /换一批推荐/i,
      /more\b/i,
      /another/i,
    ];
    const isLoadMoreRequest = loadMorePatterns.some(pattern => pattern.test(userMessage));

    if (isLoadMoreRequest) {
      console.log("检测到'换一批'意图，返回 action: load_more");
      return NextResponse.json({
        action: "load_more",
        content: JSON.stringify({
          intro: "好的，我来帮你换一批推荐！",
          places: [],
        }),
      });
    }

    // Use history for intent inheritance (e.g. user says only "远一点的" as a follow-up).
    const history = Array.isArray(historyMessages) ? historyMessages : messages;
    const trimmedHistory: HistoryMessage[] = history
      .filter((m: unknown) => {
        if (!m || typeof m !== "object") return false;
        const r = m as Record<string, unknown>;
        return typeof r.role === "string" && typeof r.content === "string";
      })
      .map((m: unknown) => {
        const r = m as Record<string, unknown>;
        return { role: r.role as string, content: r.content as string };
      })
      .slice(-6);

    const baseFromHistory = inferBaseQueryFromHistory(trimmedHistory);

    // Detect if this is a restaurant request
    const restaurantKeywords = ["吃", "餐厅", "饭店", "美食", "日料", "泰国菜", "日本料理", "韩餐", "西餐", "早餐", "午餐", "晚餐", "推荐", "附近", "便宜", "好吃", "咖啡", "cafe", "restaurant", "food"];
    const isRestaurantRequest = restaurantKeywords.some(keyword => userMessage.toLowerCase().includes(keyword.toLowerCase()));
    const isAppendConstraint = isAppendConstraintMessage(userMessage);

    // Query conversion engine: only returns strict JSON signals; never forward raw model text.
    // This enables "追加条件" messages without repeating the whole query.
    if (location && isAppendConstraint && baseFromHistory) {
      const conversion = await runQueryConversionEngine({
        historyMessages: trimmedHistory,
        userMessage,
      });

      if (conversion && "action" in conversion && conversion.action === "load_more") {
        return NextResponse.json({
          action: "load_more",
          content: JSON.stringify({
            intro: "好的，我来帮你换一批推荐！",
            places: [],
          }),
        });
      }

      if (conversion && "needClientSearch" in conversion && conversion.needClientSearch === true) {
        const mergedQuery = conversion.searchParams.textQuery;
        const inferredIncludedTypes =
          inferIncludedTypesForClientSearch(mergedQuery).length > 0
            ? inferIncludedTypesForClientSearch(mergedQuery)
            : inferIncludedTypesForClientSearch(baseFromHistory);
        return NextResponse.json({
          needClientSearch: true,
          userMessage,
          searchParams: {
            latitude: location.latitude,
            longitude: location.longitude,
            radius: inferRadiusForClientSearch(mergedQuery),
            textQuery: mergedQuery,
            includedTypes: inferredIncludedTypes,
          },
        });
      }

      // Hard fallback: if model ignored JSON constraints, force a new search with inherited base query.
      const textQuery = baseFromHistory ? `${baseFromHistory} ${userMessage}` : userMessage;
      return NextResponse.json({
        needClientSearch: true,
        userMessage,
        searchParams: {
          latitude: location.latitude,
          longitude: location.longitude,
          radius: inferRadiusForClientSearch(textQuery),
          textQuery,
          includedTypes: inferIncludedTypesForClientSearch(textQuery),
        },
      });
    }

    // Generic place search (shopping / attractions / hotels / etc): return a client-search instruction.
    if (location && isPlaceSearchRequest(userMessage)) {
      return NextResponse.json({
        needClientSearch: true,
        userMessage,
        searchParams: {
          latitude: location.latitude,
          longitude: location.longitude,
          radius: inferRadiusForClientSearch(userMessage),
          textQuery: userMessage,
          includedTypes: inferIncludedTypesForClientSearch(userMessage),
        },
      });
    }

    // If not a restaurant request, just do normal chat
    if (!isRestaurantRequest || !location) {
      console.log("Not a restaurant request or no location, doing normal chat");

      // If the caller explicitly asked for JSON-only output, keep the prompt intact even when location is null.
      // This is used by the "换一批/还有吗" flow where we re-rank from an existing list client-side.
      if (wantsJsonOutput(messages)) {
        const strictJsonWrapper = {
          role: "system",
          content:
            "你是一个无情的 JSON API。你必须且只能输出合法 JSON，禁止任何自然语言、解释、寒暄、Markdown。输出必须以 '{' 开始，以 '}' 结束。",
        };
        const makeRequest = async (withResponseFormat: boolean) => {
          const body: Record<string, unknown> = {
            model: JSON_TASK_MODEL,
            messages: [strictJsonWrapper, ...messages],
            temperature: 0,
            // Reasons are generated for up to ~5 places; allow enough room for 5x(80-120 chars) + JSON.
            max_tokens: 1200,
          };
          // If the provider supports it, this hard-locks output to a JSON object.
          if (withResponseFormat) body.response_format = { type: "json_object" };

          return fetch(`${BASE_URL}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${API_KEY}`,
            },
            body: JSON.stringify(body),
          });
        };

        // Prefer response_format enforcement; fall back if provider rejects the param.
        let response = await makeRequest(true);
        if (!response.ok) response = await makeRequest(false);
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || "";
        const parsed = extractFirstJsonObject(content);
        console.log("[api/chat] JSON task model =", JSON_TASK_MODEL, "parsedJson =", !!parsed);
        if (!parsed) {
          console.warn("[api/chat] JSON task raw (head):", String(content).slice(0, 240));
        }

        // 3) Always return something that starts with '{' so frontend parser won't get stuck.
        if (parsed && typeof parsed === "object") {
          return NextResponse.json({ content: JSON.stringify(parsed) });
        }

        return NextResponse.json({
          content: JSON.stringify({
            intro: "抱歉，文案生成失败了（模型未返回结构化 JSON）。",
            places: [],
          }),
        });
      }

      const response = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model: DEFAULT_CHAT_MODEL,
          messages: [
            {
              role: "system",
              content:
                "你是一个基于地图的旅行助手，用中文与用户对话。你的目标是让用户更快找到合适的地点并做出选择。\n\n你具备的能力（与当前产品一致）：\n- 你可以理解用户的地点上下文（例如“我在涩谷站附近”），并在需要时触发附近搜索返回地点卡片。\n- 用户可以继续追加筛选条件（便宜/远一点/安静/适合聊天等），你要继承上下文更新搜索。\n- 用户说“换一批/还有吗”表示想看更多结果。\n- 用户点开地点详情页时，会看到基于评论的评价摘要（该摘要会懒加载并缓存）。\n\n对话风格：自然、简洁、少复述。不要编造未提供的信息；如果需要位置或偏好，先问1个最关键的问题再继续。",
            },
            ...messages,
          ],
          temperature: 0.7,
        }),
      });

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || "抱歉，我暂时无法回答。";
      return NextResponse.json({ content });
    }

    // This is a restaurant request - search places first
    console.log("Searching places at:", location.latitude, location.longitude);

    // Step 1: 动态意图分析，获取精准的 includedTypes
    console.log("Step 1: Analyzing user intent...");
    const intentAnalysis = await analyzeUserIntent(userMessage);
    console.log("Intent analysis result:", intentAnalysis);

    // 构建 textQuery 用于 Text Search API
    // 使用用户消息作为查询词，并结合位置信息
    const textQuery = userMessage;

    let places: any[] = [];
    let nextPageToken: string | null = null;
    try {
      // 使用 Text Search API
      const result = await searchNearbyPlaces(
        location.latitude,
        location.longitude,
        textQuery
      );
      places = result.places;
      nextPageToken = result.nextPageToken;

      // 🔴 调试日志：显示 Google API 实际返回的数据
      console.log("========== DEBUG: Google API Response ==========");
      console.log("User message:", userMessage);
      console.log("textQuery used:", textQuery);
      console.log("Total places returned:", places.length);
      if (places.length > 0) {
        console.log("First 3 places (name, primaryType, types):");
        places.slice(0, 3).forEach((p: any, i: number) => {
          console.log(`  ${i + 1}. ${p.name}`);
          console.log(`     primaryType: ${p.primaryType}`);
          console.log(`     types: ${JSON.stringify(p.types)}`);
        });
      }
      console.log("================================================");

      // Step 2: 意图感知重排 (Intent-Aware Re-ranking)
      // 先使用旧的 filter 函数进行基础过滤，然后再用新重排算法
      console.log("Step 2: Applying intent-aware re-ranking...");
      if (!intentAnalysis.isHotelAfternoonTea) {
        places = filterPlacesByPrimaryType(places, intentAnalysis.targetTypes, intentAnalysis.isHotelAfternoonTea);
      }
      console.log("After basic filter:", places.length, "places");

      // Step 3: 动态重排算法
      places = reRankByIntent(places, intentAnalysis.includedTypes, intentAnalysis.targetTypes);
      console.log("After re-ranking:", places.length, "places remain");
    } catch (error: any) {
      console.error("Search error:", error.message);
      // Return instruction for client-side search
      return NextResponse.json({
        needClientSearch: true,
        userMessage: userMessage,
        searchParams: {
          latitude: location.latitude,
          longitude: location.longitude,
          radius: 5000,
          textQuery: userMessage,
        },
      });
    }

    if (places.length === 0) {
      return NextResponse.json({
        content: "抱歉，附近没有找到符合您需求的店铺。建议您尝试其他关键词，如" + intentAnalysis.targetTypes.join("、") + "等。",
        places: [],
      });
    }

    // Create a context with places data for the LLM (include primaryType for transparency)
    const placesContext = places.map((p: any, i: number) =>
      `${i + 1}. ${p.name}
   - ID: ${p.id}
   - 评分: ${p.rating} (${p.userRatingsTotal}条评价)
   - 地址: ${p.address}
   - 价格: ${p.priceLevel ? "$".repeat(p.priceLevel) : "未知"}
   - 营业中: ${p.openNow === true ? "是" : p.openNow === false ? "否" : "未知"}
   - 类型: ${p.primaryType || "未知"}`
    ).join("\n\n");

    // 计算实际可推荐的数量（最多 5 个）
    const maxRecommendations = Math.min(5, places.length);

    // Ask LLM to select top recommendations with anti-fabrication prompt
    const llmResponse = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: DEFAULT_CHAT_MODEL,
        messages: [
          {
            role: "system",
            content: `你是一个专业的店铺推荐助手。根据用户的需求，从以下店铺列表中筛选出最合适的进行推荐。

店铺列表：
${placesContext}

用户需求：${userMessage}

🔴 严重警告（必须遵守）：

1. 【强制校验】你推荐的店铺必须严格匹配用户需求：
   - 如果用户要找"咖啡"，你只能推荐 primaryType 为 "cafe" 的店铺
   - 如果用户要找"餐厅"，你只能推荐 primaryType 包含 "restaurant" 的店铺
   - 绝对不能推荐 hotel、lodging 类型的店铺给找咖啡/餐厅的用户（除非用户明确要求"酒店下午茶"）

2. 【宁缺毋滥 - 最关键】如果符合核心业务要求的店铺不足 ${maxRecommendations} 家，则按实际数量返回！
   - 禁止为了凑数而将非目标地点（如带餐厅的酒店）包装成推荐店
   - 禁止编造理由！reason 中描述的内容必须是该店铺真实存在的特色
   - 禁止输出空数组！如果只有 2 家符合要求，就返回 2 家

3. id 字段必须且只能原样复制上面列表中的 Google Place ID！绝对不要填入店铺名称或任何非 ID 的字符串！

4. reason 必须提供真实、具体的推荐理由：招牌菜/特色菜品、店面环境氛围、适合什么人群等。

严格遵循以下输出格式：
{
  "intro": "帮你精选了这X家店：",
  "places": [
    { "id": "店铺ID", "reason": "真实、具体的推荐理由（30-50字）" },
    ...根据实际符合要求的店铺数量，最多 ${maxRecommendations} 个
  ]
}

只输出 JSON，不要任何解释、问候或 markdown 代码块！`
          },
        ],
        temperature: 0.3,
      }),
    });

    const llmData = await llmResponse.json();
    let llmContent = llmData.choices?.[0]?.message?.content || "";

    console.log("LLM raw response:", llmContent);

    // Parse the JSON response from LLM
    let recommendations: { id: string; reason: string }[] = [];
    let introText = `帮你精选了这${maxRecommendations}家店：`;

    try {
      // 防范坑点1：移除 Markdown 代码块标记
      const cleanJson = llmContent
        .replace(/^```json\s*/, "")
        .replace(/^```\s*/, "")
        .replace(/```\s*$/, "")
        .trim();

      const parsed = JSON.parse(cleanJson);
      introText = parsed.intro || introText;
      recommendations = parsed.places || [];
      console.log("Parsed recommendations:", recommendations);
    } catch (parseError) {
      console.error("JSON parse error:", parseError);
      // 如果解析失败，返回原始内容作为普通回复
      introText = llmContent || "抱歉，推荐数据解析失败";
    }

    // Return both content and places (full list for matching IDs)
    return NextResponse.json({
      content: introText,
      recommendations: recommendations,
      places: places.slice(0, 20), // Return all 20 places for UI to match
      nextPageToken: nextPageToken,
    });

  } catch (error: any) {
    console.error("Chat API error:", error);
    return NextResponse.json(
      { error: error.message || "Internal server error" },
      { status: 500 }
    );
  }
}
