import { BadRequestException, Injectable } from '@nestjs/common';
import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';

interface ResolvedWebhookTarget {
  address: string;
  family: 4 | 6;
}

interface WebhookPostInput {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

@Injectable()
export class WebhookTargetService {
  normalizeAndValidateUrl(value: string): string {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BadRequestException('Webhook URL must be a valid absolute HTTPS URL');
    }

    if (url.protocol !== 'https:') {
      throw new BadRequestException('Webhook URL must use HTTPS');
    }

    if (url.username || url.password) {
      throw new BadRequestException('Webhook URL must not include credentials');
    }

    if (url.hash) {
      throw new BadRequestException('Webhook URL must not include a fragment');
    }

    const hostname = this.normalizeHostname(url.hostname);
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal')
    ) {
      throw new BadRequestException('Webhook URL must use a public hostname');
    }

    const family = isIP(hostname);
    if (family !== 0 && !this.isPublicAddress(hostname, family)) {
      throw new BadRequestException('Webhook URL must not target a non-public IP address');
    }

    return url.toString();
  }

  async post(input: WebhookPostInput): Promise<number> {
    const normalizedUrl = this.normalizeAndValidateUrl(input.url);
    const url = new URL(normalizedUrl);
    const hostname = this.normalizeHostname(url.hostname);
    const target = await this.resolvePublicTarget(hostname);

    return new Promise<number>((resolve, reject) => {
      const req = request(
        url,
        {
          method: 'POST',
          headers: input.headers,
          servername: hostname,
          lookup: (_requestedHostname, _options, callback) => {
            callback(null, target.address, target.family);
          },
        },
        (response) => {
          const statusCode = response.statusCode ?? 0;
          response.resume();
          response.once('end', () => resolve(statusCode));
        },
      );

      const timeout = setTimeout(() => {
        req.destroy(new Error(`Webhook request timed out after ${input.timeoutMs}ms`));
      }, input.timeoutMs);
      timeout.unref();

      req.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      req.once('close', () => clearTimeout(timeout));
      req.end(input.body);
    });
  }

  protected resolveAddresses(hostname: string): Promise<LookupAddress[]> {
    return lookup(hostname, { all: true, verbatim: true });
  }

  private async resolvePublicTarget(hostname: string): Promise<ResolvedWebhookTarget> {
    const literalFamily = isIP(hostname);
    if (literalFamily === 4 || literalFamily === 6) {
      if (!this.isPublicAddress(hostname, literalFamily)) {
        throw new Error('Webhook target is not a public IP address');
      }

      return { address: hostname, family: literalFamily };
    }

    const addresses = await this.resolveAddresses(hostname);
    if (addresses.length === 0) {
      throw new Error('Webhook target hostname did not resolve');
    }

    for (const address of addresses) {
      if (
        (address.family !== 4 && address.family !== 6) ||
        !this.isPublicAddress(address.address, address.family)
      ) {
        throw new Error('Webhook target hostname resolved to a non-public IP address');
      }
    }

    const selected = addresses[0];
    if (selected.family !== 4 && selected.family !== 6) {
      throw new Error('Webhook target hostname resolved to an unsupported address family');
    }

    return { address: selected.address, family: selected.family };
  }

  private normalizeHostname(hostname: string): string {
    return hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  }

  private isPublicAddress(address: string, family: number): boolean {
    if (family === 4) {
      const octets = address.split('.').map(Number);
      if (
        octets.length !== 4 ||
        octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
      ) {
        return false;
      }

      const [a, b, c] = octets;
      return !(
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 0 && c === 0) ||
        (a === 192 && b === 0 && c === 2) ||
        (a === 192 && b === 88 && c === 99) ||
        (a === 192 && b === 168) ||
        (a === 198 && (b === 18 || b === 19)) ||
        (a === 198 && b === 51 && c === 100) ||
        (a === 203 && b === 0 && c === 113) ||
        a >= 224
      );
    }

    if (family === 6) {
      const normalized = address.toLowerCase();
      if (normalized.startsWith('::ffff:')) return false;
      if (normalized.startsWith('2001:db8:') || normalized === '2001:db8::') return false;

      // Current globally routable unicast IPv6 space is 2000::/3. Restricting
      // callbacks to that range is intentionally conservative for an outbound webhook target.
      return normalized.startsWith('2') || normalized.startsWith('3');
    }

    return false;
  }
}
