import { useState, useEffect, useCallback } from 'react';
import {
  collection, query, where, onSnapshot,
  serverTimestamp, getDoc, doc,
  getDocs, limit, runTransaction, setDoc,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { getUserFromStorage } from '@/components/UserLoginOverlay';

const MIN_BALANCE = 2000;

// ── Convert 24h key → Arabic label ──────────────────────────────────────────
function keyToLabel(key: string): string {
  const [hStr, mStr] = key.split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr || '0', 10);
  const period = h < 12 ? 'ص' : 'م';
  const h12    = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

// ── Normalize a raw slot entry → { key, label } ───────────────────────────
interface SlotEntry { key: string; label: string; }

function normalizeSlots(raw: unknown): SlotEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s: unknown) => {
      if (typeof s === 'string' && s.trim()) {
        return { key: s.trim(), label: keyToLabel(s.trim()) };
      }
      if (s && typeof s === 'object') {
        const obj = s as Record<string, unknown>;
        const key = String(obj.key ?? obj.time ?? obj.slot ?? '').trim();
        const label = String(obj.label ?? obj.name ?? '').trim() || keyToLabel(key);
        if (key) return { key, label };
      }
      return null;
    })
    .filter((x): x is SlotEntry => x !== null);
}

function dateToStr(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
}

/**
 * Returns the "target booking date":
 * - Before 21:00 → today
 * - 21:00 or later → tomorrow (slots roll over to next day)
 */
function targetDateStr(): string {
  const now = new Date();
  if (now.getHours() >= 21) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return dateToStr(tomorrow);
  }
  return dateToStr(now);
}

interface Props {
  doctorId:   string | number;
  doctorName: string;
  doctorLat?: number;
  doctorLng?: number;
  onClose:    () => void;
}

