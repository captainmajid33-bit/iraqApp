import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { MapView } from "@/pages/map-view";
import { AdminLogin, AdminDashboard } from "@/pages/admin-dashboard";
import { useEffect } from "react";
import { handleBackButton, hideSplash } from "@/lib/capacitorPlugins";

const queryClient = new QueryClient();

// ── Mobile: back-button handler + splash hide ─────────────────────────────
function MobileInit() {
  const [location] = useLocation();

  useEffect(() => {
    // Hide splash screen once React tree is mounted
    hideSplash();

    // Register Android back-button handler
    let cleanup: (() => void) | undefined;
    handleBackButton(() => location === "/").then(fn => { cleanup = fn; });
    return () => cleanup?.();
  }, [location]);

  return null;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={MapView} />
      <Route path="/admin" component={AdminLogin} />
      <Route path="/admin/dashboard" component={AdminDashboard} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <MobileInit />
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
