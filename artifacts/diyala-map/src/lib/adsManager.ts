/**
 * adsManager.ts — Centralized Ad Integration Layer
 * ──────────────────────────────────────────────────────────────────────────────
 * Current mode: Web Mock (simulates ads for testing)
 *
 * MOBILE MIGRATION PATH (Capacitor + AdMob):
 *   1. Install: npm install @capacitor-community/admob
 *   2. In showRewardedAd() below, locate the "MOBILE SWAP POINT" comment
 *   3. Replace the mock block with the native SDK call shown in the comment
 *   4. Set your real Ad Unit IDs in AD_UNIT_IDS below
 *   5. No changes needed in any other file — this is the only swap point
 *
 * PLACEMENT NAMES (for analytics & future per-placement controls):
 *   'mission_button'    — BountyShortcutButton "شاهد المهمة" flow
 *   'challenge_gameover'— ChallengeModal end-of-game bonus button
 *   Add more as needed — all tracked here centrally
 */

// ── Ad Unit IDs ───────────────────────────────────────────────────────────────
// Replace with real AdMob unit IDs when going mobile
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
// MOBILE SWAP POINT — replace the entire function body with:
// ─────────────────────────────────────────────────────────
//   import { AdMob } from '@capacitor-community/admob';
//   await AdMob.prepareRewardVideoAd({ adId: AD_UNIT_IDS.rewarded });
//   const result = await AdMob.showRewardVideoAd();
//   return { success: true, reward: { type: result.rewardType, amount: result.rewardAmount } };
// ─────────────────────────────────────────────────────────
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
