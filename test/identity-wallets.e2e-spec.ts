import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Currency, WalletStatus } from '@prisma/client';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { LedgerService } from '../src/ledger/ledger.service';
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
  let httpServer: Server;
  let prisma: PrismaService;
  let ledger: LedgerService;

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const email = (label: string) => `${runId}-${label}@example.com`;
  const reference = (label: string) => `${runId}:${label}`;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL ??=
      'postgresql://fintech:fintech_dev@localhost:5432/fintech?schema=public';
    process.env.JWT_ACCESS_SECRET =
      'phase-three-e2e-secret-that-is-longer-than-thirty-two-characters';
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

    httpServer = app.getHttpServer() as Server;
    prisma = app.get(PrismaService);
    ledger = app.get(LedgerService);
  });

  afterAll(async () => {
    await app.close();
  });

  async function register(accountEmail: string, currency: Currency = Currency.USD) {
    const response = await request(httpServer)
      .post('/api/v1/auth/register')
      .send({
        email: accountEmail,
        password: 'correct-horse-battery-staple',
        firstName: 'Alex',
        lastName: 'Morgan',
        currency,
      })
      .expect(HttpStatus.CREATED);

    return response.body as AuthBody;
  }

  it('registers a user, ledger account, and initial zero-balance wallet atomically', async () => {
    const accountEmail = email('atomic');
    const body = await register(`  ${accountEmail.toUpperCase()}  `);

    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.tokenType).toBe('Bearer');
    expect(body.expiresIn).toBe(900);
    expect(body.user.email).toBe(accountEmail);
    expect(body.initialWallet).toEqual(
      expect.objectContaining({
        currency: Currency.USD,
        status: WalletStatus.ACTIVE,
        currentBalanceMinor: '0',
      }),
    );
    expect(JSON.stringify(body)).not.toContain('passwordHash');

    const user = await prisma.user.findUnique({ where: { email: accountEmail } });
    expect(user?.passwordHash).toMatch(/^scrypt\$/);
    expect(user?.passwordHash).not.toBe('correct-horse-battery-staple');
    expect(await prisma.wallet.count({ where: { userId: body.user.id } })).toBe(1);

    const wallet = await prisma.wallet.findFirstOrThrow({ where: { userId: body.user.id } });
    const ledgerAccount = await prisma.ledgerAccount.findUnique({
      where: { id: wallet.ledgerAccountId },
    });
    expect(ledgerAccount).toEqual(
      expect.objectContaining({
        currency: Currency.USD,
        balanceMinor: 0n,
      }),
    );

    await expect(prisma.user.delete({ where: { id: body.user.id } })).rejects.toThrow();
  });

  it('enforces canonical unique email identity and strict input validation', async () => {
    const accountEmail = email('canonical');
    await register(accountEmail);

    await request(httpServer)
      .post('/api/v1/auth/register')
      .send({
        email: accountEmail.toUpperCase(),
        password: 'another-secure-password',
        firstName: 'Other',
        lastName: 'Person',
      })
      .expect(HttpStatus.CONFLICT);

    await request(httpServer)
      .post('/api/v1/auth/register')
      .send({
        email: email('unknown-field'),
        password: 'another-secure-password',
        firstName: 'Other',
        lastName: 'Person',
        role: 'admin',
      })
      .expect(HttpStatus.BAD_REQUEST);

    await expect(
      prisma.user.create({
        data: {
          email: `UPPERCASE-${runId}@example.com`,
          passwordHash: 'not-used-by-this-constraint-test',
          firstName: 'Direct',
          lastName: 'Database',
        },
      }),
    ).rejects.toThrow();
  });

  it('authenticates with a short-lived bearer token and returns the current profile', async () => {
    const accountEmail = email('login');
    await register(accountEmail);

    await request(httpServer)
      .post('/api/v1/auth/login')
      .send({ email: accountEmail, password: 'wrong-password' })
      .expect(HttpStatus.UNAUTHORIZED);

    await request(httpServer)
      .post('/api/v1/auth/login')
      .send({ email: email('missing'), password: 'wrong-password' })
      .expect(HttpStatus.UNAUTHORIZED);

    const loginResponse = await request(httpServer)
      .post('/api/v1/auth/login')
      .send({ email: accountEmail.toUpperCase(), password: 'correct-horse-battery-staple' })
      .expect(HttpStatus.OK);
    const loginBody = loginResponse.body as AuthBody;

    const profileResponse = await request(httpServer)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${loginBody.accessToken}`)
      .expect(HttpStatus.OK);

    expect(profileResponse.body).toEqual(
      expect.objectContaining({
        id: loginBody.user.id,
        email: accountEmail,
        firstName: 'Alex',
        lastName: 'Morgan',
      }),
    );
  });

  it('scopes wallet access to the authenticated owner', async () => {
    const alice = await register(email('alice'));
    const bob = await register(email('bob'));
    const aliceWallet = alice.initialWallet;

    if (!aliceWallet) {
      throw new Error('Registration did not return an initial wallet');
    }

    await request(httpServer)
      .get(`/api/v1/wallets/${aliceWallet.id}`)
      .set('Authorization', `Bearer ${bob.accessToken}`)
      .expect(HttpStatus.NOT_FOUND);

    await request(httpServer)
      .get(`/api/v1/wallets/${aliceWallet.id}`)
      .set('Authorization', `Bearer ${alice.accessToken}`)
      .expect(HttpStatus.OK);
  });

  it('supports one wallet per currency and an explicit zero-balance close lifecycle', async () => {
    const account = await register(email('wallet-lifecycle'));

    const createdResponse = await request(httpServer)
      .post('/api/v1/wallets')
      .set('Authorization', `Bearer ${account.accessToken}`)
      .send({ currency: Currency.NGN })
      .expect(HttpStatus.CREATED);
    const ngnWallet = createdResponse.body as WalletBody;

    expect(ngnWallet.currentBalanceMinor).toBe('0');

    await request(httpServer)
      .post('/api/v1/wallets')
      .set('Authorization', `Bearer ${account.accessToken}`)
      .send({ currency: Currency.NGN })
      .expect(HttpStatus.CONFLICT);

    const storedWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: ngnWallet.id } });
    const clearing = await ledger.getExternalClearingAccount(Currency.NGN);

    await ledger.post({
      reference: reference('wallet-lifecycle-credit'),
      currency: Currency.NGN,
      postings: [
        { accountId: clearing.id, amountMinor: -1n },
        { accountId: storedWallet.ledgerAccountId, amountMinor: 1n },
      ],
    });

    await request(httpServer)
      .post(`/api/v1/wallets/${ngnWallet.id}/close`)
      .set('Authorization', `Bearer ${account.accessToken}`)
      .expect(HttpStatus.CONFLICT);

    await ledger.post({
      reference: reference('wallet-lifecycle-debit'),
      currency: Currency.NGN,
      postings: [
        { accountId: storedWallet.ledgerAccountId, amountMinor: -1n },
        { accountId: clearing.id, amountMinor: 1n },
      ],
    });

    const closeResponse = await request(httpServer)
      .post(`/api/v1/wallets/${ngnWallet.id}/close`)
      .set('Authorization', `Bearer ${account.accessToken}`)
      .expect(HttpStatus.OK);

    expect((closeResponse.body as WalletBody).status).toBe(WalletStatus.CLOSED);

    const listResponse = await request(httpServer)
      .get('/api/v1/wallets')
      .set('Authorization', `Bearer ${account.accessToken}`)
      .expect(HttpStatus.OK);
    const wallets = listResponse.body as WalletBody[];

    expect(wallets).toHaveLength(2);
    expect(wallets.find((wallet) => wallet.id === ngnWallet.id)?.status).toBe(WalletStatus.CLOSED);
  });
});
