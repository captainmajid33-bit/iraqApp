/**
 * TrafficLayer — crowdsourced live traffic system
 *
 * • Writes own GPS probe (lat/lng/speed/heading) to Firestore `traffic_probes/{uid}` every 15 s
 * • Listens to ALL `traffic_probes` docs in real-time
 * • Filters probes within 5 km of current user + fresher than 5 min
 * • Groups probes into ~111 m grid cells → averages speed
 * • Snaps each cell center to nearest road via OSRM
 * • Draws glow + dashed polylines colored by speed:
 *     < 15 km/h  → #ff2d78  (ازدحام شديد)
 *     15–45 km/h → #f5c518  (معتدل)
 *     > 45 km/h  → #00d4ff  (سيّال)
 */
import { useEffect, useRef, useCallback } from 'react';
import L from 'leaflet';
import { auth, db } from '../lib/firebase';
import {
  collection, onSnapshot, doc, setDoc, serverTimestamp,
} from 'firebase/firestore';

// ── Types ─────────────────────────────────────────────────────────────────────
interface TrafficProbe {
  uid:        string;
  lat:        number;
  lng:        number;
  speed:      number | null; // m/s from Geolocation API, null if unavailable
  heading:    number | null;
  updated_at: { toMillis(): number } | null;
}

