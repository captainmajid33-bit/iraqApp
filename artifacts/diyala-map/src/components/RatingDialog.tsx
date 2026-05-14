import { useState } from 'react';

interface RatingDialogProps {
  orderId:      number;
  driverId:     number;
  customerName: string;
  onClose:      () => void;
}

export function RatingDialog({ orderId, driverId, customerName, onClose }: RatingDialogProps) {
  const [hovered,    setHovered]    = useState(0);
  const [selected,   setSelected]   = useState(0);
  const [notes,      setNotes]      = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done,       setDone]       = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  const activeStars = hovered || selected;

  const submit = async () => {
    if (!selected) { setError('اختر عدد النجوم أولاً'); return; }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/taxi-ratings', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId,
          driverId,
          customerName: customerName || 'مجهول',
          ratingStars:  selected,
          notes:        notes.trim() || null,
        }),
      });
      if (res.ok) {
        setDone(true);
        setTimeout(onClose, 1800);
      } else {
        const j = await res.json().catch(() => ({}));
        setError((j as any).error ?? 'حدث خطأ، حاول مرة أخرى');
      }
    } catch {
      setError('تعذّر الاتصال بالسيرفر');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    // ── Full-screen backdrop ──────────────────────────────────────────────────
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9000,
      background: 'rgba(2,4,10,0.85)',
      backdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '20px',
      animation: 'rd-fade-in 0.25s ease',
    }}>
      <style>{`
        @keyframes rd-fade-in  { from { opacity:0; transform:scale(0.92) } to { opacity:1; transform:scale(1) } }
        @keyframes rd-star-pop { 0%{transform:scale(1)} 40%{transform:scale(1.45)} 100%{transform:scale(1)} }
        @keyframes rd-done-glow{ 0%,100%{text-shadow:0 0 18px #f5c518} 50%{text-shadow:0 0 36px #f5c518,0 0 60px #f5c518} }
        .rd-star { cursor:pointer; transition: transform 0.12s; user-select:none; }
        .rd-star:hover { transform: scale(1.25); }
        .rd-star.active { animation: rd-star-pop 0.28s ease; }
        .rd-submit-btn:hover:not(:disabled) { background: rgba(245,197,24,0.28)!important; box-shadow: 0 0 24px rgba(245,197,24,0.5)!important; }
        .rd-submit-btn:disabled { opacity:0.5; cursor:not-allowed; }
        .rd-skip:hover { color: rgba(255,255,255,0.6)!important; }
      `}</style>

      {/* ── Dialog card ───────────────────────────────────────────────────── */}
      <div style={{
        background: 'linear-gradient(160deg,rgba(10,13,22,0.99),rgba(5,8,15,0.99))',
        border: '1px solid rgba(245,197,24,0.35)',
        boxShadow: '0 0 60px rgba(245,197,24,0.12), 0 0 120px rgba(123,47,247,0.1)',
        padding: '32px 28px',
        maxWidth: '380px',
        width: '100%',
        direction: 'rtl',
        position: 'relative',
      }}>

        {/* ── Corner accent lines ───────────────────────────────────────── */}
        {[
          { top: 0, right: 0, width: '24px', height: '2px', background: '#f5c518' },
          { top: 0, right: 0, width: '2px',  height: '24px', background: '#f5c518' },
          { bottom: 0, left: 0, width: '24px', height: '2px', background: '#7b2ff7' },
          { bottom: 0, left: 0, width: '2px',  height: '24px', background: '#7b2ff7' },
        ].map((s, i) => (
          <div key={i} style={{ position: 'absolute', ...s }} />
        ))}

        {done ? (
          // ── Success state ───────────────────────────────────────────────
          <div style={{ textAlign: 'center', padding: '16px 0' }}>
            <div style={{
              fontSize: '52px', marginBottom: '12px',
              animation: 'rd-done-glow 1.4s ease infinite',
            }}>⭐</div>
            <div style={{
              fontFamily: 'Orbitron,sans-serif', fontSize: '13px',
              color: '#f5c518', letterSpacing: '0.12em',
              textShadow: '0 0 14px rgba(245,197,24,0.7)',
            }}>شكراً على تقييمك!</div>
            <div style={{
              fontFamily: 'Rajdhani,sans-serif', fontSize: '14px',
              color: 'rgba(255,255,255,0.5)', marginTop: '6px',
            }}>يساعدنا في تحسين خدمتنا</div>
          </div>
        ) : (
          <>
            {/* ── Header ──────────────────────────────────────────────── */}
            <div style={{ marginBottom: '22px', textAlign: 'center' }}>
              <div style={{
                fontFamily: 'Orbitron,sans-serif', fontSize: '9px',
                color: 'rgba(245,197,24,0.5)', letterSpacing: '0.2em',
                marginBottom: '6px',
              }}>RIDE COMPLETE · ORDER #{orderId}</div>
              <div style={{
                fontFamily: 'Orbitron,sans-serif', fontSize: '15px',
                color: '#f5c518', letterSpacing: '0.06em',
                textShadow: '0 0 20px rgba(245,197,24,0.5)',
              }}>قيّم رحلتك</div>
              <div style={{
                fontFamily: 'Rajdhani,sans-serif', fontSize: '13px',
                color: 'rgba(255,255,255,0.4)', marginTop: '4px',
              }}>كيف كانت تجربتك مع السائق؟</div>
            </div>

            {/* ── Stars ────────────────────────────────────────────────── */}
            <div style={{
              display: 'flex', justifyContent: 'center', gap: '10px',
              marginBottom: '22px',
            }}>
              {[1, 2, 3, 4, 5].map(n => (
                <span
                  key={n}
                  className={`rd-star${selected === n ? ' active' : ''}`}
                  onMouseEnter={() => setHovered(n)}
                  onMouseLeave={() => setHovered(0)}
                  onClick={() => { setSelected(n); setError(null); }}
                  style={{
                    fontSize: '36px',
                    filter: n <= activeStars
                      ? 'drop-shadow(0 0 10px #f5c518) drop-shadow(0 0 20px rgba(245,197,24,0.5))'
                      : 'grayscale(1) brightness(0.35)',
                    transition: 'filter 0.15s, transform 0.12s',
                  }}
                >★</span>
              ))}
            </div>

            {/* ── Star label ───────────────────────────────────────────── */}
            {activeStars > 0 && (
              <div style={{
                textAlign: 'center', marginBottom: '14px',
                fontFamily: 'Rajdhani,sans-serif', fontSize: '13px',
                color: activeStars >= 4 ? '#00f5d4' : activeStars === 3 ? '#f5c518' : '#ff2d78',
                textShadow: `0 0 12px ${activeStars >= 4 ? '#00f5d4' : activeStars === 3 ? '#f5c518' : '#ff2d78'}`,
                transition: 'color 0.2s',
              }}>
                {activeStars === 1 && 'سيئة جداً'}
                {activeStars === 2 && 'سيئة'}
                {activeStars === 3 && 'مقبولة'}
                {activeStars === 4 && 'جيدة'}
                {activeStars === 5 && 'ممتازة! 🚀'}
              </div>
            )}

            {/* ── Notes textarea ───────────────────────────────────────── */}
            <textarea
              placeholder="ملاحظاتك عن الرحلة (اختياري)"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              maxLength={300}
              rows={3}
              style={{
                width: '100%', boxSizing: 'border-box',
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(245,197,24,0.2)',
                color: 'rgba(255,255,255,0.85)',
                fontFamily: 'Rajdhani,sans-serif', fontSize: '14px',
                padding: '10px 12px', resize: 'none', outline: 'none',
                marginBottom: '6px', direction: 'rtl',
                transition: 'border-color 0.2s',
              }}
              onFocus={e => { e.currentTarget.style.borderColor = 'rgba(245,197,24,0.5)'; }}
              onBlur={e  => { e.currentTarget.style.borderColor = 'rgba(245,197,24,0.2)'; }}
            />
            {notes.length > 0 && (
              <div style={{
                textAlign: 'left', fontSize: '10px',
                color: 'rgba(255,255,255,0.25)',
                fontFamily: 'Rajdhani,sans-serif',
                marginBottom: '14px',
              }}>{notes.length}/300</div>
            )}

            {/* ── Error ────────────────────────────────────────────────── */}
            {error && (
              <div style={{
                background: 'rgba(255,45,120,0.1)',
                border: '1px solid rgba(255,45,120,0.35)',
                color: '#ff2d78', fontFamily: 'Rajdhani,sans-serif',
                fontSize: '13px', padding: '8px 12px',
                marginBottom: '14px', textAlign: 'center',
              }}>{error}</div>
            )}

            {/* ── Submit button ─────────────────────────────────────────── */}
            <button
              className="rd-submit-btn"
              onClick={submit}
              disabled={submitting || !selected}
              style={{
                width: '100%',
                background: selected ? 'rgba(245,197,24,0.16)' : 'rgba(255,255,255,0.05)',
                border: `1px solid ${selected ? 'rgba(245,197,24,0.6)' : 'rgba(255,255,255,0.12)'}`,
                color: selected ? '#f5c518' : 'rgba(255,255,255,0.3)',
                fontFamily: 'Orbitron,sans-serif', fontSize: '11px',
                letterSpacing: '0.12em', padding: '13px',
                cursor: selected ? 'pointer' : 'not-allowed',
                transition: 'all 0.2s',
                boxShadow: selected ? '0 0 14px rgba(245,197,24,0.2)' : 'none',
              }}
            >
              {submitting ? '⏳ جاري الإرسال...' : '⭐ أرسل التقييم'}
            </button>

            {/* ── Skip ─────────────────────────────────────────────────── */}
            <button
              className="rd-skip"
              onClick={onClose}
              style={{
                display: 'block', width: '100%', marginTop: '10px',
                background: 'none', border: 'none',
                color: 'rgba(255,255,255,0.25)',
                fontFamily: 'Rajdhani,sans-serif', fontSize: '12px',
                cursor: 'pointer', transition: 'color 0.2s',
              }}
            >تخطّى</button>
          </>
        )}
      </div>
    </div>
  );
}
