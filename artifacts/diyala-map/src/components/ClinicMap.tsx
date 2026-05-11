import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Clinic } from '@/data/clinics';

interface ClinicMapProps {
  clinics: Clinic[];
  onSelectClinic: (clinic: Clinic) => void;
  selectedClinic: Clinic | null;
}

function createMarkerIcon(isOpen: boolean, selected: boolean): L.DivIcon {
  const color = isOpen ? '#00f5d4' : '#ff2d78';
  const size = selected ? 44 : 36;
  const pulse = isOpen && !selected;

  return L.divIcon({
    className: '',
    html: `
      <div style="width:${size}px;height:${size}px;position:relative;display:flex;align-items:center;justify-content:center;transition:all 0.3s;">
        ${pulse ? `<div style="position:absolute;inset:0;border-radius:50%;background:${color};opacity:0.2;animation:leaflet-ping 2s cubic-bezier(0,0,0.2,1) infinite;"></div>` : ''}
        <div style="position:absolute;inset:0;border-radius:50%;border:2px solid ${color};box-shadow:0 0 ${selected ? 20 : 12}px ${color}, 0 0 ${selected ? 40 : 24}px ${color}88;"></div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" fill="${color}" opacity="0.3"/>
          <path d="M13 7h-2v4H7v2h4v4h2v-4h4v-2h-4V7z" fill="${color}"/>
        </svg>
      </div>
    `,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function createUserIcon(): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `
      <div style="width:20px;height:20px;position:relative;display:flex;align-items:center;justify-content:center;">
        <div style="position:absolute;inset:-10px;border-radius:50%;background:#f5c518;opacity:0.15;animation:leaflet-ping 2s cubic-bezier(0,0,0.2,1) infinite;"></div>
        <div style="position:absolute;inset:-4px;border-radius:50%;border:2px solid #f5c518;opacity:0.5;"></div>
        <div style="width:14px;height:14px;border-radius:50%;background:#f5c518;box-shadow:0 0 12px #f5c518,0 0 24px #f5c51888;border:2px solid #fff;"></div>
      </div>
    `,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

export function ClinicMap({ clinics, onSelectClinic, selectedClinic }: ClinicMapProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<{ [id: number]: L.Marker }>({});
  const userMarkerRef = useRef<L.Marker | null>(null);
  const userCircleRef = useRef<L.Circle | null>(null);
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;

    const style = document.createElement('style');
    style.textContent = `
      @keyframes leaflet-ping {
        75%, 100% { transform: scale(2.5); opacity: 0; }
      }
      .leaflet-container { background: #0a0d14 !important; font-family: 'Rajdhani', sans-serif; }
      .leaflet-tile-pane { filter: brightness(0.9); }
      .leaflet-control-zoom a {
        background: #0d1117 !important; color: #00f5d4 !important;
        border-color: #00f5d4 !important; font-family: 'Orbitron', sans-serif;
        box-shadow: 0 0 8px #00f5d422;
      }
      .leaflet-control-zoom a:hover { background: #00f5d422 !important; box-shadow: 0 0 16px #00f5d4 !important; }
      .leaflet-control-attribution { background: rgba(0,0,0,0.7) !important; color: #00f5d488 !important; font-size: 10px; }
      .leaflet-control-attribution a { color: #00f5d4 !important; }
    `;
    document.head.appendChild(style);

    mapRef.current = L.map(mapContainer.current, { center: [33.7451, 44.6488], zoom: 13, zoomControl: true });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 20,
    }).addTo(mapRef.current);

    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
      style.remove();
    };
  }, []);

  useEffect(() => {
    if (!mapRef.current) return;
    Object.values(markersRef.current).forEach(m => m.remove());
    markersRef.current = {};
    clinics.forEach(clinic => {
      const isOpen = clinic.status === 'مفتوح';
      const isSelected = selectedClinic?.id === clinic.id;
      const marker = L.marker([clinic.lat, clinic.lng], { icon: createMarkerIcon(isOpen, isSelected) })
        .addTo(mapRef.current!)
        .on('click', () => {
          onSelectClinic(clinic);
          mapRef.current?.flyTo([clinic.lat, clinic.lng], 15, { duration: 1 });
        });
      markersRef.current[clinic.id] = marker;
    });
  }, [clinics, onSelectClinic, selectedClinic]);

  useEffect(() => {
    clinics.forEach(clinic => {
      const marker = markersRef.current[clinic.id];
      if (!marker) return;
      marker.setIcon(createMarkerIcon(clinic.status === 'مفتوح', selectedClinic?.id === clinic.id));
    });
  }, [selectedClinic, clinics]);

  const handleLocate = () => {
    if (!navigator.geolocation) {
      setLocateError('الجهاز لا يدعم تحديد الموقع');
      return;
    }
    setLocating(true);
    setLocateError(null);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng, accuracy } = pos.coords;
        setLocating(false);
        setCoords({ lat, lng });

        if (userMarkerRef.current) userMarkerRef.current.remove();
        if (userCircleRef.current) userCircleRef.current.remove();

        userMarkerRef.current = L.marker([lat, lng], { icon: createUserIcon(), zIndexOffset: 1000 })
          .addTo(mapRef.current!);

        userCircleRef.current = L.circle([lat, lng], {
          radius: accuracy,
          color: '#f5c518',
          fillColor: '#f5c518',
          fillOpacity: 0.08,
          weight: 1,
          dashArray: '4 4',
        }).addTo(mapRef.current!);

        mapRef.current?.flyTo([lat, lng], 16, { duration: 1.5 });
      },
      (err) => {
        setLocating(false);
        if (err.code === 1) setLocateError('تم رفض صلاحية الموقع');
        else if (err.code === 2) setLocateError('تعذّر تحديد الموقع');
        else setLocateError('انتهت مهلة تحديد الموقع');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  };

  return (
    <div className="relative w-full h-full">
      <div ref={mapContainer} className="absolute inset-0" style={{ zIndex: 0 }} />

      {/* Locate Me Button */}
      <button
        onClick={handleLocate}
        disabled={locating}
        title="تحديد موقعي"
        style={{
          position: 'absolute',
          bottom: '96px',
          left: '6px',
          zIndex: 1000,
          width: '34px',
          height: '34px',
          background: locating ? '#0d1117' : coords ? '#f5c51822' : '#0d1117',
          border: `2px solid ${coords ? '#f5c518' : '#f5c518'}`,
          boxShadow: locating
            ? '0 0 16px #f5c518, 0 0 32px #f5c51888'
            : coords
            ? '0 0 12px #f5c518'
            : '0 0 8px #f5c51844',
          borderRadius: '4px',
          cursor: locating ? 'wait' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'all 0.3s',
          padding: 0,
        }}
      >
        {locating ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ animation: 'spin 1s linear infinite' }}>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            <circle cx="12" cy="12" r="9" stroke="#f5c518" strokeWidth="2" strokeDasharray="28 8" strokeLinecap="round"/>
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="3" fill={coords ? '#f5c518' : '#f5c518'} />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke="#f5c518" strokeWidth="2" strokeLinecap="round"/>
            <circle cx="12" cy="12" r="7" stroke="#f5c518" strokeWidth="1.5" opacity="0.6"/>
          </svg>
        )}
      </button>

      {/* Locate Error Toast */}
      {locateError && (
        <div style={{
          position: 'absolute', bottom: '140px', left: '6px', zIndex: 1000,
          background: 'rgba(0,0,0,0.9)', border: '1px solid #ff2d78',
          color: '#ff2d78', fontSize: '11px', padding: '8px 12px',
          fontFamily: 'Rajdhani, sans-serif', letterSpacing: '0.05em',
          boxShadow: '0 0 12px #ff2d7844', maxWidth: '180px',
        }}>
          {locateError}
          <button onClick={() => setLocateError(null)} style={{ display: 'block', marginTop: '4px', color: '#ff2d7888', fontSize: '10px', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
            اغلق
          </button>
        </div>
      )}

      {/* Coords display when located */}
      {coords && !locating && (
        <div style={{
          position: 'absolute', bottom: '140px', left: '6px', zIndex: 1000,
          background: 'rgba(0,0,0,0.85)', border: '1px solid #f5c51866',
          color: '#f5c518', fontSize: '10px', padding: '6px 10px',
          fontFamily: 'Orbitron, monospace', letterSpacing: '0.08em',
          boxShadow: '0 0 8px #f5c51822',
        }}>
          <div style={{ opacity: 0.6, fontSize: '9px', marginBottom: '2px' }}>موقعك الحالي</div>
          {coords.lat.toFixed(4)}°N · {coords.lng.toFixed(4)}°E
        </div>
      )}

      {/* Legend */}
      <div className="absolute bottom-6 left-6 z-10 font-mono"
        style={{ background: 'rgba(0,0,0,0.85)', border: '1px solid rgba(0,245,212,0.4)', padding: '16px', backdropFilter: 'blur(8px)', marginLeft: '40px' }}>
        <h4 className="text-xs tracking-widest mb-3 pb-2" style={{ color: '#00f5d4', borderBottom: '1px solid rgba(0,245,212,0.2)' }}>LEGEND</h4>
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <div className="w-3 h-3 rounded-full" style={{ background: '#00f5d4', boxShadow: '0 0 8px #00f5d4' }} />
            <span className="text-xs" style={{ color: '#00f5d4' }}>عيادة مفتوحة</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-3 h-3 rounded-full" style={{ background: '#ff2d78', boxShadow: '0 0 8px #ff2d78' }} />
            <span className="text-xs" style={{ color: '#ff2d78' }}>عيادة مغلقة</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-3 h-3 rounded-full" style={{ background: '#f5c518', boxShadow: '0 0 8px #f5c518' }} />
            <span className="text-xs" style={{ color: '#f5c518' }}>موقعك</span>
          </div>
        </div>
      </div>

      <div className="absolute top-4 right-4 z-10 font-mono text-xs pointer-events-none"
        style={{ color: 'rgba(0,245,212,0.5)', fontFamily: 'Orbitron, sans-serif', letterSpacing: '0.1em' }}>
        33.7451°N · 44.6488°E
      </div>
    </div>
  );
}
