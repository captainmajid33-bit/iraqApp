import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  collection, onSnapshot, addDoc, updateDoc, deleteDoc,
  doc, serverTimestamp, writeBatch, Timestamp, query, orderBy, setDoc,
  where, getDocs, getDoc,
} from "firebase/firestore";
import {
  RecaptchaVerifier, signInWithPhoneNumber, onAuthStateChanged, signOut,
  type ConfirmationResult,
} from "firebase/auth";
import { auth, db, storage } from "@/lib/firebase";
import { ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";

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
interface Loc { id: number; category: string; name: string; details: string; address: string; phone: string; hours: string; status: string; rating?: number | null; lat: number; lng: number; icon_url?: string | null; }
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
const BLANK = { name: "", category: "clinic", details: "", address: "بعقوبة - ", phone: "077", password: "", firebaseUid: "", hours: "9:00 ص - 5:00 م", status: "مفتوح", lat: "33.7451", lng: "44.6488", rating: "" };
type FormState = typeof BLANK;

function LocForm({ init, cats, onSave, onCancel }: { init?: Partial<FormState & { id: number; icon_url?: string | null }>; cats: Cat[]; onSave: (d: any) => Promise<void>; onCancel: () => void }) {
  const [f, setF] = useState<FormState>({ ...BLANK, ...(init ?? {}) });
  const [busy, setBusy] = useState(false);
  // Icon upload state
  const [iconFile, setIconFile]       = useState<File | null>(null);
  const [iconPreview, setIconPreview] = useState<string>(init?.icon_url ?? "");
  const [iconUploading, setIconUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const s = (k: keyof FormState) => (e: any) => setF(p => ({ ...p, [k]: e.target.value }));

  const handleIconPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== "image/png") { alert("يُسمح فقط بملفات PNG الشفافة."); return; }
    setIconFile(file);
    setIconPreview(URL.createObjectURL(file));
  };

  const save = async () => {
    if (!f.name.trim()) return;
    setBusy(true);
    let icon_url: string | undefined = init?.icon_url ?? undefined;

    // Upload new PNG to Firebase Storage if one was selected
    if (iconFile) {
      setIconUploading(true);
      try {
        const fileName = `${Date.now()}_${iconFile.name.replace(/\s+/g, "_")}`;
        const sRef = storageRef(storage, `category_icons/${fileName}`);
        await uploadBytes(sRef, iconFile, { contentType: "image/png" });
        icon_url = await getDownloadURL(sRef);
      } catch (err) {
        console.error("[LocForm] icon upload failed:", err);
        alert("فشل رفع الأيقونة. تحقق من صلاحيات Firebase Storage.");
        setIconUploading(false);
        setBusy(false);
        return;
      }
      setIconUploading(false);
    }

    await onSave({
      ...f,
      lat: parseFloat(f.lat as any),
      lng: parseFloat(f.lng as any),
      rating: f.rating ? parseInt(f.rating as any) : null,
      ...(icon_url !== undefined ? { icon_url } : {}),
    });
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
      <div style={{ marginBottom: "10px" }}>
        <label style={LBL}>الرمز السري (password) — لتسجيل دخول تطبيق التاجر 🔑</label>
        <input
          style={{ ...FLD, fontFamily: "monospace", letterSpacing: "0.08em" }}
          type="text"
          value={f.password}
          onChange={s("password")}
          placeholder="مثال: 1234 أو أي رمز نصي"
          onFocus={ff}
          onBlur={fb}
          autoComplete="off"
        />
      </div>
      <div style={{ marginBottom: "10px" }}>
        <label style={LBL}>
          Firebase UID الخاص بالطبيب/التاجر 🔥
          <span style={{ color: C.yellow, marginRight: "6px", fontSize: "10px" }}>
            — مطلوب لربط حجوزات الزبائن بتطبيق التاجر
          </span>
        </label>
        <input
          style={{ ...FLD, fontFamily: "monospace", fontSize: "12px", letterSpacing: "0.04em" }}
          type="text"
          value={f.firebaseUid}
          onChange={s("firebaseUid")}
          placeholder="مثال: aBcDeFgH1234567890XYZ"
          onFocus={ff}
          onBlur={fb}
          autoComplete="off"
          dir="ltr"
        />
        <div style={{ fontFamily: "Rajdhani, sans-serif", fontSize: "10px", color: C.dim, marginTop: "4px" }}>
          الـ UID يظهر في Firebase Console → Authentication → Users، أو يرسله لك التاجر من تطبيقه.
        </div>
      </div>
      <div style={{ ...g2, marginBottom: "10px" }}>{row("ساعات العمل", "hours")}
        <div><label style={LBL}>الحالة</label>
          <select style={{ ...FLD, cursor: "pointer" }} value={f.status} onChange={s("status")}>
            <option value="مفتوح">مفتوح</option><option value="مغلق">مغلق</option>
          </select>
        </div>
      </div>
      <div style={{ ...g2, marginBottom: "10px" }}>{row("خط العرض (lat)", "lat")} {row("خط الطول (lng)", "lng")}</div>
      <div style={{ marginBottom: "14px" }}><label style={LBL}>التقييم (1–5)</label><input style={{ ...FLD, maxWidth: "110px" }} type="number" min="1" max="5" value={f.rating} onChange={s("rating")} onFocus={ff} onBlur={fb} /></div>

      {/* ── Custom PNG Icon Upload ──────────────────────────────────────── */}
      <div style={{ marginBottom: "16px" }}>
        <label style={LBL}>أيقونة الفئة المخصصة (PNG شفاف)</label>
        <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
          {/* Upload button */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            style={{
              display: "flex", alignItems: "center", gap: "8px",
              padding: "9px 16px",
              background: "rgba(0,212,255,0.08)",
              border: `1px solid ${C.blue}66`,
              color: C.blue,
              fontFamily: "Orbitron, sans-serif", fontSize: "10px", letterSpacing: "0.08em",
              cursor: "pointer", borderRadius: "3px",
              boxShadow: neon(C.blue, 6), transition: "background 0.2s",
            }}
            onMouseEnter={e => (e.currentTarget.style.background = "rgba(0,212,255,0.16)")}
            onMouseLeave={e => (e.currentTarget.style.background = "rgba(0,212,255,0.08)")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M12 16V8M12 8L9 11M12 8L15 11" stroke={C.blue} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              <rect x="3" y="18" width="18" height="2" rx="1" fill={C.blue} opacity="0.5"/>
            </svg>
            رفع أيقونة PNG
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png"
            style={{ display: "none" }}
            onChange={handleIconPick}
          />

          {/* Preview box */}
          <div style={{
            width: "64px", height: "64px",
            background: "rgba(255,255,255,0.04)",
            border: `1px dashed ${iconPreview ? C.green : C.border}`,
            borderRadius: "6px",
            display: "flex", alignItems: "center", justifyContent: "center",
            overflow: "hidden", flexShrink: 0,
            boxShadow: iconPreview ? neon(C.green, 6) : "none",
            transition: "border-color 0.3s, box-shadow 0.3s",
          }}>
            {iconPreview
              ? <img src={iconPreview} alt="icon preview" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
              : <span style={{ fontSize: "20px", opacity: 0.3 }}>📌</span>
            }
          </div>

          {/* Status text */}
          <div style={{ fontFamily: "Rajdhani, sans-serif", fontSize: "12px", color: C.dim, direction: "rtl" }}>
            {iconUploading
              ? <span style={{ color: C.yellow }}>⏳ جاري الرفع...</span>
              : iconFile
                ? <span style={{ color: C.green }}>✓ {iconFile.name}</span>
                : iconPreview
                  ? <span style={{ color: C.dim }}>أيقونة محفوظة — اختر ملفاً جديداً للتغيير</span>
                  : <span>لم يتم اختيار أيقونة بعد</span>
            }
          </div>
        </div>
      </div>
      {/* ─────────────────────────────────────────────────────────────────── */}

      <div style={{ display: "flex", gap: "10px" }}>
        <Btn label={busy ? (iconUploading ? "جاري رفع الأيقونة..." : "جاري الحفظ...") : "حفظ"} color={C.purple} onClick={save} />
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

  // ── Write merchant login doc to Firestore after PostgreSQL save ─────────
  const syncMerchantDoc = async (
    id: number,
    d: { phone?: string; password?: string; category?: string; name?: string; firebaseUid?: string },
    overwritePassword: boolean,
  ) => {
    const payload: Record<string, string> = {
      phone:    String(d.phone    ?? '').trim(),
      category: String(d.category ?? '').toLowerCase().trim(),
      name:     String(d.name     ?? '').trim(),
    };
    if (overwritePassword || (d.password ?? '').trim()) {
      payload.password = String(d.password ?? '').trim();
    }
    // Save doctor/merchant Firebase UID — used as merchantId in appointment docs
    const fbUid = String(d.firebaseUid ?? '').trim();
    if (fbUid) payload.uid = fbUid;
    await setDoc(doc(db, 'merchants', String(id)), payload, { merge: true });
  };

  const handleAdd = async (d: any) => {
    const { password, ...apiData } = d;          // strip password — not in SQL schema
    const r = await api.post("/api/locations", apiData);
    if (r.id) {
      try { await syncMerchantDoc(r.id, { ...apiData, password }, true); } catch {}
      toast.show("تمت الإضافة بنجاح"); setShowAdd(false); load();
    } else toast.show(r.error ?? "فشلت الإضافة", false);
  };

  const handleEdit = async (id: number, d: any) => {
    const { password, ...apiData } = d;
    const r = await api.patch(`/api/locations/${id}`, apiData);
    if (r.id) {
      // Only overwrite password in Firestore if admin typed a new one
      try { await syncMerchantDoc(id, { ...apiData, password }, false); } catch {}
      toast.show("تم التعديل بنجاح"); setEditId(null); load();
    } else toast.show(r.error ?? "فشل التعديل", false);
  };

  const handleDelete = async (id: number, name: string) => {
    if (!confirm(`حذف "${name}" نهائياً من قاعدة البيانات؟`)) return;
    await api.delete(`/api/locations/${id}`);
    try { await deleteDoc(doc(db, 'merchants', String(id))); } catch {}
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
    // Voyager: shows all real POIs (mosques, schools, shops, streets) clearly
    L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
      subdomains: "abcd", maxZoom: 20,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    }).addTo(mapRef.current);
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

// ── Firestore helper: update approved_agents status by phone ─────────────────
async function syncAgentFirestore(phone: string, status: 'available' | 'offline', extra: Record<string, unknown> = {}) {
  if (!phone) return;
  try {
    const snap = await getDocs(query(collection(db, 'approved_agents'), where('phone', '==', phone)));
    if (snap.empty) return;
    await Promise.all(snap.docs.map(d => updateDoc(d.ref, {
      status,
      isOnline: status === 'available',
      currentTripId: null,
      isBusy: status !== 'available',
      ...extra,
    })));
    console.log(`[syncAgentFirestore] phone=${phone} → status=${status}`);
  } catch (e) {
    console.warn('[syncAgentFirestore] failed:', e);
  }
}

// ── Firestore helper: update drivers/{uid} by phone lookup ───────────────────
// Partner app reads this doc to decide whether to show "online" state.
async function syncDriversFirestore(phone: string, status: 'available' | 'offline') {
  if (!phone) return;
  try {
    const snap = await getDocs(query(collection(db, 'drivers'), where('phone', '==', phone)));
    if (snap.empty) {
      console.log(`[syncDriversFirestore] no drivers doc for phone=${phone}`);
      return;
    }
    const isOnline = status === 'available';
    await Promise.all(snap.docs.map(d => updateDoc(d.ref, {
      status,
      isOnline,
      currentTripId: null,
    })));
    console.log(`[syncDriversFirestore] phone=${phone} → ${status} (${snap.docs.length} doc(s))`);
  } catch (e) {
    console.warn('[syncDriversFirestore] failed:', e);
  }
}

// ── Firestore helper: update merchants/{locationId} ──────────────────────────
// Gas offline filter in ClinicMap reads this collection via onSnapshot.
async function syncMerchantFirestore(locationId: number, status: 'available' | 'offline') {
  if (!locationId) return;
  try {
    const isOnline = status === 'available';
    await setDoc(doc(db, 'merchants', String(locationId)), {
      isOnline,
      status,
    }, { merge: true });
    console.log(`[syncMerchantFirestore] locationId=${locationId} → ${status}`);
  } catch (e) {
    console.warn('[syncMerchantFirestore] failed:', e);
  }
}

function DriversTab({ toast }: { toast: ReturnType<typeof useToast> }) {
  const [drivers, setDrivers] = useState<OnlineDriver[]>([]);
  const [loading, setLoading] = useState(true);
  const [busying, setBusying] = useState<number | null>(null);
  const [offlining, setOfflining] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetch("/api/drivers-online/all", { headers: { "x-admin-password": ADMIN_PW } }).then(r => r.json());
      setDrivers(Array.isArray(d) ? d : []);
    } catch { toast.show("فشل تحميل السائقين", false); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); const iv = setInterval(load, 8000); return () => clearInterval(iv); }, [load]);

  // ── Force-free: reset isBusy in PostgreSQL + all Firestore collections ────────
  const forceFree = async (locationId: number, name: string, phone: string) => {
    setBusying(locationId);
    try {
      const r = await fetch(`/api/drivers-online/${locationId}/busy`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-admin-password": ADMIN_PW },
        body: JSON.stringify({ busy: false }),
      }).then(r => r.json());
      if (r.ok) {
        // Mirror to ALL Firestore collections simultaneously
        await Promise.all([
          syncAgentFirestore(phone, 'available'),          // approved_agents (taxi filter)
          syncDriversFirestore(phone, 'available'),        // drivers/{uid}   (partner app state)
          syncMerchantFirestore(locationId, 'available'),  // merchants/{id}  (gas popup filter)
        ]);
        toast.show(`✓ تم تحرير السائق ${name}`);
        load();
      } else toast.show(r.error ?? "فشل تحرير السائق", false);
    } catch { toast.show("خطأ في الاتصال", false); }
    finally { setBusying(null); }
  };

  // ── Force-offline: set isOnline=false in PostgreSQL + all Firestore collections
  const forceOffline = async (locationId: number, name: string, phone: string) => {
    setOfflining(locationId);
    try {
      // 1. REST API — sets isOnline=false, isBusy=false in PostgreSQL
      const r = await fetch(`/api/drivers-online/${locationId}`, {
        method: "DELETE",
        headers: { "x-admin-password": ADMIN_PW },
      });
      if (!r.ok && r.status !== 404) {
        toast.show("فشل إيقاف السائق من الـ API", false);
        return;
      }
      // 2. Mirror to ALL Firestore collections simultaneously
      await Promise.all([
        syncAgentFirestore(phone, 'offline'),          // approved_agents (taxi filter)
        syncDriversFirestore(phone, 'offline'),        // drivers/{uid}   (partner app state)
        syncMerchantFirestore(locationId, 'offline'),  // merchants/{id}  (gas popup filter)
      ]);
      toast.show(`✓ تم إيقاف السائق ${name}`);
      load();
    } catch { toast.show("خطأ في الاتصال", false); }
    finally { setOfflining(null); }
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
              {/* Buttons */}
              <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
              {/* Force-free button — only when busy */}
              {/* Force-free: reset isBusy + sync Firestore → available */}
              {dr.isBusy && (
                <button
                  disabled={busying === dr.locationId}
                  onClick={() => forceFree(dr.locationId, dr.driverName, dr.phone)}
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
              {/* Force-offline: set isOnline=false + sync Firestore → offline */}
              {dr.isOnline && (
                <button
                  disabled={offlining === dr.locationId}
                  onClick={() => forceOffline(dr.locationId, dr.driverName, dr.phone)}
                  style={{
                    padding: "7px 14px", background: `${C.red}15`, border: `1px solid ${C.red}55`,
                    color: C.red, fontFamily: "Orbitron, sans-serif", fontSize: "9px",
                    letterSpacing: "0.08em", cursor: "pointer", borderRadius: "2px",
                    opacity: offlining === dr.locationId ? 0.5 : 1,
                  }}
                >
                  {offlining === dr.locationId ? "..." : "🔴 إيقاف السائق"}
                </button>
              )}
              </div>{/* end buttons */}
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
// ── UsersTab — إدارة المستخدمين وتصفير أرصدة المحافظ (Firestore) ─────────────
// ══════════════════════════════════════════════════════════════════════════════
interface AppUser {
  id:       string;   // Firestore doc ID (= Firebase UID)
  name:     string;
  phone:    string;
  uid?:     string;
  balance:  number;
}

function UsersTab({ toast }: { toast: ReturnType<typeof useToast> }) {
  const [users,          setUsers]          = useState<AppUser[]>([]);
  const [loading,        setLoading]        = useState(true);
  const [confirmReset,   setConfirmReset]   = useState<AppUser | null>(null);
  const [resetting,      setResetting]      = useState<string | null>(null);
  const [balanceInputs,  setBalanceInputs]  = useState<Record<string, string>>({});
  const [savingBalance,  setSavingBalance]  = useState<string | null>(null);
  const [liveCount,      setLiveCount]      = useState(0);

  // ── Live Firestore listener — all users ──────────────────────────────────
  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, 'users'),
      snap => {
        const docs: AppUser[] = [];
        snap.forEach(d => {
          const raw = d.data();
          docs.push({
            id:      d.id,
            name:    String(raw.name  ?? '—'),
            phone:   String(raw.phone ?? '—'),
            uid:     String(raw.uid   ?? d.id),
            balance: Number(raw.balance ?? 0),
          });
        });
        // Sort: users with balance first, then alphabetically
        docs.sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name));
        setUsers(docs);
        setLoading(false);
      },
      err => { console.error('[UsersTab]', err); setLoading(false); }
    );
    return () => unsub();
  }, []);

  // ── Live counter — isOnline == true ──────────────────────────────────────
  useEffect(() => {
    const unsub = onSnapshot(
      query(collection(db, 'users'), where('isOnline', '==', true)),
      snap => setLiveCount(snap.size),
      () => {}
    );
    return () => unsub();
  }, []);

  // ── Reset balance → 0 ────────────────────────────────────────────────────
  async function doReset(user: AppUser) {
    setResetting(user.id);
    try {
      await updateDoc(doc(db, 'users', user.id), { balance: 0 });
      toast.show(`✅ تم تصفير رصيد ${user.name} — تحديث فوري في تطبيق الزبون`);
    } catch (e: any) {
      toast.show(`فشل التصفير: ${e?.message ?? e}`, false);
    } finally {
      setResetting(null);
      setConfirmReset(null);
    }
  }

  // ── Set balance manually ─────────────────────────────────────────────────
  async function doSetBalance(user: AppUser) {
    const raw = balanceInputs[user.id] ?? '';
    const val = Number(raw.replace(/,/g, '').trim());
    if (raw.trim() === '' || isNaN(val) || val < 0) {
      toast.show('يرجى إدخال رقم صحيح ≥ 0', false);
      return;
    }
    setSavingBalance(user.id);
    try {
      await updateDoc(doc(db, 'users', user.id), { balance: val });
      setBalanceInputs(prev => { const n = { ...prev }; delete n[user.id]; return n; });
      toast.show(`تم تحديث رصيد المستخدم بنجاح! 🟢`);
    } catch (e: any) {
      toast.show(`فشل الحفظ: ${e?.message ?? e}`, false);
    } finally {
      setSavingBalance(null);
    }
  }

  const withBalance = users.filter(u => u.balance > 0).length;

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ direction: 'rtl' }}>

      {/* ── Stats Counter Cards ─────────────────────────────────────────── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: '14px',
        marginBottom: '22px',
      }}>

        {/* Card 1 — Total users */}
        <div style={{
          background: C.surface,
          border: `1px solid ${C.blue}30`,
          borderRadius: '6px',
          padding: '18px 20px',
          display: 'flex', alignItems: 'center', gap: '16px',
          boxShadow: `0 0 20px ${C.blue}0a`,
          position: 'relative', overflow: 'hidden',
        }}>
          {/* Glow strip */}
          <div style={{
            position: 'absolute', top: 0, right: 0,
            width: '3px', height: '100%',
            background: `linear-gradient(to bottom, ${C.blue}00, ${C.blue}88, ${C.blue}00)`,
          }} />
          {/* Icon */}
          <div style={{
            width: '44px', height: '44px', borderRadius: '8px', flexShrink: 0,
            background: `${C.blue}12`, border: `1px solid ${C.blue}30`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '20px',
          }}>👥</div>
          {/* Text */}
          <div>
            <div style={{
              fontFamily: 'Orbitron, sans-serif', fontSize: '8px',
              color: `${C.blue}99`, letterSpacing: '0.12em', marginBottom: '4px',
            }}>TOTAL USERS</div>
            <div style={{
              fontFamily: 'Orbitron, sans-serif', fontSize: '28px', fontWeight: 700,
              color: C.blue, lineHeight: 1,
              textShadow: `0 0 20px ${C.blue}55`,
            }}>
              {loading
                ? <div style={{ width: '40px', height: '28px', background: `${C.blue}15`, borderRadius: '3px' }} />
                : users.length}
            </div>
            <div style={{
              fontFamily: 'Rajdhani, sans-serif', fontSize: '12px',
              color: C.dim, marginTop: '3px',
            }}>إجمالي مستخدمي النظام</div>
          </div>
        </div>

        {/* Card 2 — Live online now */}
        <div style={{
          background: C.surface,
          border: `1px solid ${C.green}35`,
          borderRadius: '6px',
          padding: '18px 20px',
          display: 'flex', alignItems: 'center', gap: '16px',
          boxShadow: liveCount > 0 ? `0 0 24px ${C.green}12` : 'none',
          position: 'relative', overflow: 'hidden',
          transition: 'box-shadow 0.4s',
        }}>
          {/* Glow strip */}
          <div style={{
            position: 'absolute', top: 0, right: 0,
            width: '3px', height: '100%',
            background: `linear-gradient(to bottom, ${C.green}00, ${C.green}99, ${C.green}00)`,
          }} />
          {/* Icon + ping */}
          <div style={{
            width: '44px', height: '44px', borderRadius: '8px', flexShrink: 0,
            background: `${C.green}10`, border: `1px solid ${C.green}35`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            position: 'relative',
          }}>
            <span style={{ fontSize: '20px', position: 'relative', zIndex: 1 }}>🟢</span>
            {liveCount > 0 && (
              <div style={{
                position: 'absolute', inset: '-4px', borderRadius: '10px',
                border: `1.5px solid ${C.green}`,
                animation: 'lf-ping 2s cubic-bezier(0,0,0.2,1) infinite',
                opacity: 0.5,
              }} />
            )}
          </div>
          {/* Text */}
          <div>
            <div style={{
              fontFamily: 'Orbitron, sans-serif', fontSize: '8px',
              color: `${C.green}88`, letterSpacing: '0.12em', marginBottom: '4px',
            }}>LIVE NOW</div>
            <div style={{
              fontFamily: 'Orbitron, sans-serif', fontSize: '28px', fontWeight: 700,
              color: C.green, lineHeight: 1,
              textShadow: liveCount > 0 ? `0 0 20px ${C.green}66` : 'none',
            }}>{liveCount}</div>
            <div style={{
              fontFamily: 'Rajdhani, sans-serif', fontSize: '12px',
              color: C.dim, marginTop: '3px',
            }}>المتواجدون لايف الآن</div>
          </div>
        </div>

      </div>

      {/* Section header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '20px', flexWrap: 'wrap', gap: '10px' }}>
        <div>
          <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '11px', color: C.blue, letterSpacing: '0.18em', marginBottom: '4px' }}>
            👥 USERS MANAGEMENT · إدارة المستخدمين
          </div>
          <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '13px', color: C.dim }}>
            مراقبة أرصدة المحافظ وتصفير الرصيد بعد تسليم الأموال
            {!loading && (
              <span style={{ marginRight: '8px' }}>
                <span style={{ color: C.text }}>· {users.length} مستخدم</span>
                {withBalance > 0 && (
                  <span style={{ color: C.yellow, marginRight: '6px' }}>
                    · {withBalance} لديهم رصيد
                  </span>
                )}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── Confirmation modal ───────────────────────────────────────────── */}
      {confirmReset && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 600, background: 'rgba(0,0,0,0.82)', backdropFilter: 'blur(7px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}
          onClick={e => { if (e.target === e.currentTarget) setConfirmReset(null); }}
        >
          <div style={{ width: 'min(420px, 100%)', background: C.surface, border: `1px solid ${C.yellow}55`, borderRadius: '4px', boxShadow: `0 0 50px ${C.yellow}14, 0 8px 40px rgba(0,0,0,0.95)`, overflow: 'hidden' }}>

            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '16px 18px', borderBottom: `1px solid ${C.yellow}22`, background: `${C.yellow}07` }}>
              <span style={{ fontSize: '24px' }}>⚠️</span>
              <span style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '10px', color: C.yellow, letterSpacing: '0.14em' }}>
                تأكيد تصفير الرصيد
              </span>
            </div>

            {/* Body */}
            <div style={{ padding: '20px 18px' }}>
              <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '15px', color: C.text, lineHeight: 1.7, marginBottom: '16px' }}>
                هل أنت متأكد من تصفير رصيد هذا المستخدم بعد تسليمه المبلغ كاش؟
              </div>

              {/* User card */}
              <div style={{ padding: '12px 14px', background: `${C.yellow}07`, border: `1px solid ${C.yellow}25`, borderRadius: '3px', marginBottom: '18px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '17px', fontWeight: 700, color: C.text }}>{confirmReset.name}</div>
                    <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '9px', color: C.dim, marginTop: '2px', letterSpacing: '0.06em' }}>{confirmReset.phone}</div>
                  </div>
                  <div style={{ textAlign: 'left' }}>
                    <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '8px', color: `${C.yellow}88`, letterSpacing: '0.1em', marginBottom: '2px' }}>الرصيد الحالي</div>
                    <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '18px', color: C.yellow, textShadow: `0 0 14px ${C.yellow}88` }}>
                      {confirmReset.balance.toLocaleString('ar-IQ')}
                      <span style={{ fontSize: '10px', opacity: 0.6, marginRight: '4px' }}>د.ع</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Warning */}
              <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '12px', color: C.red, marginBottom: '18px', padding: '8px 12px', background: `${C.red}08`, border: `1px solid ${C.red}30`, borderRadius: '3px' }}>
                ⚠ سيتحول رصيد المستخدم إلى (0 د.ع) فوراً في تطبيقه — لا يمكن التراجع.
              </div>

              {/* Buttons */}
              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  onClick={() => setConfirmReset(null)}
                  style={{ flex: 1, padding: '11px', background: 'none', border: `1px solid ${C.border}`, color: C.dim, fontFamily: 'Orbitron, sans-serif', fontSize: '9px', letterSpacing: '0.1em', cursor: 'pointer', borderRadius: '3px' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'none')}
                >
                  إلغاء
                </button>
                <button
                  onClick={() => doReset(confirmReset)}
                  disabled={resetting === confirmReset.id}
                  style={{ flex: 2, padding: '11px', background: `${C.green}15`, border: `1px solid ${C.green}77`, color: C.green, fontFamily: 'Orbitron, sans-serif', fontSize: '9px', letterSpacing: '0.1em', cursor: 'pointer', borderRadius: '3px', boxShadow: neon(C.green, 6), display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '7px' }}
                  onMouseEnter={e => (e.currentTarget.style.background = `${C.green}25`)}
                  onMouseLeave={e => (e.currentTarget.style.background = `${C.green}15`)}
                >
                  {resetting === confirmReset.id ? (
                    <><svg width="12" height="12" viewBox="0 0 28 28" fill="none" style={{ animation: 'spin 0.9s linear infinite' }}><circle cx="14" cy="14" r="10" stroke={C.green} strokeWidth="2.5" strokeDasharray="22 14" strokeLinecap="round"/></svg>جاري التصفير...</>
                  ) : (
                    '✅ نعم، تم الدفع — صفّر الرصيد'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Users Table ──────────────────────────────────────────────────── */}
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '60px', color: C.dim }}>
          <svg width="22" height="22" viewBox="0 0 28 28" fill="none" style={{ animation: 'spin 0.9s linear infinite' }}><circle cx="14" cy="14" r="10" stroke={C.blue} strokeWidth="2.5" strokeDasharray="22 14" strokeLinecap="round"/></svg>
          <span style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '11px', color: C.blue }}>جاري تحميل المستخدمين من Firestore...</span>
        </div>
      ) : users.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px', color: C.dim }}>
          <div style={{ fontSize: '40px', marginBottom: '12px' }}>👥</div>
          <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '11px', letterSpacing: '0.12em' }}>لا يوجد مستخدمون مسجلون بعد</div>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'Rajdhani, sans-serif' }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                {['#', 'الاسم', 'رقم الهاتف', 'معرّف الحساب (UID)', 'الرصيد الحالي', 'تعديل الرصيد', 'إجراء التسوية'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'Orbitron, sans-serif', fontSize: '8px', color: C.blue, letterSpacing: '0.1em', whiteSpace: 'nowrap', background: `${C.blue}07` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((u, idx) => {
                const hasBalance = u.balance > 0;
                const rowBg      = idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)';
                return (
                  <tr key={u.id}
                    style={{ borderBottom: `1px solid ${C.border}44`, background: rowBg, transition: 'background 0.15s' }}
                    onMouseEnter={e => (e.currentTarget.style.background = `${C.blue}07`)}
                    onMouseLeave={e => (e.currentTarget.style.background = rowBg)}
                  >
                    {/* # */}
                    <td style={{ padding: '10px 12px', fontFamily: 'Orbitron, sans-serif', fontSize: '9px', color: `${C.blue}55`, whiteSpace: 'nowrap' }}>{idx + 1}</td>

                    {/* Name */}
                    <td style={{ padding: '10px 12px', fontSize: '15px', fontWeight: 600, color: C.text, minWidth: '120px' }}>{u.name}</td>

                    {/* Phone */}
                    <td style={{ padding: '10px 12px', fontFamily: 'Orbitron, monospace', fontSize: '12px', color: '#00f5d4', letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>
                      {u.phone}
                    </td>

                    {/* UID */}
                    <td style={{ padding: '10px 12px', fontFamily: 'Orbitron, monospace', fontSize: '9px', color: C.dim, maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {u.id}
                    </td>

                    {/* Balance */}
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                      {hasBalance ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '5px 12px', background: `${C.yellow}12`, border: `1px solid ${C.yellow}55`, color: C.yellow, borderRadius: '3px', fontFamily: 'Orbitron, sans-serif', fontSize: '12px', boxShadow: `0 0 10px ${C.yellow}22` }}>
                          <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: C.yellow, boxShadow: `0 0 6px ${C.yellow}`, display: 'inline-block', animation: 'spin 3s linear infinite' }} />
                          🎁 {u.balance.toLocaleString('ar-IQ')} د.ع
                        </span>
                      ) : (
                        <span style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '11px', color: 'rgba(255,255,255,0.18)' }}>
                          0 د.ع
                        </span>
                      )}
                    </td>

                    {/* ── Manual balance editor ── */}
                    <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <input
                          type="number"
                          min="0"
                          placeholder={u.balance.toString()}
                          value={balanceInputs[u.id] ?? ''}
                          onChange={e => setBalanceInputs(prev => ({ ...prev, [u.id]: e.target.value }))}
                          onKeyDown={e => { if (e.key === 'Enter') doSetBalance(u); }}
                          style={{
                            width: '100px', padding: '5px 8px',
                            background: 'rgba(0,212,255,0.06)',
                            border: `1px solid ${balanceInputs[u.id] != null && balanceInputs[u.id] !== '' ? C.blue : 'rgba(0,212,255,0.2)'}`,
                            color: C.text,
                            fontFamily: 'Orbitron, monospace', fontSize: '11px',
                            borderRadius: '3px', outline: 'none',
                            transition: 'border-color 0.15s',
                          }}
                        />
                        <button
                          onClick={() => doSetBalance(u)}
                          disabled={savingBalance === u.id || !balanceInputs[u.id]}
                          title="حفظ الرصيد الجديد"
                          style={{
                            padding: '5px 10px',
                            background: balanceInputs[u.id] ? `${C.blue}18` : 'rgba(0,212,255,0.04)',
                            border: `1px solid ${balanceInputs[u.id] ? C.blue : 'rgba(0,212,255,0.18)'}`,
                            color: balanceInputs[u.id] ? C.blue : 'rgba(0,212,255,0.25)',
                            fontFamily: 'Orbitron, sans-serif', fontSize: '8px',
                            letterSpacing: '0.08em', cursor: balanceInputs[u.id] ? 'pointer' : 'not-allowed',
                            borderRadius: '2px', transition: 'all 0.15s',
                            display: 'flex', alignItems: 'center', gap: '4px',
                            boxShadow: balanceInputs[u.id] ? `0 0 8px ${C.blue}33` : 'none',
                          }}
                          onMouseEnter={e => { if (balanceInputs[u.id]) (e.currentTarget.style.background = `${C.blue}28`); }}
                          onMouseLeave={e => { if (balanceInputs[u.id]) (e.currentTarget.style.background = `${C.blue}18`); }}
                        >
                          {savingBalance === u.id ? (
                            <svg width="10" height="10" viewBox="0 0 28 28" fill="none" style={{ animation: 'spin 0.9s linear infinite' }}>
                              <circle cx="14" cy="14" r="10" stroke={C.blue} strokeWidth="2.5" strokeDasharray="22 14" strokeLinecap="round"/>
                            </svg>
                          ) : (
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
                              <path d="M20 6L9 17l-5-5" stroke={balanceInputs[u.id] ? C.blue : 'rgba(0,212,255,0.25)'} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                          )}
                          حفظ
                        </button>
                      </div>
                    </td>

                    {/* Reset action */}
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                      {hasBalance ? (
                        <button
                          onClick={() => setConfirmReset(u)}
                          disabled={resetting === u.id}
                          style={{ padding: '6px 14px', background: `${C.green}12`, border: `1px solid ${C.green}55`, color: C.green, fontFamily: 'Orbitron, sans-serif', fontSize: '8px', letterSpacing: '0.08em', cursor: 'pointer', borderRadius: '2px', transition: 'all 0.15s', display: 'flex', alignItems: 'center', gap: '5px' }}
                          onMouseEnter={e => (e.currentTarget.style.background = `${C.green}22`)}
                          onMouseLeave={e => (e.currentTarget.style.background = `${C.green}12`)}
                        >
                          {resetting === u.id ? (
                            <><svg width="10" height="10" viewBox="0 0 28 28" fill="none" style={{ animation: 'spin 0.9s linear infinite' }}><circle cx="14" cy="14" r="10" stroke={C.green} strokeWidth="2.5" strokeDasharray="22 14" strokeLinecap="round"/></svg>جاري...</>
                          ) : (
                            '✅ تم الدفع — تصفير الرصيد'
                          )}
                        </button>
                      ) : (
                        <span style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '12px', color: 'rgba(255,255,255,0.15)' }}>لا يوجد رصيد</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ── BountyMissionsTab v2 — مطاردة الكنوز المزدوجة ────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
interface AdminBountyDoc {
  id:            string;
  pairId:        string;
  isFake:        boolean;
  sponsor_name:  string;
  title:         string;
  first_reward:  string;
  second_reward: string;
  third_reward:  string;
  fake_message:  string;
  secret_answer: string;
  winners_log:   any[];
  expiresAt:     any;
  status:        'active' | 'closed' | 'expired';
  latitude:      number;
  longitude:     number;
  createdAt:     any;
}

interface AdminBountyPair {
  pairId:       string;
  sponsor_name: string;
  title:        string;
  first_reward: string;
  second_reward:string;
  third_reward: string;
  fake_message: string;
  winners_log:  any[];
  expiresAt:    any;
  status:       string;
  realDoc?:     AdminBountyDoc;
  fakeDoc?:     AdminBountyDoc;
  createdAt:    any;
}

const EMPTY_BMISSION = {
  sponsor_name:   '',
  title:          '',
  first_reward:   '',
  second_reward:  '',
  third_reward:   '',
  fake_message:   '',
  secret_answer:  '',
  duration_minutes: '30',
  realLat: '', realLng: '',
  fakeLat: '', fakeLng: '',
};

type PickMode = 'real' | 'fake';

function BountyMissionsTab({ toast }: { toast: ReturnType<typeof useToast> }) {
  const [docs,       setDocs]       = useState<AdminBountyDoc[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [showForm,   setShowForm]   = useState(false);
  const [form,       setForm]       = useState({ ...EMPTY_BMISSION });
  const [saving,     setSaving]     = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null); // pairId
  const [pickMode,   setPickMode]   = useState<PickMode>('real');

  // ── Map picker refs ──────────────────────────────────────────────────────
  const mapContainerRef    = useRef<HTMLDivElement | null>(null);
  const mapRef             = useRef<L.Map | null>(null);
  const realMarkerRef      = useRef<L.Marker | null>(null);
  const fakeMarkerRef      = useRef<L.Marker | null>(null);
  const pickModeRef        = useRef<PickMode>('real');
  const merchantMarkersRef = useRef<L.Marker[]>([]);

  // ── Map picker: init / destroy ────────────────────────────────────────────
  useEffect(() => {
    if (!showForm) {
      mapRef.current?.remove(); mapRef.current = null;
      realMarkerRef.current = null; fakeMarkerRef.current = null;
      merchantMarkersRef.current.forEach(m => m.remove());
      merchantMarkersRef.current = [];
      return;
    }
    const tid = setTimeout(() => {
      const container = mapContainerRef.current;
      if (!container || mapRef.current) return;

      const initLat = parseFloat(form.realLat) || 33.7440;
      const initLng = parseFloat(form.realLng) || 44.6530;

      const map = L.map(container, { center: [initLat, initLng], zoom: 14, zoomControl: true, attributionControl: false });
      mapRef.current = map;

      L.tileLayer(
        'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        { subdomains: 'abc', maxZoom: 20, attribution: '© OpenStreetMap contributors' },
      ).addTo(map);

      const makeRealIcon = () => L.divIcon({
        className: '', iconSize: [38, 38], iconAnchor: [19, 38],
        html: `<div style="width:38px;height:38px;display:flex;align-items:center;justify-content:center;background:#f5c51820;border:2px solid #f5c518;border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 0 14px #f5c518aa;cursor:grab"><span style="transform:rotate(45deg);font-size:17px">⭐</span></div>`,
      });
      const makeFakeIcon = () => L.divIcon({
        className: '', iconSize: [38, 38], iconAnchor: [19, 38],
        html: `<div style="width:38px;height:38px;display:flex;align-items:center;justify-content:center;background:#ff2d5020;border:2px solid #ff2d50;border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 0 14px #ff2d50aa;cursor:grab"><span style="transform:rotate(45deg);font-size:17px">🎭</span></div>`,
      });

      const realM = L.marker([initLat, initLng], { draggable: true, icon: makeRealIcon() }).addTo(map);
      const fakeM = L.marker([initLat + 0.002, initLng + 0.002], { draggable: true, icon: makeFakeIcon() }).addTo(map);
      realMarkerRef.current = realM; fakeMarkerRef.current = fakeM;

      realM.on('dragend', () => {
        const { lat, lng } = realM.getLatLng();
        setForm(p => ({ ...p, realLat: lat.toFixed(6), realLng: lng.toFixed(6) }));
      });
      fakeM.on('dragend', () => {
        const { lat, lng } = fakeM.getLatLng();
        setForm(p => ({ ...p, fakeLat: lat.toFixed(6), fakeLng: lng.toFixed(6) }));
      });

      // ── Fetch & draw existing merchant markers ──────────────────────────────
      fetch('/api/locations')
        .then(r => r.ok ? r.json() : [])
        .then((locs: Array<{
          id: number | string; name: string; lat: number; lng: number;
          category?: string; kind?: string;
          doctor?: string; specialty?: string; cuisine?: string;
        }>) => {
          if (!mapRef.current) return; // map destroyed before fetch returned

          const catStyle = (cat: string): { emoji: string; bg: string; border: string } => {
            switch (cat) {
              case 'clinic':
                return { emoji: '🏥', bg: 'rgba(0,245,212,0.18)', border: '#00f5d4' };
              case 'restaurant': case 'food':
                return { emoji: '🍽️', bg: 'rgba(255,149,0,0.18)', border: '#ff9500' };
              case 'pharmacy':
                return { emoji: '💊', bg: 'rgba(199,125,255,0.18)', border: '#c77dff' };
              case 'gas_station': case 'fuel':
                return { emoji: '⛽', bg: 'rgba(245,197,24,0.18)', border: '#f5c518' };
              case 'mosque':
                return { emoji: '🕌', bg: 'rgba(0,212,255,0.15)', border: '#00d4ff' };
              case 'school': case 'university':
                return { emoji: '🏫', bg: 'rgba(100,200,255,0.15)', border: '#64c8ff' };
              default:
                return { emoji: '📍', bg: 'rgba(255,255,255,0.10)', border: 'rgba(255,255,255,0.4)' };
            }
          };

          const newMarkers: L.Marker[] = [];

          locs.forEach(loc => {
            if (!loc.lat || !loc.lng) return;
            const cat = loc.category ?? loc.kind ?? '';
            const { emoji, bg, border } = catStyle(cat);

            const icon = L.divIcon({
              className: '',
              iconSize:  [30, 30],
              iconAnchor:[15, 15],
              html: `<div style="width:30px;height:30px;display:flex;align-items:center;justify-content:center;
                background:${bg};border:2px solid ${border};border-radius:50%;
                box-shadow:0 0 8px ${border}88;font-size:15px;cursor:pointer;
                transition:transform 0.15s;" title="${loc.name}">${emoji}</div>`,
            });

            const m = L.marker([loc.lat, loc.lng], { icon, zIndexOffset: -200 });
            m.addTo(mapRef.current!);

            // Sub-label for doctors
            const sub = cat === 'clinic'
              ? [loc.doctor, loc.specialty].filter(Boolean).join(' · ')
              : cat === 'restaurant' ? (loc.cuisine ?? '') : '';

            // InfoWindow (popup) on click — stop propagation so pin-drop is NOT triggered
            m.on('click', (e: L.LeafletMouseEvent) => {
              L.DomEvent.stopPropagation(e);
              m.openPopup();
            });

            m.bindPopup(
              `<div style="direction:rtl;font-family:Rajdhani,sans-serif;min-width:150px;padding:2px 0;">
                <div style="font-size:16px;font-weight:700;color:#1a1a1a;line-height:1.3;margin-bottom:3px;">
                  ${emoji} ${loc.name}
                </div>
                ${sub ? `<div style="font-size:12px;color:#555;margin-bottom:2px;">${sub}</div>` : ''}
                <div style="font-size:10px;color:#999;letter-spacing:0.05em;text-transform:uppercase;">${cat}</div>
              </div>`,
              { closeButton: false, maxWidth: 220, offset: [0, -8] },
            );

            newMarkers.push(m);
          });

          merchantMarkersRef.current = newMarkers;
        })
        .catch(() => {}); // silent — markers are optional guidance only

      map.on('click', (e: L.LeafletMouseEvent) => {
        const { lat, lng } = e.latlng;
        if (pickModeRef.current === 'real') {
          realM.setLatLng(e.latlng);
          setForm(p => ({ ...p, realLat: lat.toFixed(6), realLng: lng.toFixed(6) }));
        } else {
          fakeM.setLatLng(e.latlng);
          setForm(p => ({ ...p, fakeLat: lat.toFixed(6), fakeLng: lng.toFixed(6) }));
        }
      });

      // Fit both pins on screen
      setTimeout(() => {
        map.invalidateSize();
        setForm(p => ({ ...p, fakeLat: (initLat + 0.002).toFixed(6), fakeLng: (initLng + 0.002).toFixed(6) }));
      }, 80);
    }, 60);
    return () => clearTimeout(tid);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showForm]);

  // ── Keep pickModeRef in sync ───────────────────────────────────────────────
  useEffect(() => { pickModeRef.current = pickMode; }, [pickMode]);

  // ── Firestore listener ─────────────────────────────────────────────────────
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'bounties'), snap => {
      const result: AdminBountyDoc[] = [];
      snap.forEach(d => {
        const raw = d.data();
        const lat = Number(raw.latitude), lng = Number(raw.longitude);
        if (isNaN(lat) || isNaN(lng)) return;
        result.push({
          id: d.id, pairId: String(raw.pairId ?? d.id),
          isFake: Boolean(raw.isFake),
          sponsor_name: String(raw.sponsor_name ?? ''),
          title: String(raw.title ?? ''),
          first_reward: String(raw.first_reward ?? ''),
          second_reward: String(raw.second_reward ?? ''),
          third_reward: String(raw.third_reward ?? ''),
          fake_message: String(raw.fake_message ?? ''),
          secret_answer: String(raw.secret_answer ?? ''),
          winners_log: Array.isArray(raw.winners_log) ? raw.winners_log : [],
          expiresAt: raw.expiresAt,
          status: raw.status ?? 'active',
          latitude: lat, longitude: lng,
          createdAt: raw.createdAt,
        });
      });
      setDocs(result);
      setLoading(false);
    }, err => { console.error('[BountyTab] Firestore:', err); setLoading(false); });
    return () => unsub();
  }, []);

  // ── Group by pairId ────────────────────────────────────────────────────────
  const pairs = useCallback((): AdminBountyPair[] => {
    const map = new Map<string, AdminBountyPair>();
    docs.forEach(d => {
      if (!map.has(d.pairId)) {
        map.set(d.pairId, {
          pairId: d.pairId, sponsor_name: d.sponsor_name, title: d.title,
          first_reward: d.first_reward, second_reward: d.second_reward, third_reward: d.third_reward,
          fake_message: d.fake_message, winners_log: d.winners_log,
          expiresAt: d.expiresAt, status: d.status, createdAt: d.createdAt,
        });
      }
      const p = map.get(d.pairId)!;
      if (!d.isFake) p.realDoc = d; else p.fakeDoc = d;
      // Use the worst status
      if (d.status !== 'active') p.status = d.status;
      // Use longer winners_log
      if (d.winners_log.length > p.winners_log.length) p.winners_log = d.winners_log;
    });
    return [...map.values()].sort((a, b) => {
      const sa = a.status === 'active' ? 0 : 1;
      const sb = b.status === 'active' ? 0 : 1;
      return sa - sb;
    });
  }, [docs]);

  function openAdd() {
    setForm({ ...EMPTY_BMISSION }); setPickMode('real'); setShowForm(true);
  }

  async function save() {
    const rLat = parseFloat(form.realLat), rLng = parseFloat(form.realLng);
    const fLat = parseFloat(form.fakeLat), fLng = parseFloat(form.fakeLng);
    const dur  = parseInt(form.duration_minutes);

    if (!form.sponsor_name.trim()) { toast.show('اسم الراعي مطلوب', false); return; }
    if (!form.first_reward.trim()) { toast.show('جائزة المركز الأول مطلوبة', false); return; }
    if (isNaN(rLat) || isNaN(rLng)) { toast.show('يرجى تحديد الموقع الحقيقي ⭐ على الخريطة', false); return; }
    if (isNaN(fLat) || isNaN(fLng)) { toast.show('يرجى تحديد الموقع الوهمي 🎭 على الخريطة', false); return; }
    if (isNaN(dur) || dur <= 0) { toast.show('مدة المهمة يجب أن تكون أكبر من صفر', false); return; }

    setSaving(true);
    try {
      const pairId   = `pair_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const expiresAt = Timestamp.fromDate(new Date(Date.now() + dur * 60_000));
      const title    = `مهمة ${form.sponsor_name.trim()}`;
      const shared   = {
        pairId, sponsor_name: form.sponsor_name.trim(), title,
        first_reward: form.first_reward.trim(),
        second_reward: form.second_reward.trim(),
        third_reward: form.third_reward.trim(),
        fake_message: form.fake_message.trim() || 'أكلت المقلب خوية! 😂 اركض للموقع الثاني بسرعة!',
        winners_log: [],
        expiresAt,
        status: 'active',
        createdAt: serverTimestamp(),
      };
      await Promise.all([
        addDoc(collection(db, 'bounties'), { ...shared, isFake: false, latitude: rLat, longitude: rLng, secret_answer: (form.secret_answer ?? '').trim() }),
        addDoc(collection(db, 'bounties'), { ...shared, isFake: true,  latitude: fLat, longitude: fLng }),
      ]);
      toast.show(`✓ تم إطلاق مهمة "${title}" — ${dur} دقيقة`);
      setShowForm(false);
    } catch (e: any) {
      toast.show(`فشل الحفظ: ${e?.message ?? e}`, false);
    } finally { setSaving(false); }
  }

  async function deletePair(pair: AdminBountyPair) {
    try {
      const dels: Promise<any>[] = [];
      if (pair.realDoc) dels.push(deleteDoc(doc(db, 'bounties', pair.realDoc.id)));
      if (pair.fakeDoc) dels.push(deleteDoc(doc(db, 'bounties', pair.fakeDoc.id)));
      await Promise.all(dels);
      toast.show('تم حذف المهمة المزدوجة ✓');
    } catch (e: any) {
      toast.show(`فشل الحذف: ${e?.message ?? e}`, false);
    } finally { setConfirmDel(null); }
  }

  const f = (field: keyof typeof EMPTY_BMISSION) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm(p => ({ ...p, [field]: e.target.value }));

  const pairList = pairs();
  const activeCount = pairList.filter(p => p.status === 'active').length;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ direction: 'rtl' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '20px', flexWrap: 'wrap', gap: '10px' }}>
        <div>
          <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '11px', color: C.yellow, letterSpacing: '0.18em', marginBottom: '4px' }}>
            ⭐ BOUNTY HUNT MANAGEMENT · مطاردة الكنوز المزدوجة
          </div>
          <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '13px', color: C.dim }}>
            كل مهمة = موقعان متشابهان (حقيقي + وهمي) · أول 3 يصلون للحقيقي يفوزون
            {!loading && <span style={{ color: C.green, marginRight: '8px' }}>· {activeCount} مهمة نشطة</span>}
          </div>
        </div>
        <button onClick={openAdd}
          style={{ padding: '10px 20px', background: `${C.yellow}18`, border: `1px solid ${C.yellow}88`, color: C.yellow, fontFamily: 'Orbitron, sans-serif', fontSize: '10px', letterSpacing: '0.1em', cursor: 'pointer', borderRadius: '3px', boxShadow: neon(C.yellow, 8) }}
          onMouseEnter={e => (e.currentTarget.style.background = `${C.yellow}28`)}
          onMouseLeave={e => (e.currentTarget.style.background = `${C.yellow}18`)}>
          ＋ إطلاق مهمة كنز جديدة
        </button>
      </div>

      {/* ── Add Modal ── */}
      {showForm && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 500, background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(7px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}
          onClick={e => { if (e.target === e.currentTarget) setShowForm(false); }}>
          <div style={{ width: 'min(680px,100%)', background: C.surface, border: `1px solid ${C.yellow}44`, borderRadius: '6px', boxShadow: `0 0 60px ${C.yellow}18,0 8px 40px rgba(0,0,0,0.95)`, overflow: 'hidden', maxHeight: '94vh', display: 'flex', flexDirection: 'column' }}>

            {/* Modal header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 16px', borderBottom: `1px solid ${C.yellow}22`, background: `${C.yellow}08` }}>
              <span style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '10px', color: C.yellow, letterSpacing: '0.15em' }}>⭐ إطلاق مهمة كنز مزدوجة جديدة</span>
              <button onClick={() => setShowForm(false)} style={{ background: 'none', border: 'none', color: C.dim, fontSize: '20px', cursor: 'pointer' }}>×</button>
            </div>

            {/* Form body */}
            <div style={{ padding: '18px 16px', display: 'flex', flexDirection: 'column', gap: '14px', overflowY: 'auto', flex: 1 }}>

              {/* Sponsor + Duration */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '10px' }}>
                <div>
                  <label style={LBL}>🏪 اسم الراعي (Sponsor) *</label>
                  <input value={form.sponsor_name} onChange={f('sponsor_name')} onFocus={ff} onBlur={fb}
                    placeholder="مثال: مطعم كوكو جيكن"
                    style={FLD} />
                </div>
                <div>
                  <label style={LBL}>⏱ المدة (دقائق) *</label>
                  <input value={form.duration_minutes} onChange={f('duration_minutes')} onFocus={ff} onBlur={fb}
                    type="number" min="1" placeholder="30"
                    style={{ ...FLD, width: '90px', textAlign: 'center', color: C.yellow, fontFamily: 'Orbitron, monospace' }} />
                </div>
              </div>

              {/* Rewards */}
              <div>
                <label style={LBL}>🏆 جوائز المراكز الثلاثة</label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', marginTop: '6px' }}>
                  {[
                    { key: 'first_reward' as const, ph: '🥇 مثال: 15,000 دينار كاش', color: '#FFD700', lbl: 'المركز الأول *' },
                    { key: 'second_reward' as const, ph: '🥈 مثال: 5,000 دينار كاش', color: '#C0C0C0', lbl: 'المركز الثاني' },
                    { key: 'third_reward' as const, ph: '🥉 مثال: 3,000 دينار كاش', color: '#CD7F32', lbl: 'المركز الثالث' },
                  ].map(r => (
                    <div key={r.key}>
                      <label style={{ ...LBL, color: r.color + 'cc' }}>{r.lbl}</label>
                      <input value={form[r.key]} onChange={f(r.key)} onFocus={ff} onBlur={fb}
                        placeholder={r.ph}
                        style={{ ...FLD, borderColor: r.color + '44', color: r.color, fontSize: '12px' }} />
                    </div>
                  ))}
                </div>
              </div>

              {/* Fake message */}
              <div>
                <label style={LBL}>🎭 رسالة المقلب (تظهر لمن يصل الموقع الوهمي)</label>
                <textarea value={form.fake_message} onChange={f('fake_message') as any} onFocus={ff} onBlur={fb}
                  placeholder='مثال: "أكلت المقلب خوية! صاحب المحل استغرب منك 😂.. اركض للموقع الثاني بسرعة!"'
                  rows={2}
                  style={{ ...FLD, resize: 'vertical', minHeight: '60px', lineHeight: 1.55, borderColor: `${C.red}44` }} />
              </div>

              {/* Secret Answer — real location only */}
              <div style={{ padding: '14px 16px', background: `${C.yellow}07`, border: `1px solid ${C.yellow}33`, borderRadius: '6px' }}>
                <label style={{ ...LBL, color: C.yellow + 'cc', marginBottom: '6px' }}>
                  🔑 الجواب السري للموقع الحقيقي *
                </label>
                <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '12px', color: C.dim, marginBottom: '8px', lineHeight: 1.5 }}>
                  الكلمة التي يجب أن يكتبها الفائز بعد سؤال الموظف — مثال: <strong style={{ color: '#fff' }}>"ساعة"</strong> أو <strong style={{ color: '#fff' }}>"شعار أحمر"</strong>
                </div>
                <input
                  value={form.secret_answer}
                  onChange={f('secret_answer')}
                  onFocus={ff} onBlur={fb}
                  placeholder='اكتب الجواب السري هنا — غير مرئي للاعبين'
                  style={{ ...FLD, borderColor: `${C.yellow}55`, color: C.yellow, fontWeight: 700 }}
                />
                <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '11px', color: C.dim, marginTop: '5px' }}>
                  ⚠ يُحفظ فقط في مستند الموقع الحقيقي — لا يظهر للاعبين
                </div>
              </div>

              {/* ── Dual Map Picker ── */}
              <div>
                <label style={{ ...LBL, marginBottom: '8px' }}>📍 تحديد المواقع على الخريطة *</label>

                {/* Mode selector buttons */}
                <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                  <button onClick={() => setPickMode('real')} style={{
                    flex: 1, padding: '9px 12px', cursor: 'pointer', borderRadius: '4px', fontFamily: 'Orbitron, sans-serif', fontSize: '9px', letterSpacing: '0.1em',
                    background: pickMode === 'real' ? `${C.yellow}22` : 'transparent',
                    border: pickMode === 'real' ? `2px solid ${C.yellow}` : `1px solid ${C.yellow}44`,
                    color: pickMode === 'real' ? C.yellow : C.dim,
                    boxShadow: pickMode === 'real' ? neon(C.yellow, 8) : 'none',
                  }}>
                    ⭐ تحديد الموقع الحقيقي
                    {form.realLat && <span style={{ display: 'block', fontFamily: 'monospace', fontSize: '8px', marginTop: '2px', color: C.yellow + '88' }}>{parseFloat(form.realLat).toFixed(4)}, {parseFloat(form.realLng).toFixed(4)}</span>}
                  </button>
                  <button onClick={() => setPickMode('fake')} style={{
                    flex: 1, padding: '9px 12px', cursor: 'pointer', borderRadius: '4px', fontFamily: 'Orbitron, sans-serif', fontSize: '9px', letterSpacing: '0.1em',
                    background: pickMode === 'fake' ? `${C.red}20` : 'transparent',
                    border: pickMode === 'fake' ? `2px solid ${C.red}` : `1px solid ${C.red}44`,
                    color: pickMode === 'fake' ? C.red : C.dim,
                    boxShadow: pickMode === 'fake' ? neon(C.red, 8) : 'none',
                  }}>
                    🎭 تحديد الموقع الوهمي
                    {form.fakeLat && <span style={{ display: 'block', fontFamily: 'monospace', fontSize: '8px', marginTop: '2px', color: C.red + '88' }}>{parseFloat(form.fakeLat).toFixed(4)}, {parseFloat(form.fakeLng).toFixed(4)}</span>}
                  </button>
                </div>

                <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '12px', color: C.dim, marginBottom: '6px', padding: '6px 10px', background: 'rgba(255,255,255,0.03)', borderRadius: '3px' }}>
                  {pickMode === 'real'
                    ? '▶ انقر على الخريطة أو اسحب Pin ⭐ الذهبي لتحديد المكان الحقيقي'
                    : '▶ انقر على الخريطة أو اسحب Pin 🎭 الأحمر لتحديد المكان الوهمي'}
                </div>

                {/* Map */}
                <div ref={mapContainerRef} style={{ width: '100%', height: '300px', borderRadius: '4px', border: `1px solid ${pickMode === 'real' ? C.yellow : C.red}55`, overflow: 'hidden', background: '#0a0d14', cursor: 'crosshair', boxShadow: `0 0 16px ${pickMode === 'real' ? C.yellow : C.red}18` }} />

                {/* Validation */}
                {(!form.realLat || !form.fakeLat) && (
                  <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '12px', color: C.red, marginTop: '5px' }}>
                    ⚠ {!form.realLat ? 'حدد الموقع الحقيقي ⭐' : 'حدد الموقع الوهمي 🎭'} على الخريطة
                  </div>
                )}
              </div>

              {/* Firestore info */}
              <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '8px', color: `${C.yellow}55`, letterSpacing: '0.1em', padding: '8px 10px', background: `${C.yellow}06`, border: `1px solid ${C.yellow}15`, borderRadius: '2px' }}>
                📂 bounties/&lt;pairId&gt;_real · bounties/&lt;pairId&gt;_fake — نفس pairId، نفس المكافآت، مواقع مختلفة
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', paddingTop: '4px' }}>
                <button onClick={() => setShowForm(false)} style={{ padding: '9px 20px', background: 'none', border: `1px solid ${C.border}`, color: C.dim, fontFamily: 'Orbitron, sans-serif', fontSize: '9px', letterSpacing: '0.1em', cursor: 'pointer', borderRadius: '3px' }}>إلغاء</button>
                <button onClick={save} disabled={saving} style={{ padding: '9px 22px', background: saving ? `${C.yellow}08` : `${C.yellow}18`, border: `1px solid ${C.yellow}88`, color: C.yellow, fontFamily: 'Orbitron, sans-serif', fontSize: '9px', letterSpacing: '0.1em', cursor: saving ? 'wait' : 'pointer', borderRadius: '3px', boxShadow: neon(C.yellow, 6), display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {saving
                    ? <><svg width="12" height="12" viewBox="0 0 28 28" fill="none" style={{ animation: 'spin 0.9s linear infinite' }}><circle cx="14" cy="14" r="10" stroke={C.yellow} strokeWidth="2.5" strokeDasharray="22 14" strokeLinecap="round"/></svg>جاري الإطلاق...</>
                    : '🚀 إطلاق المهمة المزدوجة'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Pairs Table ── */}
      {loading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '60px', color: C.dim }}>
          <svg width="22" height="22" viewBox="0 0 28 28" fill="none" style={{ animation: 'spin 0.9s linear infinite' }}><circle cx="14" cy="14" r="10" stroke={C.yellow} strokeWidth="2.5" strokeDasharray="22 14" strokeLinecap="round"/></svg>
          <span style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '11px', color: C.yellow }}>جاري التحميل...</span>
        </div>
      ) : pairList.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px', color: C.dim }}>
          <div style={{ fontSize: '44px', marginBottom: '12px' }}>⭐🎭</div>
          <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '11px', letterSpacing: '0.12em' }}>لا توجد مهمات مزدوجة بعد</div>
          <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '13px', marginTop: '6px' }}>اضغط "+ إطلاق مهمة كنز جديدة" للبدء</div>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'Rajdhani, sans-serif' }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                {['#','الراعي','🥇🥈🥉 الجوائز','⭐ الحقيقي','🎭 الوهمي','الفائزون','الحالة','إجراءات'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'Orbitron, sans-serif', fontSize: '8px', color: C.yellow, letterSpacing: '0.1em', whiteSpace: 'nowrap', background: `${C.yellow}06` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pairList.map((pair, idx) => {
                const isActive  = pair.status === 'active';
                const isDel     = confirmDel === pair.pairId;
                const rowBg     = idx % 2 === 0 ? 'transparent' : `${C.yellow}02`;
                const wCount    = pair.winners_log.length;
                return (
                  <tr key={pair.pairId}
                    style={{ borderBottom: `1px solid ${C.border}44`, background: rowBg, transition: 'background 0.15s', opacity: isActive ? 1 : 0.5 }}
                    onMouseEnter={e => (e.currentTarget.style.background = `${C.yellow}06`)}
                    onMouseLeave={e => (e.currentTarget.style.background = rowBg)}>

                    <td style={{ padding: '10px 12px', fontFamily: 'Orbitron, sans-serif', fontSize: '9px', color: `${C.yellow}55` }}>{idx + 1}</td>

                    <td style={{ padding: '10px 12px', minWidth: '120px' }}>
                      <div style={{ fontSize: '15px', fontWeight: 700, color: C.text }}>{pair.sponsor_name}</div>
                      <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '8px', color: C.dim, marginTop: '2px' }}>{pair.title}</div>
                    </td>

                    <td style={{ padding: '10px 12px', minWidth: '150px' }}>
                      <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '11px', color: '#FFD700' }}>🥇 {pair.first_reward || '—'}</div>
                      <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '11px', color: '#C0C0C0' }}>🥈 {pair.second_reward || '—'}</div>
                      <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '11px', color: '#CD7F32' }}>🥉 {pair.third_reward || '—'}</div>
                    </td>

                    <td style={{ padding: '10px 12px', fontFamily: 'Orbitron, sans-serif', fontSize: '9px', color: C.yellow, whiteSpace: 'nowrap' }}>
                      {pair.realDoc ? `${pair.realDoc.latitude.toFixed(4)},${pair.realDoc.longitude.toFixed(4)}` : '—'}
                    </td>

                    <td style={{ padding: '10px 12px', fontFamily: 'Orbitron, sans-serif', fontSize: '9px', color: C.red, whiteSpace: 'nowrap' }}>
                      {pair.fakeDoc ? `${pair.fakeDoc.latitude.toFixed(4)},${pair.fakeDoc.longitude.toFixed(4)}` : '—'}
                    </td>

                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <div style={{ display: 'flex', gap: '2px' }}>
                          {[0,1,2].map(i => (
                            <div key={i} style={{ width: '14px', height: '14px', borderRadius: '50%', background: i < wCount ? C.yellow : 'rgba(255,255,255,0.1)', border: `1px solid ${i < wCount ? C.yellow : 'rgba(255,255,255,0.15)'}`, boxShadow: i < wCount ? `0 0 6px ${C.yellow}88` : 'none' }} />
                          ))}
                        </div>
                        <span style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '9px', color: C.dim }}>{wCount}/3</span>
                      </div>
                    </td>

                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                      {isActive ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '4px 10px', background: `${C.green}14`, border: `1px solid ${C.green}55`, color: C.green, borderRadius: '3px', fontSize: '11px', fontWeight: 600 }}>
                          <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: C.green, boxShadow: `0 0 5px ${C.green}` }} />
                          نشطة
                        </span>
                      ) : pair.status === 'closed' ? (
                        <span style={{ padding: '4px 10px', background: `${C.yellow}10`, border: `1px solid ${C.yellow}44`, color: C.yellow, borderRadius: '3px', fontSize: '11px' }}>🏆 مكتملة</span>
                      ) : (
                        <span style={{ padding: '4px 10px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.15)', color: C.dim, borderRadius: '3px', fontSize: '11px' }}>⏰ منتهية</span>
                      )}
                    </td>

                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                      {isDel ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '12px', color: C.red }}>حذف الاثنين؟</span>
                          <button onClick={() => deletePair(pair)} style={{ padding: '4px 10px', background: `${C.red}18`, border: `1px solid ${C.red}`, color: C.red, fontFamily: 'Orbitron, sans-serif', fontSize: '8px', cursor: 'pointer', borderRadius: '2px' }}>نعم 🗑️</button>
                          <button onClick={() => setConfirmDel(null)} style={{ padding: '4px 10px', background: 'none', border: `1px solid ${C.border}`, color: C.dim, fontFamily: 'Orbitron, sans-serif', fontSize: '8px', cursor: 'pointer', borderRadius: '2px' }}>لا</button>
                        </div>
                      ) : (
                        <button onClick={() => setConfirmDel(pair.pairId)}
                          style={{ padding: '5px 12px', background: `${C.red}10`, border: `1px solid ${C.red}44`, color: C.red, fontFamily: 'Orbitron, sans-serif', fontSize: '8px', letterSpacing: '0.08em', cursor: 'pointer', borderRadius: '2px', transition: 'background 0.15s' }}
                          onMouseEnter={e => (e.currentTarget.style.background = `${C.red}20`)}
                          onMouseLeave={e => (e.currentTarget.style.background = `${C.red}10`)}>
                          🗑️ حذف الزوج
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════
          ── 🏆 Live Winners Log — يتحدث لحظة بلحظة من Firestore ─────────
      ══════════════════════════════════════════════════════════════════ */}
      {(() => {
        const activePair = pairList.find(p => p.status === 'active');
        if (!activePair) return null;

        const prizes = [activePair.first_reward, activePair.second_reward, activePair.third_reward];
        const medals = ['🥇', '🥈', '🥉'];
        const medalsColor = ['#FFD700', '#C0C0C0', '#CD7F32'];
        const log: any[] = activePair.winners_log ?? [];

        const fmtTime = (ts: any): string => {
          if (!ts) return '—';
          try {
            const d = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts);
            return d.toLocaleTimeString('ar-IQ', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          } catch { return '—'; }
        };

        return (
          <div style={{ marginTop: '28px', border: `1px solid ${C.yellow}33`, borderRadius: '6px', overflow: 'hidden', background: `${C.yellow}05` }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 16px', background: `${C.yellow}0e`, borderBottom: `1px solid ${C.yellow}22` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '10px', color: C.yellow, letterSpacing: '0.15em' }}>
                  🏆 أسماء الفائزين بـ مهمة ديالى GTA الحالية
                </span>
                <span style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '12px', color: C.dim }}>
                  — {activePair.sponsor_name}
                </span>
              </div>
              {/* Live pulse */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <div style={{ width: '7px', height: '7px', borderRadius: '50%', background: C.green, boxShadow: `0 0 8px ${C.green}`, animation: 'lf-ping 1.5s infinite' }} />
                <span style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '8px', color: C.green, letterSpacing: '0.1em' }}>LIVE</span>
                <span style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '12px', color: C.dim, marginRight: '4px' }}>{log.length}/3</span>
              </div>
            </div>

            {/* Body */}
            <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {log.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '22px 0', fontFamily: 'Rajdhani, sans-serif', fontSize: '15px', color: C.dim }}>
                  بانتظار وصول أول فائز للحفاظ على الحماس... ⏱️🔥
                </div>
              ) : (
                [0, 1, 2].map(i => {
                  const w = log.find((e: any) => e.rank === i + 1);
                  const color = medalsColor[i];
                  return (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'center', gap: '14px',
                      padding: '12px 16px',
                      background: w ? `${color}0c` : 'rgba(255,255,255,0.02)',
                      border: `1px solid ${w ? color + '44' : 'rgba(255,255,255,0.07)'}`,
                      borderRadius: '5px',
                      opacity: w ? 1 : 0.45,
                      transition: 'all 0.3s',
                    }}>
                      {/* Medal */}
                      <div style={{ fontSize: '26px', lineHeight: 1, minWidth: '32px', textAlign: 'center', filter: w ? 'none' : 'grayscale(1)' }}>
                        {medals[i]}
                      </div>
                      {/* Rank label */}
                      <div style={{ minWidth: '72px' }}>
                        <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '8px', color: w ? color : C.dim, letterSpacing: '0.1em' }}>
                          المركز {i === 0 ? 'الأول' : i === 1 ? 'الثاني' : 'الثالث'}
                        </div>
                        <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '11px', color: C.dim, marginTop: '2px' }}>
                          {prizes[i] || '—'}
                        </div>
                      </div>
                      {/* Winner info */}
                      <div style={{ flex: 1 }}>
                        {w ? (
                          <>
                            <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '17px', fontWeight: 700, color: '#e8f8f5', lineHeight: 1.1 }}>
                              {w.name || w.uid || 'مجهول'}
                            </div>
                            <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '8px', color: C.dim, marginTop: '3px', letterSpacing: '0.08em' }}>
                              ⏱ {fmtTime(w.claimedAt)}
                            </div>
                          </>
                        ) : (
                          <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '14px', color: 'rgba(255,255,255,0.2)' }}>
                            في الانتظار...
                          </div>
                        )}
                      </div>
                      {/* Prize badge */}
                      {w && (
                        <div style={{
                          padding: '5px 12px',
                          background: `${color}18`,
                          border: `1px solid ${color}55`,
                          color: color,
                          fontFamily: 'Rajdhani, sans-serif',
                          fontSize: '13px', fontWeight: 700,
                          borderRadius: '4px',
                          boxShadow: `0 0 10px ${color}33`,
                          whiteSpace: 'nowrap',
                        }}>
                          {prizes[i] || '🎁'}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        );
      })()}

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
  icon_url?:    string | null;
  isPremium?:   boolean;
  isAvailable?: boolean;
}

const QUEUE_LABELS: Record<QueueStatus, { label: string; color: string; emoji: string }> = {
  green:  { label: 'فارغة · تعبئة سريعة', color: '#00dc64', emoji: '🟢' },
  yellow: { label: 'ازدحام خفيف',          color: '#f5c518', emoji: '🟡' },
  red:    { label: 'مزدحمة · قافلة',       color: '#ff2d50', emoji: '🔴' },
};

const VALID_QUEUE: QueueStatus[] = ['green', 'yellow', 'red'];

/** Safely parse a Firestore fuel_stations doc — all fields null-guarded */
function parseFuelDoc(id: string, raw: Record<string, any>): FuelStation {
  return {
    id,
    name:        String(raw.name        ?? ''),
    address:     String(raw.address     ?? ''),
    latitude:    typeof raw.latitude  === 'number' ? raw.latitude  : parseFloat(String(raw.latitude  ?? '0')) || 0,
    longitude:   typeof raw.longitude === 'number' ? raw.longitude : parseFloat(String(raw.longitude ?? '0')) || 0,
    queue_status: VALID_QUEUE.includes(raw.queue_status) ? raw.queue_status as QueueStatus : 'green',
    icon_url:    raw.icon_url   ?? null,
    isPremium:   Boolean(raw.isPremium  ?? false),
    isAvailable: raw.isAvailable !== undefined ? Boolean(raw.isAvailable) : true,
  };
}

const EMPTY_FORM = { name: '', address: '', latitude: '', longitude: '', queue_status: 'green' as QueueStatus };

function FuelStationsTab({ toast }: { toast: ReturnType<typeof useToast> }) {
  const [stations,     setStations]     = useState<FuelStation[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [fsError,      setFsError]      = useState('');
  const [showForm,     setShowForm]     = useState(false);
  const [editing,      setEditing]      = useState<FuelStation | null>(null);
  const [form,         setForm]         = useState({ ...EMPTY_FORM });
  const [saving,       setSaving]       = useState(false);
  const [confirmDel,   setConfirmDel]   = useState<string | null>(null);
  // Icon upload state
  const [iconFile,        setIconFile]        = useState<File | null>(null);
  const [iconPreview,     setIconPreview]     = useState('');
  const [iconUploading,   setIconUploading]   = useState(false);
  const iconInputRef = useRef<HTMLInputElement>(null);

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

      // Voyager: shows all real POIs (mosques, schools, shops, streets) clearly
      L.tileLayer(
        'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        { subdomains: 'abc', maxZoom: 20, attribution: '© OpenStreetMap contributors' },
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

  // ── Live Firestore listener (null-safe parsing) ──────────────────────────
  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, 'fuel_stations'),
      snap => {
        try {
          const parsed = snap.docs.map(d => parseFuelDoc(d.id, d.data() as Record<string, any>));
          setStations(parsed);
          setFsError('');
        } catch (e: any) {
          console.error('[FuelStationsTab] parse error:', e);
          setFsError('حدث خطأ أثناء معالجة البيانات، يرجى تحديث الصفحة.');
        }
        setLoading(false);
      },
      err => {
        console.error('[FuelStationsTab] Firestore error:', err);
        setFsError('حدث خطأ أثناء جلب المحطات، يرجى تحديث الصفحة.');
        setLoading(false);
      }
    );
    return () => unsub();
  }, []);

  // ── Open add form ────────────────────────────────────────────────────────
  function openAdd() {
    setEditing(null);
    setForm({ ...EMPTY_FORM });
    setIconFile(null);
    setIconPreview('');
    setShowForm(true);
  }

  // ── Open edit form ───────────────────────────────────────────────────────
  function openEdit(s: FuelStation) {
    setEditing(s);
    setForm({ name: s.name, address: s.address ?? '', latitude: String(s.latitude ?? ''), longitude: String(s.longitude ?? ''), queue_status: s.queue_status });
    setIconFile(null);
    setIconPreview(s.icon_url ?? '');
    setShowForm(true);
  }

  // ── Icon file picker ─────────────────────────────────────────────────────
  function handleIconFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setIconFile(file);
    const reader = new FileReader();
    reader.onload = ev => setIconPreview(ev.target?.result as string);
    reader.readAsDataURL(file);
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
      // Upload icon if a new file was selected
      let iconUrl: string | null = editing?.icon_url ?? null;
      if (iconFile) {
        setIconUploading(true);
        const { ref: sRef, uploadBytes: uBytes, getDownloadURL: gUrl } = await import('firebase/storage');
        const path = `fuel_icons/${Date.now()}_${iconFile.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const fileRef = sRef(storage, path);
        await uBytes(fileRef, iconFile);
        iconUrl = await gUrl(fileRef);
        setIconUploading(false);
      }

      const payload: Record<string, any> = {
        name:         form.name.trim(),
        address:      form.address.trim(),
        latitude:     lat,
        longitude:    lng,
        queue_status: form.queue_status,
        icon_url:     iconUrl,
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
      setIconUploading(false);
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

              {/* ── Icon Upload ──────────────────────────────────────────── */}
              <div>
                <label style={LBL}>
                  🖼️ أيقونة المحطة (PNG مخصصة)
                  <span style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '11px', color: C.dim, fontWeight: 400, marginRight: '6px' }}>
                    — اختياري · يستبدل الأيقونة الافتراضية ⛽
                  </span>
                </label>
                <input
                  ref={iconInputRef}
                  type="file" accept="image/png,image/webp,image/jpeg"
                  onChange={handleIconFile}
                  style={{ display: 'none' }}
                />
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  {/* Preview box */}
                  <div
                    onClick={() => iconInputRef.current?.click()}
                    style={{
                      width: '64px', height: '64px', flexShrink: 0,
                      border: `2px dashed ${iconPreview ? C.yellow : C.border}`,
                      borderRadius: '6px', cursor: 'pointer', overflow: 'hidden',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: iconPreview ? 'transparent' : `${C.yellow}06`,
                      boxShadow: iconPreview ? `0 0 12px ${C.yellow}33` : 'none',
                      transition: 'all 0.2s',
                    }}
                    title="اختر صورة PNG"
                  >
                    {iconPreview
                      ? <img src={iconPreview} alt="preview" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                      : <span style={{ fontSize: '24px', opacity: 0.5 }}>⛽</span>
                    }
                  </div>
                  <div style={{ flex: 1 }}>
                    <button
                      type="button"
                      onClick={() => iconInputRef.current?.click()}
                      style={{
                        width: '100%', padding: '9px 14px',
                        background: `${C.yellow}10`, border: `1px solid ${C.yellow}55`,
                        color: C.yellow, fontFamily: 'Orbitron, sans-serif', fontSize: '9px',
                        letterSpacing: '0.1em', cursor: 'pointer', borderRadius: '3px',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                      }}
                    >
                      📂 {iconFile ? iconFile.name.slice(0, 24) + (iconFile.name.length > 24 ? '…' : '') : 'اختر صورة PNG'}
                    </button>
                    {iconPreview && (
                      <button
                        type="button"
                        onClick={() => { setIconFile(null); setIconPreview(''); if (iconInputRef.current) iconInputRef.current.value = ''; }}
                        style={{
                          marginTop: '6px', width: '100%', padding: '5px',
                          background: 'none', border: `1px solid ${C.red}44`,
                          color: C.red, fontFamily: 'Orbitron, sans-serif', fontSize: '8px',
                          cursor: 'pointer', borderRadius: '3px',
                        }}
                      >
                        🗑️ إزالة الأيقونة
                      </button>
                    )}
                  </div>
                </div>
                {iconUploading && (
                  <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '8px', color: C.yellow, fontFamily: 'Orbitron, sans-serif', fontSize: '9px' }}>
                    <svg width="12" height="12" viewBox="0 0 28 28" fill="none" style={{ animation: 'spin 0.9s linear infinite' }}>
                      <circle cx="14" cy="14" r="10" stroke={C.yellow} strokeWidth="2.5" strokeDasharray="22 14" strokeLinecap="round"/>
                    </svg>
                    جاري رفع الأيقونة إلى Firebase...
                  </div>
                )}
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
      ) : fsError ? (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: '14px', padding: '60px 20px',
          background: `${C.red}08`, border: `1px solid ${C.red}44`, borderRadius: '4px',
        }}>
          <div style={{ fontSize: '36px' }}>⚠️</div>
          <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '16px', color: C.red, fontWeight: 700, textAlign: 'center', direction: 'rtl' }}>
            {fsError}
          </div>
          <button
            onClick={() => { setFsError(''); setLoading(true); }}
            style={{ padding: '8px 20px', background: `${C.red}18`, border: `1px solid ${C.red}88`, color: C.red, fontFamily: 'Orbitron, sans-serif', fontSize: '9px', letterSpacing: '0.1em', cursor: 'pointer', borderRadius: '3px' }}
          >
            🔄 إعادة المحاولة
          </button>
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
                    <td style={{ padding: '10px 12px', fontFamily: 'Orbitron, sans-serif', fontSize: '9px', color: C.blue, whiteSpace: 'nowrap' }}>
                      {typeof s.latitude === 'number' && !isNaN(s.latitude) ? s.latitude.toFixed(4) : '—'}
                    </td>
                    {/* Lng */}
                    <td style={{ padding: '10px 12px', fontFamily: 'Orbitron, sans-serif', fontSize: '9px', color: C.blue, whiteSpace: 'nowrap' }}>
                      {typeof s.longitude === 'number' && !isNaN(s.longitude) ? s.longitude.toFixed(4) : '—'}
                    </td>
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

