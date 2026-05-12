import { useState, useEffect, useCallback } from "react";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { ClinicMap } from "@/components/ClinicMap";
import { AdminModal } from "@/components/AdminModal";
import { MapItem, FilterKind } from "@/data/types";

const POLL_INTERVAL = 15_000; // 15 seconds

export function MapView() {
  const [activeFilter, setActiveFilter] = useState<FilterKind>("clinic");
  const [selectedItem, setSelectedItem] = useState<MapItem | null>(null);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [routeTarget, setRouteTarget] = useState<MapItem | null>(null);

  const adminMode = false;
  const [adminCoords, setAdminCoords] = useState<{ lat: number; lng: number } | null>(null);

  const [items, setItems] = useState<MapItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchLocations = useCallback(async () => {
    try {
      const res = await fetch("/api/locations");
      if (!res.ok) return;
      const data = await res.json();
      setItems(data.map((loc: any) => ({ ...loc, kind: loc.category as FilterKind })));
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch + polling for real-time sync with admin changes
  useEffect(() => {
    fetchLocations();
    const interval = setInterval(fetchLocations, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchLocations]);

  const handleFilterChange = (f: FilterKind) => {
    setActiveFilter(f);
    setSelectedItem(null);
    setRouteTarget(null);
  };

  const handleAdminSaved = (item: MapItem) => {
    setItems(prev => [...prev, item]);
    setAdminCoords(null);
  };

  const handleAdminDelete = useCallback(async (item: MapItem) => {
    try { await fetch(`/api/locations/${item.id}`, { method: "DELETE" }); } catch { /* ignore */ }
    setItems(prev => prev.filter(i => i.id !== item.id));
    if (selectedItem?.id === item.id) setSelectedItem(null);
    if (routeTarget?.id === item.id) setRouteTarget(null);
  }, [selectedItem, routeTarget]);

  return (
    <div className="flex flex-col h-screen w-full bg-background overflow-hidden dark" dir="rtl">
      <Header />
      <main className="flex-1 relative flex overflow-hidden">
        {loading && (
          <div style={{ position: "absolute", inset: 0, zIndex: 2000, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "rgba(5,8,15,0.92)", backdropFilter: "blur(8px)" }}>
            <div style={{ width: "48px", height: "48px", border: "2px solid rgba(0,245,212,0.15)", borderTop: "2px solid #00f5d4", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
            <div style={{ marginTop: "16px", fontFamily: "Orbitron, sans-serif", fontSize: "11px", color: "#00f5d4", letterSpacing: "0.15em" }}>LOADING DATABASE...</div>
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        )}

        <ClinicMap
          items={items}
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
