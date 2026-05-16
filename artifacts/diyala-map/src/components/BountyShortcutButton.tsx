/**
 * BountyShortcutButton — زر "مهمة" العائم
 * يفحص Firestore عند الضغط، يعرض قائمة المهمات النشطة
 * أو رسالة "ماكو مهمة" إذا لم تكن هناك مهمة.
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import L from 'leaflet';
import {
  collection, query, where, getDocs, Timestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';

interface ActiveBounty {
  id:           string;
  title:        string;
  sponsor_name: string;
  first_reward: string;
  expiresAt:    Timestamp | null;
  latitude:     number;
  longitude:    number;
}

interface Props {
  mapRef:  React.MutableRefObject<L.Map | null>;
  isDay?:  boolean;
}

const C = {
  yellow:  '#f5c518',
  red:     '#ff2d50',
  green:   '#00dc64',
  surface: 'rgba(5,8,15,0.98)',
  dim:     'rgba(255,255,255,0.38)',
};

function fmtCountdown(ms: number): string {
  if (ms <= 0) return '00:00';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
}

// ── Inner countdown ticker ──────────────────────────────────────────────────
function Countdown({ expiresAt }: { expiresAt: Timestamp | null }) {
  const [ms, setMs] = useState(() =>
    expiresAt ? expiresAt.toMillis() - Date.now() : 0
  );
  useEffect(() => {
    if (!expiresAt) return;
    const iv = setInterval(() => setMs(expiresAt.toMillis() - Date.now()), 1000);
    return () => clearInterval(iv);
  }, [expiresAt]);
  if (!expiresAt) return null;
  const color = ms < 60_000 ? C.red : ms < 300_000 ? C.yellow : C.green;
  return (
    <span style={{
      fontFamily: 'Orbitron, monospace', fontSize: '11px', fontWeight: 700,
      color, letterSpacing: '0.06em',
      textShadow: `0 0 12px ${color}66`,
    }}>
      ⏰ {fmtCountdown(Math.max(0, ms))}
    </span>
  );
}

// ── Main Component ──────────────────────────────────────────────────────────
export function BountyShortcutButton({ mapRef, isDay = false }: Props) {
  const [loading,   setLoading]   = useState(false);
  const [sheet,     setSheet]     = useState<ActiveBounty[] | null>(null);
  const [noMission, setNoMission] = useState(false);
  const [pressed,   setPressed]   = useState(false);
  const noMissionTimerRef         = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleClick = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    setPressed(true);
    setTimeout(() => setPressed(false), 200);
    try {
      const snap = await getDocs(
        query(collection(db, 'bounties'), where('status', '==', 'active'))
      );
      const docs: ActiveBounty[] = [];
      snap.forEach(d => {
        const raw = d.data();
        const lat = Number(raw.latitude), lng = Number(raw.longitude);
        if (isNaN(lat) || isNaN(lng)) return;
        docs.push({
          id:           d.id,
          title:        String(raw.title  ?? 'مهمة كنز'),
          sponsor_name: String(raw.sponsor_name ?? ''),
          first_reward: String(raw.first_reward ?? ''),
          expiresAt:    (raw.expiresAt as Timestamp) ?? null,
          latitude:     lat,
          longitude:    lng,
        });
      });

      if (docs.length === 0) {
        // Show "no mission" snackbar
        setNoMission(true);
        if (noMissionTimerRef.current) clearTimeout(noMissionTimerRef.current);
        noMissionTimerRef.current = setTimeout(() => setNoMission(false), 4500);
      } else {
        setSheet(docs);
      }
    } catch (err) {
      console.warn('[BountyShortcut]', err);
    } finally {
      setLoading(false);
    }
  }, [loading]);

  const flyToMission = useCallback((lat: number, lng: number) => {
    setSheet(null);
    mapRef.current?.flyTo([lat, lng], 17, { animate: true, duration: 1.4 });
  }, [mapRef]);

  useEffect(() => () => {
    if (noMissionTimerRef.current) clearTimeout(noMissionTimerRef.current);
  }, []);

  return (
    <>
      <style>{`
        @keyframes bsb-glow{
          0%,100%{box-shadow:0 0 18px #f5c51855,0 4px 18px rgba(0,0,0,0.75);}
          50%{box-shadow:0 0 32px #f5c518bb,0 0 60px #f5c51833,0 4px 18px rgba(0,0,0,0.75);}
        }
        @keyframes bsb-spin{to{transform:rotate(360deg)}}
        @keyframes bsb-up{from{transform:translateY(100%)}to{transform:translateY(0)}}
        @keyframes bsb-snack{
          0%{opacity:0;transform:translateX(-50%) translateY(14px)}
          15%{opacity:1;transform:translateX(-50%) translateY(0)}
          80%{opacity:1;transform:translateX(-50%) translateY(0)}
          100%{opacity:0;transform:translateX(-50%) translateY(6px)}
        }
        @keyframes bsb-card-in{
          from{opacity:0;transform:translateY(16px)}
          to{opacity:1;transform:translateY(0)}
        }
        @keyframes bsb-press{
          0%{transform:scale(1)}50%{transform:scale(0.91)}100%{transform:scale(1)}
        }
      `}</style>

      {/* ── Floating Action Button ── */}
      <button
        onClick={handleClick}
        aria-label="مهمة الكنز"
        style={{
          position: 'absolute',
          bottom:   '100px',
          left:     '16px',
          zIndex:   1100,
          width:    '56px',
          height:   '56px',
          borderRadius: '50%',
          background:   C.surface,
          border:       `2px solid ${C.yellow}`,
          color:        C.yellow,
          cursor:       loading ? 'wait' : 'pointer',
          display:      'flex',
          flexDirection:'column',
          alignItems:   'center',
          justifyContent:'center',
          gap:          '1px',
          backdropFilter:'blur(12px)',
          animation:    pressed ? 'bsb-press 0.2s ease' : 'bsb-glow 2.5s ease-in-out infinite',
          transition:   'border-color 0.2s',
          userSelect:   'none',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        {loading ? (
          <svg width="22" height="22" viewBox="0 0 28 28" fill="none"
            style={{ animation: 'bsb-spin 0.9s linear infinite' }}>
            <circle cx="14" cy="14" r="10" stroke={C.yellow} strokeWidth="2.5"
              strokeDasharray="22 14" strokeLinecap="round"/>
          </svg>
        ) : (
          /* Custom treasure compass SVG */
          <svg width="26" height="26" viewBox="0 0 40 40" fill="none">
            <circle cx="20" cy="20" r="17" stroke={C.yellow} strokeWidth="2" fill={`${C.yellow}10`}/>
            <polygon points="20,5 23,18 20,21 17,18" fill={C.yellow} opacity="0.9"/>
            <polygon points="20,35 23,22 20,21 17,22" fill={`${C.yellow}50`}/>
            <polygon points="5,20 18,17 21,20 18,23" fill={`${C.yellow}50`}/>
            <polygon points="35,20 22,17 21,20 22,23" fill={C.yellow} opacity="0.9"/>
            <circle cx="20" cy="20" r="3" fill={C.yellow}/>
          </svg>
        )}
        <span style={{
          fontFamily:    'Orbitron, sans-serif',
          fontSize:      '7px',
          letterSpacing: '0.05em',
          lineHeight:    1,
          color:         C.yellow,
          opacity:       0.9,
        }}>
          مهمة
        </span>
      </button>

      {/* ── No-Mission Snackbar ── */}
      {noMission && (
        <div style={{
          position:     'absolute',
          bottom:       '170px',
          left:         '50%',
          zIndex:       6000,
          direction:    'rtl',
          display:      'flex',
          alignItems:   'flex-start',
          gap:          '12px',
          padding:      '14px 18px',
          maxWidth:     'min(360px, 88vw)',
          background:   'linear-gradient(135deg,rgba(245,197,24,0.10),rgba(5,8,15,0.98))',
          border:       `1px solid ${C.yellow}55`,
          borderTop:    `3px solid ${C.yellow}`,
          borderRadius: '10px',
          boxShadow:    `0 -4px 32px ${C.yellow}22, 0 4px 32px rgba(0,0,0,0.7)`,
          backdropFilter:'blur(20px)',
          animation:    'bsb-snack 4.5s cubic-bezier(0.34,1.56,0.64,1) forwards',
          pointerEvents:'none',
        }}>
          <div style={{ fontSize: '26px', lineHeight: 1, flexShrink: 0 }}>🔥</div>
          <div>
            <div style={{
              fontFamily:    'Orbitron, sans-serif',
              fontSize:      '8px',
              color:         `${C.yellow}aa`,
              letterSpacing: '0.18em',
              marginBottom:  '5px',
            }}>
              BOUNTY HUNT · لا يوجد كنز الآن
            </div>
            <div style={{
              fontFamily:  'Rajdhani, sans-serif',
              fontSize:    '15px',
              fontWeight:  700,
              color:       '#fff',
              lineHeight:  1.55,
            }}>
              حالياً ماكو مهمة، راقب الخريطة وانتظر المهمة بحماس وكن مستعداً للفوز! 🔥
            </div>
          </div>
        </div>
      )}

      {/* ── Active Missions Bottom Sheet ── */}
      {sheet && sheet.length > 0 && (
        <>
          {/* Backdrop */}
          <div
            onClick={() => setSheet(null)}
            style={{
              position: 'absolute', inset: 0,
              zIndex:   5000,
              background: 'rgba(0,0,0,0.60)',
              backdropFilter: 'blur(3px)',
            }}
          />

          {/* Sheet */}
          <div style={{
            position: 'absolute',
            bottom:   0, left: 0, right: 0,
            zIndex:   5001,
            background:   C.surface,
            borderTop:    `2px solid ${C.yellow}`,
            borderRadius: '18px 18px 0 0',
            boxShadow:    `0 -8px 48px ${C.yellow}22, 0 -2px 24px rgba(0,0,0,0.9)`,
            backdropFilter: 'blur(24px)',
            direction:    'rtl',
            animation:    'bsb-up 0.38s cubic-bezier(0.34,1.56,0.64,1)',
            maxHeight:    '72vh',
            display:      'flex',
            flexDirection:'column',
          }}>
            {/* Handle */}
            <div style={{ display: 'flex', justifyContent: 'center', paddingTop: '10px' }}>
              <div style={{ width: '36px', height: '4px', borderRadius: '2px', background: 'rgba(255,255,255,0.15)' }} />
            </div>

            {/* Header */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 18px 12px',
              borderBottom: `1px solid ${C.yellow}18`,
            }}>
              <div>
                <div style={{
                  fontFamily: 'Orbitron, sans-serif',
                  fontSize: '9px', color: C.yellow, letterSpacing: '0.2em',
                }}>
                  ⭐ BOUNTY HUNT · مطاردة الكنوز
                </div>
                <div style={{
                  fontFamily: 'Rajdhani, sans-serif',
                  fontSize: '14px', color: 'rgba(255,255,255,0.7)', marginTop: '2px',
                }}>
                  {sheet.length} {sheet.length === 1 ? 'موقع متاح' : 'مواقع متاحة'} — اختر للانطلاق!
                </div>
              </div>
              <button
                onClick={() => setSheet(null)}
                style={{
                  background: 'rgba(255,45,80,0.1)', border: '1.5px solid rgba(255,45,80,0.4)',
                  color: '#ff2d50', width: '34px', height: '34px', borderRadius: '50%',
                  cursor: 'pointer', fontSize: '18px', display: 'flex',
                  alignItems: 'center', justifyContent: 'center', lineHeight: 1,
                }}
              >×</button>
            </div>

            {/* Hint */}
            <div style={{
              padding: '8px 18px',
              fontFamily: 'Rajdhani, sans-serif', fontSize: '12px',
              color: C.dim, borderBottom: `1px solid rgba(255,255,255,0.05)`,
              display: 'flex', alignItems: 'center', gap: '6px',
            }}>
              <span style={{ fontSize: '14px' }}>🧭</span>
              اضغط على أي موقع لتنتقل الخريطة إليه مباشرةً — انطلق وكن أول واصل!
            </div>

            {/* Mission cards list */}
            <div style={{ overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '10px', flex: 1 }}>
              {sheet.map((b, idx) => (
                <MissionCard
                  key={b.id}
                  bounty={b}
                  index={idx}
                  onGo={flyToMission}
                />
              ))}
            </div>

            {/* Safe-area spacer */}
            <div style={{ height: '16px' }} />
          </div>
        </>
      )}
    </>
  );
}

