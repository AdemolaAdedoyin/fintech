import { ConfigService } from '@nestjs/config';
import { WebhookSigningService } from './webhook-signing.service';

describe('WebhookSigningService', () => {
  const endpointId = 'c615bf3d-3642-4bba-8a82-9712db3d5b66';
  const timestamp = '1789160000';
  const rawBody = JSON.stringify({ id: 'event-1', type: 'TRANSFER_COMPLETED' });

  const createService = () =>
    new WebhookSigningService(
      new ConfigService({
        WEBHOOK_SIGNING_MASTER_SECRET:
          'unit-test-webhook-signing-master-secret-that-is-long-enough',
      }),
    );

  it('derives a stable endpoint-specific signing secret', () => {
    const service = createService();

    expect(service.deriveEndpointSecret(endpointId)).toBe(service.deriveEndpointSecret(endpointId));
    expect(service.deriveEndpointSecret(endpointId)).not.toBe(
      service.deriveEndpointSecret('ad8deef3-88b1-4bf0-ad9d-7de3327a3efa'),
    );
  });

  it('verifies the exact timestamp and raw request body', () => {
    const service = createService();
    const signature = service.sign(endpointId, timestamp, rawBody);

    expect(service.verify(endpointId, timestamp, rawBody, signature)).toBe(true);
    expect(service.verify(endpointId, timestamp, `${rawBody} `, signature)).toBe(false);
    expect(service.verify(endpointId, '1789160001', rawBody, signature)).toBe(false);
  });
});
