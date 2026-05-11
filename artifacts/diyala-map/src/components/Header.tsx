import { MapPin } from "lucide-react";

export function Header() {
  return (
    <header className="h-16 flex items-center justify-between px-6 border-b neon-border bg-black/80 backdrop-blur-sm z-10 shrink-0">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-none bg-primary/20 neon-border flex items-center justify-center">
          <MapPin className="text-primary w-6 h-6 animate-pulse" />
        </div>
        <div className="flex flex-col">
          <h1 className="text-2xl font-bold font-mono tracking-wider neon-text text-primary">خريطة الرعاية الصحية</h1>
          <span className="text-xs tracking-widest text-primary/70 font-mono">ديالى بالذكاء الاصطناعي • SYSTEM ONLINE</span>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <div className="hidden md:flex items-center gap-2 border border-primary/30 px-3 py-1 bg-primary/5">
          <div className="w-2 h-2 rounded-full bg-accent animate-pulse shadow-[0_0_5px_hsl(var(--accent))]"></div>
          <span className="text-xs font-mono text-accent">SECURE CONNECTION</span>
        </div>
        <div className="font-mono text-xl tracking-wider text-primary neon-text flex items-center gap-2">
          <span>{new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
          <span className="text-primary/50 text-sm">IQ-DIA</span>
        </div>
      </div>
    </header>
  );
}
