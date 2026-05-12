import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Save, MapPin } from "lucide-react";

interface AdminModalProps {
  latlng: { lat: number; lng: number } | null;
  onClose: () => void;
  onSaved: (clinic: any) => void;
}

const FIELD_STYLE = {
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
};

export function AdminModal({ latlng, onClose, onSaved }: AdminModalProps) {
  const [form, setForm] = useState({
    name: "",
    doctor: "",
    specialty: "طب أسنان",
    address: "بعقوبة - ",
    phone: "077",
    hours: "9:00 ص - 5:00 م",
    status: "مفتوح",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!latlng) return null;

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  const handleSave = async () => {
    if (!form.name.trim()) { setError("اسم العيادة مطلوب"); return; }
    if (!form.doctor.trim()) { setError("اسم الطبيب مطلوب"); return; }
    setSaving(true); setError(null);
    try {
      const res = await fetch("/api/clinics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, lat: latlng.lat, lng: latlng.lng }),
      });
      if (!res.ok) throw new Error(await res.text());
      const saved = await res.json();
      onSaved({ ...saved, kind: "clinic" });
      onClose();
    } catch (e: any) {
      setError(e?.message ?? "فشل الحفظ");
    } finally {
      setSaving(false);
    }
  };

  return (
    <AnimatePresence>
      <div style={{ position: "fixed", inset: 0, zIndex: 9000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}
        onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
        <motion.div
          initial={{ scale: 0.88, opacity: 0, y: 20 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.88, opacity: 0, y: 20 }}
          transition={{ type: "spring", damping: 20, stiffness: 220 }}
          style={{ background: "rgba(5,8,15,0.98)", border: "1px solid #00f5d4", boxShadow: "0 0 40px rgba(0,245,212,0.25), 0 0 80px rgba(0,245,212,0.08)", width: "100%", maxWidth: "460px", direction: "rtl", borderRadius: "2px" }}
        >
          {/* Header */}
          <div style={{ padding: "14px 18px", borderBottom: "1px solid rgba(0,245,212,0.2)", background: "rgba(0,245,212,0.06)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#00f5d4", boxShadow: "0 0 8px #00f5d4", animation: "lf-ping 2s infinite" }} />
              <span style={{ fontFamily: "Orbitron, sans-serif", fontSize: "11px", color: "#00f5d4", letterSpacing: "0.12em" }}>ADMIN · إضافة طبيب جديد</span>
            </div>
            <button onClick={onClose} style={{ background: "none", border: "none", color: "#00f5d4", cursor: "pointer", padding: "2px" }}>
              <X size={18} />
            </button>
          </div>

          {/* Coordinates badge */}
          <div style={{ padding: "10px 18px 0" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", background: "rgba(245,197,24,0.07)", border: "1px solid rgba(245,197,24,0.3)", padding: "6px 12px", color: "#f5c518", fontFamily: "Orbitron, monospace", fontSize: "10px", letterSpacing: "0.08em" }}>
              <MapPin size={12} />
              <span>COORD: {latlng.lat.toFixed(5)}, {latlng.lng.toFixed(5)}</span>
            </div>
          </div>

          {/* Form */}
          <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: "12px" }}>
            {[
              { k: "name",      label: "اسم العيادة",    placeholder: "عيادة د. ..." },
              { k: "doctor",    label: "اسم الطبيب",     placeholder: "د. محمد ..." },
              { k: "specialty", label: "التخصص",         placeholder: "طب أسنان" },
              { k: "address",   label: "العنوان",         placeholder: "بعقوبة - ..." },
              { k: "phone",     label: "الهاتف",          placeholder: "07701234567" },
              { k: "hours",     label: "ساعات العمل",    placeholder: "9:00 ص - 5:00 م" },
            ].map(({ k, label, placeholder }) => (
              <div key={k}>
                <label style={{ display: "block", fontFamily: "Rajdhani, sans-serif", fontSize: "11px", color: "rgba(0,245,212,0.7)", letterSpacing: "0.08em", marginBottom: "5px" }}>{label}</label>
                <input
                  value={(form as any)[k]}
                  onChange={set(k)}
                  placeholder={placeholder}
                  style={FIELD_STYLE}
                  onFocus={e => (e.target.style.borderColor = "#00f5d4")}
                  onBlur={e => (e.target.style.borderColor = "rgba(0,245,212,0.3)")}
                />
              </div>
            ))}

            <div>
              <label style={{ display: "block", fontFamily: "Rajdhani, sans-serif", fontSize: "11px", color: "rgba(0,245,212,0.7)", letterSpacing: "0.08em", marginBottom: "5px" }}>الحالة</label>
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

            <button onClick={handleSave} disabled={saving}
              style={{ width: "100%", padding: "12px", background: saving ? "rgba(0,245,212,0.06)" : "rgba(0,245,212,0.12)", border: "1px solid #00f5d4", color: "#00f5d4", fontFamily: "Orbitron, sans-serif", fontSize: "11px", letterSpacing: "0.1em", cursor: saving ? "wait" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", boxShadow: saving ? "none" : "0 0 16px rgba(0,245,212,0.2)", transition: "all 0.2s" }}>
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
