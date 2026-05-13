import { useEffect, useState, useRef } from "react";

const API = "/api";

export function Header() {
  const [time,      setTime]      = useState(() => _fmt(new Date()));
  const [bannerUrl, setBannerUrl] = useState<string>("");
  const [imgError,  setImgError]  = useState(false);
  const esRef = useRef<EventSource | null>(null);

  // ── Live clock ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const iv = setInterval(() => setTime(_fmt(new Date())), 1000);
    return () => clearInterval(iv);
  }, []);

  // ── Fetch top_banner on mount ──────────────────────────────────────────────
  useEffect(() => {
    fetch(`${API}/settings/top_banner`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.value) { setBannerUrl(data.value); setImgError(false); } })
      .catch(() => {});
  }, []);

  // ── SSE listener — real-time banner update for all users ──────────────────
  useEffect(() => {
    function connect() {
      const es = new EventSource(`${API}/events`);
      esRef.current = es;
      es.addEventListener("setting_update", (e: MessageEvent) => {
        try {
          const { key, value } = JSON.parse(e.data) as { key: string; value: string };
          if (key === "top_banner") {
            setBannerUrl(value ?? "");
            setImgError(false);
          }
        } catch { /* */ }
      });
      es.onerror = () => { es.close(); setTimeout(connect, 5000); };
    }
    connect();
    return () => { esRef.current?.close(); };
  }, []);

  const showBanner = bannerUrl && !imgError;

  return (
    <header style={{
      height: showBanner ? "auto" : "64px",
      minHeight: "64px",
      display: "flex",
      alignItems: "stretch",
      justifyContent: "space-between",
      borderBottom: "1px solid rgba(123,47,247,0.45)",
      boxShadow: "0 0 28px rgba(123,47,247,0.18), inset 0 -1px 0 rgba(123,47,247,0.12)",
      background: "rgba(5,8,15,0.92)",
      backdropFilter: "blur(12px)",
      zIndex: 10,
      flexShrink: 0,
      position: "relative",
      overflow: "hidden",
    }}>
      {/* ── Neon top-edge glow line ── */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, height: "2px",
        background: "linear-gradient(90deg, transparent 0%, #7b2ff7 30%, #00d4ff 70%, transparent 100%)",
        opacity: 0.7,
      }} />

      {/* ── Dynamic banner (cover image) ────────────────────────────────────── */}
      {showBanner && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 0,
          overflow: "hidden",
        }}>
          <img
            src={bannerUrl}
            alt="بنر ديالى"
            onError={() => setImgError(true)}
            style={{
              width: "100%", height: "100%",
              objectFit: "cover",
              objectPosition: "center",
              display: "block",
            }}
          />
          {/* Dark gradient overlay so text stays readable */}
          <div style={{
            position: "absolute", inset: 0,
            background: "linear-gradient(90deg, rgba(5,8,15,0.82) 0%, rgba(5,8,15,0.4) 50%, rgba(5,8,15,0.72) 100%)",
          }} />
        </div>
      )}

      {/* ── Left: logo zone (unchanged) ──────────────────────────────────────── */}
      <div style={{
        position: "relative", zIndex: 1,
        display: "flex", alignItems: "center", gap: "12px", padding: "0 24px",
        flexShrink: 0,
      }}>
        {/* Neon map-pin icon */}
        <div style={{
          width: "40px", height: "40px",
          border: "1px solid rgba(123,47,247,0.6)",
          boxShadow: "0 0 14px rgba(123,47,247,0.25), inset 0 0 10px rgba(123,47,247,0.08)",
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "rgba(123,47,247,0.1)",
          flexShrink: 0,
        }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#7b2ff7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{ filter: "drop-shadow(0 0 6px #7b2ff7)", animation: "lf-ping 2s cubic-bezier(0,0,0.2,1) infinite" }}>
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
            <circle cx="12" cy="10" r="3"/>
          </svg>
        </div>

        {/* Only show text if NO banner image */}
        {!showBanner && (
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{
              fontFamily: "Orbitron, sans-serif", fontSize: "20px", fontWeight: 700,
              color: "#7b2ff7", letterSpacing: "0.06em",
              textShadow: "0 0 18px rgba(123,47,247,0.8), 0 0 40px rgba(123,47,247,0.4)",
            }}>
              ديالى GTA MAP
            </span>
            <span style={{
              fontFamily: "Rajdhani, sans-serif", fontSize: "11px",
              color: "rgba(0,212,255,0.7)", letterSpacing: "0.18em",
            }}>
              DIYALA · BAQUBAH · SYSTEM ONLINE
            </span>
          </div>
        )}
      </div>

      {/* ── Center: banner placeholder hint (only when no image) ─────────────── */}
      {!showBanner && (
        <div style={{
          position: "relative", zIndex: 1,
          display: "flex", alignItems: "center", justifyContent: "center",
          flex: 1,
        }}>
          <div style={{
            border: "1px dashed rgba(123,47,247,0.2)",
            padding: "5px 18px",
            fontFamily: "Orbitron, sans-serif", fontSize: "8px",
            color: "rgba(123,47,247,0.35)", letterSpacing: "0.14em",
          }}>
            BANNER SLOT · أضف رابط صورة من لوحة الأدمن
          </div>
        </div>
      )}

      {/* ── Right: clock + status ─────────────────────────────────────────────── */}
      <div style={{
        position: "relative", zIndex: 1,
        display: "flex", alignItems: "center", gap: "14px", padding: "0 24px",
        flexShrink: 0,
      }}>
        <div style={{
          display: "flex", alignItems: "center", gap: "7px",
          border: "1px solid rgba(0,245,212,0.2)", padding: "4px 10px",
          background: "rgba(0,245,212,0.05)",
        }}>
          <div style={{
            width: "7px", height: "7px", borderRadius: "50%",
            background: "#00f5d4", boxShadow: "0 0 7px #00f5d4",
            animation: "lf-ping 2s cubic-bezier(0,0,0.2,1) infinite",
          }} />
          <span style={{ fontFamily: "Orbitron, sans-serif", fontSize: "9px", color: "#00f5d4", letterSpacing: "0.12em" }}>
            SECURE CONNECTION
          </span>
        </div>

        <div style={{
          fontFamily: "Orbitron, sans-serif", fontSize: "18px", fontWeight: 700,
          color: "#7b2ff7", letterSpacing: "0.08em",
          textShadow: "0 0 18px rgba(123,47,247,0.7)",
          display: "flex", alignItems: "center", gap: "8px",
        }}>
          <span>{time}</span>
          <span style={{ color: "rgba(123,47,247,0.45)", fontSize: "11px" }}>IQ-DIA</span>
        </div>
      </div>

      {/* ── Bottom-edge neon line ── */}
      <div style={{
        position: "absolute", bottom: 0, left: 0, right: 0, height: "1px",
        background: "linear-gradient(90deg, transparent 0%, rgba(123,47,247,0.6) 40%, rgba(0,212,255,0.6) 60%, transparent 100%)",
      }} />
    </header>
  );
}

function _fmt(d: Date): string {
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
