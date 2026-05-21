import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapItem, Category } from '@/data/types';
import { ChatOverlay } from './ChatOverlay';
import { GasChatOverlay } from './GasChatOverlay';
import { RatingDialog } from './RatingDialog';
import { FazaaSystem } from './FazaaSystem';
import { MarketTicker } from './MarketTicker';
import { FuelStationRadar } from './FuelStationRadar';
import { BountyMissionSystem } from './BountyMissionSystem';
import { BountyShortcutButton } from './BountyShortcutButton';
import { DoctorBookingModal } from './DoctorBookingModal';
import { ActiveOrderTracker } from './ActiveOrderTracker';
import TrafficLayer from './TrafficLayer';
import { useMapTheme } from '@/lib/mapTheme';
import { collection, query, where, getDocs, onSnapshot, orderBy, limit, doc, setDoc, updateDoc, serverTimestamp, getDoc } from 'firebase/firestore';
import { auth, db } from '@/lib/firebase';
import { getUserFromStorage } from '@/components/UserLoginOverlay';
import { useDoctorGeofence } from '@/hooks/useDoctorGeofence';

// ── Type-safe isOnline check ───────────────────────────────────────────────
// Flutter may write isOnline as boolean true OR string 'true'.
// Firestore where('isOnline','==',true) only matches boolean — so we always
// fetch without the where clause and filter client-side using this helper.
function isOnlineTruthy(val: unknown): boolean {
  return val === true || val === 'true';
}
// status check: accepts 'available' (boolean-safe)
function isAvailable(val: unknown): boolean {
  return val === 'available';
}

// ── Cross-check 1: approved_agents (status='available' AND isOnline truthy) ─
// Populated by the admin dashboard and by syncOrderToFirestore() in ClinicMap.
// We fetch by status='available' (always a string) and filter isOnline client-
// side to handle boolean vs string inconsistency from different write sources.
async function getAvailableAgentPhones(): Promise<Set<string> | null> {
  try {
    const snap = await getDocs(
      query(
        collection(db, 'approved_agents'),
        where('status', '==', 'available'),
      )
    );
    const phones = new Set<string>();
    snap.forEach(d => {
      const data = d.data();
      if (!isOnlineTruthy(data.isOnline)) return; // skip offline (bool OR string)
      const p = data.phone as string | undefined;
      if (p) phones.add(p.trim());
    });
    console.log(`[DriverFilter/approved_agents] online+available: ${phones.size}`, [...phones]);
    return phones;
  } catch (e: any) {
    console.warn('[DriverFilter/approved_agents] unreachable:', e?.code);
    return null;
  }
}

// ── Cross-check 2: drivers collection (partner app's authoritative source) ──
// The Flutter partner app writes isOnline=true/false (boolean) OR 'true'/'false'
// (string) and status='available'/'offline'.  We fetch ALL docs and filter
// client-side to be tolerant of both types (Data-Type Mismatch guard).
// Returns null if the collection is unreachable OR if no docs carry a 'phone'
// field (caller then skips this gate rather than blocking all drivers).
async function getOnlineDriverPhones(): Promise<Set<string> | null> {
  try {
    // Fetch all driver docs — no where clause so both boolean AND string
    // values of isOnline are captured; we filter client-side.
    const snap = await getDocs(collection(db, 'drivers'));
    const phones = new Set<string>();
    snap.forEach(d => {
      const data = d.data();
      // Must be online (truthy) AND status available
      if (!isOnlineTruthy(data.isOnline)) return;
      if (!isAvailable(data.status)) return;
      const p = data.phone as string | undefined;
      if (p) phones.add(p.trim());
    });
    if (phones.size === 0 && snap.size > 0) {
      console.warn('[DriverFilter/drivers] docs exist but none pass online+available filter — skipping gate');
      return null;
    }
    console.log(`[DriverFilter/drivers] online+available with phone: ${phones.size}`, [...phones]);
    return phones;
  } catch (e: any) {
    console.warn('[DriverFilter/drivers] unreachable:', e?.code);
    return null;
  }
}

// ── Combined filter: driver must pass BOTH cross-checks to be routed ─────────
// Uses Promise.all for a single parallel round-trip to Firestore.
// Logic:
//   approved_agents says available+online  → first gate (admin-side state)
//   drivers says isOnline=true             → second gate (partner-app live state)
// A driver is blocked if EITHER gate says they are unavailable/offline.
// If a gate is unreachable (returns null) it is skipped (fail-open for that gate).
async function getFilteredDriverPhones(): Promise<{
  phones: Set<string> | null;
  source: string;
}> {
  const [agentPhones, driverPhones] = await Promise.all([
    getAvailableAgentPhones(),
    getOnlineDriverPhones(),
  ]);

  // Both unavailable — fall back to REST-only
  if (agentPhones === null && driverPhones === null) {
    return { phones: null, source: 'REST-only (both Firestore gates down)' };
  }

  // Only approved_agents available
  if (driverPhones === null) {
    return { phones: agentPhones, source: 'approved_agents only' };
  }

  // Only drivers col available
  if (agentPhones === null) {
    return { phones: driverPhones, source: 'drivers col only' };
  }

  // Both available → INTERSECTION (must pass both gates)
  const intersection = new Set<string>();
  agentPhones.forEach(p => { if (driverPhones.has(p)) intersection.add(p); });
  return { phones: intersection, source: `intersection (${agentPhones.size}×${driverPhones.size}→${intersection.size})` };
}

// ── Haversine distance (km) between two lat/lng points ────────────────────
/** Taxi fare formula: ≤5 km → 750 IQD/km, >5 km → 500 IQD/km. Rounded to nearest 250. */
function calculateTaxiFare(distKm: number): number {
  const raw = distKm <= 5 ? distKm * 750 : distKm * 500;
  return Math.round(raw / 250) * 250;
}

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

