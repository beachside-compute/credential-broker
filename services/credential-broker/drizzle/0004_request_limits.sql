CREATE TABLE `grant_usage` (
	`grant_id` text NOT NULL,
	`identity` text NOT NULL,
	`window` integer NOT NULL,
	`count` integer NOT NULL,
	PRIMARY KEY(`grant_id`, `identity`),
	FOREIGN KEY (`grant_id`) REFERENCES `grants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
DROP INDEX `leases_grant`;--> statement-breakpoint
ALTER TABLE `leases` ADD `identity` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `leases` ADD `expires_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `leases_grant` ON `leases` (`grant_id`,`identity`);--> statement-breakpoint
ALTER TABLE `grants` DROP COLUMN `rate_window`;--> statement-breakpoint
ALTER TABLE `grants` DROP COLUMN `rate_count`;--> statement-breakpoint
DELETE FROM `leases`;