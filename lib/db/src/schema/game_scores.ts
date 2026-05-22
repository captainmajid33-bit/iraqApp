import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";

export const gameScoresTable = pgTable("game_scores", {
  id:        serial("id").primaryKey(),
  userId:    text("user_id").notNull(),
  userName:  text("user_name").notNull().default("لاعب"),
  score:     integer("score").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export type GameScore = typeof gameScoresTable.$inferSelect;
export type NewGameScore = typeof gameScoresTable.$inferInsert;
