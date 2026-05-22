/**
 * ActiveOrderTracker.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Firestore real-time driver tracking — CUSTOMER view.
 *
 * Architecture (Order-Based Location Tracking):
 *  1. Watches Firebase Auth → gets current user UID
 *  2. Subscribes to THREE Firestore collections for accepted orders:
 *       • orders        (taxi trips)
 *       • trips         (alternative taxi collection used by partner app)
 *       • gas_bookings  (gas agent orders)
 *  3. On first accepted order found, extracts driver_phone / driver_id
 *  4. Primary channel : onSnapshot(query(drivers, where('phone','==',phone)))
 *     — fires every time the partner app writes a new GPS coordinate
 *  5. Secondary channel: onSnapshot(doc(drivers, driverId)) if UID is available
 *  6. Fallback channel : driver_lat / driver_lng embedded in the order doc
 *  7. Every position update is SMOOTHLY INTERPOLATED via requestAnimationFrame
 *     (60 fps ease-out lerp over 1.5 s) — marker crawls along the street
 *  8. Cleans up automatically on terminal status (done/cancelled/completed)
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

interface SmoothMove {
  animFrame: number;
  fromLat:   number;
  fromLng:   number;
  toLat:     number;
  toLng:     number;
  startTime: number;
  duration:  number;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const ACTIVE_STATUSES   = ['accepted', 'in_progress', 'driving'] as const;
const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'done', 'finished', 'rejected']);
const LERP_DURATION_MS  = 1500;   // smooth move duration per GPS update

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

// ── Destination pin icon ──────────────────────────────────────────────────────
function makeDestinationIcon(): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `
      <div style="display:flex;flex-direction:column;align-items:center;gap:0;">
        <div style="
          width:36px;height:36px;
          background:rgba(5,8,15,0.95);
          border:2px solid #ff2d78;
          border-radius:50%;
          display:flex;align-items:center;justify-content:center;
          box-shadow:0 0 18px #ff2d7888;
          font-size:18px;line-height:1;
        ">📍</div>
        <div style="
          background:rgba(5,8,15,0.92);
          border:1px solid #ff2d78;
          color:#ff2d78;
          font-family:Rajdhani,sans-serif;
          font-size:10px;font-weight:700;
          padding:2px 7px;
          white-space:nowrap;
          border-radius:3px;
          letter-spacing:0.05em;
          margin-top:2px;
          box-shadow:0 0 8px #ff2d7855;
        ">وجهتك</div>
      </div>`,
    iconSize:   [36, 60],
    iconAnchor: [18, 60],
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

// ── Ease-out quad: fast start, smooth deceleration ────────────────────────────
function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

// ── Component ──────────────────────────────────────────────────────────────────
export function ActiveOrderTracker({ mapRef, userLocation }: Props) {
  const userLocRef        = useRef(userLocation);
  const markerRef         = useRef<L.Marker | null>(null);
  const destMarkerRef     = useRef<L.Marker | null>(null);
  const routeGlowRef      = useRef<L.Polyline | null>(null);
  const routeLineRef      = useRef<L.Polyline | null>(null);
  const routeTimerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const smoothMoveRef     = useRef<SmoothMove | null>(null);  // active RAF lerp

  // Active tracking state
  const activeOrderDocId  = useRef<string | null>(null);
  const activeDriverId    = useRef<string | null>(null);
  const activeDriverPhone = useRef<string | null>(null);
  const orderUnsubRef     = useRef<(() => void) | null>(null);
  const driverUnsubRef    = useRef<(() => void) | null>(null);
  const queryUnsubsRef    = useRef<Array<() => void>>([]);

  // Keep userLoc ref current
  useEffect(() => { userLocRef.current = userLocation; }, [userLocation]);

  // ── Cancel any in-progress smooth animation ──────────────────────────────────
  const cancelSmoothMove = useCallback(() => {
    if (smoothMoveRef.current !== null) {
      cancelAnimationFrame(smoothMoveRef.current.animFrame);
      smoothMoveRef.current = null;
    }
  }, []);

  // ── Cleanup helpers ─────────────────────────────────────────────────────────
  const clearVisuals = useCallback(() => {
    cancelSmoothMove();
    markerRef.current?.remove();      markerRef.current    = null;
    destMarkerRef.current?.remove();  destMarkerRef.current = null;
    routeGlowRef.current?.remove();   routeGlowRef.current = null;
    routeLineRef.current?.remove();   routeLineRef.current = null;
    if (routeTimerRef.current) { clearTimeout(routeTimerRef.current); routeTimerRef.current = null; }
  }, [cancelSmoothMove]);

  const stopDriverWatch = useCallback(() => {
    driverUnsubRef.current?.();
    driverUnsubRef.current = null;
    activeDriverId.current = null;
    activeDriverPhone.current = null;
  }, []);

  const stopOrderWatch = useCallback(() => {
    orderUnsubRef.current?.();
    orderUnsubRef.current    = null;
    activeOrderDocId.current = null;
  }, []);

  const fullCleanup = useCallback(() => {
    clearVisuals();
    stopDriverWatch();
    stopOrderWatch();
  }, [clearVisuals, stopDriverWatch, stopOrderWatch]);

  // ── Show / update destination marker ─────────────────────────────────────────
  const applyDestination = useCallback((toLat: number, toLng: number) => {
    const map = mapRef.current;
    if (!map) return;
    if (destMarkerRef.current) {
      destMarkerRef.current.setLatLng([toLat, toLng]);
    } else {
      destMarkerRef.current = L.marker([toLat, toLng], {
        icon:         makeDestinationIcon(),
        zIndexOffset: 9200,
      }).addTo(map);
    }
  }, [mapRef]);

  // ── Schedule OSRM route redraw (debounced, only after marker stops) ───────────
  const scheduleRouteRedraw = useCallback((lat: number, lng: number) => {
    if (routeTimerRef.current) { clearTimeout(routeTimerRef.current); routeTimerRef.current = null; }
    routeTimerRef.current = setTimeout(() => {
      routeTimerRef.current = null;
      const userLoc = userLocRef.current;
      if (mapRef.current && userLoc) {
        drawOsrmRoute(mapRef.current, lat, lng, userLoc.lat, userLoc.lng, routeGlowRef, routeLineRef);
      }
    }, 1200);
  }, [mapRef]);

  // ── Apply driver GPS position with smooth requestAnimationFrame lerp ──────────
  // Every time Firestore fires a new lat/lng this function is called.
  // It cancels any previous animation and starts a new one from the marker's
  // CURRENT interpolated position, so motion is always fluid and never jumps.
  const applyDriverPosition = useCallback((lat: number, lng: number, type: OrderType) => {
    const map = mapRef.current;
    if (!map) return;

    // First placement — add marker and skip animation
    if (!markerRef.current) {
      markerRef.current = L.marker([lat, lng], {
        icon:         makeTrackedDriverIcon(type),
        zIndexOffset: 9500,
      }).addTo(map);
      scheduleRouteRedraw(lat, lng);
      return;
    }

    // Subsequent updates — smoothly interpolate from current rendered position
    cancelSmoothMove();
    const { lat: fromLat, lng: fromLng } = markerRef.current.getLatLng();

    // Skip micro-jitter (< 0.5 m)
    const dlat = lat - fromLat, dlng = lng - fromLng;
    if (Math.abs(dlat) < 0.000005 && Math.abs(dlng) < 0.000005) return;


    const startTime = performance.now();

    const tick = (now: number) => {
      const raw = Math.min((now - startTime) / LERP_DURATION_MS, 1);
      const t   = easeOutQuad(raw);
      const iLat = fromLat + dlat * t;
      const iLng = fromLng + dlng * t;

      markerRef.current?.setLatLng([iLat, iLng]);

      if (raw < 1) {
        smoothMoveRef.current = {
          ...smoothMoveRef.current!,
          animFrame: requestAnimationFrame(tick),
        };
      } else {
        // Animation complete
        smoothMoveRef.current = null;
        scheduleRouteRedraw(lat, lng);
      }
    };

    smoothMoveRef.current = {
      animFrame: requestAnimationFrame(tick),
      fromLat, fromLng, toLat: lat, toLng: lng,
      startTime, duration: LERP_DURATION_MS,
    };
  }, [mapRef, cancelSmoothMove, scheduleRouteRedraw]);

  // ── PRIMARY: Watch drivers by phone (partner-app's authoritative GPS source) ──
  // Queries the Firestore `drivers` collection with where('phone','==',phone).
  // Fires within < 1 s of every GPS write from the Flutter partner app.
  const watchDriverByPhone = useCallback((phone: string, type: OrderType) => {
    if (activeDriverPhone.current === phone) return;
    stopDriverWatch();
    activeDriverPhone.current = phone;


    const q = query(collection(db, 'drivers'), where('phone', '==', phone));
    driverUnsubRef.current = onSnapshot(
      q,
      (snap) => {
        const driverDoc = snap.docs[0];
        if (!driverDoc) return;
        const data = driverDoc.data();
        const lat  = typeof data.lat === 'number' ? data.lat : Number(data.lat ?? data.latitude ?? data.driver_lat);
        const lng  = typeof data.lng === 'number' ? data.lng : Number(data.lng ?? data.longitude ?? data.driver_lng);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          applyDriverPosition(lat, lng, type);
        }
      },
      (err) => {
        console.warn(`[ActiveOrderTracker] phone query error:`, err?.code);
        // Firestore permission denied — fall back to order-doc polling
      },
    );
  }, [applyDriverPosition, stopDriverWatch]);

  // ── SECONDARY: Watch drivers/{driverId} (for Firebase-UID keyed documents) ───
  const watchDriverById = useCallback((driverId: string, type: OrderType) => {
    if (activeDriverId.current === driverId) return;
    // Only open if phone-based channel isn't already active
    if (activeDriverPhone.current) return;
    stopDriverWatch();
    activeDriverId.current = driverId;


    driverUnsubRef.current = onSnapshot(
      doc(db, 'drivers', driverId),
      (snap) => {
        const data = snap.data();
        if (!data) return;
        const lat = typeof data.lat === 'number' ? data.lat : Number(data.lat ?? data.latitude ?? data.driver_lat);
        const lng = typeof data.lng === 'number' ? data.lng : Number(data.lng ?? data.longitude ?? data.driver_lng);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          applyDriverPosition(lat, lng, type);
        }
      },
      (err) => {
        console.warn(`[ActiveOrderTracker] drivers/${driverId} error:`, err?.code);
      },
    );
  }, [applyDriverPosition, stopDriverWatch]);

  // ── Watch a single order doc for status + driver info + fallback position ─────
  const watchOrderDoc = useCallback((
    collection_: string,
    docId:       string,
    type:        OrderType,
  ) => {
    if (activeOrderDocId.current === docId) return;
    stopOrderWatch();
    activeOrderDocId.current = docId;


    orderUnsubRef.current = onSnapshot(
      doc(db, collection_, docId),
      (snap) => {
        const data = snap.data();
        if (!data) return;

        // Terminal → full cleanup
        if (TERMINAL_STATUSES.has(data.status)) {
          fullCleanup();
          return;
        }

        // ── Destination marker ─────────────────────────────────────────────
        const toLat = data.to_lat ?? data.toLat ?? data.dropoff_lat ?? null;
        const toLng = data.to_lng ?? data.toLng ?? data.dropoff_lng ?? null;
        if (typeof toLat === 'number' && typeof toLng === 'number') {
          applyDestination(toLat, toLng);
        }

        // ── PRIMARY: phone-based Firestore channel (most reliable) ────────
        const phone: string | null = data.driver_phone ?? null;
        if (phone) {
          watchDriverByPhone(phone, type);
        }

        // ── SECONDARY: UID-based Firestore channel ────────────────────────
        const driverId: string | null =
          data.driver_id ?? data.agent_id ?? data.agentId ?? data.driverId ?? null;
        if (driverId && !phone) {
          watchDriverById(driverId, type);
        }

        // ── FALLBACK: driver_lat/driver_lng in the order doc itself ───────
        // Written by syncOrderToFirestore() in ClinicMap when SSE fires.
        // Used when the partner app doesn't write to drivers/ collection.
        if (!phone && !driverId) {
          const lat = data.driver_lat ?? data.driverLat;
          const lng = data.driver_lng ?? data.driverLng;
          if (typeof lat === 'number' && typeof lng === 'number') {
            applyDriverPosition(lat, lng, type);
          }
        }
      },
      (err) => {
        console.warn(`[ActiveOrderTracker] ${collection_}/${docId} error:`, err?.code);
      },
    );
  }, [applyDestination, applyDriverPosition, fullCleanup, stopOrderWatch, watchDriverByPhone, watchDriverById]);

  // ── Main effect: auth → query THREE collections ────────────────────────────
  useEffect(() => {
    const authUnsub = onAuthStateChanged(auth, (fbUser) => {
      queryUnsubsRef.current.forEach(u => u());
      queryUnsubsRef.current = [];
      fullCleanup();

      if (!fbUser) return;

      const uid = fbUser.uid;

      const subscribeCol = (colName: string, type: OrderType) => {
        const q = query(
          collection(db, colName),
          where('customer_id', '==', uid),
          where('status', 'in', ACTIVE_STATUSES as unknown as string[]),
        );

        const unsub = onSnapshot(q, (snap) => {
          if (snap.empty) return;

          const docSnap    = snap.docs[0];
          const data       = docSnap.data();
          const orderType: OrderType = colName === 'gas_bookings' ? 'gas' : type;

          // Open order doc watcher (idempotent)
          watchOrderDoc(colName, docSnap.id, orderType);

          // Apply destination immediately from the query snapshot
          const toLat = data.to_lat ?? data.toLat ?? null;
          const toLng = data.to_lng ?? data.toLng ?? null;
          if (typeof toLat === 'number' && typeof toLng === 'number') {
            applyDestination(toLat, toLng);
          }

          // Immediately open the driver channel if phone is known
          const phone: string | null = data.driver_phone ?? null;
          if (phone) {
            watchDriverByPhone(phone, orderType);
          } else {
            // Try UID channel
            const driverId: string | null =
              data.driver_id ?? data.agent_id ?? data.agentId ?? data.driverId ?? null;
            if (driverId) {
              watchDriverById(driverId, orderType);
            } else {
              // Fallback: embedded coords
              const lat = data.driver_lat ?? data.driverLat;
              const lng = data.driver_lng ?? data.driverLng;
              if (typeof lat === 'number' && typeof lng === 'number') {
                applyDriverPosition(lat, lng, orderType);
              }
            }
          }
        }, (err) => {
          console.warn(`[ActiveOrderTracker] ${colName} query error:`, err?.code);
        });

        queryUnsubsRef.current.push(unsub);
      };

      subscribeCol('orders',       'taxi');
      subscribeCol('trips',        'taxi');
      subscribeCol('gas_bookings', 'gas');
    });

    return () => {
      authUnsub();
      queryUnsubsRef.current.forEach(u => u());
      queryUnsubsRef.current = [];
      fullCleanup();
    };
  }, [applyDestination, applyDriverPosition, fullCleanup, watchOrderDoc, watchDriverByPhone, watchDriverById]);

  return null;
}
