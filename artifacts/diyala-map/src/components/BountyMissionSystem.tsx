/**
 * BountyMissionSystem — ديالى مهمات الجوائز
 * - Reads `bounty_missions` (status == 'active') from Firestore live
 * - Draws golden pulsing diamond markers on the Leaflet map
 * - Bottom sheet with details, distance check (≤20 m), and atomic claim transaction
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
  const [mapReady,     setMapReady]     = useState(false);
  const [missions,     setMissions]     = useState<BountyMission[]>([]);
  const [selected,     setSelected]     = useState<BountyMission | null>(null);
  const [distM,        setDistM]        = useState<number | null>(null);
  const [claiming,     setClaiming]     = useState(false);
  const [claimResult,  setClaimResult]  = useState<'success' | 'taken' | 'error' | null>(null);
  const markersRef = useRef<Map<string, L.Marker>>(new Map());
  const seededRef  = useRef(false);

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
          console.log('[BountyMission] seeded initial missions');
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
      console.log(`[BountyMission] ${docs.length} active mission(s)`);
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

    // Remove claimed / gone markers
    markersRef.current.forEach((marker, id) => {
      if (!activeIds.has(id)) {
        marker.remove();
        markersRef.current.delete(id);
      }
    });

    // Add new markers
    missions.forEach(mission => {
      if (markersRef.current.has(mission.id)) return;
      const marker = L.marker([mission.latitude, mission.longitude], {
        icon:         makeMissionIcon(),
        zIndexOffset: 2000,
      }).addTo(map);

      marker.on('click', () => {
        setSelected(mission);
        setClaimResult(null);
      });
      markersRef.current.set(mission.id, marker);
    });
  }, [missions, mapReady, mapRef]);

  // ── Sync selected with live mission list ─────────────────────────────────
  useEffect(() => {
    if (!selected) return;
    const updated = missions.find(m => m.id === selected.id);
    // If the selected mission was claimed by someone else, close the sheet
    setSelected(updated ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missions]);

  // ── Live distance calculation ─────────────────────────────────────────────
  useEffect(() => {
    if (!selected || !userLocation) { setDistM(null); return; }
    const d = haversineMeters(
      userLocation.lat, userLocation.lng,
      selected.latitude, selected.longitude,
    );
    setDistM(d);
  }, [selected, userLocation]);

  // ── Claim handler — Firestore atomic transaction ──────────────────────────
  // Single transaction:
  //   1. Verify mission is still 'active' (prevents double-claim)
  //   2. Mark mission as 'claimed'
  //   3. Credit reward to user's wallet (users/{uid}.balance += reward)
  // Balance only increases here — no other code path touches it.
  const handleClaim = useCallback(async () => {
    if (!selected) return;
    const user      = getUser();
    const userId    = user?.phone ?? user?.name ?? 'anonymous';
    const firebaseUid = auth.currentUser?.uid;
    setClaiming(true);
    setClaimResult(null);
    try {
      const missionRef = doc(db, 'bounty_missions', selected.id);
      await runTransaction(db, async txn => {
        // ① Verify mission is still active
        const missionSnap = await txn.get(missionRef);
        if (!missionSnap.exists() || missionSnap.data()?.status !== 'active') {
          throw new Error('already_claimed');
        }
        const prizeAmount = Number(missionSnap.data()?.reward ?? 0);

        // ② Claim the mission
        txn.update(missionRef, {
          status:    'claimed',
          claimedBy: userId,
          claimedAt: serverTimestamp(),
        });

        // ③ Credit reward to wallet — only if we have a valid Firebase UID
        if (firebaseUid && prizeAmount > 0) {
          const userRef = doc(db, 'users', firebaseUid);
          txn.set(userRef, { balance: increment(prizeAmount) }, { merge: true });
        }
      });
      setClaimResult('success');
      setTimeout(() => { setSelected(null); setClaimResult(null); }, 3500);
    } catch (e: any) {
      setClaimResult(e?.message === 'already_claimed' ? 'taken' : 'error');
    } finally {
      setClaiming(false);
    }
  }, [selected]);

  // ── Nothing to render if no selection ────────────────────────────────────
  if (!selected) return null;

  const isClose   = distM !== null && distM <= CLAIM_RADIUS_M;
  const distLabel = distM === null
    ? 'جاري تحديد موقعك...'
    : distM < 1000
    ? `${Math.round(distM)} متر`
    : `${(distM / 1000).toFixed(1)} كم`;

  return (
    <>
      <style>{`
        @keyframes bounty-slide-up { from { transform: translateY(100%); } to { transform: translateY(0); } }
        @keyframes bounty-glow     { 0%,100%{box-shadow:0 0 20px #f5c51888,0 0 40px #f5c51844;} 50%{box-shadow:0 0 40px #f5c518cc,0 0 60px #f5c51866;} }
        @keyframes bounty-success  { 0%{transform:scale(0.8);opacity:0;} 60%{transform:scale(1.08);} 100%{transform:scale(1);opacity:1;} }
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

        {/* Distance badge */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '10px',
          marginBottom: '16px', padding: '10px 14px',
          background: isClose ? 'rgba(0,220,100,0.07)' : 'rgba(245,197,24,0.05)',
          border: `1px solid ${isClose ? 'rgba(0,220,100,0.3)' : 'rgba(245,197,24,0.18)'}`,
          borderRadius: '3px',
        }}>
          <div style={{
            width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
            background: isClose ? '#00dc64' : '#f5c518',
            boxShadow: `0 0 8px ${isClose ? '#00dc64' : '#f5c518'}`,
            animation: 'lf-ping 1.8s ease-in-out infinite',
          }} />
          <div style={{ flex: 1 }}>
            <div style={{
              fontFamily: 'Orbitron, sans-serif', fontSize: '8px', letterSpacing: '0.12em',
              color: isClose ? '#00dc64' : '#f5c518',
              marginBottom: '2px',
            }}>
              {isClose ? '✓ أنت داخل نطاق المهمة' : '📍 المسافة عن الهدف'}
            </div>
            <div style={{ fontSize: '15px', fontWeight: 700, color: isClose ? '#00dc64' : '#fff' }}>
              {distLabel}
              {!isClose && distM !== null && (
                <span style={{ fontSize: '11px', color: 'rgba(255,255,255,0.3)', marginRight: '6px' }}>
                  — تحتاج أقل من {CLAIM_RADIUS_M} متر
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Claim result feedback */}
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
              color: '#00dc64', letterSpacing: '0.14em',
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
              color: '#ff2d50', letterSpacing: '0.1em',
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
              fontFamily: 'Orbitron, sans-serif', fontSize: '10px', color: '#ff2d50',
            }}>خطأ في الاتصال — حاول مرة أخرى</div>
          </div>
        )}

        {/* Claim button */}
        {!claimResult && (
          <button
            onClick={handleClaim}
            disabled={!isClose || claiming}
            style={{
              width: '100%', padding: '15px',
              background: isClose
                ? 'rgba(245,197,24,0.14)'
                : 'rgba(255,255,255,0.02)',
              border: `2px solid ${isClose ? '#f5c518' : 'rgba(255,255,255,0.08)'}`,
              color: isClose ? '#f5c518' : 'rgba(255,255,255,0.18)',
              fontFamily: 'Orbitron, sans-serif', fontSize: '11px',
              letterSpacing: '0.14em',
              cursor: (isClose && !claiming) ? 'pointer' : 'not-allowed',
              borderRadius: '3px', transition: 'all 0.22s',
              boxShadow: isClose ? '0 0 0 rgba(245,197,24,0.3)' : 'none',
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
                  <circle cx="14" cy="14" r="10" stroke="#f5c518"
                    strokeWidth="2.5" strokeDasharray="22 14" strokeLinecap="round"/>
                </svg>
                جاري الاستلام...
              </>
            ) : isClose ? (
              '🎁 استلام الجائزة'
            ) : distM === null ? (
              '⏳ جاري تحديد موقعك...'
            ) : (
              '📍 أنت بعيد جداً عن موقع المهمة'
            )}
          </button>
        )}
      </div>
    </>
  );
}
