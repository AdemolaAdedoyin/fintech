import { NestFactory } from '@nestjs/core';
import { AsyncWorkerModule } from './async/async-worker.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AsyncWorkerModule);
  app.enableShutdownHooks();
}

void bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown worker startup error';
  process.stderr.write(`Worker failed to start: ${message}\n`);
  process.exitCode = 1;
});
