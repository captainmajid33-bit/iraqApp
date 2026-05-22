import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

export const gameCurrentSessionTable = pgTable("game_current_session", {
  id:         serial("id").primaryKey(),
  sessionId:  text("session_id").notNull().unique(),
  totalItems: integer("total_items").notNull().default(100),
  itemsLeft:  integer("items_left").notNull().default(100),
  itemType:   text("item_type").notNull().default("burger"),
  imageUrl:   text("image_url").notNull().default(""),
  isActive:   boolean("is_active").notNull().default(false),
  createdAt:  timestamp("created_at").defaultNow(),
  updatedAt:  timestamp("updated_at").defaultNow(),
});

export type GameCurrentSession    = typeof gameCurrentSessionTable.$inferSelect;
export type NewGameCurrentSession = typeof gameCurrentSessionTable.$inferInsert;
