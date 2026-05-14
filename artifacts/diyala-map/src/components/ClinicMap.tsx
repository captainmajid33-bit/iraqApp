import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapItem, Category } from '@/data/types';
import { ChatOverlay } from './ChatOverlay';
import { RatingDialog } from './RatingDialog';

// ── Haversine distance (km) between two lat/lng points ────────────────────
function haversineDist(lat1:number,lng1:number,lat2:number,lng2:number):number {
  const R=6371, toRad=(d:number)=>d*Math.PI/180;
  const dLat=toRad(lat2-lat1), dLng=toRad(lng2-lng1);
  const a=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

interface ClinicMapProps {
  items: MapItem[];
  categories: Category[];
  activeFilter: string;
  onFilterChange: (f: string) => void;
  onSelectItem: (item: MapItem) => void;
  selectedItem: MapItem | null;
  userLocation: { lat: number; lng: number } | null;
  onUserLocationChange: (loc: { lat: number; lng: number } | null) => void;
  routeTarget: MapItem | null;
  onNavigate: (item: MapItem) => void;
  onClearRoute: () => void;
  adminMode?: boolean;
  onMapClick?: (latlng: { lat: number; lng: number }) => void;
  onAdminDelete?: (item: MapItem) => void;
}

// ── Fallback colors for the 4 original kinds ──────────────────────────────────
const FALLBACK_COLORS: Record<string, { open: string }> = {
  clinic:      { open: '#00f5d4' },
  restaurant:  { open: '#ff9500' },
  pharmacy:    { open: '#c77dff' },
  gas_station: { open: '#f5c518' },
};

function getCatColor(slug: string, catMap: Map<string, Category>): string {
  return catMap.get(slug)?.color ?? FALLBACK_COLORS[slug]?.open ?? '#7b2ff7';
}

// ── Static SVG bodies for original 4 kinds ───────────────────────────────────
function getSvgBody(kind: string, color: string): string | null {
  if (kind === 'clinic')
    return `<path d="M7 2v5a5 5 0 0010 0V2" stroke="${color}" stroke-width="1.8" stroke-linecap="round" fill="none"/>
            <path d="M12 7v6" stroke="${color}" stroke-width="1.8" stroke-linecap="round"/>
            <circle cx="12" cy="17" r="3" fill="${color}" fill-opacity="0.25" stroke="${color}" stroke-width="1.5"/>
            <circle cx="12" cy="17" r="1.2" fill="${color}"/>`;
  if (kind === 'restaurant')
    return `<path d="M18 3v18M15 3c0 3.314 2.686 6 3 6v6" stroke="${color}" stroke-width="1.8" stroke-linecap="round"/>
            <path d="M6 3v6.5A3.5 3.5 0 0 0 9.5 13H10v8" stroke="${color}" stroke-width="1.8" stroke-linecap="round"/>
            <path d="M3 3v6.5A3.5 3.5 0 0 0 6.5 13" stroke="${color}" stroke-width="1.8" stroke-linecap="round"/>
            <line x1="3" y1="8" x2="10" y2="8" stroke="${color}" stroke-width="1.5"/>`;
  if (kind === 'pharmacy')
    return `<rect x="8" y="3" width="8" height="18" rx="4" fill="${color}" fill-opacity="0.15" stroke="${color}" stroke-width="1.5"/>
            <path d="M8 3h8a4 4 0 0 1 0 0v9H8V7a4 4 0 0 1 0-4z" fill="${color}" fill-opacity="0.55"/>
            <rect x="8" y="3" width="8" height="18" rx="4" fill="none" stroke="${color}" stroke-width="1.5"/>
            <line x1="8" y1="12" x2="16" y2="12" stroke="${color}" stroke-width="1.2"/>`;
  if (kind === 'gas_station')
    return `<rect x="3" y="5" width="11" height="16" rx="1.5" fill="${color}" fill-opacity="0.15" stroke="${color}" stroke-width="1.5"/>
            <rect x="5" y="8" width="7" height="4" rx="1" fill="${color}" fill-opacity="0.5"/>
            <path d="M14 8h2a2 2 0 0 1 2 2v4a1.5 1.5 0 0 0 3 0V9l-3-3" stroke="${color}" stroke-width="1.5" stroke-linecap="round" fill="none"/>
            <line x1="3" y1="21" x2="14" y2="21" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>`;
  return null;
}

// ── Icon factory ──────────────────────────────────────────────────────────────
// Open → neon green  |  Closed → neon red  (no category color on markers)
const OPEN_COLOR   = '#00f5d4';
const CLOSED_COLOR = '#ff2d78';

function makeIcon(kind: string, catMap: Map<string, Category>, isOpen: boolean, selected: boolean, name = ''): L.DivIcon {
  const color    = isOpen ? OPEN_COLOR : CLOSED_COLOR;
  const emoji    = catMap.get(kind)?.icon ?? '📍';
  const size     = selected ? 44 : 36;
  const pulse    = isOpen && !selected;
  const svgBody  = getSvgBody(kind, color);
  const short    = name.length > 16 ? name.slice(0, 16) + '…' : name;

  // Label text color: yellow-neon for open, soft pink for closed, white for selected
  const labelClr = selected ? '#ffffff' : isOpen ? '#f5c518' : '#ffb3c6';
  const txtGlow  = `0 0 7px ${color},0 0 14px ${color}88`;

  // Label HTML: dark box + neon text + thin connector line
  const labelHtml = short
    ? `<div style="background:rgba(0,6,15,0.93);border:1px solid ${color}55;color:${labelClr};font-family:'Rajdhani',sans-serif;font-size:10px;font-weight:700;padding:2px 8px;white-space:nowrap;letter-spacing:0.04em;text-shadow:${txtGlow};box-shadow:0 0 8px ${color}28,inset 0 0 6px ${color}14;direction:rtl;text-align:center;max-width:128px;overflow:hidden;text-overflow:ellipsis;">${short}</div><div style="width:1.5px;height:5px;background:${color};margin:0 auto;opacity:0.65;"></div>`
    : '';

  // Container dimensions — wider when label is present so it centres nicely
  const W       = short ? 134 : size;
  const labelH  = short ? 25 : 0;
  const totalH  = labelH + size;
  const anchorX = W / 2;
  const anchorY = labelH + size / 2;   // geographic pin at circle centre

  return L.divIcon({
    className: '',
    html: `<div style="display:flex;flex-direction:column;align-items:center;width:${W}px;">
      ${labelHtml}
      <div style="width:${size}px;height:${size}px;position:relative;display:flex;align-items:center;justify-content:center;">
        ${pulse ? `<div style="position:absolute;inset:0;border-radius:50%;background:${color};opacity:0.18;animation:lf-ping 2s cubic-bezier(0,0,0.2,1) infinite;"></div>` : ''}
        <div style="position:absolute;inset:0;border-radius:50%;border:2px solid ${color};box-shadow:0 0 ${selected?20:12}px ${color},0 0 ${selected?40:24}px ${color}88;"></div>
        ${svgBody
          ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none">${svgBody}</svg>`
          : `<span style="font-size:${Math.round(size*0.4)}px;position:relative;z-index:1;line-height:1;user-select:none">${emoji}</span>`
        }
      </div>
    </div>`,
    iconSize: [W, totalH],
    iconAnchor: [anchorX, anchorY],
  });
}

function createUserArrowIcon(heading: number | null): L.DivIcon {
  const rot = heading !== null ? heading : 0;
  const hasHeading = heading !== null;
  // GTA V-style neon arrow
  return L.divIcon({
    className: '',
    html: `<div style="width:44px;height:44px;position:relative;display:flex;align-items:center;justify-content:center;">
      <!-- outer pulse ring -->
      <div style="position:absolute;inset:0;border-radius:50%;background:#00f5d4;opacity:0.10;animation:lf-ping 2.2s cubic-bezier(0,0,0.2,1) infinite;"></div>
      <!-- accuracy ring -->
      <div style="position:absolute;inset:4px;border-radius:50%;border:1.5px solid #00f5d466;"></div>
      <!-- rotatable arrow -->
      <svg width="44" height="44" viewBox="0 0 44 44" fill="none"
           style="position:absolute;inset:0;transform:rotate(${rot}deg);transition:transform 0.4s ease;">
        <!-- glow shadow arrow -->
        <path d="M22 6 L29 32 L22 27 L15 32 Z" fill="#00f5d433" filter="url(#ug)"/>
        <!-- main neon arrow -->
        <path d="M22 6 L29 32 L22 27 L15 32 Z"
              fill="#00f5d4" stroke="#00f5d4" stroke-width="0.8" stroke-linejoin="round"/>
        <!-- center core -->
        <circle cx="22" cy="22" r="3" fill="#ffffff" opacity="0.95"/>
        <circle cx="22" cy="22" r="5" fill="#00f5d4" opacity="0.2"/>
        <defs>
          <filter id="ug" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="b"/>
          </filter>
        </defs>
      </svg>
      ${!hasHeading ? `<div style="position:absolute;bottom:-1px;left:50%;transform:translateX(-50%);width:6px;height:6px;border-radius:50%;background:#f5c518;box-shadow:0 0 8px #f5c518;"></div>` : ''}
    </div>`,
    iconSize: [44,44], iconAnchor: [22,22],
  });
}

// ── Route drawing ─────────────────────────────────────────────────────────────
function drawRoute(
  map: L.Map, userLoc: {lat:number;lng:number}, item: MapItem,
  onDone: (info:{distanceKm:number;durationMin:number}|null)=>void,
  onLoading: (v:boolean)=>void,
  glowRef: React.MutableRefObject<L.Polyline|null>,
  lineRef: React.MutableRefObject<L.Polyline|null>,
) {
  glowRef.current?.remove(); glowRef.current = null;
  lineRef.current?.remove(); lineRef.current = null;
  onDone(null); onLoading(true);
  fetch(`https://router.project-osrm.org/route/v1/driving/${userLoc.lng},${userLoc.lat};${item.lng},${item.lat}?overview=full&geometries=geojson`)
    .then(r=>r.json())
    .then(data=>{
      const route = data.routes?.[0]; if (!route) return;
      const coords:[number,number][] = route.geometry.coordinates.map(([lng,lat]:[number,number])=>[lat,lng]);
      glowRef.current = L.polyline(coords,{color:'#f5c518',weight:12,opacity:0.12,lineCap:'round',lineJoin:'round'}).addTo(map);
      lineRef.current = L.polyline(coords,{color:'#f5c518',weight:3,opacity:1,lineCap:'round',lineJoin:'round',dashArray:'12 7'}).addTo(map);
      onDone({distanceKm:route.distance/1000,durationMin:route.duration/60});
      map.flyToBounds(L.latLngBounds(coords),{padding:[70,70],duration:1.5});
    })
    .catch(()=>onDone(null))
    .finally(()=>onLoading(false));
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2
    + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── Overpass / Taxi POI helpers ───────────────────────────────────────────────
function getAmenityStyle(amenity: string): { emoji: string; color: string } {
  if (/hospital|clinic|health/.test(amenity))       return { emoji:'🏥', color:'#ff2d78' };
  if (/university|college|school|library/.test(amenity)) return { emoji:'🎓', color:'#00d4ff' };
  if (/restaurant|fast_food|cafe|food_court/.test(amenity)) return { emoji:'🍽', color:'#00f5d4' };
  if (/mosque|church|place_of_worship/.test(amenity)) return { emoji:'🕌', color:'#c77dff' };
  if (/fuel|gas_station/.test(amenity))             return { emoji:'⛽', color:'#f5c518' };
  if (/pharmacy|drugstore/.test(amenity))           return { emoji:'💊', color:'#00f5d4' };
  if (/police|fire_station/.test(amenity))          return { emoji:'🚔', color:'#00d4ff' };
  if (/bank|atm/.test(amenity))                     return { emoji:'🏦', color:'#f5c518' };
  if (/supermarket|marketplace|mall/.test(amenity)) return { emoji:'🛒', color:'#f5c518' };
  if (/hotel|lodging/.test(amenity))                return { emoji:'🏨', color:'#7b2ff7' };
  if (/cinema|theatre/.test(amenity))               return { emoji:'🎬', color:'#ff2d78' };
  return { emoji:'📍', color:'#00d4ff' };
}

function poiNeonHtml(emoji: string, label: string, color: string): string {
  const short = label.length > 18 ? label.slice(0, 18) + '…' : label;
  return `<div style="display:flex;flex-direction:column;align-items:center;cursor:pointer;filter:drop-shadow(0 0 7px ${color}80);">
    <div style="background:rgba(0,8,18,0.96);border:2px solid ${color};color:${color};font-family:'Rajdhani',sans-serif;font-size:10px;font-weight:700;padding:2px 7px;white-space:nowrap;max-width:150px;overflow:hidden;text-overflow:ellipsis;letter-spacing:0.03em;box-shadow:0 0 8px ${color}44;">${short}</div>
    <div style="width:2px;height:5px;background:${color};"></div>
    <div style="width:28px;height:28px;background:${color}18;border:2px solid ${color};border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 0 10px ${color}55;">${emoji}</div>
    <div style="width:2px;height:4px;background:linear-gradient(to bottom,${color},transparent);"></div>
  </div>`;
}

// ── Neon place-pin (Nominatim / POI selection) ────────────────────────────────
function placePinHtml(label: string): string {
  const short = label.length > 26 ? label.slice(0,26)+'…' : label;
  return `<div style="display:flex;flex-direction:column;align-items:center;filter:drop-shadow(0 0 10px rgba(0,212,255,0.8));">
    <div style="background:rgba(0,10,22,0.97);border:2px solid #00d4ff;color:#00d4ff;font-family:'Rajdhani',sans-serif;font-size:11px;font-weight:700;padding:3px 9px;white-space:nowrap;letter-spacing:0.04em;box-shadow:0 0 14px rgba(0,212,255,0.4);max-width:200px;overflow:hidden;text-overflow:ellipsis;">${short}</div>
    <div style="width:2px;height:9px;background:#00d4ff;"></div>
    <div style="width:14px;height:14px;background:#00d4ff;border-radius:50%;box-shadow:0 0 18px #00d4ff,0 0 8px #fff;"></div>
    <div style="width:2px;height:8px;background:linear-gradient(to bottom,#00d4ff88,transparent);"></div>
  </div>`;
}

function taxiPinHtml(color: string, label: string): string {
  return `<div style="position:relative;width:34px;height:42px;filter:drop-shadow(0 0 8px ${color}99);">
    <div style="width:30px;height:30px;background:${color}22;border:2.5px solid ${color};border-radius:50% 50% 50% 0;transform:rotate(-45deg);position:absolute;top:0;left:2px;"></div>
    <div style="position:absolute;top:7px;left:10px;color:${color};font-family:Orbitron,sans-serif;font-size:10px;font-weight:900;line-height:1;">${label}</div>
  </div>`;
}

// ── Component ─────────────────────────────────────────────────────────────────
export function ClinicMap({
  items, categories, activeFilter, onFilterChange,
  onSelectItem, selectedItem,
  userLocation, onUserLocationChange,
  routeTarget, onNavigate, onClearRoute,
  adminMode = false, onMapClick, onAdminDelete,
}: ClinicMapProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<L.Map|null>(null);
  const markersRef   = useRef<{[id:number]:L.Marker}>({});
  const userMarkerRef  = useRef<L.Marker|null>(null);
  const userCircleRef  = useRef<L.Circle|null>(null);
  const routeGlowRef   = useRef<L.Polyline|null>(null);
  const routeLineRef   = useRef<L.Polyline|null>(null);
  const catStyleRef    = useRef<HTMLStyleElement|null>(null);
  // User location tracking
  const watchIdRef     = useRef<number|null>(null);
  const headingRef     = useRef<number|null>(null);
  const [userHeading, setUserHeading] = useState<number|null>(null);
  const [isTracking,  setIsTracking]  = useState(false);

  // Stable refs for callbacks
  const onSelectRef          = useRef(onSelectItem);
  const onNavigateRef        = useRef(onNavigate);
  const userLocationRef      = useRef(userLocation);
  const onMapClickRef        = useRef(onMapClick);
  const onAdminDeleteRef     = useRef(onAdminDelete);
  const adminModeRef         = useRef(adminMode);
  const locateAndNavigateRef = useRef<((item:MapItem)=>void)|null>(null);
  const locateUserRef        = useRef<((afterLocate?:(loc:{lat:number;lng:number})=>void)=>void)|null>(null);
  // Live category map — accessed in buildPopup without closure issues
  const catMapRef = useRef<Map<string,Category>>(new Map());

  useEffect(()=>{onSelectRef.current=onSelectItem;},[onSelectItem]);
  useEffect(()=>{onNavigateRef.current=onNavigate;},[onNavigate]);
  useEffect(()=>{userLocationRef.current=userLocation;},[userLocation]);
  useEffect(()=>{onMapClickRef.current=onMapClick;},[onMapClick]);
  useEffect(()=>{onAdminDeleteRef.current=onAdminDelete;},[onAdminDelete]);
  useEffect(()=>{
    adminModeRef.current=adminMode;
    if (mapRef.current) mapRef.current.getContainer().style.cursor = adminMode ? 'crosshair' : '';
  },[adminMode]);

  // Keep catMap in sync
  useEffect(()=>{
    catMapRef.current = new Map(categories.map(c=>[c.slug,c]));
  },[categories]);

  // Helper: show the "active trip" block message briefly
  const showBlockTaxiMsg = useCallback(()=>{
    if (blockTaxiTimerRef.current) clearTimeout(blockTaxiTimerRef.current);
    setBlockTaxiMsg(true);
    blockTaxiTimerRef.current = setTimeout(()=> setBlockTaxiMsg(false), 4000);
  },[]);

  // Bridge: Leaflet popup button → open taxi routing flow
  useEffect(()=>{
    setTaxiItemRef.current = (item: MapItem) => {
      // Block if customer already has an active trip
      const ACTIVE = new Set(['pending','accepted','driving']);
      if (activeOrderIdRef.current !== null && ACTIVE.has(activeOrderStatusRef.current)) {
        showBlockTaxiMsg();
        return;
      }
      taxiRouteLineRef.current?.remove();  taxiRouteLineRef.current  = null;
      taxiGlowLineRef.current?.remove();   taxiGlowLineRef.current   = null;
      taxiFromMarkerRef.current?.remove(); taxiFromMarkerRef.current = null;
      taxiToMarkerRef.current?.remove();   taxiToMarkerRef.current   = null;
      try {
        const saved = JSON.parse(localStorage.getItem('diyala_user') ?? 'null');
        setTaxiUserName(saved?.name  ?? '');
        setTaxiUserPhone(saved?.phone ?? '');
      } catch { setTaxiUserName(''); setTaxiUserPhone(''); }
      setShowTaxiPrompt(false);
      setTaxiDriverItem(item); setTaxiStep('pick-from');
      setTaxiFromPt(null); setTaxiToPt(null);
      setTaxiDistKm(null); setTaxiEstPrice(null);
      setTaxiError(null);   setTaxiSuccess(false);
      setTaxiDestName('');   setTaxiFromPlaced(false);
      taxiStepRef.current   = 'pick-from';
      taxiFromPtRef.current = null;
      // No crosshair — main interaction is dragging the auto-placed A marker

      // ── Helper: place draggable A marker and update from-point refs ───────
      const autoPlaceFromMarker = (lat: number, lng: number) => {
        if (!mapRef.current || taxiStepRef.current !== 'pick-from') return;
        taxiFromMarkerRef.current?.remove();
        const m = L.marker([lat, lng], {
          icon: L.divIcon({className:'', html:taxiPinHtml('#00f5d4','A'), iconSize:[34,42], iconAnchor:[17,42]}),
          zIndexOffset: 1000,
          draggable: true,
        }).addTo(mapRef.current);
        m.on('dragend', ()=>{
          const pos = m.getLatLng();
          const pt  = { lat: pos.lat, lng: pos.lng };
          setTaxiFromPt(pt);
          taxiFromPtRef.current = pt;
        });
        taxiFromMarkerRef.current = m;
        const pt = { lat, lng };
        setTaxiFromPt(pt);
        taxiFromPtRef.current = pt;
        setTaxiFromPlaced(true);
        mapRef.current.flyTo([lat, lng], 18, { animate:true, duration:1.0 });
      };

      // ── Fly camera + auto-place A at GPS (or wait for first fix) ─────────
      const loc = userLocationRef.current;
      if (loc) {
        autoPlaceFromMarker(loc.lat, loc.lng);
      } else {
        // GPS not acquired yet — start locating; auto-place on first fix
        locateUserRef.current?.((newLoc)=> autoPlaceFromMarker(newLoc.lat, newLoc.lng));
      }
    };
  },[]);

  // Bridge: map click → pick routing point (runs every render — refs always fresh)
  useEffect(()=>{
    taxiPickPointRef.current = (lat: number, lng: number) => {
      const step   = taxiStepRef.current;
      const fromPt = taxiFromPtRef.current;
      if (step === 'idle') return;
      if (step === 'pick-from') {
        // Re-place draggable A marker at tapped location (user can also drag)
        taxiFromMarkerRef.current?.remove();
        const m = L.marker([lat,lng],{
          icon: L.divIcon({className:'',html:taxiPinHtml('#00f5d4','A'),iconSize:[34,42],iconAnchor:[17,42]}),
          zIndexOffset:1000,
          draggable:true,
        }).addTo(mapRef.current!);
        m.on('dragend',()=>{
          const pos = m.getLatLng();
          const pt2 = {lat:pos.lat,lng:pos.lng};
          setTaxiFromPt(pt2);
          taxiFromPtRef.current=pt2;
        });
        taxiFromMarkerRef.current = m;
        const pt={lat,lng};
        setTaxiFromPt(pt);
        taxiFromPtRef.current=pt;
        setTaxiFromPlaced(true);
        // Stay on pick-from — user must press confirm button to advance
      } else if (step === 'pick-to' && fromPt) {
        // Place B marker immediately so user gets instant feedback
        taxiToMarkerRef.current?.remove();
        taxiToMarkerRef.current = L.marker([lat,lng],{
          icon: L.divIcon({className:'',html:taxiPinHtml('#ff2d78','B'),iconSize:[34,42],iconAnchor:[17,42]}),
          zIndexOffset:1000,
        }).addTo(mapRef.current!);
        taxiGlowLineRef.current?.remove();
        taxiRouteLineRef.current?.remove();

        setTaxiToPt({lat,lng});
        setTaxiDistKm(null);
        setTaxiEstPrice(null);
        setTaxiStep('confirm');
        taxiStepRef.current='confirm';
        if (mapRef.current) mapRef.current.getContainer().style.cursor='';
        setTaxiRouteLoading(true);

        // ── Fetch real road route from OSRM (with retry) ─────────────────────
        const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${fromPt.lng},${fromPt.lat};${lng},${lat}?overview=full&geometries=geojson`;

        const drawOsrmRoute = async (attempt = 1): Promise<void> => {
          const ctrl = new AbortController();
          const tId  = setTimeout(()=>ctrl.abort(), 9000);
          try {
            const r    = await fetch(osrmUrl, { signal: ctrl.signal });
            clearTimeout(tId);
            const data = await r.json();
            const route = data.routes?.[0];
            if (!route || !mapRef.current) return;
            const coords:[number,number][] = route.geometry.coordinates.map(
              ([lo,la]:[number,number]) => [la,lo]
            );
            taxiGlowLineRef.current?.remove();
            taxiRouteLineRef.current?.remove();
            taxiGlowLineRef.current  = L.polyline(coords,{color:'#7b2ff7',weight:14,opacity:0.18,lineCap:'round',lineJoin:'round'}).addTo(mapRef.current);
            taxiRouteLineRef.current = L.polyline(coords,{color:'#7b2ff7',weight:3.5,opacity:1,lineCap:'round',lineJoin:'round',dashArray:'10 6'}).addTo(mapRef.current);
            const distKm = route.distance / 1000;
            setTaxiDistKm(distKm);
            setTaxiEstPrice(Math.round(distKm * 750));
            mapRef.current.fitBounds(L.latLngBounds(coords),{padding:[70,70]});
          } catch {
            clearTimeout(tId);
            if (attempt < 2) {
              // Retry once after short delay
              await new Promise(r=>setTimeout(r,1500));
              return drawOsrmRoute(2);
            }
            // Both attempts failed — show error, reset to pick-to so user can retry
            setTaxiError('تعذّر حساب مسار الشوارع — حاول تحديد نقطة الوصول مجدداً');
            taxiToMarkerRef.current?.remove();
            taxiToMarkerRef.current = null;
            setTaxiStep('pick-to');
            taxiStepRef.current = 'pick-to';
            if (mapRef.current) mapRef.current.getContainer().style.cursor = 'crosshair';
          } finally {
            setTaxiRouteLoading(false);
          }
        };
        drawOsrmRoute();
      }
    };
  });

  // Inject per-category popup CSS whenever categories change
  useEffect(()=>{
    if (!catStyleRef.current) {
      catStyleRef.current = document.createElement('style');
      document.head.appendChild(catStyleRef.current);
    }
    catStyleRef.current.textContent = categories.map(cat=>`
      .cat-${cat.slug} .leaflet-popup-content-wrapper{border:1px solid ${cat.color}!important;box-shadow:0 0 20px ${cat.color}44!important;}
    `).join('') + `
      .cat-fallback .leaflet-popup-content-wrapper{border:1px solid #7b2ff7!important;box-shadow:0 0 20px #7b2ff744!important;}
    `;
  },[categories]);

  const [locating,setLocating]         = useState(false);
  const [locateError,setLocateError]   = useState<string|null>(null);
  const [routeLoading,setRouteLoading] = useState(false);
  const [routeInfo,setRouteInfo]       = useState<{distanceKm:number;durationMin:number}|null>(null);
  const [showMoreModal,  setShowMoreModal]  = useState(false);
  const [searchQuery,    setSearchQuery]    = useState('');
  const [showTraffic,    setShowTraffic]    = useState(false);
  const [showTaxiPrompt, setShowTaxiPrompt] = useState(false);

  // ── Place search (Nominatim OSM) ─────────────────────────────────────────────
  type NominatimResult = { place_id: number; display_name: string; lat: string; lon: string };
  const [placeResults,       setPlaceResults]       = useState<NominatimResult[]>([]);
  const [placeSearchLoading, setPlaceSearchLoading] = useState(false);
  const [selectedPlace,      setSelectedPlace]      = useState<{name:string;lat:number;lng:number;addr?:string}|null>(null);
  const [placeRouteInfo,     setPlaceRouteInfo]     = useState<{distanceKm:number;durationMin:number}|null>(null);
  const [placeRouteLoading,  setPlaceRouteLoading]  = useState(false);
  const placeGlowRef = useRef<L.Polyline|null>(null);
  const placeLineRef = useRef<L.Polyline|null>(null);
  const placePinRef  = useRef<L.Marker|null>(null);

  // ── Bottom-bar helpers: detect taxi / gas categories dynamically ───────────
  const isTaxiCat = (slug: string, labelEn: string) =>
    slug === 'taxi' || slug === 'تكسي' || labelEn.toLowerCase().includes('taxi');
  const isGasCat  = (slug: string, labelEn: string) =>
    slug === 'gas_station' || slug === 'gas' || slug === 'غاز' || labelEn.toLowerCase().includes('gas');

  const taxiCategory    = useMemo(()=> categories.find(c => isTaxiCat(c.slug, c.labelEn)), [categories]);
  const gasCategory     = useMemo(()=> categories.find(c => isGasCat(c.slug,  c.labelEn)), [categories]);
  const displayCategories = useMemo(
    ()=> categories.filter(c => !isTaxiCat(c.slug, c.labelEn) && !isGasCat(c.slug, c.labelEn)),
    [categories]
  );

  // ── Taxi routing state (multi-step: pick-from → pick-to → confirm) ──────────
  type TaxiStep = 'idle' | 'pick-from' | 'pick-to' | 'confirm';
  const [taxiDriverItem, setTaxiDriverItem] = useState<MapItem|null>(null);
  const [taxiStep,       setTaxiStep]       = useState<TaxiStep>('idle');
  const [taxiFromPt,     setTaxiFromPt]     = useState<{lat:number;lng:number}|null>(null);
  const [taxiToPt,       setTaxiToPt]       = useState<{lat:number;lng:number}|null>(null);
  const [taxiDistKm,     setTaxiDistKm]     = useState<number|null>(null);
  const [taxiEstPrice,   setTaxiEstPrice]   = useState<number|null>(null);
  const [taxiUserName,   setTaxiUserName]   = useState('');
  const [taxiUserPhone,  setTaxiUserPhone]  = useState('');
  const [taxiLoading,      setTaxiLoading]      = useState(false);
  const [taxiRouteLoading, setTaxiRouteLoading] = useState(false); // OSRM fetch in progress
  const [taxiError,        setTaxiError]        = useState<string|null>(null);
  const [taxiSuccess,      setTaxiSuccess]      = useState(false);
  const [taxiDestName,     setTaxiDestName]     = useState('');   // POI name chosen as dest
  const [poiLoading,       setPoiLoading]       = useState(false);
  const poiMarkersRef = useRef<L.Marker[]>([]);

  // ── Active order tracking (after submit) ─────────────────────────────────
  const [activeOrderId,     setActiveOrderId]     = useState<number|null>(null);
  const [activeOrderStatus, setActiveOrderStatus] = useState<string>('pending');
  const [activeDriverPhone, setActiveDriverPhone] = useState<string>('');
  const [activeDriverId,    setActiveDriverId]    = useState<number>(0);
  const [driverLat,         setDriverLat]         = useState<number|null>(null);
  const [driverLng,         setDriverLng]         = useState<number|null>(null);
  const [driverDistKm,      setDriverDistKm]      = useState<number|null>(null);
  const [driverEtaMin,      setDriverEtaMin]      = useState<number|null>(null);
  const [showChat,          setShowChat]          = useState(false);
  // Snackbar shown when a system message arrives while chat is closed
  const [sysMsgSnack,       setSysMsgSnack]       = useState<string|null>(null);
  const sysMsgTimerRef      = useRef<ReturnType<typeof setTimeout>|null>(null);

  // ── Rating dialog (auto-opens when ride finishes) ─────────────────────────
  const [showRating,        setShowRating]        = useState(false);
  const [ratingOrderId,     setRatingOrderId]     = useState<number>(0);
  const [ratingDriverId,    setRatingDriverId]    = useState<number>(0);
  const [ratingCustomerName,setRatingCustomerName]= useState<string>('');
  const ratingShownRef      = useRef<Set<number>>(new Set()); // prevent double-trigger

  const activeOrderIdRef    = useRef<number|null>(null);
  const activeOrderStatusRef= useRef<string>('pending');            // mirrors activeOrderStatus for DOM handlers
  const seenSnackIdsRef     = useRef<Set<string|number>>(new Set()); // system msgs already snackbar'd
  // Brief "can't order — active trip" notification
  const [blockTaxiMsg,      setBlockTaxiMsg]      = useState(false);
  const blockTaxiTimerRef   = useRef<ReturnType<typeof setTimeout>|null>(null);
  // true while A-marker is placed and awaiting user drag/confirm in pick-from step
  const [taxiFromPlaced,    setTaxiFromPlaced]    = useState(false);
  // Auto-find nearest driver states
  const [taxiAutoSearching, setTaxiAutoSearching] = useState(false);
  const [taxiNoDriverSnack, setTaxiNoDriverSnack] = useState(false);
  const [taxiFoundSnack,    setTaxiFoundSnack]    = useState<string|null>(null); // driver name when found
  const prevDriverPosRef    = useRef<{lat:number;lng:number}|null>(null);

  // ── Online drivers (all open taxis visible on map) ────────────────────────
  type OnlineDriver = { id:number; locationId:number; driverName:string; phone:string; lat:number; lng:number; isOnline:boolean };
  const onlineDriverMarkersRef = useRef<Map<number, L.Marker>>(new Map());

  // Leaflet object refs for taxi routing visuals
  const taxiRouteLineRef  = useRef<L.Polyline|null>(null);
  const taxiGlowLineRef   = useRef<L.Polyline|null>(null);
  const taxiFromMarkerRef = useRef<L.Marker|null>(null);
  const taxiToMarkerRef   = useRef<L.Marker|null>(null);
  const driverMarkerRef   = useRef<L.Marker|null>(null);
  // Bridge refs — stable handles for Leaflet DOM callbacks & map click
  const setTaxiItemRef    = useRef<((item:MapItem)=>void)|null>(null);
  const taxiPickPointRef  = useRef<((lat:number,lng:number)=>void)|null>(null);
  const taxiStepRef       = useRef<TaxiStep>('idle');
  const taxiFromPtRef     = useRef<{lat:number;lng:number}|null>(null);

  const pendingJumpRef   = useRef<number|null>(null);
  const trafficLayersRef = useRef<L.Polyline[]>([]);
  const missionMarkerRef = useRef<L.Marker|null>(null);

  const clearRouteVisuals = useCallback(()=>{
    routeGlowRef.current?.remove(); routeGlowRef.current=null;
    routeLineRef.current?.remove(); routeLineRef.current=null;
    setRouteInfo(null);
  },[]);

  // Jump to item from search: close modal → switch filter → flyTo → open popup
  const jumpToItem = useCallback((item: MapItem)=>{
    setShowMoreModal(false);
    setSearchQuery('');
    pendingJumpRef.current = item.id;
    onFilterChange(item.kind);
    mapRef.current?.flyTo([item.lat, item.lng], 16, {animate:true, duration:1.1});
  },[onFilterChange]);

  // Search across all visible items
  const searchResults = useMemo(()=>{
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [] as MapItem[];
    return items
      .filter(i => i.status !== 'معطّل')
      .filter(i =>
        i.name.toLowerCase().includes(q) ||
        (i.address ?? '').toLowerCase().includes(q) ||
        ((i as any).details ?? '').toLowerCase().includes(q) ||
        (catMapRef.current.get(i.kind)?.labelAr ?? '').toLowerCase().includes(q)
      )
      .slice(0, 10);
  },[searchQuery, items]);

  // ── Nominatim debounced search ─────────────────────────────────────────────
  useEffect(()=>{
    const q = searchQuery.trim();
    if (q.length < 2) { setPlaceResults([]); return; }
    setPlaceSearchLoading(true);
    const t = setTimeout(async ()=>{
      try {
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q+' ديالى')}&countrycodes=iq&format=json&limit=6&addressdetails=0`;
        const r = await fetch(url, { headers:{'Accept-Language':'ar,en'} });
        const data = await r.json();
        setPlaceResults(Array.isArray(data) ? data : []);
      } catch { setPlaceResults([]); }
      finally  { setPlaceSearchLoading(false); }
    }, 650);
    return ()=>{ clearTimeout(t); };
  },[searchQuery]);

  // ── Select a Nominatim place: fly + neon pin + reset route ─────────────────
  const selectPlace = useCallback((name: string, lat: number, lng: number, addr?: string)=>{
    setShowMoreModal(false);
    setSearchQuery('');
    setPlaceResults([]);
    setSelectedPlace({ name, lat, lng, addr });
    setPlaceRouteInfo(null);
    placeGlowRef.current?.remove(); placeGlowRef.current = null;
    placeLineRef.current?.remove(); placeLineRef.current = null;
    placePinRef.current?.remove();
    if (mapRef.current) {
      placePinRef.current = L.marker([lat, lng],{
        icon: L.divIcon({ className:'', html: placePinHtml(name), iconSize:[36,56], iconAnchor:[18,56] }),
        zIndexOffset: 600,
      }).addTo(mapRef.current);
      mapRef.current.flyTo([lat, lng], 15, { animate:true, duration:1.3 });
    }
  },[]);

  // ── Clear selected place & visuals ──────────────────────────────────────────
  const clearSelectedPlace = useCallback(()=>{
    setSelectedPlace(null);
    setPlaceRouteInfo(null);
    placeGlowRef.current?.remove(); placeGlowRef.current = null;
    placeLineRef.current?.remove(); placeLineRef.current = null;
    placePinRef.current?.remove();  placePinRef.current  = null;
  },[]);

  // ── Draw OSRM route to selected place ──────────────────────────────────────
  const goToPlace = useCallback(()=>{
    if (!selectedPlace || !mapRef.current) return;
    if (!userLocation) return; // GPS button must be active first
    const { lat, lng } = selectedPlace;
    const map = mapRef.current;
    setPlaceRouteLoading(true);
    placeGlowRef.current?.remove(); placeGlowRef.current = null;
    placeLineRef.current?.remove(); placeLineRef.current = null;
    setPlaceRouteInfo(null);
    fetch(`https://router.project-osrm.org/route/v1/driving/${userLocation.lng},${userLocation.lat};${lng},${lat}?overview=full&geometries=geojson`)
      .then(r=>r.json())
      .then(data=>{
        const route = data.routes?.[0];
        if (!route) return;
        const coords:[number,number][] = route.geometry.coordinates.map(([ln,la]:[number,number])=>[la,ln]);
        placeGlowRef.current = L.polyline(coords,{color:'#00d4ff',weight:14,opacity:0.12,lineCap:'round',lineJoin:'round'}).addTo(map);
        placeLineRef.current = L.polyline(coords,{color:'#00d4ff',weight:3.5,opacity:1,lineCap:'round',lineJoin:'round',dashArray:'10 6'}).addTo(map);
        setPlaceRouteInfo({ distanceKm:route.distance/1000, durationMin:route.duration/60 });
        map.flyToBounds(L.latLngBounds(coords),{padding:[70,100],duration:1.5});
      })
      .catch(()=>{})
      .finally(()=>setPlaceRouteLoading(false));
  },[selectedPlace, userLocation]);

  // Escape key closes the modal
  useEffect(()=>{
    if (!showMoreModal) return;
    const fn = (e: KeyboardEvent) => { if (e.key==='Escape') setShowMoreModal(false); };
    document.addEventListener('keydown', fn);
    return ()=> document.removeEventListener('keydown', fn);
  },[showMoreModal]);

  // Update user marker icon (position + heading) without re-mounting
  const refreshUserMarker = useCallback((lat:number, lng:number, heading:number|null, accuracy:number)=>{
    if (!mapRef.current) return;
    const icon = createUserArrowIcon(heading);
    if (userMarkerRef.current) {
      userMarkerRef.current.setLatLng([lat,lng]);
      userMarkerRef.current.setIcon(icon);
    } else {
      userMarkerRef.current = L.marker([lat,lng],{icon,zIndexOffset:1000}).addTo(mapRef.current);
    }
    if (userCircleRef.current) {
      (userCircleRef.current as any).setLatLng([lat,lng]);
      (userCircleRef.current as any).setRadius(accuracy);
    } else {
      userCircleRef.current = L.circle([lat,lng],{
        radius:accuracy,color:'#00f5d4',fillColor:'#00f5d4',
        fillOpacity:0.06,weight:1,dashArray:'5 5',
      }).addTo(mapRef.current);
    }
  },[]);

  const locateUser = useCallback((afterLocate?:(loc:{lat:number;lng:number})=>void)=>{
    if (!navigator.geolocation){setLocateError('الجهاز لا يدعم تحديد الموقع');return;}
    // Stop any existing watch
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setLocating(true); setLocateError(null);
    let firstFix = true;

    watchIdRef.current = navigator.geolocation.watchPosition(
      ({coords:{latitude:lat,longitude:lng,accuracy,heading:geoHeading}})=>{
        setLocating(false);
        setIsTracking(true);
        const loc = {lat,lng};
        onUserLocationChange(loc); userLocationRef.current = loc;

        // Prefer GPS heading when available (only non-null when moving)
        const h = (geoHeading !== null && !isNaN(geoHeading)) ? geoHeading : headingRef.current;
        headingRef.current = h;
        setUserHeading(h);
        refreshUserMarker(lat, lng, h, accuracy);

        if (firstFix) {
          firstFix = false;
          if (!afterLocate) mapRef.current?.flyTo([lat,lng],16,{animate:true,duration:1.5});
          afterLocate?.(loc);
        }
      },
      (err)=>{
        setLocating(false);
        setIsTracking(false);
        if (err.code===1)      setLocateError('تم رفض صلاحية الموقع');
        else if (err.code===2) setLocateError('تعذّر تحديد الموقع');
        else                   setLocateError('انتهت مهلة تحديد الموقع');
      },
      {enableHighAccuracy:true,timeout:20000,maximumAge:0}
    );
  },[onUserLocationChange, refreshUserMarker]);

  // Keep locateUserRef current so closures captured with [] deps can call it
  useEffect(()=>{ locateUserRef.current = locateUser; },[locateUser]);

  // DeviceOrientation compass (mobile) — updates heading ref + marker
  useEffect(()=>{
    function handleOrientation(e: DeviceOrientationEvent) {
      const alpha = (e as any).webkitCompassHeading ?? e.alpha;
      if (alpha === null || alpha === undefined) return;
      // webkitCompassHeading is 0=North; e.alpha is 0=North going clockwise on iOS
      // We subtract from 360 for standard map bearing
      const bearing = (e as any).webkitCompassHeading !== undefined
        ? (e as any).webkitCompassHeading
        : (360 - (alpha ?? 0)) % 360;
      headingRef.current = bearing;
      setUserHeading(bearing);
      // Only update marker if we're tracking
      if (userMarkerRef.current && userLocationRef.current) {
        userMarkerRef.current.setIcon(createUserArrowIcon(bearing));
      }
    }
    // Request permission on iOS 13+
    if (typeof (DeviceOrientationEvent as any).requestPermission === 'function') {
      (DeviceOrientationEvent as any).requestPermission()
        .then((s:string)=>{ if(s==='granted') window.addEventListener('deviceorientation',handleOrientation,true); })
        .catch(()=>{});
    } else {
      window.addEventListener('deviceorientation', handleOrientation, true);
    }
    return ()=>{ window.removeEventListener('deviceorientation', handleOrientation, true); };
  },[]);

  // Cleanup watchPosition on unmount
  useEffect(()=>{
    return ()=>{
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
    };
  },[]);

  useEffect(()=>{
    locateAndNavigateRef.current=(item:MapItem)=>{
      clearRouteVisuals();
      const loc=userLocationRef.current;
      if (loc) {
        onNavigateRef.current(item);
      } else {
        locateUser((newLoc)=>{
          if (mapRef.current) drawRoute(mapRef.current,newLoc,item,setRouteInfo,setRouteLoading,routeGlowRef,routeLineRef);
          onNavigateRef.current(item);
        });
      }
    };
  },[locateUser,clearRouteVisuals]);

  // Init map once
  useEffect(()=>{
    if (!mapContainer.current||mapRef.current) return;
    const style=document.createElement('style');
    style.textContent=`
      @keyframes lf-ping{75%,100%{transform:scale(2.5);opacity:0;}}
      @keyframes lf-spin{to{transform:rotate(360deg);}}
      @keyframes mission-pulse{0%,100%{transform:scale(1);opacity:1;}50%{transform:scale(1.15);opacity:0.8;}}
      @keyframes traffic-flow{0%{stroke-dashoffset:30;}100%{stroke-dashoffset:0;}}
      .leaflet-container{background:#0a0d14!important;font-family:'Rajdhani',sans-serif;}
      .leaflet-tile-pane{filter:brightness(0.9);}
      .leaflet-control-zoom a{background:#0d1117!important;color:#00f5d4!important;border-color:#00f5d4!important;font-family:'Orbitron',sans-serif;}
      .leaflet-control-zoom a:hover{background:#00f5d422!important;}
      .leaflet-control-attribution{background:rgba(0,0,0,0.7)!important;color:#00f5d488!important;font-size:10px;}
      .leaflet-control-attribution a{color:#00f5d4!important;}
      .map-popup .leaflet-popup-content-wrapper{background:rgba(5,8,15,0.97)!important;border-radius:2px!important;padding:0!important;min-width:220px;}
      .map-popup .leaflet-popup-content{margin:0!important;width:auto!important;}
      .map-popup .leaflet-popup-tip-container{display:none;}
      .map-popup .leaflet-popup-close-button{color:#aaa!important;font-size:18px!important;top:6px!important;right:8px!important;}
      .mission-popup .leaflet-popup-content-wrapper{background:rgba(5,8,15,0.97)!important;border:1px solid #f5c518!important;box-shadow:0 0 32px #f5c51844,0 0 64px #f5c51822!important;border-radius:2px!important;padding:0!important;}
      .mission-popup .leaflet-popup-tip{background:#f5c518!important;}
      .mission-popup .leaflet-popup-tip-container{display:block;}
      .popup-nav-btn{width:100%;padding:9px 0;margin-top:10px;background:rgba(245,197,24,0.1);border:1px solid #f5c518;color:#f5c518;font-family:'Orbitron',monospace;font-size:11px;letter-spacing:0.08em;cursor:pointer;transition:all 0.2s;display:flex;align-items:center;justify-content:center;gap:7px;}
      .popup-nav-btn:hover{background:rgba(245,197,24,0.22);box-shadow:0 0 18px rgba(245,197,24,0.45);}
      .popup-details-btn{width:100%;padding:7px 0;border:none;background:transparent;color:#aaa;font-family:'Rajdhani',sans-serif;font-size:12px;letter-spacing:0.06em;cursor:pointer;transition:all 0.2s;border-top:1px solid rgba(255,255,255,0.06);margin-top:4px;}
      .popup-details-btn:hover{color:#fff;}
      .popup-delete-btn{width:100%;padding:8px 0;border:1px solid rgba(255,45,120,0.4);background:transparent;color:#ff2d78;font-family:'Rajdhani',sans-serif;font-size:12px;letter-spacing:0.06em;cursor:pointer;transition:all 0.25s;display:flex;align-items:center;justify-content:center;gap:7px;border-radius:2px;}
      .popup-delete-btn:hover{background:rgba(255,45,120,0.12);border-color:#ff2d78;}
      .popup-taxi-btn{width:100%;padding:10px 0;margin-top:8px;background:rgba(0,212,255,0.10);border:1px solid #00d4ff;color:#00d4ff;font-family:'Orbitron',sans-serif;font-size:10px;letter-spacing:0.1em;cursor:pointer;transition:all 0.2s;display:flex;align-items:center;justify-content:center;gap:8px;border-radius:2px;}
      .popup-taxi-btn:hover{background:rgba(0,212,255,0.22);box-shadow:0 0 18px rgba(0,212,255,0.45);}
      .filter-tabs-bar::-webkit-scrollbar{display:none;}
    `;
    document.head.appendChild(style);
    mapRef.current=L.map(mapContainer.current,{center:[33.7451,44.6488],zoom:13,zoomControl:true});
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',{
      attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains:'abcd',maxZoom:20,
    }).addTo(mapRef.current);
    mapRef.current.on('click',(e:L.LeafletMouseEvent)=>{
      if (adminModeRef.current) { onMapClickRef.current?.({lat:e.latlng.lat,lng:e.latlng.lng}); return; }
      taxiPickPointRef.current?.(e.latlng.lat, e.latlng.lng);
    });

    // ── Mission marker — golden pulsing diamond at city centre ───────────────
    const missionIcon = L.divIcon({
      className:'',
      html:`<div style="width:54px;height:54px;position:relative;display:flex;align-items:center;justify-content:center;cursor:pointer;">
        <div style="position:absolute;inset:-4px;border-radius:50%;background:#f5c518;opacity:0.10;animation:lf-ping 1.8s cubic-bezier(0,0,0.2,1) infinite;"></div>
        <div style="position:absolute;inset:-10px;border-radius:50%;background:#f5c518;opacity:0.05;animation:lf-ping 1.8s cubic-bezier(0,0,0.2,1) infinite;animation-delay:0.5s;"></div>
        <div style="animation:mission-pulse 2s ease-in-out infinite;">
          <svg width="46" height="46" viewBox="0 0 46 46" fill="none">
            <polygon points="23,2 43,23 23,44 3,23" fill="#f5c51818" stroke="#f5c518" stroke-width="2"/>
            <polygon points="23,10 36,23 23,36 10,23" fill="#f5c518" opacity="0.85"/>
            <text x="23" y="28" text-anchor="middle" font-size="13" fill="#0a0d14" font-weight="900" font-family="Arial">★</text>
          </svg>
        </div>
      </div>`,
      iconSize:[54,54], iconAnchor:[27,27],
    });
    const missionEl = document.createElement('div');
    missionEl.style.cssText='padding:18px 16px 14px;text-align:center;direction:rtl;min-width:230px;';
    missionEl.innerHTML=`
      <div style="font-family:Orbitron,sans-serif;font-size:9px;color:#f5c518;letter-spacing:0.18em;margin-bottom:10px;text-shadow:0 0 12px #f5c518;">⭐ DAILY MISSION ⭐</div>
      <div style="font-family:Rajdhani,sans-serif;font-size:20px;font-weight:800;color:#fff;margin-bottom:6px;text-shadow:0 0 18px #f5c51877;">استلم جائزتك الآن</div>
      <div style="font-family:Rajdhani,sans-serif;font-size:13px;color:rgba(255,255,255,0.45);margin-bottom:14px;line-height:1.5;">توجّه إلى نقطة الجائزة واضغط للاستلام<br/>المكافأة: خصم 30% على أقرب مطعم</div>
      <div style="display:flex;gap:8px;align-items:center;justify-content:center;margin-bottom:2px;">
        <div style="width:6px;height:6px;border-radius:50%;background:#00f5d4;box-shadow:0 0 8px #00f5d4;animation:lf-ping 2s ease infinite;"></div>
        <span style="font-family:Orbitron,sans-serif;font-size:9px;color:#00f5d4;letter-spacing:0.1em;">ACTIVE</span>
      </div>
    `;
    const closeBtn=document.createElement('button');
    closeBtn.textContent='✕  إغلاق المهمة';
    closeBtn.style.cssText='width:100%;padding:10px;margin-top:10px;background:rgba(245,197,24,0.08);border:1px solid #f5c51855;color:#f5c518;font-family:Orbitron,sans-serif;font-size:9px;letter-spacing:0.12em;cursor:pointer;transition:all 0.2s;';
    closeBtn.onmouseover=()=>{closeBtn.style.background='rgba(245,197,24,0.18)';closeBtn.style.boxShadow='0 0 14px #f5c51844';};
    closeBtn.onmouseout=()=>{closeBtn.style.background='rgba(245,197,24,0.08)';closeBtn.style.boxShadow='none';};
    closeBtn.onclick=()=>{ mapRef.current?.closePopup(); };
    missionEl.appendChild(closeBtn);

    missionMarkerRef.current = L.marker([33.7451,44.6488],{icon:missionIcon,zIndexOffset:2000})
      .addTo(mapRef.current)
      .bindPopup(L.popup({className:'map-popup mission-popup',closeButton:false,autoPan:true,offset:[0,-10]}).setContent(missionEl));

    return ()=>{
      missionMarkerRef.current?.remove(); missionMarkerRef.current=null;
      trafficLayersRef.current.forEach(l=>l.remove()); trafficLayersRef.current=[];
      mapRef.current?.remove(); mapRef.current=null;
      style.remove();
      catStyleRef.current?.remove(); catStyleRef.current=null;
    };
  },[]);

  // Build popup DOM — reads catMapRef so no stale closure
  const buildPopup = useCallback((item: MapItem)=>{
    const cat   = catMapRef.current.get(item.kind);
    const base  = cat?.color ?? FALLBACK_COLORS[item.kind]?.open ?? '#7b2ff7';
    const color = item.status==='مفتوح' ? base : '#ff2d78';
    const emoji = cat?.icon ?? '📍';
    const labelEn = cat?.labelEn?.toUpperCase() ?? item.kind.toUpperCase().replace(/_/g,' ');

    const isOpen = item.status === 'مفتوح';
    const statusLabel = isOpen ? 'مفتوح الآن' : 'مغلق حالياً';
    const statusIcon  = isOpen ? '✓' : '✕';

    const sub = (item as any).details
      || (item.kind==='clinic'
          ? [(item as any).doctor,(item as any).specialty].filter(Boolean).join(' — ')
          : item.kind==='restaurant'
          ? [(item as any).cuisine,(item as any).type].filter(Boolean).join(' · ')
          : '');

    const stars = typeof (item as any).rating === 'number' && (item as any).rating > 0
      ? `<div style="color:#f5c518;font-size:13px;margin-bottom:4px;letter-spacing:1px">${'★'.repeat((item as any).rating)}${'☆'.repeat(5-(item as any).rating)}</div>` : '';

    const el=document.createElement('div');
    el.style.cssText='padding:14px 16px 12px;direction:rtl;min-width:215px;';
    el.innerHTML=`
      <div style="font-family:Orbitron,sans-serif;font-size:9px;color:${color}88;letter-spacing:0.12em;margin-bottom:5px;">${emoji} ${labelEn} · ID:${item.id.toString().padStart(4,'0')}</div>
      <div style="font-family:Rajdhani,sans-serif;font-size:17px;font-weight:700;color:#e8f8f5;line-height:1.2;margin-bottom:7px;">${item.name}</div>
      ${stars}
      <div style="display:inline-flex;align-items:center;gap:7px;padding:5px 11px;border-radius:3px;border:1px solid ${color}55;background:${color}12;margin-bottom:6px;">
        <div style="width:8px;height:8px;border-radius:50%;background:${color};box-shadow:0 0 8px ${color};flex-shrink:0;${isOpen?'animation:lf-ping 2s cubic-bezier(0,0,0.2,1) infinite':''}"></div>
        <span style="font-family:Rajdhani,sans-serif;font-size:14px;font-weight:700;color:${color};letter-spacing:0.04em;">${statusIcon} ${statusLabel}</span>
      </div>
      ${sub ? `<div style="font-family:Rajdhani,sans-serif;font-size:12px;color:#ffffff55;margin-bottom:2px;">${sub}</div>` : ''}
    `;

    const navBtn=document.createElement('button');
    navBtn.className='popup-nav-btn';
    navBtn.innerHTML=`<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M3 11l19-9-9 19-2-8-8-2z" fill="#f5c518"/></svg>الذهاب إليه`;
    navBtn.addEventListener('click',()=>{locateAndNavigateRef.current?.(item);mapRef.current?.closePopup();});

    const detailsBtn=document.createElement('button');
    detailsBtn.className='popup-details-btn';
    detailsBtn.textContent='عرض التفاصيل ←';
    detailsBtn.addEventListener('click',()=>{onSelectRef.current(item);mapRef.current?.closePopup();});

    el.appendChild(navBtn);
    el.appendChild(detailsBtn);

    // ── Taxi request button (only for taxi/transport category) ────────────────
    const isTaxi = item.kind==='taxi' || item.kind==='تكسي'
      || (catMapRef.current.get(item.kind)?.labelEn ?? '').toLowerCase().includes('taxi')
      || (catMapRef.current.get(item.kind)?.labelAr ?? '').includes('تكسي');
    if (isTaxi && item.status !== 'معطّل') {
      const taxiSep = document.createElement('div');
      taxiSep.style.cssText='height:1px;background:rgba(0,212,255,0.15);margin:8px 0 6px;';
      el.appendChild(taxiSep);
      const taxiBtn = document.createElement('button');
      taxiBtn.className = 'popup-taxi-btn';
      taxiBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none">
        <rect x="2" y="7" width="20" height="11" rx="2" fill="#00d4ff" fill-opacity="0.15" stroke="#00d4ff" stroke-width="1.5"/>
        <path d="M7 7V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v2" stroke="#00d4ff" stroke-width="1.5" stroke-linecap="round"/>
        <circle cx="7" cy="15" r="2" fill="#00d4ff"/>
        <circle cx="17" cy="15" r="2" fill="#00d4ff"/>
        <path d="M3 11h18" stroke="#00d4ff" stroke-width="1.2" stroke-dasharray="3 2"/>
      </svg>أطلب تكسي`;
      taxiBtn.addEventListener('click', ()=>{
        setTaxiItemRef.current?.(item);
        mapRef.current?.closePopup();
      });
      el.appendChild(taxiBtn);
    }

    if (adminModeRef.current) {
      const sep=document.createElement('div');
      sep.style.cssText='height:1px;background:rgba(255,45,120,0.2);margin:8px 0 6px;';
      el.appendChild(sep);
      const deleteBtn=document.createElement('button');
      deleteBtn.className='popup-delete-btn';
      deleteBtn.innerHTML=`<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" stroke="#ff2d78" stroke-width="1.8" stroke-linecap="round"/><path d="M10 11v6M14 11v6" stroke="#ff2d78" stroke-width="1.6" stroke-linecap="round"/></svg>حذف هذا الموقع`;
      let confirmed=false;
      deleteBtn.addEventListener('click',()=>{
        if (!confirmed){
          confirmed=true;
          deleteBtn.innerHTML=`<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" stroke="#ff2d78" stroke-width="1.8" stroke-linecap="round"/></svg>تأكيد الحذف؟`;
          deleteBtn.style.background='rgba(255,45,120,0.2)';
          setTimeout(()=>{confirmed=false;deleteBtn.innerHTML=`<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" stroke="#ff2d78" stroke-width="1.8" stroke-linecap="round"/><path d="M10 11v6M14 11v6" stroke="#ff2d78" stroke-width="1.6" stroke-linecap="round"/></svg>حذف هذا الموقع`;deleteBtn.style.background='transparent';},3000);
        } else {
          onAdminDeleteRef.current?.(item);
          mapRef.current?.closePopup();
        }
      });
      el.appendChild(deleteBtn);
    }
    return el;
  },[]);

  // ── Traffic layer — simulated GTA-style road congestion ─────────────────────
  useEffect(()=>{
    if (!mapRef.current) return;
    // Remove existing layers
    trafficLayersRef.current.forEach(l=>l.remove());
    trafficLayersRef.current=[];
    if (!showTraffic) return;
    // Main roads of Baqubah (approximate real coordinates)
    const roads: { coords:[number,number][], color:string, weight:number, dash?:string }[] = [
      // Baghdad-Kirkuk highway (main N-S artery) — heavy traffic (red)
      { coords:[[33.763,44.651],[33.756,44.651],[33.750,44.650],[33.742,44.649],[33.736,44.648]], color:'#ff2d78', weight:6 },
      // Main E-W road — moderate (yellow)
      { coords:[[33.745,44.632],[33.745,44.640],[33.745,44.649],[33.745,44.658],[33.745,44.666]], color:'#f5c518', weight:5 },
      // Secondary road west — free (green)
      { coords:[[33.760,44.640],[33.752,44.639],[33.744,44.639]], color:'#00f5d4', weight:4 },
      // Secondary road east — moderate
      { coords:[[33.751,44.659],[33.746,44.661],[33.739,44.662]], color:'#f5c518', weight:3 },
      // Cross connector A — heavy
      { coords:[[33.753,44.641],[33.753,44.649],[33.754,44.658]], color:'#ff2d78', weight:4 },
      // Cross connector B — free
      { coords:[[33.740,44.642],[33.741,44.650],[33.740,44.660]], color:'#00f5d4', weight:3 },
      // Ring road north — moderate
      { coords:[[33.760,44.638],[33.762,44.648],[33.761,44.658],[33.757,44.665]], color:'#f5c518', weight:3 },
      // Ring road south — free
      { coords:[[33.734,44.643],[33.735,44.653],[33.736,44.663]], color:'#00f5d4', weight:3 },
      // Inner city — heavy
      { coords:[[33.748,44.644],[33.748,44.650],[33.749,44.655]], color:'#ff9500', weight:4 },
    ];
    trafficLayersRef.current = roads.flatMap(({coords,color,weight})=>[
      // Glow layer
      L.polyline(coords,{color,weight:weight+6,opacity:0.08,lineCap:'round',lineJoin:'round'}).addTo(mapRef.current!),
      // Main line
      L.polyline(coords,{color,weight,opacity:0.75,lineCap:'round',lineJoin:'round',dashArray:'14 6'}).addTo(mapRef.current!),
    ]);
  },[showTraffic]);

  // ── Close / cancel taxi routing ──────────────────────────────────────────────
  const closeTaxiRouting = useCallback(()=>{
    taxiRouteLineRef.current?.remove();  taxiRouteLineRef.current  = null;
    taxiGlowLineRef.current?.remove();   taxiGlowLineRef.current   = null;
    taxiFromMarkerRef.current?.remove(); taxiFromMarkerRef.current = null;
    taxiToMarkerRef.current?.remove();   taxiToMarkerRef.current   = null;
    setTaxiDriverItem(null); setTaxiStep('idle');
    setTaxiFromPt(null);     setTaxiToPt(null);
    setTaxiDistKm(null);     setTaxiEstPrice(null);
    setTaxiError(null);      setTaxiSuccess(false);
    setTaxiDestName('');     setTaxiFromPlaced(false);
    taxiStepRef.current   = 'idle';
    poiMarkersRef.current.forEach(m=>m.remove());
    poiMarkersRef.current = [];
    taxiFromPtRef.current = null;
    if (mapRef.current) mapRef.current.getContainer().style.cursor = adminModeRef.current ? 'crosshair' : '';
  },[]);

  // ── Confirm "from" point and advance to pick-to step ─────────────────────
  const confirmTaxiFrom = useCallback(()=>{
    if (!taxiFromPtRef.current) return;
    setTaxiStep('pick-to');
    taxiStepRef.current = 'pick-to';
    if (mapRef.current) mapRef.current.getContainer().style.cursor = '';
  },[]);

  // ── Auto-find nearest available driver (Haversine, ≤10 km) ──────────────
  const autoFindDriver = useCallback(async ()=>{
    if (!taxiCategory) return;

    // ── Full taxi state reset ────────────────────────────────────────────────
    taxiRouteLineRef.current?.remove();  taxiRouteLineRef.current  = null;
    taxiGlowLineRef.current?.remove();   taxiGlowLineRef.current   = null;
    taxiFromMarkerRef.current?.remove(); taxiFromMarkerRef.current = null;
    taxiToMarkerRef.current?.remove();   taxiToMarkerRef.current   = null;
    poiMarkersRef.current.forEach(m=>m.remove()); poiMarkersRef.current = [];
    setTaxiDriverItem(null); setTaxiStep('idle');
    setTaxiFromPt(null);     setTaxiToPt(null);
    setTaxiDistKm(null);     setTaxiEstPrice(null);
    setTaxiError(null);      setTaxiSuccess(false);
    setTaxiDestName('');     setTaxiFromPlaced(false);
    setTaxiFoundSnack(null); setTaxiNoDriverSnack(false);
    taxiStepRef.current   = 'idle';
    taxiFromPtRef.current = null;
    if (mapRef.current) mapRef.current.getContainer().style.cursor = '';

    // ── Show taxi layer on map ───────────────────────────────────────────────
    onFilterChange(taxiCategory.slug);
    setShowMoreModal(false);
    setShowTaxiPrompt(false);

    // ── Core search — runs once GPS is available ─────────────────────────────
    const doSearch = async (loc: {lat:number; lng:number}) => {
      setTaxiAutoSearching(true);
      try {
        const res     = await fetch('/api/drivers-online');
        const drivers: OnlineDriver[] = await res.json();

        const MAX_KM  = 10;
        const nearby  = drivers
          .map(d => ({ ...d, distKm: haversineDist(loc.lat, loc.lng, d.lat, d.lng) }))
          .filter(d  => d.distKm <= MAX_KM)
          .sort((a, b) => a.distKm - b.distKm);

        setTaxiAutoSearching(false);

        if (nearby.length === 0) {
          setTaxiNoDriverSnack(true);
          setTimeout(()=> setTaxiNoDriverSnack(false), 6000);
          return;
        }

        const nearest = nearby[0];

        // ── Construct a synthetic MapItem from the driver record ─────────────
        const synthetic: MapItem = {
          id:       nearest.locationId,
          kind:     taxiCategory.slug,
          category: taxiCategory.slug,
          name:     nearest.driverName,
          details:  '',
          address:  '',
          phone:    nearest.phone,
          hours:    '',
          status:   'مفتوح',
          lat:      nearest.lat,
          lng:      nearest.lng,
        };

        // Restore saved user info
        try {
          const saved = JSON.parse(localStorage.getItem('diyala_user') ?? 'null');
          setTaxiUserName(saved?.name  ?? '');
          setTaxiUserPhone(saved?.phone ?? '');
        } catch { setTaxiUserName(''); setTaxiUserPhone(''); }

        // ── Set driver + from-point (GPS) ────────────────────────────────────
        setTaxiDriverItem(synthetic);
        const fromPt = { lat: loc.lat, lng: loc.lng };
        setTaxiFromPt(fromPt);
        taxiFromPtRef.current = fromPt;
        setTaxiFromPlaced(true);

        // ── Place draggable A marker at GPS ──────────────────────────────────
        if (mapRef.current) {
          const m = L.marker([loc.lat, loc.lng], {
            icon: L.divIcon({className:'', html:taxiPinHtml('#00f5d4','A'), iconSize:[34,42], iconAnchor:[17,42]}),
            zIndexOffset: 1000,
            draggable: true,
          }).addTo(mapRef.current);
          m.on('dragend', ()=>{
            const pos = m.getLatLng();
            const pt  = { lat: pos.lat, lng: pos.lng };
            setTaxiFromPt(pt);
            taxiFromPtRef.current = pt;
          });
          taxiFromMarkerRef.current = m;
          mapRef.current.flyTo([loc.lat, loc.lng], 17, { animate:true, duration:1.0 });
        }

        // ── Jump directly to destination selection (skip pick-from) ──────────
        setTaxiStep('pick-to');
        taxiStepRef.current = 'pick-to';

        // ── Show "found" banner ───────────────────────────────────────────────
        setTaxiFoundSnack(nearest.driverName);
        setTimeout(()=> setTaxiFoundSnack(null), 7000);

      } catch {
        setTaxiAutoSearching(false);
        setTaxiNoDriverSnack(true);
        setTimeout(()=> setTaxiNoDriverSnack(false), 6000);
      }
    };

    const loc = userLocationRef.current;
    if (loc) {
      doSearch(loc);
    } else {
      // GPS not yet available — start locating, then search on first fix
      setTaxiAutoSearching(true);
      locateUserRef.current?.((newLoc)=> doSearch(newLoc));
    }
  },[taxiCategory, onFilterChange]);

  // ── Contextual POIs: fetch Overpass when taxi enters pick-to step ─────────
  // Depends only on taxiStep (NOT userLocation) so GPS updates don't re-trigger
  // the effect and cause markers to flash/disappear on every position update.
  useEffect(()=>{
    poiMarkersRef.current.forEach(m=>m.remove());
    poiMarkersRef.current = [];
    setPoiLoading(false);

    if (taxiStep !== 'pick-to' || !mapRef.current) return;

    // Use the ref so we read the latest GPS fix without adding it to deps
    const lat = userLocationRef.current?.lat ?? 33.7451;
    const lon = userLocationRef.current?.lng ?? 44.6488;

    // Zoom to street level focused on user's exact location
    mapRef.current.flyTo([lat, lon], 15, { animate:true, duration:1.0 });

    // Fetch real POIs from Overpass within 12 km radius
    const query =
      `[out:json][timeout:18];` +
      `node["amenity"~"hospital|clinic|university|school|college|restaurant|fast_food|cafe|` +
      `fuel|mosque|pharmacy|police|bank|atm|supermarket|marketplace|hotel|cinema|library"]` +
      `(around:12000,${lat},${lon});out 60;`;

    const ctrl = new AbortController();
    const tid  = setTimeout(()=>ctrl.abort(), 18000);
    setPoiLoading(true);

    fetch('https://overpass-api.de/api/interpreter', { method:'POST', body:query, signal:ctrl.signal })
      .then(r=>r.json())
      .then(data=>{
        clearTimeout(tid);
        if (taxiStepRef.current !== 'pick-to' || !mapRef.current) return;
        const elements: any[] = (data.elements ?? []).slice(0, 60);
        elements.forEach(el=>{
          if (!el.lat || !el.lon) return;
          const name = ((el.tags?.['name:ar'] || el.tags?.name || '') as string).trim();
          if (!name) return;
          const { emoji, color } = getAmenityStyle(el.tags?.amenity ?? '');
          const m = L.marker([el.lat, el.lon],{
            icon: L.divIcon({ className:'', html:poiNeonHtml(emoji, name, color), iconSize:[36,52], iconAnchor:[18,52] }),
            zIndexOffset: 350,
          });
          m.on('click', ()=>{
            if (taxiStepRef.current !== 'pick-to') return;
            setTaxiDestName(name);
            taxiPickPointRef.current?.(el.lat, el.lon);
          });
          m.addTo(mapRef.current!);
          poiMarkersRef.current.push(m);
        });
      })
      .catch(()=>clearTimeout(tid))
      .finally(()=>setPoiLoading(false));

    return ()=>{
      clearTimeout(tid);
      try { ctrl.abort(); } catch { /* */ }
      poiMarkersRef.current.forEach(m=>m.remove());
      poiMarkersRef.current = [];
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[taxiStep]);

  // ── Stop active order tracking (driver arrived / cancelled) ───────────────
  const stopOrderTracking = useCallback(()=>{
    driverMarkerRef.current?.remove(); driverMarkerRef.current = null;
    setActiveOrderId(null);    setActiveOrderStatus('pending');
    setDriverLat(null);        setDriverLng(null);
    setDriverDistKm(null);     setDriverEtaMin(null);
    setShowChat(false);        prevDriverPosRef.current = null;
    activeOrderIdRef.current    = null;
    activeOrderStatusRef.current = 'pending';
    localStorage.removeItem('diyala_active_order');
  },[]);

  // ── Restore active order from localStorage on first load ──────────────────
  useEffect(()=>{
    const saved = localStorage.getItem('diyala_active_order');
    if (!saved) return;
    try {
      const { orderId, driverPhone } = JSON.parse(saved) as { orderId:number; driverPhone:string };
      if (!orderId) return;
      // Verify order is still active before restoring
      fetch(`/api/orders/${orderId}`)
        .then(r=>r.json())
        .then(data=>{
          const s = data?.status ?? '';
          if (s === 'done' || s === 'cancelled' || !s) {
            localStorage.removeItem('diyala_active_order');
            return;
          }
          // Still active — restore tracking
          setActiveOrderId(orderId);
          setActiveOrderStatus(s);
          activeOrderIdRef.current    = orderId;
          activeOrderStatusRef.current = s;
          if (driverPhone) setActiveDriverPhone(driverPhone);
          if (s === 'accepted' || s === 'driving') setShowChat(true);
        })
        .catch(()=>{ /* network error — leave as-is, polling will start */ });
    } catch {
      localStorage.removeItem('diyala_active_order');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  // ── Driver marker icon factory ────────────────────────────────────────────
  function makeDriverIcon(): L.DivIcon {
    return L.divIcon({
      className: '',
      html: `<div style="width:46px;height:46px;position:relative;display:flex;align-items:center;justify-content:center;">
        <div style="position:absolute;inset:0;border-radius:50%;background:#f5c518;opacity:0.14;animation:lf-ping 1.8s cubic-bezier(0,0,0.2,1) infinite;"></div>
        <div style="position:absolute;inset:4px;border-radius:50%;border:2px solid #f5c518;box-shadow:0 0 20px #f5c518,0 0 40px #f5c51866;"></div>
        <span style="position:relative;z-index:1;font-size:20px;line-height:1;user-select:none;">🚕</span>
      </div>`,
      iconSize: [46,46], iconAnchor: [23,23],
    });
  }

  // ── Smooth driver marker update (CSS transition via setLatLng) ────────────
  const updateDriverMarker = useCallback((lat: number, lng: number)=>{
    if (!mapRef.current) return;
    if (driverMarkerRef.current) {
      driverMarkerRef.current.setLatLng([lat, lng]);
    } else {
      driverMarkerRef.current = L.marker([lat, lng],{
        icon: makeDriverIcon(),
        zIndexOffset: 900,
      }).addTo(mapRef.current);
    }
    // Enable CSS smooth transition on the marker DOM element
    const el = driverMarkerRef.current.getElement();
    if (el) el.style.transition = 'transform 0.9s linear';
    prevDriverPosRef.current = { lat, lng };
  },[]);

  // ── Online-driver icon (smaller cyan taxi, distinct from active-order marker)
  function makeOnlineDriverIcon(name: string): L.DivIcon {
    const label = name ? name.slice(0,6) : '🚕';
    return L.divIcon({
      className: '',
      html: `<div style="position:relative;display:flex;flex-direction:column;align-items:center;gap:2px;">
        <div style="width:38px;height:38px;position:relative;display:flex;align-items:center;justify-content:center;">
          <div style="position:absolute;inset:0;border-radius:50%;background:#00d4ff;opacity:0.12;animation:lf-ping 2.2s cubic-bezier(0,0,0.2,1) infinite;"></div>
          <div style="position:absolute;inset:3px;border-radius:50%;border:1.5px solid #00d4ff;box-shadow:0 0 14px #00d4ff88;"></div>
          <span style="position:relative;z-index:1;font-size:17px;line-height:1;user-select:none;">🚕</span>
        </div>
        <div style="background:rgba(0,212,255,0.18);border:1px solid rgba(0,212,255,0.5);color:#00d4ff;font-family:Rajdhani,sans-serif;font-size:9px;padding:1px 5px;white-space:nowrap;max-width:64px;overflow:hidden;text-overflow:ellipsis;backdrop-filter:blur(4px);">${label}</div>
      </div>`,
      iconSize: [38, 58], iconAnchor: [19, 58],
    });
  }

  // ── Update / create an online-driver marker with smooth animation ─────────
  const upsertOnlineDriverMarker = useCallback((driver: {
    locationId:number; driverName:string; phone:string; lat:number; lng:number; isOnline:boolean;
  })=>{
    if (!mapRef.current) return;
    const existing = onlineDriverMarkersRef.current.get(driver.locationId);
    if (!driver.isOnline) {
      existing?.remove();
      onlineDriverMarkersRef.current.delete(driver.locationId);
      return;
    }
    if (existing) {
      existing.setLatLng([driver.lat, driver.lng]);
      const el = existing.getElement();
      if (el) el.style.transition = 'transform 1.0s linear';
    } else {
      const m = L.marker([driver.lat, driver.lng],{
        icon: makeOnlineDriverIcon(driver.driverName),
        zIndexOffset: 800,
      }).addTo(mapRef.current);
      // Tooltip with driver name + phone
      m.bindTooltip(
        `<div style="font-family:Rajdhani,sans-serif;font-size:12px;color:#00d4ff;background:rgba(5,8,15,0.93);border:1px solid rgba(0,212,255,0.3);padding:4px 8px;">
          <b>${driver.driverName || 'سائق متصل'}</b>${driver.phone ? `<br/><span style="color:rgba(0,212,255,0.7)">${driver.phone}</span>` : ''}
        </div>`,
        { permanent: false, direction: 'top', offset: [0, -62], className: 'online-driver-tooltip', opacity: 1 }
      );
      // Enable smooth transitions
      const el = m.getElement();
      if (el) el.style.transition = 'transform 1.0s linear';
      onlineDriverMarkersRef.current.set(driver.locationId, m);
    }
  }, []);

  // ── Fetch all online drivers and render their markers ─────────────────────
  const refreshOnlineDrivers = useCallback(async ()=>{
    if (!mapRef.current) return;
    try {
      const res = await fetch('/api/drivers-online');
      if (!res.ok) return;
      const drivers: {
        id:number; locationId:number; driverName:string;
        phone:string; lat:number; lng:number; isOnline:boolean;
      }[] = await res.json();
      // Determine which locationIds are currently present in the new list
      const incomingIds = new Set(drivers.map(d=>d.locationId));
      // Remove markers for drivers no longer online
      for (const [locId, m] of onlineDriverMarkersRef.current.entries()) {
        if (!incomingIds.has(locId)) { m.remove(); onlineDriverMarkersRef.current.delete(locId); }
      }
      // Upsert all incoming drivers
      drivers.forEach(d => upsertOnlineDriverMarker(d));
    } catch { /* silent */ }
  }, [upsertOnlineDriverMarker]);

  // ── Poll online drivers every 8 s ─────────────────────────────────────────
  useEffect(()=>{
    refreshOnlineDrivers();
    const iv = setInterval(refreshOnlineDrivers, 8000);
    return ()=> clearInterval(iv);
  },[refreshOnlineDrivers]);

  // ── SSE listener for instant driver_update events ─────────────────────────
  useEffect(()=>{
    const es = new EventSource('/api/events');
    es.addEventListener('driver_update', (e: MessageEvent)=>{
      try {
        const { driver } = JSON.parse(e.data) as { driver: {
          id:number; locationId:number; driverName:string;
          phone:string; lat:number; lng:number; isOnline:boolean;
        }};
        if (driver) upsertOnlineDriverMarker(driver);
      } catch { /* */ }
    });
    es.onerror = ()=> es.close();
    return ()=> es.close();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  // ── SSE listener for system messages (works even when chat panel is closed) ─
  // Shows a Snackbar notification for any incoming message with isSystemMsg=true,
  // as long as it belongs to the current active order and hasn't been shown yet.
  useEffect(()=>{
    const es = new EventSource('/api/events');
    es.addEventListener('new_message', (e: MessageEvent)=>{
      try {
        const { message } = JSON.parse(e.data) as { message: {
          id: number|string; orderId: number;
          senderRole: string; content: string;
          isSystemMsg?: boolean; createdAt: string;
        }};
        if (!message?.isSystemMsg) return;
        if (message.orderId !== activeOrderIdRef.current) return;
        if (seenSnackIdsRef.current.has(message.id)) return;
        seenSnackIdsRef.current.add(message.id);
        // Show the snackbar
        setSysMsgSnack(message.content);
        if (sysMsgTimerRef.current) clearTimeout(sysMsgTimerRef.current);
        sysMsgTimerRef.current = setTimeout(()=> setSysMsgSnack(null), 7000);
      } catch { /* */ }
    });
    es.onerror = ()=> es.close();
    return ()=> es.close();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  // ── Apply order snapshot (status + driver position) ───────────────────────
  const applyOrderSnapshot = useCallback((data: {
    id: number; status: string;
    driverLat?: number|null; driverLng?: number|null;
    fromLat?: number|null; fromLng?: number|null;
    locationId?: number|null; userName?: string|null;
  })=>{
    setActiveOrderStatus(data.status);
    activeOrderStatusRef.current = data.status;
    if (data.status === 'accepted' || data.status === 'driving') {
      setShowChat(true); // auto-open chat when driver accepts
    }
    // 'done' or 'finished' → hide chat and show rating dialog before clearing
    if (data.status === 'done' || data.status === 'finished' || data.status === 'cancelled') {
      setShowChat(false);
      localStorage.removeItem('diyala_active_order');

      if ((data.status === 'done' || data.status === 'finished') && !ratingShownRef.current.has(data.id)) {
        ratingShownRef.current.add(data.id);
        setRatingOrderId(data.id);
        setRatingDriverId(data.locationId ?? 0);
        setRatingCustomerName(data.userName ?? '');
        setShowRating(true);
      } else {
        setTimeout(()=>{ stopOrderTracking(); }, 2500);
      }
      return;
    }
    if (typeof data.driverLat === 'number' && typeof data.driverLng === 'number') {
      setDriverLat(data.driverLat);
      setDriverLng(data.driverLng);
      updateDriverMarker(data.driverLat, data.driverLng);
      // Compute distance & ETA from driver → pickup point
      const refLat = data.fromLat ?? null;
      const refLng = data.fromLng ?? null;
      if (typeof refLat === 'number' && typeof refLng === 'number') {
        const distKm = haversineKm(data.driverLat, data.driverLng, refLat, refLng);
        setDriverDistKm(distKm);
        setDriverEtaMin(Math.round(distKm * 2.5)); // ~24 km/h avg urban speed
      }
    }
  },[updateDriverMarker, stopOrderTracking]);

  // ── Poll order status every 3 s ───────────────────────────────────────────
  useEffect(()=>{
    if (!activeOrderId) return;
    const poll = async ()=>{
      try {
        const res = await fetch(`/api/orders/${activeOrderId}`);
        if (!res.ok) return;
        const data = await res.json();
        applyOrderSnapshot(data);
      } catch { /* silent */ }
    };
    poll(); // immediate first fetch
    const iv = setInterval(poll, 3000);
    return ()=> clearInterval(iv);
  },[activeOrderId, applyOrderSnapshot]);

  // ── SSE listener for real-time order updates ──────────────────────────────
  useEffect(()=>{
    const es = new EventSource('/api/events');
    es.addEventListener('order_update', (e: MessageEvent)=>{
      try {
        const { order } = JSON.parse(e.data) as { order: any };
        if (order?.id !== activeOrderIdRef.current) return;
        applyOrderSnapshot(order);
      } catch { /* */ }
    });
    es.onerror = ()=> es.close();
    return ()=> es.close();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  // ── Submit confirmed taxi order ───────────────────────────────────────────────
  const submitTaxiOrder = useCallback(async ()=>{
    if (!taxiDriverItem || !taxiFromPt || !taxiToPt) return;
    if (!taxiUserName.trim())  { setTaxiError('الرجاء إدخال اسمك');      return; }
    if (!taxiUserPhone.trim()) { setTaxiError('الرجاء إدخال رقم الهاتف'); return; }
    setTaxiLoading(true);
    setTaxiError(null);
    try {
      const res = await fetch('/api/orders', {
        method:  'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          locationId:     taxiDriverItem.id,
          userName:       taxiUserName.trim(),
          phone:          taxiUserPhone.trim(),
          destination:    `من (${taxiFromPt.lat.toFixed(4)},${taxiFromPt.lng.toFixed(4)}) إلى (${taxiToPt.lat.toFixed(4)},${taxiToPt.lng.toFixed(4)})`,
          fromLat:        taxiFromPt.lat,
          fromLng:        taxiFromPt.lng,
          toLat:          taxiToPt.lat,
          toLng:          taxiToPt.lng,
          estimatedPrice: taxiEstPrice ?? 0,
          lat:            taxiFromPt.lat,
          lng:            taxiFromPt.lng,
        }),
      });
      if (res.ok) {
        localStorage.setItem('diyala_user', JSON.stringify({name:taxiUserName.trim(),phone:taxiUserPhone.trim()}));
        const { orderId } = await res.json();
        setTaxiSuccess(true);
        // Activate live tracking for this order
        if (orderId) {
          setActiveOrderId(orderId);
          setActiveOrderStatus('pending');
          activeOrderIdRef.current    = orderId;
          activeOrderStatusRef.current = 'pending';
          // Capture driver id + phone for rating dialog and chat
          const driverPhone = taxiDriverItem.phone ?? '';
          setActiveDriverPhone(driverPhone);
          setActiveDriverId(taxiDriverItem.id);
          // Persist order to localStorage so it survives page refresh
          localStorage.setItem('diyala_active_order', JSON.stringify({ orderId, driverPhone, driverId: taxiDriverItem.id }));
        }
        setTimeout(()=>{ closeTaxiRouting(); }, 2600);
      } else {
        const err = await res.json().catch(()=>({}));
        setTaxiError((err as any).error ?? 'فشل إرسال الطلب');
      }
    } catch {
      setTaxiError('تعذّر الاتصال بالسيرفر');
    } finally {
      setTaxiLoading(false);
    }
  },[taxiDriverItem, taxiFromPt, taxiToPt, taxiUserName, taxiUserPhone, taxiEstPrice, closeTaxiRouting]);

  // Sync markers whenever items / activeFilter / selectedItem changes
  useEffect(()=>{
    if (!mapRef.current) return;
    Object.values(markersRef.current).forEach(m=>m.remove());
    markersRef.current={};
    items
      .filter(i=>i.kind===activeFilter && i.status!=='معطّل')
      .forEach(item=>{
        const isOpen    = item.status==='مفتوح';
        const isSelected= selectedItem?.id===item.id;
        const popupClass= `map-popup cat-${item.kind}`;
        const marker    = L.marker([item.lat,item.lng],{icon:makeIcon(item.kind,catMapRef.current,isOpen,isSelected,item.name)}).addTo(mapRef.current!);
        marker.bindPopup(L.popup({className:popupClass,offset:[0,-8],closeButton:true,autoClose:true,autoPan:true}).setContent(buildPopup(item)));
        marker.on('click',()=>{marker.openPopup();mapRef.current?.flyTo([item.lat,item.lng],15,{duration:0.8});});
        markersRef.current[item.id]=marker;
      });
    // After markers are built, open popup for any pending search-jump
    if (pendingJumpRef.current !== null) {
      const jumpId = pendingJumpRef.current;
      pendingJumpRef.current = null;
      setTimeout(()=>{ markersRef.current[jumpId]?.openPopup(); }, 500);
    }
  },[items,activeFilter,selectedItem,buildPopup]);

  // Update selected icon without full re-render
  useEffect(()=>{
    items.filter(i=>i.kind===activeFilter && i.status!=='معطّل').forEach(item=>{
      markersRef.current[item.id]?.setIcon(makeIcon(item.kind,catMapRef.current,item.status==='مفتوح',selectedItem?.id===item.id,item.name));
    });
  },[selectedItem,items,activeFilter]);

  // Draw route
  useEffect(()=>{
    clearRouteVisuals();
    if (!routeTarget||!userLocation||!mapRef.current) return;
    drawRoute(mapRef.current,userLocation,routeTarget,setRouteInfo,setRouteLoading,routeGlowRef,routeLineRef);
  },[routeTarget,userLocation,clearRouteVisuals]);

  const handleCancelRoute = () => { clearRouteVisuals(); onClearRoute(); };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="relative w-full h-full">
      <div ref={mapContainer} className="absolute inset-0" style={{zIndex:0}} />

      {/* ── Filter Tabs — first 4 + More button ── */}
      <div
        className="filter-tabs-bar"
        style={{
          position:'absolute',top:'12px',left:'50%',transform:'translateX(-50%)',
          zIndex:1000,display:'flex',maxWidth:'calc(100vw - 24px)',
          overflowX:'auto',scrollbarWidth:'none',msOverflowStyle:'none',
          border:'1px solid rgba(255,255,255,0.1)',
          backdropFilter:'blur(14px)',boxShadow:'0 4px 32px rgba(0,0,0,0.8)',
        } as React.CSSProperties}
      >
        {categories.length === 0
          ? [1,2,3,4].map(n=>(
              <div key={n} style={{width:'100px',height:'72px',background:'rgba(5,8,15,0.92)',borderBottom:'2px solid transparent',flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center'}}>
                <div style={{width:'60px',height:'10px',background:'rgba(255,255,255,0.06)',borderRadius:'2px'}}/>
              </div>
            ))
          : <>
              {displayCategories.slice(0,4).map(cat=>{
                const active = activeFilter===cat.slug;
                const c = active ? cat.color : 'rgba(255,255,255,0.35)';
                const count = items.filter(i=>i.kind===cat.slug && i.status!=='معطّل').length;
                return (
                  <button key={cat.slug} onClick={()=>{onFilterChange(cat.slug);setShowMoreModal(false);}}
                    style={{
                      padding:'8px 16px',
                      background:active?`${cat.color}18`:'rgba(5,8,15,0.92)',
                      border:'none',
                      borderBottom:active?`2px solid ${cat.color}`:'2px solid transparent',
                      color:c,
                      fontFamily:'Orbitron,sans-serif',fontSize:'10px',letterSpacing:'0.1em',
                      cursor:'pointer',transition:'all 0.2s',
                      display:'flex',flexDirection:'column',alignItems:'center',gap:'3px',
                      minWidth:'90px',flexShrink:0,
                      boxShadow:active?`inset 0 0 20px ${cat.color}18`:'none',
                    }}>
                    <span style={{fontSize:'15px'}}>{cat.icon}</span>
                    <span style={{whiteSpace:'nowrap'}}>{cat.labelEn.toUpperCase()}</span>
                    <span style={{fontSize:'11px',fontFamily:'Rajdhani,sans-serif',opacity:0.8,whiteSpace:'nowrap'}}>
                      {cat.labelAr} ({count})
                    </span>
                  </button>
                );
              })}
              {/* More button — always visible (search + extra categories) */}
              <button onClick={()=>setShowMoreModal(v=>!v)}
                style={{
                  padding:'8px 16px',
                  background: showMoreModal ? 'rgba(123,47,247,0.18)' : 'rgba(5,8,15,0.92)',
                  border:'none',
                  borderBottom: showMoreModal ? '2px solid #7b2ff7' : '2px solid transparent',
                  color: showMoreModal ? '#7b2ff7' : 'rgba(255,255,255,0.35)',
                  fontFamily:'Orbitron,sans-serif',fontSize:'10px',letterSpacing:'0.1em',
                  cursor:'pointer',transition:'all 0.2s',
                  display:'flex',flexDirection:'column',alignItems:'center',gap:'4px',
                  minWidth:'76px',flexShrink:0,
                  boxShadow: showMoreModal ? 'inset 0 0 20px rgba(123,47,247,0.18)' : 'none',
                }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <rect x="3" y="3" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.8"/>
                  <rect x="14" y="3" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.8"/>
                  <rect x="3" y="14" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.8"/>
                  <rect x="14" y="14" width="7" height="7" rx="1.2" stroke="currentColor" strokeWidth="1.8"/>
                </svg>
                <span>MORE</span>
                <span style={{fontSize:'11px',fontFamily:'Rajdhani,sans-serif',opacity:0.7}}>
                  {displayCategories.length > 4 ? `المزيد (${displayCategories.length - 4})` : 'بحث'}
                </span>
              </button>
            </>
        }
      </div>

      {/* ── More Categories + Smart Search Modal ── */}
      {showMoreModal && (
        <div
          style={{
            position:'absolute',inset:0,zIndex:1500,
            background:'rgba(0,0,0,0.72)',
            backdropFilter:'blur(6px)',
            display:'flex',alignItems:'flex-start',justifyContent:'center',
            paddingTop:'90px',
          }}
          onClick={e=>{ if(e.target===e.currentTarget) setShowMoreModal(false); }}
        >
          <div style={{
            width:'min(520px, calc(100vw - 20px))',
            maxHeight:'calc(100vh - 115px)',
            background:'rgba(5,8,15,0.98)',
            border:'1px solid rgba(123,47,247,0.45)',
            boxShadow:'0 0 48px rgba(123,47,247,0.18), 0 8px 32px rgba(0,0,0,0.9)',
            display:'flex',flexDirection:'column',
            overflow:'hidden',
          }}>
            {/* Header */}
            <div style={{
              display:'flex',alignItems:'center',justifyContent:'space-between',
              padding:'10px 16px',borderBottom:'1px solid rgba(255,255,255,0.06)',
              background:'rgba(123,47,247,0.06)',
            }}>
              <div style={{display:'flex',alignItems:'center',gap:'8px'}}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <circle cx="11" cy="11" r="8" stroke="#7b2ff7" strokeWidth="2"/>
                  <path d="M21 21l-4.35-4.35" stroke="#7b2ff7" strokeWidth="2.2" strokeLinecap="round"/>
                </svg>
                <span style={{fontFamily:'Orbitron,sans-serif',fontSize:'10px',color:'#7b2ff7',letterSpacing:'0.14em'}}>
                  SEARCH &amp; CATEGORIES
                </span>
              </div>
              <button onClick={()=>setShowMoreModal(false)} style={{
                background:'none',border:'none',color:'rgba(255,255,255,0.35)',
                fontSize:'20px',cursor:'pointer',lineHeight:1,padding:'0 4px',
                transition:'color 0.2s',
              }}
              onMouseEnter={e=>(e.currentTarget.style.color='#fff')}
              onMouseLeave={e=>(e.currentTarget.style.color='rgba(255,255,255,0.35)')}
              >×</button>
            </div>

            {/* Search Input */}
            <div style={{padding:'12px 16px',borderBottom:'1px solid rgba(255,255,255,0.05)'}}>
              <div style={{position:'relative'}}>
                <svg style={{position:'absolute',left:'11px',top:'50%',transform:'translateY(-50%)',opacity:0.45,pointerEvents:'none'}}
                  width="15" height="15" viewBox="0 0 24 24" fill="none">
                  <circle cx="11" cy="11" r="8" stroke="#7b2ff7" strokeWidth="2"/>
                  <path d="M21 21l-4.35-4.35" stroke="#7b2ff7" strokeWidth="2" strokeLinecap="round"/>
                </svg>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e=>setSearchQuery(e.target.value)}
                  placeholder="ابحث عن طبيب، مطعم، صيدلية، محطة وقود..."
                  autoFocus
                  style={{
                    width:'100%',boxSizing:'border-box',
                    padding:'10px 12px 10px 34px',
                    background:'rgba(123,47,247,0.07)',
                    border:'1px solid rgba(123,47,247,0.3)',
                    color:'#e8f8f5',
                    fontFamily:'Rajdhani,sans-serif',fontSize:'15px',
                    outline:'none',direction:'rtl',
                    transition:'border-color 0.2s',
                  }}
                  onFocus={e=>(e.target.style.borderColor='rgba(123,47,247,0.7)')}
                  onBlur={e=>(e.target.style.borderColor='rgba(123,47,247,0.3)')}
                />
                {searchQuery && (
                  <button onClick={()=>setSearchQuery('')} style={{
                    position:'absolute',right:'10px',top:'50%',transform:'translateY(-50%)',
                    background:'none',border:'none',color:'rgba(255,255,255,0.3)',
                    fontSize:'16px',cursor:'pointer',lineHeight:1,padding:'2px',
                  }}>×</button>
                )}
              </div>
            </div>

            {/* Content area */}
            <div style={{overflowY:'auto',flex:1}}>
              {searchQuery.trim() ? (
                <>
                  {/* ── Local DB results ── */}
                  {searchResults.length > 0 && (
                    <>
                      <div style={{padding:'8px 16px 4px',fontFamily:'Orbitron,sans-serif',fontSize:'8px',color:'rgba(123,47,247,0.7)',letterSpacing:'0.14em'}}>
                        📍 مواقع مسجّلة ({searchResults.length})
                      </div>
                      {searchResults.map(item=>{
                        const cat = catMapRef.current.get(item.kind);
                        const isOpen = item.status==='مفتوح';
                        const statusColor = isOpen ? '#00f5d4' : '#ff2d78';
                        const catColor = cat?.color ?? '#7b2ff7';
                        return (
                          <button key={item.id} onClick={()=>jumpToItem(item)}
                            style={{
                              width:'100%',display:'flex',alignItems:'center',gap:'12px',
                              padding:'11px 16px',background:'transparent',border:'none',
                              borderBottom:'1px solid rgba(255,255,255,0.04)',
                              cursor:'pointer',textAlign:'right',transition:'background 0.15s',
                            }}
                            onMouseEnter={e=>(e.currentTarget.style.background='rgba(123,47,247,0.1)')}
                            onMouseLeave={e=>(e.currentTarget.style.background='transparent')}
                          >
                            <div style={{
                              width:'38px',height:'38px',borderRadius:'50%',flexShrink:0,
                              background:`${catColor}12`,border:`1.5px solid ${catColor}44`,
                              display:'flex',alignItems:'center',justifyContent:'center',fontSize:'17px',
                            }}>{cat?.icon ?? '📍'}</div>
                            <div style={{flex:1,minWidth:0,textAlign:'right'}}>
                              <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:'15px',fontWeight:700,color:'#e8f8f5',marginBottom:'2px',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                                {item.name}
                              </div>
                              <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:'12px',color:'rgba(255,255,255,0.38)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                                {cat?.labelAr ?? item.kind}{item.address ? ` · ${item.address}` : ''}
                              </div>
                            </div>
                            <div style={{width:'8px',height:'8px',borderRadius:'50%',flexShrink:0,background:statusColor,boxShadow:`0 0 8px ${statusColor}`}}/>
                          </button>
                        );
                      })}
                    </>
                  )}

                  {/* ── Divider ── */}
                  {searchResults.length > 0 && (placeSearchLoading || placeResults.length > 0) && (
                    <div style={{margin:'4px 16px',borderTop:'1px solid rgba(0,212,255,0.15)'}}/>
                  )}

                  {/* ── Nominatim / OSM Places ── */}
                  {placeSearchLoading ? (
                    <div style={{padding:'16px',display:'flex',alignItems:'center',gap:'10px',direction:'rtl'}}>
                      <svg width="16" height="16" viewBox="0 0 28 28" fill="none" style={{animation:'lf-spin 0.9s linear infinite',flexShrink:0}}>
                        <circle cx="14" cy="14" r="10" stroke="#00d4ff" strokeWidth="2.5" strokeDasharray="22 14" strokeLinecap="round"/>
                      </svg>
                      <span style={{fontFamily:'Rajdhani,sans-serif',fontSize:'13px',color:'rgba(0,212,255,0.6)'}}>
                        جاري البحث عن الأماكن في ديالى...
                      </span>
                    </div>
                  ) : placeResults.length > 0 ? (
                    <>
                      <div style={{padding:'8px 16px 4px',fontFamily:'Orbitron,sans-serif',fontSize:'8px',color:'rgba(0,212,255,0.7)',letterSpacing:'0.14em'}}>
                        🌐 أماكن على الخريطة ({placeResults.length})
                      </div>
                      {placeResults.map(place=>{
                        const shortName = place.display_name.split(',')[0].trim();
                        const addrParts = place.display_name.split(',').slice(1,3).join(',').trim();
                        return (
                          <button key={place.place_id}
                            onClick={()=>selectPlace(shortName, parseFloat(place.lat), parseFloat(place.lon), addrParts || undefined)}
                            style={{
                              width:'100%',display:'flex',alignItems:'center',gap:'12px',
                              padding:'11px 16px',background:'transparent',border:'none',
                              borderBottom:'1px solid rgba(0,212,255,0.07)',
                              cursor:'pointer',textAlign:'right',transition:'background 0.15s',
                            }}
                            onMouseEnter={e=>(e.currentTarget.style.background='rgba(0,212,255,0.07)')}
                            onMouseLeave={e=>(e.currentTarget.style.background='transparent')}
                          >
                            <div style={{
                              width:'38px',height:'38px',borderRadius:'50%',flexShrink:0,
                              background:'rgba(0,212,255,0.08)',border:'1.5px solid rgba(0,212,255,0.35)',
                              display:'flex',alignItems:'center',justifyContent:'center',fontSize:'17px',
                            }}>🌐</div>
                            <div style={{flex:1,minWidth:0,textAlign:'right'}}>
                              <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:'15px',fontWeight:700,color:'#00d4ff',marginBottom:'2px',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                                {shortName}
                              </div>
                              {addrParts && (
                                <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:'12px',color:'rgba(0,212,255,0.45)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                                  {addrParts}
                                </div>
                              )}
                            </div>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{flexShrink:0,opacity:0.5}}>
                              <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5S10.62 6.5 12 6.5s2.5 1.12 2.5 2.5S13.38 11.5 12 11.5z" fill="#00d4ff"/>
                            </svg>
                          </button>
                        );
                      })}
                    </>
                  ) : searchResults.length === 0 ? (
                    <div style={{padding:'32px 16px',textAlign:'center'}}>
                      <div style={{fontSize:'28px',marginBottom:'10px',opacity:0.3}}>🔍</div>
                      <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:'14px',color:'rgba(255,255,255,0.3)'}}>
                        لا توجد نتائج لـ "{searchQuery}"
                      </div>
                    </div>
                  ) : null}
                </>
              ) : (
                /* Extra categories grid (categories 5+) */
                <>
                  {displayCategories.length > 4 && (
                    <>
                      <div style={{padding:'10px 16px 6px',fontFamily:'Orbitron,sans-serif',fontSize:'8px',color:'rgba(255,255,255,0.25)',letterSpacing:'0.14em'}}>
                        CATEGORIES
                      </div>
                      <div style={{padding:'4px 16px 14px',display:'flex',flexWrap:'wrap',gap:'8px'}}>
                        {displayCategories.slice(4).map(cat=>{
                          const active = activeFilter===cat.slug;
                          const count = items.filter(i=>i.kind===cat.slug && i.status!=='معطّل').length;
                          return (
                            <button key={cat.slug}
                              onClick={()=>{onFilterChange(cat.slug);setShowMoreModal(false);}}
                              style={{
                                display:'flex',alignItems:'center',gap:'7px',
                                padding:'8px 14px',
                                background: active ? `${cat.color}15` : 'rgba(255,255,255,0.03)',
                                border:`1px solid ${active ? cat.color : 'rgba(255,255,255,0.1)'}`,
                                color: active ? cat.color : 'rgba(255,255,255,0.6)',
                                fontFamily:'Rajdhani,sans-serif',fontSize:'14px',
                                cursor:'pointer',transition:'all 0.2s',
                                boxShadow: active ? `0 0 12px ${cat.color}44` : 'none',
                              }}
                              onMouseEnter={e=>{if(!active){(e.currentTarget as HTMLElement).style.borderColor='rgba(255,255,255,0.3)';(e.currentTarget as HTMLElement).style.color='rgba(255,255,255,0.9)';}}}
                              onMouseLeave={e=>{if(!active){(e.currentTarget as HTMLElement).style.borderColor='rgba(255,255,255,0.1)';(e.currentTarget as HTMLElement).style.color='rgba(255,255,255,0.6)';}}}
                            >
                              <span style={{fontSize:'15px'}}>{cat.icon}</span>
                              <span>{cat.labelAr}</span>
                              <span style={{fontSize:'12px',opacity:0.5}}>({count})</span>
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                  {/* Search hint when no query */}
                  <div style={{padding:'12px 16px 18px',borderTop:'1px solid rgba(255,255,255,0.04)',textAlign:'center'}}>
                    <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:'13px',color:'rgba(255,255,255,0.2)',letterSpacing:'0.05em'}}>
                      ابدأ الكتابة للبحث في جميع المواقع
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Cancel Route ── */}
      {(routeTarget || routeInfo) && (
        <button onClick={handleCancelRoute}
          style={{position:'absolute',top:'12px',right:'12px',zIndex:1000,padding:'9px 16px',background:'rgba(255,45,120,0.12)',border:'1px solid #ff2d78',color:'#ff2d78',fontFamily:'Orbitron,sans-serif',fontSize:'10px',letterSpacing:'0.1em',cursor:'pointer',display:'flex',alignItems:'center',gap:'8px',boxShadow:'0 0 16px rgba(255,45,120,0.3)',backdropFilter:'blur(10px)',transition:'all 0.2s'}}
          onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.background='rgba(255,45,120,0.25)';}}
          onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.background='rgba(255,45,120,0.12)';}}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="#ff2d78" strokeWidth="2.5" strokeLinecap="round"/></svg>
          إلغاء المسار
        </button>
      )}

      {/* ── GTA V GPS Button ── */}
      <div style={{position:'absolute',bottom:'100px',left:'20px',zIndex:1001,display:'flex',flexDirection:'column',alignItems:'center',gap:'8px'}}>
        {/* Error toast */}
        {locateError && (
          <div style={{background:'rgba(5,8,15,0.97)',border:'1px solid #ff2d78',color:'#ff2d78',fontSize:'11px',padding:'8px 12px',fontFamily:'Rajdhani,sans-serif',maxWidth:'180px',marginBottom:'4px',boxShadow:'0 0 18px rgba(255,45,120,0.3)',backdropFilter:'blur(12px)'}}>
            {locateError}
            <button onClick={()=>setLocateError(null)} style={{display:'block',marginTop:'4px',color:'#ff2d7888',fontSize:'10px',background:'none',border:'none',cursor:'pointer',padding:0}}>اغلق ×</button>
          </div>
        )}
        {/* Tracking badge */}
        {isTracking && !locating && (
          <div style={{
            display:'flex',alignItems:'center',gap:'6px',
            padding:'4px 10px',background:'rgba(0,245,212,0.08)',
            border:'1px solid #00f5d444',
            fontFamily:'Orbitron,sans-serif',fontSize:'8px',
            color:'#00f5d4',letterSpacing:'0.12em',
            backdropFilter:'blur(10px)',
          }}>
            <div style={{width:'5px',height:'5px',borderRadius:'50%',background:'#00f5d4',boxShadow:'0 0 8px #00f5d4',animation:'lf-ping 1.8s ease-in-out infinite'}}/>
            LIVE TRACKING
          </div>
        )}
        {/* Main circular GPS button */}
        <button
          onClick={()=>{
            if (isTracking && userLocation) {
              // Already tracking — re-center on user
              mapRef.current?.flyTo([userLocation.lat, userLocation.lng], 16, {animate:true, duration:1.5});
            } else {
              locateUser();
            }
          }}
          disabled={locating}
          title={isTracking ? 'العودة لموقعي' : 'تحديد موقعي'}
          style={{
            width:'56px', height:'56px',
            borderRadius:'50%',
            background: isTracking
              ? 'radial-gradient(circle at 38% 38%, rgba(0,245,212,0.22), rgba(0,245,212,0.06))'
              : 'radial-gradient(circle at 38% 38%, rgba(0,212,255,0.14), rgba(13,17,23,0.98))',
            border: isTracking ? '2px solid #00f5d4' : '2px solid #00d4ff',
            boxShadow: isTracking
              ? '0 0 20px rgba(0,245,212,0.55), 0 0 40px rgba(0,245,212,0.2), inset 0 0 12px rgba(0,245,212,0.08)'
              : '0 0 12px rgba(0,212,255,0.35), 0 0 24px rgba(0,212,255,0.1)',
            cursor: locating ? 'wait' : 'pointer',
            display:'flex', alignItems:'center', justifyContent:'center',
            padding:0, transition:'all 0.35s cubic-bezier(0.4,0,0.2,1)',
            backdropFilter:'blur(14px)',
            position:'relative',
            overflow:'hidden',
          }}
          onMouseEnter={e=>{
            if (!locating) (e.currentTarget as HTMLElement).style.boxShadow = isTracking
              ? '0 0 30px rgba(0,245,212,0.8), 0 0 60px rgba(0,245,212,0.3), inset 0 0 18px rgba(0,245,212,0.12)'
              : '0 0 24px rgba(0,212,255,0.7), 0 0 48px rgba(0,212,255,0.25)';
          }}
          onMouseLeave={e=>{
            (e.currentTarget as HTMLElement).style.boxShadow = isTracking
              ? '0 0 20px rgba(0,245,212,0.55), 0 0 40px rgba(0,245,212,0.2), inset 0 0 12px rgba(0,245,212,0.08)'
              : '0 0 12px rgba(0,212,255,0.35), 0 0 24px rgba(0,212,255,0.1)';
          }}
        >
          {locating ? (
            /* Spinner while acquiring lock */
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none" style={{animation:'lf-spin 0.9s linear infinite'}}>
              <circle cx="14" cy="14" r="10" stroke={isTracking?'#00f5d4':'#00d4ff'} strokeWidth="2" strokeDasharray="22 14" strokeLinecap="round"/>
              <circle cx="14" cy="14" r="5" stroke={isTracking?'#00f5d4':'#00d4ff'} strokeWidth="1.5" strokeDasharray="10 6" strokeLinecap="round" opacity="0.5"/>
            </svg>
          ) : isTracking ? (
            /* Re-center icon when tracking */
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="3.5" fill="#00f5d4"/>
              <circle cx="12" cy="12" r="7" stroke="#00f5d4" strokeWidth="1.5" opacity="0.6"/>
              <path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="#00f5d4" strokeWidth="2" strokeLinecap="round"/>
              <circle cx="12" cy="12" r="10.5" stroke="#00f5d4" strokeWidth="1" strokeDasharray="3 3" opacity="0.35"/>
            </svg>
          ) : (
            /* GPS crosshair icon when idle */
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
              <path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="#00d4ff" strokeWidth="2" strokeLinecap="round"/>
              <circle cx="12" cy="12" r="7" stroke="#00d4ff" strokeWidth="1.5" opacity="0.7"/>
              <circle cx="12" cy="12" r="3" stroke="#00d4ff" strokeWidth="1.8"/>
              <circle cx="12" cy="12" r="1.2" fill="#00d4ff"/>
            </svg>
          )}
          {/* Ripple effect when active */}
          {isTracking && (
            <div style={{position:'absolute',inset:0,borderRadius:'50%',background:'rgba(0,245,212,0.06)',animation:'lf-ping 2.5s ease-in-out infinite'}}/>
          )}
        </button>

        {/* Heading badge */}
        {isTracking && userHeading !== null && (
          <div style={{
            fontFamily:'Orbitron,sans-serif',fontSize:'9px',
            color:'#00f5d488',letterSpacing:'0.1em',
            textAlign:'center',
          }}>
            {Math.round(userHeading)}°
          </div>
        )}
      </div>

      {/* ── Traffic Toggle Button ── */}
      <div style={{
        position:'absolute',bottom:'96px',right:'20px',
        zIndex:1000,display:'flex',flexDirection:'column',alignItems:'center',gap:'4px',
      }}>
        <button
          onClick={()=>setShowTraffic(v=>!v)}
          title={showTraffic?'إخفاء حركة المرور':'عرض حركة المرور'}
          style={{
            width:'52px',height:'52px',borderRadius:'50%',
            background: showTraffic ? 'rgba(255,149,0,0.18)' : 'rgba(5,8,15,0.92)',
            border: `2px solid ${showTraffic ? '#ff9500' : 'rgba(0,212,255,0.35)'}`,
            color: showTraffic ? '#ff9500' : '#00d4ff',
            cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',
            boxShadow: showTraffic
              ? '0 0 18px rgba(255,149,0,0.55), 0 0 36px rgba(255,149,0,0.2), inset 0 0 10px rgba(255,149,0,0.08)'
              : '0 0 12px rgba(0,212,255,0.35), 0 0 24px rgba(0,212,255,0.1)',
            backdropFilter:'blur(12px)',transition:'all 0.25s',position:'relative',
          }}
          onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.boxShadow = showTraffic?'0 0 24px rgba(255,149,0,0.7), 0 0 48px rgba(255,149,0,0.25)':'0 0 20px rgba(0,212,255,0.6), 0 0 40px rgba(0,212,255,0.2)';}}
          onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.boxShadow = showTraffic?'0 0 18px rgba(255,149,0,0.55), 0 0 36px rgba(255,149,0,0.2), inset 0 0 10px rgba(255,149,0,0.08)':'0 0 12px rgba(0,212,255,0.35), 0 0 24px rgba(0,212,255,0.1)';}}
        >
          {/* Traffic / road icon */}
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M12 2v20" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeDasharray="3 3"/>
            <rect x="3" y="4" width="18" height="3" rx="1.5" fill="currentColor" opacity="0.25"/>
            <rect x="3" y="10.5" width="18" height="3" rx="1.5" fill="currentColor" opacity="0.55"/>
            <rect x="3" y="17" width="18" height="3" rx="1.5" fill="currentColor" opacity="0.25"/>
            {showTraffic && <>
              <circle cx="6" cy="5.5" r="1.5" fill="#ff2d78"/>
              <circle cx="12" cy="12" r="1.5" fill="#f5c518"/>
              <circle cx="18" cy="18.5" r="1.5" fill="#00f5d4"/>
            </>}
          </svg>
          {showTraffic && (
            <div style={{position:'absolute',inset:0,borderRadius:'50%',background:'rgba(255,149,0,0.06)',animation:'lf-ping 2.5s ease-in-out infinite'}}/>
          )}
        </button>
        <div style={{fontFamily:'Orbitron,sans-serif',fontSize:'7px',color:showTraffic?'#ff9500':'rgba(0,212,255,0.5)',letterSpacing:'0.1em',textAlign:'center'}}>
          {showTraffic?'TRAFFIC':'TRAFFIC'}
        </div>
        {/* Traffic legend when active */}
        {showTraffic && (
          <div style={{
            marginTop:'4px',background:'rgba(5,8,15,0.94)',
            border:'1px solid rgba(255,149,0,0.3)',
            padding:'7px 10px',backdropFilter:'blur(10px)',
            display:'flex',flexDirection:'column',gap:'4px',
          }}>
            {[['#ff2d78','ازدحام شديد'],['#f5c518','معتدل'],['#00f5d4','سيّال']].map(([c,l])=>(
              <div key={l} style={{display:'flex',alignItems:'center',gap:'6px'}}>
                <div style={{width:'20px',height:'3px',background:c,borderRadius:'2px',boxShadow:`0 0 6px ${c}`}}/>
                <span style={{fontFamily:'Rajdhani,sans-serif',fontSize:'10px',color:'rgba(255,255,255,0.6)'}}>{l}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Route Loading ── */}
      {routeLoading && (
        <div style={{position:'absolute',top:'50%',left:'50%',transform:'translate(-50%,-50%)',zIndex:1000,background:'rgba(0,0,0,0.92)',border:'1px solid #f5c518',color:'#f5c518',fontSize:'12px',padding:'14px 24px',fontFamily:'Orbitron,sans-serif',letterSpacing:'0.1em',boxShadow:'0 0 28px #f5c51866',textAlign:'center'}}>
          <div style={{marginBottom:'5px'}}>CALCULATING ROUTE...</div>
          <div style={{fontSize:'10px',opacity:0.6}}>جاري حساب المسار</div>
        </div>
      )}

      {/* ── Route Info Banner ── */}
      {routeInfo && !routeLoading && (
        <div style={{position:'absolute',bottom:'96px',left:'50%',transform:'translateX(-50%)',zIndex:1000,background:'rgba(5,8,15,0.96)',border:'1px solid #f5c518',color:'#f5c518',padding:'10px 24px',fontFamily:'Orbitron,sans-serif',fontSize:'11px',letterSpacing:'0.1em',boxShadow:'0 0 24px #f5c51844',display:'flex',gap:'24px',alignItems:'center',backdropFilter:'blur(10px)'}}>
          <span>🛣️ {routeInfo.distanceKm.toFixed(1)} كم</span>
          <span>⏱ {Math.round(routeInfo.durationMin)} دقيقة</span>
        </div>
      )}

      {/* ── Taxi Prompt Banner (shown after bottom taxi button pressed) ── */}
      {showTaxiPrompt && taxiStep === 'idle' && (
        <div style={{
          position:'absolute',top:'14px',left:'50%',transform:'translateX(-50%)',
          zIndex:3000,display:'flex',justifyContent:'center',
          pointerEvents:'none',width:'100%',padding:'0 16px',boxSizing:'border-box',
        }}>
          <div style={{
            pointerEvents:'auto',
            background:'rgba(5,8,15,0.97)',
            border:'2px solid #f5c518',
            boxShadow:'0 0 30px rgba(245,197,24,0.35)',
            padding:'12px 18px',direction:'rtl',
            display:'flex',alignItems:'center',gap:'14px',
            maxWidth:'480px',width:'100%',backdropFilter:'blur(12px)',
          }}>
            <span style={{fontSize:'26px',flexShrink:0}}>🚕</span>
            <div style={{flex:1}}>
              <div style={{fontFamily:'Orbitron,sans-serif',fontSize:'8px',color:'rgba(245,197,24,0.7)',letterSpacing:'0.16em',marginBottom:'3px'}}>
                TAXI — اختر سائقاً
              </div>
              <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:'16px',fontWeight:700,color:'#f5f0d0'}}>
                انقر على أيقونة سائق تكسي في الخريطة لبدء الطلب
              </div>
            </div>
            <button
              onClick={()=>setShowTaxiPrompt(false)}
              style={{
                background:'none',border:'1px solid rgba(245,197,24,0.35)',
                color:'rgba(245,197,24,0.7)',fontFamily:'Orbitron,sans-serif',
                fontSize:'9px',letterSpacing:'0.1em',padding:'6px 10px',
                cursor:'pointer',flexShrink:0,transition:'all 0.2s',
              }}
              onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.background='rgba(245,197,24,0.12)';(e.currentTarget as HTMLElement).style.color='#f5c518';}}
              onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.background='none';(e.currentTarget as HTMLElement).style.color='rgba(245,197,24,0.7)';}}
            >إلغاء</button>
          </div>
        </div>
      )}

      {/* ── Taxi Routing HUD (pick-from / pick-to steps) ── */}
      {(taxiStep === 'pick-from' || taxiStep === 'pick-to') && taxiDriverItem && (
        <div style={{position:'absolute',top:0,left:0,right:0,zIndex:3000,display:'flex',justifyContent:'center',padding:'14px 16px 0',pointerEvents:'none'}}>
          <div style={{
            pointerEvents:'auto',background:'rgba(5,8,15,0.97)',
            border:`1px solid ${taxiStep==='pick-from'?'#00f5d4':'#ff2d78'}`,
            boxShadow:`0 0 30px ${taxiStep==='pick-from'?'rgba(0,245,212,0.25)':'rgba(255,45,120,0.25)'}`,
            padding:'12px 18px',direction:'rtl',display:'flex',alignItems:'center',gap:'14px',
            maxWidth:'480px',width:'100%',backdropFilter:'blur(10px)',
          }}>
            {/* Step indicator */}
            <div style={{
              width:'36px',height:'36px',borderRadius:'50%',flexShrink:0,
              background: taxiStep==='pick-from'?'rgba(0,245,212,0.12)':'rgba(255,45,120,0.12)',
              border:`2px solid ${taxiStep==='pick-from'?'#00f5d4':'#ff2d78'}`,
              display:'flex',alignItems:'center',justifyContent:'center',
              fontFamily:'Orbitron,sans-serif',fontSize:'14px',fontWeight:900,
              color: taxiStep==='pick-from'?'#00f5d4':'#ff2d78',
            }}>
              {taxiStep==='pick-from'?'A':'B'}
            </div>
            <div style={{flex:1,minWidth:0}}>
              {/* "Found driver" badge shown during pick-to after auto-search */}
              {taxiStep==='pick-to' && taxiFoundSnack && (
                <div style={{
                  display:'inline-flex',alignItems:'center',gap:'5px',
                  marginBottom:'4px',padding:'3px 9px',
                  background:'rgba(0,245,212,0.12)',border:'1px solid rgba(0,245,212,0.45)',
                  boxShadow:'0 0 10px rgba(0,245,212,0.18)',
                }}>
                  <span style={{fontSize:'11px'}}>✅</span>
                  <span style={{fontFamily:'Rajdhani,sans-serif',fontSize:'11.5px',fontWeight:700,color:'#00f5d4'}}>
                    تم العثور على أقرب سائق لك، حدد وجهتك الآن
                  </span>
                </div>
              )}
              <div style={{fontFamily:'Orbitron,sans-serif',fontSize:'8px',color:'rgba(255,255,255,0.35)',letterSpacing:'0.15em',marginBottom:'3px'}}>
                {taxiStep==='pick-from'?'STEP 1 / 2':'STEP 2 / 2'} · {taxiDriverItem.name}
              </div>
              {taxiStep==='pick-from' ? (
                taxiFromPlaced ? (
                  /* A marker placed — show drag hint + confirm button */
                  <div style={{display:'flex',alignItems:'center',gap:'10px',flexWrap:'wrap'}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:'13px',fontWeight:700,color:'#00f5d4',lineHeight:1.35}}>
                        اسحب الدبوس لوضعه فوق باب منزلك بالضبط
                      </div>
                      <div style={{fontFamily:'Orbitron,sans-serif',fontSize:'7.5px',color:'rgba(0,245,212,0.5)',letterSpacing:'0.1em',marginTop:'2px'}}>
                        أو انقر موقعاً آخر على الخريطة
                      </div>
                    </div>
                    <button
                      onClick={confirmTaxiFrom}
                      style={{
                        flexShrink:0,padding:'7px 14px',
                        background:'rgba(0,245,212,0.18)',
                        border:'1.5px solid #00f5d4',
                        color:'#00f5d4',
                        fontFamily:'Orbitron,sans-serif',fontSize:'8.5px',
                        letterSpacing:'0.1em',cursor:'pointer',
                        boxShadow:'0 0 12px rgba(0,245,212,0.25)',
                        transition:'all 0.18s',whiteSpace:'nowrap',
                      }}
                      onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.background='rgba(0,245,212,0.3)';}}
                      onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.background='rgba(0,245,212,0.18)';}}
                    >✓ تأكيد الموقع</button>
                  </div>
                ) : (
                  /* GPS not yet acquired — locating spinner */
                  <div style={{display:'flex',alignItems:'center',gap:'8px'}}>
                    <svg width="14" height="14" viewBox="0 0 28 28" fill="none" style={{animation:'lf-spin 0.9s linear infinite',flexShrink:0}}>
                      <circle cx="14" cy="14" r="10" stroke="#00f5d4" strokeWidth="2.5" strokeDasharray="22 14" strokeLinecap="round"/>
                    </svg>
                    <span style={{fontFamily:'Rajdhani,sans-serif',fontSize:'14px',color:'rgba(0,245,212,0.8)'}}>
                      جاري تحديد موقعك...
                    </span>
                  </div>
                )
              ) : taxiDestName ? (
                /* Destination chosen — show name */
                <div style={{display:'flex',alignItems:'center',gap:'6px'}}>
                  <div style={{fontFamily:'Orbitron,sans-serif',fontSize:'7px',color:'rgba(255,45,120,0.6)',letterSpacing:'0.12em',flexShrink:0}}>DEST</div>
                  <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:'15px',fontWeight:700,color:'#ff2d78',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                    {taxiDestName}
                  </div>
                </div>
              ) : poiLoading ? (
                /* Loading POIs */
                <div style={{display:'flex',alignItems:'center',gap:'8px'}}>
                  <svg width="14" height="14" viewBox="0 0 28 28" fill="none" style={{animation:'lf-spin 0.9s linear infinite',flexShrink:0}}>
                    <circle cx="14" cy="14" r="10" stroke="#ff2d78" strokeWidth="2.5" strokeDasharray="22 14" strokeLinecap="round"/>
                  </svg>
                  <span style={{fontFamily:'Rajdhani,sans-serif',fontSize:'14px',color:'rgba(255,45,120,0.7)'}}>
                    جاري تحميل المعالم...
                  </span>
                </div>
              ) : (
                <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:'15px',fontWeight:700,color:'#ff2d78'}}>
                  اضغط على معلم أو موقع في الخريطة
                </div>
              )}
            </div>
            <button
              onClick={closeTaxiRouting}
              style={{background:'none',border:'1px solid rgba(255,45,120,0.3)',color:'rgba(255,45,120,0.7)',fontFamily:'Orbitron,sans-serif',fontSize:'8px',letterSpacing:'0.1em',padding:'6px 10px',cursor:'pointer',flexShrink:0,transition:'all 0.2s'}}
              onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.background='rgba(255,45,120,0.12)';(e.currentTarget as HTMLElement).style.color='#ff2d78';}}
              onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.background='none';(e.currentTarget as HTMLElement).style.color='rgba(255,45,120,0.7)';}}
            >إلغاء</button>
          </div>
        </div>
      )}

      {/* ── Taxi Confirm Panel (after both points picked) ── */}
      {taxiStep === 'confirm' && taxiDriverItem && (
        <div style={{
          position:'absolute',inset:0,zIndex:3000,
          display:'flex',alignItems:'flex-end',justifyContent:'center',
          background:'rgba(2,4,10,0.55)',backdropFilter:'blur(3px)',
        }}>
          <div style={{
            width:'min(460px,100vw)',background:'rgba(5,8,15,0.99)',
            border:'1px solid #7b2ff7',borderBottom:'none',
            boxShadow:'0 -4px 60px rgba(123,47,247,0.3)',
            direction:'rtl',
          }}>
            {taxiSuccess ? (
              <div style={{padding:'32px 20px',textAlign:'center'}}>
                <div style={{fontSize:'40px',marginBottom:'10px'}}>✅</div>
                <div style={{fontFamily:'Orbitron,sans-serif',fontSize:'12px',color:'#00f5d4',letterSpacing:'0.15em',marginBottom:'6px'}}>تم إرسال الطلب بنجاح!</div>
                <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:'15px',color:'rgba(255,255,255,0.5)'}}>سيتواصل معك السائق قريباً</div>
              </div>
            ) : (
              <>
                {/* Header row */}
                <div style={{padding:'14px 18px 12px',borderBottom:'1px solid rgba(123,47,247,0.15)',display:'flex',alignItems:'center',justifyContent:'space-between',background:'rgba(123,47,247,0.05)'}}>
                  <div>
                    <div style={{fontFamily:'Orbitron,sans-serif',fontSize:'8px',color:'rgba(123,47,247,0.8)',letterSpacing:'0.18em',marginBottom:'3px'}}>🚕 TAXI ORDER · {taxiDriverItem.name}</div>
                    <div style={{display:'flex',alignItems:'center',gap:'12px'}}>
                      {/* Route summary badges */}
                      <div style={{display:'flex',alignItems:'center',gap:'6px'}}>
                        <span style={{width:'18px',height:'18px',borderRadius:'50%',background:'rgba(0,245,212,0.15)',border:'1.5px solid #00f5d4',display:'inline-flex',alignItems:'center',justifyContent:'center',fontSize:'9px',fontWeight:900,color:'#00f5d4',fontFamily:'Orbitron,sans-serif'}}>A</span>
                        <svg width="20" height="8" viewBox="0 0 20 8" fill="none"><path d="M0 4h16M13 1l3 3-3 3" stroke="#7b2ff7" strokeWidth="1.5" strokeLinecap="round"/></svg>
                        <span style={{width:'18px',height:'18px',borderRadius:'50%',background:'rgba(255,45,120,0.15)',border:'1.5px solid #ff2d78',display:'inline-flex',alignItems:'center',justifyContent:'center',fontSize:'9px',fontWeight:900,color:'#ff2d78',fontFamily:'Orbitron,sans-serif'}}>B</span>
                      </div>
                      <span style={{fontFamily:'Rajdhani,sans-serif',fontSize:'14px',color:'rgba(255,255,255,0.5)'}}>
                        {taxiRouteLoading
                          ? <span style={{color:'rgba(245,197,24,0.5)',fontSize:'12px'}}>جاري الحساب...</span>
                          : taxiDistKm !== null ? `${taxiDistKm.toFixed(2)} كم` : ''}
                      </span>
                    </div>
                  </div>
                  {/* Price badge */}
                  <div style={{textAlign:'center',background:'rgba(245,197,24,0.1)',border:`1px solid ${taxiRouteLoading?'rgba(245,197,24,0.2)':'rgba(245,197,24,0.4)'}`,padding:'6px 12px',minWidth:'100px',transition:'border-color 0.3s'}}>
                    <div style={{fontFamily:'Orbitron,sans-serif',fontSize:'7px',color:'rgba(245,197,24,0.7)',letterSpacing:'0.12em',marginBottom:'2px'}}>التكلفة التقديرية</div>
                    {taxiRouteLoading ? (
                      <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:'6px',padding:'2px 0'}}>
                        <svg width="14" height="14" viewBox="0 0 28 28" fill="none" style={{animation:'lf-spin 0.9s linear infinite'}}><circle cx="14" cy="14" r="10" stroke="#f5c518" strokeWidth="2" strokeDasharray="22 14" strokeLinecap="round"/></svg>
                        <span style={{fontFamily:'Orbitron,sans-serif',fontSize:'8px',color:'rgba(245,197,24,0.5)',letterSpacing:'0.08em'}}>جاري الحساب...</span>
                      </div>
                    ) : (
                      <div style={{fontFamily:'Orbitron,sans-serif',fontSize:'16px',color:'#f5c518',fontWeight:900}}>
                        {taxiEstPrice !== null ? taxiEstPrice.toLocaleString() : '—'}
                      </div>
                    )}
                    <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:'10px',color:'rgba(245,197,24,0.55)'}}>
                      {taxiDistKm !== null && !taxiRouteLoading
                        ? `${taxiDistKm.toFixed(2)} كم × 750 = د.ع`
                        : 'دينار عراقي'}
                    </div>
                  </div>
                </div>

                {/* Form */}
                <div style={{padding:'16px 18px'}}>
                  <div style={{display:'flex',gap:'12px',marginBottom:'14px'}}>
                    {/* Name */}
                    <div style={{flex:1}}>
                      <label style={{display:'block',fontFamily:'Orbitron,sans-serif',fontSize:'7px',color:'rgba(123,47,247,0.6)',letterSpacing:'0.14em',marginBottom:'6px'}}>الاسم</label>
                      <input
                        type="text"
                        value={taxiUserName}
                        onChange={e=>{setTaxiUserName(e.target.value);setTaxiError(null);}}
                        placeholder="اسمك..."
                        disabled={taxiLoading}
                        style={{width:'100%',background:'rgba(123,47,247,0.07)',border:'1px solid rgba(123,47,247,0.3)',color:'#e8f8f5',fontFamily:'Rajdhani,sans-serif',fontSize:'15px',padding:'9px 11px',outline:'none',boxSizing:'border-box',transition:'border-color 0.2s'}}
                        onFocus={e=>(e.currentTarget.style.borderColor='#7b2ff7')}
                        onBlur={e=>(e.currentTarget.style.borderColor='rgba(123,47,247,0.3)')}
                      />
                    </div>
                    {/* Phone */}
                    <div style={{flex:1}}>
                      <label style={{display:'block',fontFamily:'Orbitron,sans-serif',fontSize:'7px',color:'rgba(123,47,247,0.6)',letterSpacing:'0.14em',marginBottom:'6px'}}>رقم الهاتف</label>
                      <input
                        type="tel"
                        value={taxiUserPhone}
                        onChange={e=>{setTaxiUserPhone(e.target.value);setTaxiError(null);}}
                        placeholder="07XX XXX XXXX"
                        disabled={taxiLoading}
                        style={{width:'100%',background:'rgba(123,47,247,0.07)',border:'1px solid rgba(123,47,247,0.3)',color:'#e8f8f5',fontFamily:'Rajdhani,sans-serif',fontSize:'15px',padding:'9px 11px',outline:'none',boxSizing:'border-box',transition:'border-color 0.2s'}}
                        onFocus={e=>(e.currentTarget.style.borderColor='#7b2ff7')}
                        onBlur={e=>(e.currentTarget.style.borderColor='rgba(123,47,247,0.3)')}
                      />
                    </div>
                  </div>

                  {taxiError && (
                    <div style={{marginBottom:'12px',padding:'8px 12px',background:'rgba(255,45,120,0.08)',border:'1px solid rgba(255,45,120,0.3)',color:'#ff2d78',fontFamily:'Rajdhani,sans-serif',fontSize:'13px'}}>
                      ⚠ {taxiError}
                    </div>
                  )}

                  <div style={{display:'flex',gap:'10px'}}>
                    <button
                      onClick={closeTaxiRouting}
                      disabled={taxiLoading}
                      style={{flex:'0 0 auto',padding:'12px 16px',background:'transparent',border:'1px solid rgba(255,45,120,0.3)',color:'rgba(255,45,120,0.7)',fontFamily:'Orbitron,sans-serif',fontSize:'9px',letterSpacing:'0.1em',cursor:'pointer',transition:'all 0.2s'}}
                      onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.background='rgba(255,45,120,0.1)';}}
                      onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.background='transparent';}}
                    >إلغاء</button>
                    <button
                      onClick={submitTaxiOrder}
                      disabled={taxiLoading || taxiRouteLoading}
                      style={{
                        flex:1,padding:'13px',
                        background:(taxiLoading||taxiRouteLoading)?'rgba(123,47,247,0.06)':'rgba(123,47,247,0.18)',
                        border:'1px solid #7b2ff7',color:'#c77dff',
                        fontFamily:'Orbitron,sans-serif',fontSize:'10px',letterSpacing:'0.12em',
                        cursor:(taxiLoading||taxiRouteLoading)?'not-allowed':'pointer',
                        boxShadow:(taxiLoading||taxiRouteLoading)?'none':'0 0 22px rgba(123,47,247,0.3)',
                        transition:'all 0.2s',display:'flex',alignItems:'center',justifyContent:'center',gap:'8px',
                      }}
                      onMouseEnter={e=>{if(!taxiLoading&&!taxiRouteLoading)(e.currentTarget as HTMLElement).style.background='rgba(123,47,247,0.3)';}}
                      onMouseLeave={e=>{if(!taxiLoading&&!taxiRouteLoading)(e.currentTarget as HTMLElement).style.background='rgba(123,47,247,0.18)';}}
                    >
                      {taxiLoading
                        ? <><svg width="14" height="14" viewBox="0 0 28 28" fill="none" style={{animation:'lf-spin 0.9s linear infinite'}}><circle cx="14" cy="14" r="10" stroke="#c77dff" strokeWidth="2" strokeDasharray="22 14" strokeLinecap="round"/></svg>جاري الإرسال...</>
                        : taxiRouteLoading
                          ? <><svg width="14" height="14" viewBox="0 0 28 28" fill="none" style={{animation:'lf-spin 0.9s linear infinite'}}><circle cx="14" cy="14" r="10" stroke="#f5c518" strokeWidth="2" strokeDasharray="22 14" strokeLinecap="round"/></svg>جاري رسم المسار...</>
                          : <>✓ تأكيد وإرسال الطلب</>
                      }
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Active Order: Driver Status Bar ── */}
      {activeOrderId && (
        <div style={{
          position:'absolute',top:0,left:0,right:0,zIndex:3500,
          display:'flex',justifyContent:'center',padding:'10px 16px 0',
          pointerEvents:'none',
        }}>
          <div style={{
            pointerEvents:'auto',
            background:'rgba(5,8,15,0.97)',
            border:`1px solid ${
              activeOrderStatus==='pending'   ? 'rgba(245,197,24,0.6)'  :
              activeOrderStatus==='accepted'  ? '#00f5d4'               :
              activeOrderStatus==='driving'   ? '#00f5d4'               :
              activeOrderStatus==='done'      ? '#00f5d4'               :
              'rgba(255,45,120,0.5)'
            }`,
            boxShadow:`0 0 28px ${
              activeOrderStatus==='pending' ? 'rgba(245,197,24,0.2)' :
              activeOrderStatus==='done'    ? 'rgba(0,245,212,0.15)' :
              'rgba(0,212,255,0.2)'
            }`,
            padding:'10px 18px',direction:'rtl',
            display:'flex',alignItems:'center',gap:'14px',
            maxWidth:'520px',width:'100%',backdropFilter:'blur(12px)',
          }}>
            {/* Status dot pulse */}
            <div style={{
              width:'10px',height:'10px',borderRadius:'50%',flexShrink:0,
              background: activeOrderStatus==='pending' ? '#f5c518' : activeOrderStatus==='done' ? '#00f5d4' : '#00f5d4',
              boxShadow: `0 0 10px ${activeOrderStatus==='pending'?'#f5c518':'#00f5d4'}`,
              animation: activeOrderStatus==='done' ? 'none' : 'lf-ping 1.8s cubic-bezier(0,0,0.2,1) infinite',
            }}/>

            {/* Text */}
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontFamily:'Orbitron,sans-serif',fontSize:'8px',color:'rgba(255,255,255,0.3)',letterSpacing:'0.15em',marginBottom:'2px'}}>
                ORDER #{activeOrderId}
              </div>
              <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:'15px',fontWeight:700,color:'#e8f8f5',lineHeight:1.2}}>
                {activeOrderStatus==='pending'    && 'في انتظار قبول السائق...'}
                {activeOrderStatus==='accepted'   && '🚕 السائق في الطريق إليك'}
                {activeOrderStatus==='driving'    && '🚕 السائق في الطريق إليك'}
                {activeOrderStatus==='done'       && '✅ وصل السائق — شكراً!'}
                {activeOrderStatus==='cancelled'  && '❌ تم إلغاء الطلب'}
              </div>
              {/* Distance + ETA row */}
              {(activeOrderStatus==='accepted'||activeOrderStatus==='driving') && driverDistKm !== null && (
                <div style={{display:'flex',gap:'14px',marginTop:'4px'}}>
                  <span style={{fontFamily:'Rajdhani,sans-serif',fontSize:'12px',color:'#00d4ff'}}>
                    📍 {driverDistKm.toFixed(2)} كم
                  </span>
                  {driverEtaMin !== null && (
                    <span style={{fontFamily:'Rajdhani,sans-serif',fontSize:'12px',color:'#00f5d4'}}>
                      ⏱ ~{driverEtaMin} دقيقة
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Chat toggle button */}
            {activeOrderId && activeOrderStatus !== 'done' && activeOrderStatus !== 'cancelled' && (
              <button
                onClick={()=>setShowChat(v=>!v)}
                style={{
                  background: showChat ? 'rgba(123,47,247,0.25)' : 'rgba(123,47,247,0.1)',
                  border:'1px solid rgba(123,47,247,0.5)',
                  color:'#c77dff',fontFamily:'Orbitron,sans-serif',fontSize:'8px',
                  letterSpacing:'0.1em',padding:'6px 10px',cursor:'pointer',
                  flexShrink:0,transition:'all 0.2s',
                  boxShadow: showChat ? '0 0 14px rgba(123,47,247,0.3)' : 'none',
                }}
                onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.background='rgba(123,47,247,0.3)';}}
                onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.background=showChat?'rgba(123,47,247,0.25)':'rgba(123,47,247,0.1)';}}
              >
                💬 دردشة
              </button>
            )}

            {/* Cancel / close tracking */}
            <button
              onClick={stopOrderTracking}
              style={{
                background:'none',border:'1px solid rgba(255,45,120,0.3)',
                color:'rgba(255,45,120,0.6)',fontFamily:'Orbitron,sans-serif',
                fontSize:'8px',letterSpacing:'0.1em',padding:'6px 10px',
                cursor:'pointer',flexShrink:0,transition:'all 0.2s',
              }}
              onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.background='rgba(255,45,120,0.1)';(e.currentTarget as HTMLElement).style.color='#ff2d78';}}
              onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.background='none';(e.currentTarget as HTMLElement).style.color='rgba(255,45,120,0.6)';}}
            >✕</button>
          </div>
        </div>
      )}

      {/* ── System-message Snackbar (shown when chat is closed) ── */}
      {sysMsgSnack && (
        <div style={{
          position:'absolute', top:'72px', left:'50%', transform:'translateX(-50%)',
          zIndex:5000, direction:'rtl',
          display:'flex', alignItems:'center', gap:'12px',
          padding:'11px 18px',
          background:'linear-gradient(135deg,rgba(245,197,24,0.14),rgba(255,150,0,0.1))',
          border:'1px solid rgba(245,197,24,0.7)',
          borderTop:'3px solid #f5c518',
          boxShadow:'0 4px 40px rgba(245,197,24,0.3), 0 0 0 1px rgba(245,197,24,0.1)',
          backdropFilter:'blur(16px)',
          maxWidth:'min(380px,90vw)',
          animation:'sys-snack-in 0.35s cubic-bezier(0.34,1.56,0.64,1)',
        }}>
          <style>{`
            @keyframes sys-snack-in {
              from { opacity:0; transform:translateX(-50%) translateY(-16px) scale(0.94); }
              to   { opacity:1; transform:translateX(-50%) translateY(0) scale(1); }
            }
          `}</style>
          {/* Bell icon */}
          <div style={{
            flexShrink:0, width:'32px', height:'32px',
            border:'1px solid rgba(245,197,24,0.5)', borderRadius:'50%',
            display:'flex', alignItems:'center', justifyContent:'center',
            background:'rgba(245,197,24,0.12)',
            boxShadow:'0 0 12px rgba(245,197,24,0.3)',
          }}>
            <span style={{fontSize:'15px', lineHeight:1}}>🔔</span>
          </div>
          {/* Text */}
          <div style={{flex:1, minWidth:0}}>
            <div style={{fontFamily:'Orbitron,sans-serif',fontSize:'8px',color:'rgba(245,197,24,0.7)',letterSpacing:'0.18em',marginBottom:'3px'}}>
              تنبيه · SYSTEM ALERT
            </div>
            <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:'14px',fontWeight:600,color:'#ffe08a',lineHeight:1.3}}>
              {sysMsgSnack}
            </div>
          </div>
          {/* Open chat button */}
          <button onClick={()=>{ setShowChat(true); setSysMsgSnack(null); if(sysMsgTimerRef.current) clearTimeout(sysMsgTimerRef.current); }}
            style={{
              flexShrink:0, padding:'6px 11px',
              background:'rgba(245,197,24,0.2)', border:'1px solid rgba(245,197,24,0.6)',
              color:'#f5c518', fontFamily:'Orbitron,sans-serif',
              fontSize:'8px', letterSpacing:'0.1em', cursor:'pointer',
              whiteSpace:'nowrap',
            }}>
            فتح الدردشة
          </button>
          {/* Dismiss */}
          <button onClick={()=>{ setSysMsgSnack(null); if(sysMsgTimerRef.current) clearTimeout(sysMsgTimerRef.current); }}
            style={{flexShrink:0,background:'none',border:'none',color:'rgba(245,197,24,0.5)',fontSize:'14px',cursor:'pointer',padding:'2px 4px',lineHeight:1}}>
            ✕
          </button>
        </div>
      )}

      {/* ── Auto-search Loading Banner ── */}
      {taxiAutoSearching && (
        <div style={{
          position:'absolute', top:'14px', left:'50%', transform:'translateX(-50%)',
          zIndex:5002, direction:'rtl',
          display:'flex', alignItems:'center', gap:'12px',
          padding:'12px 20px',
          background:'rgba(5,8,15,0.97)',
          border:'2px solid rgba(123,47,247,0.7)',
          boxShadow:'0 0 30px rgba(123,47,247,0.3)',
          backdropFilter:'blur(16px)',
          maxWidth:'min(380px,90vw)',
        }}>
          <svg width="18" height="18" viewBox="0 0 28 28" fill="none" style={{animation:'lf-spin 0.9s linear infinite',flexShrink:0}}>
            <circle cx="14" cy="14" r="10" stroke="#7b2ff7" strokeWidth="2.5" strokeDasharray="22 14" strokeLinecap="round"/>
          </svg>
          <div>
            <div style={{fontFamily:'Orbitron,sans-serif',fontSize:'7.5px',color:'rgba(123,47,247,0.8)',letterSpacing:'0.18em',marginBottom:'2px'}}>
              SEARCHING · جاري البحث
            </div>
            <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:'14px',fontWeight:600,color:'#c4b5fd'}}>
              جاري البحث عن أقرب سائق متاح...
            </div>
          </div>
        </div>
      )}

      {/* ── No-driver Snackbar ── */}
      {taxiNoDriverSnack && (
        <div style={{
          position:'absolute', top:'72px', left:'50%', transform:'translateX(-50%)',
          zIndex:5002, direction:'rtl',
          display:'flex', alignItems:'center', gap:'12px',
          padding:'11px 18px',
          background:'linear-gradient(135deg,rgba(255,45,120,0.15),rgba(5,8,15,0.97))',
          border:'1px solid rgba(255,45,120,0.7)',
          borderTop:'3px solid #ff2d78',
          boxShadow:'0 4px 40px rgba(255,45,120,0.3)',
          backdropFilter:'blur(16px)',
          maxWidth:'min(420px,92vw)',
          animation:'sys-snack-in 0.35s cubic-bezier(0.34,1.56,0.64,1)',
        }}>
          <div style={{
            flexShrink:0,width:'34px',height:'34px',border:'1px solid rgba(255,45,120,0.5)',borderRadius:'50%',
            display:'flex',alignItems:'center',justifyContent:'center',
            background:'rgba(255,45,120,0.12)',boxShadow:'0 0 12px rgba(255,45,120,0.3)',
            fontSize:'17px',lineHeight:1,
          }}>😔</div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontFamily:'Orbitron,sans-serif',fontSize:'7.5px',color:'rgba(255,45,120,0.8)',letterSpacing:'0.18em',marginBottom:'3px'}}>
              لا يوجد سائقون · NO DRIVERS
            </div>
            <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:'14px',fontWeight:600,color:'#ffa0c0',lineHeight:1.35}}>
              نعتذر، لا يوجد سائقون متاحون حالياً في منطقتك
            </div>
          </div>
          <button onClick={()=> setTaxiNoDriverSnack(false)}
            style={{flexShrink:0,background:'none',border:'none',color:'rgba(255,45,120,0.5)',fontSize:'15px',cursor:'pointer',padding:'2px 4px',lineHeight:1}}>
            ✕
          </button>
        </div>
      )}

      {/* ── Block-taxi Snackbar (shown when user tries to order while having active trip) ── */}
      {blockTaxiMsg && (
        <div style={{
          position:'absolute', top:'72px', left:'50%', transform:'translateX(-50%)',
          zIndex:5001, direction:'rtl',
          display:'flex', alignItems:'center', gap:'12px',
          padding:'11px 18px',
          background:'linear-gradient(135deg,rgba(255,45,120,0.15),rgba(123,47,247,0.12))',
          border:'1px solid rgba(255,45,120,0.7)',
          borderTop:'3px solid #ff2d78',
          boxShadow:'0 4px 40px rgba(255,45,120,0.3), 0 0 0 1px rgba(255,45,120,0.1)',
          backdropFilter:'blur(16px)',
          maxWidth:'min(380px,90vw)',
          animation:'sys-snack-in 0.35s cubic-bezier(0.34,1.56,0.64,1)',
          whiteSpace:'nowrap',
        }}>
          <div style={{
            flexShrink:0, width:'32px', height:'32px',
            border:'1px solid rgba(255,45,120,0.5)', borderRadius:'50%',
            display:'flex', alignItems:'center', justifyContent:'center',
            background:'rgba(255,45,120,0.12)',
            boxShadow:'0 0 12px rgba(255,45,120,0.3)',
            fontSize:'16px', lineHeight:1,
          }}>🔒</div>
          <div style={{flex:1, minWidth:0}}>
            <div style={{fontFamily:'Orbitron,sans-serif',fontSize:'8px',color:'rgba(255,45,120,0.8)',letterSpacing:'0.18em',marginBottom:'3px'}}>
              رحلة نشطة · ACTIVE TRIP
            </div>
            <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:'14px',fontWeight:600,color:'#ffa0c0',lineHeight:1.3}}>
              لديك رحلة نشطة حالياً — أكمل رحلتك الحالية أولاً
            </div>
          </div>
          <button onClick={()=>{ setBlockTaxiMsg(false); if(blockTaxiTimerRef.current) clearTimeout(blockTaxiTimerRef.current); }}
            style={{flexShrink:0,background:'none',border:'none',color:'rgba(255,45,120,0.5)',fontSize:'14px',cursor:'pointer',padding:'2px 4px',lineHeight:1}}>
            ✕
          </button>
        </div>
      )}

      {/* ── Chat Overlay ── */}
      {showChat && activeOrderId && activeOrderStatus !== 'done' && activeOrderStatus !== 'finished' && activeOrderStatus !== 'cancelled' && (
        <ChatOverlay
          orderId={activeOrderId}
          driverPhone={activeDriverPhone}
          onClose={()=>setShowChat(false)}
          onSystemMsg={(content)=>{
            if (!showChat) {
              // Chat is closed — show snackbar
              if (sysMsgTimerRef.current) clearTimeout(sysMsgTimerRef.current);
              setSysMsgSnack(content);
              sysMsgTimerRef.current = setTimeout(()=> setSysMsgSnack(null), 7000);
            }
          }}
        />
      )}

      {/* ── Rating Dialog (auto-pops after ride finishes) ── */}
      {showRating && (
        <RatingDialog
          orderId={ratingOrderId}
          driverId={ratingDriverId || activeDriverId}
          customerName={ratingCustomerName}
          onClose={()=>{
            setShowRating(false);
            stopOrderTracking();
          }}
        />
      )}

      {/* ── Legend ── */}
      {categories.length > 0 && (
        <div style={{position:'absolute',bottom:'96px',left:'92px',zIndex:1000,background:'rgba(5,8,15,0.88)',border:'1px solid rgba(255,255,255,0.07)',padding:'10px 14px',backdropFilter:'blur(10px)',minWidth:'150px'}}>
          <div style={{fontFamily:'Orbitron,sans-serif',fontSize:'9px',color:'rgba(255,255,255,0.3)',letterSpacing:'0.15em',marginBottom:'8px'}}>LEGEND</div>
          {categories.map(cat=>(
            <div key={cat.slug} style={{display:'flex',alignItems:'center',gap:'8px',marginBottom:'5px',cursor:'pointer'}} onClick={()=>onFilterChange(cat.slug)}>
              <div style={{width:'8px',height:'8px',borderRadius:'50%',background:cat.color,boxShadow:`0 0 6px ${cat.color}`,flexShrink:0}}/>
              <span style={{fontFamily:'Rajdhani,sans-serif',fontSize:'12px',color:activeFilter===cat.slug?cat.color:'rgba(255,255,255,0.55)',transition:'color 0.2s'}}>
                {cat.icon} {cat.labelAr}
              </span>
            </div>
          ))}
          <div style={{display:'flex',alignItems:'center',gap:'8px',marginTop:'6px',paddingTop:'6px',borderTop:'1px solid rgba(255,255,255,0.07)'}}>
            <div style={{width:'8px',height:'8px',borderRadius:'50%',background:'#f5c518',boxShadow:'0 0 6px #f5c518',flexShrink:0}}/>
            <span style={{fontFamily:'Rajdhani,sans-serif',fontSize:'12px',color:'rgba(255,255,255,0.45)'}}>موقعك / المسار</span>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          ── Selected Place Panel (slides up above bottom bar) ─────────────
          ══════════════════════════════════════════════════════════════════ */}
      {selectedPlace && (
        <div style={{
          position:'absolute', bottom:'80px', left:0, right:0, zIndex:1010,
          background:'rgba(5,8,15,0.98)',
          borderTop:'2px solid #00d4ff',
          boxShadow:'0 -6px 40px rgba(0,212,255,0.25)',
          backdropFilter:'blur(16px)',
          direction:'rtl',
        }}>
          {/* Title row */}
          <div style={{
            display:'flex',alignItems:'center',gap:'12px',
            padding:'12px 16px 8px',
            borderBottom:'1px solid rgba(0,212,255,0.12)',
          }}>
            <div style={{
              width:'40px',height:'40px',borderRadius:'50%',flexShrink:0,
              background:'rgba(0,212,255,0.1)',border:'2px solid #00d4ff44',
              display:'flex',alignItems:'center',justifyContent:'center',fontSize:'20px',
            }}>🌐</div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontFamily:'Orbitron,sans-serif',fontSize:'7px',color:'rgba(0,212,255,0.55)',letterSpacing:'0.18em',marginBottom:'3px'}}>
                DESTINATION
              </div>
              <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:'16px',fontWeight:700,color:'#00d4ff',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                {selectedPlace.name}
              </div>
              {selectedPlace.addr && (
                <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:'11px',color:'rgba(0,212,255,0.45)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                  {selectedPlace.addr}
                </div>
              )}
            </div>
            <button onClick={clearSelectedPlace} style={{
              background:'none',border:'1px solid rgba(255,45,120,0.3)',
              color:'rgba(255,45,120,0.6)',fontFamily:'Orbitron,sans-serif',
              fontSize:'10px',padding:'6px 10px',cursor:'pointer',flexShrink:0,
              transition:'all 0.2s',
            }}
            onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.background='rgba(255,45,120,0.1)';(e.currentTarget as HTMLElement).style.color='#ff2d78';}}
            onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.background='none';(e.currentTarget as HTMLElement).style.color='rgba(255,45,120,0.6)';}}
            >✕</button>
          </div>

          {/* Route info row (shown after goToPlace) */}
          {placeRouteInfo && (
            <div style={{
              display:'flex',alignItems:'center',gap:'0',
              borderBottom:'1px solid rgba(0,212,255,0.1)',
            }}>
              <div style={{flex:1,textAlign:'center',padding:'8px 12px',borderRight:'1px solid rgba(0,212,255,0.1)'}}>
                <div style={{fontFamily:'Orbitron,sans-serif',fontSize:'7px',color:'rgba(0,212,255,0.5)',letterSpacing:'0.12em',marginBottom:'2px'}}>المسافة</div>
                <div style={{fontFamily:'Orbitron,sans-serif',fontSize:'15px',color:'#00d4ff',fontWeight:900}}>
                  {placeRouteInfo.distanceKm.toFixed(1)} <span style={{fontSize:'9px',opacity:0.7}}>كم</span>
                </div>
              </div>
              <div style={{flex:1,textAlign:'center',padding:'8px 12px',borderRight:'1px solid rgba(0,212,255,0.1)'}}>
                <div style={{fontFamily:'Orbitron,sans-serif',fontSize:'7px',color:'rgba(0,212,255,0.5)',letterSpacing:'0.12em',marginBottom:'2px'}}>الوقت</div>
                <div style={{fontFamily:'Orbitron,sans-serif',fontSize:'15px',color:'#00f5d4',fontWeight:900}}>
                  {Math.round(placeRouteInfo.durationMin)} <span style={{fontSize:'9px',opacity:0.7}}>دقيقة</span>
                </div>
              </div>
              <div style={{flex:1,textAlign:'center',padding:'8px 12px'}}>
                <div style={{fontFamily:'Orbitron,sans-serif',fontSize:'7px',color:'rgba(245,197,24,0.6)',letterSpacing:'0.12em',marginBottom:'2px'}}>التكلفة التقديرية</div>
                <div style={{fontFamily:'Orbitron,sans-serif',fontSize:'15px',color:'#f5c518',fontWeight:900}}>
                  {Math.round(placeRouteInfo.distanceKm * 750).toLocaleString()} <span style={{fontSize:'9px',opacity:0.7}}>د.ع</span>
                </div>
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div style={{display:'flex',gap:'0'}}>
            {/* Go / Route button */}
            <button
              onClick={goToPlace}
              disabled={!userLocation || placeRouteLoading}
              style={{
                flex:1,padding:'12px 8px',
                background: placeRouteInfo
                  ? 'rgba(0,212,255,0.08)'
                  : (!userLocation || placeRouteLoading)
                    ? 'rgba(0,212,255,0.04)'
                    : 'rgba(0,212,255,0.16)',
                border:'none',
                borderRight:'1px solid rgba(255,255,255,0.07)',
                color: (!userLocation || placeRouteLoading) ? 'rgba(0,212,255,0.35)' : '#00d4ff',
                fontFamily:'Orbitron,sans-serif',fontSize:'10px',
                letterSpacing:'0.1em',cursor:(!userLocation||placeRouteLoading)?'not-allowed':'pointer',
                transition:'all 0.2s',
                display:'flex',alignItems:'center',justifyContent:'center',gap:'6px',
              }}
              onMouseEnter={e=>{if(userLocation&&!placeRouteLoading)(e.currentTarget as HTMLElement).style.background='rgba(0,212,255,0.22)';}}
              onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.background=placeRouteInfo?'rgba(0,212,255,0.08)':(!userLocation||placeRouteLoading)?'rgba(0,212,255,0.04)':'rgba(0,212,255,0.16)';}}
            >
              {placeRouteLoading ? (
                <><svg width="13" height="13" viewBox="0 0 28 28" fill="none" style={{animation:'lf-spin 0.9s linear infinite'}}><circle cx="14" cy="14" r="10" stroke="#00d4ff" strokeWidth="2.5" strokeDasharray="22 14" strokeLinecap="round"/></svg>جاري الحساب</>
              ) : placeRouteInfo ? (
                <><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M1 12h22M15 5l7 7-7 7" stroke="#00d4ff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>إعادة الحساب</>
              ) : !userLocation ? (
                <>📍 فعّل موقعك أولاً</>
              ) : (
                <><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M1 12h22M15 5l7 7-7 7" stroke="#00d4ff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>انطلق</>
              )}
            </button>

            {/* Book Taxi button */}
            <button
              onClick={()=>{ autoFindDriver(); }}
              disabled={!taxiCategory}
              style={{
                flex:1,padding:'12px 8px',
                background:'rgba(245,197,24,0.12)',
                border:'none',
                color: taxiCategory ? '#f5c518' : 'rgba(245,197,24,0.3)',
                fontFamily:'Orbitron,sans-serif',fontSize:'10px',
                letterSpacing:'0.1em',
                cursor: taxiCategory ? 'pointer' : 'not-allowed',
                transition:'all 0.2s',
                display:'flex',alignItems:'center',justifyContent:'center',gap:'6px',
              }}
              onMouseEnter={e=>{if(taxiCategory)(e.currentTarget as HTMLElement).style.background='rgba(245,197,24,0.22)';}}
              onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.background='rgba(245,197,24,0.12)';}}
            >
              🚕 احجز تكسي
            </button>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          ── Bottom Action Bar: Taxi (yellow) + Gas (red) ──────────────────
          ══════════════════════════════════════════════════════════════════ */}
      <div style={{
        position:'absolute', bottom:0, left:0, right:0,
        height:'80px', zIndex:1002,
        display:'flex',
        background:'rgba(5,8,15,0.97)',
        borderTop:'1px solid rgba(255,255,255,0.09)',
        backdropFilter:'blur(16px)',
        boxShadow:'0 -4px 32px rgba(0,0,0,0.7)',
      }}>

        {/* ── TAXI button ── */}
        {(() => {
          const ACTIVE_STATUSES = ['pending','accepted','driving'];
          const hasTripActive = !!(activeOrderId && ACTIVE_STATUSES.includes(activeOrderStatus));
          return (
        <button
          onClick={()=>{
            if (hasTripActive) { showBlockTaxiMsg(); return; }
            autoFindDriver();
          }}
          style={{
            flex:1,
            display:'flex', flexDirection:'column',
            alignItems:'center', justifyContent:'center', gap:'4px',
            background: hasTripActive
              ? 'rgba(255,45,120,0.08)'
              : (activeFilter === (taxiCategory?.slug ?? '__none__') || showTaxiPrompt)
                ? 'rgba(245,197,24,0.18)'
                : 'transparent',
            border:'none',
            borderTop: hasTripActive
              ? '3px solid rgba(255,45,120,0.4)'
              : (activeFilter === (taxiCategory?.slug ?? '__none__') || showTaxiPrompt)
                ? '3px solid #f5c518'
                : '3px solid transparent',
            borderRight:'1px solid rgba(255,255,255,0.07)',
            color: hasTripActive ? 'rgba(245,197,24,0.45)' : '#f5c518',
            cursor: taxiCategory ? 'pointer' : 'not-allowed',
            opacity: taxiCategory ? 1 : 0.35,
            transition:'all 0.2s',
            padding:0,
            position:'relative',
          }}
          onMouseEnter={e=>{ if(taxiCategory && !hasTripActive)(e.currentTarget as HTMLElement).style.background='rgba(245,197,24,0.14)'; }}
          onMouseLeave={e=>{ (e.currentTarget as HTMLElement).style.background=hasTripActive?'rgba(255,45,120,0.08)':(activeFilter===(taxiCategory?.slug??'__none__')||showTaxiPrompt)?'rgba(245,197,24,0.18)':'transparent'; }}
        >
          {/* Taxi icon SVG */}
          <svg width="28" height="28" viewBox="0 0 48 48" fill="none">
            <rect x="6" y="18" width="36" height="20" rx="5" fill="#f5c518" opacity="0.18"/>
            <rect x="6" y="18" width="36" height="20" rx="5" stroke="#f5c518" strokeWidth="2"/>
            <path d="M14 18V14a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4" stroke="#f5c518" strokeWidth="2"/>
            <rect x="14" y="22" width="8" height="5" rx="1.5" fill="#f5c518" opacity="0.55"/>
            <rect x="26" y="22" width="8" height="5" rx="1.5" fill="#f5c518" opacity="0.55"/>
            <circle cx="14" cy="38" r="4" fill="#f5c518"/>
            <circle cx="34" cy="38" r="4" fill="#f5c518"/>
            <rect x="20" y="10" width="8" height="4" rx="2" fill="#f5c518" opacity="0.8"/>
          </svg>
          <span style={{
            fontFamily:'Orbitron,sans-serif', fontSize:'11px',
            fontWeight:700, letterSpacing:'0.12em',
          }}>تكسي</span>
          {/* Active-trip lock badge */}
          {hasTripActive && (
            <span style={{
              position:'absolute', top:'6px', right:'10px',
              fontSize:'10px', lineHeight:1,
              background:'rgba(255,45,120,0.85)',
              border:'1px solid rgba(255,45,120,0.5)',
              color:'#fff', padding:'1px 5px',
              fontFamily:'Orbitron,sans-serif', letterSpacing:'0.05em',
              boxShadow:'0 0 6px rgba(255,45,120,0.5)',
            }}>🔒</span>
          )}
        </button>
          );
        })()}

        {/* ── GAS button ── */}
        <button
          onClick={()=>{
            if (gasCategory) {
              onFilterChange(gasCategory.slug);
              setShowMoreModal(false);
              setShowTaxiPrompt(false);
            }
          }}
          style={{
            flex:1,
            display:'flex', flexDirection:'column',
            alignItems:'center', justifyContent:'center', gap:'4px',
            background: activeFilter === (gasCategory?.slug ?? '__none__')
              ? 'rgba(255,45,120,0.18)'
              : 'transparent',
            border:'none',
            borderTop: activeFilter === (gasCategory?.slug ?? '__none__')
              ? '3px solid #ff2d78'
              : '3px solid transparent',
            color:'#ff2d78',
            cursor: gasCategory ? 'pointer' : 'not-allowed',
            opacity: gasCategory ? 1 : 0.35,
            transition:'all 0.2s',
            padding:0,
          }}
          onMouseEnter={e=>{ if(gasCategory)(e.currentTarget as HTMLElement).style.background='rgba(255,45,120,0.14)'; }}
          onMouseLeave={e=>{ (e.currentTarget as HTMLElement).style.background=activeFilter===(gasCategory?.slug??'__none__')?'rgba(255,45,120,0.18)':'transparent'; }}
        >
          {/* Gas pump SVG icon */}
          <svg width="26" height="28" viewBox="0 0 40 48" fill="none">
            <rect x="6" y="10" width="20" height="30" rx="3" stroke="#ff2d78" strokeWidth="2" fill="rgba(255,45,120,0.1)"/>
            <rect x="10" y="15" width="12" height="8" rx="2" fill="#ff2d78" opacity="0.45"/>
            <path d="M26 18 L34 14 L34 36 Q36 36 36 34 L36 22" stroke="#ff2d78" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="34" cy="20" r="3" fill="#ff2d78" opacity="0.7"/>
            <path d="M6 36 h20" stroke="#ff2d78" strokeWidth="1.5" opacity="0.5"/>
          </svg>
          <span style={{
            fontFamily:'Orbitron,sans-serif', fontSize:'11px',
            fontWeight:700, letterSpacing:'0.12em',
          }}>غاز</span>
        </button>

      </div>
    </div>
  );
}
