import { Router, type IRouter, type Request, type Response } from "express";
import { db, settingsTable, gameScoresTable, gameProfilesTable, gameCurrentSessionTable } from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";
import { broadcastGameSessionUpdate } from "../lib/sse";
import { randomUUID } from "crypto";

// Admin guard (same password as rest of admin routes)
const ADMIN_PW = process.env.ADMIN_PASSWORD ?? "Admin2026";
function isAdmin(req: Request): boolean {
  return (
    req.headers["x-admin-password"] === ADMIN_PW ||
    req.headers["x-admin-token"]    === ADMIN_PW
  );
}

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

// ── GET /api/game/session ────────────────────────────────────────────────────
// Returns the currently active session (or the most recent one)
router.get("/game/session", async (req: Request, res: Response) => {
  try {
    const [session] = await db
      .select()
      .from(gameCurrentSessionTable)
      .where(eq(gameCurrentSessionTable.isActive, true))
      .limit(1);
    res.json(session ?? null);
  } catch (err) {
    req.log.error({ err }, "game session fetch error");
    res.status(500).json({ error: "internal" });
  }
});

// ── POST /api/game/session ───────────────────────────────────────────────────
// Admin: create and activate a new session
// Body: { totalItems, itemType?, imageUrl? }
router.post("/game/session", async (req: Request, res: Response) => {
  if (!isAdmin(req)) { res.status(401).json({ error: "unauthorized" }); return; }

  const { totalItems = 100, itemType = "burger", imageUrl = "" } = req.body as {
    totalItems?: number;
    itemType?:   string;
    imageUrl?:   string;
  };

  if (totalItems < 1 || totalItems > 10000) {
    res.status(400).json({ error: "totalItems must be between 1 and 10000" });
    return;
  }

  try {
    // Deactivate any existing active sessions
    await db
      .update(gameCurrentSessionTable)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(gameCurrentSessionTable.isActive, true));

    const [session] = await db
      .insert(gameCurrentSessionTable)
      .values({
        sessionId:  randomUUID(),
        totalItems: Math.floor(totalItems),
        itemsLeft:  Math.floor(totalItems),
        itemType,
        imageUrl,
        isActive:   true,
      })
      .returning();

    broadcastGameSessionUpdate({
      sessionId:  session.sessionId,
      totalItems: session.totalItems,
      itemsLeft:  session.itemsLeft,
      itemType:   session.itemType,
      imageUrl:   session.imageUrl,
      isActive:   session.isActive,
    });

    res.status(201).json(session);
  } catch (err) {
    req.log.error({ err }, "game session create error");
    res.status(500).json({ error: "internal" });
  }
});

// ── PATCH /api/game/session ──────────────────────────────────────────────────
// Admin: toggle isActive or update fields on the current active session
router.patch("/game/session", async (req: Request, res: Response) => {
  if (!isAdmin(req)) { res.status(401).json({ error: "unauthorized" }); return; }

  const { isActive, itemsLeft, imageUrl, itemType } = req.body as {
    isActive?:  boolean;
    itemsLeft?: number;
    imageUrl?:  string;
    itemType?:  string;
  };

  try {
    const [session] = await db
      .select()
      .from(gameCurrentSessionTable)
      .where(eq(gameCurrentSessionTable.isActive, true))
      .limit(1);

    if (!session) { res.status(404).json({ error: "no active session" }); return; }

    const updates: Partial<typeof gameCurrentSessionTable.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (isActive  !== undefined) updates.isActive  = isActive;
    if (itemsLeft !== undefined) updates.itemsLeft = Math.max(0, itemsLeft);
    if (imageUrl  !== undefined) updates.imageUrl  = imageUrl;
    if (itemType  !== undefined) updates.itemType  = itemType;

    const [updated] = await db
      .update(gameCurrentSessionTable)
      .set(updates)
      .where(eq(gameCurrentSessionTable.id, session.id))
      .returning();

    broadcastGameSessionUpdate({
      sessionId:  updated.sessionId,
      totalItems: updated.totalItems,
      itemsLeft:  updated.itemsLeft,
      itemType:   updated.itemType,
      imageUrl:   updated.imageUrl,
      isActive:   updated.isActive,
    });

    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "game session patch error");
    res.status(500).json({ error: "internal" });
  }
});

// ── POST /api/game/session/catch ─────────────────────────────────────────────
// Player catches one item. Atomically decrements itemsLeft.
// Awards 1 gamePoint to the player's profile.
// Broadcasts updated session state to ALL connected clients via SSE.
// Body: { firebaseUid, userName? }
router.post("/game/session/catch", async (req: Request, res: Response) => {
  const { firebaseUid, userName } = req.body as {
    firebaseUid?: string;
    userName?:    string;
  };

  if (!firebaseUid) {
    res.status(400).json({ error: "firebaseUid is required" });
    return;
  }

  try {
    // Atomic decrement — only succeeds if session is active and items remain
    const result = await db.execute(sql`
      UPDATE game_current_session
      SET    items_left = items_left - 1,
             updated_at  = NOW()
      WHERE  is_active   = true
        AND  items_left  > 0
      RETURNING
        session_id,
        total_items,
        items_left,
        item_type,
        image_url,
        is_active
    `);

    const rows = result.rows as Array<{
      session_id:  string;
      total_items: number;
      items_left:  number;
      item_type:   string;
      image_url:   string;
      is_active:   boolean;
    }>;

    if (rows.length === 0) {
      // No active session or no items left
      res.json({ caught: false, reason: "no_items_left" });
      return;
    }

    const row = rows[0];

    // Award 1 gamePoint to the player's profile (upsert)
    await db
      .insert(gameProfilesTable)
      .values({ firebaseUid, gamePoints: 1 })
      .onConflictDoUpdate({
        target: gameProfilesTable.firebaseUid,
        set: {
          gamePoints: sql`${gameProfilesTable.gamePoints} + 1`,
          updatedAt:  new Date(),
        },
      });

    // Broadcast updated state to ALL connected SSE clients
    const sessionPayload = {
      sessionId:  row.session_id,
      totalItems: Number(row.total_items),
      itemsLeft:  Number(row.items_left),
      itemType:   row.item_type,
      imageUrl:   row.image_url,
      isActive:   row.is_active,
    };
    broadcastGameSessionUpdate(sessionPayload);

    res.json({
      caught:    true,
      itemsLeft: Number(row.items_left),
      session:   sessionPayload,
    });
  } catch (err) {
    req.log.error({ err }, "game session catch error");
    res.status(500).json({ error: "internal" });
  }
});

export default router;