export function DoctorBookingModal({ doctorId, doctorName, doctorLat, doctorLng, onClose }: Props) {
  const [bookedSlots,    setBookedSlots]    = useState<Set<string>>(new Set());
  const [availableSlots, setAvailableSlots] = useState<SlotEntry[]>([]);
  const [slotsLoading,   setSlotsLoading]   = useState(true);
  const [selected,       setSelected]       = useState<string | null>(null);
  const [phase,          setPhase]          = useState<'checking' | 'insufficient' | 'already_booked' | 'slots' | 'cost_confirm' | 'confirming' | 'success'>('checking');
  const [errMsg,         setErrMsg]         = useState('');
  const [userBalance,    setUserBalance]    = useState<number>(0);
  // Firebase UID of the doctor (stored in merchants/{id}.uid) — used as merchantId in appointment doc
  const [merchantUid,    setMerchantUid]    = useState<string>('');

  const today    = targetDateStr();
  const user     = getUserFromStorage();
  const userId   = user?.uid  ?? 'anonymous';
  const userName = user?.name ?? 'زبون';

  // ── Step 1: Check balance → then check duplicate booking ────────────────
  useEffect(() => {
    let cancelled = false;
    async function checkBalanceThenDuplicate() {
      if (!userId || userId === 'anonymous') {
        if (!cancelled) setPhase('insufficient');
        return;
      }
      try {
        // 1a. Balance check
        const userSnap = await getDoc(doc(db, 'users', userId));
        const bal = userSnap.exists() ? (Number(userSnap.data()?.balance) || 0) : 0;
        if (cancelled) return;
        setUserBalance(bal);
        if (bal < MIN_BALANCE) { setPhase('insufficient'); return; }

        // 1b. Duplicate booking check — same doctor, same day, same user
        const dupQ = query(
          collection(db, 'doctors', String(doctorId), 'appointments'),
          where('date',   '==', today),
          where('userId', '==', userId),
          limit(1),
        );
        const dupSnap = await getDocs(dupQ);
        if (cancelled) return;
        if (!dupSnap.empty) { setPhase('already_booked'); return; }

        setPhase('slots');
      } catch {
        if (!cancelled) setPhase('slots'); // fail-open
      }
    }
    checkBalanceThenDuplicate();
    return () => { cancelled = true; };
  }, [userId, doctorId, today]);

  // ── Step 2: Fetch available_slots from merchants/{doctorId} ───────────────
  useEffect(() => {
    if (phase !== 'slots' && phase !== 'confirming' && phase !== 'success') return;
    let cancelled = false;
    async function fetchSlots() {
      setSlotsLoading(true);
      try {
        const snap = await getDoc(doc(db, 'merchants', String(doctorId)));
        if (cancelled) return;
        const data = snap.exists() ? snap.data() : undefined;
        setAvailableSlots(normalizeSlots(data?.available_slots));
        // Grab the doctor's Firebase UID stored in the merchant doc
        if (data?.uid) setMerchantUid(String(data.uid));
      } catch {
        if (!cancelled) setAvailableSlots([]);
      } finally {
        if (!cancelled) setSlotsLoading(false);
      }
    }
    fetchSlots();
    return () => { cancelled = true; };
  }, [doctorId, phase]);

  // ── Step 3: Real-time listener — today's booked appointments ─────────────
  useEffect(() => {
    if (phase !== 'slots' && phase !== 'confirming' && phase !== 'success') return;
    const colRef = collection(db, 'doctors', String(doctorId), 'appointments');
    const q      = query(colRef, where('date', '==', today));
    const unsub  = onSnapshot(q, snap => {
      const booked = new Set<string>();
      snap.forEach(d => booked.add(d.data().slot_time as string));
      setBookedSlots(booked);
    }, () => {});
    return unsub;
  }, [doctorId, today, phase]);

  // ── Open cost-confirm dialog when user taps "تأكيد الحجز" ─────────────────
  const requestConfirm = useCallback(() => {
    if (!selected) return;
    setErrMsg('');
    setPhase('cost_confirm');
  }, [selected]);

  // ── Run transaction: deduct balance + create appointment ──────────────────
  const executeBooking = useCallback(async () => {
    if (!selected) return;
    setPhase('confirming');
    setErrMsg('');
    try {
      const userRef    = doc(db, 'users', userId);
      const apptCol    = collection(db, 'doctors', String(doctorId), 'appointments');
      // Pre-create ref so we can read its ID after the transaction
      const newApptRef = doc(apptCol);

      await runTransaction(db, async (txn) => {
        const userSnap = await txn.get(userRef);
        const bal = userSnap.exists() ? (Number(userSnap.data()?.balance) || 0) : 0;
        if (bal < MIN_BALANCE) throw new Error('INSUFFICIENT');

        // Deduct 2000 from balance
        txn.update(userRef, { balance: bal - MIN_BALANCE });

        // Create appointment document
        // merchantId = doctor's Firebase UID (from merchants/{id}.uid) — falls back to numeric id
        // time       = 24h slot string (e.g. "15:00") — required by merchant app
        // slot_time  = same value kept for admin backward-compatibility
        txn.set(newApptRef, {
          merchantId: merchantUid || String(doctorId),
          slot_time:  selected,
          time:       selected,
          userId,
          userName,
          date:       today,
          createdAt:  serverTimestamp(),
        });
      });

      // ── Write geo-mirror doc for client-side geofencing ──────────────────
      if (userId !== 'anonymous') {
        const mirrorRef = doc(collection(db, 'users', userId, 'myAppointments'));
        await setDoc(mirrorRef, {
          doctorId:      String(doctorId),
          apptDocId:     newApptRef.id,
          slot_time:     selected,
          date:          today,
          doctorLat:     doctorLat ?? null,
          doctorLng:     doctorLng ?? null,
          isUserArrived: false,
          createdAt:     serverTimestamp(),
        });
      }

      setPhase('success');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg === 'INSUFFICIENT') {
        setErrMsg('رصيدك غير كافٍ!');
      } else {
        setErrMsg('فشل الحجز، يرجى المحاولة مرة أخرى.');
      }
      setPhase('slots');
    }
  }, [selected, doctorId, userId, userName, today, doctorLat, doctorLng]);

  const selectedLabel = availableSlots.find(s => s.key === selected)?.label ?? selected ?? '';

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 2100,
      background: 'rgba(2,5,12,0.93)', backdropFilter: 'blur(14px)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      direction: 'rtl', padding: '20px',
    }}>
      <div style={{
        width: '100%', maxWidth: '400px',
        background: 'rgba(5,8,15,0.99)',
        border: `2px solid ${phase === 'insufficient' || phase === 'already_booked' ? '#ff2d78' : '#00f5d4'}`,
        borderRadius: '8px',
        boxShadow: phase === 'insufficient' || phase === 'already_booked'
          ? '0 0 60px rgba(255,45,120,0.25), 0 0 120px rgba(255,45,120,0.08)'
          : '0 0 60px rgba(0,245,212,0.25), 0 0 120px rgba(0,245,212,0.08)',
        overflow: 'hidden',
        transition: 'border-color 0.3s, box-shadow 0.3s',
      }}>

        {/* ── Header ── */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 18px',
          borderBottom: `1px solid ${phase === 'insufficient' || phase === 'already_booked' ? 'rgba(255,45,120,0.18)' : 'rgba(0,245,212,0.18)'}`,
          background: phase === 'insufficient' || phase === 'already_booked' ? 'rgba(255,45,120,0.05)' : 'rgba(0,245,212,0.05)',
        }}>
          <div>
            <div style={{
              fontFamily: 'Orbitron, sans-serif', fontSize: '9px',
              color: phase === 'insufficient' || phase === 'already_booked' ? 'rgba(255,45,120,0.55)' : 'rgba(0,245,212,0.55)',
              letterSpacing: '0.16em', marginBottom: '3px',
            }}>
              🏥 APPOINTMENT BOOKING
            </div>
            <div style={{
              fontFamily: 'Rajdhani, sans-serif', fontSize: '16px', fontWeight: 700,
              color: phase === 'insufficient' || phase === 'already_booked' ? '#ff2d78' : '#00f5d4',
            }}>
              {doctorName}
            </div>
          </div>
          <button onClick={onClose} style={{
            width: '32px', height: '32px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(255,45,120,0.12)', border: '1.5px solid rgba(255,45,120,0.5)',
            borderRadius: '4px', color: '#ff2d78', fontSize: '16px', cursor: 'pointer',
          }}>✕</button>
        </div>

        {/* ── Content ── */}
        {phase === 'checking'      && <CheckingView />}
        {phase === 'insufficient'  && <InsufficientView balance={userBalance} onClose={onClose} />}
        {phase === 'already_booked'&& <AlreadyBookedView onClose={onClose} />}
        {phase === 'cost_confirm'  && (
          <CostConfirmView
            label={selectedLabel}
            onConfirm={executeBooking}
            onCancel={() => setPhase('slots')}
          />
        )}
        {phase === 'success'       && <SuccessView label={selectedLabel} onClose={onClose} />}

        {(phase === 'slots' || phase === 'confirming') && (
          <div style={{ padding: '18px' }}>

            {/* Date label */}
            <div style={{
              fontFamily: 'Rajdhani, sans-serif', fontSize: '13px',
              color: 'rgba(255,255,255,0.45)', marginBottom: '14px',
            }}>
              الأوقات المتاحة ليوم{' '}
              <span style={{ color: '#00f5d4' }}>{today}</span>
              {' '}— اختر وقتاً مناسباً:
            </div>

            {/* Slots grid — dynamic from Firestore */}
            {slotsLoading ? (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                gap: '10px', padding: '32px 0',
              }}>
                <svg width="22" height="22" viewBox="0 0 28 28" fill="none"
                  style={{ animation: 'lf-spin 0.85s linear infinite' }}>
                  <circle cx="14" cy="14" r="10" stroke="#00f5d4" strokeWidth="2.5"
                    strokeDasharray="22 14" strokeLinecap="round"/>
                </svg>
                <span style={{
                  fontFamily: 'Rajdhani, sans-serif', fontSize: '14px',
                  color: 'rgba(0,245,212,0.6)',
                }}>جاري تحميل الأوقات...</span>
              </div>
            ) : availableSlots.length === 0 ? (
              <div style={{
                textAlign: 'center', padding: '32px 0',
                fontFamily: 'Rajdhani, sans-serif', fontSize: '15px',
                color: 'rgba(255,255,255,0.3)',
              }}>
                <div style={{ fontSize: '36px', marginBottom: '10px', opacity: 0.4 }}>📅</div>
                لا توجد أوقات متاحة لهذا الطبيب حالياً
              </div>
            ) : (
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: '8px', marginBottom: '18px',
              }}>
                {availableSlots.map(slot => {
                  const isBooked   = bookedSlots.has(slot.key);
                  const isSelected = selected === slot.key;
                  return (
                    <button
                      key={slot.key}
                      disabled={isBooked || phase === 'confirming'}
                      onClick={() => !isBooked && setSelected(slot.key)}
                      style={{
                        padding: '10px 4px',
                        fontFamily: 'Rajdhani, sans-serif', fontSize: '15px', fontWeight: 600,
                        borderRadius: '5px',
                        cursor: isBooked || phase === 'confirming' ? 'not-allowed' : 'pointer',
                        transition: 'all 0.15s',
                        background: isBooked
                          ? 'rgba(255,45,120,0.06)'
                          : isSelected
                          ? 'rgba(0,245,212,0.22)'
                          : 'rgba(0,245,212,0.05)',
                        border: isBooked
                          ? '1px solid rgba(255,45,120,0.22)'
                          : isSelected
                          ? '2px solid #00f5d4'
                          : '1px solid rgba(0,245,212,0.22)',
                        color: isBooked
                          ? 'rgba(255,255,255,0.2)'
                          : isSelected
                          ? '#00f5d4'
                          : 'rgba(255,255,255,0.78)',
                        boxShadow: isSelected ? '0 0 14px rgba(0,245,212,0.3)' : 'none',
                        textDecoration: isBooked ? 'line-through' : 'none',
                        lineHeight: 1.2,
                      }}
                    >
                      {slot.label}
                      {isBooked && (
                        <div style={{
                          fontSize: '8px', color: 'rgba(255,45,120,0.55)',
                          fontFamily: 'Orbitron, sans-serif', marginTop: '2px',
                          textDecoration: 'none',
                        }}>محجوز</div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Error */}
            {errMsg && (
              <div style={{
                color: '#ff2d78', fontFamily: 'Rajdhani, sans-serif',
                fontSize: '14px', marginBottom: '10px',
              }}>{errMsg}</div>
            )}

            {/* Confirm button */}
            {availableSlots.length > 0 && !slotsLoading && (
              <button
                onClick={requestConfirm}
                disabled={!selected || phase === 'confirming'}
                style={{
                  width: '100%', padding: '14px',
                  fontFamily: 'Orbitron, sans-serif', fontSize: '11px', letterSpacing: '0.13em',
                  background: selected
                    ? 'linear-gradient(135deg,rgba(0,245,212,0.22),rgba(0,245,212,0.08))'
                    : 'rgba(0,245,212,0.04)',
                  border: `2px solid ${selected ? '#00f5d4' : 'rgba(0,245,212,0.18)'}`,
                  color: selected ? '#00f5d4' : 'rgba(0,245,212,0.28)',
                  borderRadius: '5px',
                  cursor: selected && phase !== 'confirming' ? 'pointer' : 'not-allowed',
                  boxShadow: selected ? '0 0 22px rgba(0,245,212,0.28)' : 'none',
                  transition: 'all 0.2s',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
                }}
              >
                {phase === 'confirming'
                  ? (
                    <>
                      <svg width="14" height="14" viewBox="0 0 28 28" fill="none"
                        style={{ animation: 'lf-spin 0.9s linear infinite', flexShrink: 0 }}>
                        <circle cx="14" cy="14" r="10" stroke="#00f5d4" strokeWidth="2.5"
                          strokeDasharray="22 14" strokeLinecap="round"/>
                      </svg>
                      جاري الحجز...
                    </>
                  )
                  : 'تأكيد الحجز'
                }
              </button>
            )}

          </div>
        )}
      </div>
    </div>
  );
}

// ── Checking balance spinner ────────────────────────────────────────────────
function CheckingView() {
  return (
    <div style={{ padding: '48px 24px', textAlign: 'center', direction: 'rtl' }}>
      <svg width="40" height="40" viewBox="0 0 40 40" fill="none"
        style={{ animation: 'lf-spin 1s linear infinite', margin: '0 auto 16px' }}>
        <circle cx="20" cy="20" r="15" stroke="#00f5d4" strokeWidth="3"
          strokeDasharray="30 20" strokeLinecap="round"/>
      </svg>
      <div style={{
        fontFamily: 'Orbitron, sans-serif', fontSize: '10px',
        color: 'rgba(0,245,212,0.5)', letterSpacing: '0.14em',
      }}>
        جاري التحقق من رصيدك...
      </div>
    </div>
  );
}

// ── Insufficient balance dialog ─────────────────────────────────────────────
function InsufficientView({ balance, onClose }: { balance: number; onClose: () => void }) {
  return (
    <div style={{ padding: '32px 24px', textAlign: 'center', direction: 'rtl' }}>

      <div style={{
        width: '72px', height: '72px', borderRadius: '50%',
        background: 'rgba(255,45,120,0.1)',
        border: '2px solid rgba(255,45,120,0.5)',
        boxShadow: '0 0 30px rgba(255,45,120,0.25)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        margin: '0 auto 20px',
        fontSize: '32px',
      }}>💸</div>

      <div style={{
        fontFamily: 'Orbitron, sans-serif', fontSize: '11px',
        color: '#ff2d78', letterSpacing: '0.14em',
        marginBottom: '14px',
        textShadow: '0 0 12px rgba(255,45,120,0.5)',
      }}>رصيد غير كافٍ</div>

      <div style={{
        fontFamily: 'Rajdhani, sans-serif', fontSize: '16px', fontWeight: 600,
        color: 'rgba(255,255,255,0.88)', lineHeight: 1.7,
        marginBottom: '18px',
      }}>
        عذراً، رصيدك الحالي غير كافٍ.
        <br/>
        يجب أن يكون في محفظتك{' '}
        <span style={{ color: '#f5c518', fontWeight: 700 }}>2,000 دينار</span>{' '}
        على الأقل للتمكن من حجز موعد!
        <br/>
        يرجى شحن رصيدك أولاً 💸
      </div>

      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: '8px',
        padding: '8px 20px',
        background: 'rgba(255,45,120,0.07)',
        border: '1px solid rgba(255,45,120,0.3)',
        borderRadius: '4px',
        marginBottom: '24px',
      }}>
        <span style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '13px', color: 'rgba(255,255,255,0.45)' }}>
          رصيدك الحالي:
        </span>
        <span style={{ fontFamily: 'Orbitron, sans-serif', fontSize: '13px', fontWeight: 700, color: '#ff2d78' }}>
          {balance.toLocaleString()} د.ع
        </span>
      </div>

      <div style={{ height: '1px', background: 'rgba(255,45,120,0.15)', marginBottom: '22px' }} />

      <button onClick={onClose} style={{
        width: '100%', padding: '13px',
        fontFamily: 'Orbitron, sans-serif', fontSize: '10px', letterSpacing: '0.15em',
        background: 'rgba(255,45,120,0.12)', border: '2px solid rgba(255,45,120,0.55)',
        color: '#ff2d78', borderRadius: '5px', cursor: 'pointer',
        boxShadow: '0 0 18px rgba(255,45,120,0.2)',
        transition: 'background 0.2s',
      }}
        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,45,120,0.2)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,45,120,0.12)')}
      >
        حسناً — إغلاق
      </button>

    </div>
  );
}

