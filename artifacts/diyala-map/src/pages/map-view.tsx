import { useState, useEffect, useCallback } from "react";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { ClinicMap } from "@/components/ClinicMap";
import { AdminModal } from "@/components/AdminModal";
import { clinics as staticClinics } from "@/data/clinics";
import { restaurants } from "@/data/restaurants";
import { pharmacies } from "@/data/pharmacies";
import { MapItem, FilterKind } from "@/data/types";

export function MapView() {
  const [activeFilter, setActiveFilter] = useState<FilterKind>("clinic");
  const [selectedItem, setSelectedItem] = useState<MapItem | null>(null);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [routeTarget, setRouteTarget] = useState<MapItem | null>(null);

  // Admin Mode
  const [adminMode, setAdminMode] = useState(false);
  const [adminCoords, setAdminCoords] = useState<{ lat: number; lng: number } | null>(null);

  // DB clinics (added via admin)
  const [dbClinics, setDbClinics] = useState<MapItem[]>([]);

  // Load DB clinics on mount
  const fetchDbClinics = useCallback(async () => {
    try {
      const res = await fetch("/api/clinics");
      if (!res.ok) return;
      const data = await res.json();
      setDbClinics(data.map((c: any) => ({ ...c, kind: "clinic" as const })));
    } catch {
      // API not ready yet, fail silently
    }
  }, []);

  useEffect(() => { fetchDbClinics(); }, [fetchDbClinics]);

  const allItems: MapItem[] = [
    ...staticClinics,
    ...dbClinics,
    ...restaurants,
    ...pharmacies,
  ];

  const handleFilterChange = (f: FilterKind) => {
    setActiveFilter(f);
    setSelectedItem(null);
    setRouteTarget(null);
  };

  const handleAdminSaved = (clinic: MapItem) => {
    setDbClinics(prev => [...prev, clinic]);
    setAdminCoords(null);
  };

  return (
    <div className="flex flex-col h-screen w-full bg-background overflow-hidden dark" dir="rtl">
      <Header />
      <main className="flex-1 relative flex overflow-hidden">
        <ClinicMap
          items={allItems}
          activeFilter={activeFilter}
          onFilterChange={handleFilterChange}
          onSelectItem={setSelectedItem}
          selectedItem={selectedItem}
          userLocation={userLocation}
          onUserLocationChange={setUserLocation}
          routeTarget={routeTarget}
          onNavigate={setRouteTarget}
          onClearRoute={() => setRouteTarget(null)}
          adminMode={adminMode}
          onMapClick={(latlng) => { setAdminCoords(latlng); setSelectedItem(null); }}
        />

        {/* Admin Mode Toggle */}
        <button
          onClick={() => { setAdminMode(a => !a); setAdminCoords(null); }}
          style={{
            position: "absolute", bottom: "24px", right: "12px", zIndex: 1000,
            padding: "9px 16px",
            background: adminMode ? "rgba(0,245,212,0.18)" : "rgba(5,8,15,0.9)",
            border: `1px solid ${adminMode ? "#00f5d4" : "rgba(0,245,212,0.3)"}`,
            color: adminMode ? "#00f5d4" : "rgba(0,245,212,0.5)",
            fontFamily: "Orbitron, sans-serif", fontSize: "10px", letterSpacing: "0.1em",
            cursor: "pointer", display: "flex", alignItems: "center", gap: "8px",
            boxShadow: adminMode ? "0 0 20px rgba(0,245,212,0.3)" : "none",
            backdropFilter: "blur(10px)", transition: "all 0.25s",
          }}
        >
          <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: adminMode ? "#00f5d4" : "rgba(0,245,212,0.3)", boxShadow: adminMode ? "0 0 8px #00f5d4" : "none", flexShrink: 0, display: "inline-block", animation: adminMode ? "lf-ping 2s infinite" : "none" }} />
          {adminMode ? "ADMIN MODE · انقر على الخريطة" : "ADMIN MODE"}
        </button>

        <Sidebar
          item={selectedItem}
          onClose={() => { setSelectedItem(null); setRouteTarget(null); }}
          userLocation={userLocation}
          onNavigate={setRouteTarget}
          routeTarget={routeTarget}
          onClearRoute={() => setRouteTarget(null)}
        />

        <AdminModal
          latlng={adminCoords}
          onClose={() => setAdminCoords(null)}
          onSaved={handleAdminSaved}
        />
      </main>
    </div>
  );
}
