/**
 * adsManager.ts — Centralized Ad Integration Layer
 * ──────────────────────────────────────────────────────────────────────────────
 * Current mode: Web Mock (simulates ads for testing)
 *
 * ══════════════════════════════════════════════════════════════════════
 * MOBILE MIGRATION — 3 steps, this file only:
 *
 * Step 1 — Install AdMob plugin (run once, locally):
 *   pnpm --filter @workspace/diyala-map add @capacitor-community/admob
 *   npx cap sync
 *
 * Step 2 — Add real Ad Unit IDs in AD_UNIT_IDS below
 *
 * Step 3 — Replace showRewardedAd() body with the native block shown in
 *           the MOBILE SWAP POINT comment below
 * ══════════════════════════════════════════════════════════════════════
 *
 * PLACEMENT NAMES (for analytics & per-placement controls):
 *   'mission_button'    — BountyShortcutButton "شاهد المهمة" flow
 *   'challenge_gameover'— ChallengeModal end-of-game bonus button
 */

// ── Ad Unit IDs ───────────────────────────────────────────────────────────────
// Replace with your real AdMob unit IDs before publishing to stores
export const AD_UNIT_IDS = {
  rewarded:     'ca-app-pub-XXXXXXXXXXXXXXXX/XXXXXXXXXX',  // Rewarded video
  interstitial: 'ca-app-pub-XXXXXXXXXXXXXXXX/XXXXXXXXXX',  // Interstitial
  banner:       'ca-app-pub-XXXXXXXXXXXXXXXX/XXXXXXXXXX',  // Banner
};

// ── Watch duration (seconds) ──────────────────────────────────────────────────
// Exported so SimulatedAdOverlay can show a matching countdown.
// On mobile this is irrelevant (AdMob controls duration natively).
export const AD_WATCH_SECONDS = 15;

// ── Types ─────────────────────────────────────────────────────────────────────
export interface AdReward {
  type:   string;
  amount: number;
}

export interface AdResult {
  success: boolean;
  reward?: AdReward;
  error?:  string;
}

// ── showRewardedAd ────────────────────────────────────────────────────────────
// Shows a rewarded video ad and returns the reward on completion.
// Web mock: simulates the full AD_WATCH_SECONDS duration then grants reward.
//
// ══════════════════════════════════════════════════════════════════════════════
// MOBILE SWAP POINT — replace the entire function body below with:
// ──────────────────────────────────────────────────────────────────────────────
//   import { AdMob, AdLoadInfo } from '@capacitor-community/admob';
//   import { Capacitor } from '@capacitor/core';
//
//   export async function showRewardedAd(placement_name = 'default'): Promise<AdResult> {
//     console.log(`[adsManager] showRewardedAd — placement: ${placement_name}`);
//     if (!Capacitor.isNativePlatform()) {
//       // Fallback for web preview during native development
//       return { success: true, reward: { type: 'points', amount: 50 } };
//     }
//     try {
//       await AdMob.prepareRewardVideoAd({
//         adId: AD_UNIT_IDS.rewarded,
//         isTesting: false, // set true during development
//       });
//       const result = await AdMob.showRewardVideoAd();
//       return { success: true, reward: { type: result.rewardType, amount: result.rewardAmount } };
//     } catch (e) {
//       console.error(`[adsManager] Ad failed (${placement_name}):`, e);
//       return { success: false, error: String(e) };
//     }
//   }
// ══════════════════════════════════════════════════════════════════════════════
export async function showRewardedAd(placement_name = 'default'): Promise<AdResult> {
  console.log(`[adsManager] showRewardedAd — placement: ${placement_name}`);
  return new Promise(resolve => {
    // Web mock — simulates full ad watch duration
    setTimeout(() => {
      console.log(`[adsManager] rewarded ad completed — placement: ${placement_name}`);
      resolve({
        success: true,
        reward: { type: 'points', amount: 50 },
      });
    }, AD_WATCH_SECONDS * 1000);
  });
}

// ── isAdsEnabled ──────────────────────────────────────────────────────────────
// Reads the ads_enabled flag from the backend settings API.
// Returns false on any error (fail-safe: never show ads if uncertain).
// Used by ALL ad placements — toggling in admin controls everything centrally.
export async function isAdsEnabled(baseUrl = ''): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl}/api/settings/ads_enabled`);
    if (!r.ok) return false;
    const d = await r.json();
    return d?.value === 'true';
  } catch {
    return false;
  }
}
