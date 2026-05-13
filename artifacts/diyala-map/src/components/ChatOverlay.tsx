import { useState, useEffect, useRef, useCallback } from 'react';

interface Msg {
  id: number;
  orderId: number;
  senderRole: string;
  content: string;
  createdAt: string;
}

interface ChatOverlayProps {
  orderId: number;
  driverPhone?: string;
  onClose: () => void;
}

const API = '/api';

export function ChatOverlay({ orderId, driverPhone, onClose }: ChatOverlayProps) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input,    setInput]    = useState('');
  const [sending,  setSending]  = useState(false);
  const bottomRef  = useRef<HTMLDivElement>(null);
  const pollRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastIdRef  = useRef(0);

  // ── Fetch messages ─────────────────────────────────────────────────────────
  const fetchMessages = useCallback(async () => {
    try {
      const res = await fetch(`${API}/orders/${orderId}/messages`);
      if (!res.ok) return;
      const data: Msg[] = await res.json();
      setMessages(data);
      if (data.length > 0) lastIdRef.current = data[data.length - 1].id;
    } catch { /* silent */ }
  }, [orderId]);

  // ── Polling fallback every 2.5 s ──────────────────────────────────────────
  useEffect(() => {
    fetchMessages();
    pollRef.current = setInterval(fetchMessages, 2500);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchMessages]);

  // ── SSE listener — instant new_message events ──────────────────────────────
  useEffect(() => {
    const es = new EventSource(`${API}/events`);
    es.addEventListener('new_message', (e: MessageEvent) => {
      try {
        const { message } = JSON.parse(e.data) as { message: Msg };
        if (message.orderId !== orderId) return;
        setMessages(prev => {
          if (prev.some(m => m.id === message.id)) return prev;
          lastIdRef.current = message.id;
          return [...prev, message];
        });
      } catch { /* */ }
    });
    es.onerror = () => es.close();
    return () => es.close();
  }, [orderId]);

  // ── Auto-scroll to bottom on new messages ─────────────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── Send message ──────────────────────────────────────────────────────────
  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const res = await fetch(`${API}/orders/${orderId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ senderRole: 'customer', content: text }),
      });
      if (res.ok) {
        setInput('');
        fetchMessages();
      }
    } catch { /* */ } finally {
      setSending(false);
    }
  }, [input, sending, orderId, fetchMessages]);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  return (
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
        background: 'rgba(123,47,247,0.08)',
        flexShrink: 0,
      }}>
        {/* Left side: indicator + title */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{
            width: '8px', height: '8px', borderRadius: '50%',
            background: '#00f5d4', boxShadow: '0 0 8px #00f5d4',
            animation: 'lf-ping 2s cubic-bezier(0,0,0.2,1) infinite',
          }} />
          <div>
            <div style={{ fontFamily: 'Orbitron,sans-serif', fontSize: '9px', color: '#7b2ff7', letterSpacing: '0.18em' }}>
              LIVE CHAT · ORDER #{orderId}
            </div>
            <div style={{ fontFamily: 'Rajdhani,sans-serif', fontSize: '13px', color: '#e8f8f5', fontWeight: 600 }}>
              تواصل مع السائق
            </div>
          </div>
        </div>

        {/* Right side: call button + close */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {driverPhone && (
            <a
              href={`tel:${driverPhone}`}
              title={`اتصل بالسائق: ${driverPhone}`}
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                gap: '4px',
                background: 'rgba(0,245,212,0.12)',
                border: '1px solid rgba(0,245,212,0.5)',
                color: '#00f5d4',
                fontFamily: 'Orbitron,sans-serif', fontSize: '8px', letterSpacing: '0.1em',
                padding: '4px 9px',
                textDecoration: 'none',
                cursor: 'pointer',
                transition: 'all 0.2s',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLElement).style.background = 'rgba(0,245,212,0.22)';
                (e.currentTarget as HTMLElement).style.boxShadow = '0 0 12px rgba(0,245,212,0.3)';
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLElement).style.background = 'rgba(0,245,212,0.12)';
                (e.currentTarget as HTMLElement).style.boxShadow = 'none';
              }}
            >
              {/* Phone icon SVG */}
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 9.91a16 16 0 0 0 6.08 6.08l1.48-.93a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
              </svg>
              اتصال
            </a>
          )}
          <button
            onClick={onClose}
            style={{
              background: 'none', border: '1px solid rgba(255,45,120,0.3)',
              color: 'rgba(255,45,120,0.7)', fontFamily: 'Orbitron,sans-serif',
              fontSize: '8px', letterSpacing: '0.1em', padding: '4px 8px',
              cursor: 'pointer', transition: 'all 0.2s',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,45,120,0.12)'; (e.currentTarget as HTMLElement).style.color = '#ff2d78'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'none'; (e.currentTarget as HTMLElement).style.color = 'rgba(255,45,120,0.7)'; }}
          >إغلاق</button>
        </div>
      </div>

      {/* ── Messages list ── */}
      <div style={{
        flex: 1, overflowY: 'auto', padding: '12px 14px',
        display: 'flex', flexDirection: 'column', gap: '8px',
        minHeight: '160px',
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
          const isCustomer = msg.senderRole === 'customer';
          return (
            <div key={msg.id} style={{
              display: 'flex',
              justifyContent: isCustomer ? 'flex-start' : 'flex-end',
            }}>
              <div style={{
                maxWidth: '78%',
                background: isCustomer
                  ? 'rgba(123,47,247,0.15)'
                  : 'rgba(0,212,255,0.1)',
                border: `1px solid ${isCustomer ? 'rgba(123,47,247,0.4)' : 'rgba(0,212,255,0.35)'}`,
                padding: '7px 11px',
                boxShadow: isCustomer
                  ? '0 0 12px rgba(123,47,247,0.15)'
                  : '0 0 12px rgba(0,212,255,0.1)',
              }}>
                <div style={{
                  fontFamily: 'Orbitron,sans-serif', fontSize: '7px',
                  color: isCustomer ? 'rgba(123,47,247,0.7)' : 'rgba(0,212,255,0.7)',
                  letterSpacing: '0.12em', marginBottom: '4px',
                }}>
                  {isCustomer ? 'أنت' : '🚕 السائق'}
                </div>
                <div style={{
                  fontFamily: 'Rajdhani,sans-serif', fontSize: '14px',
                  color: '#e8f8f5', lineHeight: 1.4, wordBreak: 'break-word',
                }}>
                  {msg.content}
                </div>
                <div style={{
                  fontFamily: 'Rajdhani,sans-serif', fontSize: '10px',
                  color: 'rgba(255,255,255,0.25)', marginTop: '4px', textAlign: 'left',
                }}>
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
            background: 'rgba(123,47,247,0.08)',
            border: '1px solid rgba(123,47,247,0.3)',
            color: '#e8f8f5',
            fontFamily: 'Rajdhani,sans-serif', fontSize: '14px',
            padding: '8px 11px', outline: 'none',
            transition: 'border-color 0.2s',
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
            border: '1px solid #7b2ff7',
            color: '#c77dff',
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
  );
}
