ALTER TABLE `grants` ADD `created_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `grants` ADD `label` text;--> statement-breakpoint
ALTER TABLE `grants` ADD `requests` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `grants` ADD `last_used_at` integer;