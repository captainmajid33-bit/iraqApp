import { useState, useEffect, useRef } from 'react';
import {
  RecaptchaVerifier,
  signInWithPhoneNumber,
  onAuthStateChanged,
  type ConfirmationResult,
} from 'firebase/auth';
import { doc, setDoc, getDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';

const STORAGE_KEY = 'diyala_user';

export interface DiyalaUser {
  name:  string;
  phone: string;
  uid?:  string;
}

export function getUserFromStorage(): DiyalaUser | null {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'); }
  catch { return null; }
}

function toE164(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('964'))  return '+' + digits;
  if (digits.startsWith('0'))    return '+964' + digits.slice(1);
  if (digits.startsWith('7'))    return '+964' + digits;
  return '+' + digits;
}

type Step = 'phone' | 'otp' | 'done';

const S: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, zIndex: 9900,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(2,4,10,0.96)', backdropFilter: 'blur(10px)',
  },
  card: {
    width: 'min(420px, calc(100vw - 24px))',
    background: 'rgba(5,8,15,0.99)',
    border: '1px solid rgba(123,47,247,0.7)',
    boxShadow: '0 0 80px rgba(123,47,247,0.3), 0 0 160px rgba(123,47,247,0.1)',
    direction: 'rtl', overflow: 'hidden',
  },
  header: {
    padding: '22px 22px 18px',
    borderBottom: '1px solid rgba(123,47,247,0.2)',
    background: 'rgba(123,47,247,0.07)',
    position: 'relative', overflow: 'hidden',
  },
  body: { padding: '22px' },
  label: {
    display: 'block',
    fontFamily: 'Orbitron, sans-serif', fontSize: '8px',
    color: 'rgba(123,47,247,0.75)', letterSpacing: '0.2em',
    marginBottom: '7px',
  },
  input: {
    width: '100%', boxSizing: 'border-box',
    background: 'rgba(123,47,247,0.07)',
    border: '1px solid rgba(123,47,247,0.35)', color: '#e8f8f5',
    fontFamily: 'Rajdhani, sans-serif', fontSize: '17px',
    padding: '11px 14px', outline: 'none', transition: 'border-color 0.2s',
  },
  btn: {
    width: '100%', padding: '14px',
    background: 'rgba(123,47,247,0.2)', border: '1px solid #7b2ff7',
    color: '#c4b5fd', fontFamily: 'Orbitron, sans-serif',
    fontSize: '10px', letterSpacing: '0.14em', cursor: 'pointer',
    boxShadow: '0 0 22px rgba(123,47,247,0.25)', transition: 'all 0.2s',
  },
  btnDisabled: {
    width: '100%', padding: '14px',
    background: 'rgba(123,47,247,0.07)', border: '1px solid rgba(123,47,247,0.25)',
    color: 'rgba(123,47,247,0.4)', fontFamily: 'Orbitron, sans-serif',
    fontSize: '10px', letterSpacing: '0.14em', cursor: 'not-allowed',
  },
  error: {
    padding: '9px 12px', marginBottom: '14px',
    background: 'rgba(255,45,120,0.08)', border: '1px solid rgba(255,45,120,0.3)',
    color: '#ff8099', fontFamily: 'Rajdhani, sans-serif', fontSize: '14px',
  },
};

