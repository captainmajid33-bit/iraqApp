/**
 * ActiveOrderTracker.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Firestore-based real-time driver tracking for the CUSTOMER view.
 *
 * Flow:
 *  1. Watches Firebase Auth → gets current user UID
 *  2. Subscribes to Firestore `orders` where
 *       customer_id == uid  AND  status ∈ ['accepted','in_progress','driving']
 *  3. For the active order, shows a driver marker on the Leaflet map
 *     and draws an OSRM real-road route  driver → customer
 *  4. Cleans up automatically when status → completed / cancelled / done
 *
 * Invisible component — all output is on the Leaflet map.
 */
import { useEffect, useRef, useCallback } from 'react';
import L from 'leaflet';
import { onAuthStateChanged } from 'firebase/auth';
import { collection, query, where, onSnapshot, doc } from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';

// ── Types ─────────────────────────────────────────────────────────────────────
interface Props {
  mapRef:       React.MutableRefObject<L.Map | null>;
  userLocation: { lat: number; lng: number } | null;
}

type OrderType = 'taxi' | 'gas';

// ── Constants ─────────────────────────────────────────────────────────────────
const ACTIVE_STATUSES  = ['accepted', 'in_progress', 'driving'];
const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'done', 'finished', 'rejected']);

// ── Icons ─────────────────────────────────────────────────────────────────────
function makeTrackedDriverIcon(type: OrderType): L.DivIcon {
  const emoji = type === 'gas' ? '🛵' : '🚕';
  const color = type === 'gas' ? '#00dc64' : '#00d4ff';
  const label = type === 'gas' ? 'وكيل الغاز' : 'السائق';
  return L.divIcon({
    className: '',
    html: `
      <div style="position:relative;display:flex;flex-direction:column;align-items:center;gap:2px;">
        <div style="width:48px;height:48px;position:relative;display:flex;align-items:center;justify-content:center;">
          <div style="position:absolute;inset:0;border-radius:50%;background:${color};opacity:0.14;animation:lf-ping 2s cubic-bezier(0,0,0.2,1) infinite;"></div>
          <div style="position:absolute;inset:0;border-radius:50%;background:${color};opacity:0.07;animation:lf-ping 2s cubic-bezier(0,0,0.2,1) infinite;animation-delay:0.5s;"></div>
          <div style="position:absolute;inset:4px;border-radius:50%;border:2px solid ${color};box-shadow:0 0 20px ${color}99;"></div>
          <span style="position:relative;z-index:1;font-size:22px;line-height:1;user-select:none;">${emoji}</span>
        </div>
        <div style="
          background:rgba(0,0,0,0.85);
          border:1px solid ${color};
          color:${color};
          font-family:Rajdhani,sans-serif;
          font-size:10px;font-weight:700;
          padding:2px 7px;
          white-space:nowrap;
          border-radius:3px;
          letter-spacing:0.05em;
          box-shadow:0 0 8px ${color}55;
        ">${label}</div>
      </div>`,
    iconSize:   [48, 74],
    iconAnchor: [24, 74],
  });
}

// ── OSRM route drawing ────────────────────────────────────────────────────────
async function drawOsrmRoute(
  map:     L.Map,
  fromLat: number, fromLng: number,
  toLat:   number, toLng:   number,
  glowRef: React.MutableRefObject<L.Polyline | null>,
  lineRef: React.MutableRefObject<L.Polyline | null>,
) {
  try {
    glowRef.current?.remove(); glowRef.current = null;
    lineRef.current?.remove(); lineRef.current = null;

    const url = `https://router.project-osrm.org/route/v1/driving/`
      + `${fromLng},${fromLat};${toLng},${toLat}`
      + `?overview=full&geometries=geojson`;
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    const coords = data.routes?.[0]?.geometry?.coordinates;
    if (!coords?.length) return;

    const latlngs = coords.map(([lng, lat]: [number, number]) => [lat, lng] as [number, number]);
    glowRef.current = L.polyline(latlngs, { color: '#00d4ff', weight: 9,  opacity: 0.18 }).addTo(map);
    lineRef.current = L.polyline(latlngs, { color: '#00d4ff', weight: 3,  opacity: 0.85, dashArray: '8,6' }).addTo(map);
    glowRef.current.bringToBack();
  } catch { /* silent */ }
}

