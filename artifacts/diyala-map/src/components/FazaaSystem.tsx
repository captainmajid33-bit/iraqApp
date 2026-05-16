/**
 * FazaaSystem — نظام فزعة ديالى التفاعلي
 * Peer-to-peer rescue system integrated with the main Leaflet map + Firestore
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import {
  collection, query, where, onSnapshot, addDoc, updateDoc, doc,
  serverTimestamp, Unsubscribe,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';

// ── Types ─────────────────────────────────────────────────────────────────────
type FazaaPhase =
  | 'idle'               // nothing active
  | 'sheet'              // requester: issue selection sheet
  | 'waiting'            // requester: waiting for a helper
  | 'requester_helped'   // requester: helper accepted, showing info
  | 'detail'             // helper: tapped a marker, showing detail sheet
  | 'helping';           // helper: accepted, rescue route on map

interface FazaaDoc {
  id:         string;
  userId:     string;
  userName:   string;
  userPhone:  string;
  issueType:  string;
  latitude:   number;
  longitude:  number;
  status:     'active' | 'accepted';
  helperId?:  string;
  helperName?: string;
}

interface RouteInfo {
  distKm:      number;
  durationMin: number;
  coords:      [number, number][];
}

interface FazaaSystemProps {
  mapRef:           React.MutableRefObject<L.Map | null>;
  userLocation:     { lat: number; lng: number } | null;
  clearMapForRescue: () => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const ISSUES = [
  { key: 'flat_tire', label: 'تاير بنكت',         icon: '🚗' },
  { key: 'no_fuel',   label: 'خلص بنزين',          icon: '⛽' },
  { key: 'battery',   label: 'عطل بطارية/اشتراك',  icon: '⚡' },
  { key: 'tow',       label: 'سحب سيارة',           icon: '🚜' },
] as const;

const ISSUE_MAP: Record<string, string> = {
  flat_tire: '🚗 تاير بنكت',
  no_fuel:   '⛽ خلص بنزين',
  battery:   '⚡ عطل بطارية',
  tow:       '🚜 سحب سيارة',
};

const OSRM = 'https://router.project-osrm.org/route/v1/driving';

function getUser(): { uid: string; name: string; phone: string } | null {
  try { return JSON.parse(localStorage.getItem('diyala_user') ?? 'null'); } catch { return null; }
}

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371, r = (d: number) => d * Math.PI / 180;
  const a = Math.sin(r(lat2-lat1)/2)**2 + Math.cos(r(lat1))*Math.cos(r(lat2))*Math.sin(r(lng2-lng1)/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function fetchRoute(
  fromLat: number, fromLng: number,
  toLat:   number, toLng:   number,
): Promise<RouteInfo | null> {
  try {
    const r = await fetch(`${OSRM}/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson`);
    const d = await r.json();
    const rt = d?.routes?.[0];
    if (!rt) return null;
    const coords = (rt.geometry.coordinates as [number,number][]).map(([lng,lat]) => [lat,lng] as [number,number]);
    return {
      distKm:      +(rt.distance / 1000).toFixed(2),
      durationMin: Math.max(1, Math.round(rt.duration / 60)),
      coords,
    };
  } catch { return null; }
}

// ── CSS injection (once) ───────────────────────────────────────────────────────
const CSS_ID = 'fazaa-styles';
function injectFazaaCSS() {
  if (document.getElementById(CSS_ID)) return;
  const s = document.createElement('style');
  s.id = CSS_ID;
  s.textContent = `
    @keyframes fazaa-bob {
      0%,100% { transform: translateY(0) scale(1); }
      50%      { transform: translateY(-5px) scale(1.08); }
    }
    @keyframes fazaa-ring {
      0%   { transform: scale(0.6); opacity: 0.9; }
      100% { transform: scale(2.6); opacity: 0; }
    }
    .fazaa-wrap {
      position: relative;
      animation: fazaa-bob 2s ease-in-out infinite;
      cursor: pointer;
    }
    .fazaa-ring {
      position: absolute;
      top: 50%; left: 50%;
      width: 44px; height: 44px;
      margin: -22px 0 0 -22px;
      border-radius: 50%;
      border: 2.5px solid #ff2d78;
      animation: fazaa-ring 1.6s ease-out infinite;
      pointer-events: none;
    }
    .fazaa-ring2 {
      animation-delay: 0.55s;
    }
  `;
  document.head.appendChild(s);
}

function makeFazaaMarkerIcon(): L.DivIcon {
  return L.divIcon({
    className: '',
    iconSize:  [80, 70],
    iconAnchor:[40, 70],
    html: `
      <div class="fazaa-wrap">
        <div class="fazaa-ring"></div>
        <div class="fazaa-ring fazaa-ring2"></div>
        <div style="
          background: rgba(255,45,120,0.92);
          border: 2px solid #ff2d78;
          border-radius: 8px;
          padding: 4px 8px;
          text-align: center;
          box-shadow: 0 0 14px rgba(255,45,120,0.7), 0 0 28px rgba(255,45,120,0.35);
          font-family: 'Tajawal', 'Arial', sans-serif;
          font-size: 11px;
          font-weight: 700;
          color: #fff;
          white-space: nowrap;
          direction: rtl;
        ">فزعة ياشباب! 🤝</div>
        <div style="
          margin: 3px auto 0;
          font-size: 22px;
          text-align: center;
          line-height: 1;
          filter: drop-shadow(0 0 6px rgba(255,45,120,0.8));
        ">🚘</div>
        <div style="
          width: 0; height: 0;
          border-left: 8px solid transparent;
          border-right: 8px solid transparent;
          border-top: 10px solid rgba(255,45,120,0.92);
          margin: 0 auto;
          filter: drop-shadow(0 2px 4px rgba(255,45,120,0.5));
        "></div>
      </div>`,
  });
}

// ── Component ─────────────────────────────────────────────────────────────────
export function FazaaSystem({ mapRef, userLocation, clearMapForRescue }: FazaaSystemProps) {
  const [phase,         setPhase]         = useState<FazaaPhase>('idle');
  const [selectedIssue, setSelectedIssue] = useState<string>('');
  const [submitting,    setSubmitting]    = useState(false);
  const [myRequestId,   setMyRequestId]   = useState<string | null>(null);
  const [activeFazaas,  setActiveFazaas]  = useState<FazaaDoc[]>([]);
  const [selected,      setSelected]      = useState<FazaaDoc | null>(null);
  const [routeInfo,     setRouteInfo]     = useState<RouteInfo | null>(null);
  const [calcRoute,     setCalcRoute]     = useState(false);
  const [helperInfo,    setHelperInfo]    = useState<{ name: string } | null>(null);

  // Rescue route refs
  const rescueGlowRef  = useRef<L.Polyline | null>(null);
  const rescueLineRef  = useRef<L.Polyline | null>(null);
  const fazaaMarkersRef = useRef<Map<string, L.Marker>>(new Map());

  // Live distance for helper panel
  const rescueTargetRef = useRef<{ lat: number; lng: number } | null>(null);
  const [liveInfo, setLiveInfo] = useState<{ distKm: number; durationMin: number } | null>(null);

  // Unsubscribers
  const listenerUnsub = useRef<Unsubscribe | null>(null);
  const myDocUnsub    = useRef<Unsubscribe | null>(null);

  // Inject CSS once
  useEffect(() => { injectFazaaCSS(); }, []);

  // ── Live distance update for helper ────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'helping' || !userLocation || !rescueTargetRef.current) return;
    const t = rescueTargetRef.current;
    const km = haversine(userLocation.lat, userLocation.lng, t.lat, t.lng);
    setLiveInfo({ distKm: +km.toFixed(2), durationMin: Math.max(1, Math.round(km / 40 * 60)) });
  }, [userLocation, phase]);

  // ── onSnapshot: listen for ALL active fazaa requests ───────────────────────
  useEffect(() => {
    const unsub = onSnapshot(
      query(collection(db, 'fazaa_requests'), where('status', '==', 'active')),
      snap => {
        const docs: FazaaDoc[] = [];
        snap.forEach(d => docs.push({ id: d.id, ...(d.data() as any) }));
        setActiveFazaas(docs);
      },
      err => console.warn('[Fazaa] onSnapshot error:', err),
    );
    listenerUnsub.current = unsub;
    return () => unsub();
  }, []);

  // ── Draw / remove markers when activeFazaas changes ───────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const user = getUser();
    const myId = user?.uid ?? user?.phone ?? '';

    // Build set of current IDs
    const currentIds = new Set(activeFazaas.map(f => f.id));

    // Remove stale markers
    fazaaMarkersRef.current.forEach((marker, id) => {
      if (!currentIds.has(id)) { marker.remove(); fazaaMarkersRef.current.delete(id); }
    });

    // Add new markers (not my own request)
    activeFazaas.forEach(f => {
      if (f.userId === myId) return; // skip own request
      if (fazaaMarkersRef.current.has(f.id)) return; // already drawn

      const marker = L.marker([f.latitude, f.longitude], {
        icon:          makeFazaaMarkerIcon(),
        zIndexOffset:  2000,
        interactive:   true,
      }).addTo(map);

      marker.on('click', () => {
        setSelected(f);
        setRouteInfo(null);
        setCalcRoute(true);
        setPhase('detail');
      });

      fazaaMarkersRef.current.set(f.id, marker);
    });
  }, [activeFazaas, mapRef]);

  // ── Calc route when detail sheet opens ────────────────────────────────────
  useEffect(() => {
    if (!calcRoute || !selected || !userLocation) { setCalcRoute(false); return; }
    setCalcRoute(false);
    fetchRoute(userLocation.lat, userLocation.lng, selected.latitude, selected.longitude)
      .then(info => setRouteInfo(info));
  }, [calcRoute, selected, userLocation]);

  // ── Cleanup map layers on unmount ─────────────────────────────────────────
  useEffect(() => {
    return () => {
      fazaaMarkersRef.current.forEach(m => m.remove());
      fazaaMarkersRef.current.clear();
      rescueGlowRef.current?.remove();
      rescueLineRef.current?.remove();
      listenerUnsub.current?.();
      myDocUnsub.current?.();
    };
  }, []);

  // ── Submit a fazaa request ─────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    if (!selectedIssue || !userLocation) return;
    const user = getUser();
    if (!user) return;
    setSubmitting(true);
    try {
      const ref = await addDoc(collection(db, 'fazaa_requests'), {
        userId:    user.uid ?? user.phone,
        userName:  user.name ?? 'مستخدم',
        userPhone: user.phone ?? '',
        issueType: selectedIssue,
        latitude:  userLocation.lat,
        longitude: userLocation.lng,
        status:    'active',
        timestamp: serverTimestamp(),
      });
      setMyRequestId(ref.id);
      setPhase('waiting');

      // Watch own doc for status change
      myDocUnsub.current?.();
      myDocUnsub.current = onSnapshot(doc(db, 'fazaa_requests', ref.id), snap => {
        const d = snap.data();
        if (d?.status === 'accepted') {
          setHelperInfo({ name: d.helperName ?? 'نشمي' });
          setPhase('requester_helped');
          myDocUnsub.current?.();
        }
      });
    } catch (e) {
      console.error('[Fazaa] submit error:', e);
    } finally {
      setSubmitting(false);
    }
  }, [selectedIssue, userLocation]);

  // ── Accept a fazaa (helper) ────────────────────────────────────────────────
  const handleAccept = useCallback(async () => {
    if (!selected || !userLocation) return;
    const user = getUser();
    if (!user) return;

    // 1) Update Firestore
    await updateDoc(doc(db, 'fazaa_requests', selected.id), {
      status:     'accepted',
      helperId:   user.uid ?? user.phone,
      helperName: user.name ?? 'نشمي',
    });

    // 2) Remove this marker from map
    fazaaMarkersRef.current.get(selected.id)?.remove();
    fazaaMarkersRef.current.delete(selected.id);

    // 3) Clear existing taxi/route on map
    clearMapForRescue();

    // 4) Draw rescue route
    const map = mapRef.current;
    if (map) {
      const info = routeInfo ?? await fetchRoute(
        userLocation.lat, userLocation.lng, selected.latitude, selected.longitude
      );
      if (info) {
        rescueGlowRef.current?.remove();
        rescueLineRef.current?.remove();
        rescueGlowRef.current = L.polyline(info.coords, {
          color: '#ff4444', weight: 16, opacity: 0.18, lineCap: 'round', lineJoin: 'round',
        }).addTo(map);
        rescueLineRef.current = L.polyline(info.coords, {
          color: '#ff4444', weight: 4.5, opacity: 1, lineCap: 'round', lineJoin: 'round',
        }).addTo(map);
        map.fitBounds(L.latLngBounds(info.coords), { padding: [80, 80] });
        setLiveInfo({ distKm: info.distKm, durationMin: info.durationMin });
      }
    }

    rescueTargetRef.current = { lat: selected.latitude, lng: selected.longitude };
    setPhase('helping');
  }, [selected, userLocation, routeInfo, mapRef, clearMapForRescue]);

  // ── Cancel / finish rescue ─────────────────────────────────────────────────
  const handleFinish = useCallback(() => {
    rescueGlowRef.current?.remove(); rescueGlowRef.current = null;
    rescueLineRef.current?.remove(); rescueLineRef.current = null;
    rescueTargetRef.current = null;
    setPhase('idle');
    setSelected(null);
    setLiveInfo(null);
  }, []);

  // ── Cancel own waiting request ─────────────────────────────────────────────
  const handleCancelWaiting = useCallback(async () => {
    if (!myRequestId) { setPhase('idle'); return; }
    try {
      await updateDoc(doc(db, 'fazaa_requests', myRequestId), { status: 'accepted' }); // deactivate
    } catch { /* */ }
    myDocUnsub.current?.();
    setMyRequestId(null);
    setPhase('idle');
  }, [myRequestId]);

  const user = getUser();
  const canRequest = Boolean(user && userLocation);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      {/* ── Floating "طلب فزعة" button ── */}
      {(phase === 'idle') && (
        <button
          onClick={() => {
            if (!canRequest) return;
            setSelectedIssue('');
            setPhase('sheet');
          }}
          style={{
            position:     'fixed',
            bottom:       '90px',
            left:         '16px',
            zIndex:       1200,
            display:      'flex',
            alignItems:   'center',
            gap:          '7px',
            padding:      '10px 16px',
            background:   'rgba(200, 20, 60, 0.92)',
            border:       '1.5px solid rgba(255,80,110,0.7)',
            borderRadius: '28px',
            color:        '#fff',
            fontFamily:   "'Tajawal', 'Orbitron', sans-serif",
            fontSize:     '13px',
            fontWeight:   700,
            cursor:       canRequest ? 'pointer' : 'not-allowed',
            opacity:      canRequest ? 1 : 0.6,
            boxShadow:    '0 0 18px rgba(255,45,80,0.55), 0 2px 8px rgba(0,0,0,0.4)',
            direction:    'rtl',
            transition:   'all 0.2s',
            backdropFilter: 'blur(4px)',
          }}
          title={canRequest ? 'اطلب مساعدة' : 'فعّل الموقع أولاً'}
        >
          🤝 طلب فزعة
        </button>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          REQUESTER — Issue selection sheet
      ═══════════════════════════════════════════════════════════════════ */}
      {phase === 'sheet' && (
        <div style={overlayBg} onClick={() => setPhase('idle')}>
          <div style={sheet} onClick={e => e.stopPropagation()}>
            <div style={sheetHandle} />
            <div style={sheetTitle}>اختر نوع المشكلة</div>
            <div style={sheetSub}>سيصلك المساعدة من أقرب نشمي قريب 🤝</div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', justifyContent: 'center', marginBottom: '20px' }}>
              {ISSUES.map(issue => (
                <button
                  key={issue.key}
                  onClick={() => setSelectedIssue(issue.key)}
                  style={{
                    padding:      '12px 18px',
                    background:   selectedIssue === issue.key
                      ? 'rgba(255,45,80,0.25)'
                      : 'rgba(255,255,255,0.05)',
                    border:       `2px solid ${selectedIssue === issue.key ? '#ff2d50' : 'rgba(255,255,255,0.12)'}`,
                    borderRadius: '12px',
                    color:        selectedIssue === issue.key ? '#ff8fa0' : '#ccc',
                    fontSize:     '14px',
                    fontFamily:   "'Tajawal', sans-serif",
                    fontWeight:   600,
                    cursor:       'pointer',
                    direction:    'rtl',
                    minWidth:     '130px',
                    textAlign:    'center',
                    transition:   'all 0.18s',
                    boxShadow:    selectedIssue === issue.key ? '0 0 12px rgba(255,45,80,0.4)' : 'none',
                  }}
                >
                  <div style={{ fontSize: '24px', marginBottom: '4px' }}>{issue.icon}</div>
                  {issue.label}
                </button>
              ))}
            </div>

            <button
              onClick={handleSubmit}
              disabled={!selectedIssue || submitting}
              style={{
                width:        '100%',
                padding:      '14px',
                background:   (!selectedIssue || submitting) ? 'rgba(255,45,80,0.25)' : 'rgba(255,45,80,0.88)',
                border:       '1.5px solid rgba(255,80,100,0.6)',
                borderRadius: '10px',
                color:        '#fff',
                fontSize:     '15px',
                fontFamily:   "'Tajawal', sans-serif",
                fontWeight:   700,
                cursor:       (!selectedIssue || submitting) ? 'not-allowed' : 'pointer',
                boxShadow:    '0 0 16px rgba(255,45,80,0.4)',
                direction:    'rtl',
              }}
            >
              {submitting ? '⟳ جاري الإرسال...' : '📡 إرسال الاستغاثة'}
            </button>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          REQUESTER — Waiting screen
      ═══════════════════════════════════════════════════════════════════ */}
      {phase === 'waiting' && (
        <div style={{ ...overlayBg, alignItems: 'center', justifyContent: 'center' }}>
          <div style={{
            background:   'rgba(10,12,22,0.97)',
            border:       '1px solid rgba(255,45,80,0.4)',
            borderRadius: '20px',
            padding:      '36px 32px',
            textAlign:    'center',
            maxWidth:     '320px',
            width:        '90%',
            direction:    'rtl',
          }}>
            <div style={{ fontSize: '48px', marginBottom: '16px', animation: 'fazaa-bob 2s ease-in-out infinite' }}>🤝</div>
            <div style={waitingTitle}>جاري نداء النشامى القريبين...</div>
            <div style={waitingSub}>
              {selectedIssue && ISSUE_MAP[selectedIssue]}<br />
              انتظر — سيصلك نشمي بسرعة إن شاء الله
            </div>
            <Spinner />
            <button onClick={handleCancelWaiting} style={cancelBtn}>إلغاء الطلب</button>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          REQUESTER — Helper accepted! notification
      ═══════════════════════════════════════════════════════════════════ */}
      {phase === 'requester_helped' && (
        <div style={{ ...overlayBg, alignItems: 'center', justifyContent: 'center' }} onClick={() => setPhase('idle')}>
          <div style={{
            background:   'rgba(10,12,22,0.97)',
            border:       '1px solid rgba(0,220,100,0.5)',
            borderRadius: '20px',
            padding:      '36px 32px',
            textAlign:    'center',
            maxWidth:     '320px',
            width:        '90%',
            direction:    'rtl',
            boxShadow:    '0 0 32px rgba(0,220,100,0.25)',
          }}>
            <div style={{ fontSize: '52px', marginBottom: '12px' }}>🚀</div>
            <div style={{ ...waitingTitle, color: '#00dc64' }}>تم قبول فزعتك!</div>
            <div style={waitingSub}>
              <strong style={{ color: '#7fffb0' }}>{helperInfo?.name ?? 'نشمي'}</strong>
              <br />يتجه نحوك الآن — ابقَ في مكانك
            </div>
            <button style={{ ...cancelBtn, borderColor: 'rgba(0,220,100,0.4)', color: '#00dc64' }}>
              حسناً ✓
            </button>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          HELPER — Detail sheet (tapped a marker)
      ═══════════════════════════════════════════════════════════════════ */}
      {phase === 'detail' && selected && (
        <div style={overlayBg} onClick={() => { setPhase('idle'); setSelected(null); }}>
          <div style={sheet} onClick={e => e.stopPropagation()}>
            <div style={sheetHandle} />
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px', direction: 'rtl' }}>
              <span style={{ fontSize: '32px' }}>🤝</span>
              <div>
                <div style={sheetTitle}>طلب فزعة</div>
                <div style={{ ...sheetSub, marginBottom: 0 }}>{selected.userName}</div>
              </div>
            </div>

            {/* Issue type */}
            <div style={detailRow}>
              <span style={detailLabel}>المشكلة</span>
              <span style={detailVal}>{ISSUE_MAP[selected.issueType] ?? selected.issueType}</span>
            </div>

            {/* Distance + duration */}
            <div style={detailRow}>
              <span style={detailLabel}>المسافة</span>
              {calcRoute
                ? <span style={{ color: '#888', fontSize: '13px' }}>جاري الحساب...</span>
                : routeInfo
                  ? <span style={detailVal}>{routeInfo.distKm} كم — {routeInfo.durationMin} دقيقة</span>
                  : userLocation
                    ? <span style={detailVal}>
                        {haversine(userLocation.lat, userLocation.lng, selected.latitude, selected.longitude).toFixed(1)} كم (تقريبي)
                      </span>
                    : <span style={{ color: '#888' }}>—</span>
              }
            </div>

            <button
              onClick={handleAccept}
              style={{
                width:        '100%',
                padding:      '15px',
                marginTop:    '8px',
                background:   'rgba(255,45,80,0.9)',
                border:       '1.5px solid rgba(255,80,100,0.7)',
                borderRadius: '10px',
                color:        '#fff',
                fontSize:     '16px',
                fontFamily:   "'Tajawal', sans-serif",
                fontWeight:   700,
                cursor:       'pointer',
                boxShadow:    '0 0 20px rgba(255,45,80,0.5)',
                direction:    'rtl',
              }}
            >
              🚀 قبول الفزعة — إفزع له!
            </button>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          HELPER — Active rescue info panel
      ═══════════════════════════════════════════════════════════════════ */}
      {phase === 'helping' && selected && (
        <div style={{
          position:  'fixed',
          bottom:    '80px',
          left:      '50%',
          transform: 'translateX(-50%)',
          zIndex:    1300,
          background: 'rgba(10,12,22,0.95)',
          border:    '1.5px solid rgba(255,68,68,0.6)',
          borderRadius: '16px',
          padding:   '14px 20px',
          minWidth:  '280px',
          maxWidth:  '360px',
          direction: 'rtl',
          boxShadow: '0 0 24px rgba(255,68,68,0.35), 0 4px 16px rgba(0,0,0,0.5)',
          backdropFilter: 'blur(8px)',
        }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '20px' }}>🚨</span>
              <span style={{ color: '#ff4444', fontFamily: 'Orbitron, sans-serif', fontSize: '11px', letterSpacing: '0.1em' }}>
                RESCUE ACTIVE
              </span>
            </div>
            <button onClick={handleFinish} style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: '16px', padding: '2px 6px' }}>✕</button>
          </div>

          {/* Issue */}
          <div style={{ color: '#ddd', fontSize: '13px', fontFamily: "'Tajawal', sans-serif", marginBottom: '8px' }}>
            {ISSUE_MAP[selected.issueType] ?? selected.issueType}
          </div>

          {/* Live distance */}
          {liveInfo && (
            <div style={{ display: 'flex', gap: '20px', marginBottom: '12px' }}>
              <div style={statBox}>
                <div style={statVal}>{liveInfo.distKm} <span style={statUnit}>كم</span></div>
                <div style={statLabel}>المسافة المتبقية</div>
              </div>
              <div style={statBox}>
                <div style={statVal}>{liveInfo.durationMin} <span style={statUnit}>دقيقة</span></div>
                <div style={statLabel}>الوقت المتوقع</div>
              </div>
            </div>
          )}

          {/* Call button */}
          {selected.userPhone && (
            <a
              href={`tel:${selected.userPhone}`}
              style={{
                display:      'block',
                width:        '100%',
                padding:      '10px',
                background:   'rgba(0,180,80,0.18)',
                border:       '1px solid rgba(0,200,80,0.45)',
                borderRadius: '8px',
                color:        '#00dc64',
                textAlign:    'center',
                textDecoration: 'none',
                fontSize:     '13px',
                fontFamily:   "'Tajawal', sans-serif",
                fontWeight:   600,
                direction:    'rtl',
              }}
            >
              📞 اتصال بطالب الفزعة ({selected.userName})
            </a>
          )}
        </div>
      )}
    </>
  );
}

