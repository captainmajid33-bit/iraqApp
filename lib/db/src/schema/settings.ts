import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const settingsTable = pgTable("settings", {
  key:       text("key").primaryKey(),
  value:     text("value").notNull().default(""),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type Setting = typeof settingsTable.$inferSelect;
