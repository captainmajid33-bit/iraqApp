import { useEffect, useState, useRef, useCallback } from "react";

const API      = "/api";
const CLOCK_W  = 154;
const INTERVAL = 5000;

type MediaItem = {
  type:          "image" | "video" | "youtube";
  url:           string;
  customHeight?: number;
  objectFit?:    "cover" | "contain" | "fill";
};

// Convert any YouTube URL variant to a safe https embed URL
function toYouTubeEmbed(url: string): string | null {
  try {
    // Already an embed URL
    const embedMatch = url.match(/youtube\.com\/embed\/([A-Za-z0-9_-]{11})/);
    if (embedMatch) return `https://www.youtube.com/embed/${embedMatch[1]}`;
    // Standard watch URL: youtube.com/watch?v=ID
    const watchMatch = url.match(/(?:youtube\.com\/watch\?.*v=)([A-Za-z0-9_-]{11})/);
    if (watchMatch) return `https://www.youtube.com/embed/${watchMatch[1]}`;
    // Short URL: youtu.be/ID
    const shortMatch = url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
    if (shortMatch) return `https://www.youtube.com/embed/${shortMatch[1]}`;
  } catch { /* */ }
  return null;
}

function parseMediaItems(raw: string): MediaItem[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return (parsed as MediaItem[]).map(item => {
          if (item.type === "youtube") {
            const embed = toYouTubeEmbed(item.url);
            return embed ? { ...item, url: embed } : item;
          }
          return item;
        });
      }
    } catch { /* */ }
  }
  // Auto-detect YouTube URL passed as plain string
  const embed = toYouTubeEmbed(trimmed);
  if (embed) return [{ type: "youtube", url: embed }];
  if (trimmed) return [{ type: "image", url: trimmed }];
  return [];
}

// ── SVG icons ────────────────────────────────────────────────────────────────
function IconExpand() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 3 21 3 21 9"/>
      <polyline points="9 21 3 21 3 15"/>
      <line x1="21" y1="3" x2="14" y2="10"/>
      <line x1="3" y1="21" x2="10" y2="14"/>
    </svg>
  );
}
function IconClose() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/>
      <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  );
}
function IconPlay() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5 3 19 12 5 21 5 3"/>
    </svg>
  );
}
function IconPause() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16"/>
      <rect x="14" y="4" width="4" height="16"/>
    </svg>
  );
}
function IconMuted() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
      <line x1="23" y1="9" x2="17" y2="15"/>
      <line x1="17" y1="9" x2="23" y2="15"/>
    </svg>
  );
}
function IconUnmuted() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
    </svg>
  );
}

