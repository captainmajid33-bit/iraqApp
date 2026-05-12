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
function makeIcon(kind: string, catMap: Map<string, Category>, isOpen: boolean, selected: boolean): L.DivIcon {
  const baseColor = getCatColor(kind, catMap);
  const color     = isOpen ? baseColor : '#ff2d78';
  const emoji     = catMap.get(kind)?.icon ?? '📍';
  const size      = selected ? 44 : 36;
  const pulse     = isOpen && !selected;
  const svgBody   = getSvgBody(kind, color);

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

function createUserIcon(): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `<div style="width:20px;height:20px;position:relative;display:flex;align-items:center;justify-content:center;">
      <div style="position:absolute;inset:-10px;border-radius:50%;background:#f5c518;opacity:0.15;animation:lf-ping 2s cubic-bezier(0,0,0.2,1) infinite;"></div>
      <div style="position:absolute;inset:-4px;border-radius:50%;border:2px solid #f5c518;opacity:0.5;"></div>
      <div style="width:14px;height:14px;border-radius:50%;background:#f5c518;box-shadow:0 0 12px #f5c518,0 0 24px #f5c51888;border:2px solid #fff;"></div>
    </div>`,
    iconSize: [20,20], iconAnchor: [10,10],
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

  const locateUser = useCallback((afterLocate?:(loc:{lat:number;lng:number})=>void)=>{
    if (!navigator.geolocation){setLocateError('الجهاز لا يدعم تحديد الموقع');return;}
    setLocating(true); setLocateError(null);
    navigator.geolocation.getCurrentPosition(
      ({coords:{latitude:lat,longitude:lng,accuracy}})=>{
        setLocating(false);
        const loc={lat,lng};
        onUserLocationChange(loc); userLocationRef.current=loc;
        userMarkerRef.current?.remove(); userCircleRef.current?.remove();
        userMarkerRef.current=L.marker([lat,lng],{icon:createUserIcon(),zIndexOffset:1000}).addTo(mapRef.current!);
        userCircleRef.current=L.circle([lat,lng],{radius:accuracy,color:'#f5c518',fillColor:'#f5c518',fillOpacity:0.08,weight:1,dashArray:'4 4'}).addTo(mapRef.current!);
        if (!afterLocate) mapRef.current?.flyTo([lat,lng],16,{duration:1.5});
        afterLocate?.(loc);
      },
      (err)=>{
        setLocating(false);
        if (err.code===1)      setLocateError('تم رفض صلاحية الموقع');
        else if (err.code===2) setLocateError('تعذّر تحديد الموقع');
        else                   setLocateError('انتهت مهلة تحديد الموقع');
      },
      {enableHighAccuracy:true,timeout:10000,maximumAge:0}
    );
  },[onUserLocationChange]);

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

    const sub = (item as any).details
      ?? (item.kind==='clinic' ? [(item as any).doctor,(item as any).specialty].filter(Boolean).join(' — ') : '')
      ?? (item.kind==='restaurant' ? [(item as any).cuisine,(item as any).type].filter(Boolean).join(' · ') : '')
      ?? '';

    const stars = typeof (item as any).rating === 'number' && (item as any).rating > 0
      ? `<div style="color:#f5c518;font-size:12px;margin-bottom:2px;">${'★'.repeat((item as any).rating)}${'☆'.repeat(5-(item as any).rating)}</div>` : '';

    const el=document.createElement('div');
    el.style.cssText='padding:14px 16px 12px;direction:rtl;min-width:215px;';
    el.innerHTML=`
      <div style="font-family:Orbitron,sans-serif;font-size:9px;color:${color}88;letter-spacing:0.12em;margin-bottom:4px;">${emoji} ${labelEn} · ID:${item.id.toString().padStart(4,'0')}</div>
      <div style="font-family:Rajdhani,sans-serif;font-size:16px;font-weight:700;color:#e8f8f5;line-height:1.2;margin-bottom:5px;">${item.name}</div>
      ${stars}
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">
        <div style="width:7px;height:7px;border-radius:50%;background:${color};box-shadow:0 0 6px ${color};flex-shrink:0;"></div>
        <span style="font-family:Rajdhani,sans-serif;font-size:12px;color:${color};">${item.status}</span>
      </div>
      <div style="font-family:Rajdhani,sans-serif;font-size:11px;color:#ffffff55;">${sub}</div>
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

      {/* ── Locate Me ── */}
      <button onClick={()=>locateUser()} disabled={locating} title="تحديد موقعي"
        style={{position:'absolute',bottom:'96px',left:'6px',zIndex:1000,width:'34px',height:'34px',background:userLocation?'#f5c51822':'#0d1117',border:'2px solid #f5c518',boxShadow:locating?'0 0 18px #f5c518':'0 0 6px #f5c51844',borderRadius:'4px',cursor:locating?'wait':'pointer',display:'flex',alignItems:'center',justifyContent:'center',padding:0,transition:'all 0.3s'}}>
        {locating
          ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{animation:'lf-spin 1s linear infinite'}}><circle cx="12" cy="12" r="9" stroke="#f5c518" strokeWidth="2" strokeDasharray="28 8" strokeLinecap="round"/></svg>
          : <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" fill="#f5c518"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="#f5c518" strokeWidth="2" strokeLinecap="round"/><circle cx="12" cy="12" r="7" stroke="#f5c518" strokeWidth="1.5" opacity="0.6"/></svg>
        }
      </button>

      {/* ── Locate Error ── */}
      {locateError && (
        <div style={{position:'absolute',bottom:'140px',left:'6px',zIndex:1000,background:'rgba(0,0,0,0.92)',border:'1px solid #ff2d78',color:'#ff2d78',fontSize:'11px',padding:'8px 12px',fontFamily:'Rajdhani,sans-serif',maxWidth:'180px'}}>
          {locateError}
          <button onClick={()=>setLocateError(null)} style={{display:'block',marginTop:'4px',color:'#ff2d7888',fontSize:'10px',background:'none',border:'none',cursor:'pointer',padding:0}}>اغلق ×</button>
        </div>
      )}

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
        <div style={{position:'absolute',bottom:'20px',left:'6px',zIndex:1000,background:'rgba(5,8,15,0.88)',border:'1px solid rgba(255,255,255,0.07)',padding:'10px 14px',backdropFilter:'blur(10px)',minWidth:'150px'}}>
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
