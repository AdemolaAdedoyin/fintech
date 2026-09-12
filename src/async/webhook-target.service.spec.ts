import type { LookupAddress } from 'node:dns';
import { WebhookTargetService } from './webhook-target.service';

class StubWebhookTargetService extends WebhookTargetService {
  constructor(private readonly addresses: LookupAddress[]) {
    super();
  }

  protected override resolveAddresses(_hostname: string): Promise<LookupAddress[]> {
    return Promise.resolve(this.addresses);
  }
}

describe('WebhookTargetService', () => {
  const service = new WebhookTargetService();

  it.each([
    'http://example.com/hook',
    'https://localhost/hook',
    'https://localhost./hook',
    'https://127.0.0.1/hook',
    'https://10.1.2.3/hook',
    'https://169.254.169.254/latest/meta-data',
    'https://192.168.1.4/hook',
    'https://[::1]/hook',
    'https://[fd00::1]/hook',
  ])('rejects unsafe callback URL %s', (url) => {
    expect(() => service.normalizeAndValidateUrl(url)).toThrow();
  });

  it('accepts a syntactically valid public HTTPS hostname', () => {
    expect(service.normalizeAndValidateUrl('https://hooks.example.com/events')).toBe(
      'https://hooks.example.com/events',
    );
  });

  it('rejects hostnames when DNS includes a private address', async () => {
    const target = new StubWebhookTargetService([
      { address: '203.0.113.10', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);

    await expect(
      target.post({
        url: 'https://hooks.example.com/events',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow('non-public IP address');
  });
});
