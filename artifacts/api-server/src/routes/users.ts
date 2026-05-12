import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { usersTable, insertUserSchema } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

const router: IRouter = Router();

// GET all users (sorted by XP desc)
router.get("/users", async (_req, res) => {
  try {
    const users = await db.select().from(usersTable).orderBy(desc(usersTable.xp));
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

// GET single user
router.get("/users/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    if (!user) return res.status(404).json({ error: "Not found" });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// POST create user
router.post("/users", async (req, res) => {
  try {
    const data = insertUserSchema.parse(req.body);
    const [user] = await db.insert(usersTable).values(data).returning();
    res.status(201).json(user);
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "Invalid data" });
  }
});

// PATCH update user (xp, balance, location)
router.patch("/users/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const data = insertUserSchema.partial().parse(req.body);
    const [user] = await db.update(usersTable).set(data).where(eq(usersTable.id, id)).returning();
    if (!user) return res.status(404).json({ error: "Not found" });
    res.json(user);
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "Invalid data" });
  }
});

// POST add XP to user
router.post("/users/:id/xp", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { amount } = req.body as { amount: number };
    if (typeof amount !== "number") return res.status(400).json({ error: "amount must be a number" });
    const [current] = await db.select().from(usersTable).where(eq(usersTable.id, id));
    if (!current) return res.status(404).json({ error: "Not found" });
    const [user] = await db.update(usersTable).set({ xp: current.xp + amount }).where(eq(usersTable.id, id)).returning();
    res.json(user);
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? "Failed" });
  }
});

// DELETE user
router.delete("/users/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    await db.delete(usersTable).where(eq(usersTable.id, id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete user" });
  }
});

export default router;
