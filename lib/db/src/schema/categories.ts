import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const categoriesTable = pgTable("categories", {
  id:        serial("id").primaryKey(),
  slug:      text("slug").notNull().unique(),
  labelAr:   text("label_ar").notNull(),
  labelEn:   text("label_en").notNull(),
  color:     text("color").notNull().default("#00f5d4"),
  icon:      text("icon").notNull().default("📍"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertCategorySchema = createInsertSchema(categoriesTable).omit({ id: true, createdAt: true });
export type InsertCategory = z.infer<typeof insertCategorySchema>;
export type CategoryDB = typeof categoriesTable.$inferSelect;
