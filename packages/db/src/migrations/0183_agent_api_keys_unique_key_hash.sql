-- Duplicate key hashes can only exist where the same token was stored twice;
-- keep the oldest row so the credential keeps working, then enforce uniqueness
-- to match board_api_keys.
DELETE FROM "agent_api_keys" WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", row_number() OVER (
      PARTITION BY "key_hash" ORDER BY "created_at" ASC, "id" ASC
    ) AS "rn"
    FROM "agent_api_keys"
  ) "ranked" WHERE "rn" > 1
);
--> statement-breakpoint
DROP INDEX IF EXISTS "agent_api_keys_key_hash_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_api_keys_key_hash_uniq_idx" ON "agent_api_keys" ("key_hash");
