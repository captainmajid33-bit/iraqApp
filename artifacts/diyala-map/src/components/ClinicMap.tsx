import { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapItem, Category } from '@/data/types';

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

function makeIcon(kind: string, catMap: Map<string, Category>, isOpen: boolean, selected: boolean): L.DivIcon {
  const color   = isOpen ? OPEN_COLOR : CLOSED_COLOR;
  const emoji   = catMap.get(kind)?.icon ?? '📍';
  const size    = selected ? 44 : 36;
  const pulse   = isOpen && !selected;
  const svgBody = getSvgBody(kind, color);

  return L.divIcon({
    className: '',
    html: `<div style="width:${size}px;height:${size}px;position:relative;display:flex;align-items:center;justify-content:center;">
      ${pulse ? `<div style="position:absolute;inset:0;border-radius:50%;background:${color};opacity:0.18;animation:lf-ping 2s cubic-bezier(0,0,0.2,1) infinite;"></div>` : ''}
      <div style="position:absolute;inset:0;border-radius:50%;border:2px solid ${color};box-shadow:0 0 ${selected?20:12}px ${color},0 0 ${selected?40:24}px ${color}88;"></div>
      ${svgBody
        ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none">${svgBody}</svg>`
        : `<span style="font-size:${Math.round(size*0.4)}px;position:relative;z-index:1;line-height:1;user-select:none">${emoji}</span>`
      }
    </div>`,
    iconSize: [size, size], iconAnchor: [size/2, size/2],
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

  const clearRouteVisuals = useCallback(()=>{
    routeGlowRef.current?.remove(); routeGlowRef.current=null;
    routeLineRef.current?.remove(); routeLineRef.current=null;
    setRouteInfo(null);
  },[]);

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
      {enableHighAccuracy:true,timeout:12000,maximumAge:3000}
    );
  },[onUserLocationChange, refreshUserMarker]);

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
      .popup-nav-btn{width:100%;padding:9px 0;margin-top:10px;background:rgba(245,197,24,0.1);border:1px solid #f5c518;color:#f5c518;font-family:'Orbitron',monospace;font-size:11px;letter-spacing:0.08em;cursor:pointer;transition:all 0.2s;display:flex;align-items:center;justify-content:center;gap:7px;}
      .popup-nav-btn:hover{background:rgba(245,197,24,0.22);box-shadow:0 0 18px rgba(245,197,24,0.45);}
      .popup-details-btn{width:100%;padding:7px 0;border:none;background:transparent;color:#aaa;font-family:'Rajdhani',sans-serif;font-size:12px;letter-spacing:0.06em;cursor:pointer;transition:all 0.2s;border-top:1px solid rgba(255,255,255,0.06);margin-top:4px;}
      .popup-details-btn:hover{color:#fff;}
      .popup-delete-btn{width:100%;padding:8px 0;border:1px solid rgba(255,45,120,0.4);background:transparent;color:#ff2d78;font-family:'Rajdhani',sans-serif;font-size:12px;letter-spacing:0.06em;cursor:pointer;transition:all 0.25s;display:flex;align-items:center;justify-content:center;gap:7px;border-radius:2px;}
      .popup-delete-btn:hover{background:rgba(255,45,120,0.12);border-color:#ff2d78;}
      .filter-tabs-bar::-webkit-scrollbar{display:none;}
    `;
    document.head.appendChild(style);
    mapRef.current=L.map(mapContainer.current,{center:[33.7451,44.6488],zoom:13,zoomControl:true});
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',{
      attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains:'abcd',maxZoom:20,
    }).addTo(mapRef.current);
    mapRef.current.on('click',(e:L.LeafletMouseEvent)=>{
      if (adminModeRef.current) onMapClickRef.current?.({lat:e.latlng.lat,lng:e.latlng.lng});
    });
    return ()=>{
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
        const marker    = L.marker([item.lat,item.lng],{icon:makeIcon(item.kind,catMapRef.current,isOpen,isSelected)}).addTo(mapRef.current!);
        marker.bindPopup(L.popup({className:popupClass,offset:[0,-8],closeButton:true,autoClose:true,autoPan:true}).setContent(buildPopup(item)));
        marker.on('click',()=>{marker.openPopup();mapRef.current?.flyTo([item.lat,item.lng],15,{duration:0.8});});
        markersRef.current[item.id]=marker;
      });
  },[items,activeFilter,selectedItem,buildPopup]);

  // Update selected icon without full re-render
  useEffect(()=>{
    items.filter(i=>i.kind===activeFilter && i.status!=='معطّل').forEach(item=>{
      markersRef.current[item.id]?.setIcon(makeIcon(item.kind,catMapRef.current,item.status==='مفتوح',selectedItem?.id===item.id));
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

      {/* ── Filter Tabs — scrollable, unlimited categories ── */}
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
          ? /* Skeleton while loading */
            [1,2,3,4].map(n=>(
              <div key={n} style={{width:'100px',height:'72px',background:'rgba(5,8,15,0.92)',borderBottom:'2px solid transparent',flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center'}}>
                <div style={{width:'60px',height:'10px',background:'rgba(255,255,255,0.06)',borderRadius:'2px'}}/>
              </div>
            ))
          : categories.map(cat=>{
              const active = activeFilter===cat.slug;
              const c = active ? cat.color : 'rgba(255,255,255,0.35)';
              const count = items.filter(i=>i.kind===cat.slug && i.status!=='معطّل').length;
              return (
                <button key={cat.slug} onClick={()=>onFilterChange(cat.slug)}
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
            })
        }
      </div>

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
      <div style={{position:'absolute',bottom:'24px',left:'20px',zIndex:1001,display:'flex',flexDirection:'column',alignItems:'center',gap:'8px'}}>
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

      {/* ── Route Loading ── */}
      {routeLoading && (
        <div style={{position:'absolute',top:'50%',left:'50%',transform:'translate(-50%,-50%)',zIndex:1000,background:'rgba(0,0,0,0.92)',border:'1px solid #f5c518',color:'#f5c518',fontSize:'12px',padding:'14px 24px',fontFamily:'Orbitron,sans-serif',letterSpacing:'0.1em',boxShadow:'0 0 28px #f5c51866',textAlign:'center'}}>
          <div style={{marginBottom:'5px'}}>CALCULATING ROUTE...</div>
          <div style={{fontSize:'10px',opacity:0.6}}>جاري حساب المسار</div>
        </div>
      )}

      {/* ── Route Info Banner ── */}
      {routeInfo && !routeLoading && (
        <div style={{position:'absolute',bottom:'20px',left:'50%',transform:'translateX(-50%)',zIndex:1000,background:'rgba(5,8,15,0.96)',border:'1px solid #f5c518',color:'#f5c518',padding:'10px 24px',fontFamily:'Orbitron,sans-serif',fontSize:'11px',letterSpacing:'0.1em',boxShadow:'0 0 24px #f5c51844',display:'flex',gap:'24px',alignItems:'center',backdropFilter:'blur(10px)'}}>
          <span>🛣️ {routeInfo.distanceKm.toFixed(1)} كم</span>
          <span>⏱ {Math.round(routeInfo.durationMin)} دقيقة</span>
        </div>
      )}

      {/* ── Legend ── */}
      {categories.length > 0 && (
        <div style={{position:'absolute',bottom:'20px',left:'92px',zIndex:1000,background:'rgba(5,8,15,0.88)',border:'1px solid rgba(255,255,255,0.07)',padding:'10px 14px',backdropFilter:'blur(10px)',minWidth:'150px'}}>
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
    </div>
  );
}
