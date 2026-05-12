import { pgTable, serial, text, real, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const locationsTable = pgTable("locations", {
  id:          serial("id").primaryKey(),
  category:    text("category").notNull().default("clinic"),
  name:        text("name").notNull(),
  details:     text("details").notNull().default(""),
  address:     text("address").notNull().default(""),
  phone:       text("phone").notNull().default(""),
  hours:       text("hours").notNull().default(""),
  status:      text("status").notNull().default("مفتوح"),
  rating:      integer("rating"),
  merchantKey: text("merchant_key"),   // per-merchant auth key (admin-managed, never public)
  lat:         real("lat").notNull(),
  lng:         real("lng").notNull(),
  createdAt:   timestamp("created_at").defaultNow(),
});

// Public insert schema — excludes merchantKey (admin sets it via dedicated endpoint)
export const insertLocationSchema = createInsertSchema(locationsTable).omit({
  id:          true,
  createdAt:   true,
  merchantKey: true,
});
export const selectLocationSchema = createSelectSchema(locationsTable);

export type InsertLocation = z.infer<typeof insertLocationSchema>;
export type LocationDB     = typeof locationsTable.$inferSelect;
