import { useState } from "react";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { ClinicMap } from "@/components/ClinicMap";
import { Clinic, clinics } from "@/data/clinics";

export function MapView() {
  const [selectedClinic, setSelectedClinic] = useState<Clinic | null>(null);

  const handleClinicSelect = (clinic: Clinic | null) => {
    setSelectedClinic(clinic);
  };

  return (
    <div className="flex flex-col h-screen w-full bg-background overflow-hidden dark scanline" dir="rtl">
      <Header />
      <main className="flex-1 relative flex">
        <ClinicMap 
          clinics={clinics} 
          onSelectClinic={handleClinicSelect} 
          selectedClinic={selectedClinic} 
        />
        <Sidebar 
          clinic={selectedClinic} 
          onClose={() => setSelectedClinic(null)} 
        />
      </main>
    </div>
  );
}
