/**
 * ActiveOrderTracker.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Firestore-based real-time driver tracking — CUSTOMER view.
 *
 * Architecture (Order-Based Location Tracking):
 *  1. Watches Firebase Auth → gets current user UID
 *  2. Subscribes to THREE Firestore collections for accepted orders:
 *       • orders        (taxi trips)
 *       • trips         (alternative taxi collection used by partner app)
 *       • gas_bookings  (gas agent orders)
 *  3. On first accepted order found, extracts driver_id / agent_id
 *  4. Opens a DEDICATED channel to drivers/{driver_id} for live GPS
 *  5. Falls back to driver_lat/driver_lng inside the order doc if no driver_id
 *  6. Shows a single animated driver marker + OSRM route on the Leaflet map
 *  7. Cleans up automatically on terminal status (done/cancelled/completed)
 *
 * NO global driver stream. NO public driver markers.
 * Location tracking is strictly order-gated and driver-specific.
 */
import { useEffect, useRef, useCallback } from 'react';
import L from 'leaflet';
import { onAuthStateChanged } from 'firebase/auth';
import {
  collection, query, where, onSnapshot, doc,
} from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';

// ── Types ─────────────────────────────────────────────────────────────────────
interface Props {
  mapRef:       React.MutableRefObject<L.Map | null>;
  userLocation: { lat: number; lng: number } | null;
}

type OrderType = 'taxi' | 'gas';

// ── Constants ─────────────────────────────────────────────────────────────────
const ACTIVE_STATUSES   = ['accepted', 'in_progress', 'driving'] as const;
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

// ── OSRM route drawing ─────────────────────────────────────────────────────────
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