// ── Spinner ────────────────────────────────────────────────────────────────────
function Spinner() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', margin: '20px 0' }}>
      <div style={{
        width:  '40px', height: '40px',
        border: '3px solid rgba(255,45,80,0.2)',
        borderTop: '3px solid #ff2d50',
        borderRadius: '50%',
        animation: 'fazaa-bob 0.8s linear infinite',
      }} />
    </div>
  );
}

// ── Shared styles ─────────────────────────────────────────────────────────────
const overlayBg: React.CSSProperties = {
  position:  'fixed', inset: 0,
  zIndex:    1250,
  background: 'rgba(0,0,0,0.55)',
  display:   'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  justifyContent: 'flex-end',
  backdropFilter: 'blur(2px)',
};

const sheet: React.CSSProperties = {
  background:   'rgba(8,10,20,0.98)',
  border:       '1px solid rgba(255,45,80,0.25)',
  borderRadius: '20px 20px 0 0',
  padding:      '20px 20px 36px',
  width:        '100%',
  maxHeight:    '85vh',
  overflowY:    'auto',
  direction:    'rtl',
  boxShadow:    '0 -8px 32px rgba(255,45,80,0.15)',
};

const sheetHandle: React.CSSProperties = {
  width:        '40px', height: '4px',
  background:   'rgba(255,255,255,0.15)',
  borderRadius: '2px',
  margin:       '0 auto 18px',
};

