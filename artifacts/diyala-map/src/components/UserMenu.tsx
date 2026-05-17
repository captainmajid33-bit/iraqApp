import { useState, useEffect, useRef } from 'react';
import { signOut, onAuthStateChanged, type User as FbUser } from 'firebase/auth';
import {
  doc, getDoc, updateDoc,
  collection, query, where, onSnapshot,
  runTransaction, increment, serverTimestamp,
} from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';
import { getUserFromStorage, type DiyalaUser } from './UserLoginOverlay';

const STORAGE_KEY = 'diyala_user';

// ── Admin WhatsApp ─────────────────────────────────────────────────────────────
const ADMIN_WA = '9647742533658';

// ── Helpers ───────────────────────────────────────────────────────────────────
function encodeWA(text: string) {
  return encodeURIComponent(text);
}

function buildWALink(userId: string, balance: number) {
  const text =
    `مرحباً أدمن تطبيق ديالى، لقد حققت المهمة بنجاح وأريد سحب رصيد محفظتي. ` +
    `معرف حسابي: ${userId} والرصيد الحالي المطلوب سحبه: ${balance.toLocaleString('ar-IQ')} دينار.`;
  return `https://wa.me/${ADMIN_WA}?text=${encodeWA(text)}`;
}

function buildRechargeLink(userId: string) {
  const text =
    `السلام عليكم، أريد شحن رصيد محفظتي في تطبيق ديالى. ` +
    `وهذا هو معرّف حسابي (UID): ${userId}`;
  return `https://wa.me/${ADMIN_WA}?text=${encodeWA(text)}`;
}