// ── Fullscreen Modal ──────────────────────────────────────────────────────────
function FullscreenModal({
  item,
  onClose,
}: {
  item: MediaItem;
  onClose: () => void;
}) {
  const [fsMuted,   setFsMuted]   = useState(true);
  const [fsPaused,  setFsPaused]  = useState(false);
  const [fsVisible, setFsVisible] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Fade-in on mount
  useEffect(() => {
    const t = setTimeout(() => setFsVisible(true), 20);
    return () => clearTimeout(t);
  }, []);

  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") handleClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleClose = useCallback(() => {
    setFsVisible(false);
    setTimeout(onClose, 280);
  }, [onClose]);

  const togglePause = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play(); setFsPaused(false); }
    else          { v.pause(); setFsPaused(true); }
  };

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) handleClose(); }}
      style={{
        position:   "fixed",
        inset:      0,
        zIndex:     99999,
        display:    "flex",
        alignItems: "center",
        justifyContent: "center",
        background: `rgba(0,0,0,${fsVisible ? 0.92 : 0})`,
        backdropFilter: `blur(${fsVisible ? 8 : 0}px)`,
        transition: "background 0.28s ease, backdrop-filter 0.28s ease",
      }}
    >
      {/* ── Media container ── */}
      <div style={{
        position:  "relative",
        maxWidth:  "95vw",
        maxHeight: "92vh",
        display:   "flex",
        alignItems: "center",
        justifyContent: "center",
        transform:  fsVisible ? "scale(1)"    : "scale(0.94)",
        opacity:    fsVisible ? 1             : 0,
        transition: "transform 0.28s cubic-bezier(0.16,1,0.3,1), opacity 0.28s ease",
      }}>

        {/* Neon border frame */}
        <div style={{
          position:     "absolute",
          inset:        "-2px",
          borderRadius: "6px",
          border:       "1px solid rgba(123,47,247,0.55)",
          boxShadow:    "0 0 40px rgba(123,47,247,0.22), 0 0 80px rgba(0,212,255,0.08), inset 0 0 40px rgba(0,0,0,0.4)",
          pointerEvents: "none",
          zIndex:       2,
        }} />

        {/* ── Media ── */}
        {item.type === "youtube" ? (
          <iframe
            key={item.url}
            src={item.url}
            title="YouTube Video Player"
            frameBorder="0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            style={{
              width:        "min(90vw, 960px)",
              height:       "min(80vh, 540px)",
              borderRadius: "4px",
              display:      "block",
              border:       "none",
              background:   "#000",
            }}
          />
        ) : item.type === "video" ? (
          <video
            ref={videoRef}
            key={item.url}
            src={item.url}
            autoPlay
            muted={fsMuted}
            loop
            playsInline
            style={{
              maxWidth:    "95vw",
              maxHeight:   "80vh",
              borderRadius: "4px",
              display:     "block",
              objectFit:   "contain",
              background:  "#000",
            }}
          />
        ) : (
          <img
            key={item.url}
            src={item.url}
            alt="fullscreen"
            style={{
              maxWidth:    "95vw",
              maxHeight:   "85vh",
              borderRadius: "4px",
              display:     "block",
              objectFit:   "contain",
            }}
          />
        )}

        {/* ── Close button — top right ── */}
        <button
          onClick={handleClose}
          title="إغلاق (Escape)"
          style={{
            position:   "absolute",
            top:        "-14px",
            right:      "-14px",
            zIndex:     10,
            width:      "36px",
            height:     "36px",
            borderRadius: "50%",
            display:    "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(5,8,15,0.9)",
            border:     "1px solid rgba(255,80,80,0.6)",
            color:      "rgba(255,100,100,0.9)",
            cursor:     "pointer",
            backdropFilter: "blur(6px)",
            boxShadow:  "0 0 14px rgba(255,60,60,0.35)",
            transition: "all 0.18s ease",
            padding:    0,
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLButtonElement).style.background = "rgba(200,30,30,0.35)";
            (e.currentTarget as HTMLButtonElement).style.boxShadow  = "0 0 20px rgba(255,60,60,0.6)";
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLButtonElement).style.background = "rgba(5,8,15,0.9)";
            (e.currentTarget as HTMLButtonElement).style.boxShadow  = "0 0 14px rgba(255,60,60,0.35)";
          }}
        >
          <IconClose />
        </button>

        {/* ── Video controls bar (video only, not YouTube) ── */}
        {item.type === "video" && (
          <div style={{
            position:   "absolute",
            bottom:     "-48px",
            left:       "50%",
            transform:  "translateX(-50%)",
            zIndex:     10,
            display:    "flex",
            gap:        "10px",
            alignItems: "center",
            background: "rgba(5,8,15,0.85)",
            border:     "1px solid rgba(123,47,247,0.35)",
            borderRadius: "24px",
            padding:    "7px 18px",
            backdropFilter: "blur(8px)",
            boxShadow:  "0 0 20px rgba(123,47,247,0.18)",
          }}>

            {/* Play / Pause */}
            <button
              onClick={togglePause}
              title={fsPaused ? "تشغيل" : "إيقاف مؤقت"}
              style={{
                width: "34px", height: "34px",
                borderRadius: "50%",
                display: "flex", alignItems: "center", justifyContent: "center",
                background: fsPaused ? "rgba(123,47,247,0.25)" : "rgba(0,212,255,0.15)",
                border: `1px solid ${fsPaused ? "rgba(123,47,247,0.7)" : "rgba(0,212,255,0.6)"}`,
                color:  fsPaused ? "#7b2ff7" : "#00d4ff",
                cursor: "pointer",
                boxShadow: fsPaused ? "0 0 10px rgba(123,47,247,0.4)" : "0 0 10px rgba(0,212,255,0.35)",
                transition: "all 0.18s ease",
                padding: 0,
              }}
            >
              {fsPaused ? <IconPlay /> : <IconPause />}
            </button>

            {/* Separator */}
            <div style={{ width: "1px", height: "20px", background: "rgba(123,47,247,0.25)" }} />

            {/* Mute / Unmute */}
            <button
              onClick={() => setFsMuted(m => !m)}
              title={fsMuted ? "تشغيل الصوت" : "كتم الصوت"}
              style={{
                width: "34px", height: "34px",
                borderRadius: "50%",
                display: "flex", alignItems: "center", justifyContent: "center",
                background: fsMuted ? "rgba(123,47,247,0.15)" : "rgba(0,212,255,0.15)",
                border: `1px solid ${fsMuted ? "rgba(123,47,247,0.5)" : "rgba(0,212,255,0.6)"}`,
                color:  fsMuted ? "rgba(123,47,247,0.8)" : "#00d4ff",
                cursor: "pointer",
                boxShadow: fsMuted ? "0 0 8px rgba(123,47,247,0.3)" : "0 0 10px rgba(0,212,255,0.35)",
                transition: "all 0.18s ease",
                padding: 0,
              }}
            >
              {fsMuted ? <IconMuted /> : <IconUnmuted />}
            </button>

            {/* Label */}
            <span style={{
              fontFamily: "Orbitron, sans-serif", fontSize: "8px",
              color: "rgba(0,212,255,0.5)", letterSpacing: "0.12em",
              userSelect: "none",
            }}>
              {fsPaused ? "PAUSED" : "PLAYING"}
            </span>
          </div>
        )}
      </div>

      {/* ── ESC hint ── */}
      <div style={{
        position:   "absolute",
        bottom:     "20px",
        left:       "50%",
        transform:  "translateX(-50%)",
        fontFamily: "Orbitron, sans-serif",
        fontSize:   "8px",
        color:      "rgba(123,47,247,0.35)",
        letterSpacing: "0.18em",
        pointerEvents: "none",
        opacity:    fsVisible ? 1 : 0,
        transition: "opacity 0.4s ease 0.3s",
      }}>
        ESC / اضغط خارج الصورة للإغلاق
      </div>
    </div>
  );
}

