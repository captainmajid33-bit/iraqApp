/**
 * BountyMissionSystem — ديالى مهمات الجوائز
 * - Reads `bounty_missions` (status == 'active') from Firestore live
 * - Draws golden pulsing diamond markers on the Leaflet map
 * - Bottom sheet: live GPS distance, navigate polyline, atomic claim transaction
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import {
  collection, onSnapshot, query, where,
  runTransaction, doc, serverTimestamp,
  setDoc, getDoc, increment,
} from 'firebase/firestore';
import { db, auth } from '@/lib/firebase';

// ── Types ─────────────────────────────────────────────────────────────────────
interface BountyMission {
  id:          string;
  title:       string;
  description: string;
  reward:      number;
  latitude:    number;
  longitude:   number;
  status:      'active' | 'claimed';
  claimedBy?:  string;
}

interface Props {
  mapRef:       React.MutableRefObject<L.Map | null>;
  userLocation: { lat: number; lng: number } | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const CLAIM_RADIUS_M = 20;
const C = {
  yellow: '#f5c518',
  green:  '#00dc64',
  red:    '#ff2d50',
  blue:   '#00d4ff',
  dim:    'rgba(255,255,255,0.35)',
  dimx:   'rgba(255,255,255,0.18)',
};

const SEED: Omit<BountyMission, 'id'>[] = [
  {
    title:       'صندوق حديقة مصطفى جواد',
    description: 'ابحث عن الصندوق السري في حديقة مصطفى جواد وكن أول من يصل إليه واستلم مكافأتك الحصرية!',
    reward:      25000,
    latitude:    33.7460,
    longitude:   44.6510,
    status:      'active',
  },
  {
    title:       'كنز الساحة المركزية',
    description: 'توجّه إلى الساحة المركزية في باقوبة — الأول يفوز بالجائزة الكبرى.',
    reward:      15000,
    latitude:    33.7430,
    longitude:   44.6498,
    status:      'active',
  },
  {
    title:       'تحدي الشارع الرئيسي',
    description: 'أكمل تحدي الوصول السريع على الشارع الرئيسي وكن البطل الأول في ديالى!',
    reward:      35000,
    latitude:    33.7472,
    longitude:   44.6540,
    status:      'active',
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Returns human-readable distance string */
function fmtDist(m: number): string {
  return m < 1000 ? `${Math.round(m)} م` : `${(m / 1000).toFixed(1)} كم`;
}

/** Estimated travel time (walking ≤800m, else car ~30 km/h city) */
function estMinutes(m: number): number {
  if (m <= 800) return Math.max(1, Math.round(m / 70));       // ~70 m/min walking
  return Math.max(1, Math.round((m / 1000 / 30) * 60));       // 30 km/h car
}

function travelMode(m: number): string {
  return m <= 800 ? '🚶 مشياً' : '🚗 بالسيارة';
}

function getUser(): { name?: string; phone?: string } | null {
  try { return JSON.parse(localStorage.getItem('diyala_user') ?? 'null'); }
  catch { return null; }
}

function makeMissionIcon(): L.DivIcon {
  return L.divIcon({
    className:  '',
    iconSize:   [54, 54],
    iconAnchor: [27, 27],
    html: `<div style="width:54px;height:54px;position:relative;display:flex;align-items:center;justify-content:center;cursor:pointer;">
      <div style="position:absolute;inset:-4px;border-radius:50%;background:#f5c518;opacity:0.10;animation:lf-ping 1.8s cubic-bezier(0,0,0.2,1) infinite;"></div>
      <div style="position:absolute;inset:-10px;border-radius:50%;background:#f5c518;opacity:0.05;animation:lf-ping 1.8s cubic-bezier(0,0,0.2,1) infinite;animation-delay:0.5s;"></div>
      <div style="animation:mission-pulse 2s ease-in-out infinite;">
        <svg width="46" height="46" viewBox="0 0 46 46" fill="none">
          <polygon points="23,2 43,23 23,44 3,23" fill="#f5c51818" stroke="#f5c518" stroke-width="2"/>
          <polygon points="23,10 36,23 23,36 10,23" fill="#f5c518" opacity="0.85"/>
          <text x="23" y="28" text-anchor="middle" font-size="13" fill="#0a0d14" font-weight="900" font-family="Arial">★</text>
        </svg>
      </div>
    </div>`,
  });
}

