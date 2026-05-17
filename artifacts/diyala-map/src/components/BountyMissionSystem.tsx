/**
 * BountyMissionSystem v2 — مطاردة الكنوز المزدوجة
 * Firestore collection: 'bounties'
 * Each pair = 2 docs sharing pairId (isFake: false = real, isFake: true = fake)
 * - Identical markers for both; countdown overlays above each
 * - 15m GPS radius to claim
 * - Fake → funny red popup; Real → Firestore transaction, top-3 winners
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import {
  collection, onSnapshot, query, where,
  runTransaction, doc, serverTimestamp,
  arrayUnion, updateDoc, Timestamp, getDoc,
} from 'firebase/firestore';
import { db, auth } from '@/lib/firebase';

// ── Types ──────────────────────────────────────────────────────────────────────
interface BountyDoc {
  id:            string;
  pairId:        string;
  isFake:        boolean;
  sponsor_name:  string;
  title:         string;
  first_reward:  string;
  second_reward: string;
  third_reward:  string;
  fake_message:  string;
  secret_answer: string;
  winners_log:   WinnerEntry[];
  expiresAt:     Timestamp;
  status:        'active' | 'closed' | 'expired';
  latitude:      number;
  longitude:     number;
}

interface WinnerEntry {
  uid:       string;
  name:      string;
  rank:      number;
  claimedAt: any;
}

interface Props {
  mapRef:       React.MutableRefObject<L.Map | null>;
  userLocation: { lat: number; lng: number } | null;
  isDay?:       boolean;
  filterActive?:    boolean;
  markersVisible?:  boolean;
}

// ── Constants ──────────────────────────────────────────────────────────────────
const CLAIM_RADIUS_M = 15;
const CL = {
  yellow: '#f5c518',
  green:  '#00dc64',
  red:    '#ff2d50',
  blue:   '#00d4ff',
  gold:   '#FFD700',
  silver: '#C0C0C0',
  bronze: '#CD7F32',
  dim:    'rgba(255,255,255,0.35)',
};

// ── Helpers ────────────────────────────────────────────────────────────────────
function haversineMeters(la1: number, lo1: number, la2: number, lo2: number): number {
  const R = 6_371_000;
  const r = (d: number) => (d * Math.PI) / 180;
  const dLa = r(la2 - la1), dLo = r(lo2 - lo1);
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(r(la1)) * Math.cos(r(la2)) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function fmtDist(m: number) { return m < 1000 ? `${Math.round(m)} م` : `${(m / 1000).toFixed(1)} كم`; }

function fmtMmSs(ms: number): string {
  if (ms <= 0) return '00:00';
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function getUser() {
  try { return JSON.parse(localStorage.getItem('diyala_user') ?? 'null') as { name?: string; phone?: string } | null; }
  catch { return null; }
}

function getVisitedFakes(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem('diyala_fakes') ?? '[]') as string[]); }
  catch { return new Set(); }
}

function markFakeVisited(id: string) {
  const s = getVisitedFakes(); s.add(id);
  localStorage.setItem('diyala_fakes', JSON.stringify([...s]));
}

function makeMissionIcon(): L.DivIcon {
  return L.divIcon({
    className: '',
    iconSize: [54, 54],
    iconAnchor: [27, 27],
    html: `<div style="width:54px;height:54px;position:relative;display:flex;align-items:center;justify-content:center;cursor:pointer;">
      <div style="position:absolute;inset:-4px;border-radius:50%;background:#f5c518;opacity:0.10;animation:lf-ping 1.8s cubic-bezier(0,0,0.2,1) infinite;"></div>
      <div style="position:absolute;inset:-10px;border-radius:50%;background:#f5c518;opacity:0.05;animation:lf-ping 1.8s cubic-bezier(0,0,0.2,1) infinite;animation-delay:0.5s;"></div>
      <div style="animation:bms-pulse 2s ease-in-out infinite;">
        <svg width="46" height="46" viewBox="0 0 46 46" fill="none">
          <polygon points="23,2 43,23 23,44 3,23" fill="#f5c51818" stroke="#f5c518" stroke-width="2"/>
          <polygon points="23,10 36,23 23,36 10,23" fill="#f5c518" opacity="0.85"/>
          <text x="23" y="28" text-anchor="middle" font-size="13" fill="#0a0d14" font-weight="900" font-family="Arial">★</text>
        </svg>
      </div>
    </div>`,
  });
}

// ── Component ──────────────────────────────────────────────────────────────────
export function BountyMissionSystem({
  mapRef, userLocation, isDay = false, filterActive = false, markersVisible = false,
}: Props) {
  const [mapReady,    setMapReady]    = useState(false);
  const [bounties,    setBounties]    = useState<BountyDoc[]>([]);
  const [selected,    setSelected]    = useState<BountyDoc | null>(null);
  const [distM,       setDistM]       = useState<number | null>(null);
  const [claiming,    setClaiming]    = useState(false);
  const [phase, setPhase] = useState<'idle'|'question'|'fake'|'rank1'|'rank2'|'rank3'|'full'|'error'>('idle');
  const [answerInput,  setAnswerInput]  = useState('');
  const [answerError,  setAnswerError]  = useState('');
  const [gpsLoading,  setGpsLoading]  = useState(false);
  const [internalPos, setInternalPos] = useState<{lat:number;lng:number}|null>(null);
  const [overlays,    setOverlays]    = useState<Array<{id:string;x:number;y:number;ms:number}>>([]);

  const [navLoading,  setNavLoading]  = useState(false);

  // ── Pre-ad selection dialog state ─────────────────────────────────────────
  const [preAdSelected, setPreAdSelected] = useState<BountyDoc | null>(null);
  const [skipToast,     setSkipToast]     = useState('');
  const [skipBusy,      setSkipBusy]      = useState(false);

  const markersRef  = useRef<Map<string, L.Marker>>(new Map());
  const gpsWatchRef = useRef<number | null>(null);
  const bountiesRef = useRef<BountyDoc[]>([]); // stable ref to avoid stale closure in transaction
  const navGlowRef  = useRef<L.Polyline | null>(null);
  const navLineRef  = useRef<L.Polyline | null>(null);

  const pos = userLocation ?? internalPos;

  // ── Wait for map ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (mapRef.current) { setMapReady(true); return; }
    const iv = setInterval(() => { if (mapRef.current) { setMapReady(true); clearInterval(iv); } }, 250);
    return () => clearInterval(iv);
  }, [mapRef]);

  // ── Firestore listener ─────────────────────────────────────────────────────
  useEffect(() => {
    const q = query(collection(db, 'bounties'), where('status', '==', 'active'));
    const unsub = onSnapshot(q, snap => {
      const visited = getVisitedFakes();
      const docs: BountyDoc[] = [];
      snap.forEach(d => {
        const raw = d.data();
        const lat = Number(raw.latitude), lng = Number(raw.longitude);
        if (isNaN(lat) || isNaN(lng)) return;
        if (raw.isFake && visited.has(d.id)) return; // already visited fake for this user
        docs.push({
          id:            d.id,
          pairId:        String(raw.pairId ?? d.id),
          isFake:        Boolean(raw.isFake),
          sponsor_name:  String(raw.sponsor_name ?? ''),
          title:         String(raw.title ?? 'مهمة كنز'),
          first_reward:  String(raw.first_reward ?? ''),
          second_reward: String(raw.second_reward ?? ''),
          third_reward:  String(raw.third_reward ?? ''),
          fake_message:  String(raw.fake_message ?? 'أكلت المقلب خوية! 😂 اركض للموقع الثاني بسرعة!'),
          secret_answer: String(raw.secret_answer ?? ''),
          winners_log:   Array.isArray(raw.winners_log) ? raw.winners_log : [],
          expiresAt:     raw.expiresAt as Timestamp,
          status:        raw.status,
          latitude:      lat,
          longitude:     lng,
        });
      });
      setBounties(docs);
    }, err => console.warn('[BountyV2] snapshot:', err.message));
    return () => unsub();
  }, []);

  // ── Draw markers ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current; if (!map) return;

    // ── Strict Visibility Lock: markers hidden until user watches the ad ──────
    if (filterActive || !markersVisible) {
      markersRef.current.forEach(m => m.remove());
      markersRef.current.clear();
      return;
    }

    const ids = new Set(bounties.map(b => b.id));
    markersRef.current.forEach((m, id) => { if (!ids.has(id)) { m.remove(); markersRef.current.delete(id); } });

    bounties.forEach(b => {
      if (markersRef.current.has(b.id)) return;
      const marker = L.marker([b.latitude, b.longitude], { icon: makeMissionIcon(), zIndexOffset: 2000 }).addTo(map);
      marker.on('click', () => { setPreAdSelected(b); });
      markersRef.current.set(b.id, marker);
    });
  }, [bounties, mapReady, mapRef, filterActive, markersVisible]);

  // ── Countdown overlays ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapReady) return;
    const updateOverlays = () => {
      const map = mapRef.current; if (!map) return;
      const now = Date.now();
      const next: Array<{id:string;x:number;y:number;ms:number}> = [];
      bounties.forEach(b => {
        if (!b.expiresAt || filterActive || !markersVisible) return;
        const ms = b.expiresAt.toMillis() - now;
        if (ms <= 0) {
          updateDoc(doc(db, 'bounties', b.id), { status: 'expired' }).catch(() => {});
          return;
        }
        const marker = markersRef.current.get(b.id); if (!marker) return;
        const pt = map.latLngToContainerPoint([b.latitude, b.longitude]);
        next.push({ id: b.id, x: pt.x, y: pt.y, ms });
      });
      setOverlays(next);
    };
    updateOverlays();
    const iv = setInterval(updateOverlays, 1000);
    const map = mapRef.current;
    if (map) map.on('move zoom resize', updateOverlays);
    return () => {
      clearInterval(iv);
      if (map) map.off('move zoom resize', updateOverlays);
    };
  }, [bounties, mapReady, mapRef, filterActive, markersVisible]);

  // ── Sync selected ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!selected) return;
    const upd = bounties.find(b => b.id === selected.id);
    setSelected(upd ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounties]);

  // ── GPS watch ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!selected) {
      if (gpsWatchRef.current !== null) { navigator.geolocation?.clearWatch(gpsWatchRef.current); gpsWatchRef.current = null; }
      setInternalPos(null); setGpsLoading(false); return;
    }
    if (userLocation || !navigator.geolocation) return;
    setGpsLoading(true);
    gpsWatchRef.current = navigator.geolocation.watchPosition(
      p => { setInternalPos({ lat: p.coords.latitude, lng: p.coords.longitude }); setGpsLoading(false); },
      () => setGpsLoading(false),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 3000 },
    );
    return () => { if (gpsWatchRef.current !== null) { navigator.geolocation.clearWatch(gpsWatchRef.current); gpsWatchRef.current = null; } };
  }, [selected, userLocation]);

  // ── Distance ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!selected || !pos) { setDistM(null); return; }
    setDistM(haversineMeters(pos.lat, pos.lng, selected.latitude, selected.longitude));
  }, [selected, pos]);

  // ── Keep bountiesRef in sync (stable ref for transaction) ─────────────────
  useEffect(() => { bountiesRef.current = bounties; }, [bounties]);

  // ── Clear nav route polylines ──────────────────────────────────────────────
  const clearNavRoute = useCallback(() => {
    navGlowRef.current?.remove(); navGlowRef.current = null;
    navLineRef.current?.remove(); navLineRef.current = null;
  }, []);

  // ── Cleanup nav route on unmount ──────────────────────────────────────────
  useEffect(() => () => clearNavRoute(), [clearNavRoute]);

  // ── Navigate to mission: close sheet → draw OSRM road route → fitBounds ──
  const goToMission = useCallback(async () => {
    if (!pos || !selected || !mapRef.current) return;
    clearNavRoute();
    setNavLoading(true);

    // Close bottom sheet so map is fully visible
    setSelected(null);
    setPhase('idle');

    const map = mapRef.current;
    const { lat: uLat, lng: uLng } = pos;
    const { latitude: dLat, longitude: dLng } = selected;

    try {
      const url =
        `https://router.project-osrm.org/route/v1/driving/` +
        `${uLng},${uLat};${dLng},${dLat}` +
        `?overview=full&geometries=geojson`;
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error('osrm');
      const data = await res.json();
      const coords: [number, number][] = (data.routes?.[0]?.geometry?.coordinates ?? [])
        .map(([lng, lat]: [number, number]) => [lat, lng]);

      if (coords.length >= 2) {
        // Outer glow
        navGlowRef.current = L.polyline(coords, {
          color: '#f5c518', weight: 11, opacity: 0.16, lineCap: 'round', lineJoin: 'round',
        }).addTo(map);
        // Main neon gold line
        navLineRef.current = L.polyline(coords, {
          color: '#f5c518', weight: 3.5, opacity: 0.95,
          dashArray: '10 5', lineCap: 'round', lineJoin: 'round',
        }).addTo(map);

        // Destination pin
        const destIcon = L.divIcon({
          className: '',
          iconSize: [36, 36], iconAnchor: [18, 36],
          html: `<div style="width:36px;height:36px;display:flex;align-items:center;justify-content:center;
            background:#f5c51820;border:2px solid #f5c518;border-radius:50% 50% 50% 0;
            transform:rotate(-45deg);box-shadow:0 0 18px #f5c518aa;">
            <span style="transform:rotate(45deg);font-size:16px;">⭐</span></div>`,
        });
        L.marker([dLat, dLng], { icon: destIcon, zIndexOffset: 3000 }).addTo(map);

        // Fit both endpoints in view with 60 px padding
        map.fitBounds(
          L.latLngBounds([[uLat, uLng], [dLat, dLng]]),
          { padding: [60, 60], animate: true, duration: 1.0 },
        );
      }
    } catch {
      // Fallback: straight line if OSRM fails
      navGlowRef.current = L.polyline([[uLat, uLng], [dLat, dLng]], {
        color: '#f5c518', weight: 9, opacity: 0.14,
      }).addTo(map);
      navLineRef.current = L.polyline([[uLat, uLng], [dLat, dLng]], {
        color: '#f5c518', weight: 2.5, opacity: 0.85, dashArray: '6 5',
      }).addTo(map);
      map.fitBounds(
        L.latLngBounds([[uLat, uLng], [dLat, dLng]]),
        { padding: [60, 60], animate: true, duration: 1.0 },
      );
    } finally {
      setNavLoading(false);
    }
  }, [pos, selected, mapRef, clearNavRoute]);

  // ── Open question dialog when user clicks claim ─────────────────────────
  const openQuestion = useCallback(() => {
    setAnswerInput('');
    setAnswerError('');
    setPhase('question');
  }, []);

  // ── Submit answer — handles both fake + real validation ─────────────────
  const handleSubmitAnswer = useCallback(async () => {
    if (!selected || claiming) return;

    // ── FAKE location: ignore the answer entirely → prank screen ──────────
    if (selected.isFake) {
      markFakeVisited(selected.id);
      markersRef.current.get(selected.id)?.remove();
      markersRef.current.delete(selected.id);
      setPhase('fake');
      return;
    }

    // ── REAL location: validate secret_answer ─────────────────────────────
    const trimmed = answerInput.trim().toLowerCase();
    const correct = selected.secret_answer.trim().toLowerCase();
    if (correct && trimmed !== correct) {
      setAnswerError('لتكتب جواب من يمك روح اسئل الموظف شنو جواب السؤال وكتبه');
      return;
    }

    // ── Correct answer → Firestore transaction ────────────────────────────
    const user  = getUser();
    const uid   = auth.currentUser?.uid ?? user?.phone ?? user?.name ?? 'anonymous';
    const uname = user?.name ?? uid;
    setClaiming(true);
    try {
      let rank = 0;
      // Stable snapshot of bounties for finding the fake sibling
      const fakeSibling = bountiesRef.current.find(
        b => b.pairId === selected.pairId && b.isFake,
      );
      await runTransaction(db, async txn => {
        const ref  = doc(db, 'bounties', selected.id);
        const snap = await txn.get(ref);
        if (!snap.exists() || snap.data()?.status !== 'active') throw new Error('closed');
        const log: WinnerEntry[] = snap.data()?.winners_log ?? [];
        if (log.length >= 3) throw new Error('full');
        rank = log.length + 1;
        const entry: WinnerEntry = { uid, name: uname, rank, claimedAt: serverTimestamp() };
        const upd: Record<string, any> = { winners_log: arrayUnion(entry) };
        if (rank === 3) {
          // ── شرط الاختفاء الفوري: أغلق المهمتين معاً عند الفائز الثالث ──
          upd.status = 'closed';
          txn.update(ref, upd);
          if (fakeSibling) {
            txn.update(doc(db, 'bounties', fakeSibling.id), { status: 'closed' });
          }
        } else {
          txn.update(ref, upd);
        }
      });
      setPhase(rank === 1 ? 'rank1' : rank === 2 ? 'rank2' : 'rank3');
    } catch (e: any) {
      setPhase(e?.message === 'full' || e?.message === 'closed' ? 'full' : 'error');
    } finally {
      setClaiming(false);
    }
  }, [selected, claiming, answerInput]);

  const closeSheet = () => {
    setSelected(null);
    setPhase('idle');
    setDistM(null);
    setAnswerInput('');
    setAnswerError('');
  };

  // ── Pre-ad: watch ad (free) → go straight to mission sheet ───────────────
  const handleWatchAd = useCallback(() => {
    if (!preAdSelected) return;
    const bounty = preAdSelected;
    setPreAdSelected(null);
    setSelected(bounty);
    setPhase('idle');
  }, [preAdSelected]);

  // ── Pre-ad: skip ad by paying 1000 IQD ───────────────────────────────────
  const handleSkipWithPayment = useCallback(async () => {
    if (!preAdSelected || skipBusy) return;
    const bounty = preAdSelected;

    const userObj  = getUser();
    const uid      = auth.currentUser?.uid ?? userObj?.phone ?? userObj?.name ?? '';
    if (!uid) {
      setSkipToast('لم يتم التعرف على حسابك. سجّل الدخول أولاً.');
      setTimeout(() => setSkipToast(''), 3500);
      return;
    }

    setSkipBusy(true);
    try {
      // ── Check current balance ────────────────────────────────────────────
      const userRef  = doc(db, 'users', uid);
      const snap     = await getDoc(userRef);
      const balance  = snap.exists() ? (Number(snap.data()?.balance) || 0) : 0;

      if (balance < 1000) {
        setSkipToast(`رصيدك الحالي (${balance.toLocaleString()} د.ع) غير كافٍ لتخطي الإعلان! يرجى اختيار المشاهدة المجانية 💸`);
        setTimeout(() => setSkipToast(''), 4000);
        setSkipBusy(false);
        return;
      }

      // ── Deduct 1000 via transaction ──────────────────────────────────────
      await runTransaction(db, async txn => {
        const fresh = await txn.get(userRef);
        const bal   = fresh.exists() ? (Number(fresh.data()?.balance) || 0) : 0;
        if (bal < 1000) throw new Error('insufficient');
        txn.update(userRef, { balance: bal - 1000 });
      });

      // ── Open mission sheet directly (ad skipped) ─────────────────────────
      setPreAdSelected(null);
      setSelected(bounty);
      setPhase('idle');
    } catch (e: any) {
      if (e?.message === 'insufficient') {
        setSkipToast('رصيدك أقل من 1000 د.ع. اختر المشاهدة المجانية 💸');
        setTimeout(() => setSkipToast(''), 4000);
      } else {
        setSkipToast('حدث خطأ، حاول مرة أخرى.');
        setTimeout(() => setSkipToast(''), 3000);
      }
    } finally {
      setSkipBusy(false);
    }
  }, [preAdSelected, skipBusy]);

  if (!mapReady) return null;

  const isClose  = distM !== null && distM <= CLAIM_RADIUS_M;
  const locReady = pos !== null;
  const selMs    = selected?.expiresAt ? selected.expiresAt.toMillis() - Date.now() : null;

  return (
    <>
      <style>{`
        @keyframes bms-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.08)}}
        @keyframes bms-up{from{transform:translateY(100%)}to{transform:translateY(0)}}
        @keyframes bms-pop{0%{transform:scale(0.5);opacity:0}60%{transform:scale(1.15)}100%{transform:scale(1);opacity:1}}
        @keyframes bms-blink{0%,100%{opacity:1}50%{opacity:0.5}}
        @keyframes bms-gold{0%,100%{box-shadow:0 0 30px #FFD70099,0 0 60px #FFD70033}50%{box-shadow:0 0 50px #FFD700cc,0 0 80px #FFD70055}}
        @keyframes bms-silver{0%,100%{box-shadow:0 0 30px #C0C0C099}50%{box-shadow:0 0 50px #C0C0C0cc}}
        @keyframes bms-bronze{0%,100%{box-shadow:0 0 30px #CD7F3299}50%{box-shadow:0 0 50px #CD7F32cc}}
      `}</style>

      {/* ── Pre-Ad Selection Dialog ── */}
      {preAdSelected && (
        <PreAdDialog
          bounty={preAdSelected}
          skipBusy={skipBusy}
          toast={skipToast}
          onSkip={handleSkipWithPayment}
          onWatchAd={handleWatchAd}
          onDismiss={() => setPreAdSelected(null)}
        />
      )}

      {/* ── Skip-toast snackbar (shown inside dialog) ── */}
      {!preAdSelected && skipToast && (
        <div style={{
          position: 'fixed', bottom: '100px', left: '50%', transform: 'translateX(-50%)',
          zIndex: 4500, padding: '11px 20px',
          background: 'rgba(255,45,120,0.14)',
          border: '1px solid rgba(255,45,120,0.55)',
          color: '#ff2d78',
          fontFamily: 'Rajdhani, sans-serif', fontSize: '14px', fontWeight: 600,
          borderRadius: '6px', direction: 'rtl', textAlign: 'center',
          boxShadow: '0 0 24px rgba(255,45,120,0.25)',
          maxWidth: '340px', whiteSpace: 'pre-wrap',
          animation: 'bms-pop 0.3s ease',
        }}>
          ⚠ {skipToast}
        </div>
      )}

      {/* ── Countdown overlays ── */}
      {!filterActive && overlays.map(o => (
        <div key={o.id} style={{
          position: 'absolute', left: o.x, top: o.y - 66,
          transform: 'translateX(-50%)',
          zIndex: 1800, pointerEvents: 'none',
          background: 'rgba(10,13,20,0.92)',
          border: `1px solid ${CL.yellow}88`,
          borderRadius: '20px', padding: '3px 10px',
          display: 'flex', alignItems: 'center', gap: '5px',
          boxShadow: `0 0 12px ${CL.yellow}44`,
          backdropFilter: 'blur(4px)',
          animation: o.ms < 60_000 ? 'bms-blink 1s ease-in-out infinite' : 'none',
        }}>
          <span style={{ fontSize: '9px' }}>⏰</span>
          <span style={{
            fontFamily: 'Orbitron, monospace', fontSize: '11px', fontWeight: 700,
            letterSpacing: '0.08em',
            color: o.ms < 60_000 ? CL.red : o.ms < 300_000 ? CL.yellow : CL.green,
          }}>
            {fmtMmSs(o.ms)}
          </span>
        </div>
      ))}

      {/* ── Bottom Sheet ── */}
      {selected && (
        <>
          <div onClick={closeSheet} style={{ position:'absolute',inset:0,zIndex:3000,background:'rgba(0,0,0,0.55)',backdropFilter:'blur(3px)' }} />
          <div style={{
            position:'absolute',bottom:0,left:0,right:0,zIndex:3001,
            background: isDay ? 'rgba(248,249,252,0.99)' : 'rgba(5,8,15,0.99)',
            borderTop:`2px solid ${CL.yellow}`,
            boxShadow:`0 -8px 48px ${CL.yellow}28`,
            backdropFilter:'blur(20px)',
            padding:'20px 20px 44px',
            direction:'rtl', fontFamily:'Rajdhani, sans-serif',
            maxHeight:'84vh', overflowY:'auto',
            animation:'bms-up 0.35s cubic-bezier(0.34,1.56,0.64,1)',
          }}>
            <button onClick={closeSheet} style={{ position:'absolute',top:'12px',left:'16px',background:'none',border:'none',color:'rgba(255,255,255,0.3)',fontSize:'22px',cursor:'pointer' }}>×</button>

            {/* ── Result Screens ── */}
            {phase === 'question' && (
              <QuestionScreen
                isFake={selected.isFake}
                answer={answerInput}
                error={answerError}
                claiming={claiming}
                onChange={v => { setAnswerInput(v); setAnswerError(''); }}
                onSubmit={handleSubmitAnswer}
                onBack={() => { setPhase('idle'); setAnswerInput(''); setAnswerError(''); }}
              />
            )}
            {phase === 'fake' && <FakeScreen msg={selected.fake_message} onClose={closeSheet} />}
            {phase === 'rank1' && <WinScreen rank={1} reward={selected.first_reward} sponsor={selected.sponsor_name} onClose={closeSheet} />}
            {phase === 'rank2' && <WinScreen rank={2} reward={selected.second_reward} sponsor={selected.sponsor_name} onClose={closeSheet} />}
            {phase === 'rank3' && <WinScreen rank={3} reward={selected.third_reward} sponsor={selected.sponsor_name} onClose={closeSheet} />}
            {phase === 'full'  && <FullScreen onClose={closeSheet} />}
            {phase === 'error' && (
              <div style={{ textAlign:'center', padding:'20px' }}>
                <div style={{ fontSize:'32px',marginBottom:'8px' }}>⚠️</div>
                <div style={{ color:CL.red, fontFamily:'Orbitron, sans-serif', fontSize:'11px' }}>حدث خطأ — حاول مجدداً</div>
                <button onClick={() => setPhase('idle')} style={{ marginTop:'14px',padding:'8px 20px',background:`${CL.red}15`,border:`1px solid ${CL.red}55`,color:CL.red,borderRadius:'3px',cursor:'pointer',fontFamily:'Orbitron, sans-serif',fontSize:'9px' }}>إعادة المحاولة</button>
              </div>
            )}

            {/* ── Main Info (idle) ── */}
            {phase === 'idle' && (
              <>
                {/* Header */}
                <div style={{ display:'flex',alignItems:'flex-start',gap:'12px',marginBottom:'14px' }}>
                  <div style={{ fontSize:'34px',lineHeight:1,filter:`drop-shadow(0 0 12px ${CL.yellow})`,flexShrink:0 }}>⭐</div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontFamily:'Orbitron, sans-serif',fontSize:'8px',color:CL.yellow,letterSpacing:'0.2em',marginBottom:'3px' }}>⚡ BOUNTY HUNT · مطاردة الكنز</div>
                    <div style={{ fontSize:'18px',fontWeight:800,color:isDay?'#0d1117':'#fff',lineHeight:1.25 }}>{selected.title}</div>
                    <div style={{ fontSize:'12px',color:CL.dim,marginTop:'2px' }}>
                      راعي المهمة: <strong style={{ color:CL.yellow }}>{selected.sponsor_name}</strong>
                    </div>
                  </div>
                </div>

                {/* Countdown in sheet */}
                {selMs !== null && selMs > 0 && (
                  <div style={{ display:'flex',alignItems:'center',justifyContent:'center',gap:'12px',marginBottom:'14px',padding:'12px 16px',background:`${CL.yellow}08`,border:`1px solid ${CL.yellow}33`,borderRadius:'8px' }}>
                    <span style={{ fontSize:'18px' }}>⏰</span>
                    <div>
                      <div style={{ fontFamily:'Orbitron, sans-serif',fontSize:'8px',color:CL.dim,letterSpacing:'0.1em',marginBottom:'3px' }}>الوقت المتبقي</div>
                      <LiveCountdown expiresAt={selected.expiresAt} />
                    </div>
                  </div>
                )}
                {selMs !== null && selMs <= 0 && (
                  <div style={{ textAlign:'center',padding:'12px',background:`${CL.red}10`,border:`1px solid ${CL.red}44`,borderRadius:'6px',marginBottom:'14px',color:CL.red,fontFamily:'Orbitron, sans-serif',fontSize:'10px' }}>
                    ⚠ انتهت مدة المهمة
                  </div>
                )}

                {/* Top-3 Prizes */}
                <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:'8px',marginBottom:'14px' }}>
                  {[
                    { emoji:'🥇',label:'الأول',val:selected.first_reward,color:CL.gold },
                    { emoji:'🥈',label:'الثاني',val:selected.second_reward,color:CL.silver },
                    { emoji:'🥉',label:'الثالث',val:selected.third_reward,color:CL.bronze },
                  ].map(p => (
                    <div key={p.label} style={{ padding:'10px 8px',background:`${p.color}0C`,border:`1px solid ${p.color}44`,borderRadius:'8px',textAlign:'center' }}>
                      <div style={{ fontSize:'20px',marginBottom:'4px' }}>{p.emoji}</div>
                      <div style={{ fontFamily:'Rajdhani, sans-serif',fontSize:'12px',color:p.color,fontWeight:700,lineHeight:1.3 }}>{p.val||'—'}</div>
                      <div style={{ fontSize:'9px',color:CL.dim,marginTop:'2px' }}>المركز {p.label}</div>
                    </div>
                  ))}
                </div>

                {/* Winners count bar */}
                <div style={{ display:'flex',alignItems:'center',gap:'8px',marginBottom:'14px',padding:'8px 12px',background:`${CL.yellow}06`,border:`1px solid ${CL.yellow}22`,borderRadius:'4px' }}>
                  <span style={{ fontSize:'14px' }}>🏆</span>
                  <span style={{ fontFamily:'Rajdhani, sans-serif',fontSize:'13px',color:CL.dim }}>
                    الفائزون حتى الآن: <strong style={{ color:CL.yellow }}>{selected.winners_log.length} / 3</strong>
                  </span>
                  <div style={{ flex:1, height:'4px', background:'rgba(255,255,255,0.08)', borderRadius:'2px', overflow:'hidden' }}>
                    <div style={{ height:'100%', width:`${(selected.winners_log.length/3)*100}%`, background:CL.yellow, borderRadius:'2px', transition:'width 0.4s' }} />
                  </div>
                </div>

                {/* Distance */}
                <div style={{
                  display:'flex',alignItems:'center',gap:'10px',marginBottom:'16px',
                  padding:'10px 14px',
                  background: isClose ? `${CL.green}08` : locReady ? `${CL.yellow}05` : 'rgba(255,255,255,0.02)',
                  border:`1px solid ${isClose?`${CL.green}44`:locReady?`${CL.yellow}22`:'rgba(255,255,255,0.07)'}`,
                  borderRadius:'4px',
                }}>
                  <div style={{ width:'8px',height:'8px',borderRadius:'50%',flexShrink:0,background:isClose?CL.green:locReady?CL.yellow:'rgba(255,255,255,0.2)',boxShadow:isClose?`0 0 8px ${CL.green}`:locReady?`0 0 8px ${CL.yellow}`:'none' }} />
                  <div style={{ flex:1 }}>
                    <div style={{ fontFamily:'Orbitron, sans-serif',fontSize:'8px',letterSpacing:'0.12em',color:isClose?CL.green:CL.dim,marginBottom:'2px' }}>
                      {isClose ? '✓ أنت داخل نطاق المهمة — اضغط الاستلام!' : '📍 المسافة عن الهدف'}
                    </div>
                    {gpsLoading && !locReady
                      ? <span style={{ fontSize:'13px',color:CL.dim }}>جاري تحديد موقعك...</span>
                      : !locReady
                      ? <span style={{ fontSize:'13px',color:CL.dim }}>أعطِ التطبيق إذن الموقع</span>
                      : <span style={{ fontSize:'15px',fontWeight:700,color:isClose?CL.green:'#fff' }}>
                          {fmtDist(distM!)}
                          {!isClose && <span style={{ fontSize:'11px',color:'rgba(255,255,255,0.28)',marginRight:'6px' }}>— تحتاج أقل من {CLAIM_RADIUS_M} م</span>}
                        </span>
                    }
                  </div>
                </div>

                {/* ── Go to Mission button ── */}
                {locReady && selMs !== null && selMs > 0 && selected.winners_log.length < 3 && (
                  <button
                    onClick={goToMission}
                    disabled={navLoading}
                    style={{
                      width: '100%', padding: '14px 20px', marginBottom: '10px',
                      background: navLoading
                        ? 'rgba(0,212,255,0.04)'
                        : 'linear-gradient(135deg,rgba(0,212,255,0.18),rgba(0,212,255,0.07))',
                      border: `2px solid ${navLoading ? 'rgba(0,212,255,0.3)' : '#00d4ff'}`,
                      color: '#00d4ff',
                      fontFamily: 'Orbitron, sans-serif', fontSize: '11px', letterSpacing: '0.15em',
                      cursor: navLoading ? 'wait' : 'pointer', borderRadius: '6px',
                      boxShadow: navLoading ? 'none' : '0 0 20px rgba(0,212,255,0.35),0 0 40px rgba(0,212,255,0.12)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
                      transition: 'all 0.2s',
                    }}
                  >
                    {navLoading ? (
                      <>
                        <svg width="16" height="16" viewBox="0 0 28 28" fill="none"
                          style={{ animation: 'lf-spin 0.9s linear infinite', flexShrink: 0 }}>
                          <circle cx="14" cy="14" r="10" stroke="#00d4ff" strokeWidth="2.5"
                            strokeDasharray="22 14" strokeLinecap="round"/>
                        </svg>
                        جاري رسم المسار...
                      </>
                    ) : (
                      <>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
                          <path d="M12 2L19 9H15V22H9V9H5L12 2Z" fill="#00d4ff" opacity="0.9"/>
                          <path d="M12 2L19 9H15V22H9V9H5L12 2Z" stroke="#00d4ff" strokeWidth="1.2"
                            strokeLinejoin="round"/>
                        </svg>
                        الذهاب إلى المهمة
                      </>
                    )}
                  </button>
                )}

                {/* Claim button → opens question dialog first */}
                {isClose && selMs !== null && selMs > 0 && selected.winners_log.length < 3 && (
                  <button onClick={openQuestion} disabled={claiming} style={{
                    width:'100%',padding:'15px 20px',
                    background: claiming ? `${CL.yellow}10` : `linear-gradient(135deg,${CL.yellow}22,${CL.yellow}0C)`,
                    border:`2px solid ${CL.yellow}`,color:CL.yellow,
                    fontFamily:'Orbitron, sans-serif',fontSize:'12px',letterSpacing:'0.15em',
                    cursor:claiming?'wait':'pointer',borderRadius:'6px',
                    boxShadow:`0 0 24px ${CL.yellow}44,0 0 48px ${CL.yellow}18`,
                    display:'flex',alignItems:'center',justifyContent:'center',gap:'10px',
                    animation:claiming?'none':'bms-gold 2s ease-in-out infinite',
                  }}>
                    {claiming
                      ? <><svg width="16" height="16" viewBox="0 0 28 28" fill="none" style={{ animation:'lf-spin 1s linear infinite' }}><circle cx="14" cy="14" r="10" stroke={CL.yellow} strokeWidth="2.5" strokeDasharray="22 14"/></svg>جاري التحقق...</>
                      : '🎯 أنا وصلت — استلام الجائزة!'
                    }
                  </button>
                )}
                {locReady && !isClose && selMs !== null && selMs > 0 && (
                  <div style={{ textAlign:'center',padding:'12px',color:CL.dim,fontFamily:'Rajdhani, sans-serif',fontSize:'13px' }}>
                    اقترب أكثر من الموقع لتفعيل زر الاستلام ⭐
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function LiveCountdown({ expiresAt }: { expiresAt: Timestamp }) {
  const [ms, setMs] = useState(() => expiresAt.toMillis() - Date.now());
  useEffect(() => {
    const iv = setInterval(() => setMs(expiresAt.toMillis() - Date.now()), 1000);
    return () => clearInterval(iv);
  }, [expiresAt]);
  const color = ms < 60_000 ? '#ff2d50' : ms < 300_000 ? '#f5c518' : '#00dc64';
  return (
    <span style={{ fontFamily:'Orbitron, monospace',fontSize:'24px',fontWeight:900,color,letterSpacing:'0.08em',textShadow:`0 0 20px ${color}88` }}>
      {fmtMmSs(Math.max(0, ms))}
    </span>
  );
}

function FakeScreen({ msg, onClose }: { msg: string; onClose: () => void }) {
  return (
    <div style={{ textAlign:'center',padding:'10px 0 20px',animation:'bms-pop 0.5s cubic-bezier(0.34,1.56,0.64,1)' }}>
      <div style={{ fontSize:'58px',marginBottom:'10px',filter:'drop-shadow(0 0 20px #ff2d50)' }}>🎭</div>
      <div style={{ fontFamily:'Orbitron, sans-serif',fontSize:'14px',color:'#ff2d50',letterSpacing:'0.12em',marginBottom:'12px',textShadow:'0 0 20px #ff2d5088' }}>
        أكلت المقلب! 😂
      </div>
      <div style={{ fontFamily:'Rajdhani, sans-serif',fontSize:'17px',color:'#fff',lineHeight:1.7,marginBottom:'20px',padding:'14px 16px',background:'rgba(255,45,80,0.08)',border:'1px solid rgba(255,45,80,0.35)',borderRadius:'10px' }}>
        {msg}
      </div>
      <button onClick={onClose} style={{ padding:'11px 28px',background:'rgba(255,45,80,0.12)',border:'1px solid rgba(255,45,80,0.5)',color:'#ff2d50',fontFamily:'Orbitron, sans-serif',fontSize:'10px',letterSpacing:'0.12em',cursor:'pointer',borderRadius:'4px' }}>
        🏃 اركض للموقع الثاني!
      </button>
    </div>
  );
}

function WinScreen({ rank, reward, sponsor, onClose }: { rank:number; reward:string; sponsor:string; onClose:()=>void }) {
  const cfg = rank === 1
    ? { emoji:'🥇',label:'الفائز الأول', color:'#FFD700',anim:'bms-gold',  bg:'rgba(255,215,0,0.08)' }
    : rank === 2
    ? { emoji:'🥈',label:'الفائز الثاني',color:'#C0C0C0',anim:'bms-silver',bg:'rgba(192,192,192,0.08)' }
    : { emoji:'🥉',label:'الفائز الثالث',color:'#CD7F32',anim:'bms-bronze',bg:'rgba(205,127,50,0.08)' };
  return (
    <div style={{ textAlign:'center',padding:'10px 0 20px',animation:'bms-pop 0.6s cubic-bezier(0.34,1.56,0.64,1)' }}>
      <div style={{ fontSize:'66px',marginBottom:'10px',filter:`drop-shadow(0 0 24px ${cfg.color})`,animation:`${cfg.anim} 2s ease-in-out infinite` }}>
        {cfg.emoji}
      </div>
      <div style={{ fontFamily:'Orbitron, sans-serif',fontSize:'16px',color:cfg.color,letterSpacing:'0.12em',marginBottom:'10px',textShadow:`0 0 24px ${cfg.color}88` }}>
        مبروك! أنت {cfg.label}!
      </div>
      <div style={{ padding:'16px 18px',background:cfg.bg,border:`1px solid ${cfg.color}44`,borderRadius:'10px',marginBottom:'14px' }}>
        <div style={{ fontFamily:'Rajdhani, sans-serif',fontSize:'15px',color:'rgba(255,255,255,0.7)',marginBottom:'8px' }}>جائزتك:</div>
        <div style={{ fontFamily:'Orbitron, sans-serif',fontSize:'22px',color:cfg.color,fontWeight:900,textShadow:`0 0 20px ${cfg.color}88` }}>
          {reward}
        </div>
        <div style={{ fontFamily:'Rajdhani, sans-serif',fontSize:'13px',color:'rgba(255,255,255,0.4)',marginTop:'6px' }}>من {sponsor}</div>
      </div>
      <div style={{ fontFamily:'Rajdhani, sans-serif',fontSize:'17px',color:'rgba(255,255,255,0.8)',marginBottom:'20px',padding:'12px',background:'rgba(255,255,255,0.05)',borderRadius:'8px' }}>
        📲 شوّف الشاشة للكاشير للاستلام!
      </div>
      <button onClick={onClose} style={{ padding:'11px 28px',background:`${cfg.color}15`,border:`1px solid ${cfg.color}55`,color:cfg.color,fontFamily:'Orbitron, sans-serif',fontSize:'10px',letterSpacing:'0.12em',cursor:'pointer',borderRadius:'4px' }}>
        إغلاق
      </button>
    </div>
  );
}

function FullScreen({ onClose }: { onClose: () => void }) {
  return (
    <div style={{ textAlign:'center',padding:'10px 0 20px',animation:'bms-pop 0.5s cubic-bezier(0.34,1.56,0.64,1)' }}>
      <div style={{ fontSize:'54px',marginBottom:'10px',filter:'grayscale(1) opacity(0.7)' }}>😔</div>
      <div style={{ fontFamily:'Orbitron, sans-serif',fontSize:'13px',color:'rgba(255,255,255,0.45)',letterSpacing:'0.1em',marginBottom:'10px' }}>أوووف! راحت عليك خوية</div>
      <div style={{ fontFamily:'Rajdhani, sans-serif',fontSize:'17px',color:'rgba(255,255,255,0.7)',lineHeight:1.7,marginBottom:'20px',padding:'16px',background:'rgba(255,255,255,0.04)',borderRadius:'10px' }}>
        انتهت المقاعد المتاحة لهذه المهمة!<br/>
        <span style={{ color:'rgba(255,255,255,0.4)',fontSize:'14px' }}>حظاً أوفر بالقادم 🍀</span>
      </div>
      <button onClick={onClose} style={{ padding:'11px 28px',background:'rgba(255,255,255,0.06)',border:'1px solid rgba(255,255,255,0.18)',color:'rgba(255,255,255,0.55)',fontFamily:'Orbitron, sans-serif',fontSize:'10px',letterSpacing:'0.12em',cursor:'pointer',borderRadius:'4px' }}>
        إغلاق
      </button>
    </div>
  );
}

// ── PreAdDialog — اختيار التخطي أو المشاهدة المجانية ──────────────────────
function PreAdDialog({
  bounty, skipBusy, toast, onSkip, onWatchAd, onDismiss,
}: {
  bounty:    BountyDoc;
  skipBusy:  boolean;
  toast:     string;
  onSkip:    () => void;
  onWatchAd: () => void;
  onDismiss: () => void;
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 4200,
      background: 'rgba(2,5,12,0.92)', backdropFilter: 'blur(16px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      direction: 'rtl', padding: '20px',
    }}>
      <div style={{
        width: '100%', maxWidth: '380px',
        background: 'rgba(5,8,15,0.99)',
        border: '2px solid #f5c518',
        borderRadius: '12px',
        boxShadow: '0 0 60px rgba(245,197,24,0.22), 0 0 120px rgba(245,197,24,0.07)',
        overflow: 'hidden',
        animation: 'bms-pop 0.38s cubic-bezier(0.34,1.56,0.64,1)',
      }}>

        {/* Header */}
        <div style={{
          padding: '16px 18px 12px',
          borderBottom: '1px solid rgba(245,197,24,0.18)',
          background: 'rgba(245,197,24,0.05)',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        }}>
          <div>
            <div style={{
              fontFamily: 'Orbitron, sans-serif', fontSize: '8px',
              color: 'rgba(245,197,24,0.55)', letterSpacing: '0.18em', marginBottom: '4px',
            }}>
              ⭐ BOUNTY HUNT · مطاردة الكنز
            </div>
            <div style={{
              fontFamily: 'Rajdhani, sans-serif', fontSize: '15px', fontWeight: 700,
              color: '#f5c518', maxWidth: '240px', lineHeight: 1.3,
            }}>
              {bounty.title}
            </div>
          </div>
          <button onClick={onDismiss} style={{
            width: '30px', height: '30px', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: '4px', color: 'rgba(255,255,255,0.35)', fontSize: '16px', cursor: 'pointer',
          }}>×</button>
        </div>

        {/* Question */}
        <div style={{ padding: '22px 20px 6px' }}>
          <div style={{
            fontFamily: 'Rajdhani, sans-serif', fontSize: '17px', fontWeight: 600,
            color: 'rgba(255,255,255,0.88)', lineHeight: 1.75,
            textAlign: 'center', marginBottom: '22px',
          }}>
            هل تريد تخطي الإعلان والانطلاق فوراً
            مقابل <span style={{ color: '#f5c518', fontWeight: 800 }}>1,000 دينار</span>،
            أم مشاهدة الإعلان مجاناً؟
          </div>

          {/* Toast inside dialog */}
          {toast && (
            <div style={{
              padding: '10px 14px', marginBottom: '16px',
              background: 'rgba(255,45,120,0.10)',
              border: '1px solid rgba(255,45,120,0.45)',
              borderRadius: '6px',
              color: '#ff2d78',
              fontFamily: 'Rajdhani, sans-serif', fontSize: '14px', fontWeight: 600,
              textAlign: 'center', direction: 'rtl',
              animation: 'bms-pop 0.3s ease',
            }}>
              ⚠ {toast}
            </div>
          )}

          {/* Skip button — paid */}
          <button
            onClick={onSkip}
            disabled={skipBusy}
            style={{
              width: '100%', padding: '14px 16px', marginBottom: '10px',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
              background: skipBusy
                ? 'rgba(245,197,24,0.05)'
                : 'linear-gradient(135deg,rgba(245,197,24,0.20),rgba(245,197,24,0.08))',
              border: `2px solid ${skipBusy ? 'rgba(245,197,24,0.3)' : '#f5c518'}`,
              color: skipBusy ? 'rgba(245,197,24,0.4)' : '#f5c518',
              fontFamily: 'Orbitron, sans-serif', fontSize: '11px', letterSpacing: '0.13em',
              borderRadius: '7px',
              cursor: skipBusy ? 'wait' : 'pointer',
              boxShadow: skipBusy ? 'none' : '0 0 22px rgba(245,197,24,0.28)',
              transition: 'all 0.2s',
            }}
            onMouseEnter={e => { if (!skipBusy) e.currentTarget.style.background = 'rgba(245,197,24,0.26)'; }}
            onMouseLeave={e => { if (!skipBusy) e.currentTarget.style.background = 'linear-gradient(135deg,rgba(245,197,24,0.20),rgba(245,197,24,0.08))'; }}
          >
            {skipBusy ? (
              <>
                <svg width="14" height="14" viewBox="0 0 28 28" fill="none"
                  style={{ animation: 'lf-spin 0.9s linear infinite', flexShrink: 0 }}>
                  <circle cx="14" cy="14" r="10" stroke="#f5c518" strokeWidth="2.5"
                    strokeDasharray="22 14" strokeLinecap="round"/>
                </svg>
                جاري الخصم...
              </>
            ) : (
              <>⚡ تخطي بـ 1000 د.ع</>
            )}
          </button>

          {/* Watch ad button — free */}
          <button
            onClick={onWatchAd}
            style={{
              width: '100%', padding: '13px 16px', marginBottom: '20px',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
              background: 'rgba(0,212,255,0.07)',
              border: '1.5px solid rgba(0,212,255,0.45)',
              color: '#00d4ff',
              fontFamily: 'Orbitron, sans-serif', fontSize: '11px', letterSpacing: '0.12em',
              borderRadius: '7px', cursor: 'pointer',
              boxShadow: '0 0 16px rgba(0,212,255,0.15)',
              transition: 'background 0.2s',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(0,212,255,0.14)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'rgba(0,212,255,0.07)')}
          >
            🎬 مشاهدة الإعلان مجاناً
          </button>
        </div>
      </div>
    </div>
  );
}

