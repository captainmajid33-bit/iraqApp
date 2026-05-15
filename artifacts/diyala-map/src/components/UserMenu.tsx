import { useState, useEffect, useRef } from 'react';
import { signOut } from 'firebase/auth';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';
import { getUserFromStorage, type DiyalaUser } from './UserLoginOverlay';

const STORAGE_KEY = 'diyala_user';

export function UserMenu() {
  const [menuOpen,    setMenuOpen]    = useState(false);
  const [dialogOpen,  setDialogOpen]  = useState(false);
  const [signingOut,  setSigningOut]  = useState(false);
  const [user,        setUser]        = useState<DiyalaUser | null>(null);

  // Editable name state
  const [editedName,  setEditedName]  = useState('');
  const [saving,      setSaving]      = useState(false);

  // Toast / snackbar
  const [toast,       setToast]       = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const menuRef = useRef<HTMLDivElement>(null);

  // ── Resolve user data ─────────────────────────────────────────────────────
  useEffect(() => {
    const fromStorage = getUserFromStorage();
    if (fromStorage?.name) { setUser(fromStorage); return; }
    const fbUser = auth.currentUser;
    if (!fbUser) return;
    getDoc(doc(db, 'users', fbUser.uid))
      .then(snap => { if (snap.exists()) setUser(snap.data() as DiyalaUser); })
      .catch(() => {});
  }, []);

  // ── Sync editedName whenever dialog opens ────────────────────────────────
  useEffect(() => {
    if (dialogOpen) setEditedName(user?.name ?? '');
  }, [dialogOpen, user?.name]);

  // ── Close menu when clicking outside ────────────────────────────────────
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  // ── Show toast helper ────────────────────────────────────────────────────
  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  };

  // ── Sign out ─────────────────────────────────────────────────────────────
  const handleSignOut = async () => {
    setMenuOpen(false);
    setSigningOut(true);
    try {
      localStorage.removeItem(STORAGE_KEY);
      await signOut(auth);
    } catch (e) {
      console.error('[UserMenu] sign-out error:', e);
      setSigningOut(false);
    }
  };

  // ── Save updated name ─────────────────────────────────────────────────────
  const handleSaveName = () => {
    const newName = editedName.trim();
    if (!newName || newName === user?.name) return;

    const fbUser = auth.currentUser;
    if (!fbUser) { showToast('خطأ: غير مسجّل الدخول'); return; }

    setSaving(true);

    // ① Update local state + localStorage immediately — never block on Firestore.
    const updated = { ...user, name: newName } as DiyalaUser;
    setUser(updated);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    showToast('تم تحديث الاسم بنجاح ✓');
    setSaving(false);

    // ② Write to Firestore in the background (non-blocking).
    //    If Security Rules reject the write, a warning is logged — UI is unaffected.
    updateDoc(doc(db, 'users', fbUser.uid), { name: newName })
      .catch(e => {
        console.warn('[UserMenu] Firestore updateDoc failed (non-critical):', e?.code, e?.message);
      });
  };

  const isDirty = editedName.trim() !== (user?.name ?? '');

  return (
    <>
      <style>{`
        @keyframes um-fade-in    { from{opacity:0;transform:scale(0.92) translateY(-6px)} to{opacity:1;transform:scale(1) translateY(0)} }
        @keyframes um-dialog-in  { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
        @keyframes um-toast-in   { from{opacity:0;transform:translateY(24px)} to{opacity:1;transform:translateY(0)} }
        @keyframes um-spin       { to{transform:rotate(360deg)} }
        .um-item:hover  { background: rgba(123,47,247,0.12) !important; }
        .um-btn:hover   { background: rgba(123,47,247,0.18) !important; box-shadow: 0 0 20px rgba(123,47,247,0.3) !important; }
        .um-save:hover  { background: rgba(0,245,212,0.22) !important; }
        .um-close:hover { background: rgba(123,47,247,0.28) !important; }
        .um-name-input:focus { border-color: #7b2ff7 !important; box-shadow: 0 0 0 2px rgba(123,47,247,0.15); }
      `}</style>

      {/* ── Anchor container ─────────────────────────────────────────────── */}
      <div ref={menuRef} style={{ position: 'absolute', top: 20, right: 20, zIndex: 1500, direction: 'rtl' }}>

        {/* ── 3-dot trigger ──────────────────────────────────────────────── */}
        <button
          className="um-btn"
          onClick={() => setMenuOpen(o => !o)}
          disabled={signingOut}
          title="خيارات"
          style={{
            width: 40, height: 40, borderRadius: '50%',
            background: 'rgba(5,8,15,0.88)',
            border: '1px solid rgba(123,47,247,0.5)',
            boxShadow: '0 2px 16px rgba(0,0,0,0.55), 0 0 12px rgba(123,47,247,0.15)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: signingOut ? 'not-allowed' : 'pointer',
            transition: 'all 0.18s', padding: 0,
          }}
        >
          {signingOut ? (
            <svg width="16" height="16" viewBox="0 0 28 28" fill="none"
              style={{ animation: 'um-spin 0.85s linear infinite' }}>
              <circle cx="14" cy="14" r="10" stroke="#7b2ff7" strokeWidth="2.5" strokeDasharray="22 14" strokeLinecap="round"/>
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="rgba(180,160,255,0.9)">
              <circle cx="12" cy="5"  r="1.8"/>
              <circle cx="12" cy="12" r="1.8"/>
              <circle cx="12" cy="19" r="1.8"/>
            </svg>
          )}
        </button>

        {/* ── Dropdown ───────────────────────────────────────────────────── */}
        {menuOpen && (
          <div style={{
            position: 'absolute', top: 48, right: 0, minWidth: 190,
            background: 'rgba(5,8,15,0.97)',
            border: '1px solid rgba(123,47,247,0.45)',
            boxShadow: '0 8px 40px rgba(0,0,0,0.7), 0 0 24px rgba(123,47,247,0.12)',
            animation: 'um-fade-in 0.15s ease-out', overflow: 'hidden',
          }}>
            <button className="um-item" onClick={() => { setMenuOpen(false); setDialogOpen(true); }}
              style={{ width:'100%', padding:'12px 16px', display:'flex', alignItems:'center', gap:10, background:'transparent', border:'none', cursor:'pointer', textAlign:'right', transition:'background 0.15s' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(123,47,247,0.85)" strokeWidth="1.8" strokeLinecap="round">
                <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
              </svg>
              <span style={{ fontFamily:'Rajdhani, sans-serif', fontSize:'15px', color:'#d4c8ff', letterSpacing:'0.02em' }}>تفاصيل الحساب</span>
            </button>

            <div style={{ height:1, background:'rgba(123,47,247,0.15)', margin:'0 12px' }}/>

            <button className="um-item" onClick={handleSignOut}
              style={{ width:'100%', padding:'12px 16px', display:'flex', alignItems:'center', gap:10, background:'transparent', border:'none', cursor:'pointer', textAlign:'right', transition:'background 0.15s' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ff4d6d" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
              </svg>
              <span style={{ fontFamily:'Rajdhani, sans-serif', fontSize:'15px', color:'#ff4d6d', letterSpacing:'0.02em' }}>تسجيل الخروج</span>
            </button>
          </div>
        )}
      </div>

      {/* ── Account Details Dialog ────────────────────────────────────────── */}
      {dialogOpen && (
        <div
          onClick={e => { if (e.target === e.currentTarget) setDialogOpen(false); }}
          style={{ position:'fixed', inset:0, zIndex:9800, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(2,4,10,0.82)', backdropFilter:'blur(6px)' }}
        >
          <div style={{
            width: 'min(380px, calc(100vw - 32px))',
            background: 'rgba(5,8,15,0.99)',
            border: '1px solid rgba(123,47,247,0.6)',
            boxShadow: '0 0 60px rgba(123,47,247,0.25)',
            direction: 'rtl',
            animation: 'um-dialog-in 0.18s ease-out',
          }}>

            {/* Header */}
            <div style={{ padding:'18px 20px 14px', borderBottom:'1px solid rgba(123,47,247,0.18)', background:'rgba(123,47,247,0.06)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
              <div>
                <div style={{ fontFamily:'Orbitron, sans-serif', fontSize:'8px', color:'rgba(123,47,247,0.7)', letterSpacing:'0.22em', marginBottom:'5px' }}>PLAYER PROFILE</div>
                <div style={{ fontFamily:'Rajdhani, sans-serif', fontSize:'19px', fontWeight:700, color:'#e8f8f5' }}>تفاصيل الحساب</div>
              </div>
              <div style={{ width:44, height:44, borderRadius:'50%', background:'rgba(123,47,247,0.15)', border:'1px solid rgba(123,47,247,0.4)', display:'flex', alignItems:'center', justifyContent:'center' }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="rgba(123,47,247,0.8)" strokeWidth="1.6" strokeLinecap="round">
                  <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
                </svg>
              </div>
            </div>

            {/* Body */}
            <div style={{ padding:'20px' }}>

              {/* ── Editable Name ── */}
              <div style={{ marginBottom:'14px' }}>
                <div style={{ fontFamily:'Orbitron, sans-serif', fontSize:'7px', color:'rgba(123,47,247,0.6)', letterSpacing:'0.2em', marginBottom:'6px', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                  <span>الاسم الكامل</span>
                  {/* pen icon badge */}
                  <span style={{ display:'flex', alignItems:'center', gap:4, color:'rgba(123,47,247,0.5)', fontSize:'7px' }}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                    قابل للتعديل
                  </span>
                </div>
                <input
                  className="um-name-input"
                  type="text"
                  value={editedName}
                  onChange={e => setEditedName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && isDirty) handleSaveName(); }}
                  disabled={saving}
                  style={{
                    width:'100%', boxSizing:'border-box',
                    padding:'10px 14px',
                    background: isDirty ? 'rgba(123,47,247,0.12)' : 'rgba(123,47,247,0.07)',
                    border: `1px solid ${isDirty ? 'rgba(123,47,247,0.6)' : 'rgba(123,47,247,0.2)'}`,
                    outline:'none', transition:'all 0.2s',
                    fontFamily:'Rajdhani, sans-serif', fontSize:'17px',
                    color:'#e8f8f5', letterSpacing:'0.03em',
                  }}
                />
              </div>

              {/* ── Phone (read-only) ── */}
              <div style={{ marginBottom: isDirty ? '14px' : '22px' }}>
                <div style={{ fontFamily:'Orbitron, sans-serif', fontSize:'7px', color:'rgba(123,47,247,0.6)', letterSpacing:'0.2em', marginBottom:'6px' }}>رقم الهاتف</div>
                <div style={{
                  padding:'10px 14px',
                  background:'rgba(123,47,247,0.05)',
                  border:'1px solid rgba(123,47,247,0.15)',
                  fontFamily:'Rajdhani, sans-serif', fontSize:'17px',
                  color: user?.phone ? '#00f5d4' : 'rgba(255,255,255,0.3)',
                  letterSpacing:'0.04em', direction:'ltr', textAlign:'right',
                  opacity: 0.8,
                }}>
                  {user?.phone || '—'}
                </div>
              </div>

              {/* ── Save button (only when dirty) ── */}
              {isDirty && (
                <button
                  className="um-save"
                  onClick={handleSaveName}
                  disabled={saving || !editedName.trim()}
                  style={{
                    width:'100%', padding:'12px', marginBottom:'10px',
                    background: saving ? 'rgba(0,245,212,0.08)' : 'rgba(0,245,212,0.14)',
                    border:'1px solid rgba(0,245,212,0.5)',
                    color: saving ? 'rgba(0,245,212,0.4)' : '#00f5d4',
                    fontFamily:'Orbitron, sans-serif', fontSize:'9px',
                    letterSpacing:'0.14em', cursor: saving ? 'not-allowed' : 'pointer',
                    transition:'all 0.18s',
                    display:'flex', alignItems:'center', justifyContent:'center', gap:8,
                  }}
                >
                  {saving ? (
                    <>
                      <svg width="12" height="12" viewBox="0 0 28 28" fill="none" style={{ animation:'um-spin 0.85s linear infinite' }}>
                        <circle cx="14" cy="14" r="10" stroke="#00f5d4" strokeWidth="2.5" strokeDasharray="22 14" strokeLinecap="round"/>
                      </svg>
                      جاري الحفظ...
                    </>
                  ) : (
                    <>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/>
                        <polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>
                      </svg>
                      حفظ التغييرات
                    </>
                  )}
                </button>
              )}

              {/* ── Close button ── */}
              <button
                className="um-close"
                onClick={() => setDialogOpen(false)}
                style={{
                  width:'100%', padding:'12px',
                  background:'rgba(123,47,247,0.14)',
                  border:'1px solid rgba(123,47,247,0.4)',
                  color:'rgba(180,160,255,0.85)',
                  fontFamily:'Orbitron, sans-serif', fontSize:'9px',
                  letterSpacing:'0.14em', cursor:'pointer', transition:'all 0.18s',
                }}
              >
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Toast / Snackbar ─────────────────────────────────────────────── */}
      {toast && (
        <div style={{
          position:'fixed', bottom:24, left:'50%', transform:'translateX(-50%)',
          zIndex:9999,
          background:'rgba(5,8,15,0.96)',
          border:'1px solid rgba(0,245,212,0.45)',
          boxShadow:'0 4px 24px rgba(0,0,0,0.6), 0 0 16px rgba(0,245,212,0.12)',
          padding:'11px 22px',
          fontFamily:'Rajdhani, sans-serif', fontSize:'15px',
          color:'#00f5d4', letterSpacing:'0.04em',
          whiteSpace:'nowrap',
          animation:'um-toast-in 0.22s ease-out',
          pointerEvents:'none',
        }}>
          {toast}
        </div>
      )}
    </>
  );
}
