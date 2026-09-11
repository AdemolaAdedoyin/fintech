import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { toAuditLogResponse } from './audit.mapper';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async findAllForUser(actorUserId: string) {
    const entries = await this.prisma.auditLog.findMany({
      where: { actorUserId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });

    return entries.map(toAuditLogResponse);
  }
}