// ── Mission Card (identical appearance for real + fake) ─────────────────────
function MissionCard({
  bounty, index, onGo,
}: {
  bounty: ActiveBounty;
  index: number;
  onGo: (lat: number, lng: number) => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onClick={() => onGo(bounty.latitude, bounty.longitude)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding:     '14px 16px',
        background:  hovered ? `${C.yellow}0F` : `${C.yellow}07`,
        border:      `1px solid ${hovered ? C.yellow + '66' : C.yellow + '28'}`,
        borderRadius:'10px',
        cursor:      'pointer',
        display:     'flex',
        alignItems:  'center',
        gap:         '14px',
        transition:  'all 0.18s',
        boxShadow:   hovered ? `0 0 20px ${C.yellow}18` : 'none',
        animation:   `bsb-card-in 0.35s ease ${index * 0.07}s both`,
      }}
    >
      {/* Icon */}
      <div style={{
        width:       '50px',
        height:      '50px',
        borderRadius:'50%',
        background:  `${C.yellow}12`,
        border:      `2px solid ${C.yellow}55`,
        display:     'flex',
        alignItems:  'center',
        justifyContent:'center',
        fontSize:    '24px',
        flexShrink:  0,
        boxShadow:   `0 0 16px ${C.yellow}33`,
      }}>
        ⭐
      </div>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontFamily:    'Orbitron, sans-serif',
          fontSize:      '8px',
          color:         `${C.yellow}99`,
          letterSpacing: '0.15em',
          marginBottom:  '3px',
        }}>
          BOUNTY · موقع #{index + 1}
        </div>
        <div style={{
          fontFamily:  'Rajdhani, sans-serif',
          fontSize:    '16px',
          fontWeight:  700,
          color:       '#fff',
          overflow:    'hidden',
          textOverflow:'ellipsis',
          whiteSpace:  'nowrap',
          lineHeight:  1.3,
        }}>
          {bounty.title}
        </div>
        {bounty.sponsor_name && (
          <div style={{
            fontFamily: 'Rajdhani, sans-serif',
            fontSize:   '12px',
            color:      C.dim,
            marginTop:  '1px',
          }}>
            🏪 {bounty.sponsor_name}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '5px', flexWrap: 'wrap' }}>
          {bounty.first_reward && (
            <span style={{
              fontFamily: 'Rajdhani, sans-serif',
              fontSize:   '12px',
              color:      '#FFD700',
              fontWeight: 700,
            }}>
              🥇 {bounty.first_reward}
            </span>
          )}
          <Countdown expiresAt={bounty.expiresAt} />
        </div>
      </div>

      {/* Arrow indicator */}
      <div style={{
        flexShrink: 0,
        display:    'flex',
        alignItems: 'center',
        justifyContent:'center',
        width:      '32px',
        height:     '32px',
        borderRadius:'50%',
        background: hovered ? `${C.yellow}20` : 'transparent',
        border:     `1px solid ${hovered ? C.yellow + '66' : 'rgba(255,255,255,0.12)'}`,
        transition: 'all 0.18s',
      }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path d="M5 12h14M13 6l6 6-6 6"
            stroke={hovered ? C.yellow : 'rgba(255,255,255,0.35)'}
            strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>
    </div>
  );
}
