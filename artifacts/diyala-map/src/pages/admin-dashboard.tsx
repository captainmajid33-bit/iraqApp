import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  bg:       "#05080f",
  surface:  "#0d1117",
  surface2: "#13181f",
  purple:   "#7b2ff7",
  blue:     "#00d4ff",
  red:      "#ff2d78",
  yellow:   "#f5c518",
  green:    "#00f5d4",
  text:     "#e2e8f0",
  dim:      "rgba(226,232,240,0.45)",
  border:   "rgba(123,47,247,0.28)",
  borderB:  "rgba(0,212,255,0.22)",
};

const neon = (c: string, s = 14) => `0 0 ${s}px ${c}88, 0 0 ${s*2}px ${c}33`;
const pulse = { animation: "adm-pulse 2s infinite" };

// ── API helpers ───────────────────────────────────────────────────────────────
const api = {
  get: (url: string) => fetch(url).then(r => r.json()),
  post: (url: string, body: any) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json()),
  patch: (url: string, body: any) => fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json()),
  delete: (url: string) => fetch(url, { method: "DELETE" }).then(r => r.json()),
};

// ── Types ─────────────────────────────────────────────────────────────────────
interface Location { id: number; category: string; name: string; details: string; address: string; phone: string; hours: string; status: string; rating?: number | null; lat: number; lng: number; }
interface Category { id: number; slug: string; labelAr: string; labelEn: string; color: string; icon: string; }

// ── Shared field style ────────────────────────────────────────────────────────
const F: React.CSSProperties = {
  width: "100%", background: "rgba(123,47,247,0.07)", border: `1px solid ${C.border}`,
  color: C.text, fontFamily: "Rajdhani, sans-serif", fontSize: "14px",
  padding: "8px 11px", outline: "none", borderRadius: "3px", boxSizing: "border-box",
};
const FL: React.CSSProperties = { fontFamily: "Rajdhani, sans-serif", fontSize: "11px", color: C.dim, letterSpacing: "0.07em", display: "block", marginBottom: "4px" };
const fFocus = (e: any) => (e.target.style.borderColor = C.purple);
const fBlur  = (e: any) => (e.target.style.borderColor = C.border);

// ── Toast ─────────────────────────────────────────────────────────────────────
function useToast() {
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const show = (msg: string, ok = true) => { setToast({ msg, ok }); setTimeout(() => setToast(null), 3000); };
  return { toast, show };
}

function Toast({ toast }: { toast: { msg: string; ok: boolean } | null }) {
  if (!toast) return null;
  return (
    <div style={{ position: "fixed", bottom: "24px", left: "50%", transform: "translateX(-50%)", zIndex: 9999, padding: "10px 24px", background: toast.ok ? "rgba(0,245,212,0.12)" : "rgba(255,45,120,0.12)", border: `1px solid ${toast.ok ? C.green : C.red}`, color: toast.ok ? C.green : C.red, fontFamily: "Orbitron, sans-serif", fontSize: "11px", letterSpacing: "0.1em", boxShadow: neon(toast.ok ? C.green : C.red), borderRadius: "2px", whiteSpace: "nowrap" }}>
      {toast.ok ? "✓" : "✗"} {toast.msg}
    </div>
  );
}

// ── Location Form ─────────────────────────────────────────────────────────────
const EMPTY_FORM = { name: "", category: "clinic", details: "", address: "بعقوبة - ", phone: "077", hours: "9:00 ص - 5:00 م", status: "مفتوح", lat: "33.7451", lng: "44.6488", rating: "" };

