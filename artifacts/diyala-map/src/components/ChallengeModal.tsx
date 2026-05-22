/**
 * ChallengeModal — نظام لعبة التحدي 🏆
 * لعبة أركيد: اصطياد العناصر الساقطة
 * - شخصية تتحرك يميناً/يساراً (زري ← →)
 * - عناصر تسقط من الأعلى بمواقع عشوائية
 * - اصطياد العناصر يرفع النقاط
 * - مدة 60 ثانية
 * - إرسال النتيجة عبر POST /api/game/score
 * - Leaderboard من GET /api/game/leaderboard
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { auth, db } from '@/lib/firebase';
import { doc, onSnapshot, runTransaction, increment } from 'firebase/firestore';

// ── Types ───────────────────────────────────────────────────────────────────
interface Props {
  onClose: () => void;
}

type Phase = 'menu' | 'loading' | 'playing' | 'gameover' | 'leaderboard' | 'shop' | 'duel';

interface GameProfile {
  firebaseUid:   string;
  gamePoints:    number;
  gameCash:      number;
  unlockedSkins: string[];
  activeSkin:    string;
  magnetLevel:   number;
  comboLevel:    number;
}

interface SkinDef {
  id:       string;
  name:     string;
  emoji:    string;
  price:    number;
  imageUrl: string;
  color:    string;
}

interface GameConfig {
  characterUrl:  string;
  targetUrl:     string;
  duration:      number;
  backgroundUrl: string;
  bgTheme:       number; // 0=auto-rotate, 1-5=specific theme
}

interface FallingItem {
  id:        number;
  x:         number;
  y:         number;
  speed:     number;
  collected: boolean;
  type:      'food' | 'magnet' | 'obstacle';
  lane:      number;
}

interface LeaderEntry {
  rank:      number;
  userId:    string;
  userName:  string;
  bestScore: number;
}

// ── Design tokens ────────────────────────────────────────────────────────────
const C = {
  bg:     '#05080f',
  green:  '#00f5d4',
  yellow: '#f5c518',
  blue:   '#00d4ff',
  red:    '#ff2d78',
  purple: '#7b2ff7',
  dim:    'rgba(255,255,255,0.35)',
  surface:'rgba(13,17,30,0.97)',
  border: 'rgba(255,255,255,0.09)',
};

const neon = (c: string, b = 8) => `0 0 ${b}px ${c}88, 0 0 ${b * 2}px ${c}44`;

// ── Skins catalog ─────────────────────────────────────────────────────────────
const SKINS: SkinDef[] = [
  {
    id:       'skin_captain',
    name:     'كابتن كشخة',
    emoji:    '🧢',
    price:    1000,
    imageUrl: 'https://api.dicebear.com/7.x/bottts/svg?seed=captain&backgroundColor=00f5d4',
    color:    '#00f5d4',
  },
  {
    id:       'skin_gold',
    name:     'السكن الذهبي',
    emoji:    '👑',
    price:    2500,
    imageUrl: 'https://api.dicebear.com/7.x/bottts/svg?seed=gold&backgroundColor=f5c518',
    color:    '#f5c518',
  },
  {
    id:       'skin_gas',
    name:     'مندوب الغاز السريع',
    emoji:    '🔥',
    price:    1500,
    imageUrl: 'https://api.dicebear.com/7.x/bottts/svg?seed=gasman&backgroundColor=ff2d78',
    color:    '#ff2d78',
  },
  {
    id:       'skin_ninja',
    name:     'النينجا الأسطوري',
    emoji:    '🥷',
    price:    3000,
    imageUrl: 'https://api.dicebear.com/7.x/bottts/svg?seed=ninja&backgroundColor=7b2ff7',
    color:    '#7b2ff7',
  },
];

// ── Game constants — Horizontal Runner ────────────────────────────────────────
const CHAR_W        = 64;
const CHAR_H        = 64;
const ITEM_W        = 48;
const ITEM_H        = 48;
const CHAR_SPEED    = 6;   // unused (kept for compat)
const RUSH_SPEED    = 12;  // px/frame — character rushes right on press
const RETURN_SPEED  = 8;   // px/frame — character snaps left on release
const ITEM_SPD_MIN  = 5.5; // horizontal item speed (px/frame)
const ITEM_SPD_VAR  = 4.0;
const BG_SCROLL_RUN = 6.0; // parallax speed when pressing (sprinting feel)
const BG_SCROLL_IDL = 2.5; // parallax speed when idle (always running)
const MAGNET_RAD    = 165; // magnet attraction radius (px)
const MAGNET_DUR    = 5000;// magnet duration (ms)
const DIFF_INTERVAL = 15000;// ms between difficulty steps
const DIFF_BOOST    = 0.10; // 10% speed increase per step
const JUMP_VEL         = -17;   // initial upward velocity (px/frame, negative = up)
const DOUBLE_JUMP_VEL  = -13;   // second jump initial velocity
const JUMP_GRAVITY     = 0.82;  // gravity applied each frame (px/frame²)

// ── Upgrade tables (indexed by level-1) ──────────────────────────────────────
const MAGNET_DUR_LVL  = [5000, 7500, 11000, 16000, 23000]; // ms per magnet level
const COMBO_WIN_LVL   = [2200, 2800,  3600,  4500,  6000]; // combo window ms per level
const UPGRADE_COSTS   = { magnet: [1500, 3000, 5000, 8000], combo: [1500, 3000, 5000, 8000] }; // cost per step
const MAX_UPG_LEVEL   = 5;

// ── Background Themes (5 procedural themes for parallax layers) ───────────────
const BG_THEMES = [
  // 0: Night City — default neon dark
  { name: 'ليل المدينة',      sky1: '#020510', sky2: '#08122a', horizon: '#0d1a3a',
    cloud1: '#1a2645', cloud2: '#101a35', star: '#cce0ff',
    bld1: '#060c1a', bld2: '#0a1020', win: '#f5c51830', palm: '#1a3010',
    fogR: 0, fogG: 212, fogB: 255, fogA: 0.035 },
  // 1: Sunset Dusk
  { name: 'غروب الشمس',      sky1: '#0f0510', sky2: '#9a3008', horizon: '#d05508',
    cloud1: '#cc3a1a', cloud2: '#882010', star: '#ffddaa',
    bld1: '#120815', bld2: '#1e0d0a', win: '#ff990030', palm: '#1a2a08',
    fogR: 255, fogG: 80,  fogB: 0,   fogA: 0.040 },
  // 2: Deep Space Purple
  { name: 'الفضاء البنفسجي', sky1: '#04000e', sky2: '#180035', horizon: '#28005a',
    cloud1: '#2a005a', cloud2: '#1a0040', star: '#ddaaff',
    bld1: '#0a0020', bld2: '#140038', win: '#dd00ff28', palm: '#1a0035',
    fogR: 180, fogG: 0,   fogB: 255, fogA: 0.050 },
  // 3: Desert Dawn
  { name: 'فجر الصحراء',     sky1: '#060c18', sky2: '#0e2040', horizon: '#1a3a5a',
    cloud1: '#ffffff15', cloud2: '#ffffff0a', star: '#aabbff',
    bld1: '#140e08', bld2: '#1e1508', win: '#ffbb4430', palm: '#2a4010',
    fogR: 255, fogG: 190, fogB: 0,   fogA: 0.025 },
  // 4: Cyberpunk Green
  { name: 'سايبر أخضر',      sky1: '#020a06', sky2: '#04200e', horizon: '#062a10',
    cloud1: '#083820', cloud2: '#052815', star: '#aaffcc',
    bld1: '#030d06', bld2: '#061510', win: '#00ff6630', palm: '#083810',
    fogR: 0,   fogG: 245, fogB: 100, fogA: 0.040 },
] as const;

// ── Dynamic skin def (from DB) ────────────────────────────────────────────────
interface DynSkinDef extends SkinDef { isActive?: boolean; }

// ── Component ────────────────────────────────────────────────────────────────
export function ChallengeModal({ onClose }: Props) {
  const [phase,       setPhase]       = useState<Phase>('menu');
  const [config,      setConfig]      = useState<GameConfig | null>(null);
  const [score,       setScore]       = useState(0);
  const [timeLeft,    setTimeLeft]    = useState(60);
  const [board,       setBoard]       = useState<LeaderEntry[]>([]);
  const [submitting,  setSubmitting]  = useState(false);
  const [submitErr,   setSubmitErr]   = useState('');
  const [boardLoading,setBoardLoading]= useState(false);

  // ── Profile / shop state ───────────────────────────────────────────────────
  const [profile,     setProfile]     = useState<GameProfile | null>(null);
  const [walletBal,    setWalletBal]    = useState(0);
  const [comboFlash,   setComboFlash]   = useState<string | null>(null);
  const [duelCode,     setDuelCode]     = useState<string | null>(null);
  const [duelBet,      setDuelBet]      = useState(500);
  const [duelCreating, setDuelCreating] = useState(false);
  const [duelTab,      setDuelTab]      = useState<'create' | 'join'>('create');
  const [duelJoinCode, setDuelJoinCode] = useState('');
  const [duelJoining,  setDuelJoining]  = useState(false);
  const [duelJoinErr,  setDuelJoinErr]  = useState('');
  const [duelResultMsg,setDuelResultMsg]= useState('');
  const activeDuelIdRef = useRef<string | null>(null);
  const [shopTab,      setShopTab]      = useState<'skins' | 'upgrades'>('skins');
  const [upgrading,    setUpgrading]    = useState<string | null>(null);
  const [shopBuying,  setShopBuying]  = useState<string | null>(null);
  const [shopMsg,     setShopMsg]     = useState('');
  const [redeeming,   setRedeeming]   = useState(false);
  const [dynSkins,    setDynSkins]    = useState<DynSkinDef[]>([]);

  // ── Global session state ────────────────────────────────────────────────────
  const [sessionItemsLeft,  setSessionItemsLeft]  = useState<number | null>(null);
  const [sessionActive,     setSessionActive]     = useState(false);
  const [sessionTotal,      setSessionTotal]      = useState<number>(100);
  const [externalCatchFlash,setExternalCatchFlash]= useState(false);   // "⚡ لاعب آخر التقط!"

  const canvasRef            = useRef<HTMLCanvasElement>(null);
  const rafRef               = useRef<number>(0);
  const timerRef             = useRef<ReturnType<typeof setInterval> | null>(null);
  const charImgRef           = useRef<HTMLImageElement | null>(null);
  const itemImgRef           = useRef<HTMLImageElement | null>(null);
  // refs accessible inside RAF loop without closure issues
  const userUidRef           = useRef<string | null>(null);
  const userNameRef          = useRef<string>('لاعب');
  const sessionItemsRef      = useRef<number | null>(null);
  const sessionActiveRef     = useRef<boolean>(false);
  const sseRef               = useRef<EventSource | null>(null);
  // external catch queue: items taken by OTHER players → remove from canvas
  const externalCatchQueue   = useRef<number>(0);
  // phase ref so SSE handler (no closure re-creation) can read current phase
  const phaseRef             = useRef<string>('menu');
  // flash timeout handle
  const flashTimerRef        = useRef<ReturnType<typeof setTimeout> | null>(null);

  // All mutable game state in a single ref (no re-render per frame)
  const gs = useRef({
    charX:        0,
    charY:        0,
    items:        [] as FallingItem[],
    score:        0,
    timeLeft:     60,
    pressing:     null as 'left' | 'right' | null,
    nextId:       0,
    lastSpawn:    0,
    running:      false,
    W:            380,
    H:            520,
    comboCount:   0,
    lastCatchTs:  0,
    bgScrollX:      0,
    speedBoost:     0,
    jumpYOffset:    0,
    jumpVelY:       0,
    jumpCount:      0,
    magnetActive:   false,
    magnetEnd:      0,
    diffMultiplier: 1.0,
    lastDiffTime:   0,
    magnetLevel:    1,   // from profile upgrade
    comboLevel:     1,   // from profile upgrade
    charLane:       1,   // 0=top 1=mid 2=ground
    charLaneY:      0,   // animated Y toward LANE_Y[charLane]; init on first frame
    lives:          3,   // player lives (obstacles reduce this)
    invincible:     0,   // ms timestamp — invincibility until
    bgThemeIdx:     0,   // current background theme index (0-4)
    particles:      [] as Array<{
      x: number; y: number; vx: number; vy: number;
      life: number; maxLife: number; color: string; size: number;
    }>,
  });

  const bgImgRef        = useRef<HTMLImageElement | null>(null);
  const audioCtxRef     = useRef<AudioContext | null>(null);
  const comboTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartTsRef = useRef(0);
  const holdTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTapTsRef    = useRef(0);

  // ── Fetch game config ──────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/game/config')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((d: GameConfig) => setConfig({
        characterUrl:  d.characterUrl  ?? '',
        targetUrl:     d.targetUrl     ?? '',
        duration:      d.duration      ?? 60,
        backgroundUrl: d.backgroundUrl ?? '',
        bgTheme:       d.bgTheme       ?? 0,
      }))
      .catch(() => setConfig({ characterUrl: '', targetUrl: '', duration: 60, backgroundUrl: '', bgTheme: 0 }));
  }, []);

  // ── Load player profile ────────────────────────────────────────────────────
  const loadProfile = useCallback(async () => {
    const user = auth.currentUser;
    if (!user) return;
    try {
      const profRes = await fetch(`/api/game/profile/${user.uid}`);
      if (profRes.ok) setProfile(await profRes.json());
    } catch { /* silent */ }
  }, []);

  useEffect(() => { loadProfile(); }, [loadProfile]);

  // ── Live Firestore balance subscription (محفظة التطبيق الحقيقية) ───────────
  useEffect(() => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    const unsub = onSnapshot(
      doc(db, 'users', uid),
      snap => { if (snap.exists()) setWalletBal(Number(snap.data()?.balance ?? 0)); },
      () => { /* Firestore error — keep last known value */ }
    );
    return () => unsub();
  }, []);

  // ── Load dynamic skins from DB ─────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/game/shop/items')
      .then(r => r.ok ? r.json() : [])
      .then((rows: Array<{ id: number; name: string; emoji: string; price: number; imageUrl: string; color: string; category: string }>) => {
        const skins = rows
          .filter(r => r.category === 'skin')
          .map(r => ({
            id:       `skin_db_${r.id}`,
            name:     r.name,
            emoji:    r.emoji,
            price:    r.price,
            imageUrl: r.imageUrl,
            color:    r.color,
          } satisfies DynSkinDef));
        if (skins.length > 0) setDynSkins(skins);
      })
      .catch(() => {});
  }, []);

  // Keep phaseRef in sync with React state (SSE handler reads it without closure issues)
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // ── Session fetch + SSE listener ────────────────────────────────────────────
  useEffect(() => {
    // Cache user info in refs (accessible inside RAF without closure)
    const user = auth.currentUser;
    if (user) {
      userUidRef.current  = user.uid;
      userNameRef.current = user.displayName ?? 'لاعب';
    }

    // Fetch current active session
    fetch('/api/game/session')
      .then(r => r.ok ? r.json() : null)
      .then((s: { sessionId: string; totalItems: number; itemsLeft: number; isActive: boolean } | null) => {
        if (s && s.isActive) {
          setSessionActive(true);
          setSessionTotal(s.totalItems);
          setSessionItemsLeft(s.itemsLeft);
          sessionItemsRef.current  = s.itemsLeft;
          sessionActiveRef.current = true;
        }
      })
      .catch(() => {});

    // Open SSE stream and listen for game_session_update
    const es = new EventSource('/api/events');
    sseRef.current = es;
    es.addEventListener('game_session_update', (e: MessageEvent) => {
      try {
        const { session } = JSON.parse(e.data) as {
          session: { sessionId: string; totalItems: number; itemsLeft: number; isActive: boolean };
        };

        // ── Detect external catches (items taken by OTHER players) ────────────
        // Our optimistic decrement keeps sessionItemsRef ahead. If server says
        // even LOWER, the difference = items grabbed by others this frame.
        const prevItems = sessionItemsRef.current;
        if (
          prevItems !== null &&
          session.isActive &&
          session.itemsLeft < prevItems &&
          phaseRef.current === 'playing'
        ) {
          const externalCount = prevItems - session.itemsLeft;
          externalCatchQueue.current += externalCount;
          // Show flash overlay "⚡ لاعب آخر التقط عنصراً!"
          setExternalCatchFlash(true);
          if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
          flashTimerRef.current = setTimeout(() => setExternalCatchFlash(false), 1600);
        }

        setSessionActive(session.isActive);
        setSessionTotal(session.totalItems);
        setSessionItemsLeft(session.itemsLeft);
        sessionItemsRef.current  = session.itemsLeft;
        sessionActiveRef.current = session.isActive;
      } catch { /* ignore malformed event */ }
    });

    return () => {
      es.close();
      sseRef.current = null;
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, []);

  // ── Shop: buy a skin ───────────────────────────────────────────────────────
  const buySkin = useCallback(async (skin: SkinDef) => {
    const user = auth.currentUser;
    if (!user) { setShopMsg('يجب تسجيل الدخول أولاً'); return; }
    setShopBuying(skin.id);
    setShopMsg('');
    try {
      // Deduct from Firestore balance first
      const userRef = doc(db, 'users', user.uid);
      await runTransaction(db, async txn => {
        const snap = await txn.get(userRef);
        const bal  = Number(snap.data()?.balance ?? 0);
        if (bal < skin.price) throw new Error(`رصيدك ${bal.toLocaleString()} د.ع — المطلوب ${skin.price.toLocaleString()} د.ع`);
        txn.update(userRef, { balance: increment(-skin.price) });
      });
      // Tell server to record the skin (no balance check needed)
      const r = await fetch('/api/game/shop/buy-skin', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ firebaseUid: user.uid, skinId: skin.id, price: skin.price, preAuthorized: true }),
      });
      const d = await r.json();
      if (!r.ok) {
        // Refund on server failure
        runTransaction(db, async txn => { txn.update(userRef, { balance: increment(skin.price) }); }).catch(() => {});
        setShopMsg(d.message ?? 'فشل الشراء'); return;
      }
      setProfile(p => p ? { ...p, gameCash: d.gameCash, unlockedSkins: d.unlockedSkins } : p);
      setShopMsg(`✓ تم شراء "${skin.name}" بنجاح!`);
    } catch (e: any) { setShopMsg(e?.message ?? 'خطأ في الاتصال'); }
    finally  { setShopBuying(null); }
  }, []);

  // ── Shop: equip a skin (immediate canvas update) ───────────────────────────
  const equipSkin = useCallback(async (skin: SkinDef) => {
    const user = auth.currentUser;
    if (!user) return;
    // Update charImgRef immediately so the game uses it right away
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { charImgRef.current = img; };
    img.src = skin.imageUrl;
    // Persist to server
    try {
      await fetch(`/api/game/profile/${user.uid}/active-skin`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ skinId: skin.id }),
      });
    } catch { /* non-critical */ }
    setProfile(p => p ? { ...p, activeSkin: skin.id } : p);
    setShopMsg(`✓ تم تفعيل "${skin.name}"!`);
  }, []);

  // ── Shop: redeem points ─────────────────────────────────────────────────────
  const redeemPoints = useCallback(async () => {
    const user = auth.currentUser;
    if (!user) { setShopMsg('يجب تسجيل الدخول أولاً'); return; }
    setRedeeming(true);
    setShopMsg('');
    try {
      const r = await fetch('/api/game/shop/redeem-points', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ firebaseUid: user.uid }),
      });
      const d = await r.json();
      if (!r.ok) { setShopMsg(d.message ?? 'فشل الاستبدال'); return; }
      setProfile(p => p ? { ...p, gamePoints: d.gamePoints, gameCash: d.gameCash } : p);
      setShopMsg(`✓ تم إضافة ${d.cashEarned} دينار إلى رصيدك!`);
    } catch { setShopMsg('خطأ في الاتصال'); }
    finally  { setRedeeming(false); }
  }, []);

  // ── Upgrade ability (magnet / combo) ──────────────────────────────────────
  const upgradeAbility = useCallback(async (statType: 'magnet' | 'combo') => {
    const user = auth.currentUser;
    if (!user || !profile) { setShopMsg('يجب تسجيل الدخول أولاً'); return; }
    const currentLevel = statType === 'magnet' ? profile.magnetLevel : profile.comboLevel;
    if (currentLevel >= MAX_UPG_LEVEL) { setShopMsg('وصلت للحد الأقصى!'); return; }
    const UPG_COSTS = [1500, 3000, 5000, 8000];
    const cost = UPG_COSTS[currentLevel - 1] ?? 1500;
    setUpgrading(statType);
    setShopMsg('');
    try {
      // Deduct from Firestore balance first
      const userRef = doc(db, 'users', user.uid);
      await runTransaction(db, async txn => {
        const snap = await txn.get(userRef);
        const bal  = Number(snap.data()?.balance ?? 0);
        if (bal < cost) throw new Error(`رصيدك ${bal.toLocaleString()} د.ع — المطلوب ${cost.toLocaleString()} د.ع`);
        txn.update(userRef, { balance: increment(-cost) });
      });
      // Tell server to apply level-up (no balance check needed)
      const r = await fetch('/api/game/shop/upgrade', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firebaseUid: user.uid, statType, preAuthorized: true }),
      });
      const d = await r.json();
      if (!r.ok) {
        // Refund on server failure
        runTransaction(db, async txn => { txn.update(userRef, { balance: increment(cost) }); }).catch(() => {});
        setShopMsg(d.message ?? 'فشل التطوير'); return;
      }
      setProfile(p => p ? {
        ...p,
        gameCash:    d.gameCash,
        magnetLevel: d.magnetLevel ?? p.magnetLevel,
        comboLevel:  d.comboLevel  ?? p.comboLevel,
      } : p);
      const label = statType === 'magnet' ? 'المغناطيس' : 'الكومبو';
      setShopMsg(`✓ تم ترقية ${label} إلى مستوى ${d.newLevel}! 🚀`);
    } catch (e: any) { setShopMsg(e?.message ?? 'خطأ في الاتصال'); }
    finally  { setUpgrading(null); }
  }, [profile]);

  // ── Load leaderboard ───────────────────────────────────────────────────────
  const loadBoard = useCallback(async () => {
    setBoardLoading(true);
    try {
      const r = await fetch('/api/game/leaderboard');
      const d = await r.json();
      setBoard(Array.isArray(d) ? d : []);
    } catch {
      setBoard([]);
    } finally {
      setBoardLoading(false);
    }
  }, []);

  // ── Cleanup on unmount ─────────────────────────────────────────────────────
  useEffect(() => () => {
    gs.current.running = false;
    cancelAnimationFrame(rafRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  // ── End game ───────────────────────────────────────────────────────────────
  const endGame = useCallback(() => {
    gs.current.running = false;
    cancelAnimationFrame(rafRef.current);
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    const finalScore = gs.current.score;
    setScore(finalScore);
    setDuelResultMsg('');
    setPhase('gameover');
    const duelId = activeDuelIdRef.current;
    const uid    = userUidRef.current;
    if (duelId && uid) {
      fetch('/api/game/duel/score', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firebaseUid: uid, duelId, score: finalScore }),
      }).then(r => r.ok ? r.json() : null)
        .then((d: { done?: boolean; youWon?: boolean; winnerScore?: number; loserScore?: number; prize?: number; waiting?: boolean } | null) => {
          if (!d) return;
          if (d.done) {
            const msg = d.youWon
              ? `🏆 فزت! ربحت ${(d.prize ?? 0).toLocaleString()} د.ع`
              : `❌ خسرت! نتيجة الفائز: ${d.winnerScore}`;
            setDuelResultMsg(msg);
            const u = auth.currentUser;
            if (u && d.youWon && d.prize) {
              // Credit prize to Firestore balance (محفظة التطبيق)
              runTransaction(db, async txn => {
                txn.update(doc(db, 'users', u.uid), { balance: increment(d.prize!) });
              }).catch(() => {});
            }
          } else if (d.waiting) {
            setDuelResultMsg('⏳ تم تسجيل نتيجتك — بانتظار الخصم...');
          }
        }).catch(() => {});
    }
  }, []);

  // Jump mechanic removed — horizontal-only runner

  // ── Draw one frame — Horizontal Runner ────────────────────────────────────
  const drawFrame = useCallback((ts: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const g = gs.current;
    const { W, H } = g;

    const BASE_X   = Math.round(W * 0.16);
    const MAX_X    = Math.round(W * 0.60);
    const GROUND_Y = Math.round(H * 0.74);
    const LANE_Y   = [GROUND_Y - 110, GROUND_Y - 55, GROUND_Y] as [number, number, number];
    const BASE_Y   = LANE_Y[2]; // character always anchored to ground lane

    // ── Jump physics (gravity arc) ───────────────────────────────────────────
    if (g.jumpYOffset < 0 || g.jumpVelY < 0) {
      g.jumpVelY   += JUMP_GRAVITY;
      g.jumpYOffset += g.jumpVelY;
      if (g.jumpYOffset >= 0) {
        g.jumpYOffset = 0;
        g.jumpVelY   = 0;
        g.jumpCount  = 0; // reset jumps on landing
      }
    }
    const charDrawY = Math.round(BASE_Y + g.jumpYOffset);

    // ── Character FIXED at left — infinite runner, bg scrolls past ───────────
    g.charX = BASE_X;

    // ── Progressive difficulty (every 15 s) ───────────────────────────────────
    if (g.lastDiffTime === 0) g.lastDiffTime = ts;
    if (ts - g.lastDiffTime > DIFF_INTERVAL) {
      g.diffMultiplier = Math.min(g.diffMultiplier * (1 + DIFF_BOOST), 2.8);
      g.lastDiffTime   = ts;
    }

    // ── Parallax scroll — always running; hold = sprint (faster BG) ─────────
    const scrollSpd = BG_SCROLL_IDL + (g.pressing === 'right' ? BG_SCROLL_RUN : 0);
    g.bgScrollX = (g.bgScrollX + scrollSpd * g.diffMultiplier) % W;

    // Score-based speed boost
    g.speedBoost = Math.min(2.5, g.score * 0.07);

    // ── Magnet attraction ─────────────────────────────────────────────────────
    if (g.magnetActive && Date.now() < g.magnetEnd) {
      for (const item of g.items) {
        if (item.collected || item.type === 'magnet' || item.type === 'obstacle') continue;
        const dx   = g.charX - item.x;
        const dy   = charDrawY - item.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < MAGNET_RAD && dist > 1) {
          const pull = Math.min(12, 900 / (dist + 1));
          item.x += (dx / dist) * pull;
          item.y += (dy / dist) * pull;
        }
      }
    } else if (g.magnetActive) {
      g.magnetActive = false;
    }

    // ── Spawn items + obstacles (3 lanes) ────────────────────────────────────
    const baseInterval  = Math.max(400, 900 - g.score * 6);
    const spawnInterval = baseInterval / g.diffMultiplier;
    if (ts - g.lastSpawn > spawnInterval) {
      const isMagnet   = (g.nextId > 3) && (Math.random() < 0.10);
      const isObstacle = !isMagnet && (Math.random() < 0.20);
      // Obstacles always on GROUND lane — player must JUMP to dodge
      // Food items at all 3 heights — player jumps to catch higher ones
      const lane       = isMagnet ? 2 : isObstacle ? 2 : Math.floor(Math.random() * 3);
      const itemY      = LANE_Y[lane];
      g.items.push({
        id:        g.nextId++,
        x:         W + ITEM_W,
        y:         itemY,
        lane,
        speed:     (ITEM_SPD_MIN + Math.random() * ITEM_SPD_VAR + g.speedBoost) * g.diffMultiplier,
        collected: false,
        type:      isMagnet ? 'magnet' : isObstacle ? 'obstacle' : 'food',
      });
      g.lastSpawn = ts;
    }

    // ── Update items + collision ──────────────────────────────────────────────
    const now_ms = Date.now();
    for (const item of g.items) {
      if (item.collected) continue;
      item.x -= item.speed;
      const dx = Math.abs(item.x - g.charX);
      const dy = Math.abs(item.y - charDrawY);
      if (dx < (CHAR_W / 2 + ITEM_W / 2) * 0.82 && dy < (CHAR_H / 2 + ITEM_H / 2) * 1.10) {
        if (item.type === 'obstacle') {
          // Only collide if player is on (or near) the ground — jumping = dodge!
          const onGround = g.jumpYOffset > -22;
          if (onGround && now_ms > g.invincible) {
            item.collected = true;
            g.comboCount = 0;       // break the combo streak
            g.invincible = now_ms + 900;
            // Emit red impact particles
            for (let pi = 0; pi < 10; pi++) {
              const ang = (Math.PI * 2 * pi) / 10 + Math.random() * 0.6;
              const spd = 2 + Math.random() * 3.5;
              g.particles.push({
                x: item.x, y: item.y,
                vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd - 1.5,
                life: 20 + Math.floor(Math.random() * 12), maxLife: 32,
                color: '#ff2d78', size: 3,
              });
            }
            try {
              if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
              const actx = audioCtxRef.current;
              const osc  = actx.createOscillator();
              const gain = actx.createGain();
              osc.connect(gain); gain.connect(actx.destination);
              osc.type = 'sawtooth'; osc.frequency.value = 100;
              gain.gain.setValueAtTime(0.25, actx.currentTime);
              gain.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.28);
              osc.start(actx.currentTime); osc.stop(actx.currentTime + 0.28);
            } catch {}
            if (comboTimerRef.current) clearTimeout(comboTimerRef.current);
            setComboFlash('💥 انكسر الكومبو!');
            comboTimerRef.current = setTimeout(() => setComboFlash(null), 900);
          }
          continue;
        }
        item.collected = true;
        if (item.type === 'magnet') {
          g.magnetActive = true;
          g.magnetEnd    = Date.now() + (MAGNET_DUR_LVL[g.magnetLevel - 1] ?? MAGNET_DUR);
          try {
            if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
            const actx = audioCtxRef.current;
            for (let i = 0; i < 3; i++) {
              const mo = actx.createOscillator();
              const mg = actx.createGain();
              mo.connect(mg); mg.connect(actx.destination);
              mo.frequency.value = 440 + i * 220;
              mo.type = 'sine';
              mg.gain.setValueAtTime(0.14, actx.currentTime + i * 0.07);
              mg.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + i * 0.07 + 0.18);
              mo.start(actx.currentTime + i * 0.07);
              mo.stop(actx.currentTime + i * 0.07 + 0.18);
            }
          } catch {}
          if (comboTimerRef.current) clearTimeout(comboTimerRef.current);
          setComboFlash('🧲 مغناطيس!');
          comboTimerRef.current = setTimeout(() => setComboFlash(null), 1600);
        } else {
          const timeSinceLast = ts - g.lastCatchTs;
          const comboWin      = COMBO_WIN_LVL[g.comboLevel - 1] ?? 2200;
          g.comboCount  = timeSinceLast < comboWin ? Math.min(g.comboCount + 1, 10) : 1;
          g.lastCatchTs = ts;
          const combo      = g.comboCount;
          const multiplier = combo >= 3 ? combo : 1;
          g.score += multiplier;
          setScore(g.score);
          // ── Emit catch particles ────────────────────────────────────────────
          {
            const pCount = combo >= 5 ? 16 : combo >= 3 ? 12 : 7;
            const pColor = combo >= 5 ? '#ff9900' : combo >= 3 ? '#f5c518' : '#00f5d4';
            for (let pi = 0; pi < pCount; pi++) {
              const ang = (Math.PI * 2 * pi) / pCount + Math.random() * 0.55;
              const spd = 2.5 + Math.random() * 4;
              g.particles.push({
                x: item.x, y: item.y,
                vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd - 2.5,
                life: 22 + Math.floor(Math.random() * 18), maxLife: 40,
                color: pColor, size: combo >= 3 ? 4 : 2.5,
              });
            }
          }
          try {
            if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
            const actx = audioCtxRef.current;
            const osc  = actx.createOscillator();
            const gain = actx.createGain();
            osc.connect(gain); gain.connect(actx.destination);
            osc.frequency.value = combo >= 3 ? 880 + (combo - 3) * 130 : 560;
            osc.type = combo >= 3 ? 'triangle' : 'sine';
            gain.gain.setValueAtTime(0.28, actx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.22);
            osc.start(actx.currentTime);
            osc.stop(actx.currentTime + 0.22);
          } catch {}
          if (combo >= 3) {
            if (comboTimerRef.current) clearTimeout(comboTimerRef.current);
            setComboFlash(`Combo ×${combo}!`);
            comboTimerRef.current = setTimeout(() => setComboFlash(null), 950);
          }
          const uid = userUidRef.current;
          if (uid && sessionActiveRef.current && (sessionItemsRef.current ?? 1) > 0) {
            if (sessionItemsRef.current !== null) sessionItemsRef.current = Math.max(0, sessionItemsRef.current - 1);
            fetch('/api/game/session/catch', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ firebaseUid: uid, userName: userNameRef.current }),
            }).then(r => r.ok ? r.json() : null)
              .then((res: { caught: boolean } | null) => {
                if (res?.caught) setProfile(p => p ? { ...p, gamePoints: p.gamePoints + multiplier } : p);
              }).catch(() => {});
          }
        }
      }
    }
    g.items = g.items.filter(it => !it.collected && it.x > -ITEM_W * 2);

    if (externalCatchQueue.current > 0) {
      const visible  = g.items.filter(it => !it.collected && it.type === 'food');
      const toRemove = Math.min(externalCatchQueue.current, visible.length);
      for (let i = 0; i < toRemove; i++) visible[i].collected = true;
      externalCatchQueue.current = Math.max(0, externalCatchQueue.current - toRemove);
      g.items = g.items.filter(it => !it.collected);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // DRAW — 3-Layer Parallax Background + HUD
    // ══════════════════════════════════════════════════════════════════════════
    const theme = BG_THEMES[g.bgThemeIdx % BG_THEMES.length];

    // ── Layer 0: Sky + Stars + Clouds (speed 0.08×) ───────────────────────────
    const skyOff = (g.bgScrollX * 0.08) % W;
    const skyGrad = ctx.createLinearGradient(0, 0, 0, GROUND_Y + 20);
    skyGrad.addColorStop(0,   theme.sky1);
    skyGrad.addColorStop(0.7, theme.sky2);
    skyGrad.addColorStop(1,   theme.horizon);
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, W, GROUND_Y + 20);

    // Stars — seeded positions, slow parallax, twinkle via sin
    for (let i = 0; i < 45; i++) {
      const sx = ((i * 137.508 + skyOff * 0.35) % W + W) % W;
      const sy = ((i * 71.317) % (GROUND_Y * 0.62)) + 4;
      const sz = 0.6 + (i % 3) * 0.4;
      ctx.globalAlpha = Math.max(0.1, 0.35 + Math.sin(ts * 0.0008 + i * 1.73) * 0.28);
      ctx.fillStyle = theme.star;
      ctx.beginPath(); ctx.arc(sx, sy, sz, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Clouds — 2 passes for seamless infinite loop
    const cloudOff = (g.bgScrollX * 0.08) % W;
    const CLOUDS = [
      { x: 0.10, y: 0.08, rx: 40, ry: 14 },
      { x: 0.33, y: 0.14, rx: 58, ry: 19 },
      { x: 0.56, y: 0.06, rx: 46, ry: 15 },
      { x: 0.78, y: 0.12, rx: 52, ry: 17 },
    ];
    for (let pass = 0; pass < 2; pass++) {
      const cx0 = -(cloudOff % W) + pass * W;
      for (const c of CLOUDS) {
        const ccx = cx0 + c.x * W;
        const ccy = c.y * GROUND_Y;
        ctx.save();
        ctx.globalAlpha = 0.20;
        ctx.fillStyle = theme.cloud1;
        ctx.beginPath(); ctx.ellipse(ccx, ccy, c.rx, c.ry, 0, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 0.12;
        ctx.fillStyle = theme.cloud2;
        ctx.beginPath(); ctx.ellipse(ccx - 16, ccy + 5, c.rx * 0.60, c.ry * 0.80, 0, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
    }

    // ── Layer 1: Midground Buildings + Palm Trees (speed 0.30×) ──────────────
    const midOff = (g.bgScrollX * 0.30) % W;
    const BLDGS = [
      { x: 0.04, w: 0.07, h: 0.31 }, { x: 0.14, w: 0.05, h: 0.44 },
      { x: 0.21, w: 0.09, h: 0.26 }, { x: 0.32, w: 0.06, h: 0.50 },
      { x: 0.40, w: 0.08, h: 0.34 }, { x: 0.51, w: 0.05, h: 0.40 },
      { x: 0.58, w: 0.10, h: 0.28 }, { x: 0.70, w: 0.06, h: 0.46 },
      { x: 0.78, w: 0.07, h: 0.36 }, { x: 0.88, w: 0.08, h: 0.30 },
    ];
    const PALMS = [
      { x: 0.08, h: 54 }, { x: 0.25, h: 62 }, { x: 0.44, h: 50 },
      { x: 0.63, h: 58 }, { x: 0.82, h: 52 }, { x: 0.95, h: 60 },
    ];
    for (let pass = 0; pass < 2; pass++) {
      const ox = -(midOff % W) + pass * W;

      // Buildings silhouette
      for (const b of BLDGS) {
        const bh  = b.h * GROUND_Y * 0.65;
        const bx2 = ox + b.x * W;
        const by2 = GROUND_Y - bh;
        ctx.fillStyle = theme.bld1;
        ctx.fillRect(bx2, by2, b.w * W, bh);
        // Window glow dots
        ctx.fillStyle = theme.win;
        for (let wy = by2 + 8; wy < GROUND_Y - 10; wy += 14) {
          for (let wx = bx2 + 5; wx < bx2 + b.w * W - 5; wx += 10) {
            if (Math.sin(wx * 3.7 + wy * 1.3 + g.bgThemeIdx * 2.1) > 0.22) {
              ctx.fillRect(wx, wy, 4, 6);
            }
          }
        }
        // Rooftop neon edge
        const fogClr = `rgba(${theme.fogR},${theme.fogG},${theme.fogB},${theme.fogA * 6})`;
        ctx.fillStyle = fogClr;
        ctx.fillRect(bx2, by2, b.w * W, 2);
      }

      // Palm trees with wind animation
      for (const p of PALMS) {
        const px   = ox + p.x * W;
        const baseY = GROUND_Y;
        const trunkH = p.h;
        const wind   = Math.sin(ts * 0.0018 + p.x * 7.3) * 3; // gentle sway

        // Trunk (curved quadratic)
        ctx.strokeStyle = theme.palm;
        ctx.lineWidth = 3.5;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.moveTo(px, baseY);
        ctx.quadraticCurveTo(px + 6 + wind * 0.3, baseY - trunkH * 0.55, px + 4 + wind, baseY - trunkH);
        ctx.stroke();

        // Fronds (5 radiating arcs from top)
        const topX = px + 4 + wind;
        const topY = baseY - trunkH;
        ctx.lineWidth = 1.8;
        const frondAngles = [-0.85, -0.35, 0.05, 0.50, 0.95];
        for (const a of frondAngles) {
          const flen = 18 + Math.sin(ts * 0.002 + p.x * 5.1 + a) * 2.5;
          ctx.beginPath();
          ctx.moveTo(topX, topY);
          ctx.lineTo(
            topX + Math.cos(a) * flen * 1.4,
            topY - Math.sin(Math.abs(a - 0.15) + 0.2) * flen
          );
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    }

    // Horizon atmospheric fog gradient (ties sky to road)
    const horizFog = ctx.createLinearGradient(0, GROUND_Y - 35, 0, GROUND_Y + 12);
    horizFog.addColorStop(0, 'transparent');
    horizFog.addColorStop(1, `rgba(${theme.fogR},${theme.fogG},${theme.fogB},${theme.fogA})`);
    ctx.fillStyle = horizFog;
    ctx.fillRect(0, GROUND_Y - 35, W, 47);

    // Scanlines
    ctx.fillStyle = 'rgba(0,0,0,0.14)';
    for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 2);

    // Difficulty red tint (grows with speed)
    if (g.diffMultiplier > 1.08) {
      ctx.fillStyle = `rgba(255,45,120,${Math.min(0.07, (g.diffMultiplier - 1) * 0.04)})`;
      ctx.fillRect(0, 0, W, H);
    }

    // Road
    const roadTop = GROUND_Y - CHAR_H / 2 - 6;
    const roadH   = H - roadTop;
    const roadGrad = ctx.createLinearGradient(0, roadTop, 0, H);
    roadGrad.addColorStop(0, '#0d1220');
    roadGrad.addColorStop(1, '#070b15');
    ctx.fillStyle = roadGrad;
    ctx.fillRect(0, roadTop, W, roadH);

    ctx.strokeStyle = 'rgba(0,212,255,0.18)';
    ctx.lineWidth   = 2;
    ctx.setLineDash([22, 18]);
    ctx.lineDashOffset = -(g.bgScrollX * 1.6) % 40;
    const laneY = roadTop + roadH * 0.38;
    ctx.beginPath(); ctx.moveTo(0, laneY); ctx.lineTo(W, laneY); ctx.stroke();
    ctx.setLineDash([]);

    const glowGrad = ctx.createLinearGradient(0, roadTop - 3, 0, roadTop + 8);
    glowGrad.addColorStop(0, '#00f5d488');
    glowGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = glowGrad;
    ctx.fillRect(0, roadTop - 3, W, 11);
    ctx.strokeStyle = '#00f5d466';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, roadTop); ctx.lineTo(W, roadTop); ctx.stroke();

    // Speed streaks — always show (runner always moves, more intense on sprint)
    {
      const streakAlpha = g.pressing === 'right' ? 0.28 : 0.10;
      const streakCount = g.pressing === 'right' ? 9 : 4;
      ctx.save();
      ctx.globalAlpha = streakAlpha;
      for (let i = 0; i < streakCount; i++) {
        const sy   = roadTop + 4 + Math.random() * (roadH - 8);
        const slen = 20 + Math.random() * 55;
        const sx   = BASE_X + 20 + Math.random() * (W - BASE_X - 20);
        const streak = ctx.createLinearGradient(sx - slen, sy, sx, sy);
        streak.addColorStop(0, 'transparent');
        streak.addColorStop(1, g.pressing === 'right' ? '#00d4ff' : '#00f5d466');
        ctx.fillStyle = streak;
        ctx.fillRect(sx - slen, sy - 1, slen, 2);
      }
      ctx.restore();
    }

    // Magnet halo
    if (g.magnetActive && Date.now() < g.magnetEnd) {
      const fracLeft = (g.magnetEnd - Date.now()) / MAGNET_DUR;
      ctx.save();
      ctx.globalAlpha = Math.min(1, fracLeft * 2) * 0.45 + Math.sin(ts * 0.012) * 0.07;
      const mh = ctx.createRadialGradient(g.charX, charDrawY, 10, g.charX, charDrawY, MAGNET_RAD);
      mh.addColorStop(0, '#f5c51822'); mh.addColorStop(0.65, '#f5c51811'); mh.addColorStop(1, 'transparent');
      ctx.fillStyle = mh;
      ctx.beginPath(); ctx.arc(g.charX, charDrawY, MAGNET_RAD, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `rgba(245,197,24,${0.35 + Math.sin(ts * 0.012) * 0.12})`;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 9]);
      ctx.lineDashOffset = -(ts * 0.06) % 15;
      ctx.beginPath(); ctx.arc(g.charX, charDrawY, MAGNET_RAD, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // ── Particle system — update physics + draw ───────────────────────────────
    for (let pi = g.particles.length - 1; pi >= 0; pi--) {
      const p = g.particles[pi];
      p.life--;
      if (p.life <= 0) { g.particles.splice(pi, 1); continue; }
      p.x  += p.vx;
      p.y  += p.vy;
      p.vy += 0.25; // gravity
      p.vx *= 0.96; // air drag
      const alpha = (p.life / p.maxLife);
      ctx.save();
      ctx.globalAlpha = alpha * 0.92;
      ctx.fillStyle   = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur  = 8;
      // Star shape for combo particles, circle for regular
      const sz = p.size * (0.5 + alpha * 0.5);
      ctx.beginPath();
      ctx.arc(p.x, p.y, sz, 0, Math.PI * 2);
      ctx.fill();
      // Sparkle cross for larger particles
      if (p.size >= 3.5) {
        ctx.globalAlpha = alpha * 0.55;
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(p.x - sz * 2, p.y); ctx.lineTo(p.x + sz * 2, p.y);
        ctx.moveTo(p.x, p.y - sz * 2); ctx.lineTo(p.x, p.y + sz * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Items
    for (const item of g.items) {
      if (item.collected) continue;
      const bob = Math.sin(ts * 0.006 + item.id) * 4;
      ctx.save();
      if (item.type === 'obstacle') {
        // Brick wall obstacle — must jump to dodge
        const obFlash = g.invincible > Date.now() && Math.floor(ts / 130) % 2 === 0;
        ctx.globalAlpha = obFlash ? 0.28 : 1;
        const bW = ITEM_W + 10, bH = Math.round(ITEM_H * 0.75);
        const bx = item.x - bW / 2, by = item.y - bH + 4;
        // Drop shadow
        ctx.shadowColor = '#ff2d78cc'; ctx.shadowBlur = 18;
        ctx.fillStyle = '#1a0508';
        ctx.fillRect(bx + 3, by + 4, bW, bH);
        // Brick gradient face
        const bGrad = ctx.createLinearGradient(bx, by, bx, by + bH);
        bGrad.addColorStop(0, '#8b1a1a');
        bGrad.addColorStop(0.5, '#6b1212');
        bGrad.addColorStop(1, '#3a0808');
        ctx.fillStyle = bGrad;
        ctx.shadowBlur = 0;
        ctx.fillRect(bx, by, bW, bH);
        // Brick mortar lines
        ctx.strokeStyle = '#ff2d7833';
        ctx.lineWidth = 1;
        // Horizontal lines
        ctx.beginPath();
        ctx.moveTo(bx, by + bH * 0.5); ctx.lineTo(bx + bW, by + bH * 0.5);
        ctx.stroke();
        // Vertical lines (offset per row)
        ctx.beginPath();
        ctx.moveTo(bx + bW * 0.5, by); ctx.lineTo(bx + bW * 0.5, by + bH * 0.5);
        ctx.moveTo(bx + bW * 0.25, by + bH * 0.5); ctx.lineTo(bx + bW * 0.25, by + bH);
        ctx.moveTo(bx + bW * 0.75, by + bH * 0.5); ctx.lineTo(bx + bW * 0.75, by + bH);
        ctx.stroke();
        // Warning pulse glow on top edge
        ctx.fillStyle = `rgba(255,45,120,${0.55 + Math.sin(ts * 0.018) * 0.30})`;
        ctx.fillRect(bx, by - 3, bW, 4);
        // Outer neon border
        ctx.strokeStyle = `rgba(255,45,120,${0.50 + Math.sin(ts * 0.012) * 0.25})`;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(bx, by, bW, bH);
      } else if (item.type === 'magnet') {
        ctx.shadowColor = '#f5c518cc'; ctx.shadowBlur = 20;
        ctx.font = '36px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('🧲', item.x, item.y + bob);
        ctx.shadowBlur = 0;
        ctx.strokeStyle = `rgba(245,197,24,${0.5 + Math.sin(ts * 0.01 + item.id) * 0.2})`;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(item.x, item.y + bob, ITEM_W * 0.65, 0, Math.PI * 2); ctx.stroke();
      } else if (itemImgRef.current) {
        ctx.shadowColor = '#f5c51899'; ctx.shadowBlur = 14;
        ctx.drawImage(itemImgRef.current, item.x - ITEM_W / 2, item.y - ITEM_H / 2 + bob, ITEM_W, ITEM_H);
      } else {
        ctx.font = '34px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.shadowColor = C.yellow; ctx.shadowBlur = 16;
        ctx.fillText('🍔', item.x, item.y + bob);
      }
      ctx.restore();
    }

    // Character (flashes when invincible)
    const rushing      = g.pressing === 'right';
    const airborne     = g.jumpYOffset < -6;
    const isInvincible = g.invincible > Date.now();
    const charVisible  = !isInvincible || (Math.floor(ts / 110) % 2 === 0);
    if (charVisible) {
      ctx.save();
      ctx.shadowColor = isInvincible ? '#ff2d7888'
                      : airborne     ? '#f5c51888'
                      : rushing      ? '#00d4ff88'
                      :                '#00f5d455';
      ctx.shadowBlur  = airborne ? 20 : rushing ? 22 : 12;
      ctx.globalAlpha = isInvincible ? 0.65 : 1;
      if (charImgRef.current) {
        // Character always faces RIGHT (mirrored) — always running forward
        ctx.save();
        ctx.translate(g.charX + CHAR_W / 2, 0);
        ctx.scale(-1, 1);
        // Slight lean forward on sprint, bounce on ground
        const lean = g.pressing === 'right' ? 0.12 : airborne ? -0.06 : 0;
        if (lean !== 0) {
          ctx.translate(0, charDrawY);
          ctx.rotate(lean);
          ctx.translate(0, -charDrawY);
        }
        ctx.drawImage(charImgRef.current, -CHAR_W / 2, charDrawY - CHAR_H / 2, CHAR_W, CHAR_H);
        ctx.restore();
      } else {
        ctx.font = '44px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const emoji = airborne ? (g.jumpCount >= 2 ? '🦋' : '🦅') : g.pressing === 'right' ? '🏃' : '🚶';
        ctx.fillText(emoji, g.charX, charDrawY);
      }
      ctx.restore();
    }

    // Jump arc shadow (ellipse on ground when airborne)
    if (airborne) {
      ctx.save();
      const shadowY   = BASE_Y + 4;
      const shadowAmt = Math.max(0, 1 + g.jumpYOffset / 110); // fade as rising
      ctx.globalAlpha = shadowAmt * 0.30;
      const shG = ctx.createRadialGradient(g.charX, shadowY, 0, g.charX, shadowY, CHAR_W * 0.75);
      shG.addColorStop(0, '#f5c51866'); shG.addColorStop(1, 'transparent');
      ctx.fillStyle = shG;
      ctx.fillRect(g.charX - CHAR_W, shadowY - 5, CHAR_W * 2, 10);
      ctx.restore();
    }

    // Ground shadow
    ctx.save();
    ctx.globalAlpha = rushing ? 0.45 : 0.28;
    const shGrad = ctx.createRadialGradient(g.charX, roadTop + 2, 0, g.charX, roadTop + 2, CHAR_W * 0.60);
    shGrad.addColorStop(0, rushing ? '#00d4ff55' : '#00f5d444'); shGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = shGrad;
    ctx.fillRect(g.charX - CHAR_W * 0.65, roadTop - 2, CHAR_W * 1.3, 8);
    ctx.restore();

    // ── Lives HUD (top-left) ─────────────────────────────────────────────────
    for (let i = 0; i < 3; i++) {
      ctx.save();
      ctx.globalAlpha = i < g.lives ? 1 : 0.18;
      ctx.shadowColor = i < g.lives ? '#ff2d78cc' : 'transparent';
      ctx.shadowBlur  = i < g.lives ? 8 : 0;
      ctx.font = '17px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('❤', 10 + i * 22, 10);
      ctx.restore();
    }

    // ── Jump charge indicator (top-right: 2 triangles = available jumps) ────
    for (let ji = 0; ji < 2; ji++) {
      const used = ji < g.jumpCount; // used = grayed out
      ctx.save();
      ctx.globalAlpha = used ? 0.14 : 0.82;
      ctx.fillStyle   = used ? '#555' : '#f5c518';
      ctx.shadowColor = used ? 'transparent' : '#f5c518cc';
      ctx.shadowBlur  = used ? 0 : 9;
      ctx.font = '13px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
      ctx.fillText('▲', W - 8, 8 + ji * 17);
      ctx.restore();
    }

    // ── COMBO counter — big fiery canvas text ────────────────────────────────
    if (g.comboCount >= 2) {
      const cVal  = g.comboCount;
      const cSize = Math.min(46, 22 + cVal * 2.8);
      const cX    = W / 2;
      const cY    = GROUND_Y - 90 + Math.sin(ts * 0.022) * (cVal >= 5 ? 7 : 3);
      ctx.save();
      ctx.font         = `900 ${cSize}px Orbitron, sans-serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      // Outer flame glow
      ctx.globalAlpha = 0.95;
      ctx.shadowColor = cVal >= 7 ? '#ff4400' : cVal >= 5 ? '#ff7700' : '#f5c518';
      ctx.shadowBlur  = 28 + cVal * 4;
      ctx.fillStyle   = cVal >= 7 ? '#ff6600' : cVal >= 5 ? '#ffaa00' : '#f5c518';
      ctx.fillText(`×${cVal}`, cX, cY);
      // Inner bright white core
      ctx.shadowBlur  = 10;
      ctx.globalAlpha = 0.65;
      ctx.fillStyle   = '#fff';
      ctx.fillText(`×${cVal}`, cX, cY);
      // Combo label
      ctx.shadowBlur  = 0;
      ctx.globalAlpha = 0.55;
      ctx.font = `700 10px Orbitron, sans-serif`;
      ctx.fillStyle = cVal >= 5 ? '#ffaa00' : '#f5c518';
      ctx.fillText('COMBO', cX, cY + cSize * 0.65);
      ctx.restore();
    }

    // ── Sprint indicator (bottom-center pill) ───────────────────────────────
    if (g.pressing === 'right') {
      ctx.save();
      ctx.globalAlpha = 0.72;
      ctx.fillStyle   = '#00d4ff18';
      ctx.strokeStyle = '#00d4ff66';
      ctx.lineWidth   = 1;
      const pw = 64, ph = 16, px2 = (W - pw) / 2, py2 = H - 36;
      ctx.beginPath();
      ctx.roundRect(px2, py2, pw, ph, 8);
      ctx.fill(); ctx.stroke();
      ctx.font = '700 9px Orbitron, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#00d4ff';
      ctx.shadowColor = '#00d4ffaa'; ctx.shadowBlur = 8;
      ctx.fillText('⚡ سريع', W / 2, py2 + ph / 2);
      ctx.restore();
    }
  }, [endGame]);

  // ── Start game ─────────────────────────────────────────────────────────────
  const startGame = useCallback(async () => {
    if (!config) return;
    setPhase('loading');
    setSubmitErr('');

    const loadImg = (url: string): Promise<HTMLImageElement | null> => {
      if (!url) return Promise.resolve(null);
      return new Promise(res => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload  = () => res(img);
        img.onerror = () => res(null);
        img.src = url;
      });
    };

    const loadBg = (url: string) => new Promise<HTMLImageElement | null>(res => {
      if (!url) { res(null); return; }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload  = () => res(img);
      img.onerror = () => res(null);
      img.src = url;
    });

    const [ci, ii, bg] = await Promise.all([
      loadImg(config.characterUrl),
      loadImg(config.targetUrl),
      loadBg(config.backgroundUrl),
    ]);
    charImgRef.current = ci;
    itemImgRef.current = ii;
    bgImgRef.current   = bg;

    // Wait for React to flush the DOM (canvas is now rendered during 'loading' phase)
    await new Promise(r => setTimeout(r, 120));

    const canvas = canvasRef.current;
    if (!canvas) { setPhase('menu'); return; }
    const W = canvas.offsetWidth  || 380;
    const H = canvas.offsetHeight || 520;
    canvas.width  = W;
    canvas.height = H;

    const g = gs.current;
    g.charX      = Math.round(W * 0.16);   // start on LEFT side
    g.charY      = Math.round(H * 0.74);
    g.items      = [];
    g.score      = 0;
    g.timeLeft   = config.duration;
    g.pressing   = null;
    g.nextId     = 0;
    g.lastSpawn  = 0;
    g.running    = true;
    g.comboCount = 0;
    g.lastCatchTs= 0;
    g.bgScrollX      = 0;
    g.speedBoost     = 0;
    g.jumpYOffset    = 0;
    g.jumpVelY       = 0;
    g.jumpCount      = 0;
    g.magnetActive   = false;
    g.magnetEnd      = 0;
    g.diffMultiplier = 1.0;
    g.lastDiffTime   = 0;
    g.particles      = [];
    g.magnetLevel    = profile?.magnetLevel ?? 1;
    g.comboLevel     = profile?.comboLevel  ?? 1;
    g.charLane       = 1;   // start in middle lane
    g.charLaneY      = 0;   // init'd on first drawFrame
    g.lives          = 3;
    g.invincible     = 0;
    // ── Theme selection ───────────────────────────────────────────────────────
    const themeMode = config.bgTheme ?? 0;
    if (themeMode === 0) {
      // auto-rotate: advance to next theme each game
      g.bgThemeIdx = (g.bgThemeIdx + 1) % BG_THEMES.length;
    } else {
      g.bgThemeIdx = Math.max(0, Math.min(BG_THEMES.length - 1, themeMode - 1));
    }
    g.W = W; g.H = H;

    setScore(0);
    setTimeLeft(config.duration);
    setPhase('playing');

    // Timer countdown
    timerRef.current = setInterval(() => {
      gs.current.timeLeft -= 1;
      setTimeLeft(t => {
        const next = t - 1;
        if (next <= 0) endGame();
        return next;
      });
    }, 1000);

    // RAF game loop
    const loop = (ts: number) => {
      if (!gs.current.running) {
        if (gs.current.lives <= 0) endGame();
        return;
      }
      drawFrame(ts);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [config, drawFrame, endGame]);

  // ── Submit score ───────────────────────────────────────────────────────────
  const submitScore = useCallback(async () => {
    const user = auth.currentUser;
    if (!user) { setSubmitErr('يجب تسجيل الدخول لحفظ نتيجتك'); return; }
    setSubmitting(true);
    setSubmitErr('');
    try {
      const r = await fetch('/api/game/score', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          userId:   user.uid,
          userName: user.displayName || 'لاعب',
          score:    gs.current.score,
        }),
      });
      if (!r.ok) throw new Error('failed');
      await loadBoard();
      setPhase('leaderboard');
    } catch {
      setSubmitErr('فشل إرسال النتيجة، حاول مجدداً');
    } finally {
      setSubmitting(false);
    }
  }, [loadBoard]);

  // ── Pressing controls ──────────────────────────────────────────────────────
  const pressLeft  = useCallback(() => { gs.current.pressing = 'left';  }, []);
  const pressRight = useCallback(() => { gs.current.pressing = 'right'; }, []);
  const pressStop  = useCallback(() => { gs.current.pressing = null;     }, []);
  const triggerJump = useCallback(() => {
    const g   = gs.current;
    const now = Date.now();
    const isDouble = now - lastTapTsRef.current < 320 && g.jumpCount === 1;
    lastTapTsRef.current = now;
    if (isDouble) {
      // Double jump — give a fresh upward boost in mid-air
      g.jumpVelY   = DOUBLE_JUMP_VEL;
      g.jumpCount  = 2;
    } else if (g.jumpCount === 0) {
      // First jump from ground
      g.jumpVelY    = JUMP_VEL;
      g.jumpYOffset = -1; // nudge off ground so physics starts
      g.jumpCount   = 1;
    }
  }, []);

  const acceptDuel = useCallback(async () => {
    const uid = auth.currentUser?.uid;
    if (!uid) { setDuelJoinErr('يجب تسجيل الدخول أولاً'); return; }
    if (!duelJoinCode.trim()) { setDuelJoinErr('أدخل رمز التحدي'); return; }
    setDuelJoining(true); setDuelJoinErr('');
    try {
      // Fetch room info to get bet amount
      const roomRes = await fetch(`/api/game/duel/${duelJoinCode.trim().toUpperCase()}`);
      if (!roomRes.ok) { setDuelJoinErr('رمز التحدي غير صحيح'); return; }
      const room = await roomRes.json();
      const bet  = room.bet as number;
      // Deduct bet from Firestore balance
      const userRef = doc(db, 'users', uid);
      await runTransaction(db, async txn => {
        const snap = await txn.get(userRef);
        const bal  = Number(snap.data()?.balance ?? 0);
        if (bal < bet) throw new Error(`رصيدك ${bal.toLocaleString()} د.ع — المطلوب ${bet.toLocaleString()} د.ع`);
        txn.update(userRef, { balance: increment(-bet) });
      });
      // Activate room on server
      const r = await fetch('/api/game/duel/accept', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firebaseUid: uid, duelId: duelJoinCode.trim().toUpperCase() }),
      });
      const d = await r.json();
      if (!r.ok) {
        // Refund on server error
        runTransaction(db, async txn => { txn.update(userRef, { balance: increment(bet) }); }).catch(() => {});
        setDuelJoinErr(d.message ?? d.error ?? 'فشل الانضمام'); return;
      }
      activeDuelIdRef.current = duelJoinCode.trim().toUpperCase();
      startGame();
    } catch (e: any) { setDuelJoinErr(e?.message ?? 'خطأ في الاتصال'); }
    finally  { setDuelJoining(false); }
  }, [duelJoinCode, startGame]);

  // Medal helper
  const medal = (rank: number) => rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9600,
        background: 'rgba(5,8,15,0.96)',
        backdropFilter: 'blur(14px)',
        display: 'flex', flexDirection: 'column',
        fontFamily: 'Orbitron, Rajdhani, sans-serif',
        direction: 'rtl',
        overflow: 'hidden',
      }}
    >
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 18px',
        borderBottom: `1px solid ${C.border}`,
        background: C.surface,
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '20px' }}>🔥</span>
          <span style={{
            fontFamily: 'Orbitron, sans-serif', fontSize: '15px',
            color: C.yellow, letterSpacing: '0.14em',
            fontWeight: 900,
            textShadow: `0 0 8px ${C.yellow}, 0 0 22px ${C.yellow}88, 0 0 48px #ff990055`,
          }}>تحدي المعدّل</span>
        </div>

        {phase === 'playing' && (
          <div style={{ display: 'flex', gap: '14px', alignItems: 'center' }}>
            <div style={{
              fontFamily: 'Orbitron, sans-serif', fontSize: '13px',
              color: C.green, letterSpacing: '0.08em',
              textShadow: neon(C.green, 6),
            }}>
              ✦ <strong>{score}</strong>
            </div>
            <div style={{
              fontFamily: 'Orbitron, sans-serif', fontSize: '13px',
              color: timeLeft <= 10 ? C.red : C.blue,
              letterSpacing: '0.08em',
              textShadow: neon(timeLeft <= 10 ? C.red : C.blue, 6),
              animation: timeLeft <= 10 ? 'pulse 0.6s ease-in-out infinite alternate' : 'none',
            }}>
              ⏱ {timeLeft}ث
            </div>
            {sessionActive && sessionItemsLeft !== null && (
              <div style={{
                fontFamily: 'Orbitron, sans-serif', fontSize: '11px',
                color: sessionItemsLeft === 0 ? C.red : C.yellow,
                letterSpacing: '0.06em',
                textShadow: neon(sessionItemsLeft === 0 ? C.red : C.yellow, 5),
                background: `rgba(0,0,0,0.3)`,
                padding: '3px 8px', borderRadius: '10px',
                border: `1px solid ${sessionItemsLeft === 0 ? C.red : C.yellow}33`,
                transition: 'all 0.3s',
              }}>
                🎯 {sessionItemsLeft}/{sessionTotal}
              </div>
            )}
          </div>
        )}

        <button
          onClick={() => { gs.current.running = false; cancelAnimationFrame(rafRef.current); if (timerRef.current) clearInterval(timerRef.current); onClose(); }}
          style={{
            background: 'transparent', border: 'none',
            color: C.dim, fontSize: '20px', cursor: 'pointer', lineHeight: 1,
            padding: '4px 8px',
          }}
        >✕</button>
      </div>

      {/* ── MENU ─────────────────────────────────────────────────────────────── */}
      {(phase === 'menu' || phase === 'loading') && (
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: '28px',
          padding: '24px',
        }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '64px', marginBottom: '12px' }}>🏆</div>
            <div style={{
              fontFamily: 'Orbitron, sans-serif', fontSize: '24px',
              background: 'linear-gradient(90deg, #f5c518, #ff9900, #f5c518)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              letterSpacing: '0.14em',
              fontWeight: 900,
              textShadow: 'none',
              filter: 'drop-shadow(0 0 14px #f5c51899)',
              marginBottom: '10px',
            }}>تحدي المعدّل</div>
            <div style={{ color: C.dim, fontSize: '13px', lineHeight: 1.8, maxWidth: '290px', margin: '0 auto' }}>
              اصطد أكبر قدر من العناصر خلال {config?.duration ?? 60} ثانية!<br/>
              انقر مرة = قفز 🦅 • انقر مرتين سريعاً = قفزة مزدوجة<br/>
              اضغط مطوّلاً = سرعة قصوى ⚡ • المغناطيس 🧲 يجذب كل شيء!<br/>
              <span style={{ color: C.red }}>احذر الطوب 🧱 — اقفز لتتجنبه وإلا يكسر الكومبو!</span>
            </div>
          </div>

          {/* ── Live Session Banner ───────────────────────────────────────────── */}
          {sessionActive && sessionItemsLeft !== null && (
            <div style={{
              width: '100%', maxWidth: '300px',
              background: `linear-gradient(135deg, ${C.yellow}14, ${C.yellow}08)`,
              border: `1px solid ${C.yellow}55`,
              borderRadius: '10px',
              padding: '12px 16px',
              display: 'flex', flexDirection: 'column', gap: '8px',
            }}>
              {/* Title row */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{
                  fontFamily: 'Orbitron, sans-serif', fontSize: '11px',
                  color: C.yellow, letterSpacing: '0.08em',
                  textShadow: neon(C.yellow, 5),
                }}>🏆 تحدي جماعي نشط!</span>
                <span style={{
                  fontFamily: 'Orbitron, sans-serif', fontSize: '13px',
                  color: sessionItemsLeft === 0 ? C.red : C.green,
                  textShadow: neon(sessionItemsLeft === 0 ? C.red : C.green, 6),
                  fontWeight: 700,
                }}>
                  {sessionItemsLeft === 0 ? '⛔ انتهت العناصر' : `متبقي ${sessionItemsLeft} عنصر فقط!`}
                </span>
              </div>
              {/* Progress bar */}
              <div style={{
                width: '100%', height: '6px', borderRadius: '3px',
                background: `${C.yellow}22`,
                overflow: 'hidden',
              }}>
                <div style={{
                  height: '100%', borderRadius: '3px',
                  width: `${Math.max(0, (sessionItemsLeft / sessionTotal) * 100)}%`,
                  background: sessionItemsLeft < sessionTotal * 0.2
                    ? `linear-gradient(90deg, ${C.red}, ${C.yellow})`
                    : `linear-gradient(90deg, ${C.green}, ${C.yellow})`,
                  transition: 'width 0.4s ease, background 0.4s',
                  boxShadow: neon(C.yellow, 4),
                }} />
              </div>
              <div style={{ fontSize: '10px', color: C.dim, textAlign: 'center' }}>
                {sessionTotal - sessionItemsLeft} من {sessionTotal} عنصر تم التقاطه من اللاعبين
              </div>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '100%', maxWidth: '300px' }}>
            <button
              onClick={startGame}
              disabled={!config || phase === 'loading'}
              style={{
                padding: '16px', borderRadius: '6px',
                background: `linear-gradient(135deg, ${C.yellow}22, ${C.yellow}11)`,
                border: `1.5px solid ${C.yellow}88`,
                color: C.yellow, fontFamily: 'Orbitron, sans-serif',
                fontSize: '14px', letterSpacing: '0.12em',
                cursor: !config || phase === 'loading' ? 'not-allowed' : 'pointer',
                textShadow: neon(C.yellow, 7),
                boxShadow: neon(C.yellow, 6),
                opacity: !config || phase === 'loading' ? 0.5 : 1,
                transition: 'all 0.2s',
              }}
            >
              {phase === 'loading' ? '⏳ جاري التحضير...' : '▶ ابدأ اللعبة'}
            </button>

            <button
              onClick={async () => { await loadBoard(); setPhase('leaderboard'); }}
              style={{
                padding: '14px', borderRadius: '6px',
                background: `${C.blue}11`,
                border: `1px solid ${C.blue}44`,
                color: C.blue, fontFamily: 'Orbitron, sans-serif',
                fontSize: '12px', letterSpacing: '0.1em',
                cursor: 'pointer', transition: 'all 0.2s',
              }}
            >
              🏅 قائمة متصدري المعدل
            </button>

            <button
              onClick={() => { setShopMsg(''); setPhase('shop'); }}
              style={{
                padding: '14px', borderRadius: '6px',
                background: `${C.purple}11`,
                border: `1px solid ${C.purple}44`,
                color: C.purple, fontFamily: 'Orbitron, sans-serif',
                fontSize: '12px', letterSpacing: '0.1em',
                cursor: 'pointer', transition: 'all 0.2s',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
              }}
            >
              🛍 المتجر
              {(
                <span style={{ fontSize: '10px', background: `${C.yellow}22`, padding: '2px 7px', borderRadius: '10px', color: C.yellow }}>
                  💰 {walletBal.toLocaleString()} د.ع
                </span>
              )}
            </button>

            <button
              onClick={() => {
                setDuelCode(null); setDuelBet(500);
                setDuelTab('create'); setDuelJoinCode(''); setDuelJoinErr('');
                activeDuelIdRef.current = null;
                setPhase('duel');
              }}
              style={{
                padding: '14px', borderRadius: '6px',
                background: `${C.red}11`,
                border: `1px solid ${C.red}44`,
                color: C.red, fontFamily: 'Orbitron, sans-serif',
                fontSize: '12px', letterSpacing: '0.1em',
                cursor: 'pointer', transition: 'all 0.2s',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
              }}
            >
              ⚔ تحدي صديق
            </button>
          </div>
        </div>
      )}

      {/* ── PLAYING (canvas is mounted during loading too so ref is valid) ──── */}
      {(phase === 'playing' || phase === 'loading') && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Loading overlay — visible only while images load */}
          {phase === 'loading' && (
            <div style={{
              position: 'absolute', inset: 0, zIndex: 10,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(5,8,15,0.92)',
              flexDirection: 'column', gap: '16px',
            }}>
              <div style={{ fontSize: '40px', animation: 'spin 1s linear infinite' }}>⏳</div>
              <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '13px', color: C.yellow, letterSpacing: '0.1em' }}>
                جاري التحضير...
              </div>
            </div>
          )}
          {/* ── External-catch flash overlay ──────────────────────────────── */}
          {externalCatchFlash && (
            <div style={{
              position: 'absolute', top: '60px', left: '50%', transform: 'translateX(-50%)',
              zIndex: 20, pointerEvents: 'none',
              background: `linear-gradient(135deg, ${C.red}cc, ${C.yellow}99)`,
              border: `1px solid ${C.red}88`,
              borderRadius: '22px', padding: '6px 18px',
              fontFamily: 'Orbitron, sans-serif', fontSize: '11px',
              color: '#fff', letterSpacing: '0.07em',
              textShadow: neon(C.red, 6),
              boxShadow: `0 0 14px ${C.red}88`,
              animation: 'fadeInOut 1.6s ease forwards',
              whiteSpace: 'nowrap',
            }}>
              ⚡ لاعب آخر التقط عنصراً!
            </div>
          )}

          {/* Canvas */}
          {/* Combo flash overlay */}
          {comboFlash && (
            <div style={{
              position: 'absolute', top: '38%', left: '50%',
              transform: 'translate(-50%, -50%)',
              zIndex: 25, pointerEvents: 'none',
              fontFamily: 'Orbitron, sans-serif',
              fontSize: '28px', fontWeight: 900,
              color: C.yellow,
              textShadow: `${neon(C.yellow, 14)}, 0 2px 8px #000`,
              letterSpacing: '0.08em',
              animation: 'fadeInOut 0.9s ease forwards',
              whiteSpace: 'nowrap',
            }}>
              ⚡ {comboFlash}
            </div>
          )}

          {/* Touch hint — only shown on first play */}
          {phase === 'playing' && (
            <div style={{
              position: 'absolute', bottom: '10px', left: 0, right: 0,
              textAlign: 'center', pointerEvents: 'none',
              fontFamily: 'Orbitron, sans-serif', fontSize: '10px',
              color: 'rgba(0,212,255,0.40)', letterSpacing: '0.06em',
            }}>
              انقر = قفز  •  انقر مرتين سريعاً = قفزة مزدوجة 🦅  •  اضغط مطوّلاً = سرعة قصوى ⚡
            </div>
          )}

          <canvas
            ref={canvasRef}
            onMouseDown={() => {
              touchStartTsRef.current = Date.now();
              if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
              holdTimerRef.current = setTimeout(() => { gs.current.pressing = 'right'; }, 180);
            }}
            onMouseUp={() => {
              const dur = Date.now() - touchStartTsRef.current;
              if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
              gs.current.pressing = null;
              if (dur < 180) triggerJump();
            }}
            onMouseLeave={() => {
              if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
              gs.current.pressing = null;
            }}
            onTouchStart={e => {
              e.preventDefault();
              touchStartTsRef.current = Date.now();
              if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
              holdTimerRef.current = setTimeout(() => { gs.current.pressing = 'right'; }, 180);
            }}
            onTouchEnd={e => {
              e.preventDefault();
              const dur = Date.now() - touchStartTsRef.current;
              if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
              gs.current.pressing = null;
              if (dur < 180) triggerJump();
            }}
            onTouchCancel={e => {
              e.preventDefault();
              if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
              gs.current.pressing = null;
            }}
            style={{
              flex: 1, width: '100%', display: 'block',
              touchAction: 'none', cursor: 'pointer',
              visibility: phase === 'loading' ? 'hidden' : 'visible',
            }}
          />
        </div>
      )}

      {/* ── GAME OVER ────────────────────────────────────────────────────────── */}
      {phase === 'gameover' && (
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: '24px',
          padding: '28px',
        }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '52px', marginBottom: '8px' }}>🎮</div>
            <div style={{
              fontFamily: 'Orbitron, sans-serif', fontSize: '16px',
              color: C.green, letterSpacing: '0.12em',
              textShadow: neon(C.green, 8), marginBottom: '6px',
            }}>انتهت اللعبة!</div>
            <div style={{ color: C.dim, fontSize: '13px' }}>نتيجتك النهائية</div>
            {duelResultMsg && (
              <div style={{
                marginTop: '8px', padding: '8px 16px', borderRadius: '8px',
                background: duelResultMsg.startsWith('🏆') ? `${C.yellow}18` : duelResultMsg.startsWith('⏳') ? `${C.blue}18` : `${C.red}18`,
                border: `1px solid ${duelResultMsg.startsWith('🏆') ? C.yellow + '55' : duelResultMsg.startsWith('⏳') ? C.blue + '55' : C.red + '55'}`,
                color: duelResultMsg.startsWith('🏆') ? C.yellow : duelResultMsg.startsWith('⏳') ? C.blue : C.red,
                fontFamily: 'Orbitron, sans-serif', fontSize: '12px', letterSpacing: '0.06em',
                textShadow: duelResultMsg.startsWith('🏆') ? neon(C.yellow, 6) : 'none',
              }}>{duelResultMsg}</div>
            )}
          </div>

          {/* Big score display */}
          <div style={{
            padding: '20px 48px', borderRadius: '10px',
            background: `${C.yellow}11`,
            border: `2px solid ${C.yellow}55`,
            boxShadow: neon(C.yellow, 12),
            textAlign: 'center',
          }}>
            <div style={{ color: C.dim, fontSize: '11px', letterSpacing: '0.1em', marginBottom: '6px' }}>النقاط</div>
            <div style={{
              fontFamily: 'Orbitron, sans-serif', fontSize: '48px',
              color: C.yellow, letterSpacing: '0.05em',
              textShadow: neon(C.yellow, 14),
            }}>{score}</div>
          </div>

          {submitErr && (
            <div style={{ color: C.red, fontSize: '12px', textAlign: 'center' }}>{submitErr}</div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', width: '100%', maxWidth: '300px' }}>
            <button
              onClick={submitScore}
              disabled={submitting}
              style={{
                padding: '15px', borderRadius: '6px',
                background: `linear-gradient(135deg, ${C.green}22, ${C.green}11)`,
                border: `1.5px solid ${C.green}88`,
                color: C.green, fontFamily: 'Orbitron, sans-serif',
                fontSize: '13px', letterSpacing: '0.1em',
                cursor: submitting ? 'not-allowed' : 'pointer',
                textShadow: neon(C.green, 6),
                opacity: submitting ? 0.6 : 1,
                transition: 'all 0.2s',
              }}
            >
              {submitting ? '⏳ جاري الحفظ...' : '💾 احفظ نتيجتي'}
            </button>

            <button
              onClick={async () => { await loadBoard(); setPhase('leaderboard'); }}
              style={{
                padding: '13px', borderRadius: '6px',
                background: `${C.blue}11`,
                border: `1px solid ${C.blue}44`,
                color: C.blue, fontFamily: 'Orbitron, sans-serif',
                fontSize: '12px', letterSpacing: '0.1em',
                cursor: 'pointer', transition: 'all 0.2s',
              }}
            >
              🏅 قائمة متصدري المعدل
            </button>

            <button
              onClick={startGame}
              style={{
                padding: '13px', borderRadius: '6px',
                background: `${C.purple}11`,
                border: `1px solid ${C.purple}44`,
                color: C.purple, fontFamily: 'Orbitron, sans-serif',
                fontSize: '12px', letterSpacing: '0.1em',
                cursor: 'pointer', transition: 'all 0.2s',
              }}
            >
              🔄 العب مجدداً
            </button>
          </div>
        </div>
      )}

      {/* ── FRIENDLY DUEL ────────────────────────────────────────────────────── */}
      {phase === 'duel' && (
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          gap: '22px', padding: '28px 24px',
        }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '56px', marginBottom: '10px' }}>⚔</div>
            <div style={{
              fontFamily: 'Orbitron, sans-serif', fontSize: '18px',
              color: C.red, letterSpacing: '0.12em',
              textShadow: neon(C.red, 10), marginBottom: '8px',
            }}>تحدي صديق</div>
            <div style={{ color: C.dim, fontSize: '12px', lineHeight: 1.7, maxWidth: '260px', margin: '0 auto' }}>
              أنشئ رابط تحدي خاص وشاركه مع صديق — من يحصل على أعلى نقطة يفوز برسوم التحدي!
            </div>
          </div>

          {/* ── Tab bar: Create / Join ────────────────────────────────────── */}
          {!duelCode && (
            <div style={{ display: 'flex', gap: '8px', width: '100%', maxWidth: '300px' }}>
              {(['create', 'join'] as const).map(tab => (
                <button key={tab} onClick={() => { setDuelTab(tab); setDuelJoinErr(''); }}
                  style={{
                    flex: 1, padding: '9px 0', borderRadius: '6px',
                    background: duelTab === tab ? `${C.red}22` : 'transparent',
                    border: `1.5px solid ${duelTab === tab ? C.red + '88' : C.red + '33'}`,
                    color: duelTab === tab ? C.red : C.dim,
                    fontFamily: 'Orbitron, sans-serif', fontSize: '11px',
                    letterSpacing: '0.08em', cursor: 'pointer', transition: 'all 0.2s',
                  }}>
                  {tab === 'create' ? '🔗 أنشئ تحدياً' : '⚔ انضم لتحدٍ'}
                </button>
              ))}
            </div>
          )}

          {!duelCode && duelTab === 'create' ? (
            <div style={{
              width: '100%', maxWidth: '300px',
              background: `${C.red}0d`, border: `1px solid ${C.red}33`,
              borderRadius: '10px', padding: '20px 18px',
              display: 'flex', flexDirection: 'column', gap: '14px',
            }}>
              <div style={{ fontSize: '10px', color: C.dim, textAlign: 'center' }}>
                رصيدك: <span style={{ color: C.yellow }}>{walletBal.toLocaleString()} د.ع</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '11px', color: C.dim, letterSpacing: '0.08em' }}>
                  رسوم التحدي (دينار عراقي)
                </label>
                <input
                  type="number" min={100} max={50000} step={100}
                  value={duelBet}
                  onChange={e => setDuelBet(Math.max(100, Number(e.target.value)))}
                  style={{
                    background: '#0a0f1c', border: `1px solid ${C.red}44`,
                    borderRadius: '6px', padding: '10px 14px',
                    color: C.red, fontFamily: 'Orbitron, sans-serif',
                    fontSize: '16px', textAlign: 'center', outline: 'none',
                    width: '100%', boxSizing: 'border-box' as const,
                  }}
                />
              </div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' as const }}>
                {[500, 1000, 2000, 5000].map(v => (
                  <button key={v} onClick={() => setDuelBet(v)} style={{
                    flex: 1, padding: '6px 0', borderRadius: '5px',
                    background: duelBet === v ? `${C.red}33` : `${C.red}0d`,
                    border: `1px solid ${duelBet === v ? C.red : C.red + '33'}`,
                    color: C.red, fontFamily: 'Orbitron, sans-serif',
                    fontSize: '11px', cursor: 'pointer',
                  }}>{v.toLocaleString()}</button>
                ))}
              </div>
              {duelBet > walletBal && (
                <div style={{ fontSize: '11px', color: C.red, textAlign: 'center', fontFamily: 'Rajdhani, sans-serif' }}>
                  ⚠ رسوم التحدي أكبر من رصيدك ({walletBal.toLocaleString()} د.ع)
                </div>
              )}
              <button
                disabled={duelCreating || duelBet > walletBal}
                onClick={async () => {
                  const uid = auth.currentUser?.uid;
                  if (!uid) return;
                  setDuelCreating(true);
                  try {
                    // Deduct bet from Firestore balance first
                    const userRef = doc(db, 'users', uid);
                    await runTransaction(db, async txn => {
                      const snap = await txn.get(userRef);
                      const bal  = Number(snap.data()?.balance ?? 0);
                      if (bal < duelBet) throw new Error(`رصيدك ${bal.toLocaleString()} د.ع — المطلوب ${duelBet.toLocaleString()} د.ع`);
                      txn.update(userRef, { balance: increment(-duelBet) });
                    });
                    // Ask server to create room (no balance ops on server)
                    const r = await fetch('/api/game/duel/create', {
                      method: 'POST', headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ firebaseUid: uid, bet: duelBet }),
                    });
                    const data = await r.json();
                    if (!r.ok) {
                      // Refund on server failure
                      runTransaction(db, async txn => { txn.update(userRef, { balance: increment(duelBet) }); }).catch(() => {});
                      setDuelJoinErr(data.message ?? data.error ?? 'فشل الإنشاء'); return;
                    }
                    if (data.duelId) setDuelCode(data.duelId);
                  } catch (e: any) { setDuelJoinErr(e?.message ?? 'خطأ في الاتصال'); }
                  finally { setDuelCreating(false); }
                }}
                style={{
                  padding: '14px', borderRadius: '6px',
                  background: (duelCreating || duelBet > walletBal) ? `${C.red}0d` : `linear-gradient(135deg, ${C.red}33, ${C.red}18)`,
                  border: `1.5px solid ${C.red}88`,
                  color: C.red, fontFamily: 'Orbitron, sans-serif',
                  fontSize: '13px', letterSpacing: '0.1em',
                  cursor: (duelCreating || duelBet > walletBal) ? 'not-allowed' : 'pointer',
                  textShadow: neon(C.red, 6), boxShadow: neon(C.red, 5),
                  transition: 'all 0.2s', opacity: duelBet > walletBal ? 0.5 : 1,
                }}
              >
                {duelCreating ? '⏳ جاري الإنشاء...' : '🔗 أنشئ التحدي وادفع رسوم التحدي'}
              </button>
              {duelJoinErr && (
                <div style={{ fontSize: '11px', color: C.red, textAlign: 'center', fontFamily: 'Rajdhani, sans-serif' }}>
                  {duelJoinErr}
                </div>
              )}
            </div>
          ) : !duelCode && duelTab === 'join' ? (
            <div style={{
              width: '100%', maxWidth: '300px',
              background: `${C.blue}0d`, border: `1px solid ${C.blue}33`,
              borderRadius: '10px', padding: '20px 18px',
              display: 'flex', flexDirection: 'column', gap: '14px',
            }}>
              <div style={{ fontSize: '10px', color: C.dim, textAlign: 'center' }}>
                رصيدك: <span style={{ color: C.yellow }}>{walletBal.toLocaleString()} د.ع</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '11px', color: C.dim, letterSpacing: '0.08em' }}>
                  رمز التحدي (6 أحرف)
                </label>
                <input
                  type="text" maxLength={6} value={duelJoinCode}
                  onChange={e => { setDuelJoinCode(e.target.value.toUpperCase()); setDuelJoinErr(''); }}
                  placeholder="مثال: AB3XY7"
                  style={{
                    background: '#0a0f1c', border: `1px solid ${C.blue}44`,
                    borderRadius: '6px', padding: '10px 14px',
                    color: C.blue, fontFamily: 'Orbitron, sans-serif',
                    fontSize: '20px', textAlign: 'center', outline: 'none',
                    width: '100%', boxSizing: 'border-box' as const, letterSpacing: '0.22em',
                  }}
                />
              </div>
              {duelJoinErr && (
                <div style={{ fontSize: '11px', color: C.red, textAlign: 'center', fontFamily: 'Rajdhani, sans-serif' }}>
                  {duelJoinErr}
                </div>
              )}
              <button
                disabled={duelJoining || !duelJoinCode.trim()}
                onClick={acceptDuel}
                style={{
                  padding: '14px', borderRadius: '6px',
                  background: duelJoining ? `${C.blue}0d` : `linear-gradient(135deg, ${C.blue}33, ${C.blue}18)`,
                  border: `1.5px solid ${C.blue}88`,
                  color: C.blue, fontFamily: 'Orbitron, sans-serif',
                  fontSize: '13px', letterSpacing: '0.1em',
                  cursor: (duelJoining || !duelJoinCode.trim()) ? 'not-allowed' : 'pointer',
                  textShadow: neon(C.blue, 6), boxShadow: neon(C.blue, 5),
                  transition: 'all 0.2s',
                }}
              >
                {duelJoining ? '⏳ جاري الانضمام...' : '⚔ انضم وادفع رسوم التحدي'}
              </button>
            </div>
          ) : duelCode ? (
            <div style={{
              width: '100%', maxWidth: '300px',
              background: `${C.green}0d`, border: `1px solid ${C.green}44`,
              borderRadius: '10px', padding: '20px 18px',
              display: 'flex', flexDirection: 'column', gap: '14px',
              textAlign: 'center',
            }}>
              <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '12px', color: C.dim }}>
                رمز التحدي — شاركه مع خصمك
              </div>
              <div style={{
                fontFamily: 'Orbitron, sans-serif', fontSize: '28px',
                color: C.green, letterSpacing: '0.22em',
                textShadow: neon(C.green, 12),
              }}>{duelCode}</div>
              <div style={{ fontSize: '11px', color: C.dim }}>
                رسوم التحدي: <span style={{ color: C.yellow }}>{duelBet.toLocaleString()} د.ع</span>
                {'  '}<span style={{ color: C.dim, fontSize: '9px' }}>تم خصمه من رصيدك</span>
              </div>
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(duelCode).catch(() => {});
                  if (comboTimerRef.current) clearTimeout(comboTimerRef.current);
                  setComboFlash('✅ تم نسخ الرمز!');
                  comboTimerRef.current = setTimeout(() => setComboFlash(null), 1800);
                }}
                style={{
                  padding: '12px', borderRadius: '6px',
                  background: `${C.green}18`, border: `1px solid ${C.green}55`,
                  color: C.green, fontFamily: 'Orbitron, sans-serif',
                  fontSize: '12px', letterSpacing: '0.08em',
                  cursor: 'pointer', textShadow: neon(C.green, 5),
                }}
              >
                📋 انسخ الرمز
              </button>
              <button onClick={() => { activeDuelIdRef.current = duelCode; startGame(); }} style={{
                padding: '14px', borderRadius: '6px',
                background: `linear-gradient(135deg, ${C.yellow}22, ${C.yellow}11)`,
                border: `1.5px solid ${C.yellow}88`,
                color: C.yellow, fontFamily: 'Orbitron, sans-serif',
                fontSize: '13px', letterSpacing: '0.1em',
                cursor: 'pointer', textShadow: neon(C.yellow, 7),
                boxShadow: neon(C.yellow, 5), transition: 'all 0.2s',
              }}>
                ▶ ابدأ وسجّل نتيجتك
              </button>
            </div>
          ) : null}

          <button onClick={() => setPhase('menu')} style={{
            background: 'transparent', border: 'none',
            color: C.dim, fontFamily: 'Orbitron, sans-serif',
            fontSize: '11px', cursor: 'pointer', letterSpacing: '0.08em',
          }}>← رجوع للقائمة</button>
        </div>
      )}

      {/* ── LEADERBOARD ──────────────────────────────────────────────────────── */}
      {phase === 'leaderboard' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{
            padding: '16px 18px 8px',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            flexShrink: 0,
          }}>
            <div style={{
              fontFamily: 'Orbitron, sans-serif', fontSize: '13px',
              color: C.yellow, letterSpacing: '0.1em',
              textShadow: neon(C.yellow, 6),
            }}>🏅 قائمة متصدري المعدل</div>
            <button
              onClick={() => setPhase('menu')}
              style={{
                background: 'transparent', border: 'none',
                color: C.dim, fontSize: '12px', cursor: 'pointer',
                fontFamily: 'Orbitron, sans-serif', letterSpacing: '0.08em',
              }}
            >← العودة</button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '4px 16px 20px' }}>
            {boardLoading ? (
              <div style={{ textAlign: 'center', color: C.dim, padding: '40px', fontSize: '13px' }}>
                ⏳ جاري التحميل...
              </div>
            ) : board.length === 0 ? (
              <div style={{ textAlign: 'center', color: C.dim, padding: '40px', fontSize: '13px' }}>
                لا توجد نتائج بعد — كن أول المتصدرين!
              </div>
            ) : board.map((entry, i) => {
              const isTop3 = entry.rank <= 3;
              const rowColor = entry.rank === 1 ? C.yellow : entry.rank === 2 ? '#C0C0C0' : entry.rank === 3 ? '#CD7F32' : C.dim;
              return (
                <div key={entry.userId} style={{
                  display: 'flex', alignItems: 'center', gap: '14px',
                  padding: '12px 16px',
                  marginBottom: '6px',
                  borderRadius: '8px',
                  background: isTop3 ? `${rowColor}0d` : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${isTop3 ? rowColor + '33' : C.border}`,
                  transition: 'all 0.2s',
                  animation: i < 3 ? `slideIn 0.3s ease ${i * 0.08}s both` : 'none',
                }}>
                  <span style={{ fontSize: isTop3 ? '22px' : '14px', minWidth: '28px', textAlign: 'center' }}>
                    {medal(entry.rank)}
                  </span>
                  <div style={{ flex: 1 }}>
                    <div style={{
                      fontFamily: 'Rajdhani, sans-serif', fontSize: '15px',
                      color: isTop3 ? rowColor : 'rgba(255,255,255,0.85)',
                      fontWeight: isTop3 ? 700 : 500,
                    }}>
                      {entry.userName || 'لاعب'}
                    </div>
                  </div>
                  <div style={{
                    fontFamily: 'Orbitron, sans-serif', fontSize: '15px',
                    color: isTop3 ? rowColor : C.green,
                    textShadow: isTop3 ? neon(rowColor, 5) : 'none',
                    fontWeight: 700,
                  }}>
                    {entry.bestScore} <span style={{ fontSize: '10px', opacity: 0.6 }}>نقطة</span>
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{
            padding: '12px 16px',
            borderTop: `1px solid ${C.border}`,
            display: 'flex', gap: '10px',
            background: C.surface,
            flexShrink: 0,
          }}>
            <button
              onClick={startGame}
              style={{
                flex: 1, padding: '13px', borderRadius: '6px',
                background: `${C.yellow}11`,
                border: `1px solid ${C.yellow}44`,
                color: C.yellow, fontFamily: 'Orbitron, sans-serif',
                fontSize: '12px', letterSpacing: '0.1em', cursor: 'pointer',
                transition: 'all 0.2s',
              }}
            >▶ العب الآن</button>
          </div>
        </div>
      )}

      {/* ── SHOP ─────────────────────────────────────────────────────────────── */}
      {phase === 'shop' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {/* ── Header ── */}
          <div style={{
            padding: '12px 16px 0', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '13px', color: C.purple, letterSpacing: '0.1em', textShadow: neon(C.purple, 6) }}>
              🛍 المتجر
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              {profile && (
                <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '11px', color: C.yellow, background: `${C.yellow}11`, border: `1px solid ${C.yellow}33`, padding: '3px 9px', borderRadius: '20px' }}>
                  💰 {walletBal.toLocaleString()} د.ع
                </div>
              )}
              <button onClick={() => setPhase('menu')} style={{ background: 'transparent', border: 'none', color: C.dim, fontSize: '12px', cursor: 'pointer', fontFamily: 'Orbitron, sans-serif' }}>← رجوع</button>
            </div>
          </div>

          {/* ── Tab bar ── */}
          <div style={{ display: 'flex', gap: '0', padding: '10px 16px 0', flexShrink: 0 }}>
            {(['skins', 'upgrades'] as const).map(tab => {
              const active = shopTab === tab;
              const label  = tab === 'skins' ? '🎭 الملابس' : '⚡ التطويرات';
              return (
                <button key={tab} onClick={() => { setShopTab(tab); setShopMsg(''); }} style={{
                  flex: 1, padding: '9px 0', border: 'none',
                  borderBottom: `2px solid ${active ? C.purple : 'transparent'}`,
                  background: active ? `${C.purple}14` : 'transparent',
                  color: active ? C.purple : C.dim,
                  fontFamily: 'Orbitron, sans-serif', fontSize: '11px',
                  letterSpacing: '0.08em', cursor: 'pointer',
                  transition: 'all 0.2s',
                }}>{label}</button>
              );
            })}
          </div>

          {/* ── Stats bar ── */}
          {profile && (
            <div style={{
              margin: '10px 16px 0', borderRadius: '8px', padding: '10px 14px',
              background: `${C.green}0a`, border: `1px solid ${C.green}22`,
              display: 'flex', gap: '14px', alignItems: 'center', flexShrink: 0,
            }}>
              <div style={{ flex: 1, textAlign: 'center' }}>
                <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '17px', color: C.green, textShadow: neon(C.green, 5) }}>{profile.gamePoints.toLocaleString()}</div>
                <div style={{ fontSize: '9px', color: C.dim, marginTop: '2px' }}>نقاط اللعب</div>
              </div>
              <div style={{ width: '1px', height: '28px', background: C.border }} />
              <div style={{ flex: 1, textAlign: 'center' }}>
                <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '17px', color: C.yellow, textShadow: neon(C.yellow, 5) }}>
                  {walletBal.toLocaleString()}
                </div>
                <div style={{ fontSize: '9px', color: C.dim, marginTop: '2px' }}>رصيد المحفظة</div>
              </div>
              <div style={{ width: '1px', height: '28px', background: C.border }} />
              <button onClick={redeemPoints} disabled={redeeming || profile.gamePoints < 5000} style={{
                flex: 1, padding: '6px 4px', borderRadius: '5px',
                background: profile.gamePoints >= 5000 ? `${C.green}1a` : 'transparent',
                border: `1px solid ${profile.gamePoints >= 5000 ? C.green + '44' : C.border}`,
                color: profile.gamePoints >= 5000 ? C.green : C.dim,
                fontFamily: 'Orbitron, sans-serif', fontSize: '9px', letterSpacing: '0.04em',
                cursor: profile.gamePoints >= 5000 ? 'pointer' : 'not-allowed', opacity: redeeming ? 0.6 : 1,
              }}>{redeeming ? '⏳' : '💱 استبدال'}</button>
            </div>
          )}

          {/* ── Feedback ── */}
          {shopMsg && (
            <div style={{
              margin: '8px 16px 0', padding: '8px 12px', borderRadius: '6px',
              background: shopMsg.startsWith('✓') ? `${C.green}15` : `${C.red}15`,
              border: `1px solid ${shopMsg.startsWith('✓') ? C.green + '44' : C.red + '44'}`,
              color: shopMsg.startsWith('✓') ? C.green : C.red,
              fontFamily: 'Rajdhani, sans-serif', fontSize: '12px', textAlign: 'center',
            }}>{shopMsg}</div>
          )}

          <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px 16px' }}>

            {/* ══════════════════ SKINS TAB ══════════════════ */}
            {shopTab === 'skins' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                {(dynSkins.length > 0 ? dynSkins : SKINS).map(skin => {
                  const owned  = profile?.unlockedSkins?.includes(skin.id) ?? false;
                  const active = profile?.activeSkin === skin.id;
                  const canBuy = walletBal >= skin.price;
                  const buying = shopBuying === skin.id;
                  return (
                    <div key={skin.id} style={{
                      borderRadius: '10px', overflow: 'hidden',
                      background: active ? `${skin.color}15` : owned ? `${skin.color}08` : 'rgba(255,255,255,0.02)',
                      border: `1.5px solid ${active ? skin.color + '77' : owned ? skin.color + '33' : C.border}`,
                      transition: 'all 0.25s', boxShadow: active ? neon(skin.color, 8) : 'none',
                    }}>
                      <div style={{ height: '86px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: `${skin.color}${active ? '22' : '08'}`, position: 'relative' }}>
                        <img src={skin.imageUrl} alt={skin.name}
                          style={{ width: '60px', height: '60px', objectFit: 'contain', filter: active ? `drop-shadow(0 0 8px ${skin.color})` : 'none' }}
                          onError={e => { (e.currentTarget as HTMLImageElement).style.display='none'; (e.currentTarget.nextElementSibling as HTMLElement).style.display='flex'; }}
                        />
                        <div style={{ display: 'none', fontSize: '38px', alignItems: 'center', justifyContent: 'center' }}>{skin.emoji}</div>
                        {active && <div style={{ position: 'absolute', top: '5px', right: '5px', background: skin.color, color: '#000', fontSize: '8px', fontFamily: 'Orbitron, sans-serif', padding: '2px 4px', borderRadius: '3px', fontWeight: 700 }}>نشط</div>}
                      </div>
                      <div style={{ padding: '8px 10px 10px' }}>
                        <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '13px', fontWeight: 600, color: active ? skin.color : 'rgba(255,255,255,0.85)', marginBottom: '3px' }}>{skin.emoji} {skin.name}</div>
                        <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '10px', color: C.yellow, marginBottom: '7px' }}>{skin.price.toLocaleString()} د.ع</div>
                        {owned ? (
                          <button onClick={() => equipSkin(skin)} disabled={active} style={{ width: '100%', padding: '6px', borderRadius: '5px', background: active ? `${skin.color}30` : `${skin.color}18`, border: `1px solid ${skin.color}${active ? '77' : '44'}`, color: skin.color, fontFamily: 'Orbitron, sans-serif', fontSize: '9px', letterSpacing: '0.08em', cursor: active ? 'default' : 'pointer' }}>
                            {active ? '✓ مفعّل' : '▶ تفعيل'}
                          </button>
                        ) : (
                          <button onClick={() => buySkin(skin)} disabled={buying || !canBuy || !profile} style={{ width: '100%', padding: '6px', borderRadius: '5px', background: canBuy ? `${C.yellow}18` : 'rgba(255,255,255,0.03)', border: `1px solid ${canBuy ? C.yellow+'55' : C.border}`, color: canBuy ? C.yellow : C.dim, fontFamily: 'Orbitron, sans-serif', fontSize: '9px', letterSpacing: '0.08em', cursor: canBuy && !buying ? 'pointer' : 'not-allowed', opacity: buying ? 0.6 : 1 }}>
                            {buying ? '⏳...' : canBuy ? '🛒 شراء' : '🔒 رصيد غير كافٍ'}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* ══════════════════ UPGRADES TAB ══════════════════ */}
            {shopTab === 'upgrades' && (() => {
              const upgrades = [
                {
                  key:      'magnet' as const,
                  icon:     '🧲',
                  title:    'مستوى المغناطيس',
                  color:    C.yellow,
                  level:    profile?.magnetLevel ?? 1,
                  effects:  MAGNET_DUR_LVL.map(ms => `${(ms/1000).toFixed(1)}ث`),
                  effectLabel: 'مدة الجذب',
                },
                {
                  key:      'combo' as const,
                  icon:     '⚡',
                  title:    'مضاعف الكومبو',
                  color:    C.blue,
                  level:    profile?.comboLevel ?? 1,
                  effects:  COMBO_WIN_LVL.map(ms => `${(ms/1000).toFixed(1)}ث`),
                  effectLabel: 'نافذة الكومبو',
                },
              ];
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  {upgrades.map(upg => {
                    const lvl      = upg.level;
                    const maxed    = lvl >= MAX_UPG_LEVEL;
                    const cost     = maxed ? 0 : UPGRADE_COSTS[upg.key][lvl - 1];
                    const balance  = walletBal;
                    const canAfford = !maxed && balance >= cost;
                    const isUpgrading = upgrading === upg.key;

                    return (
                      <div key={upg.key} style={{
                        borderRadius: '12px', padding: '16px',
                        background: `${upg.color}0a`,
                        border: `1.5px solid ${upg.color}${maxed ? '66' : '33'}`,
                        boxShadow: maxed ? neon(upg.color, 6) : 'none',
                        transition: 'all 0.3s',
                      }}>
                        {/* Card header */}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ fontSize: '22px' }}>{upg.icon}</span>
                            <div>
                              <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '12px', color: upg.color, letterSpacing: '0.08em', textShadow: neon(upg.color, 5) }}>{upg.title}</div>
                              <div style={{ fontSize: '10px', color: C.dim, marginTop: '2px' }}>{upg.effectLabel}: <span style={{ color: 'rgba(255,255,255,0.8)' }}>{upg.effects[lvl - 1]}</span></div>
                            </div>
                          </div>
                          {/* Level badge */}
                          <div style={{
                            fontFamily: 'Orbitron, sans-serif', fontSize: '14px', fontWeight: 700,
                            color: upg.color, textShadow: neon(upg.color, 8),
                            background: `${upg.color}18`, border: `1px solid ${upg.color}44`,
                            padding: '4px 10px', borderRadius: '20px', letterSpacing: '0.08em',
                          }}>
                            {maxed ? 'MAX ✓' : `Lv.${lvl}`}
                          </div>
                        </div>

                        {/* Level progress bar */}
                        <div style={{ marginBottom: '12px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '5px' }}>
                            {Array.from({ length: MAX_UPG_LEVEL }, (_, i) => (
                              <div key={i} style={{
                                flex: 1, height: '6px', borderRadius: '3px',
                                background: i < lvl ? upg.color : `${upg.color}22`,
                                margin: '0 2px',
                                boxShadow: i < lvl ? neon(upg.color, 4) : 'none',
                                transition: 'all 0.4s',
                              }} />
                            ))}
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', paddingLeft: '2px', paddingRight: '2px' }}>
                            {Array.from({ length: MAX_UPG_LEVEL }, (_, i) => (
                              <div key={i} style={{ flex: 1, textAlign: 'center', fontSize: '8px', color: i < lvl ? upg.color : C.dim, fontFamily: 'Orbitron, sans-serif' }}>
                                {i + 1}
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* Next level preview */}
                        {!maxed && (
                          <div style={{ fontSize: '11px', color: C.dim, marginBottom: '10px' }}>
                            المستوى التالي: <span style={{ color: upg.color }}>{upg.effects[lvl]}</span>
                            <span style={{ marginRight: '8px', color: 'rgba(255,255,255,0.4)' }}>•</span>
                            التكلفة: <span style={{ color: C.yellow }}>{cost.toLocaleString()} د.ع</span>
                          </div>
                        )}

                        {/* Upgrade button */}
                        <button
                          disabled={maxed || isUpgrading || !canAfford || !profile}
                          onClick={() => upgradeAbility(upg.key)}
                          style={{
                            width: '100%', padding: '10px', borderRadius: '7px',
                            background: maxed
                              ? `${upg.color}22`
                              : canAfford ? `${upg.color}22` : 'rgba(255,255,255,0.04)',
                            border: `1.5px solid ${maxed ? upg.color+'66' : canAfford ? upg.color+'55' : C.border}`,
                            color: maxed ? upg.color : canAfford ? upg.color : C.dim,
                            fontFamily: 'Orbitron, sans-serif', fontSize: '11px', letterSpacing: '0.08em',
                            cursor: (!maxed && canAfford && !isUpgrading) ? 'pointer' : 'not-allowed',
                            textShadow: canAfford || maxed ? neon(upg.color, 5) : 'none',
                            transition: 'all 0.2s', opacity: isUpgrading ? 0.6 : 1,
                          }}
                        >
                          {maxed
                            ? '🏆 وصلت للحد الأقصى!'
                            : isUpgrading
                              ? '⏳ جاري الترقية...'
                              : canAfford
                                ? `⬆ ترقية إلى Lv.${lvl + 1} — ${cost.toLocaleString()} د.ع`
                                : `🔒 رصيد غير كافٍ (${cost.toLocaleString()} د.ع)`
                          }
                        </button>
                      </div>
                    );
                  })}

                  {/* Info box */}
                  <div style={{ borderRadius: '8px', padding: '12px 14px', background: 'rgba(255,255,255,0.02)', border: `1px solid ${C.border}` }}>
                    <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '10px', color: C.dim, letterSpacing: '0.06em', marginBottom: '6px' }}>💡 كيف تعمل التطويرات؟</div>
                    <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.45)', lineHeight: 1.7 }}>
                      • <strong style={{ color: C.yellow }}>المغناطيس</strong>: كل مستوى يمدد وقت الجذب التلقائي للأكل<br/>
                      • <strong style={{ color: C.blue }}>الكومبو</strong>: يوسّع النافذة الزمنية لتراكم مضاعفات الكومبو<br/>
                      • يُخصم السعر من محفظة الرحلات أو رصيد اللعبة تلقائياً
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&family=Rajdhani:wght@400;500;600;700&display=swap');
        @keyframes pulse  { from { opacity:1 } to { opacity:0.4 } }
        @keyframes slideIn{ from { transform:translateX(20px); opacity:0 } to { transform:translateX(0); opacity:1 } }
      `}</style>
    </div>
  );
}
