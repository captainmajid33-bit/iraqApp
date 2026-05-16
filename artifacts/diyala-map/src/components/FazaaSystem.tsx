/**
 * FazaaSystem — نظام فزعة ديالى التفاعلي
 * Peer-to-peer rescue system integrated with Leaflet map + Firestore
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
  | 'idle'
  | 'sheet'
  | 'waiting'
  | 'requester_helped'
  | 'detail'
  | 'helping';

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
  mapRef:            React.MutableRefObject<L.Map | null>;
  userLocation:      { lat: number; lng: number } | null;
  clearMapForRescue: () => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const ISSUES = [
  { key: 'flat_tire', label: 'تاير بنكت',          icon: '🚗' },
  { key: 'no_fuel',   label: 'خلص بنزين',           icon: '⛽' },
  { key: 'battery',   label: 'عطل بطارية/اشتراك',   icon: '⚡' },
  { key: 'tow',       label: 'سحب سيارة',            icon: '🚜' },
] as const;

const ISSUE_MAP: Record<string, string> = {
  flat_tire: '🚗 تاير بنكت',
  no_fuel:   '⛽ خلص بنزين',
  battery:   '⚡ عطل بطارية',
  tow:       '🚜 سحب سيارة',
};

const OSRM = 'https://router.project-osrm.org/route/v1/driving';

// ── Helpers ───────────────────────────────────────────────────────────────────
function getUser(): { uid?: string; name?: string; phone?: string } | null {
  try { return JSON.parse(localStorage.getItem('diyala_user') ?? 'null'); } catch { return null; }
}

function myId(): string {
  const u = getUser();
  return (u?.uid ?? u?.phone ?? '').trim();
}

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371, r = (d: number) => d * Math.PI / 180;
  const a = Math.sin(r(lat2-lat1)/2)**2 + Math.cos(r(lat1))*Math.cos(r(lat2))*Math.sin(r(lng2-lng1)/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function fetchRoute(fromLat: number, fromLng: number, toLat: number, toLng: number): Promise<RouteInfo | null> {
  try {
    const res = await fetch(`${OSRM}/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson`);
    const d   = await res.json();
    const rt  = d?.routes?.[0];
    if (!rt) return null;
    const coords = (rt.geometry.coordinates as [number,number][]).map(([lng, lat]) => [lat, lng] as [number, number]);
    return {
      distKm:      +(rt.distance / 1000).toFixed(2),
      durationMin: Math.max(1, Math.round(rt.duration / 60)),
      coords,
    };
  } catch (e) {
    console.warn('[Fazaa] OSRM error:', e);
    return null;
  }
}

// ── CSS injection (once) ───────────────────────────────────────────────────────
function injectFazaaCSS() {
  if (document.getElementById('fazaa-styles')) return;
  const s = document.createElement('style');
  s.id = 'fazaa-styles';
  s.textContent = `
    @keyframes fz-bob  { 0%,100%{transform:translateY(0) scale(1)} 50%{transform:translateY(-6px) scale(1.1)} }
    @keyframes fz-ring { 0%{transform:scale(0.5);opacity:0.9}       100%{transform:scale(2.8);opacity:0} }
    @keyframes fz-spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
    .fz-wrap { position:relative; animation:fz-bob 2s ease-in-out infinite; cursor:pointer; display:inline-block; }
    .fz-ring { position:absolute; top:50%; left:50%; width:48px; height:48px; margin:-24px 0 0 -24px;
               border-radius:50%; border:2.5px solid #ff2d78;
               animation:fz-ring 1.7s ease-out infinite; pointer-events:none; }
    .fz-ring2{ animation-delay:0.6s; }
  `;
  document.head.appendChild(s);
}

// ── Marker factory — L.divIcon only, no external images ──────────────────────
function makeFazaaIcon(): L.DivIcon {
  return L.divIcon({
    className:  '',   // prevent leaflet's default white-box class
    iconSize:   [90, 72],
    iconAnchor: [45, 72],
    html: `<div class="fz-wrap">
      <div class="fz-ring"></div>
      <div class="fz-ring fz-ring2"></div>
      <div style="
        background:rgba(200,20,50,0.93);
        border:2px solid #ff2d78;
        border-radius:10px;
        padding:5px 10px;
        font-family:'Tajawal','Arial',sans-serif;
        font-size:12px; font-weight:700;
        color:#fff; white-space:nowrap; direction:rtl;
        text-align:center;
        box-shadow:0 0 14px rgba(255,45,120,0.75),0 0 28px rgba(255,45,120,0.35);
      ">فزعة ياشباب! 🤝</div>
      <div style="font-size:24px;text-align:center;line-height:1.1;
                  filter:drop-shadow(0 0 6px rgba(255,45,120,0.9));">🚘</div>
      <div style="width:0;height:0;
                  border-left:9px solid transparent;
                  border-right:9px solid transparent;
                  border-top:11px solid rgba(200,20,50,0.93);
                  margin:0 auto;"></div>
    </div>`,
  });
}

// ── Component ─────────────────────────────────────────────────────────────────
export function FazaaSystem({ mapRef, userLocation, clearMapForRescue }: FazaaSystemProps) {

  // ── Map readiness — poll until mapRef.current is set ─────────────────────
  const [mapReady, setMapReady] = useState(false);
  useEffect(() => {
    if (mapRef.current) { setMapReady(true); return; }
    const iv = setInterval(() => {
      if (mapRef.current) { setMapReady(true); clearInterval(iv); }
    }, 250);
    return () => clearInterval(iv);
  }, [mapRef]);

  // ── State ─────────────────────────────────────────────────────────────────
  const [phase,         setPhase]         = useState<FazaaPhase>('idle');
  const [selectedIssue, setSelectedIssue] = useState('');
  const [submitting,    setSubmitting]    = useState(false);
  const [myRequestId,   setMyRequestId]   = useState<string | null>(null);
  const [activeFazaas,  setActiveFazaas]  = useState<FazaaDoc[]>([]);
  const [selected,      setSelected]      = useState<FazaaDoc | null>(null);
  const [routeInfo,     setRouteInfo]     = useState<RouteInfo | null>(null);
  const [calcRoute,     setCalcRoute]     = useState(false);
  const [helperInfo,    setHelperInfo]    = useState<{ name: string } | null>(null);
  const [liveInfo,      setLiveInfo]      = useState<{ distKm: number; durationMin: number } | null>(null);

  // ── Refs ──────────────────────────────────────────────────────────────────
  const rescueGlowRef   = useRef<L.Polyline | null>(null);
  const rescueLineRef   = useRef<L.Polyline | null>(null);
  const fazaaMarkersRef = useRef<Map<string, L.Marker>>(new Map());
  const rescueTargetRef = useRef<{ lat: number; lng: number } | null>(null);
  const listenerUnsub   = useRef<Unsubscribe | null>(null);
  const myDocUnsub      = useRef<Unsubscribe | null>(null);

  // ── CSS injection ─────────────────────────────────────────────────────────
  useEffect(() => { injectFazaaCSS(); }, []);

  // ── onSnapshot — listen for ALL active fazaa requests ────────────────────
  useEffect(() => {
    const unsub = onSnapshot(
      query(collection(db, 'fazaa_requests'), where('status', '==', 'active')),
      snap => {
        const docs: FazaaDoc[] = [];
        snap.forEach(d => {
          const raw = d.data();
          // ── FIX: always parse coordinates as numbers ──
          const lat = Number(raw.latitude);
          const lng = Number(raw.longitude);
          if (isNaN(lat) || isNaN(lng)) {
            console.warn('[Fazaa] bad coordinates for doc', d.id, raw.latitude, raw.longitude);
            return;
          }
          const fazaa: FazaaDoc = {
            id:        d.id,
            userId:    String(raw.userId   ?? ''),
            userName:  String(raw.userName ?? 'مستخدم'),
            userPhone: String(raw.userPhone ?? ''),
            issueType: String(raw.issueType ?? ''),
            latitude:  lat,
            longitude: lng,
            status:    raw.status ?? 'active',
          };
          docs.push(fazaa);
          console.log(`[Fazaa] 📍 active request: id=${d.id} issue=${fazaa.issueType} lat=${lat} lng=${lng} user=${fazaa.userName}`);
        });
        console.log(`[Fazaa] onSnapshot → ${docs.length} active request(s)`);
        setActiveFazaas(docs);
      },
      err => console.warn('[Fazaa] onSnapshot error:', err.code, err.message),
    );
    listenerUnsub.current = unsub;
    return () => unsub();
  }, []);

  // ── Draw / update map markers when fazaas or map readiness changes ────────
  useEffect(() => {
    if (!mapReady) { console.log('[Fazaa] map not ready yet, deferring markers'); return; }
    const map = mapRef.current;
    if (!map) return;

    const me = myId();
    const currentIds = new Set(activeFazaas.map(f => f.id));

    // Remove stale markers
    fazaaMarkersRef.current.forEach((marker, id) => {
      if (!currentIds.has(id)) {
        marker.remove();
        fazaaMarkersRef.current.delete(id);
        console.log('[Fazaa] removed stale marker:', id);
      }
    });

    // Add new markers
    activeFazaas.forEach(f => {
      if (f.userId === me) {
        console.log('[Fazaa] skipping own request:', f.id);
        return;
      }
      if (fazaaMarkersRef.current.has(f.id)) return; // already on map

      console.log(`[Fazaa] adding marker at [${f.latitude}, ${f.longitude}] for ${f.userName}`);
      try {
        const marker = L.marker([f.latitude, f.longitude], {
          icon:         makeFazaaIcon(),
          zIndexOffset: 2000,
          interactive:  true,
        }).addTo(map);

        marker.on('click', () => {
          console.log('[Fazaa] marker tapped:', f.id, f.issueType);
          setSelected(f);
          setRouteInfo(null);
          setCalcRoute(true);
          setPhase('detail');
        });

        fazaaMarkersRef.current.set(f.id, marker);
        console.log('[Fazaa] ✅ marker added successfully:', f.id);
      } catch (e) {
        console.error('[Fazaa] ❌ failed to add marker:', e);
      }
    });
  }, [activeFazaas, mapReady, mapRef]);

  // ── Calc OSRM route when detail sheet opens ───────────────────────────────
  useEffect(() => {
    if (!calcRoute || !selected || !userLocation) { setCalcRoute(false); return; }
    setCalcRoute(false);
    fetchRoute(userLocation.lat, userLocation.lng, selected.latitude, selected.longitude)
      .then(info => {
        setRouteInfo(info);
        if (info) console.log(`[Fazaa] route calc: ${info.distKm}km ${info.durationMin}min`);
      });
  }, [calcRoute, selected, userLocation]);

  // ── Live distance recalc as helper moves ─────────────────────────────────
  useEffect(() => {
    if (phase !== 'helping' || !userLocation || !rescueTargetRef.current) return;
    const t = rescueTargetRef.current;
    const km = haversine(userLocation.lat, userLocation.lng, t.lat, t.lng);
    setLiveInfo({ distKm: +km.toFixed(2), durationMin: Math.max(1, Math.round(km / 40 * 60)) });
  }, [userLocation, phase]);

  // ── Cleanup on unmount ────────────────────────────────────────────────────
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

  // ── Submit fazaa request ──────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    if (!selectedIssue || !userLocation) return;
    const user = getUser();
    if (!user) return;
    setSubmitting(true);
    try {
      const ref = await addDoc(collection(db, 'fazaa_requests'), {
        userId:    user.uid ?? user.phone ?? 'anon',
        userName:  user.name ?? 'مستخدم',
        userPhone: user.phone ?? '',
        issueType: selectedIssue,
        latitude:  userLocation.lat,   // stored as number
        longitude: userLocation.lng,
        status:    'active',
        timestamp: serverTimestamp(),
      });
      console.log('[Fazaa] created request:', ref.id);
      setMyRequestId(ref.id);
      setPhase('waiting');

      // Watch own doc for acceptance
      myDocUnsub.current?.();
      myDocUnsub.current = onSnapshot(doc(db, 'fazaa_requests', ref.id), snap => {
        const d = snap.data();
        if (d?.status === 'accepted') {
          console.log('[Fazaa] request accepted by:', d.helperName);
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

  // ── Accept fazaa (helper side) ────────────────────────────────────────────
  const handleAccept = useCallback(async () => {
    if (!selected || !userLocation) return;
    const user = getUser();
    if (!user) return;

    try {
      await updateDoc(doc(db, 'fazaa_requests', selected.id), {
        status:     'accepted',
        helperId:   user.uid ?? user.phone ?? 'anon',
        helperName: user.name ?? 'نشمي',
      });
      console.log('[Fazaa] accepted request:', selected.id);
    } catch (e) {
      console.error('[Fazaa] accept error:', e);
    }

    // Remove marker
    fazaaMarkersRef.current.get(selected.id)?.remove();
    fazaaMarkersRef.current.delete(selected.id);

    // Clear existing map layers
    clearMapForRescue();

    // Draw rescue route
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

  // ── Cancel waiting ────────────────────────────────────────────────────────
  const handleCancelWaiting = useCallback(async () => {
    if (myRequestId) {
      try { await updateDoc(doc(db, 'fazaa_requests', myRequestId), { status: 'cancelled' }); } catch { /* */ }
      myDocUnsub.current?.();
    }
    setMyRequestId(null);
    setPhase('idle');
  }, [myRequestId]);

  // ── Finish rescue ─────────────────────────────────────────────────────────
  const handleFinish = useCallback(() => {
    rescueGlowRef.current?.remove(); rescueGlowRef.current = null;
    rescueLineRef.current?.remove(); rescueLineRef.current = null;
    rescueTargetRef.current = null;
    setPhase('idle'); setSelected(null); setLiveInfo(null);
  }, []);

  const canRequest = Boolean(getUser() && userLocation);

  // ── JSX ───────────────────────────────────────────────────────────────────
  return (
    <>
      {/* ── Floating button (idle only) ── */}
      {phase === 'idle' && (
        <div style={{
          position:      'fixed',
          bottom:        '184px',
          right:         '20px',
          zIndex:        1200,
          display:       'flex',
          flexDirection: 'column',
          alignItems:    'center',
          gap:           '4px',
        }}>
          <button
            onClick={() => { if (canRequest) { setSelectedIssue(''); setPhase('sheet'); } }}
            title={canRequest ? 'اطلب مساعدة' : 'فعّل الموقع وسجّل دخولك أولاً'}
            style={{
              width:          '52px',
              height:         '52px',
              borderRadius:   '50%',
              background:     canRequest ? 'rgba(190,15,50,0.92)' : 'rgba(80,10,25,0.85)',
              border:         '2px solid rgba(255,60,90,0.65)',
              color:          '#fff',
              display:        'flex',
              alignItems:     'center',
              justifyContent: 'center',
              fontSize:       '22px',
              cursor:         canRequest ? 'pointer' : 'not-allowed',
              opacity:        canRequest ? 1 : 0.55,
              boxShadow:      canRequest
                ? '0 0 16px rgba(255,45,80,0.55), 0 0 32px rgba(255,45,80,0.2)'
                : '0 0 6px rgba(255,45,80,0.2)',
              backdropFilter: 'blur(12px)',
              transition:     'all 0.25s',
              position:       'relative',
            }}
          >
            🤝
          </button>
          <div style={{
            fontFamily:    'Orbitron, sans-serif',
            fontSize:      '7px',
            color:         canRequest ? 'rgba(255,100,120,0.85)' : 'rgba(255,100,120,0.4)',
            letterSpacing: '0.1em',
            textAlign:     'center',
          }}>
            FAZAA
          </div>
        </div>
      )}

      {/* ── Issue selection sheet ── */}
      {phase === 'sheet' && (
        <div style={S.overlay} onClick={() => setPhase('idle')}>
          <div style={S.sheet} onClick={e => e.stopPropagation()}>
            <div style={S.handle} />
            <div style={S.title}>اختر نوع المشكلة</div>
            <div style={S.sub}>سيصلك المساعدة من أقرب نشمي قريب 🤝</div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:'10px', justifyContent:'center', marginBottom:'20px' }}>
              {ISSUES.map(issue => (
                <button
                  key={issue.key}
                  onClick={() => setSelectedIssue(issue.key)}
                  style={{
                    padding:'12px 16px', minWidth:'130px', textAlign:'center',
                    background:   selectedIssue === issue.key ? 'rgba(255,45,80,0.28)' : 'rgba(255,255,255,0.05)',
                    border:       `2px solid ${selectedIssue === issue.key ? '#ff2d50' : 'rgba(255,255,255,0.12)'}`,
                    borderRadius: '12px',
                    color:        selectedIssue === issue.key ? '#ff8fa0' : '#ccc',
                    fontSize:'14px', fontFamily:"'Tajawal',sans-serif", fontWeight:600,
                    cursor:'pointer', direction:'rtl',
                    boxShadow: selectedIssue === issue.key ? '0 0 12px rgba(255,45,80,0.4)' : 'none',
                    transition:'all 0.18s',
                  }}
                >
                  <div style={{ fontSize:'26px', marginBottom:'4px' }}>{issue.icon}</div>
                  {issue.label}
                </button>
              ))}
            </div>
            <button
              onClick={handleSubmit}
              disabled={!selectedIssue || submitting}
              style={{
                width:'100%', padding:'14px',
                background: (!selectedIssue || submitting) ? 'rgba(255,45,80,0.22)' : 'rgba(255,45,80,0.9)',
                border:'1.5px solid rgba(255,80,100,0.6)', borderRadius:'10px',
                color:'#fff', fontSize:'15px',
                fontFamily:"'Tajawal',sans-serif", fontWeight:700,
                cursor: (!selectedIssue || submitting) ? 'not-allowed' : 'pointer',
                boxShadow:'0 0 16px rgba(255,45,80,0.4)', direction:'rtl',
              }}
            >
              {submitting ? '⟳ جاري الإرسال...' : '📡 إرسال الاستغاثة'}
            </button>
          </div>
        </div>
      )}

      {/* ── Waiting screen (requester) ── */}
      {phase === 'waiting' && (
        <div style={{ ...S.overlay, alignItems:'center', justifyContent:'center' }}>
          <div style={S.centerCard}>
            <div style={{ fontSize:'52px', marginBottom:'14px', animation:'fz-bob 2s ease-in-out infinite' }}>🤝</div>
            <div style={{ ...S.title, color:'#ff8fa0' }}>جاري نداء النشامى القريبين...</div>
            <div style={S.sub}>{ISSUE_MAP[selectedIssue] ?? selectedIssue}</div>
            <div style={{ display:'flex', justifyContent:'center', margin:'18px 0' }}>
              <div style={{
                width:'38px', height:'38px',
                border:'3px solid rgba(255,45,80,0.2)',
                borderTop:'3px solid #ff2d50',
                borderRadius:'50%',
                animation:'fz-spin 0.9s linear infinite',
              }} />
            </div>
            <button onClick={handleCancelWaiting} style={S.cancelBtn}>إلغاء الطلب</button>
          </div>
        </div>
      )}

      {/* ── Helper accepted notification (requester) ── */}
      {phase === 'requester_helped' && (
        <div style={{ ...S.overlay, alignItems:'center', justifyContent:'center' }} onClick={() => setPhase('idle')}>
          <div style={{ ...S.centerCard, border:'1px solid rgba(0,220,100,0.45)', boxShadow:'0 0 32px rgba(0,220,100,0.2)' }}>
            <div style={{ fontSize:'52px', marginBottom:'12px' }}>🚀</div>
            <div style={{ ...S.title, color:'#00dc64' }}>تم قبول فزعتك!</div>
            <div style={S.sub}>
              <strong style={{ color:'#7fffb0' }}>{helperInfo?.name ?? 'نشمي'}</strong>
              <br/>يتجه نحوك الآن — ابقَ في مكانك
            </div>
            <button style={{ ...S.cancelBtn, borderColor:'rgba(0,220,100,0.4)', color:'#00dc64' }}>حسناً ✓</button>
          </div>
        </div>
      )}

      {/* ── Detail sheet (helper tapped marker) ── */}
      {phase === 'detail' && selected && (
        <div style={S.overlay} onClick={() => { setPhase('idle'); setSelected(null); }}>
          <div style={S.sheet} onClick={e => e.stopPropagation()}>
            <div style={S.handle} />
            <div style={{ display:'flex', alignItems:'center', gap:'10px', marginBottom:'14px', direction:'rtl' }}>
              <span style={{ fontSize:'32px' }}>🤝</span>
              <div>
                <div style={S.title}>{selected.userName}</div>
                <div style={{ ...S.sub, marginBottom:0 }}>طلب مساعدة عاجل</div>
              </div>
            </div>
            <div style={S.row}><span style={S.rowLabel}>المشكلة</span><span style={S.rowVal}>{ISSUE_MAP[selected.issueType] ?? selected.issueType}</span></div>
            <div style={S.row}>
              <span style={S.rowLabel}>المسافة</span>
              {calcRoute
                ? <span style={{ color:'#888', fontSize:'13px' }}>جاري الحساب...</span>
                : routeInfo
                  ? <span style={S.rowVal}>{routeInfo.distKm} كم — {routeInfo.durationMin} دقيقة</span>
                  : userLocation
                    ? <span style={S.rowVal}>{haversine(userLocation.lat, userLocation.lng, selected.latitude, selected.longitude).toFixed(1)} كم (تقريبي)</span>
                    : <span style={{ color:'#888' }}>—</span>
              }
            </div>
            <button
              onClick={handleAccept}
              style={{
                width:'100%', padding:'15px', marginTop:'8px',
                background:'rgba(255,45,80,0.9)',
                border:'1.5px solid rgba(255,80,100,0.7)', borderRadius:'10px',
                color:'#fff', fontSize:'16px',
                fontFamily:"'Tajawal',sans-serif", fontWeight:700,
                cursor:'pointer', boxShadow:'0 0 20px rgba(255,45,80,0.5)', direction:'rtl',
              }}
            >
              🚀 قبول الفزعة — إفزع له!
            </button>
          </div>
        </div>
      )}

      {/* ── Active rescue info panel (helper) ── */}
      {phase === 'helping' && selected && (
        <div style={{
          position:'fixed', bottom:'84px', left:'50%', transform:'translateX(-50%)',
          zIndex:1300,
          background:'rgba(10,12,22,0.95)',
          border:'1.5px solid rgba(255,68,68,0.55)',
          borderRadius:'16px', padding:'14px 20px',
          minWidth:'280px', maxWidth:'360px',
          direction:'rtl',
          boxShadow:'0 0 24px rgba(255,68,68,0.3),0 4px 16px rgba(0,0,0,0.5)',
          backdropFilter:'blur(8px)',
        }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'10px' }}>
            <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
              <span style={{ fontSize:'18px' }}>🚨</span>
              <span style={{ color:'#ff4444', fontFamily:'Orbitron,sans-serif', fontSize:'10px', letterSpacing:'0.1em' }}>RESCUE ACTIVE</span>
            </div>
            <button onClick={handleFinish} style={{ background:'none', border:'none', color:'#555', cursor:'pointer', fontSize:'16px', padding:'0 4px' }}>✕</button>
          </div>
          <div style={{ color:'#ddd', fontSize:'13px', fontFamily:"'Tajawal',sans-serif", marginBottom:'10px' }}>
            {ISSUE_MAP[selected.issueType] ?? selected.issueType}
          </div>
          {liveInfo && (
            <div style={{ display:'flex', gap:'16px', marginBottom:'12px' }}>
              <div style={{ flex:1, textAlign:'center' }}>
                <div style={{ fontFamily:'Orbitron,sans-serif', fontSize:'20px', fontWeight:700, color:'#ff4444', lineHeight:1 }}>
                  {liveInfo.distKm} <span style={{ fontSize:'11px', color:'#ff8888' }}>كم</span>
                </div>
                <div style={{ fontFamily:"'Tajawal',sans-serif", fontSize:'11px', color:'rgba(255,255,255,0.4)', marginTop:'3px' }}>المسافة المتبقية</div>
              </div>
              <div style={{ flex:1, textAlign:'center' }}>
                <div style={{ fontFamily:'Orbitron,sans-serif', fontSize:'20px', fontWeight:700, color:'#ff4444', lineHeight:1 }}>
                  {liveInfo.durationMin} <span style={{ fontSize:'11px', color:'#ff8888' }}>دقيقة</span>
                </div>
                <div style={{ fontFamily:"'Tajawal',sans-serif", fontSize:'11px', color:'rgba(255,255,255,0.4)', marginTop:'3px' }}>الوقت المتوقع</div>
              </div>
            </div>
          )}
          {selected.userPhone && (
            <a href={`tel:${selected.userPhone}`} style={{
              display:'block', width:'100%', padding:'10px',
              background:'rgba(0,180,80,0.18)', border:'1px solid rgba(0,200,80,0.4)',
              borderRadius:'8px', color:'#00dc64', textAlign:'center',
              textDecoration:'none', fontSize:'13px',
              fontFamily:"'Tajawal',sans-serif", fontWeight:600, direction:'rtl',
            }}>
              📞 اتصال بطالب الفزعة ({selected.userName})
            </a>
          )}
        </div>
      )}
    </>
  );
}

