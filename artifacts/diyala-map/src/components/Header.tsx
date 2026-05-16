import { useEffect, useState, useRef } from "react";

const API      = "/api";
const HEADER_H = 190;
const CLOCK_W  = 154;
const INTERVAL = 5000; // ms between slides

type MediaItem = { type: "image" | "video"; url: string };

function parseMediaItems(raw: string): MediaItem[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as MediaItem[];
    } catch { /* */ }
  }
  // Backward compat — plain URL string
  if (trimmed) return [{ type: "image", url: trimmed }];
  return [];
}

export function Header() {
  const [time,       setTime]       = useState(() => _fmt(new Date()));
  const [items,      setItems]      = useState<MediaItem[]>([]);
  const [idx,        setIdx]        = useState(0);
  const [visible,    setVisible]    = useState(true); // for crossfade
  const [isMuted,    setIsMuted]    = useState(true);
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

  const current   = items[idx] ?? null;
  const showMedia = Boolean(current);
  const hh        = time.slice(0, 5);
  const ss        = time.slice(5);

  return (
    <header
      style={{
        height:        `${HEADER_H}px`,
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
              {current!.type === "video" ? (
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
                    objectFit: "cover", objectPosition: "center",
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
                    objectFit: "cover", objectPosition: "center",
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

            {/* ── Mute / Unmute button (video only) ── */}
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
                }}
              >
                {isMuted ? (
                  /* Muted — speaker with X */
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(123,47,247,0.9)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                    <line x1="23" y1="9" x2="17" y2="15"/>
                    <line x1="17" y1="9" x2="23" y2="15"/>
                  </svg>
                ) : (
                  /* Unmuted — speaker with waves */
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(0,212,255,0.9)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
                  </svg>
                )}
              </button>
            )}

            {/* ── Dot indicators (only when >1 item) ── */}
            {items.length > 1 && (
              <div style={{
                position: "absolute", bottom: "8px", left: 0, right: 0,
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
  );
}

function _fmt(d: Date): string {
  return d.toLocaleTimeString("en-US", {
    hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}
