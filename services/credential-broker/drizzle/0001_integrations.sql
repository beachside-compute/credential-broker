CREATE TABLE `integrations` (
	`identity` text PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`enabled` integer NOT NULL,
	`credential` text NOT NULL,
	`credential_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integrations_id_unique` ON `integrations` (`id`);--> statement-breakpoint
CREATE TABLE `issuer_integrations` (
	`identity` text PRIMARY KEY NOT NULL,
	FOREIGN KEY (`identity`) REFERENCES `integrations`(`identity`) ON UPDATE no action ON DELETE cascade
);
