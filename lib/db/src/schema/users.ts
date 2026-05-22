import { pgTable, serial, text, real, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usersTable = pgTable("users", {
  id:          serial("id").primaryKey(),
  name:        text("name").notNull(),
  lat:         real("lat"),
  lng:         real("lng"),
  xp:          integer("xp").notNull().default(0),
  balance:     real("balance").notNull().default(0),
  firebaseUid: text("firebase_uid").unique(),
  createdAt:   timestamp("created_at").defaultNow(),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true,
  createdAt: true,
});
export const selectUserSchema = createSelectSchema(usersTable);

export type InsertUser = z.infer<typeof insertUserSchema>;
export type UserDB = typeof usersTable.$inferSelect;