// ── Shared style tokens ────────────────────────────────────────────────────────
const S = {
  overlay: {
    position:  'fixed', inset: 0,
    zIndex:    1250,
    background:'rgba(0,0,0,0.58)',
    display:   'flex', flexDirection:'column',
    alignItems:'flex-end', justifyContent:'flex-end',
    backdropFilter:'blur(2px)',
  } as React.CSSProperties,

  sheet: {
    background:   'rgba(8,10,20,0.98)',
    border:       '1px solid rgba(255,45,80,0.22)',
    borderRadius: '20px 20px 0 0',
    padding:      '20px 20px 36px',
    width:        '100%',
    maxHeight:    '85vh',
    overflowY:    'auto',
    direction:    'rtl',
    boxShadow:    '0 -8px 32px rgba(255,45,80,0.12)',
  } as React.CSSProperties,

  centerCard: {
    background:   'rgba(10,12,22,0.97)',
    border:       '1px solid rgba(255,45,80,0.38)',
    borderRadius: '20px',
    padding:      '36px 28px',
    textAlign:    'center',
    maxWidth:     '320px',
    width:        '90%',
    direction:    'rtl',
  } as React.CSSProperties,

  handle: {
    width:'40px', height:'4px',
    background:'rgba(255,255,255,0.14)',
    borderRadius:'2px', margin:'0 auto 18px',
  } as React.CSSProperties,

  title: {
    fontFamily:"'Tajawal','Orbitron',sans-serif",
    fontSize:'18px', fontWeight:700,
    color:'#fff', marginBottom:'6px',
  } as React.CSSProperties,

  sub: {
    fontFamily:"'Tajawal',sans-serif",
    fontSize:'13px', color:'rgba(255,255,255,0.5)',
    marginBottom:'18px', lineHeight:1.7,
  } as React.CSSProperties,

  cancelBtn: {
    marginTop:'12px', width:'100%', padding:'10px',
    background:'transparent',
    border:'1px solid rgba(255,45,80,0.32)',
    borderRadius:'8px', color:'#ff8fa0',
    fontSize:'13px', fontFamily:"'Tajawal',sans-serif",
    cursor:'pointer', direction:'rtl',
  } as React.CSSProperties,

  row: {
    display:'flex', justifyContent:'space-between', alignItems:'center',
    padding:'10px 0', borderBottom:'1px solid rgba(255,255,255,0.07)',
  } as React.CSSProperties,

  rowLabel: {
    fontFamily:"'Tajawal',sans-serif",
    fontSize:'13px', color:'rgba(255,255,255,0.42)',
  } as React.CSSProperties,

  rowVal: {
    fontFamily:"'Tajawal',sans-serif",
    fontSize:'14px', fontWeight:600, color:'#fff',
  } as React.CSSProperties,
};
