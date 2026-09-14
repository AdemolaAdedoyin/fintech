import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import type { RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { EventEmitter } from 'node:events';
import { isPublicIPv4, WebhookTransportService } from './webhook-transport.service';

jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));
jest.mock('node:https', () => ({ request: jest.fn() }));
const dns = lookup as unknown as jest.MockedFunction<
  (hostname: string, options: { all: true }) => Promise<{ address: string; family: number }[]>
>;
const https = jest.mocked(request);
const transport = new WebhookTransportService();

describe('Webhook transport', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });
  afterEach(() => {
    jest.useRealTimers();
  });
  it.each([
    'http://example.com',
    'https://user:pass@example.com',
    'https://example.com/#secret',
    'https://example.com:444',
    'https://127.0.0.1',
    'https://2130706433',
    'https://[::1]',
    'https://localhost',
    'https://example.com./',
    'not a url',
  ])('rejects unsafe URL %s', (url) => {
    expect(() => transport.parse(url)).toThrow('UNSAFE_ENDPOINT');
  });
  it.each([
    '0.1.2.3',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '192.0.0.1',
    '192.0.2.1',
    '192.88.99.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '::1',
    '::ffff:127.0.0.1',
  ])('blocks IP %s', (ip) => {
    expect(isPublicIPv4(ip)).toBe(false);
  });
  it('accepts a public IPv4 endpoint and rejects mixed or empty DNS answers', async () => {
    dns.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]);
    await expect(transport.validate('https://example.com/events')).resolves.toBeUndefined();
    dns.mockResolvedValueOnce([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]);
    await expect(transport.validate('https://example.com')).rejects.toThrow('UNSAFE_ENDPOINT');
    dns.mockResolvedValueOnce([]);
    await expect(transport.validate('https://example.com')).rejects.toThrow('UNSAFE_ENDPOINT');
  });
  it('pins the checked address, keeps the TLS hostname, and does not follow redirects or buffer bodies', async () => {
    dns.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]);
    const destroy = jest.fn();
    let captured: RequestOptions | undefined;
    let capturedUrl: URL | undefined;
    const end = jest.fn();
    https.mockImplementation((...args: unknown[]) => {
      capturedUrl = args[0] as URL;
      captured = args[1] as RequestOptions;
      const callback = args[2] as (response: IncomingMessage) => void;
      const req = new EventEmitter() as ClientRequest;
      req.end = end.mockImplementation(() => {
        callback({ statusCode: 302, destroy } as unknown as IncomingMessage);
        return req;
      });
      return req;
    });
    expect(await transport.send('https://example.com/events', '€', {})).toBe(302);
    expect(capturedUrl?.hostname).toBe('example.com');
    expect(captured?.agent).toBe(false);
    expect(captured?.family).toBe(4);
    const resolved = jest.fn();
    captured!.lookup!('example.com', {}, resolved);
    expect(resolved).toHaveBeenCalledWith(null, '8.8.8.8', 4);
    expect(captured?.headers).toEqual(expect.objectContaining({ 'Content-Length': '3' }));
    expect(https).toHaveBeenCalledTimes(1);
    expect(dns).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledWith('€');
  });
  it('does not start a connection when DNS returns after the deadline', async () => {
    jest.useFakeTimers();
    let finish!: (value: { address: string; family: number }[]) => void;
    dns.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = expect(transport.send('https://example.com', '{}', {})).rejects.toThrow(
      'TIMEOUT',
    );
    await jest.advanceTimersByTimeAsync(5001);
    await pending;
    finish([{ address: '8.8.8.8', family: 4 }]);
    await jest.advanceTimersByTimeAsync(1);
    expect(https).not.toHaveBeenCalled();
  });
  it('normalizes DNS errors without exposing URL or resolver details', async () => {
    dns.mockRejectedValue(new Error('sensitive resolver message'));
    await expect(transport.send('https://example.com', '{}', {})).rejects.toThrow('NETWORK_ERROR');
  });
});
