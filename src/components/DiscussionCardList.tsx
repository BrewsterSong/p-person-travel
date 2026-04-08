"use client";

import { useState } from "react";
import type { DiscussionCard } from "@/types/chat";

interface DiscussionCardListProps {
  discussions: DiscussionCard[];
}

export default function DiscussionCardList({ discussions }: DiscussionCardListProps) {
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>({});
  const [detailMap, setDetailMap] = useState<Record<string, DiscussionCard>>({});
  const [loadingMap, setLoadingMap] = useState<Record<string, boolean>>({});
  const [errorMap, setErrorMap] = useState<Record<string, string>>({});
  const [commentsLoadingMap, setCommentsLoadingMap] = useState<Record<string, boolean>>({});

  if (!discussions || discussions.length === 0) return null;

  const handleToggleDetail = async (discussion: DiscussionCard) => {
    const isExpanded = !!expandedIds[discussion.id];
    setExpandedIds((prev) => ({ ...prev, [discussion.id]: !isExpanded }));
    if (isExpanded) return;
    if (detailMap[discussion.id] || loadingMap[discussion.id]) return;

    setLoadingMap((prev) => ({ ...prev, [discussion.id]: true }));
    setErrorMap((prev) => ({ ...prev, [discussion.id]: "" }));

    try {
      const params = new URLSearchParams({
        url: discussion.url,
        title: discussion.title,
        snippet: discussion.snippet,
        subreddit: discussion.subreddit,
        ageText: discussion.ageText,
        displaySource: discussion.displaySource,
      });
      if (discussion.thumbnail) params.set("thumbnail", discussion.thumbnail);
      if (discussion.commentCount !== null) params.set("commentCount", String(discussion.commentCount));
      if (discussion.query) params.set("query", discussion.query);
      const response = await fetch(`/api/reddit/detail?${params.toString()}`);
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to load discussion detail");
      }
      if (data?.discussion) {
        setDetailMap((prev) => ({ ...prev, [discussion.id]: data.discussion as DiscussionCard }));
        if (!data.discussion.topComments || data.discussion.topComments.length === 0) {
          setCommentsLoadingMap((prev) => ({ ...prev, [discussion.id]: true }));
          try {
            const commentsParams = new URLSearchParams({
              url: discussion.url,
              limit: "3",
            });
            const commentsResponse = await fetch(`/api/reddit/comments?${commentsParams.toString()}`);
            const commentsData = await commentsResponse.json();
            if (commentsResponse.ok && Array.isArray(commentsData.comments) && commentsData.comments.length > 0) {
              setDetailMap((prev) => ({
                ...prev,
                [discussion.id]: {
                  ...(prev[discussion.id] || (data.discussion as DiscussionCard)),
                  topComments: commentsData.comments,
                },
              }));
            }
          } finally {
            setCommentsLoadingMap((prev) => ({ ...prev, [discussion.id]: false }));
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load discussion detail";
      setErrorMap((prev) => ({ ...prev, [discussion.id]: message }));
    } finally {
      setLoadingMap((prev) => ({ ...prev, [discussion.id]: false }));
    }
  };

  return (
    <div className="mt-3 -mx-3 -mb-3">
      <div className="flex flex-col gap-3 rounded-b-lg bg-gray-50 p-3">
        {discussions.map((discussion) => {
          const detail = detailMap[discussion.id];
          const current = detail || discussion;
          const expanded = !!expandedIds[discussion.id];

          return (
            <article
              key={discussion.id}
              className="overflow-hidden rounded-xl border border-gray-200 bg-white"
            >
              <div className="flex gap-3 p-3">
              {discussion.thumbnail ? (
                <div className="h-24 w-24 shrink-0 overflow-hidden rounded-lg bg-gray-100">
                  <img
                    src={discussion.thumbnail}
                    alt={discussion.title}
                    className="h-full w-full object-cover"
                  />
                </div>
              ) : (
                <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-center text-[11px] font-medium text-gray-500">
                  Reddit
                  <br />
                  Discussion
                </div>
              )}

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
                  <span className="rounded-full bg-orange-50 px-2 py-0.5 font-semibold text-orange-700">
                    {current.subreddit ? `r/${current.subreddit}` : "Reddit"}
                  </span>
                  {current.commentCount !== null && (
                    <span>{current.commentCount}+ comments</span>
                  )}
                  {current.ageText && <span>{current.ageText}</span>}
                  {current.displaySource && <span>{current.displaySource}</span>}
                </div>

                <h3 className="mt-2 line-clamp-2 text-sm font-semibold text-gray-900">
                  {current.title}
                </h3>
                <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-gray-600">
                  {current.snippet || current.summary || "Reddit travel discussion"}
                </p>
                {current.destinationHints && current.destinationHints.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {current.destinationHints.slice(0, 4).map((place) => (
                      <span
                        key={`${discussion.id}-${place}`}
                        className="rounded-full bg-gray-100 px-2 py-1 text-[11px] font-medium text-gray-600"
                      >
                        {place}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {expanded && (
              <div className="border-t border-gray-100 px-3 py-3">
                {loadingMap[discussion.id] && (
                  <p className="text-xs text-gray-500">正在加载讨论详情...</p>
                )}

                {errorMap[discussion.id] && (
                  <p className="text-xs text-red-500">{errorMap[discussion.id]}</p>
                )}

                {!loadingMap[discussion.id] && !errorMap[discussion.id] && detail && (
                  <div className="space-y-3">
                    {detail.summary && (
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                          Summary
                        </p>
                        <p className="mt-1 text-xs leading-relaxed text-gray-700">{detail.summary}</p>
                      </div>
                    )}

                    {detail.highlights && detail.highlights.length > 0 && (
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                          Highlights
                        </p>
                        <div className="mt-2 flex flex-col gap-1.5">
                          {detail.highlights.slice(0, 4).map((highlight, index) => (
                            <p key={`${discussion.id}-highlight-${index}`} className="text-xs leading-relaxed text-gray-700">
                              {highlight}
                            </p>
                          ))}
                        </div>
                      </div>
                    )}

                    {detail.body && (
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                          Post Body
                        </p>
                        <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-gray-700">
                          {detail.body}
                        </p>
                      </div>
                    )}

                    {detail.topComments && detail.topComments.length > 0 && (
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                          Top Comments
                        </p>
                        <div className="mt-2 flex flex-col gap-2">
                          {detail.topComments.slice(0, 3).map((comment) => (
                            <div key={comment.id} className="rounded-lg bg-gray-50 px-3 py-2">
                              <div className="flex items-center gap-2 text-[11px] text-gray-500">
                                <span className="font-medium text-gray-700">@{comment.author}</span>
                                <span>{comment.score} points</span>
                              </div>
                              <p className="mt-1 text-xs leading-relaxed text-gray-600">{comment.body}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {commentsLoadingMap[discussion.id] && (
                      <p className="text-xs text-gray-500">正在尝试加载热门评论...</p>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="border-t border-gray-100 px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => void handleToggleDetail(discussion)}
                  className="text-xs font-medium text-gray-700 hover:text-gray-900"
                >
                  {expanded ? "收起详情" : "查看详情"}
                </button>
                <a
                  href={discussion.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-medium text-blue-600 hover:text-blue-700"
                >
                  在 Reddit 查看原帖
                </a>
              </div>
            </div>
          </article>
          );
        })}
      </div>
    </div>
  );
}
