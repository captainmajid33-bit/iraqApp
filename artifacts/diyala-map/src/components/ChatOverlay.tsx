import { useState, useEffect, useRef, useCallback } from 'react';

interface Msg {
  id: number | string;
  orderId: number;
  senderRole: string;
  content: string;
  isSystemMsg?: boolean;
  createdAt: string;
}

interface ChatOverlayProps {
  orderId: number;
  driverPhone?: string;
  /** Called when user presses the minimize (−) button — hides UI, keeps session alive */
  onMinimize: () => void;
  /** Called when user confirms "حذف المحادثة نهائياً" — ends session fully */
  onDeleteChat: () => void;
  /** Called whenever a system message arrives for the first time */
  onSystemMsg?: (content: string) => void;
}

const API = '/api';
const MSG_PATH = (id: number) => `${API}/orders/${id}/messages`;

function sortByTime(msgs: Msg[]): Msg[] {
  return [...msgs].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
}

// ── System Alert Bubble ────────────────────────────────────────────────────────
function SystemAlertBubble({ msg }: { msg: Msg }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '2px 0' }}>
      <div style={{
        position: 'relative', width: '100%',
        background: 'linear-gradient(135deg, rgba(245,197,24,0.08) 0%, rgba(255,150,0,0.12) 100%)',
        border: '1px solid rgba(245,197,24,0.55)',
        borderRight: '3px solid #f5c518',
        padding: '9px 13px 9px 11px',
        boxShadow: '0 0 18px rgba(245,197,24,0.18), inset 0 0 30px rgba(245,197,24,0.04)',
        overflow: 'hidden',
      }}>
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: '1px',
          background: 'linear-gradient(90deg, transparent, rgba(245,197,24,0.6), transparent)',
          animation: 'sys-scan 2.4s linear infinite',
        }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '5px' }}>
          <div style={{
            width: '6px', height: '6px', borderRadius: '50%',
            background: '#f5c518', boxShadow: '0 0 8px #f5c518',
            animation: 'sys-blink 1.2s ease-in-out infinite', flexShrink: 0,
          }} />
          <span style={{
            fontFamily: 'Orbitron, sans-serif', fontSize: '8px',
            color: '#f5c518', letterSpacing: '0.2em',
            textShadow: '0 0 10px rgba(245,197,24,0.6)',
          }}>⚠ تنبيه · SYSTEM ALERT</span>
        </div>
        <div style={{
          fontFamily: 'Rajdhani, sans-serif', fontSize: '14px', fontWeight: 600,
          color: '#ffe08a', lineHeight: 1.4,
          textShadow: '0 0 12px rgba(245,197,24,0.3)', wordBreak: 'break-word',
        }}>
          {msg.content}
        </div>
        <div style={{
          fontFamily: 'Rajdhani, sans-serif', fontSize: '9px',
          color: 'rgba(245,197,24,0.45)', marginTop: '5px', letterSpacing: '0.06em',
        }}>
          {new Date(msg.createdAt).toLocaleTimeString('ar-IQ', { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
    </div>
  );
}

export function ChatOverlay({ orderId, driverPhone, onMinimize, onDeleteChat, onSystemMsg }: ChatOverlayProps) {
  const [messages,     setMessages]     = useState<Msg[]>([]);
  const [input,        setInput]        = useState('');
  const [sending,      setSending]      = useState(false);
  const [sseOk,        setSseOk]        = useState(false);
  const [confirmDelete,setConfirmDelete] = useState(false);
  const bottomRef  = useRef<HTMLDivElement>(null);
  const pollRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const seenSysRef = useRef<Set<number | string>>(new Set());

  // ── Merge helper ──────────────────────────────────────────────────────────
  const mergeMessages = useCallback((incoming: Msg[]) => {
    setMessages(prev => {
      const existingIds = new Set(prev.map(m => m.id));
      const newMsgs = incoming.filter(m => !existingIds.has(m.id));
      newMsgs.forEach(m => {
        if (m.isSystemMsg && !seenSysRef.current.has(m.id)) {
          seenSysRef.current.add(m.id);
          onSystemMsg?.(m.content);
        }
      });
      if (newMsgs.length === 0) return prev;
      return sortByTime([...prev, ...newMsgs]);
    });
  }, [onSystemMsg]);

  const mergeMessage = useCallback((msg: Msg) => {
    setMessages(prev => {
      if (prev.some(m => m.id === msg.id)) return prev;
      if (msg.isSystemMsg && !seenSysRef.current.has(msg.id)) {
        seenSysRef.current.add(msg.id);
        onSystemMsg?.(msg.content);
      }
      return sortByTime([...prev, msg]);
    });
  }, [onSystemMsg]);

  // ── Fetch all messages ────────────────────────────────────────────────────
  const fetchMessages = useCallback(async () => {
    try {
      const res = await fetch(MSG_PATH(orderId));
      if (!res.ok) return;
      const data: Msg[] = await res.json();
      if (seenSysRef.current.size === 0) {
        data.forEach(m => { if (m.isSystemMsg) seenSysRef.current.add(m.id); });
        setMessages(sortByTime(data));
      } else {
        mergeMessages(data);
      }
    } catch { /* silent */ }
  }, [orderId, mergeMessages]);

  // ── Initial load + polling (every 2 s) ───────────────────────────────────
  useEffect(() => {
    fetchMessages();
    pollRef.current = setInterval(fetchMessages, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchMessages]);

  // ── SSE real-time listener ────────────────────────────────────────────────
  useEffect(() => {
    let es: EventSource | null = null;
    let retryDelay = 1000;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let destroyed = false;

    const connect = () => {
      if (destroyed) return;
      es = new EventSource(`${API}/events`);
      es.onopen = () => { retryDelay = 1000; setSseOk(true); };
      es.addEventListener('new_message', (e: MessageEvent) => {
        try {
          const { message } = JSON.parse(e.data) as { message: Msg };
          if (message.orderId !== orderId) return;
          mergeMessage(message);
        } catch { /* malformed */ }
      });
      es.onerror = (err) => {
        console.error('[ChatOverlay] SSE error — reconnecting in', retryDelay, 'ms', err);
        es?.close(); setSseOk(false);
        if (destroyed) return;
        retryTimer = setTimeout(() => { retryDelay = Math.min(retryDelay * 2, 16_000); connect(); }, retryDelay);
      };
    };

    connect();
    return () => { destroyed = true; if (retryTimer) clearTimeout(retryTimer); es?.close(); };
  }, [orderId, mergeMessage]);

  // ── Auto-scroll ───────────────────────────────────────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── Send message ──────────────────────────────────────────────────────────
  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const res = await fetch(MSG_PATH(orderId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ senderRole: 'customer', content: text }),
      });
      if (res.ok) { setInput(''); fetchMessages(); }
    } catch { /* silent */ }
    finally { setSending(false); }
  }, [input, sending, orderId, fetchMessages]);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  return (
    <>
      <style>{`
        @keyframes sys-scan {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        @keyframes sys-blink {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.3; }
        }
      `}</style>

      <div style={{
        position: 'absolute', bottom: 0, right: 0, zIndex: 4000,
        width: 'min(360px, 100vw)',
        background: 'rgba(5,8,15,0.98)',
        border: '1px solid #7b2ff7',
        borderBottom: 'none',
        boxShadow: '0 -4px 60px rgba(123,47,247,0.35), inset 0 1px 0 rgba(123,47,247,0.2)',
        display: 'flex', flexDirection: 'column',
        maxHeight: '420px',
        direction: 'rtl',
      }}>

        {/* ── Header ── */}
        <div style={{
          padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderBottom: '1px solid rgba(123,47,247,0.2)',
          background: 'rgba(123,47,247,0.08)', flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{
              width: '8px', height: '8px', borderRadius: '50%',
              background: sseOk ? '#00f5d4' : '#f5c518',
              boxShadow: sseOk ? '0 0 8px #00f5d4' : '0 0 8px #f5c518',
              animation: 'lf-ping 2s cubic-bezier(0,0,0.2,1) infinite', flexShrink: 0,
            }} />
            <div>
              <div style={{ fontFamily: 'Orbitron,sans-serif', fontSize: '9px', color: '#7b2ff7', letterSpacing: '0.18em' }}>
                {sseOk ? 'LIVE' : 'SYNC'} · ORDER #{orderId}
              </div>
              <div style={{ fontFamily: 'Rajdhani,sans-serif', fontSize: '13px', color: '#e8f8f5', fontWeight: 600 }}>
                تواصل مع السائق
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            {/* Call button */}
            {driverPhone && (
              <a
                href={`tel:${driverPhone}`}
                title={`اتصل بالسائق: ${driverPhone}`}
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '4px',
                  background: 'rgba(0,245,212,0.12)', border: '1px solid rgba(0,245,212,0.5)',
                  color: '#00f5d4', fontFamily: 'Orbitron,sans-serif', fontSize: '8px',
                  letterSpacing: '0.1em', padding: '4px 9px', textDecoration: 'none',
                  cursor: 'pointer', transition: 'all 0.2s',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(0,245,212,0.22)'; (e.currentTarget as HTMLElement).style.boxShadow = '0 0 12px rgba(0,245,212,0.3)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(0,245,212,0.12)'; (e.currentTarget as HTMLElement).style.boxShadow = 'none'; }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 9.91a16 16 0 0 0 6.08 6.08l1.48-.93a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
                </svg>
                اتصال
              </a>
            )}

            {/* Minimize button (−) — hides overlay, session stays alive */}
            <button
              onClick={onMinimize}
              title="تصغير الدردشة"
              style={{
                background: 'none', border: '1px solid rgba(123,47,247,0.4)',
                color: 'rgba(180,150,255,0.9)', fontFamily: 'Orbitron,sans-serif',
                fontSize: '14px', lineHeight: 1, padding: '3px 9px',
                cursor: 'pointer', transition: 'all 0.2s',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(123,47,247,0.15)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'none'; }}
            >−</button>

            {/* Delete button (trash) — opens confirm banner */}
            <button
              onClick={() => setConfirmDelete(true)}
              title="حذف المحادثة نهائياً"
              style={{
                background: 'none', border: '1px solid rgba(255,45,120,0.3)',
                color: 'rgba(255,45,120,0.7)', fontFamily: 'Orbitron,sans-serif',
                fontSize: '9px', letterSpacing: '0.08em', padding: '4px 8px',
                cursor: 'pointer', transition: 'all 0.2s',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,45,120,0.12)'; (e.currentTarget as HTMLElement).style.color = '#ff2d78'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'none'; (e.currentTarget as HTMLElement).style.color = 'rgba(255,45,120,0.7)'; }}
            >🗑</button>
          </div>
        </div>

        {/* ── Delete Confirmation Banner ── */}
        {confirmDelete && (
          <div style={{
            padding: '10px 14px', flexShrink: 0,
            background: 'rgba(255,45,120,0.1)',
            borderBottom: '1px solid rgba(255,45,120,0.35)',
            display: 'flex', alignItems: 'center', gap: '10px', direction: 'rtl',
          }}>
            <span style={{ fontFamily: 'Rajdhani,sans-serif', fontSize: '13px', color: '#ffa0c0', flex: 1 }}>
              إنهاء الجلسة نهائياً؟ لن تتمكن من استعادة المحادثة.
            </span>
            <button
              onClick={onDeleteChat}
              style={{
                padding: '5px 12px', background: 'rgba(255,45,120,0.2)',
                border: '1px solid #ff2d78', color: '#ff2d78',
                fontFamily: 'Orbitron,sans-serif', fontSize: '8px',
                letterSpacing: '0.1em', cursor: 'pointer',
              }}
            >تأكيد</button>
            <button
              onClick={() => setConfirmDelete(false)}
              style={{
                padding: '5px 10px', background: 'none',
                border: '1px solid rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.5)',
                fontFamily: 'Orbitron,sans-serif', fontSize: '8px',
                letterSpacing: '0.1em', cursor: 'pointer',
              }}
            >إلغاء</button>
          </div>
        )}

        {/* ── Messages list ── */}
        <div style={{
          flex: 1, overflowY: 'auto', padding: '12px 14px',
          display: 'flex', flexDirection: 'column', gap: '8px', minHeight: '160px',
        }}>
          {messages.length === 0 && (
            <div style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: 'Rajdhani,sans-serif', fontSize: '13px',
              color: 'rgba(255,255,255,0.25)', textAlign: 'center',
            }}>
              لا توجد رسائل بعد.<br />ابدأ المحادثة مع السائق
            </div>
          )}
          {messages.map(msg => {
            if (msg.isSystemMsg) return <SystemAlertBubble key={msg.id} msg={msg} />;
            const isCustomer = msg.senderRole === 'customer';
            return (
              <div key={msg.id} style={{ display: 'flex', justifyContent: isCustomer ? 'flex-start' : 'flex-end' }}>
                <div style={{
                  maxWidth: '78%',
                  background: isCustomer ? 'rgba(123,47,247,0.15)' : 'rgba(0,212,255,0.1)',
                  border: `1px solid ${isCustomer ? 'rgba(123,47,247,0.4)' : 'rgba(0,212,255,0.35)'}`,
                  padding: '7px 11px',
                  boxShadow: isCustomer ? '0 0 12px rgba(123,47,247,0.15)' : '0 0 12px rgba(0,212,255,0.1)',
                }}>
                  <div style={{ fontFamily: 'Orbitron,sans-serif', fontSize: '7px', color: isCustomer ? 'rgba(123,47,247,0.7)' : 'rgba(0,212,255,0.7)', letterSpacing: '0.12em', marginBottom: '4px' }}>
                    {isCustomer ? 'أنت' : '🚕 السائق'}
                  </div>
                  <div style={{ fontFamily: 'Rajdhani,sans-serif', fontSize: '14px', color: '#e8f8f5', lineHeight: 1.4, wordBreak: 'break-word' }}>
                    {msg.content}
                  </div>
                  <div style={{ fontFamily: 'Rajdhani,sans-serif', fontSize: '10px', color: 'rgba(255,255,255,0.25)', marginTop: '4px', textAlign: 'left' }}>
                    {new Date(msg.createdAt).toLocaleTimeString('ar-IQ', { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {/* ── Input row ── */}
        <div style={{
          padding: '10px 14px', borderTop: '1px solid rgba(123,47,247,0.15)',
          display: 'flex', gap: '8px', flexShrink: 0,
          background: 'rgba(123,47,247,0.04)',
        }}>
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder="اكتب رسالة..."
            disabled={sending}
            style={{
              flex: 1,
              background: 'rgba(123,47,247,0.08)', border: '1px solid rgba(123,47,247,0.3)',
              color: '#e8f8f5', fontFamily: 'Rajdhani,sans-serif', fontSize: '14px',
              padding: '8px 11px', outline: 'none', transition: 'border-color 0.2s',
            }}
            onFocus={e => (e.currentTarget.style.borderColor = '#7b2ff7')}
            onBlur={e => (e.currentTarget.style.borderColor = 'rgba(123,47,247,0.3)')}
          />
          <button
            onClick={sendMessage}
            disabled={!input.trim() || sending}
            style={{
              padding: '8px 14px',
              background: (!input.trim() || sending) ? 'rgba(123,47,247,0.05)' : 'rgba(123,47,247,0.2)',
              border: '1px solid #7b2ff7', color: '#c77dff',
              fontFamily: 'Orbitron,sans-serif', fontSize: '9px', letterSpacing: '0.1em',
              cursor: (!input.trim() || sending) ? 'not-allowed' : 'pointer',
              transition: 'all 0.2s', flexShrink: 0,
            }}
            onMouseEnter={e => { if (input.trim() && !sending) (e.currentTarget as HTMLElement).style.background = 'rgba(123,47,247,0.35)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = (!input.trim() || sending) ? 'rgba(123,47,247,0.05)' : 'rgba(123,47,247,0.2)'; }}
          >
            {sending
              ? <svg width="12" height="12" viewBox="0 0 28 28" fill="none" style={{ animation: 'lf-spin 0.9s linear infinite' }}><circle cx="14" cy="14" r="10" stroke="#c77dff" strokeWidth="2" strokeDasharray="22 14" strokeLinecap="round" /></svg>
              : 'إرسال'}
          </button>
        </div>
      </div>
    </>
  );
}