// ── Component ─────────────────────────────────────────────────────────────────
export function BountyMissionSystem({ mapRef, userLocation }: Props) {
  const [mapReady,       setMapReady]       = useState(false);
  const [missions,       setMissions]       = useState<BountyMission[]>([]);
  const [selected,       setSelected]       = useState<BountyMission | null>(null);
  const [distM,          setDistM]          = useState<number | null>(null);
  const [claiming,       setClaiming]       = useState(false);
  const [claimResult,    setClaimResult]    = useState<'success' | 'taken' | 'error' | null>(null);
  const [navigating,     setNavigating]     = useState(false);
  const [routeLoading,   setRouteLoading]   = useState(false);
  const [routeInfo,      setRouteInfo]      = useState<{ distM: number; durationSec: number } | null>(null);
  const [gpsLoading,     setGpsLoading]     = useState(false);
  const [internalPos,    setInternalPos]    = useState<{ lat: number; lng: number } | null>(null);

  const markersRef  = useRef<Map<string, L.Marker>>(new Map());
  const polylineRef = useRef<L.Polyline | null>(null);
  const seededRef   = useRef(false);
  const gpsWatchRef = useRef<number | null>(null);

  // Effective location: prop first, then internal GPS fallback
  const effectivePos = userLocation ?? internalPos;

  // ── Wait for Leaflet map ───────────────────────────────────────────────────
  useEffect(() => {
    if (mapRef.current) { setMapReady(true); return; }
    const iv = setInterval(() => {
      if (mapRef.current) { setMapReady(true); clearInterval(iv); }
    }, 250);
    return () => clearInterval(iv);
  }, [mapRef]);

  // ── Seed Firestore once if collection is empty ─────────────────────────────
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    (async () => {
      try {
        const checkRef = doc(db, 'bounty_missions', '_seed_check');
        const snap = await getDoc(checkRef);
        if (!snap.exists()) {
          await Promise.all(
            SEED.map((m, i) => setDoc(doc(db, 'bounty_missions', `mission_${i + 1}`), m))
          );
          await setDoc(checkRef, { seeded: true });
        }
      } catch (e) { console.warn('[BountyMission] seed error:', e); }
    })();
  }, []);

  // ── Live Firestore listener — active missions only ─────────────────────────
  useEffect(() => {
    const q = query(
      collection(db, 'bounty_missions'),
      where('status', '==', 'active'),
    );
    const unsub = onSnapshot(q, snap => {
      const docs: BountyMission[] = [];
      snap.forEach(d => {
        if (d.id === '_seed_check') return;
        const raw = d.data();
        const lat = Number(raw.latitude);
        const lng = Number(raw.longitude);
        if (isNaN(lat) || isNaN(lng)) return;
        docs.push({
          id:          d.id,
          title:       String(raw.title ?? 'مهمة'),
          description: String(raw.description ?? ''),
          reward:      Number(raw.reward ?? 0),
          latitude:    lat,
          longitude:   lng,
          status:      raw.status as 'active' | 'claimed',
          claimedBy:   raw.claimedBy,
        });
      });
      setMissions(docs);
    }, err => console.warn('[BountyMission] onSnapshot error:', err.message));
    return () => unsub();
  }, []);

  // ── Draw / update markers when missions or map change ─────────────────────
  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current;
    if (!map) return;
    const activeIds = new Set(missions.map(m => m.id));
    markersRef.current.forEach((marker, id) => {
      if (!activeIds.has(id)) { marker.remove(); markersRef.current.delete(id); }
    });
    missions.forEach(mission => {
      if (markersRef.current.has(mission.id)) return;
      const marker = L.marker([mission.latitude, mission.longitude], {
        icon:         makeMissionIcon(),
        zIndexOffset: 2000,
      }).addTo(map);
      marker.on('click', () => { setSelected(mission); setClaimResult(null); });
      markersRef.current.set(mission.id, marker);
    });
  }, [missions, mapReady, mapRef]);

  // ── Sync selected with live mission list ─────────────────────────────────
  useEffect(() => {
    if (!selected) return;
    const updated = missions.find(m => m.id === selected.id);
    setSelected(updated ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missions]);

  // ── Internal GPS: start watching when sheet opens & userLocation is null ───
  useEffect(() => {
    if (!selected) {
      // Sheet closed — stop watch, clear internal pos
      if (gpsWatchRef.current !== null) {
        navigator.geolocation?.clearWatch(gpsWatchRef.current);
        gpsWatchRef.current = null;
      }
      setInternalPos(null);
      setGpsLoading(false);
      return;
    }

    // If parent already provides location, no need for internal watch
    if (userLocation) return;

    if (!navigator.geolocation) return;

    setGpsLoading(true);
    gpsWatchRef.current = navigator.geolocation.watchPosition(
      pos => {
        setInternalPos({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setGpsLoading(false);
      },
      err => {
        console.warn('[BountyMission] GPS error:', err.message);
        setGpsLoading(false);
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 3000 },
    );

    return () => {
      if (gpsWatchRef.current !== null) {
        navigator.geolocation.clearWatch(gpsWatchRef.current);
        gpsWatchRef.current = null;
      }
    };
  }, [selected, userLocation]);

  // ── Live distance calculation (haversine — always kept fresh) ────────────
  useEffect(() => {
    if (!selected || !effectivePos) { setDistM(null); return; }
    const d = haversineMeters(
      effectivePos.lat, effectivePos.lng,
      selected.latitude, selected.longitude,
    );
    setDistM(d);
  }, [selected, effectivePos]);

  // ── Remove polyline when sheet closes ─────────────────────────────────────
  useEffect(() => {
    if (!selected) {
      clearPolyline();
      setNavigating(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  function clearPolyline() {
    if (polylineRef.current) {
      polylineRef.current.remove();
      polylineRef.current = null;
    }
  }

  // ── Navigate: fetch OSRM road route → draw polyline + fit bounds ─────────
  const handleNavigate = useCallback(async () => {
    if (!selected || !effectivePos || !mapRef.current) return;
    const map  = mapRef.current;
    const from = effectivePos;
    const to   = { lat: selected.latitude, lng: selected.longitude };

    clearPolyline();
    setRouteLoading(true);
    setNavigating(true);
    setRouteInfo(null);

    try {
      // OSRM public routing API — no key required
      // Coords order: longitude,latitude (OSRM convention)
      const url =
        `https://router.project-osrm.org/route/v1/driving/` +
        `${from.lng},${from.lat};${to.lng},${to.lat}` +
        `?overview=full&geometries=geojson`;

      const res  = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const data = await res.json();

      if (data.code === 'Ok' && data.routes?.length) {
        const route = data.routes[0];

        // GeoJSON coords are [lng, lat] — flip to [lat, lng] for Leaflet
        const latlngs: L.LatLngTuple[] = (
          route.geometry.coordinates as [number, number][]
        ).map(([lng, lat]) => [lat, lng]);

        // Draw road-following polyline
        polylineRef.current = L.polyline(latlngs, {
          color:     C.yellow,
          weight:    5,
          opacity:   0.95,
          className: 'bounty-nav-line',
        }).addTo(map);

        // Fit the full route on screen
        map.fitBounds(polylineRef.current.getBounds(), {
          padding: [55, 55],
          maxZoom: 16,
          animate: true,
          duration: 0.9,
        });

        setRouteInfo({
          distM:       route.distance,    // metres (real road)
          durationSec: route.duration,    // seconds
        });
      } else {
        // OSRM fallback — no route found, draw straight line
        console.warn('[BountyMission] OSRM no route, using fallback');
        const pts: L.LatLngTuple[] = [
          [from.lat, from.lng],
          [to.lat,   to.lng],
        ];
        polylineRef.current = L.polyline(pts, {
          color:     C.yellow,
          weight:    4,
          opacity:   0.88,
          dashArray: '10 6',
          className: 'bounty-nav-line',
        }).addTo(map);
        map.fitBounds(L.latLngBounds(pts), {
          padding: [60, 60], maxZoom: 16, animate: true, duration: 0.8,
        });
      }
    } catch (err) {
      console.warn('[BountyMission] OSRM fetch error:', err);
      // Straight-line fallback on network error
      const pts: L.LatLngTuple[] = [
        [from.lat, from.lng],
        [to.lat,   to.lng],
      ];
      if (mapRef.current) {
        polylineRef.current = L.polyline(pts, {
          color:     C.yellow,
          weight:    4,
          opacity:   0.88,
          dashArray: '10 6',
          className: 'bounty-nav-line',
        }).addTo(mapRef.current);
        mapRef.current.fitBounds(L.latLngBounds(pts), {
          padding: [60, 60], maxZoom: 16, animate: true, duration: 0.8,
        });
      }
    } finally {
      setRouteLoading(false);
    }
  }, [selected, effectivePos, mapRef]);

  // ── Stop navigation ───────────────────────────────────────────────────────
  const handleStopNav = useCallback(() => {
    clearPolyline();
    setNavigating(false);
    setRouteInfo(null);
  }, []);

  // ── Claim handler — Firestore atomic transaction ──────────────────────────
  const handleClaim = useCallback(async () => {
    if (!selected) return;
    const user        = getUser();
    const userId      = user?.phone ?? user?.name ?? 'anonymous';
    const firebaseUid = auth.currentUser?.uid;
    setClaiming(true);
    setClaimResult(null);
    try {
      const missionRef = doc(db, 'bounty_missions', selected.id);
      await runTransaction(db, async txn => {
        const missionSnap = await txn.get(missionRef);
        if (!missionSnap.exists() || missionSnap.data()?.status !== 'active') {
          throw new Error('already_claimed');
        }
        const prizeAmount = Number(missionSnap.data()?.reward ?? 0);
        txn.update(missionRef, {
          status:    'claimed',
          claimedBy: userId,
          claimedAt: serverTimestamp(),
        });
        if (firebaseUid && prizeAmount > 0) {
          const userRef = doc(db, 'users', firebaseUid);
          txn.set(userRef, { balance: increment(prizeAmount) }, { merge: true });
        }
      });
      setClaimResult('success');
      clearPolyline();
      setNavigating(false);
      setTimeout(() => { setSelected(null); setClaimResult(null); }, 3500);
    } catch (e: any) {
      setClaimResult(e?.message === 'already_claimed' ? 'taken' : 'error');
    } finally {
      setClaiming(false);
    }
  }, [selected]);

  // ── Nothing to render if no selection ────────────────────────────────────
  if (!selected) return null;

  const isClose = distM !== null && distM <= CLAIM_RADIUS_M;
  const locReady = effectivePos !== null;

  // ── Distance / travel info ────────────────────────────────────────────────
  const distStr  = distM !== null ? fmtDist(distM) : null;
  const minutes  = distM !== null ? estMinutes(distM) : null;
  const mode     = distM !== null ? travelMode(distM) : null;

  return (
    <>
      <style>{`
        @keyframes bounty-slide-up { from { transform: translateY(100%); } to { transform: translateY(0); } }
        @keyframes bounty-glow     { 0%,100%{box-shadow:0 0 20px #f5c51888,0 0 40px #f5c51844;} 50%{box-shadow:0 0 40px #f5c518cc,0 0 60px #f5c51866;} }
        @keyframes bounty-success  { 0%{transform:scale(0.8);opacity:0;} 60%{transform:scale(1.08);} 100%{transform:scale(1);opacity:1;} }
        @keyframes nav-dash        { to { stroke-dashoffset: -32; } }
        .bounty-nav-line           { filter: drop-shadow(0 0 6px #f5c518cc); animation: none; }
      `}</style>

      {/* Backdrop */}
      <div
        onClick={() => { setSelected(null); setClaimResult(null); }}
        style={{
          position: 'absolute', inset: 0, zIndex: 3000,
          background: 'rgba(0,0,0,0.52)',
          backdropFilter: 'blur(3px)',
        }}
      />

      {/* Bottom Sheet */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 3001,
        background: 'rgba(5,8,15,0.99)',
        borderTop: '2px solid #f5c518',
        boxShadow: '0 -8px 48px rgba(245,197,24,0.28), 0 -2px 16px rgba(245,197,24,0.14)',
        backdropFilter: 'blur(20px)',
        padding: '20px 20px 36px',
        direction: 'rtl',
        animation: 'bounty-slide-up 0.35s cubic-bezier(0.34,1.56,0.64,1)',
        fontFamily: 'Rajdhani, sans-serif',
        maxHeight: '82vh',
        overflowY: 'auto',
      }}>

        {/* Close ✕ */}
        <button
          onClick={() => { setSelected(null); setClaimResult(null); }}
          style={{
            position: 'absolute', top: '12px', left: '16px',
            background: 'none', border: 'none',
            color: 'rgba(255,255,255,0.35)', fontSize: '22px',
            cursor: 'pointer', padding: '4px', lineHeight: 1,
            transition: 'color 0.2s',
          }}
          onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
          onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.35)')}
        >×</button>

        {/* ── Mission header ── */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', marginBottom: '14px' }}>
          <div style={{ fontSize: '36px', lineHeight: 1, filter: 'drop-shadow(0 0 12px #f5c518)', flexShrink: 0 }}>⭐</div>
          <div style={{ flex: 1 }}>
            <div style={{
              fontFamily: 'Orbitron, sans-serif', fontSize: '8px',
              color: '#f5c518', letterSpacing: '0.2em', marginBottom: '4px',
            }}>⚡ BOUNTY MISSION · مهمة جائزة</div>
            <div style={{ fontSize: '19px', fontWeight: 800, color: '#fff', lineHeight: 1.25 }}>
              {selected.title}
            </div>
          </div>
        </div>

        {/* Description */}
        <div style={{
          fontSize: '14px', color: 'rgba(255,255,255,0.55)',
          lineHeight: 1.7, marginBottom: '16px',
          paddingBottom: '14px',
          borderBottom: '1px solid rgba(245,197,24,0.1)',
        }}>
          {selected.description}
        </div>

        {/* Reward */}
        <div style={{
          display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', marginBottom: '14px',
        }}>
          <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.4)' }}>قيمة الجائزة</div>
          <div style={{
            fontFamily: 'Orbitron, sans-serif', fontSize: '17px',
            color: '#f5c518', fontWeight: 700,
            textShadow: '0 0 16px #f5c51888, 0 0 32px #f5c51844',
          }}>
            🎁 {selected.reward.toLocaleString('ar-IQ')} دينار
          </div>
        </div>

        {/* ── Distance badge ── */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '10px',
          marginBottom: '14px', padding: '10px 14px',
          background: isClose
            ? 'rgba(0,220,100,0.07)'
            : locReady
            ? 'rgba(245,197,24,0.05)'
            : 'rgba(255,255,255,0.03)',
          border: `1px solid ${
            isClose   ? 'rgba(0,220,100,0.3)' :
            locReady  ? 'rgba(245,197,24,0.18)' :
                        'rgba(255,255,255,0.08)'
          }`,
          borderRadius: '3px',
        }}>
          {/* Pulse dot */}
          <div style={{
            width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
            background: isClose ? C.green : locReady ? C.yellow : 'rgba(255,255,255,0.25)',
            boxShadow: isClose ? `0 0 8px ${C.green}` : locReady ? `0 0 8px ${C.yellow}` : 'none',
            animation: locReady ? 'lf-ping 1.8s ease-in-out infinite' : 'none',
          }} />
          <div style={{ flex: 1 }}>
            <div style={{
              fontFamily: 'Orbitron, sans-serif', fontSize: '8px', letterSpacing: '0.12em',
              color: isClose ? C.green : locReady ? C.yellow : C.dim,
              marginBottom: '2px',
            }}>
              {isClose ? '✓ أنت داخل نطاق المهمة' : '📍 المسافة عن الهدف'}
            </div>

            {/* Distance value */}
            {gpsLoading && !locReady ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                <svg width="12" height="12" viewBox="0 0 28 28" fill="none"
                  style={{ animation: 'lf-spin 1s linear infinite', flexShrink: 0 }}>
                  <circle cx="14" cy="14" r="10" stroke={C.yellow}
                    strokeWidth="2.5" strokeDasharray="22 14" strokeLinecap="round"/>
                </svg>
                <span style={{ fontSize: '13px', color: C.dim }}>جاري تحديد موقعك بدقة...</span>
              </div>
            ) : !locReady ? (
              <div style={{ fontSize: '13px', color: C.dim }}>
                تعذّر الوصول إلى GPS — أعطِ التطبيق إذن الموقع
              </div>
            ) : (
              <div style={{ fontSize: '15px', fontWeight: 700, color: isClose ? C.green : '#fff' }}>
                {distStr}
                {!isClose && distM !== null && (
                  <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.3)', marginRight: '6px' }}>
                    — تحتاج أقل من {CLAIM_RADIUS_M} م للاستلام
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── Navigate button + travel info (only when location known & not close) ── */}
        {locReady && !isClose && !claimResult && (
          <div style={{ marginBottom: '14px' }}>

            {/* Navigate / Loading / Stop nav button */}
            {!navigating ? (
              <button
                onClick={handleNavigate}
                style={{
                  width: '100%', padding: '13px 16px',
                  background: 'rgba(0,212,255,0.09)',
                  border: `1px solid ${C.blue}66`,
                  color: C.blue,
                  fontFamily: 'Orbitron, sans-serif', fontSize: '11px',
                  letterSpacing: '0.14em', cursor: 'pointer',
                  borderRadius: '3px', transition: 'all 0.2s',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                  boxShadow: `0 0 14px ${C.blue}22`,
                  marginBottom: '10px',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.background = 'rgba(0,212,255,0.16)';
                  e.currentTarget.style.boxShadow  = `0 0 20px ${C.blue}44`;
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = 'rgba(0,212,255,0.09)';
                  e.currentTarget.style.boxShadow  = `0 0 14px ${C.blue}22`;
                }}
              >
                🧭 الذهاب إلى المهمة
              </button>
            ) : routeLoading ? (
              /* Loading state while fetching OSRM route */
              <div style={{
                width: '100%', padding: '13px 16px',
                background: 'rgba(0,212,255,0.05)',
                border: `1px solid ${C.blue}33`,
                borderRadius: '3px', marginBottom: '10px',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
              }}>
                <svg width="14" height="14" viewBox="0 0 28 28" fill="none"
                  style={{ animation: 'lf-spin 0.9s linear infinite', flexShrink: 0 }}>
                  <circle cx="14" cy="14" r="10" stroke={C.blue}
                    strokeWidth="2.5" strokeDasharray="22 14" strokeLinecap="round"/>
                </svg>
                <span style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '9px', color: C.blue, letterSpacing: '0.1em' }}>
                  جاري حساب المسار عبر الشوارع...
                </span>
              </div>
            ) : (
              <button
                onClick={handleStopNav}
                style={{
                  width: '100%', padding: '11px 16px',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  color: 'rgba(255,255,255,0.45)',
                  fontFamily: 'Orbitron, sans-serif', fontSize: '9px',
                  letterSpacing: '0.12em', cursor: 'pointer',
                  borderRadius: '3px', marginBottom: '10px',
                }}
              >
                ✕ إلغاء الملاحة
              </button>
            )}

            {/* ── Travel info card ── */}
            {(() => {
              // Prefer OSRM real-road data; fall back to haversine
              const useRoute  = routeInfo !== null;
              const showDist  = useRoute ? fmtDist(routeInfo!.distM) : distStr;
              const showMins  = useRoute
                ? Math.max(1, Math.round(routeInfo!.durationSec / 60))
                : minutes;
              const showMode  = useRoute ? '🚗 عبر الطريق الفعلي' : mode;
              if (!showDist || showMins === null) return null;
              return (
                <div>
                  {/* "Via road" badge — only when OSRM data is available */}
                  {useRoute && (
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: '6px',
                      marginBottom: '6px', padding: '5px 10px',
                      background: 'rgba(123,47,247,0.08)',
                      border: '1px solid rgba(123,47,247,0.28)',
                      borderRadius: '2px',
                    }}>
                      <span style={{ fontSize: '10px' }}>🗺️</span>
                      <span style={{
                        fontFamily: 'Orbitron, sans-serif', fontSize: '7px',
                        color: '#a78bfa', letterSpacing: '0.1em',
                      }}>مسار حقيقي عبر شبكة الطرق · OSRM ROUTING</span>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '8px' }}>
                    {/* Distance chip */}
                    <div style={{
                      flex: 1, padding: '8px 12px',
                      background: 'rgba(245,197,24,0.06)',
                      border: '1px solid rgba(245,197,24,0.18)',
                      borderRadius: '3px', textAlign: 'center',
                    }}>
                      <div style={{
                        fontFamily: 'Orbitron, sans-serif', fontSize: '7px',
                        color: 'rgba(245,197,24,0.55)', letterSpacing: '0.1em', marginBottom: '4px',
                      }}>المسافة {useRoute ? 'عبر الطريق' : 'الهوائية'}</div>
                      <div style={{
                        fontFamily: 'Orbitron, sans-serif', fontSize: '14px',
                        color: C.yellow, fontWeight: 700,
                      }}>{showDist}</div>
                    </div>
                    {/* Time chip */}
                    <div style={{
                      flex: 1, padding: '8px 12px',
                      background: 'rgba(0,212,255,0.05)',
                      border: '1px solid rgba(0,212,255,0.18)',
                      borderRadius: '3px', textAlign: 'center',
                    }}>
                      <div style={{
                        fontFamily: 'Orbitron, sans-serif', fontSize: '7px',
                        color: 'rgba(0,212,255,0.55)', letterSpacing: '0.1em', marginBottom: '4px',
                      }}>الوقت المتوقع</div>
                      <div style={{
                        fontFamily: 'Orbitron, sans-serif', fontSize: '14px',
                        color: C.blue, fontWeight: 700,
                      }}>~{showMins} دقيقة</div>
                      <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.25)', marginTop: '1px' }}>
                        {showMode}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* ── Claim result feedback ── */}
        {claimResult === 'success' && (
          <div style={{
            textAlign: 'center', padding: '16px',
            background: 'rgba(0,220,100,0.09)',
            border: '1px solid rgba(0,220,100,0.4)',
            borderRadius: '3px', marginBottom: '12px',
            animation: 'bounty-success 0.5s ease',
          }}>
            <div style={{ fontSize: '32px', marginBottom: '6px' }}>🎉</div>
            <div style={{
              fontFamily: 'Orbitron, sans-serif', fontSize: '11px',
              color: C.green, letterSpacing: '0.14em',
            }}>تهانينا! — استلمت الجائزة بنجاح</div>
          </div>
        )}

        {claimResult === 'taken' && (
          <div style={{
            textAlign: 'center', padding: '12px',
            background: 'rgba(255,45,80,0.07)',
            border: '1px solid rgba(255,45,80,0.35)',
            borderRadius: '3px', marginBottom: '12px',
          }}>
            <div style={{ fontSize: '22px', marginBottom: '4px' }}>⚡</div>
            <div style={{
              fontFamily: 'Orbitron, sans-serif', fontSize: '10px',
              color: C.red, letterSpacing: '0.1em',
            }}>سبقك شخص آخر — الجائزة محجوزة</div>
          </div>
        )}

        {claimResult === 'error' && (
          <div style={{
            textAlign: 'center', padding: '10px',
            background: 'rgba(255,45,80,0.07)',
            border: '1px solid rgba(255,45,80,0.3)',
            borderRadius: '3px', marginBottom: '12px',
          }}>
            <div style={{
              fontFamily: 'Orbitron, sans-serif', fontSize: '10px', color: C.red,
            }}>خطأ في الاتصال — حاول مرة أخرى</div>
          </div>
        )}

        {/* ── Claim button ── */}
        {!claimResult && (
          <button
            onClick={handleClaim}
            disabled={!isClose || claiming}
            style={{
              width: '100%', padding: '15px',
              background: isClose
                ? 'rgba(245,197,24,0.14)'
                : 'rgba(255,255,255,0.02)',
              border: `2px solid ${isClose ? C.yellow : 'rgba(255,255,255,0.08)'}`,
              color: isClose ? C.yellow : C.dimx,
              fontFamily: 'Orbitron, sans-serif', fontSize: '11px',
              letterSpacing: '0.14em',
              cursor: (isClose && !claiming) ? 'pointer' : 'not-allowed',
              borderRadius: '3px', transition: 'all 0.22s',
              animation: isClose && !claiming ? 'bounty-glow 2.2s ease-in-out infinite' : 'none',
              display: 'flex', alignItems: 'center',
              justifyContent: 'center', gap: '8px',
            }}
            onMouseEnter={e => {
              if (isClose && !claiming)
                (e.currentTarget as HTMLElement).style.background = 'rgba(245,197,24,0.24)';
            }}
            onMouseLeave={e => {
              if (isClose && !claiming)
                (e.currentTarget as HTMLElement).style.background = 'rgba(245,197,24,0.14)';
            }}
          >
            {claiming ? (
              <>
                <svg width="14" height="14" viewBox="0 0 28 28" fill="none"
                  style={{ animation: 'lf-spin 0.9s linear infinite' }}>
                  <circle cx="14" cy="14" r="10" stroke={C.yellow}
                    strokeWidth="2.5" strokeDasharray="22 14" strokeLinecap="round"/>
                </svg>
                جاري الاستلام...
              </>
            ) : isClose ? (
              '🎁 استلام الجائزة'
            ) : (
              '📍 اقترب من موقع المهمة للاستلام'
            )}
          </button>
        )}
      </div>
    </>
  );
}
