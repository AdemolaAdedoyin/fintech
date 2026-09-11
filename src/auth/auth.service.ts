import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import { PasswordService } from './password.service';
import { JWT_AUDIENCE, JWT_ISSUER } from './auth.constants';
import type { AccessTokenPayload } from './auth.types';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';
import { UsersService, type SafeUser } from '../users/users.service';
import { toWalletResponse } from '../wallets/wallet.mapper';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly passwordService: PasswordService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  async register(input: RegisterDto) {
    const email = this.usersService.normalizeEmail(input.email);
    const existing = await this.usersService.findByEmailWithPassword(email);

    if (existing) {
      throw new ConflictException('An account with this email already exists');
    }

    const passwordHash = await this.passwordService.hash(input.password);

    try {
      const created = await this.usersService.createWithInitialWallet({
        email,
        passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
        currency: input.currency,
      });

      return {
        ...(await this.issueAccessToken(created.user)),
        user: created.user,
        initialWallet: toWalletResponse(created.wallet),
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('An account with this email already exists');
      }

      throw error;
    }
  }

  async login(input: LoginDto) {
    const user = await this.usersService.findByEmailWithPassword(input.email);
    const validPassword = await this.passwordService.verifyOrBurn(
      input.password,
      user?.passwordHash,
    );

    if (!user || !validPassword) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const safeUser: SafeUser = {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };

    return {
      ...(await this.issueAccessToken(safeUser)),
      user: safeUser,
    };
  }

  async getProfile(userId: string): Promise<SafeUser> {
    const user = await this.usersService.findSafeById(userId);
    if (!user) {
      throw new UnauthorizedException('Authenticated user no longer exists');
    }

    return user;
  }

  private async issueAccessToken(user: SafeUser) {
    const expiresIn = this.config.getOrThrow<number>('JWT_ACCESS_TTL_SECONDS');
    const payload: AccessTokenPayload = {
      sub: user.id,
      email: user.email,
      type: 'access',
    };

    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      algorithm: 'HS256',
      expiresIn,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });

    return {
      accessToken,
      tokenType: 'Bearer' as const,
      expiresIn,
    };
  }
}
