import { useState, useEffect, useRef } from 'react';
import { signOut } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';
import { getUserFromStorage, type DiyalaUser } from './UserLoginOverlay';

const STORAGE_KEY = 'diyala_user';

export function UserMenu() {
  const [menuOpen,    setMenuOpen]    = useState(false);
  const [dialogOpen,  setDialogOpen]  = useState(false);
  const [signingOut,  setSigningOut]  = useState(false);
  const [user,        setUser]        = useState<DiyalaUser | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Resolve user data: localStorage first, then Firestore as fallback
  useEffect(() => {
    const fromStorage = getUserFromStorage();
    if (fromStorage?.name) { setUser(fromStorage); return; }

    const fbUser = auth.currentUser;
    if (!fbUser) return;
    getDoc(doc(db, 'users', fbUser.uid))
      .then(snap => { if (snap.exists()) setUser(snap.data() as DiyalaUser); })
      .catch(() => {});
  }, []);

  // Close menu when clicking outside
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const handleSignOut = async () => {
    setMenuOpen(false);
    setSigningOut(true);
    try {
      localStorage.removeItem(STORAGE_KEY);
      await signOut(auth);
      // UserLoginOverlay listens to onAuthStateChanged → will re-show automatically
    } catch (e) {
      console.error('[UserMenu] sign-out error:', e);
      setSigningOut(false);
    }
  };

  const handleAccountDetails = () => {
    setMenuOpen(false);
    setDialogOpen(true);
  };

  return (
    <>
      <style>{`
        @keyframes um-fade-in { from{opacity:0;transform:scale(0.92) translateY(-6px)} to{opacity:1;transform:scale(1) translateY(0)} }
        @keyframes um-spin     { to{transform:rotate(360deg)} }
        .um-item:hover { background: rgba(123,47,247,0.12) !important; }
        .um-btn:hover  { background: rgba(123,47,247,0.18) !important; box-shadow: 0 0 20px rgba(123,47,247,0.3) !important; }
      `}</style>

      {/* ── Anchor container ──────────────────────────────────────────────── */}
      <div ref={menuRef} style={{ position: 'absolute', top: 20, right: 20, zIndex: 1500, direction: 'rtl' }}>

        {/* ── 3-dot trigger button ─────────────────────────────────────────── */}
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
              <circle cx="14" cy="14" r="10" stroke="#7b2ff7" strokeWidth="2.5"
                strokeDasharray="22 14" strokeLinecap="round" />
            </svg>
          ) : (
            /* ⋮  three vertical dots */
            <svg width="18" height="18" viewBox="0 0 24 24" fill="rgba(180,160,255,0.9)">
              <circle cx="12" cy="5"  r="1.8"/>
              <circle cx="12" cy="12" r="1.8"/>
              <circle cx="12" cy="19" r="1.8"/>
            </svg>
          )}
        </button>

        {/* ── Dropdown menu ──────────────────────────────────────────────────── */}
        {menuOpen && (
          <div style={{
            position: 'absolute', top: 48, right: 0,
            minWidth: 190,
            background: 'rgba(5,8,15,0.97)',
            border: '1px solid rgba(123,47,247,0.45)',
            boxShadow: '0 8px 40px rgba(0,0,0,0.7), 0 0 24px rgba(123,47,247,0.12)',
            animation: 'um-fade-in 0.15s ease-out',
            overflow: 'hidden',
          }}>
            {/* Account Details */}
            <button
              className="um-item"
              onClick={handleAccountDetails}
              style={{
                width: '100%', padding: '12px 16px',
                display: 'flex', alignItems: 'center', gap: 10,
                background: 'transparent', border: 'none',
                cursor: 'pointer', textAlign: 'right', transition: 'background 0.15s',
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                stroke="rgba(123,47,247,0.85)" strokeWidth="1.8" strokeLinecap="round">
                <circle cx="12" cy="8" r="4"/>
                <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
              </svg>
              <span style={{
                fontFamily: 'Rajdhani, sans-serif', fontSize: '15px',
                color: '#d4c8ff', letterSpacing: '0.02em',
              }}>تفاصيل الحساب</span>
            </button>

            <div style={{ height: 1, background: 'rgba(123,47,247,0.15)', margin: '0 12px' }} />

            {/* Sign Out */}
            <button
              className="um-item"
              onClick={handleSignOut}
              style={{
                width: '100%', padding: '12px 16px',
                display: 'flex', alignItems: 'center', gap: 10,
                background: 'transparent', border: 'none',
                cursor: 'pointer', textAlign: 'right', transition: 'background 0.15s',
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                stroke="#ff4d6d" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
                <polyline points="16 17 21 12 16 7"/>
                <line x1="21" y1="12" x2="9" y2="12"/>
              </svg>
              <span style={{
                fontFamily: 'Rajdhani, sans-serif', fontSize: '15px',
                color: '#ff4d6d', letterSpacing: '0.02em',
              }}>تسجيل الخروج</span>
            </button>
          </div>
        )}
      </div>

      {/* ── Account Details Dialog ──────────────────────────────────────────── */}
      {dialogOpen && (
        <div
          onClick={e => { if (e.target === e.currentTarget) setDialogOpen(false); }}
          style={{
            position: 'fixed', inset: 0, zIndex: 9800,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(2,4,10,0.82)', backdropFilter: 'blur(6px)',
          }}
        >
          <style>{`@keyframes um-dialog-in{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}`}</style>
          <div style={{
            width: 'min(360px, calc(100vw - 32px))',
            background: 'rgba(5,8,15,0.99)',
            border: '1px solid rgba(123,47,247,0.6)',
            boxShadow: '0 0 60px rgba(123,47,247,0.25)',
            direction: 'rtl',
            animation: 'um-dialog-in 0.18s ease-out',
          }}>
            {/* Dialog header */}
            <div style={{
              padding: '18px 20px 14px',
              borderBottom: '1px solid rgba(123,47,247,0.18)',
              background: 'rgba(123,47,247,0.06)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <div>
                <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '8px', color: 'rgba(123,47,247,0.7)', letterSpacing: '0.22em', marginBottom: '5px' }}>
                  PLAYER PROFILE
                </div>
                <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '19px', fontWeight: 700, color: '#e8f8f5' }}>
                  تفاصيل الحساب
                </div>
              </div>
              {/* Avatar circle */}
              <div style={{
                width: 44, height: 44, borderRadius: '50%',
                background: 'rgba(123,47,247,0.15)',
                border: '1px solid rgba(123,47,247,0.4)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
                  stroke="rgba(123,47,247,0.8)" strokeWidth="1.6" strokeLinecap="round">
                  <circle cx="12" cy="8" r="4"/>
                  <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
                </svg>
              </div>
            </div>

            {/* Dialog body */}
            <div style={{ padding: '20px' }}>
              {/* Name row */}
              <div style={{ marginBottom: '14px' }}>
                <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '7px', color: 'rgba(123,47,247,0.6)', letterSpacing: '0.2em', marginBottom: '6px' }}>
                  الاسم الكامل
                </div>
                <div style={{
                  padding: '10px 14px',
                  background: 'rgba(123,47,247,0.07)',
                  border: '1px solid rgba(123,47,247,0.2)',
                  fontFamily: 'Rajdhani, sans-serif', fontSize: '17px',
                  color: user?.name ? '#e8f8f5' : 'rgba(255,255,255,0.3)',
                  letterSpacing: '0.03em',
                }}>
                  {user?.name || '—'}
                </div>
              </div>

              {/* Phone row */}
              <div style={{ marginBottom: '22px' }}>
                <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '7px', color: 'rgba(123,47,247,0.6)', letterSpacing: '0.2em', marginBottom: '6px' }}>
                  رقم الهاتف
                </div>
                <div style={{
                  padding: '10px 14px',
                  background: 'rgba(123,47,247,0.07)',
                  border: '1px solid rgba(123,47,247,0.2)',
                  fontFamily: 'Rajdhani, sans-serif', fontSize: '17px',
                  color: user?.phone ? '#00f5d4' : 'rgba(255,255,255,0.3)',
                  letterSpacing: '0.04em', direction: 'ltr', textAlign: 'right',
                }}>
                  {user?.phone || '—'}
                </div>
              </div>

              {/* Close button */}
              <button
                onClick={() => setDialogOpen(false)}
                style={{
                  width: '100%', padding: '12px',
                  background: 'rgba(123,47,247,0.14)',
                  border: '1px solid rgba(123,47,247,0.4)',
                  color: 'rgba(180,160,255,0.85)',
                  fontFamily: 'Orbitron, sans-serif', fontSize: '9px',
                  letterSpacing: '0.14em', cursor: 'pointer',
                  transition: 'all 0.18s',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(123,47,247,0.28)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(123,47,247,0.14)'; }}
              >
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