export function UserLoginOverlay({ onLogin }: { onLogin: (u: DiyalaUser) => void }) {
  const [visible,   setVisible]   = useState(false);
  const [step,      setStep]      = useState<Step>('phone');
  const [name,      setName]      = useState('');
  const [phone,     setPhone]     = useState('');
  const [otp,       setOtp]       = useState('');
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const [sentTo,    setSentTo]    = useState('');
  const [countdown, setCountdown] = useState(0);

  const confirmRef = useRef<ConfirmationResult | null>(null);
  const captchaRef = useRef<RecaptchaVerifier | null>(null);

  // ── Destroy & reset the reCAPTCHA widget cleanly ─────────────────────────
  const clearRecaptcha = () => {
    try { captchaRef.current?.clear(); } catch {}
    captchaRef.current = null;
    const el = document.getElementById('rcv-container');
    if (el) el.innerHTML = '';
  };

  // ── Create & pre-render an invisible RecaptchaVerifier ───────────────────
  // Called as early as possible so Google has time to silently verify the user
  // before they click "Send OTP". This prevents the visual challenge pop-up.
  const initRecaptcha = async () => {
    if (captchaRef.current) return; // already initialised
    try {
      const v = new RecaptchaVerifier(auth, 'rcv-container', {
        size: 'invisible',           // ← never shows a checkbox to the user
        callback:          () => { console.log('[PhoneAuth] reCAPTCHA ✓ solved silently'); },
        'expired-callback':() => { console.warn('[PhoneAuth] reCAPTCHA expired — will reinit'); clearRecaptcha(); },
      });
      await v.render(); // pre-render so the token is ready when signIn is called
      captchaRef.current = v;
      console.log('[PhoneAuth] reCAPTCHA initialised early ✓');
    } catch (e) {
      console.warn('[PhoneAuth] early reCAPTCHA init failed (will retry on send):', e);
    }
  };

  // ── Auth-state listener (runs on mount) ──────────────────────────────────
  useEffect(() => {
    // Kick off reCAPTCHA immediately — gives Google the most time to analyse
    // the user silently, minimising the chance of a visual challenge.
    initRecaptcha();

    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      if (fbUser) {
        const saved = getUserFromStorage();
        if (saved?.name && saved?.phone && saved?.uid === fbUser.uid) {
          onLogin(saved); return;
        }
        try {
          const snap = await getDoc(doc(db, 'users', fbUser.uid));
          if (snap.exists()) {
            const data = snap.data() as DiyalaUser;
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
            onLogin(data); return;
          }
        } catch { /* fall through → show form */ }
      }
      setVisible(true);
    });
    return () => { unsub(); clearRecaptcha(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Countdown timer ───────────────────────────────────────────────────────
  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  // ── Send OTP ─────────────────────────────────────────────────────────────
  const sendOtp = async () => {
    const trimName  = name.trim();
    const trimPhone = phone.trim();
    if (!trimName)  { setError('الرجاء إدخال اسمك الكامل'); return; }
    if (!trimPhone) { setError('الرجاء إدخال رقم الهاتف');   return; }

    const e164 = toE164(trimPhone);
    console.log('[PhoneAuth] → sending to:', e164);

    if (!/^\+964\d{10}$/.test(e164)) {
      setError('رقم الهاتف غير صحيح — مثال: 07742533658'); return;
    }

    setLoading(true); setError(null);
    try {
      // Ensure verifier is ready (may already be from early init)
      if (!captchaRef.current) await initRecaptcha();
      const verifier = captchaRef.current!;

      console.log('[PhoneAuth] calling signInWithPhoneNumber...');
      const result = await signInWithPhoneNumber(auth, e164, verifier);
      confirmRef.current = result;
      setSentTo(e164);
      setStep('otp');
      setCountdown(60);
      console.log('[PhoneAuth] OTP dispatched ✓');
    } catch (e: any) {
      console.error('[PhoneAuth] sendOtp FAILED ▼', {
        code:    e?.code,
        message: e?.message,
        full:    e,
      });
      clearRecaptcha();
      // Re-init for next attempt
      setTimeout(() => initRecaptcha(), 300);

      if      (e?.code === 'auth/too-many-requests')     setError('طلبات كثيرة جداً، انتظر قليلاً ثم أعد المحاولة');
      else if (e?.code === 'auth/invalid-phone-number')  setError('رقم الهاتف غير صالح');
      else if (e?.code === 'auth/captcha-check-failed')  setError('فشل التحقق الصامت — أعد تحميل الصفحة');
      else if (e?.code === 'auth/operation-not-allowed') setError('Phone Auth غير مفعّل في Firebase Console');
      else setError(`خطأ Firebase: ${e?.code ?? e?.message ?? 'unknown'}`);
    } finally {
      setLoading(false);
    }
  };

  // ── Verify OTP ────────────────────────────────────────────────────────────
  const verifyOtp = async () => {
    if (otp.length < 6)        { setError('الرجاء إدخال الرمز المكوّن من 6 أرقام'); return; }
    if (!confirmRef.current)   { setError('انتهت الجلسة، أعد إرسال الرمز'); return; }
    setLoading(true); setError(null);
    try {
      console.log('[PhoneAuth] confirming OTP...');
      const cred = await confirmRef.current.confirm(otp);
      const uid  = cred.user.uid;
      console.log('[PhoneAuth] UID:', uid);
      const user: DiyalaUser = { name: name.trim(), phone: phone.trim(), uid };

      // ① Save to localStorage immediately — onAuthStateChanged may fire before
      //    Firestore write completes, so this ensures the listener can read the name.
      localStorage.setItem(STORAGE_KEY, JSON.stringify(user));

      // ② Navigate right away — never block on Firestore.
      setStep('done');
      setVisible(false);
      onLogin(user);

      // ③ Write to Firestore in the background (non-blocking).
      //    If Security Rules reject this, the user is still on the map.
      setDoc(doc(db, 'users', uid), {
        name:      user.name,
        phone:     user.phone,
        uid,
        createdAt: serverTimestamp(),
      }, { merge: true }).catch(e => {
        console.warn('[PhoneAuth] Firestore setDoc failed (non-critical):', e?.code, e?.message);
      });

    } catch (e: any) {
      console.error('[PhoneAuth] verifyOtp FAILED ▼', {
        code:    e?.code,
        message: e?.message,
        full:    e,
      });
      if      (e?.code === 'auth/invalid-verification-code') setError('الرمز غير صحيح، تأكد من الأرقام');
      else if (e?.code === 'auth/code-expired')              setError('انتهت صلاحية الرمز، اضغط "إعادة الإرسال"');
      else setError(`خطأ Firebase: ${e?.code ?? e?.message ?? 'unknown'}`);
    } finally {
      // Always unblock the UI — runs whether confirm() succeeded, failed, or hung.
      setLoading(false);
    }
  };

  // ── Resend ────────────────────────────────────────────────────────────────
  const resendOtp = async () => {
    if (countdown > 0) return;
    clearRecaptcha();
    setOtp(''); setError(null);
    await initRecaptcha();
    await sendOtp();
  };

  // ── The reCAPTCHA anchor is ALWAYS in the DOM (never removed) ─────────────
  // This gives Google maximum time to silently verify the user before submit.
  const captchaAnchor = (
    <div
      id="rcv-container"
      style={{ position: 'fixed', bottom: '-9999px', left: '-9999px',
               width: 0, height: 0, overflow: 'hidden', pointerEvents: 'none' }}
    />
  );

  if (!visible) return captchaAnchor;

  const isPhoneStep = step === 'phone';

  return (
    <>
      {captchaAnchor}
      <style>{`
        @keyframes dl-scan  { 0%{top:-8px} 100%{top:100%} }
        @keyframes dl-blink { 0%,100%{opacity:1} 50%{opacity:0.25} }
        @keyframes dl-spin  { to{transform:rotate(360deg)} }
        .dl-btn:hover { background:rgba(123,47,247,0.35) !important; box-shadow:0 0 36px rgba(123,47,247,0.45) !important; }
        .dl-input:focus { border-color:#7b2ff7 !important; box-shadow:0 0 0 2px rgba(123,47,247,0.15); }
        .dl-otp-input { letter-spacing:0.35em; text-align:center; font-size:26px !important; }
      `}</style>

      <div style={S.overlay}>
        <div style={S.card}>

          {/* ── Header ── */}
          <div style={S.header}>
            <div style={{
              position: 'absolute', inset: 0,
              background: 'linear-gradient(180deg,rgba(123,47,247,0.06) 0%,transparent 100%)',
              pointerEvents: 'none',
            }} />
            <div style={{
              position: 'absolute', top: 0, left: 0, right: 0, height: '2px',
              background: 'linear-gradient(90deg,transparent,rgba(123,47,247,0.8),transparent)',
              animation: 'dl-scan 2.8s linear infinite',
            }} />

            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
              <div style={{
                width: '8px', height: '8px', borderRadius: '50%',
                background: '#7b2ff7', boxShadow: '0 0 12px #7b2ff7',
                animation: 'dl-blink 1.4s ease-in-out infinite', flexShrink: 0,
              }} />
              <div style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '8px', color: 'rgba(123,47,247,0.8)', letterSpacing: '0.25em' }}>
                {isPhoneStep ? 'PLAYER REGISTRATION · تسجيل الدخول' : 'OTP VERIFICATION · التحقق من الهوية'}
              </div>
            </div>

            <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '22px', fontWeight: 800, color: '#e8f8f5', lineHeight: 1.2 }}>
              {isPhoneStep ? 'أدخل بياناتك للدخول إلى الخريطة' : 'أدخل رمز التحقق'}
            </div>
            {isPhoneStep ? (
              <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '13px', color: 'rgba(255,255,255,0.3)', marginTop: '5px' }}>
                سيتم إرسال رمز التحقق (OTP) إلى رقمك
              </div>
            ) : (
              <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '13px', color: 'rgba(0,245,212,0.6)', marginTop: '5px' }}>
                تم الإرسال إلى {sentTo}
              </div>
            )}
          </div>

          {/* ── Body ── */}
          <div style={S.body}>

            {/* ── STEP 1: Name + Phone ── */}
            {isPhoneStep && (
              <>
                <div style={{ marginBottom: '16px' }}>
                  <label style={S.label}>الاسم الكامل</label>
                  <input
                    className="dl-input"
                    type="text"
                    value={name}
                    onChange={e => { setName(e.target.value); setError(null); }}
                    onKeyDown={e => e.key === 'Enter' && sendOtp()}
                    placeholder="مثال: أحمد محمد"
                    autoFocus
                    disabled={loading}
                    style={S.input}
                  />
                </div>

                <div style={{ marginBottom: '20px' }}>
                  <label style={S.label}>رقم الهاتف</label>
                  <div style={{ position: 'relative' }}>
                    <span style={{
                      position: 'absolute', right: '14px', top: '50%', transform: 'translateY(-50%)',
                      fontFamily: 'Rajdhani, sans-serif', fontSize: '15px',
                      color: 'rgba(123,47,247,0.7)', pointerEvents: 'none', userSelect: 'none',
                    }}>+964</span>
                    <input
                      className="dl-input"
                      type="tel"
                      inputMode="numeric"
                      value={phone}
                      onChange={e => { setPhone(e.target.value); setError(null); }}
                      onKeyDown={e => e.key === 'Enter' && sendOtp()}
                      placeholder="07XX XXX XXXX"
                      disabled={loading}
                      style={{ ...S.input, paddingRight: '56px' }}
                    />
                  </div>
                </div>
              </>
            )}

            {/* ── STEP 2: OTP ── */}
            {step === 'otp' && (
              <>
                <div style={{ marginBottom: '20px' }}>
                  <label style={S.label}>رمز التحقق (6 أرقام)</label>
                  <input
                    className="dl-input dl-otp-input"
                    type="text"
                    inputMode="numeric"
                    value={otp}
                    onChange={e => { setOtp(e.target.value.replace(/\D/g, '').slice(0, 6)); setError(null); }}
                    onKeyDown={e => e.key === 'Enter' && verifyOtp()}
                    placeholder="• • • • • •"
                    maxLength={6}
                    autoFocus
                    disabled={loading}
                    style={S.input}
                  />
                </div>

                <div style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <button
                    onClick={resendOtp}
                    disabled={countdown > 0 || loading}
                    style={{
                      background: 'none', border: 'none', padding: 0,
                      cursor: countdown > 0 ? 'not-allowed' : 'pointer',
                      fontFamily: 'Rajdhani, sans-serif', fontSize: '13px',
                      color: countdown > 0 ? 'rgba(255,255,255,0.2)' : 'rgba(0,245,212,0.7)',
                      textDecoration: countdown > 0 ? 'none' : 'underline',
                    }}
                  >
                    إعادة الإرسال
                  </button>
                  {countdown > 0 && (
                    <span style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '11px', color: 'rgba(123,47,247,0.6)' }}>
                      {countdown}s
                    </span>
                  )}
                  <button
                    onClick={() => { setStep('phone'); setOtp(''); setError(null); clearRecaptcha(); initRecaptcha(); }}
                    disabled={loading}
                    style={{
                      background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                      fontFamily: 'Rajdhani, sans-serif', fontSize: '13px', color: 'rgba(255,255,255,0.3)',
                    }}
                  >
                    ← تغيير الرقم
                  </button>
                </div>
              </>
            )}

            {/* ── Error ── */}
            {error && <div style={S.error}>⚠ {error}</div>}

            {/* ── Submit ── */}
            <button
              className={loading ? '' : 'dl-btn'}
              onClick={isPhoneStep ? sendOtp : verifyOtp}
              disabled={loading}
              style={loading ? S.btnDisabled : S.btn}
            >
              {loading ? (
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                  <svg width="14" height="14" viewBox="0 0 28 28" fill="none" style={{ animation: 'dl-spin 0.9s linear infinite' }}>
                    <circle cx="14" cy="14" r="10" stroke="#7b2ff7" strokeWidth="2.5" strokeDasharray="22 14" strokeLinecap="round" />
                  </svg>
                  جاري المعالجة...
                </span>
              ) : isPhoneStep ? 'إرسال رمز التحقق ←' : 'تحقق والدخول إلى الخريطة ←'}
            </button>

            <div style={{ marginTop: '12px', fontFamily: 'Rajdhani, sans-serif', fontSize: '11px', color: 'rgba(255,255,255,0.18)', textAlign: 'center' }}>
              بياناتك آمنة ومحمية · Firebase Authentication
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
