import { useState } from "react";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { ClinicMap } from "@/components/ClinicMap";
import { Clinic, clinics } from "@/data/clinics";

export function MapView() {
  const [selectedClinic, setSelectedClinic] = useState<Clinic | null>(null);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [routeTarget, setRouteTarget] = useState<Clinic | null>(null);

  const handleClearRoute = () => setRouteTarget(null);

  return (
    <div className="flex flex-col h-screen w-full bg-background overflow-hidden dark scanline" dir="rtl">
      <Header />
      <main className="flex-1 relative flex">
        <ClinicMap
          clinics={clinics}
          onSelectClinic={setSelectedClinic}
          selectedClinic={selectedClinic}
          userLocation={userLocation}
          onUserLocationChange={setUserLocation}
          routeTarget={routeTarget}
          onNavigate={setRouteTarget}
          onClearRoute={handleClearRoute}
        />
        <Sidebar
          clinic={selectedClinic}
          onClose={() => { setSelectedClinic(null); handleClearRoute(); }}
          userLocation={userLocation}
          onNavigate={setRouteTarget}
          routeTarget={routeTarget}
          onClearRoute={handleClearRoute}
        />
      </main>
    </div>
  );
}
