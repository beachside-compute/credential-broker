CREATE TABLE `grants` (
	`id` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`owner` text NOT NULL,
	`permissions` text NOT NULL,
	`expires_at` integer NOT NULL,
	`traceparent` text,
	`rate_window` integer DEFAULT 0 NOT NULL,
	`rate_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `grants_hash_unique` ON `grants` (`hash`);--> statement-breakpoint
CREATE INDEX `grants_expiration` ON `grants` (`expires_at`);--> statement-breakpoint
CREATE INDEX `grants_owner` ON `grants` (`owner`,`expires_at`);--> statement-breakpoint
CREATE TABLE `leases` (
	`id` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	FOREIGN KEY (`grant_id`) REFERENCES `grants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `leases_grant` ON `leases` (`grant_id`);