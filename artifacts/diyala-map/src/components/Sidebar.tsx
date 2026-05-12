import { MapItem } from "@/data/types";
import { X, Phone, Clock, MapPin, User, Stethoscope, AlertTriangle, Navigation, XCircle, Utensils, Star, Pill } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@/components/ui/button";

interface SidebarProps {
  item: MapItem | null;
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

const KIND_CONFIG = {
  clinic:     { color: '#00f5d4', label: 'MEDICAL TARGET',  footer: 'DIYALA HEALTH DIRECTORATE' },
  restaurant: { color: '#ff9500', label: 'DINING TARGET',   footer: 'DIYALA DINING GUIDE' },
  pharmacy:   { color: '#c77dff', label: 'PHARMACY TARGET', footer: 'DIYALA PHARMACY NETWORK' },
};

export function Sidebar({ item, onClose, userLocation, onNavigate, routeTarget, onClearRoute }: SidebarProps) {
  if (!item) return null;

  const cfg = KIND_CONFIG[item.kind];
  const accentColor = cfg.color;
  const accentDim = `${accentColor}18`;
  const isNavigating = routeTarget?.id === item.id;
  const distanceKm = userLocation ? haversineKm(userLocation.lat, userLocation.lng, item.lat, item.lng) : null;

  const HeaderIcon = item.kind === 'clinic' ? Stethoscope : item.kind === 'restaurant' ? Utensils : Pill;

  return (
    <AnimatePresence>
      <motion.aside
        key={item.id}
        initial={{ x: "100%", opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: "100%", opacity: 0 }}
        transition={{ type: "spring", damping: 25, stiffness: 200 }}
        className="absolute top-0 right-0 h-full w-[380px] bg-black/90 backdrop-blur-md z-20 flex flex-col"
        style={{ borderLeft: `1px solid ${accentColor}44` }}
      >
        {/* Header */}
        <div className="p-4 flex items-center justify-between shrink-0" style={{ borderBottom: `1px solid ${accentColor}30`, background: accentDim }}>
          <div className="flex items-center gap-2">
            <HeaderIcon className="w-4 h-4" style={{ color: accentColor }} />
            <h2 className="text-sm font-mono font-bold tracking-wider" style={{ color: accentColor }}>{cfg.label}</h2>
          </div>
          <button onClick={onClose} className="p-1 transition-colors rounded" style={{ color: accentColor }}
            onMouseEnter={e=>(e.currentTarget.style.background=accentDim)}
            onMouseLeave={e=>(e.currentTarget.style.background='transparent')}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Name */}
          <div>
            <h3 className="text-xl font-bold mb-1" style={{ color: accentColor, textShadow: `0 0 12px ${accentColor}55` }}>
              {item.name}
            </h3>
            <div className="flex items-center gap-2 text-xs font-mono" style={{ color: `${accentColor}77` }}>
              <span>ID: {item.id.toString().padStart(4,'0')}</span>
              <span>•</span>
              <span>{item.lat.toFixed(4)}, {item.lng.toFixed(4)}</span>
            </div>
          </div>

          {/* Status + rating */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="inline-flex items-center gap-2 px-3 py-1 font-mono text-sm"
              style={{ border: `1px solid ${item.status==='مفتوح'?'#00f5d466':'#ff2d7866'}`, background: item.status==='مفتوح'?'rgba(0,245,212,0.07)':'rgba(255,45,120,0.07)', color: item.status==='مفتوح'?'#00f5d4':'#ff2d78' }}>
              <AlertTriangle className="w-3.5 h-3.5" />
              {item.status}
            </div>
            {item.kind === 'restaurant' && 'rating' in item && (
              <div className="flex items-center gap-1">
                {Array.from({length:5}).map((_,i)=>(
                  <Star key={i} className="w-3.5 h-3.5" fill={i<(item as any).rating?'#f5c518':'transparent'} style={{color:'#f5c518'}}/>
                ))}
              </div>
            )}
          </div>

          {/* Distance */}
          {distanceKm !== null && (
            <div className="flex items-center gap-3 px-3 py-2 font-mono text-sm"
              style={{ border:'1px solid rgba(245,197,24,0.4)', background:'rgba(245,197,24,0.06)', color:'#f5c518' }}>
              <Navigation className="w-4 h-4 flex-shrink-0" />
              <span>المسافة: <strong>{distanceKm<1?`${Math.round(distanceKm*1000)} م`:`${distanceKm.toFixed(1)} كم`}</strong></span>
            </div>
          )}

          {/* Info rows */}
          <div className="space-y-2">
            {item.kind==='clinic' && 'doctor' in item && (
              <InfoRow icon={<User/>} label="الطبيب" value={(item as any).doctor} color={accentColor}/>
            )}
            {item.kind==='clinic' && 'specialty' in item && (
              <InfoRow icon={<Stethoscope/>} label="الاختصاص" value={(item as any).specialty} color={accentColor}/>
            )}
            {item.kind==='restaurant' && 'cuisine' in item && (
              <InfoRow icon={<Utensils/>} label="المطبخ" value={(item as any).cuisine} color={accentColor}/>
            )}
            {item.kind==='restaurant' && 'type' in item && (
              <InfoRow icon={<MapPin/>} label="النوع" value={(item as any).type} color={accentColor}/>
            )}
            {item.kind==='pharmacy' && 'pharmacist' in item && (
              <InfoRow icon={<User/>} label="الصيدلاني" value={(item as any).pharmacist} color={accentColor}/>
            )}
            {item.kind==='pharmacy' && 'type' in item && (
              <InfoRow icon={<Pill/>} label="النوع" value={(item as any).type} color={accentColor}/>
            )}
            <InfoRow icon={<MapPin/>} label="العنوان" value={item.address} color={accentColor}/>
            <InfoRow icon={<Phone/>} label="الهاتف" value={item.phone} color={accentColor} font="font-mono"/>
            <InfoRow icon={<Clock/>} label="ساعات العمل" value={item.hours} color={accentColor} font="font-mono"/>
          </div>

          {/* Buttons */}
          <div className="pt-3 space-y-3" style={{ borderTop:`1px solid ${accentColor}20` }}>
            {isNavigating ? (
              <Button className="w-full font-mono text-sm py-5 tracking-widest uppercase"
                style={{ background:'rgba(255,45,120,0.12)', border:'1px solid #ff2d78', color:'#ff2d78', boxShadow:'0 0 14px rgba(255,45,120,0.25)' }}
                onClick={onClearRoute}>
                <XCircle className="w-4 h-4 ml-2"/>إلغاء المسار / CANCEL
              </Button>
            ) : (
              <Button className="w-full font-mono text-sm py-5 tracking-widest uppercase"
                style={{ background:userLocation?'rgba(245,197,24,0.1)':'rgba(40,40,40,0.2)', border:`1px solid ${userLocation?'#f5c518':'#333'}`, color:userLocation?'#f5c518':'#444', cursor:userLocation?'pointer':'not-allowed' }}
                onClick={()=>userLocation&&onNavigate(item)}
                title={!userLocation?'اضغط على زر تحديد موقعي أولاً':undefined}>
                <Navigation className="w-4 h-4 ml-2"/>
                {userLocation?'الذهاب إليه / NAVIGATE':'حدد موقعك أولاً'}
              </Button>
            )}
            <Button className="w-full font-mono text-sm py-5 tracking-widest uppercase transition-all"
              style={{ background:accentDim, border:`1px solid ${accentColor}88`, color:accentColor }}
              onClick={()=>window.open(`tel:${item.phone}`)}>
              تواصل / CONTACT
            </Button>
          </div>
        </div>

        <div className="p-2 text-center shrink-0" style={{ borderTop:`1px solid ${accentColor}20`, background:accentDim }}>
          <span className="text-[10px] font-mono tracking-widest" style={{color:`${accentColor}55`}}>
            {cfg.footer} · AI SYSTEM
          </span>
        </div>
      </motion.aside>
    </AnimatePresence>
  );
}

function InfoRow({ icon, label, value, color, font='font-sans' }: {
  icon: React.ReactNode; label: string; value: string; color: string; font?: string;
}) {
  return (
    <div className="flex items-start gap-3 p-3" style={{ background:'rgba(255,255,255,0.03)', border:`1px solid ${color}12` }}>
      <div style={{ color, marginTop:'2px', flexShrink:0 }}>{icon}</div>
      <div>
        <p className="text-xs font-mono mb-0.5" style={{ color:`${color}66` }}>{label}</p>
        <p className={`text-base text-white/90 ${font}`}>{value}</p>
      </div>
    </div>
  );
}
