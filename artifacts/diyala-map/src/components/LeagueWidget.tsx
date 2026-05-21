import { useState, useEffect, useRef } from 'react';

// ── Dynamic season: auto-detects current football season ─────────────────────
// Football seasons run Aug–May. In May 2026: season = "2025-2026", year = 2025.
function getCurrentSeason(): { label: string; sportsDbSeason: string } {
  const now   = new Date();
  const yr    = now.getFullYear();
  const mo    = now.getMonth() + 1; // 1-12
  const start = mo >= 8 ? yr : yr - 1;
  return {
    label:          `${start}/${start + 1}`,
    sportsDbSeason: `${start}-${start + 1}`,
  };
}

// ── Data shape ────────────────────────────────────────────────────────────────
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

// ── ESPN fetch (primary — no API key, live, has logos) ────────────────────────
async function fetchFromESPN(slug: string): Promise<TeamStanding | null> {
  try {
    const url = `https://site.api.espn.com/apis/v2/sports/soccer/${slug}/standings`;
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(7000) });
    if (!res.ok) return null;
    const data = await res.json();

    const entries: any[] =
      data?.children?.[0]?.standings?.entries ??
      data?.standings?.entries ??
      [];
    if (!entries.length) return null;

    // ESPN already returns entries sorted by rank — index 0 = leader
    const e = entries[0];
    const stat = (name: string): number =>
      e.stats?.find((s: any) => s.name === name)?.value ?? 0;

    const gd = stat('pointDifferential');

    return {
      name:   e.team?.displayName ?? '—',
      badge:  e.team?.logos?.[0]?.href ?? null,
      points: stat('points'),
      played: stat('gamesPlayed'),
      wins:   stat('wins'),
      draws:  stat('ties'),
      losses: stat('losses'),
      gd:     typeof gd === 'number' ? gd : 0,
    };
  } catch {
    return null;
  }
}

// ── theSportsDB fetch (fallback — open, no key) ───────────────────────────────
async function fetchFromSportsDB(leagueId: number, season: string): Promise<TeamStanding | null> {
  try {
    const url = `https://www.thesportsdb.com/api/v1/json/3/lookuptable.php?l=${leagueId}&s=${encodeURIComponent(season)}`;
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(7000) });
    if (!res.ok) return null;
    const data = await res.json();
    const rows: any[] = data?.table ?? [];
    if (!rows.length) return null;

    const sorted = [...rows].sort((a, b) =>
      Number(b.intPoints) - Number(a.intPoints) ||
      (Number(b.intGoalsFor) - Number(b.intGoalsAgainst)) -
      (Number(a.intGoalsFor) - Number(a.intGoalsAgainst))
    );
    const top = sorted[0];
    return {
      name:   top.strTeam     ?? '—',
      badge:  top.strBadge    ?? top.strTeamBadge ?? null,
      points: Number(top.intPoints ?? 0),
      played: Number(top.intPlayed ?? 0),
      wins:   Number(top.intWin    ?? 0),
      draws:  Number(top.intDraw   ?? 0),
      losses: Number(top.intLoss   ?? 0),
      gd:     Number(top.intGoalsFor ?? 0) - Number(top.intGoalsAgainst ?? 0),
    };
  } catch {
    return null;
  }
}

// ── League config ─────────────────────────────────────────────────────────────
interface LeagueInfo {
  label:       string;
  flag:        string;
  color:       string;
  espnSlug:    string | null; // null = ESPN doesn't cover this league
  sportsDbId:  number | null; // null = no theSportsDB coverage
}

const LEAGUES: LeagueInfo[] = [
  {
    label:      'الدوري الإنجليزي',
    flag:       '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
    color:      '#00d4ff',
    espnSlug:   'eng.1',
    sportsDbId: 4328,
  },
  {
    label:      'الدوري الإسباني',
    flag:       '🇪🇸',
    color:      '#ff2d78',
    espnSlug:   'esp.1',
    sportsDbId: 4335,
  },
  {
    label:      'الدوري العراقي',
    flag:       '🇮🇶',
    color:      '#f5c518',
    espnSlug:   null,
    sportsDbId: 4987,
  },
];

