import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { toAuditLogResponse } from './audit.mapper';
import type { ListAuditDto } from './dto/list-audit.dto';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async findAllForUser(actorUserId: string, query: ListAuditDto) {
    if (query.cursor) {
      const cursor = await this.prisma.auditLog.findFirst({
        where: { id: query.cursor, actorUserId },
        select: { id: true },
      });

      if (!cursor) {
        throw new BadRequestException('Audit cursor is invalid for the authenticated user');
      }
    }

    const entries = await this.prisma.auditLog.findMany({
      where: { actorUserId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    });

    const hasMore = entries.length > query.limit;
    const page = hasMore ? entries.slice(0, query.limit) : entries;

    return {
      items: page.map(toAuditLogResponse),
      nextCursor: hasMore ? page.at(-1)?.id : null,
    };
  }
}
