import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

export const gameProfilesTable = pgTable("game_profiles", {
  firebaseUid:    text("firebase_uid").primaryKey(),
  gamePoints:     integer("game_points").notNull().default(0),
  gameCash:       integer("game_cash").notNull().default(0),
  unlockedSkins:  text("unlocked_skins").array().notNull().default([]),
  activeSkin:     text("active_skin").notNull().default(""),
  magnetLevel:    integer("magnet_level").notNull().default(1),
  comboLevel:     integer("combo_level").notNull().default(1),
  updatedAt:      timestamp("updated_at").defaultNow(),
});

export type GameProfile    = typeof gameProfilesTable.$inferSelect;
export type NewGameProfile = typeof gameProfilesTable.$inferInsert;
