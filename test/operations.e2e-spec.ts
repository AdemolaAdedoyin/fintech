import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { OperationalRedis } from '../src/operations/redis.service';
import { PrismaService } from '../src/prisma/prisma.service';

const metricsToken = 'operational-metrics-test-token-at-least-32-characters';
describe('Operational security (e2e)', () => {
  let app: INestApplication, server: Server, config: ConfigService, redis: OperationalRedis;
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    config = app.get(ConfigService);
    config.set('METRICS_TOKEN', metricsToken);
    redis = app.get(OperationalRedis);
    await app.init();
    server = app.getHttpServer() as Server;
  });
  afterEach(() => {
    jest.restoreAllMocks();
    config.set('AUTH_RATE_LIMIT', 60);
  });
  afterAll(async () => {
    await app?.close();
  });
  it('includes both dependencies in readiness and keeps liveness independent', async () => {
    await request(server).get('/api/v1/health/ready').expect(200);
    jest.spyOn(redis.client, 'ping').mockRejectedValue(new Error('private redis URL'));
    const response = await request(server).get('/api/v1/health/ready').expect(503);
    expect(response.text).not.toContain('private redis URL');
    await request(server).get('/api/v1/health/live').expect(200);
  });
  it('rejects unauthenticated metrics before touching data', async () => {
    const count = jest.spyOn(app.get(PrismaService).payment, 'count');
    await request(server).get('/api/v1/health/metrics').expect(401);
    await request(server)
      .get('/api/v1/health/metrics')
      .auth('wrong', { type: 'bearer' })
      .expect(401);
    expect(count).not.toHaveBeenCalled();
    const response = await request(server)
      .get('/api/v1/health/metrics')
      .auth(metricsToken, { type: 'bearer' })
      .expect(200);
    expect(response.text).toContain('fintech_payment_pending');
    expect(response.text).not.toContain('email');
  });
  it('uses atomic Redis counters and ignores spoofed forwarded IPs', async () => {
    config.set('AUTH_RATE_LIMIT', 1);
    // Remove only this suite's auth counter before and after the assertion.
    const calls: string[] = [];
    const original = redis.client.eval.bind(redis.client);
    jest
      .spyOn(redis.client, 'eval')
      .mockImplementation((...args: Parameters<typeof redis.client.eval>) => {
        args[2] = `${String(args[2])}:operations-test`;
        calls.push(String(args[2]));
        return original(...args);
      });
    const first = await request(server)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', '198.51.100.1')
      .send({});
    expect(first.status).toBe(400);
    const second = await request(server)
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', '198.51.100.2')
      .send({});
    expect(second.status).toBe(429);
    expect(second.headers['retry-after']).toBe('60');
    expect(calls[0]).toBe(calls[1]);
    await redis.client.del(calls[0]);
  });
  it('fails authentication closed during limiter outage without affecting liveness', async () => {
    jest.spyOn(redis.client, 'eval').mockRejectedValue(new Error('private dependency error'));
    const response = await request(server).post('/api/v1/auth/login').send({}).expect(503);
    expect(response.text).not.toContain('private dependency error');
    await request(server).get('/api/v1/health/live').expect(200);
  });
});
