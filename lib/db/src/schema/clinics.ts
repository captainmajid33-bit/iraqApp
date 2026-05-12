import { pgTable, serial, text, real, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const clinicsTable = pgTable("clinics_db", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  doctor: text("doctor").notNull().default(""),
  specialty: text("specialty").notNull().default(""),
  address: text("address").notNull().default(""),
  phone: text("phone").notNull().default(""),
  hours: text("hours").notNull().default(""),
  status: text("status").notNull().default("مفتوح"),
  lat: real("lat").notNull(),
  lng: real("lng").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertClinicSchema = createInsertSchema(clinicsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertClinic = z.infer<typeof insertClinicSchema>;
export type ClinicDB = typeof clinicsTable.$inferSelect;