// ── Sub-component: Wallet Dialog ──────────────────────────────────────────────
interface WalletDialogProps {
  user:     DiyalaUser | null;
  fbUser:   FbUser    | null;
  onClose:  () => void;
}
function WalletDialog({ user, fbUser, onClose }: WalletDialogProps) {
  const [balance,    setBalance]    = useState<number | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [cardCode,   setCardCode]   = useState('');
  const [redeeming,  setRedeeming]  = useState(false);
  const [redeemMsg,  setRedeemMsg]  = useState<{ text: string; ok: boolean } | null>(null);

  const userId = user?.uid ?? user?.phone ?? user?.name ?? 'anonymous';

  // ── Redeem gift card via Firestore Transaction (anti double-spend) ──────────
  async function redeemCard() {
    const uid     = fbUser?.uid;
    const codeRaw = cardCode.trim();
    if (!codeRaw || !uid) return;
    setRedeeming(true);
    setRedeemMsg(null);
    try {
      const amount = await runTransaction(db, async txn => {
        const cardRef  = doc(db, 'gift_cards', codeRaw);
        const cardSnap = await txn.get(cardRef);

        if (!cardSnap.exists() || cardSnap.data()?.isUsed === true) {
          throw new Error('invalid');
        }

        const amt     = Number(cardSnap.data()?.amount ?? 0);
        const userRef = doc(db, 'users', uid);

        txn.update(cardRef, {
          isUsed: true,
          usedBy: uid,
          usedAt: serverTimestamp(),
        });
        txn.update(userRef, { balance: increment(amt) });

        return amt;
      });

      setRedeemMsg({
        text: `تم شحن محفظتك بمبلغ ${(amount as number).toLocaleString('ar-IQ')} دينار بنجاح! 🥳🎉`,
        ok: true,
      });
      setCardCode('');
    } catch (e: any) {
      setRedeemMsg({
        text: e?.message === 'invalid'
          ? 'هذا الكود غير صالح أو تم استخدامه مسبقاً! ❌'
          : `حدث خطأ: ${e?.message ?? e}`,
        ok: false,
      });
    } finally {
      setRedeeming(false);
    }
  }

  // Live balance from Firestore users/{uid}
  useEffect(() => {
    const uid = fbUser?.uid;
    if (!uid) { setBalance(0); setLoading(false); return; }

    const unsub = onSnapshot(
      doc(db, 'users', uid),
      snap => {
        setBalance(snap.exists() ? Number(snap.data()?.balance ?? 0) : 0);
        setLoading(false);
      },
      () => { setBalance(0); setLoading(false); }
    );
    return () => unsub();
  }, [fbUser?.uid]);

  const waLink       = buildWALink(userId, balance ?? 0);
  const rechargeLink = buildRechargeLink(userId);
  const hasBalance = (balance ?? 0) > 0;

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position:'fixed', inset:0, zIndex:9900, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(2,4,10,0.85)', backdropFilter:'blur(7px)' }}
    >
      <div style={{
        width: 'min(380px, calc(100vw - 32px))',
        background: 'rgba(5,8,15,0.99)',
        border: '1px solid rgba(245,197,24,0.45)',
        boxShadow: '0 0 60px rgba(245,197,24,0.2), 0 8px 40px rgba(0,0,0,0.9)',
        direction: 'rtl',
        animation: 'um-dialog-in 0.2s ease-out',
        overflow: 'hidden',
      }}>

        {/* Header */}
        <div style={{ padding:'18px 20px 14px', borderBottom:'1px solid rgba(245,197,24,0.15)', background:'rgba(245,197,24,0.05)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div>
            <div style={{ fontFamily:'Orbitron, sans-serif', fontSize:'8px', color:'rgba(245,197,24,0.7)', letterSpacing:'0.22em', marginBottom:'5px' }}>PLAYER WALLET</div>
            <div style={{ fontFamily:'Rajdhani, sans-serif', fontSize:'20px', fontWeight:700, color:'#e8f8f5' }}>👛 محفظتي</div>
          </div>
          <div style={{ width:44, height:44, borderRadius:'50%', background:'rgba(245,197,24,0.12)', border:'1px solid rgba(245,197,24,0.35)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'22px' }}>
            💰
          </div>
        </div>

        {/* Body */}
        <div style={{ padding:'22px 20px' }}>

          {/* Balance card */}
          <div style={{
            padding:'20px 18px',
            background: hasBalance
              ? 'linear-gradient(135deg,rgba(245,197,24,0.12),rgba(245,197,24,0.04))'
              : 'rgba(255,255,255,0.03)',
            border: `1px solid ${hasBalance ? 'rgba(245,197,24,0.4)' : 'rgba(255,255,255,0.08)'}`,
            borderRadius:'3px',
            marginBottom:'18px',
            textAlign:'center',
            boxShadow: hasBalance ? '0 0 24px rgba(245,197,24,0.14)' : 'none',
          }}>
            <div style={{ fontFamily:'Orbitron, sans-serif', fontSize:'8px', color:'rgba(245,197,24,0.65)', letterSpacing:'0.2em', marginBottom:'10px' }}>رصيدك الحالي</div>
            {loading ? (
              <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:'8px', padding:'8px 0' }}>
                <svg width="18" height="18" viewBox="0 0 28 28" fill="none" style={{ animation:'um-spin 0.85s linear infinite' }}>
                  <circle cx="14" cy="14" r="10" stroke="#f5c518" strokeWidth="2.5" strokeDasharray="22 14" strokeLinecap="round"/>
                </svg>
                <span style={{ fontFamily:'Rajdhani, sans-serif', fontSize:'13px', color:'rgba(245,197,24,0.6)' }}>جاري التحميل...</span>
              </div>
            ) : (
              <>
                <div style={{
                  fontFamily:'Orbitron, sans-serif',
                  fontSize: hasBalance ? '26px' : '22px',
                  fontWeight:700,
                  color: hasBalance ? '#f5c518' : 'rgba(255,255,255,0.25)',
                  textShadow: hasBalance ? '0 0 24px rgba(245,197,24,0.6)' : 'none',
                  letterSpacing:'0.04em',
                  marginBottom:'4px',
                }}>
                  {(balance ?? 0).toLocaleString('ar-IQ')}
                </div>
                <div style={{ fontFamily:'Rajdhani, sans-serif', fontSize:'14px', color:'rgba(245,197,24,0.5)', letterSpacing:'0.06em' }}>
                  دينار عراقي
                </div>
                {!hasBalance && (
                  <div style={{ fontFamily:'Rajdhani, sans-serif', fontSize:'12px', color:'rgba(255,255,255,0.25)', marginTop:'8px' }}>
                    فز بجائزة لتحصل على رصيد 🏆
                  </div>
                )}
              </>
            )}
          </div>

          {/* User ID row */}
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'14px', padding:'10px 12px', background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.07)', borderRadius:'3px' }}>
            <span style={{ fontFamily:'Orbitron, sans-serif', fontSize:'8px', color:'rgba(255,255,255,0.3)', letterSpacing:'0.14em' }}>رقم الحساب</span>
            <span style={{ fontFamily:'Orbitron, monospace', fontSize:'10px', color:'rgba(255,255,255,0.45)', letterSpacing:'0.06em', maxWidth:'60%', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', textAlign:'left' }}>
              {userId}
            </span>
          </div>

          {/* ── Recharge button ── */}
          <a
            href={rechargeLink}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display:'flex', alignItems:'center', justifyContent:'center', gap:'10px',
              width:'100%', padding:'13px',
              background:'rgba(245,197,24,0.12)',
              border:'2px solid rgba(245,197,24,0.55)',
              color:'#f5c518',
              fontFamily:'Orbitron, sans-serif', fontSize:'10px',
              letterSpacing:'0.12em', cursor:'pointer',
              borderRadius:'3px', textDecoration:'none',
              boxShadow:'0 0 18px rgba(245,197,24,0.18)',
              transition:'all 0.2s',
              marginBottom:'10px',
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLElement).style.background = 'rgba(245,197,24,0.22)';
              (e.currentTarget as HTMLElement).style.boxShadow = '0 0 28px rgba(245,197,24,0.35)';
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLElement).style.background = 'rgba(245,197,24,0.12)';
              (e.currentTarget as HTMLElement).style.boxShadow = '0 0 18px rgba(245,197,24,0.18)';
            }}
          >
            {/* WhatsApp icon */}
            <svg width="17" height="17" viewBox="0 0 24 24" fill="#f5c518">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
            </svg>
            ⚡ شحن رصيد الحساب
          </a>

          {/* ── Gift Card Redeem section ─────────────────────────────────── */}
          <div style={{
            marginBottom: '10px',
            padding: '14px 14px 12px',
            background: 'rgba(0,212,255,0.04)',
            border: '1px solid rgba(0,212,255,0.22)',
            borderRadius: '3px',
          }}>
            <div style={{
              fontFamily: 'Orbitron, sans-serif', fontSize: '8px',
              color: 'rgba(0,212,255,0.65)', letterSpacing: '0.16em', marginBottom: '10px',
            }}>
              💳 REDEEM CARD · تعبئة برمز الشحن
            </div>

            {/* Code input */}
            <input
              type="text"
              value={cardCode}
              onChange={e => { setCardCode(e.target.value); setRedeemMsg(null); }}
              onKeyDown={e => { if (e.key === 'Enter' && !redeeming) redeemCard(); }}
              placeholder="أدخل كود شحن المحفظة 💳"
              disabled={redeeming}
              style={{
                width: '100%', padding: '10px 12px',
                background: 'rgba(0,212,255,0.06)',
                border: '1px solid rgba(0,212,255,0.28)',
                borderRadius: '3px', color: '#e8f8ff',
                fontFamily: 'Courier New, monospace', fontSize: '14px',
                letterSpacing: '1.5px', outline: 'none',
                marginBottom: '8px', boxSizing: 'border-box',
                direction: 'ltr', textAlign: 'center',
              }}
            />

            {/* Feedback message */}
            {redeemMsg && (
              <div style={{
                padding: '8px 10px', borderRadius: '3px', marginBottom: '8px',
                fontFamily: 'Rajdhani, sans-serif', fontSize: '13px', fontWeight: 600,
                textAlign: 'center', lineHeight: 1.4,
                background: redeemMsg.ok
                  ? 'rgba(0,245,212,0.1)' : 'rgba(255,45,120,0.1)',
                border: `1px solid ${redeemMsg.ok ? 'rgba(0,245,212,0.35)' : 'rgba(255,45,120,0.35)'}`,
                color: redeemMsg.ok ? '#00f5d4' : '#ff2d78',
              }}>
                {redeemMsg.text}
              </div>
            )}

            {/* Redeem button */}
            <button
              onClick={redeemCard}
              disabled={redeeming || !cardCode.trim()}
              style={{
                width: '100%', padding: '11px',
                background: (redeeming || !cardCode.trim())
                  ? 'rgba(0,212,255,0.04)' : 'rgba(0,212,255,0.14)',
                border: `2px solid ${(redeeming || !cardCode.trim())
                  ? 'rgba(0,212,255,0.15)' : 'rgba(0,212,255,0.55)'}`,
                color: (redeeming || !cardCode.trim())
                  ? 'rgba(0,212,255,0.3)' : '#00d4ff',
                fontFamily: 'Orbitron, sans-serif', fontSize: '10px',
                letterSpacing: '0.1em', cursor: (redeeming || !cardCode.trim())
                  ? 'not-allowed' : 'pointer',
                borderRadius: '3px',
                boxShadow: (!redeeming && cardCode.trim())
                  ? '0 0 16px rgba(0,212,255,0.2)' : 'none',
                transition: 'all 0.18s',
              }}
            >
              {redeeming ? '⏳ جاري التحقق...' : 'تعبئة الرصيد الآن 🚀'}
            </button>
          </div>

          {/* Withdraw button */}
          <a
            href={waLink}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => { if (!hasBalance && !loading) { e.preventDefault(); } }}
            style={{
              display:'flex', alignItems:'center', justifyContent:'center', gap:'10px',
              width:'100%', padding:'14px',
              background: hasBalance ? 'rgba(37,211,102,0.14)' : 'rgba(255,255,255,0.03)',
              border: `2px solid ${hasBalance ? 'rgba(37,211,102,0.6)' : 'rgba(255,255,255,0.08)'}`,
              color: hasBalance ? '#25D366' : 'rgba(255,255,255,0.2)',
              fontFamily:'Orbitron, sans-serif', fontSize:'10px',
              letterSpacing:'0.14em', cursor: hasBalance ? 'pointer' : 'not-allowed',
              borderRadius:'3px',
              textDecoration:'none',
              boxShadow: hasBalance ? '0 0 20px rgba(37,211,102,0.2)' : 'none',
              transition:'all 0.2s',
              marginBottom:'12px',
              pointerEvents: loading ? 'none' : 'auto',
            }}
            onMouseEnter={e => { if (hasBalance) (e.currentTarget as HTMLElement).style.background = 'rgba(37,211,102,0.22)'; }}
            onMouseLeave={e => { if (hasBalance) (e.currentTarget as HTMLElement).style.background = 'rgba(37,211,102,0.14)'; }}
          >
            {/* WhatsApp icon */}
            <svg width="18" height="18" viewBox="0 0 24 24" fill={hasBalance ? '#25D366' : 'rgba(255,255,255,0.2)'}>
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
            </svg>
            💵 سحب الفلوس عبر واتساب
          </a>

          {!hasBalance && !loading && (
            <div style={{ fontFamily:'Rajdhani, sans-serif', fontSize:'12px', color:'rgba(255,197,24,0.45)', textAlign:'center', marginBottom:'14px' }}>
              ⚠ رصيدك صفر — فز بمهمة لتتمكن من السحب
            </div>
          )}

          {/* Close */}
          <button
            onClick={onClose}
            style={{
              width:'100%', padding:'12px',
              background:'rgba(245,197,24,0.1)',
              border:'1px solid rgba(245,197,24,0.3)',
              color:'rgba(245,197,24,0.7)',
              fontFamily:'Orbitron, sans-serif', fontSize:'9px',
              letterSpacing:'0.14em', cursor:'pointer', transition:'all 0.18s', borderRadius:'3px',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(245,197,24,0.18)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'rgba(245,197,24,0.1)')}
          >
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Sub-component: Missions History Dialog ────────────────────────────────────
interface MissionsDialogProps {
  user:    DiyalaUser | null;
  fbUser:  FbUser    | null;
  onClose: () => void;
}

