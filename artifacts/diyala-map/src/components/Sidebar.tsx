import { useEffect, useState } from "react";
import { Clinic } from "@/data/clinics";
import { X, Phone, Clock, MapPin, User, Stethoscope, AlertTriangle } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@/components/ui/button";

interface SidebarProps {
  clinic: Clinic | null;
  onClose: () => void;
}

export function Sidebar({ clinic, onClose }: SidebarProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <AnimatePresence>
      {clinic && (
        <motion.aside
          initial={{ x: "100%", opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: "100%", opacity: 0 }}
          transition={{ type: "spring", damping: 25, stiffness: 200 }}
          className="absolute top-0 right-0 h-full w-[380px] bg-black/90 backdrop-blur-md neon-border z-20 flex flex-col scanline"
        >
          <div className="p-4 border-b border-primary/30 flex items-center justify-between bg-primary/5">
            <h2 className="text-lg font-mono font-bold text-primary neon-text tracking-wider">
              TARGET INFO
            </h2>
            <button 
              onClick={onClose}
              className="p-1 hover:bg-primary/20 text-primary transition-colors neon-border"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            <div>
              <h3 className="text-2xl font-bold text-primary mb-1 neon-text">{clinic.name}</h3>
              <div className="flex items-center gap-2 text-primary/70 font-mono text-sm">
                <span>ID: {clinic.id.toString().padStart(4, '0')}</span>
                <span>•</span>
                <span>COORD: {clinic.lat.toFixed(4)}, {clinic.lng.toFixed(4)}</span>
              </div>
            </div>

            <div className={`inline-flex items-center gap-2 px-3 py-1 font-mono text-sm uppercase ${clinic.status === 'مفتوح' ? 'neon-box-green neon-text-green bg-accent/10' : 'neon-box-magenta neon-text-magenta bg-secondary/10'}`}>
              <AlertTriangle className="w-4 h-4" />
              <span>STATUS: {clinic.status}</span>
            </div>

            <div className="space-y-4">
              <InfoRow icon={<User />} label="الطبيب" value={clinic.doctor} />
              <InfoRow icon={<Stethoscope />} label="الاختصاص" value={clinic.specialty} />
              <InfoRow icon={<MapPin />} label="العنوان" value={clinic.address} />
              <InfoRow icon={<Phone />} label="الهاتف" value={clinic.phone} font="font-mono" />
              <InfoRow icon={<Clock />} label="ساعات العمل" value={clinic.hours} font="font-mono" />
            </div>

            <div className="pt-6 mt-6 border-t border-primary/20">
              <Button 
                className="w-full bg-primary/20 hover:bg-primary/40 text-primary border border-primary neon-text font-mono text-lg py-6 tracking-widest uppercase transition-all"
                onClick={() => alert(`Initiating contact with ${clinic.phone}...`)}
              >
                تواصل / CONTACT
              </Button>
            </div>
          </div>
          
          <div className="p-2 border-t border-primary/30 bg-primary/5 text-center">
             <span className="text-[10px] text-primary/50 font-mono tracking-widest">
               DIYALA HEALTH DIRECTORATE • INTEL DEPT
             </span>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function InfoRow({ icon, label, value, font = "font-sans" }: { icon: React.ReactNode, label: string, value: string, font?: string }) {
  return (
    <div className="flex items-start gap-4 p-3 bg-white/5 border border-primary/10 hover:border-primary/30 transition-colors">
      <div className="text-primary mt-0.5">
        {icon}
      </div>
      <div>
        <p className="text-xs text-primary/50 font-mono mb-1">{label}</p>
        <p className={`text-lg text-white/90 ${font}`}>{value}</p>
      </div>
    </div>
  );
}
