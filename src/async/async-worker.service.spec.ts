import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AsyncWorkerService } from './async-worker.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from './notification.service';

describe('Notification polling recovery', () => {
  it('contains a database outage and resumes polling without publishing a false heartbeat', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const query = jest
      .fn()
      .mockRejectedValueOnce(new Error('private database details'))
      .mockResolvedValue([]);
    const heartbeat = jest.fn().mockResolvedValue('OK');
    const worker = new AsyncWorkerService(
      new ConfigService(),
      { $queryRaw: query } as unknown as PrismaService,
      {} as NotificationService,
    );
    Object.assign(worker, { queue: {}, queueRedis: { set: heartbeat } });
    try {
      await expect(worker.dispatchOnce()).resolves.toBeUndefined();
      expect(heartbeat).not.toHaveBeenCalled();
      await expect(worker.dispatchOnce()).resolves.toBeUndefined();
      expect(heartbeat).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('Notification polling failed; next poll will retry');
    } finally {
      warn.mockRestore();
    }
  });
});
