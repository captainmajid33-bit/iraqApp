import { useState, useEffect, useCallback, useRef } from "react";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { ClinicMap } from "@/components/ClinicMap";
import { AdminModal } from "@/components/AdminModal";
import { UserLoginOverlay } from "@/components/UserLoginOverlay";
import { UserMenu } from "@/components/UserMenu";
import { MapItem, Category } from "@/data/types";

const POLL_MS = 30_000; // 30 s fallback poll (SSE handles real-time)

export function MapView() {
  const [items, setItems] = useState<MapItem[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [activeFilter, setActiveFilter] = useState<string>("");
  const [loading, setLoading] = useState(true);

  const [selectedItem, setSelectedItem] = useState<MapItem | null>(null);
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [routeTarget, setRouteTarget] = useState<MapItem | null>(null);
  const [adminCoords, setAdminCoords] = useState<{ lat: number; lng: number } | null>(null);

  const firstCatRef = useRef("");

  // ── Full fetch (initial + fallback polling) ───────────────────────────────
  const fetchAll = useCallback(async () => {
    try {
      const [locRes, catRes] = await Promise.all([
        fetch("/api/locations"),
        fetch("/api/categories"),
      ]);
      if (locRes.ok) {
        const locs = await locRes.json();
        setItems(locs.map((loc: any) => ({ ...loc, kind: loc.category })));
      }
      if (catRes.ok) {
        const cats: Category[] = await catRes.json();
        if (Array.isArray(cats) && cats.length > 0) {
          const sorted = [...cats].sort((a, b) => a.labelEn.localeCompare(b.labelEn));
          setCategories(sorted);
          if (!firstCatRef.current) {
            firstCatRef.current = sorted[0].slug;
            setActiveFilter(sorted[0].slug);
          }
        }
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const iv = setInterval(fetchAll, POLL_MS);
    return () => clearInterval(iv);
  }, [fetchAll]);

  // ── SSE — instant real-time updates from partner app or admin ─────────────
  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimeout: ReturnType<typeof setTimeout>;

    function connect() {
      es = new EventSource("/api/events");

      es.addEventListener("location_update", (e: MessageEvent) => {
        try {
          const { location } = JSON.parse(e.data) as { location: any };
          if (!location?.id) return;

          if (location._deleted) {
            // Location was deleted
            setItems(prev => prev.filter(i => i.id !== location.id));
            setSelectedItem(prev => prev?.id === location.id ? null : prev);
            setRouteTarget(prev => prev?.id === location.id ? null : prev);
          } else {
            // Upsert: update existing or add new
            setItems(prev => {
              const idx = prev.findIndex(i => i.id === location.id);
              const mapped = { ...location, kind: location.category };
              if (idx >= 0) {
                const next = [...prev];
                next[idx] = { ...prev[idx], ...mapped };
                return next;
              }
              return [...prev, mapped];
            });
            // If this item is currently selected, update the sidebar too
            setSelectedItem(prev =>
              prev?.id === location.id ? { ...prev, ...location, kind: location.category } : prev
            );
          }
        } catch {
          // malformed event — ignore
        }
      });

      es.onerror = () => {
        es?.close();
        // Retry after 5 s
        retryTimeout = setTimeout(connect, 5_000);
      };
    }

    connect();
    return () => {
      clearTimeout(retryTimeout);
      es?.close();
    };
  }, []);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleFilterChange = (f: string) => {
    setActiveFilter(f);
    setSelectedItem(null);
    setRouteTarget(null);
  };

  const handleAdminSaved = (item: MapItem) => {
    setItems(prev => [...prev, item]);
    setAdminCoords(null);
  };

  const handleAdminDelete = useCallback(async (item: MapItem) => {
    try { await fetch(`/api/locations/${item.id}`, { method: "DELETE" }); } catch { /* */ }
    setItems(prev => prev.filter(i => i.id !== item.id));
    if (selectedItem?.id === item.id) setSelectedItem(null);
    if (routeTarget?.id === item.id) setRouteTarget(null);
  }, [selectedItem, routeTarget]);

  return (
    <div className="flex flex-col h-screen w-full bg-background overflow-hidden dark" dir="rtl">
      <UserLoginOverlay onLogin={() => {}} />
      <Header />
      <main className="flex-1 relative flex overflow-hidden">
        <UserMenu />
        {loading && (
          <div style={{ position: "absolute", inset: 0, zIndex: 2000, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "rgba(5,8,15,0.92)", backdropFilter: "blur(8px)" }}>
            <div style={{ width: "48px", height: "48px", border: "2px solid rgba(0,245,212,0.15)", borderTop: "2px solid #00f5d4", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
            <div style={{ marginTop: "16px", fontFamily: "Orbitron, sans-serif", fontSize: "11px", color: "#00f5d4", letterSpacing: "0.15em" }}>LOADING DATABASE...</div>
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        )}

        <ClinicMap
          items={items}
          categories={categories}
          activeFilter={activeFilter}
          onFilterChange={handleFilterChange}
          onSelectItem={setSelectedItem}
          selectedItem={selectedItem}
          userLocation={userLocation}
          onUserLocationChange={setUserLocation}
          routeTarget={routeTarget}
          onNavigate={setRouteTarget}
          onClearRoute={() => setRouteTarget(null)}
          adminMode={false}
          onMapClick={(latlng) => { setAdminCoords(latlng); setSelectedItem(null); }}
          onAdminDelete={handleAdminDelete}
        />

        <Sidebar
          item={selectedItem}
          categories={categories}
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
