import { Router, type IRouter, type Request, type Response } from "express";
import { db, settingsTable, gameScoresTable } from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";

const router: IRouter = Router();

// ── GET /api/game/config ────────────────────────────────────────────────────
// Returns current game config (character image, target image, duration)
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
// Admin updates character/target image URLs and duration
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
// Submit a score. Client sends { userId, userName, score }
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
    const [inserted] = await db
      .insert(gameScoresTable)
      .values({
        userId,
        userName: userName?.slice(0, 80) ?? "لاعب",
        score:    Math.floor(score),
      })
      .returning();

    res.status(201).json({ id: inserted.id, score: inserted.score });
  } catch (err) {
    req.log.error({ err }, "game score insert error");
    res.status(500).json({ error: "internal" });
  }
});

// ── GET /api/game/leaderboard ───────────────────────────────────────────────
// Returns top 20 players by best score (one entry per user)
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

export default router;