function LocationForm({ initial, categories, onSave, onCancel }: { initial?: Partial<typeof EMPTY_FORM & { id: number }>; categories: Category[]; onSave: (data: any) => Promise<void>; onCancel: () => void; }) {
  const [form, setForm] = useState({ ...EMPTY_FORM, ...(initial ?? {}) });
  const [saving, setSaving] = useState(false);
  const set = (k: string) => (e: any) => setForm(f => ({ ...f, [k]: e.target.value }));

  const handleSave = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    await onSave({ ...form, lat: parseFloat(form.lat as any), lng: parseFloat(form.lng as any), rating: form.rating ? parseInt(form.rating as any) : null });
    setSaving(false);
  };

  const grid2: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" };

  return (
    <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "4px", padding: "18px", marginBottom: "18px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "10px" }}>
        <div><label style={FL}>الاسم *</label><input style={F} value={form.name} onChange={set("name")} placeholder="اسم المكان" onFocus={fFocus} onBlur={fBlur} /></div>
        <div>
          <label style={FL}>الفئة</label>
          <select style={{ ...F, cursor: "pointer" }} value={form.category} onChange={set("category")}>
            {categories.map(c => <option key={c.slug} value={c.slug}>{c.icon} {c.labelAr}</option>)}
          </select>
        </div>
      </div>
      <div style={{ marginBottom: "10px" }}><label style={FL}>التفاصيل</label><input style={F} value={form.details} onChange={set("details")} placeholder="طبيب، تخصص، مأكولات..." onFocus={fFocus} onBlur={fBlur} /></div>
      <div style={grid2}>
        <div style={{ marginBottom: "10px" }}><label style={FL}>العنوان</label><input style={F} value={form.address} onChange={set("address")} onFocus={fFocus} onBlur={fBlur} /></div>
        <div style={{ marginBottom: "10px" }}><label style={FL}>الهاتف</label><input style={F} value={form.phone} onChange={set("phone")} onFocus={fFocus} onBlur={fBlur} /></div>
      </div>
      <div style={grid2}>
        <div style={{ marginBottom: "10px" }}><label style={FL}>ساعات العمل</label><input style={F} value={form.hours} onChange={set("hours")} onFocus={fFocus} onBlur={fBlur} /></div>
        <div style={{ marginBottom: "10px" }}>
          <label style={FL}>الحالة</label>
          <select style={{ ...F, cursor: "pointer" }} value={form.status} onChange={set("status")}>
            <option value="مفتوح">مفتوح</option>
            <option value="مغلق">مغلق</option>
          </select>
        </div>
      </div>
      <div style={grid2}>
        <div style={{ marginBottom: "10px" }}><label style={FL}>خط العرض (lat)</label><input style={F} value={form.lat} onChange={set("lat")} type="number" step="0.0001" onFocus={fFocus} onBlur={fBlur} /></div>
        <div style={{ marginBottom: "10px" }}><label style={FL}>خط الطول (lng)</label><input style={F} value={form.lng} onChange={set("lng")} type="number" step="0.0001" onFocus={fFocus} onBlur={fBlur} /></div>
      </div>
      <div style={{ marginBottom: "14px" }}><label style={FL}>التقييم (1–5، للمطاعم)</label><input style={{ ...F, maxWidth: "120px" }} value={form.rating} onChange={set("rating")} type="number" min="1" max="5" onFocus={fFocus} onBlur={fBlur} /></div>
      <div style={{ display: "flex", gap: "10px" }}>
        <button onClick={handleSave} disabled={saving} style={{ padding: "9px 22px", background: `${C.purple}20`, border: `1px solid ${C.purple}`, color: C.purple, fontFamily: "Orbitron, sans-serif", fontSize: "10px", letterSpacing: "0.1em", cursor: saving ? "wait" : "pointer", borderRadius: "2px", boxShadow: saving ? "none" : neon(C.purple, 10) }}>
          {saving ? "جاري الحفظ..." : "حفظ"}
        </button>
        <button onClick={onCancel} style={{ padding: "9px 18px", background: "transparent", border: `1px solid ${C.border}`, color: C.dim, fontFamily: "Rajdhani, sans-serif", fontSize: "13px", cursor: "pointer", borderRadius: "2px" }}>إلغاء</button>
      </div>
    </div>
  );
}

