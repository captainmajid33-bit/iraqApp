/**
 * FuelStationRadar — رادار محطات وقود ديالى
 * - Reads fuel_stations collection from Firestore (live)
 * - Draws colour-coded markers on the Leaflet map
 * - Bottom sheet lets nearby users (<500m) update the queue status
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import {
  collection, onSnapshot, updateDoc, doc, serverTimestamp,
  setDoc, getDoc,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';

// ── Types ─────────────────────────────────────────────────────────────────────
type QueueStatus = 'green' | 'yellow' | 'red';

interface FuelStation {
  id:           string;
  name:         string;
  address?:     string;
  latitude:     number;
  longitude:    number;
  queue_status: QueueStatus;
  last_updated: unknown;
  updater_name?: string;
}

interface FuelStationRadarProps {
  mapRef:       React.MutableRefObject<L.Map | null>;
  userLocation: { lat: number; lng: number } | null;
  visible?:     boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const STATUS_CONFIG: Record<QueueStatus, { color: string; glow: string; label: string; emoji: string }> = {
  red:    { color: '#ff2d50', glow: 'rgba(255,45,80,0.65)',   label: 'مزدحمة وقافلة',     emoji: '🔴' },
  yellow: { color: '#f5c518', glow: 'rgba(245,197,24,0.55)',  label: 'ازدحام خفيف',        emoji: '🟡' },
  green:  { color: '#00dc64', glow: 'rgba(0,220,100,0.55)',   label: 'فارغة وتفول سريع',   emoji: '🟢' },
};

// Default seed stations for Diyala / Baqubah — only written once if collection is empty
const SEED_STATIONS: Omit<FuelStation, 'id'>[] = [
  { name:'محطة باقوبة المركزية',    address:'شارع المدينة، باقوبة',   latitude:33.7440, longitude:44.6530, queue_status:'green',  last_updated:null },
  { name:'محطة الكاظمية - ديالى',  address:'منطقة الكاظمية',          latitude:33.7300, longitude:44.6700, queue_status:'yellow', last_updated:null },
  { name:'محطة المقدادية الغربية',  address:'مدخل المقدادية',           latitude:33.9700, longitude:44.9300, queue_status:'red',    last_updated:null },
  { name:'محطة بعقوبة الشمالية',   address:'الطريق العام الشمالي',     latitude:33.7650, longitude:44.6450, queue_status:'green',  last_updated:null },
  { name:'محطة خانقين المركزية',   address:'مركز خانقين',              latitude:34.3500, longitude:45.3800, queue_status:'yellow', last_updated:null },
  { name:'محطة بلدروز',             address:'قضاء بلدروز',              latitude:33.8250, longitude:45.0600, queue_status:'green',  last_updated:null },
  { name:'محطة الخالص الرئيسية',   address:'مدينة الخالص',             latitude:33.8330, longitude:44.5330, queue_status:'red',    last_updated:null },
];

// ── CSS ───────────────────────────────────────────────────────────────────────
function injectFuelCSS() {
  if (document.getElementById('fuel-styles')) return;
  const s = document.createElement('style');
  s.id = 'fuel-styles';
  s.textContent = `
    @keyframes fuel-pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.7;transform:scale(1.08)} }
    .fuel-marker-red    { animation: fuel-pulse 1.4s ease-in-out infinite; }
    .fuel-marker-yellow { animation: fuel-pulse 2.2s ease-in-out infinite; }
  `;
  document.head.appendChild(s);
}

// ── Marker icon factory ───────────────────────────────────────────────────────
function makeFuelIcon(status: QueueStatus): L.DivIcon {
  const cfg = STATUS_CONFIG[status];
  const pulse = status === 'red' ? 'fuel-marker-red' : status === 'yellow' ? 'fuel-marker-yellow' : '';
  return L.divIcon({
    className:  '',
    iconSize:   [48, 58],
    iconAnchor: [24, 58],
    html: `<div class="${pulse}" style="text-align:center;cursor:pointer;">
      <div style="
        width:42px; height:42px; border-radius:50%;
        background: rgba(5,8,15,0.92);
        border: 2.5px solid ${cfg.color};
        display:flex; align-items:center; justify-content:center;
        font-size:20px; margin:0 auto;
        box-shadow: 0 0 12px ${cfg.glow}, 0 0 24px ${cfg.glow.replace('0.55','0.25')};
      ">⛽</div>
      <div style="
        width:0; height:0;
        border-left:6px solid transparent;
        border-right:6px solid transparent;
        border-top:8px solid ${cfg.color};
        margin:0 auto;
      "></div>
    </div>`,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371, r = (d: number) => d * Math.PI / 180;
  const a = Math.sin(r(lat2-lat1)/2)**2 + Math.cos(r(lat1))*Math.cos(r(lat2))*Math.sin(r(lng2-lng1)/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function getUser(): { name?: string; phone?: string } | null {
  try { return JSON.parse(localStorage.getItem('diyala_user') ?? 'null'); } catch { return null; }
}

function formatTime(ts: unknown): string {
  if (!ts) return 'لم يُحدَّث بعد';
  try {
    const d = (ts as { toDate?: () => Date }).toDate?.() ?? new Date(ts as string);
    const diff = Math.floor((Date.now() - d.getTime()) / 60000);
    if (diff < 1)  return 'الآن';
    if (diff < 60) return `منذ ${diff} دقيقة`;
    const h = Math.floor(diff / 60);
    if (h < 24)    return `منذ ${h} ساعة`;
    return `منذ ${Math.floor(h/24)} يوم`;
  } catch { return '—'; }
}

// ── Component ─────────────────────────────────────────────────────────────────
export function FuelStationRadar({ mapRef, userLocation, visible = true }: FuelStationRadarProps) {

  const [mapReady,   setMapReady]   = useState(false);
  const [stations,   setStations]   = useState<FuelStation[]>([]);
  const [selected,   setSelected]   = useState<FuelStation | null>(null);
  const [updating,   setUpdating]   = useState(false);
  const [nearbyErr,  setNearbyErr]  = useState(false);
  const markersRef = useRef<Map<string, L.Marker>>(new Map());
  const seededRef  = useRef(false);

  // ── Wait for map readiness ────────────────────────────────────────────────
  useEffect(() => {
    if (mapRef.current) { setMapReady(true); return; }
    const iv = setInterval(() => {
      if (mapRef.current) { setMapReady(true); clearInterval(iv); }
    }, 250);
    return () => clearInterval(iv);
  }, [mapRef]);

  // ── Seed Firestore once if empty ──────────────────────────────────────────
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    (async () => {
      try {
        const testRef = doc(db, 'fuel_stations', 'seed_check');
        const snap = await getDoc(testRef);
        if (!snap.exists()) {
          console.log('[FuelRadar] seeding initial stations...');
          await Promise.all(SEED_STATIONS.map((s, i) =>
            setDoc(doc(db, 'fuel_stations', `station_${i+1}`), s)
          ));
          await setDoc(testRef, { seeded: true });
          console.log('[FuelRadar] seed complete');
        }
      } catch (e) { console.warn('[FuelRadar] seed error:', e); }
    })();
  }, []);

  // ── Live listener ─────────────────────────────────────────────────────────
  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, 'fuel_stations'),
      snap => {
        const docs: FuelStation[] = [];
        snap.forEach(d => {
          if (d.id === 'seed_check') return;
          const raw = d.data();
          const lat = Number(raw.latitude);
          const lng = Number(raw.longitude);
          if (isNaN(lat) || isNaN(lng)) return;
          docs.push({
            id:           d.id,
            name:         String(raw.name ?? 'محطة'),
            address:      raw.address ? String(raw.address) : undefined,
            latitude:     lat,
            longitude:    lng,
            queue_status: (raw.queue_status as QueueStatus) ?? 'green',
            last_updated: raw.last_updated ?? null,
            updater_name: raw.updater_name ? String(raw.updater_name) : undefined,
          });
        });
        console.log(`[FuelRadar] ${docs.length} station(s) loaded`);
        setStations(docs);
      },
      err => console.warn('[FuelRadar] onSnapshot error:', err.message),
    );
    return () => unsub();
  }, []);

  // ── Draw / update markers ─────────────────────────────────────────────────
  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current;
    if (!map) return;

    // Hide all markers when not visible
    if (!visible) {
      markersRef.current.forEach(marker => marker.remove());
      markersRef.current.clear();
      setSelected(null);
      return;
    }

    const currentIds = new Set(stations.map(s => s.id));

    // Remove stale
    markersRef.current.forEach((marker, id) => {
      if (!currentIds.has(id)) { marker.remove(); markersRef.current.delete(id); }
    });

    // Add / update
    stations.forEach(station => {
      const existing = markersRef.current.get(station.id);
      if (existing) {
        existing.setIcon(makeFuelIcon(station.queue_status));
        return;
      }
      const marker = L.marker([station.latitude, station.longitude], {
        icon:         makeFuelIcon(station.queue_status),
        zIndexOffset: 1500,
      }).addTo(map);

      marker.on('click', () => {
        setSelected(station);
        setNearbyErr(false);
      });
      markersRef.current.set(station.id, marker);
    });
  }, [stations, mapReady, mapRef, visible]);

  // ── Sync selected station with live updates ───────────────────────────────
  useEffect(() => {
    if (!selected) return;
    const updated = stations.find(s => s.id === selected.id);
    if (updated) setSelected(updated);
  }, [stations]);

  // ── Handle status update ──────────────────────────────────────────────────
  const handleUpdate = useCallback(async (newStatus: QueueStatus) => {
    if (!selected) return;

    // Anti-spam: must be within 500m
    if (!userLocation) {
      setNearbyErr(true);
      return;
    }
    const dist = haversine(userLocation.lat, userLocation.lng, selected.latitude, selected.longitude);
    if (dist > 0.5) {
      setNearbyErr(true);
      return;
    }

    setNearbyErr(false);
    setUpdating(true);
    try {
      const user = getUser();
      await updateDoc(doc(db, 'fuel_stations', selected.id), {
        queue_status: newStatus,
        last_updated: serverTimestamp(),
        updater_name: user?.name ?? 'مجهول',
      });
      console.log(`[FuelRadar] updated ${selected.id} → ${newStatus}`);
      setSelected(null);
    } catch (e) {
      console.error('[FuelRadar] update error:', e);
    } finally {
      setUpdating(false);
    }
  }, [selected, userLocation]);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  useEffect(() => {
    injectFuelCSS();
    return () => {
      markersRef.current.forEach(m => m.remove());
      markersRef.current.clear();
    };
  }, []);

  if (!selected) return null;

  const cfg = STATUS_CONFIG[selected.queue_status];
  const distKm = userLocation
    ? haversine(userLocation.lat, userLocation.lng, selected.latitude, selected.longitude).toFixed(2)
    : null;
  const isNearby = userLocation
    ? haversine(userLocation.lat, userLocation.lng, selected.latitude, selected.longitude) <= 0.5
    : false;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1100,
        background: 'rgba(0,0,0,0.52)', backdropFilter: 'blur(2px)',
        display: 'flex', flexDirection: 'column',
        alignItems: 'flex-end', justifyContent: 'flex-end',
      }}
      onClick={() => { setSelected(null); setNearbyErr(false); }}
    >
      <div
        style={{
          background:   'rgba(8,10,20,0.98)',
          border:       '1px solid rgba(255,255,255,0.1)',
          borderRadius: '20px 20px 0 0',
          padding:      '18px 20px 36px',
          width:        '100%',
          direction:    'rtl',
          boxShadow:    '0 -8px 32px rgba(0,0,0,0.5)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Handle */}
        <div style={{ width:'40px', height:'4px', background:'rgba(255,255,255,0.14)', borderRadius:'2px', margin:'0 auto 16px' }} />

        {/* Header */}
        <div style={{ display:'flex', alignItems:'center', gap:'12px', marginBottom:'14px' }}>
          <div style={{
            width:'44px', height:'44px', borderRadius:'50%', flexShrink:0,
            background:'rgba(5,8,15,0.9)',
            border:`2px solid ${cfg.color}`,
            display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:'22px',
            boxShadow:`0 0 14px ${cfg.glow}`,
          }}>⛽</div>
          <div>
            <div style={{ fontFamily:"'Tajawal',sans-serif", fontSize:'17px', fontWeight:700, color:'#fff' }}>{selected.name}</div>
            {selected.address && <div style={{ fontFamily:"'Tajawal',sans-serif", fontSize:'12px', color:'rgba(255,255,255,0.42)', marginTop:'2px' }}>{selected.address}</div>}
          </div>
        </div>

        {/* Status + meta */}
        <div style={{
          display:'flex', justifyContent:'space-between', alignItems:'center',
          padding:'10px 14px',
          background:'rgba(255,255,255,0.04)',
          border:'1px solid rgba(255,255,255,0.08)',
          borderRadius:'10px', marginBottom:'14px',
        }}>
          <div>
            <div style={{ fontFamily:"'Tajawal',sans-serif", fontSize:'13px', color:'rgba(255,255,255,0.4)', marginBottom:'3px' }}>الحالة الحالية</div>
            <div style={{ display:'flex', alignItems:'center', gap:'6px' }}>
              <span style={{ fontSize:'16px' }}>{cfg.emoji}</span>
              <span style={{ fontFamily:"'Tajawal',sans-serif", fontSize:'14px', fontWeight:700, color:cfg.color }}>{cfg.label}</span>
            </div>
          </div>
          <div style={{ textAlign:'left' }}>
            <div style={{ fontFamily:"'Tajawal',sans-serif", fontSize:'12px', color:'rgba(255,255,255,0.35)', marginBottom:'3px' }}>آخر تحديث</div>
            <div style={{ fontFamily:"'Tajawal',sans-serif", fontSize:'12px', color:'rgba(255,255,255,0.6)' }}>
              {formatTime(selected.last_updated)}
              {selected.updater_name && <span style={{ color:'rgba(255,255,255,0.3)' }}> · {selected.updater_name}</span>}
            </div>
          </div>
        </div>

        {/* Distance info */}
        {distKm && (
          <div style={{
            fontFamily:"'Tajawal',sans-serif", fontSize:'12px',
            color: isNearby ? '#00dc64' : 'rgba(255,255,255,0.4)',
            marginBottom:'12px', textAlign:'center',
          }}>
            {isNearby
              ? `✅ أنت على بُعد ${distKm} كم — يمكنك تحديث الحالة`
              : `📍 أنت على بُعد ${distKm} كم — يجب أن تكون أقل من 0.5 كم لتحديث الحالة`}
          </div>
        )}

        {/* Anti-spam error */}
        {nearbyErr && (
          <div style={{
            fontFamily:"'Tajawal',sans-serif", fontSize:'12px', color:'#ff8fa0',
            background:'rgba(255,45,80,0.1)', border:'1px solid rgba(255,45,80,0.3)',
            borderRadius:'8px', padding:'8px 12px', marginBottom:'12px', textAlign:'center',
          }}>
            ⚠️ يجب أن تكون قريباً من المحطة (أقل من 500 متر) لتحديث حالتها
          </div>
        )}

        {/* Update buttons */}
        <div style={{ marginBottom:'4px' }}>
          <div style={{ fontFamily:"'Tajawal',sans-serif", fontSize:'13px', color:'rgba(255,255,255,0.45)', marginBottom:'10px', textAlign:'center' }}>
            تحديث حالة السرّة الآن
          </div>
          <div style={{ display:'flex', flexDirection:'column', gap:'8px' }}>
            {(['red','yellow','green'] as QueueStatus[]).map(s => {
              const c = STATUS_CONFIG[s];
              const isActive = selected.queue_status === s;
              return (
                <button
                  key={s}
                  onClick={() => handleUpdate(s)}
                  disabled={updating || isActive}
                  style={{
                    width:'100%', padding:'13px 16px',
                    display:'flex', alignItems:'center', gap:'10px',
                    background: isActive ? `rgba(${s==='red'?'255,45,80':s==='yellow'?'245,197,24':'0,220,100'},0.15)` : 'rgba(255,255,255,0.04)',
                    border:`1.5px solid ${isActive ? c.color : 'rgba(255,255,255,0.1)'}`,
                    borderRadius:'10px',
                    cursor: (updating || isActive) ? 'default' : 'pointer',
                    opacity: updating && !isActive ? 0.5 : 1,
                    direction:'rtl',
                    transition:'all 0.18s',
                  }}
                >
                  <span style={{ fontSize:'18px' }}>{c.emoji}</span>
                  <span style={{ fontFamily:"'Tajawal',sans-serif", fontSize:'14px', fontWeight:600, color: isActive ? c.color : '#ccc' }}>
                    {c.label}
                  </span>
                  {isActive && (
                    <span style={{ marginRight:'auto', fontFamily:"'Tajawal',sans-serif", fontSize:'11px', color:c.color }}>● حالية</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Cancel */}
        <button
          onClick={() => { setSelected(null); setNearbyErr(false); }}
          style={{
            marginTop:'12px', width:'100%', padding:'10px',
            background:'transparent', border:'1px solid rgba(255,255,255,0.1)',
            borderRadius:'8px', color:'rgba(255,255,255,0.35)',
            fontFamily:"'Tajawal',sans-serif", fontSize:'13px', cursor:'pointer',
          }}
        >
          إغلاق
        </button>
      </div>
    </div>
  );
}
