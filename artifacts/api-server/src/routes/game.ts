import { Router, type IRouter, type Request, type Response } from "express";
import { db, settingsTable, gameScoresTable, gameProfilesTable, gameCurrentSessionTable, usersTable, shopItemsTable } from "@workspace/db";
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
        sql`${settingsTable.key} IN ('game_character_url','game_target_url','game_duration','game_background_url','game_bg_theme')`
      );

    const map: Record<string, string> = {};
    for (const r of rows) map[r.key] = r.value;

    res.json({
      characterUrl:  map["game_character_url"]  ?? "",
      targetUrl:     map["game_target_url"]     ?? "",
      duration:      parseInt(map["game_duration"] ?? "60", 10),
      backgroundUrl: map["game_background_url"] ?? "",
      bgTheme:       parseInt(map["game_bg_theme"] ?? "0", 10),
    });
  } catch (err) {
    req.log.error({ err }, "game config fetch error");
    res.status(500).json({ error: "internal" });
  }
});

// ── PATCH /api/game/config ──────────────────────────────────────────────────
router.patch("/game/config", async (req: Request, res: Response) => {
  const { characterUrl, targetUrl, duration, backgroundUrl, bgTheme } = req.body as {
    characterUrl?:  string;
    targetUrl?:     string;
    duration?:      number;
    backgroundUrl?: string;
    bgTheme?:       number;
  };

  try {
    const updates: Array<{ key: string; value: string }> = [];
    if (characterUrl  !== undefined) updates.push({ key: "game_character_url",  value: String(characterUrl)  });
    if (targetUrl     !== undefined) updates.push({ key: "game_target_url",     value: String(targetUrl)     });
    if (duration      !== undefined) updates.push({ key: "game_duration",       value: String(duration)      });
    if (backgroundUrl !== undefined) updates.push({ key: "game_background_url", value: String(backgroundUrl) });
    if (bgTheme       !== undefined) updates.push({ key: "game_bg_theme",       value: String(bgTheme)       });

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

// ── GET /api/game/wallet/:firebaseUid ───────────────────────────────────────
// Returns real wallet balance (users.balance) linked to a Firebase UID.
router.get("/game/wallet/:firebaseUid", async (req: Request, res: Response) => {
  const { firebaseUid } = req.params;
  try {
    const [user] = await db
      .select({ balance: usersTable.balance, id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.firebaseUid, firebaseUid));
    res.json({ balance: user?.balance ?? 0, linked: !!user });
  } catch (err) {
    req.log.error({ err }, "wallet fetch error");
    res.status(500).json({ error: "internal" });
  }
});

// ── POST /api/game/wallet/link ──────────────────────────────────────────────
// Link a Firebase UID to an existing users row (by userId integer id).
// Body: { firebaseUid, userId }
router.post("/game/wallet/link", async (req: Request, res: Response) => {
  const { firebaseUid, userId } = req.body as { firebaseUid?: string; userId?: number };
  if (!firebaseUid || !userId) {
    res.status(400).json({ error: "firebaseUid and userId required" }); return;
  }
  try {
    await db.update(usersTable).set({ firebaseUid }).where(eq(usersTable.id, userId));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "wallet link error");
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
// Purchase a skin — tries wallet balance (users.balance) first, falls back to gameCash.
// Body: { firebaseUid: string, skinId: string, price: number }
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
    if (!profile) { res.status(404).json({ error: "profile not found" }); return; }

    // Check if already owned
    if (profile.unlockedSkins.includes(skinId)) {
      res.status(409).json({ error: "skin_already_owned", message: "هذا السكن مملوك بالفعل" });
      return;
    }

    // ── Try real wallet (users.balance linked via firebase_uid) first ─────────
    const [walletUser] = await db
      .select({ id: usersTable.id, balance: usersTable.balance })
      .from(usersTable)
      .where(eq(usersTable.firebaseUid, firebaseUid));

    if (walletUser && walletUser.balance >= price) {
      // Deduct from real wallet
      await db
        .update(usersTable)
        .set({ balance: walletUser.balance - price })
        .where(eq(usersTable.id, walletUser.id));

      // Add skin to profile
      const [updated] = await db
        .update(gameProfilesTable)
        .set({
          unlockedSkins: sql`array_append(${gameProfilesTable.unlockedSkins}, ${skinId}::text)`,
          updatedAt:     new Date(),
        })
        .where(eq(gameProfilesTable.firebaseUid, firebaseUid))
        .returning();

      res.json({
        ok:             true,
        source:         "wallet",
        walletBalance:  walletUser.balance - price,
        gameCash:       updated.gameCash,
        unlockedSkins:  updated.unlockedSkins,
      });
      return;
    }

    // ── Fall back to gameCash ─────────────────────────────────────────────────
    if (profile.gameCash < price) {
      const walletBalance = walletUser?.balance ?? 0;
      res.status(402).json({
        error:         "insufficient_balance",
        message:       `رصيدك غير كافٍ — المحفظة: ${walletBalance} د، نقود اللعبة: ${profile.gameCash} د، المطلوب: ${price} د`,
        walletBalance,
        gameCash:      profile.gameCash,
        required:      price,
      });
      return;
    }

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
      source:        "gameCash",
      walletBalance: walletUser?.balance ?? 0,
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

// ── POST /api/game/admin/start-session ───────────────────────────────────────
// Dedicated admin endpoint — start (or restart) the global live game session.
// Body: { totalItems: number, itemType?: string, imageUrl?: string }
// Broadcasts game_session_update to ALL connected clients immediately.
router.post("/game/admin/start-session", async (req: Request, res: Response) => {
  if (!isAdmin(req)) { res.status(401).json({ error: "unauthorized" }); return; }

  const { totalItems = 50, itemType = "burger", imageUrl = "" } = req.body as {
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

    // Broadcast to ALL connected clients immediately
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
    req.log.error({ err }, "game admin start-session error");
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

// ── POST /api/game/shop/upgrade ──────────────────────────────────────────────
// Upgrade magnet duration or combo window using wallet or gameCash.
// Body: { firebaseUid: string, statType: 'magnet' | 'combo' }
const UPG_COSTS: Record<string, number[]> = {
  magnet: [1500, 3000, 5000, 8000], // index = current level - 1 (L1→L2 costs [0], etc.)
  combo:  [1500, 3000, 5000, 8000],
};
const MAX_UPG = 5;

router.post("/game/shop/upgrade", async (req: Request, res: Response) => {
  const { firebaseUid, statType } = req.body as { firebaseUid?: string; statType?: string };
  if (!firebaseUid || !['magnet', 'combo'].includes(statType ?? '')) {
    res.status(400).json({ error: "invalid_params" }); return;
  }
  try {
    const profile = await upsertProfile(firebaseUid);
    if (!profile) { res.status(404).json({ error: "profile_not_found" }); return; }

    const currentLevel = statType === 'magnet' ? profile.magnetLevel : profile.comboLevel;
    if (currentLevel >= MAX_UPG) {
      res.status(409).json({ error: "max_level", message: "وصلت للحد الأقصى من التطوير!" }); return;
    }

    const cost = UPG_COSTS[statType!][currentLevel - 1];

    // Try real wallet first
    const [walletUser] = await db
      .select({ id: usersTable.id, balance: usersTable.balance })
      .from(usersTable)
      .where(eq(usersTable.firebaseUid, firebaseUid));

    let source: 'wallet' | 'gameCash';
    if (walletUser && walletUser.balance >= cost) {
      await db.update(usersTable)
        .set({ balance: walletUser.balance - cost })
        .where(eq(usersTable.id, walletUser.id));
      source = 'wallet';
    } else if (profile.gameCash >= cost) {
      source = 'gameCash';
    } else {
      res.status(402).json({
        error:         "insufficient_balance",
        message:       `رصيدك غير كافٍ — المطلوب: ${cost.toLocaleString()} د.ع`,
        walletBalance: walletUser?.balance ?? 0,
        gameCash:      profile.gameCash,
        required:      cost,
      }); return;
    }

    const newLevel = currentLevel + 1;
    const setData  = statType === 'magnet'
      ? { magnetLevel: newLevel, updatedAt: new Date(), ...(source === 'gameCash' ? { gameCash: profile.gameCash - cost } : {}) }
      : { comboLevel:  newLevel, updatedAt: new Date(), ...(source === 'gameCash' ? { gameCash: profile.gameCash - cost } : {}) };

    const [updated] = await db
      .update(gameProfilesTable)
      .set(setData)
      .where(eq(gameProfilesTable.firebaseUid, firebaseUid))
      .returning();

    res.json({
      ok:            true,
      statType,
      newLevel,
      source,
      walletBalance: source === 'wallet' ? (walletUser!.balance - cost) : (walletUser?.balance ?? 0),
      gameCash:      updated.gameCash,
      magnetLevel:   updated.magnetLevel,
      comboLevel:    updated.comboLevel,
    });
  } catch (err) {
    req.log.error({ err }, "upgrade error");
    res.status(500).json({ error: "internal" });
  }
});

// ── Friendly Duels — wallet-locked matchmaking ───────────────────────────────
interface DuelRoom {
  creatorId:     string;
  creatorDbId:   number;
  joinerId?:     string;
  joinerDbId?:   number;
  bet:           number;
  createdAt:     number;
  status:        'waiting' | 'active' | 'done';
  creatorScore?: number;
  joinerScore?:  number;
}
const duelRooms = new Map<string, DuelRoom>();

// Helper: look up DB user by Firebase UID
async function getDuelWalletUser(firebaseUid: string) {
  const [u] = await db
    .select({ id: usersTable.id, balance: usersTable.balance })
    .from(usersTable)
    .where(eq(usersTable.firebaseUid, firebaseUid));
  return u ?? null;
}

// POST /api/game/duel/create — deducts bet from creator, returns duelId
router.post("/game/duel/create", async (req: Request, res: Response) => {
  const { firebaseUid, bet } = req.body as { firebaseUid?: string; bet?: number };
  if (!firebaseUid || typeof bet !== 'number' || bet < 100) {
    res.status(400).json({ error: "invalid_params" }); return;
  }
  try {
    const walletUser = await getDuelWalletUser(firebaseUid);
    if (!walletUser) {
      res.status(400).json({ error: "wallet_not_linked", message: "المحفظة غير مربوطة — سجّل الدخول أولاً" }); return;
    }
    if (walletUser.balance < bet) {
      res.status(400).json({ error: "insufficient_balance", walletBalance: walletUser.balance,
        message: `رصيدك ${walletUser.balance.toLocaleString()} د.ع — المطلوب ${bet.toLocaleString()} د.ع` }); return;
    }
    await db.update(usersTable).set({ balance: walletUser.balance - bet }).where(eq(usersTable.id, walletUser.id));
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let duelId  = '';
    for (let i = 0; i < 6; i++) duelId += chars[Math.floor(Math.random() * chars.length)];
    const cutoff = Date.now() - 86_400_000;
    for (const [k, v] of duelRooms) if (v.createdAt < cutoff) duelRooms.delete(k);
    duelRooms.set(duelId, { creatorId: firebaseUid, creatorDbId: walletUser.id, bet, createdAt: Date.now(), status: 'waiting' });
    res.json({ duelId, bet, walletBalance: walletUser.balance - bet });
  } catch (err) {
    req.log.error({ err }, "duel create error");
    res.status(500).json({ error: "internal" });
  }
});

// GET /api/game/duel/:duelId — get room info
router.get("/game/duel/:duelId", async (req: Request, res: Response) => {
  const duelId = (req.params.duelId ?? '').toUpperCase();
  const room   = duelRooms.get(duelId);
  if (!room) { res.status(404).json({ error: "not_found" }); return; }
  res.json({ duelId, bet: room.bet, status: room.status, hasJoiner: !!room.joinerId });
});

// POST /api/game/duel/accept — joiner pays bet and activates room
router.post("/game/duel/accept", async (req: Request, res: Response) => {
  const { firebaseUid, duelId } = req.body as { firebaseUid?: string; duelId?: string };
  if (!firebaseUid || !duelId) { res.status(400).json({ error: "invalid_params" }); return; }
  const roomKey = duelId.toUpperCase();
  const room    = duelRooms.get(roomKey);
  if (!room)                            { res.status(404).json({ error: "not_found" }); return; }
  if (room.status !== 'waiting')        { res.status(400).json({ error: "duel_not_waiting", message: "التحدي بدأ أو انتهى بالفعل" }); return; }
  if (room.creatorId === firebaseUid)   { res.status(400).json({ error: "cannot_join_own_duel", message: "لا يمكنك الانضمام لتحديك الخاص" }); return; }
  try {
    const walletUser = await getDuelWalletUser(firebaseUid);
    if (!walletUser) { res.status(400).json({ error: "wallet_not_linked", message: "المحفظة غير مربوطة" }); return; }
    if (walletUser.balance < room.bet) {
      res.status(400).json({ error: "insufficient_balance", walletBalance: walletUser.balance,
        message: `رصيدك ${walletUser.balance.toLocaleString()} د.ع — المطلوب ${room.bet.toLocaleString()} د.ع` }); return;
    }
    await db.update(usersTable).set({ balance: walletUser.balance - room.bet }).where(eq(usersTable.id, walletUser.id));
    room.joinerId   = firebaseUid;
    room.joinerDbId = walletUser.id;
    room.status     = 'active';
    res.json({ duelId: roomKey, bet: room.bet, walletBalance: walletUser.balance - room.bet });
  } catch (err) {
    req.log.error({ err }, "duel accept error");
    res.status(500).json({ error: "internal" });
  }
});

// POST /api/game/duel/score — submit score; pays winner when both submitted
router.post("/game/duel/score", async (req: Request, res: Response) => {
  const { firebaseUid, duelId, score } = req.body as { firebaseUid?: string; duelId?: string; score?: number };
  if (!firebaseUid || !duelId || typeof score !== 'number') {
    res.status(400).json({ error: "invalid_params" }); return;
  }
  const roomKey = duelId.toUpperCase();
  const room    = duelRooms.get(roomKey);
  if (!room) { res.status(404).json({ error: "not_found" }); return; }
  if (room.status === 'done') { res.json({ done: true, alreadyPaid: true }); return; }

  let isCreator = false;
  if      (room.creatorId === firebaseUid) { room.creatorScore = score; isCreator = true; }
  else if (room.joinerId  === firebaseUid) { room.joinerScore  = score; }
  else { res.status(403).json({ error: "not_in_duel" }); return; }

  if (room.creatorScore !== undefined && room.joinerScore !== undefined) {
    const creatorWon  = room.creatorScore >= room.joinerScore;
    const winnerDbId  = creatorWon ? room.creatorDbId : room.joinerDbId!;
    const winnerScore = Math.max(room.creatorScore, room.joinerScore);
    const loserScore  = Math.min(room.creatorScore, room.joinerScore);
    const prize       = room.bet * 2;
    try {
      await db.update(usersTable).set({ balance: sql`balance + ${prize}` }).where(eq(usersTable.id, winnerDbId));
      room.status = 'done';
      const youWon = (isCreator && creatorWon) || (!isCreator && !creatorWon);
      res.json({ done: true, youWon, winnerScore, loserScore, prize });
    } catch (err) {
      req.log.error({ err }, "duel payout error");
      res.status(500).json({ error: "payout_failed" });
    }
  } else {
    res.json({ done: false, waiting: true, submitted: isCreator ? 'creator' : 'joiner' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SHOP ITEMS — public + admin CRUD
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/game/shop/items  — public, returns active items ordered by sort_order
router.get("/game/shop/items", async (req: Request, res: Response) => {
  try {
    const rows = await db
      .select()
      .from(shopItemsTable)
      .where(eq(shopItemsTable.isActive, true))
      .orderBy(shopItemsTable.sortOrder, shopItemsTable.id);
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "shop items fetch error");
    res.status(500).json({ error: "internal" });
  }
});

// GET /api/game/admin/shop/items  — admin, returns ALL items
router.get("/game/admin/shop/items", async (req: Request, res: Response) => {
  if (!isAdmin(req)) { res.status(403).json({ error: "forbidden" }); return; }
  try {
    const rows = await db
      .select()
      .from(shopItemsTable)
      .orderBy(shopItemsTable.sortOrder, shopItemsTable.id);
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "admin shop items error");
    res.status(500).json({ error: "internal" });
  }
});

// POST /api/game/admin/shop/add
router.post("/game/admin/shop/add", async (req: Request, res: Response) => {
  if (!isAdmin(req)) { res.status(403).json({ error: "forbidden" }); return; }
  const { name, emoji = "🎭", price = 1000, imageUrl = "", color = "#00f5d4", category = "skin", sortOrder = 0 } =
    req.body as { name?: string; emoji?: string; price?: number; imageUrl?: string; color?: string; category?: string; sortOrder?: number };
  if (!name?.trim()) { res.status(400).json({ error: "name_required" }); return; }
  try {
    const [row] = await db
      .insert(shopItemsTable)
      .values({ name: name.trim(), emoji, price, imageUrl, color, category, sortOrder })
      .returning();
    res.status(201).json(row);
  } catch (err) {
    req.log.error({ err }, "admin shop add error");
    res.status(500).json({ error: "internal" });
  }
});

// PUT /api/game/admin/shop/update/:itemId
router.put("/game/admin/shop/update/:itemId", async (req: Request, res: Response) => {
  if (!isAdmin(req)) { res.status(403).json({ error: "forbidden" }); return; }
  const id = parseInt(req.params.itemId ?? "0", 10);
  if (!id) { res.status(400).json({ error: "invalid_id" }); return; }
  const { name, emoji, price, imageUrl, color, category, sortOrder, isActive } = req.body as Partial<{
    name: string; emoji: string; price: number; imageUrl: string;
    color: string; category: string; sortOrder: number; isActive: boolean;
  }>;
  const patch: Record<string, unknown> = {};
  if (name      !== undefined) patch.name      = name;
  if (emoji     !== undefined) patch.emoji     = emoji;
  if (price     !== undefined) patch.price     = price;
  if (imageUrl  !== undefined) patch.imageUrl  = imageUrl;
  if (color     !== undefined) patch.color     = color;
  if (category  !== undefined) patch.category  = category;
  if (sortOrder !== undefined) patch.sortOrder = sortOrder;
  if (isActive  !== undefined) patch.isActive  = isActive;
  if (Object.keys(patch).length === 0) { res.status(400).json({ error: "no_fields" }); return; }
  try {
    const [row] = await db
      .update(shopItemsTable)
      .set(patch)
      .where(eq(shopItemsTable.id, id))
      .returning();
    if (!row) { res.status(404).json({ error: "not_found" }); return; }
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "admin shop update error");
    res.status(500).json({ error: "internal" });
  }
});

// DELETE /api/game/admin/shop/delete/:itemId
router.delete("/game/admin/shop/delete/:itemId", async (req: Request, res: Response) => {
  if (!isAdmin(req)) { res.status(403).json({ error: "forbidden" }); return; }
  const id = parseInt(req.params.itemId ?? "0", 10);
  if (!id) { res.status(400).json({ error: "invalid_id" }); return; }
  try {
    await db.delete(shopItemsTable).where(eq(shopItemsTable.id, id));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "admin shop delete error");
    res.status(500).json({ error: "internal" });
  }
});

export default router;
