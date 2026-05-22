import { Router, type IRouter, type Request, type Response } from "express";
import { db, settingsTable, gameScoresTable, gameProfilesTable } from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";

const router: IRouter = Router();

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Upsert a game profile row and return it */
async function upsertProfile(uid: string) {
  const [row] = await db
    .insert(gameProfilesTable)
    .values({ firebaseUid: uid })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  const [existing] = await db
    .select()
    .from(gameProfilesTable)
    .where(eq(gameProfilesTable.firebaseUid, uid));
  return existing;
}

// ── GET /api/game/config ────────────────────────────────────────────────────
router.get("/game/config", async (req: Request, res: Response) => {
  try {
    const rows = await db
      .select()
      .from(settingsTable)
      .where(
        sql`${settingsTable.key} IN ('game_character_url','game_target_url','game_duration')`
      );

    const map: Record<string, string> = {};
    for (const r of rows) map[r.key] = r.value;

    res.json({
      characterUrl: map["game_character_url"] ?? "",
      targetUrl:    map["game_target_url"]    ?? "",
      duration:     parseInt(map["game_duration"] ?? "60", 10),
    });
  } catch (err) {
    req.log.error({ err }, "game config fetch error");
    res.status(500).json({ error: "internal" });
  }
});

// ── PATCH /api/game/config ──────────────────────────────────────────────────
router.patch("/game/config", async (req: Request, res: Response) => {
  const { characterUrl, targetUrl, duration } = req.body as {
    characterUrl?: string;
    targetUrl?:    string;
    duration?:     number;
  };

  try {
    const updates: Array<{ key: string; value: string }> = [];
    if (characterUrl !== undefined) updates.push({ key: "game_character_url", value: String(characterUrl) });
    if (targetUrl    !== undefined) updates.push({ key: "game_target_url",    value: String(targetUrl)    });
    if (duration     !== undefined) updates.push({ key: "game_duration",      value: String(duration)     });

    for (const u of updates) {
      await db
        .insert(settingsTable)
        .values({ key: u.key, value: u.value })
        .onConflictDoUpdate({
          target: settingsTable.key,
          set:    { value: u.value, updatedAt: new Date() },
        });
    }

    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "game config update error");
    res.status(500).json({ error: "internal" });
  }
});

// ── POST /api/game/score ────────────────────────────────────────────────────
// Submit a score. Accumulates game points in the player's profile.
router.post("/game/score", async (req: Request, res: Response) => {
  const { userId, userName, score } = req.body as {
    userId?:   string;
    userName?: string;
    score?:    number;
  };

  if (!userId || typeof score !== "number" || score < 0) {
    res.status(400).json({ error: "userId and score are required" });
    return;
  }

  try {
    // Insert score record
    const [inserted] = await db
      .insert(gameScoresTable)
      .values({
        userId,
        userName: userName?.slice(0, 80) ?? "لاعب",
        score:    Math.floor(score),
      })
      .returning();

    // Accumulate game points in profile (score earned = points gained)
    await db
      .insert(gameProfilesTable)
      .values({
        firebaseUid: userId,
        gamePoints:  Math.floor(score),
      })
      .onConflictDoUpdate({
        target: gameProfilesTable.firebaseUid,
        set: {
          gamePoints: sql`${gameProfilesTable.gamePoints} + ${Math.floor(score)}`,
          updatedAt:  new Date(),
        },
      });

    res.status(201).json({ id: inserted.id, score: inserted.score });
  } catch (err) {
    req.log.error({ err }, "game score insert error");
    res.status(500).json({ error: "internal" });
  }
});

// ── GET /api/game/leaderboard ───────────────────────────────────────────────
router.get("/game/leaderboard", async (req: Request, res: Response) => {
  try {
    const rows = await db.execute(sql`
      SELECT
        user_id     AS "userId",
        user_name   AS "userName",
        MAX(score)  AS "bestScore"
      FROM game_scores
      GROUP BY user_id, user_name
      ORDER BY "bestScore" DESC
      LIMIT 20
    `);

    const entries = (rows.rows as Array<{ userId: string; userName: string; bestScore: string }>)
      .map((r, i) => ({
        rank:      i + 1,
        userId:    r.userId,
        userName:  r.userName,
        bestScore: Number(r.bestScore),
      }));

    res.json(entries);
  } catch (err) {
    req.log.error({ err }, "game leaderboard fetch error");
    res.status(500).json({ error: "internal" });
  }
});

// ── GET /api/game/profile/:uid ──────────────────────────────────────────────
// Returns the player's game profile (points, cash, skins, activeSkin)
router.get("/game/profile/:uid", async (req: Request, res: Response) => {
  const { uid } = req.params;
  try {
    const profile = await upsertProfile(uid);
    if (!profile) {
      res.status(404).json({ error: "profile not found" });
      return;
    }
    res.json(profile);
  } catch (err) {
    req.log.error({ err }, "game profile fetch error");
    res.status(500).json({ error: "internal" });
  }
});

