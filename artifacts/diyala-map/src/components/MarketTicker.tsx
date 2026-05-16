/**
 * MarketTicker — شريط بورصة ديالى المحلي
 * Reads from Firestore doc `market_rates/current` and renders a live scrolling ticker.
 */
import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';

interface RateDoc {
  dollar_rate?: string;
  gold_rate?:   string;
  notice?:      string;
  updated_at?:  unknown;
}

function injectTickerCSS() {
  if (document.getElementById('ticker-styles')) return;
  const s = document.createElement('style');
  s.id = 'ticker-styles';
  s.textContent = `
    @keyframes tk-scroll {
      0%   { transform: translateX(0); }
      100% { transform: translateX(-50%); }
    }
    .tk-track { display: flex; animation: tk-scroll 28s linear infinite; width: max-content; }
    .tk-track:hover { animation-play-state: paused; }
  `;
  document.head.appendChild(s);
}

export function MarketTicker() {
  const [rates, setRates] = useState<RateDoc | null>(null);

  useEffect(() => {
    injectTickerCSS();
    const unsub = onSnapshot(
      doc(db, 'market_rates', 'current'),
      snap => {
        if (snap.exists()) setRates(snap.data() as RateDoc);
      },
      err => console.warn('[Ticker] Firestore error:', err.message),
    );
    return () => unsub();
  }, []);

  // Build items list
  const items: { icon: string; label: string; value: string }[] = [];
  if (rates?.dollar_rate) items.push({ icon: '💵', label: 'الدولار',   value: rates.dollar_rate });
  if (rates?.gold_rate)   items.push({ icon: '⚜️', label: 'الذهب',    value: rates.gold_rate });
  if (rates?.notice)      items.push({ icon: '🔔', label: 'تنويه',     value: rates.notice });

  // Don't render if no data
  if (!rates || items.length === 0) return null;

  // Duplicate items for seamless loop
  const doubled = [...items, ...items];

  return (
    <div style={{
      position:     'fixed',
      top:          0,
      left:         0,
      right:        0,
      zIndex:       850,
      height:       '28px',
      background:   'rgba(5,8,15,0.96)',
      borderBottom: '1px solid rgba(245,197,24,0.28)',
      overflow:     'hidden',
      display:      'flex',
      alignItems:   'center',
      boxShadow:    '0 2px 16px rgba(245,197,24,0.12)',
      backdropFilter: 'blur(8px)',
    }}>
      {/* Label badge */}
      <div style={{
        flexShrink:     0,
        display:        'flex',
        alignItems:     'center',
        gap:            '5px',
        padding:        '0 10px',
        height:         '100%',
        background:     'rgba(245,197,24,0.14)',
        borderRight:    '1px solid rgba(245,197,24,0.3)',
        fontFamily:     'Orbitron, sans-serif',
        fontSize:       '8px',
        fontWeight:     700,
        color:          '#f5c518',
        letterSpacing:  '0.12em',
        whiteSpace:     'nowrap',
      }}>
        <span style={{ fontSize: '10px' }}>📊</span> LIVE
      </div>

      {/* Scrolling track */}
      <div style={{ flex: 1, overflow: 'hidden', height: '100%', display: 'flex', alignItems: 'center' }}>
        <div className="tk-track">
          {doubled.map((item, i) => (
            <div key={i} style={{
              display:    'flex',
              alignItems: 'center',
              gap:        '5px',
              padding:    '0 20px',
              direction:  'rtl',
              borderRight: i < doubled.length - 1 ? '1px solid rgba(255,255,255,0.08)' : 'none',
              whiteSpace: 'nowrap',
            }}>
              <span style={{ fontSize: '12px' }}>{item.icon}</span>
              <span style={{
                fontFamily:    "'Tajawal', sans-serif",
                fontSize:      '11px',
                color:         'rgba(255,255,255,0.45)',
              }}>{item.label}:</span>
              <span style={{
                fontFamily:    'Orbitron, sans-serif',
                fontSize:      '10px',
                fontWeight:    700,
                color:         item.icon === '🔔' ? '#ff8c42' : '#f5c518',
                letterSpacing: '0.03em',
              }}>{item.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
