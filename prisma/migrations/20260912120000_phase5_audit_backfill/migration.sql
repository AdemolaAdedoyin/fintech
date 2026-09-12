-- Phase 5 introduced AuditLog after transfers already existed. Backfill the
-- creation event so audit completeness does not depend on deployment timing.
SELECT set_config('app.audit_write', 'on', true);

INSERT INTO "AuditLog" (
  "id",
  "actorUserId",
  "action",
  "transferId",
  "reversalId",
  "createdAt"
)
SELECT
  md5('audit:transfer-created:' || transfer."id"::text)::uuid,
  transfer."senderUserId",
  'TRANSFER_CREATED'::"AuditAction",
  transfer."id",
  NULL,
  transfer."createdAt"
FROM "Transfer" transfer
WHERE NOT EXISTS (
  SELECT 1
  FROM "AuditLog" audit
  WHERE audit."action" = 'TRANSFER_CREATED'
    AND audit."transferId" = transfer."id"
);
