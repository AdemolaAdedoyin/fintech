import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { AuthController } from '../auth/auth.controller';
import { OperationalRedis } from './redis.service';

// Atomic increment and expiry; neither concurrency nor process restarts reset the window.
const increment = `local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], 60) end; return n`;
@Injectable()
export class AuthRateGuard implements CanActivate {
  constructor(
    private readonly redis: OperationalRedis,
    private readonly config: ConfigService,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    if (
      context.getClass() !== AuthController ||
      !['login', 'register'].includes(context.getHandler().name)
    )
      return true;
    // trust proxy is deliberately disabled; arbitrary forwarded headers cannot evade limits.
    const identity = createHash('sha256')
      .update(req.socket.remoteAddress ?? 'unknown')
      .digest('hex');
    let count: unknown;
    try {
      count = await this.redis.client.eval(increment, 1, `fintech:auth-rate:${identity}`);
    } catch {
      throw new ServiceUnavailableException('Authentication temporarily unavailable');
    }
    if (typeof count !== 'number')
      throw new ServiceUnavailableException('Authentication temporarily unavailable');
    if (count > this.config.getOrThrow<number>('AUTH_RATE_LIMIT')) {
      context.switchToHttp().getResponse<Response>().setHeader('Retry-After', '60');
      throw new HttpException('Too many authentication attempts; retry later', 429);
    }
    return true;
  }
}
