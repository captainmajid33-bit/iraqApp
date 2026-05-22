/**
 * adsManager.ts — Ad Integration Foundation
 * ──────────────────────────────────────────────────────────────────────────────
 * Current mode: Web Mock (simulates ads for testing)
 *
 * MOBILE MIGRATION PATH (Capacitor + AdMob):
 *   1. Install: npm install @capacitor-community/admob
 *   2. In each function below, locate the "MOBILE SWAP POINT" comment
 *   3. Replace the mock block with the native SDK call shown in the comment
 *   4. Set your real Ad Unit IDs in AD_UNIT_IDS below
 *   5. No changes needed in any other file
 */

// ── Ad Unit IDs ───────────────────────────────────────────────────────────────
// Replace with real AdMob unit IDs when going mobile
export const AD_UNIT_IDS = {
  rewarded:     'ca-app-pub-XXXXXXXXXXXXXXXX/XXXXXXXXXX',  // Rewarded video
  interstitial: 'ca-app-pub-XXXXXXXXXXXXXXXX/XXXXXXXXXX',  // Interstitial
  banner:       'ca-app-pub-XXXXXXXXXXXXXXXX/XXXXXXXXXX',  // Banner
};

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
// Web mock: simulates a 2.5-second "ad view" then grants reward.
//
// MOBILE SWAP POINT — replace entire function body with:
//   import { AdMob, RewardAdPluginEvents } from '@capacitor-community/admob';
//   await AdMob.prepareRewardVideoAd({ adId: AD_UNIT_IDS.rewarded });
//   const result = await AdMob.showRewardVideoAd();
//   return { success: true, reward: { type: result.rewardType, amount: result.rewardAmount } };
export async function showRewardedAd(): Promise<AdResult> {
  return new Promise(resolve => {
    // Web mock — simulates ad playback delay
    setTimeout(() => {
      resolve({
        success: true,
        reward: { type: 'points', amount: 50 },
      });
    }, 2500);
  });
}

// ── isAdsEnabled ──────────────────────────────────────────────────────────────
// Reads the ads_enabled flag from the backend settings API.
// Returns false on any error (fail-safe: never show ads if uncertain).
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
