/**
 * BountyShortcutButton — زر "مهمة" العائم
 *
 * ══════════════════════════════════════════════════════════════════════
 * بنية الإعلانات (موحّدة عبر adsManager):
 *   جميع استدعاءات الإعلانات تمر عبر adsManager.ts الذي يُعدّ نقطة
 *   التغيير الوحيدة عند التحول إلى موبايل (AdMob / Capacitor).
 *
 *   Web Mock  → SimulatedAdOverlay (countdown UI) + adsManager promise
 *   Mobile    → AdMob SDK (adsManager.ts هو المكان الوحيد للتغيير)
 * ══════════════════════════════════════════════════════════════════════
 */

import {
  useState, useCallback, useEffect, useRef, useMemo,
} from 'react';
import L from 'leaflet';
import {
  collection, query, where, getDocs, Timestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import {
  showRewardedAd as showAd,
  isAdsEnabled,
  AD_WATCH_SECONDS,
} from '@/lib/adsManager';

// ── Types ───────────────────────────────────────────────────────────────────
interface ActiveBounty {
  id:           string;
  title:        string;
  sponsor_name: string;
  first_reward: string;
  expiresAt:    Timestamp | null;
  latitude:     number;
  longitude:    number;
}

type Phase =
  | 'idle'        // Initial state
  | 'loading'     // Fetching Firestore
  | 'no-mission'  // No active bounties found
  | 'ad-prompt'   // "شاهد الإعلان" bottom sheet
  | 'ad-watching' // Ad is playing
  | 'ad-skip-warn'// User tried to skip early
  | 'missions';   // Show missions list (reward earned)

interface Props {
  mapRef:       React.MutableRefObject<L.Map | null>;
  isDay?:       boolean;
  onUnlock?:    () => void;
  bottomOffset?: number;
}

// ── Colors ──────────────────────────────────────────────────────────────────
const C = {
  yellow:  '#f5c518',
  red:     '#ff2d50',
  green:   '#00dc64',
  blue:    '#00d4ff',
  surface: 'rgba(5,8,15,0.98)',
  dim:     'rgba(255,255,255,0.38)',
};

// ════════════════════════════════════════════════════════════════════════════
// ── Countdown Ticker ─────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════
function Countdown({ expiresAt }: { expiresAt: Timestamp | null }) {
  const [ms, setMs] = useState(() =>
    expiresAt ? expiresAt.toMillis() - Date.now() : 0
  );
  useEffect(() => {
    if (!expiresAt) return;
    const iv = setInterval(() => setMs(expiresAt.toMillis() - Date.now()), 1000);
    return () => clearInterval(iv);
  }, [expiresAt]);
  if (!expiresAt || ms <= 0) return null;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const color = ms < 60_000 ? C.red : ms < 300_000 ? C.yellow : C.green;
  const fmt = `${String(m).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
  return (
    <span style={{
      fontFamily: 'Orbitron, monospace', fontSize: '11px',
      fontWeight: 700, color, letterSpacing: '0.06em',
    }}>⏰ {fmt}</span>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ── SimulatedAdOverlay — واجهة محاكاة الإعلان (Display-only)
// ── المكافأة تُمنح عبر adsManager.showRewardedAd() Promise
// ── زر "إغلاق" يستدعي onSkip فقط — لا auto-reward داخلي
// ════════════════════════════════════════════════════════════════════════════
function SimulatedAdOverlay({
  onSkip,
}: {
  onSkip: () => void;
}) {
  const [remaining, setRemaining] = useState(AD_WATCH_SECONDS);
  const [canClose,  setCanClose]  = useState(false);
  const [bars,      setBars]      = useState(0);

  // Countdown (display only — reward is fired by adsManager Promise)
  useEffect(() => {
    const iv = setInterval(() => {
      setRemaining(p => {
        if (p <= 1) { clearInterval(iv); return 0; }
        return p - 1;
      });
      setBars(p => Math.min(p + 1, 8));
    }, 1000);
    // Allow skip button after half the duration
    const t = setTimeout(() => setCanClose(true), (AD_WATCH_SECONDS / 2) * 1000);
    return () => { clearInterval(iv); clearTimeout(t); };
  }, []);

  const progress = ((AD_WATCH_SECONDS - remaining) / AD_WATCH_SECONDS) * 100;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9998,
      background: '#000',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      direction: 'rtl',
    }}>
      {/* Ad Label */}
      <div style={{
        position: 'absolute', top: '16px', left: '16px',
        padding: '4px 10px',
        background: 'rgba(255,255,255,0.12)',
        border: '1px solid rgba(255,255,255,0.25)',
        borderRadius: '4px',
        fontFamily: 'Orbitron, sans-serif', fontSize: '9px',
        color: 'rgba(255,255,255,0.6)', letterSpacing: '0.12em',
      }}>
        إعلان ممول · AD
      </div>

      {/* Simulated Ad Content */}
      <div style={{
        width: '100%', maxWidth: '520px',
        padding: '0 20px',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: '24px',
      }}>
        {/* Fake ad visual */}
        <div style={{
          width: '100%', aspectRatio: '16/9',
          background: 'linear-gradient(135deg, #0d1117 0%, #1a1f2e 50%, #0d1117 100%)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '12px',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          gap: '16px',
          overflow: 'hidden',
          position: 'relative',
        }}>
          {/* Animated bars (fake audio visualizer) */}
          <div style={{ display: 'flex', gap: '5px', alignItems: 'flex-end', height: '60px' }}>
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} style={{
                width: '10px',
                height: `${10 + Math.sin(Date.now() / 300 + i) * 25 + (i < bars ? 20 : 0)}px`,
                background: i < bars ? C.yellow : 'rgba(255,255,255,0.15)',
                borderRadius: '3px 3px 0 0',
                transition: 'height 0.3s ease, background 0.5s',
              }}/>
            ))}
          </div>

          {/* Logo placeholder */}
          <div style={{
            fontFamily: 'Orbitron, sans-serif', fontSize: '22px',
            fontWeight: 900, letterSpacing: '0.2em',
            color: C.yellow, textShadow: `0 0 24px ${C.yellow}88`,
          }}>
            DIYALA MAP
          </div>
          <div style={{
            fontFamily: 'Rajdhani, sans-serif', fontSize: '15px',
            color: 'rgba(255,255,255,0.55)',
          }}>
            دعمك للتطبيق يحافظ على الخدمة مجانية 🙏
          </div>

          {/* Shimmer overlay */}
          <div style={{
            position: 'absolute', inset: 0,
            background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.03) 50%, transparent 100%)',
            animation: 'bsb-shimmer 2s ease-in-out infinite',
            pointerEvents: 'none',
          }}/>
        </div>

        {/* Progress bar */}
        <div style={{ width: '100%' }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginBottom: '8px',
          }}>
            <span style={{
              fontFamily: 'Rajdhani, sans-serif', fontSize: '13px',
              color: 'rgba(255,255,255,0.55)',
            }}>
              شاهد الإعلان للوصول إلى الكنز 🎯
            </span>
            <span style={{
              fontFamily: 'Orbitron, monospace', fontSize: '16px',
              fontWeight: 900, color: remaining <= 5 ? C.green : C.yellow,
              textShadow: `0 0 16px ${remaining <= 5 ? C.green : C.yellow}88`,
            }}>
              {remaining}s
            </span>
          </div>
          <div style={{
            width: '100%', height: '6px',
            background: 'rgba(255,255,255,0.1)',
            borderRadius: '3px', overflow: 'hidden',
          }}>
            <div style={{
              height: '100%',
              width: `${progress}%`,
              background: `linear-gradient(90deg, ${C.yellow}, ${C.green})`,
              borderRadius: '3px',
              transition: 'width 1s linear',
              boxShadow: `0 0 10px ${C.yellow}88`,
            }}/>
          </div>
        </div>

        {/* Close button (appears at half-time) */}
        {canClose && (
          <button
            onClick={onSkip}
            style={{
              padding: '8px 20px',
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.2)',
              color: 'rgba(255,255,255,0.4)',
              fontFamily: 'Rajdhani, sans-serif', fontSize: '13px',
              cursor: 'pointer', borderRadius: '6px',
              letterSpacing: '0.05em',
              animation: 'bsb-fade-in 0.4s ease',
            }}
          >
            تخطي الإعلان (ستخسر المكافأة)
          </button>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// ── Mission Card ─────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════
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
        padding: '14px 16px',
        background: hovered ? `${C.yellow}10` : `${C.yellow}07`,
        border: `1px solid ${hovered ? C.yellow + '66' : C.yellow + '28'}`,
        borderRadius: '10px',
        cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: '14px',
        transition: 'all 0.18s',
        boxShadow: hovered ? `0 0 20px ${C.yellow}18` : 'none',
        animation: `bsb-card-in 0.35s ease ${index * 0.07}s both`,
      }}
    >
      <div style={{
        width: '50px', height: '50px', borderRadius: '50%',
        background: `${C.yellow}12`, border: `2px solid ${C.yellow}55`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: '24px', flexShrink: 0,
        boxShadow: `0 0 16px ${C.yellow}33`,
      }}>⭐</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontFamily: 'Orbitron, sans-serif', fontSize: '8px',
          color: `${C.yellow}99`, letterSpacing: '0.15em', marginBottom: '3px',
        }}>
          BOUNTY · موقع #{index + 1}
        </div>
        <div style={{
          fontFamily: 'Rajdhani, sans-serif', fontSize: '16px',
          fontWeight: 700, color: '#fff',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {bounty.title}
        </div>
        {bounty.sponsor_name && (
          <div style={{
            fontFamily: 'Rajdhani, sans-serif', fontSize: '12px',
            color: C.dim, marginTop: '1px',
          }}>🏪 {bounty.sponsor_name}</div>
        )}
        <div style={{ display: 'flex', gap: '12px', marginTop: '5px', flexWrap: 'wrap', alignItems: 'center' }}>
          {bounty.first_reward && (
            <span style={{
              fontFamily: 'Rajdhani, sans-serif', fontSize: '12px',
              color: '#FFD700', fontWeight: 700,
            }}>🥇 {bounty.first_reward}</span>
          )}
          <Countdown expiresAt={bounty.expiresAt} />
        </div>
      </div>
      <div style={{
        flexShrink: 0, width: '32px', height: '32px', borderRadius: '50%',
        background: hovered ? `${C.yellow}20` : 'transparent',
        border: `1px solid ${hovered ? C.yellow + '66' : 'rgba(255,255,255,0.12)'}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
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

// ════════════════════════════════════════════════════════════════════════════
// ── Main Component ────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════
export function BountyShortcutButton({ mapRef, isDay = false, onUnlock, bottomOffset = 0 }: Props) {
  const [phase,      setPhase]      = useState<Phase>('idle');
  const [bounties,   setBounties]   = useState<ActiveBounty[]>([]);
  const [pressed,    setPressed]    = useState(false);
  const [adsEnabled, setAdsEnabled] = useState(true); // optimistic default
  const noMissionTimerRef           = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rewardEarnedRef             = useRef(false);
  const adCancelledRef              = useRef(false); // set true when user skips early

  // ── Check ads enabled on mount ────────────────────────────────────────────
  useEffect(() => {
    isAdsEnabled().then(v => setAdsEnabled(v));
  }, []);

  // ── Fetch active bounties ─────────────────────────────────────────────────
  const fetchBounties = useCallback(async (): Promise<ActiveBounty[]> => {
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
        title:        String(raw.title        ?? 'مهمة كنز'),
        sponsor_name: String(raw.sponsor_name ?? ''),
        first_reward: String(raw.first_reward ?? ''),
        expiresAt:    (raw.expiresAt as Timestamp) ?? null,
        latitude:     lat,
        longitude:    lng,
      });
    });
    return docs;
  }, []);

  // ── FAB Click ──────────────────────────────────────────────────────────────
  const handleFabClick = useCallback(async () => {
    if (phase !== 'idle' && phase !== 'no-mission') return;
    setPressed(true);
    setTimeout(() => setPressed(false), 200);
    setPhase('loading');
    try {
      const docs = await fetchBounties();
      if (docs.length === 0) {
        setBounties([]);
        setPhase('no-mission');
        if (noMissionTimerRef.current) clearTimeout(noMissionTimerRef.current);
        noMissionTimerRef.current = setTimeout(() => setPhase('idle'), 4500);
      } else {
        setBounties(docs);
        // If ads are disabled by admin → skip ad, go straight to missions
        if (!adsEnabled) {
          rewardEarnedRef.current = true;
          onUnlock?.();
          setPhase('missions');
        } else {
          setPhase('ad-prompt');
        }
      }
    } catch (err) {
      console.warn('[BountyShortcut] fetchBounties:', err);
      setPhase('idle');
    }
  }, [phase, fetchBounties, adsEnabled, onUnlock]);

  // ── "Watch Ad" button → calls adsManager (single swap point for mobile) ───
  const handleWatchAd = useCallback(async () => {
    rewardEarnedRef.current = false;
    adCancelledRef.current  = false;
    setPhase('ad-watching');
    try {
      const result = await showAd('mission_button');
      if (adCancelledRef.current) return; // user already skipped — phase changed
      if (result.success) {
        rewardEarnedRef.current = true;
        onUnlock?.();
        setPhase('missions');
      } else {
        setPhase('ad-skip-warn');
      }
    } catch {
      if (!adCancelledRef.current) setPhase('ad-skip-warn');
    }
  }, [onUnlock]);

  // ── User skipped early (SimulatedAdOverlay skip button) ───────────────────
  const handleAdSkipped = useCallback(() => {
    adCancelledRef.current = true;
    setPhase('ad-skip-warn');
  }, []);

  // ── Fly to mission ────────────────────────────────────────────────────────
  const flyToMission = useCallback((lat: number, lng: number) => {
    setPhase('idle');
    mapRef.current?.flyTo([lat, lng], 17, { animate: true, duration: 1.4 });
  }, [mapRef]);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  useEffect(() => () => {
    if (noMissionTimerRef.current) clearTimeout(noMissionTimerRef.current);
  }, []);

  // ── Derived ───────────────────────────────────────────────────────────────
  const isLoading = phase === 'loading';
  const hasBackdrop = phase === 'ad-prompt' || phase === 'missions' || phase === 'ad-skip-warn';

  return (
    <>
      <style>{`
        @keyframes bsb-glow{
          0%,100%{box-shadow:0 0 18px #f5c51855,0 4px 18px rgba(0,0,0,0.75);}
          50%{box-shadow:0 0 32px #f5c518bb,0 0 60px #f5c51833,0 4px 18px rgba(0,0,0,0.75);}
        }
        @keyframes bsb-spin{to{transform:rotate(360deg)}}
        @keyframes bsb-press{0%{transform:scale(1)}50%{transform:scale(0.91)}100%{transform:scale(1)}}
        @keyframes bsb-up{from{transform:translateY(100%)}to{transform:translateY(0)}}
        @keyframes bsb-pop{
          0%{transform:scale(0.75);opacity:0}
          70%{transform:scale(1.05)}
          100%{transform:scale(1);opacity:1}
        }
        @keyframes bsb-snack{
          0%{opacity:0;transform:translateX(-50%) translateY(14px)}
          15%{opacity:1;transform:translateX(-50%) translateY(0)}
          80%{opacity:1;}
          100%{opacity:0;}
        }
        @keyframes bsb-card-in{
          from{opacity:0;transform:translateY(16px)}
          to{opacity:1;transform:translateY(0)}
        }
        @keyframes bsb-shimmer{
          0%,100%{opacity:0} 50%{opacity:1}
        }
        @keyframes bsb-fade-in{from{opacity:0}to{opacity:1}}
        @keyframes bsb-pulse-red{
          0%,100%{box-shadow:0 0 14px #ff2d5055}
          50%{box-shadow:0 0 28px #ff2d50cc}
        }
        @keyframes bsb-warn-shake{
          0%,100%{transform:translateX(0)}
          20%,60%{transform:translateX(-6px)}
          40%,80%{transform:translateX(6px)}
        }
      `}</style>

      {/* ══════════════════════════════════════════════════════════════════════
          ── Floating Action Button — centered above bottom bar ─────────────
          Wrapper handles position so animation transform doesn't conflict
      ══════════════════════════════════════════════════════════════════════ */}
      <div style={{
        position:   'absolute',
        bottom:     `${90 + bottomOffset}px`,
        left:       '50%',
        transform:  'translateX(-50%)',
        zIndex:     1100,
        pointerEvents: 'none',
        transition: 'bottom 0.32s cubic-bezier(0.4,0,0.2,1)',
      }}>
        <button
          onClick={handleFabClick}
          aria-label="مهمة الكنز"
          style={{
            pointerEvents:  'auto',
            width:          '56px',
            height:         '56px',
            borderRadius:   '50%',
            background:     C.surface,
            border:         `2px solid ${C.yellow}`,
            color:          C.yellow,
            cursor:         isLoading ? 'wait' : 'pointer',
            display:        'flex',
            flexDirection:  'column',
            alignItems:     'center',
            justifyContent: 'center',
            gap:            '1px',
            backdropFilter: 'blur(12px)',
            animation:      pressed
              ? 'bsb-press 0.2s ease'
              : 'bsb-glow 2.5s ease-in-out infinite',
            userSelect:     'none',
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          {isLoading ? (
            <svg width="22" height="22" viewBox="0 0 28 28" fill="none"
              style={{ animation: 'bsb-spin 0.9s linear infinite' }}>
              <circle cx="14" cy="14" r="10" stroke={C.yellow} strokeWidth="2.5"
                strokeDasharray="22 14" strokeLinecap="round"/>
            </svg>
          ) : (
            <svg width="26" height="26" viewBox="0 0 40 40" fill="none">
              <circle cx="20" cy="20" r="17" stroke={C.yellow} strokeWidth="2"
                fill={`${C.yellow}10`}/>
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
          }}>مهمة</span>
        </button>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          ── No-Mission Snackbar ────────────────────────────────────────────
      ══════════════════════════════════════════════════════════════════════ */}
      {phase === 'no-mission' && (
        <div style={{
          position:       'absolute',
          bottom:         '170px',
          left:           '50%',
          zIndex:         6000,
          direction:      'rtl',
          display:        'flex',
          alignItems:     'flex-start',
          gap:            '12px',
          padding:        '14px 18px',
          maxWidth:       'min(360px, 88vw)',
          background:     `linear-gradient(135deg,${C.yellow}10,${C.surface})`,
          border:         `1px solid ${C.yellow}55`,
          borderTop:      `3px solid ${C.yellow}`,
          borderRadius:   '10px',
          boxShadow:      `0 -4px 32px ${C.yellow}22, 0 4px 32px rgba(0,0,0,0.7)`,
          backdropFilter: 'blur(20px)',
          animation:      'bsb-snack 4.5s cubic-bezier(0.34,1.56,0.64,1) forwards',
          pointerEvents:  'none',
        }}>
          <div style={{ fontSize: '26px', lineHeight: 1, flexShrink: 0 }}>🔥</div>
          <div>
            <div style={{
              fontFamily:    'Orbitron, sans-serif', fontSize: '8px',
              color:         `${C.yellow}aa`, letterSpacing: '0.18em', marginBottom: '5px',
            }}>BOUNTY HUNT · لا يوجد كنز الآن</div>
            <div style={{
              fontFamily: 'Rajdhani, sans-serif', fontSize: '15px',
              fontWeight: 700, color: '#fff', lineHeight: 1.55,
            }}>
              حالياً ماكو مهمة، راقب الخريطة وانتظر المهمة بحماس وكن مستعداً للفوز! 🔥
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          ── Ad Overlay — shown while ad is "playing" (web mock UI)
          ── On mobile: adsManager calls AdMob natively, no overlay needed
      ══════════════════════════════════════════════════════════════════════ */}
      {phase === 'ad-watching' && (
        <SimulatedAdOverlay
          onSkip={handleAdSkipped}
        />
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          ── Backdrop (for sheets) ──────────────────────────────────────────
      ══════════════════════════════════════════════════════════════════════ */}
      {hasBackdrop && (
        <div
          onClick={() => setPhase('idle')}
          style={{
            position: 'absolute', inset: 0, zIndex: 5000,
            background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(3px)',
          }}
        />
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          ── Ad Prompt Bottom Sheet ─────────────────────────────────────────
          "شاهد الإعلان للعثور على المهمة 📺🔥"
      ══════════════════════════════════════════════════════════════════════ */}
      {phase === 'ad-prompt' && (
        <div style={{
          position:       'absolute',
          bottom:         0, left: 0, right: 0,
          zIndex:         5001,
          background:     C.surface,
          borderTop:      `2px solid ${C.yellow}`,
          borderRadius:   '20px 20px 0 0',
          boxShadow:      `0 -8px 60px ${C.yellow}22, 0 -2px 24px rgba(0,0,0,0.9)`,
          backdropFilter: 'blur(24px)',
          direction:      'rtl',
          animation:      'bsb-up 0.38s cubic-bezier(0.34,1.56,0.64,1)',
          padding:        '0 0 40px',
        }}>
          {/* Handle */}
          <div style={{ display: 'flex', justifyContent: 'center', paddingTop: '12px' }}>
            <div style={{ width: '36px', height: '4px', borderRadius: '2px', background: 'rgba(255,255,255,0.15)' }} />
          </div>

          {/* Close btn */}
          <button
            onClick={() => setPhase('idle')}
            style={{
              position: 'absolute', top: '14px', left: '18px',
              background: 'none', border: 'none', color: C.dim,
              fontSize: '22px', cursor: 'pointer', lineHeight: 1,
            }}
          >×</button>

          {/* Body */}
          <div style={{
            padding:        '28px 28px 10px',
            display:        'flex',
            flexDirection:  'column',
            alignItems:     'center',
            textAlign:      'center',
            gap:            '20px',
          }}>
            {/* Icon */}
            <div style={{
              fontSize:   '64px',
              lineHeight: 1,
              filter:     `drop-shadow(0 0 24px ${C.yellow})`,
              animation:  'bsb-pop 0.55s cubic-bezier(0.34,1.56,0.64,1)',
            }}>
              📺
            </div>

            {/* Headline */}
            <div>
              <div style={{
                fontFamily:    'Orbitron, sans-serif',
                fontSize:      '10px',
                color:         `${C.yellow}aa`,
                letterSpacing: '0.2em',
                marginBottom:  '10px',
              }}>
                ⭐ BOUNTY HUNT · مطاردة الكنوز
              </div>
              <div style={{
                fontFamily:  'Rajdhani, sans-serif',
                fontSize:    '22px',
                fontWeight:  800,
                color:       '#fff',
                lineHeight:  1.45,
              }}>
                شاهد الاعلان للعثور على المهمه 📺🔥
              </div>
              <div style={{
                fontFamily:  'Rajdhani, sans-serif',
                fontSize:    '14px',
                color:       C.dim,
                marginTop:   '8px',
                lineHeight:  1.6,
              }}>
                مشاهدة إعلان قصير تدعم التطبيق وتمنحك الوصول إلى موقع الكنز مباشرةً 🎯
              </div>
            </div>

            {/* Info boxes */}
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr',
              gap: '10px', width: '100%',
            }}>
              {[
                { emoji: '⏱', label: `${AD_WATCH_SECONDS} ثانية فقط`, sub: 'مدة الإعلان' },
                { emoji: '🏆', label: 'وصول فوري', sub: 'لموقع الكنز' },
              ].map(b => (
                <div key={b.label} style={{
                  padding:      '12px 10px',
                  background:   `${C.yellow}08`,
                  border:       `1px solid ${C.yellow}25`,
                  borderRadius: '10px',
                  textAlign:    'center',
                }}>
                  <div style={{ fontSize: '22px', marginBottom: '4px' }}>{b.emoji}</div>
                  <div style={{
                    fontFamily: 'Orbitron, sans-serif', fontSize: '10px',
                    color: C.yellow, fontWeight: 700,
                  }}>{b.label}</div>
                  <div style={{
                    fontFamily: 'Rajdhani, sans-serif', fontSize: '11px',
                    color: C.dim, marginTop: '2px',
                  }}>{b.sub}</div>
                </div>
              ))}
            </div>

            {/* Watch Ad Button */}
            <button
              onClick={handleWatchAd}
              style={{
                width:          '100%',
                padding:        '16px 24px',
                background:     `linear-gradient(135deg, ${C.yellow}22, ${C.yellow}10)`,
                border:         `2px solid ${C.yellow}`,
                borderRadius:   '12px',
                color:          C.yellow,
                fontFamily:     'Orbitron, sans-serif',
                fontSize:       '13px',
                fontWeight:     900,
                letterSpacing:  '0.14em',
                cursor:         'pointer',
                display:        'flex',
                alignItems:     'center',
                justifyContent: 'center',
                gap:            '10px',
                boxShadow:      `0 0 28px ${C.yellow}44, 0 0 56px ${C.yellow}18`,
                transition:     'all 0.2s',
                animation:      'bsb-glow 2s ease-in-out infinite',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLElement).style.background =
                  `linear-gradient(135deg, ${C.yellow}35, ${C.yellow}20)`;
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLElement).style.background =
                  `linear-gradient(135deg, ${C.yellow}22, ${C.yellow}10)`;
              }}
            >
              {/* Play icon */}
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke={C.yellow} strokeWidth="2"
                  fill={`${C.yellow}15`}/>
                <polygon points="10,8 18,12 10,16" fill={C.yellow}/>
              </svg>
              مشاهدة الاعلان
            </button>

            {/* Small disclaimer */}
            <div style={{
              fontFamily:  'Rajdhani, sans-serif',
              fontSize:    '11px',
              color:       'rgba(255,255,255,0.22)',
              textAlign:   'center',
              lineHeight:  1.5,
            }}>
              الإعلان يدعم خدمة الخريطة ويبقيها مجانية للجميع
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          ── Early-Skip Warning Sheet ───────────────────────────────────────
      ══════════════════════════════════════════════════════════════════════ */}
      {phase === 'ad-skip-warn' && (
        <div style={{
          position:       'absolute',
          bottom:         0, left: 0, right: 0,
          zIndex:         5001,
          background:     C.surface,
          borderTop:      `2px solid ${C.red}`,
          borderRadius:   '20px 20px 0 0',
          boxShadow:      `0 -8px 40px ${C.red}22, 0 -2px 24px rgba(0,0,0,0.9)`,
          backdropFilter: 'blur(24px)',
          direction:      'rtl',
          animation:      'bsb-warn-shake 0.4s ease, bsb-up 0.35s ease',
          padding:        '16px 24px 48px',
          textAlign:      'center',
        }}>
          {/* Handle */}
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '20px' }}>
            <div style={{ width: '36px', height: '4px', borderRadius: '2px', background: 'rgba(255,255,255,0.15)' }} />
          </div>

          <div style={{ fontSize: '52px', marginBottom: '14px', filter: `drop-shadow(0 0 18px ${C.red})` }}>⛔</div>

          <div style={{
            fontFamily:    'Orbitron, sans-serif', fontSize: '11px',
            color:         C.red, letterSpacing: '0.15em', marginBottom: '10px',
            animation:     'bsb-pulse-red 1.5s ease-in-out infinite',
          }}>
            لم تكتمل المشاهدة!
          </div>

          <div style={{
            fontFamily:  'Rajdhani, sans-serif', fontSize: '18px',
            fontWeight:  700, color: '#fff', lineHeight: 1.55, marginBottom: '24px',
          }}>
            يجب مشاهدة الإعلان كاملاً لتتمكن من رؤية مكان المهمة بالخريطة!
          </div>

          {/* Retry button */}
          <button
            onClick={() => setPhase('ad-prompt')}
            style={{
              width:          '100%',
              padding:        '14px 20px',
              background:     `${C.yellow}15`,
              border:         `1.5px solid ${C.yellow}88`,
              borderRadius:   '10px',
              color:          C.yellow,
              fontFamily:     'Orbitron, sans-serif',
              fontSize:       '11px',
              letterSpacing:  '0.12em',
              cursor:         'pointer',
              marginBottom:   '10px',
              boxShadow:      `0 0 18px ${C.yellow}33`,
              display:        'flex',
              alignItems:     'center',
              justifyContent: 'center',
              gap:            '8px',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M23 4v6h-6M1 20v-6h6" stroke={C.yellow} strokeWidth="2.2"
                strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"
                stroke={C.yellow} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            حاول مجدداً — شاهد الإعلان كاملاً
          </button>

          <button
            onClick={() => setPhase('idle')}
            style={{
              background: 'none', border: 'none', color: C.dim,
              fontFamily: 'Rajdhani, sans-serif', fontSize: '13px',
              cursor: 'pointer', padding: '6px',
            }}
          >
            إغلاق
          </button>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          ── Missions List Sheet (reward earned ✓) ─────────────────────────
      ══════════════════════════════════════════════════════════════════════ */}
      {phase === 'missions' && bounties.length > 0 && (
        <div style={{
          position:       'absolute',
          bottom:         0, left: 0, right: 0,
          zIndex:         5001,
          background:     C.surface,
          borderTop:      `2px solid ${C.yellow}`,
          borderRadius:   '18px 18px 0 0',
          boxShadow:      `0 -8px 48px ${C.yellow}22, 0 -2px 24px rgba(0,0,0,0.9)`,
          backdropFilter: 'blur(24px)',
          direction:      'rtl',
          animation:      'bsb-up 0.38s cubic-bezier(0.34,1.56,0.64,1)',
          maxHeight:      '72vh',
          display:        'flex',
          flexDirection:  'column',
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
                fontFamily: 'Orbitron, sans-serif', fontSize: '9px',
                color: C.yellow, letterSpacing: '0.2em',
              }}>
                ✓ المكافأة مفتوحة · REWARD UNLOCKED
              </div>
              <div style={{
                fontFamily: 'Rajdhani, sans-serif', fontSize: '14px',
                color: 'rgba(255,255,255,0.7)', marginTop: '2px',
              }}>
                {bounties.length} {bounties.length === 1 ? 'موقع' : 'مواقع'} — انطلق الآن!
              </div>
            </div>
            <button
              onClick={() => setPhase('idle')}
              style={{
                background: `rgba(255,45,80,0.1)`, border: '1.5px solid rgba(255,45,80,0.4)',
                color: C.red, width: '34px', height: '34px', borderRadius: '50%',
                cursor: 'pointer', fontSize: '18px',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
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
            اضغط على أي موقع لتنتقل الخريطة إليه — كن أول واصل!
          </div>

          {/* Cards */}
          <div style={{
            overflowY: 'auto', padding: '12px 14px',
            display: 'flex', flexDirection: 'column', gap: '10px', flex: 1,
          }}>
            {bounties.map((b, idx) => (
              <MissionCard key={b.id} bounty={b} index={idx} onGo={flyToMission} />
            ))}
          </div>

          <div style={{ height: '16px' }} />
        </div>
      )}
    </>
  );
}
