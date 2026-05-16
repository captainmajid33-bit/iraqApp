import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  collection, onSnapshot, addDoc, updateDoc, deleteDoc,
  doc, serverTimestamp,
} from "firebase/firestore";
import { db } from "@/lib/firebase";

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  bg:      "#05080f",
  surface: "#0d1117",
  surf2:   "#13181f",
  purple:  "#7b2ff7",
  blue:    "#00d4ff",
  red:     "#ff2d78",
  yellow:  "#f5c518",
  green:   "#00f5d4",
  text:    "#e2e8f0",
  dim:     "rgba(226,232,240,0.45)",
  border:  "rgba(123,47,247,0.28)",
};
const neon = (c: string, s = 14) => `0 0 ${s}px ${c}88, 0 0 ${s * 2}px ${c}33`;

// ── Token helpers ─────────────────────────────────────────────────────────────
const TOKEN_KEY = "adm_tk";
const getToken = () => sessionStorage.getItem(TOKEN_KEY) ?? "";
const setToken = (t: string) => sessionStorage.setItem(TOKEN_KEY, t);
const clearToken = () => sessionStorage.removeItem(TOKEN_KEY);

// ── API helpers (auto-injects admin token + password on write ops) ────────────
// x-admin-password is stateless and survives server restarts.
// x-admin-token is kept for backward compat with other admin endpoints.
const ADMIN_PW = "Admin2026";
function admHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-admin-token": getToken(),
    "x-admin-password": ADMIN_PW,
    ...extra,
  };
}
const api = {
  get:    (u: string) => fetch(u).then(r => r.json()),
  post:   (u: string, b: any) => fetch(u, { method: "POST",   headers: admHeaders(), body: JSON.stringify(b) }).then(r => r.json()),
  patch:  (u: string, b: any) => fetch(u, { method: "PATCH",  headers: admHeaders(), body: JSON.stringify(b) }).then(r => r.json()),
  delete: (u: string)         => fetch(u, { method: "DELETE", headers: admHeaders() }).then(r => r.json()),
};

// ── Types ─────────────────────────────────────────────────────────────────────
interface Loc { id: number; category: string; name: string; details: string; address: string; phone: string; hours: string; status: string; rating?: number | null; lat: number; lng: number; }
interface Cat { id: number; slug: string; labelAr: string; labelEn: string; color: string; icon: string; }

// ── Shared input styles ───────────────────────────────────────────────────────
const FLD: React.CSSProperties = { width: "100%", background: "rgba(123,47,247,0.07)", border: `1px solid ${C.border}`, color: C.text, fontFamily: "Rajdhani, sans-serif", fontSize: "14px", padding: "8px 11px", outline: "none", borderRadius: "3px", boxSizing: "border-box" };
const LBL: React.CSSProperties = { fontFamily: "Rajdhani, sans-serif", fontSize: "11px", color: C.dim, letterSpacing: "0.07em", display: "block", marginBottom: "4px" };
const ff = (e: any) => (e.target.style.borderColor = C.purple);
const fb = (e: any) => (e.target.style.borderColor = C.border);

// ── Toast ─────────────────────────────────────────────────────────────────────
function useToast() {
  const [t, setT] = useState<{ msg: string; ok: boolean } | null>(null);
  const show = (msg: string, ok = true) => { setT({ msg, ok }); setTimeout(() => setT(null), 3200); };
  return { toast: t, show };
}
function Toast({ toast }: { toast: { msg: string; ok: boolean } | null }) {
  if (!toast) return null;
  return (
    <div style={{ position: "fixed", bottom: "24px", left: "50%", transform: "translateX(-50%)", zIndex: 9999, padding: "10px 24px", background: toast.ok ? "rgba(0,245,212,0.12)" : "rgba(255,45,120,0.12)", border: `1px solid ${toast.ok ? C.green : C.red}`, color: toast.ok ? C.green : C.red, fontFamily: "Orbitron, sans-serif", fontSize: "11px", letterSpacing: "0.1em", boxShadow: neon(toast.ok ? C.green : C.red), borderRadius: "2px", whiteSpace: "nowrap" }}>
      {toast.ok ? "✓" : "✗"} {toast.msg}
    </div>
  );
}

// ── Btn helper ────────────────────────────────────────────────────────────────
function Btn({ label, color, onClick, full }: { label: string; color: string; onClick: () => void; full?: boolean }) {
  return (
    <button onClick={onClick} style={{ padding: "9px 20px", width: full ? "100%" : undefined, background: `${color}15`, border: `1px solid ${color}66`, color, fontFamily: "Orbitron, sans-serif", fontSize: "10px", letterSpacing: "0.1em", cursor: "pointer", borderRadius: "3px", boxShadow: neon(color, 8), transition: "background 0.2s" }}
      onMouseEnter={e => (e.currentTarget.style.background = `${color}28`)}
      onMouseLeave={e => (e.currentTarget.style.background = `${color}15`)}>
      {label}
    </button>
  );
}

// ── Location Form ─────────────────────────────────────────────────────────────
const BLANK = { name: "", category: "clinic", details: "", address: "بعقوبة - ", phone: "077", hours: "9:00 ص - 5:00 م", status: "مفتوح", lat: "33.7451", lng: "44.6488", rating: "" };
type FormState = typeof BLANK;

function LocForm({ init, cats, onSave, onCancel }: { init?: Partial<FormState & { id: number }>; cats: Cat[]; onSave: (d: any) => Promise<void>; onCancel: () => void }) {
  const [f, setF] = useState<FormState>({ ...BLANK, ...(init ?? {}) });
  const [busy, setBusy] = useState(false);
  const s = (k: keyof FormState) => (e: any) => setF(p => ({ ...p, [k]: e.target.value }));
  const save = async () => {
    if (!f.name.trim()) return;
    setBusy(true);
    await onSave({ ...f, lat: parseFloat(f.lat as any), lng: parseFloat(f.lng as any), rating: f.rating ? parseInt(f.rating as any) : null });
    setBusy(false);
  };
  const g2: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" };
  const row = (label: string, key: keyof FormState, ph?: string) => (
    <div><label style={LBL}>{label}</label><input style={FLD} value={f[key] as string} onChange={s(key)} placeholder={ph} onFocus={ff} onBlur={fb} /></div>
  );
  return (
    <div style={{ background: C.surf2, border: `1px solid ${C.border}`, borderRadius: "4px", padding: "18px", marginBottom: "16px" }}>
      <div style={{ ...g2, marginBottom: "10px" }}>
        {row("الاسم *", "name", "اسم المكان")}
        <div><label style={LBL}>الفئة (اكتب بحرية)</label>
          <input style={FLD} value={f.category} onChange={s("category")} placeholder="clinic, restaurant, taxi..." onFocus={ff} onBlur={fb} list="cat-suggestions" />
          <datalist id="cat-suggestions">
            {cats.map(c => <option key={c.slug} value={c.slug}>{c.labelAr}</option>)}
          </datalist>
        </div>
      </div>
      <div style={{ marginBottom: "10px" }}>{row("التفاصيل", "details", "تخصص، وصف...")}</div>
      <div style={{ ...g2, marginBottom: "10px" }}>{row("العنوان", "address")} {row("الهاتف", "phone")}</div>
      <div style={{ ...g2, marginBottom: "10px" }}>{row("ساعات العمل", "hours")}
        <div><label style={LBL}>الحالة</label>
          <select style={{ ...FLD, cursor: "pointer" }} value={f.status} onChange={s("status")}>
            <option value="مفتوح">مفتوح</option><option value="مغلق">مغلق</option>
          </select>
        </div>
      </div>
      <div style={{ ...g2, marginBottom: "10px" }}>{row("خط العرض (lat)", "lat")} {row("خط الطول (lng)", "lng")}</div>
      <div style={{ marginBottom: "14px" }}><label style={LBL}>التقييم (1–5)</label><input style={{ ...FLD, maxWidth: "110px" }} type="number" min="1" max="5" value={f.rating} onChange={s("rating")} onFocus={ff} onBlur={fb} /></div>
      <div style={{ display: "flex", gap: "10px" }}>
        <Btn label={busy ? "جاري الحفظ..." : "حفظ"} color={C.purple} onClick={save} />
        <button onClick={onCancel} style={{ padding: "9px 16px", background: "transparent", border: `1px solid ${C.border}`, color: C.dim, fontFamily: "Rajdhani, sans-serif", fontSize: "13px", cursor: "pointer", borderRadius: "3px" }}>إلغاء</button>
      </div>
    </div>
  );
}

