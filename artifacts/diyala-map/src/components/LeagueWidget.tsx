import { useState, useEffect, useRef } from 'react';

// ── theSportsDB free API (no key needed for v1) ──────────────────────────────
// League IDs on theSportsDB:
//   English Premier League → 4328
//   Spanish La Liga        → 4335
//   Iraqi Premier League   → 4987 (falls back to placeholder if unavailable)
const SPORTS_DB = 'https://www.thesportsdb.com/api/v1/json/3';

interface TeamStanding {
  name:   string;
  badge:  string | null;
  points: number;
  played: number;
  wins:   number;
  draws:  number;
  losses: number;
  gd:     number;
}

interface LeagueInfo {
  label:   string;
  flag:    string;
  color:   string;
  leagueId: number;
  season:  string;
}

const LEAGUES: LeagueInfo[] = [
  { label: 'الدوري العراقي',  flag: '🇮🇶', color: '#f5c518', leagueId: 4987, season: '2024-2025' },
  { label: 'الدوري الإسباني', flag: '🇪🇸', color: '#ff2d78', leagueId: 4335, season: '2024-2025' },
  { label: 'الدوري الإنجليزي',flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', color: '#00d4ff', leagueId: 4328, season: '2024-2025' },
];

async function fetchTopTeam(leagueId: number, season: string): Promise<TeamStanding | null> {
  try {
    const url = `${SPORTS_DB}/lookuptable.php?l=${leagueId}&s=${encodeURIComponent(season)}`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const data = await res.json();
    const rows = data?.table;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    // Sort by points desc, then goal diff desc
    const sorted = [...rows].sort((a: any, b: any) =>
      Number(b.intPoints) - Number(a.intPoints) ||
      (Number(b.intGoalsFor) - Number(b.intGoalsAgainst)) -
      (Number(a.intGoalsFor) - Number(a.intGoalsAgainst))
    );
    const top = sorted[0] as any;
    return {
      name:   top.strTeam          ?? '—',
      badge:  top.strTeamBadge     ?? null,
      points: Number(top.intPoints ?? 0),
      played: Number(top.intPlayed ?? 0),
      wins:   Number(top.intWin    ?? 0),
      draws:  Number(top.intDraw   ?? 0),
      losses: Number(top.intLoss   ?? 0),
      gd:     (Number(top.intGoalsFor ?? 0)) - (Number(top.intGoalsAgainst ?? 0)),
    };
  } catch {
    return null;
  }
}

// ── Single League Card ────────────────────────────────────────────────────────
function LeagueCard({ info, active }: { info: LeagueInfo; active: boolean }) {
  const [team,    setTeam]    = useState<TeamStanding | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(false);
  const fetched = useRef(false);

  useEffect(() => {
    if (!active || fetched.current) return;
    fetched.current = true;
    setLoading(true);
    setError(false);
    fetchTopTeam(info.leagueId, info.season)
      .then(t => {
        setTeam(t);
        if (!t) setError(true);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [active]);

  const { color, flag, label } = info;

  return (
    <div style={{
      flex: '1 1 0',
      minWidth: 0,
      background: `linear-gradient(160deg,${color}10,${color}04)`,
      border: `1px solid ${color}33`,
      borderRadius: '4px',
      padding: '10px 8px 9px',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '6px',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Glow top-edge */}
      <div style={{
        position: 'absolute', top: 0, left: '10%', right: '10%',
        height: '1px', background: color, opacity: 0.45,
        boxShadow: `0 0 8px ${color}`,
      }}/>

      {/* League flag */}
      <div style={{ fontSize: '20px', lineHeight: 1 }}>{flag}</div>

      {/* League label */}
      <div style={{
        fontFamily: 'Orbitron, sans-serif', fontSize: '6px',
        color: `${color}99`, letterSpacing: '0.12em',
        textAlign: 'center', lineHeight: 1.3,
      }}>{label}</div>

      {/* ── Loading state ── */}
      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '48px' }}>
          <svg width="16" height="16" viewBox="0 0 28 28" fill="none"
            style={{ animation: 'um-spin 0.85s linear infinite' }}>
            <circle cx="14" cy="14" r="10" stroke={color} strokeWidth="2.5"
              strokeDasharray="22 14" strokeLinecap="round"/>
          </svg>
        </div>
      )}

      {/* ── Error / no data ── */}
      {!loading && error && (
        <div style={{
          textAlign: 'center', fontSize: '9px',
          color: 'rgba(255,255,255,0.25)',
          fontFamily: 'Rajdhani, sans-serif',
          lineHeight: 1.4, padding: '4px 0',
        }}>
          قريباً<br/>
          <span style={{ fontSize: '8px', opacity: 0.6 }}>coming soon</span>
        </div>
      )}

      {/* ── Team data ── */}
      {!loading && team && (
        <>
          {/* Badge */}
          {team.badge ? (
            <img
              src={team.badge}
              alt={team.name}
              width={32}
              height={32}
              style={{ objectFit: 'contain', filter: 'drop-shadow(0 0 4px rgba(255,255,255,0.2))' }}
              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          ) : (
            <div style={{
              width: 32, height: 32, borderRadius: '50%',
              background: `${color}20`, border: `1px solid ${color}44`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '16px',
            }}>⚽</div>
          )}

          {/* Team name */}
          <div style={{
            fontFamily: 'Rajdhani, sans-serif', fontSize: '11px', fontWeight: 700,
            color: color, textAlign: 'center', lineHeight: 1.25,
            textShadow: `0 0 10px ${color}66`,
            maxWidth: '100%', overflow: 'hidden',
            display: '-webkit-box', WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
          }}>
            {team.name}
          </div>

          {/* Points badge */}
          <div style={{
            fontFamily: 'Orbitron, sans-serif', fontSize: '14px', fontWeight: 700,
            color: color, textShadow: `0 0 14px ${color}`,
            letterSpacing: '0.04em',
          }}>
            {team.points}
            <span style={{ fontSize: '7px', opacity: 0.65, marginRight: '2px' }}>نقطة</span>
          </div>

          {/* W-D-L mini row */}
          <div style={{
            display: 'flex', gap: '4px', justifyContent: 'center',
            fontFamily: 'Orbitron, sans-serif', fontSize: '7px',
          }}>
            <span style={{ color: '#00f5d4', opacity: 0.9 }}>{team.wins}ف</span>
            <span style={{ color: 'rgba(255,255,255,0.3)' }}>·</span>
            <span style={{ color: '#f5c518', opacity: 0.8 }}>{team.draws}ت</span>
            <span style={{ color: 'rgba(255,255,255,0.3)' }}>·</span>
            <span style={{ color: '#ff2d78', opacity: 0.8 }}>{team.losses}خ</span>
          </div>
        </>
      )}
    </div>
  );
}

// ── Main Widget (exported) ────────────────────────────────────────────────────
export function LeagueWidget({ active }: { active: boolean }) {
  return (
    <div style={{ marginBottom: '14px' }}>
      {/* Section header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '8px',
        marginBottom: '10px',
      }}>
        <div style={{ flex: 1, height: '1px', background: 'linear-gradient(90deg,transparent,rgba(0,212,255,0.25))' }}/>
        <div style={{
          fontFamily: 'Orbitron, sans-serif', fontSize: '7px',
          color: 'rgba(0,212,255,0.55)', letterSpacing: '0.22em',
          whiteSpace: 'nowrap',
        }}>
          ⚽ LEAGUE STANDINGS · المتصدرون
        </div>
        <div style={{ flex: 1, height: '1px', background: 'linear-gradient(90deg,rgba(0,212,255,0.25),transparent)' }}/>
      </div>

      {/* 3 cards grid */}
      <div style={{ display: 'flex', gap: '6px' }}>
        {LEAGUES.map(lg => (
          <LeagueCard key={lg.leagueId} info={lg} active={active} />
        ))}
      </div>
    </div>
  );
}
