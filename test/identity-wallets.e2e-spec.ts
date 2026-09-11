import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Currency, WalletStatus } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

interface WalletBody {
  id: string;
  currency: Currency;
  status: WalletStatus;
  currentBalanceMinor: string;
}

interface AuthBody {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  };
  initialWallet?: WalletBody;
}

describe('Identity and wallets (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL ??=
      'postgresql://fintech:fintech_dev@localhost:5432/fintech?schema=public';
    process.env.JWT_ACCESS_SECRET =
      'phase-two-e2e-secret-that-is-longer-than-thirty-two-characters';
    process.env.JWT_ACCESS_TTL_SECONDS = '900';
    process.env.CORS_ORIGIN = 'http://localhost:3000';
    process.env.LOG_LEVEL = 'silent';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();

    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.wallet.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => {
    await app.close();
  });

  async function register(email: string, currency: Currency = Currency.USD) {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email,
        password: 'correct-horse-battery-staple',
        firstName: 'Alex',
        lastName: 'Morgan',
        currency,
      })
      .expect(HttpStatus.CREATED);

    return response.body as AuthBody;
  }

  it('registers a user and initial zero-balance wallet atomically', async () => {
    const body = await register('  ALEX@example.com  ');

    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.tokenType).toBe('Bearer');
    expect(body.expiresIn).toBe(900);
    expect(body.user.email).toBe('alex@example.com');
    expect(body.initialWallet).toEqual(
      expect.objectContaining({
        currency: Currency.USD,
        status: WalletStatus.ACTIVE,
        currentBalanceMinor: '0',
      }),
    );
    expect(JSON.stringify(body)).not.toContain('passwordHash');

    const user = await prisma.user.findUnique({ where: { email: 'alex@example.com' } });
    expect(user?.passwordHash).toMatch(/^scrypt\$/);
    expect(user?.passwordHash).not.toBe('correct-horse-battery-staple');
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.wallet.count()).toBe(1);
  });

  it('enforces canonical unique email identity and strict input validation', async () => {
    await register('alex@example.com');

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: 'ALEX@EXAMPLE.COM',
        password: 'another-secure-password',
        firstName: 'Other',
        lastName: 'Person',
      })
      .expect(HttpStatus.CONFLICT);

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({
        email: 'new@example.com',
        password: 'another-secure-password',
        firstName: 'Other',
        lastName: 'Person',
        role: 'admin',
      })
      .expect(HttpStatus.BAD_REQUEST);
  });

  it('authenticates with a short-lived bearer token and returns the current profile', async () => {
    await register('alex@example.com');

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'alex@example.com', password: 'wrong-password' })
      .expect(HttpStatus.UNAUTHORIZED);

    const loginResponse = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 'ALEX@example.com', password: 'correct-horse-battery-staple' })
      .expect(HttpStatus.OK);
    const loginBody = loginResponse.body as AuthBody;

    const profileResponse = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(HttpStatus.OK);

    expect(profileResponse.body).toEqual(
      expect.objectContaining({
        id: loginBody.user.id,
        email: 'alex@example.com',
        firstName: 'Alex',
        lastName: 'Morgan',
      }),
    );
  });

  it('scopes wallet access to the authenticated owner', async () => {
    const alice = await register('alice@example.com');
    const bob = await register('bob@example.com');
    const aliceWallet = alice.initialWallet;

    expect(aliceWallet).toBeDefined();

    await request(app.getHttpServer())
      .get(`/api/v1/wallets/${aliceWallet!.id}`)
      .set('Authorization', `Bearer ${bob.accessToken}`)
      .expect(HttpStatus.NOT_FOUND);

    await request(app.getHttpServer())
      .get(`/api/v1/wallets/${aliceWallet!.id}`)
      .set('Authorization', `Bearer ${alice.accessToken}`)
      .expect(HttpStatus.OK);
  });

  it('supports one wallet per currency and an explicit zero-balance close lifecycle', async () => {
    const account = await register('alex@example.com');

    const createdResponse = await request(app.getHttpServer())
      .post('/api/v1/wallets')
      .set('Authorization', `Bearer ${account.accessToken}`)
      .send({ currency: Currency.NGN })
      .expect(HttpStatus.CREATED);
    const ngnWallet = createdResponse.body as WalletBody;

    expect(ngnWallet.currentBalanceMinor).toBe('0');

    await request(app.getHttpServer())
      .post('/api/v1/wallets')
      .set('Authorization', `Bearer ${account.accessToken}`)
      .send({ currency: Currency.NGN })
      .expect(HttpStatus.CONFLICT);

    await prisma.wallet.update({
      where: { id: ngnWallet.id },
      data: { currentBalanceMinor: 1n },
    });

    await request(app.getHttpServer())
      .post(`/api/v1/wallets/${ngnWallet.id}/close`)
      .set('Authorization', `Bearer ${account.accessToken}`)
      .expect(HttpStatus.CONFLICT);

    await prisma.wallet.update({
      where: { id: ngnWallet.id },
      data: { currentBalanceMinor: 0n },
    });

    const closeResponse = await request(app.getHttpServer())
      .post(`/api/v1/wallets/${ngnWallet.id}/close`)
      .set('Authorization', `Bearer ${account.accessToken}`)
      .expect(HttpStatus.OK);

    expect((closeResponse.body as WalletBody).status).toBe(WalletStatus.CLOSED);

    const listResponse = await request(app.getHttpServer())
      .get('/api/v1/wallets')
      .set('Authorization', `Bearer ${account.accessToken}`)
      .expect(HttpStatus.OK);
    const wallets = listResponse.body as WalletBody[];

    expect(wallets).toHaveLength(2);
    expect(wallets.find((wallet) => wallet.id === ngnWallet.id)?.status).toBe(WalletStatus.CLOSED);
  });
});

const HttpStatus = {
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  CONFLICT: 409,
} as const;