const sheetTitle: React.CSSProperties = {
  fontFamily:   "'Tajawal', 'Orbitron', sans-serif",
  fontSize:     '18px', fontWeight: 700,
  color:        '#fff',
  marginBottom: '6px',
};

const sheetSub: React.CSSProperties = {
  fontFamily:   "'Tajawal', sans-serif",
  fontSize:     '13px',
  color:        'rgba(255,255,255,0.5)',
  marginBottom: '18px',
};

const waitingTitle: React.CSSProperties = {
  fontFamily: "'Tajawal', 'Orbitron', sans-serif",
  fontSize:   '17px', fontWeight: 700,
  color:      '#ff8fa0',
  marginBottom: '10px',
};

const waitingSub: React.CSSProperties = {
  fontFamily: "'Tajawal', sans-serif",
  fontSize:   '14px',
  color:      'rgba(255,255,255,0.55)',
  lineHeight: 1.8,
  marginBottom: '8px',
};

const cancelBtn: React.CSSProperties = {
  marginTop:    '14px',
  width:        '100%',
  padding:      '10px',
  background:   'transparent',
  border:       '1px solid rgba(255,45,80,0.35)',
  borderRadius: '8px',
  color:        '#ff8fa0',
  fontSize:     '13px',
  fontFamily:   "'Tajawal', sans-serif",
  cursor:       'pointer',
  direction:    'rtl',
};