// ── Merchants Tab ─────────────────────────────────────────────────────────────
function MerchantsTab({ categories, toast }: { categories: Category[]; toast: ReturnType<typeof useToast> }) {
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [filterCat, setFilterCat] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const data = await api.get("/api/locations");
    setLocations(Array.isArray(data) ? data : []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async (data: any) => {
    const res = await api.post("/api/locations", data);
    if (res.id) { toast.show("تم إضافة الموقع بنجاح"); setShowAdd(false); load(); }
    else toast.show(res.error ?? "فشل الإضافة", false);
  };

  const handleEdit = async (id: number, data: any) => {
    const res = await api.patch(`/api/locations/${id}`, data);
    if (res.id) { toast.show("تم التعديل بنجاح"); setEditId(null); load(); }
    else toast.show(res.error ?? "فشل التعديل", false);
  };

  const handleDelete = async (id: number, name: string) => {
    if (!confirm(`حذف "${name}"؟`)) return;
    await api.delete(`/api/locations/${id}`);
    toast.show("تم الحذف"); load();
  };

  const catMap = Object.fromEntries(categories.map(c => [c.slug, c]));
  const filtered = locations.filter(l =>
    (!filterCat || l.category === filterCat) &&
    (!search || l.name.includes(search) || l.address.includes(search))
  );

  return (
    <div>
      {/* Controls */}
      <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginBottom: "16px", alignItems: "center" }}>
        <button onClick={() => { setShowAdd(v => !v); setEditId(null); }}
          style={{ padding: "9px 18px", background: showAdd ? `${C.purple}30` : `${C.purple}15`, border: `1px solid ${C.purple}`, color: C.purple, fontFamily: "Orbitron, sans-serif", fontSize: "10px", letterSpacing: "0.1em", cursor: "pointer", borderRadius: "2px", boxShadow: showAdd ? neon(C.purple, 10) : "none" }}>
          {showAdd ? "✕ إلغاء" : "+ إضافة تاجر"}
        </button>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="بحث..." style={{ ...F, maxWidth: "200px", flex: "1" }} onFocus={fFocus} onBlur={fBlur} />
        <select value={filterCat} onChange={e => setFilterCat(e.target.value)} style={{ ...F, maxWidth: "180px", cursor: "pointer" }}>
          <option value="">كل الفئات</option>
          {categories.map(c => <option key={c.slug} value={c.slug}>{c.icon} {c.labelAr}</option>)}
        </select>
        <span style={{ fontFamily: "Orbitron, sans-serif", fontSize: "10px", color: C.dim, whiteSpace: "nowrap" }}>{filtered.length} سجل</span>
      </div>

      {showAdd && <LocationForm categories={categories} onSave={handleAdd} onCancel={() => setShowAdd(false)} />}

      {loading ? (
        <div style={{ textAlign: "center", padding: "40px", color: C.dim, fontFamily: "Orbitron, sans-serif", fontSize: "11px" }}>LOADING...</div>
      ) : (
        <div style={{ overflowX: "auto", borderRadius: "4px", border: `1px solid ${C.border}` }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "Rajdhani, sans-serif" }}>
            <thead>
              <tr style={{ background: `${C.purple}12`, borderBottom: `1px solid ${C.border}` }}>
                {["#", "الاسم", "الفئة", "الحالة", "الموقع", "الإجراءات"].map(h => (
                  <th key={h} style={{ padding: "10px 12px", textAlign: "right", fontSize: "11px", color: C.blue, fontFamily: "Orbitron, sans-serif", letterSpacing: "0.08em", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((loc, i) => {
                const cat = catMap[loc.category];
                return editId === loc.id ? (
                  <tr key={loc.id}>
                    <td colSpan={6} style={{ padding: "12px", background: C.surface2 }}>
                      <LocationForm
                        categories={categories}
                        initial={{ ...loc, lat: String(loc.lat), lng: String(loc.lng), rating: loc.rating ? String(loc.rating) : "" }}
                        onSave={d => handleEdit(loc.id, d)}
                        onCancel={() => setEditId(null)}
                      />
                    </td>
                  </tr>
                ) : (
                  <tr key={loc.id} style={{ borderBottom: `1px solid rgba(123,47,247,0.1)`, transition: "background 0.15s" }}
                    onMouseEnter={e => (e.currentTarget.style.background = `${C.purple}08`)}
                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
                    <td style={{ padding: "10px 12px", color: C.dim, fontSize: "12px" }}>{i + 1}</td>
                    <td style={{ padding: "10px 12px", color: C.text, fontSize: "14px", fontWeight: "600", maxWidth: "180px" }}>
                      <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{loc.name}</div>
                      {loc.details && <div style={{ fontSize: "11px", color: C.dim, marginTop: "2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{loc.details}</div>}
                    </td>
                    <td style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", padding: "3px 8px", background: `${cat?.color ?? C.purple}18`, border: `1px solid ${cat?.color ?? C.purple}44`, color: cat?.color ?? C.purple, fontSize: "12px", borderRadius: "2px" }}>
                        {cat?.icon} {cat?.labelAr ?? loc.category}
                      </span>
                    </td>
                    <td style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>
                      <span style={{ color: loc.status === "مفتوح" ? C.green : C.red, fontSize: "13px" }}>● {loc.status}</span>
                    </td>
                    <td style={{ padding: "10px 12px", fontFamily: "Orbitron, monospace", fontSize: "11px", color: C.dim, whiteSpace: "nowrap" }}>
                      {loc.lat.toFixed(4)}, {loc.lng.toFixed(4)}
                    </td>
                    <td style={{ padding: "10px 12px", whiteSpace: "nowrap" }}>
                      <div style={{ display: "flex", gap: "6px" }}>
                        <button onClick={() => { setEditId(loc.id); setShowAdd(false); }}
                          style={{ padding: "5px 12px", background: `${C.blue}15`, border: `1px solid ${C.blue}55`, color: C.blue, fontSize: "12px", cursor: "pointer", borderRadius: "2px", fontFamily: "Rajdhani, sans-serif" }}>تعديل</button>
                        <button onClick={() => handleDelete(loc.id, loc.name)}
                          style={{ padding: "5px 12px", background: `${C.red}15`, border: `1px solid ${C.red}55`, color: C.red, fontSize: "12px", cursor: "pointer", borderRadius: "2px", fontFamily: "Rajdhani, sans-serif" }}>حذف</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filtered.length === 0 && <div style={{ textAlign: "center", padding: "32px", color: C.dim, fontFamily: "Rajdhani, sans-serif", fontSize: "14px" }}>لا توجد نتائج</div>}
        </div>
      )}
    </div>
  );
}

// ── Map Editor Tab ────────────────────────────────────────────────────────────
function MapEditorTab({ categories, toast }: { categories: Category[]; toast: ReturnType<typeof useToast> }) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Map<number, L.Marker>>(new Map());
  const [filterCat, setFilterCat] = useState("");
  const [locations, setLocations] = useState<Location[]>([]);
  const [saving, setSaving] = useState<number | null>(null);

  const catMap = Object.fromEntries(categories.map(c => [c.slug, c]));

  const load = useCallback(async () => {
    const data = await api.get("/api/locations");
    setLocations(Array.isArray(data) ? data : []);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Init map once
  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;
    const style = document.createElement("style");
    style.textContent = `@keyframes adm-pulse{75%,100%{transform:scale(2.2);opacity:0}} .leaflet-container{background:#0a0d14!important} .leaflet-control-zoom a{background:#0d1117!important;color:#7b2ff7!important;border-color:#7b2ff7!important}`;
    document.head.appendChild(style);
    mapRef.current = L.map(mapContainer.current, { center: [33.7451, 44.6488], zoom: 13 });
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { subdomains: "abcd", maxZoom: 20 }).addTo(mapRef.current);
    return () => { mapRef.current?.remove(); mapRef.current = null; style.remove(); };
  }, []);

  // Sync markers when locations or filter changes
  useEffect(() => {
    if (!mapRef.current) return;
    markersRef.current.forEach(m => m.remove());
    markersRef.current.clear();

    const visible = filterCat ? locations.filter(l => l.category === filterCat) : locations;

    visible.forEach(loc => {
      const cat = catMap[loc.category];
      const color = cat?.color ?? "#7b2ff7";
      const icon = L.divIcon({
        className: "",
        html: `<div style="width:32px;height:32px;position:relative;display:flex;align-items:center;justify-content:center;">
          <div style="position:absolute;inset:0;border-radius:50%;background:${color};opacity:0.15;animation:adm-pulse 2s infinite"></div>
          <div style="position:absolute;inset:0;border-radius:50%;border:2px solid ${color};box-shadow:0 0 10px ${color}88"></div>
          <span style="font-size:13px">${cat?.icon ?? "📍"}</span>
        </div>`,
        iconSize: [32, 32], iconAnchor: [16, 16],
      });

      const marker = L.marker([loc.lat, loc.lng], { icon, draggable: true }).addTo(mapRef.current!);

      const popup = L.popup({ offset: [0, -8], closeButton: false }).setContent(
        `<div style="background:#0d1117;padding:10px 13px;direction:rtl;min-width:160px;font-family:Rajdhani,sans-serif">
          <div style="color:${color};font-size:13px;font-weight:700;margin-bottom:3px">${loc.name}</div>
          <div style="color:#aaa;font-size:11px">${loc.category}</div>
          <div style="color:#f5c518;font-size:11px;margin-top:4px;font-family:monospace">${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}</div>
          <div style="color:#7b2ff7;font-size:10px;margin-top:4px">↕ اسحب لتغيير الموقع</div>
        </div>`
      );
      marker.bindPopup(popup);
      marker.on("click", () => marker.openPopup());

      marker.on("dragend", async () => {
        const latlng = marker.getLatLng();
        setSaving(loc.id);
        try {
          await api.patch(`/api/locations/${loc.id}`, { lat: latlng.lat, lng: latlng.lng });
          toast.show(`✓ ${loc.name} — تم حفظ الموقع`);
          // Update popup content
          marker.getPopup()?.setContent(
            `<div style="background:#0d1117;padding:10px 13px;direction:rtl;min-width:160px;font-family:Rajdhani,sans-serif">
              <div style="color:${color};font-size:13px;font-weight:700;margin-bottom:3px">${loc.name}</div>
              <div style="color:#aaa;font-size:11px">${loc.category}</div>
              <div style="color:#00f5d4;font-size:11px;margin-top:4px;font-family:monospace">${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}</div>
              <div style="color:#00f5d4;font-size:10px;margin-top:2px">✓ تم الحفظ</div>
            </div>`
          );
        } catch {
          toast.show("فشل حفظ الموقع", false);
        } finally {
          setSaving(null);
        }
      });

      markersRef.current.set(loc.id, marker);
    });
  }, [locations, filterCat, catMap]);

  return (
    <div>
      <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginBottom: "12px", alignItems: "center" }}>
        <select value={filterCat} onChange={e => setFilterCat(e.target.value)} style={{ ...F, maxWidth: "200px", cursor: "pointer" }}>
          <option value="">كل الفئات</option>
          {categories.map(c => <option key={c.slug} value={c.slug}>{c.icon} {c.labelAr}</option>)}
        </select>
        <div style={{ fontFamily: "Rajdhani, sans-serif", fontSize: "13px", color: C.dim }}>
          ↕ اسحب أي أيقونة لتحديث موقعها — يُحفظ تلقائياً
        </div>
        {saving !== null && (
          <div style={{ fontFamily: "Orbitron, sans-serif", fontSize: "10px", color: C.yellow }}>⟳ جاري الحفظ...</div>
        )}
      </div>
      <div ref={mapContainer} style={{ height: "500px", borderRadius: "4px", border: `1px solid ${C.border}`, overflow: "hidden" }} />
    </div>
  );
}

// ── Categories Tab ────────────────────────────────────────────────────────────
function CategoriesTab({ categories, onRefresh, toast }: { categories: Category[]; onRefresh: () => void; toast: ReturnType<typeof useToast> }) {
  const [form, setForm] = useState({ slug: "", labelAr: "", labelEn: "", color: "#7b2ff7", icon: "📍" });
  const [saving, setSaving] = useState(false);
  const set = (k: string) => (e: any) => setForm(f => ({ ...f, [k]: e.target.value }));

  const handleAdd = async () => {
    if (!form.slug.trim() || !form.labelAr.trim()) return;
    setSaving(true);
    const res = await api.post("/api/categories", form);
    setSaving(false);
    if (res.id) { toast.show("تمت إضافة الفئة"); setForm({ slug: "", labelAr: "", labelEn: "", color: "#7b2ff7", icon: "📍" }); onRefresh(); }
    else toast.show(res.error ?? "فشل الإضافة", false);
  };

  const handleDelete = async (id: number, label: string) => {
    if (!confirm(`حذف فئة "${label}"؟`)) return;
    await api.delete(`/api/categories/${id}`);
    toast.show("تم حذف الفئة"); onRefresh();
  };

  return (
    <div>
      {/* Existing categories */}
      <div style={{ marginBottom: "24px" }}>
        <div style={{ fontFamily: "Orbitron, sans-serif", fontSize: "10px", color: C.blue, letterSpacing: "0.12em", marginBottom: "12px" }}>الفئات الحالية</div>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {categories.map(cat => (
            <div key={cat.id} style={{ display: "flex", alignItems: "center", gap: "12px", padding: "12px 16px", background: C.surface2, border: `1px solid ${cat.color}33`, borderRadius: "4px" }}>
              <span style={{ fontSize: "22px" }}>{cat.icon}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: "Rajdhani, sans-serif", fontSize: "15px", color: C.text, fontWeight: "600" }}>{cat.labelAr}</div>
                <div style={{ fontFamily: "Orbitron, sans-serif", fontSize: "10px", color: C.dim, letterSpacing: "0.08em" }}>{cat.slug} · {cat.labelEn}</div>
              </div>
              <div style={{ width: "18px", height: "18px", borderRadius: "50%", background: cat.color, boxShadow: neon(cat.color, 8), flexShrink: 0 }} />
              <button onClick={() => handleDelete(cat.id, cat.labelAr)}
                style={{ padding: "5px 12px", background: `${C.red}12`, border: `1px solid ${C.red}44`, color: C.red, fontSize: "12px", cursor: "pointer", borderRadius: "2px", fontFamily: "Rajdhani, sans-serif", whiteSpace: "nowrap" }}>
                حذف
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Add new category */}
      <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: "4px", padding: "18px" }}>
        <div style={{ fontFamily: "Orbitron, sans-serif", fontSize: "10px", color: C.purple, letterSpacing: "0.12em", marginBottom: "14px" }}>+ إضافة فئة جديدة</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "10px" }}>
          <div><label style={FL}>المعرّف (slug) *</label><input style={F} value={form.slug} onChange={set("slug")} placeholder="taxi" onFocus={fFocus} onBlur={fBlur} /></div>
          <div><label style={FL}>الاسم بالعربي *</label><input style={F} value={form.labelAr} onChange={set("labelAr")} placeholder="تكسي" onFocus={fFocus} onBlur={fBlur} /></div>
          <div><label style={FL}>الاسم بالإنجليزي</label><input style={F} value={form.labelEn} onChange={set("labelEn")} placeholder="Taxi" onFocus={fFocus} onBlur={fBlur} /></div>
          <div><label style={FL}>الأيقونة (emoji)</label><input style={F} value={form.icon} onChange={set("icon")} placeholder="🚕" onFocus={fFocus} onBlur={fBlur} /></div>
        </div>
        <div style={{ marginBottom: "14px" }}>
          <label style={FL}>اللون</label>
          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            <input type="color" value={form.color} onChange={set("color")} style={{ width: "44px", height: "36px", padding: "2px", background: "transparent", border: `1px solid ${C.border}`, cursor: "pointer", borderRadius: "3px" }} />
            <span style={{ fontFamily: "Orbitron, monospace", fontSize: "12px", color: form.color }}>{form.color}</span>
          </div>
        </div>
        <button onClick={handleAdd} disabled={saving}
          style={{ padding: "9px 22px", background: `${C.purple}20`, border: `1px solid ${C.purple}`, color: C.purple, fontFamily: "Orbitron, sans-serif", fontSize: "10px", letterSpacing: "0.1em", cursor: saving ? "wait" : "pointer", borderRadius: "2px", boxShadow: saving ? "none" : neon(C.purple, 10) }}>
          {saving ? "جاري الحفظ..." : "إضافة فئة"}
        </button>
      </div>
    </div>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────
export function AdminDashboard() {
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<"merchants" | "map" | "categories">("merchants");
  const [categories, setCategories] = useState<Category[]>([]);
  const toast = useToast();

  const isAuth = sessionStorage.getItem("admin_auth") === "Admin2026";
  useEffect(() => { if (!isAuth) navigate("/admin"); }, [isAuth]);

  const loadCats = useCallback(async () => {
    const data = await api.get("/api/categories");
    setCategories(Array.isArray(data) ? data : []);
  }, []);

  useEffect(() => { loadCats(); }, [loadCats]);

  const logout = () => { sessionStorage.removeItem("admin_auth"); navigate("/admin"); };

  const tabs: { key: typeof tab; ar: string; en: string }[] = [
    { key: "merchants",  ar: "التجار",  en: "MERCHANTS" },
    { key: "map",        ar: "الخريطة", en: "MAP EDITOR" },
    { key: "categories", ar: "الفئات",  en: "CATEGORIES" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, direction: "rtl", fontFamily: "Rajdhani, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&family=Rajdhani:wght@400;500;600;700&display=swap');
        @keyframes adm-pulse{75%,100%{transform:scale(2.2);opacity:0}}
        @keyframes adm-spin{to{transform:rotate(360deg)}}
        * { box-sizing: border-box; }
        ::-webkit-scrollbar{width:6px;height:6px} ::-webkit-scrollbar-track{background:#0d1117} ::-webkit-scrollbar-thumb{background:#7b2ff733;border-radius:3px}
      `}</style>

      {/* Header */}
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: "0 20px", display: "flex", alignItems: "center", gap: "16px", height: "56px", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flex: 1 }}>
          <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: C.red, boxShadow: neon(C.red, 8), ...pulse }} />
          <span style={{ fontFamily: "Orbitron, sans-serif", fontSize: "12px", color: C.purple, letterSpacing: "0.15em", textShadow: neon(C.purple, 8) }}>ADMIN CONTROL</span>
          <span style={{ fontFamily: "Orbitron, sans-serif", fontSize: "12px", color: C.dim }}>· ديالى</span>
        </div>
        <a href="/" target="_blank" style={{ fontFamily: "Orbitron, sans-serif", fontSize: "10px", color: C.blue, letterSpacing: "0.08em", textDecoration: "none", padding: "6px 12px", border: `1px solid ${C.blue}44`, borderRadius: "2px" }}>↗ الخريطة</a>
        <button onClick={logout} style={{ fontFamily: "Orbitron, sans-serif", fontSize: "10px", color: C.red, letterSpacing: "0.08em", background: `${C.red}10`, border: `1px solid ${C.red}44`, padding: "6px 12px", cursor: "pointer", borderRadius: "2px" }}>خروج</button>
      </div>

      {/* Tabs */}
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: "0 20px", display: "flex", gap: "0", overflowX: "auto" }}>
        {tabs.map(t => {
          const active = tab === t.key;
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              style={{ padding: "14px 22px", background: "transparent", border: "none", borderBottom: active ? `2px solid ${C.purple}` : "2px solid transparent", color: active ? C.purple : C.dim, fontFamily: "Orbitron, sans-serif", fontSize: "10px", letterSpacing: "0.1em", cursor: "pointer", transition: "all 0.2s", whiteSpace: "nowrap", textShadow: active ? neon(C.purple, 6) : "none" }}>
              {t.en} <span style={{ fontFamily: "Rajdhani, sans-serif", fontSize: "12px", opacity: 0.7 }}>({t.ar})</span>
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div style={{ padding: "20px", maxWidth: "1200px", margin: "0 auto" }}>
        {tab === "merchants"  && <MerchantsTab categories={categories} toast={toast} />}
        {tab === "map"        && <MapEditorTab categories={categories} toast={toast} />}
        {tab === "categories" && <CategoriesTab categories={categories} onRefresh={loadCats} toast={toast} />}
      </div>

      <Toast toast={toast.toast} />
    </div>
  );
}

// ── Login Page ────────────────────────────────────────────────────────────────
export function AdminLogin() {
  const [, navigate] = useLocation();
  const [code, setCode] = useState("");
  const [error, setError] = useState(false);
  const [shake, setShake] = useState(false);

  useEffect(() => {
    if (sessionStorage.getItem("admin_auth") === "Admin2026") navigate("/admin/dashboard");
  }, []);

  const handleLogin = () => {
    if (code === "Admin2026") {
      sessionStorage.setItem("admin_auth", "Admin2026");
      navigate("/admin/dashboard");
    } else {
      setError(true); setShake(true);
      setTimeout(() => setShake(false), 600);
      setTimeout(() => setError(false), 2000);
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Rajdhani, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&family=Rajdhani:wght@400;600;700&display=swap');
        @keyframes adm-pulse{75%,100%{transform:scale(2.5);opacity:0}}
        @keyframes adm-shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-8px)}40%,80%{transform:translateX(8px)}}
        @keyframes adm-glow{0%,100%{box-shadow:0 0 20px #7b2ff744}50%{box-shadow:0 0 40px #7b2ff788,0 0 80px #7b2ff733}}
        * { box-sizing: border-box; }
      `}</style>

      <div style={{ width: "100%", maxWidth: "380px", padding: "20px", animation: shake ? "adm-shake 0.5s" : "none" }}>
        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: "36px" }}>
          <div style={{ position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "center", width: "72px", height: "72px", marginBottom: "16px" }}>
            <div style={{ position: "absolute", inset: 0, borderRadius: "50%", background: C.purple, opacity: 0.15, animation: "adm-pulse 2.5s infinite" }} />
            <div style={{ position: "absolute", inset: 0, borderRadius: "50%", border: `2px solid ${C.purple}`, animation: "adm-glow 3s infinite" }} />
            <span style={{ fontSize: "28px" }}>🛡️</span>
          </div>
          <div style={{ fontFamily: "Orbitron, sans-serif", fontSize: "14px", color: C.purple, letterSpacing: "0.2em", textShadow: neon(C.purple) }}>ADMIN CONTROL</div>
          <div style={{ fontFamily: "Orbitron, sans-serif", fontSize: "10px", color: C.dim, letterSpacing: "0.15em", marginTop: "4px" }}>ديالى بالذكاء الاصطناعي</div>
        </div>

        {/* Card */}
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: "4px", padding: "28px", boxShadow: `0 0 40px ${C.purple}22` }}>
          <label style={{ ...FL, fontSize: "12px", marginBottom: "8px" }}>رمز الدخول السري</label>
          <input
            type="password" value={code}
            onChange={e => setCode(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleLogin()}
            placeholder="••••••••••"
            autoFocus
            style={{ ...F, fontSize: "18px", letterSpacing: "0.3em", marginBottom: "16px", borderColor: error ? C.red : C.border, boxShadow: error ? neon(C.red, 8) : "none" }}
            onFocus={e => (e.target.style.borderColor = error ? C.red : C.purple)}
            onBlur={e => (e.target.style.borderColor = error ? C.red : C.border)}
          />
          {error && <div style={{ color: C.red, fontSize: "13px", marginBottom: "12px", fontFamily: "Rajdhani, sans-serif" }}>✗ رمز دخول خاطئ</div>}
          <button onClick={handleLogin} style={{ width: "100%", padding: "13px", background: `${C.purple}20`, border: `1px solid ${C.purple}`, color: C.purple, fontFamily: "Orbitron, sans-serif", fontSize: "11px", letterSpacing: "0.12em", cursor: "pointer", borderRadius: "2px", boxShadow: neon(C.purple, 10), transition: "all 0.2s" }}
            onMouseEnter={e => ((e.target as any).style.background = `${C.purple}35`)}
            onMouseLeave={e => ((e.target as any).style.background = `${C.purple}20`)}>
            دخول ← ENTER
          </button>
        </div>

        <div style={{ textAlign: "center", marginTop: "20px" }}>
          <a href="/" style={{ fontFamily: "Orbitron, sans-serif", fontSize: "10px", color: C.dim, letterSpacing: "0.08em", textDecoration: "none" }}>← الخريطة الرئيسية</a>
        </div>
      </div>
    </div>
  );
}