// ── Component ──────────────────────────────────────────────────────────────────
export function ActiveOrderTracker({ mapRef, userLocation }: Props) {
  const userLocRef        = useRef(userLocation);
  const markerRef         = useRef<L.Marker | null>(null);
  const routeGlowRef      = useRef<L.Polyline | null>(null);
  const routeLineRef      = useRef<L.Polyline | null>(null);
  const routeTimerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Active tracking state
  const activeOrderDocId  = useRef<string | null>(null);  // Firestore doc ID of active order
  const activeDriverId    = useRef<string | null>(null);  // drivers/{uid} we are watching
  const orderUnsubRef     = useRef<(() => void) | null>(null);   // unsub for order doc
  const driverUnsubRef    = useRef<(() => void) | null>(null);   // unsub for drivers/{id}
  const queryUnsubsRef    = useRef<Array<() => void>>([]);       // unsubs for collection queries

  // Keep userLoc ref current
  useEffect(() => { userLocRef.current = userLocation; }, [userLocation]);

  // ── Cleanup helpers ─────────────────────────────────────────────────────────
  const clearVisuals = useCallback(() => {
    markerRef.current?.remove();     markerRef.current    = null;
    routeGlowRef.current?.remove();  routeGlowRef.current = null;
    routeLineRef.current?.remove();  routeLineRef.current = null;
    if (routeTimerRef.current) { clearTimeout(routeTimerRef.current); routeTimerRef.current = null; }
  }, []);

  const stopDriverWatch = useCallback(() => {
    driverUnsubRef.current?.();
    driverUnsubRef.current = null;
    activeDriverId.current = null;
  }, []);

  const stopOrderWatch = useCallback(() => {
    orderUnsubRef.current?.();
    orderUnsubRef.current  = null;
    activeOrderDocId.current = null;
  }, []);

  const fullCleanup = useCallback(() => {
    clearVisuals();
    stopDriverWatch();
    stopOrderWatch();
  }, [clearVisuals, stopDriverWatch, stopOrderWatch]);

  // ── Apply driver GPS position ───────────────────────────────────────────────
  const applyDriverPosition = useCallback((lat: number, lng: number, type: OrderType) => {
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

    // Redraw OSRM route (debounced 1 s) every time driver moves
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

  // ── Watch drivers/{driverId} for live GPS ────────────────────────────────────
  // Called once we know the accepted driver's UID. Opens a dedicated channel.
  const watchDriverLocation = useCallback((driverId: string, type: OrderType) => {
    if (activeDriverId.current === driverId) return;  // already watching
    stopDriverWatch();
    activeDriverId.current = driverId;

    console.log(`[ActiveOrderTracker] 📍 subscribing to drivers/${driverId}`);

    driverUnsubRef.current = onSnapshot(
      doc(db, 'drivers', driverId),
      (snap) => {
        const data = snap.data();
        if (!data) return;
        const lat = data.lat ?? data.latitude  ?? data.driver_lat;
        const lng = data.lng ?? data.longitude ?? data.driver_lng;
        if (typeof lat === 'number' && typeof lng === 'number') {
          applyDriverPosition(lat, lng, type);
        }
      },
      (err) => {
        console.warn(`[ActiveOrderTracker] drivers/${driverId} error:`, err?.code);
      },
    );
  }, [applyDriverPosition, stopDriverWatch]);

  // ── Watch a single order doc for status + fallback position ─────────────────
  // Opens driver location channel as soon as driverId is known.
  const watchOrderDoc = useCallback((
    collection_: string,
    docId: string,
    type: OrderType,
  ) => {
    if (activeOrderDocId.current === docId) return;
    stopOrderWatch();
    activeOrderDocId.current = docId;

    console.log(`[ActiveOrderTracker] watching ${collection_}/${docId}`);

    orderUnsubRef.current = onSnapshot(
      doc(db, collection_, docId),
      (snap) => {
        const data = snap.data();
        if (!data) return;

        // Terminal → full cleanup
        if (TERMINAL_STATUSES.has(data.status)) {
          console.log(`[ActiveOrderTracker] order ${docId} terminal (${data.status}) — cleanup`);
          fullCleanup();
          return;
        }

        // ── Extract driver UID from various field names ─────────────────────
        // Partner app writes: driver_id (Firebase UID) OR agent_id (gas)
        const driverId: string | null =
          data.driver_id   ??   // partner app sets this on accept
          data.agent_id    ??   // gas agent UID
          data.agentId     ??
          data.driverId    ??
          null;

        // ── Subscribe to drivers/{driverId} for primary live location ────────
        if (driverId) {
          watchDriverLocation(driverId, type);
        }

        // ── Fallback: read driver_lat/driver_lng embedded in order doc ───────
        // Used when the partner app updates the order doc directly (REST flow)
        const lat = data.driver_lat ?? data.driverLat;
        const lng = data.driver_lng ?? data.driverLng;
        if (typeof lat === 'number' && typeof lng === 'number') {
          applyDriverPosition(lat, lng, type);
        }
      },
      (err) => {
        console.warn(`[ActiveOrderTracker] ${collection_}/${docId} error:`, err?.code);
      },
    );
  }, [applyDriverPosition, fullCleanup, stopOrderWatch, watchDriverLocation]);

  // ── Main effect: auth → query THREE collections ────────────────────────────
  useEffect(() => {
    const authUnsub = onAuthStateChanged(auth, (fbUser) => {
      // Tear down previous subscriptions when user changes
      queryUnsubsRef.current.forEach(u => u());
      queryUnsubsRef.current = [];
      fullCleanup();

      if (!fbUser) return;

      const uid = fbUser.uid;
      console.log(`[ActiveOrderTracker] user ${uid} — subscribing to accepted orders`);

      // Helper: subscribe to one collection
      const subscribeCol = (colName: string, type: OrderType) => {
        const q = query(
          collection(db, colName),
          where('customer_id', '==', uid),
          where('status', 'in', ACTIVE_STATUSES as unknown as string[]),
        );

        const unsub = onSnapshot(q, (snap) => {
          if (snap.empty) {
            // No active orders in this collection — clear if this was our source
            return;
          }

          // Pick the most recent active order
          const docSnap = snap.docs[0];
          const data    = docSnap.data();
          const orderType: OrderType = colName === 'gas_bookings' ? 'gas' : type;

          // Start watching this specific order doc for driver updates
          watchOrderDoc(colName, docSnap.id, orderType);

          // Apply position immediately if already embedded in order doc
          const driverId: string | null =
            data.driver_id ?? data.agent_id ?? data.agentId ?? data.driverId ?? null;
          if (driverId) {
            watchDriverLocation(driverId, orderType);
          }
          const lat = data.driver_lat ?? data.driverLat;
          const lng = data.driver_lng ?? data.driverLng;
          if (typeof lat === 'number' && typeof lng === 'number') {
            applyDriverPosition(lat, lng, orderType);
          }
        }, (err) => {
          console.warn(`[ActiveOrderTracker] ${colName} query error:`, err?.code);
        });

        queryUnsubsRef.current.push(unsub);
      };

      // ── Subscribe to all three order collections ──────────────────────────
      subscribeCol('orders',        'taxi');  // standard taxi orders
      subscribeCol('trips',         'taxi');  // alternative partner-hub trips collection
      subscribeCol('gas_bookings',  'gas');   // gas agent orders
    });

    return () => {
      authUnsub();
      queryUnsubsRef.current.forEach(u => u());
      queryUnsubsRef.current = [];
      fullCleanup();
    };
  }, [applyDriverPosition, fullCleanup, watchOrderDoc, watchDriverLocation]);

  return null;
}
