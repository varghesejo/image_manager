import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "device_mount" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "libraryId" uuid NOT NULL,
  "volumeId" character varying NOT NULL,
  "identityMethod" character varying NOT NULL,
  "identityConfidence" character varying NOT NULL,
  "lastKnownPath" character varying NOT NULL,
  "pendingPath" character varying,
  "lastSeenAt" timestamp with time zone NOT NULL,
  "assetCount" integer,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "device_mount_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "library" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "UQ_device_mount_volumeId" UNIQUE ("volumeId"),
  CONSTRAINT "device_mount_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "device_mount_libraryId_idx" ON "device_mount" ("libraryId");`.execute(db);
  await sql`CREATE OR REPLACE TRIGGER "device_mount_updatedAt"
  BEFORE UPDATE ON "device_mount"
  FOR EACH ROW
  EXECUTE FUNCTION updated_at();`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_device_mount_updatedAt', '{"type":"trigger","name":"device_mount_updatedAt","sql":"CREATE OR REPLACE TRIGGER \\"device_mount_updatedAt\\"\\n  BEFORE UPDATE ON \\"device_mount\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION updated_at();"}'::jsonb);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TRIGGER "device_mount_updatedAt" ON "device_mount";`.execute(db);
  await sql`DROP TABLE "device_mount";`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_device_mount_updatedAt';`.execute(db);
}
