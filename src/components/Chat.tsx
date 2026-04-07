"use client";

import { useState, useRef, useEffect, useMemo, useLayoutEffect } from "react";
import { useAuthContext } from "@/context/AuthContext";
import { useChatContext } from "@/context/ChatContext";
import { usePlaceContext } from "@/context/PlaceContext";
import { useLocationContext } from "@/context/LocationContext";
import PlaceList from "./PlaceList";
import PlaceDetail from "./PlaceDetail";
import { Place } from "@/types/chat";
import { distanceLabel } from "@/lib/distance";

interface ChatProps {
  onPlaceSelected?: (place: Place | null) => void;
  onPlaceHover?: (place: Place | null) => void;
  onMapPlacesChange?: (places: Place[]) => void;
}

export default function Chat({ onPlaceSelected, onPlaceHover, onMapPlacesChange }: ChatProps) {
  const { messages, isLoading, error, recommendedPlaces, allPlaces, sendMessage, nextPageToken, loadMorePlaces, loadMoreRecommendations } = useChatContext();
  const { isConfigured, isLoading: isAuthLoading, user, signInWithGoogle, signOut } = useAuthContext();
  const { selectedPlace, selectPlace, setSelectedPlace } = usePlaceContext();
  const { location } = useLocationContext();
  const [input, setInput] = useState("");
  const [hoveredPlace, setHoveredPlace] = useState<Place | null>(null);
  const [expandedReasons, setExpandedReasons] = useState<Record<string, boolean>>({});
  const [authError, setAuthError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const ReasonText = ({
    text,
    expanded,
    onToggle,
  }: {
    text: string;
    expanded: boolean;
    onToggle: () => void;
  }) => {
    const pRef = useRef<HTMLParagraphElement | null>(null);
    const [canExpand, setCanExpand] = useState(false);

    useLayoutEffect(() => {
      const el = pRef.current;
      if (!el) return;
      if (expanded) {
        setCanExpand(true);
        return;
      }
      // Wait for layout; then check overflow under line-clamp.
      const raf = requestAnimationFrame(() => {
        setCanExpand(el.scrollHeight > el.clientHeight + 1);
      });
      return () => cancelAnimationFrame(raf);
    }, [text, expanded]);

    return (
      <div className="mt-1">
        <p
          ref={pRef}
          className={`text-xs text-gray-500 leading-relaxed ${expanded ? "" : "line-clamp-2"}`}
          title={text}
        >
          {text}
        </p>
        <div className="mt-1 h-6">
          {canExpand && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
              className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold text-gray-600 hover:text-gray-900 hover:bg-gray-100 transition-colors"
            >
              <span>{expanded ? "收起" : "展开"}</span>
              <svg
                viewBox="0 0 20 20"
                fill="currentColor"
                className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`}
                aria-hidden="true"
              >
                <path
                  fillRule="evenodd"
                  d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 10.94l3.71-3.71a.75.75 0 1 1 1.06 1.06l-4.24 4.24a.75.75 0 0 1-1.06 0L5.21 8.29a.75.75 0 0 1 .02-1.08z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          )}
        </div>
      </div>
    );
  };

  // 构建地点映射，用于根据 recommendation ID 获取完整数据
  // 使用 allPlaces 确保历史消息的卡片也能正确渲染
  const placesMap = useMemo(() => {
    const map = new Map<string, Place>();
    allPlaces.forEach(place => map.set(place.id, place));
    return map;
  }, [allPlaces]);

  const resolvePlacesForRecommendations = useMemo(() => {
    return (recommendations: { id: string }[] | undefined): Place[] => {
      if (!recommendations || recommendations.length === 0) return [];
      const resolved: Place[] = [];
      for (const rec of recommendations) {
        let place = placesMap.get(rec.id);
        if (!place) {
          const recIdLower = rec.id.toLowerCase();
          for (const p of allPlaces) {
            const pName = p.name || "";
            const pNameLower = pName.toLowerCase();
            if (
              pNameLower.includes(recIdLower) ||
              recIdLower.includes(pNameLower) ||
              pName === rec.id ||
              rec.id === pName
            ) {
              place = p;
              break;
            }
          }
        }
        if (place) resolved.push(place);
      }
      return resolved;
    };
  }, [allPlaces, placesMap]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, recommendedPlaces, selectedPlace]);

  // Notify parent when selectedPlace changes
  useEffect(() => {
    if (onPlaceSelected) {
      onPlaceSelected(selectedPlace);
    }
  }, [selectedPlace, onPlaceSelected]);

  // Notify parent when hoveredPlace changes
  useEffect(() => {
    if (onPlaceHover) {
      onPlaceHover(hoveredPlace);
    }
  }, [hoveredPlace, onPlaceHover]);

  useEffect(() => {
    onMapPlacesChange?.(recommendedPlaces);
  }, [onMapPlacesChange, recommendedPlaces]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userInput = input.trim();
    setInput("");

    await sendMessage(userInput);
  };

  const handlePlaceClick = async (place: Place) => {
    console.log("[Chat] handlePlaceClick called:", place.name);
    await selectPlace(place);
    console.log("[Chat] After selectPlace, selectedPlace:", selectedPlace?.name);
  };

  const handleCloseDetail = () => {
    setSelectedPlace(null);
  };

  const displayName =
    user?.user_metadata?.full_name ||
    user?.user_metadata?.name ||
    user?.email ||
    "Traveler";
  const avatarUrl =
    user?.user_metadata?.avatar_url ||
    user?.user_metadata?.picture ||
    null;

  const handleGoogleSignIn = async () => {
    setAuthError(null);
    try {
      await signInWithGoogle();
    } catch (signInError) {
      console.error("[auth] Google sign-in failed:", signInError);
      setAuthError("Google 登录失败，请稍后再试。");
    }
  };

  const handleSignOut = async () => {
    setAuthError(null);
    try {
      await signOut();
    } catch (signOutError) {
      console.error("[auth] Sign-out failed:", signOutError);
      setAuthError("退出登录失败，请稍后再试。");
    }
  };

  // Show detail drawer when a place is selected
  if (selectedPlace) {
    return (
      <div className="min-h-0 flex-1 bg-white flex flex-col md:h-full">
        <PlaceDetail place={selectedPlace} onClose={handleCloseDetail} />
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 bg-white flex flex-col md:h-full">
      {/* Header */}
      <div className="shrink-0 border-b border-gray-200 px-3 py-2 md:px-4 md:py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold md:text-xl">P-Person Travel Assistant</h1>
            <p className="text-xs text-gray-500">随时随地找到下一站去哪里</p>
          </div>

          {isConfigured ? (
            user ? (
              <div className="flex items-center gap-2">
                <div className="hidden text-right md:block">
                  <p className="text-sm font-medium text-gray-900">{String(displayName)}</p>
                  <p className="text-xs text-gray-500">已连接 Google</p>
                </div>
                <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-gray-100 text-sm font-semibold text-gray-700">
                  {avatarUrl ? (
                    <div
                      aria-label={String(displayName)}
                      className="h-full w-full bg-cover bg-center"
                      role="img"
                      style={{ backgroundImage: `url(${String(avatarUrl)})` }}
                    />
                  ) : (
                    String(displayName).slice(0, 1).toUpperCase()
                  )}
                </div>
                <button
                  type="button"
                  onClick={handleSignOut}
                  className="rounded-full border border-gray-200 px-3 py-2 text-xs font-medium text-gray-700 transition hover:bg-gray-50"
                >
                  退出
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleGoogleSignIn}
                disabled={isAuthLoading}
                className="rounded-full bg-gray-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isAuthLoading ? "加载中..." : "Continue with Google"}
              </button>
            )
          ) : (
            <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-700">
              待配置 Supabase
            </span>
          )}
        </div>
        {authError && (
          <p className="mt-2 text-xs text-red-500">{authError}</p>
        )}
      </div>

      {/* Chat Area */}
      <div
        className="flex-1 overflow-y-auto overscroll-y-contain p-3 md:p-4"
        style={{ scrollbarGutter: "stable", WebkitOverflowScrolling: "touch" }}
      >
        {messages.map((message) => (
          (() => {
            const hasRecs = message.role === "assistant" && message.recommendations && message.recommendations.length > 0;
            const suggestionPool = ["更近一点", "预算更低", "更安静", "想坐露台", "换一批"];
            const hash = (s: string) => {
              let h = 0;
              for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
              return h;
            };
            const pickSuggestions = (seed: string): string[] => {
              const h = Math.abs(hash(seed || "seed"));
              const count = 2 + (h % 2); // 2-3
              const start = h % suggestionPool.length;
              const out: string[] = [];
              for (let i = 0; i < suggestionPool.length && out.length < count; i++) {
                const v = suggestionPool[(start + i) % suggestionPool.length];
                if (!out.includes(v)) out.push(v);
              }
              return out;
            };
            const suggestions = hasRecs ? pickSuggestions(message.id) : [];
            const batchPlaces = hasRecs ? resolvePlacesForRecommendations(message.recommendations) : [];
            return (
          <div
            key={message.id}
            className={`flex ${message.role === "user" ? "justify-end" : "justify-start"} mb-4`}
          >
            <div
              className={`${hasRecs ? "w-full max-w-full" : "max-w-[92%] md:max-w-[80%]"} rounded-lg p-3 ${
                message.role === "user"
                  ? "bg-blue-500 text-white"
                  : "bg-gray-100 text-gray-800"
              }`}
            >
              <p className="whitespace-pre-wrap">{message.content}</p>

              {/* 嵌入消息内的推荐卡片 - 纵向列表布局 */}
              {message.role === "assistant" && message.recommendations && message.recommendations.length > 0 && (
                <div className="mt-3 -mx-3 -mb-3">
                  <div
                    className="flex flex-col gap-3 p-3 bg-gray-50 rounded-b-lg"
                    onMouseEnter={() => {
                      onMapPlacesChange?.(batchPlaces);
                    }}
                    onMouseLeave={() => {
                      setHoveredPlace(null);
                      onPlaceHover?.(null);
                      onMapPlacesChange?.(recommendedPlaces);
                    }}
                  >
                    {message.recommendations.map((rec) => {
                      // 容错匹配：先尝试 ID，再尝试模糊名称
                      let place = placesMap.get(rec.id);
                      if (!place) {
                        // 模糊匹配：大小写不敏感 + 双向包含
                        const recIdLower = rec.id.toLowerCase();
                        for (const p of allPlaces) {
                          const pName = p.name || "";
                          const pNameLower = pName.toLowerCase();
                          if (
                            pNameLower.includes(recIdLower) ||
                            recIdLower.includes(pNameLower) ||
                            pName === rec.id ||
                            rec.id === pName
                          ) {
                            place = p;
                            break;
                          }
                        }
                      }
                      if (!place) return null;
                      const dist = distanceLabel(location, place.location);
                      const expandKey = `${message.id}:${rec.id}`;
                      const expanded = !!expandedReasons[expandKey];

                      return (
                        <div
                          key={rec.id}
                          onClick={() => handlePlaceClick(place)}
                          onMouseEnter={() => {
                            setHoveredPlace(place);
                            onPlaceHover?.(place);
                          }}
                          className="w-full flex gap-2 p-2 bg-white rounded-lg cursor-pointer hover:bg-gray-50 transition-colors md:gap-3"
                        >
                          {/* 左侧图片 */}
                          <div className="h-20 w-20 flex-shrink-0 bg-gray-200 rounded-lg overflow-hidden md:h-24 md:w-24">
                            {place.photos && place.photos.length > 0 ? (
                              <img
                                src={place.photos[0]}
                                alt={place.name}
                                className="w-full h-full object-cover"
                                onError={(e) => {
                                  (e.target as HTMLImageElement).src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='96' height='96'%3E%3Crect fill='%23E5E7EB' width='96' height='96'/%3E%3Ctext fill='%239CA3AF' x='50%25' y='50%25' text-anchor='middle' dy='.3em' font-size='12'%3E无图%3C/text%3E%3C/svg%3E";
                                }}
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-gray-400 text-xs">
                                无图
                              </div>
                            )}
                          </div>

                          {/* 右侧内容 */}
                            <div className="flex-1 min-w-0">
                              <div className="flex min-w-0 items-center gap-2">
                                <p className="min-w-0 flex-1 truncate text-sm font-medium text-gray-900">{place.name}</p>
                                {place.openNow === true && (
                                  <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                    营业中
                                  </span>
                                )}
                                {place.openNow === false && (
                                  <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-700">
                                    <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
                                    已打烊
                                  </span>
                                )}
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-1">
                                <span className="text-yellow-500 text-xs leading-none">
                                  {"★".repeat(Math.floor(place.rating))}
                                </span>
                                <span className="text-xs text-gray-400 leading-none">
                                  {place.rating.toFixed(1)} ({place.userRatingsTotal})
                                </span>
                                {place.priceLevel && (
                                  <span className="ml-1 text-xs text-green-600 leading-none">
                                    {"$".repeat(place.priceLevel)}
                                  </span>
                                )}
                                {dist && (
                                  <span className="inline-flex items-center gap-1 text-xs text-gray-500 font-medium md:ml-auto">
                                    <span aria-hidden>📍</span>
                                    <span>{dist}</span>
                                  </span>
                                )}
                              </div>
                              {rec.reason ? (
                                <ReasonText
                                  text={rec.reason}
                                  expanded={expanded}
                                  onToggle={() =>
                                    setExpandedReasons((prev) => ({
                                      ...prev,
                                      [expandKey]: !prev[expandKey],
                                    }))
                                  }
                                />
                              ) : (
                                <div className="mt-2 space-y-1.5 animate-pulse">
                                  <div className="h-3 bg-gray-200 rounded w-11/12" />
                                  <div className="h-3 bg-gray-200 rounded w-8/12" />
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}

                    {/* 换一批按钮 - 从已有地点中选择不同的推荐 */}
                    {allPlaces.length > 0 && allPlaces.length > recommendedPlaces.length && (
                      <button
                        onClick={() => {
                          // 获取已推荐的地点 ID
                          const excludeIds = recommendedPlaces.map(p => p.id);
                          loadMoreRecommendations(allPlaces, excludeIds);
                        }}
                        disabled={isLoading}
                        className="mt-2 w-full rounded-lg border border-gray-300 bg-white py-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isLoading ? "加载中..." : "换一批"}
                      </button>
                    )}

                    {/* Follow-up guidance */}
                    {suggestions.length > 0 && (
                      <p className="mt-2 text-xs text-gray-500 leading-relaxed">
                        想继续缩小范围的话，可以直接追加一句条件，比如：{suggestions.join(" / ")}。
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
            );
          })()
        ))}

        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-gray-100 rounded-lg p-3">
              <div className="flex gap-1">
                <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="flex justify-center">
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-600">
              {error}
            </div>
          </div>
        )}

        {/* Recommended Places - 只在消息内没有推荐卡片时显示 */}
        {!messages.some(m => m.role === "assistant" && m.recommendations && m.recommendations.length > 0) && (
          <PlaceList
            places={recommendedPlaces}
            onPlaceClick={handlePlaceClick}
            onPlaceHover={setHoveredPlace}
          />
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <form onSubmit={handleSubmit} className="shrink-0 border-t border-gray-200 flex items-center gap-2 px-3 py-3 md:h-16 md:px-4 md:py-0">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="输入你的位置或需求..."
          className="h-10 flex-1 min-w-0 rounded-full border border-gray-300 px-4 text-sm focus:outline-none focus:border-blue-500 md:text-base"
          disabled={isLoading}
        />
        <button
          type="submit"
          disabled={!input.trim() || isLoading}
          className="h-10 shrink-0 rounded-full bg-blue-500 px-4 text-sm text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-gray-300 md:text-base"
        >
          发送
        </button>
      </form>
    </div>
  );
}
