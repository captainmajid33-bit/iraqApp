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
import { auth } from '@/lib/firebase';

// ── Types ───────────────────────────────────────────────────────────────────
interface Props {
  onClose: () => void;
}

type Phase = 'menu' | 'loading' | 'playing' | 'gameover' | 'leaderboard';

interface GameConfig {
  characterUrl: string;
  targetUrl:    string;
  duration:     number;
}

interface FallingItem {
  id:        number;
  x:         number;
  y:         number;
  speed:     number;
  collected: boolean;
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

// ── Game constants ────────────────────────────────────────────────────────────
const CHAR_W     = 60;
const CHAR_H     = 60;
const ITEM_W     = 44;
const ITEM_H     = 44;
const CHAR_SPEED = 6;

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

  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const rafRef     = useRef<number>(0);
  const timerRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const charImgRef = useRef<HTMLImageElement | null>(null);
  const itemImgRef = useRef<HTMLImageElement | null>(null);

  // All mutable game state in a single ref (no re-render per frame)
  const gs = useRef({
    charX:     0,
    charY:     0,
    items:     [] as FallingItem[],
    score:     0,
    timeLeft:  60,
    pressing:  null as 'left' | 'right' | null,
    nextId:    0,
    lastSpawn: 0,
    running:   false,
    W:         380,
    H:         520,
  });

