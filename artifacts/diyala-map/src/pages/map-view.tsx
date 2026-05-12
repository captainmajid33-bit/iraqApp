import { useState, useEffect, useCallback } from "react";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { ClinicMap } from "@/components/ClinicMap";
import { AdminModal } from "@/components/AdminModal";
import { clinics as staticClinics } from "@/data/clinics";
import { restaurants } from "@/data/restaurants";
import { pharmacies } from "@/data/pharmacies";
import { gasStations } from "@/data/gas_stations";
import { MapItem, FilterKind } from "@/data/types";

export function MapView() {
  const [activeFilter, setActiveFilter] = useState<FilterKind>("clinic");
  const [selectedItem, setSelectedItem] = useState<MapItem | null>(null);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [routeTarget, setRouteTarget] = useState<MapItem | null>(null);

  const [adminMode, setAdminMode] = useState(false);
  const [adminCoords, setAdminCoords] = useState<{ lat: number; lng: number } | null>(null);

  // DB items (added via admin)
  const [dbItems, setDbItems] = useState<MapItem[]>([]);
  // IDs of static items hidden by admin delete
  const [hiddenStaticIds, setHiddenStaticIds] = useState<Set<number>>(new Set());

  const fetchDbItems = useCallback(async () => {
    try {
      const res = await fetch("/api/locations");
      if (!res.ok) return;
      const data = await res.json();
      setDbItems(data.map((c: any) => ({ ...c, kind: (c.category ?? "clinic") as FilterKind })));
    } catch {
      // API not ready, silent fail
    }
  }, []);

  useEffect(() => { fetchDbItems(); }, [fetchDbItems]);

  const staticItems: MapItem[] = [
    ...staticClinics,
    ...restaurants,
    ...pharmacies,
    ...gasStations,
  ].filter(i => !hiddenStaticIds.has(i.id));

  const allItems: MapItem[] = [...staticItems, ...dbItems];

  const handleFilterChange = (f: FilterKind) => {
    setActiveFilter(f);
    setSelectedItem(null);
    setRouteTarget(null);
  };

  const handleAdminSaved = (item: MapItem) => {
    setDbItems(prev => [...prev, item]);
    setAdminCoords(null);
  };

  const handleAdminDelete = useCallback(async (item: MapItem) => {
    const isDbItem = 'category' in item;

    if (isDbItem) {
      try {
        await fetch(`/api/locations/${item.id}`, { method: "DELETE" });
        setDbItems(prev => prev.filter(i => i.id !== item.id));
      } catch {
        // ignore
      }
    } else {
      // Static item — hide locally
      setHiddenStaticIds(prev => new Set([...prev, item.id]));
    }

    if (selectedItem?.id === item.id) setSelectedItem(null);
    if (routeTarget?.id === item.id) setRouteTarget(null);
  }, [selectedItem, routeTarget]);

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
          onAdminDelete={handleAdminDelete}
        />

        {/* Admin Mode Toggle */}
        <button
          onClick={() => { setAdminMode(a => !a); setAdminCoords(null); }}
          style={{
            position: "absolute", bottom: "24px", right: "12px", zIndex: 1000,
            padding: "9px 16px",
            background: adminMode ? "rgba(255,45,120,0.15)" : "rgba(5,8,15,0.9)",
            border: `1px solid ${adminMode ? "#ff2d78" : "rgba(0,245,212,0.3)"}`,
            color: adminMode ? "#ff2d78" : "rgba(0,245,212,0.5)",
            fontFamily: "Orbitron, sans-serif", fontSize: "10px", letterSpacing: "0.1em",
            cursor: "pointer", display: "flex", alignItems: "center", gap: "8px",
            boxShadow: adminMode ? "0 0 20px rgba(255,45,120,0.3)" : "none",
            backdropFilter: "blur(10px)", transition: "all 0.25s",
          }}
        >
          <span style={{
            width: "8px", height: "8px", borderRadius: "50%",
            background: adminMode ? "#ff2d78" : "rgba(0,245,212,0.3)",
            boxShadow: adminMode ? "0 0 8px #ff2d78" : "none",
            flexShrink: 0, display: "inline-block",
            animation: adminMode ? "lf-ping 2s infinite" : "none",
          }} />
          {adminMode ? "ADMIN · انقر للإضافة أو الحذف" : "ADMIN MODE"}
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