// ── Merchants Tab ─────────────────────────────────────────────────────────────
function MerchantsTab({ cats, toast }: { cats: Cat[]; toast: ReturnType<typeof useToast> }) {
  const [locs, setLocs] = useState<Loc[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("");
  const catMap = Object.fromEntries(cats.map(c => [c.slug, c]));

  const load = useCallback(async () => {
    setLoading(true);
    const d = await api.get("/api/locations");
    setLocs(Array.isArray(d) ? d : []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async (d: any) => {
    const r = await api.post("/api/locations", d);
    if (r.id) { toast.show("تمت الإضافة بنجاح"); setShowAdd(false); load(); }
    else toast.show(r.error ?? "فشلت الإضافة", false);
  };

  const handleEdit = async (id: number, d: any) => {
    const r = await api.patch(`/api/locations/${id}`, d);
    if (r.id) { toast.show("تم التعديل بنجاح"); setEditId(null); load(); }
    else toast.show(r.error ?? "فشل التعديل", false);
  };

  const handleDelete = async (id: number, name: string) => {
    if (!confirm(`حذف "${name}" نهائياً من قاعدة البيانات؟`)) return;
    await api.delete(`/api/locations/${id}`);
    toast.show("تم الحذف نهائياً"); load();
  };

  const handleToggleDisable = async (loc: Loc) => {
    const isDisabled = loc.status === "معطّل";
    const newStatus = isDisabled ? "مفتوح" : "معطّل";
    const r = await api.patch(`/api/locations/${loc.id}`, { status: newStatus });
    if (r.id) {
      toast.show(isDisabled ? `✓ تم تفعيل "${loc.name}"` : `⏸ تم تعطيل "${loc.name}" من الخريطة`);
      load();
    }
  };

  const rows = locs.filter(l =>
    (!catFilter || l.category === catFilter) &&
    (!search || l.name.includes(search) || (l.address ?? "").includes(search))
  );

  return (
    <div>
      <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginBottom: "14px", alignItems: "center" }}>
        <Btn label={showAdd ? "✕ إلغاء" : "+ إضافة تاجر"} color={C.purple} onClick={() => { setShowAdd(v => !v); setEditId(null); }} />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="بحث..." style={{ ...FLD, maxWidth: "200px", flex: 1 }} onFocus={ff} onBlur={fb} />
        <select value={catFilter} onChange={e => setCatFilter(e.target.value)} style={{ ...FLD, maxWidth: "180px", cursor: "pointer" }}>
          <option value="">كل الفئات</option>
          {cats.map(c => <option key={c.slug} value={c.slug}>{c.icon} {c.labelAr}</option>)}
        </select>
        <span style={{ fontFamily: "Orbitron, sans-serif", fontSize: "10px", color: C.dim }}>{rows.length} سجل</span>
      </div>

      {showAdd && <LocForm cats={cats} onSave={handleAdd} onCancel={() => setShowAdd(false)} />}

      {loading ? (
        <div style={{ textAlign: "center", padding: "48px", color: C.dim, fontFamily: "Orbitron, sans-serif", fontSize: "11px", letterSpacing: "0.1em" }}>LOADING...</div>
      ) : (
        <div style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: "4px" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "Rajdhani, sans-serif" }}>
            <thead>
              <tr style={{ background: `${C.purple}10`, borderBottom: `1px solid ${C.border}` }}>
                {["#", "الاسم", "الفئة", "الحالة", "الإحداثيات", "الإجراءات"].map(h => (
                  <th key={h} style={{ padding: "10px 12px", textAlign: "right", fontSize: "10px", color: C.blue, fontFamily: "Orbitron, sans-serif", letterSpacing: "0.08em", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((loc, i) => {
                const cat = catMap[loc.category];
                return editId === loc.id ? (
                  <tr key={loc.id}>
                    <td colSpan={6} style={{ padding: "12px", background: C.surf2 }}>
                      <LocForm cats={cats}
                        init={{ ...loc, lat: String(loc.lat), lng: String(loc.lng), rating: loc.rating ? String(loc.rating) : "" }}
                        onSave={d => handleEdit(loc.id, d)}
                        onCancel={() => setEditId(null)} />
                    </td>
                  </tr>
                ) : (
                  <tr key={loc.id}
                    style={{ borderBottom: `1px solid rgba(123,47,247,0.1)`, opacity: loc.status === "معطّل" ? 0.5 : 1, transition: "opacity 0.2s" }}
                    onMouseEnter={e => (e.currentTarget.style.background = `${C.purple}08`)}
                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                    <td style={{ padding: "10px 12px", color: C.dim, fontSize: "12px" }}>{i + 1}</td>
                    <td style={{ padding: "10px 12px", maxWidth: "180px" }}>
                      <div style={{ color: C.text, fontSize: "14px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {loc.status === "معطّل" && <span style={{ fontSize: "10px", color: C.yellow, marginLeft: "6px", fontFamily: "Orbitron, sans-serif" }}>⏸</span>}
                        {loc.name}
                      </div>
                      {loc.details && <div style={{ color: C.dim, fontSize: "11px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{loc.details}</div>}
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", padding: "3px 8px", background: `${cat?.color ?? C.purple}18`, border: `1px solid ${cat?.color ?? C.purple}44`, color: cat?.color ?? C.purple, fontSize: "12px", borderRadius: "2px", whiteSpace: "nowrap" }}>
                        {cat?.icon ?? "📍"} {cat?.labelAr ?? loc.category}
                      </span>
                    </td>
                    <td style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>
                      {loc.status === "معطّل"
                        ? <span style={{ color: C.yellow, fontSize: "13px" }}>⏸ معطّل</span>
                        : <span style={{ color: loc.status === "مفتوح" ? C.green : C.red, fontSize: "13px" }}>● {loc.status}</span>
                      }
                    </td>
                    <td style={{ padding: "10px 12px", fontFamily: "monospace", fontSize: "11px", color: C.dim, whiteSpace: "nowrap" }}>
                      {loc.lat.toFixed(4)}, {loc.lng.toFixed(4)}
                    </td>
                    <td style={{ padding: "10px 12px" }}>
                      <div style={{ display: "flex", gap: "5px", flexWrap: "nowrap" }}>
                        <button onClick={() => { setEditId(loc.id); setShowAdd(false); }}
                          style={{ padding: "5px 10px", background: `${C.blue}12`, border: `1px solid ${C.blue}44`, color: C.blue, fontSize: "12px", cursor: "pointer", borderRadius: "2px", fontFamily: "Rajdhani, sans-serif", whiteSpace: "nowrap" }}>تعديل</button>
                        <button onClick={() => handleToggleDisable(loc)}
                          style={{ padding: "5px 10px", background: loc.status === "معطّل" ? `${C.green}12` : `${C.yellow}12`, border: `1px solid ${loc.status === "معطّل" ? C.green : C.yellow}44`, color: loc.status === "معطّل" ? C.green : C.yellow, fontSize: "12px", cursor: "pointer", borderRadius: "2px", fontFamily: "Rajdhani, sans-serif", whiteSpace: "nowrap" }}>
                          {loc.status === "معطّل" ? "تفعيل" : "تعطيل"}
                        </button>
                        <button onClick={() => handleDelete(loc.id, loc.name)}
                          style={{ padding: "5px 10px", background: `${C.red}12`, border: `1px solid ${C.red}44`, color: C.red, fontSize: "12px", cursor: "pointer", borderRadius: "2px", fontFamily: "Rajdhani, sans-serif", whiteSpace: "nowrap" }}>حذف</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={6} style={{ padding: "36px", textAlign: "center", color: C.dim, fontFamily: "Rajdhani, sans-serif", fontSize: "14px" }}>لا توجد نتائج</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Map Editor Tab ────────────────────────────────────────────────────────────
function MapEditorTab({ cats, toast }: { cats: Cat[]; toast: ReturnType<typeof useToast> }) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markers = useRef<Map<number, L.Marker>>(new Map());
  const adminMarkerRef = useRef<L.Marker | null>(null);
  const [locs, setLocs] = useState<Loc[]>([]);
  const [catFilter, setCatFilter] = useState("");
  const [saving, setSaving] = useState<number | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const catMap = Object.fromEntries(cats.map(c => [c.slug, c]));

  const flyToMyLocation = () => {
    if (!navigator.geolocation) { toast.show("المتصفح لا يدعم GPS", false); return; }
    setGpsLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        setGpsLoading(false);
        if (!mapRef.current) return;
        mapRef.current.flyTo([lat, lng], 19, { animate: true, duration: 1.2 });

        // Remove previous admin marker if any
        adminMarkerRef.current?.remove();

        const icon = L.divIcon({
          className: "",
          html: `<div style="position:relative;display:flex;flex-direction:column;align-items:center;gap:3px">
            <div style="position:absolute;inset:-8px;border-radius:50%;border:2px solid #00f5d4;opacity:0.5;animation:lf-ping 1.8s cubic-bezier(0,0,0.2,1) infinite"></div>
            <div style="width:36px;height:36px;border-radius:50%;background:rgba(0,245,212,0.15);border:2.5px solid #00f5d4;display:flex;align-items:center;justify-content:center;box-shadow:0 0 20px #00f5d488;position:relative;z-index:1">
              <span style="font-size:17px">📍</span>
            </div>
            <div style="background:rgba(0,245,212,0.18);border:1px solid rgba(0,245,212,0.5);color:#00f5d4;font-family:Orbitron,sans-serif;font-size:7px;padding:2px 7px;white-space:nowrap;letter-spacing:0.12em">موقعك</div>
          </div>`,
          iconSize: [36, 56], iconAnchor: [18, 56],
        });

        const m = L.marker([lat, lng], { icon }).addTo(mapRef.current);
        m.bindPopup(
          `<div style="background:#0d1117;padding:10px 13px;direction:rtl;font-family:Rajdhani,sans-serif">
            <div style="color:#00f5d4;font-size:13px;font-weight:700;margin-bottom:4px">📍 موقعك الحالي</div>
            <div style="color:#aaa;font-size:11px;font-family:monospace">${lat.toFixed(6)}, ${lng.toFixed(6)}</div>
            <div style="color:#555;font-size:10px;margin-top:3px">اسحب أيقونات التجار فوق هذه النقطة</div>
          </div>`,
          { closeButton: false, offset: [0, -10] }
        ).openPopup();
        adminMarkerRef.current = m;
        toast.show("📍 تم تحديد موقعك");
      },
      (err) => {
        setGpsLoading(false);
        const msg = err.code === 1 ? "تم رفض إذن الموقع" : err.code === 2 ? "تعذّر تحديد الموقع" : "انتهت مهلة تحديد الموقع";
        toast.show(msg, false);
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
    );
  };

  const load = useCallback(async () => {
    const d = await api.get("/api/locations");
    setLocs(Array.isArray(d) ? d : []);
  }, []);
  useEffect(() => { load(); }, [load]);

  // Init map once
  useEffect(() => {
    if (!container.current || mapRef.current) return;
    mapRef.current = L.map(container.current, { center: [33.7451, 44.6488], zoom: 13 });
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { subdomains: "abcd", maxZoom: 20 }).addTo(mapRef.current);
    return () => { mapRef.current?.remove(); mapRef.current = null; };
  }, []);

  // Sync markers
  useEffect(() => {
    if (!mapRef.current) return;
    markers.current.forEach(m => m.remove());
    markers.current.clear();

    const visible = catFilter ? locs.filter(l => l.category === catFilter) : locs;
    visible.forEach(loc => {
      const cat = catMap[loc.category];
      const color = cat?.color ?? "#7b2ff7";
      const icon = L.divIcon({
        className: "",
        html: `<div style="width:30px;height:30px;display:flex;align-items:center;justify-content:center;position:relative">
          <div style="position:absolute;inset:0;border-radius:50%;border:2px solid ${color};box-shadow:0 0 10px ${color}88"></div>
          <span style="font-size:13px;position:relative;z-index:1">${cat?.icon ?? "📍"}</span>
        </div>`,
        iconSize: [30, 30], iconAnchor: [15, 15],
      });
      const marker = L.marker([loc.lat, loc.lng], { icon, draggable: true }).addTo(mapRef.current!);

      const mkPopup = (lat: number, lng: number, saved = false) =>
        `<div style="background:#0d1117;padding:10px 13px;direction:rtl;min-width:160px;font-family:Rajdhani,sans-serif">
          <div style="color:${color};font-size:13px;font-weight:700;margin-bottom:3px">${loc.name}</div>
          <div style="color:#888;font-size:11px">${cat?.labelAr ?? loc.category}</div>
          <div style="color:${saved ? "#00f5d4" : "#f5c518"};font-size:11px;margin-top:4px;font-family:monospace">${lat.toFixed(5)}, ${lng.toFixed(5)}</div>
          <div style="color:${saved ? "#00f5d4" : "#7b2ff7"};font-size:10px;margin-top:3px">${saved ? "✓ تم الحفظ" : "↕ اسحب لتغيير الموقع"}</div>
        </div>`;

      marker.bindPopup(L.popup({ offset: [0, -8], closeButton: false }).setContent(mkPopup(loc.lat, loc.lng)));
      marker.on("click", () => marker.openPopup());

      marker.on("dragend", async () => {
        const ll = marker.getLatLng();
        setSaving(loc.id);
        try {
          await api.patch(`/api/locations/${loc.id}`, { lat: ll.lat, lng: ll.lng });
          toast.show(`${loc.name} — تم حفظ الموقع`);
          marker.getPopup()?.setContent(mkPopup(ll.lat, ll.lng, true));
        } catch {
          toast.show("فشل حفظ الموقع", false);
        } finally { setSaving(null); }
      });

      markers.current.set(loc.id, marker);
    });
  }, [locs, catFilter]);

  return (
    <div>
      <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", marginBottom: "12px", alignItems: "center" }}>
        <select value={catFilter} onChange={e => setCatFilter(e.target.value)} style={{ ...FLD, maxWidth: "200px", cursor: "pointer" }}>
          <option value="">كل الفئات</option>
          {cats.map(c => <option key={c.slug} value={c.slug}>{c.icon} {c.labelAr}</option>)}
        </select>
        <span style={{ color: C.dim, fontFamily: "Rajdhani, sans-serif", fontSize: "13px" }}>↕ اسحب أي أيقونة لتحديث موقعها — يُحفظ تلقائياً</span>
        {saving !== null && <span style={{ color: C.yellow, fontFamily: "Orbitron, sans-serif", fontSize: "10px" }}>⟳ جاري الحفظ...</span>}
      </div>
      <div style={{ position: "relative" }}>
        <div ref={container} style={{ height: "calc(100vh - 200px)", minHeight: "440px", border: `1px solid ${C.border}`, borderRadius: "4px", overflow: "hidden" }} />

        {/* ── Floating GPS Button ── */}
        <button
          onClick={flyToMyLocation}
          disabled={gpsLoading}
          title="انتقل إلى موقعي"
          style={{
            position: "absolute", top: "12px", left: "12px", zIndex: 1000,
            width: "42px", height: "42px",
            background: gpsLoading ? "rgba(0,245,212,0.08)" : "rgba(0,245,212,0.15)",
            border: `1.5px solid ${gpsLoading ? "rgba(0,245,212,0.35)" : "rgba(0,245,212,0.7)"}`,
            borderRadius: "4px",
            cursor: gpsLoading ? "wait" : "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: gpsLoading ? "none" : "0 0 14px rgba(0,245,212,0.3)",
            transition: "all 0.2s",
          }}
          onMouseEnter={e => { if (!gpsLoading) (e.currentTarget as HTMLElement).style.background = "rgba(0,245,212,0.26)"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = gpsLoading ? "rgba(0,245,212,0.08)" : "rgba(0,245,212,0.15)"; }}
        >
          {gpsLoading ? (
            <svg width="18" height="18" viewBox="0 0 28 28" fill="none" style={{ animation: "lf-spin 0.9s linear infinite" }}>
              <circle cx="14" cy="14" r="10" stroke="#00f5d4" strokeWidth="2.5" strokeDasharray="22 14" strokeLinecap="round" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#00f5d4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
              <circle cx="12" cy="12" r="8" strokeOpacity="0.35" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

// ── Categories Tab ────────────────────────────────────────────────────────────
function CategoriesTab({ cats, onRefresh, toast }: { cats: Cat[]; onRefresh: () => void; toast: ReturnType<typeof useToast> }) {
  const BLANK = { slug: "", labelAr: "", labelEn: "", color: "#7b2ff7", icon: "📍" };
  const [form,     setForm]     = useState(BLANK);
  const [editId,   setEditId]   = useState<number | null>(null);
  const [busy,     setBusy]     = useState(false);
  const formRef = useRef<HTMLDivElement>(null);
  const s = (k: string) => (e: any) => setForm(f => ({ ...f, [k]: e.target.value }));

  const startEdit = (cat: Cat) => {
    setForm({ slug: cat.slug, labelAr: cat.labelAr, labelEn: cat.labelEn, color: cat.color, icon: cat.icon });
    setEditId(cat.id);
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
  };

  const cancelEdit = () => { setForm(BLANK); setEditId(null); };

  const handleSave = async () => {
    if (!form.slug.trim() || !form.labelAr.trim()) return;
    setBusy(true);
    if (editId !== null) {
      const r = await api.patch(`/api/categories/${editId}`, form);
      setBusy(false);
      if (r.id) { toast.show("تم تحديث الفئة بنجاح"); cancelEdit(); onRefresh(); }
      else toast.show(r.error ?? "فشل التحديث", false);
    } else {
      const r = await api.post("/api/categories", form);
      setBusy(false);
      if (r.id) { toast.show("تمت إضافة الفئة"); setForm(BLANK); onRefresh(); }
      else toast.show(r.error ?? "فشلت الإضافة", false);
    }
  };

  const handleDel = async (id: number, label: string) => {
    if (!confirm(`حذف "${label}"؟`)) return;
    if (editId === id) cancelEdit();
    await api.delete(`/api/categories/${id}`);
    toast.show("تم الحذف"); onRefresh();
  };

  const isEdit = editId !== null;
  const accentColor = isEdit ? C.yellow : C.purple;

  return (
    <div style={{ maxWidth: "660px" }}>
      <div style={{ marginBottom: "28px" }}>
        <div style={{ fontFamily: "Orbitron, sans-serif", fontSize: "10px", color: C.blue, letterSpacing: "0.12em", marginBottom: "12px" }}>الفئات الحالية</div>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {cats.map(cat => {
            const isActive = editId === cat.id;
            return (
              <div key={cat.id} style={{
                display: "flex", alignItems: "center", gap: "14px",
                padding: "12px 16px", background: C.surf2,
                border: `1px solid ${isActive ? cat.color + "88" : cat.color + "33"}`,
                borderRadius: "4px",
                boxShadow: isActive ? `0 0 14px ${cat.color}22` : "none",
                transition: "all 0.2s",
              }}>
                <span style={{ fontSize: "22px" }}>{cat.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: C.text, fontFamily: "Rajdhani, sans-serif", fontSize: "15px", fontWeight: 600 }}>{cat.labelAr}</div>
                  <div style={{ color: C.dim, fontFamily: "Orbitron, sans-serif", fontSize: "10px", letterSpacing: "0.08em" }}>{cat.slug} · {cat.labelEn}</div>
                </div>
                <div style={{ width: "16px", height: "16px", borderRadius: "50%", background: cat.color, boxShadow: neon(cat.color, 8), flexShrink: 0 }} />
                <button
                  onClick={() => isActive ? cancelEdit() : startEdit(cat)}
                  style={{
                    padding: "5px 12px",
                    background: isActive ? `${C.yellow}18` : `${C.blue}10`,
                    border: `1px solid ${isActive ? C.yellow + "88" : C.blue + "44"}`,
                    color: isActive ? C.yellow : C.blue,
                    fontSize: "12px", cursor: "pointer", borderRadius: "2px",
                    fontFamily: "Rajdhani, sans-serif", whiteSpace: "nowrap", transition: "all 0.2s",
                  }}
                >{isActive ? "إلغاء" : "تعديل"}</button>
                <button
                  onClick={() => handleDel(cat.id, cat.labelAr)}
                  style={{ padding: "5px 12px", background: `${C.red}10`, border: `1px solid ${C.red}44`, color: C.red, fontSize: "12px", cursor: "pointer", borderRadius: "2px", fontFamily: "Rajdhani, sans-serif", whiteSpace: "nowrap" }}
                >حذف</button>
              </div>
            );
          })}
        </div>
      </div>

      <div ref={formRef} style={{ background: C.surf2, border: `1.5px solid ${accentColor}44`, borderRadius: "4px", padding: "20px", transition: "border-color 0.3s", boxShadow: isEdit ? `0 0 24px ${accentColor}18` : "none" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
          <div style={{ fontFamily: "Orbitron, sans-serif", fontSize: "10px", color: accentColor, letterSpacing: "0.12em" }}>
            {isEdit ? `✏ تعديل الفئة: ${form.labelAr || "..."}` : "+ إضافة فئة جديدة"}
          </div>
          {isEdit && (
            <button onClick={cancelEdit} style={{ background: "none", border: `1px solid ${C.red}44`, color: C.red, fontSize: "11px", padding: "3px 10px", cursor: "pointer", borderRadius: "2px", fontFamily: "Rajdhani, sans-serif" }}>✕ إلغاء التعديل</button>
          )}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "10px" }}>
          <div>
            <label style={LBL}>المعرّف (slug) *</label>
            <input style={{ ...FLD, ...(isEdit ? { background: `${C.yellow}08`, borderColor: `${C.yellow}44` } : {}) }} value={form.slug} onChange={s("slug")} placeholder="taxi" onFocus={ff} onBlur={fb} readOnly={isEdit} />
          </div>
          <div><label style={LBL}>الاسم بالعربي *</label><input style={FLD} value={form.labelAr} onChange={s("labelAr")} placeholder="تكسي" onFocus={ff} onBlur={fb} /></div>
          <div><label style={LBL}>الاسم بالإنجليزي</label><input style={FLD} value={form.labelEn} onChange={s("labelEn")} placeholder="Taxi" onFocus={ff} onBlur={fb} /></div>
          <div><label style={LBL}>الأيقونة (emoji)</label><input style={FLD} value={form.icon} onChange={s("icon")} placeholder="🚕" onFocus={ff} onBlur={fb} /></div>
        </div>
        <div style={{ marginBottom: "16px" }}>
          <label style={LBL}>اللون</label>
          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            <input type="color" value={form.color} onChange={s("color")} style={{ width: "44px", height: "36px", padding: "2px", background: "transparent", border: `1px solid ${C.border}`, cursor: "pointer", borderRadius: "3px" }} />
            <span style={{ fontFamily: "monospace", fontSize: "13px", color: form.color }}>{form.color}</span>
            <div style={{ width: "20px", height: "20px", borderRadius: "50%", background: form.color, boxShadow: neon(form.color, 10), marginLeft: "4px" }} />
          </div>
        </div>
        <Btn
          label={busy ? "جاري الحفظ..." : isEdit ? "💾 حفظ التعديلات" : "إضافة الفئة"}
          color={accentColor}
          onClick={handleSave}
        />
      </div>
    </div>
  );
}

// ── MediaItem type ────────────────────────────────────────────────────────────
type MediaItem = {
  type:         "image" | "video";
  url:          string;
  customHeight?: number;
  objectFit?:   "cover" | "contain" | "fill";
};

function parseMediaItems(raw: string): MediaItem[] {
  if (!raw) return [];
  const t = raw.trim();
  if (t.startsWith("[")) {
    try {
      const p = JSON.parse(t);
      if (Array.isArray(p)) return p as MediaItem[];
    } catch { /* */ }
  }
  if (t) return [{ type: "image", url: t }];
  return [];
}

const DEFAULT_HEIGHT = 190;
const FIT_OPTIONS: { value: "cover" | "contain" | "fill"; label: string }[] = [
  { value: "cover",   label: "Cover 📐 — ملء الشاشة مع قص الأطراف" },
  { value: "contain", label: "Contain 📺 — إظهار كامل مع حواف" },
  { value: "fill",    label: "Fill 🔄 — تمديد لملء الأبعاد بالكامل" },
];

function detectType(file: File): "image" | "video" {
  if (file.type.startsWith("video/")) return "video";
  return "image";
}

// ── Settings Tab (banner carousel) ───────────────────────────────────────────
function SettingsTab({ toast }: { toast: ReturnType<typeof useToast> }) {
  const [items,          setItems]          = useState<MediaItem[]>([]);
  const [saving,         setSaving]         = useState(false);
  const [uploading,      setUploading]      = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [urlInput,       setUrlInput]       = useState("");
  const [urlType,        setUrlType]        = useState<"image" | "video">("image");
  const [newHeight,      setNewHeight]      = useState<number>(DEFAULT_HEIGHT);
  const [newFit,         setNewFit]         = useState<"cover" | "contain" | "fill">("cover");
  const [previewUrl,     setPreviewUrl]     = useState<string>("");
  const [previewType,    setPreviewType]    = useState<"image" | "video">("image");
  const fileInputRef     = useRef<HTMLInputElement>(null);
  const previewVideoRef  = useRef<HTMLVideoElement>(null);

  // Load on mount
  useEffect(() => {
    api.get("/api/settings/top_banner").then(d => {
      if (d?.value) setItems(parseMediaItems(d.value));
    });
  }, []);

  // ── Persist full array ────────────────────────────────────────────────────
  const persistItems = async (next: MediaItem[], successMsg?: string) => {
    setSaving(true);
    const r = await api.patch("/api/settings/top_banner", {
      value: next.length === 0 ? "" : JSON.stringify(next),
    });
    setSaving(false);
    if (r.ok) {
      setItems(next);
      toast.show(successMsg ?? "✓ تم الحفظ — يتحدث فوراً لجميع المستخدمين");
    } else {
      toast.show(r.error ?? "فشل الحفظ", false);
    }
  };

  // ── Upload a single file ──────────────────────────────────────────────────
  const uploadFile = async (file: File) => {
    const mediaType = detectType(file);
    const isVideo   = mediaType === "video";

    // Validate
    if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) {
      toast.show("يُسمح فقط بملفات الصور أو الفيديو", false);
      return;
    }

    setUploading(true);
    setUploadProgress(10);
    try {
      const metaRes = await fetch("/api/storage/uploads/request-url", {
        method:  "POST",
        headers: admHeaders(),
        body:    JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
      });
      if (!metaRes.ok) throw new Error("فشل الحصول على رابط الرفع");
      const { uploadURL, objectPath } = await metaRes.json();
      setUploadProgress(30);

      const xhr = new XMLHttpRequest();
      xhr.upload.addEventListener("progress", ev => {
        if (ev.lengthComputable) setUploadProgress(30 + Math.round((ev.loaded / ev.total) * 60));
      });
      await new Promise<void>((resolve, reject) => {
        xhr.open("PUT", uploadURL);
        xhr.setRequestHeader("Content-Type", file.type);
        xhr.onload  = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`GCS ${xhr.status}`)));
        xhr.onerror = () => reject(new Error("فشل الاتصال بالتخزين"));
        xhr.send(file);
      });
      setUploadProgress(95);

      const servingUrl = `/api/storage${objectPath}`;
      const next = [...items, { type: mediaType, url: servingUrl, customHeight: newHeight, objectFit: newFit }];
      await persistItems(next, `✓ تم رفع ${isVideo ? "الفيديو" : "الصورة"} وإضافته للسلايدر`);
      setUploadProgress(100);
    } catch (err: any) {
      toast.show(err?.message ?? "فشل رفع الملف", false);
    } finally {
      setUploading(false);
      setTimeout(() => setUploadProgress(0), 1200);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length > 0) {
      const f = files[0];
      const objUrl = URL.createObjectURL(f);
      setPreviewUrl(objUrl);
      setPreviewType(detectType(f));
    }
    for (const f of files) await uploadFile(f);
  };

  const handleAddUrl = async () => {
    const url = urlInput.trim();
    if (!url) return;
    const next = [...items, { type: urlType, url, customHeight: newHeight, objectFit: newFit }];
    await persistItems(next, "✓ تمت إضافة الرابط للسلايدر");
    setUrlInput("");
    setPreviewUrl("");
  };

  const handleDelete = (idx: number) => {
    const next = items.filter((_, i) => i !== idx);
    persistItems(next, "✓ تم حذف العنصر");
  };

  const handleClearAll = () => persistItems([], "تم مسح جميع عناصر البنر");

  const busy = saving || uploading;

  return (
    <div style={{ maxWidth: "760px" }}>
      {/* Section title */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "20px" }}>
        <div style={{ width: "3px", height: "26px", background: C.purple, boxShadow: neon(C.purple) }} />
        <div>
          <div style={{ fontFamily: "Orbitron, sans-serif", fontSize: "12px", color: C.purple, letterSpacing: "0.14em" }}>MEDIA CAROUSEL · سلايدر البنر العلوي</div>
          <div style={{ fontFamily: "Rajdhani, sans-serif", fontSize: "12px", color: C.dim, marginTop: "2px" }}>
            أضف صوراً وفيديوهات متعددة — تتنقل تلقائياً كل 5 ثوانٍ لجميع المستخدمين
          </div>
        </div>
      </div>

      {/* ── Upload zone ── */}
      <div style={{ background: C.surf2, border: `1px solid ${C.border}`, borderRadius: "4px", padding: "18px", marginBottom: "16px" }}>
        <label style={LBL}>رفع ملفات (صور أو فيديو) من الجهاز</label>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/mp4,video/webm"
          multiple
          style={{ display: "none" }}
          onChange={handleFileChange}
        />
        <button
          onClick={() => !busy && fileInputRef.current?.click()}
          disabled={busy}
          style={{
            display: "flex", alignItems: "center", gap: "10px",
            padding: "11px 20px", width: "100%", justifyContent: "center",
            background:  uploading ? `${C.green}0a` : `${C.green}12`,
            border:      `1px solid ${uploading ? C.green : `${C.green}66`}`,
            color:       uploading ? C.green : `${C.green}cc`,
            fontFamily:  "Orbitron, sans-serif", fontSize: "10px", letterSpacing: "0.1em",
            cursor:      busy ? "wait" : "pointer", borderRadius: "3px",
            boxShadow:   uploading ? neon(C.green, 10) : "none",
            transition:  "all 0.2s",
          }}
        >
          {uploading
            ? <><span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>⟳</span> جاري الرفع...</>
            : <><span style={{ fontSize: "14px" }}>📁</span> اختر صور أو فيديوهات للإضافة</>
          }
        </button>
        {uploadProgress > 0 && (
          <div style={{ marginTop: "8px", height: "3px", background: `${C.green}18`, borderRadius: "2px", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${uploadProgress}%`, background: C.green, boxShadow: neon(C.green, 6), transition: "width 0.3s ease", borderRadius: "2px" }} />
          </div>
        )}

        {/* ── Divider ── */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px", margin: "16px 0 14px" }}>
          <div style={{ flex: 1, height: "1px", background: C.border }} />
          <span style={{ fontFamily: "Rajdhani, sans-serif", fontSize: "11px", color: C.dim }}>أو أضف رابطاً مباشراً</span>
          <div style={{ flex: 1, height: "1px", background: C.border }} />
        </div>

        {/* ── URL input row ── */}
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
          <select
            value={urlType}
            onChange={e => setUrlType(e.target.value as "image" | "video")}
            disabled={busy}
            style={{
              ...FLD, width: "110px", flexShrink: 0, cursor: "pointer",
              padding: "8px 10px",
            }}
          >
            <option value="image">🖼 صورة</option>
            <option value="video">🎬 فيديو</option>
          </select>
          <input
            style={{ ...FLD, flex: 1, minWidth: "200px" }}
            value={urlInput}
            onChange={e => {
              setUrlInput(e.target.value);
              setPreviewUrl(e.target.value.trim());
              setPreviewType(urlType);
            }}
            placeholder="https://example.com/media.jpg"
            onFocus={ff} onBlur={fb}
            onKeyDown={e => e.key === "Enter" && !busy && handleAddUrl()}
            disabled={busy}
          />
          <button
            onClick={handleAddUrl}
            disabled={busy || !urlInput.trim()}
            style={{
              padding: "9px 18px", flexShrink: 0,
              background: `${C.blue}12`, border: `1px solid ${C.blue}66`,
              color: C.blue, fontFamily: "Orbitron, sans-serif", fontSize: "10px",
              letterSpacing: "0.1em", cursor: (busy || !urlInput.trim()) ? "default" : "pointer",
              borderRadius: "3px",
            }}
          >
            + إضافة
          </button>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════
          DIMENSION CONTROLS + LIVE PREVIEW
      ══════════════════════════════════════════════════════════ */}
      <div style={{ background: C.surf2, border: `1px solid ${C.border}`, borderRadius: "4px", padding: "18px", marginBottom: "16px" }}>

        {/* Section label */}
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "16px" }}>
          <span style={{ fontFamily: "Orbitron, sans-serif", fontSize: "9px", color: C.blue, letterSpacing: "0.14em" }}>DIMENSION CONTROLS · أبعاد العرض</span>
          <div style={{ flex: 1, height: "1px", background: C.border }} />
        </div>

        {/* Height slider */}
        <div style={{ marginBottom: "14px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
            <label style={{ ...LBL, marginBottom: 0 }}>ارتفاع البانر (Height)</label>
            <span style={{
              fontFamily: "Orbitron, sans-serif", fontSize: "11px",
              color: C.blue, background: `${C.blue}12`,
              border: `1px solid ${C.blue}44`,
              padding: "2px 10px", borderRadius: "2px", letterSpacing: "0.08em",
            }}>
              {newHeight}px
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ fontFamily: "Rajdhani, sans-serif", fontSize: "10px", color: C.dim, flexShrink: 0 }}>100px</span>
            <input
              type="range"
              min={100}
              max={400}
              step={5}
              value={newHeight}
              onChange={e => setNewHeight(Number(e.target.value))}
              style={{ flex: 1, accentColor: C.blue, cursor: "pointer" }}
            />
            <span style={{ fontFamily: "Rajdhani, sans-serif", fontSize: "10px", color: C.dim, flexShrink: 0 }}>400px</span>
          </div>
        </div>

        {/* Object-fit dropdown */}
        <div style={{ marginBottom: "16px" }}>
          <label style={LBL}>طريقة ملء الميديا (Object Fit)</label>
          <select
            value={newFit}
            onChange={e => setNewFit(e.target.value as "cover" | "contain" | "fill")}
            style={{ ...FLD, width: "100%", cursor: "pointer" }}
          >
            {FIT_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        {/* ── Live Preview Box ── */}
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
            <span style={{ fontFamily: "Orbitron, sans-serif", fontSize: "9px", color: C.purple, letterSpacing: "0.14em" }}>LIVE PREVIEW · معاينة البانر</span>
            <div style={{ flex: 1, height: "1px", background: C.border }} />
            {previewUrl && (
              <button
                onClick={() => setPreviewUrl("")}
                style={{ padding: "2px 8px", background: `${C.red}10`, border: `1px solid ${C.red}33`, color: C.red, fontSize: "9px", fontFamily: "Orbitron, sans-serif", borderRadius: "2px", cursor: "pointer", letterSpacing: "0.06em" }}
              >
                ✕ إغلاق
              </button>
            )}
          </div>

          {/* The preview frame — exact dimensions and look of the real header */}
          <div style={{
            width: "100%",
            height: `${newHeight}px`,
            transition: "height 0.3s ease",
            background: "#05080f",
            border: `1px solid rgba(123,47,247,0.5)`,
            borderRadius: "4px",
            overflow: "hidden",
            position: "relative",
            boxShadow: "0 0 20px rgba(123,47,247,0.12)",
            display: "flex",
            flexDirection: "row",
          }}>
            {/* Top neon edge */}
            <div style={{
              position: "absolute", top: 0, left: 0, right: 0, height: "2px", zIndex: 3,
              background: "linear-gradient(90deg,transparent 0%,#7b2ff7 30%,#00d4ff 70%,transparent 100%)",
            }} />

            {/* Left — media area */}
            <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
              {previewUrl ? (
                <>
                  {previewType === "video" ? (
                    <video
                      ref={previewVideoRef}
                      key={previewUrl}
                      src={previewUrl}
                      autoPlay
                      muted
                      loop
                      playsInline
                      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: newFit, objectPosition: "center", display: "block" }}
                    />
                  ) : (
                    <img
                      key={previewUrl}
                      src={previewUrl}
                      alt="preview"
                      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: newFit, objectPosition: "center", display: "block" }}
                    />
                  )}
                  {/* Right-edge fade */}
                  <div style={{
                    position: "absolute", inset: 0, zIndex: 1,
                    background: "linear-gradient(to right, rgba(5,8,15,0.05) 60%, rgba(5,8,15,0.75) 100%)",
                    pointerEvents: "none",
                  }} />
                  {/* Fit label overlay */}
                  <div style={{
                    position: "absolute", top: "8px", right: "8px", zIndex: 4,
                    fontFamily: "Orbitron, sans-serif", fontSize: "8px", letterSpacing: "0.1em",
                    color: "#fff", background: "rgba(0,0,0,0.55)",
                    padding: "3px 8px", borderRadius: "2px",
                    border: `1px solid ${C.blue}44`,
                    backdropFilter: "blur(4px)",
                  }}>
                    {newFit.toUpperCase()}
                  </div>
                </>
              ) : (
                <div style={{
                  position: "absolute", inset: 0,
                  background: "radial-gradient(ellipse at 40% 50%, rgba(123,47,247,0.07) 0%, rgba(5,8,15,0) 68%)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  <div style={{
                    border: "1px dashed rgba(123,47,247,0.25)",
                    padding: "8px 20px",
                    fontFamily: "Orbitron, sans-serif", fontSize: "8px",
                    color: "rgba(123,47,247,0.35)", letterSpacing: "0.14em",
                    textAlign: "center",
                  }}>
                    اختر ملفاً أو ادخل رابطاً<br />
                    <span style={{ opacity: 0.5 }}>لتظهر المعاينة هنا</span>
                  </div>
                </div>
              )}
            </div>

            {/* Right — clock placeholder */}
            <div style={{
              width: "154px", flexShrink: 0,
              background: "rgba(5,8,15,0.92)",
              display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center", gap: "2px",
              position: "relative",
            }}>
              <div style={{
                position: "absolute", top: 0, bottom: 0, left: 0, width: "1px",
                background: "linear-gradient(180deg,transparent 0%,#7b2ff788 25%,#00d4ff88 75%,transparent 100%)",
              }} />
              <span style={{ fontFamily: "Orbitron, sans-serif", fontSize: "6px", color: "rgba(0,212,255,0.4)", letterSpacing: "0.2em" }}>SYSTEM TIME</span>
              <span style={{ fontFamily: "Orbitron, sans-serif", fontSize: "28px", fontWeight: 700, color: "#7b2ff7", textShadow: "0 0 14px rgba(123,47,247,0.8)", lineHeight: 1 }}>00:00</span>
              <span style={{ fontFamily: "Orbitron, sans-serif", fontSize: "16px", color: "#00d4ff", textShadow: "0 0 10px rgba(0,212,255,0.6)", lineHeight: 1 }}>:00</span>
            </div>

            {/* Bottom neon edge */}
            <div style={{
              position: "absolute", bottom: 0, left: 0, right: 0, height: "1px", zIndex: 3,
              background: "linear-gradient(90deg,transparent 0%,rgba(123,47,247,0.6) 40%,rgba(0,212,255,0.6) 60%,transparent 100%)",
            }} />
          </div>

          <div style={{ marginTop: "8px", display: "flex", gap: "12px", flexWrap: "wrap" }}>
            <span style={{ fontFamily: "Rajdhani, sans-serif", fontSize: "11px", color: C.dim }}>
              الارتفاع المختار: <span style={{ color: C.blue, fontFamily: "Orbitron, sans-serif", fontSize: "10px" }}>{newHeight}px</span>
            </span>
            <span style={{ fontFamily: "Rajdhani, sans-serif", fontSize: "11px", color: C.dim }}>
              طريقة الملء: <span style={{ color: C.purple, fontFamily: "Orbitron, sans-serif", fontSize: "10px" }}>{newFit.toUpperCase()}</span>
            </span>
            <span style={{ fontFamily: "Rajdhani, sans-serif", fontSize: "11px", color: `${C.green}aa` }}>
              ✓ سيُحفظ مع العنصر التالي الذي تضيفه
            </span>
          </div>
        </div>
      </div>

      {/* ── Current media items list ── */}
      <div style={{ background: C.surf2, border: `1px solid ${C.border}`, borderRadius: "4px", overflow: "hidden", marginBottom: "12px" }}>
        <div style={{ padding: "10px 14px", borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontFamily: "Orbitron, sans-serif", fontSize: "9px", color: C.dim, letterSpacing: "0.12em" }}>
            MEDIA ITEMS · {items.length} عنصر في السلايدر
          </span>
          {items.length > 0 && (
            <button
              onClick={handleClearAll}
              disabled={busy}
              style={{ padding: "4px 12px", background: `${C.red}10`, border: `1px solid ${C.red}44`, color: C.red, fontFamily: "Orbitron, sans-serif", fontSize: "8px", letterSpacing: "0.1em", cursor: busy ? "default" : "pointer", borderRadius: "3px" }}
            >
              ✕ مسح الكل
            </button>
          )}
        </div>

        {items.length === 0 ? (
          <div style={{ padding: "28px", textAlign: "center", fontFamily: "Rajdhani, sans-serif", fontSize: "13px", color: C.dim }}>
            لا توجد عناصر بعد — أضف صورة أو فيديو من الأعلى
          </div>
        ) : (
          <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: "8px" }}>
            {items.map((item, i) => (
              <div key={i} style={{
                display: "flex", alignItems: "center", gap: "10px",
                background: "#05080f", border: `1px solid ${C.border}`,
                borderRadius: "3px", padding: "8px 10px",
              }}>
                {/* Type badge */}
                <div style={{
                  flexShrink: 0, width: "56px", textAlign: "center",
                  padding: "3px 0",
                  background: item.type === "video" ? `${C.blue}18` : `${C.purple}18`,
                  border: `1px solid ${item.type === "video" ? C.blue : C.purple}55`,
                  borderRadius: "2px",
                  fontFamily: "Orbitron, sans-serif", fontSize: "8px",
                  color: item.type === "video" ? C.blue : C.purple,
                  letterSpacing: "0.08em",
                }}>
                  {item.type === "video" ? "🎬 VIDEO" : "🖼 IMAGE"}
                </div>

                {/* Thumbnail / icon */}
                <div style={{
                  width: "48px", height: "32px", flexShrink: 0,
                  background: "#0a0f1a", border: `1px solid ${C.border}`,
                  borderRadius: "2px", overflow: "hidden",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  {item.type === "image"
                    ? <img src={item.url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    : <span style={{ fontSize: "18px" }}>🎬</span>
                  }
                </div>

                {/* URL */}
                <div style={{ flex: 1, fontFamily: "Rajdhani, sans-serif", fontSize: "11px", color: C.dim, wordBreak: "break-all", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {item.url}
                </div>

                {/* Height badge */}
                {item.customHeight && (
                  <div style={{
                    flexShrink: 0, padding: "2px 7px",
                    background: `${C.blue}12`, border: `1px solid ${C.blue}44`,
                    borderRadius: "2px", fontFamily: "Orbitron, sans-serif",
                    fontSize: "8px", color: C.blue, letterSpacing: "0.06em",
                  }}>
                    {item.customHeight}px
                  </div>
                )}

                {/* ObjectFit badge */}
                {item.objectFit && (
                  <div style={{
                    flexShrink: 0, padding: "2px 7px",
                    background: `${C.purple}12`, border: `1px solid ${C.purple}44`,
                    borderRadius: "2px", fontFamily: "Orbitron, sans-serif",
                    fontSize: "8px", color: C.purple, letterSpacing: "0.06em",
                    textTransform: "uppercase",
                  }}>
                    {item.objectFit}
                  </div>
                )}

                {/* Index badge */}
                <div style={{
                  flexShrink: 0, width: "22px", height: "22px",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: `${C.purple}18`, border: `1px solid ${C.purple}44`,
                  borderRadius: "2px", fontFamily: "Orbitron, sans-serif",
                  fontSize: "9px", color: C.purple,
                }}>
                  {i + 1}
                </div>

                {/* Delete */}
                <button
                  onClick={() => handleDelete(i)}
                  disabled={busy}
                  style={{
                    flexShrink: 0, width: "26px", height: "26px",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: `${C.red}0a`, border: `1px solid ${C.red}44`,
                    color: C.red, fontSize: "12px",
                    cursor: busy ? "default" : "pointer", borderRadius: "2px",
                    transition: "all 0.15s",
                  }}
                  title="حذف"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Status bar */}
        {saving && (
          <div style={{ padding: "8px 14px", borderTop: `1px solid ${C.border}`, fontFamily: "Rajdhani, sans-serif", fontSize: "11px", color: C.green, display: "flex", alignItems: "center", gap: "6px" }}>
            <span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>⟳</span> جاري الحفظ...
          </div>
        )}
      </div>
    </div>
  );
}

// ── Drivers Tab ───────────────────────────────────────────────────────────────
interface OnlineDriver { id: number; locationId: number; driverName: string; phone: string; lat: number; lng: number; isOnline: boolean; isBusy: boolean; updatedAt: string; }

function DriversTab({ toast }: { toast: ReturnType<typeof useToast> }) {
  const [drivers, setDrivers] = useState<OnlineDriver[]>([]);
  const [loading, setLoading] = useState(true);
  const [busying, setBusying] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetch("/api/drivers-online/all", { headers: { "x-admin-password": ADMIN_PW } }).then(r => r.json());
      setDrivers(Array.isArray(d) ? d : []);
    } catch { toast.show("فشل تحميل السائقين", false); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); const iv = setInterval(load, 8000); return () => clearInterval(iv); }, [load]);

  const forceFree = async (locationId: number, name: string) => {
    setBusying(locationId);
    try {
      const r = await fetch(`/api/drivers-online/${locationId}/busy`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-admin-password": ADMIN_PW },
        body: JSON.stringify({ busy: false }),
      }).then(r => r.json());
      if (r.ok) { toast.show(`✓ تم تحرير السائق ${name}`); load(); }
      else toast.show(r.error ?? "فشل تحرير السائق", false);
    } catch { toast.show("خطأ في الاتصال", false); }
    finally { setBusying(null); }
  };

  const fmtTime = (iso: string) => {
    const d = new Date(iso);
    return `${d.toLocaleDateString("ar-IQ")} ${d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" })}`;
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "20px" }}>
        <div style={{ width: "3px", height: "26px", background: C.blue, boxShadow: neon(C.blue) }} />
        <div>
          <div style={{ fontFamily: "Orbitron, sans-serif", fontSize: "12px", color: C.blue, letterSpacing: "0.14em" }}>DRIVERS · السائقون المتصلون</div>
          <div style={{ fontSize: "11px", color: C.dim, marginTop: "2px" }}>مراقبة حالة السائقين وتحرير الانشغال العالق</div>
        </div>
        <div style={{ marginRight: "auto" }}>
          <Btn label="تحديث" color={C.blue} onClick={load} />
        </div>
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: "40px", color: C.dim }}>جاري التحميل...</div>
      ) : drivers.length === 0 ? (
        <div style={{ textAlign: "center", padding: "40px", color: C.dim, fontFamily: "Rajdhani, sans-serif" }}>
          لا يوجد سائقون مسجلون حالياً — سيظهرون هنا عند تشغيل تطبيق الوكيل
        </div>
      ) : (
        <div style={{ display: "grid", gap: "10px" }}>
          {drivers.map(dr => (
            <div key={dr.locationId} style={{
              background: C.surf2, border: `1px solid ${dr.isBusy ? C.red + "66" : dr.isOnline ? C.green + "44" : C.border}`,
              borderRadius: "4px", padding: "14px 16px", display: "flex", alignItems: "center", gap: "14px",
              boxShadow: dr.isBusy ? `0 0 12px ${C.red}22` : "none",
            }}>
              {/* Status dot */}
              <div style={{
                width: "10px", height: "10px", borderRadius: "50%", flexShrink: 0,
                background: dr.isBusy ? C.red : dr.isOnline ? C.green : "#555",
                boxShadow: dr.isBusy ? neon(C.red, 6) : dr.isOnline ? neon(C.green, 6) : "none",
              }} />
              {/* Info */}
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: "Rajdhani, sans-serif", fontWeight: 700, fontSize: "15px", color: C.text }}>{dr.driverName || `#${dr.locationId}`}</div>
                <div style={{ fontSize: "11px", color: C.dim, marginTop: "2px", display: "flex", gap: "14px", flexWrap: "wrap" }}>
                  <span>📍 locationId: {dr.locationId}</span>
                  {dr.phone && <span>📞 {dr.phone}</span>}
                  <span>🕐 {fmtTime(dr.updatedAt)}</span>
                </div>
              </div>
              {/* Status badge */}
              <div style={{
                padding: "4px 10px", borderRadius: "2px", fontSize: "11px", fontFamily: "Orbitron, sans-serif",
                letterSpacing: "0.08em",
                background: dr.isBusy ? `${C.red}15` : dr.isOnline ? `${C.green}15` : "rgba(255,255,255,0.05)",
                color: dr.isBusy ? C.red : dr.isOnline ? C.green : C.dim,
                border: `1px solid ${dr.isBusy ? C.red + "55" : dr.isOnline ? C.green + "44" : "#33333399"}`,
              }}>
                {dr.isBusy ? "🔴 في رحلة" : dr.isOnline ? "🟢 متاح" : "⚫ غير متصل"}
              </div>
              {/* Force-free button — only when busy */}
              {dr.isBusy && (
                <button
                  disabled={busying === dr.locationId}
                  onClick={() => forceFree(dr.locationId, dr.driverName)}
                  style={{
                    padding: "7px 14px", background: `${C.yellow}15`, border: `1px solid ${C.yellow}55`,
                    color: C.yellow, fontFamily: "Orbitron, sans-serif", fontSize: "9px",
                    letterSpacing: "0.08em", cursor: "pointer", borderRadius: "2px",
                    opacity: busying === dr.locationId ? 0.5 : 1,
                  }}
                >
                  {busying === dr.locationId ? "..." : "⚡ فك الانشغال"}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Taxi Ratings Tab ──────────────────────────────────────────────────────────
interface Rating { id: number; orderId: number; driverId: number; customerName: string | null; ratingStars: number; notes: string | null; createdAt: string; }

function StarsDisplay({ n, small }: { n: number; small?: boolean }) {
  const sz = small ? "13px" : "16px";
  return (
    <span style={{ display: "inline-flex", gap: "1px" }}>
      {Array.from({ length: 5 }).map((_, i) => (
        <span key={i} style={{ fontSize: sz, color: i < n ? C.yellow : "rgba(255,255,255,0.12)", filter: i < n ? `drop-shadow(0 0 4px ${C.yellow}99)` : "none" }}>★</span>
      ))}
    </span>
  );
}

function TaxiTab({ toast }: { toast: ReturnType<typeof useToast> }) {
  const [ratings, setRatings]   = useState<Rating[]>([]);
  const [drivers, setDrivers]   = useState<Record<number, string>>({});
  const [loading, setLoading]   = useState(true);
  const [starFilter, setStarFilter] = useState(0);   // 0 = all
  const [search, setSearch]     = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rData, lData] = await Promise.all([
        api.get("/api/taxi-ratings"),
        api.get("/api/locations"),
      ]);
      setRatings(Array.isArray(rData) ? rData : []);
      // Build driverId → name lookup from locations
      if (Array.isArray(lData)) {
        const map: Record<number, string> = {};
        lData.forEach((l: any) => { map[l.id] = l.name; });
        setDrivers(map);
      }
    } catch { toast.show("فشل تحميل التقييمات", false); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Computed stats ─────────────────────────────────────────────────────────
  const avg = ratings.length ? (ratings.reduce((s, r) => s + r.ratingStars, 0) / ratings.length) : 0;
  const dist = [5, 4, 3, 2, 1].map(s => ({ star: s, count: ratings.filter(r => r.ratingStars === s).length }));

  // ── Filtered rows ──────────────────────────────────────────────────────────
  const rows = ratings.filter(r => {
    if (starFilter && r.ratingStars !== starFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      const driverName = (drivers[r.driverId] ?? "").toLowerCase();
      const customerName = (r.customerName ?? "").toLowerCase();
      const notes = (r.notes ?? "").toLowerCase();
      if (!driverName.includes(q) && !customerName.includes(q) && !notes.includes(q) && !String(r.orderId).includes(q)) return false;
    }
    return true;
  });

  const fmtDate = (iso: string) => {
    const d = new Date(iso);
    return `${d.toLocaleDateString("ar-IQ")} ${d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" })}`;
  };

  return (
    <div>
      {/* ── Section header ──────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "20px" }}>
        <div style={{ width: "3px", height: "26px", background: C.yellow, boxShadow: neon(C.yellow) }} />
        <div>
          <div style={{ fontFamily: "Orbitron, sans-serif", fontSize: "12px", color: C.yellow, letterSpacing: "0.14em" }}>TAXI RATINGS · تقييمات التكسي</div>
          <div style={{ fontFamily: "Rajdhani, sans-serif", fontSize: "12px", color: C.dim, marginTop: "2px" }}>
            مراقبة أداء السائقين · رسائل وشكاوى الزبائن
          </div>
        </div>
        <button onClick={load} style={{ marginRight: "auto", padding: "6px 14px", background: `${C.blue}10`, border: `1px solid ${C.blue}44`, color: C.blue, fontFamily: "Orbitron, sans-serif", fontSize: "9px", letterSpacing: "0.1em", cursor: "pointer", borderRadius: "3px" }}>
          ↺ تحديث
        </button>
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: "60px", color: C.dim, fontFamily: "Orbitron, sans-serif", fontSize: "11px", letterSpacing: "0.1em" }}>LOADING...</div>
      ) : (
        <>
          {/* ── Stats cards ─────────────────────────────────────────────── */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "12px", marginBottom: "20px" }}>
            {/* Total */}
            <div style={{ background: C.surf2, border: `1px solid ${C.border}`, borderRadius: "4px", padding: "16px", textAlign: "center" }}>
              <div style={{ fontFamily: "Orbitron, sans-serif", fontSize: "28px", color: C.purple, textShadow: neon(C.purple) }}>{ratings.length}</div>
              <div style={{ fontFamily: "Rajdhani, sans-serif", fontSize: "12px", color: C.dim, marginTop: "4px" }}>إجمالي التقييمات</div>
            </div>
            {/* Avg */}
            <div style={{ background: C.surf2, border: `1px solid ${C.yellow}44`, borderRadius: "4px", padding: "16px", textAlign: "center" }}>
              <div style={{ fontFamily: "Orbitron, sans-serif", fontSize: "28px", color: C.yellow, textShadow: neon(C.yellow) }}>{avg.toFixed(1)}</div>
              <div style={{ display: "flex", justifyContent: "center", marginTop: "2px" }}><StarsDisplay n={Math.round(avg)} small /></div>
              <div style={{ fontFamily: "Rajdhani, sans-serif", fontSize: "12px", color: C.dim, marginTop: "4px" }}>متوسط التقييم</div>
            </div>
            {/* Distribution */}
            <div style={{ background: C.surf2, border: `1px solid ${C.border}`, borderRadius: "4px", padding: "14px", gridColumn: "span 2" }}>
              <div style={{ fontFamily: "Orbitron, sans-serif", fontSize: "9px", color: C.dim, letterSpacing: "0.12em", marginBottom: "10px" }}>توزيع النجوم</div>
              {dist.map(({ star, count }) => {
                const pct = ratings.length ? (count / ratings.length) * 100 : 0;
                return (
                  <div key={star} style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "5px", cursor: "pointer" }}
                    onClick={() => setStarFilter(starFilter === star ? 0 : star)}>
                    <span style={{ fontFamily: "Rajdhani, sans-serif", fontSize: "12px", color: starFilter === star ? C.yellow : C.dim, width: "16px", textAlign: "right" }}>{star}</span>
                    <span style={{ color: C.yellow, fontSize: "11px" }}>★</span>
                    <div style={{ flex: 1, height: "6px", background: "rgba(255,255,255,0.06)", borderRadius: "3px", overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${pct}%`, background: starFilter === star ? C.yellow : `${C.yellow}77`, borderRadius: "3px", transition: "width 0.4s ease", boxShadow: starFilter === star ? neon(C.yellow, 4) : "none" }} />
                    </div>
                    <span style={{ fontFamily: "Orbitron, sans-serif", fontSize: "10px", color: C.dim, width: "28px" }}>{count}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Filters ──────────────────────────────────────────────────── */}
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginBottom: "14px", alignItems: "center" }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="بحث بالسائق أو الزبون أو الملاحظات..."
              style={{ ...FLD, maxWidth: "300px", flex: 1 }} onFocus={ff} onBlur={fb} />
            <div style={{ display: "flex", gap: "6px" }}>
              {[0, 5, 4, 3, 2, 1].map(s => (
                <button key={s} onClick={() => setStarFilter(starFilter === s ? 0 : s)}
                  style={{ padding: "5px 10px", background: starFilter === s ? `${C.yellow}22` : `${C.surface}`, border: `1px solid ${starFilter === s ? C.yellow : C.border}`, color: starFilter === s ? C.yellow : C.dim, fontFamily: "Orbitron, sans-serif", fontSize: "9px", cursor: "pointer", borderRadius: "3px", transition: "all 0.15s", boxShadow: starFilter === s ? neon(C.yellow, 5) : "none" }}>
                  {s === 0 ? "الكل" : `${s}★`}
                </button>
              ))}
            </div>
            <span style={{ fontFamily: "Orbitron, sans-serif", fontSize: "10px", color: C.dim }}>{rows.length} سجل</span>
          </div>

          {/* ── Table ────────────────────────────────────────────────────── */}
          <div style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: "4px" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "Rajdhani, sans-serif" }}>
              <thead>
                <tr style={{ background: `${C.yellow}0a`, borderBottom: `1px solid ${C.border}` }}>
                  {["# رقم الطلب", "السائق", "التقييم", "الزبون", "الملاحظات", "التاريخ والوقت"].map(h => (
                    <th key={h} style={{ padding: "10px 14px", textAlign: "right", fontSize: "10px", color: C.yellow, fontFamily: "Orbitron, sans-serif", letterSpacing: "0.08em", whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id}
                    style={{ borderBottom: `1px solid rgba(123,47,247,0.08)` }}
                    onMouseEnter={e => (e.currentTarget.style.background = `${C.yellow}06`)}
                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>

                    {/* Order ID */}
                    <td style={{ padding: "12px 14px", whiteSpace: "nowrap" }}>
                      <span style={{ fontFamily: "Orbitron, sans-serif", fontSize: "11px", color: C.blue, textShadow: neon(C.blue, 5) }}>#{r.orderId}</span>
                    </td>

                    {/* Driver */}
                    <td style={{ padding: "12px 14px", whiteSpace: "nowrap" }}>
                      <div style={{ color: C.text, fontSize: "14px", fontWeight: 600 }}>{drivers[r.driverId] ?? `—`}</div>
                      <div style={{ color: C.dim, fontFamily: "Orbitron, sans-serif", fontSize: "9px", letterSpacing: "0.08em" }}>ID: {r.driverId}</div>
                    </td>

                    {/* Stars */}
                    <td style={{ padding: "12px 14px", whiteSpace: "nowrap" }}>
                      <StarsDisplay n={r.ratingStars} />
                      <div style={{ fontFamily: "Orbitron, sans-serif", fontSize: "10px", color: C.yellow, marginTop: "2px" }}>{r.ratingStars}/5</div>
                    </td>

                    {/* Customer */}
                    <td style={{ padding: "12px 14px" }}>
                      <span style={{ color: C.text, fontSize: "14px" }}>{r.customerName || <span style={{ color: C.dim, fontSize: "12px" }}>—</span>}</span>
                    </td>

                    {/* Notes */}
                    <td style={{ padding: "12px 14px", maxWidth: "260px" }}>
                      {r.notes
                        ? <span style={{ color: "rgba(226,232,240,0.75)", fontSize: "13px", lineHeight: 1.5, display: "block" }}>{r.notes}</span>
                        : <span style={{ color: C.dim, fontSize: "12px", fontStyle: "italic" }}>لا توجد ملاحظات</span>
                      }
                    </td>

                    {/* Date */}
                    <td style={{ padding: "12px 14px", whiteSpace: "nowrap" }}>
                      <span style={{ fontFamily: "Rajdhani, sans-serif", fontSize: "13px", color: C.dim }}>{fmtDate(r.createdAt)}</span>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ padding: "48px", textAlign: "center" }}>
                      <div style={{ fontFamily: "Orbitron, sans-serif", fontSize: "12px", color: C.dim, letterSpacing: "0.1em", marginBottom: "8px" }}>NO RATINGS YET</div>
                      <div style={{ fontFamily: "Rajdhani, sans-serif", fontSize: "14px", color: `${C.dim}88` }}>لم تُسجَّل أي تقييمات حتى الآن</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ── FuelStationsTab — إدارة محطات الوقود (Firestore CRUD) ────────────────────
// ══════════════════════════════════════════════════════════════════════════════
type QueueStatus = 'green' | 'yellow' | 'red';
interface FuelStation {
  id:           string;
  name:         string;
  address:      string;
  latitude:     number;
  longitude:    number;
  queue_status: QueueStatus;
}

const QUEUE_LABELS: Record<QueueStatus, { label: string; color: string; emoji: string }> = {
  green:  { label: 'فارغة · تعبئة سريعة', color: '#00dc64', emoji: '🟢' },
  yellow: { label: 'ازدحام خفيف',          color: '#f5c518', emoji: '🟡' },
  red:    { label: 'مزدحمة · قافلة',       color: '#ff2d50', emoji: '🔴' },
};

const EMPTY_FORM = { name: '', address: '', latitude: '', longitude: '', queue_status: 'green' as QueueStatus };

function FuelStationsTab({ toast }: { toast: ReturnType<typeof useToast> }) {
  const [stations,     setStations]     = useState<FuelStation[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [showForm,     setShowForm]     = useState(false);
  const [editing,      setEditing]      = useState<FuelStation | null>(null);
  const [form,         setForm]         = useState({ ...EMPTY_FORM });
  const [saving,       setSaving]       = useState(false);
  const [confirmDel,   setConfirmDel]   = useState<string | null>(null);

  // ── Map picker refs ──────────────────────────────────────────────────────
  const mapPickerContainerRef = useRef<HTMLDivElement | null>(null);
  const mapPickerRef          = useRef<L.Map | null>(null);
  const mapPickerMarkerRef    = useRef<L.Marker | null>(null);

  // ── Map picker: init / destroy with modal ───────────────────────────────
  useEffect(() => {
    if (!showForm) {
      // Clean up map when modal closes
      mapPickerRef.current?.remove();
      mapPickerRef.current    = null;
      mapPickerMarkerRef.current = null;
      return;
    }

    // Wait one tick for the DOM to mount the container
    const tid = setTimeout(() => {
      const container = mapPickerContainerRef.current;
      if (!container || mapPickerRef.current) return;

      // Determine initial position
      const initLat = parseFloat(form.latitude) || 33.7440;
      const initLng = parseFloat(form.longitude) || 44.6530;

      // Create map
      const map = L.map(container, {
        center: [initLat, initLng],
        zoom: 13,
        zoomControl: true,
        attributionControl: false,
      });
      mapPickerRef.current = map;

      L.tileLayer(
        'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
        { subdomains: 'abcd', maxZoom: 20 }
      ).addTo(map);

      // Custom yellow fuel-pin icon
      const pinIcon = L.divIcon({
        className: '',
        iconSize:  [34, 34],
        iconAnchor:[17, 34],
        html: `<div style="width:34px;height:34px;display:flex;align-items:center;justify-content:center;
                      background:#f5c51822;border:2px solid #f5c518;border-radius:50% 50% 50% 0;
                      transform:rotate(-45deg);box-shadow:0 0 14px #f5c51888;cursor:grab">
                 <span style="transform:rotate(45deg);font-size:16px">⛽</span>
               </div>`,
      });

      // Draggable marker
      const marker = L.marker([initLat, initLng], { draggable: true, icon: pinIcon }).addTo(map);
      mapPickerMarkerRef.current = marker;

      const applyLatLng = (lat: number, lng: number) => {
        setForm(p => ({ ...p, latitude: lat.toFixed(6), longitude: lng.toFixed(6) }));
      };

      // Update on drag end
      marker.on('dragend', () => {
        const { lat, lng } = marker.getLatLng();
        applyLatLng(lat, lng);
      });

      // Click on map → move marker
      map.on('click', (e: L.LeafletMouseEvent) => {
        marker.setLatLng(e.latlng);
        applyLatLng(e.latlng.lat, e.latlng.lng);
      });

      // Invalidate size after mount to fix tile rendering
      setTimeout(() => map.invalidateSize(), 80);
    }, 60);

    return () => clearTimeout(tid);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showForm]);

  // ── Sync marker position when lat/lng manually changed ──────────────────
  useEffect(() => {
    const map    = mapPickerRef.current;
    const marker = mapPickerMarkerRef.current;
    if (!map || !marker) return;
    const lat = parseFloat(form.latitude);
    const lng = parseFloat(form.longitude);
    if (!isNaN(lat) && !isNaN(lng)) {
      marker.setLatLng([lat, lng]);
      map.panTo([lat, lng], { animate: true, duration: 0.4 });
    }
  }, [form.latitude, form.longitude]);

  // ── Live Firestore listener ──────────────────────────────────────────────
  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, 'fuel_stations'),
      snap => {
        setStations(
          snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<FuelStation, 'id'>) }))
        );
        setLoading(false);
      },
      err => { console.error('[FuelStationsTab] Firestore error:', err); setLoading(false); }
    );
    return () => unsub();
  }, []);

  // ── Open add form ────────────────────────────────────────────────────────
  function openAdd() {
    setEditing(null);
    setForm({ ...EMPTY_FORM });
    setShowForm(true);
  }

  // ── Open edit form ───────────────────────────────────────────────────────
  function openEdit(s: FuelStation) {
    setEditing(s);
    setForm({ name: s.name, address: s.address ?? '', latitude: String(s.latitude), longitude: String(s.longitude), queue_status: s.queue_status });
    setShowForm(true);
  }

  // ── Save (add or update) ─────────────────────────────────────────────────
  async function save() {
    const lat = parseFloat(form.latitude);
    const lng = parseFloat(form.longitude);
    if (!form.name.trim())            { toast.show('اسم المحطة مطلوب', false); return; }
    if (isNaN(lat) || isNaN(lng))     { toast.show('الإحداثيات غير صحيحة', false); return; }
    if (lat < 30 || lat > 38)         { toast.show('خط العرض يجب أن يكون بين 30 و 38', false); return; }
    if (lng < 38 || lng > 50)         { toast.show('خط الطول يجب أن يكون بين 38 و 50', false); return; }

    setSaving(true);
    try {
      const payload = {
        name:         form.name.trim(),
        address:      form.address.trim(),
        latitude:     lat,
        longitude:    lng,
        queue_status: form.queue_status,
        last_updated: serverTimestamp(),
        updater_name: 'admin',
      };
      if (editing) {
        await updateDoc(doc(db, 'fuel_stations', editing.id), payload);
        toast.show('تم تحديث المحطة ✓');
      } else {
        await addDoc(collection(db, 'fuel_stations'), payload);
        toast.show('تمت إضافة المحطة ✓');
      }
      setShowForm(false);
    } catch (e: any) {
      toast.show(`فشل الحفظ: ${e?.message ?? e}`, false);
    } finally { setSaving(false); }
  }

  // ── Delete ───────────────────────────────────────────────────────────────
  async function confirmDelete(id: string) {
    try {
      await deleteDoc(doc(db, 'fuel_stations', id));
      toast.show('تم حذف المحطة');
    } catch (e: any) {
      toast.show(`فشل الحذف: ${e?.message ?? e}`, false);
    } finally { setConfirmDel(null); }
  }

  const f = (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm(p => ({ ...p, [field]: e.target.value }));

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={{ direction: 'rtl' }}>
      {/* Section header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px', flexWrap: 'wrap', gap: '10px' }}>
        <div>
          <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '11px', color: C.yellow, letterSpacing: '0.18em', marginBottom: '4px' }}>⛽ FUEL STATIONS MANAGEMENT</div>
          <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '13px', color: C.dim }}>
            جميع التغييرات تُطبَّق فوراً على خريطة الزبائن عبر Firestore
            {!loading && <span style={{ marginRight: '8px', color: C.green }}>· {stations.length} محطة مسجلة</span>}
          </div>
        </div>
        <button
          onClick={openAdd}
          style={{ padding: '10px 20px', background: `${C.yellow}18`, border: `1px solid ${C.yellow}88`, color: C.yellow, fontFamily: 'Orbitron, sans-serif', fontSize: '10px', letterSpacing: '0.1em', cursor: 'pointer', borderRadius: '3px', boxShadow: neon(C.yellow, 8), display: 'flex', alignItems: 'center', gap: '6px' }}
          onMouseEnter={e => (e.currentTarget.style.background = `${C.yellow}28`)}
          onMouseLeave={e => (e.currentTarget.style.background = `${C.yellow}18`)}
        >
          ＋ إضافة محطة جديدة
        </button>
      </div>

      {/* Add/Edit form modal */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 500, background: 'rgba(0,0,0,0.78)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}
          onClick={e => { if (e.target === e.currentTarget) setShowForm(false); }}>
          <div style={{ width: 'min(580px, 100%)', background: C.surface, border: `1px solid ${C.yellow}44`, borderRadius: '4px', boxShadow: `0 0 48px ${C.yellow}18, 0 8px 32px rgba(0,0,0,0.9)`, overflow: 'hidden', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
            {/* Modal header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: `1px solid ${C.yellow}22`, background: `${C.yellow}08` }}>
              <span style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '10px', color: C.yellow, letterSpacing: '0.15em' }}>
                {editing ? '📝 تعديل محطة وقود' : '⛽ إضافة محطة جديدة'}
              </span>
              <button onClick={() => setShowForm(false)} style={{ background: 'none', border: 'none', color: C.dim, fontSize: '18px', cursor: 'pointer', padding: '0 4px' }}>×</button>
            </div>

            {/* Form body */}
            <div style={{ padding: '18px 16px', display: 'flex', flexDirection: 'column', gap: '14px', overflowY: 'auto', flex: 1 }}>
              {/* Name */}
              <div>
                <label style={LBL}>اسم المحطة *</label>
                <input value={form.name} onChange={f('name')} onFocus={ff} onBlur={fb}
                  placeholder="مثال: محطة باقوبة المركزية"
                  style={FLD} />
              </div>

              {/* Address */}
              <div>
                <label style={LBL}>العنوان التفصيلي</label>
                <input value={form.address} onChange={f('address')} onFocus={ff} onBlur={fb}
                  placeholder="مثال: شارع المدينة، باقوبة"
                  style={FLD} />
              </div>

              {/* ── Map Picker ───────────────────────────────────────────── */}
              <div>
                <label style={{ ...LBL, marginBottom: '6px' }}>
                  📍 تحديد الموقع على الخريطة *
                  <span style={{ color: C.dim, fontFamily: 'Rajdhani, sans-serif', fontSize: '11px', marginRight: '6px', fontWeight: 400 }}>
                    — اضغط أو اسحب الـ Pin
                  </span>
                </label>

                {/* Map container */}
                <div
                  ref={mapPickerContainerRef}
                  style={{
                    width:        '100%',
                    height:       '260px',
                    borderRadius: '3px',
                    border:       `1px solid ${C.yellow}44`,
                    overflow:     'hidden',
                    background:   '#0a0d14',
                    boxShadow:    `inset 0 0 24px rgba(0,0,0,0.6), 0 0 12px ${C.yellow}18`,
                    cursor:       'crosshair',
                  }}
                />

                {/* Coordinate readout + manual fine-tune */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '8px' }}>
                  <div>
                    <label style={{ ...LBL, color: `${C.yellow}88` }}>Latitude (خط العرض)</label>
                    <input
                      value={form.latitude}
                      onChange={f('latitude')}
                      onFocus={ff} onBlur={fb}
                      type="number" step="0.000001" placeholder="33.744000"
                      style={{ ...FLD, fontFamily: 'Orbitron, monospace', fontSize: '11px', color: C.yellow, letterSpacing: '0.04em', borderColor: `${C.yellow}55` }}
                    />
                  </div>
                  <div>
                    <label style={{ ...LBL, color: `${C.yellow}88` }}>Longitude (خط الطول)</label>
                    <input
                      value={form.longitude}
                      onChange={f('longitude')}
                      onFocus={ff} onBlur={fb}
                      type="number" step="0.000001" placeholder="44.653000"
                      style={{ ...FLD, fontFamily: 'Orbitron, monospace', fontSize: '11px', color: C.yellow, letterSpacing: '0.04em', borderColor: `${C.yellow}55` }}
                    />
                  </div>
                </div>
                {!form.latitude && !form.longitude && (
                  <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '12px', color: C.red, marginTop: '4px' }}>
                    ⚠ يرجى تحديد الموقع على الخريطة
                  </div>
                )}
              </div>

              {/* Queue status */}
              <div>
                <label style={LBL}>حالة الازدحام الافتراضية</label>
                <select value={form.queue_status} onChange={f('queue_status')} onFocus={ff} onBlur={fb} style={FLD}>
                  {(Object.entries(QUEUE_LABELS) as [QueueStatus, typeof QUEUE_LABELS[QueueStatus]][]).map(([k, v]) => (
                    <option key={k} value={k}>{v.emoji} {v.label}</option>
                  ))}
                </select>
              </div>

              {/* Firestore path hint */}
              <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '8px', color: `${C.yellow}55`, letterSpacing: '0.1em', padding: '8px 10px', background: `${C.yellow}06`, border: `1px solid ${C.yellow}15`, borderRadius: '2px' }}>
                📂 Firestore: fuel_stations/{editing ? editing.id : '<auto-id>'}
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
                <button onClick={() => setShowForm(false)} style={{ padding: '8px 18px', background: 'none', border: `1px solid ${C.border}`, color: C.dim, fontFamily: 'Orbitron, sans-serif', fontSize: '9px', letterSpacing: '0.1em', cursor: 'pointer', borderRadius: '3px' }}>إلغاء</button>
                <button onClick={save} disabled={saving}
                  style={{ padding: '8px 20px', background: saving ? `${C.yellow}08` : `${C.yellow}18`, border: `1px solid ${C.yellow}88`, color: C.yellow, fontFamily: 'Orbitron, sans-serif', fontSize: '9px', letterSpacing: '0.1em', cursor: saving ? 'wait' : 'pointer', borderRadius: '3px', boxShadow: neon(C.yellow, 6), display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {saving
                    ? <><svg width="12" height="12" viewBox="0 0 28 28" fill="none" style={{ animation: 'spin 0.9s linear infinite' }}><circle cx="14" cy="14" r="10" stroke={C.yellow} strokeWidth="2.5" strokeDasharray="22 14" strokeLinecap="round"/></svg>جاري الحفظ</>
                    : (editing ? '💾 حفظ التعديلات' : '✓ إضافة المحطة')
                  }
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Stations table */}
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '60px', color: C.dim }}>
          <svg width="22" height="22" viewBox="0 0 28 28" fill="none" style={{ animation: 'spin 0.9s linear infinite' }}><circle cx="14" cy="14" r="10" stroke={C.yellow} strokeWidth="2.5" strokeDasharray="22 14" strokeLinecap="round"/></svg>
          <span style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '11px', color: C.yellow }}>جاري تحميل البيانات من Firestore...</span>
        </div>
      ) : stations.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px', color: C.dim }}>
          <div style={{ fontSize: '40px', marginBottom: '12px' }}>⛽</div>
          <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '11px', letterSpacing: '0.12em' }}>لا توجد محطات مسجلة بعد</div>
          <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '13px', marginTop: '6px' }}>اضغط "+ إضافة محطة جديدة" للبدء</div>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'Rajdhani, sans-serif' }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                {['#', 'اسم المحطة', 'العنوان', 'Latitude', 'Longitude', 'حالة الازدحام', 'إجراءات'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'Orbitron, sans-serif', fontSize: '8px', color: C.yellow, letterSpacing: '0.1em', whiteSpace: 'nowrap', background: `${C.yellow}06` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stations.map((s, idx) => {
                const qs = QUEUE_LABELS[s.queue_status] ?? QUEUE_LABELS.green;
                const isDeleting = confirmDel === s.id;
                return (
                  <tr key={s.id} style={{ borderBottom: `1px solid ${C.border}44`, background: idx % 2 === 0 ? 'transparent' : `${C.yellow}03`, transition: 'background 0.15s' }}
                    onMouseEnter={e => (e.currentTarget.style.background = `${C.yellow}07`)}
                    onMouseLeave={e => (e.currentTarget.style.background = idx % 2 === 0 ? 'transparent' : `${C.yellow}03`)}>
                    {/* # */}
                    <td style={{ padding: '10px 12px', fontFamily: 'Orbitron, sans-serif', fontSize: '9px', color: `${C.yellow}55`, whiteSpace: 'nowrap' }}>{idx + 1}</td>
                    {/* Name */}
                    <td style={{ padding: '10px 12px', color: C.text, fontWeight: 600, fontSize: '15px', minWidth: '160px' }}>{s.name}</td>
                    {/* Address */}
                    <td style={{ padding: '10px 12px', color: C.dim, fontSize: '13px', minWidth: '130px' }}>{s.address || '—'}</td>
                    {/* Lat */}
                    <td style={{ padding: '10px 12px', fontFamily: 'Orbitron, sans-serif', fontSize: '9px', color: C.blue, whiteSpace: 'nowrap' }}>{s.latitude.toFixed(4)}</td>
                    {/* Lng */}
                    <td style={{ padding: '10px 12px', fontFamily: 'Orbitron, sans-serif', fontSize: '9px', color: C.blue, whiteSpace: 'nowrap' }}>{s.longitude.toFixed(4)}</td>
                    {/* Queue status */}
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 10px', background: `${qs.color}15`, border: `1px solid ${qs.color}55`, color: qs.color, borderRadius: '3px', fontSize: '12px', fontWeight: 600 }}>
                        {qs.emoji} {qs.label}
                      </span>
                    </td>
                    {/* Actions */}
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                      {isDeleting ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '12px', color: C.red }}>تأكيد الحذف؟</span>
                          <button onClick={() => confirmDelete(s.id)}
                            style={{ padding: '4px 10px', background: `${C.red}18`, border: `1px solid ${C.red}`, color: C.red, fontFamily: 'Orbitron, sans-serif', fontSize: '8px', cursor: 'pointer', borderRadius: '2px' }}>نعم 🗑️</button>
                          <button onClick={() => setConfirmDel(null)}
                            style={{ padding: '4px 10px', background: 'none', border: `1px solid ${C.border}`, color: C.dim, fontFamily: 'Orbitron, sans-serif', fontSize: '8px', cursor: 'pointer', borderRadius: '2px' }}>لا</button>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', gap: '6px' }}>
                          <button onClick={() => openEdit(s)}
                            style={{ padding: '5px 12px', background: `${C.blue}12`, border: `1px solid ${C.blue}55`, color: C.blue, fontFamily: 'Orbitron, sans-serif', fontSize: '8px', letterSpacing: '0.08em', cursor: 'pointer', borderRadius: '2px', transition: 'background 0.15s' }}
                            onMouseEnter={e => (e.currentTarget.style.background = `${C.blue}22`)}
                            onMouseLeave={e => (e.currentTarget.style.background = `${C.blue}12`)}>
                            📝 تعديل
                          </button>
                          <button onClick={() => setConfirmDel(s.id)}
                            style={{ padding: '5px 12px', background: `${C.red}10`, border: `1px solid ${C.red}44`, color: C.red, fontFamily: 'Orbitron, sans-serif', fontSize: '8px', letterSpacing: '0.08em', cursor: 'pointer', borderRadius: '2px', transition: 'background 0.15s' }}
                            onMouseEnter={e => (e.currentTarget.style.background = `${C.red}20`)}
                            onMouseLeave={e => (e.currentTarget.style.background = `${C.red}10`)}>
                            🗑️ حذف
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Live sync badge */}
      <div style={{ marginTop: '16px', display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px', background: `${C.green}08`, border: `1px solid ${C.green}25`, borderRadius: '3px', width: 'fit-content' }}>
        <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: C.green, boxShadow: neon(C.green, 6), animation: 'spin 2s linear infinite' }} />
        <span style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '8px', color: C.green, letterSpacing: '0.15em' }}>LIVE SYNC · Firestore onSnapshot · التحديثات فورية على خريطة الزبائن</span>
      </div>
    </div>
  );
}

// ── Admin Dashboard ───────────────────────────────────────────────────────────
export function AdminDashboard() {
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<"merchants" | "map" | "categories" | "settings" | "taxi" | "drivers" | "fuel">("merchants");
  const [cats, setCats] = useState<Cat[]>([]);
  const [authChecked, setAuthChecked] = useState(false);
  const toast = useToast();

  // Verify token with backend on every mount
  useEffect(() => {
    fetch("/api/admin/verify", { headers: { "x-admin-token": getToken() } })
      .then(r => r.json())
      .then(d => {
        if (!d.ok) { clearToken(); navigate("/"); }
        else setAuthChecked(true);
      })
      .catch(() => { clearToken(); navigate("/"); });
  }, []);

  const loadCats = useCallback(async () => {
    const d = await api.get("/api/categories");
    setCats(Array.isArray(d) ? d : []);
  }, []);
  useEffect(() => { if (authChecked) loadCats(); }, [authChecked, loadCats]);

  const logout = async () => {
    await api.post("/api/admin/logout", {});
    clearToken();
    navigate("/");
  };

  if (!authChecked) return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: "40px", height: "40px", border: `2px solid ${C.purple}33`, borderTop: `2px solid ${C.purple}`, borderRadius: "50%", animation: "spin 1s linear infinite" }} />
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  const TABS = [
    { key: "merchants"  as const, en: "MERCHANTS",  ar: "التجار" },
    { key: "map"        as const, en: "MAP EDITOR",  ar: "الخريطة" },
    { key: "categories" as const, en: "CATEGORIES",  ar: "الفئات" },
    { key: "drivers"    as const, en: "DRIVERS",     ar: "🚗 السائقون" },
    { key: "taxi"       as const, en: "TAXI",        ar: "🚕 التكسي" },
    { key: "fuel"       as const, en: "FUEL",        ar: "⛽ محطات الوقود" },
    { key: "settings"   as const, en: "SETTINGS",    ar: "الإعدادات" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, direction: "rtl", fontFamily: "Rajdhani, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&family=Rajdhani:wght@400;500;600;700&display=swap');
        @keyframes spin{to{transform:rotate(360deg)}}
        *{box-sizing:border-box}
        ::-webkit-scrollbar{width:5px;height:5px}
        ::-webkit-scrollbar-track{background:#0d1117}
        ::-webkit-scrollbar-thumb{background:#7b2ff733;border-radius:3px}
        .leaflet-container{background:#0a0d14!important}
        .leaflet-control-zoom a{background:#0d1117!important;color:#7b2ff7!important;border-color:#7b2ff744!important}
        .leaflet-popup-content-wrapper{background:transparent!important;border:1px solid #7b2ff744!important;box-shadow:0 0 20px #7b2ff733!important;padding:0!important;border-radius:4px!important}
        .leaflet-popup-tip{background:#0d1117!important}
      `}</style>

      {/* Header */}
      <header style={{ position: "sticky", top: 0, zIndex: 200, background: C.surface, borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", gap: "14px", padding: "0 18px", height: "54px" }}>
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: "10px" }}>
          <div style={{ width: "7px", height: "7px", borderRadius: "50%", background: C.red, boxShadow: neon(C.red, 7) }} />
          <span style={{ fontFamily: "Orbitron, sans-serif", fontSize: "12px", color: C.purple, letterSpacing: "0.14em", textShadow: neon(C.purple, 8) }}>ADMIN PANEL</span>
          <span style={{ color: C.dim, fontFamily: "Orbitron, sans-serif", fontSize: "11px" }}>· ديالى</span>
        </div>
        <a href="/" target="_blank" style={{ fontFamily: "Orbitron, sans-serif", fontSize: "10px", color: C.blue, letterSpacing: "0.08em", textDecoration: "none", padding: "6px 12px", border: `1px solid ${C.blue}40`, borderRadius: "3px" }}>↗ الخريطة</a>
        <button onClick={logout} style={{ fontFamily: "Orbitron, sans-serif", fontSize: "10px", color: C.red, letterSpacing: "0.08em", background: `${C.red}10`, border: `1px solid ${C.red}40`, padding: "6px 14px", cursor: "pointer", borderRadius: "3px" }}>خروج</button>
      </header>

      {/* Tabs */}
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, display: "flex", overflowX: "auto", padding: "0 18px" }}>
        {TABS.map(t => {
          const active = tab === t.key;
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              style={{ padding: "14px 20px", background: "transparent", border: "none", borderBottom: active ? `2px solid ${C.purple}` : "2px solid transparent", color: active ? C.purple : C.dim, fontFamily: "Orbitron, sans-serif", fontSize: "10px", letterSpacing: "0.1em", cursor: "pointer", whiteSpace: "nowrap", textShadow: active ? neon(C.purple, 6) : "none", transition: "all 0.18s" }}>
              {t.en} <span style={{ fontFamily: "Rajdhani, sans-serif", fontSize: "12px", opacity: 0.65 }}>({t.ar})</span>
            </button>
          );
        })}
      </div>

      {/* Content */}
      <main style={{ padding: "20px", maxWidth: "1200px", margin: "0 auto" }}>
        {tab === "merchants"  && <MerchantsTab cats={cats} toast={toast} />}
        {tab === "map"        && <MapEditorTab cats={cats} toast={toast} />}
        {tab === "categories" && <CategoriesTab cats={cats} onRefresh={loadCats} toast={toast} />}
        {tab === "drivers"    && <DriversTab toast={toast} />}
        {tab === "taxi"       && <TaxiTab toast={toast} />}
        {tab === "fuel"       && <FuelStationsTab toast={toast} />}
        {tab === "settings"   && <SettingsTab toast={toast} />}
      </main>

      <Toast toast={toast.toast} />
    </div>
  );
}

// ── Admin Login (generic-looking, no admin hints) ─────────────────────────────
export function AdminLogin() {
  const [, navigate] = useLocation();
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);

  // If already authenticated, redirect directly to dashboard
  useEffect(() => {
    const token = getToken();
    if (!token) return;
    fetch("/api/admin/verify", { headers: { "x-admin-token": token } })
      .then(r => r.json())
      .then(d => { if (d.ok) navigate("/admin/dashboard"); });
  }, []);

  const handleLogin = async () => {
    if (!pw.trim() || busy) return;
    setBusy(true);
    setErr("");
    try {
      const r = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      const d = await r.json();
      if (d.ok && d.token) {
        setToken(d.token);
        navigate("/admin/dashboard");
      } else {
        setErr("كلمة المرور غير صحيحة");
        setShake(true); setTimeout(() => setShake(false), 600);
      }
    } catch {
      setErr("تعذر الاتصال بالخادم");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: "#080a0f", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;600;700&display=swap');
        @keyframes adm-shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-7px)}40%,80%{transform:translateX(7px)}}
        *{box-sizing:border-box}
      `}</style>

      <div style={{ width: "100%", maxWidth: "340px", padding: "20px", animation: shake ? "adm-shake 0.5s" : "none" }}>
        <div style={{ background: "#0d1117", border: "1px solid rgba(255,255,255,0.07)", borderRadius: "8px", padding: "32px 28px" }}>
          <div style={{ textAlign: "center", marginBottom: "28px" }}>
            <span style={{ fontSize: "30px", display: "block", marginBottom: "12px", opacity: 0.55 }}>🗺️</span>
            <div style={{ color: "rgba(226,232,240,0.6)", fontFamily: "Rajdhani, sans-serif", fontSize: "16px", fontWeight: 600 }}>خريطة ديالى</div>
            <div style={{ color: "rgba(226,232,240,0.25)", fontFamily: "Rajdhani, sans-serif", fontSize: "12px", marginTop: "4px" }}>تسجيل الدخول</div>
          </div>

          <div style={{ marginBottom: "12px" }}>
            <label style={{ display: "block", fontFamily: "Rajdhani, sans-serif", fontSize: "12px", color: "rgba(226,232,240,0.35)", marginBottom: "7px" }}>كلمة المرور</label>
            <input
              type="password" value={pw} autoFocus
              onChange={e => { setPw(e.target.value); setErr(""); }}
              onKeyDown={e => e.key === "Enter" && handleLogin()}
              placeholder="••••••••"
              style={{ width: "100%", padding: "10px 13px", background: "rgba(255,255,255,0.04)", border: `1px solid ${err ? "rgba(255,80,80,0.45)" : "rgba(255,255,255,0.09)"}`, color: "#e2e8f0", fontSize: "16px", letterSpacing: "0.22em", outline: "none", borderRadius: "5px", fontFamily: "Rajdhani, sans-serif", transition: "border-color 0.2s" }}
              onFocus={e => { if (!err) e.target.style.borderColor = "rgba(255,255,255,0.22)"; }}
              onBlur={e => { if (!err) e.target.style.borderColor = "rgba(255,255,255,0.09)"; }}
            />
          </div>

          {err && <div style={{ color: "rgba(255,90,90,0.85)", fontFamily: "Rajdhani, sans-serif", fontSize: "12px", marginBottom: "10px" }}>⚠ {err}</div>}

          <button onClick={handleLogin} disabled={busy}
            style={{ width: "100%", padding: "11px", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.11)", color: busy ? "rgba(226,232,240,0.35)" : "rgba(226,232,240,0.75)", fontFamily: "Rajdhani, sans-serif", fontSize: "14px", fontWeight: 600, cursor: busy ? "wait" : "pointer", borderRadius: "5px", letterSpacing: "0.05em", transition: "all 0.18s" }}
            onMouseEnter={e => { if (!busy) { e.currentTarget.style.background = "rgba(255,255,255,0.1)"; e.currentTarget.style.color = "#e2e8f0"; } }}
            onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; e.currentTarget.style.color = busy ? "rgba(226,232,240,0.35)" : "rgba(226,232,240,0.75)"; }}>
            {busy ? "جاري الدخول..." : "دخول"}
          </button>
        </div>
      </div>
    </div>
  );
}