function makeIcon(kind: string, catMap: Map<string, Category>, isOpen: boolean, selected: boolean, name = '', iconUrl?: string | null): L.DivIcon {
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

  // Custom PNG icon: rendered as a transparent network image inside the neon ring
  const innerHtml = iconUrl
    ? `<img src="${iconUrl}" alt="" style="width:${Math.round(size*0.72)}px;height:${Math.round(size*0.72)}px;object-fit:contain;position:relative;z-index:1;pointer-events:none;image-rendering:auto;" />`
    : svgBody
      ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none">${svgBody}</svg>`
      : `<span style="font-size:${Math.round(size*0.4)}px;position:relative;z-index:1;line-height:1;user-select:none">${emoji}</span>`;

  return L.divIcon({
    className: '',
    html: `<div style="display:flex;flex-direction:column;align-items:center;width:${W}px;">
      ${labelHtml}
      <div style="width:${size}px;height:${size}px;position:relative;display:flex;align-items:center;justify-content:center;">
        ${pulse ? `<div style="position:absolute;inset:0;border-radius:50%;background:${color};opacity:0.18;animation:lf-ping 2s cubic-bezier(0,0,0.2,1) infinite;"></div>` : ''}
        <div style="position:absolute;inset:0;border-radius:50%;border:2px solid ${color};box-shadow:0 0 ${selected?20:12}px ${color},0 0 ${selected?40:24}px ${color}88;"></div>
        ${innerHtml}
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

// Priority tier for zoom-based visibility filtering
// 1 = always (hospitals, mosques, fuel, schools) — zoom ≥ 12
// 2 = medium (restaurants, pharmacies, banks, police) — zoom ≥ 14
// 3 = low (cafes, hotels, bakeries, parks …) — zoom ≥ 16
function getAmenityPriority(amenity: string): number {
  if (/hospital|clinic|health|fuel|mosque|place_of_worship|school|university|college|police/.test(amenity)) return 1;
  if (/pharmacy|bank|atm|supermarket|restaurant|fast_food|library/.test(amenity)) return 2;
  return 3;
}

// Clean label — NO colored box, just white text with dark stroke (no visual clutter)
function poiNeonHtml(emoji: string, label: string, color: string): string {
  const short = label.length > 15 ? label.slice(0, 14) + '…' : label;
  // Icon is 30% smaller than before: 20 px circle (was 28 px)
  return `<div style="display:flex;flex-direction:column;align-items:center;cursor:pointer;filter:drop-shadow(0 0 4px ${color}50);">
    <div style="color:#f0f4ff;font-family:'Noto Sans Arabic',Rajdhani,sans-serif;font-size:9px;font-weight:700;white-space:nowrap;text-shadow:0 0 3px #000,1px 1px 0 #000,-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000;letter-spacing:0.02em;text-align:center;">${short}</div>
    <div style="width:1.5px;height:3px;background:${color};opacity:0.6;"></div>
    <div style="width:20px;height:20px;background:${color}20;border:1.5px solid ${color};border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;box-shadow:0 0 5px ${color}44;">${emoji}</div>
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
  const theme        = useMapTheme();
  const [isBountyUnlocked, setIsBountyUnlocked] = useState(false);

  const mapContainer      = useRef<HTMLDivElement>(null);
  const mapRef            = useRef<L.Map|null>(null);
  const tileLayerRef      = useRef<L.TileLayer|null>(null);
  const navTargetMarkerRef = useRef<L.Marker|null>(null);
  const markersRef        = useRef<{[id:number]:L.Marker}>({});
  const userMarkerRef  = useRef<L.Marker|null>(null);
  const userCircleRef  = useRef<L.Circle|null>(null);
  const routeGlowRef     = useRef<L.Polyline|null>(null);
  const routeLineRef     = useRef<L.Polyline|null>(null);
  const poiRouteGlowRef  = useRef<L.Polyline|null>(null);
  const poiRouteLineRef  = useRef<L.Polyline|null>(null);
  const fetchPOIsImmRef  = useRef<(()=>void)|null>(null); // immediate POI fetch trigger
  const catStyleRef    = useRef<HTMLStyleElement|null>(null);
  const poiLayerRef    = useRef<L.LayerGroup|null>(null);
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

  // Bridge: Leaflet popup button → open doctor booking modal / closed alert
  useEffect(()=>{
    setBookingTargetRef.current  = (item: MapItem) => setBookingTargetItem(item);
    showDoctorClosedRef.current  = () => setDoctorClosedAlert(true);
  },[]);

  // ── Live Firestore listener: track offline gas merchants ─────────────────
  // Partner app writes: merchants/{uid} → { isOnline, status }
  // Admin creates:      merchants/{locationId} → { uid, category, isOnline, status }
  // We resolve both doc-ID shapes so the filter always works.
  useEffect(()=>{
    const unsub = onSnapshot(collection(db, 'merchants'), (snap) => {
      // 1. Build uid → locationId map from admin-created docs (numeric IDs)
      const uidMap = new Map<string, number>();
      snap.docs.forEach(d => {
        const locId = Number(d.id);
        const uid   = d.data()?.uid as string | undefined;
        if (!isNaN(locId) && uid) uidMap.set(uid, locId);
      });
      uidToLocIdRef.current = uidMap;

      // 2. Build offline set — any gas merchant with isOnline:false OR status offline/مغلق
      const offline = new Set<number>();
      snap.docs.forEach(d => {
        const data = d.data() ?? {};
        const cat  = String(data.category ?? '').toLowerCase();
        const isGas = cat === 'gas_station' || cat === 'gas' || cat === 'غاز' || cat.includes('gas');
        if (!isGas) return;

        const isOffline =
          data.isOnline === false ||
          data.status === 'offline' ||
          data.status === 'مغلق';
        if (!isOffline) return;

        // Case A: doc ID is the numeric locationId (admin-created)
        const docLocId = Number(d.id);
        if (!isNaN(docLocId)) offline.add(docLocId);

        // Case B: doc ID is the Firebase UID (partner-app-created)
        if (isNaN(Number(d.id)) && uidMap.has(d.id)) offline.add(uidMap.get(d.id)!);

        // Case C: doc has a uid field — resolve through uidMap
        if (data.uid && uidMap.has(data.uid)) offline.add(uidMap.get(data.uid)!);
      });

      gasOfflineIdsRef.current = offline;
      console.log(`[GasMerchants] offline IDs:`, [...offline]);
    }, (err) => {
      console.warn('[GasMerchants] Firestore listener error:', err?.code);
    });
    return () => unsub();
  }, []);

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
      // Auto-dispatch mode: manual driver selection disabled.
      // Customer uses the taxi button to open the quick-form instead.
      setShowTaxiQuickForm(true);
      return;

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
      if (loc != null) {
        autoPlaceFromMarker(loc!.lat, loc!.lng);
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
            setTaxiEstPrice(calculateTaxiFare(distKm));
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
  const [hasPoiRoute,setHasPoiRoute]   = useState(false);
  const [showMoreModal,  setShowMoreModal]  = useState(false);
  const [searchQuery,    setSearchQuery]    = useState('');
  const [showTraffic,    setShowTraffic]    = useState(false);
  const [showFuel,       setShowFuel]       = useState(false);
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
  // ── Lazy initializers: read localStorage synchronously on first render ───
  // This eliminates the blank-field flash — values are ready before the first
  // paint, no useEffect delay, no async fetch needed.
  const [taxiUserName,  setTaxiUserName]  = useState<string>(() => {
    try { return JSON.parse(localStorage.getItem('diyala_user') ?? 'null')?.name  ?? ''; }
    catch { return ''; }
  });
  const [taxiUserPhone, setTaxiUserPhone] = useState<string>(() => {
    try { return JSON.parse(localStorage.getItem('diyala_user') ?? 'null')?.phone ?? ''; }
    catch { return ''; }
  });
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
  const activeDriverIdRef = useRef<number>(0);
  // Ref mirrors for use inside useCallback closures without stale captures
  const activeDriverPhoneRef = useRef<string>('');
  const [driverLat,         setDriverLat]         = useState<number|null>(null);
  const [driverLng,         setDriverLng]         = useState<number|null>(null);
  const [driverDistKm,      setDriverDistKm]      = useState<number|null>(null);
  const [driverEtaMin,      setDriverEtaMin]      = useState<number|null>(null);
  const [showChat,          setShowChat]          = useState(false);
  // Snackbar shown when a system message arrives while chat is closed
  const [sysMsgSnack,       setSysMsgSnack]       = useState<string|null>(null);
  const sysMsgTimerRef      = useRef<ReturnType<typeof setTimeout>|null>(null);
  // ── Gas order chat ────────────────────────────────────────────────────────
  const [showGasChat,          setShowGasChat]          = useState(false);
  const [gasUnread,            setGasUnread]            = useState(false);
  const [hasUnreadChat,        setHasUnreadChat]        = useState(false);
  const [unreadChatCount,      setUnreadChatCount]      = useState(0);
  const showChatRef = useRef(false);
  const [showGasCancelConfirm, setShowGasCancelConfirm] = useState(false);

  // ── Remote service-toggle flags (Firestore settings/services) ─────────────
  const [isTaxiActive, setIsTaxiActive] = useState<boolean>(true);
  const [isGasActive,  setIsGasActive]  = useState<boolean>(true);
  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, 'settings', 'services'),
      (snap) => {
        const d = snap.exists() ? snap.data() : {};
        setIsTaxiActive(d?.isTaxiActive ?? true);
        setIsGasActive(d?.isGasActive  ?? true);
      },
      () => { /* on error — leave defaults (true) */ }
    );
    return unsub;
  }, []);

  // ── Doctor Geo-Fence: silent background arrival detection ────────────────
  useDoctorGeofence(userLocationRef);

  // ── User Presence Tracker — mirrors AppLifecycleState.resumed / paused ──
  // Equivalent of Flutter WidgetsBindingObserver for web:
  //   visible  → isOnline: true   (app foregrounded / tab active)
  //   hidden   → isOnline: false  (app backgrounded / tab hidden / closed)
  useEffect(() => {
    const syncPresence = (online: boolean) => {
      const uid = auth.currentUser?.uid;
      if (!uid) return;
      setDoc(
        doc(db, 'users', uid),
        { isOnline: online, last_seen: serverTimestamp() },
        { merge: true },
      ).catch(() => {/* silent */});
    };

    // Mark online immediately on mount (resumed)
    syncPresence(true);

    // visibilitychange covers tab switch, minimize, and most closures
    const onVisibility = () => syncPresence(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);

    // beforeunload — best-effort for browser/tab close
    const onUnload = () => syncPresence(false);
    window.addEventListener('beforeunload', onUnload);

    return () => {
      // Mark offline on component unmount
      syncPresence(false);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, []); // runs once; auth.currentUser resolved by the time map mounts

  // ── Rating dialog (auto-opens when ride finishes) ─────────────────────────
  const [showRating,        setShowRating]        = useState(false);
  const [ratingOrderId,     setRatingOrderId]     = useState<number>(0);
  const [ratingDriverId,    setRatingDriverId]    = useState<number>(0);
  const [ratingCustomerName,setRatingCustomerName]= useState<string>('');
  const ratingShownRef      = useRef<Set<number>>(new Set()); // prevent double-trigger
  // Thank-you snackbar shown after rating is submitted/skipped
  const [showThankYouSnack, setShowThankYouSnack] = useState(false);

  // ── Driver Search Loop ────────────────────────────────────────────────────
  const [loopCountdown,     setLoopCountdown]     = useState<number|null>(null); // seconds left
  const [loopActive,        setLoopActive]        = useState(false);
  const [loopCurrentDriver, setLoopCurrentDriver] = useState<string>('');        // name of current driver being tried
  const loopIgnoredRef     = useRef<Set<number>>(new Set());          // locationIds already tried
  const loopFromPtRef      = useRef<{lat:number;lng:number}|null>(null);
  const loopToPtRef        = useRef<{lat:number;lng:number}|null>(null);
  const loopUserNameRef    = useRef<string>('');
  const loopUserPhoneRef   = useRef<string>('');
  const loopEstPriceRef    = useRef<number>(0);
  const redirectToNextRef  = useRef<()=>Promise<void>>(async()=>{});   // stable pointer, updated after def
  const [loopCurrentDriverDist, setLoopCurrentDriverDist] = useState<number|null>(null); // km to the driver currently being tried
  // ── Online drivers state: rebuilt from Firestore snapshot on every change ──
  // Using React STATE (not ref) so the map re-renders immediately when any
  // driver flips isOnline ↔ false without requiring a page refresh.
  const [onlineDrivers, setOnlineDrivers] = useState<Array<{
    phone: string; lat: number|null; lng: number|null; name: string;
  }>>([]);
  const loopInitDistRef    = useRef<number|null>(null);   // distance to first auto-found driver
  // ── Redirect guard ────────────────────────────────────────────────────────
  // true while redirectToNextDriver is mid-flight (between cancel-old & create-new).
  // Prevents the 'cancelled' SSE/poll echo from triggering stopOrderTracking().
  const isRedirectingRef   = useRef(false);
  // ── Concurrency lock ──────────────────────────────────────────────────────
  // Prevents the 3-second poll from triggering a second concurrent
  // redirectToNextDriver while the first one is still awaiting customer-cancel.
  // Without this, a 'rejected' poll response during the cancel-fetch window
  // launches a duplicate redirect → double orders / accidental cancellation.
  const redirectLockRef    = useRef(false);

  // ── Live Firestore Sets for real-time driver availability ─────────────────
  // Updated by onSnapshot listeners (started when loopActive=true).
  // null  = listener not yet fired / collection unreachable → gate skipped
  // Set   = phones currently passing that gate
  const liveOnlineDriverPhonesRef   = useRef<Set<string> | null>(null);  // drivers col
  const liveAvailableAgentPhonesRef = useRef<Set<string> | null>(null);  // approved_agents col
  // ── Live-radar helpers ────────────────────────────────────────────────────
  const loopActiveRef          = useRef(false);                          // mirrors loopActive for snapshot callbacks
  const autoFindDriverRef      = useRef<()=>Promise<void>>(async()=>{}); // stable ptr → updated after definition
  const prevDriverPhonesRef    = useRef<Set<string>>(new Set());         // tracks previous online phones (new-driver trigger only)
  const newDriverSearchTimer   = useRef<ReturnType<typeof setTimeout>|null>(null); // debounce for auto-trigger
  const onlineDriverMarkersRef = useRef<Map<string, L.Marker>>(new Map()); // phone → Leaflet marker

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
  // Cancel-order snackbar (shown after customer cancels pending order)
  const [taxiCancelSnack,   setTaxiCancelSnack]   = useState(false);
  const cancelSnackTimerRef = useRef<ReturnType<typeof setTimeout>|null>(null);
  // ── Quick-dispatch form (auto mode: no manual driver selection) ───────────
  const [showTaxiQuickForm, setShowTaxiQuickForm] = useState(false);
  const [taxiQuickDest,     setTaxiQuickDest]     = useState('');
  const [taxiQuickError,    setTaxiQuickError]    = useState<string|null>(null);
  // Manual pin routing (two-step: from → to)
  const [taxiManualStep,    setTaxiManualStep]    = useState<'idle'|'from'|'to'>('idle');
  const taxiManualStepRef   = useRef<'idle'|'from'|'to'>('idle');
  const [taxiQuickFromPt,   setTaxiQuickFromPt]   = useState<{lat:number;lng:number}|null>(null);
  const taxiQuickFromPtRef  = useRef<{lat:number;lng:number}|null>(null);
  const [taxiQuickToPt,     setTaxiQuickToPt]     = useState<{lat:number;lng:number}|null>(null);
  const [taxiQuickDistKm,   setTaxiQuickDistKm]   = useState<number|null>(null);
  const [taxiQuickPrice,    setTaxiQuickPrice]     = useState<number|null>(null);
  const taxiQuickPolyRef    = useRef<L.Polyline|null>(null);
  // ── Gas order form ────────────────────────────────────────────────────────
  const [showGasForm,    setShowGasForm]    = useState(false);
  const [gasFormError,   setGasFormError]   = useState<string|null>(null);
  const [gasFormLoading, setGasFormLoading] = useState(false);
  const [gasFormSuccess, setGasFormSuccess] = useState(false);
  const [gasLocationAddr, setGasLocationAddr] = useState('');
  // ── Active gas order tracking ─────────────────────────────────────────────
  const [activeGasOrderId,     setActiveGasOrderId]     = useState<number|null>(null);
  const [activeGasOrderStatus, setActiveGasOrderStatus] = useState<string>('pending');
  const activeGasOrderIdRef    = useRef<number|null>(null);
  const activeGasOrderStatusRef= useRef<string>('pending');
  const taxiManualARef      = useRef<L.Marker|null>(null);
  const manualNavLayerRef   = useRef<L.LayerGroup|null>(null);
  // Destination autocomplete (Nominatim)
  type DestSugg = { name:string; lat:number; lng:number };
  const [taxiDestSuggs,     setTaxiDestSuggs]     = useState<DestSugg[]>([]);
  const [taxiDestLoading,   setTaxiDestLoading]   = useState(false);
  const taxiDestTimerRef    = useRef<ReturnType<typeof setTimeout>|null>(null);
  const taxiDestInputRef    = useRef<HTMLInputElement>(null);
  const [taxiFoundSnack,    setTaxiFoundSnack]    = useState<string|null>(null); // driver name when found
  const [taxiAutoConnect,   setTaxiAutoConnect]   = useState(false); // true → auto-submit when route ready
  const prevDriverPosRef    = useRef<{lat:number;lng:number}|null>(null);

  // ── Online drivers (all open taxis visible on map) ────────────────────────
  type OnlineDriver = { id:number; locationId:number; driverName:string; phone:string; lat:number; lng:number; isOnline:boolean; isBusy?:boolean; updatedAt?:string|null };
  // onlineDriverMarkersRef removed — drivers are never shown on the public map

  // Leaflet object refs for taxi routing visuals
  const taxiRouteLineRef  = useRef<L.Polyline|null>(null);
  const taxiGlowLineRef   = useRef<L.Polyline|null>(null);
  const taxiFromMarkerRef = useRef<L.Marker|null>(null);
  const taxiToMarkerRef   = useRef<L.Marker|null>(null);
  const driverMarkerRef   = useRef<L.Marker|null>(null);
  // ── Doctor booking bridge ────────────────────────────────────────────────
  const [bookingTargetItem,  setBookingTargetItem]  = useState<MapItem|null>(null);
  const setBookingTargetRef = useRef<((item:MapItem)=>void)|null>(null);
  // ── Doctor-closed alert dialog ───────────────────────────────────────────
  const [doctorClosedAlert,  setDoctorClosedAlert]  = useState(false);
  const showDoctorClosedRef = useRef<(()=>void)|null>(null);

  // ── Gas form bridge ref + offline merchants tracker ──────────────────────
  const openGasFormRef      = useRef<(()=>void)|null>(null);
  const gasOfflineIdsRef    = useRef<Set<number>>(new Set());   // locationIds offline in Firestore
  const uidToLocIdRef       = useRef<Map<string, number>>(new Map()); // uid → locationId

  // Bridge refs — stable handles for Leaflet DOM callbacks & map click
  const setTaxiItemRef    = useRef<((item:MapItem)=>void)|null>(null);
  const taxiPickPointRef  = useRef<((lat:number,lng:number)=>void)|null>(null);
  const taxiStepRef       = useRef<TaxiStep>('idle');
  const taxiFromPtRef     = useRef<{lat:number;lng:number}|null>(null);

  const pendingJumpRef   = useRef<number|null>(null);

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

  // ── Last Firestore-synced location (for 100 m debounce) ─────────────────
  const lastFsSyncRef = useRef<{lat:number;lng:number}|null>(null);

  // Haversine distance in metres (inline, no import needed)
  const haversineM = (a:{lat:number;lng:number}, b:{lat:number;lng:number}): number => {
    const R = 6371000;
    const toR = (d:number) => d * Math.PI / 180;
    const dLat = toR(b.lat - a.lat);
    const dLng = toR(b.lng - a.lng);
    const x = Math.sin(dLat/2)**2 +
              Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
  };

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

        // ── Firestore location sync (debounced: first fix + every 100 m) ────
        const uid = auth.currentUser?.uid;
        if (uid) {
          const last = lastFsSyncRef.current;
          const shouldSync = !last || haversineM(last, loc) >= 100;
          if (shouldSync) {
            lastFsSyncRef.current = loc;
            setDoc(
              doc(db, 'users', uid),
              { latitude: lat, longitude: lng, last_seen: serverTimestamp() },
              { merge: true },
            ).catch(() => {/* silent */});
          }
        }

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
      @keyframes lf-ping-subtle{0%,100%{box-shadow:0 0 22px rgba(123,47,247,0.55),0 0 8px rgba(123,47,247,0.3);}50%{box-shadow:0 0 36px rgba(123,47,247,0.85),0 0 16px rgba(123,47,247,0.5);}}
      @keyframes lf-spin{to{transform:rotate(360deg);}}
      @keyframes chat-unread-pulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:0.7;transform:scale(1.35);}}
      @keyframes chat-unread-shake{0%{transform:rotate(-8deg) scale(1.04);}100%{transform:rotate(8deg) scale(1.04);}}
      @keyframes fuel-top-pulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:0.6;transform:scale(1.4);}}
      @keyframes mission-pulse{0%,100%{transform:scale(1);opacity:1;}50%{transform:scale(1.15);opacity:0.8;}}
      @keyframes traffic-flow{0%{stroke-dashoffset:30;}100%{stroke-dashoffset:0;}}
      .leaflet-container{background:#0a0d14!important;font-family:'Rajdhani',sans-serif;}
      .leaflet-tile-pane{filter:brightness(0.9);}
      .leaflet-control-zoom a{background:#0d1117!important;color:#00f5d4!important;border-color:#00f5d4!important;font-family:'Orbitron',sans-serif;}
      .leaflet-control-zoom a:hover{background:#00f5d422!important;}
      .leaflet-control-attribution{background:rgba(0,0,0,0.7)!important;color:#00f5d488!important;font-size:10px;}
      .leaflet-control-attribution a{color:#00f5d4!important;}
      .map-popup .leaflet-popup-content-wrapper{background:rgba(5,8,15,0.97)!important;border-radius:2px!important;padding:0!important;min-width:220px;max-height:75vh!important;overflow-y:auto!important;-webkit-overflow-scrolling:touch!important;}
      .map-popup .leaflet-popup-content{margin:0!important;width:auto!important;}
      .map-popup .leaflet-popup-tip-container{display:none;}
      .map-popup .leaflet-popup-close-button{color:rgba(255,255,255,0.7)!important;font-size:22px!important;top:4px!important;right:6px!important;width:28px!important;height:28px!important;display:flex!important;align-items:center!important;justify-content:center!important;background:rgba(255,45,120,0.12)!important;border-radius:3px!important;transition:all 0.15s!important;}
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
      .popup-book-btn{width:100%;padding:9px 12px;margin-top:6px;background:rgba(0,245,212,0.08);border:1px solid rgba(0,245,212,0.35);color:#00f5d4;font-family:'Rajdhani',sans-serif;font-size:13px;font-weight:600;cursor:pointer;transition:all 0.2s;display:flex;align-items:center;justify-content:center;gap:7px;border-radius:3px;direction:rtl;}
      .popup-book-btn:hover{background:rgba(0,245,212,0.18);box-shadow:0 0 14px rgba(0,245,212,0.35);border-color:#00f5d4;}
      .popup-book-btn:disabled,.popup-book-btn[data-unavailable]{cursor:not-allowed;opacity:0.65;}
      .filter-tabs-bar::-webkit-scrollbar{display:none;}
    `;
    document.head.appendChild(style);
    mapRef.current=L.map(mapContainer.current,{center:[33.7451,44.6488],zoom:13,zoomControl:true});
    tileLayerRef.current = L.tileLayer(theme.tileUrl,{
      attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains:'abcd',maxZoom:20,
    });
    tileLayerRef.current.addTo(mapRef.current);
    mapRef.current.on('click',(e:L.LeafletMouseEvent)=>{
      if (adminModeRef.current) { onMapClickRef.current?.({lat:e.latlng.lat,lng:e.latlng.lng}); return; }
      taxiPickPointRef.current?.(e.latlng.lat, e.latlng.lng);
    });

    // ── OSM Global POI overlay — sticky accumulation (markers never clear on pan/zoom) ───
    const poiLayerA = L.layerGroup().addTo(mapRef.current);
    poiLayerRef.current = poiLayerA;

    // Persistent dedup state — survives panning/zooming for the whole session
    const placedPoiIds   = new Set<number>();                        // OSM node IDs
    const placedPositions: { lat: number; lon: number }[] = [];     // collision grid

    // POI route lines — stored in component refs so cancel button can reach them
    let poiAbort: AbortController|null = null;
    let lastBoundsKey = '';
    let poiTimer: ReturnType<typeof setTimeout>|null = null;

    // Build markers — adds only NEW (unseen) elements; never clears existing ones
    const buildPoiMarkers = (elements: any[], zoom: number) => {
      // Priority threshold based on zoom
      const maxPriority = zoom >= 16 ? 3 : zoom >= 14 ? 2 : 1;

      // Collision grid min-distance scales with zoom
      const minDistDeg = zoom >= 16 ? 0.0006 : zoom >= 14 ? 0.0018 : 0.004;

      const tooClose = (lat: number, lon: number): boolean =>
        placedPositions.some(p => Math.abs(p.lat - lat) < minDistDeg && Math.abs(p.lon - lon) < minDistDeg);

      elements.slice(0, 400).forEach((el: any) => {
        if (typeof el.lat !== 'number' || !el.id) return;
        if (placedPoiIds.has(el.id as number)) return;   // already on map — skip
        const amenityKey = el.tags?.amenity ?? el.tags?.leisure ?? '';
        const priority = getAmenityPriority(amenityKey);
        if (priority > maxPriority) return;              // zoom-based density filter
        if (tooClose(el.lat, el.lon)) return;            // collision prevention

        const { emoji, color } = getAmenityStyle(amenityKey);
        const name = (el.tags?.['name:ar'] ?? el.tags?.name ?? '').trim();
        if (!name) return;

        placedPoiIds.add(el.id as number);
        placedPositions.push({ lat: el.lat, lon: el.lon });

        const marker = L.marker([el.lat, el.lon], {
          icon: L.divIcon({
            className: '',
            html: poiNeonHtml(emoji, name, color),
            // 30% smaller: was [36,52]/anchor[18,52] → now [26,36]/anchor[13,36]
            iconSize:   [26, 36],
            iconAnchor: [13, 36],
          }),
          interactive:  true,
          keyboard:     false,
          zIndexOffset: 100,
        });

        marker.on('click', () => {
          const map    = mapRef.current; if (!map) return;
          const userLoc = userLocationRef.current;

          const popupEl = document.createElement('div');
          popupEl.style.cssText = 'padding:14px 16px 12px;direction:rtl;min-width:210px;';
          popupEl.innerHTML = `
            <div style="font-family:Orbitron,sans-serif;font-size:9px;color:${color}99;letter-spacing:0.12em;margin-bottom:5px;">${emoji} معلم</div>
            <div style="font-family:Rajdhani,sans-serif;font-size:17px;font-weight:700;color:#e8f8f5;line-height:1.2;margin-bottom:10px;">${name}</div>
          `;

          const navBtn = document.createElement('button');
          navBtn.className = 'popup-nav-btn';
          navBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M3 11l19-9-9 19-2-8-8-2z" fill="#f5c518"/></svg>الذهاب إليه`;

          navBtn.addEventListener('click', async () => {
            map.closePopup();
            if (!userLoc) return;
            poiRouteGlowRef.current?.remove(); poiRouteGlowRef.current = null;
            poiRouteLineRef.current?.remove(); poiRouteLineRef.current = null;
            try {
              const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${userLoc.lng},${userLoc.lat};${el.lon},${el.lat}?overview=full&geometries=geojson`;
              const rData = await (await fetch(osrmUrl)).json();
              const route = rData.routes?.[0]; if (!route) return;
              const coords: [number,number][] = route.geometry.coordinates.map(([ln,la]: [number,number]) => [la, ln]);
              poiRouteGlowRef.current = L.polyline(coords,{color,weight:14,opacity:0.18,lineCap:'round',lineJoin:'round'}).addTo(map);
              poiRouteLineRef.current = L.polyline(coords,{color,weight:3.5,opacity:1,lineCap:'round',lineJoin:'round',dashArray:'10 6'}).addTo(map);
              setHasPoiRoute(true);
              const distKm = route.distance/1000, durMin = route.duration/60;
              const distTxt = distKm<1 ? `${(distKm*1000).toFixed(0)} م` : `${distKm.toFixed(1)} كم`;
              const durTxt  = durMin<60 ? `${Math.round(durMin)} دقيقة` : `${(durMin/60).toFixed(1)} ساعة`;
              L.popup({className:'map-popup',closeButton:true,autoPan:true,offset:[0,-18]})
                .setLatLng([el.lat, el.lon])
                .setContent(`<div style="padding:12px 16px;direction:rtl;">
                  <div style="font-family:Orbitron,sans-serif;font-size:9px;color:${color}99;letter-spacing:0.1em;margin-bottom:5px;">${emoji} معلم</div>
                  <div style="font-family:Rajdhani,sans-serif;font-size:16px;font-weight:700;color:#e8f8f5;margin-bottom:10px;">${name}</div>
                  <div style="display:flex;gap:16px;align-items:center;">
                    <div style="display:flex;flex-direction:column;align-items:center;gap:2px;">
                      <span style="font-family:Orbitron,sans-serif;font-size:14px;font-weight:700;color:#00d4ff;">${distTxt}</span>
                      <span style="font-family:Rajdhani,sans-serif;font-size:10px;color:#ffffff55;letter-spacing:0.06em;">المسافة</span>
                    </div>
                    <div style="width:1px;height:30px;background:#ffffff18;"></div>
                    <div style="display:flex;flex-direction:column;align-items:center;gap:2px;">
                      <span style="font-family:Orbitron,sans-serif;font-size:14px;font-weight:700;color:#f5c518;">${durTxt}</span>
                      <span style="font-family:Rajdhani,sans-serif;font-size:10px;color:#ffffff55;letter-spacing:0.06em;">وقت الوصول</span>
                    </div>
                  </div>
                </div>`)
                .openOn(map);
              map.flyToBounds(L.latLngBounds(coords),{padding:[70,100],duration:1.5});
            } catch(_) { /* OSRM error — silent */ }
          });

          popupEl.appendChild(navBtn);
          L.popup({className:'map-popup',closeButton:true,autoPan:true,offset:[0,-18]})
            .setLatLng([el.lat, el.lon]).setContent(popupEl).openOn(map);
        });

        marker.addTo(poiLayerA);
      });
    };

    // Actual fetch — merges new markers into the sticky layer (never clears)
    const doFetchPOIs = async () => {
      const map = mapRef.current; if (!map) return;
      const zoom = map.getZoom();
      if (zoom < 12) return;

      const b   = map.getBounds();
      const key = `${b.getSouth().toFixed(2)},${b.getWest().toFixed(2)},${b.getNorth().toFixed(2)},${b.getEast().toFixed(2)}`;
      if (key === lastBoundsKey) return;
      lastBoundsKey = key;

      poiAbort?.abort();
      poiAbort = new AbortController();

      const [S,W,N,E] = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
      const q = `[out:json][timeout:20];(
        node["amenity"~"place_of_worship|restaurant|cafe|fast_food|hospital|clinic|pharmacy|school|university|fuel|bank|supermarket|hotel|bakery|butcher|police|cinema|library"](${S},${W},${N},${E});
        node["leisure"~"park|garden"](${S},${W},${N},${E});
      );out body;`;

      try {
        const res = await fetch('https://overpass-api.de/api/interpreter',{method:'POST',body:q,signal:poiAbort.signal});
        if (!res.ok) return;
        const data = await res.json();
        if (!mapRef.current) return;
        // Merge new elements — only adds markers not already on map
        buildPoiMarkers(data.elements ?? [], zoom);
      } catch (_) { /* aborted or network error — silent */ }
    };

    // Expose immediate fetch so GPS button can call it without debounce
    fetchPOIsImmRef.current = doFetchPOIs;

    // Debounced wrapper — 400 ms after last moveend/zoomend
    const fetchPOIs = () => {
      if (poiTimer) clearTimeout(poiTimer);
      poiTimer = setTimeout(doFetchPOIs, 400);
    };

    mapRef.current.on('moveend zoomend', fetchPOIs);
    // Fetch immediately on load (no delay — tiles load in parallel)
    doFetchPOIs();

    return ()=>{
      poiAbort?.abort();
      if (poiTimer) clearTimeout(poiTimer);
      poiLayerA.remove(); poiLayerRef.current = null;
      poiRouteGlowRef.current?.remove(); poiRouteGlowRef.current = null;
      poiRouteLineRef.current?.remove(); poiRouteLineRef.current = null;
      mapRef.current?.remove(); mapRef.current=null;
      style.remove();
      catStyleRef.current?.remove(); catStyleRef.current=null;
    };
  },[]);

  // ── Compute effective tile URL based on map state ─────────────────────────
  // Focus / Nav → _nolabels (no embedded POI icons in tiles)
  // All (no filter) → _all (full labels + POIs)
  const effectiveTileUrl = useMemo(() => {
    const focused = !!routeTarget || (!!activeFilter && activeFilter !== '');
    return focused ? theme.tileUrlFocused : theme.tileUrl;
  }, [routeTarget, activeFilter, theme.tileUrlFocused, theme.tileUrl]);

  // ── Swap tile layer when effective URL changes (day/night OR map state) ───
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (tileLayerRef.current) {
      map.removeLayer(tileLayerRef.current);
    }
    tileLayerRef.current = L.tileLayer(effectiveTileUrl, {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: 'abcd', maxZoom: 20,
    });
    tileLayerRef.current.addTo(map);
    tileLayerRef.current.bringToBack();
  }, [effectiveTileUrl]);

  // ── OSM POI overlay visibility (hide when category focused or nav active) ─
  useEffect(() => {
    const map   = mapRef.current;
    const layer = poiLayerRef.current;
    if (!map || !layer) return;
    // Show only when there is NO active filter AND no navigation
    const shouldShow = !routeTarget && (!activeFilter || activeFilter === '');
    if (shouldShow) {
      if (!map.hasLayer(layer)) layer.addTo(map);
    } else {
      if (map.hasLayer(layer)) map.removeLayer(layer);
    }
  }, [routeTarget, activeFilter]);

  // ── Sync showFuel from activeFilter (fuel stations auto-show/hide) ────────
  useEffect(() => {
    setShowFuel(activeFilter === '__fuel_stations__');
  }, [activeFilter]);

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

    // ── Multi-signal doctor/clinic detection ─────────────────────────────────
    // Matches any slug variant: clinic, doctor, doctors, physician, طبيب, عيادة…
    const kindLower   = item.kind.toLowerCase();
    const labelEnLow  = (cat?.labelEn ?? '').toLowerCase();
    const labelArLow  = (cat?.labelAr ?? '').toLowerCase();
    const isDoctor =
      kindLower === 'clinic'    || kindLower === 'doctor'   ||
      kindLower === 'doctors'   || kindLower === 'physician'||
      kindLower === 'طبيب'      || kindLower === 'عيادة'    ||
      labelEnLow.includes('doctor')  || labelEnLow.includes('clinic') ||
      labelEnLow.includes('health')  || labelEnLow.includes('physician') ||
      labelArLow.includes('طبيب')    || labelArLow.includes('عيادة')    ||
      labelArLow.includes('صحة')     ||
      !!(item as any).doctor         || !!(item as any).specialty;

    const sub = (item as any).details
      || (isDoctor
          ? [(item as any).doctor,(item as any).specialty].filter(Boolean).join(' — ')
          : item.kind==='restaurant'
          ? [(item as any).cuisine,(item as any).type].filter(Boolean).join(' · ')
          : '');

    const stars = typeof (item as any).rating === 'number' && (item as any).rating > 0
      ? `<div style="color:#f5c518;font-size:13px;margin-bottom:4px;letter-spacing:1px">${'★'.repeat((item as any).rating)}${'☆'.repeat(5-(item as any).rating)}</div>` : '';

    const statusBadgeId = `doc-status-${item.id}`;

    const el=document.createElement('div');
    el.style.cssText='padding:14px 16px 12px;direction:rtl;min-width:215px;';
    el.innerHTML=`
      <div style="font-family:Orbitron,sans-serif;font-size:9px;color:${color}88;letter-spacing:0.12em;margin-bottom:5px;">${emoji} ${labelEn} · ID:${item.id.toString().padStart(4,'0')}</div>
      <div style="font-family:Rajdhani,sans-serif;font-size:17px;font-weight:700;color:#e8f8f5;line-height:1.2;margin-bottom:7px;">${item.name}</div>
      ${stars}
      <div id="${statusBadgeId}" style="display:inline-flex;align-items:center;gap:7px;padding:5px 11px;border-radius:3px;border:1px solid ${color}55;background:${color}12;margin-bottom:6px;">
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

    // ── Doctor booking button — inserted BEFORE detailsBtn ───────────────────
    // Order: الذهاب إليه → حجز موعد → عرض التفاصيل
    el.appendChild(navBtn);

    if (isDoctor) {
      const bookSep = document.createElement('div');
      bookSep.style.cssText = 'height:1px;background:rgba(0,245,212,0.15);margin:8px 0 6px;';
      el.appendChild(bookSep);

      const bookBtn = document.createElement('button');
      bookBtn.className = 'popup-book-btn';
      // Loading state while Firestore check runs
      bookBtn.disabled  = true;
      bookBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 28 28" fill="none"
        style="animation:lf-spin 0.9s linear infinite;flex-shrink:0">
        <circle cx="14" cy="14" r="10" stroke="#00f5d4" stroke-width="2.5"
          stroke-dasharray="22 14" stroke-linecap="round"/>
      </svg>جاري التحقق...`;
      el.appendChild(bookBtn);

      // Async availability check — reads from merchants/{id}
      getDoc(doc(db, 'merchants', String(item.id)))
        .then(snap => {
          const available = snap.exists() ? (snap.data()?.isAvailable !== false) : true;

          // ── Update status badge in popup DOM ──────────────────────────────
          if (!available) {
            const badge = document.getElementById(statusBadgeId);
            if (badge) {
              badge.style.border     = '1px solid rgba(255,45,120,0.5)';
              badge.style.background = 'rgba(255,45,120,0.10)';
              badge.innerHTML = `
                <div style="width:8px;height:8px;border-radius:50%;background:#ff2d78;box-shadow:0 0 8px #ff2d78;flex-shrink:0;"></div>
                <span style="font-family:Rajdhani,sans-serif;font-size:14px;font-weight:700;color:#ff2d78;letter-spacing:0.04em;">العيادة مغلقة حالياً 🔴</span>
              `;
            }
          }

          if (available) {
            bookBtn.disabled = false;
            bookBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" style="flex-shrink:0">
              <rect x="3" y="4" width="18" height="18" rx="2" stroke="#00f5d4" stroke-width="1.8"/>
              <path d="M8 2v4M16 2v4M3 10h18" stroke="#00f5d4" stroke-width="1.8" stroke-linecap="round"/>
              <path d="M8 14h2v2H8z" fill="#00f5d4"/>
            </svg>حجز موعد`;
            bookBtn.style.background = 'rgba(0,245,212,0.1)';
            bookBtn.style.border     = '1px solid rgba(0,245,212,0.6)';
            bookBtn.style.color      = '#00f5d4';
            bookBtn.style.boxShadow  = '0 0 10px rgba(0,245,212,0.2)';
            bookBtn.addEventListener('click', () => {
              setBookingTargetRef.current?.(item);
              mapRef.current?.closePopup();
            });
          } else {
            // Clinic closed — button clickable but triggers alert dialog
            bookBtn.disabled = false;
            bookBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="flex-shrink:0">
              <circle cx="12" cy="12" r="9" stroke="#ff2d78" stroke-width="1.8"/>
              <path d="M15 9l-6 6M9 9l6 6" stroke="#ff2d78" stroke-width="1.8" stroke-linecap="round"/>
            </svg>العيادة مغلقة — حجز موعد`;
            bookBtn.style.background = 'rgba(255,45,120,0.07)';
            bookBtn.style.border     = '1px solid rgba(255,45,120,0.45)';
            bookBtn.style.color      = '#ff2d78';
            bookBtn.style.cursor     = 'pointer';
            bookBtn.addEventListener('click', () => {
              showDoctorClosedRef.current?.();
            });
          }
        })
        .catch(() => {
          bookBtn.innerHTML = '⚠ تعذّر التحقق';
          bookBtn.style.color = 'rgba(255,255,255,0.3)';
        });
    }

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

    // ── Gas order button — checks Firestore merchants status ─────────────────
    // isGasCat defined in outer scope; uses gasOfflineIdsRef for live status
    const isGasItem =
      item.kind === 'gas_station' || item.kind === 'gas' || item.kind === 'غاز' ||
      (catMapRef.current.get(item.kind)?.labelEn ?? '').toLowerCase().includes('gas') ||
      (catMapRef.current.get(item.kind)?.labelAr ?? '').includes('غاز');

    if (isGasItem) {
      const gasSep = document.createElement('div');
      gasSep.style.cssText = 'height:1px;background:rgba(245,197,24,0.15);margin:8px 0 6px;';
      el.appendChild(gasSep);

      const gasBtn = document.createElement('button');
      gasBtn.className = 'popup-gas-btn';
      gasBtn.disabled  = true;
      gasBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 28 28" fill="none" style="animation:lf-spin 0.9s linear infinite;flex-shrink:0"><circle cx="14" cy="14" r="10" stroke="#f5c518" stroke-width="2.5" stroke-dasharray="22 14" stroke-linecap="round"/></svg>جاري التحقق...`;
      gasBtn.style.cssText = 'display:flex;align-items:center;gap:7px;width:100%;padding:8px 12px;background:rgba(245,197,24,0.06);border:1px solid rgba(245,197,24,0.3);color:rgba(245,197,24,0.5);font-family:Rajdhani,sans-serif;font-size:13px;font-weight:600;cursor:not-allowed;border-radius:0;';
      el.appendChild(gasBtn);

      // 1. Instant check from the live ref (set by onSnapshot listener)
      const applyGasStatus = (agentOnline: boolean) => {
        const badge = document.getElementById(statusBadgeId);
        if (agentOnline) {
          gasBtn.disabled = false;
          gasBtn.innerHTML = `⛽ اطلب غاز الآن`;
          gasBtn.style.background  = 'rgba(245,197,24,0.12)';
          gasBtn.style.border      = '1px solid rgba(245,197,24,0.6)';
          gasBtn.style.color       = '#f5c518';
          gasBtn.style.cursor      = 'pointer';
          gasBtn.style.boxShadow   = '0 0 10px rgba(245,197,24,0.18)';
          gasBtn.addEventListener('click', () => {
            openGasFormRef.current?.();
            mapRef.current?.closePopup();
          });
        } else {
          gasBtn.disabled = false;
          gasBtn.innerHTML = `🔴 الوكيل غير متاح حالياً`;
          gasBtn.style.background  = 'rgba(255,45,120,0.07)';
          gasBtn.style.border      = '1px solid rgba(255,45,120,0.35)';
          gasBtn.style.color       = '#ff2d78';
          gasBtn.style.cursor      = 'default';
          // Update status badge in popup
          if (badge) {
            badge.style.border     = '1px solid rgba(255,45,120,0.5)';
            badge.style.background = 'rgba(255,45,120,0.10)';
            badge.innerHTML = `<div style="width:8px;height:8px;border-radius:50%;background:#ff2d78;box-shadow:0 0 8px #ff2d78;flex-shrink:0;"></div><span style="font-family:Rajdhani,sans-serif;font-size:14px;font-weight:700;color:#ff2d78;letter-spacing:0.04em;">الوكيل مغلق حالياً 🔴</span>`;
          }
        }
      };

      // 2. Check live ref first (instant, no network call)
      if (gasOfflineIdsRef.current.size > 0 || true) {
        // Always do Firestore check to get freshest data
        // Also resolve by uid in case partner-app wrote to merchants/{uid}
        getDoc(doc(db, 'merchants', String(item.id)))
          .then(snap => {
            const data = snap.data() ?? {};
            // Offline if: explicitly false/offline, OR in our live ref
            const firestoreOffline =
              data.isOnline === false ||
              data.status === 'offline' ||
              data.status === 'مغلق';
            const refOffline = gasOfflineIdsRef.current.has(item.id);
            applyGasStatus(!(firestoreOffline || refOffline));
          })
          .catch(() => {
            // Fallback: use ref only
            applyGasStatus(!gasOfflineIdsRef.current.has(item.id));
          });
      }
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

  // ── Traffic layer handled by <TrafficLayer> component (crowdsourced) ─────────
  // (old static-roads useEffect removed)

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
    setTaxiAutoConnect(false);
    taxiStepRef.current   = 'idle';
    poiMarkersRef.current.forEach(m=>m.remove());
    poiMarkersRef.current = [];
    taxiFromPtRef.current = null;
    if (mapRef.current) mapRef.current.getContainer().style.cursor = adminModeRef.current ? 'crosshair' : '';
  },[]);

  // ── Clear search loop state (called from stopOrderTracking) ───────────────
  const clearLoop = useCallback(()=>{
    setLoopActive(false);
    setLoopCountdown(null);
    setLoopCurrentDriver('');
    loopIgnoredRef.current.clear();
    loopFromPtRef.current  = null;
    loopToPtRef.current    = null;
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
    setTaxiAutoConnect(false);
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
        const res     = await fetch('/api/drivers-online?category=taxi');
        const drivers: OnlineDriver[] = await res.json();

        // DEBUG ── log every driver returned by the API ──────────────────────
        console.log(`[autoFindDriver] API returned ${drivers.length} driver(s)`, drivers.map(d=>({
          name: d.driverName, locationId: d.locationId,
          isOnline: d.isOnline, isBusy: d.isBusy,
          updatedAt: d.updatedAt,
          distKm: +haversineDist(loc.lat, loc.lng, d.lat, d.lng).toFixed(3),
          userLat: loc.lat, userLng: loc.lng, driverLat: d.lat, driverLng: d.lng,
        })));

        // ── Live dual-gate cross-check (approved_agents ∩ drivers) ─────────
        // getLiveFilteredPhones() reads the two onSnapshot Sets synchronously —
        // they are kept current in real-time, so an offline driver disappears
        // from the Set within milliseconds of closing the partner app.
        const { phones: filteredPhones, source: filterSource } = getLiveFilteredPhones();
        const fsFiltered = filteredPhones !== null
          ? drivers.filter(d => filteredPhones.has((d.phone ?? '').trim()))
          : drivers; // both gates null → trust REST only
        console.log(`[autoFindDriver] live dual-gate (${filterSource}): ${fsFiltered.length}/${drivers.length} pass`);

        // ── Fixed radius, sorted nearest-first ───────────────────────────────
        const SEARCH_RADIUS_KM = 2;
        const withDist = fsFiltered
          .map(d => ({ ...d, distKm: haversineDist(loc.lat, loc.lng, d.lat, d.lng) }));
        console.log(`[autoFindDriver] after distance calc — within ${SEARCH_RADIUS_KM} km:`,
          withDist.filter(d => d.distKm <= SEARCH_RADIUS_KM).map(d=>({name:d.driverName, distKm:+d.distKm.toFixed(3)})));
        const nearby = withDist
          .filter(d => d.distKm <= SEARCH_RADIUS_KM)
          .sort((a, b) => a.distKm - b.distKm);

        setTaxiAutoSearching(false);

        if (nearby.length === 0) {
          setTaxiNoDriverSnack(true);
          setTimeout(()=> setTaxiNoDriverSnack(false), 6000);
          return;
        }

        const nearest = nearby[0];
        loopInitDistRef.current = nearest.distKm; // saved for loop start in submitTaxiOrder

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

        // ── Activate auto-connect: submit order automatically when route ready ─
        setTaxiAutoConnect(true);

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

  // ── Keep autoFindDriverRef stable for snapshot callbacks ─────────────────
  useEffect(() => { autoFindDriverRef.current = autoFindDriver; }, [autoFindDriver]);
  // ── Keep loopActiveRef in sync for snapshot callbacks ────────────────────
  useEffect(() => { loopActiveRef.current = loopActive; }, [loopActive]);
  // ── Keep activeDriverIdRef in sync ────────────────────────────────────────
  useEffect(() => { activeDriverIdRef.current = activeDriverId; }, [activeDriverId]);

  // ── Gas form: open with auto reverse-geocode ─────────────────────────────
  const openGasForm = useCallback(async ()=>{
    // Block if there's already an active gas order
    if (activeGasOrderIdRef.current !== null) return;
    setGasFormError(null);
    setGasFormSuccess(false);
    setGasFormLoading(false);
    // pre-fill name/phone from localStorage
    try {
      const saved = JSON.parse(localStorage.getItem('diyala_user') ?? 'null');
      if (saved?.name)  setTaxiUserName(saved.name);
      if (saved?.phone) setTaxiUserPhone(saved.phone);
    } catch { /* ignore */ }
    const loc = userLocationRef.current;
    if (loc) {
      setGasLocationAddr(`${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}`);
      try {
        const r = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=json&lat=${loc.lat}&lon=${loc.lng}&accept-language=ar`
        );
        const d = await r.json();
        if (d?.display_name) setGasLocationAddr(d.display_name);
      } catch { /* keep lat/lng fallback */ }
    } else {
      setGasLocationAddr('');
    }
    setShowGasForm(true);
  }, []);

  // Keep bridge ref current so buildPopup can call openGasForm
  useEffect(() => { openGasFormRef.current = openGasForm; }, [openGasForm]);

  const submitGasOrder = useCallback(async ()=>{
    const name  = taxiUserName.trim();
    const phone = taxiUserPhone.trim();
    if (!name)  { setGasFormError('الرجاء إدخال اسمك في الملف الشخصي أولاً');        return; }
    if (!phone) { setGasFormError('الرجاء إدخال رقم الهاتف في الملف الشخصي أولاً'); return; }
    const loc = userLocationRef.current;
    if (!loc)   { setGasFormError('تعذّر تحديد موقعك — فعّل الـ GPS أولاً');          return; }
    setGasFormError(null);
    setGasFormLoading(true);
    try {
      const res = await fetch('/api/gas-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userName:        name,
          phone,
          locationAddress: gasLocationAddr || `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}`,
          lat: loc.lat,
          lng: loc.lng,
        }),
      });
      if (res.ok) {
        const respData = await res.json().catch(()=>({}));
        const gasOrderId: number|null = (respData as any).orderId ?? null;
        setGasFormSuccess(true);
        if (gasOrderId) {
          setActiveGasOrderId(gasOrderId);
          setActiveGasOrderStatus('pending');
          activeGasOrderIdRef.current    = gasOrderId;
          activeGasOrderStatusRef.current = 'pending';
          localStorage.setItem('diyala_active_gas_order', JSON.stringify({ orderId: gasOrderId }));
          // ── Mirror to Firestore for real-time driver tracking ──────────
          const uid = auth.currentUser?.uid;
          if (uid) {
            setDoc(doc(db, 'orders', String(gasOrderId)), {
              customer_id:  uid,
              type:         'gas',
              status:       'pending',
              customer_lat: loc.lat,
              customer_lng: loc.lng,
              created_at:   serverTimestamp(),
            }).catch(() => { /* non-fatal */ });
          }
        }
        setTimeout(()=>{ setShowGasForm(false); setGasFormSuccess(false); }, 2500);
      } else {
        const d = await res.json().catch(()=>({}));
        setGasFormError((d as any).error ?? 'فشل إرسال الطلب');
      }
    } catch {
      setGasFormError('خطأ في الشبكة — أعد المحاولة');
    } finally {
      setGasFormLoading(false);
    }
  }, [taxiUserName, taxiUserPhone, gasLocationAddr]);

  // ── Open cancel confirmation dialog ────────────────────────────────────────
  const cancelGasOrder = useCallback(()=>{
    if (!activeGasOrderIdRef.current) return;
    setShowGasCancelConfirm(true);
  }, []);

  // ── Permanently delete gas order (called after user confirms) ──────────────
  const deleteGasOrderConfirmed = useCallback(async ()=>{
    const id = activeGasOrderIdRef.current;
    setShowGasCancelConfirm(false);
    if (!id) return;
    // Optimistically clear UI so user sees instant feedback
    setActiveGasOrderId(null);
    setActiveGasOrderStatus('pending');
    setShowGasChat(false);
    activeGasOrderIdRef.current     = null;
    activeGasOrderStatusRef.current = 'pending';
    localStorage.removeItem('diyala_active_gas_order');
    try {
      await fetch(`/api/gas-orders/${id}`, { method: 'DELETE' });
    } catch { /* ignore network errors — UI already cleared */ }
  }, []);

  // ── Quick-dispatch: pre-fill name/phone from localStorage when form opens ──
  useEffect(()=>{
    if (!showTaxiQuickForm) return;
    try {
      const saved = JSON.parse(localStorage.getItem('diyala_user') ?? 'null');
      if (saved?.name)  setTaxiUserName(saved.name);
      if (saved?.phone) setTaxiUserPhone(saved.phone);
    } catch { /* ignore */ }
  },[showTaxiQuickForm]);

  // ── dispatchTaxiNow: find nearest driver and post order without routing UI ─
  const dispatchTaxiNow = useCallback(async ()=>{
    const name  = taxiUserName.trim();
    const phone = taxiUserPhone.trim();
    // Accept any non-empty dest; also accept manual pin selection even if dest is still loading
    const destRaw  = taxiQuickDest.trim();
    const hasManualTo = !!taxiQuickToPt;
    const dest = destRaw === 'جاري احتساب المسار...'
      ? (taxiQuickToPt ? `${taxiQuickToPt.lat.toFixed(5)}, ${taxiQuickToPt.lng.toFixed(5)}` : '')
      : (destRaw || (hasManualTo ? `${taxiQuickToPt!.lat.toFixed(5)}, ${taxiQuickToPt!.lng.toFixed(5)}` : ''));
    if (!name)  { setTaxiQuickError('الرجاء إدخال اسمك');        return; }
    if (!phone) { setTaxiQuickError('الرجاء إدخال رقم الهاتف');  return; }
    if (!dest)  { setTaxiQuickError('الرجاء تحديد الوجهة أو اكتبها يدوياً'); return; }
    const loc = userLocationRef.current;
    if (!loc)   { setTaxiQuickError('تعذّر تحديد موقعك — فعّل الـ GPS أولاً'); return; }

    // Use manual selected points if available, otherwise fall back to GPS
    const fromPt = taxiQuickFromPt  || loc;
    const toPt   = taxiQuickToPt    || taxiQuickFromPt || loc;
    const estPrice = taxiQuickPrice ?? 0;

    setTaxiQuickError(null);
    setShowTaxiQuickForm(false);
    setTaxiLoading(true);

    // ── helper: safe JSON fetch with non-JSON guard ────────────────────────────
    const safeFetch = async (url: string, opts?: RequestInit) => {
      const r = await fetch(url, opts);
      const text = await r.text();
      let json: unknown = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { ok: r.ok, status: r.status, json };
    };

    try {
      // ── 1. Get online drivers — up to 3 attempts (handles network flaps + cold-start) ──
      let dOk = false, dStatus = 0, dRaw: unknown = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await safeFetch('/api/drivers-online?category=taxi');
          dOk = r.ok; dStatus = r.status; dRaw = r.json;
          if (dOk && Array.isArray(dRaw)) break;           // success
          console.warn(`[dispatch] attempt ${attempt+1}: status=${dStatus} json=${JSON.stringify(dRaw)?.slice(0,60)}`);
        } catch (netErr) {
          console.warn(`[dispatch] attempt ${attempt+1} network error:`, netErr);
          dOk = false;
        }
        if (attempt < 2) await new Promise(r => setTimeout(r, 1800));
      }
      if (!dOk && !Array.isArray(dRaw)) {
        setTaxiQuickError('السيرفر لا يستجيب — أعد المحاولة بعد لحظة');
        setShowTaxiQuickForm(true);
        setTaxiLoading(false);
        return;
      }

      type DriverRow = { locationId:number; driverName:string; phone:string; lat:number; lng:number; };
      const drivers: DriverRow[] = Array.isArray(dRaw) ? (dRaw as DriverRow[]) : [];
      const SEARCH_RADIUS_KM = 2;

      // ── Live dual-gate cross-check (approved_agents ∩ drivers) ──────────────
      // getLiveFilteredPhones() reads the pre-warmed onSnapshot Sets synchronously.
      // If a driver is offline in Firestore (isOnline=false or status≠available),
      // their phone is NOT in the Set → they are excluded here before any order is placed.
      const { phones: dispatchFilterPhones, source: dispatchFilterSrc } = getLiveFilteredPhones();
      const fsFilteredDrivers = dispatchFilterPhones !== null
        ? drivers.filter(d => dispatchFilterPhones.has((d.phone ?? '').trim()))
        : drivers; // both gates still null (very first mount, no internet) → trust REST
      console.log(`[dispatchTaxiNow] live dual-gate (${dispatchFilterSrc}): ${fsFilteredDrivers.length}/${drivers.length} pass`);

      const available = fsFilteredDrivers
        .map(d=>({ ...d, distKm: haversineDist(fromPt.lat, fromPt.lng, d.lat, d.lng) }))
        .filter(d=>d.distKm <= SEARCH_RADIUS_KM)
        .sort((a,b)=>a.distKm - b.distKm);

      console.log(`[dispatchTaxiNow] ${available.length} driver(s) within ${SEARCH_RADIUS_KM} km`,
        available.map(d=>({ name:d.driverName, distKm:+d.distKm.toFixed(3) })));

      if (available.length === 0) {
        setTaxiNoDriverSnack(true);
        setTimeout(()=> setTaxiNoDriverSnack(false), 7000);
        setTaxiLoading(false);
        return;
      }

      // Save loop context
      loopFromPtRef.current    = fromPt;
      loopToPtRef.current      = toPt;
      loopUserNameRef.current  = name;
      loopUserPhoneRef.current = phone;
      loopEstPriceRef.current  = estPrice;
      loopIgnoredRef.current.clear();
      localStorage.setItem('diyala_user', JSON.stringify({ name, phone }));

      const first = available[0];
      loopIgnoredRef.current.add(first.locationId);
      setLoopCurrentDriver(first.driverName);
      setLoopCurrentDriverDist(first.distKm);

      // ── 2. Post order to nearest driver (retry up to 3 times on network error) ─
      const orderBody = JSON.stringify({
        locationId:     first.locationId,
        userName:       name,
        phone:          phone,
        destination:    dest,
        fromLat:        fromPt.lat,
        fromLng:        fromPt.lng,
        toLat:          toPt.lat,
        toLng:          toPt.lng,
        estimatedPrice: estPrice,
        lat:            fromPt.lat,
        lng:            fromPt.lng,
      });
      let oOk = false, oStatus = 0, oData: unknown = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await safeFetch('/api/orders', {
            method: 'POST', headers: {'Content-Type':'application/json'}, body: orderBody,
          });
          oOk = r.ok; oStatus = r.status; oData = r.json;
          console.log(`[dispatchTaxiNow] POST attempt ${attempt+1} → status=${oStatus}`, oData);
          if (oOk || oStatus === 400 || oStatus === 409) break; // success or definitive error
        } catch (netErr) {
          console.warn(`[dispatchTaxiNow] POST attempt ${attempt+1} network error:`, netErr);
          oStatus = 0;
        }
        if (attempt < 2) await new Promise(r => setTimeout(r, 1500));
      }

      if (oOk) {
        const orderId = (oData as any)?.orderId ?? null;
        setActiveOrderId(orderId);
        setActiveOrderStatus('pending');
        activeOrderIdRef.current    = orderId;
        activeOrderStatusRef.current = 'pending';
        setActiveDriverPhone(first.phone);
        setActiveDriverId(first.locationId);
        localStorage.setItem('diyala_active_order', JSON.stringify({ orderId, driverPhone: first.phone, driverId: first.locationId }));
        setLoopActive(true);
        setLoopCountdown(120);
      } else if (oStatus === 400) {
        // Validation error — don't loop, show the actual error
        const errMsg = (oData as any)?.error ?? 'بيانات الطلب غير صحيحة';
        console.error('[dispatchTaxiNow] order 400:', oData);
        setTaxiQuickError(errMsg);
        setShowTaxiQuickForm(true);
      } else {
        // Driver busy or other — try next in loop
        redirectToNextRef.current();
      }
    } catch (err: any) {
      console.error('[dispatchTaxiNow] error:', err?.name, err?.message, err);
      const isNetworkError = err instanceof TypeError;
      const detail = err?.message ? ` (${err.message})` : '';
      setTaxiQuickError(
        isNetworkError
          ? `خطأ شبكة — تأكد من الاتصال وأعد المحاولة${detail}`
          : `خطأ: ${err?.message ?? 'غير معروف'}`
      );
      setShowTaxiQuickForm(true);
    } finally {
      setTaxiLoading(false);
    }
  },[taxiUserName, taxiUserPhone, taxiQuickDest, taxiQuickFromPt, taxiQuickToPt, taxiQuickPrice]);

  // ── Auto-fill name/phone from localStorage when quick form opens ──────────
  useEffect(()=>{
    if (!showTaxiQuickForm) return;
    try {
      const stored = localStorage.getItem('diyala_user');
      if (stored) {
        const { name, phone } = JSON.parse(stored);
        if (name)  setTaxiUserName(name);
        if (phone) setTaxiUserPhone(phone);
      }
    } catch {}
    // Delay focus so the DOM is rendered
    setTimeout(()=> taxiDestInputRef.current?.focus(), 120);
  },[showTaxiQuickForm]);

  // ── Quick-route helpers ────────────────────────────────────────────────────
  const clearQuickRoute = useCallback(()=>{
    taxiQuickPolyRef.current?.remove();  taxiQuickPolyRef.current = null;
    taxiManualARef.current?.remove();    taxiManualARef.current   = null;
    setTaxiQuickFromPt(null); taxiQuickFromPtRef.current = null;
    setTaxiQuickToPt(null);   setTaxiQuickDistKm(null);  setTaxiQuickPrice(null);
  },[]);

  const startManualPick = useCallback(()=>{
    clearQuickRoute();
    setShowTaxiQuickForm(false);
    setTaxiManualStep('from');
    taxiManualStepRef.current = 'from';
    // Force Leaflet to recalculate container size after overlay removal
    setTimeout(()=> mapRef.current?.invalidateSize(), 60);
    const loc = userLocationRef.current;
    if (loc && mapRef.current) mapRef.current.flyTo([loc.lat, loc.lng], 15, { animate:true, duration:0.9 });
  },[clearQuickRoute]);

  const cancelManualPick = useCallback(()=>{
    setTaxiManualStep('idle');
    taxiManualStepRef.current = 'idle';
    taxiManualARef.current?.remove(); taxiManualARef.current = null;
    setShowTaxiQuickForm(true);
  },[]);

  const confirmManualPin = useCallback(()=>{
    if (!mapRef.current) return;
    const center = mapRef.current.getCenter();
    const pt = { lat: center.lat, lng: center.lng };
    if (taxiManualStepRef.current === 'from') {
      taxiQuickFromPtRef.current = pt;
      setTaxiQuickFromPt(pt);
      // Drop teal A-marker
      taxiManualARef.current?.remove();
      taxiManualARef.current = L.marker([pt.lat, pt.lng], {
        icon: L.divIcon({
          className:'',
          html:`<div style="display:flex;flex-direction:column;align-items:center;gap:2px">
            <div style="width:34px;height:34px;border-radius:50%;background:rgba(0,245,212,0.18);border:2.5px solid #00f5d4;display:flex;align-items:center;justify-content:center;box-shadow:0 0 18px #00f5d466">
              <span style="font-size:12px;font-weight:900;color:#00f5d4;font-family:Orbitron,sans-serif">A</span>
            </div>
          </div>`,
          iconSize:[34,34], iconAnchor:[17,34],
        }),
      }).addTo(mapRef.current);
      setTaxiManualStep('to');
      taxiManualStepRef.current = 'to';
    } else if (taxiManualStepRef.current === 'to') {
      setTaxiQuickToPt(pt);
      const fromPt = taxiQuickFromPtRef.current || userLocationRef.current || pt;

      // Show form immediately with loading placeholder
      setTaxiQuickDest('جاري احتساب المسار...');
      setTaxiManualStep('idle');
      taxiManualStepRef.current = 'idle';
      setShowTaxiQuickForm(true);

      // Async: OSRM road route + reverse geocode in background
      (async () => {
        // ── 1. OSRM road route ────────────────────────────────────────────
        try {
          const osrmUrl =
            `https://router.project-osrm.org/route/v1/driving/` +
            `${fromPt.lng},${fromPt.lat};${pt.lng},${pt.lat}` +
            `?overview=full&geometries=geojson`;
          const res  = await fetch(osrmUrl);
          const data = await res.json();
          if (data.routes?.length > 0) {
            const route  = data.routes[0];
            const distKm = route.distance / 1000;
            const price  = calculateTaxiFare(distKm);
            setTaxiQuickDistKm(distKm);
            setTaxiQuickPrice(price);
            // Draw road-following polyline
            taxiQuickPolyRef.current?.remove();
            if (mapRef.current) {
              const latLngs = (route.geometry.coordinates as [number,number][])
                .map(([lng, lat]) => [lat, lng] as [number, number]);
              taxiQuickPolyRef.current = L.polyline(latLngs, {
                color:'#f5c518', weight:4, opacity:0.92,
              }).addTo(mapRef.current);
              mapRef.current.fitBounds(taxiQuickPolyRef.current.getBounds(), { padding:[60,60] });
            }
          } else {
            throw new Error('no route');
          }
        } catch {
          // Fallback: straight line + haversine
          const distKm = haversineDist(fromPt.lat, fromPt.lng, pt.lat, pt.lng);
          setTaxiQuickDistKm(distKm);
          setTaxiQuickPrice(Math.round(distKm * 750 / 250) * 250);
          taxiQuickPolyRef.current?.remove();
          if (mapRef.current) {
            taxiQuickPolyRef.current = L.polyline(
              [[fromPt.lat, fromPt.lng],[pt.lat, pt.lng]],
              { color:'#f5c518', weight:3.5, opacity:0.85, dashArray:'9 5' }
            ).addTo(mapRef.current);
            mapRef.current.fitBounds(
              L.latLngBounds([[fromPt.lat, fromPt.lng],[pt.lat, pt.lng]]),
              { padding:[60,60] }
            );
          }
        }
        // ── 2. Reverse-geocode destination name (Nominatim) ───────────────
        try {
          const r2   = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${pt.lat}&lon=${pt.lng}&accept-language=ar`,
            { headers:{'User-Agent':'DiyalaHealthMap/1.0'} }
          );
          const d2   = await r2.json();
          const name = d2.display_name
            ? d2.display_name.split(',').slice(0, 3).join('، ')
            : `${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)}`;
          setTaxiQuickDest(name);
        } catch {
          setTaxiQuickDest(`${pt.lat.toFixed(5)}, ${pt.lng.toFixed(5)}`);
        }
      })();
    }
  },[]);

  // ── Destination autocomplete (Nominatim / OpenStreetMap) ──────────────────
  const searchDestination = useCallback((q: string)=>{
    setTaxiQuickDest(q);
    setTaxiDestSuggs([]);
    if (taxiDestTimerRef.current) clearTimeout(taxiDestTimerRef.current);
    if (q.length < 2) { setTaxiDestLoading(false); return; }
    setTaxiDestLoading(true);
    taxiDestTimerRef.current = setTimeout(async ()=>{
      try {
        const r = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=5&countrycodes=iq&accept-language=ar`,
          { headers:{'User-Agent':'DiyalaHealthMap/1.0'} }
        );
        const data: any[] = await r.json();
        setTaxiDestSuggs(data.map(d=>({
          name: d.display_name.split(',').slice(0,3).join('، '),
          lat:  parseFloat(d.lat),
          lng:  parseFloat(d.lon),
        })));
      } catch { setTaxiDestSuggs([]); }
      finally   { setTaxiDestLoading(false); }
    }, 500);
  },[]);

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
    // Remove driver marker
    driverMarkerRef.current?.remove();   driverMarkerRef.current   = null;
    // Remove ALL taxi route/pin overlays
    taxiGlowLineRef.current?.remove();   taxiGlowLineRef.current   = null;
    taxiRouteLineRef.current?.remove();  taxiRouteLineRef.current  = null;
    taxiQuickPolyRef.current?.remove();  taxiQuickPolyRef.current  = null;
    taxiFromMarkerRef.current?.remove(); taxiFromMarkerRef.current = null;
    taxiToMarkerRef.current?.remove();   taxiToMarkerRef.current   = null;
    // Reset active-order state
    setActiveOrderId(null);    setActiveOrderStatus('pending');
    setDriverLat(null);        setDriverLng(null);
    setDriverDistKm(null);     setDriverEtaMin(null);
    setShowChat(false);        prevDriverPosRef.current = null;
    activeOrderIdRef.current     = null;
    activeOrderStatusRef.current = 'pending';
    // Reset chat unread
    setHasUnreadChat(false);   setUnreadChatCount(0);
    // Reset quick taxi form (so map opens fresh for next order)
    setTaxiQuickDest('');
    setTaxiQuickFromPt(null);  setTaxiQuickToPt(null);
    setTaxiQuickDistKm(null);  setTaxiQuickPrice(null);
    // Reset manual taxi routing UI state
    setTaxiStep('idle');       taxiStepRef.current = 'idle';
    setTaxiFromPt(null);       setTaxiToPt(null);
    setTaxiDistKm(null);       setTaxiEstPrice(null);
    setTaxiDriverItem(null);   setTaxiAutoConnect(false);
    setTaxiSuccess(false);     setTaxiError(null);
    setTaxiFromPlaced(false);  setTaxiDestName('');
    taxiFromPtRef.current = null;
    localStorage.removeItem('diyala_active_order');
    // Clear the search loop
    setLoopActive(false); setLoopCountdown(null); setLoopCurrentDriver(''); setLoopCurrentDriverDist(null);
    loopIgnoredRef.current.clear();
    loopFromPtRef.current = null; loopToPtRef.current = null;
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
          // Chat is NOT auto-opened — user must tap 💬 or status-bar button
        })
        .catch(()=>{ /* network error — leave as-is, polling will start */ });
    } catch {
      localStorage.removeItem('diyala_active_order');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  // ── Restore active gas order from localStorage on first load ──────────────
  useEffect(()=>{
    const saved = localStorage.getItem('diyala_active_gas_order');
    if (!saved) return;
    try {
      const raw = JSON.parse(saved);
      const orderId = Number(raw?.orderId);
      if (!Number.isFinite(orderId) || orderId <= 0) return;
      fetch(`/api/gas-orders/${orderId}`)
        .then(r=>r.json())
        .then(data=>{
          const s = data?.status ?? '';
          if (!s || s === 'done' || s === 'finished' || s === 'completed' || s === 'cancelled') {
            localStorage.removeItem('diyala_active_gas_order');
            return;
          }
          setActiveGasOrderId(orderId);
          setActiveGasOrderStatus(s);
          activeGasOrderIdRef.current    = orderId;
          activeGasOrderStatusRef.current = s;
        })
        .catch(()=>{ /* network error — polling will start */ });
    } catch {
      localStorage.removeItem('diyala_active_gas_order');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  // ── Driver markers are handled exclusively by <ActiveOrderTracker> ──────
  // ActiveOrderTracker (Firestore) shows a marker only when an order reaches
  // status 'accepted'/'in_progress'/'driving' for the current user.
  // No global driver stream, no public map markers, no duplicate icons.

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

  // ── Keep activeDriverPhoneRef current (safe for useCallback closures) ────────
  useEffect(() => { activeDriverPhoneRef.current = activeDriverPhone; }, [activeDriverPhone]);

  // ── Live Firestore listeners for driver availability (always-on from mount) ──
  // Started once when the map mounts — NOT gated on loopActive.
  // This eliminates the race-condition where loopActive=true triggers the
  // listener AND autoFindDriver at the same time; listeners are pre-warmed
  // before the user ever taps "search", so Sets are already populated.
  //
  // Gate 1 — approved_agents: status='available' AND isOnline=true (admin-managed)
  // Gate 2 — drivers col:     isOnline=true  (partner-app authoritative)
  // A driver must appear in BOTH sets to be routed (intersection).
  // Any field change in Firestore propagates here in < 1 second.
  useEffect(() => {
    // Gate 2 — drivers collection: isOnline=true/`'true'` AND status='available'
    // ⚠ NO where('isOnline') clause — Firestore type-checks strictly.
    //   Flutter may write boolean true OR string 'true'; we filter client-side
    //   via isOnlineTruthy() to accept both without losing any driver docs.
    const unsubDrivers = onSnapshot(
      collection(db, 'drivers'),   // fetch ALL — filter client-side (type-mismatch safe)
      (snap) => {
        // ── Rebuild from scratch on every snapshot ─────────────────────────
        // When a driver presses "offline" their Firestore doc stays — only
        // isOnline changes to false.  We re-filter the ENTIRE collection here
        // so React state reflects reality immediately without comparing with
        // a stale previous array.
        const phones      = new Set<string>();
        const activeDocs: Array<{phone:string; lat:number|null; lng:number|null; name:string}> = [];

        snap.forEach(d => {
          const data = d.data();
          // ── Category gate: taxi only ──────────────────────────────────────
          const dtype: string = (data.driverType ?? data.category ?? '').toString().toLowerCase();
          if (dtype && dtype !== 'taxi') return;
          // ── Live status gates (direct field read, no prev comparison) ─────
          if (!isOnlineTruthy(data.isOnline)) return;   // bool true OR string 'true'
          if (!isAvailable(data.status))      return;   // must be 'available'
          const p = data.phone as string | undefined;
          if (!p) return;
          phones.add(p.trim());
          activeDocs.push({
            phone: p.trim(),
            lat:   typeof data.lat === 'number' ? data.lat : null,
            lng:   typeof data.lng === 'number' ? data.lng : null,
            name:  (data.driverName ?? data.name ?? '') as string,
          });
        });

        // Update live-filter ref (sync, for getLiveFilteredPhones cross-check)
        liveOnlineDriverPhonesRef.current = (!snap.empty || phones.size > 0) ? phones : null;

        // Update React state → triggers immediate re-render + marker redraw
        setOnlineDrivers(activeDocs);

        // ── New-driver trigger (kept for search loop auto-wake) ──────────────
        const prev        = prevDriverPhonesRef.current;
        const hasNewPhone = [...phones].some(p => !prev.has(p));
        prevDriverPhonesRef.current = new Set(phones);

        if (hasNewPhone && loopActiveRef.current) {
          console.log(`[LiveFilter/drivers] new driver(s) detected while loop active — triggering search`);
          if (newDriverSearchTimer.current) clearTimeout(newDriverSearchTimer.current);
          newDriverSearchTimer.current = setTimeout(() => {
            if (loopActiveRef.current) autoFindDriverRef.current();
          }, 900);
        }

        // ── Offline-driver trigger (direct field check, no prev diff needed) ─
        // If the driver currently being contacted is no longer in the online
        // set, redirect to the next driver immediately.
        if (loopActiveRef.current && !redirectLockRef.current) {
          const curPhone = activeDriverPhoneRef.current;
          if (curPhone && !phones.has(curPhone)) {
            console.log(`[LiveFilter/drivers] current driver (${curPhone}) went offline — redirecting`);
            redirectToNextRef.current();
          }
        }

        console.log(`[LiveFilter/drivers] online+available: ${phones.size}`, [...phones]);
      },
      (err) => {
        console.warn('[LiveFilter/drivers] snapshot error:', err?.code);
        liveOnlineDriverPhonesRef.current = null;
      },
    );

    // Gate 1 — approved_agents: status='available' AND isOnline truthy
    // Fetch by status (reliable string) and filter isOnline client-side.
    const unsubAgents = onSnapshot(
      query(collection(db, 'approved_agents'), where('status', '==', 'available')),
      (snap) => {
        const phones = new Set<string>();
        snap.forEach(d => {
          const data = d.data();
          if (!isOnlineTruthy(data.isOnline)) return;  // skip offline
          const p = data.phone as string | undefined;
          if (p) phones.add(p.trim());
        });
        liveAvailableAgentPhonesRef.current = phones;
        console.log(`[LiveFilter/approved_agents] available+online phones: ${phones.size}`, [...phones]);
      },
      (err) => {
        console.warn('[LiveFilter/approved_agents] snapshot error:', err?.code);
        liveAvailableAgentPhonesRef.current = null;
      },
    );

    return () => { unsubDrivers(); unsubAgents(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // ← empty deps: start once on mount, stop on unmount

  // ── Render / sync Leaflet markers for online taxi drivers ─────────────────
  // Runs every time `onlineDrivers` state changes (set by Firestore snapshot).
  // Uses a phone→marker Map to add new drivers, remove offline drivers, and
  // update positions — all in < 1 ms, no page refresh needed.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const existing = onlineDriverMarkersRef.current;
    const currentPhones = new Set(onlineDrivers.map(d => d.phone));

    // Remove markers for drivers who went offline
    existing.forEach((marker, phone) => {
      if (!currentPhones.has(phone)) {
        marker.remove();
        existing.delete(phone);
      }
    });

    // Add or reposition markers for online drivers
    onlineDrivers.forEach(driver => {
      if (typeof driver.lat !== 'number' || typeof driver.lng !== 'number') return;
      if (existing.has(driver.phone)) {
        // Driver already has a marker — just move it
        existing.get(driver.phone)!.setLatLng([driver.lat, driver.lng]);
      } else {
        // New driver came online — create a marker
        const icon = L.divIcon({
          className: '',
          html: `<div style="
            width:30px;height:30px;border-radius:50%;
            background:rgba(0,245,212,0.18);
            border:2px solid #00f5d4;
            display:flex;align-items:center;justify-content:center;
            font-size:16px;box-shadow:0 0 8px #00f5d4aa;">
            🚕
          </div>`,
          iconSize: [30, 30],
          iconAnchor: [15, 15],
        });
        const marker = L.marker([driver.lat, driver.lng], {
          icon,
          zIndexOffset: 400,
          title: driver.name || 'سائق متاح',
        }).addTo(map);
        existing.set(driver.phone, marker);
      }
    });
  }, [onlineDrivers]);

  // ── Read live phone Sets synchronously (no await needed) ──────────────────
  // Returns intersection of both gates, or falls back gracefully if either is null.
  const getLiveFilteredPhones = useCallback((): { phones: Set<string> | null; source: string } => {
    const agentPhones  = liveAvailableAgentPhonesRef.current;
    const driverPhones = liveOnlineDriverPhonesRef.current;

    if (agentPhones === null && driverPhones === null)
      return { phones: null, source: 'REST-only (both gates null)' };
    if (driverPhones === null)
      return { phones: agentPhones, source: 'approved_agents only' };
    if (agentPhones === null)
      return { phones: driverPhones, source: 'drivers col only' };

    // Both available → INTERSECTION (must pass both gates)
    const intersection = new Set<string>();
    agentPhones.forEach(p => { if (driverPhones.has(p)) intersection.add(p); });
    return {
      phones: intersection,
      source: `intersection (${agentPhones.size}×${driverPhones.size}→${intersection.size})`,
    };
  }, []);

  // ── Sync Firestore order doc — called after REST/SSE status change ─────────
  // This bridges the REST-based order system to Firestore so ActiveOrderTracker
  // (which watches Firestore) can show the live driver marker + route polyline.
  const syncOrderToFirestore = useCallback((
    orderId:   number,
    status:    string,
    driverLat: number | null,
    driverLng: number | null,
  ) => {
    const uid = auth.currentUser?.uid;
    if (!uid || !orderId) return;
    const payload: Record<string, unknown> = { status };
    if (typeof driverLat === 'number') payload.driver_lat = driverLat;
    if (typeof driverLng === 'number') payload.driver_lng = driverLng;
    updateDoc(doc(db, 'orders', String(orderId)), payload).catch(() => {
      // Doc might not exist yet (race condition on first call) — ignore silently
    });
    // ── Mark driver busy/free in Firestore approved_agents ─────────────────
    // This blocks the Firestore cross-check from routing new customers to a
    // busy driver when the REST isBusy state hasn't propagated yet.
    const TRIP_ACTIVE    = new Set(['accepted', 'in_progress', 'driving']);
    const TRIP_TERMINAL  = new Set(['done', 'finished', 'completed', 'cancelled', 'rejected']);
    const phone = activeDriverPhoneRef.current;
    if (phone) {
      if (TRIP_ACTIVE.has(status)) {
        // Firestore: mark agent as on-trip (non-fatal if Security Rules deny)
        getDocs(
          query(collection(db, 'approved_agents'), where('phone', '==', phone))
        ).then(snap => {
          snap.forEach(d => updateDoc(d.ref, { status: 'on_trip', isBusy: true }).catch(() => {}));
        }).catch(() => {});
      } else if (TRIP_TERMINAL.has(status)) {
        getDocs(
          query(collection(db, 'approved_agents'), where('phone', '==', phone))
        ).then(snap => {
          snap.forEach(d => updateDoc(d.ref, { status: 'available', isBusy: false }).catch(() => {}));
        }).catch(() => {});
      }
    }
  }, []);

  // ── Apply order snapshot (status + driver position) ───────────────────────
  // source: 'firestore' → do NOT write back to Firestore (breaks circular loop)
  //         'sse' | 'rest' → sync status to Firestore so ActiveOrderTracker wakes
  const applyOrderSnapshot = useCallback((data: {
    id: number; status: string;
    driverLat?: number|null; driverLng?: number|null;
    fromLat?: number|null; fromLng?: number|null;
    locationId?: number|null; userName?: string|null;
  }, source: 'firestore' | 'sse' | 'rest' = 'rest')=>{
    setActiveOrderStatus(data.status);
    activeOrderStatusRef.current = data.status;

    // ── Bridge REST/SSE status → Firestore so ActiveOrderTracker wakes up ────
    // Skip when data already came from Firestore — prevents a circular echo:
    //   applyOrderSnapshot → syncOrderToFirestore → onSnapshot → applyOrderSnapshot ...
    if (source !== 'firestore') {
      syncOrderToFirestore(
        data.id,
        data.status,
        data.driverLat ?? null,
        data.driverLng ?? null,
      );
    }

    if (data.status === 'accepted' || data.status === 'driving') {
      // Chat is NOT auto-opened — user must tap 💬 or status-bar button
      // Driver accepted → stop the search loop
      setLoopActive(false); setLoopCountdown(null);
    }
    // Driver rejected → redirect to next available driver immediately.
    // ① redirectLockRef blocks duplicate calls (poll + SSE race).
    // ② Clear current-driver UI instantly so the customer sees "searching…"
    //    rather than the rejected driver's name / countdown freezing on screen.
    if (data.status === 'rejected') {
      // Reset UI to "searching" state before the async redirect completes
      setActiveOrderStatus('pending');
      activeOrderStatusRef.current = 'pending';
      setLoopCurrentDriver('');
      setLoopCurrentDriverDist(null);
      setLoopCountdown(120);
      if (!redirectLockRef.current) {
        // Keep activeOrderId — reassign-driver PATCH reuses same orderId.
        // No setActiveOrderId(null) here: Firestore listener stays alive
        // on the same document; reassign-driver will reset it to 'pending'.
        redirectToNextRef.current();
      }
      return;
    }
    // 'done' or 'finished' → hide chat and show rating dialog before clearing
    if (data.status === 'done' || data.status === 'finished' || data.status === 'cancelled') {
      // ── 'cancelled' while search loop is active: driver app sent 'cancelled'
      //    instead of 'rejected' — treat identically: redirect to next driver.
      //    Do NOT stop the loop; the same orderId is reused via reassign-driver.
      if (data.status === 'cancelled' && loopActiveRef.current) {
        setActiveOrderStatus('pending');
        activeOrderStatusRef.current = 'pending';
        setLoopCurrentDriver('');
        setLoopCurrentDriverDist(null);
        setLoopCountdown(120);
        if (!redirectLockRef.current) redirectToNextRef.current();
        return;
      }
      // Stale 'cancelled' guard (safety net for old redirect code path)
      if (data.status === 'cancelled' && isRedirectingRef.current) return;

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
    // Only update driver position state (UI bar) for active statuses.
    // The Leaflet marker itself is rendered exclusively by <ActiveOrderTracker>
    // which gates on status ∈ ['accepted','in_progress','driving'] via Firestore.
    const ACTIVE_STATUSES = new Set(['accepted','in_progress','driving','pending']);
    if (ACTIVE_STATUSES.has(data.status) &&
        typeof data.driverLat === 'number' && typeof data.driverLng === 'number') {
      setDriverLat(data.driverLat);
      setDriverLng(data.driverLng);
      // Compute distance & ETA from driver → pickup point (status bar display only)
      const refLat = data.fromLat ?? null;
      const refLng = data.fromLng ?? null;
      if (typeof refLat === 'number' && typeof refLng === 'number') {
        const distKm = haversineKm(data.driverLat, data.driverLng, refLat, refLng);
        setDriverDistKm(distKm);
        setDriverEtaMin(Math.round(distKm * 2.5));
      }
    }
  },[stopOrderTracking, syncOrderToFirestore]);

  // ── Firestore real-time order listener (replaces the old 3-second REST poll) ─
  // The Firestore document `orders/{orderId}` is written by:
  //   • This web app (setDoc on order creation, syncOrderToFirestore on status change)
  //   • The Flutter partner app (accepted / rejected / in_progress / done)
  // Listening here gives sub-second latency with zero caching — the exact same
  // field-level change from the driver app arrives here immediately.
  // `source:'firestore'` prevents applyOrderSnapshot from writing back to
  // Firestore (syncOrderToFirestore), avoiding a circular snapshot echo.
  useEffect(()=>{
    if (!activeOrderId) return;
    const unsub = onSnapshot(
      doc(db, 'orders', String(activeOrderId)),
      (snap) => {
        if (!snap.exists()) return;
        const d = snap.data();
        if (!d || redirectLockRef.current) return; // skip during redirect
        applyOrderSnapshot({
          id:        activeOrderId,
          status:    (d.status ?? '') as string,
          driverLat: typeof d.driver_lat === 'number' ? d.driver_lat : null,
          driverLng: typeof d.driver_lng === 'number' ? d.driver_lng : null,
          fromLat:   typeof d.from_lat   === 'number' ? d.from_lat   : null,
          fromLng:   typeof d.from_lng   === 'number' ? d.from_lng   : null,
          locationId: d.location_id ?? null,
          userName:   d.user_name   ?? null,
        }, 'firestore');
      },
      () => { /* Firestore unreachable — SSE below is the fallback */ },
    );
    return () => unsub();
  },[activeOrderId, applyOrderSnapshot]);

  // ── SSE listener: order_update + driver_update ────────────────────────────
  // driver_update fires when any driver goes online/offline via the REST API
  // (PUT /api/drivers-online → online, DELETE → offline).
  // We merge it into the onlineDrivers React state so map markers update
  // immediately without waiting for the next Firestore snapshot.
  useEffect(()=>{
    const es = new EventSource('/api/events');

    es.addEventListener('order_update', (e: MessageEvent)=>{
      try {
        const { order } = JSON.parse(e.data) as { order: any };
        if (order?.id !== activeOrderIdRef.current) return;
        applyOrderSnapshot(order, 'sse');
      } catch { /* */ }
    });

    es.addEventListener('driver_update', (e: MessageEvent)=>{
      try {
        const { driver } = JSON.parse(e.data) as { driver: any };
        if (!driver) return;
        const phone = String(driver.phone ?? '').trim();
        if (!phone) return;
        const goingOffline = !driver.isOnline || driver.isBusy === true;
        setOnlineDrivers(prev => {
          if (goingOffline) {
            // Remove this driver from the visible list immediately
            return prev.filter(d => d.phone !== phone);
          }
          // Driver came online or updated position — add or update
          const idx = prev.findIndex(d => d.phone === phone);
          const entry = {
            phone,
            lat:  typeof driver.lat  === 'number' ? driver.lat  : (prev[idx]?.lat  ?? null),
            lng:  typeof driver.lng  === 'number' ? driver.lng  : (prev[idx]?.lng  ?? null),
            name: (driver.driverName ?? prev[idx]?.name ?? '') as string,
          };
          if (idx === -1) return [...prev, entry];
          return prev.map((d, i) => i === idx ? entry : d);
        });
        // Also keep the live-filter ref in sync (used by getLiveFilteredPhones cross-check)
        if (liveOnlineDriverPhonesRef.current !== null) {
          if (goingOffline) liveOnlineDriverPhonesRef.current.delete(phone);
          else              liveOnlineDriverPhonesRef.current.add(phone);
        }
        // If the loop is active and the current driver just went offline, redirect.
        // Check by phone OR by locationId (locationId is more reliable when phone is empty).
        if (goingOffline && loopActiveRef.current && !redirectLockRef.current) {
          const matchByPhone = phone && phone === activeDriverPhoneRef.current;
          const matchById    = driver.locationId && driver.locationId === activeDriverIdRef.current;
          if (matchByPhone || matchById) {
            console.log(`[driver_update SSE] current driver (${phone || driver.locationId}) went offline — redirecting`);
            redirectToNextRef.current();
          }
        }
      } catch { /* */ }
    });

    es.onerror = ()=> es.close();
    return ()=> es.close();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  // ── SSE listener for gas order updates + gas chat messages ───────────────
  useEffect(()=>{
    const es = new EventSource('/api/events');
    es.addEventListener('gas_order_update', (e: MessageEvent)=>{
      try {
        const { order } = JSON.parse(e.data) as { order: { id:number; status:string; agentId?:string } };
        if (!order || order.id !== activeGasOrderIdRef.current) return;
        setActiveGasOrderStatus(order.status);
        activeGasOrderStatusRef.current = order.status;
        const FINAL = new Set(['done','finished','completed','cancelled']);
        if (FINAL.has(order.status)) {
          activeGasOrderIdRef.current     = null;
          activeGasOrderStatusRef.current = 'pending';
          localStorage.removeItem('diyala_active_gas_order');
          setShowGasChat(false);
          setGasUnread(false);
          // Show success/cancel message briefly then auto-reset UI
          setTimeout(()=>{
            setActiveGasOrderId(null);
            setActiveGasOrderStatus('pending');
          }, order.status === 'cancelled' ? 800 : 1500);
        }
      } catch { /* */ }
    });
    es.addEventListener('gas_new_message', (e: MessageEvent)=>{
      try {
        const { message } = JSON.parse(e.data) as { message: { gasOrderId:number; senderRole:string } };
        if (!message || message.gasOrderId !== activeGasOrderIdRef.current) return;
        if (message.senderRole === 'agent') {
          setGasUnread(true);
        }
      } catch { /* */ }
    });
    es.onerror = ()=> es.close();
    return ()=> es.close();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  // ── Keep showChatRef in sync with showChat ────────────────────────────────
  useEffect(()=>{ showChatRef.current = showChat; }, [showChat]);

  // ── Taxi chat unread: Firestore live listener (with count) ───────────────
  useEffect(()=>{
    if (!activeOrderId) {
      setHasUnreadChat(false);
      setUnreadChatCount(0);
      return;
    }
    // Listen to ALL messages — count those from non-customer (driver/agent)
    // that arrived after the chat was last opened (tracked by showChatRef).
    const q = query(
      collection(db, 'chats', String(activeOrderId), 'messages'),
      orderBy('timestamp', 'asc'),
    );
    const unsub = onSnapshot(q, snap => {
      if (snap.empty) return;
      if (showChatRef.current) return; // chat is open — nothing is unread
      // Count messages from non-customer sender
      let count = 0;
      snap.forEach(d => {
        const data = d.data();
        const sender: string = data.senderId ?? data.sender ?? '';
        if (sender !== 'customer') count++;
      });
      if (count > 0) {
        setHasUnreadChat(true);
        setUnreadChatCount(count);
      }
    }, () => {/* ignore errors */});
    return () => unsub();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOrderId]);

  // ── Poll gas order status every 4 s ───────────────────────────────────────
  useEffect(()=>{
    if (!activeGasOrderId) return;
    const poll = async ()=>{
      try {
        const res = await fetch(`/api/gas-orders/${activeGasOrderId}`);
        if (!res.ok) return;
        const data = await res.json();
        setActiveGasOrderStatus(data.status);
        activeGasOrderStatusRef.current = data.status;
        const FINAL = new Set(['done','finished','completed','cancelled']);
        if (FINAL.has(data.status)) {
          activeGasOrderIdRef.current     = null;
          activeGasOrderStatusRef.current = 'pending';
          localStorage.removeItem('diyala_active_gas_order');
          setShowGasChat(false);
          setGasUnread(false);
          setTimeout(()=>{
            setActiveGasOrderId(null);
            setActiveGasOrderStatus('pending');
          }, data.status === 'cancelled' ? 800 : 1500);
        }
      } catch { /* silent */ }
    };
    poll();
    const iv = setInterval(poll, 4000);
    return ()=> clearInterval(iv);
  },[activeGasOrderId]);

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
          // ── Mirror to Firestore for real-time driver tracking ────────────
          // from_lat/from_lng = pickup point, to_lat/to_lng = destination
          // ActiveOrderTracker reads these to show destination marker.
          const uid = auth.currentUser?.uid;
          if (uid) {
            setDoc(doc(db, 'orders', String(orderId)), {
              customer_id:     uid,
              type:            'taxi',
              status:          'pending',
              customer_lat:    taxiFromPt?.lat ?? null,
              customer_lng:    taxiFromPt?.lng ?? null,
              from_lat:        taxiFromPt?.lat ?? null,
              from_lng:        taxiFromPt?.lng ?? null,
              to_lat:          taxiToPt?.lat   ?? null,
              to_lng:          taxiToPt?.lng   ?? null,
              estimated_fare:  taxiEstPrice    ?? 0,
              route_dist_km:   taxiDistKm      ?? null,
              created_at:      serverTimestamp(),
            }).catch(() => { /* non-fatal */ });
          }
          // ── Start the search loop countdown ─────────────────────────────
          loopFromPtRef.current    = taxiFromPt;
          loopToPtRef.current      = taxiToPt;
          loopUserNameRef.current  = taxiUserName.trim();
          loopUserPhoneRef.current = taxiUserPhone.trim();
          loopEstPriceRef.current  = taxiEstPrice ?? 0;
          loopIgnoredRef.current.clear();
          loopIgnoredRef.current.add(taxiDriverItem.id);
          setLoopCurrentDriver(taxiDriverItem.name);
          setLoopCurrentDriverDist(loopInitDistRef.current); // dist saved by autoFindDriver (null if manual pick)
          setLoopActive(true);
          setLoopCountdown(120);
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

  // ── Auto-connect: submit order automatically once route is drawn ──────────
  // Fires when: auto-search found a driver (taxiAutoConnect=true)
  //             AND user tapped destination (taxiStep='confirm')
  //             AND OSRM route finished loading (!taxiRouteLoading)
  //             AND we have user credentials from localStorage
  useEffect(()=>{
    if (!taxiAutoConnect) return;
    if (taxiStep !== 'confirm') return;
    if (taxiRouteLoading) return;
    if (!taxiToPt) return;
    // Only auto-submit if user info is available from localStorage
    if (!taxiUserName.trim() || !taxiUserPhone.trim()) return;
    // Short delay so the route line is visible before submission
    const t = setTimeout(()=> submitTaxiOrder(), 400);
    return ()=> clearTimeout(t);
  },[taxiAutoConnect, taxiStep, taxiRouteLoading, taxiToPt, taxiUserName, taxiUserPhone, submitTaxiOrder]);

  // ── Redirect to next available driver (loop core) ────────────────────────
  const redirectToNextDriver = useCallback(async ()=>{
    // ── Concurrency lock ─────────────────────────────────────────────────────
    if (redirectLockRef.current) return;
    redirectLockRef.current  = true;
    isRedirectingRef.current = true;

    // curOrderId stays set — we PATCH reassign-driver to the next driver.
    // No customer-cancel, no setActiveOrderId(null): the customer NEVER receives
    // a 'cancelled' SSE. The Firestore listener keeps watching the same doc.
    const curOrderId = activeOrderIdRef.current;

    // Find next uncontacted driver
    const loc = loopFromPtRef.current;
    if (!loc) { redirectLockRef.current = false; isRedirectingRef.current = false; stopOrderTracking(); return; }

    try {
      // API filters isOnline=true & isBusy=false & category=taxi at DB level.
      const res     = await fetch('/api/drivers-online?category=taxi');
      const drivers: OnlineDriver[] = await res.json();

      const SEARCH_RADIUS_KM = 2;

      console.log(`[redirectToNext] API ${drivers.length} driver(s), ignored:[${[...loopIgnoredRef.current].join(',')}]`,
        drivers.map(d => ({
          name: d.driverName, locationId: d.locationId,
          distKm: +haversineDist(loc.lat, loc.lng, d.lat, d.lng).toFixed(3),
          ignored: loopIgnoredRef.current.has(d.locationId),
        })));

      const { phones: filteredPhones2, source: filterSource2 } = getLiveFilteredPhones();
      const fsFiltered = filteredPhones2 !== null
        ? drivers.filter(d => filteredPhones2.has((d.phone ?? '').trim()))
        : drivers; // both gates null → trust REST only
      console.log(`[redirectToNext] dual-gate (${filterSource2}): ${fsFiltered.length}/${drivers.length} pass`);

      const available = fsFiltered
        .filter(d => !loopIgnoredRef.current.has(d.locationId))
        .map(d => ({ ...d, distKm: haversineDist(loc.lat, loc.lng, d.lat, d.lng) }))
        .filter(d => d.distKm <= SEARCH_RADIUS_KM)
        .sort((a, b) => a.distKm - b.distKm);
      console.log(`[redirectToNext] available: ${available.length}`, available.map(d=>({name:d.driverName, distKm:+d.distKm.toFixed(3)})));

      if (available.length === 0) {
        redirectLockRef.current = false; isRedirectingRef.current = false;
        setLoopActive(false); setLoopCountdown(null); setLoopCurrentDriver(''); setLoopCurrentDriverDist(null);
        setTaxiNoDriverSnack(true);
        setTimeout(()=> setTaxiNoDriverSnack(false), 7000);
        stopOrderTracking();
        return;
      }

      const next = available[0];
      setLoopCurrentDriver(next.driverName);
      setLoopCurrentDriverDist(next.distKm);

      if (curOrderId) {
        // ── Reassign same order to next driver ─────────────────────────────
        // PATCH updates locationId + resets status to 'pending' server-side.
        // No 'cancelled' event is broadcast to the customer SSE stream.
        const patchRes = await fetch(`/api/orders/${curOrderId}/reassign-driver`, {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ locationId: next.locationId }),
        });

        if (patchRes.ok) {
          // Mirror the status reset to Firestore (same doc, back to pending)
          updateDoc(doc(db, 'orders', String(curOrderId)), { status: 'pending' }).catch(()=>{});
          setActiveDriverPhone(next.phone);
          setActiveDriverId(next.locationId);
          activeDriverPhoneRef.current = next.phone;
          setActiveOrderStatus('pending');
          activeOrderStatusRef.current = 'pending';
          localStorage.setItem('diyala_active_order',
            JSON.stringify({ orderId: curOrderId, driverPhone: next.phone, driverId: next.locationId }));
          loopIgnoredRef.current.add(next.locationId);
          setLoopActive(true);
          setLoopCountdown(120);
          isRedirectingRef.current = false;
          redirectLockRef.current  = false;
        } else {
          // Reassign failed (driver busy/gone) — skip and try the next one
          isRedirectingRef.current = false;
          redirectLockRef.current  = false;
          loopIgnoredRef.current.add(next.locationId);
          redirectToNextRef.current();
        }
      } else {
        // ── Fallback: no existing order (first attempt) — create via POST ──
        const fromPt = loopFromPtRef.current!;
        const toPt   = loopToPtRef.current;
        const orderRes = await fetch('/api/orders', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            locationId:     next.locationId,
            userName:       loopUserNameRef.current,
            phone:          loopUserPhoneRef.current,
            destination:    toPt
              ? `من (${fromPt.lat.toFixed(4)},${fromPt.lng.toFixed(4)}) إلى (${toPt.lat.toFixed(4)},${toPt.lng.toFixed(4)})`
              : `(${fromPt.lat.toFixed(4)},${fromPt.lng.toFixed(4)})`,
            fromLat: fromPt.lat, fromLng: fromPt.lng,
            toLat:   toPt?.lat ?? fromPt.lat, toLng: toPt?.lng ?? fromPt.lng,
            estimatedPrice: loopEstPriceRef.current,
            lat: fromPt.lat, lng: fromPt.lng,
          }),
        });
        if (orderRes.ok) {
          const { orderId: newId } = await orderRes.json();
          setActiveOrderId(newId); setActiveOrderStatus('pending');
          activeOrderIdRef.current = newId; activeOrderStatusRef.current = 'pending';
          setActiveDriverPhone(next.phone);
          setActiveDriverId(next.locationId);
          activeDriverPhoneRef.current = next.phone;
          localStorage.setItem('diyala_active_order',
            JSON.stringify({ orderId: newId, driverPhone: next.phone, driverId: next.locationId }));
          const uid2 = auth.currentUser?.uid;
          if (uid2 && newId) {
            setDoc(doc(db, 'orders', String(newId)), {
              customer_id: uid2, type: 'taxi', status: 'pending',
              customer_lat: fromPt.lat, customer_lng: fromPt.lng,
              from_lat: fromPt.lat, from_lng: fromPt.lng,
              to_lat: toPt?.lat ?? fromPt.lat, to_lng: toPt?.lng ?? fromPt.lng,
              created_at: serverTimestamp(),
            }).catch(()=>{});
          }
          loopIgnoredRef.current.add(next.locationId);
          setLoopActive(true);
          setLoopCountdown(120);
          isRedirectingRef.current = false;
          redirectLockRef.current  = false;
        } else {
          isRedirectingRef.current = false;
          redirectLockRef.current  = false;
          loopIgnoredRef.current.add(next.locationId);
          redirectToNextRef.current();
        }
      }
    } catch {
      isRedirectingRef.current = false;
      redirectLockRef.current  = false;
      stopOrderTracking();
    }
  },[stopOrderTracking]);

  // Keep redirectToNextRef always pointing at latest version
  useEffect(()=>{ redirectToNextRef.current = redirectToNextDriver; },[redirectToNextDriver]);

  // ── Fazaa: clear all active map layers to focus on rescue ─────────────────
  const clearMapForRescue = useCallback(()=>{
    stopOrderTracking();   // cancels taxi order, removes taxi route + markers
    clearRouteVisuals();   // removes clinic/navigation route polylines
    onClearRoute();        // resets parent route target state
  },[stopOrderTracking, clearRouteVisuals, onClearRoute]);

  // ── Countdown tick: decrement every second, trigger redirect at 0 ─────────
  useEffect(()=>{
    if (!loopActive || loopCountdown === null) return;
    if (loopCountdown <= 0) { redirectToNextRef.current(); return; }
    const t = setTimeout(()=> setLoopCountdown(c=> (c ?? 1) - 1), 1000);
    return ()=> clearTimeout(t);
  },[loopActive, loopCountdown]);

  // ── Helper: returns true for mobile-service categories (taxi / gas agent)
  // These are NOT fixed physical locations — they should never appear as map pins.
  // Driver positions are shown exclusively by <ActiveOrderTracker> after order acceptance.
  const isMobileServiceItem = useCallback((item: MapItem) => {
    const labelEn = catMapRef.current.get(item.kind)?.labelEn ?? '';
    return isTaxiCat(item.kind, labelEn) || isGasCat(item.kind, labelEn);
  }, []);

  // Sync markers — 3 modes:
  //  NAV    (routeTarget set)       → hide ALL category markers (route handles it)
  //  FOCUS  (activeFilter set)      → show only that category (excluding taxi/gas)
  //  ALL    (no filter / taxi/gas)  → show every non-mobile-service item
  useEffect(()=>{
    if (!mapRef.current) return;
    // Clear existing category markers
    Object.values(markersRef.current).forEach(m=>m.remove());
    markersRef.current={};

    // NAV MODE — no regular markers; navTargetMarkerRef handles the target pin
    if (routeTarget) return;

    // If activeFilter is a mobile-service category (taxi/gas), treat as "no filter"
    // so static landmarks remain visible while the taxi/gas UI takes over
    const filterLabelEn = catMapRef.current.get(activeFilter)?.labelEn ?? '';
    const filterIsMobile = isTaxiCat(activeFilter, filterLabelEn) || isGasCat(activeFilter, filterLabelEn);
    const effectiveFilter = filterIsMobile ? '' : activeFilter;

    const visible = effectiveFilter
      ? items.filter(i => i.kind === effectiveFilter && i.status !== 'معطّل' && !isMobileServiceItem(i))
      : items.filter(i => i.status !== 'معطّل' && !isMobileServiceItem(i));

    visible.forEach(item=>{
      const isOpen    = item.status==='مفتوح';
      const isSelected= selectedItem?.id===item.id;
      const popupClass= `map-popup cat-${item.kind}`;
      const marker    = L.marker([item.lat,item.lng],{icon:makeIcon(item.kind,catMapRef.current,isOpen,isSelected,item.name,item.icon_url)}).addTo(mapRef.current!);
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
  },[items,activeFilter,selectedItem,buildPopup,routeTarget,isMobileServiceItem]);

  // Update selected icon without full re-render (skip in nav mode)
  useEffect(()=>{
    if (routeTarget) return;
    // Same mobile-service exclusion — never update icons for taxi/gas pins (they don't exist)
    const filterLabelEn2 = catMapRef.current.get(activeFilter)?.labelEn ?? '';
    const filterIsMobile2 = isTaxiCat(activeFilter, filterLabelEn2) || isGasCat(activeFilter, filterLabelEn2);
    const effectiveFilter2 = filterIsMobile2 ? '' : activeFilter;
    const visible = effectiveFilter2
      ? items.filter(i => i.kind === effectiveFilter2 && i.status !== 'معطّل' && !isMobileServiceItem(i))
      : items.filter(i => i.status !== 'معطّل' && !isMobileServiceItem(i));
    visible.forEach(item=>{
      markersRef.current[item.id]?.setIcon(makeIcon(item.kind,catMapRef.current,item.status==='مفتوح',selectedItem?.id===item.id,item.name,item.icon_url));
    });
  },[selectedItem,items,activeFilter,routeTarget,isMobileServiceItem]);

  // ── Nav target marker — show dedicated pin during navigation ──────────────
  useEffect(()=>{
    // Remove old nav target marker
    navTargetMarkerRef.current?.remove();
    navTargetMarkerRef.current = null;
    if (!routeTarget || !mapRef.current) return;
    // Create a bold target marker (pulse ring via CSS class)
    const icon = makeIcon(routeTarget.kind, catMapRef.current, routeTarget.status==='مفتوح', true, routeTarget.name, routeTarget.icon_url);
    const m = L.marker([routeTarget.lat, routeTarget.lng], { icon, zIndexOffset: 9000 }).addTo(mapRef.current);
    m.bindPopup(L.popup({className:`map-popup cat-${routeTarget.kind}`,offset:[0,-8],closeButton:true,autoClose:false,autoPan:false}).setContent(buildPopup(routeTarget)));
    navTargetMarkerRef.current = m;
  },[routeTarget, buildPopup]);

  // ── Manual-pick navigation layer: show ALL saved locations as reference dots ──
  // So user can see doctors, gas stations, landmarks while dragging map
  useEffect(()=>{
    if (!mapRef.current) return;
    if (taxiManualStep !== 'idle') {
      // Remove old layer
      manualNavLayerRef.current?.remove();
      const group = L.layerGroup();
      items.filter(i=>i.status!=='معطّل' && !isMobileServiceItem(i)).forEach(item=>{
        const cat   = catMapRef.current.get(item.kind);
        const color = cat?.color ?? '#00f5d4';
        // Dot marker — non-interactive so map drag works through it
        const dot = L.circleMarker([item.lat, item.lng], {
          radius:6, color, fillColor:color, fillOpacity:0.85,
          weight:1.5, bubblingMouseEvents:false,
        } as L.CircleMarkerOptions);
        dot.bindTooltip(item.name, { direction:'top', offset:[0,-6] });
        group.addLayer(dot);
      });
      group.addTo(mapRef.current);
      manualNavLayerRef.current = group;
      // Re-render Leaflet after overlay state change to restore tiles+style
      mapRef.current.invalidateSize();
    } else {
      manualNavLayerRef.current?.remove();
      manualNavLayerRef.current = null;
    }
  },[taxiManualStep, items]);

  // Draw route — only when routeTarget changes (NOT on every userLocation update)
  // Using userLocationRef avoids re-triggering flyToBounds on every GPS tick
  useEffect(()=>{
    clearRouteVisuals();
    if (!routeTarget||!mapRef.current) return;
    const loc = userLocationRef.current;
    if (!loc) return;
    drawRoute(mapRef.current,loc,routeTarget,setRouteInfo,setRouteLoading,routeGlowRef,routeLineRef);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[routeTarget,clearRouteVisuals]);

  const handleCancelRoute = useCallback(() => {
    // 1. Clear clinic/doctor route
    clearRouteVisuals();
    onClearRoute();
    // 2. Clear nav target marker (nav mode pin)
    navTargetMarkerRef.current?.remove(); navTargetMarkerRef.current = null;
    // 3. Clear POI route (global overlay)
    poiRouteGlowRef.current?.remove(); poiRouteGlowRef.current = null;
    poiRouteLineRef.current?.remove(); poiRouteLineRef.current = null;
    setHasPoiRoute(false);
    // 4. Clear Nominatim place route
    placeGlowRef.current?.remove(); placeGlowRef.current = null;
    placeLineRef.current?.remove(); placeLineRef.current = null;
    // 5. Close any open popup
    mapRef.current?.closePopup();
    // 6. Fly back to user location
    const loc = userLocationRef.current;
    if (loc && mapRef.current) {
      mapRef.current.flyTo([loc.lat, loc.lng], 15, { animate: true, duration: 1.2 });
    }
  }, [clearRouteVisuals, onClearRoute]);

  // ── Category list visibility & lift offset ───────────────────────────────
  const isCategoryListVisible =
    !!activeFilter &&
    activeFilter !== '__fuel_stations__' &&
    !routeTarget &&
    !selectedPlace &&
    items.filter(i => i.kind === activeFilter && i.status !== 'معطّل').length > 0;

  /** px to add to every floating button when the category list is showing */
  const LIST_LIFT = isCategoryListVisible ? 148 : 0;

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
              {/* ── Fuel Stations toggle button ── */}
              <button
                onClick={() => {
                  const next = activeFilter === '__fuel_stations__' ? '' : '__fuel_stations__';
                  onFilterChange(next);
                  setShowMoreModal(false);
                }}
                style={{
                  padding:'8px 16px',
                  background: activeFilter==='__fuel_stations__' ? 'rgba(245,197,24,0.18)' : 'rgba(5,8,15,0.92)',
                  border:'none',
                  borderBottom: activeFilter==='__fuel_stations__' ? '2px solid #f5c518' : '2px solid transparent',
                  color: activeFilter==='__fuel_stations__' ? '#f5c518' : 'rgba(255,255,255,0.35)',
                  fontFamily:'Orbitron,sans-serif',fontSize:'10px',letterSpacing:'0.1em',
                  cursor:'pointer',transition:'all 0.2s',
                  display:'flex',flexDirection:'column',alignItems:'center',gap:'3px',
                  minWidth:'90px',flexShrink:0,
                  boxShadow: activeFilter==='__fuel_stations__' ? 'inset 0 0 20px rgba(245,197,24,0.18)' : 'none',
                  position:'relative',
                }}>
                <span style={{fontSize:'15px'}}>⛽</span>
                <span style={{whiteSpace:'nowrap'}}>FUEL</span>
                <span style={{fontSize:'11px',fontFamily:'Rajdhani,sans-serif',opacity:0.8,whiteSpace:'nowrap'}}>
                  محطات الوقود
                </span>
                {activeFilter==='__fuel_stations__' && (
                  <span style={{
                    position:'absolute',top:'6px',right:'6px',
                    width:'6px',height:'6px',borderRadius:'50%',
                    background:'#f5c518',
                    boxShadow:'0 0 6px #f5c518, 0 0 12px #f5c51888',
                    animation:'fuel-top-pulse 1.6s ease-in-out infinite',
                  }}/>
                )}
              </button>

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

      {/* ── Clear Active Filter Button — appears only when a filter is active ── */}
      {activeFilter && (
        <button
          onClick={() => { onFilterChange(''); setShowMoreModal(false); }}
          style={{
            position: 'absolute',
            top: '98px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '5px 14px 5px 10px',
            background: 'rgba(255,45,80,0.13)',
            border: '1px solid rgba(255,45,80,0.45)',
            borderRadius: '20px',
            color: '#ff2d50',
            fontFamily: 'Rajdhani, sans-serif',
            fontSize: '13px',
            fontWeight: 700,
            letterSpacing: '0.04em',
            cursor: 'pointer',
            backdropFilter: 'blur(12px)',
            boxShadow: '0 2px 16px rgba(255,45,80,0.18)',
            transition: 'all 0.18s',
            whiteSpace: 'nowrap',
            direction: 'rtl',
          }}
          onMouseEnter={e => {
            (e.currentTarget as HTMLElement).style.background = 'rgba(255,45,80,0.26)';
            (e.currentTarget as HTMLElement).style.boxShadow = '0 2px 24px rgba(255,45,80,0.38)';
          }}
          onMouseLeave={e => {
            (e.currentTarget as HTMLElement).style.background = 'rgba(255,45,80,0.13)';
            (e.currentTarget as HTMLElement).style.boxShadow = '0 2px 16px rgba(255,45,80,0.18)';
          }}
        >
          <span style={{ fontSize: '15px', lineHeight: 1 }}>✕</span>
          <span>إلغاء الفلتر — عرض الكل</span>
        </button>
      )}

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

      {/* ── Cancel Route — visible whenever ANY route is active ── */}
      {(routeTarget || routeInfo || hasPoiRoute) && (
        <button
          onClick={handleCancelRoute}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.cssText += 'background:rgba(255,45,120,0.28);box-shadow:0 0 24px rgba(255,45,120,0.55);'; }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.cssText += 'background:rgba(255,45,120,0.13);box-shadow:0 0 18px rgba(255,45,120,0.35);'; }}
          style={{
            position:'absolute', top:'12px', right:'12px', zIndex:1200,
            display:'flex', alignItems:'center', gap:'8px',
            padding:'10px 18px',
            background:'rgba(255,45,120,0.13)',
            border:'1.5px solid #ff2d78',
            color:'#ff2d78',
            fontFamily:'Orbitron,sans-serif',
            fontSize:'10px',
            fontWeight:'700',
            letterSpacing:'0.12em',
            cursor:'pointer',
            boxShadow:'0 0 18px rgba(255,45,120,0.35), inset 0 1px 0 rgba(255,255,255,0.06)',
            backdropFilter:'blur(12px)',
            transition:'background 0.18s, box-shadow 0.18s',
          } as React.CSSProperties}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
            <path d="M18 6L6 18M6 6l12 12" stroke="#ff2d78" strokeWidth="2.5" strokeLinecap="round"/>
          </svg>
          إلغاء المسار
        </button>
      )}

      {/* ── GTA V GPS Button ── */}
      {/* bottom shifts up dynamically when Selected Place or Category List is visible */}
      <div style={{
        position:'absolute',
        bottom: selectedPlace
          ? (placeRouteInfo ? '262px' : '208px')
          : `${100 + LIST_LIFT}px`,
        left:'20px',
        zIndex:1001,
        display:'flex',flexDirection:'column',alignItems:'center',gap:'8px',
        transition:'bottom 0.32s cubic-bezier(0.4,0,0.2,1)',
      }}>
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
              // Re-center on user + trigger immediate POI fetch for new viewport
              mapRef.current?.flyTo([userLocation.lat, userLocation.lng], 16, {animate:true, duration:1.5});
              setTimeout(()=>fetchPOIsImmRef.current?.(), 150);
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
              ? 'rgba(0,28,22,0.97)'
              : 'rgba(6,10,18,0.97)',
            border: isTracking ? '2px solid #00f5d4' : '2px solid #00d4ff',
            boxShadow: isTracking
              ? '0 4px 18px rgba(0,0,0,0.7), 0 0 20px rgba(0,245,212,0.55), 0 0 40px rgba(0,245,212,0.2)'
              : '0 4px 18px rgba(0,0,0,0.7), 0 0 14px rgba(0,212,255,0.45), 0 0 28px rgba(0,212,255,0.15)',
            cursor: locating ? 'wait' : 'pointer',
            display:'flex', alignItems:'center', justifyContent:'center',
            padding:0, transition:'all 0.35s cubic-bezier(0.4,0,0.2,1)',
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

      {/* ── Traffic Toggle Button — hidden when destination sheet is open ── */}
      <div style={{
        position:'absolute',
        bottom:`${90 + LIST_LIFT}px`,
        right:'16px',
        zIndex:1000,display:'flex',flexDirection:'column-reverse',alignItems:'center',gap:'4px',
        opacity: selectedPlace ? 0 : 1,
        pointerEvents: selectedPlace ? 'none' : 'auto',
        transition: 'opacity 0.25s ease, bottom 0.32s cubic-bezier(0.4,0,0.2,1)',
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
      {/* ── Manual Pin Overlay (step: from / to) ── */}
      {taxiManualStep !== 'idle' && (
        <>
          {/* Dim top strip with instruction — pointer-events only on the strip itself */}
          <div style={{
            position:'absolute',top:0,left:0,right:0,zIndex:4500,
            background:'rgba(5,8,15,0.88)',backdropFilter:'blur(6px)',
            padding:'14px 20px',direction:'rtl',
            display:'flex',alignItems:'center',justifyContent:'space-between',
            borderBottom:`2px solid ${taxiManualStep==='from'?'#00f5d4':'#ff2d78'}`,
            pointerEvents:'auto',
          }}>
            <div>
              <div style={{fontFamily:'Orbitron,sans-serif',fontSize:'8px',
                color:taxiManualStep==='from'?'rgba(0,245,212,0.6)':'rgba(255,45,120,0.6)',
                letterSpacing:'0.18em',marginBottom:'3px'}}>
                {taxiManualStep==='from' ? 'الخطوة ١ / ٢' : 'الخطوة ٢ / ٢'}
              </div>
              <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:'17px',fontWeight:700,color:'#f5f0d0'}}>
                {taxiManualStep==='from' ? '📍 حرّك الخريطة لنقطة الانطلاق' : '🏁 حرّك الخريطة للوجهة'}
              </div>
            </div>
            <button onClick={cancelManualPick} style={{
              background:'none',border:'1px solid rgba(255,45,120,0.4)',color:'rgba(255,45,120,0.7)',
              fontFamily:'Orbitron,sans-serif',fontSize:'8px',letterSpacing:'0.1em',
              padding:'6px 12px',cursor:'pointer',
            }}>إلغاء</button>
          </div>

          {/* Center crosshair */}
          <div style={{
            position:'absolute',top:'50%',left:'50%',
            transform:'translate(-50%,-50%)',
            zIndex:4500,pointerEvents:'none',
          }}>
            <div style={{position:'relative',width:'56px',height:'56px',display:'flex',alignItems:'center',justifyContent:'center'}}>
              {/* Outer ring */}
              <div style={{position:'absolute',inset:0,borderRadius:'50%',
                border:`2px solid ${taxiManualStep==='from'?'rgba(0,245,212,0.4)':'rgba(255,45,120,0.4)'}`,
                animation:'lf-ping-subtle 2s cubic-bezier(0,0,0.2,1) infinite'}}/>
              {/* Cross lines */}
              <div style={{position:'absolute',top:'50%',left:0,right:0,height:'1.5px',marginTop:'-0.75px',
                background:taxiManualStep==='from'?'rgba(0,245,212,0.7)':'rgba(255,45,120,0.7)'}}/>
              <div style={{position:'absolute',left:'50%',top:0,bottom:0,width:'1.5px',marginLeft:'-0.75px',
                background:taxiManualStep==='from'?'rgba(0,245,212,0.7)':'rgba(255,45,120,0.7)'}}/>
              {/* Center dot */}
              <div style={{width:'8px',height:'8px',borderRadius:'50%',
                background:taxiManualStep==='from'?'#00f5d4':'#ff2d78',
                boxShadow:`0 0 10px ${taxiManualStep==='from'?'#00f5d4':'#ff2d78'}`}}/>
            </div>
          </div>

          {/* Confirm button at bottom */}
          <div style={{
            position:'absolute',bottom:'90px',left:'50%',transform:'translateX(-50%)',
            zIndex:4500,
          }}>
            <button
              onClick={confirmManualPin}
              style={{
                background:taxiManualStep==='from'?'rgba(0,245,212,0.18)':'rgba(255,45,120,0.18)',
                border:`1.5px solid ${taxiManualStep==='from'?'#00f5d4':'#ff2d78'}`,
                color:taxiManualStep==='from'?'#00f5d4':'#ff2d78',
                fontFamily:'Orbitron,sans-serif',fontSize:'11px',letterSpacing:'0.14em',
                padding:'13px 36px',cursor:'pointer',
                boxShadow:`0 0 24px ${taxiManualStep==='from'?'rgba(0,245,212,0.3)':'rgba(255,45,120,0.3)'}`,
                backdropFilter:'blur(8px)',
              }}
            >
              {taxiManualStep==='from' ? '✓ تأكيد موقع الانطلاق' : '✓ تأكيد الوجهة'}
            </button>
          </div>
        </>
      )}

      {/* ── Quick-Dispatch Form: full-screen overlay (auto mode) ── */}
      {showTaxiQuickForm && (
        <div style={{
          position:'absolute',inset:0,zIndex:5000,
          background:'rgba(5,8,15,0.93)',
          display:'flex',alignItems:'center',justifyContent:'center',
          padding:'20px 16px',boxSizing:'border-box',
          backdropFilter:'blur(8px)',
          direction:'rtl',
        }}>
          <div style={{
            background:'rgba(8,12,22,0.98)',
            border:'2px solid rgba(245,197,24,0.6)',
            boxShadow:'0 0 60px rgba(245,197,24,0.18), 0 0 120px rgba(245,197,24,0.08)',
            padding:'28px 24px',
            width:'100%',maxWidth:'380px',
            display:'flex',flexDirection:'column',gap:'16px',
          }}>
            {/* Header */}
            <div style={{textAlign:'center',paddingBottom:'4px'}}>
              {/* Radar animation */}
              <div style={{position:'relative',width:'64px',height:'64px',margin:'0 auto 12px'}}>
                <div style={{position:'absolute',inset:0,borderRadius:'50%',border:'2px solid rgba(245,197,24,0.15)',animation:'lf-ping 2s cubic-bezier(0,0,0.2,1) infinite'}}/>
                <div style={{position:'absolute',inset:'8px',borderRadius:'50%',border:'1.5px solid rgba(245,197,24,0.3)',animation:'lf-ping 2s cubic-bezier(0,0,0.2,1) infinite',animationDelay:'0.4s'}}/>
                <div style={{position:'absolute',inset:'18px',borderRadius:'50%',border:'1.5px solid rgba(245,197,24,0.5)',animation:'lf-ping 2s cubic-bezier(0,0,0.2,1) infinite',animationDelay:'0.8s'}}/>
                <span style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize:'24px'}}>🚕</span>
              </div>
              <div style={{fontFamily:'Orbitron,sans-serif',fontSize:'9px',color:'rgba(245,197,24,0.6)',letterSpacing:'0.2em',marginBottom:'4px'}}>TAXI DISPATCH</div>
              <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:'20px',fontWeight:700,color:'#f5f0d0'}}>طلب تكسي</div>
            </div>

            {/* Fields — Read-only (auto-filled from saved profile) */}
            {([
              { label:'الاسم', value:taxiUserName,  icon:'👤' },
              { label:'الهاتف', value:taxiUserPhone, icon:'📞' },
            ] as const).map(f=>(
              <div key={f.label}>
                <div style={{display:'flex',alignItems:'center',gap:'5px',marginBottom:'5px'}}>
                  <span style={{fontSize:'10px'}}>{f.icon}</span>
                  <span style={{fontFamily:'Rajdhani,sans-serif',fontSize:'11px',color:'rgba(245,197,24,0.55)',letterSpacing:'0.06em'}}>{f.label}</span>
                  <span style={{fontFamily:'Orbitron,sans-serif',fontSize:'7px',color:'rgba(0,245,212,0.5)',letterSpacing:'0.12em',marginRight:'auto'}}>محفوظ</span>
                </div>
                <input
                  readOnly
                  tabIndex={-1}
                  inputMode="none"
                  value={f.value}
                  onFocus={e=>e.target.blur()}
                  style={{
                    width:'100%',boxSizing:'border-box',
                    background:'rgba(245,197,24,0.03)',
                    border:'1px solid rgba(245,197,24,0.15)',
                    color:'rgba(245,240,208,0.6)',fontFamily:'Rajdhani,sans-serif',fontSize:'15px',
                    padding:'10px 12px',outline:'none',
                    cursor:'default',userSelect:'none',
                    WebkitUserSelect:'none',
                  }}
                />
              </div>
            ))}

            {/* Destination — autocomplete + manual */}
            <div style={{position:'relative'}}>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'5px'}}>
                <span style={{fontFamily:'Rajdhani,sans-serif',fontSize:'11px',color:'rgba(245,197,24,0.65)',letterSpacing:'0.06em'}}>الوجهة</span>
                <button
                  onClick={startManualPick}
                  style={{
                    background:'none',border:'1px solid rgba(0,245,212,0.4)',
                    color:'#00f5d4',fontFamily:'Orbitron,sans-serif',fontSize:'7px',
                    letterSpacing:'0.1em',padding:'3px 8px',cursor:'pointer',transition:'all 0.2s',
                  }}
                  onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.background='rgba(0,245,212,0.1)';}}
                  onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.background='none';}}
                >📍 تحديد يدوي</button>
              </div>
              <div style={{position:'relative'}}>
                <input
                  ref={taxiDestInputRef}
                  type="text"
                  value={taxiQuickDest}
                  placeholder="ابحث عن وجهتك..."
                  onChange={e=>searchDestination(e.target.value)}
                  onKeyDown={e=>{ if(e.key==='Escape') setTaxiDestSuggs([]); }}
                  style={{
                    width:'100%',boxSizing:'border-box',
                    background:'rgba(245,197,24,0.08)',
                    border:'1.5px solid rgba(245,197,24,0.5)',
                    color:'#f5f0d0',fontFamily:'Rajdhani,sans-serif',fontSize:'15px',
                    padding:'10px 36px 10px 12px',outline:'none',
                    boxShadow:'0 0 12px rgba(245,197,24,0.1)',
                  }}
                />
                {taxiDestLoading && (
                  <svg width="16" height="16" viewBox="0 0 28 28" fill="none"
                    style={{position:'absolute',top:'50%',left:'10px',transform:'translateY(-50%)',animation:'lf-spin 0.8s linear infinite',pointerEvents:'none'}}>
                    <circle cx="14" cy="14" r="10" stroke="rgba(245,197,24,0.5)" strokeWidth="2.5" strokeDasharray="22 14" strokeLinecap="round"/>
                  </svg>
                )}
              </div>
              {/* Autocomplete dropdown */}
              {taxiDestSuggs.length > 0 && (
                <div style={{
                  position:'absolute',top:'100%',left:0,right:0,zIndex:100,
                  background:'rgba(8,12,22,0.99)',border:'1px solid rgba(245,197,24,0.3)',
                  borderTop:'none',maxHeight:'160px',overflowY:'auto',
                }}>
                  {taxiDestSuggs.map((s,i)=>(
                    <div key={i}
                      onClick={()=>{
                        setTaxiQuickDest(s.name);
                        setTaxiQuickToPt({lat:s.lat, lng:s.lng});
                        setTaxiDestSuggs([]);
                        const fromPt = taxiQuickFromPtRef.current || taxiQuickFromPt || userLocationRef.current;
                        if (!fromPt) return;
                        // OSRM road route
                        (async ()=>{
                          try {
                            const r = await fetch(
                              `https://router.project-osrm.org/route/v1/driving/` +
                              `${fromPt.lng},${fromPt.lat};${s.lng},${s.lat}` +
                              `?overview=full&geometries=geojson`
                            );
                            const data = await r.json();
                            if (data.routes?.length > 0) {
                              const route  = data.routes[0];
                              const distKm = route.distance / 1000;
                              setTaxiQuickDistKm(distKm);
                              setTaxiQuickPrice(calculateTaxiFare(distKm));
                              taxiQuickPolyRef.current?.remove();
                              if (mapRef.current) {
                                const ll = (route.geometry.coordinates as [number,number][])
                                  .map(([lng,lat])=>[lat,lng] as [number,number]);
                                taxiQuickPolyRef.current = L.polyline(ll, {color:'#f5c518',weight:4,opacity:0.92}).addTo(mapRef.current);
                                mapRef.current.fitBounds(taxiQuickPolyRef.current.getBounds(), {padding:[60,60]});
                              }
                            } else { throw new Error(); }
                          } catch {
                            const distKm = haversineDist(fromPt.lat, fromPt.lng, s.lat, s.lng);
                            setTaxiQuickDistKm(distKm);
                            setTaxiQuickPrice(calculateTaxiFare(distKm));
                            taxiQuickPolyRef.current?.remove();
                            if (mapRef.current) {
                              taxiQuickPolyRef.current = L.polyline(
                                [[fromPt.lat,fromPt.lng],[s.lat,s.lng]],
                                {color:'#f5c518',weight:3.5,opacity:0.85,dashArray:'9 5'}
                              ).addTo(mapRef.current);
                            }
                          }
                        })();
                      }}
                      style={{
                        padding:'8px 12px',cursor:'pointer',
                        borderBottom:'1px solid rgba(245,197,24,0.08)',
                        fontFamily:'Rajdhani,sans-serif',fontSize:'13px',color:'#d0c8b0',
                        direction:'rtl',
                      }}
                      onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.background='rgba(245,197,24,0.08)';}}
                      onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.background='';}}
                    >
                      <span style={{marginLeft:'6px',opacity:0.5}}>📍</span>{s.name}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Route summary (shown after manual or autocomplete selection) */}
            {taxiQuickToPt && taxiQuickDistKm !== null && (
              <div style={{
                background:'rgba(0,245,212,0.06)',border:'1px solid rgba(0,245,212,0.25)',
                padding:'10px 12px',display:'flex',justifyContent:'space-between',alignItems:'center',
              }}>
                <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:'12px',color:'rgba(0,245,212,0.8)'}}>
                  <div>📏 {taxiQuickDistKm.toFixed(2)} كم</div>
                  {taxiQuickFromPt && <div style={{fontSize:'10px',color:'rgba(0,245,212,0.5)',marginTop:'2px'}}>من نقطة يدوية</div>}
                </div>
                <div style={{textAlign:'left'}}>
                  <div style={{fontFamily:'Orbitron,sans-serif',fontSize:'14px',color:'#f5c518',fontWeight:900}}>
                    {(taxiQuickPrice ?? 0).toLocaleString()}
                  </div>
                  <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:'9px',color:'rgba(245,197,24,0.5)'}}>دينار عراقي</div>
                </div>
                <button
                  onClick={()=>{ clearQuickRoute(); setTaxiQuickDest(''); }}
                  style={{background:'none',border:'none',color:'rgba(255,45,120,0.6)',cursor:'pointer',fontSize:'16px',padding:'2px 6px'}}
                >✕</button>
              </div>
            )}

            {/* Error */}
            {taxiQuickError && (
              <div style={{
                background:'rgba(255,45,120,0.12)',border:'1px solid rgba(255,45,120,0.4)',
                color:'#ff2d78',fontFamily:'Rajdhani,sans-serif',fontSize:'13px',
                padding:'8px 12px',textAlign:'center',
              }}>{taxiQuickError}</div>
            )}

            {/* Buttons */}
            <div style={{display:'flex',gap:'10px',paddingTop:'4px'}}>
              <button
                onClick={()=>{ setShowTaxiQuickForm(false); setTaxiQuickError(null); setTaxiQuickDest(''); setTaxiDestSuggs([]); clearQuickRoute(); }}
                style={{
                  flex:1,padding:'11px 8px',
                  background:'none',border:'1px solid rgba(245,197,24,0.25)',
                  color:'rgba(245,197,24,0.6)',fontFamily:'Orbitron,sans-serif',fontSize:'9px',
                  letterSpacing:'0.1em',cursor:'pointer',transition:'all 0.2s',
                }}
                onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.background='rgba(245,197,24,0.08)';}}
                onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.background='none';}}
              >إلغاء</button>
              <button
                onClick={dispatchTaxiNow}
                style={{
                  flex:2,padding:'11px 8px',
                  background:'rgba(245,197,24,0.15)',
                  border:'1px solid rgba(245,197,24,0.7)',
                  color:'#f5c518',fontFamily:'Orbitron,sans-serif',fontSize:'9px',
                  letterSpacing:'0.1em',cursor:'pointer',
                  fontWeight:700,transition:'all 0.2s',
                  display:'flex',alignItems:'center',justifyContent:'center',gap:'7px',
                }}
                onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.background='rgba(245,197,24,0.26)';}}
                onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.background='rgba(245,197,24,0.15)';}}
              >
                <span style={{fontSize:'14px'}}>🔍</span>
                ابحث عن أقرب سائق
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Active Gas Order: Status Bar ─────────────────────────────────────── */}
      {activeGasOrderId && (
        <div style={{
          position:'absolute',top:0,left:0,right:0,zIndex:3450,
          display:'flex',justifyContent:'center',padding:'10px 16px 0',
          pointerEvents:'none',
        }}>
          <div style={{
            pointerEvents:'auto',
            background:'rgba(5,8,15,0.97)',
            border:`1px solid ${
              activeGasOrderStatus==='pending'  ? 'rgba(255,45,120,0.65)' :
              activeGasOrderStatus==='accepted' ? 'rgba(0,245,212,0.7)'  :
              activeGasOrderStatus==='done'     ? 'rgba(0,245,212,0.45)' :
              'rgba(255,45,120,0.4)'
            }`,
            boxShadow:`0 0 28px ${
              activeGasOrderStatus==='pending' ? 'rgba(255,45,120,0.22)' :
              'rgba(0,212,255,0.18)'
            }`,
            padding:'10px 18px',direction:'rtl',
            display:'flex',alignItems:'center',gap:'14px',
            maxWidth:'520px',width:'100%',backdropFilter:'blur(12px)',
          }}>
            {/* Pulse dot */}
            <div style={{
              width:'10px',height:'10px',borderRadius:'50%',flexShrink:0,
              background: activeGasOrderStatus==='pending' ? '#ff2d78' : '#00f5d4',
              boxShadow:`0 0 10px ${activeGasOrderStatus==='pending'?'#ff2d78':'#00f5d4'}`,
              animation: (activeGasOrderStatus==='done'||activeGasOrderStatus==='cancelled') ? 'none' : 'lf-ping 1.8s cubic-bezier(0,0,0.2,1) infinite',
            }}/>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontFamily:'Orbitron,sans-serif',fontSize:'8px',color:'rgba(255,255,255,0.3)',letterSpacing:'0.15em',marginBottom:'2px'}}>
                GAS ORDER #{activeGasOrderId}
              </div>
              <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:'15px',fontWeight:700,color:'#e8f8f5',lineHeight:1.2}}>
                {activeGasOrderStatus==='pending'                              ? '⏳ في انتظار قبول الوكيل...'
                :activeGasOrderStatus==='accepted'                             ? '⛽ الوكيل في الطريق إليك!'
                :(activeGasOrderStatus==='done'||activeGasOrderStatus==='finished'||activeGasOrderStatus==='completed') ? '✅ تم التوصيل — شكراً!'
                :activeGasOrderStatus==='cancelled'                            ? '❌ تم إلغاء الطلب'
                :`⏳ ${activeGasOrderStatus}`}
              </div>
            </div>
            {/* Chat button — only when accepted */}
            {activeGasOrderStatus==='accepted' && (
              <button
                onClick={()=>{ setShowGasChat(true); setGasUnread(false); }}
                style={{
                  position:'relative',
                  background: showGasChat ? 'rgba(0,245,212,0.2)' : 'rgba(0,245,212,0.1)',
                  border:'1px solid rgba(0,245,212,0.55)',
                  color:'#00f5d4',cursor:'pointer',
                  fontSize:'14px',padding:'5px 10px',flexShrink:0,
                  borderRadius:'2px',transition:'all 0.2s',
                }}
                title="دردشة مع الوكيل"
              >
                💬
                {gasUnread && (
                  <span style={{
                    position:'absolute',top:'-4px',right:'-4px',
                    width:'10px',height:'10px',borderRadius:'50%',
                    background:'#ff2d78',boxShadow:'0 0 8px #ff2d78',
                    display:'block',
                  }}/>
                )}
              </button>
            )}
            {/* Cancel — only while pending or accepted */}
            {(activeGasOrderStatus==='pending'||activeGasOrderStatus==='accepted') && (
              <button
                onClick={cancelGasOrder}
                style={{
                  background:'rgba(255,45,120,0.12)',
                  border:'1px solid rgba(255,45,120,0.45)',
                  color:'#ff2d78',cursor:'pointer',
                  fontSize:'11px',fontFamily:'Rajdhani,sans-serif',fontWeight:700,
                  padding:'5px 10px',flexShrink:0,letterSpacing:'0.05em',
                  borderRadius:'2px',
                }}
              >إلغاء</button>
            )}
            {/* Dismiss — only after final state */}
            {(activeGasOrderStatus==='done'||activeGasOrderStatus==='finished'||activeGasOrderStatus==='completed'||activeGasOrderStatus==='cancelled') && (
              <button
                onClick={()=>{
                  setActiveGasOrderId(null); setActiveGasOrderStatus('pending');
                  activeGasOrderIdRef.current=null; activeGasOrderStatusRef.current='pending';
                  localStorage.removeItem('diyala_active_gas_order');
                }}
                style={{background:'none',border:'none',color:'rgba(255,255,255,0.4)',cursor:'pointer',fontSize:'18px',padding:'2px 6px',flexShrink:0}}
              >✕</button>
            )}
          </div>
        </div>
      )}

      {/* ── Gas Order Form ────────────────────────────────────────────────────── */}
      {showGasForm && (
        <div style={{
          position:'absolute',inset:0,zIndex:5000,
          background:'rgba(5,8,15,0.93)',
          display:'flex',alignItems:'center',justifyContent:'center',
          padding:'20px 16px',boxSizing:'border-box',
          backdropFilter:'blur(8px)',
          direction:'rtl',
        }}>
          <div style={{
            background:'rgba(8,12,22,0.98)',
            border:'2px solid rgba(255,45,120,0.6)',
            boxShadow:'0 0 60px rgba(255,45,120,0.18), 0 0 120px rgba(255,45,120,0.08)',
            padding:'28px 24px',
            width:'100%',maxWidth:'380px',
            display:'flex',flexDirection:'column',gap:'16px',
          }}>
            {/* Header */}
            <div style={{textAlign:'center',paddingBottom:'4px'}}>
              <div style={{position:'relative',width:'64px',height:'64px',margin:'0 auto 12px'}}>
                <div style={{position:'absolute',inset:0,borderRadius:'50%',border:'2px solid rgba(255,45,120,0.15)',animation:'lf-ping 2s cubic-bezier(0,0,0.2,1) infinite'}}/>
                <div style={{position:'absolute',inset:'8px',borderRadius:'50%',border:'1.5px solid rgba(255,45,120,0.3)',animation:'lf-ping 2s cubic-bezier(0,0,0.2,1) infinite',animationDelay:'0.4s'}}/>
                <div style={{position:'absolute',inset:'18px',borderRadius:'50%',border:'1.5px solid rgba(255,45,120,0.5)',animation:'lf-ping 2s cubic-bezier(0,0,0.2,1) infinite',animationDelay:'0.8s'}}/>
                <span style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',fontSize:'24px'}}>⛽</span>
              </div>
              <div style={{fontFamily:'Orbitron,sans-serif',fontSize:'9px',color:'rgba(255,45,120,0.6)',letterSpacing:'0.2em',marginBottom:'4px'}}>GAS DISPATCH</div>
              <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:'20px',fontWeight:700,color:'#f5f0d0'}}>طلب توصيل غاز</div>
            </div>

            {/* Name + phone — editable if empty, read-only if saved from profile */}
            <div>
              <div style={{display:'flex',alignItems:'center',gap:'5px',marginBottom:'5px'}}>
                <span style={{fontSize:'10px'}}>👤</span>
                <span style={{fontFamily:'Rajdhani,sans-serif',fontSize:'11px',color:'rgba(255,45,120,0.55)',letterSpacing:'0.06em'}}>الاسم</span>
                <span style={{fontFamily:'Orbitron,sans-serif',fontSize:'7px',color:taxiUserName?'rgba(0,245,212,0.5)':'rgba(255,45,120,0.4)',letterSpacing:'0.12em',marginRight:'auto'}}>
                  {taxiUserName ? 'محفوظ' : 'مطلوب'}
                </span>
              </div>
              <input
                readOnly={!!taxiUserName}
                tabIndex={taxiUserName ? -1 : 0}
                inputMode={taxiUserName ? 'none' : 'text'}
                value={taxiUserName}
                onChange={e=>{ if(!taxiUserName) setTaxiUserName(e.target.value); }}
                onFocus={e=>{ if(taxiUserName) e.target.blur(); }}
                placeholder={taxiUserName ? '' : 'اكتب اسمك...'}
                dir="rtl"
                style={{
                  width:'100%',boxSizing:'border-box',
                  background: taxiUserName ? 'rgba(255,45,120,0.03)' : 'rgba(255,45,120,0.08)',
                  border:`1px solid ${taxiUserName?'rgba(255,45,120,0.15)':'rgba(255,45,120,0.5)'}`,
                  color: taxiUserName ? 'rgba(245,240,208,0.6)' : '#f5f0d0',
                  fontFamily:'Rajdhani,sans-serif',fontSize:'15px',
                  padding:'10px 12px',outline:'none',
                  cursor: taxiUserName ? 'default' : 'text',
                  userSelect: taxiUserName ? 'none' : 'auto',
                  WebkitUserSelect: taxiUserName ? 'none' : 'auto',
                }}
              />
            </div>
            <div>
              <div style={{display:'flex',alignItems:'center',gap:'5px',marginBottom:'5px'}}>
                <span style={{fontSize:'10px'}}>📞</span>
                <span style={{fontFamily:'Rajdhani,sans-serif',fontSize:'11px',color:'rgba(255,45,120,0.55)',letterSpacing:'0.06em'}}>الهاتف</span>
                <span style={{fontFamily:'Orbitron,sans-serif',fontSize:'7px',color:taxiUserPhone?'rgba(0,245,212,0.5)':'rgba(255,45,120,0.4)',letterSpacing:'0.12em',marginRight:'auto'}}>
                  {taxiUserPhone ? 'محفوظ' : 'مطلوب'}
                </span>
              </div>
              <input
                readOnly={!!taxiUserPhone}
                tabIndex={taxiUserPhone ? -1 : 0}
                inputMode={taxiUserPhone ? 'none' : 'tel'}
                value={taxiUserPhone}
                onChange={e=>{ if(!taxiUserPhone) setTaxiUserPhone(e.target.value); }}
                onFocus={e=>{ if(taxiUserPhone) e.target.blur(); }}
                placeholder={taxiUserPhone ? '' : '07XX XXX XXXX'}
                dir="ltr"
                style={{
                  width:'100%',boxSizing:'border-box',
                  background: taxiUserPhone ? 'rgba(255,45,120,0.03)' : 'rgba(255,45,120,0.08)',
                  border:`1px solid ${taxiUserPhone?'rgba(255,45,120,0.15)':'rgba(255,45,120,0.5)'}`,
                  color: taxiUserPhone ? 'rgba(245,240,208,0.6)' : '#f5f0d0',
                  fontFamily:'Rajdhani,sans-serif',fontSize:'15px',
                  padding:'10px 12px',outline:'none',
                  cursor: taxiUserPhone ? 'default' : 'text',
                  userSelect: taxiUserPhone ? 'none' : 'auto',
                  WebkitUserSelect: taxiUserPhone ? 'none' : 'auto',
                }}
              />
            </div>

            {/* Auto-detected location */}
            <div>
              <div style={{display:'flex',alignItems:'center',gap:'5px',marginBottom:'5px'}}>
                <span style={{fontSize:'10px'}}>📍</span>
                <span style={{fontFamily:'Rajdhani,sans-serif',fontSize:'11px',color:'rgba(255,45,120,0.55)',letterSpacing:'0.06em'}}>موقع الطلب</span>
                <span style={{fontFamily:'Orbitron,sans-serif',fontSize:'7px',color:'rgba(0,245,212,0.5)',letterSpacing:'0.12em',marginRight:'auto'}}>تلقائي</span>
              </div>
              <input
                readOnly
                tabIndex={-1}
                inputMode="none"
                value={gasLocationAddr || 'جاري تحديد موقعك...'}
                onFocus={e=>e.target.blur()}
                style={{
                  width:'100%',boxSizing:'border-box',
                  background:'rgba(0,245,212,0.04)',
                  border:'1px solid rgba(0,245,212,0.2)',
                  color:'rgba(0,245,212,0.75)',fontFamily:'Rajdhani,sans-serif',fontSize:'12px',
                  padding:'10px 12px',outline:'none',
                  cursor:'default',userSelect:'none',
                  WebkitUserSelect:'none',
                  lineHeight:'1.4',
                }}
              />
            </div>

            {/* Error */}
            {gasFormError && (
              <div style={{
                background:'rgba(255,45,120,0.12)',border:'1px solid rgba(255,45,120,0.4)',
                color:'#ff2d78',fontFamily:'Rajdhani,sans-serif',fontSize:'13px',
                padding:'8px 12px',textAlign:'center',
              }}>{gasFormError}</div>
            )}

            {/* Success */}
            {gasFormSuccess && (
              <div style={{
                background:'rgba(0,245,100,0.1)',border:'1px solid rgba(0,245,100,0.35)',
                color:'#00f564',fontFamily:'Rajdhani,sans-serif',fontSize:'14px',
                padding:'10px 12px',textAlign:'center',fontWeight:700,
              }}>✓ تم إرسال طلبك بنجاح!</div>
            )}

            {/* Buttons */}
            <div style={{display:'flex',gap:'10px',paddingTop:'4px'}}>
              <button
                onClick={()=>{ setShowGasForm(false); setGasFormError(null); }}
                disabled={gasFormLoading}
                style={{
                  flex:1,padding:'11px 8px',
                  background:'none',border:'1px solid rgba(255,45,120,0.25)',
                  color:'rgba(255,45,120,0.6)',fontFamily:'Orbitron,sans-serif',fontSize:'9px',
                  letterSpacing:'0.1em',cursor:'pointer',transition:'all 0.2s',
                }}
                onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.background='rgba(255,45,120,0.08)';}}
                onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.background='none';}}
              >إلغاء</button>
              <button
                onClick={submitGasOrder}
                disabled={gasFormLoading || gasFormSuccess}
                style={{
                  flex:2,padding:'11px 8px',
                  background: gasFormLoading ? 'rgba(255,45,120,0.08)' : 'rgba(255,45,120,0.18)',
                  border:'1px solid rgba(255,45,120,0.7)',
                  color:'#ff2d78',fontFamily:'Orbitron,sans-serif',fontSize:'9px',
                  letterSpacing:'0.08em',cursor: gasFormLoading ? 'wait' : 'pointer',
                  fontWeight:700,transition:'all 0.2s',
                  display:'flex',alignItems:'center',justifyContent:'center',gap:'7px',
                }}
                onMouseEnter={e=>{ if(!gasFormLoading)(e.currentTarget as HTMLElement).style.background='rgba(255,45,120,0.3)'; }}
                onMouseLeave={e=>{ if(!gasFormLoading)(e.currentTarget as HTMLElement).style.background='rgba(255,45,120,0.18)'; }}
              >
                {gasFormLoading
                  ? <svg width="14" height="14" viewBox="0 0 28 28" fill="none" style={{animation:'lf-spin 0.8s linear infinite'}}><circle cx="14" cy="14" r="10" stroke="rgba(255,45,120,0.5)" strokeWidth="2.5" strokeDasharray="22 14" strokeLinecap="round"/></svg>
                  : <span style={{fontSize:'14px'}}>⛽</span>
                }
                {gasFormLoading ? 'جاري الإرسال...' : 'اطلب غاز الآن'}
              </button>
            </div>
          </div>
        </div>
      )}

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
                        ? `${taxiDistKm.toFixed(2)} كم × ${taxiDistKm <= 5 ? '750' : '500'} = د.ع`
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
                {activeOrderStatus==='pending' && loopActive
                  ? `نبحث عن أقرب تكسي لك ضمن منطقة 2 كم...`
                  : activeOrderStatus==='pending'   ? 'في انتظار قبول السائق...'
                  : activeOrderStatus==='accepted'  ? '🚕 السائق في الطريق إليك'
                  : activeOrderStatus==='driving'   ? '🚕 السائق في الطريق إليك'
                  : activeOrderStatus==='done'      ? '✅ وصل السائق — شكراً!'
                  : activeOrderStatus==='cancelled' ? '❌ تم إلغاء الطلب'
                  : null}
              </div>

              {/* ── Search loop countdown ── */}
              {loopActive && loopCountdown !== null && activeOrderStatus === 'pending' && (
                <div style={{marginTop:'5px',display:'flex',alignItems:'center',gap:'10px'}}>
                  {/* Countdown ring */}
                  <div style={{position:'relative',flexShrink:0,width:'36px',height:'36px'}}>
                    <svg width="36" height="36" viewBox="0 0 36 36" style={{transform:'rotate(-90deg)'}}>
                      <circle cx="18" cy="18" r="14" fill="none" stroke="rgba(245,197,24,0.15)" strokeWidth="3"/>
                      <circle cx="18" cy="18" r="14" fill="none" stroke="#f5c518" strokeWidth="3"
                        strokeDasharray={`${(loopCountdown/120)*88} 88`}
                        strokeLinecap="round"
                        style={{transition:'stroke-dasharray 1s linear'}}
                      />
                    </svg>
                    <div style={{
                      position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',
                      fontFamily:'Orbitron,sans-serif',fontSize:'9px',fontWeight:700,
                      color: loopCountdown <= 30 ? '#ff2d78' : '#f5c518',
                    }}>
                      {String(Math.floor(loopCountdown/60)).padStart(2,'0')}:{String(loopCountdown%60).padStart(2,'0')}
                    </div>
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    {/* Driver name + distance */}
                    {loopCurrentDriver && (
                      <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:'13px',fontWeight:700,color:'#00d4ff',lineHeight:1.2,marginBottom:'2px'}}>
                        🚕 {loopCurrentDriver}
                        {loopCurrentDriverDist !== null && (
                          <span style={{fontWeight:400,fontSize:'11px',color:'rgba(0,212,255,0.7)',marginRight:'6px'}}>
                            {' '}· {loopCurrentDriverDist.toFixed(2)} كم
                          </span>
                        )}
                      </div>
                    )}
                    <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:'11px',color:'rgba(245,197,24,0.7)',lineHeight:1.3}}>
                      سيتم الانتقال للسائق التالي إذا لم يستجب
                    </div>
                    <div style={{fontFamily:'Orbitron,sans-serif',fontSize:'7px',color:'rgba(255,255,255,0.3)',letterSpacing:'0.1em',marginTop:'2px'}}>
                      DRIVER SEARCH LOOP · ATTEMPT #{loopIgnoredRef.current.size} OF {loopIgnoredRef.current.size + 1}+
                    </div>
                  </div>
                </div>
              )}

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

            {/* Buttons column: chat + cancel */}
            <div style={{display:'flex',flexDirection:'column',gap:'6px',flexShrink:0}}>

              {/* Chat toggle button */}
              {activeOrderId && activeOrderStatus !== 'done' && activeOrderStatus !== 'cancelled' && (
                <button
                  onClick={()=>{ setShowChat(true); setHasUnreadChat(false); setUnreadChatCount(0); }}
                  style={{
                    background: showChat ? 'rgba(123,47,247,0.25)' : 'rgba(123,47,247,0.1)',
                    border:`1px solid ${hasUnreadChat ? '#ff2d50' : 'rgba(123,47,247,0.5)'}`,
                    color: hasUnreadChat ? '#ff8099' : '#c77dff',
                    fontFamily:'Orbitron,sans-serif',fontSize:'8px',
                    letterSpacing:'0.1em',padding:'6px 10px',cursor:'pointer',
                    flexShrink:0,transition:'all 0.2s',
                    boxShadow: hasUnreadChat
                      ? '0 0 18px rgba(255,45,80,0.5)'
                      : showChat ? '0 0 14px rgba(123,47,247,0.3)' : 'none',
                    position:'relative',
                  }}
                  onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.background='rgba(123,47,247,0.3)';}}
                  onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.background=showChat?'rgba(123,47,247,0.25)':'rgba(123,47,247,0.1)';}}
                >
                  💬 دردشة
                  {hasUnreadChat && (
                    <span style={{
                      position:'absolute', top:'-6px', right:'-6px',
                      minWidth:'16px', height:'16px', borderRadius:'8px',
                      padding:'0 3px',
                      background:'#ff2d50',
                      boxShadow:'0 0 8px #ff2d50, 0 0 16px rgba(255,45,80,0.6)',
                      animation:'chat-unread-pulse 1.4s ease-in-out infinite',
                      display:'flex', alignItems:'center', justifyContent:'center',
                      fontFamily:'Orbitron,sans-serif', fontSize:'7px',
                      color:'#fff', fontWeight:700,
                    }}>
                      {unreadChatCount > 0 ? (unreadChatCount > 9 ? '9+' : unreadChatCount) : '!'}
                    </span>
                  )}
                </button>
              )}

              {/* ── Cancel order button (only while searching / pending, before driver accepts) ── */}
              {activeOrderId && (activeOrderStatus === 'pending') && (
                <button
                  onClick={async ()=>{
                    const oid = activeOrderIdRef.current;
                    // 1. Stop search loop immediately
                    setLoopActive(false);
                    setLoopCountdown(null);
                    setLoopCurrentDriver('');
                    setLoopCurrentDriverDist(null);
                    loopIgnoredRef.current.clear();
                    // 2. Mark order as cancelled in Firestore / backend
                    if (oid) {
                      try { await fetch(`/api/orders/${oid}/customer-cancel`, { method:'PATCH' }); } catch { /* non-fatal */ }
                    }
                    // 3. Full state reset — closes the banner
                    taxiRouteLineRef.current?.remove();  taxiRouteLineRef.current  = null;
                    taxiQuickPolyRef.current?.remove();  taxiQuickPolyRef.current  = null;
                    taxiFromMarkerRef.current?.remove(); taxiFromMarkerRef.current = null;
                    taxiToMarkerRef.current?.remove();   taxiToMarkerRef.current   = null;
                    setActiveOrderId(null);    setActiveOrderStatus('pending');
                    setDriverLat(null);        setDriverLng(null);
                    setDriverDistKm(null);     setDriverEtaMin(null);
                    setShowChat(false);        prevDriverPosRef.current = null;
                    activeOrderIdRef.current     = null;
                    activeOrderStatusRef.current = 'pending';
                    loopFromPtRef.current = null; loopToPtRef.current = null;
                    localStorage.removeItem('diyala_active_order');
                    // 4. Show success snackbar
                    if (cancelSnackTimerRef.current) clearTimeout(cancelSnackTimerRef.current);
                    setTaxiCancelSnack(true);
                    cancelSnackTimerRef.current = setTimeout(()=> setTaxiCancelSnack(false), 4000);
                  }}
                  style={{
                    background:'rgba(255,45,120,0.12)',
                    border:'1px solid rgba(255,45,120,0.55)',
                    color:'#ff6b9d',
                    fontFamily:'Orbitron,sans-serif',fontSize:'7.5px',
                    letterSpacing:'0.1em',padding:'6px 10px',
                    cursor:'pointer',flexShrink:0,
                    transition:'all 0.2s',
                    display:'flex',alignItems:'center',justifyContent:'center',gap:'5px',
                    whiteSpace:'nowrap',
                  }}
                  onMouseEnter={e=>{
                    (e.currentTarget as HTMLElement).style.background='rgba(255,45,120,0.25)';
                    (e.currentTarget as HTMLElement).style.boxShadow='0 0 14px rgba(255,45,120,0.4)';
                  }}
                  onMouseLeave={e=>{
                    (e.currentTarget as HTMLElement).style.background='rgba(255,45,120,0.12)';
                    (e.currentTarget as HTMLElement).style.boxShadow='none';
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="9" stroke="#ff2d78" strokeWidth="2"/>
                    <path d="M15 9l-6 6M9 9l6 6" stroke="#ff2d78" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                  إلغاء الطلب
                </button>
              )}

            </div>

            {/* ✕ button intentionally removed — status bar closes only via delete/finish/cancel */}
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
          <button onClick={()=>{ setShowChat(true); setHasUnreadChat(false); setSysMsgSnack(null); if(sysMsgTimerRef.current) clearTimeout(sysMsgTimerRef.current); }}
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
              نعتذر، لا يوجد سائقون متاحون ضمن نطاق 2 كم حالياً، يرجى المحاولة بعد قليل
            </div>
          </div>
          <button onClick={()=> setTaxiNoDriverSnack(false)}
            style={{flexShrink:0,background:'none',border:'none',color:'rgba(255,45,120,0.5)',fontSize:'15px',cursor:'pointer',padding:'2px 4px',lineHeight:1}}>
            ✕
          </button>
        </div>
      )}

      {/* ── Cancel-order Snackbar ── */}
      {taxiCancelSnack && (
        <div style={{
          position:'absolute', bottom:'100px', left:'50%', transform:'translateX(-50%)',
          zIndex:5003, direction:'rtl',
          display:'flex', alignItems:'center', gap:'12px',
          padding:'11px 20px',
          background:'linear-gradient(135deg,rgba(255,45,120,0.16),rgba(5,8,15,0.97))',
          border:'1px solid rgba(255,45,120,0.65)',
          borderBottom:'3px solid #ff2d78',
          boxShadow:'0 -4px 32px rgba(255,45,120,0.25), 0 4px 40px rgba(0,0,0,0.6)',
          backdropFilter:'blur(16px)',
          maxWidth:'min(400px,92vw)',
          borderRadius:'4px 4px 2px 2px',
          animation:'sys-snack-in 0.35s cubic-bezier(0.34,1.56,0.64,1)',
        }}>
          <div style={{
            flexShrink:0, width:'34px', height:'34px',
            border:'1px solid rgba(255,45,120,0.5)', borderRadius:'50%',
            display:'flex', alignItems:'center', justifyContent:'center',
            background:'rgba(255,45,120,0.14)', boxShadow:'0 0 12px rgba(255,45,120,0.35)',
            fontSize:'17px', lineHeight:1,
          }}>🔴</div>
          <div style={{flex:1, minWidth:0}}>
            <div style={{fontFamily:'Orbitron,sans-serif',fontSize:'7.5px',color:'rgba(255,100,150,0.85)',letterSpacing:'0.18em',marginBottom:'3px'}}>
              ORDER CANCELLED
            </div>
            <div style={{fontFamily:'Rajdhani,sans-serif',fontSize:'14px',fontWeight:600,color:'#ffb3c6',lineHeight:1.35}}>
              تم إلغاء طلب التكسي بنجاح 🔴
            </div>
          </div>
          <button onClick={()=>{ setTaxiCancelSnack(false); if(cancelSnackTimerRef.current) clearTimeout(cancelSnackTimerRef.current); }}
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

      {/* ── Floating Chat Icon (shown when chat is minimized and trip is active) ── */}
      {activeOrderId && !showChat && ['pending','accepted','driving'].includes(activeOrderStatus) && (
        <button
          onClick={()=>{ setShowChat(true); setHasUnreadChat(false); setUnreadChatCount(0); }}
          title="فتح الدردشة"
          style={{
            position:'absolute', bottom:'90px', left:'16px', zIndex:4001,
            width:'54px', height:'54px', borderRadius:'50%',
            background:'rgba(5,8,15,0.97)',
            border: hasUnreadChat ? '2px solid #ff2d50' : '2px solid #7b2ff7',
            boxShadow: hasUnreadChat
              ? '0 0 22px rgba(255,45,80,0.7), 0 0 8px rgba(255,45,80,0.4)'
              : '0 0 22px rgba(123,47,247,0.55), 0 0 8px rgba(123,47,247,0.3)',
            cursor:'pointer', display:'flex', flexDirection:'column',
            alignItems:'center', justifyContent:'center', gap:'1px',
            animation: hasUnreadChat
              ? 'chat-unread-shake 0.5s ease-in-out infinite alternate'
              : 'lf-ping-subtle 2.5s cubic-bezier(0,0,0.2,1) infinite',
            padding:0,
          }}
        >
          <span style={{fontSize:'22px', lineHeight:1}}>💬</span>
          <span style={{
            fontFamily:'Orbitron,sans-serif', fontSize:'6px',
            color: hasUnreadChat ? '#ff8099' : '#c77dff', letterSpacing:'0.05em',
          }}>CHAT</span>
          {hasUnreadChat && (
            <span style={{
              position:'absolute', top:'-4px', right:'-4px',
              minWidth:'18px', height:'18px', borderRadius:'9px',
              padding:'0 3px',
              background:'#ff2d50',
              boxShadow:'0 0 10px #ff2d50, 0 0 20px rgba(255,45,80,0.7)',
              animation:'chat-unread-pulse 1.4s ease-in-out infinite',
              display:'flex', alignItems:'center', justifyContent:'center',
              fontFamily:'Orbitron,sans-serif', fontSize:'8px', color:'#fff', fontWeight:700,
            }}>
              {unreadChatCount > 0 ? (unreadChatCount > 9 ? '9+' : unreadChatCount) : '!'}
            </span>
          )}
        </button>
      )}

      {/* ── Gas Cancel Confirmation Dialog ── */}
      {showGasCancelConfirm && (
        <div style={{
          position:'fixed', inset:0, zIndex:9999,
          background:'rgba(0,0,0,0.72)',
          display:'flex', alignItems:'center', justifyContent:'center',
        }}
          onClick={()=> setShowGasCancelConfirm(false)}
        >
          <div
            onClick={e=> e.stopPropagation()}
            style={{
              background:'rgba(5,8,15,0.98)',
              border:'1.5px solid #ff2d78',
              boxShadow:'0 0 50px rgba(255,45,120,0.45), 0 0 120px rgba(255,45,120,0.15)',
              borderRadius:'4px',
              width:'min(340px, 90vw)',
              padding:'28px 24px 22px',
              direction:'rtl',
              display:'flex', flexDirection:'column', gap:'16px',
            }}
          >
            {/* Header */}
            <div style={{ display:'flex', alignItems:'center', gap:'10px' }}>
              <span style={{ fontSize:'22px' }}>⚠️</span>
              <div style={{
                fontFamily:'Orbitron,sans-serif', fontSize:'12px',
                color:'#ff2d78', letterSpacing:'0.2em', fontWeight:700,
              }}>تحذير</div>
            </div>

            {/* Body */}
            <div style={{
              fontFamily:'Rajdhani,sans-serif', fontSize:'15px',
              color:'#e8f8f5', lineHeight:1.6,
            }}>
              هل أنت متأكد؟ سيتم حذف الطلب نهائياً ولن يتمكن أي وكيل من قبوله.
            </div>

            {/* Order ID badge */}
            {activeGasOrderId && Number.isFinite(activeGasOrderId) && (
              <div style={{
                fontFamily:'Orbitron,sans-serif', fontSize:'10px',
                color:'rgba(255,45,120,0.7)', letterSpacing:'0.15em',
              }}>
                طلب الغاز #{activeGasOrderId}
              </div>
            )}

            {/* Buttons */}
            <div style={{ display:'flex', gap:'10px', justifyContent:'flex-end', marginTop:'4px' }}>
              <button
                onClick={()=> setShowGasCancelConfirm(false)}
                style={{
                  padding:'8px 18px', borderRadius:'3px', cursor:'pointer',
                  background:'rgba(255,255,255,0.06)', border:'1px solid rgba(255,255,255,0.18)',
                  color:'#b0c4d8', fontFamily:'Rajdhani,sans-serif', fontSize:'13px', fontWeight:600,
                }}
              >تراجع</button>
              <button
                onClick={deleteGasOrderConfirmed}
                style={{
                  padding:'8px 18px', borderRadius:'3px', cursor:'pointer',
                  background:'rgba(255,30,30,0.18)', border:'1.5px solid #ff2020',
                  color:'#ff4444', fontFamily:'Rajdhani,sans-serif', fontSize:'13px', fontWeight:700,
                  boxShadow:'0 0 14px rgba(255,30,30,0.35)',
                  letterSpacing:'0.04em',
                }}
              >حذف نهائي للطلب</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Gas Chat Overlay ── */}
      {showGasChat && Number.isFinite(activeGasOrderId) && (activeGasOrderId ?? 0) > 0 && activeGasOrderStatus === 'accepted' && (
        <GasChatOverlay
          gasOrderId={activeGasOrderId!}
          onMinimize={()=> setShowGasChat(false)}
          onNewMessage={()=>{ if (!showGasChat) setGasUnread(true); }}
        />
      )}

      {/* ── Gas Floating Chat Button (shown when minimized & order accepted) ── */}
      {Number.isFinite(activeGasOrderId) && (activeGasOrderId ?? 0) > 0 && !showGasChat && activeGasOrderStatus === 'accepted' && (
        <button
          onClick={()=>{ setShowGasChat(true); setGasUnread(false); }}
          title="فتح دردشة الغاز"
          style={{
            position:'absolute', bottom:'90px', right:'16px', zIndex:4101,
            width:'54px', height:'54px', borderRadius:'50%',
            background:'rgba(5,8,15,0.97)',
            border:'2px solid #ff2d78',
            boxShadow:'0 0 22px rgba(255,45,120,0.55), 0 0 8px rgba(255,45,120,0.3)',
            cursor:'pointer', display:'flex', flexDirection:'column',
            alignItems:'center', justifyContent:'center', gap:'1px',
            padding:0,
          }}
        >
          <span style={{fontSize:'22px', lineHeight:1}}>💬</span>
          <span style={{fontFamily:'Orbitron,sans-serif',fontSize:'6px',color:'#ff8099',letterSpacing:'0.05em'}}>GAS</span>
          {gasUnread && (
            <span style={{
              position:'absolute',top:'-2px',right:'-2px',
              width:'14px',height:'14px',borderRadius:'50%',
              background:'#ff2d78',boxShadow:'0 0 10px #ff2d78',
              display:'flex',alignItems:'center',justifyContent:'center',
              fontFamily:'Orbitron,sans-serif',fontSize:'8px',color:'#fff',
            }}>!</span>
          )}
        </button>
      )}

      {/* ── Chat Overlay ── */}
      {showChat && activeOrderId && activeOrderStatus !== 'done' && activeOrderStatus !== 'finished' && activeOrderStatus !== 'cancelled' && (
        <ChatOverlay
          orderId={activeOrderId}
          driverPhone={activeDriverPhone}
          onMinimize={()=> setShowChat(false)}
          onDeleteChat={()=>{
            setShowChat(false);
            // Show rating dialog before full reset
            if (activeOrderId) {
              const savedName = (()=>{ try{ return JSON.parse(localStorage.getItem('diyala_user')?? 'null')?.name ?? ''; }catch{ return ''; }})();
              setRatingOrderId(activeOrderId);
              setRatingDriverId(activeDriverId || 0);
              setRatingCustomerName(taxiUserName.trim() || savedName);
              setShowRating(true);
            } else {
              stopOrderTracking();
            }
          }}
          onSystemMsg={(content)=>{
            if (!showChat) {
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
            // Show thank-you snack then full cleanup
            setShowThankYouSnack(true);
            setTimeout(()=> setShowThankYouSnack(false), 4500);
            stopOrderTracking();
          }}
        />
      )}

      {/* ── Thank-you Snackbar (shown after rating submitted/skipped) ── */}
      {showThankYouSnack && (
        <div style={{
          position:'fixed', bottom:'30px', left:'50%', transform:'translateX(-50%)',
          zIndex:9500, direction:'rtl',
          display:'flex', alignItems:'center', gap:'14px',
          padding:'14px 22px',
          background:'linear-gradient(135deg,rgba(0,245,212,0.12),rgba(5,8,15,0.97))',
          border:'1px solid rgba(0,245,212,0.5)',
          borderTop:'3px solid #00f5d4',
          boxShadow:'0 -4px 40px rgba(0,245,212,0.25), 0 4px 40px rgba(0,0,0,0.6)',
          backdropFilter:'blur(20px)',
          maxWidth:'min(420px,92vw)',
          animation:'sys-snack-in 0.4s cubic-bezier(0.34,1.56,0.64,1)',
        }}>
          <div style={{fontSize:'28px', lineHeight:1, flexShrink:0}}>⭐</div>
          <div style={{flex:1, minWidth:0}}>
            <div style={{
              fontFamily:'Orbitron,sans-serif', fontSize:'8px',
              color:'rgba(0,245,212,0.7)', letterSpacing:'0.2em', marginBottom:'4px',
            }}>شكراً · THANK YOU</div>
            <div style={{
              fontFamily:'Rajdhani,sans-serif', fontSize:'15px',
              fontWeight:700, color:'#a8fff5', lineHeight:1.4,
            }}>شكراً لتقييمك — نتمنى لك يوماً سعيداً! 🌟</div>
          </div>
        </div>
      )}


      {/* ══════════════════════════════════════════════════════════════════════
          ── Category Bottom List — slides up when a filter is active ──────
          ══════════════════════════════════════════════════════════════════ */}
      {(() => {
        const showList =
          !!activeFilter &&
          activeFilter !== '__fuel_stations__' &&
          !routeTarget &&
          !selectedPlace;
        if (!showList) return null;

        const activeCat = categories.find(c => c.slug === activeFilter);
        const catColor  = activeCat?.color ?? '#00d4ff';
        const catIcon   = activeCat?.icon  ?? '📍';
        const catLabel  = activeCat?.labelAr ?? activeFilter;
        const listItems = items.filter(i => i.kind === activeFilter && i.status !== 'معطّل');

        if (listItems.length === 0) return null;

        return (
          <div style={{
            position:'absolute', bottom:'80px', left:0, right:0, zIndex:1005,
            background:`linear-gradient(to top, rgba(3,5,12,0.97) 60%, rgba(3,5,12,0.82))`,
            borderTop:`2px solid ${catColor}55`,
            boxShadow:`0 -4px 32px rgba(0,0,0,0.6), 0 -1px 0 ${catColor}22`,
            backdropFilter:'blur(14px)',
            direction:'rtl',
          }}>
            {/* List header */}
            <div style={{
              display:'flex', alignItems:'center', justifyContent:'space-between',
              padding:'8px 14px 4px',
              borderBottom:`1px solid ${catColor}18`,
            }}>
              <div style={{ display:'flex', alignItems:'center', gap:'7px' }}>
                <span style={{ fontSize:'14px' }}>{catIcon}</span>
                <span style={{
                  fontFamily:'Orbitron,sans-serif', fontSize:'8px', letterSpacing:'0.16em',
                  color:catColor,
                }}>{catLabel.toUpperCase()} · {listItems.length} موقع</span>
                <span style={{
                  width:'5px', height:'5px', borderRadius:'50%',
                  background:catColor, display:'inline-block',
                  boxShadow:`0 0 6px ${catColor}`,
                  animation:'lf-ping 1.8s ease-in-out infinite',
                }}/>
              </div>
              <button
                onClick={() => { onFilterChange(''); }}
                style={{
                  background:'rgba(255,45,80,0.1)', border:'1px solid rgba(255,45,80,0.4)',
                  color:'#ff2d50', fontFamily:'Orbitron,sans-serif', fontSize:'8px',
                  letterSpacing:'0.1em', padding:'3px 9px', borderRadius:'20px',
                  cursor:'pointer', display:'flex', alignItems:'center', gap:'4px',
                  transition:'background 0.18s',
                }}
                onMouseEnter={e=>(e.currentTarget.style.background='rgba(255,45,80,0.2)')}
                onMouseLeave={e=>(e.currentTarget.style.background='rgba(255,45,80,0.1)')}
              >
                <svg width="8" height="8" viewBox="0 0 12 12" fill="none">
                  <path d="M1 1l10 10M11 1L1 11" stroke="#ff2d50" strokeWidth="2" strokeLinecap="round"/>
                </svg>
                عرض الكل
              </button>
            </div>

            {/* Horizontal scrollable cards */}
            <div style={{
              display:'flex', flexDirection:'row', gap:'10px',
              overflowX:'auto', overflowY:'hidden',
              padding:'10px 14px 12px',
              scrollbarWidth:'none', msOverflowStyle:'none',
            } as React.CSSProperties}>
              {listItems.map(item => {
                const isOpen   = item.status === 'مفتوح';
                const subtitle = item.specialty || item.details || item.cuisine || item.type || activeCat?.labelAr || '';
                return (
                  <button
                    key={item.id}
                    onClick={() => {
                      if (!mapRef.current) return;
                      mapRef.current.flyTo([item.lat, item.lng], 16.5, { animate:true, duration:0.85 });
                      setTimeout(() => {
                        markersRef.current[item.id]?.openPopup();
                      }, 700);
                    }}
                    style={{
                      flexShrink:0,
                      width:'130px',
                      background:`rgba(5,8,15,0.92)`,
                      border:`1.5px solid ${catColor}33`,
                      borderRadius:'8px',
                      padding:'0',
                      cursor:'pointer',
                      overflow:'hidden',
                      transition:'border-color 0.2s, box-shadow 0.2s, transform 0.15s',
                      textAlign:'right',
                      boxShadow:`0 2px 12px rgba(0,0,0,0.5)`,
                    }}
                    onMouseEnter={e=>{
                      (e.currentTarget as HTMLElement).style.borderColor=catColor;
                      (e.currentTarget as HTMLElement).style.boxShadow=`0 0 18px ${catColor}44, 0 4px 20px rgba(0,0,0,0.6)`;
                      (e.currentTarget as HTMLElement).style.transform='translateY(-2px)';
                    }}
                    onMouseLeave={e=>{
                      (e.currentTarget as HTMLElement).style.borderColor=`${catColor}33`;
                      (e.currentTarget as HTMLElement).style.boxShadow='0 2px 12px rgba(0,0,0,0.5)';
                      (e.currentTarget as HTMLElement).style.transform='translateY(0)';
                    }}
                  >
                    {/* Icon strip */}
                    <div style={{
                      width:'100%', height:'52px',
                      background: item.icon_url
                        ? `url(${item.icon_url}) center/cover no-repeat`
                        : `${catColor}10`,
                      display:'flex', alignItems:'center', justifyContent:'center',
                      borderBottom:`1px solid ${catColor}18`,
                      position:'relative', overflow:'hidden',
                    }}>
                      {!item.icon_url && (
                        <span style={{ fontSize:'22px', opacity:0.85 }}>{catIcon}</span>
                      )}
                      {/* Status dot */}
                      <div style={{
                        position:'absolute', top:'6px', left:'6px',
                        width:'7px', height:'7px', borderRadius:'50%',
                        background: isOpen ? '#00dc64' : '#ff2d50',
                        boxShadow: isOpen ? '0 0 6px #00dc64' : '0 0 6px #ff2d50',
                      }}/>
                    </div>

                    {/* Text */}
                    <div style={{ padding:'7px 8px 8px' }}>
                      <div style={{
                        fontFamily:'Rajdhani,sans-serif', fontSize:'13px', fontWeight:700,
                        color:'rgba(255,255,255,0.9)', lineHeight:1.2,
                        overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                        marginBottom:'3px',
                      }}>{item.name}</div>
                      {subtitle ? (
                        <div style={{
                          fontFamily:'Rajdhani,sans-serif', fontSize:'10px',
                          color:`${catColor}99`,
                          overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                        }}>{subtitle}</div>
                      ) : null}
                      <div style={{
                        marginTop:'5px',
                        fontFamily:'Orbitron,sans-serif', fontSize:'7px',
                        color: isOpen ? '#00dc64' : '#ff2d50',
                        letterSpacing:'0.08em',
                      }}>{isOpen ? '● مفتوح' : '● مغلق'}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* ══════════════════════════════════════════════════════════════════════
          ── Selected Place Panel (slides up above bottom bar) ─────────────
          ══════════════════════════════════════════════════════════════════ */}
      {selectedPlace && (
        <div style={{
          position:'absolute', bottom:'80px', left:0, right:0, zIndex:1010,
          maxHeight:'58vh', overflowY:'auto',
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
              background:'rgba(255,45,120,0.1)',
              border:'1.5px solid rgba(255,45,120,0.55)',
              color:'#ff2d78',
              fontFamily:'Orbitron,sans-serif',
              fontSize:'16px',lineHeight:1,
              width:'34px',height:'34px',
              display:'flex',alignItems:'center',justifyContent:'center',
              cursor:'pointer',flexShrink:0,
              borderRadius:'3px',
              boxShadow:'0 0 10px rgba(255,45,120,0.2)',
              transition:'all 0.2s',
            }}
            onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.background='rgba(255,45,120,0.22)';(e.currentTarget as HTMLElement).style.boxShadow='0 0 16px rgba(255,45,120,0.5)';}}
            onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.background='rgba(255,45,120,0.1)';(e.currentTarget as HTMLElement).style.boxShadow='0 0 10px rgba(255,45,120,0.2)';}}
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
              onClick={()=>{ setShowTaxiQuickForm(true); }}
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

        {/* ── TAXI button — hidden when isTaxiActive===false ── */}
        {isTaxiActive && (() => {
          const ACTIVE_STATUSES = ['pending','accepted','driving'];
          const hasTripActive = !!(activeOrderId && ACTIVE_STATUSES.includes(activeOrderStatus));
          return (
        <button
          onClick={()=>{
            if (hasTripActive) { showBlockTaxiMsg(); return; }
            setShowTaxiQuickForm(true);
          }}
          style={{
            flex:1,
            display:'flex', flexDirection:'column',
            alignItems:'center', justifyContent:'center', gap:'4px',
            background: hasTripActive
              ? 'rgba(255,45,120,0.08)'
              : (activeFilter === (taxiCategory?.slug ?? '__none__') || showTaxiPrompt || showTaxiQuickForm)
                ? 'rgba(245,197,24,0.18)'
                : 'transparent',
            border:'none',
            borderTop: hasTripActive
              ? '3px solid rgba(255,45,120,0.4)'
              : (activeFilter === (taxiCategory?.slug ?? '__none__') || showTaxiPrompt || showTaxiQuickForm)
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

        {/* ── GAS button — hidden when isGasActive===false ── */}
        {isGasActive && <button
          onClick={()=>{
            if (!gasCategory) return;
            if (activeGasOrderId) return;
            setShowMoreModal(false);
            setShowTaxiPrompt(false);
            openGasForm();
          }}
          style={{
            flex:1,
            display:'flex', flexDirection:'column',
            alignItems:'center', justifyContent:'center', gap:'4px',
            background: activeGasOrderId
              ? 'rgba(255,45,120,0.10)'
              : 'transparent',
            border:'none',
            borderTop: activeGasOrderId
              ? '3px solid rgba(255,45,120,0.5)'
              : '3px solid transparent',
            color:'#ff2d78',
            cursor: (!gasCategory || !!activeGasOrderId) ? 'not-allowed' : 'pointer',
            opacity: gasCategory ? 1 : 0.35,
            transition:'all 0.2s',
            padding:0,
          }}
          onMouseEnter={e=>{ if(gasCategory && !activeGasOrderId)(e.currentTarget as HTMLElement).style.background='rgba(255,45,120,0.14)'; }}
          onMouseLeave={e=>{ (e.currentTarget as HTMLElement).style.background=activeGasOrderId?'rgba(255,45,120,0.10)':'transparent'; }}
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
        </button>}

      </div>

      {/* ── Fazaa Rescue System — hidden when destination sheet is open ── */}
      {!selectedPlace && (
        <FazaaSystem
          mapRef={mapRef}
          userLocation={userLocation}
          clearMapForRescue={clearMapForRescue}
          buttonBottom={(showTraffic ? 250 : 172) + LIST_LIFT}
        />
      )}

      {/* ── Fuel Station Radar ── */}
      <FuelStationRadar
        mapRef={mapRef}
        userLocation={userLocation}
        visible={showFuel}
      />

      {/* ── Active Order Tracker — Firestore real-time driver tracking ── */}
      <ActiveOrderTracker
        mapRef={mapRef}
        userLocation={userLocation}
      />

      {/* ── Crowdsourced Live Traffic Layer ── */}
      <TrafficLayer
        mapRef={mapRef}
        userLocation={userLocation}
        enabled={showTraffic}
      />

      {/* ── Bounty Mission System ── */}
      <BountyMissionSystem
        mapRef={mapRef}
        userLocation={userLocation}
        isDay={theme.isDay}
        filterActive={!!activeFilter}
        markersVisible={isBountyUnlocked}
      />

      {/* ── Bounty Shortcut FAB — hidden when destination sheet is open ── */}
      {!selectedPlace && (
        <BountyShortcutButton
          mapRef={mapRef}
          isDay={theme.isDay}
          onUnlock={() => setIsBountyUnlocked(true)}
          bottomOffset={LIST_LIFT}
        />
      )}

      {/* ── Live Market Ticker ── */}
      <MarketTicker />

      {/* ── Doctor Booking Modal — opened from popup "حجز موعد" button ── */}
      {bookingTargetItem && (
        <DoctorBookingModal
          doctorId={bookingTargetItem.id}
          doctorName={bookingTargetItem.name}
          doctorLat={bookingTargetItem.lat}
          doctorLng={bookingTargetItem.lng}
          onClose={() => setBookingTargetItem(null)}
        />
      )}

      {/* ── Doctor-Closed Alert Dialog ── */}
      {doctorClosedAlert && (
        <div
          onClick={() => setDoctorClosedAlert(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 9500,
            background: 'rgba(5,8,15,0.88)', backdropFilter: 'blur(8px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '20px',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#0d1117',
              border: '2px solid #ff2d78',
              borderRadius: '10px',
              padding: '32px 28px 24px',
              maxWidth: '360px', width: '100%',
              boxShadow: '0 0 60px rgba(255,45,120,0.25)',
              direction: 'rtl', textAlign: 'center',
            }}
          >
            {/* Icon */}
            <div style={{ fontSize: '48px', lineHeight: 1, marginBottom: '16px' }}>⚠️</div>

            {/* Title */}
            <div style={{
              fontFamily: 'Orbitron, sans-serif', fontSize: '11px',
              color: '#ff2d78', letterSpacing: '0.14em', marginBottom: '10px',
            }}>CLINIC UNAVAILABLE</div>

            {/* Message */}
            <div style={{
              fontFamily: 'Rajdhani, sans-serif', fontSize: '16px',
              fontWeight: 600, color: 'rgba(255,255,255,0.88)',
              lineHeight: 1.6, marginBottom: '24px',
            }}>
              الطبيب غير متوفر، العيادة مغلقة حالياً!
              <br/>
              <span style={{ fontSize: '13px', color: 'rgba(255,255,255,0.5)', fontWeight: 400 }}>
                يرجى المحاولة لاحقاً عندما يقوم الطبيب بفتح العيادة.
              </span>
            </div>

            {/* Close button */}
            <button
              onClick={() => setDoctorClosedAlert(false)}
              style={{
                width: '100%', padding: '12px',
                background: 'rgba(255,45,120,0.12)',
                border: '1.5px solid rgba(255,45,120,0.5)',
                color: '#ff2d78',
                fontFamily: 'Orbitron, sans-serif', fontSize: '10px',
                letterSpacing: '0.1em', cursor: 'pointer',
                borderRadius: '5px',
                boxShadow: '0 0 12px rgba(255,45,120,0.18)',
                transition: 'all 0.2s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,45,120,0.24)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,45,120,0.12)')}
            >
              حسناً، فهمت ✓
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
