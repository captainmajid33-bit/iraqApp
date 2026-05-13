import { useEffect, useState, useRef } from "react";

const API          = "/api";
const HEADER_H     = 190; // px — between 180-200 as requested
const CLOCK_W      = 154; // px — clock sidebar width

export function Header() {
  const [time,      setTime]      = useState(() => _fmt(new Date()));
  const [bannerUrl, setBannerUrl] = useState<string>("");
  const [imgError,  setImgError]  = useState(false);
  const esRef = useRef<EventSource | null>(null);

  // ── Live clock — ticks every second ────────────────────────────────────────
  useEffect(() => {
    const iv = setInterval(() => setTime(_fmt(new Date())), 1000);
    return () => clearInterval(iv);
  }, []);

  // ── Fetch top_banner on mount ──────────────────────────────────────────────
  useEffect(() => {
    fetch(`${API}/settings/top_banner`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.value) { setBannerUrl(d.value); setImgError(false); } })
      .catch(() => {});
  }, []);

  // ── SSE — real-time banner update for all users ───────────────────────────
  useEffect(() => {
    function connect() {
      const es = new EventSource(`${API}/events`);
      esRef.current = es;
      es.addEventListener("setting_update", (ev: MessageEvent) => {
        try {
          const { key, value } = JSON.parse(ev.data) as { key: string; value: string };
          if (key === "top_banner") { setBannerUrl(value ?? ""); setImgError(false); }
        } catch { /* */ }
      });
      es.onerror = () => { es.close(); setTimeout(connect, 5_000); };
    }
    connect();
    return () => { esRef.current?.close(); };
  }, []);

  const showBanner = Boolean(bannerUrl) && !imgError;
  const hh = time.slice(0, 5);   // "HH:mm"
  const ss = time.slice(5);      // ":ss"

  return (
    <header
      style={{
        height:      `${HEADER_H}px`,
        display:     "flex",
        flexDirection: "row",
        flexShrink:  0,
        direction:   "ltr",           // always LTR so banner=left, clock=right
        overflow:    "hidden",
        position:    "relative",
        background:  "#05080f",
        borderBottom: "1px solid rgba(123,47,247,0.5)",
        boxShadow:   "0 0 32px rgba(123,47,247,0.14)",
        zIndex:      10,
      }}
    >
      {/* ── Top neon edge ── */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, height: "2px", zIndex: 3,
        background: "linear-gradient(90deg,transparent 0%,#7b2ff7 30%,#00d4ff 70%,transparent 100%)",
      }} />

      {/* ═══════════════════════════════════════════════════════════════════════
          LEFT PANEL — Dynamic Banner (flex: 1, cover fill)
      ═══════════════════════════════════════════════════════════════════════ */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>

        {showBanner ? (
          <>
            {/* Banner image — objectFit:cover, no black gaps */}
            <img
              src={bannerUrl}
              alt="banner"
              onError={() => setImgError(true)}
              style={{
                position: "absolute", inset: 0,
                width: "100%", height: "100%",
                objectFit: "cover", objectPosition: "center",
                display: "block",
              }}
            />
            {/* Right-edge fade so clock panel looks seamless */}
            <div style={{
              position: "absolute", inset: 0,
              background: "linear-gradient(to right, rgba(5,8,15,0.05) 60%, rgba(5,8,15,0.75) 100%)",
            }} />
          </>
        ) : (
          /* ── Empty state: radial glow + slot hint ── */
          <div style={{
            position: "absolute", inset: 0,
            background: "radial-gradient(ellipse at 40% 50%, rgba(123,47,247,0.07) 0%, rgba(5,8,15,0) 68%)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <div style={{
              border: "1px dashed rgba(123,47,247,0.18)",
              padding: "8px 24px",
              fontFamily: "Orbitron, sans-serif",
              fontSize: "9px",
              color: "rgba(123,47,247,0.28)",
              letterSpacing: "0.16em",
            }}>
              BANNER SLOT · أضف صورة البنر من لوحة الأدمن
            </div>
          </div>
        )}
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════
          RIGHT PANEL — Clock sidebar (only the clock, nothing else)
      ═══════════════════════════════════════════════════════════════════════ */}
      <div style={{
        width:        `${CLOCK_W}px`,
        flexShrink:   0,
        position:     "relative",
        display:      "flex",
        flexDirection: "column",
        alignItems:   "center",
        justifyContent: "center",
        gap:          "2px",
        background:   "rgba(5,8,15,0.92)",
        zIndex:       1,
      }}>
        {/* Left separator — neon vertical line */}
        <div style={{
          position: "absolute", top: 0, bottom: 0, left: 0, width: "1px",
          background: "linear-gradient(180deg,transparent 0%,#7b2ff788 25%,#00d4ff88 75%,transparent 100%)",
        }} />

        {/* Label */}
        <span style={{
          fontFamily:    "Orbitron, sans-serif",
          fontSize:      "7px",
          color:         "rgba(0,212,255,0.45)",
          letterSpacing: "0.22em",
          marginBottom:  "4px",
        }}>
          SYSTEM TIME
        </span>

        {/* HH:mm — large neon purple */}
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

        {/* :ss — cyan accent */}
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