// ── Fetch orchestrator ────────────────────────────────────────────────────────
async function fetchTopTeam(info: LeagueInfo, sportsDbSeason: string): Promise<TeamStanding | null> {
  if (info.espnSlug) {
    const espnResult = await fetchFromESPN(info.espnSlug);
    if (espnResult) return espnResult;
  }
  if (info.sportsDbId) {
    return fetchFromSportsDB(info.sportsDbId, sportsDbSeason);
  }
  return null;
}

// ── Single League Card ────────────────────────────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000; // 5-minute cache per card

function LeagueCard({
  info,
  active,
  seasonLabel,
  sportsDbSeason,
}: {
  info:            LeagueInfo;
  active:          boolean;
  seasonLabel:     string;
  sportsDbSeason:  string;
}) {
  const [team,    setTeam]    = useState<TeamStanding | null>(null);
  const [loading, setLoading] = useState(false);
  const [noData,  setNoData]  = useState(false);
  const lastFetchedAt = useRef<number>(0);

  useEffect(() => {
    if (!active) return;
    const age = Date.now() - lastFetchedAt.current;
    if (age < CACHE_TTL_MS && team !== null) return; // still fresh

    let cancelled = false;
    setLoading(true);
    setNoData(false);

    fetchTopTeam(info, sportsDbSeason).then(t => {
      if (cancelled) return;
      setTeam(t);
      setNoData(!t);
      lastFetchedAt.current = Date.now();
    }).catch(() => {
      if (!cancelled) { setNoData(true); }
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => { cancelled = true; };
  // Re-run when dialog opens (active flips true) — cache check prevents spam
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

      {/* Flag */}
      <div style={{ fontSize: '20px', lineHeight: 1 }}>{flag}</div>

      {/* League label */}
      <div style={{
        fontFamily: 'Orbitron, sans-serif', fontSize: '6px',
        color: `${color}99`, letterSpacing: '0.10em',
        textAlign: 'center', lineHeight: 1.3,
      }}>{label}</div>

      {/* Season label */}
      <div style={{
        fontFamily: 'Rajdhani, sans-serif', fontSize: '8px',
        color: 'rgba(255,255,255,0.2)', letterSpacing: '0.06em',
      }}>{seasonLabel}</div>

      {/* ── Loading ── */}
      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '48px' }}>
          <svg width="16" height="16" viewBox="0 0 28 28" fill="none"
            style={{ animation: 'um-spin 0.85s linear infinite' }}>
            <circle cx="14" cy="14" r="10" stroke={color} strokeWidth="2.5"
              strokeDasharray="22 14" strokeLinecap="round"/>
          </svg>
        </div>
      )}

      {/* ── No data ── */}
      {!loading && noData && (
        <div style={{
          textAlign: 'center', fontSize: '8px',
          color: 'rgba(255,255,255,0.22)',
          fontFamily: 'Rajdhani, sans-serif',
          lineHeight: 1.5, padding: '4px 0',
        }}>
          لا تتوفر<br/>بيانات رسمية
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
            color, textAlign: 'center', lineHeight: 1.2,
            textShadow: `0 0 10px ${color}66`,
            maxWidth: '100%', overflow: 'hidden',
            display: '-webkit-box', WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
          }}>
            {team.name}
          </div>

          {/* Points */}
          <div style={{
            fontFamily: 'Orbitron, sans-serif', fontSize: '14px', fontWeight: 700,
            color, textShadow: `0 0 14px ${color}`,
            letterSpacing: '0.04em',
          }}>
            {team.points}
            <span style={{ fontSize: '7px', opacity: 0.65, marginRight: '2px' }}>نقطة</span>
          </div>

          {/* W-D-L */}
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

// ── Main Widget ───────────────────────────────────────────────────────────────
export function LeagueWidget({ active }: { active: boolean }) {
  const season = getCurrentSeason();

  return (
    <div style={{ marginBottom: '14px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
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

      {/* 3 cards */}
      <div style={{ display: 'flex', gap: '6px' }}>
        {LEAGUES.map(lg => (
          <LeagueCard
            key={lg.label}
            info={lg}
            active={active}
            seasonLabel={season.label}
            sportsDbSeason={season.sportsDbSeason}
          />
        ))}
      </div>
    </div>
  );
}
