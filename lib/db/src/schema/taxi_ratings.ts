import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { ordersTable } from "./orders";

export const taxiRatingsTable = pgTable("taxi_ratings", {
  id:          serial("id").primaryKey(),
  orderId:     integer("order_id").notNull().references(() => ordersTable.id, { onDelete: "cascade" }),
  driverId:    integer("driver_id").notNull(),
  customerName: text("customer_name"),
  ratingStars: integer("rating_stars").notNull(),
  notes:       text("notes"),
  createdAt:   timestamp("created_at").defaultNow(),
});

export const insertTaxiRatingSchema = createInsertSchema(taxiRatingsTable).omit({
  id:        true,
  createdAt: true,
}).extend({
  ratingStars: z.number().int().min(1).max(5),
});

export type InsertTaxiRating = z.infer<typeof insertTaxiRatingSchema>;
export type TaxiRatingDB     = typeof taxiRatingsTable.$inferSelect;