  // ── Fetch game config ──────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/game/config')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((d: GameConfig) => setConfig({
        characterUrl: d.characterUrl ?? '',
        targetUrl:    d.targetUrl    ?? '',
        duration:     d.duration     ?? 60,
      }))
      .catch(() => setConfig({ characterUrl: '', targetUrl: '', duration: 60 }));
  }, []);

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
    setScore(gs.current.score);
    setPhase('gameover');
  }, []);

  // ── Draw one frame ─────────────────────────────────────────────────────────
  const drawFrame = useCallback((ts: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const g = gs.current;
    const { W, H } = g;

    // Move character
    if (g.pressing === 'right') g.charX = Math.min(W - CHAR_W / 2, g.charX + CHAR_SPEED);
    if (g.pressing === 'left')  g.charX = Math.max(CHAR_W / 2,     g.charX - CHAR_SPEED);

    // Spawn new item
    if (ts - g.lastSpawn > 1100) {
      g.items.push({
        id:        g.nextId++,
        x:         ITEM_W / 2 + Math.random() * (W - ITEM_W),
        y:         -ITEM_H,
        speed:     2.2 + Math.random() * 2.2,
        collected: false,
      });
      g.lastSpawn = ts;
    }

    // Update items + collision
    for (const item of g.items) {
      if (item.collected) continue;
      item.y += item.speed;
      const dx = Math.abs(item.x - g.charX);
      const dy = Math.abs(item.y - g.charY);
      if (dx < (CHAR_W / 2 + ITEM_W / 2) * 0.72 && dy < (CHAR_H / 2 + ITEM_H / 2) * 0.72) {
        item.collected = true;
        g.score++;
        setScore(g.score);
      }
    }
    g.items = g.items.filter(it => !it.collected && it.y < H + ITEM_H);

    // ── Draw ──────────────────────────────────────────────────────────────────
    // Background
    ctx.fillStyle = '#05080f';
    ctx.fillRect(0, 0, W, H);

    // Grid
    ctx.strokeStyle = 'rgba(0,212,255,0.055)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= W; x += 38) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
    for (let y = 0; y <= H; y += 38) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }

    // Scanline effect (subtle)
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 2);

    // Ground glow
    const groundY = g.charY + CHAR_H / 2 + 8;
    const grad = ctx.createLinearGradient(0, groundY - 4, 0, groundY + 12);
    grad.addColorStop(0, '#00f5d466');
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.fillRect(0, groundY - 4, W, 16);
    ctx.strokeStyle = '#00f5d455';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, groundY); ctx.lineTo(W, groundY); ctx.stroke();

    // Draw items
    for (const item of g.items) {
      if (item.collected) continue;
      if (itemImgRef.current) {
        ctx.save();
        ctx.shadowColor = '#f5c51888';
        ctx.shadowBlur = 10;
        ctx.drawImage(itemImgRef.current, item.x - ITEM_W / 2, item.y - ITEM_H / 2, ITEM_W, ITEM_H);
        ctx.restore();
      } else {
        ctx.save();
        ctx.font = '32px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = C.yellow;
        ctx.shadowBlur = 12;
        ctx.fillText('🍔', item.x, item.y);
        ctx.restore();
      }
    }

    // Draw character
    if (charImgRef.current) {
      ctx.save();
      ctx.shadowColor = '#00f5d466';
      ctx.shadowBlur = 14;
      ctx.drawImage(charImgRef.current, g.charX - CHAR_W / 2, g.charY - CHAR_H / 2, CHAR_W, CHAR_H);
      ctx.restore();
    } else {
      ctx.save();
      ctx.font = '40px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = C.green;
      ctx.shadowBlur = 16;
      ctx.fillText('🏃', g.charX, g.charY);
      ctx.restore();
    }
  }, []);

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

    const [ci, ii] = await Promise.all([
      loadImg(config.characterUrl),
      loadImg(config.targetUrl),
    ]);
    charImgRef.current = ci;
    itemImgRef.current = ii;

    // Wait for React to flush the DOM (canvas is now rendered during 'loading' phase)
    await new Promise(r => setTimeout(r, 120));

    const canvas = canvasRef.current;
    if (!canvas) { setPhase('menu'); return; }
    const W = canvas.offsetWidth  || 380;
    const H = canvas.offsetHeight || 520;
    canvas.width  = W;
    canvas.height = H;

    const g = gs.current;
    g.charX    = W / 2;
    g.charY    = H - CHAR_H - 24;
    g.items    = [];
    g.score    = 0;
    g.timeLeft = config.duration;
    g.pressing = null;
    g.nextId   = 0;
    g.lastSpawn = 0;
    g.running  = true;
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
      if (!gs.current.running) return;
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
          <span style={{ fontSize: '20px' }}>🏆</span>
          <span style={{
            fontFamily: 'Orbitron, sans-serif', fontSize: '14px',
            color: C.yellow, letterSpacing: '0.12em',
            textShadow: neon(C.yellow, 7),
          }}>التحدي</span>
        </div>

        {phase === 'playing' && (
          <div style={{ display: 'flex', gap: '20px', alignItems: 'center' }}>
            <div style={{
              fontFamily: 'Orbitron, sans-serif', fontSize: '13px',
              color: C.green, letterSpacing: '0.08em',
              textShadow: neon(C.green, 6),
            }}>
              النقاط: <strong>{score}</strong>
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
              fontFamily: 'Orbitron, sans-serif', fontSize: '22px',
              color: C.yellow, letterSpacing: '0.12em',
              textShadow: neon(C.yellow, 10),
              marginBottom: '10px',
            }}>التحدي</div>
            <div style={{ color: C.dim, fontSize: '13px', lineHeight: 1.7, maxWidth: '280px', margin: '0 auto' }}>
              اصطد أكبر عدد من العناصر خلال {config?.duration ?? 60} ثانية!<br/>
              استخدم زري ← و → للتحرك
            </div>
          </div>

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
              🏅 قائمة المتصدرين
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
          {/* Canvas */}
          <canvas
            ref={canvasRef}
            style={{
              flex: 1, width: '100%', display: 'block',
              touchAction: 'none',
              visibility: phase === 'loading' ? 'hidden' : 'visible',
            }}
          />

          {/* Controls */}
          <div style={{
            display: 'flex', gap: '12px',
            padding: '12px 24px',
            background: C.surface,
            borderTop: `1px solid ${C.border}`,
            flexShrink: 0,
          }}>
            <button
              onMouseDown={pressLeft}  onMouseUp={pressStop} onMouseLeave={pressStop}
              onTouchStart={e => { e.preventDefault(); pressLeft(); }}
              onTouchEnd={e => { e.preventDefault(); pressStop(); }}
              style={{
                flex: 1, height: '64px', borderRadius: '8px',
                background: `${C.blue}18`,
                border: `2px solid ${C.blue}55`,
                color: C.blue, fontSize: '26px', cursor: 'pointer',
                touchAction: 'none', userSelect: 'none',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all 0.1s',
              }}
            >◀</button>

            <button
              onMouseDown={pressRight} onMouseUp={pressStop} onMouseLeave={pressStop}
              onTouchStart={e => { e.preventDefault(); pressRight(); }}
              onTouchEnd={e => { e.preventDefault(); pressStop(); }}
              style={{
                flex: 1, height: '64px', borderRadius: '8px',
                background: `${C.green}18`,
                border: `2px solid ${C.green}55`,
                color: C.green, fontSize: '26px', cursor: 'pointer',
                touchAction: 'none', userSelect: 'none',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'all 0.1s',
              }}
            >▶</button>
          </div>
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
              🏅 قائمة المتصدرين
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
            }}>🏅 قائمة المتصدرين</div>
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

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&family=Rajdhani:wght@400;500;600;700&display=swap');
        @keyframes pulse  { from { opacity:1 } to { opacity:0.4 } }
        @keyframes slideIn{ from { transform:translateX(20px); opacity:0 } to { transform:translateX(0); opacity:1 } }
      `}</style>
    </div>
  );
}