// ── Component ─────────────────────────────────────────────────────────────────
export function ActiveOrderTracker({ mapRef, userLocation }: Props) {
  const userLocRef      = useRef(userLocation);
  const markerRef       = useRef<L.Marker | null>(null);
  const routeGlowRef    = useRef<L.Polyline | null>(null);
  const routeLineRef    = useRef<L.Polyline | null>(null);
  const routeTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uidRef          = useRef<string | null>(null);
  const orderUnsubRef   = useRef<(() => void) | null>(null);
  const queryUnsubRef   = useRef<(() => void) | null>(null);
  const activeOrderId   = useRef<string | null>(null);

  // Keep userLoc ref current
  useEffect(() => { userLocRef.current = userLocation; }, [userLocation]);

  // ── Cleanup helpers ───────────────────────────────────────────────────────
  const clearVisuals = useCallback(() => {
    markerRef.current?.remove();     markerRef.current   = null;
    routeGlowRef.current?.remove();  routeGlowRef.current = null;
    routeLineRef.current?.remove();  routeLineRef.current = null;
    if (routeTimerRef.current) clearTimeout(routeTimerRef.current);
  }, []);

  const stopOrderWatch = useCallback(() => {
    orderUnsubRef.current?.();
    orderUnsubRef.current = null;
    activeOrderId.current = null;
  }, []);

  const fullCleanup = useCallback(() => {
    clearVisuals();
    stopOrderWatch();
  }, [clearVisuals, stopOrderWatch]);

  // ── Apply driver position update ──────────────────────────────────────────
  const applyDriverPosition = useCallback((
    lat:  number, lng:  number, type: OrderType,
  ) => {
    const map = mapRef.current;
    if (!map) return;

    if (markerRef.current) {
      markerRef.current.setLatLng([lat, lng]);
      const el = markerRef.current.getElement();
      if (el) el.style.transition = 'transform 0.9s linear';
    } else {
      markerRef.current = L.marker([lat, lng], {
        icon: makeTrackedDriverIcon(type),
        zIndexOffset: 9500,
      }).addTo(map);
      const el = markerRef.current.getElement();
      if (el) el.style.transition = 'transform 0.9s linear';
    }

    // Redraw route every time driver moves (debounced 1 s)
    const userLoc = userLocRef.current;
    if (userLoc && routeTimerRef.current === null) {
      routeTimerRef.current = setTimeout(() => {
        routeTimerRef.current = null;
        if (mapRef.current) {
          drawOsrmRoute(mapRef.current, lat, lng, userLoc.lat, userLoc.lng, routeGlowRef, routeLineRef);
        }
      }, 1000);
    }
  }, [mapRef]);

  // ── Subscribe to a single order document for live updates ────────────────
  const watchOrder = useCallback((orderId: string, type: OrderType) => {
    // Avoid double-subscribing same order
    if (activeOrderId.current === orderId) return;
    stopOrderWatch();
    activeOrderId.current = orderId;

    orderUnsubRef.current = onSnapshot(
      doc(db, 'orders', orderId),
      (snap) => {
        const data = snap.data();
        if (!data) return;

        // Terminal state → cleanup
        if (TERMINAL_STATUSES.has(data.status)) {
          fullCleanup();
          return;
        }

        // Update driver marker if coordinates are present
        const lat = data.driver_lat;
        const lng = data.driver_lng;
        if (typeof lat === 'number' && typeof lng === 'number') {
          applyDriverPosition(lat, lng, type);
        }
      },
      (err) => { console.warn('[ActiveOrderTracker] order watch error:', err); },
    );
  }, [applyDriverPosition, fullCleanup, stopOrderWatch]);

  // ── Main Firestore query — listen for accepted orders of this user ─────────
  useEffect(() => {
    let queryUnsub: (() => void) | null = null;

    const authUnsub = onAuthStateChanged(auth, (fbUser) => {
      // Cleanup previous query if user changed
      queryUnsub?.();
      queryUnsubRef.current = null;
      fullCleanup();

      if (!fbUser) { uidRef.current = null; return; }
      uidRef.current = fbUser.uid;

      const q = query(
        collection(db, 'orders'),
        where('customer_id', '==', fbUser.uid),
        where('status',      'in',  ACTIVE_STATUSES),
      );

      queryUnsub = onSnapshot(q, (snap) => {
        if (snap.empty) {
          // No active orders — clear everything
          fullCleanup();
          return;
        }

        // Pick the most recent active order doc
        const docSnap = snap.docs[0];
        const data    = docSnap.data();
        const type: OrderType = data.type === 'gas' ? 'gas' : 'taxi';

        // Start watching this specific order for position updates
        watchOrder(docSnap.id, type);

        // Apply current driver position immediately (if already set)
        const lat = data.driver_lat;
        const lng = data.driver_lng;
        if (typeof lat === 'number' && typeof lng === 'number') {
          applyDriverPosition(lat, lng, type);
        }
      }, (err) => {
        console.warn('[ActiveOrderTracker] query error:', err);
      });

      queryUnsubRef.current = queryUnsub;
    });

    return () => {
      authUnsub();
      queryUnsub?.();
      fullCleanup();
    };
  }, [applyDriverPosition, fullCleanup, watchOrder]);

  return null; // invisible — all rendering is on the Leaflet map
}
