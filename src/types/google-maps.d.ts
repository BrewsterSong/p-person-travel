declare namespace google.maps {
  export class Map {
    constructor(mapDiv: Element, options?: MapOptions);
    setCenter(latlng: LatLngLiteral): void;
    setZoom(zoom: number): void;
    getCenter(): LatLng | null;
    getZoom(): number;
    fitBounds(bounds: LatLngBounds | LatLngBoundsLiteral): void;
    panTo(latlng: LatLngLiteral): void;
  }

  export interface MapOptions {
    center?: LatLngLiteral;
    zoom?: number;
    mapTypeControl?: boolean;
    streetViewControl?: boolean;
    fullscreenControl?: boolean;
    disableDefaultUI?: boolean;
  }

  export interface LatLngLiteral {
    lat: number;
    lng: number;
  }

  export class LatLng {
    constructor(lat: number, lng: number);
    lat(): number;
    lng(): number;
  }

  export interface LatLngBounds {
    getNorthEast(): LatLng;
    getSouthWest(): LatLng;
  }

  export interface LatLngBoundsLiteral {
    north: number;
    south: number;
    east: number;
    west: number;
  }

  export class Marker {
    constructor(options?: MarkerOptions);
    setPosition(position: LatLngLiteral): void;
    setMap(map: Map | null): void;
    setVisible(visible: boolean): void;
    setTitle(title: string): void;
  }

  export interface MarkerOptions {
    position: LatLngLiteral;
    map?: Map;
    title?: string;
    visible?: boolean;
  }

  export class InfoWindow {
    constructor(options?: InfoWindowOptions);
    open(options?: InfoWindowOpenOptions): void;
    close(): void;
    setContent(content: string | Node): void;
  }

  export interface InfoWindowOptions {
    content?: string | Node;
    position?: LatLngLiteral;
  }

  export interface InfoWindowOpenOptions {
    map?: Map;
    anchor?: any;
  }

  export class Polyline {
    constructor(options?: PolylineOptions);
    setMap(map: Map | null): void;
  }

  export interface PolylineOptions {
    path?: LatLngLiteral[];
    strokeColor?: string;
    strokeWeight?: number;
    strokeOpacity?: number;
  }

  export class DirectionsRenderer {
    constructor(options?: DirectionsRendererOptions);
    setDirections(response: DirectionsResult): void;
    setMap(map: Map | null): void;
  }

  export interface DirectionsRendererOptions {
    map?: Map;
    directions?: DirectionsResult;
  }

  export interface DirectionsResult {
    routes: DirectionsRoute[];
  }

  export interface DirectionsRoute {
    overview_polyline: {
      points: string;
    };
    legs: DirectionsLeg[];
  }

  export interface DirectionsLeg {
    distance: {
      text: string;
      value: number;
    };
    duration: {
      text: string;
      value: number;
    };
    start_location: LatLngLiteral;
    end_location: LatLngLiteral;
  }

  export class DirectionsService {
    route(request: DirectionsRequest, callback: (result: DirectionsResult, status: DirectionsStatus) => void): void;
  }

  export interface DirectionsRequest {
    origin: LatLngLiteral | string;
    destination: LatLngLiteral | string;
    travelMode: TravelMode;
  }

  export type TravelMode = "DRIVING" | "WALKING" | "BICYCLING" | "TRANSIT";

  export type DirectionsStatus = "OK" | "NOT_FOUND" | "ZERO_RESULTS" | "MAX_WAYPOINTS_EXCEEDED" | "INVALID_REQUEST" | "OVER_QUERY_LIMIT" | "REQUEST_DENIED" | "UNKNOWN_ERROR";
}
