import { useState } from "react";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { ClinicMap } from "@/components/ClinicMap";
import { clinics } from "@/data/clinics";
import { restaurants } from "@/data/restaurants";
import { pharmacies } from "@/data/pharmacies";
import { MapItem, FilterKind } from "@/data/types";

const allItems: MapItem[] = [...clinics, ...restaurants, ...pharmacies];

export function MapView() {
  const [activeFilter, setActiveFilter] = useState<FilterKind>('clinic');
  const [selectedItem, setSelectedItem] = useState<MapItem | null>(null);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [routeTarget, setRouteTarget] = useState<MapItem | null>(null);

  const handleFilterChange = (f: FilterKind) => {
    setActiveFilter(f);
    setSelectedItem(null);
    setRouteTarget(null);
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
        />
        <Sidebar
          item={selectedItem}
          onClose={() => { setSelectedItem(null); setRouteTarget(null); }}
          userLocation={userLocation}
          onNavigate={setRouteTarget}
          routeTarget={routeTarget}
          onClearRoute={() => setRouteTarget(null)}
        />
      </main>
    </div>
  );
}
