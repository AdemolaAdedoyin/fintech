import { Injectable } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';

export class WebhookTransportError extends Error {
  constructor(public readonly code: 'UNSAFE_ENDPOINT' | 'TIMEOUT' | 'NETWORK_ERROR') {
    super(code);
  }
}

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4');

export function isPublicIPv4(address: string): boolean {
  return isIP(address) === 4 && !blocked.check(address, 'ipv4');
}

@Injectable()
export class WebhookTransportService {
  parse(raw: string): URL {
    try {
      const url = new URL(raw);
      if (
        raw.length > 2048 ||
        url.protocol !== 'https:' ||
        (url.port && url.port !== '443') ||
        url.username ||
        url.password ||
        url.hash ||
        isIP(url.hostname) ||
        !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(
          url.hostname,
        )
      ) {
        throw new Error();
      }
      return url;
    } catch {
      throw new WebhookTransportError('UNSAFE_ENDPOINT');
    }
  }

  private async resolve(url: URL): Promise<string> {
    const addresses = await lookup(url.hostname, { all: true });
    if (!addresses.length || addresses.some(({ address }) => !isPublicIPv4(address))) {
      throw new WebhookTransportError('UNSAFE_ENDPOINT');
    }
    return addresses[0].address;
  }

  async validate(raw: string): Promise<void> {
    const url = this.parse(raw);
    await this.withDeadline(async () => {
      await this.resolve(url);
    });
  }

  private async withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation(controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new WebhookTransportError('TIMEOUT'));
          }, 5000);
        }),
      ]);
    } catch (error) {
      if (controller.signal.aborted) throw new WebhookTransportError('TIMEOUT');
      if (error instanceof WebhookTransportError) throw error;
      throw new WebhookTransportError('NETWORK_ERROR');
    } finally {
      clearTimeout(timer);
    }
  }

  async send(raw: string, body: string, headers: Record<string, string>): Promise<number> {
    const url = this.parse(raw);
    return this.withDeadline(async (signal) => {
      const address = await this.resolve(url);
      if (signal.aborted) throw new WebhookTransportError('TIMEOUT');
      return new Promise<number>((resolve, reject) => {
        const req = request(
          url,
          {
            method: 'POST',
            agent: false,
            family: 4,
            signal,
            // Preserve hostname/SNI/certificate validation but pin the checked address.
            lookup: (_hostname, _options, callback) => callback(null, address, 4),
            headers: {
              ...headers,
              'Content-Type': 'application/json',
              'Content-Length': String(Buffer.byteLength(body)),
            },
          },
          (response) => {
            resolve(response.statusCode ?? 0);
            response.destroy();
          },
        );
        req.on('error', reject);
        req.end(body);
      });
    });
  }
}