// ── QuestionScreen — لغز السؤال السري ──────────────────────────────────────
function QuestionScreen({
  isFake, answer, error, claiming, onChange, onSubmit, onBack,
}: {
  isFake:    boolean;
  answer:    string;
  error:     string;
  claiming:  boolean;
  onChange:  (v: string) => void;
  onSubmit:  () => void;
  onBack:    () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 150); }, []);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !claiming) onSubmit();
  };

  return (
    <div style={{
      textAlign: 'center', padding: '10px 0 20px',
      animation: 'bms-pop 0.45s cubic-bezier(0.34,1.56,0.64,1)',
    }}>
      {/* Icon */}
      <div style={{
        fontSize: '54px', marginBottom: '12px',
        filter: 'drop-shadow(0 0 20px #f5c518)',
        animation: 'bms-pulse 2s ease-in-out infinite',
      }}>🔑</div>

      {/* Label */}
      <div style={{
        fontFamily: 'Orbitron, sans-serif', fontSize: '9px',
        color: '#f5c518', letterSpacing: '0.2em', marginBottom: '10px',
      }}>
        سؤال التحقق · SECRET QUESTION
      </div>

      {/* Question text */}
      <div style={{
        fontFamily: 'Rajdhani, sans-serif', fontSize: '18px', fontWeight: 700,
        color: '#fff', lineHeight: 1.6, marginBottom: '20px',
        padding: '14px 16px',
        background: 'rgba(245,197,24,0.07)',
        border: '1px solid rgba(245,197,24,0.3)',
        borderRadius: '10px',
      }}>
        ماهو الشي المخفي الذي لقيته بعد سؤال الموظف ؟
      </div>

      {/* Text input */}
      <input
        ref={inputRef}
        value={answer}
        onChange={e => onChange(e.target.value)}
        onKeyDown={handleKey}
        placeholder='اكتب جوابك هنا...'
        disabled={claiming}
        style={{
          width: '100%',
          padding: '13px 16px',
          background: 'rgba(255,255,255,0.04)',
          border: `2px solid ${error ? '#ff2d50' : 'rgba(245,197,24,0.5)'}`,
          borderRadius: '8px',
          color: '#fff',
          fontFamily: 'Rajdhani, sans-serif',
          fontSize: '17px',
          fontWeight: 600,
          textAlign: 'center',
          outline: 'none',
          boxSizing: 'border-box',
          marginBottom: '8px',
          transition: 'border-color 0.2s',
        }}
      />

      {/* Error message */}
      {error && (
        <div style={{
          fontFamily: 'Rajdhani, sans-serif', fontSize: '14px',
          color: '#ff2d50', lineHeight: 1.6,
          padding: '10px 14px',
          background: 'rgba(255,45,80,0.08)',
          border: '1px solid rgba(255,45,80,0.35)',
          borderRadius: '8px',
          marginBottom: '8px',
          animation: 'bms-pop 0.35s ease',
        }}>
          ⚠ {error}
        </div>
      )}

      {/* Confirm button */}
      <button
        onClick={onSubmit}
        disabled={claiming || !answer.trim()}
        style={{
          width: '100%', padding: '14px 20px', marginTop: '4px',
          background: answer.trim()
            ? 'linear-gradient(135deg,rgba(245,197,24,0.22),rgba(245,197,24,0.10))'
            : 'rgba(255,255,255,0.04)',
          border: `2px solid ${answer.trim() ? '#f5c518' : 'rgba(255,255,255,0.12)'}`,
          color: answer.trim() ? '#f5c518' : 'rgba(255,255,255,0.3)',
          fontFamily: 'Orbitron, sans-serif', fontSize: '11px', letterSpacing: '0.14em',
          cursor: claiming || !answer.trim() ? 'not-allowed' : 'pointer',
          borderRadius: '8px',
          boxShadow: answer.trim() ? '0 0 20px rgba(245,197,24,0.3)' : 'none',
          transition: 'all 0.2s',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
          marginBottom: '10px',
        }}
      >
        {claiming ? (
          <>
            <svg width="14" height="14" viewBox="0 0 28 28" fill="none"
              style={{ animation: 'lf-spin 0.9s linear infinite' }}>
              <circle cx="14" cy="14" r="10" stroke="#f5c518" strokeWidth="2.5"
                strokeDasharray="22 14" strokeLinecap="round"/>
            </svg>
            جاري التحقق...
          </>
        ) : '✓ تأكيد الجواب'}
      </button>

      {/* Back link */}
      <button
        onClick={onBack}
        disabled={claiming}
        style={{
          background: 'none', border: 'none',
          color: 'rgba(255,255,255,0.3)',
          fontFamily: 'Rajdhani, sans-serif', fontSize: '13px',
          cursor: 'pointer', padding: '4px 8px',
          textDecoration: 'underline',
        }}
      >
        ← رجوع
      </button>
    </div>
  );
}
