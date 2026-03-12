"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Place } from "@/types/chat";

interface PlaceDetailProps {
  place: Place;
  onClose: () => void;
}

const REVIEWS_SUMMARY_CACHE_VERSION = 1;
const REVIEWS_SUMMARY_NEGATIVE_TTL_MS = 5 * 60 * 1000; // don't retry too aggressively within a session

function hashString(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function buildReviewsSummaryCacheKey(place: Place) {
  const parts =
    (place.reviews || []).map((r) => `${r.authorName || ""}|${String(r.rating ?? "")}|${r.relativeTimeDescription || ""}|${r.text || ""}`) || [];
  const sig = `${place.id}|${parts.join("||")}`;
  return `llm_reviews_summary_v${REVIEWS_SUMMARY_CACHE_VERSION}_${Math.abs(hashString(sig))}`;
}

function extractFirstJsonObject(text: string): any | null {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  const start = cleaned.indexOf("{");
  if (start === -1) return null;
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
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === "\"") inString = false;
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
      try {
        return JSON.parse(candidate);
      } catch {
        return null;
      }
    }
  }
  return null;
}

export default function PlaceDetail({ place, onClose }: PlaceDetailProps) {
  const [hoursOpen, setHoursOpen] = useState(false);
  const [reviewsSummary, setReviewsSummary] = useState<string>("");
  const [reviewsSummaryLoading, setReviewsSummaryLoading] = useState<boolean>(false);
  const fetchSeq = useRef(0);

  const getPriceLevel = (level?: number) => {
    if (!level) return "";
    return "$".repeat(level);
  };

  const isAnonymousName = (name?: string | null) => {
    const n = (name || "").trim().toLowerCase();
    return !n || n === "匿名用户" || n === "anonymous" || n === "anonymous user";
  };

  const photos = place.photos || [];

  const statusBadge = useMemo(() => {
    if (place.openNow === true) {
      return { label: "营业中", dot: "bg-green-600", cls: "bg-green-50 text-green-700 border-green-100" };
    }
    if (place.openNow === false) {
      return { label: "已关门", dot: "bg-red-600", cls: "bg-red-50 text-red-700 border-red-100" };
    }
    return { label: "营业状态未知", dot: "bg-gray-500", cls: "bg-gray-50 text-gray-700 border-gray-100" };
  }, [place.openNow]);

  const stars = useMemo(() => {
    const full = Math.max(0, Math.min(5, Math.floor(place.rating || 0)));
    return { full, empty: Math.max(0, 5 - full) };
  }, [place.rating]);

  useEffect(() => {
    const reviews = place.reviews || [];
    if (reviews.length === 0) {
      setReviewsSummary("");
      setReviewsSummaryLoading(false);
      return;
    }

    const cacheKey = buildReviewsSummaryCacheKey(place);
    try {
      const cachedRaw = window.sessionStorage.getItem(cacheKey);
      if (cachedRaw) {
        const cached = JSON.parse(cachedRaw) as { v?: number; ok?: boolean; summary?: string; cachedAt?: number } | null;
        if (cached && cached.v === REVIEWS_SUMMARY_CACHE_VERSION) {
          const cachedAt = typeof cached.cachedAt === "number" ? cached.cachedAt : 0;
          if (cached.ok === true && typeof cached.summary === "string" && cached.summary.trim()) {
            setReviewsSummary(cached.summary);
            setReviewsSummaryLoading(false);
            return;
          }
          if (cached.ok === false && Date.now() - cachedAt < REVIEWS_SUMMARY_NEGATIVE_TTL_MS) {
            setReviewsSummary("");
            setReviewsSummaryLoading(false);
            return;
          }
        }
      }
    } catch {
      // ignore
    }

    const seq = ++fetchSeq.current;
    setReviewsSummary("");
    setReviewsSummaryLoading(true);

    void (async () => {
      try {
        const reviewsContext = reviews
          .slice(0, 3)
          .map((r, i) => {
            const text = (r.text || "").trim().slice(0, 360);
            const time = (r.relativeTimeDescription || "").trim();
            const rating = typeof r.rating === "number" ? r.rating : "";
            return `${i + 1}. ${time ? `[${time}] ` : ""}${rating ? `(星级:${rating}) ` : ""}${text}`;
          })
          .join("\n");

        const resp = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [
              {
                role: "system",
                content: `你是一个【用户评价总结引擎】。你的任务是基于我提供的评论文本，写一段自然中文总结。

评论（唯一信息来源）：
${reviewsContext}

严格规则：
1) 你必须且只能输出合法 JSON，禁止任何 Markdown 或自然语言前后缀。
2) 输出格式固定为：{"summary":"..."}，只允许这个字段。
3) summary 写 80-140 字一段自然语言，总结“大家常提到的优点/可能的槽点/适合的人群或场景”。
4) 禁止编造评论里没有提到的细节（比如招牌菜、服务态度、排队情况、环境氛围等，除非评论文本明确提到）。
5) 不要复述任何数字（不要写星级、不要写评论数量）。只用“口碑在线/不少人提到/有人吐槽”等非数字表达。`,
              },
              { role: "user", content: "请按要求只返回 JSON。" },
            ],
            location: null,
          }),
        });

        const data = await resp.json();
        const parsed = extractFirstJsonObject(data?.content || "");
        const summary = typeof parsed?.summary === "string" ? parsed.summary.trim() : "";
        if (fetchSeq.current !== seq) return;

        if (summary) {
          setReviewsSummary(summary);
          try {
            window.sessionStorage.setItem(
              cacheKey,
              JSON.stringify({ v: REVIEWS_SUMMARY_CACHE_VERSION, ok: true, summary, cachedAt: Date.now() })
            );
          } catch {
            // ignore
          }
        } else {
          setReviewsSummary("");
          try {
            window.sessionStorage.setItem(
              cacheKey,
              JSON.stringify({ v: REVIEWS_SUMMARY_CACHE_VERSION, ok: false, summary: "", cachedAt: Date.now() })
            );
          } catch {
            // ignore
          }
        }
      } catch {
        if (fetchSeq.current !== seq) return;
        setReviewsSummary("");
        try {
          window.sessionStorage.setItem(
            cacheKey,
            JSON.stringify({ v: REVIEWS_SUMMARY_CACHE_VERSION, ok: false, summary: "", cachedAt: Date.now() })
          );
        } catch {
          // ignore
        }
      } finally {
        if (fetchSeq.current === seq) setReviewsSummaryLoading(false);
      }
    })();
  }, [place.id, place.reviews]);

  const todayHours = useMemo(() => {
    const list = place.openingHours || [];
    if (list.length === 0) return "";

    // Google weekdayDescriptions are typically ordered Monday..Sunday.
    // JS getDay() is Sunday(0)..Saturday(6); convert to Monday-based index.
    const day = new Date().getDay();
    const mondayIndex = day === 0 ? 6 : day - 1;
    return list[mondayIndex] || list[0] || "";
  }, [place.openingHours]);

  return (
    <div className="h-full flex flex-col bg-white">
      <div className="flex-1 overflow-y-auto">
        {/* Hero */}
        <div className="relative">
          <div className="grid grid-cols-3 gap-1 h-64 bg-gray-200">
            <div className="col-span-2 h-64 overflow-hidden">
              {photos[0] ? (
                <img
                  src={photos[0]}
                  alt={`${place.name} photo 1`}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full bg-gradient-to-br from-gray-200 to-gray-300" />
              )}
            </div>
            <div className="col-span-1 h-64 grid grid-rows-2 gap-1">
              <div className="overflow-hidden">
                {photos[1] ? (
                  <img
                    src={photos[1]}
                    alt={`${place.name} photo 2`}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full bg-gradient-to-br from-gray-200 to-gray-300" />
                )}
              </div>
              <div className="overflow-hidden">
                {photos[2] ? (
                  <img
                    src={photos[2]}
                    alt={`${place.name} photo 3`}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full bg-gradient-to-br from-gray-200 to-gray-300" />
                )}
              </div>
            </div>
          </div>

          {/* Floating back button */}
          <button
            onClick={onClose}
            aria-label="Back"
            className="absolute top-4 left-4 h-11 w-11 rounded-full bg-white/60 backdrop-blur-md border border-white/40 shadow-lg flex items-center justify-center hover:bg-white/75 transition-colors"
          >
            <svg className="w-5 h-5 text-gray-900" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 18l-6-6 6-6" />
            </svg>
          </button>
        </div>

        {/* Header info */}
        <div className="px-5 pt-5">
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <h2 className="text-2xl font-bold text-gray-900 leading-tight break-words">{place.name}</h2>

              <div className="flex flex-wrap items-center gap-2 mt-2">
                <span className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-sm border ${statusBadge.cls}`}>
                  <span className={`w-2 h-2 rounded-full ${statusBadge.dot}`} />
                  {statusBadge.label}
                </span>
                {(() => {
                  const priceText = getPriceLevel(place.priceLevel);
                  if (!priceText) return null;
                  return (
                  <span className="inline-flex items-center px-2.5 py-1 rounded-full text-sm border bg-gray-50 text-gray-700 border-gray-200">
                    {priceText}
                  </span>
                  );
                })()}
                {(() => {
                  const t = (place.primaryType || "").trim();
                  if (!t) return null;
                  // Guard against unexpected payloads (e.g. empty strings or duplicated place name).
                  if (t.toLowerCase() === (place.name || "").trim().toLowerCase()) return null;
                  return (
                  <span className="inline-flex items-center px-2.5 py-1 rounded-full text-sm border bg-gray-50 text-gray-700 border-gray-200">
                    {t}
                  </span>
                  );
                })()}
              </div>

              <div className="flex items-center gap-2 mt-3">
                <div className="flex items-center text-yellow-400">
                  {"★".repeat(stars.full)}
                  <span className="text-gray-200">
                    {"★".repeat(stars.empty)}
                  </span>
                </div>
                <span className="text-sm text-gray-700">
                  {place.rating.toFixed(1)}
                </span>
                <span className="text-sm text-gray-400">
                  ({place.userRatingsTotal} 条评价)
                </span>
              </div>
            </div>
          </div>

        </div>

        {/* AI reviews summary - standalone section (not grouped with address/hours) */}
        {place.reviews && place.reviews.length > 0 && (
          <div className="px-5 mt-5">
            <div className="rounded-2xl bg-gradient-to-br from-slate-50 via-white to-slate-100 border border-slate-200/80 p-4 shadow-sm">
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-full bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-700">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 2l1.2 3.8L17 7l-3.8 1.2L12 12l-1.2-3.8L7 7l3.8-1.2L12 2z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l.9 2.7L8.6 16l-2.7.9L5 19l-.9-2.7L1.4 16l2.7-.9L5 13z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 13l.9 2.7 2.7.3-2.1 1.6.7 2.8-2.2-1.4-2.2 1.4.7-2.8-2.1-1.6 2.7-.3.9-2.7z" />
                  </svg>
                </div>
                <div className="text-sm font-semibold text-slate-900">AI 评价速览</div>
                <span className="ml-auto inline-flex items-center rounded-full bg-white/70 px-2 py-0.5 text-[11px] font-medium text-slate-600 border border-slate-200">
                  基于评论生成
                </span>
              </div>

              {reviewsSummaryLoading ? (
                <div className="mt-3 space-y-2 animate-pulse">
                  <div className="h-3 rounded bg-slate-200 w-11/12" />
                  <div className="h-3 rounded bg-slate-200 w-10/12" />
                  <div className="h-3 rounded bg-slate-200 w-8/12" />
                </div>
              ) : reviewsSummary ? (
                <div className="mt-3 text-sm text-slate-700 leading-relaxed">
                  {reviewsSummary}
                </div>
              ) : (
                <div className="mt-3 text-sm text-slate-500">
                  暂时无法生成评价总结。
                </div>
              )}
            </div>
          </div>
        )}

        {/* Info cards */}
        <div className="mt-6 bg-gray-50 border-t border-gray-100">
          <div className="px-5 py-5">
            <div className="bg-white rounded-2xl border border-gray-200 p-4">
              <div className="text-sm font-semibold text-gray-900">地址</div>
              <div className="mt-2 text-sm text-gray-700 leading-relaxed">{place.address}</div>
            </div>

            {/* Opening hours accordion */}
            {place.openingHours && place.openingHours.length > 0 && (
              <div className="mt-4 bg-white rounded-2xl border border-gray-200 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setHoursOpen((v) => !v)}
                  className="w-full flex items-center justify-between px-4 py-4 hover:bg-gray-50 transition-colors"
                >
                  <div className="text-left">
                    <div className="text-sm font-semibold text-gray-900">营业时间</div>
                    <div className="mt-1 text-sm text-gray-700">
                      今日：{todayHours || "暂无"}
                    </div>
                  </div>
                  <svg
                    className={`w-5 h-5 text-gray-500 transition-transform ${hoursOpen ? "rotate-180" : ""}`}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
                  </svg>
                </button>
                {hoursOpen && (
                  <div className="px-4 pb-4 border-t border-gray-100">
                    <ul className="pt-3 space-y-1.5">
                      {place.openingHours.map((hours, index) => (
                        <li key={index} className="text-sm text-gray-700">
                          {hours}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {place.editorialSummary && (
              <div className="mt-4 bg-white rounded-2xl border border-gray-200 p-4">
                <div className="text-sm font-semibold text-gray-900">简介</div>
                <div className="mt-2 text-sm text-gray-700 leading-relaxed">{place.editorialSummary}</div>
              </div>
            )}
          </div>
        </div>

        {/* Reviews */}
        <div className="px-5 py-6 border-t border-gray-100">
          <div className="flex items-baseline justify-between">
            <div className="text-base font-semibold text-gray-900">最新评论</div>
            <div className="text-sm text-gray-500">{place.reviews?.length ? `${place.reviews.length} 条` : ""}</div>
          </div>

          {place.reviews && place.reviews.length > 0 ? (
            <div className="mt-4 space-y-3">
              {place.reviews.map((review, index) => {
                const name = review.authorName || "匿名用户";
                const rating = Math.max(0, Math.min(5, Math.floor(review.rating || 0)));
                const anonymous = isAnonymousName(review.authorName);
                const initial = name.trim().slice(0, 1) || "?";
                return (
                  <div key={index} className="border border-gray-200 rounded-2xl p-4 bg-white">
                    <div className="flex items-start gap-3">
                      {anonymous ? (
                        <div className="h-10 w-10 rounded-full bg-gray-100 border border-gray-200 flex items-center justify-center text-gray-500">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M20 21a8 8 0 10-16 0" />
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 13a4.5 4.5 0 100-9 4.5 4.5 0 000 9z" />
                          </svg>
                        </div>
                      ) : (
                        <div className="h-10 w-10 rounded-full bg-gray-100 border border-gray-200 flex items-center justify-center text-gray-700 font-semibold">
                          {initial}
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-3">
                          <div className="font-medium text-gray-900 truncate">{name}</div>
                          <div className="text-xs text-gray-500 whitespace-nowrap">{review.relativeTimeDescription}</div>
                        </div>
                        <div className="mt-1 text-yellow-400">
                          {"★".repeat(rating)}
                          <span className="text-gray-200">{"★".repeat(5 - rating)}</span>
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 text-sm text-gray-700 leading-relaxed">
                      {review.text || "暂无评论内容"}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="mt-4 text-sm text-gray-500">暂无评论</div>
          )}
        </div>
      </div>
    </div>
  );
}
