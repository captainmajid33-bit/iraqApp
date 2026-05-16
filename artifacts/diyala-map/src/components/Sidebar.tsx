import { MapItem, Category } from "@/data/types";
import { Phone, Clock, MapPin, User, AlertTriangle, Navigation, XCircle, Star } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@/components/ui/button";

interface SidebarProps {
  item: MapItem | null;
  categories: Category[];
  onClose: () => void;
  userLocation: { lat: number; lng: number } | null;
  onNavigate: (item: MapItem) => void;
  routeTarget: MapItem | null;
  onClearRoute: () => void;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos((lat1*Math.PI)/180)*Math.cos((lat2*Math.PI)/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function getDetails(item: MapItem): string {
  const a = item as any;
  if (a.details) return a.details;
  if (item.kind === 'clinic')      return [a.doctor, a.specialty].filter(Boolean).join(' — ');
  if (item.kind === 'restaurant')  return [a.cuisine, a.type].filter(Boolean).join(' · ');
  if (item.kind === 'pharmacy')    return [a.pharmacist, a.type].filter(Boolean).join(' · ');
  return a.details ?? '';
}

const FALLBACK_COLORS: Record<string, string> = {
  clinic:      '#00f5d4',
  restaurant:  '#ff9500',
  pharmacy:    '#c77dff',
  gas_station: '#f5c518',
};

export function Sidebar({ item, categories, onClose, userLocation, onNavigate, routeTarget, onClearRoute }: SidebarProps) {
  if (!item) return null;

  const cat         = categories.find(c => c.slug === item.kind);
  const accentColor = cat?.color ?? FALLBACK_COLORS[item.kind] ?? '#00f5d4';
  const accentDim   = `${accentColor}18`;
  const catLabel    = cat ? `${cat.labelEn.toUpperCase()} TARGET` : item.kind.toUpperCase().replace(/_/g, ' ');
  const catEmoji    = cat?.icon ?? '📍';
  const catFooter   = cat ? `DIYALA ${cat.labelEn.toUpperCase()} NETWORK` : 'DIYALA NETWORK';

  const isNavigating = routeTarget?.id === item.id;
  const distanceKm   = userLocation ? haversineKm(userLocation.lat, userLocation.lng, item.lat, item.lng) : null;
  const details      = getDetails(item);
  const rating       = (item as any).rating as number | undefined;

  return (
    <AnimatePresence>
      <motion.aside
        key={item.id}
        initial={{ y: "100%", opacity: 0 }}
        animate={{ y: 0,      opacity: 1 }}
        exit={{ y: "100%",    opacity: 0 }}
        transition={{ type: "spring", damping: 28, stiffness: 220 }}
        style={{
          position:      'absolute',
          bottom:        0,
          left:          0,
          right:         0,
          zIndex:        1050,
          maxHeight:     '55vh',
          display:       'flex',
          flexDirection: 'column',
          background:    'rgba(5,8,15,0.97)',
          borderTop:     `2px solid ${accentColor}`,
          boxShadow:     `0 -8px 48px ${accentColor}22, 0 -2px 0 ${accentColor}44`,
          backdropFilter:'blur(16px)',
          direction:     'rtl',
          overflow:      'hidden',
        }}
      >
        {/* ── Close button — absolutely pinned to top-left of panel ── */}
        <button
          onClick={onClose}
          title="إغلاق"
          style={{
            position:       'absolute',
            top:            '10px',
            left:           '12px',
            zIndex:         10,
            width:          '36px',
            height:         '36px',
            display:        'flex',
            alignItems:     'center',
            justifyContent: 'center',
            background:     'rgba(255,45,120,0.12)',
            border:         '1.5px solid rgba(255,45,120,0.55)',
            borderRadius:   '4px',
            color:          '#ff2d78',
            fontSize:       '18px',
            lineHeight:     1,
            cursor:         'pointer',
            boxShadow:      '0 0 12px rgba(255,45,120,0.25)',
            transition:     'all 0.2s',
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLElement).style.background   = 'rgba(255,45,120,0.25)';
            (e.currentTarget as HTMLElement).style.boxShadow    = '0 0 20px rgba(255,45,120,0.5)';
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLElement).style.background   = 'rgba(255,45,120,0.12)';
            (e.currentTarget as HTMLElement).style.boxShadow    = '0 0 12px rgba(255,45,120,0.25)';
          }}
        >✕</button>

        {/* ── Header row ── */}
        <div style={{
          display:       'flex',
          alignItems:    'center',
          justifyContent:'center',
          padding:       '12px 60px',
          borderBottom:  `1px solid ${accentColor}30`,
          background:    accentDim,
          flexShrink:    0,
          gap:           '8px',
          minHeight:     '52px',
        }}>
          <span style={{ fontSize: '18px' }}>{catEmoji}</span>
          <h2 style={{
            fontFamily:    'Orbitron, sans-serif',
            fontSize:      '10px',
            fontWeight:    700,
            letterSpacing: '0.18em',
            color:         accentColor,
            textShadow:    `0 0 12px ${accentColor}66`,
          }}>{catLabel}</h2>
        </div>

        {/* ── Scrollable content ── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>

          {/* Name + ID */}
          <div>
            <h3 style={{ fontFamily:'Rajdhani,sans-serif', fontSize:'20px', fontWeight:700, color:accentColor, marginBottom:'4px', textShadow:`0 0 14px ${accentColor}55` }}>
              {item.name}
            </h3>
            <div style={{ fontFamily:'Orbitron,sans-serif', fontSize:'8px', color:`${accentColor}66`, letterSpacing:'0.14em' }}>
              ID: {item.id.toString().padStart(4,'0')} · {item.lat.toFixed(4)}, {item.lng.toFixed(4)}
            </div>
          </div>

          {/* Status + rating row */}
          <div style={{ display:'flex', alignItems:'center', gap:'10px', flexWrap:'wrap' }}>
            <div style={{
              display:'inline-flex', alignItems:'center', gap:'7px',
              padding:'5px 12px',
              border:`1px solid ${item.status==='مفتوح'?'#00f5d466':'#ff2d7866'}`,
              background:item.status==='مفتوح'?'rgba(0,245,212,0.07)':'rgba(255,45,120,0.07)',
              color:item.status==='مفتوح'?'#00f5d4':'#ff2d78',
              fontFamily:'Rajdhani,sans-serif', fontSize:'14px', fontWeight:600,
            }}>
              <AlertTriangle size={13}/>
              {item.status}
            </div>
            {typeof rating === 'number' && rating > 0 && (
              <div style={{ display:'flex', alignItems:'center', gap:'2px' }}>
                {Array.from({length:5}).map((_,i)=>(
                  <Star key={i} size={14} fill={i<rating?'#f5c518':'transparent'} style={{color:'#f5c518'}}/>
                ))}
              </div>
            )}
          </div>

          {/* Distance */}
          {distanceKm !== null && (
            <div style={{ display:'flex', alignItems:'center', gap:'10px', padding:'8px 12px', border:'1px solid rgba(245,197,24,0.35)', background:'rgba(245,197,24,0.06)', color:'#f5c518', fontFamily:'Rajdhani,sans-serif', fontSize:'14px' }}>
              <Navigation size={15} style={{flexShrink:0}}/>
              المسافة: <strong>{distanceKm<1?`${Math.round(distanceKm*1000)} م`:`${distanceKm.toFixed(1)} كم`}</strong>
            </div>
          )}

          {/* Info rows */}
          <div style={{ display:'flex', flexDirection:'column', gap:'6px' }}>
            {details   && <InfoRow icon={<User size={14}/>}      label="التفاصيل"   value={details}    color={accentColor}/>}
            <InfoRow icon={<MapPin size={14}/>}  label="العنوان"     value={item.address} color={accentColor}/>
            <InfoRow icon={<Phone size={14}/>}   label="الهاتف"      value={item.phone}   color={accentColor} mono/>
            <InfoRow icon={<Clock size={14}/>}   label="ساعات العمل" value={item.hours}   color={accentColor} mono/>
          </div>

          {/* Action buttons */}
          <div style={{ display:'flex', flexDirection:'column', gap:'8px', paddingTop:'8px', borderTop:`1px solid ${accentColor}20` }}>
            {isNavigating ? (
              <Button className="w-full font-mono text-sm tracking-widest uppercase"
                style={{ background:'rgba(255,45,120,0.12)', border:'1px solid #ff2d78', color:'#ff2d78', boxShadow:'0 0 14px rgba(255,45,120,0.25)', padding:'12px' }}
                onClick={onClearRoute}>
                <XCircle size={15} style={{marginLeft:'6px'}}/>إلغاء المسار / CANCEL
              </Button>
            ) : (
              <Button className="w-full font-mono text-sm tracking-widest uppercase"
                style={{ background:userLocation?'rgba(245,197,24,0.1)':'rgba(40,40,40,0.2)', border:`1px solid ${userLocation?'#f5c518':'#333'}`, color:userLocation?'#f5c518':'#444', cursor:userLocation?'pointer':'not-allowed', padding:'12px' }}
                onClick={()=>userLocation&&onNavigate(item)}
                title={!userLocation?'اضغط على زر تحديد موقعي أولاً':undefined}>
                <Navigation size={15} style={{marginLeft:'6px'}}/>
                {userLocation?'الذهاب إليه / NAVIGATE':'حدد موقعك أولاً'}
              </Button>
            )}
            <Button className="w-full font-mono text-sm tracking-widest uppercase"
              style={{ background:accentDim, border:`1px solid ${accentColor}88`, color:accentColor, padding:'12px' }}
              onClick={()=>window.open(`tel:${item.phone}`)}>
              <Phone size={14} style={{marginLeft:'6px'}}/>تواصل / CONTACT
            </Button>
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding:'6px 16px', textAlign:'center', flexShrink:0, borderTop:`1px solid ${accentColor}20`, background:accentDim }}>
          <span style={{ fontFamily:'Orbitron,sans-serif', fontSize:'8px', letterSpacing:'0.18em', color:`${accentColor}44` }}>
            {catFooter} · AI SYSTEM
          </span>
        </div>
      </motion.aside>
    </AnimatePresence>
  );
}

function InfoRow({ icon, label, value, color, mono=false }: {
  icon: React.ReactNode; label: string; value: string; color: string; mono?: boolean;
}) {
  if (!value) return null;
  return (
    <div style={{ display:'flex', alignItems:'flex-start', gap:'10px', padding:'10px 12px', background:'rgba(255,255,255,0.03)', border:`1px solid ${color}12` }}>
      <div style={{ color, marginTop:'1px', flexShrink:0 }}>{icon}</div>
      <div>
        <p style={{ fontFamily:'Orbitron,sans-serif', fontSize:'8px', color:`${color}66`, letterSpacing:'0.12em', marginBottom:'3px' }}>{label}</p>
        <p style={{ fontFamily:mono?'Orbitron,sans-serif':'Rajdhani,sans-serif', fontSize:mono?'12px':'15px', color:'rgba(255,255,255,0.9)', lineHeight:1.4 }}>{value}</p>
      </div>
    </div>
  );
}