const detailRow: React.CSSProperties = {
  display:       'flex',
  justifyContent: 'space-between',
  alignItems:    'center',
  padding:       '10px 0',
  borderBottom:  '1px solid rgba(255,255,255,0.07)',
};

const detailLabel: React.CSSProperties = {
  fontFamily: "'Tajawal', sans-serif",
  fontSize:   '13px',
  color:      'rgba(255,255,255,0.45)',
};

const detailVal: React.CSSProperties = {
  fontFamily: "'Tajawal', sans-serif",
  fontSize:   '14px',
  fontWeight: 600,
  color:      '#fff',
};

const statBox: React.CSSProperties = {
  flex:      1,
  textAlign: 'center',
};

const statVal: React.CSSProperties = {
  fontFamily: 'Orbitron, sans-serif',
  fontSize:   '20px', fontWeight: 700,
  color:      '#ff4444',
  lineHeight: 1,
};

const statUnit: React.CSSProperties = {
  fontSize:   '11px',
  fontFamily: "'Tajawal', sans-serif",
  color:      '#ff8888',
};

const statLabel: React.CSSProperties = {
  fontFamily: "'Tajawal', sans-serif",
  fontSize:   '11px',
  color:      'rgba(255,255,255,0.4)',
  marginTop:  '4px',
};