// ── Cost-confirm dialog ─────────────────────────────────────────────────────
function CostConfirmView({
  label, onConfirm, onCancel,
}: { label: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div style={{ padding: '28px 22px', direction: 'rtl' }}>

      {/* Warning icon */}
      <div style={{
        width: '64px', height: '64px', borderRadius: '50%',
        background: 'rgba(245,197,24,0.1)',
        border: '2px solid rgba(245,197,24,0.55)',
        boxShadow: '0 0 28px rgba(245,197,24,0.2)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        margin: '0 auto 18px', fontSize: '28px',
      }}>💳</div>

      {/* Title */}
      <div style={{
        fontFamily: 'Orbitron, sans-serif', fontSize: '10px',
        color: '#f5c518', letterSpacing: '0.15em',
        textAlign: 'center', marginBottom: '14px',
        textShadow: '0 0 10px rgba(245,197,24,0.4)',
      }}>تنبيه — استقطاع من المحفظة</div>

      {/* Body */}
      <div style={{
        background: 'rgba(245,197,24,0.06)',
        border: '1px solid rgba(245,197,24,0.22)',
        borderRadius: '6px',
        padding: '14px 16px',
        marginBottom: '22px',
        fontFamily: 'Rajdhani, sans-serif', fontSize: '15px', fontWeight: 500,
        color: 'rgba(255,255,255,0.85)', lineHeight: 1.8, textAlign: 'center',
      }}>
        سيتم استقطاع{' '}
        <span style={{ color: '#f5c518', fontWeight: 700, fontSize: '17px' }}>2,000 دينار عراقي</span>
        {' '}من محفظتك لتأكيد موعدك بالساعة{' '}
        <span style={{ color: '#00f5d4', fontWeight: 700 }}>{label}</span>.
        <br/>
        <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.45)' }}>
          هل تريد الاستمرار؟
        </span>
      </div>

      {/* Divider */}
      <div style={{ height: '1px', background: 'rgba(255,255,255,0.07)', marginBottom: '18px' }} />

      {/* Buttons */}
      <div style={{ display: 'flex', gap: '10px' }}>
        <button
          onClick={onCancel}
          style={{
            flex: 1, padding: '13px',
            fontFamily: 'Orbitron, sans-serif', fontSize: '10px', letterSpacing: '0.13em',
            background: 'rgba(255,45,120,0.08)', border: '1.5px solid rgba(255,45,120,0.4)',
            color: 'rgba(255,45,120,0.8)', borderRadius: '5px', cursor: 'pointer',
            transition: 'background 0.2s',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,45,120,0.16)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,45,120,0.08)')}
        >إلغاء</button>

        <button
          onClick={onConfirm}
          style={{
            flex: 2, padding: '13px',
            fontFamily: 'Orbitron, sans-serif', fontSize: '10px', letterSpacing: '0.13em',
            background: 'linear-gradient(135deg,rgba(0,245,212,0.22),rgba(0,245,212,0.08))',
            border: '2px solid #00f5d4',
            color: '#00f5d4', borderRadius: '5px', cursor: 'pointer',
            boxShadow: '0 0 18px rgba(0,245,212,0.25)',
            transition: 'background 0.2s',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(0,245,212,0.28)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'linear-gradient(135deg,rgba(0,245,212,0.22),rgba(0,245,212,0.08))')}
        >نعم، استمر</button>
      </div>

    </div>
  );
}

