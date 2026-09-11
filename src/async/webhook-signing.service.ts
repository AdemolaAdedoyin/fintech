import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

@Injectable()
export class WebhookSigningService {
  constructor(private readonly config: ConfigService) {}

  deriveEndpointSecret(endpointId: string): string {
    const masterSecret = this.config.getOrThrow<string>('WEBHOOK_SIGNING_MASTER_SECRET');
    return createHmac('sha256', masterSecret)
      .update(`webhook-endpoint:${endpointId}`)
      .digest('base64url');
  }

  sign(endpointId: string, timestamp: string, rawBody: string): string {
    const endpointSecret = this.deriveEndpointSecret(endpointId);
    const digest = createHmac('sha256', endpointSecret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');

    return `v1=${digest}`;
  }

  verify(endpointId: string, timestamp: string, rawBody: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(endpointId, timestamp, rawBody));
    const actual = Buffer.from(signature);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}
