"use client";

import { Place } from "@/types/chat";
import { useLocationContext } from "@/context/LocationContext";
import { distanceLabel } from "@/lib/distance";

interface PlaceListProps {
  places: Place[];
  onPlaceClick?: (place: Place) => void;
  onPlaceHover?: (place: Place | null) => void;
}

export default function PlaceList({ places, onPlaceClick, onPlaceHover }: PlaceListProps) {
  const { location } = useLocationContext();

  if (!places || places.length === 0) {
    return null;
  }

  const getPriceLevel = (level?: number) => {
    if (!level) return "";
    return "$".repeat(level);
  };

  return (
    <div className="space-y-3 mt-4">
      <h3 className="font-semibold text-gray-800">推荐餐厅</h3>
      {places.map((place) => {
        const dist = distanceLabel(location, place.location);
        return (
        <div
          key={place.id}
          onClick={() => onPlaceClick?.(place)}
          onMouseEnter={() => onPlaceHover?.(place)}
          onMouseLeave={() => onPlaceHover?.(null)}
          className="flex gap-3 p-3 bg-white border border-gray-200 rounded-lg cursor-pointer hover:border-blue-400 hover:shadow-md transition-all"
        >
          {/* Photo */}
          <div className="w-20 h-20 flex-shrink-0 bg-gray-200 rounded-lg overflow-hidden">
            {place.photos && place.photos.length > 0 ? (
              <img
                src={place.photos[0]}
                alt={place.name}
                className="w-full h-full object-cover"
                onError={(e) => {
                  (e.target as HTMLImageElement).src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Crect fill='%23E5E7EB' width='80' height='80'/%3E%3Ctext fill='%239CA3AF' x='50%25' y='50%25' text-anchor='middle' dy='.3em'%3E无图%3C/text%3E%3C/svg%3E";
                }}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-gray-400 text-xs">
                无图
              </div>
            )}
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <h4 className="font-medium text-gray-900 truncate">{place.name}</h4>
            <p className="text-sm text-gray-500 truncate">{place.address}</p>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-yellow-500">
                {"★".repeat(Math.floor(place.rating))}
                <span className="text-gray-300">
                  {"★".repeat(5 - Math.floor(place.rating))}
                </span>
              </span>
              <span className="text-sm text-gray-500">
                {place.rating.toFixed(1)} ({place.userRatingsTotal})
              </span>
              {place.priceLevel && (
                <span className="text-sm text-green-600">
                  {getPriceLevel(place.priceLevel)}
                </span>
              )}
              {place.openNow === true && (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  营业中
                </span>
              )}
              {place.openNow === false && (
                <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-700">
                  <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
                  已打烊
                </span>
              )}
              {dist && (
                <span className="ml-auto inline-flex items-center gap-1 text-xs text-gray-500 font-medium">
                  <span aria-hidden>📍</span>
                  <span>{dist}</span>
                </span>
              )}
            </div>
          </div>
        </div>
      )})}
    </div>
  );
}