// ── Main Header ───────────────────────────────────────────────────────────────
export function Header() {
  const [time,        setTime]        = useState(() => _fmt(new Date()));
  const [items,       setItems]       = useState<MediaItem[]>([]);
  const [idx,         setIdx]         = useState(0);
  const [visible,     setVisible]     = useState(true);
  const [isMuted,     setIsMuted]     = useState(true);
  const [fullscreen,  setFullscreen]  = useState(false);
  const [expandHover, setExpandHover] = useState(false);
  const esRef    = useRef<EventSource | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Live clock ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const iv = setInterval(() => setTime(_fmt(new Date())), 1000);
    return () => clearInterval(iv);
  }, []);

  // ── Fetch on mount ───────────────────────────────────────────────────────────
  useEffect(() => {
    fetch(`${API}/settings/top_banner`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.value) setItems(parseMediaItems(d.value)); })
      .catch(() => {});
  }, []);

  // ── SSE — real-time updates ──────────────────────────────────────────────────
  useEffect(() => {
    function connect() {
      const es = new EventSource(`${API}/events`);
      esRef.current = es;
      es.addEventListener("setting_update", (ev: MessageEvent) => {
        try {
          const { key, value } = JSON.parse(ev.data) as { key: string; value: string };
          if (key === "top_banner") {
            setItems(parseMediaItems(value ?? ""));
            setIdx(0);
          }
        } catch { /* */ }
      });
      es.onerror = () => { es.close(); setTimeout(connect, 5_000); };
    }
    connect();
    return () => { esRef.current?.close(); };
  }, []);

  // ── Autoplay — advance every INTERVAL ms with crossfade ─────────────────────
  useEffect(() => {
    if (items.length <= 1) { timerRef.current && clearInterval(timerRef.current); return; }
    timerRef.current = setInterval(() => {
      setVisible(false);
      setTimeout(() => {
        setIdx(prev => (prev + 1) % items.length);
        setVisible(true);
      }, 350);
    }, INTERVAL);
    return () => { timerRef.current && clearInterval(timerRef.current); };
  }, [items.length]);

  const current    = items[idx] ?? null;
  const showMedia  = Boolean(current);
  const headerH    = current?.customHeight ?? 190;
  const mediaFit   = current?.objectFit   ?? "cover";
  const hh         = time.slice(0, 5);
  const ss         = time.slice(5);

  return (
    <>
      <header
        style={{
          height:        `${headerH}px`,
          transition:    "height 0.4s ease",
          display:       "flex",
          flexDirection: "row",
          flexShrink:    0,
          direction:     "ltr",
          overflow:      "hidden",
          position:      "relative",
          background:    "#05080f",
          borderBottom:  "1px solid rgba(123,47,247,0.5)",
          boxShadow:     "0 0 32px rgba(123,47,247,0.14)",
          zIndex:        10,
        }}
      >
        {/* ── Top neon edge ── */}
        <div style={{
          position: "absolute", top: 0, left: 0, right: 0, height: "2px", zIndex: 3,
          background: "linear-gradient(90deg,transparent 0%,#7b2ff7 30%,#00d4ff 70%,transparent 100%)",
        }} />

        {/* ═══════════════════════════════════════════════════════════════
            LEFT PANEL — Media Carousel
        ═══════════════════════════════════════════════════════════════ */}
        <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>

          {showMedia ? (
            <>
              {/* ── Media layer ── */}
              <div
                style={{
                  position: "absolute", inset: 0,
                  opacity:    visible ? 1 : 0,
                  transition: "opacity 0.35s ease",
                }}
              >
                {current!.type === "youtube" ? (
                  <iframe
                    key={current!.url}
                    src={current!.url}
                    title="YouTube Video Player"
                    frameBorder="0"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    allowFullScreen
                    style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
                  />
                ) : current!.type === "video" ? (
                  <video
                    key={current!.url}
                    src={current!.url}
                    autoPlay
                    muted={isMuted}
                    loop
                    playsInline
                    style={{
                      position: "absolute", inset: 0,
                      width: "100%", height: "100%",
                      objectFit: mediaFit, objectPosition: "center",
                      display: "block",
                    }}
                  />
                ) : (
                  <img
                    key={current!.url}
                    src={current!.url}
                    alt="banner"
                    style={{
                      position: "absolute", inset: 0,
                      width: "100%", height: "100%",
                      objectFit: mediaFit, objectPosition: "center",
                      display: "block",
                    }}
                  />
                )}
              </div>

              {/* Right-edge fade */}
              <div style={{
                position: "absolute", inset: 0, zIndex: 1,
                background: "linear-gradient(to right, rgba(5,8,15,0.05) 60%, rgba(5,8,15,0.75) 100%)",
                pointerEvents: "none",
              }} />

              {/* ── Mute / Unmute button (video only, not YouTube) ── */}
              {current!.type === "video" && (
                <button
                  onClick={() => setIsMuted(m => !m)}
                  title={isMuted ? "تشغيل الصوت" : "كتم الصوت"}
                  style={{
                    position:   "absolute",
                    top:        "10px",
                    left:       "10px",
                    zIndex:     4,
                    width:      "32px",
                    height:     "32px",
                    display:    "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "rgba(5,8,15,0.65)",
                    border:     `1px solid ${isMuted ? "rgba(123,47,247,0.5)" : "rgba(0,212,255,0.6)"}`,
                    borderRadius: "50%",
                    cursor:     "pointer",
                    backdropFilter: "blur(4px)",
                    boxShadow:  isMuted
                      ? "0 0 8px rgba(123,47,247,0.4)"
                      : "0 0 8px rgba(0,212,255,0.5)",
                    transition: "all 0.2s ease",
                    padding:    0,
                    color:      isMuted ? "rgba(123,47,247,0.9)" : "rgba(0,212,255,0.9)",
                  }}
                >
                  {isMuted ? <IconMuted /> : <IconUnmuted />}
                </button>
              )}

              {/* ── Fullscreen / Expand button ── */}
              <button
                onClick={() => setFullscreen(true)}
                onMouseEnter={() => setExpandHover(true)}
                onMouseLeave={() => setExpandHover(false)}
                title="عرض بملء الشاشة"
                style={{
                  position:   "absolute",
                  bottom:     current!.type === "video" ? "10px" : "10px",
                  right:      "10px",
                  zIndex:     4,
                  width:      "30px",
                  height:     "30px",
                  display:    "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: expandHover
                    ? "rgba(123,47,247,0.35)"
                    : "rgba(5,8,15,0.6)",
                  border:     `1px solid ${expandHover
                    ? "rgba(123,47,247,0.9)"
                    : "rgba(123,47,247,0.4)"}`,
                  borderRadius: "4px",
                  cursor:     "pointer",
                  backdropFilter: "blur(4px)",
                  boxShadow:  expandHover
                    ? "0 0 14px rgba(123,47,247,0.6)"
                    : "0 0 6px rgba(123,47,247,0.2)",
                  transition: "all 0.18s ease",
                  padding:    0,
                  color:      expandHover
                    ? "#a56bff"
                    : "rgba(123,47,247,0.75)",
                }}
              >
                <IconExpand />
              </button>

              {/* ── Dot indicators (only when >1 item) ── */}
              {items.length > 1 && (
                <div style={{
                  position: "absolute", bottom: "8px", left: 0, right: "48px",
                  display: "flex", justifyContent: "center", gap: "5px",
                  zIndex: 2, pointerEvents: "none",
                }}>
                  {items.map((_, i) => (
                    <div key={i} style={{
                      width:        i === idx ? "14px" : "5px",
                      height:       "5px",
                      borderRadius: "3px",
                      background:   i === idx ? "#7b2ff7" : "rgba(123,47,247,0.35)",
                      boxShadow:    i === idx ? "0 0 6px rgba(123,47,247,0.8)" : "none",
                      transition:   "all 0.35s ease",
                    }} />
                  ))}
                </div>
              )}
            </>
          ) : (
            /* ── Empty state ── */
            <div style={{
              position: "absolute", inset: 0,
              background: "radial-gradient(ellipse at 40% 50%, rgba(123,47,247,0.07) 0%, rgba(5,8,15,0) 68%)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <div style={{
                border:      "1px dashed rgba(123,47,247,0.18)",
                padding:     "8px 24px",
                fontFamily:  "Orbitron, sans-serif",
                fontSize:    "9px",
                color:       "rgba(123,47,247,0.28)",
                letterSpacing: "0.16em",
              }}>
                BANNER SLOT · أضف صورة أو فيديو من لوحة الأدمن
              </div>
            </div>
          )}
        </div>

        {/* ═══════════════════════════════════════════════════════════════
            RIGHT PANEL — Clock
        ═══════════════════════════════════════════════════════════════ */}
        <div style={{
          width:          `${CLOCK_W}px`,
          flexShrink:     0,
          position:       "relative",
          display:        "flex",
          flexDirection:  "column",
          alignItems:     "center",
          justifyContent: "center",
          gap:            "2px",
          background:     "rgba(5,8,15,0.92)",
          zIndex:         1,
        }}>
          <div style={{
            position: "absolute", top: 0, bottom: 0, left: 0, width: "1px",
            background: "linear-gradient(180deg,transparent 0%,#7b2ff788 25%,#00d4ff88 75%,transparent 100%)",
          }} />

          <span style={{
            fontFamily:    "Orbitron, sans-serif",
            fontSize:      "7px",
            color:         "rgba(0,212,255,0.45)",
            letterSpacing: "0.22em",
            marginBottom:  "4px",
          }}>
            SYSTEM TIME
          </span>

          <span style={{
            fontFamily:  "Orbitron, sans-serif",
            fontSize:    "34px",
            fontWeight:  700,
            lineHeight:  1,
            color:       "#7b2ff7",
            letterSpacing: "0.04em",
            textShadow:  "0 0 18px rgba(123,47,247,0.9), 0 0 36px rgba(123,47,247,0.5), 0 0 54px rgba(123,47,247,0.22)",
          }}>
            {hh}
          </span>

          <span style={{
            fontFamily:  "Orbitron, sans-serif",
            fontSize:    "20px",
            fontWeight:  400,
            lineHeight:  1,
            color:       "#00d4ff",
            letterSpacing: "0.06em",
            textShadow:  "0 0 12px rgba(0,212,255,0.7), 0 0 24px rgba(0,212,255,0.35)",
          }}>
            {ss}
          </span>
        </div>

        {/* ── Bottom neon edge ── */}
        <div style={{
          position: "absolute", bottom: 0, left: 0, right: 0, height: "1px", zIndex: 3,
          background: "linear-gradient(90deg,transparent 0%,rgba(123,47,247,0.6) 40%,rgba(0,212,255,0.6) 60%,transparent 100%)",
        }} />
      </header>

      {/* ── Fullscreen Modal (portal-like, rendered outside header) ── */}
      {fullscreen && current && (
        <FullscreenModal
          item={current}
          onClose={() => setFullscreen(false)}
        />
      )}
    </>
  );
}

function _fmt(d: Date): string {
  return d.toLocaleTimeString("en-US", {
    hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}