interface Props {
  mapRef:       React.MutableRefObject<L.Map | null>;
  userLocation: { lat: number; lng: number } | null;
  enabled:      boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const PROBE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const RADIUS_KM    = 5;
const GRID_DEG     = 0.001;          // ~111 m per cell
const HALF_GRID    = GRID_DEG / 2;
const WRITE_MS     = 15_000;         // write to Firestore every 15 s
const DRAW_DEBOUNCE_MS = 800;

// ── Helpers ───────────────────────────────────────────────────────────────────
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R   = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a   = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function speedColor(speedMs: number | null): string {
  if (speedMs === null || speedMs < 0) return '#ff2d78';
  const kmh = speedMs * 3.6;
  if (kmh < 15) return '#ff2d78';  // heavy  — pink/red
  if (kmh < 45) return '#f5c518';  // moderate — yellow
  return '#00d4ff';                // free     — cyan
}

// Module-level OSRM snap cache: rounded key → [sLat, sLng]
const snapCache = new Map<string, [number, number]>();

async function snapToRoad(lat: number, lng: number): Promise<[number, number]> {
  // Cache key at 4 decimal places (~11 m resolution) — same cell → same snap
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  if (snapCache.has(key)) return snapCache.get(key)!;
  try {
    const res = await fetch(
      `https://router.project-osrm.org/nearest/v1/driving/${lng},${lat}?number=1`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (!res.ok) throw new Error('OSRM error');
    const data = await res.json();
    const [sLng, sLat] = data.waypoints[0].location as [number, number];
    snapCache.set(key, [sLat, sLng]);
    return [sLat, sLng];
  } catch {
    return [lat, lng]; // fallback — original position
  }
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function TrafficLayer({ mapRef, userLocation, enabled }: Props) {
  const watchRef       = useRef<number | null>(null);
  const writeTimerRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const unsubRef       = useRef<(() => void) | null>(null);
  const layersRef      = useRef<L.Polyline[]>([]);
  const renderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const probesRef      = useRef<TrafficProbe[]>([]);
  const lastPosRef     = useRef<GeolocationPosition | null>(null);
  const userLocRef     = useRef(userLocation);

  // Keep userLocRef in sync (avoid stale closures without re-registering effects)
  useEffect(() => { userLocRef.current = userLocation; }, [userLocation]);

  // ── Clear all polylines from map ─────────────────────────────────────────
  const clearLayers = useCallback(() => {
    layersRef.current.forEach(l => l.remove());
    layersRef.current = [];
  }, []);

  // ── Draw traffic polylines from probesRef ─────────────────────────────────
  const drawTraffic = useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;
    clearLayers();

    const probes = probesRef.current;
    if (!probes.length) return;

    const ref = userLocRef.current ?? { lat: probes[0].lat, lng: probes[0].lng };
    const now = Date.now();

    // 1. Filter: within radius + fresh
    const valid = probes.filter(p => {
      if (!p.updated_at) return false;
      if (now - p.updated_at.toMillis() > PROBE_TTL_MS) return false;
      return haversineKm(ref.lat, ref.lng, p.lat, p.lng) <= RADIUS_KM;
    });
    if (!valid.length) return;

    // 2. Group into grid cells
    type CellData = { speedSum: number; count: number; latSum: number; lngSum: number };
    const cells = new Map<string, CellData>();
    valid.forEach(p => {
      const cellLat = Math.floor(p.lat / GRID_DEG);
      const cellLng = Math.floor(p.lng / GRID_DEG);
      const key     = `${cellLat}:${cellLng}`;
      const speed   = p.speed ?? 0; // treat unknown speed as 0 (stopped = heavy)
      const existing = cells.get(key);
      if (existing) {
        existing.speedSum += speed;
        existing.count    += 1;
        existing.latSum   += p.lat;
        existing.lngSum   += p.lng;
      } else {
        cells.set(key, { speedSum: speed, count: 1, latSum: p.lat, lngSum: p.lng });
      }
    });

    // 3. Snap each cell center to road + draw polyline
    const drawPromises = Array.from(cells.values()).map(async data => {
      const avgLat   = data.latSum  / data.count;
      const avgLng   = data.lngSum  / data.count;
      const avgSpeed = data.speedSum / data.count;
      const color    = speedColor(avgSpeed);

      const [sLat, sLng] = await snapToRoad(avgLat, avgLng);

      if (!mapRef.current) return; // map unmounted during async

      // Short E-W polyline centered on snapped road point (~111 m)
      const coords: L.LatLngTuple[] = [
        [sLat, sLng - HALF_GRID * 0.85],
        [sLat, sLng + HALF_GRID * 0.85],
      ];

      // Glow layer
      const glow = L.polyline(coords, {
        color, weight: 16, opacity: 0.07,
        lineCap: 'round', lineJoin: 'round',
      }).addTo(mapRef.current);

      // Main layer (dashed, animated via CSS)
      const main = L.polyline(coords, {
        color, weight: 5, opacity: 0.85,
        lineCap: 'round', lineJoin: 'round',
        dashArray: '12 5',
        className: 'traffic-live-line',
      }).addTo(mapRef.current);

      layersRef.current.push(glow, main);
    });

    await Promise.allSettled(drawPromises);
  }, [mapRef, clearLayers]);

  // Debounced redraw trigger
  const scheduleDraw = useCallback(() => {
    if (renderTimerRef.current) clearTimeout(renderTimerRef.current);
    renderTimerRef.current = setTimeout(() => drawTraffic(), DRAW_DEBOUNCE_MS);
  }, [drawTraffic]);

  // ── Write own probe ───────────────────────────────────────────────────────
  const writeProbe = useCallback(() => {
    const uid = auth.currentUser?.uid;
    if (!uid || !lastPosRef.current) return;
    const { latitude, longitude, speed, heading } = lastPosRef.current.coords;
    setDoc(doc(db, 'traffic_probes', uid), {
      uid,
      lat:        latitude,
      lng:        longitude,
      speed:      speed   ?? null,
      heading:    heading ?? null,
      updated_at: serverTimestamp(),
    }).catch(() => { /* non-fatal */ });
  }, []);

  // ── Full cleanup helper ───────────────────────────────────────────────────
  const cleanup = useCallback(() => {
    clearLayers();
    if (watchRef.current !== null) {
      navigator.geolocation?.clearWatch(watchRef.current);
      watchRef.current = null;
    }
    if (writeTimerRef.current) { clearInterval(writeTimerRef.current); writeTimerRef.current = null; }
    if (unsubRef.current) { unsubRef.current(); unsubRef.current = null; }
    if (renderTimerRef.current) { clearTimeout(renderTimerRef.current); renderTimerRef.current = null; }
    probesRef.current = [];
  }, [clearLayers]);

  // ── Main effect — enable / disable ───────────────────────────────────────
  useEffect(() => {
    if (!enabled) { cleanup(); return; }

    // Start writing own GPS probe
    watchRef.current = navigator.geolocation?.watchPosition(
      pos => { lastPosRef.current = pos; writeProbe(); },
      ()  => { /* silent — GPS may be unavailable */ },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 },
    ) ?? null;

    // Periodic write (in case watchPosition fires rarely on desktop)
    writeTimerRef.current = setInterval(writeProbe, WRITE_MS);

    // Listen to all traffic_probes in Firestore
    const colRef = collection(db, 'traffic_probes');
    unsubRef.current = onSnapshot(colRef, snap => {
      probesRef.current = snap.docs
        .filter(d => typeof d.data().lat === 'number')
        .map(d => d.data() as TrafficProbe);
      scheduleDraw();
    }, () => { /* silent */ });

    return cleanup;
  }, [enabled, cleanup, writeProbe, scheduleDraw]);

  // Redraw when user moves to a new area (new probes may enter radius)
  useEffect(() => {
    if (enabled && probesRef.current.length) scheduleDraw();
  }, [enabled, userLocation, scheduleDraw]);

  return null; // purely map-side effects
}
