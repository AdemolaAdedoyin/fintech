import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { AuthenticatedRequest, AccessTokenPayload } from './auth.types';
import { UsersService } from '../users/users.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly usersService: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractBearerToken(request);

    try {
      const payload = await this.jwtService.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        algorithms: ['HS256'],
      });

      if (payload.type !== 'access' || !payload.sub) {
        throw new UnauthorizedException('Invalid access token');
      }

      const user = await this.usersService.findSafeById(payload.sub);
      if (!user) {
        throw new UnauthorizedException('Invalid access token');
      }

      request.user = {
        id: user.id,
        email: user.email,
      };

      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      throw new UnauthorizedException('Invalid or expired access token');
    }
  }

  private extractBearerToken(request: AuthenticatedRequest): string {
    const authorization = request.headers.authorization;
    if (!authorization) {
      throw new UnauthorizedException('Bearer access token is required');
    }

    const parts = authorization.trim().split(/\s+/);
    if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer' || !parts[1]) {
      throw new UnauthorizedException('Bearer access token is required');
    }

    return parts[1];
  }
}
