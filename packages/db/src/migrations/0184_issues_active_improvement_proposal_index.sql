CREATE UNIQUE INDEX IF NOT EXISTS "issues_active_improvement_proposal_uq"
  ON "issues" USING btree ("company_id","origin_kind","origin_fingerprint")
  WHERE "origin_kind" = 'improvement_proposal'
    AND "origin_fingerprint" <> 'default'
    AND "hidden_at" IS NULL
    AND "status" NOT IN ('done', 'cancelled');
