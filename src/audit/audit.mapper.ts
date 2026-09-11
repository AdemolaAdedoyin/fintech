import type { AuditLog } from '@prisma/client';

export function toAuditLogResponse(entry: AuditLog) {
  return {
    id: entry.id,
    action: entry.action,
    transferId: entry.transferId,
    reversalId: entry.reversalId,
    createdAt: entry.createdAt,
  };
}
