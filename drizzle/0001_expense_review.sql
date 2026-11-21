ALTER TABLE entries ADD COLUMN review_day TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE entries ADD COLUMN review_ref TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE entries ADD COLUMN reviewed_by TEXT NOT NULL DEFAULT '';
