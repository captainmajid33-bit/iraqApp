import { useState, useEffect, useCallback } from 'react';
import {
  collection, query, where, onSnapshot,
  addDoc, serverTimestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { getUserFromStorage } from '@/components/UserLoginOverlay';

// ── Time slots 3:00 PM → 9:00 PM every 30 min ─────────────────────────────
const SLOTS = [
  { key: '15:00', label: '3:00 م' },
  { key: '15:30', label: '3:30 م' },
  { key: '16:00', label: '4:00 م' },
  { key: '16:30', label: '4:30 م' },
  { key: '17:00', label: '5:00 م' },
  { key: '17:30', label: '5:30 م' },
  { key: '18:00', label: '6:00 م' },
  { key: '18:30', label: '6:30 م' },
  { key: '19:00', label: '7:00 م' },
  { key: '19:30', label: '7:30 م' },
  { key: '20:00', label: '8:00 م' },
  { key: '20:30', label: '8:30 م' },
  { key: '21:00', label: '9:00 م' },
];

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface Props {
  doctorId:   string | number;
  doctorName: string;
  onClose:    () => void;
}

export function DoctorBookingModal({ doctorId, doctorName, onClose }: Props) {
  const [bookedSlots, setBookedSlots] = useState<Set<string>>(new Set());
  const [selected,    setSelected]    = useState<string | null>(null);
  const [phase,       setPhase]       = useState<'slots' | 'confirming' | 'success'>('slots');
  const [errMsg,      setErrMsg]      = useState('');

  const today    = todayStr();
  const user     = getUserFromStorage();
  const userId   = user?.uid  ?? 'anonymous';
  const userName = user?.name ?? 'زبون';

  // ── Real-time listener — today's booked slots ─────────────────────────────
  useEffect(() => {
    const colRef = collection(db, 'doctors', String(doctorId), 'appointments');
    const q      = query(colRef, where('date', '==', today));
    const unsub  = onSnapshot(q, snap => {
      const booked = new Set<string>();
      snap.forEach(d => booked.add(d.data().slot_time as string));
      setBookedSlots(booked);
    }, () => {});
    return unsub;
  }, [doctorId, today]);

  // ── Confirm booking ────────────────────────────────────────────────────────
  const confirmBooking = useCallback(async () => {
    if (!selected) return;
    setPhase('confirming');
    setErrMsg('');
    try {
      await addDoc(
        collection(db, 'doctors', String(doctorId), 'appointments'),
        { slot_time: selected, userId, userName, date: today, createdAt: serverTimestamp() },
      );
      setPhase('success');
    } catch {
      setErrMsg('فشل الحجز، يرجى المحاولة مرة أخرى.');
      setPhase('slots');
    }
  }, [selected, doctorId, userId, userName, today]);

  const selectedLabel = SLOTS.find(s => s.key === selected)?.label ?? selected ?? '';

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
        border: '2px solid #00f5d4',
        borderRadius: '8px',
        boxShadow: '0 0 60px rgba(0,245,212,0.25), 0 0 120px rgba(0,245,212,0.08)',
        overflow: 'hidden',
      }}>

        {/* ── Header ── */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 18px', borderBottom: '1px solid rgba(0,245,212,0.18)',
          background: 'rgba(0,245,212,0.05)',
        }}>
          <div>
            <div style={{
              fontFamily: 'Orbitron, sans-serif', fontSize: '9px',
              color: 'rgba(0,245,212,0.55)', letterSpacing: '0.16em', marginBottom: '3px',
            }}>
              🏥 APPOINTMENT BOOKING
            </div>
            <div style={{ fontFamily: 'Rajdhani, sans-serif', fontSize: '16px', fontWeight: 700, color: '#00f5d4' }}>
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
        {phase === 'success'
          ? <SuccessView label={selectedLabel} onClose={onClose} />
          : (
            <div style={{ padding: '18px' }}>

              {/* Date label */}
              <div style={{
                fontFamily: 'Rajdhani, sans-serif', fontSize: '13px',
                color: 'rgba(255,255,255,0.45)', marginBottom: '14px',
              }}>
                الأوقات المتاحة ليوم <span style={{ color: '#00f5d4' }}>{today}</span> — اختر وقتاً مناسباً:
              </div>

              {/* Slots grid */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', marginBottom: '18px' }}>
                {SLOTS.map(slot => {
                  const isBooked   = bookedSlots.has(slot.key);
                  const isSelected = selected === slot.key;
                  return (
                    <button
                      key={slot.key}
                      disabled={isBooked}
                      onClick={() => setSelected(slot.key)}
                      style={{
                        padding: '10px 4px',
                        fontFamily: 'Rajdhani, sans-serif', fontSize: '15px', fontWeight: 600,
                        borderRadius: '5px', cursor: isBooked ? 'not-allowed' : 'pointer',
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

              {/* Error */}
              {errMsg && (
                <div style={{
                  color: '#ff2d78', fontFamily: 'Rajdhani, sans-serif',
                  fontSize: '14px', marginBottom: '10px',
                }}>{errMsg}</div>
              )}

              {/* Confirm button */}
              <button
                onClick={confirmBooking}
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

            </div>
          )
        }
      </div>
    </div>
  );
}

// ── Success dialog ─────────────────────────────────────────────────────────
function SuccessView({ label, onClose }: { label: string; onClose: () => void }) {
  return (
    <div style={{ padding: '32px 24px', textAlign: 'center', direction: 'rtl' }}>
      <div style={{ fontSize: '52px', marginBottom: '14px' }}>✅</div>
      <div style={{
        fontFamily: 'Rajdhani, sans-serif', fontSize: '20px', fontWeight: 700,
        color: '#00f5d4', marginBottom: '10px', lineHeight: 1.5,
      }}>
        تم الحجز، حجزك بالساعة {label}
        <br/>
        لا تتأخر على الموعد
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
