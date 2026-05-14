import { useState, useEffect, useRef, useCallback } from 'react';

interface GasMsg {
  id: number | string;
  gasOrderId: number;
  senderRole: string;
  content: string;
  isSystemMsg?: boolean;
  createdAt: string;
}

interface GasChatOverlayProps {
  gasOrderId: number;
  agentPhone?: string;
  onMinimize: () => void;
  onNewMessage?: () => void;
}

const API = '/api';
const MSG_PATH = (id: number) => `${API}/gas-orders/${id}/messages`;

function sortByTime(msgs: GasMsg[]): GasMsg[] {
  return [...msgs].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
}

function SystemAlertBubble({ msg }: { msg: GasMsg }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '2px 0' }}>
      <div style={{
        position: 'relative', width: '100%',
        background: 'linear-gradient(135deg, rgba(255,45,120,0.08) 0%, rgba(255,150,0,0.12) 100%)',
        border: '1px solid rgba(255,45,120,0.55)',
        borderRight: '3px solid #ff2d78',
        padding: '9px 13px 9px 11px',
        boxShadow: '0 0 18px rgba(255,45,120,0.18), inset 0 0 30px rgba(255,45,120,0.04)',
        overflow: 'hidden',
      }}>
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: '1px',
          background: 'linear-gradient(90deg, transparent, rgba(255,45,120,0.6), transparent)',
          animation: 'gsys-scan 2.4s linear infinite',
        }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '5px' }}>
          <div style={{
            width: '6px', height: '6px', borderRadius: '50%',
            background: '#ff2d78', boxShadow: '0 0 8px #ff2d78',
            animation: 'gsys-blink 1.2s ease-in-out infinite', flexShrink: 0,
          }} />
          <span style={{
            fontFamily: 'Orbitron, sans-serif', fontSize: '8px',
            color: '#ff2d78', letterSpacing: '0.2em',
            textShadow: '0 0 10px rgba(255,45,120,0.6)',
          }}>⛽ تنبيه · GAS AGENT</span>
        </div>
        <div style={{
          fontFamily: 'Rajdhani, sans-serif', fontSize: '14px', fontWeight: 600,
          color: '#ffb0c8', lineHeight: 1.4,
          textShadow: '0 0 12px rgba(255,45,120,0.3)', wordBreak: 'break-word',
        }}>
          {msg.content}
        </div>
        <div style={{
          fontFamily: 'Rajdhani, sans-serif', fontSize: '9px',
          color: 'rgba(255,45,120,0.45)', marginTop: '5px', letterSpacing: '0.06em',
        }}>
          {new Date(msg.createdAt).toLocaleTimeString('ar-IQ', { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
    </div>
  );
}

export function GasChatOverlay({ gasOrderId, agentPhone, onMinimize, onNewMessage }: GasChatOverlayProps) {
  const [messages,  setMessages]  = useState<GasMsg[]>([]);
  const [input,     setInput]     = useState('');
  const [sending,   setSending]   = useState(false);
  const [sseOk,     setSseOk]     = useState(false);
  const bottomRef   = useRef<HTMLDivElement>(null);
  const pollRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const seenIdsRef  = useRef<Set<number | string>>(new Set());

  const mergeMessages = useCallback((incoming: GasMsg[]) => {
    setMessages(prev => {
      const existingIds = new Set(prev.map(m => m.id));
      const newMsgs = incoming.filter(m => !existingIds.has(m.id));
      newMsgs.forEach(m => {
        if (!seenIdsRef.current.has(m.id)) {
          seenIdsRef.current.add(m.id);
          if (m.senderRole === 'agent') onNewMessage?.();
        }
      });
      if (newMsgs.length === 0) return prev;
      return sortByTime([...prev, ...newMsgs]);
    });
  }, [onNewMessage]);

  const mergeMessage = useCallback((msg: GasMsg) => {
    setMessages(prev => {
      if (prev.some(m => m.id === msg.id)) return prev;
      if (!seenIdsRef.current.has(msg.id)) {
        seenIdsRef.current.add(msg.id);
        if (msg.senderRole === 'agent') onNewMessage?.();
      }
      return sortByTime([...prev, msg]);
    });
  }, [onNewMessage]);

  const fetchMessages = useCallback(async () => {
    try {
      const res = await fetch(MSG_PATH(gasOrderId));
      if (!res.ok) return;
      const data: GasMsg[] = await res.json();
      if (seenIdsRef.current.size === 0) {
        data.forEach(m => seenIdsRef.current.add(m.id));
        setMessages(sortByTime(data));
      } else {
        mergeMessages(data);
      }
    } catch { /* silent */ }
  }, [gasOrderId, mergeMessages]);

  useEffect(() => {
    fetchMessages();
    pollRef.current = setInterval(fetchMessages, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchMessages]);

  useEffect(() => {
    let es: EventSource | null = null;
    let retryDelay = 1000;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let destroyed = false;

    const connect = () => {
      if (destroyed) return;
      es = new EventSource(`${API}/events`);
      es.onopen = () => { retryDelay = 1000; setSseOk(true); };
      es.addEventListener('gas_new_message', (e: MessageEvent) => {
        try {
          const { message } = JSON.parse(e.data) as { message: GasMsg };
          if (message.gasOrderId !== gasOrderId) return;
          mergeMessage(message);
        } catch { /* malformed */ }
      });
      es.onerror = () => {
        es?.close(); setSseOk(false);
        if (destroyed) return;
        retryTimer = setTimeout(() => { retryDelay = Math.min(retryDelay * 2, 16_000); connect(); }, retryDelay);
      };
    };

    connect();
    return () => { destroyed = true; if (retryTimer) clearTimeout(retryTimer); es?.close(); };
  }, [gasOrderId, mergeMessage]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const res = await fetch(MSG_PATH(gasOrderId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ senderRole: 'customer', content: text }),
      });
      if (res.ok) { setInput(''); fetchMessages(); }
    } catch { /* silent */ }
    finally { setSending(false); }
  }, [input, sending, gasOrderId, fetchMessages]);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  return (
    <>
      <style>{`
        @keyframes gsys-scan {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        @keyframes gsys-blink {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.3; }
        }
      `}</style>

      <div style={{
        position: 'absolute', bottom: 0, right: 0, zIndex: 4100,
        width: 'min(360px, 100vw)',
        background: 'rgba(5,8,15,0.98)',
        border: '1px solid #ff2d78',
        borderBottom: 'none',
        boxShadow: '0 -4px 60px rgba(255,45,120,0.3), inset 0 1px 0 rgba(255,45,120,0.15)',
        display: 'flex', flexDirection: 'column',
        maxHeight: '420px',
        direction: 'rtl',
      }}>

        {/* ── Header ── */}
        <div style={{
          padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderBottom: '1px solid rgba(255,45,120,0.2)',
          background: 'rgba(255,45,120,0.06)', flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{
              width: '8px', height: '8px', borderRadius: '50%',
              background: sseOk ? '#00f5d4' : '#ff2d78',
              boxShadow: sseOk ? '0 0 8px #00f5d4' : '0 0 8px #ff2d78',
              animation: 'lf-ping 2s cubic-bezier(0,0,0.2,1) infinite', flexShrink: 0,
            }} />
            <div>
              <div style={{ fontFamily: 'Orbitron,sans-serif', fontSize: '9px', color: '#ff2d78', letterSpacing: '0.18em' }}>
                {sseOk ? 'LIVE' : 'SYNC'} · GAS ORDER #{gasOrderId}
              </div>
              <div style={{ fontFamily: 'Rajdhani,sans-serif', fontSize: '13px', color: '#e8f8f5', fontWeight: 600 }}>
                تواصل مع وكيل الغاز
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            {agentPhone && (
              <a
                href={`tel:${agentPhone}`}
                title={`اتصل بالوكيل: ${agentPhone}`}
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '4px',
                  background: 'rgba(0,245,212,0.12)', border: '1px solid rgba(0,245,212,0.5)',
                  color: '#00f5d4', fontFamily: 'Orbitron,sans-serif', fontSize: '8px',
                  letterSpacing: '0.1em', padding: '4px 9px', textDecoration: 'none',
                  cursor: 'pointer',
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 9.91a16 16 0 0 0 6.08 6.08l1.48-.93a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>
                </svg>
                اتصال
              </a>
            )}

            <button
              onClick={onMinimize}
              title="تصغير الدردشة"
              style={{
                background: 'none', border: '1px solid rgba(255,45,120,0.4)',
                color: 'rgba(255,160,180,0.9)', fontFamily: 'Orbitron,sans-serif',
                fontSize: '14px', lineHeight: 1, padding: '3px 9px',
                cursor: 'pointer',
              }}
            >−</button>
          </div>
        </div>

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
              لا توجد رسائل بعد.<br />ابدأ المحادثة مع وكيل الغاز
            </div>
          )}
          {messages.map(msg => {
            if (msg.isSystemMsg) return <SystemAlertBubble key={msg.id} msg={msg} />;
            const isCustomer = msg.senderRole === 'customer';
            return (
              <div key={msg.id} style={{ display: 'flex', justifyContent: isCustomer ? 'flex-start' : 'flex-end' }}>
                <div style={{
                  maxWidth: '78%',
                  background: isCustomer ? 'rgba(255,45,120,0.12)' : 'rgba(0,245,212,0.08)',
                  border: `1px solid ${isCustomer ? 'rgba(255,45,120,0.35)' : 'rgba(0,245,212,0.3)'}`,
                  padding: '7px 11px',
                  boxShadow: isCustomer ? '0 0 12px rgba(255,45,120,0.12)' : '0 0 12px rgba(0,245,212,0.08)',
                }}>
                  <div style={{ fontFamily: 'Orbitron,sans-serif', fontSize: '7px', color: isCustomer ? 'rgba(255,45,120,0.7)' : 'rgba(0,245,212,0.7)', letterSpacing: '0.12em', marginBottom: '4px' }}>
                    {isCustomer ? 'أنت' : '⛽ وكيل الغاز'}
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
          padding: '10px 14px', borderTop: '1px solid rgba(255,45,120,0.15)',
          display: 'flex', gap: '8px', flexShrink: 0,
          background: 'rgba(255,45,120,0.03)',
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
              background: 'rgba(255,45,120,0.06)', border: '1px solid rgba(255,45,120,0.3)',
              color: '#e8f8f5', fontFamily: 'Rajdhani,sans-serif', fontSize: '14px',
              padding: '8px 11px', outline: 'none',
            }}
            onFocus={e => (e.currentTarget.style.borderColor = '#ff2d78')}
            onBlur={e => (e.currentTarget.style.borderColor = 'rgba(255,45,120,0.3)')}
          />
          <button
            onClick={sendMessage}
            disabled={!input.trim() || sending}
            style={{
              padding: '8px 14px',
              background: (!input.trim() || sending) ? 'rgba(255,45,120,0.04)' : 'rgba(255,45,120,0.18)',
              border: '1px solid #ff2d78', color: '#ff8099',
              fontFamily: 'Orbitron,sans-serif', fontSize: '9px', letterSpacing: '0.1em',
              cursor: (!input.trim() || sending) ? 'not-allowed' : 'pointer',
              flexShrink: 0,
            }}
          >
            {sending
              ? <svg width="12" height="12" viewBox="0 0 28 28" fill="none" style={{ animation: 'lf-spin 0.9s linear infinite' }}><circle cx="14" cy="14" r="10" stroke="#ff8099" strokeWidth="2" strokeDasharray="22 14" strokeLinecap="round" /></svg>
              : 'إرسال'}
          </button>
        </div>
      </div>
    </>
  );
}