// ── Doctors Bookings Tab ──────────────────────────────────────────────────────
interface Appt {
  id: string;
  userName?: string;
  userId?: string;
  slot_time?: string;
  date?: string;
  isUserArrived?: boolean;
  arrivalMethod?: string;
  // Firestore Timestamp or null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  arrivalTime?: any;
}

// ── Generate 30-min slots in 24h string format ──────────────────────────────
function generateSlots(startPmH: number, endPmH: number): string[] {
  const slots: string[] = [];
  for (let h = startPmH; h <= endPmH; h++) {
    const h24 = h + 12; // e.g. 3 PM → 15
    slots.push(`${h24}:00`);
    if (h < endPmH) slots.push(`${h24}:30`);
  }
  return slots;
}

function DoctorCard({
  doctor,
  defaultOpen,
}: {
  doctor: Loc;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const [appts, setAppts] = useState<Appt[]>([]);
  const [loading, setLoading] = useState(false);

  // ── Slots editor state ────────────────────────────────────────────────────
  const [showSlots,   setShowSlots]   = useState(false);
  const [slotStart,   setSlotStart]   = useState(3);   // default 3 PM
  const [slotEnd,     setSlotEnd]     = useState(9);   // default 9 PM
  const [slotsSaving, setSlotsSaving] = useState(false);

  // ── Reset / delete state ──────────────────────────────────────────────────
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetting,        setResetting]        = useState(false);
  const [confirmDelAppt,   setConfirmDelAppt]   = useState<Appt | null>(null);
  const [deletingAppt,     setDeletingAppt]     = useState<string | null>(null);

  // ── Reset ALL appointments for this doctor ────────────────────────────────
  async function resetAllAppts() {
    setResetting(true);
    try {
      const batch = writeBatch(db);

      // 1) Delete from subcollection doctors/{id}/appointments (old storage path)
      const subColRef = collection(db, "doctors", String(doctor.id), "appointments");
      const subSnap   = await getDocs(subColRef);
      subSnap.forEach(d => batch.delete(d.ref));

      // 2) Collect the merchantId values we need to query against:
      //    - always include the numeric string fallback (e.g. "25")
      //    - include the Firebase UID if present in merchants/{id}.uid
      const merchantIdValues = new Set<string>([String(doctor.id)]);
      try {
        const mSnap = await getDoc(doc(db, "merchants", String(doctor.id)));
        if (mSnap.exists()) {
          const uid = mSnap.data()?.uid as string | undefined;
          if (uid) merchantIdValues.add(uid);
        }
      } catch { /* permission issue — proceed with numeric fallback only */ }

      // 3) Delete from top-level appointments for each merchantId value
      //    (Firestore `in` operator supports up to 30 values)
      const ids = Array.from(merchantIdValues);
      const topQ    = query(collection(db, "appointments"), where("merchantId", "in", ids));
      const topSnap = await getDocs(topQ);
      topSnap.forEach(d => batch.delete(d.ref));

      await batch.commit();
      setShowResetConfirm(false);
    } catch {
      // silent — user can retry
    } finally {
      setResetting(false);
    }
  }

  // ── Delete a single appointment ───────────────────────────────────────────
  async function deleteSingleAppt(appt: Appt) {
    setDeletingAppt(appt.id);
    try {
      await deleteDoc(
        doc(db, "doctors", String(doctor.id), "appointments", appt.id)
      );
      setConfirmDelAppt(null);
    } catch {
      // silent
    } finally {
      setDeletingAppt(null);
    }
  }

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const colRef = collection(db, "doctors", String(doctor.id), "appointments");
    const q = query(colRef, orderBy("date", "desc"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows: Appt[] = [];
        snap.forEach((d) =>
          rows.push({ id: d.id, ...(d.data() as Omit<Appt, "id">) })
        );
        // secondary sort by slot_time desc (string comparison works for HH:MM)
        rows.sort((a, b) => {
          const dateCmp = (b.date ?? "").localeCompare(a.date ?? "");
          if (dateCmp !== 0) return dateCmp;
          return (b.slot_time ?? "").localeCompare(a.slot_time ?? "");
        });
        setAppts(rows);
        setLoading(false);
      },
      () => setLoading(false)
    );
    return unsub;
  }, [open, doctor.id]);

  const gpsVerifiedAppts = appts.filter((a) => a.isUserArrived === true);
  const totalCommission  = gpsVerifiedAppts.length * 2000;

  // ── Save generated slots to Firestore ───────────────────────────────────
  const handleSaveSlots = async () => {
    if (slotStart >= slotEnd) return;
    setSlotsSaving(true);
    const slots = generateSlots(slotStart, slotEnd);
    try {
      await setDoc(
        doc(db, "merchants", String(doctor.id)),
        { available_slots: slots },
        { merge: true },
      );
      setShowSlots(false);
    } catch {
      // silent — toast not available here; user can retry
    }
    setSlotsSaving(false);
  };

  const pmHours = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

  return (
    <div style={{
      border: `1px solid ${open ? C.green : C.border}`,
      borderRadius: "5px",
      marginBottom: "10px",
      overflow: "visible",
      transition: "border-color 0.2s",
      boxShadow: open ? `0 0 16px ${C.green}18` : "none",
      position: "relative",
    }}>

      {/* ── Slots Editor Dialog ───────────────────────────────────────────── */}
      {showSlots && (
        <div
          onClick={() => setShowSlots(false)}
          style={{
            position: "fixed", inset: 0, zIndex: 9000,
            background: "rgba(5,8,15,0.82)", backdropFilter: "blur(6px)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#0d1117",
              border: `2px solid ${C.green}`,
              borderRadius: "8px",
              padding: "28px 28px 24px",
              minWidth: "320px", maxWidth: "400px",
              boxShadow: `0 0 40px ${C.green}22`,
              direction: "rtl",
            }}
          >
            {/* Title */}
            <div style={{
              fontFamily: "Orbitron, sans-serif", fontSize: "11px",
              color: C.green, letterSpacing: "0.12em", marginBottom: "6px",
            }}>⏱️ AUTO-GENERATE SLOTS</div>
            <div style={{
              fontFamily: "Rajdhani, sans-serif", fontSize: "17px",
              fontWeight: 700, color: C.text, marginBottom: "22px",
            }}>تحديد نطاق أوقات العيادة — {doctor.name}</div>

            {/* Start / End selects */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", marginBottom: "20px" }}>
              {/* Start */}
              <div>
                <label style={{ ...LBL, marginBottom: "6px" }}>🟢 وقت البدء (PM)</label>
                <select
                  value={slotStart}
                  onChange={(e) => setSlotStart(Number(e.target.value))}
                  style={{ ...FLD, cursor: "pointer" }}
                >
                  {pmHours.map((h) => (
                    <option key={h} value={h}>{h}:00 PM</option>
                  ))}
                </select>
              </div>
              {/* End */}
              <div>
                <label style={{ ...LBL, marginBottom: "6px" }}>🔴 وقت الانتهاء (PM)</label>
                <select
                  value={slotEnd}
                  onChange={(e) => setSlotEnd(Number(e.target.value))}
                  style={{ ...FLD, cursor: "pointer" }}
                >
                  {pmHours.map((h) => (
                    <option key={h} value={h}>{h}:00 PM</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Preview */}
            {slotStart < slotEnd && (
              <div style={{
                background: `${C.green}08`,
                border: `1px solid ${C.green}25`,
                borderRadius: "4px", padding: "10px 14px",
                marginBottom: "18px",
              }}>
                <div style={{
                  fontFamily: "Orbitron, sans-serif", fontSize: "9px",
                  color: C.dim, letterSpacing: "0.1em", marginBottom: "6px",
                }}>PREVIEW — {generateSlots(slotStart, slotEnd).length} موعد</div>
                <div style={{
                  fontFamily: "monospace", fontSize: "12px",
                  color: C.green, lineHeight: 1.8,
                  display: "flex", flexWrap: "wrap", gap: "6px",
                }}>
                  {generateSlots(slotStart, slotEnd).map((s) => (
                    <span key={s} style={{
                      background: `${C.green}12`,
                      border: `1px solid ${C.green}30`,
                      padding: "1px 7px", borderRadius: "2px", fontSize: "11px",
                    }}>{s}</span>
                  ))}
                </div>
              </div>
            )}

            {slotStart >= slotEnd && (
              <div style={{
                fontFamily: "Rajdhani, sans-serif", fontSize: "13px",
                color: C.red, marginBottom: "18px", textAlign: "center",
              }}>⚠️ وقت البدء يجب أن يكون أقل من وقت الانتهاء</div>
            )}

            {/* Action buttons */}
            <div style={{ display: "flex", gap: "10px" }}>
              <button
                onClick={handleSaveSlots}
                disabled={slotsSaving || slotStart >= slotEnd}
                style={{
                  flex: 1, padding: "11px",
                  background: slotsSaving || slotStart >= slotEnd
                    ? `${C.green}0a` : `${C.green}15`,
                  border: `1px solid ${slotsSaving || slotStart >= slotEnd
                    ? `${C.green}22` : `${C.green}66`}`,
                  color: slotsSaving || slotStart >= slotEnd ? C.dim : C.green,
                  fontFamily: "Orbitron, sans-serif", fontSize: "10px",
                  letterSpacing: "0.08em", cursor: slotsSaving || slotStart >= slotEnd
                    ? "not-allowed" : "pointer",
                  borderRadius: "4px",
                  boxShadow: slotsSaving ? "none" : `0 0 10px ${C.green}22`,
                  transition: "all 0.2s",
                }}
              >
                {slotsSaving ? "⏳ جاري الحفظ..." : "💾 حفظ الأوقات"}
              </button>
              <button
                onClick={() => setShowSlots(false)}
                style={{
                  padding: "11px 18px",
                  background: "rgba(255,45,120,0.08)",
                  border: "1px solid rgba(255,45,120,0.3)",
                  color: C.red, cursor: "pointer",
                  fontFamily: "Orbitron, sans-serif", fontSize: "10px",
                  letterSpacing: "0.08em", borderRadius: "4px",
                }}
              >✕ إلغاء</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Reset ALL appointments confirm dialog ── */}
      {showResetConfirm && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 700,
            background: "rgba(0,0,0,0.82)", backdropFilter: "blur(7px)",
            display: "flex", alignItems: "center", justifyContent: "center", padding: "16px",
          }}
          onClick={e => { if (e.target === e.currentTarget) setShowResetConfirm(false); }}
        >
          <div style={{
            width: "min(400px, 100%)", background: C.surface,
            border: `1px solid ${C.red}55`, borderRadius: "5px",
            boxShadow: `0 0 50px ${C.red}18, 0 8px 40px rgba(0,0,0,0.95)`,
            overflow: "hidden", direction: "rtl",
          }}>
            {/* Header */}
            <div style={{
              display: "flex", alignItems: "center", gap: "12px",
              padding: "16px 18px", borderBottom: `1px solid ${C.red}22`,
              background: `${C.red}07`,
            }}>
              <span style={{ fontSize: "22px" }}>⚠️</span>
              <div>
                <div style={{ fontFamily: "Orbitron, sans-serif", fontSize: "9px", color: C.red, letterSpacing: "0.14em" }}>
                  تصفير كافة الحجوزات
                </div>
                <div style={{ fontFamily: "Rajdhani, sans-serif", fontSize: "13px", color: C.text, marginTop: "3px" }}>
                  {doctor.name}
                </div>
              </div>
            </div>
            {/* Body */}
            <div style={{ padding: "20px 18px" }}>
              <div style={{
                fontFamily: "Rajdhani, sans-serif", fontSize: "15px",
                color: C.text, lineHeight: 1.7, marginBottom: "20px",
              }}>
                هل أنت متأكد من تصفير وحذف جميع حجوزات هذا الطبيب؟
                <br />
                <span style={{ color: C.red, fontSize: "13px" }}>
                  سيتم تحرير جميع السلوتات وتحويلها لـ&rdquo;متاح&rdquo; فوراً.
                </span>
              </div>
              <div style={{ display: "flex", gap: "10px" }}>
                <button
                  onClick={resetAllAppts}
                  disabled={resetting}
                  style={{
                    flex: 1, padding: "11px",
                    background: resetting ? `${C.red}08` : `${C.red}18`,
                    border: `1px solid ${resetting ? `${C.red}22` : `${C.red}66`}`,
                    color: resetting ? C.dim : C.red,
                    fontFamily: "Orbitron, sans-serif", fontSize: "10px",
                    letterSpacing: "0.08em", cursor: resetting ? "not-allowed" : "pointer",
                    borderRadius: "4px", transition: "all 0.18s",
                  }}
                >
                  {resetting ? "⏳ جاري الحذف..." : "🧹 تأكيد التصفير"}
                </button>
                <button
                  onClick={() => setShowResetConfirm(false)}
                  style={{
                    padding: "11px 18px",
                    background: "transparent",
                    border: `1px solid ${C.border}`,
                    color: C.dim, cursor: "pointer",
                    fontFamily: "Orbitron, sans-serif", fontSize: "10px",
                    letterSpacing: "0.08em", borderRadius: "4px",
                  }}
                >
                  إلغاء
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete single appointment confirm dialog ── */}
      {confirmDelAppt && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 700,
            background: "rgba(0,0,0,0.8)", backdropFilter: "blur(6px)",
            display: "flex", alignItems: "center", justifyContent: "center", padding: "16px",
          }}
          onClick={e => { if (e.target === e.currentTarget) setConfirmDelAppt(null); }}
        >
          <div style={{
            width: "min(380px, 100%)", background: C.surface,
            border: `1px solid ${C.red}44`, borderRadius: "5px",
            boxShadow: `0 0 40px ${C.red}14, 0 8px 40px rgba(0,0,0,0.95)`,
            overflow: "hidden", direction: "rtl",
          }}>
            <div style={{
              display: "flex", alignItems: "center", gap: "12px",
              padding: "14px 18px", borderBottom: `1px solid ${C.red}22`,
              background: `${C.red}06`,
            }}>
              <span style={{ fontSize: "20px" }}>🗑️</span>
              <span style={{ fontFamily: "Orbitron, sans-serif", fontSize: "9px", color: C.red, letterSpacing: "0.12em" }}>
                حذف حجز
              </span>
            </div>
            <div style={{ padding: "18px 18px" }}>
              <div style={{
                fontFamily: "Rajdhani, sans-serif", fontSize: "15px",
                color: C.text, lineHeight: 1.6, marginBottom: "18px",
              }}>
                حذف حجز{" "}
                <span style={{ color: C.yellow, fontWeight: 700 }}>
                  {confirmDelAppt.userName ?? "الزبون"}
                </span>
                {confirmDelAppt.date && (
                  <span style={{ color: C.dim }}>{" "}بتاريخ {confirmDelAppt.date}</span>
                )}
                {confirmDelAppt.slot_time && (
                  <span style={{ color: C.blue }}>{" "}الساعة {confirmDelAppt.slot_time}</span>
                )}
                ؟
              </div>
              <div style={{ display: "flex", gap: "10px" }}>
                <button
                  onClick={() => deleteSingleAppt(confirmDelAppt)}
                  disabled={deletingAppt === confirmDelAppt.id}
                  style={{
                    flex: 1, padding: "10px",
                    background: deletingAppt ? `${C.red}08` : `${C.red}16`,
                    border: `1px solid ${deletingAppt ? `${C.red}22` : `${C.red}55`}`,
                    color: deletingAppt ? C.dim : C.red,
                    fontFamily: "Orbitron, sans-serif", fontSize: "10px",
                    letterSpacing: "0.08em", cursor: deletingAppt ? "not-allowed" : "pointer",
                    borderRadius: "4px", transition: "all 0.18s",
                  }}
                >
                  {deletingAppt === confirmDelAppt.id ? "⏳ جاري الحذف..." : "🗑️ تأكيد الحذف"}
                </button>
                <button
                  onClick={() => setConfirmDelAppt(null)}
                  style={{
                    padding: "10px 16px", background: "transparent",
                    border: `1px solid ${C.border}`, color: C.dim,
                    cursor: "pointer", fontFamily: "Orbitron, sans-serif",
                    fontSize: "10px", borderRadius: "4px",
                  }}
                >
                  إلغاء
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Card Header ── */}
      <div
        style={{
          width: "100%", display: "flex", alignItems: "center",
          gap: "14px", padding: "14px 18px",
          background: open ? `${C.green}08` : C.surface,
          direction: "rtl", transition: "background 0.18s",
        }}
      >
        {/* Expand toggle area */}
        <div
          onClick={() => setOpen((v) => !v)}
          style={{ display: "flex", alignItems: "center", gap: "14px", flex: 1, cursor: "pointer" }}
        >
          {/* Expand icon */}
          <span style={{
            fontFamily: "Orbitron, sans-serif", fontSize: "14px",
            color: open ? C.green : C.dim,
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 0.2s", flexShrink: 0,
          }}>▶</span>

          {/* Doctor info */}
          <div style={{ flex: 1, textAlign: "right" }}>
            <div style={{
              fontFamily: "Rajdhani, sans-serif", fontSize: "15px", fontWeight: 700,
              color: C.text,
            }}>{doctor.name}</div>
            {doctor.details && (
              <div style={{
                fontFamily: "Rajdhani, sans-serif", fontSize: "12px",
                color: C.dim, marginTop: "2px",
              }}>{doctor.details}</div>
            )}
          </div>
        </div>

        {/* Edit slots button */}
        <button
          onClick={(e) => { e.stopPropagation(); setShowSlots(true); }}
          title="تعديل الأوقات المتاحة"
          style={{
            display: "flex", flexDirection: "column", alignItems: "center",
            padding: "6px 12px",
            background: `${C.blue}10`,
            border: `1px solid ${C.blue}33`,
            borderRadius: "4px", flexShrink: 0, cursor: "pointer",
            transition: "all 0.2s",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = `${C.blue}22`)}
          onMouseLeave={(e) => (e.currentTarget.style.background = `${C.blue}10`)}
        >
          <span style={{ fontSize: "16px", lineHeight: 1 }}>⏱️</span>
          <span style={{
            fontFamily: "Orbitron, sans-serif", fontSize: "8px",
            color: C.blue, marginTop: "3px", whiteSpace: "nowrap", letterSpacing: "0.06em",
          }}>الأوقات</span>
        </button>

        {/* Reset all appointments button */}
        <button
          onClick={(e) => { e.stopPropagation(); setShowResetConfirm(true); }}
          title="تصفير كافة الحجوزات"
          style={{
            display: "flex", flexDirection: "column", alignItems: "center",
            padding: "6px 12px",
            background: `${C.red}0a`,
            border: `1px solid ${C.red}33`,
            borderRadius: "4px", flexShrink: 0, cursor: "pointer",
            transition: "all 0.2s",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = `${C.red}1a`)}
          onMouseLeave={(e) => (e.currentTarget.style.background = `${C.red}0a`)}
        >
          <span style={{ fontSize: "15px", lineHeight: 1 }}>🧹</span>
          <span style={{
            fontFamily: "Orbitron, sans-serif", fontSize: "7px",
            color: C.red, marginTop: "3px", whiteSpace: "nowrap", letterSpacing: "0.05em",
          }}>تصفير</span>
        </button>

        {/* Bookings counter */}
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center",
          padding: "6px 14px",
          background: `rgba(0,212,255,0.10)`,
          border: `1px solid rgba(0,212,255,0.20)`,
          borderRadius: "4px", flexShrink: 0,
        }}>
          <span style={{
            fontFamily: "Orbitron, sans-serif", fontSize: "16px", fontWeight: 700,
            color: C.blue, lineHeight: 1,
          }}>{appts.length}</span>
          <span style={{
            fontFamily: "Rajdhani, sans-serif", fontSize: "10px",
            color: C.dim, marginTop: "2px",
          }}>📈 حجز</span>
        </div>

        {/* Commission badge */}
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center",
          padding: "6px 14px",
          background: `${C.yellow}10`,
          border: `1px solid ${C.yellow}33`,
          borderRadius: "4px", flexShrink: 0,
        }}>
          <span style={{
            fontFamily: "Orbitron, sans-serif", fontSize: "15px", fontWeight: 700,
            color: C.yellow, lineHeight: 1, whiteSpace: "nowrap",
          }}>{totalCommission.toLocaleString()}</span>
          <span style={{
            fontFamily: "Rajdhani, sans-serif", fontSize: "10px",
            color: C.dim, marginTop: "2px", whiteSpace: "nowrap",
          }}>💰 عمولة د.ع</span>
        </div>
      </div>

      {/* ── Appointments Sub-Table ── */}
      {open && (
        <div style={{ borderTop: `1px solid ${C.border}` }}>
          {loading ? (
            <div style={{
              padding: "32px", textAlign: "center",
              fontFamily: "Orbitron, sans-serif", fontSize: "10px",
              color: C.dim, letterSpacing: "0.1em",
            }}>LOADING...</div>
          ) : appts.length === 0 ? (
            <div style={{
              padding: "28px", textAlign: "center",
              fontFamily: "Rajdhani, sans-serif", fontSize: "14px",
              color: C.dim,
            }}>لا توجد حجوزات لهذا الطبيب حتى الآن</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{
                width: "100%", borderCollapse: "collapse",
                fontFamily: "Rajdhani, sans-serif",
              }}>
                <thead>
                  <tr style={{
                    background: `${C.green}08`,
                    borderBottom: `1px solid ${C.border}`,
                  }}>
                    {["#", "اسم الزبون", "معرّف الزبون (UID)", "وقت الحجز", "تاريخ اليوم", "التحقق الجغرافي / الاستقطاع", ""].map((h) => (
                      <th key={h} style={{
                        padding: "9px 12px", textAlign: "right",
                        fontSize: "9px", color: C.green,
                        fontFamily: "Orbitron, sans-serif", letterSpacing: "0.07em",
                        whiteSpace: "nowrap",
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {appts.map((ap, i) => (
                    <tr key={ap.id}
                      style={{ borderBottom: `1px solid rgba(123,47,247,0.07)` }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = `${C.green}05`)}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      <td style={{ padding: "9px 12px", color: C.dim, fontSize: "12px" }}>
                        {i + 1}
                      </td>
                      <td style={{ padding: "9px 12px", color: C.text, fontSize: "14px", fontWeight: 600 }}>
                        {ap.userName ?? "—"}
                      </td>
                      <td style={{
                        padding: "9px 12px", fontFamily: "monospace",
                        fontSize: "11px", color: C.dim,
                        maxWidth: "160px", overflow: "hidden",
                        textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}>
                        {ap.userId ?? "—"}
                      </td>
                      <td style={{
                        padding: "9px 12px", fontFamily: "Orbitron, sans-serif",
                        fontSize: "12px", color: C.blue, whiteSpace: "nowrap",
                      }}>
                        {ap.slot_time ?? "—"}
                      </td>
                      <td style={{
                        padding: "9px 12px", fontFamily: "Rajdhani, sans-serif",
                        fontSize: "13px", color: C.dim, whiteSpace: "nowrap",
                      }}>
                        {ap.date ?? "—"}
                      </td>
                      <td style={{ padding: "9px 6px", whiteSpace: "nowrap" }}>
                        {ap.isUserArrived ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
                            <span style={{
                              display: "inline-flex", alignItems: "center", gap: "5px",
                              padding: "3px 10px",
                              background: "rgba(0,245,212,0.10)",
                              border: "1px solid rgba(0,245,212,0.5)",
                              borderRadius: "3px",
                              fontFamily: "Rajdhani, sans-serif", fontSize: "13px", fontWeight: 700,
                              color: C.green,
                              boxShadow: "0 0 8px rgba(0,245,212,0.2)",
                            }}>
                              مؤكد بالـ GPS 🛰️✅
                            </span>
                            {ap.arrivalTime?.toDate && (
                              <span style={{
                                fontFamily: "Orbitron, sans-serif", fontSize: "9px",
                                color: C.dim, letterSpacing: "0.05em", paddingRight: "2px",
                              }}>
                                {(ap.arrivalTime.toDate() as Date).toLocaleTimeString("ar-IQ", {
                                  hour: "2-digit", minute: "2-digit",
                                })}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span style={{
                            display: "inline-flex", alignItems: "center", gap: "5px",
                            padding: "3px 10px",
                            background: "rgba(255,255,255,0.03)",
                            border: "1px solid rgba(255,255,255,0.10)",
                            borderRadius: "3px",
                            fontFamily: "Rajdhani, sans-serif", fontSize: "12px", fontWeight: 500,
                            color: C.dim,
                          }}>
                            حجز مسجل — لم يُرصد حضور جغرافي
                          </span>
                        )}
                      </td>

                      {/* ── Trash (delete single) ── */}
                      <td style={{ padding: "9px 10px", textAlign: "center" }}>
                        <button
                          onClick={() => setConfirmDelAppt(ap)}
                          disabled={deletingAppt === ap.id}
                          title={`حذف حجز ${ap.userName ?? ""}`}
                          style={{
                            background: `${C.red}0c`,
                            border: `1px solid ${C.red}33`,
                            borderRadius: "4px",
                            padding: "5px 8px",
                            cursor: deletingAppt === ap.id ? "not-allowed" : "pointer",
                            color: C.red,
                            fontSize: "14px",
                            lineHeight: 1,
                            transition: "all 0.15s",
                            opacity: deletingAppt === ap.id ? 0.4 : 1,
                          }}
                          onMouseEnter={e => (e.currentTarget.style.background = `${C.red}20`)}
                          onMouseLeave={e => (e.currentTarget.style.background = `${C.red}0c`)}
                        >
                          {deletingAppt === ap.id ? "⏳" : "🗑️"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Summary footer */}
              <div style={{
                display: "flex", flexWrap: "wrap", justifyContent: "flex-end",
                gap: "20px", padding: "10px 18px",
                borderTop: `1px solid ${C.border}`,
                background: `${C.yellow}05`,
                direction: "rtl",
              }}>
                {/* Total bookings */}
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <span style={{ fontFamily: "Rajdhani, sans-serif", fontSize: "13px", color: C.dim }}>
                    إجمالي الحجوزات:
                  </span>
                  <span style={{ fontFamily: "Orbitron, sans-serif", fontSize: "13px", color: C.blue, fontWeight: 700 }}>
                    {appts.length} حجز
                  </span>
                </div>

                {/* GPS-verified count */}
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <span style={{ fontFamily: "Rajdhani, sans-serif", fontSize: "13px", color: C.dim }}>
                    مؤكد بـ GPS 🛰️:
                  </span>
                  <span style={{
                    fontFamily: "Orbitron, sans-serif", fontSize: "13px", fontWeight: 700,
                    color: gpsVerifiedAppts.length > 0 ? C.green : C.dim,
                  }}>
                    {gpsVerifiedAppts.length} / {appts.length}
                  </span>
                </div>

                {/* Guaranteed commission (GPS only) */}
                <div style={{
                  display: "flex", alignItems: "center", gap: "6px",
                  paddingRight: "14px",
                  borderRight: `2px solid ${C.yellow}44`,
                }}>
                  <span style={{ fontFamily: "Rajdhani, sans-serif", fontSize: "13px", color: C.dim }}>
                    العمولة المضمونة:
                  </span>
                  <span style={{
                    fontFamily: "Orbitron, sans-serif", fontSize: "14px", fontWeight: 700,
                    color: C.yellow,
                    textShadow: totalCommission > 0 ? `0 0 10px ${C.yellow}66` : "none",
                  }}>
                    {totalCommission.toLocaleString()} د.ع
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DoctorsBookingsTab({ toast }: { toast: ReturnType<typeof useToast> }) {
  const [doctors, setDoctors] = useState<Loc[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    // ── Query Firestore merchants collection for category == 'doctor' ────────
    getDocs(
      query(
        collection(db, "merchants"),
        where("category", "==", "doctor"),
      )
    ).then((snap) => {
      const doctorLocs: Loc[] = snap.docs.map((d) => {
        const data = d.data();
        return {
          id:       parseInt(d.id, 10) || 0,
          name:     String(data.name     ?? "—"),
          category: String(data.category ?? "doctor"),
          details:  String(data.details  ?? ""),
          address:  String(data.address  ?? ""),
          phone:    String(data.phone    ?? ""),
          hours:    String(data.hours    ?? ""),
          status:   String(data.status   ?? "مفتوح"),
          lat:      Number(data.lat      ?? 0),
          lng:      Number(data.lng      ?? 0),
        };
      });
      setDoctors(doctorLocs);
      setLoading(false);
    }).catch(() => {
      toast.show("فشل تحميل الأطباء", false);
      setLoading(false);
    });
  }, []);

  const filtered = doctors.filter(
    (d) =>
      !search ||
      d.name.includes(search) ||
      (d.details ?? "").includes(search)
  );

  return (
    <div>
      {/* ── Header bar ── */}
      <div style={{
        display: "flex", alignItems: "center", flexWrap: "wrap",
        gap: "12px", marginBottom: "18px",
      }}>
        <div>
          <div style={{
            fontFamily: "Orbitron, sans-serif", fontSize: "12px",
            color: C.green, letterSpacing: "0.12em",
            textShadow: neon(C.green, 8),
          }}>🏥 DOCTORS BOOKINGS</div>
          <div style={{
            fontFamily: "Rajdhani, sans-serif", fontSize: "13px",
            color: C.dim, marginTop: "3px",
          }}>متابعة الحجوزات والعمولات لكل طبيب</div>
        </div>

        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="بحث باسم الطبيب أو التخصص..."
          style={{ ...FLD, maxWidth: "260px", flex: 1 }}
          onFocus={ff} onBlur={fb}
        />

        <span style={{
          fontFamily: "Orbitron, sans-serif", fontSize: "10px", color: C.dim,
        }}>{filtered.length} طبيب</span>
      </div>

      {/* ── Summary strip ── */}
      <div style={{
        display: "flex", gap: "12px", flexWrap: "wrap",
        marginBottom: "18px",
      }}>
        {[
          { label: "إجمالي الأطباء", value: String(filtered.length), color: C.purple },
          { label: "معادلة العمولة", value: "عدد الحجوزات × 2,000 د.ع", color: C.yellow },
        ].map(({ label, value, color }) => (
          <div key={label} style={{
            flex: 1, minWidth: "180px",
            padding: "12px 16px",
            background: `${color}08`,
            border: `1px solid ${color}28`,
            borderRadius: "5px",
          }}>
            <div style={{
              fontFamily: "Orbitron, sans-serif", fontSize: "9px",
              color: `${color}99`, letterSpacing: "0.1em", marginBottom: "5px",
            }}>{label}</div>
            <div style={{
              fontFamily: "Orbitron, sans-serif", fontSize: "14px",
              fontWeight: 700, color,
            }}>{value}</div>
          </div>
        ))}
      </div>

      {/* ── Doctor cards ── */}
      {loading ? (
        <div style={{
          textAlign: "center", padding: "60px",
          fontFamily: "Orbitron, sans-serif", fontSize: "11px",
          color: C.dim, letterSpacing: "0.1em",
        }}>LOADING DOCTORS...</div>
      ) : filtered.length === 0 ? (
        <div style={{
          textAlign: "center", padding: "48px",
          fontFamily: "Rajdhani, sans-serif", fontSize: "15px", color: C.dim,
        }}>
          {search ? "لا توجد نتائج للبحث" : "لا يوجد أطباء مضافون بالنظام"}
        </div>
      ) : (
        filtered.map((doctor) => (
          <DoctorCard key={doctor.id} doctor={doctor} />
        ))
      )}
    </div>
  );
}

// ── Users Radar Tab ───────────────────────────────────────────────────────────
interface RadarUser {
  id:         string;
  name?:      string;
  phone?:     string;
  latitude:   number;
  longitude:  number;
  last_seen?: { toDate: () => Date } | null;
}

function UsersRadarTab() {
  const mapContainer  = useRef<HTMLDivElement>(null);
  const mapRef        = useRef<L.Map | null>(null);
  const markerRef     = useRef<L.Marker | null>(null);   // single tracked marker
  const liveUnsubRef  = useRef<(() => void) | null>(null);

  const [phoneInput,   setPhoneInput]   = useState('');
  const [searching,    setSearching]    = useState(false);
  const [notFound,     setNotFound]     = useState(false);
  const [trackedUser,  setTrackedUser]  = useState<RadarUser | null>(null);
  const [isTracking,   setIsTracking]   = useState(false);

  // ── Init Leaflet map once ────────────────────────────────────────────────
  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;
    const map = L.map(mapContainer.current, {
      center: [33.7451, 44.6488], zoom: 11, zoomControl: true,
    });
    L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      { attribution: '©OpenStreetMap ©CartoDB', subdomains: 'abcd', maxZoom: 19 }
    ).addTo(map);
    mapRef.current = map;
    return () => {
      liveUnsubRef.current?.();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // ── Build / update the single marker ────────────────────────────────────
  const placeMarker = (u: RadarUser, flyToIt: boolean) => {
    const map = mapRef.current;
    if (!map) return;

    const popupHtml = `
      <div style="background:#0d1117;padding:10px 13px;direction:rtl;min-width:175px;
        border:1px solid #00d4ff44;border-radius:4px">
        <div style="font-family:Orbitron,sans-serif;font-size:9px;color:#00d4ff88;
          letter-spacing:0.1em;margin-bottom:4px">📡 LIVE TRACKING</div>
        <div style="font-family:Rajdhani,sans-serif;font-size:15px;font-weight:700;
          color:#e8f8ff;margin-bottom:2px">${u.name}</div>
        <div style="font-family:monospace;font-size:12px;color:#00f5d4">${u.phone}</div>
        <div style="font-family:monospace;font-size:10px;color:#ffffff44;margin-top:5px">
          ${u.latitude.toFixed(6)}, ${u.longitude.toFixed(6)}</div>
        <div style="font-family:Rajdhani,sans-serif;font-size:11px;color:#ffffff55;margin-top:3px">
          ${u.last_seen?.toDate
            ? (() => { try { const d = u.last_seen!.toDate!(); return d.toLocaleDateString('ar-IQ') + ' · ' + d.toLocaleTimeString('ar-IQ', { hour: '2-digit', minute: '2-digit' }); } catch { return '—'; } })()
            : '—'}
        </div>
      </div>`;

    if (markerRef.current) {
      markerRef.current.setLatLng([u.latitude, u.longitude]);
      (markerRef.current as L.Marker & { _popup?: L.Popup }).getPopup()?.setContent(popupHtml);
    } else {
      const icon = L.divIcon({
        className: '',
        html: `<div style="position:relative;display:flex;flex-direction:column;align-items:center">
          <div style="position:absolute;inset:-10px;border-radius:50%;border:2.5px solid #00d4ff;
            opacity:0.5;animation:lf-ping 1.8s cubic-bezier(0,0,0.2,1) infinite"></div>
          <div style="width:36px;height:36px;border-radius:50%;background:rgba(0,212,255,0.18);
            border:2.5px solid #00d4ff;display:flex;align-items:center;justify-content:center;
            box-shadow:0 0 20px #00d4ff88;position:relative;z-index:1;font-size:18px">👤</div>
          <div style="background:rgba(0,212,255,0.2);border:1px solid rgba(0,212,255,0.5);
            color:#00d4ff;font-family:Orbitron,sans-serif;font-size:7px;padding:2px 7px;
            white-space:nowrap;letter-spacing:0.1em;margin-top:2px">LIVE</div>
        </div>`,
        iconSize: [36, 58], iconAnchor: [18, 58],
      });
      markerRef.current = L.marker([u.latitude, u.longitude], { icon })
        .addTo(map)
        .bindPopup(popupHtml, { closeButton: false, offset: [0, -12] })
        .openPopup();
    }

    if (flyToIt) {
      map.flyTo([u.latitude, u.longitude], 16, { animate: true, duration: 1.2 });
    }
  };

  // ── Stop current tracking session ────────────────────────────────────────
  const stopTracking = () => {
    liveUnsubRef.current?.();
    liveUnsubRef.current = null;
    markerRef.current?.remove();
    markerRef.current = null;
    setTrackedUser(null);
    setIsTracking(false);
    setNotFound(false);
  };

  // ── Search + start live listener ─────────────────────────────────────────
  const handleSearch = async () => {
    const phone = phoneInput.trim();
    if (!phone) return;

    stopTracking();
    setSearching(true);
    setNotFound(false);

    try {
      // 1. Find the user document by phone
      const snap = await getDocs(
        query(collection(db, 'users'), where('phone', '==', phone))
      );

      if (snap.empty) {
        setNotFound(true);
        setSearching(false);
        return;
      }

      const docSnap = snap.docs[0];
      const data    = docSnap.data() as Record<string, unknown>;

      // Check for location fields
      if (typeof data.latitude !== 'number' || typeof data.longitude !== 'number') {
        setNotFound(true);
        setSearching(false);
        return;
      }

      setSearching(false);
      setIsTracking(true);

      // 2. Attach live listener on that specific document
      liveUnsubRef.current = onSnapshot(
        doc(db, 'users', docSnap.id),
        (d) => {
          if (!d.exists()) return;
          const dd = d.data() as Record<string, unknown>;
          if (typeof dd.latitude !== 'number' || typeof dd.longitude !== 'number') return;
          const u: RadarUser = {
            id:        d.id,
            name:      (dd.name || dd.displayName || dd.userName || '—') as string,
            phone:     (dd.phone || dd.phoneNumber || '—') as string,
            latitude:  dd.latitude,
            longitude: dd.longitude,
            last_seen: dd.last_seen as RadarUser['last_seen'],
          };
          setTrackedUser(u);
          // flyTo only on first update; subsequent updates just move the marker
          placeMarker(u, !markerRef.current);
        },
        () => { setIsTracking(false); }
      );
    } catch {
      setNotFound(true);
      setSearching(false);
    }
  };

  const fmtLastSeen = (ts: RadarUser['last_seen']) => {
    if (!ts?.toDate) return '—';
    try {
      const d = ts.toDate();
      return d.toLocaleDateString('ar-IQ') + ' · ' +
             d.toLocaleTimeString('ar-IQ', { hour: '2-digit', minute: '2-digit' });
    } catch { return '—'; }
  };

  return (
    <div>
      {/* ── Header ── */}
      <div style={{ marginBottom: '18px' }}>
        <div style={{
          fontFamily: 'Orbitron, sans-serif', fontSize: '10px',
          color: C.blue, letterSpacing: '0.15em', marginBottom: '3px',
        }}>📡 USERS RADAR — رادار المستخدمين</div>
        <div style={{
          fontFamily: 'Rajdhani, sans-serif', fontSize: '13px', color: C.dim,
        }}>ابحث برقم الهاتف لبدء التتبع الحي للموقع عبر Firestore</div>
      </div>

      {/* ── Search Bar ── */}
      <div style={{
        display: 'flex', gap: '10px', alignItems: 'stretch',
        marginBottom: '18px', flexWrap: 'wrap',
      }}>
        <div style={{ flex: 1, minWidth: '220px', position: 'relative' }}>
          <span style={{
            position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)',
            fontSize: '16px', pointerEvents: 'none',
          }}>📱</span>
          <input
            type="tel"
            placeholder="أدخل رقم هاتف المستخدم للرصد لايف"
            value={phoneInput}
            onChange={e => { setPhoneInput(e.target.value); setNotFound(false); }}
            onKeyDown={e => { if (e.key === 'Enter') handleSearch(); }}
            style={{
              ...FLD,
              paddingRight: '38px',
              width: '100%',
              direction: 'rtl',
              fontSize: '14px',
            }}
          />
        </div>

        <button
          onClick={handleSearch}
          disabled={searching || !phoneInput.trim()}
          style={{
            padding: '0 22px',
            background: searching || !phoneInput.trim()
              ? `${C.blue}0a` : `${C.blue}18`,
            border: `1px solid ${searching || !phoneInput.trim()
              ? `${C.blue}22` : `${C.blue}66`}`,
            color: searching || !phoneInput.trim() ? C.dim : C.blue,
            fontFamily: 'Orbitron, sans-serif', fontSize: '10px',
            letterSpacing: '0.08em', cursor: searching || !phoneInput.trim()
              ? 'not-allowed' : 'pointer',
            borderRadius: '4px', whiteSpace: 'nowrap',
            boxShadow: searching ? 'none' : `0 0 10px ${C.blue}22`,
            transition: 'all 0.2s',
            display: 'flex', alignItems: 'center', gap: '7px',
          }}
        >
          {searching
            ? <><div style={{ width: '12px', height: '12px', border: `2px solid ${C.blue}33`, borderTop: `2px solid ${C.blue}`, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />جاري البحث...</>
            : <>🔍 بحث ورصد</>}
        </button>

        {isTracking && (
          <button
            onClick={stopTracking}
            style={{
              padding: '0 16px',
              background: `${C.red}10`, border: `1px solid ${C.red}44`,
              color: C.red, fontFamily: 'Orbitron, sans-serif', fontSize: '9px',
              letterSpacing: '0.08em', cursor: 'pointer', borderRadius: '4px',
              whiteSpace: 'nowrap', transition: 'all 0.2s',
            }}
          >✕ إيقاف التتبع</button>
        )}
      </div>

      {/* ── Not Found Alert ── */}
      {notFound && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '10px',
          padding: '12px 16px', marginBottom: '16px',
          background: `${C.yellow}0c`, border: `1px solid ${C.yellow}40`,
          borderRadius: '5px', direction: 'rtl',
        }}>
          <span style={{ fontSize: '18px' }}>⚠️</span>
          <div>
            <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '14px', fontWeight: 600, color: C.yellow }}>
              لم يتم رصد موقع لهذا الرقم حالياً
            </div>
            <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '12px', color: C.dim, marginTop: '2px' }}>
              تأكد من أن المستخدم سمح بمشاركة الموقع وأن رقم الهاتف مسجَّل بالضبط
            </div>
          </div>
        </div>
      )}

      {/* ── Live Status Badge ── */}
      {isTracking && trackedUser && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '8px',
          padding: '8px 14px', marginBottom: '14px',
          background: `${C.green}0a`, border: `1px solid ${C.green}30`,
          borderRadius: '4px',
        }}>
          <div style={{
            width: '8px', height: '8px', borderRadius: '50%',
            background: C.green, boxShadow: `0 0 8px ${C.green}`,
            animation: 'lf-ping 1.8s cubic-bezier(0,0,0.2,1) infinite', flexShrink: 0,
          }} />
          <span style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '9px', color: C.green, letterSpacing: '0.1em' }}>
            LIVE TRACKING ACTIVE
          </span>
          <span style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '13px', color: C.text }}>
            — {trackedUser.name} ({trackedUser.phone})
          </span>
        </div>
      )}

      {/* ── Map ── */}
      <div style={{
        border: `1px solid ${isTracking ? `${C.blue}55` : `${C.border}`}`,
        borderRadius: '6px', overflow: 'hidden', marginBottom: '18px',
        boxShadow: isTracking ? `0 0 28px ${C.blue}18` : 'none',
        position: 'relative', transition: 'border-color 0.3s, box-shadow 0.3s',
      }}>
        {!isTracking && !trackedUser && (
          <div style={{
            position: 'absolute', inset: 0, zIndex: 500,
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            background: 'rgba(5,8,15,0.72)', backdropFilter: 'blur(4px)',
            gap: '10px', pointerEvents: 'none',
          }}>
            <span style={{ fontSize: '36px' }}>📡</span>
            <div style={{
              fontFamily: 'Orbitron, sans-serif', fontSize: '10px',
              color: C.dim, letterSpacing: '0.14em',
            }}>أدخل رقم الهاتف وابدأ الرصد</div>
          </div>
        )}
        <div ref={mapContainer} style={{ height: '440px', width: '100%' }} />
      </div>

      {/* ── Tracked User Card ── */}
      {trackedUser && (
        <div style={{
          border: `1px solid ${C.blue}33`, borderRadius: '6px', overflow: 'hidden',
        }}>
          <div style={{
            padding: '10px 16px', background: C.surface,
            borderBottom: `1px solid ${C.border}`,
          }}>
            <span style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '9px', color: C.blue, letterSpacing: '0.12em' }}>
              TRACKED USER DETAILS
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'Rajdhani, sans-serif' }}>
              <thead>
                <tr style={{ background: `${C.blue}07`, borderBottom: `1px solid ${C.border}` }}>
                  {['الاسم', 'الهاتف', 'خط العرض', 'خط الطول', 'آخر ظهور', 'الإجراءات'].map(h => (
                    <th key={h} style={{
                      padding: '8px 12px', textAlign: 'right',
                      fontFamily: 'Orbitron, sans-serif', fontSize: '8px',
                      color: C.blue, letterSpacing: '0.1em', fontWeight: 700,
                      whiteSpace: 'nowrap',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                  {/* Name */}
                  <td style={{ padding: '12px 12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <div style={{
                        width: '30px', height: '30px', borderRadius: '50%', flexShrink: 0,
                        background: `${C.blue}12`, border: `1px solid ${C.blue}40`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: '14px',
                      }}>👤</div>
                      <span style={{ fontSize: '15px', fontWeight: 600, color: C.text }}>
                        {trackedUser.name}
                      </span>
                    </div>
                  </td>
                  {/* Phone */}
                  <td style={{ padding: '12px 12px', color: C.green, fontFamily: 'monospace', fontSize: '13px' }}>
                    {trackedUser.phone}
                  </td>
                  {/* Lat */}
                  <td style={{ padding: '12px 12px', fontFamily: 'monospace', fontSize: '12px', color: C.dim }}>
                    {trackedUser.latitude.toFixed(6)}
                  </td>
                  {/* Lng */}
                  <td style={{ padding: '12px 12px', fontFamily: 'monospace', fontSize: '12px', color: C.dim }}>
                    {trackedUser.longitude.toFixed(6)}
                  </td>
                  {/* Last seen */}
                  <td style={{ padding: '12px 12px', fontSize: '12px', color: C.dim, whiteSpace: 'nowrap' }}>
                    {fmtLastSeen(trackedUser.last_seen)}
                  </td>
                  {/* Actions */}
                  <td style={{ padding: '12px 12px' }}>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      {/* Re-center map */}
                      <button
                        onClick={() => mapRef.current?.flyTo([trackedUser.latitude, trackedUser.longitude], 16, { animate: true, duration: 1 })}
                        style={{
                          padding: '5px 10px', cursor: 'pointer', whiteSpace: 'nowrap',
                          background: `${C.blue}12`, border: `1px solid ${C.blue}40`,
                          color: C.blue, borderRadius: '3px',
                          fontFamily: 'Orbitron, sans-serif', fontSize: '8px', letterSpacing: '0.06em',
                          transition: 'all 0.18s',
                        }}
                        onMouseEnter={e => (e.currentTarget.style.background = `${C.blue}22`)}
                        onMouseLeave={e => (e.currentTarget.style.background = `${C.blue}12`)}
                      >📍 تحديد</button>
                      {/* External Google Maps */}
                      <a
                        href={`https://www.google.com/maps/search/?api=1&query=${trackedUser.latitude},${trackedUser.longitude}`}
                        target="_blank" rel="noreferrer"
                        style={{
                          padding: '5px 10px', cursor: 'pointer', whiteSpace: 'nowrap',
                          background: `${C.green}10`, border: `1px solid ${C.green}35`,
                          color: C.green, borderRadius: '3px',
                          fontFamily: 'Orbitron, sans-serif', fontSize: '8px', letterSpacing: '0.06em',
                          textDecoration: 'none', display: 'inline-flex', alignItems: 'center',
                          transition: 'all 0.18s',
                        }}
                        onMouseEnter={e => ((e.currentTarget as HTMLElement).style.background = `${C.green}1e`)}
                        onMouseLeave={e => ((e.currentTarget as HTMLElement).style.background = `${C.green}10`)}
                      >🚗 توجيه</a>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      <style>{`@keyframes lf-ping{0%{transform:scale(1);opacity:0.7}70%{transform:scale(2.2);opacity:0}100%{transform:scale(2.2);opacity:0}}`}</style>
    </div>
  );
}

// ── Services Settings Tab ─────────────────────────────────────────────────────
function ServicesSettingsTab({ toast }: { toast: ReturnType<typeof useToast> }) {
  const [isTaxiActive, setIsTaxiActive] = useState<boolean | null>(null);
  const [isGasActive,  setIsGasActive]  = useState<boolean | null>(null);
  const [saving, setSaving] = useState<"taxi" | "gas" | null>(null);

  // Live listener on settings/services
  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, "settings", "services"),
      (snap) => {
        const d = snap.exists() ? snap.data() : {};
        setIsTaxiActive(d?.isTaxiActive ?? true);
        setIsGasActive(d?.isGasActive  ?? true);
      },
      () => {
        setIsTaxiActive(true);
        setIsGasActive(true);
      }
    );
    return unsub;
  }, []);

  const toggle = async (field: "isTaxiActive" | "isGasActive", current: boolean) => {
    const key = field === "isTaxiActive" ? "taxi" : "gas";
    setSaving(key);
    try {
      await setDoc(doc(db, "settings", "services"), { [field]: !current }, { merge: true });
      toast.show(
        field === "isTaxiActive"
          ? (!current ? "✓ خدمة التكسي مفتوحة الآن" : "⏸ خدمة التكسي مقفلة")
          : (!current ? "✓ خدمة الغاز مفتوحة الآن"  : "⏸ خدمة الغاز مقفلة"),
        !current
      );
    } catch {
      toast.show("فشل التحديث، حاول مجدداً", false);
    } finally {
      setSaving(null);
    }
  };

  const loading = isTaxiActive === null || isGasActive === null;

  const services = [
    {
      key:     "taxi" as const,
      field:   "isTaxiActive" as const,
      active:  isTaxiActive ?? true,
      icon:    "🚕",
      labelAr: "خدمة طلب التكسي",
      labelEn: "TAXI SERVICE",
      color:   C.yellow,
      desc:    "يتحكم بزر «اطلب تكسي» في تطبيق الزبائن — عند الإغلاق يُعرض الزر بشكل غير فعّال.",
    },
    {
      key:     "gas" as const,
      field:   "isGasActive" as const,
      active:  isGasActive ?? true,
      icon:    "⛽",
      labelAr: "خدمة حجز الغاز",
      labelEn: "GAS SERVICE",
      color:   C.blue,
      desc:    "يتحكم بزر «اطلب غاز» في تطبيق الزبائن — عند الإغلاق يُعرض الزر بشكل غير فعّال.",
    },
  ];

  return (
    <div style={{ maxWidth: "680px" }}>

      {/* ── Section header ── */}
      <div style={{ marginBottom: "24px" }}>
        <div style={{
          fontFamily: "Orbitron, sans-serif", fontSize: "12px",
          color: C.purple, letterSpacing: "0.14em",
          textShadow: neon(C.purple, 8), marginBottom: "6px",
        }}>⚙️ SERVICES SETTINGS</div>
        <div style={{
          fontFamily: "Rajdhani, sans-serif", fontSize: "13px", color: C.dim,
        }}>
          التحكم الفوري بفتح وقفل خدمات التطبيق الرئيسية — التغييرات تنعكس على الزبائن فورياً.
        </div>
      </div>

      {/* ── Firestore path info ── */}
      <div style={{
        display: "inline-flex", alignItems: "center", gap: "8px",
        padding: "7px 14px", marginBottom: "22px",
        background: `${C.purple}08`,
        border: `1px solid ${C.purple}28`,
        borderRadius: "4px",
        fontFamily: "monospace", fontSize: "12px", color: `${C.purple}cc`,
      }}>
        <span style={{ opacity: 0.5 }}>Firestore:</span>
        <span>settings / services</span>
      </div>

      {loading ? (
        <div style={{
          textAlign: "center", padding: "60px",
          fontFamily: "Orbitron, sans-serif", fontSize: "11px",
          color: C.dim, letterSpacing: "0.1em",
        }}>LOADING...</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          {services.map((svc) => {
            const isBusy = saving === svc.key;
            return (
              <div key={svc.key} style={{
                background: C.surface,
                border: `1px solid ${svc.active ? svc.color + "55" : C.border}`,
                borderRadius: "6px",
                padding: "20px 22px",
                display: "flex", alignItems: "center", gap: "18px",
                transition: "border-color 0.25s, box-shadow 0.25s",
                boxShadow: svc.active ? `0 0 18px ${svc.color}18` : "none",
              }}>

                {/* Icon */}
                <div style={{
                  width: "52px", height: "52px", flexShrink: 0,
                  borderRadius: "10px",
                  background: svc.active ? `${svc.color}12` : "rgba(255,255,255,0.03)",
                  border: `1px solid ${svc.active ? svc.color + "44" : C.border}`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: "26px",
                  transition: "all 0.25s",
                }}>
                  {svc.icon}
                </div>

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
                    <span style={{
                      fontFamily: "Rajdhani, sans-serif", fontSize: "16px", fontWeight: 700,
                      color: svc.active ? C.text : C.dim,
                      transition: "color 0.2s",
                    }}>{svc.labelAr}</span>
                    <span style={{
                      fontFamily: "Orbitron, sans-serif", fontSize: "8px",
                      color: svc.active ? svc.color : C.dim,
                      letterSpacing: "0.1em", opacity: 0.7,
                    }}>{svc.labelEn}</span>
                  </div>
                  <div style={{
                    fontFamily: "Rajdhani, sans-serif", fontSize: "12px",
                    color: C.dim, lineHeight: 1.5,
                  }}>{svc.desc}</div>

                  {/* Field badge */}
                  <div style={{
                    display: "inline-block", marginTop: "8px",
                    padding: "2px 9px",
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: "3px",
                    fontFamily: "monospace", fontSize: "11px",
                    color: "rgba(255,255,255,0.3)",
                  }}>
                    {svc.field}: <span style={{ color: svc.active ? C.green : C.red, fontWeight: 700 }}>
                      {String(svc.active)}
                    </span>
                  </div>
                </div>

                {/* Status + Toggle */}
                <div style={{
                  display: "flex", flexDirection: "column",
                  alignItems: "center", gap: "8px", flexShrink: 0,
                }}>
                  {/* Status pill */}
                  <span style={{
                    padding: "4px 12px",
                    background: svc.active ? `${C.green}12` : `${C.red}12`,
                    border: `1px solid ${svc.active ? C.green + "55" : C.red + "55"}`,
                    borderRadius: "20px",
                    fontFamily: "Orbitron, sans-serif", fontSize: "9px",
                    letterSpacing: "0.1em",
                    color: svc.active ? C.green : C.red,
                    whiteSpace: "nowrap",
                    transition: "all 0.2s",
                  }}>
                    {svc.active ? "● مفتوحة" : "○ مقفلة"}
                  </span>

                  {/* Toggle button */}
                  <button
                    onClick={() => toggle(svc.field, svc.active)}
                    disabled={isBusy}
                    style={{
                      width: "72px", height: "36px",
                      borderRadius: "18px",
                      background: svc.active
                        ? `linear-gradient(90deg, ${svc.color}40, ${svc.color}20)`
                        : "rgba(255,255,255,0.05)",
                      border: `2px solid ${svc.active ? svc.color : "rgba(255,255,255,0.12)"}`,
                      cursor: isBusy ? "wait" : "pointer",
                      position: "relative",
                      transition: "all 0.25s",
                      boxShadow: svc.active ? `0 0 14px ${svc.color}44` : "none",
                      padding: 0,
                    }}
                    title={svc.active ? "اضغط للإغلاق" : "اضغط للفتح"}
                  >
                    {isBusy ? (
                      <svg width="16" height="16" viewBox="0 0 28 28" fill="none"
                        style={{
                          animation: "spin 0.8s linear infinite",
                          display: "block", margin: "0 auto",
                        }}>
                        <circle cx="14" cy="14" r="10"
                          stroke={svc.active ? svc.color : C.dim}
                          strokeWidth="2.5" strokeDasharray="22 14" strokeLinecap="round"/>
                      </svg>
                    ) : (
                      <span style={{
                        display: "block",
                        width: "26px", height: "26px",
                        borderRadius: "50%",
                        background: svc.active ? svc.color : "rgba(255,255,255,0.2)",
                        position: "absolute",
                        top: "3px",
                        left: svc.active ? "calc(100% - 29px)" : "3px",
                        transition: "left 0.25s, background 0.25s",
                        boxShadow: svc.active ? `0 0 8px ${svc.color}88` : "none",
                      }} />
                    )}
                  </button>
                </div>

              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// ── GiftCardsTab — توليد كارتات الشحن وبطاقات الهدايا ────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
interface GiftCard {
  id:        string;   // Firestore doc ID = code itself
  code:      string;
  amount:    number;
  isUsed:    boolean;
  createdAt: string;
}

/** توليد كود عشوائي بصيغة  XXXX-XXXX-XXXX  (حروف كبيرة+صغيرة+أرقام) */
function genCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const seg = (n: number) =>
    Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${seg(4)}-${seg(4)}-${seg(4)}`;
}

function GiftCardsTab({ toast }: { toast: ReturnType<typeof useToast> }) {
  const [cards,      setCards]      = useState<GiftCard[]>([]);
  const [amount,     setAmount]     = useState('10000');
  const [countStr,   setCountStr]   = useState('1');
  const [generating, setGenerating] = useState(false);
  const [copied,     setCopied]     = useState<string | null>(null);
  const [deleting,   setDeleting]   = useState<string | null>(null);
  const [filterUsed, setFilterUsed] = useState<'unused' | 'used' | 'all'>('unused');

  // ── Live listener ─────────────────────────────────────────────────────────
  useEffect(() => {
    const unsub = onSnapshot(
      query(collection(db, 'gift_cards'), orderBy('createdAt', 'desc')),
      snap => {
        const rows: GiftCard[] = [];
        snap.forEach(d => {
          const r = d.data();
          rows.push({
            id:        d.id,
            code:      String(r.code      ?? d.id),
            amount:    Number(r.amount    ?? 0),
            isUsed:    Boolean(r.isUsed   ?? false),
            createdAt: r.createdAt?.toDate
              ? r.createdAt.toDate().toLocaleString('ar-IQ')
              : '—',
          });
        });
        setCards(rows);
      },
      err => console.error('[GiftCardsTab]', err),
    );
    return () => unsub();
  }, []);

  // ── توليد الكارتات ────────────────────────────────────────────────────────
  async function generate() {
    const amt = Number(amount.replace(/,/g, '').trim());
    const cnt = Math.min(Math.max(parseInt(countStr, 10) || 1, 1), 100);
    if (!amt || amt <= 0) { toast.show('يرجى إدخال قيمة صحيحة للكارت', false); return; }
    setGenerating(true);
    try {
      const batch = writeBatch(db);
      for (let i = 0; i < cnt; i++) {
        const code = genCode();
        batch.set(doc(db, 'gift_cards', code), {
          code,
          amount:    amt,
          isUsed:    false,
          createdBy: 'Admin',
          createdAt: serverTimestamp(),
        });
      }
      await batch.commit();
      toast.show(`✅ تم توليد ${cnt} كارت بقيمة ${amt.toLocaleString('ar-IQ')} دينار`);
      setCountStr('1');
    } catch (e: any) {
      toast.show(`فشل التوليد: ${e?.message ?? e}`, false);
    } finally {
      setGenerating(false);
    }
  }

  // ── نسخ الكود ─────────────────────────────────────────────────────────────
  async function copyCode(code: string) {
    try { await navigator.clipboard.writeText(code); } catch { /* noop */ }
    setCopied(code);
    setTimeout(() => setCopied(null), 1800);
  }

  // ── حذف كارت ─────────────────────────────────────────────────────────────
  async function deleteCard(id: string) {
    setDeleting(id);
    try {
      await deleteDoc(doc(db, 'gift_cards', id));
      toast.show('تم حذف الكارت');
    } catch (e: any) {
      toast.show(`فشل الحذف: ${e?.message ?? e}`, false);
    } finally {
      setDeleting(null);
    }
  }

  // ── طباعة الكارتات الظاهرة ────────────────────────────────────────────────
  function printCards() {
    const rows = filtered.map(c =>
      `<tr style="border-bottom:1px solid #333">
        <td style="padding:8px 12px;font-family:monospace;font-size:16px;letter-spacing:2px;font-weight:700">${c.code}</td>
        <td style="padding:8px 12px;text-align:center">${c.amount.toLocaleString('ar-IQ')} IQD</td>
        <td style="padding:8px 12px;font-size:11px;color:#888">${c.createdAt}</td>
      </tr>`
    ).join('');
    const win = window.open('', '_blank');
    if (!win) return;
    win.document.write(`
      <html><head><title>كارتات الشحن</title>
      <style>body{direction:rtl;font-family:Arial;background:#fff;padding:20px}
      table{border-collapse:collapse;width:100%}
      th{background:#111;color:#fff;padding:10px 12px}
      @media print{button{display:none!important}}</style>
      </head><body>
      <h2 style="text-align:center">كارتات شحن المحفظة — ديالى</h2>
      <button onclick="window.print()" style="margin-bottom:16px;padding:8px 20px;background:#111;color:#fff;border:none;cursor:pointer;border-radius:4px">🖨 طباعة</button>
      <table><thead><tr><th>الكود</th><th>القيمة</th><th>تاريخ الإنشاء</th></tr></thead>
      <tbody>${rows}</tbody></table>
      </body></html>`);
    win.document.close();
  }

  const filtered = cards.filter(c =>
    filterUsed === 'all' ? true : filterUsed === 'used' ? c.isUsed : !c.isUsed
  );
  const unusedCount = cards.filter(c => !c.isUsed).length;
  const usedCount   = cards.filter(c => c.isUsed).length;

  const AMOUNT_PRESETS = [5000, 10000, 25000, 50000, 100000];

  return (
    <div style={{ direction: 'rtl' }}>

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div style={{ marginBottom: '22px' }}>
        <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '11px', color: C.yellow, letterSpacing: '0.18em', marginBottom: '4px' }}>
          🎁 GIFT CARDS · إدارة كارتات الشحن
        </div>
        <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '13px', color: C.dim }}>
          توليد أكواد شحن فريدة وآمنة لتوزيعها على الوكلاء والزبائن
        </div>
      </div>

      {/* ── Stats row ───────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: '12px', marginBottom: '22px' }}>
        {[
          { label: 'إجمالي الكارتات', value: cards.length, color: C.blue },
          { label: 'غير مستخدمة',     value: unusedCount,  color: C.green },
          { label: 'مستخدمة',         value: usedCount,    color: C.dim },
        ].map(s => (
          <div key={s.label} style={{ background: C.surface, border: `1px solid ${s.color}22`, borderRadius: '6px', padding: '14px 16px' }}>
            <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '22px', fontWeight: 700, color: s.color, textShadow: `0 0 14px ${s.color}44` }}>{s.value}</div>
            <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '12px', color: C.dim, marginTop: '2px' }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* ── Generator panel ─────────────────────────────────────────────── */}
      <div style={{ background: C.surface, border: `1px solid ${C.yellow}28`, borderRadius: '6px', padding: '20px', marginBottom: '24px' }}>

        <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '9px', color: `${C.yellow}88`, letterSpacing: '0.14em', marginBottom: '14px' }}>
          ⚡ GENERATOR — توليد كارتات جديدة
        </div>

        {/* Amount presets */}
        <div style={{ marginBottom: '14px' }}>
          <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '12px', color: C.dim, marginBottom: '8px' }}>قيمة الكارت (دينار عراقي)</div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
            {AMOUNT_PRESETS.map(p => (
              <button key={p} onClick={() => setAmount(String(p))}
                style={{
                  padding: '5px 14px', borderRadius: '4px', cursor: 'pointer',
                  fontFamily: 'Orbitron, sans-serif', fontSize: '10px',
                  background: amount === String(p) ? `${C.yellow}22` : 'transparent',
                  border: `1px solid ${amount === String(p) ? C.yellow : C.border}`,
                  color: amount === String(p) ? C.yellow : C.dim,
                  transition: 'all 0.15s',
                }}>
                {p.toLocaleString('ar-IQ')}
              </button>
            ))}
          </div>
          <input
            type="number" value={amount} onChange={e => setAmount(e.target.value)}
            placeholder="أو أدخل قيمة مخصصة..."
            style={{ ...FLD, width: '220px' }}
          />
        </div>

        {/* Count */}
        <div style={{ marginBottom: '18px' }}>
          <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '12px', color: C.dim, marginBottom: '8px' }}>عدد الكارتات (الحد الأقصى 100)</div>
          <input
            type="number" min={1} max={100} value={countStr}
            onChange={e => setCountStr(e.target.value)}
            style={{ ...FLD, width: '120px' }}
          />
        </div>

        {/* Generate button */}
        <button onClick={generate} disabled={generating}
          style={{
            padding: '10px 28px', borderRadius: '4px', cursor: generating ? 'not-allowed' : 'pointer',
            fontFamily: 'Orbitron, sans-serif', fontSize: '11px', letterSpacing: '0.1em',
            background: generating ? `${C.yellow}10` : `${C.yellow}18`,
            border: `1px solid ${generating ? C.border : C.yellow}`,
            color: generating ? C.dim : C.yellow,
            textShadow: generating ? 'none' : `0 0 10px ${C.yellow}66`,
            transition: 'all 0.18s',
          }}>
          {generating ? '⏳ جاري التوليد...' : '⚡ توليد الكارتات'}
        </button>
      </div>

      {/* ── Cards table ─────────────────────────────────────────────────── */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: '6px', overflow: 'hidden' }}>

        {/* Table toolbar */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: `1px solid ${C.border}`, flexWrap: 'wrap', gap: '10px' }}>
          <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '9px', color: C.dim, letterSpacing: '0.12em' }}>
            قائمة الكارتات · {filtered.length} نتيجة
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {/* Filter buttons */}
            {(['unused', 'used', 'all'] as const).map(f => {
              const labels = { unused: 'غير مستخدمة', used: 'مستخدمة', all: 'الكل' };
              const active = filterUsed === f;
              return (
                <button key={f} onClick={() => setFilterUsed(f)}
                  style={{
                    padding: '5px 12px', borderRadius: '3px', cursor: 'pointer',
                    fontFamily: 'Rajdhani, sans-serif', fontSize: '12px',
                    background: active ? `${C.blue}18` : 'transparent',
                    border: `1px solid ${active ? C.blue : C.border}`,
                    color: active ? C.blue : C.dim,
                  }}>
                  {labels[f]}
                </button>
              );
            })}
            {/* Print button */}
            {filtered.length > 0 && (
              <button onClick={printCards}
                style={{ padding: '5px 14px', borderRadius: '3px', cursor: 'pointer', fontFamily: 'Rajdhani, sans-serif', fontSize: '12px', background: `${C.green}12`, border: `1px solid ${C.green}44`, color: C.green }}>
                🖨 طباعة
              </button>
            )}
          </div>
        </div>

        {filtered.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', fontFamily: 'Rajdhani, sans-serif', fontSize: '14px', color: C.dim }}>
            لا توجد كارتات — اضغط "توليد الكارتات" لإنشاء أكواد جديدة
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: `${C.yellow}08` }}>
                  {['الكود', 'القيمة', 'الحالة', 'تاريخ الإنشاء', 'إجراءات'].map(h => (
                    <th key={h} style={{ padding: '10px 14px', fontFamily: 'Orbitron, sans-serif', fontSize: '8px', color: `${C.yellow}88`, letterSpacing: '0.1em', textAlign: 'right', borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((card, i) => (
                  <tr key={card.id}
                    style={{
                      background: i % 2 === 0 ? 'transparent' : `${C.yellow}03`,
                      borderBottom: `1px solid ${C.border}22`,
                      opacity: card.isUsed ? 0.45 : 1,
                    }}>
                    {/* Code */}
                    <td style={{ padding: '11px 14px', fontFamily: 'Courier New, monospace', fontSize: '15px', fontWeight: 700, color: card.isUsed ? C.dim : C.text, letterSpacing: '1.5px' }}>
                      {card.code}
                    </td>
                    {/* Amount */}
                    <td style={{ padding: '11px 14px', fontFamily: 'Orbitron, sans-serif', fontSize: '12px', color: C.yellow, whiteSpace: 'nowrap' }}>
                      {card.amount.toLocaleString('ar-IQ')} IQD
                    </td>
                    {/* Status */}
                    <td style={{ padding: '11px 14px' }}>
                      <span style={{
                        padding: '3px 9px', borderRadius: '20px', fontSize: '11px',
                        fontFamily: 'Rajdhani, sans-serif',
                        background: card.isUsed ? `${C.dim}18` : `${C.green}14`,
                        border: `1px solid ${card.isUsed ? C.border : C.green + '44'}`,
                        color: card.isUsed ? C.dim : C.green,
                      }}>
                        {card.isUsed ? 'مستخدم' : '🟢 متاح'}
                      </span>
                    </td>
                    {/* Date */}
                    <td style={{ padding: '11px 14px', fontFamily: 'Rajdhani, sans-serif', fontSize: '12px', color: C.dim, whiteSpace: 'nowrap' }}>
                      {card.createdAt}
                    </td>
                    {/* Actions */}
                    <td style={{ padding: '11px 14px' }}>
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'nowrap' }}>
                        {/* Copy */}
                        <button onClick={() => copyCode(card.code)}
                          style={{
                            padding: '4px 10px', borderRadius: '3px', cursor: 'pointer',
                            fontFamily: 'Rajdhani, sans-serif', fontSize: '11px',
                            background: copied === card.code ? `${C.green}18` : `${C.blue}12`,
                            border: `1px solid ${copied === card.code ? C.green + '55' : C.blue + '44'}`,
                            color: copied === card.code ? C.green : C.blue,
                            whiteSpace: 'nowrap', transition: 'all 0.15s',
                          }}>
                          {copied === card.code ? '✅ تم النسخ' : '📋 نسخ'}
                        </button>
                        {/* Delete */}
                        {!card.isUsed && (
                          <button onClick={() => deleteCard(card.id)}
                            disabled={deleting === card.id}
                            style={{
                              padding: '4px 10px', borderRadius: '3px', cursor: deleting === card.id ? 'not-allowed' : 'pointer',
                              fontFamily: 'Rajdhani, sans-serif', fontSize: '11px',
                              background: `${C.red}0e`, border: `1px solid ${C.red}33`, color: C.red,
                            }}>
                            {deleting === card.id ? '...' : '🗑 حذف'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

    </div>
  );
}

// ── Admin Dashboard ───────────────────────────────────────────────────────────
export function AdminDashboard() {
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<"merchants" | "map" | "categories" | "settings" | "taxi" | "drivers" | "fuel" | "bounty" | "users" | "users_radar" | "gift_cards" | "doctors_bookings" | "services_settings">("merchants");
  const [cats, setCats] = useState<Cat[]>([]);
  const [authChecked, setAuthChecked] = useState(false);
  const toast = useToast();

  // ── Firebase Auth + Firestore role guard ────────────────────────────────────
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      if (!fbUser) { navigate("/admin"); return; }
      try {
        const snap = await getDoc(doc(db, "users", fbUser.uid));
        if (snap.exists() && snap.data()?.role === "admin") {
          setAuthChecked(true);
        } else {
          await signOut(auth);
          navigate("/admin");
        }
      } catch {
        await signOut(auth);
        navigate("/admin");
      }
    });
    return () => unsub();
  }, []);

  const loadCats = useCallback(async () => {
    const d = await api.get("/api/categories");
    setCats(Array.isArray(d) ? d : []);
  }, []);
  useEffect(() => { if (authChecked) loadCats(); }, [authChecked, loadCats]);

  const logout = async () => {
    await signOut(auth);
    navigate("/admin");
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
    { key: "bounty"     as const, en: "BOUNTY",      ar: "⭐ المهمات والجوائز" },
    { key: "users"            as const, en: "USERS",           ar: "👥 المستخدمون" },
    { key: "users_radar"      as const, en: "USERS RADAR",     ar: "📡 رادار المستخدمين" },
    { key: "gift_cards"       as const, en: "GIFT CARDS",      ar: "🎁 كارتات الشحن" },
    { key: "doctors_bookings"   as const, en: "DOCTORS BOOKINGS",  ar: "🏥 حجوزات الأطباء" },
    { key: "services_settings" as const, en: "SERVICES SETTINGS", ar: "⚙️ إعدادات الخدمات" },
    { key: "settings"          as const, en: "SETTINGS",          ar: "الإعدادات" },
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
        {tab === "bounty"     && <BountyMissionsTab toast={toast} />}
        {tab === "users"            && <UsersTab toast={toast} />}
        {tab === "users_radar"      && <UsersRadarTab />}
        {tab === "gift_cards"       && <GiftCardsTab toast={toast} />}
        {tab === "doctors_bookings"   && <DoctorsBookingsTab toast={toast} />}
        {tab === "services_settings"  && <ServicesSettingsTab toast={toast} />}
        {tab === "settings"           && <SettingsTab toast={toast} />}
      </main>

      <Toast toast={toast.toast} />
    </div>
  );
}

// ── helpers ────────────────────────────────────────────────────────────────────
function toAdminE164(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("964"))  return "+" + digits;
  if (digits.startsWith("0"))    return "+964" + digits.slice(1);
  if (digits.startsWith("7"))    return "+964" + digits;
  return "+" + digits;
}

// ── Admin Login — Phone Auth + Firestore role:admin guard ──────────────────────
export function AdminLogin() {
  const [, navigate] = useLocation();

  // step: "phone" → send OTP  |  "otp" → verify  |  "role" → checking role
  const [step,      setStep]      = useState<"phone" | "otp" | "role">("phone");
  const [phone,     setPhone]     = useState("");
  const [otp,       setOtp]       = useState("");
  const [err,       setErr]       = useState("");
  const [busy,      setBusy]      = useState(false);
  const [shake,     setShake]     = useState(false);
  const [sentTo,    setSentTo]    = useState("");
  const [countdown, setCountdown] = useState(0);

  const confirmRef  = useRef<ConfirmationResult | null>(null);
  const captchaRef  = useRef<RecaptchaVerifier | null>(null);

  // ── reCAPTCHA helpers ────────────────────────────────────────────────────
  const clearCaptcha = () => {
    try { captchaRef.current?.clear(); } catch {}
    captchaRef.current = null;
    const el = document.getElementById("adm-rcv");
    if (el) el.innerHTML = "";
  };

  const initCaptcha = async () => {
    if (captchaRef.current) return;
    try {
      const v = new RecaptchaVerifier(auth, "adm-rcv", {
        size: "invisible",
        callback: () => {},
        "expired-callback": () => clearCaptcha(),
      });
      await v.render();
      captchaRef.current = v;
    } catch { /* will retry on send */ }
  };

  // ── If already authenticated with admin role, skip to dashboard ──────────
  useEffect(() => {
    initCaptcha();
    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      if (!fbUser) return;
      try {
        const snap = await getDoc(doc(db, "users", fbUser.uid));
        if (snap.exists() && snap.data()?.role === "admin") navigate("/admin/dashboard");
      } catch { /* stay on login */ }
    });
    return () => { unsub(); clearCaptcha(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Countdown ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  const triggerShake = () => { setShake(true); setTimeout(() => setShake(false), 600); };

  // ── Step 1 — Send OTP ─────────────────────────────────────────────────────
  const sendOtp = async () => {
    const e164 = toAdminE164(phone.trim());
    if (!/^\+964\d{10}$/.test(e164)) {
      setErr("رقم غير صحيح — مثال: 07742533658"); triggerShake(); return;
    }
    setBusy(true); setErr("");
    try {
      if (!captchaRef.current) await initCaptcha();
      const result = await signInWithPhoneNumber(auth, e164, captchaRef.current!);
      confirmRef.current = result;
      setSentTo(e164);
      setStep("otp");
      setCountdown(60);
    } catch (e: unknown) {
      clearCaptcha(); setTimeout(() => initCaptcha(), 300);
      const code = (e as { code?: string })?.code ?? "";
      if (code === "auth/too-many-requests")    setErr("طلبات كثيرة جداً، انتظر قليلاً");
      else if (code === "auth/invalid-phone-number") setErr("رقم الهاتف غير صالح");
      else if (code === "auth/captcha-check-failed") setErr("فشل التحقق — أعد تحميل الصفحة");
      else setErr(`خطأ: ${code || "unknown"}`);
      triggerShake();
    } finally { setBusy(false); }
  };

  // ── Step 2 — Verify OTP + role check ──────────────────────────────────────
  const verifyOtp = async () => {
    if (otp.length < 6)       { setErr("الرمز يجب أن يكون 6 أرقام"); triggerShake(); return; }
    if (!confirmRef.current)  { setErr("انتهت الجلسة، أعد إرسال الرمز"); return; }
    setBusy(true); setErr(""); setStep("role");
    try {
      const cred = await confirmRef.current.confirm(otp);
      const uid  = cred.user.uid;

      // Firestore role check
      const snap = await getDoc(doc(db, "users", uid));
      const role = snap.exists() ? snap.data()?.role : undefined;

      if (role !== "admin") {
        await signOut(auth);
        setStep("otp");
        setErr("عذراً، هذا الحساب لا يملك صلاحيات الأدمن!");
        triggerShake();
        return;
      }
      navigate("/admin/dashboard");
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code ?? "";
      setStep("otp");
      if (code === "auth/invalid-verification-code") setErr("الرمز غير صحيح، تحقق من الأرقام");
      else if (code === "auth/code-expired")         setErr("انتهت صلاحية الرمز، أعد الإرسال");
      else setErr(`خطأ: ${code || "unknown"}`);
      triggerShake();
    } finally { setBusy(false); }
  };

  // ── Resend ────────────────────────────────────────────────────────────────
  const resend = async () => {
    if (countdown > 0) return;
    clearCaptcha(); setOtp(""); setErr("");
    await initCaptcha();
    await sendOtp();
  };

  // ── Styles ────────────────────────────────────────────────────────────────
  const hasErr = !!err;
  const INP: React.CSSProperties = {
    width: "100%", padding: "11px 14px",
    background: "rgba(123,47,247,0.06)",
    border: `1px solid ${hasErr ? "rgba(255,45,120,0.5)" : "rgba(123,47,247,0.35)"}`,
    color: "#e2e8f0", fontSize: "16px", outline: "none",
    borderRadius: "4px", fontFamily: "Rajdhani, sans-serif",
    transition: "border-color 0.2s", direction: "ltr", letterSpacing: "0.04em",
  };
  const BTN: React.CSSProperties = {
    width: "100%", padding: "13px",
    background: "rgba(123,47,247,0.18)", border: "1px solid rgba(123,47,247,0.6)",
    color: "#c4a8ff", fontFamily: "Orbitron, sans-serif", fontSize: "10px",
    letterSpacing: "0.12em", cursor: "pointer", borderRadius: "4px",
    boxShadow: "0 0 20px rgba(123,47,247,0.2)", transition: "all 0.18s",
    textShadow: "0 0 8px rgba(123,47,247,0.5)",
  };
  const BTN_DIS: React.CSSProperties = {
    ...BTN, background: "rgba(123,47,247,0.05)",
    border: "1px solid rgba(123,47,247,0.2)",
    color: "rgba(123,47,247,0.35)", cursor: "wait", boxShadow: "none", textShadow: "none",
  };

  const isRole = step === "role";

  return (
    <div style={{ minHeight: "100vh", background: "#05080f", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700&family=Rajdhani:wght@400;600;700&display=swap');
        @keyframes adm-shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-8px)}40%,80%{transform:translateX(8px)}}
        @keyframes adm-spin{to{transform:rotate(360deg)}}
        *{box-sizing:border-box}
      `}</style>

      {/* invisible reCAPTCHA anchor — always in DOM */}
      <div id="adm-rcv" style={{ position: "fixed", bottom: "-9999px", left: "-9999px", width: 0, height: 0, overflow: "hidden", pointerEvents: "none" }} />

      <div style={{ width: "100%", maxWidth: "370px", padding: "20px", animation: shake ? "adm-shake 0.5s" : "none" }}>
        <div style={{
          background: "#0d1117",
          border: `1px solid ${hasErr ? "rgba(255,45,120,0.4)" : "rgba(123,47,247,0.45)"}`,
          borderRadius: "6px", padding: "36px 28px",
          boxShadow: `0 0 60px rgba(123,47,247,0.15)`,
          transition: "border-color 0.3s",
        }}>

          {/* Header */}
          <div style={{ textAlign: "center", marginBottom: "32px" }}>
            <div style={{ fontSize: "9px", fontFamily: "Orbitron, sans-serif", color: "rgba(123,47,247,0.6)", letterSpacing: "0.25em", marginBottom: "12px" }}>
              DIYALA · ADMIN PANEL
            </div>
            <div style={{ fontSize: "26px", marginBottom: "10px" }}>🗺️</div>
            <div style={{ color: "rgba(226,232,240,0.45)", fontFamily: "Rajdhani, sans-serif", fontSize: "14px" }}>
              {step === "phone" ? "تسجيل الدخول برقم الهاتف" : step === "role" ? "جارٍ التحقق من الصلاحيات..." : `تم إرسال رمز SMS إلى ${sentTo}`}
            </div>
          </div>

          {/* ── STEP: PHONE ── */}
          {step === "phone" && (
            <>
              <div style={{ marginBottom: "18px" }}>
                <label style={{ display: "block", fontFamily: "Orbitron, sans-serif", fontSize: "8px", color: "rgba(123,47,247,0.7)", letterSpacing: "0.18em", marginBottom: "8px" }}>
                  رقم الهاتف
                </label>
                <input
                  type="tel" value={phone} autoFocus
                  onChange={e => { setPhone(e.target.value); setErr(""); }}
                  onKeyDown={e => e.key === "Enter" && sendOtp()}
                  placeholder="+9647XXXXXXXXX"
                  style={INP}
                  onFocus={e => { if (!hasErr) e.target.style.borderColor = "rgba(123,47,247,0.7)"; }}
                  onBlur={e => { if (!hasErr) e.target.style.borderColor = "rgba(123,47,247,0.35)"; }}
                />
                <div style={{ marginTop: "6px", fontFamily: "Rajdhani, sans-serif", fontSize: "11px", color: "rgba(226,232,240,0.25)" }}>
                  مثال: 07742533658 أو +96407742533658
                </div>
              </div>

              {err && (
                <div style={{ padding: "9px 13px", borderRadius: "4px", marginBottom: "14px", background: "rgba(255,45,120,0.08)", border: "1px solid rgba(255,45,120,0.35)", color: "#ff7aaa", fontFamily: "Rajdhani, sans-serif", fontSize: "13px", fontWeight: 600, textAlign: "center" }}>
                  ⛔ {err}
                </div>
              )}

              <button onClick={sendOtp} disabled={busy || !phone.trim()} style={busy || !phone.trim() ? BTN_DIS : BTN}
                onMouseEnter={e => { if (!busy) e.currentTarget.style.background = "rgba(123,47,247,0.28)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "rgba(123,47,247,0.18)"; }}>
                {busy ? "⏳ جاري الإرسال..." : "إرسال رمز التحقق SMS ›"}
              </button>
            </>
          )}

          {/* ── STEP: OTP ── */}
          {(step === "otp" || step === "role") && (
            <>
              <div style={{ marginBottom: "18px" }}>
                <label style={{ display: "block", fontFamily: "Orbitron, sans-serif", fontSize: "8px", color: "rgba(123,47,247,0.7)", letterSpacing: "0.18em", marginBottom: "8px" }}>
                  رمز التحقق OTP
                </label>
                <input
                  type="number" value={otp} autoFocus disabled={isRole}
                  onChange={e => { setOtp(e.target.value.slice(0, 6)); setErr(""); }}
                  onKeyDown={e => e.key === "Enter" && verifyOtp()}
                  placeholder="_ _ _ _ _ _"
                  style={{ ...INP, fontSize: "22px", letterSpacing: "0.35em", textAlign: "center", opacity: isRole ? 0.4 : 1 }}
                  onFocus={e => { if (!hasErr) e.target.style.borderColor = "rgba(0,212,255,0.6)"; }}
                  onBlur={e => { if (!hasErr) e.target.style.borderColor = "rgba(123,47,247,0.35)"; }}
                />
              </div>

              {err && (
                <div style={{ padding: "9px 13px", borderRadius: "4px", marginBottom: "14px", background: "rgba(255,45,120,0.08)", border: "1px solid rgba(255,45,120,0.35)", color: "#ff7aaa", fontFamily: "Rajdhani, sans-serif", fontSize: "13px", fontWeight: 600, textAlign: "center" }}>
                  ⛔ {err}
                </div>
              )}

              {/* Role-checking spinner */}
              {isRole && (
                <div style={{ display: "flex", alignItems: "center", gap: "10px", justifyContent: "center", marginBottom: "16px" }}>
                  <div style={{ width: "16px", height: "16px", border: "2px solid rgba(0,212,255,0.2)", borderTop: "2px solid #00d4ff", borderRadius: "50%", animation: "adm-spin 0.8s linear infinite" }} />
                  <span style={{ fontFamily: "Orbitron, sans-serif", fontSize: "8px", color: "rgba(0,212,255,0.7)", letterSpacing: "0.15em" }}>VERIFYING ROLE...</span>
                </div>
              )}

              <button onClick={verifyOtp} disabled={busy || otp.length < 6 || isRole}
                style={busy || otp.length < 6 || isRole ? BTN_DIS : { ...BTN, border: "1px solid rgba(0,212,255,0.55)", color: "#a8eeff", textShadow: "0 0 8px rgba(0,212,255,0.5)", boxShadow: "0 0 20px rgba(0,212,255,0.15)" }}
                onMouseEnter={e => { if (!busy && !isRole) e.currentTarget.style.background = "rgba(0,212,255,0.18)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "rgba(123,47,247,0.18)"; }}>
                {isRole ? "⏳ جاري التحقق..." : "تأكيد الرمز والدخول ›"}
              </button>

              {/* Resend + back */}
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: "14px" }}>
                <button onClick={resend} disabled={countdown > 0 || busy}
                  style={{ background: "none", border: "none", cursor: countdown > 0 ? "default" : "pointer", fontFamily: "Rajdhani, sans-serif", fontSize: "12px", color: countdown > 0 ? "rgba(226,232,240,0.2)" : "rgba(123,47,247,0.7)", padding: 0 }}>
                  {countdown > 0 ? `إعادة الإرسال (${countdown}s)` : "↻ إعادة الإرسال"}
                </button>
                <button onClick={() => { setStep("phone"); setOtp(""); setErr(""); confirmRef.current = null; }}
                  style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "Rajdhani, sans-serif", fontSize: "12px", color: "rgba(226,232,240,0.3)", padding: 0 }}>
                  ‹ تغيير الرقم
                </button>
              </div>
            </>
          )}

        </div>
      </div>
    </div>
  );
}
