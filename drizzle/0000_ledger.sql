CREATE TABLE entries (
 id TEXT PRIMARY KEY, day TEXT NOT NULL, kind TEXT NOT NULL, category TEXT NOT NULL,
 title TEXT NOT NULL, amount INTEGER NOT NULL, voucher TEXT NOT NULL, note TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'draft', revision INTEGER NOT NULL DEFAULT 1,
 reason TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX entries_day ON entries(day,status);
--> statement-breakpoint
CREATE TABLE attachments (
 id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES entries(id), filename TEXT NOT NULL,
 mime TEXT NOT NULL, size INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE reports (
 month TEXT PRIMARY KEY, announcement TEXT NOT NULL, opening INTEGER NOT NULL,
 income INTEGER NOT NULL, expense INTEGER NOT NULL, published_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