// ── Already booked dialog ───────────────────────────────────────────────────
function AlreadyBookedView({ onClose }: { onClose: () => void }) {
  return (
    <div style={{ padding: '32px 24px', textAlign: 'center', direction: 'rtl' }}>

      <div style={{
        width: '72px', height: '72px', borderRadius: '50%',
        background: 'rgba(255,45,120,0.1)',
        border: '2px solid rgba(255,45,120,0.5)',
        boxShadow: '0 0 30px rgba(255,45,120,0.25)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        margin: '0 auto 20px',
        fontSize: '32px',
      }}>⚠️</div>

      <div style={{
        fontFamily: 'Orbitron, sans-serif', fontSize: '11px',
        color: '#ff2d78', letterSpacing: '0.14em',
        marginBottom: '14px',
        textShadow: '0 0 12px rgba(255,45,120,0.5)',
      }}>
        حجز مسبق موجود
      </div>

      <div style={{
        fontFamily: 'Rajdhani, sans-serif', fontSize: '16px', fontWeight: 600,
        color: 'rgba(255,255,255,0.88)', lineHeight: 1.75,
        marginBottom: '28px',
      }}>
        عذراً، لديك حجز مؤكد ومسبق لدى هذا الطبيب لليوم الحالي! ⚠️
        <br/>
        <span style={{ color: 'rgba(255,255,255,0.55)', fontSize: '14px', fontWeight: 400 }}>
          لا يمكنك حجز أكثر من موعد في نفس اليوم
          <br/>
          لإتاحة الفرصة لباقي المراجعين.
        </span>
      </div>

      <div style={{ height: '1px', background: 'rgba(255,45,120,0.15)', marginBottom: '22px' }} />

      <button onClick={onClose} style={{
        width: '100%', padding: '13px',
        fontFamily: 'Orbitron, sans-serif', fontSize: '10px', letterSpacing: '0.15em',
        background: 'rgba(255,45,120,0.12)', border: '2px solid rgba(255,45,120,0.55)',
        color: '#ff2d78', borderRadius: '5px', cursor: 'pointer',
        boxShadow: '0 0 18px rgba(255,45,120,0.2)',
        transition: 'background 0.2s',
      }}
        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,45,120,0.2)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,45,120,0.12)')}
      >
        حسناً — إغلاق
      </button>

    </div>
  );
}