interface WonMission {
  id:          string;
  title:       string;
  description: string;
  reward:      number;
  claimedAt?:  any;
}

function MissionsDialog({ user, fbUser, onClose }: MissionsDialogProps) {
  const [won,     setWon]     = useState<WonMission[]>([]);
  const [loading, setLoading] = useState(true);

  const userId = user?.uid ?? user?.phone ?? user?.name ?? 'anonymous';

  useEffect(() => {
    if (!userId || userId === 'anonymous') { setLoading(false); return; }

    const q = query(
      collection(db, 'bounty_missions'),
      where('status',    '==', 'claimed'),
      where('claimedBy', '==', userId),
    );
    const unsub = onSnapshot(q,
      snap => {
        const docs: WonMission[] = [];
        snap.forEach(d => {
          if (d.id === '_seed_check') return;
          const raw = d.data();
          docs.push({
            id:          d.id,
            title:       String(raw.title ?? 'مهمة'),
            description: String(raw.description ?? ''),
            reward:      Number(raw.reward ?? 0),
            claimedAt:   raw.claimedAt,
          });
        });
        // Newest first (by claimedAt if available, else push order)
        docs.sort((a, b) =>
          (b.claimedAt?.seconds ?? 0) - (a.claimedAt?.seconds ?? 0)
        );
        setWon(docs);
        setLoading(false);
      },
      () => { setLoading(false); }
    );
    return () => unsub();
  }, [userId]);

  const totalWon = won.reduce((s, m) => s + m.reward, 0);

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position:'fixed', inset:0, zIndex:9900, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(2,4,10,0.85)', backdropFilter:'blur(7px)' }}
    >
      <div style={{
        width: 'min(400px, calc(100vw - 32px))',
        maxHeight: '80vh',
        background: 'rgba(5,8,15,0.99)',
        border: '1px solid rgba(245,197,24,0.42)',
        boxShadow: '0 0 60px rgba(245,197,24,0.18), 0 8px 40px rgba(0,0,0,0.9)',
        direction: 'rtl',
        animation: 'um-dialog-in 0.2s ease-out',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}>

        {/* Header */}
        <div style={{ padding:'18px 20px 14px', borderBottom:'1px solid rgba(245,197,24,0.14)', background:'rgba(245,197,24,0.04)', display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0 }}>
          <div>
            <div style={{ fontFamily:'Orbitron, sans-serif', fontSize:'8px', color:'rgba(245,197,24,0.7)', letterSpacing:'0.22em', marginBottom:'5px' }}>BOUNTY HISTORY</div>
            <div style={{ fontFamily:'Rajdhani, sans-serif', fontSize:'20px', fontWeight:700, color:'#e8f8f5' }}>🏆 سجل المهمات</div>
          </div>
          {won.length > 0 && (
            <div style={{ textAlign:'center' }}>
              <div style={{ fontFamily:'Orbitron, sans-serif', fontSize:'8px', color:'rgba(245,197,24,0.6)', letterSpacing:'0.12em', marginBottom:'2px' }}>إجمالي الجوائز</div>
              <div style={{ fontFamily:'Orbitron, sans-serif', fontSize:'15px', color:'#f5c518', textShadow:'0 0 16px rgba(245,197,24,0.6)' }}>
                {totalWon.toLocaleString('ar-IQ')} <span style={{ fontSize:'9px', opacity:0.6 }}>د.ع</span>
              </div>
            </div>
          )}
        </div>

        {/* List */}
        <div style={{ overflowY:'auto', flex:1, padding:'12px 16px' }}>
          {loading ? (
            <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:'10px', padding:'40px 0' }}>
              <svg width="20" height="20" viewBox="0 0 28 28" fill="none" style={{ animation:'um-spin 0.85s linear infinite' }}>
                <circle cx="14" cy="14" r="10" stroke="#f5c518" strokeWidth="2.5" strokeDasharray="22 14" strokeLinecap="round"/>
              </svg>
              <span style={{ fontFamily:'Rajdhani, sans-serif', fontSize:'14px', color:'rgba(245,197,24,0.6)' }}>جاري التحميل...</span>
            </div>
          ) : won.length === 0 ? (
            <div style={{ textAlign:'center', padding:'40px 0' }}>
              <div style={{ fontSize:'44px', marginBottom:'12px', opacity:0.35 }}>🏆</div>
              <div style={{ fontFamily:'Orbitron, sans-serif', fontSize:'10px', color:'rgba(255,255,255,0.25)', letterSpacing:'0.12em', marginBottom:'6px' }}>لا توجد جوائز بعد</div>
              <div style={{ fontFamily:'Rajdhani, sans-serif', fontSize:'13px', color:'rgba(255,255,255,0.2)' }}>ابحث عن المهمات على الخريطة وفز بها!</div>
            </div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:'10px' }}>
              {won.map((m, idx) => (
                <div key={m.id} style={{
                  padding:'14px 14px',
                  background: idx === 0 ? 'rgba(245,197,24,0.07)' : 'rgba(255,255,255,0.02)',
                  border: `1px solid ${idx === 0 ? 'rgba(245,197,24,0.3)' : 'rgba(255,255,255,0.07)'}`,
                  borderRadius:'3px',
                  position:'relative',
                  overflow:'hidden',
                }}>
                  {/* First badge */}
                  {idx === 0 && (
                    <div style={{ position:'absolute', top:8, left:10, fontFamily:'Orbitron, sans-serif', fontSize:'7px', color:'#f5c518', letterSpacing:'0.14em', opacity:0.7 }}>
                      ★ LATEST
                    </div>
                  )}
                  <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:'10px' }}>
                    <div style={{ flex:1 }}>
                      <div style={{ fontFamily:'Rajdhani, sans-serif', fontSize:'16px', fontWeight:700, color:'#e8f8f5', marginBottom:'3px', marginTop: idx === 0 ? '10px' : 0 }}>
                        {m.title}
                      </div>
                      {m.description && (
                        <div style={{ fontFamily:'Rajdhani, sans-serif', fontSize:'12px', color:'rgba(255,255,255,0.38)', lineHeight:1.5, marginBottom:'6px' }}>
                          {m.description}
                        </div>
                      )}
                      {m.claimedAt && (
                        <div style={{ fontFamily:'Orbitron, sans-serif', fontSize:'7px', color:'rgba(255,255,255,0.2)', letterSpacing:'0.1em' }}>
                          {new Date(m.claimedAt.seconds * 1000).toLocaleDateString('ar-IQ', { year:'numeric', month:'short', day:'numeric' })}
                        </div>
                      )}
                    </div>
                    <div style={{ flexShrink:0, textAlign:'center' }}>
                      <div style={{ fontSize:'22px', lineHeight:1, marginBottom:'2px' }}>🎁</div>
                      <div style={{ fontFamily:'Orbitron, sans-serif', fontSize:'12px', color:'#f5c518', textShadow:'0 0 10px rgba(245,197,24,0.5)', fontWeight:700 }}>
                        {m.reward.toLocaleString('ar-IQ')}
                      </div>
                      <div style={{ fontFamily:'Rajdhani, sans-serif', fontSize:'10px', color:'rgba(245,197,24,0.45)' }}>د.ع</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding:'12px 16px', borderTop:'1px solid rgba(245,197,24,0.1)', flexShrink:0 }}>
          <button
            onClick={onClose}
            style={{
              width:'100%', padding:'12px',
              background:'rgba(245,197,24,0.1)',
              border:'1px solid rgba(245,197,24,0.3)',
              color:'rgba(245,197,24,0.7)',
              fontFamily:'Orbitron, sans-serif', fontSize:'9px',
              letterSpacing:'0.14em', cursor:'pointer', transition:'all 0.18s', borderRadius:'3px',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(245,197,24,0.18)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'rgba(245,197,24,0.1)')}
          >
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main UserMenu ─────────────────────────────────────────────────────────────
export function UserMenu() {
  const [menuOpen,      setMenuOpen]      = useState(false);
  const [dialogOpen,    setDialogOpen]    = useState(false);
  const [showWallet,    setShowWallet]    = useState(false);
  const [showMissions,  setShowMissions]  = useState(false);
  const [signingOut,    setSigningOut]    = useState(false);
  const [user,          setUser]          = useState<DiyalaUser | null>(null);
  const [fbUser,        setFbUser]        = useState<FbUser | null>(null);

  const [editedName, setEditedName] = useState('');
  const [saving,     setSaving]     = useState(false);
  const [toast,      setToast]      = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef    = useRef<HTMLDivElement>(null);

  // ── Track Firebase auth state ─────────────────────────────────────────────
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, fb => setFbUser(fb));
    return () => unsub();
  }, []);

  // ── Resolve user data ─────────────────────────────────────────────────────
  useEffect(() => {
    const fromStorage = getUserFromStorage();
    if (fromStorage?.name) { setUser(fromStorage); return; }
    const fb = auth.currentUser;
    if (!fb) return;
    getDoc(doc(db, 'users', fb.uid))
      .then(snap => { if (snap.exists()) setUser(snap.data() as DiyalaUser); })
      .catch(() => {});
  }, []);

  // ── Sync editedName when dialog opens ────────────────────────────────────
  useEffect(() => {
    if (dialogOpen) setEditedName(user?.name ?? '');
  }, [dialogOpen, user?.name]);

  // ── Close menu on outside click ───────────────────────────────────────────
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node))
        setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  };

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

  const handleSaveName = () => {
    const newName = editedName.trim();
    if (!newName || newName === user?.name) return;
    const fb = auth.currentUser;
    if (!fb) { showToast('خطأ: غير مسجّل الدخول'); return; }
    setSaving(true);
    const updated = { ...user, name: newName } as DiyalaUser;
    setUser(updated);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    showToast('تم تحديث الاسم بنجاح ✓');
    setSaving(false);
    updateDoc(doc(db, 'users', fb.uid), { name: newName })
      .catch(e => console.warn('[UserMenu] updateDoc failed:', e?.code));
  };

  const isDirty = editedName.trim() !== (user?.name ?? '');

  // ── Menu item helper style ────────────────────────────────────────────────
  const MI: React.CSSProperties = {
    width:'100%', padding:'12px 16px',
    display:'flex', alignItems:'center', gap:10,
    background:'transparent', border:'none',
    cursor:'pointer', textAlign:'right',
    transition:'background 0.15s',
  };

  return (
    <>
      <style>{`
        @keyframes um-fade-in    { from{opacity:0;transform:scale(0.88) translateY(-10px)} to{opacity:1;transform:scale(1) translateY(0)} }
        @keyframes um-dialog-in  { from{opacity:0;transform:translateY(14px)} to{opacity:1;transform:translateY(0)} }
        @keyframes um-toast-in   { from{opacity:0;transform:translateY(24px)} to{opacity:1;transform:translateY(0)} }
        @keyframes um-spin       { to{transform:rotate(360deg)} }
        @keyframes um-neon-pulse { 0%,100%{box-shadow:0 0 18px rgba(123,47,247,0.35),0 8px 40px rgba(0,0,0,0.8)} 50%{box-shadow:0 0 28px rgba(123,47,247,0.55),0 8px 40px rgba(0,0,0,0.8)} }
        .um-item:hover   { background: rgba(123,47,247,0.14) !important; }
        .um-item-y:hover { background: rgba(245,197,24,0.1) !important; }
        .um-item-r:hover { background: rgba(255,45,120,0.1) !important; }
        .um-btn:hover    { background: rgba(123,47,247,0.2) !important; box-shadow: 0 0 22px rgba(123,47,247,0.4) !important; }
        .um-save:hover   { background: rgba(0,245,212,0.22) !important; }
        .um-close:hover  { background: rgba(123,47,247,0.28) !important; }
        .um-name-input:focus { border-color: #7b2ff7 !important; box-shadow: 0 0 0 2px rgba(123,47,247,0.15); }
      `}</style>

      {/* ── Anchor container ────────────────────────────────────────────────── */}
      <div ref={menuRef} style={{ position:'absolute', top:20, right:20, zIndex:1500, direction:'rtl' }}>

        {/* ── 3-dot trigger ─────────────────────────────────────────────────── */}
        <button
          className="um-btn"
          onClick={() => setMenuOpen(o => !o)}
          disabled={signingOut}
          title="خيارات"
          style={{
            width:40, height:40, borderRadius:'50%',
            background:'rgba(5,8,15,0.88)',
            border:'1px solid rgba(123,47,247,0.5)',
            boxShadow:'0 2px 16px rgba(0,0,0,0.55), 0 0 12px rgba(123,47,247,0.15)',
            display:'flex', alignItems:'center', justifyContent:'center',
            cursor: signingOut ? 'not-allowed' : 'pointer',
            transition:'all 0.18s', padding:0,
          }}
        >
          {signingOut ? (
            <svg width="16" height="16" viewBox="0 0 28 28" fill="none"
              style={{ animation:'um-spin 0.85s linear infinite' }}>
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

        {/* ── Dropdown ──────────────────────────────────────────────────────── */}
        {menuOpen && (
          <div style={{
            position:'absolute', top:50, right:0, minWidth:230,
            background:'rgba(6,9,18,0.82)',
            backdropFilter:'blur(22px)',
            WebkitBackdropFilter:'blur(22px)',
            border:'1px solid rgba(123,47,247,0.55)',
            borderRadius:'20px',
            boxShadow:'0 0 0 1px rgba(123,47,247,0.15), 0 8px 48px rgba(0,0,0,0.82), 0 0 32px rgba(123,47,247,0.22)',
            animation:'um-fade-in 0.2s cubic-bezier(0.34,1.56,0.64,1)',
            overflow:'hidden',
            direction:'rtl',
          }}>

            {/* ── Header: user identity ─────────────────────────────────────── */}
            <div style={{
              padding:'16px 18px 14px',
              background:'linear-gradient(135deg,rgba(123,47,247,0.14),rgba(0,245,212,0.04))',
              borderBottom:'1px solid rgba(123,47,247,0.2)',
              display:'flex', alignItems:'center', gap:'12px',
            }}>
              {/* Avatar glow ring */}
              <div style={{
                flexShrink:0, width:'40px', height:'40px', borderRadius:'50%',
                background:'rgba(123,47,247,0.18)',
                border:'1.5px solid rgba(123,47,247,0.7)',
                boxShadow:'0 0 14px rgba(123,47,247,0.45), inset 0 0 8px rgba(123,47,247,0.1)',
                display:'flex', alignItems:'center', justifyContent:'center',
              }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
                  stroke="rgba(180,140,255,0.95)" strokeWidth="1.7" strokeLinecap="round">
                  <circle cx="12" cy="8" r="4"/>
                  <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
                </svg>
              </div>
              {/* Name + tag */}
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{
                  fontFamily:'Rajdhani, sans-serif', fontSize:'16px', fontWeight:700,
                  color:'#e4d8ff', lineHeight:1.15,
                  overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                }}>
                  {user?.name || 'مجهول'}
                </div>
                <div style={{
                  fontFamily:'Orbitron, sans-serif', fontSize:'7px',
                  color:'rgba(123,47,247,0.7)', letterSpacing:'0.18em', marginTop:'2px',
                }}>
                  PLAYER PROFILE
                </div>
              </div>
              {/* Online dot */}
              <div style={{
                width:'8px', height:'8px', borderRadius:'50%', flexShrink:0,
                background:'#00f5d4', boxShadow:'0 0 8px #00f5d4',
                animation:'lf-ping 2s cubic-bezier(0,0,0.2,1) infinite',
              }}/>
            </div>

            {/* ── Section: account + missions + wallet ─────────────────────── */}
            <div style={{ padding:'8px 0 4px' }}>

              {/* تفاصيل الحساب */}
              <button className="um-item"
                onClick={() => { setMenuOpen(false); setDialogOpen(true); }}
                style={{ ...MI, padding:'10px 18px', borderRadius:'0', gap:'12px' }}>
                <div style={{
                  width:'32px', height:'32px', borderRadius:'8px', flexShrink:0,
                  background:'rgba(123,47,247,0.14)', border:'1px solid rgba(123,47,247,0.3)',
                  display:'flex', alignItems:'center', justifyContent:'center',
                }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                    stroke="rgba(180,140,255,0.9)" strokeWidth="1.8" strokeLinecap="round">
                    <circle cx="12" cy="8" r="4"/>
                    <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
                  </svg>
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontFamily:'Rajdhani, sans-serif', fontSize:'14px', fontWeight:600, color:'#d4c8ff', lineHeight:1.2 }}>تفاصيل الحساب</div>
                  <div style={{ fontFamily:'Orbitron, sans-serif', fontSize:'6.5px', color:'rgba(123,47,247,0.5)', letterSpacing:'0.14em', marginTop:'1px' }}>MY PROFILE</div>
                </div>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(123,47,247,0.4)" strokeWidth="2" strokeLinecap="round"><path d="M15 18l-6-6 6-6"/></svg>
              </button>

              {/* ── neon divider ── */}
              <div style={{ height:'1px', margin:'4px 14px', background:'linear-gradient(90deg,transparent,rgba(123,47,247,0.25),transparent)' }}/>

              {/* 🏆 المهمات */}
              <button className="um-item-y"
                onClick={() => { setMenuOpen(false); setShowMissions(true); }}
                style={{ ...MI, padding:'10px 18px', borderRadius:'0', gap:'12px' }}>
                <div style={{
                  width:'32px', height:'32px', borderRadius:'8px', flexShrink:0,
                  background:'rgba(245,197,24,0.1)', border:'1px solid rgba(245,197,24,0.28)',
                  display:'flex', alignItems:'center', justifyContent:'center',
                }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                    stroke="rgba(245,197,24,0.9)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 9H4a2 2 0 000 4h2M18 9h2a2 2 0 010 4h-2"/>
                    <path d="M6 9V5h12v4M6 13v3a6 6 0 0012 0v-3"/>
                    <path d="M12 19v3M9 22h6"/>
                  </svg>
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontFamily:'Rajdhani, sans-serif', fontSize:'14px', fontWeight:600, color:'#f5c518', lineHeight:1.2 }}>المهمات</div>
                  <div style={{ fontFamily:'Orbitron, sans-serif', fontSize:'6.5px', color:'rgba(245,197,24,0.45)', letterSpacing:'0.14em', marginTop:'1px' }}>BOUNTY HISTORY</div>
                </div>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(245,197,24,0.35)" strokeWidth="2" strokeLinecap="round"><path d="M15 18l-6-6 6-6"/></svg>
              </button>

              {/* 💎 المحفظة */}
              <button className="um-item-y"
                onClick={() => { setMenuOpen(false); setShowWallet(true); }}
                style={{ ...MI, padding:'10px 18px', borderRadius:'0', gap:'12px' }}>
                <div style={{
                  width:'32px', height:'32px', borderRadius:'8px', flexShrink:0,
                  background:'rgba(0,245,212,0.08)', border:'1px solid rgba(0,245,212,0.25)',
                  display:'flex', alignItems:'center', justifyContent:'center',
                }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                    stroke="rgba(0,245,212,0.9)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="7" width="20" height="14" rx="2"/>
                    <path d="M16 14a1 1 0 100-2 1 1 0 000 2z" fill="rgba(0,245,212,0.8)" stroke="none"/>
                    <path d="M22 11V7a2 2 0 00-2-2H6a2 2 0 00-2 2v4"/>
                  </svg>
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontFamily:'Rajdhani, sans-serif', fontSize:'14px', fontWeight:600, color:'#00f5d4', lineHeight:1.2 }}>المحفظة</div>
                  <div style={{ fontFamily:'Orbitron, sans-serif', fontSize:'6.5px', color:'rgba(0,245,212,0.45)', letterSpacing:'0.14em', marginTop:'1px' }}>WALLET · سحب الأرباح</div>
                </div>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(0,245,212,0.35)" strokeWidth="2" strokeLinecap="round"><path d="M15 18l-6-6 6-6"/></svg>
              </button>
            </div>

            {/* ── Bottom separator + logout ─────────────────────────────────── */}
            <div style={{ height:'1px', margin:'0 14px', background:'linear-gradient(90deg,transparent,rgba(255,45,120,0.3),transparent)' }}/>
            <div style={{ padding:'4px 0 8px' }}>
              <button className="um-item-r"
                onClick={handleSignOut}
                style={{ ...MI, padding:'11px 18px', borderRadius:'0', gap:'12px' }}>
                <div style={{
                  width:'32px', height:'32px', borderRadius:'8px', flexShrink:0,
                  background:'rgba(255,45,120,0.1)', border:'1px solid rgba(255,45,120,0.28)',
                  display:'flex', alignItems:'center', justifyContent:'center',
                }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
                    stroke="#ff4d6d" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
                    <polyline points="16 17 21 12 16 7"/>
                    <line x1="21" y1="12" x2="9" y2="12"/>
                  </svg>
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontFamily:'Rajdhani, sans-serif', fontSize:'14px', fontWeight:600, color:'#ff6b8a', lineHeight:1.2 }}>تسجيل الخروج</div>
                  <div style={{ fontFamily:'Orbitron, sans-serif', fontSize:'6.5px', color:'rgba(255,45,120,0.45)', letterSpacing:'0.14em', marginTop:'1px' }}>SIGN OUT</div>
                </div>
              </button>
            </div>

          </div>
        )}
      </div>

      {/* ── Account Details Dialog ─────────────────────────────────────────── */}
      {dialogOpen && (
        <div
          onClick={e => { if (e.target === e.currentTarget) setDialogOpen(false); }}
          style={{ position:'fixed', inset:0, zIndex:9800, display:'flex', alignItems:'center', justifyContent:'center', background:'rgba(2,4,10,0.82)', backdropFilter:'blur(6px)' }}
        >
          <div style={{
            width:'min(380px, calc(100vw - 32px))',
            background:'rgba(5,8,15,0.99)',
            border:'1px solid rgba(123,47,247,0.6)',
            boxShadow:'0 0 60px rgba(123,47,247,0.25)',
            direction:'rtl',
            animation:'um-dialog-in 0.18s ease-out',
          }}>
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

            <div style={{ padding:'20px' }}>
              {/* Name */}
              <div style={{ marginBottom:'14px' }}>
                <div style={{ fontFamily:'Orbitron, sans-serif', fontSize:'7px', color:'rgba(123,47,247,0.6)', letterSpacing:'0.2em', marginBottom:'6px', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                  <span>الاسم الكامل</span>
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
                    border:`1px solid ${isDirty ? 'rgba(123,47,247,0.6)' : 'rgba(123,47,247,0.2)'}`,
                    outline:'none', transition:'all 0.2s',
                    fontFamily:'Rajdhani, sans-serif', fontSize:'17px',
                    color:'#e8f8f5', letterSpacing:'0.03em',
                  }}
                />
              </div>

              {/* Phone */}
              <div style={{ marginBottom: isDirty ? '14px' : '22px' }}>
                <div style={{ fontFamily:'Orbitron, sans-serif', fontSize:'7px', color:'rgba(123,47,247,0.6)', letterSpacing:'0.2em', marginBottom:'6px' }}>رقم الهاتف</div>
                <div style={{
                  padding:'10px 14px',
                  background:'rgba(123,47,247,0.05)',
                  border:'1px solid rgba(123,47,247,0.15)',
                  fontFamily:'Rajdhani, sans-serif', fontSize:'17px',
                  color: user?.phone ? '#00f5d4' : 'rgba(255,255,255,0.3)',
                  letterSpacing:'0.04em', direction:'ltr', textAlign:'right', opacity:0.8,
                }}>
                  {user?.phone || '—'}
                </div>
              </div>

              {/* Save button */}
              {isDirty && (
                <button className="um-save" onClick={handleSaveName} disabled={saving || !editedName.trim()}
                  style={{
                    width:'100%', padding:'12px', marginBottom:'10px',
                    background: saving ? 'rgba(0,245,212,0.08)' : 'rgba(0,245,212,0.14)',
                    border:'1px solid rgba(0,245,212,0.5)',
                    color: saving ? 'rgba(0,245,212,0.4)' : '#00f5d4',
                    fontFamily:'Orbitron, sans-serif', fontSize:'9px',
                    letterSpacing:'0.14em', cursor: saving ? 'not-allowed' : 'pointer',
                    transition:'all 0.18s',
                    display:'flex', alignItems:'center', justifyContent:'center', gap:8,
                  }}>
                  {saving ? (
                    <><svg width="12" height="12" viewBox="0 0 28 28" fill="none" style={{ animation:'um-spin 0.85s linear infinite' }}><circle cx="14" cy="14" r="10" stroke="#00f5d4" strokeWidth="2.5" strokeDasharray="22 14" strokeLinecap="round"/></svg>جاري الحفظ...</>
                  ) : (
                    <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>حفظ التغييرات</>
                  )}
                </button>
              )}

              {/* Close */}
              <button className="um-close" onClick={() => setDialogOpen(false)}
                style={{
                  width:'100%', padding:'12px',
                  background:'rgba(123,47,247,0.14)', border:'1px solid rgba(123,47,247,0.4)',
                  color:'rgba(180,160,255,0.85)',
                  fontFamily:'Orbitron, sans-serif', fontSize:'9px',
                  letterSpacing:'0.14em', cursor:'pointer', transition:'all 0.18s',
                }}>
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Wallet Dialog ──────────────────────────────────────────────────── */}
      {showWallet && (
        <WalletDialog
          user={user}
          fbUser={fbUser}
          onClose={() => setShowWallet(false)}
        />
      )}

      {/* ── Missions History Dialog ────────────────────────────────────────── */}
      {showMissions && (
        <MissionsDialog
          user={user}
          fbUser={fbUser}
          onClose={() => setShowMissions(false)}
        />
      )}

      {/* ── Toast ─────────────────────────────────────────────────────────── */}
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
