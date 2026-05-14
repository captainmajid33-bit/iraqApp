import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Save, MapPin, Navigation, CheckCircle, AlertCircle } from "lucide-react";
import { FilterKind } from "@/data/types";

interface AdminModalProps {
  latlng: { lat: number; lng: number } | null;
  onClose: () => void;
  onSaved: (item: any) => void;
}

const FIELD_STYLE: React.CSSProperties = {
  width: "100%",
  background: "rgba(0,245,212,0.04)",
  border: "1px solid rgba(0,245,212,0.3)",
  color: "#e8f8f5",
  fontFamily: "Rajdhani, sans-serif",
  fontSize: "15px",
  padding: "8px 12px",
  outline: "none",
  letterSpacing: "0.03em",
  borderRadius: "2px",
  transition: "border-color 0.2s",
  boxSizing: "border-box",
};

const CATEGORY_CONFIG: Record<FilterKind, {
  label: string;
  color: string;
  icon: string;
  detailsLabel: string;
  detailsPlaceholder: string;
  namePlaceholder: string;
}> = {
  clinic: {
    label: "عيادة / طبيب",
    color: "#00f5d4",
    icon: "🏥",
    detailsLabel: "الطبيب والتخصص",
    detailsPlaceholder: "د. محمد علي — طب أسنان",
    namePlaceholder: "عيادة د. ...",
  },
  restaurant: {
    label: "مطعم / كافيه",
    color: "#ff9500",
    icon: "🍽️",
    detailsLabel: "نوع المطعم والمأكولات",
    detailsPlaceholder: "مشاوي وكباب — مطعم شعبي",
    namePlaceholder: "مطعم ...",
  },
  pharmacy: {
    label: "صيدلية",
    color: "#c77dff",
    icon: "💊",
    detailsLabel: "اسم الصيدلاني / النوع",
    detailsPlaceholder: "صيدلاني: أحمد كاظم — صيدلية عامة",
    namePlaceholder: "صيدلية ...",
  },
  gas_station: {
    label: "محطة وقود",
    color: "#f5c518",
    icon: "⛽",
    detailsLabel: "أنواع الوقود / الخدمات",
    detailsPlaceholder: "بنزين · غاز · ديزل",
    namePlaceholder: "محطة ...",
  },
};

type GpsState = 'idle' | 'loading' | 'locked' | 'error';