// ── POST /api/game/shop/buy-skin ────────────────────────────────────────────
// Purchase a skin using gameCash.
// Body: { firebaseUid: string, skinId: string, price: number }
// Logic:
//   - Verify gameCash >= price
//   - Deduct price from gameCash
//   - Add skinId to unlockedSkins (if not already owned)
router.post("/game/shop/buy-skin", async (req: Request, res: Response) => {
  const { firebaseUid, skinId, price } = req.body as {
    firebaseUid?: string;
    skinId?:      string;
    price?:       number;
  };

  if (!firebaseUid || !skinId || typeof price !== "number" || price < 0) {
    res.status(400).json({ error: "firebaseUid, skinId, and price are required" });
    return;
  }

  try {
    const profile = await upsertProfile(firebaseUid);
    if (!profile) {
      res.status(404).json({ error: "profile not found" });
      return;
    }

    // Check if already owned
    if (profile.unlockedSkins.includes(skinId)) {
      res.status(409).json({ error: "skin_already_owned", message: "هذا السكن مملوك بالفعل" });
      return;
    }

    // Check balance
    if (profile.gameCash < price) {
      res.status(402).json({
        error:    "insufficient_balance",
        message:  "رصيدك غير كافٍ لشراء هذا السكن",
        gameCash: profile.gameCash,
        required: price,
      });
      return;
    }

    // Deduct price and add skin
    const [updated] = await db
      .update(gameProfilesTable)
      .set({
        gameCash:      profile.gameCash - price,
        unlockedSkins: sql`array_append(${gameProfilesTable.unlockedSkins}, ${skinId}::text)`,
        updatedAt:     new Date(),
      })
      .where(eq(gameProfilesTable.firebaseUid, firebaseUid))
      .returning();

    res.json({
      ok:            true,
      gameCash:      updated.gameCash,
      unlockedSkins: updated.unlockedSkins,
    });
  } catch (err) {
    req.log.error({ err }, "buy-skin error");
    res.status(500).json({ error: "internal" });
  }
});

// ── POST /api/game/shop/redeem-points ───────────────────────────────────────
// Convert game points to cash.
// Rate: 5000 game points → 1000 IQD (gameCash)
// Body: { firebaseUid: string }
const REDEEM_POINTS_COST  = 5000;
const REDEEM_CASH_REWARD  = 1000;

router.post("/game/shop/redeem-points", async (req: Request, res: Response) => {
  const { firebaseUid } = req.body as { firebaseUid?: string };

  if (!firebaseUid) {
    res.status(400).json({ error: "firebaseUid is required" });
    return;
  }

  try {
    const profile = await upsertProfile(firebaseUid);
    if (!profile) {
      res.status(404).json({ error: "profile not found" });
      return;
    }

    if (profile.gamePoints < REDEEM_POINTS_COST) {
      res.status(402).json({
        error:      "insufficient_points",
        message:    `تحتاج ${REDEEM_POINTS_COST} نقطة على الأقل للاستبدال`,
        gamePoints: profile.gamePoints,
        required:   REDEEM_POINTS_COST,
      });
      return;
    }

    // How many full redemption blocks does the player have?
    const blocks       = Math.floor(profile.gamePoints / REDEEM_POINTS_COST);
    const pointsSpent  = blocks * REDEEM_POINTS_COST;
    const cashEarned   = blocks * REDEEM_CASH_REWARD;

    const [updated] = await db
      .update(gameProfilesTable)
      .set({
        gamePoints: profile.gamePoints - pointsSpent,
        gameCash:   profile.gameCash   + cashEarned,
        updatedAt:  new Date(),
      })
      .where(eq(gameProfilesTable.firebaseUid, firebaseUid))
      .returning();

    res.json({
      ok:           true,
      pointsSpent,
      cashEarned,
      gamePoints:   updated.gamePoints,
      gameCash:     updated.gameCash,
    });
  } catch (err) {
    req.log.error({ err }, "redeem-points error");
    res.status(500).json({ error: "internal" });
  }
});

// ── PATCH /api/game/profile/:uid/active-skin ────────────────────────────────
// Set the currently active skin.
// Body: { skinId: string }
router.patch("/game/profile/:uid/active-skin", async (req: Request, res: Response) => {
  const { uid }    = req.params;
  const { skinId } = req.body as { skinId?: string };

  if (!skinId) {
    res.status(400).json({ error: "skinId is required" });
    return;
  }

  try {
    const profile = await upsertProfile(uid);
    if (!profile) {
      res.status(404).json({ error: "profile not found" });
      return;
    }

    if (!profile.unlockedSkins.includes(skinId)) {
      res.status(403).json({ error: "skin_not_owned", message: "هذا السكن غير مملوك" });
      return;
    }

    const [updated] = await db
      .update(gameProfilesTable)
      .set({ activeSkin: skinId, updatedAt: new Date() })
      .where(eq(gameProfilesTable.firebaseUid, uid))
      .returning();

    res.json({ ok: true, activeSkin: updated.activeSkin });
  } catch (err) {
    req.log.error({ err }, "active-skin update error");
    res.status(500).json({ error: "internal" });
  }
});

export default router;
