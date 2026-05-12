import { useState, useEffect } from 'react';

const STORAGE_KEY = 'diyala_user';

export interface DiyalaUser {
  name:  string;
  phone: string;
}

export function getUserFromStorage(): DiyalaUser | null {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'); }
  catch { return null; }
}

export function UserLoginOverlay({ onLogin }: { onLogin: (u: DiyalaUser) => void }) {
  const [visible, setVisible] = useState(false);
  const [name,    setName]    = useState('');
  const [phone,   setPhone]   = useState('');
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    const saved = getUserFromStorage();
    if (saved?.name && saved?.phone) { onLogin(saved); }
    else { setVisible(true); }
  }, []);

  const handleSubmit = () => {
    if (!name.trim())  { setError('الرجاء إدخال اسمك'); return; }
    if (!phone.trim()) { setError('الرجاء إدخال رقم الهاتف'); return; }
    const user: DiyalaUser = { name: name.trim(), phone: phone.trim() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
    onLogin(user);
    setVisible(false);
  };

  const handleKey = (e: React.KeyboardEvent) => { if (e.key === 'Enter') handleSubmit(); };

  if (!visible) return null;

  const inputStyle: React.CSSProperties = {
    width: '100%', background: 'rgba(123,47,247,0.08)',
    border: '1px solid rgba(123,47,247,0.4)', color: '#e8f8f5',
    fontFamily: 'Rajdhani, sans-serif', fontSize: '17px',
    padding: '11px 14px', outline: 'none', boxSizing: 'border-box',
    transition: 'border-color 0.2s',
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(2,4,10,0.92)', backdropFilter: 'blur(8px)',
    }}>
      <div style={{
        width: 'min(400px, calc(100vw - 32px))',
        background: 'rgba(5,8,15,0.99)',
        border: '1px solid #7b2ff7',
        boxShadow: '0 0 60px rgba(123,47,247,0.35), 0 0 120px rgba(123,47,247,0.12)',
        direction: 'rtl',
      }}>
        {/* Scan line animation */}
        <style>{`
          @keyframes dl-scan{0%{top:-8px;}100%{top:100%;}}
          @keyframes dl-blink{0%,100%{opacity:1;}50%{opacity:0.3;}}
        `}</style>

        {/* Header */}
        <div style={{
          padding: '20px 20px 16px',
          borderBottom: '1px solid rgba(123,47,247,0.2)',
          background: 'rgba(123,47,247,0.06)',
          position: 'relative', overflow: 'hidden',
        }}>
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg,rgba(123,47,247,0.04) 0%,transparent 100%)', pointerEvents: 'none' }} />
          <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '8px', color: '#7b2ff7', letterSpacing: '0.25em', marginBottom: '8px' }}>
            🎮 DIYALA GTA MAP · PLAYER REGISTRATION
          </div>
          <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '22px', fontWeight: 800, color: '#e8f8f5', lineHeight: 1.2 }}>
            أدخل بياناتك لتفعيل الخريطة
          </div>
          <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '13px', color: 'rgba(255,255,255,0.35)', marginTop: '5px' }}>
            ستُستخدم هذه البيانات تلقائياً عند طلب التكسي
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: '20px' }}>
          {/* Name */}
          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', fontFamily: 'Orbitron, sans-serif', fontSize: '8px', color: 'rgba(123,47,247,0.7)', letterSpacing: '0.18em', marginBottom: '7px' }}>
              الاسم
            </label>
            <input
              type="text"
              value={name}
              onChange={e => { setName(e.target.value); setError(null); }}
              onKeyDown={handleKey}
              placeholder="اكتب اسمك هنا..."
              autoFocus
              style={inputStyle}
              onFocus={e => (e.currentTarget.style.borderColor = '#7b2ff7')}
              onBlur={e => (e.currentTarget.style.borderColor = 'rgba(123,47,247,0.4)')}
            />
          </div>

          {/* Phone */}
          <div style={{ marginBottom: '18px' }}>
            <label style={{ display: 'block', fontFamily: 'Orbitron, sans-serif', fontSize: '8px', color: 'rgba(123,47,247,0.7)', letterSpacing: '0.18em', marginBottom: '7px' }}>
              رقم الهاتف
            </label>
            <input
              type="tel"
              value={phone}
              onChange={e => { setPhone(e.target.value); setError(null); }}
              onKeyDown={handleKey}
              placeholder="07XX XXX XXXX"
              style={inputStyle}
              onFocus={e => (e.currentTarget.style.borderColor = '#7b2ff7')}
              onBlur={e => (e.currentTarget.style.borderColor = 'rgba(123,47,247,0.4)')}
            />
          </div>

          {/* Error */}
          {error && (
            <div style={{ marginBottom: '14px', padding: '9px 12px', background: 'rgba(255,45,120,0.08)', border: '1px solid rgba(255,45,120,0.3)', color: '#ff2d78', fontFamily: 'Rajdhani, sans-serif', fontSize: '14px' }}>
              ⚠ {error}
            </div>
          )}

          {/* Submit */}
          <button
            onClick={handleSubmit}
            style={{
              width: '100%', padding: '14px',
              background: 'rgba(123,47,247,0.18)', border: '1px solid #7b2ff7',
              color: '#7b2ff7', fontFamily: 'Orbitron, sans-serif',
              fontSize: '11px', letterSpacing: '0.14em', cursor: 'pointer',
              boxShadow: '0 0 22px rgba(123,47,247,0.3)', transition: 'all 0.2s',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(123,47,247,0.32)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(123,47,247,0.18)'; }}
          >
            دخول إلى الخريطة ←
          </button>

          <div style={{ marginTop: '12px', fontFamily: 'Rajdhani, sans-serif', fontSize: '11px', color: 'rgba(255,255,255,0.2)', textAlign: 'center' }}>
            بياناتك تُحفظ محلياً فقط ولا تُشارك مع أي جهة
          </div>
        </div>
      </div>
    </div>
  );
}
