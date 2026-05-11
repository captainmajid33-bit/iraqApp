import { useEffect, useRef } from 'react';
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
      <div style="
        width:${size}px;height:${size}px;
        position:relative;display:flex;
        align-items:center;justify-content:center;
        transition:all 0.3s;
      ">
        ${pulse ? `<div style="
          position:absolute;inset:0;border-radius:50%;
          background:${color};opacity:0.2;
          animation:leaflet-ping 2s cubic-bezier(0,0,0.2,1) infinite;
        "></div>` : ''}
        <div style="
          position:absolute;inset:0;border-radius:50%;
          border:2px solid ${color};
          box-shadow:0 0 ${selected ? 20 : 12}px ${color}, 0 0 ${selected ? 40 : 24}px ${color}88;
        "></div>
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

export function ClinicMap({ clinics, onSelectClinic, selectedClinic }: ClinicMapProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<{ [id: number]: L.Marker }>({});

  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;

    const style = document.createElement('style');
    style.textContent = `
      @keyframes leaflet-ping {
        75%, 100% { transform: scale(2.5); opacity: 0; }
      }
      .leaflet-container {
        background: #0a0d14 !important;
        font-family: 'Rajdhani', sans-serif;
      }
      .leaflet-tile-pane { filter: brightness(0.9); }
      .leaflet-control-zoom a {
        background: #0d1117 !important;
        color: #00f5d4 !important;
        border-color: #00f5d4 !important;
        font-family: 'Orbitron', sans-serif;
        box-shadow: 0 0 8px #00f5d422;
      }
      .leaflet-control-zoom a:hover {
        background: #00f5d422 !important;
        box-shadow: 0 0 16px #00f5d4 !important;
      }
      .leaflet-control-attribution {
        background: rgba(0,0,0,0.7) !important;
        color: #00f5d488 !important;
        font-size: 10px;
      }
      .leaflet-control-attribution a { color: #00f5d4 !important; }
    `;
    document.head.appendChild(style);

    mapRef.current = L.map(mapContainer.current, {
      center: [33.7451, 44.6488],
      zoom: 13,
      zoomControl: true,
    });

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
      const icon = createMarkerIcon(isOpen, isSelected);

      const marker = L.marker([clinic.lat, clinic.lng], { icon })
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
      const isOpen = clinic.status === 'مفتوح';
      const isSelected = selectedClinic?.id === clinic.id;
      marker.setIcon(createMarkerIcon(isOpen, isSelected));
    });
  }, [selectedClinic, clinics]);

  return (
    <div className="relative w-full h-full">
      <div ref={mapContainer} className="absolute inset-0" style={{ zIndex: 0 }} />

      <div className="absolute bottom-6 left-6 z-10 font-mono"
        style={{ background: 'rgba(0,0,0,0.85)', border: '1px solid rgba(0,245,212,0.4)', padding: '16px', backdropFilter: 'blur(8px)' }}>
        <h4 className="text-xs tracking-widest mb-3 pb-2" style={{ color: '#00f5d4', borderBottom: '1px solid rgba(0,245,212,0.2)' }}>LEGEND</h4>
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-3 h-3 rounded-full" style={{ background: '#00f5d4', boxShadow: '0 0 8px #00f5d4' }} />
            <span className="text-xs" style={{ color: '#00f5d4' }}>عيادة مفتوحة</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-3 h-3 rounded-full" style={{ background: '#ff2d78', boxShadow: '0 0 8px #ff2d78' }} />
            <span className="text-xs" style={{ color: '#ff2d78' }}>عيادة مغلقة</span>
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