export function AdminModal({ latlng, onClose, onSaved }: AdminModalProps) {
  const [category, setCategory] = useState<FilterKind>("clinic");
  const [form, setForm] = useState({
    name: "",
    details: "",
    address: "بعقوبة - ",
    phone: "077",
    hours: "9:00 ص - 5:00 م",
    status: "مفتوح",
  });
  // Internal coords — starts from map-click, can be overridden by GPS
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(latlng);
  const [gpsState, setGpsState] = useState<GpsState>('idle');
  const [gpsError, setGpsError] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!latlng && !coords) return null;

  const cfg = CATEGORY_CONFIG[category];

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  // ── GPS snap ────────────────────────────────────────────────────────────────
  const snapToGps = () => {
    if (!navigator.geolocation) {
      setGpsState('error');
      setGpsError('GPS غير مدعوم في هذا المتصفح');
      return;
    }
    setGpsState('loading');
    setGpsError('');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        setCoords({ lat: latitude, lng: longitude });
        setGpsState('locked');
        // Auto-reset glow after 4s
        setTimeout(() => setGpsState('idle'), 4000);
      },
      (err) => {
        setGpsState('error');
        setGpsError(
          err.code === 1 ? 'تم رفض إذن الموقع' :
          err.code === 2 ? 'تعذّر تحديد الموقع' :
          'انتهت مهلة طلب الموقع'
        );
        setTimeout(() => setGpsState('idle'), 3500);
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  };

  const handleSave = async () => {
    if (!form.name.trim()) { setError("الاسم مطلوب"); return; }
    if (!coords) { setError("يرجى تحديد الموقع"); return; }
    setSaving(true); setError(null);
    try {
      const res = await fetch("/api/locations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, category, lat: coords.lat, lng: coords.lng }),
      });
      if (!res.ok) throw new Error(await res.text());
      const saved = await res.json();
      onSaved({ ...saved, kind: category });
      onClose();
    } catch (e: any) {
      setError(e?.message ?? "فشل الحفظ");
    } finally {
      setSaving(false);
    }
  };

  // GPS button visual config per state
  const gpsCfg = {
    idle:    { bg: 'rgba(0,212,255,0.08)',  border: 'rgba(0,212,255,0.35)', color: '#00d4ff',  shadow: 'none',                        label: 'تحديد موقعي',      Icon: Navigation  },
    loading: { bg: 'rgba(245,197,24,0.1)',  border: '#f5c518',              color: '#f5c518',  shadow: '0 0 16px rgba(245,197,24,0.4)', label: 'جاري التحديد...', Icon: Navigation  },
    locked:  { bg: 'rgba(0,245,212,0.15)',  border: '#00f5d4',              color: '#00f5d4',  shadow: '0 0 20px rgba(0,245,212,0.5)', label: 'تم تحديد موقعك ✓', Icon: CheckCircle },
    error:   { bg: 'rgba(255,45,120,0.1)',  border: '#ff2d78',              color: '#ff2d78',  shadow: '0 0 16px rgba(255,45,120,0.4)', label: gpsError || 'خطأ في GPS', Icon: AlertCircle },
  }[gpsState];

  const activeCoords = coords ?? latlng!;

  return (
    <AnimatePresence>
      <div
        style={{ position: "fixed", inset: 0, zIndex: 9000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.72)", backdropFilter: "blur(4px)" }}
        onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      >
        <motion.div
          initial={{ scale: 0.88, opacity: 0, y: 20 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.88, opacity: 0, y: 20 }}
          transition={{ type: "spring", damping: 20, stiffness: 220 }}
          style={{
            background: "rgba(5,8,15,0.98)",
            border: `1px solid ${cfg.color}`,
            boxShadow: `0 0 40px ${cfg.color}40, 0 0 80px ${cfg.color}14`,
            width: "100%", maxWidth: "460px", direction: "rtl", borderRadius: "2px",
            maxHeight: "90vh", overflowY: "auto",
          }}
        >
          {/* Header */}
          <div style={{ padding: "14px 18px", borderBottom: `1px solid ${cfg.color}33`, background: `${cfg.color}0e`, display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 1, backdropFilter: "blur(8px)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: cfg.color, boxShadow: `0 0 8px ${cfg.color}`, animation: "lf-ping 2s infinite" }} />
              <span style={{ fontFamily: "Orbitron, sans-serif", fontSize: "11px", color: cfg.color, letterSpacing: "0.12em" }}>ADMIN · إضافة موقع جديد</span>
            </div>
            <button onClick={onClose} style={{ background: "none", border: "none", color: cfg.color, cursor: "pointer", padding: "2px" }}>
              <X size={18} />
            </button>
          </div>

          <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: "14px" }}>

            {/* ── Coordinates block: badge + GPS button side by side ── */}
            <div style={{ display: "flex", gap: "8px", alignItems: "stretch" }}>
              {/* Coordinates badge */}
              <div style={{
                flex: 1, display: "flex", alignItems: "center", gap: "8px",
                background: gpsState === 'locked' ? "rgba(0,245,212,0.1)" : "rgba(245,197,24,0.07)",
                border: `1px solid ${gpsState === 'locked' ? 'rgba(0,245,212,0.5)' : 'rgba(245,197,24,0.3)'}`,
                padding: "6px 12px",
                color: gpsState === 'locked' ? "#00f5d4" : "#f5c518",
                fontFamily: "Orbitron, monospace", fontSize: "10px", letterSpacing: "0.08em",
                transition: "all 0.35s",
                boxShadow: gpsState === 'locked' ? "0 0 12px rgba(0,245,212,0.2)" : "none",
              }}>
                <MapPin size={12} style={{ flexShrink: 0 }} />
                <span style={{ direction: "ltr" }}>
                  {activeCoords.lat.toFixed(5)}, {activeCoords.lng.toFixed(5)}
                </span>
                {gpsState === 'locked' && (
                  <span style={{ fontFamily: "Rajdhani, sans-serif", fontSize: "9px", color: "#00f5d4aa", letterSpacing: "0.1em", marginRight: "4px" }}>GPS</span>
                )}
              </div>

              {/* GPS Floating Button */}
              <motion.button
                onClick={snapToGps}
                disabled={gpsState === 'loading'}
                whileHover={{ scale: gpsState === 'loading' ? 1 : 1.05 }}
                whileTap={{ scale: 0.95 }}
                style={{
                  flexShrink: 0,
                  background: gpsCfg.bg,
                  border: `1.5px solid ${gpsCfg.border}`,
                  color: gpsCfg.color,
                  boxShadow: gpsCfg.shadow,
                  fontFamily: "Rajdhani, sans-serif",
                  fontSize: "11px",
                  fontWeight: 700,
                  letterSpacing: "0.04em",
                  padding: "6px 12px",
                  cursor: gpsState === 'loading' ? "wait" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  borderRadius: "2px",
                  transition: "background 0.3s, border-color 0.3s, box-shadow 0.3s, color 0.3s",
                  minWidth: "max-content",
                }}
              >
                <motion.div
                  animate={gpsState === 'loading' ? { rotate: 360 } : { rotate: 0 }}
                  transition={gpsState === 'loading' ? { repeat: Infinity, duration: 1, ease: "linear" } : { duration: 0.2 }}
                  style={{ display: "flex" }}
                >
                  <gpsCfg.Icon size={14} />
                </motion.div>
                <span>{gpsCfg.label}</span>
              </motion.button>
            </div>

            {/* GPS accuracy note — shown only when locked */}
            {gpsState === 'locked' && (
              <motion.div
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                style={{
                  display: "flex", alignItems: "center", gap: "6px",
                  padding: "6px 10px",
                  background: "rgba(0,245,212,0.07)",
                  border: "1px solid rgba(0,245,212,0.25)",
                  color: "rgba(0,245,212,0.8)",
                  fontFamily: "Rajdhani, sans-serif",
                  fontSize: "12px",
                  marginTop: "-6px",
                }}
              >
                <CheckCircle size={12} />
                <span>تم تحديث الإحداثيات إلى موقعك الدقيق — يمكنك الحفظ الآن</span>
              </motion.div>
            )}

            {/* Category selector */}
            <div>
              <label style={{ display: "block", fontFamily: "Rajdhani, sans-serif", fontSize: "11px", color: "rgba(0,245,212,0.7)", letterSpacing: "0.08em", marginBottom: "8px" }}>نوع الموقع</label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                {(Object.keys(CATEGORY_CONFIG) as FilterKind[]).map(cat => {
                  const c = CATEGORY_CONFIG[cat];
                  const active = category === cat;
                  return (
                    <button
                      key={cat}
                      onClick={() => setCategory(cat)}
                      style={{
                        padding: "10px 8px",
                        background: active ? `${c.color}18` : "rgba(255,255,255,0.03)",
                        border: `1px solid ${active ? c.color : "rgba(255,255,255,0.1)"}`,
                        color: active ? c.color : "rgba(255,255,255,0.45)",
                        fontFamily: "Rajdhani, sans-serif",
                        fontSize: "13px",
                        cursor: "pointer",
                        display: "flex", alignItems: "center", gap: "8px",
                        justifyContent: "center",
                        boxShadow: active ? `0 0 12px ${c.color}30` : "none",
                        transition: "all 0.2s",
                        borderRadius: "2px",
                      }}
                    >
                      <span style={{ fontSize: "16px" }}>{c.icon}</span>
                      <span>{c.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Form fields */}
            {[
              { k: "name",    label: "الاسم",           placeholder: cfg.namePlaceholder },
              { k: "details", label: cfg.detailsLabel,  placeholder: cfg.detailsPlaceholder },
              { k: "address", label: "العنوان",          placeholder: "بعقوبة - ..." },
              { k: "phone",   label: "الهاتف",           placeholder: "07701234567" },
              { k: "hours",   label: "ساعات العمل",     placeholder: "9:00 ص - 5:00 م" },
            ].map(({ k, label, placeholder }) => (
              <div key={k}>
                <label style={{ display: "block", fontFamily: "Rajdhani, sans-serif", fontSize: "11px", color: `${cfg.color}bb`, letterSpacing: "0.08em", marginBottom: "5px" }}>{label}</label>
                <input
                  value={(form as any)[k]}
                  onChange={set(k)}
                  placeholder={placeholder}
                  style={FIELD_STYLE}
                  onFocus={e => (e.target.style.borderColor = cfg.color)}
                  onBlur={e => (e.target.style.borderColor = "rgba(0,245,212,0.3)")}
                />
              </div>
            ))}

            <div>
              <label style={{ display: "block", fontFamily: "Rajdhani, sans-serif", fontSize: "11px", color: `${cfg.color}bb`, letterSpacing: "0.08em", marginBottom: "5px" }}>الحالة</label>
              <select value={form.status} onChange={set("status")} style={{ ...FIELD_STYLE, cursor: "pointer" }}>
                <option value="مفتوح">مفتوح</option>
                <option value="مغلق">مغلق</option>
              </select>
            </div>

            {error && (
              <div style={{ padding: "8px 12px", background: "rgba(255,45,120,0.1)", border: "1px solid #ff2d78", color: "#ff2d78", fontFamily: "Rajdhani, sans-serif", fontSize: "13px" }}>
                {error}
              </div>
            )}

            <button
              onClick={handleSave}
              disabled={saving}
              style={{
                width: "100%", padding: "12px",
                background: saving ? `${cfg.color}0a` : `${cfg.color}18`,
                border: `1px solid ${cfg.color}`,
                color: cfg.color,
                fontFamily: "Orbitron, sans-serif", fontSize: "11px", letterSpacing: "0.1em",
                cursor: saving ? "wait" : "pointer",
                display: "flex", alignItems: "center", justifyContent: "center", gap: "8px",
                boxShadow: saving ? "none" : `0 0 16px ${cfg.color}33`,
                transition: "all 0.2s",
              }}
            >
              {saving
                ? <><span style={{ animation: "lf-spin 1s linear infinite", display: "inline-block" }}>⟳</span> جاري الحفظ...</>
                : <><Save size={14} /> حفظ في قاعدة البيانات</>
              }
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
