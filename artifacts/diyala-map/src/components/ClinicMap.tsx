import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { Clinic } from '@/data/clinics';

mapboxgl.accessToken = 'pk.eyJ1IjoiYWxtYXZhbGlkIiwiYSI6ImNtYWtremg1NzBjY3IybHB3ZGVlbDhxMDYifQ.lO0K2lFRHAZj0hOYt8OyoQ';

interface ClinicMapProps {
  clinics: Clinic[];
  onSelectClinic: (clinic: Clinic) => void;
  selectedClinic: Clinic | null;
}

export function ClinicMap({ clinics, onSelectClinic, selectedClinic }: ClinicMapProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<{ [id: number]: mapboxgl.Marker }>({});
  const [webglError, setWebglError] = useState(false);
  const [mapLoaded, setMapLoaded] = useState(false);

  useEffect(() => {
    if (!mapboxgl.supported()) {
      setWebglError(true);
      return;
    }

    if (!mapboxgl.getRTLTextPluginStatus() || mapboxgl.getRTLTextPluginStatus() === 'unavailable') {
      try {
        mapboxgl.setRTLTextPlugin(
          'https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-rtl-text/v0.2.3/mapbox-gl-rtl-text.js',
          () => {},
          true
        );
      } catch (_) {}
    }

    if (map.current || !mapContainer.current) return;

    try {
      map.current = new mapboxgl.Map({
        container: mapContainer.current,
        style: 'mapbox://styles/mapbox/dark-v11',
        center: [44.6488, 33.7451],
        zoom: 10,
        pitch: 45,
        bearing: -17.6,
      });

      map.current.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'bottom-left');

      map.current.on('load', () => {
        setMapLoaded(true);
        if (!map.current) return;
        try {
          map.current.addLayer({
            id: '3d-buildings',
            source: 'composite',
            'source-layer': 'building',
            filter: ['==', 'extrude', 'true'],
            type: 'fill-extrusion',
            minzoom: 15,
            paint: {
              'fill-extrusion-color': '#0d1b2a',
              'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 15, 0, 15.05, ['get', 'height']],
              'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 15, 0, 15.05, ['get', 'min_height']],
              'fill-extrusion-opacity': 0.6,
            },
          });
        } catch (_) {}
      });

      map.current.on('error', () => {
        setWebglError(true);
      });
    } catch (_) {
      setWebglError(true);
    }

    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    if (!map.current || !mapLoaded) return;

    Object.values(markersRef.current).forEach(marker => marker.remove());
    markersRef.current = {};

    clinics.forEach(clinic => {
      const el = document.createElement('div');
      el.style.cssText = 'width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;position:relative;transition:transform 0.3s;';

      const isOpen = clinic.status === 'مفتوح';
      const color = isOpen ? '#00f5d4' : '#ff2d78';
      const glow = isOpen ? '0 0 12px #00f5d4, 0 0 24px #00f5d4aa' : '0 0 12px #ff2d78, 0 0 24px #ff2d78aa';

      el.innerHTML = `
        <div style="position:absolute;inset:0;border-radius:50%;border:2px solid ${color};box-shadow:${glow};"></div>
        <div style="width:8px;height:8px;border-radius:50%;background:${color};box-shadow:${glow};"></div>
        ${isOpen ? `<div style="position:absolute;inset:0;border-radius:50%;background:${color};opacity:0.15;animation:ping 2s cubic-bezier(0,0,0.2,1) infinite;"></div>` : ''}
      `;

      el.addEventListener('mouseenter', () => { el.style.transform = 'scale(1.2)'; });
      el.addEventListener('mouseleave', () => { el.style.transform = selectedClinic?.id === clinic.id ? 'scale(1.3)' : 'scale(1)'; });
      el.addEventListener('click', () => {
        onSelectClinic(clinic);
        map.current?.flyTo({ center: [clinic.lng, clinic.lat], zoom: 14, essential: true, duration: 1500 });
      });

      const marker = new mapboxgl.Marker(el)
        .setLngLat([clinic.lng, clinic.lat])
        .addTo(map.current!);

      markersRef.current[clinic.id] = marker;
    });
  }, [clinics, onSelectClinic, mapLoaded]);

  useEffect(() => {
    Object.entries(markersRef.current).forEach(([id, marker]) => {
      const el = marker.getElement();
      if (selectedClinic && parseInt(id) === selectedClinic.id) {
        el.style.transform = 'scale(1.3)';
        el.style.zIndex = '10';
      } else {
        el.style.transform = 'scale(1)';
        el.style.zIndex = '1';
      }
    });
  }, [selectedClinic]);

  if (webglError) {
    return (
      <div className="relative w-full h-full flex flex-col items-center justify-center bg-background overflow-auto p-6">
        <div className="max-w-2xl w-full">
          <div className="text-center mb-8">
            <div className="text-primary font-mono text-xs tracking-widest mb-2">// RENDER MODE: FALLBACK</div>
            <h2 className="text-2xl font-bold text-foreground mb-2" style={{ fontFamily: 'Orbitron, sans-serif' }}>
              قائمة العيادات
            </h2>
            <p className="text-muted-foreground text-sm font-mono">محافظة ديالى — نظام الرعاية الصحية</p>
          </div>
          <div className="grid gap-3">
            {clinics.map(clinic => (
              <button
                key={clinic.id}
                onClick={() => onSelectClinic(clinic)}
                className={`w-full text-right p-4 border transition-all duration-200 ${
                  selectedClinic?.id === clinic.id
                    ? 'border-primary bg-primary/10'
                    : 'border-border bg-card hover:border-primary/50 hover:bg-primary/5'
                }`}
                style={{ boxShadow: selectedClinic?.id === clinic.id ? '0 0 16px rgba(0,245,212,0.3)' : undefined }}
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <div
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{
                        background: clinic.status === 'مفتوح' ? '#00f5d4' : '#ff2d78',
                        boxShadow: clinic.status === 'مفتوح' ? '0 0 8px #00f5d4' : '0 0 8px #ff2d78',
                      }}
                    />
                    <span className="text-xs font-mono" style={{ color: clinic.status === 'مفتوح' ? '#00f5d4' : '#ff2d78' }}>
                      {clinic.status === 'مفتوح' ? 'ONLINE' : 'OFFLINE'}
                    </span>
                  </div>
                  <div className="text-right">
                    <div className="font-bold text-foreground">{clinic.name}</div>
                    <div className="text-xs text-muted-foreground mt-1">{clinic.specialty} — {clinic.doctor}</div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full">
      <div ref={mapContainer} className="absolute inset-0" />

      <style>{`
        @keyframes ping {
          75%, 100% { transform: scale(2); opacity: 0; }
        }
      `}</style>

      <div className="absolute bottom-6 left-6 bg-black/80 backdrop-blur-sm border border-primary/50 p-4 font-mono z-10">
        <h4 className="text-primary text-xs tracking-widest mb-3 border-b border-primary/30 pb-2">LEGEND</h4>
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-3 h-3 rounded-full" style={{ background: '#00f5d4', boxShadow: '0 0 8px #00f5d4' }} />
            <span className="text-xs" style={{ color: '#00f5d4' }}>CLINIC ONLINE</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-3 h-3 rounded-full" style={{ background: '#ff2d78', boxShadow: '0 0 8px #ff2d78' }} />
            <span className="text-xs" style={{ color: '#ff2d78' }}>CLINIC OFFLINE</span>
          </div>
        </div>
      </div>

      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none opacity-10 z-0 flex items-center justify-center">
        <div className="w-[300px] h-[300px] rounded-full border border-dashed border-primary animate-[spin_60s_linear_infinite]" />
        <div className="absolute w-[200px] h-[200px] rounded-full border border-primary" />
        <div className="absolute w-full h-[1px] bg-primary/50" />
        <div className="absolute h-full w-[1px] bg-primary/50" />
      </div>
    </div>
  );
}