// ── Success dialog ──────────────────────────────────────────────────────────
function SuccessView({ label, onClose }: { label: string; onClose: () => void }) {
  return (
    <div style={{ padding: '32px 24px', textAlign: 'center', direction: 'rtl' }}>
      <div style={{ fontSize: '52px', marginBottom: '14px' }}>✅</div>

      <div style={{
        fontFamily: 'Rajdhani, sans-serif', fontSize: '20px', fontWeight: 700,
        color: '#00f5d4', marginBottom: '12px', lineHeight: 1.6,
      }}>
        تم الحجز بنجاح!
        <br/>
        حجزك بالساعة{' '}
        <span style={{ color: '#fff', fontWeight: 800 }}>{label}</span>
        <br/>
        لا تتأخر على الموعد 🏥
      </div>

      {/* Deduction badge */}
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: '8px',
        padding: '8px 18px',
        background: 'rgba(245,197,24,0.07)',
        border: '1px solid rgba(245,197,24,0.3)',
        borderRadius: '4px',
        marginBottom: '20px',
      }}>
        <span style={{
          fontFamily: 'Rajdhani, sans-serif', fontSize: '13px',
          color: 'rgba(255,255,255,0.5)',
        }}>تم استقطاع</span>
        <span style={{
          fontFamily: 'Orbitron, sans-serif', fontSize: '13px', fontWeight: 700,
          color: '#f5c518',
        }}>2,000 د.ع</span>
        <span style={{
          fontFamily: 'Rajdhani, sans-serif', fontSize: '13px',
          color: 'rgba(255,255,255,0.5)',
        }}>من محفظتك</span>
      </div>

      <div style={{
        fontFamily: 'Orbitron, sans-serif', fontSize: '8px',
        color: 'rgba(0,245,212,0.4)', letterSpacing: '0.14em', marginBottom: '26px',
      }}>
        APPOINTMENT CONFIRMED · DIYALA HEALTH SYSTEM
      </div>

      <button onClick={onClose} style={{
        padding: '12px 44px',
        fontFamily: 'Orbitron, sans-serif', fontSize: '10px', letterSpacing: '0.15em',
        background: 'rgba(0,245,212,0.15)', border: '2px solid #00f5d4', color: '#00f5d4',
        borderRadius: '5px', cursor: 'pointer', boxShadow: '0 0 22px rgba(0,245,212,0.3)',
      }}>إغلاق</button>
    </div>
  );
}
