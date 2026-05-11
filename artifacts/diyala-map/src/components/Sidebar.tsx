import { Clinic } from "@/data/clinics";
import { X, Phone, Clock, MapPin, User, Stethoscope, AlertTriangle, Navigation, XCircle } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@/components/ui/button";

interface SidebarProps {
  clinic: Clinic | null;
  onClose: () => void;
  userLocation: { lat: number; lng: number } | null;
  onNavigate: (clinic: Clinic) => void;
  routeTarget: Clinic | null;
  onClearRoute: () => void;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function Sidebar({ clinic, onClose, userLocation, onNavigate, routeTarget, onClearRoute }: SidebarProps) {
  const isNavigating = routeTarget?.id === clinic?.id;
  const distanceKm = userLocation && clinic
    ? haversineKm(userLocation.lat, userLocation.lng, clinic.lat, clinic.lng)
    : null;

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
                <span>ID: {clinic.id.toString().padStart(4, "0")}</span>
                <span>•</span>
                <span>COORD: {clinic.lat.toFixed(4)}, {clinic.lng.toFixed(4)}</span>
              </div>
            </div>

            <div
              className={`inline-flex items-center gap-2 px-3 py-1 font-mono text-sm uppercase ${
                clinic.status === "مفتوح"
                  ? "neon-box-green neon-text-green bg-accent/10"
                  : "neon-box-magenta neon-text-magenta bg-secondary/10"
              }`}
            >
              <AlertTriangle className="w-4 h-4" />
              <span>STATUS: {clinic.status}</span>
            </div>

            {distanceKm !== null && (
              <div
                className="flex items-center gap-3 px-3 py-2 font-mono text-sm"
                style={{
                  border: "1px solid rgba(245,197,24,0.5)",
                  background: "rgba(245,197,24,0.06)",
                  color: "#f5c518",
                  boxShadow: "0 0 8px rgba(245,197,24,0.2)",
                }}
              >
                <Navigation className="w-4 h-4 flex-shrink-0" />
                <span>
                  المسافة التقريبية:{" "}
                  <strong>
                    {distanceKm < 1
                      ? `${Math.round(distanceKm * 1000)} م`
                      : `${distanceKm.toFixed(1)} كم`}
                  </strong>
                </span>
              </div>
            )}

            <div className="space-y-4">
              <InfoRow icon={<User />} label="الطبيب" value={clinic.doctor} />
              <InfoRow icon={<Stethoscope />} label="الاختصاص" value={clinic.specialty} />
              <InfoRow icon={<MapPin />} label="العنوان" value={clinic.address} />
              <InfoRow icon={<Phone />} label="الهاتف" value={clinic.phone} font="font-mono" />
              <InfoRow icon={<Clock />} label="ساعات العمل" value={clinic.hours} font="font-mono" />
            </div>

            <div className="pt-4 border-t border-primary/20 space-y-3">
              {isNavigating ? (
                <Button
                  className="w-full font-mono text-sm py-5 tracking-widest uppercase transition-all"
                  style={{
                    background: "rgba(245,197,24,0.15)",
                    border: "1px solid #f5c518",
                    color: "#f5c518",
                    boxShadow: "0 0 16px rgba(245,197,24,0.4)",
                  }}
                  onClick={onClearRoute}
                >
                  <XCircle className="w-4 h-4 ml-2" />
                  إلغاء المسار / CANCEL ROUTE
                </Button>
              ) : (
                <Button
                  className="w-full font-mono text-sm py-5 tracking-widest uppercase transition-all"
                  style={{
                    background: userLocation ? "rgba(245,197,24,0.12)" : "rgba(100,100,100,0.1)",
                    border: `1px solid ${userLocation ? "#f5c518" : "#444"}`,
                    color: userLocation ? "#f5c518" : "#555",
                    boxShadow: userLocation ? "0 0 12px rgba(245,197,24,0.3)" : "none",
                    cursor: userLocation ? "pointer" : "not-allowed",
                  }}
                  onClick={() => userLocation && onNavigate(clinic)}
                  title={!userLocation ? "اضغط على زر تحديد موقعي أولاً" : undefined}
                >
                  <Navigation className="w-4 h-4 ml-2" />
                  {userLocation ? "الذهاب إليه / NAVIGATE" : "حدد موقعك أولاً"}
                </Button>
              )}

              <Button
                className="w-full bg-primary/20 hover:bg-primary/40 text-primary border border-primary neon-text font-mono text-sm py-5 tracking-widest uppercase transition-all"
                onClick={() => window.open(`tel:${clinic.phone}`)}
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

function InfoRow({
  icon,
  label,
  value,
  font = "font-sans",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  font?: string;
}) {
  return (
    <div className="flex items-start gap-4 p-3 bg-white/5 border border-primary/10 hover:border-primary/30 transition-colors">
      <div className="text-primary mt-0.5">{icon}</div>
      <div>
        <p className="text-xs text-primary/50 font-mono mb-1">{label}</p>
        <p className={`text-lg text-white/90 ${font}`}>{value}</p>
      </div>
    </div>
  );
}
