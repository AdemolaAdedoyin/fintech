export const DOMAIN_EVENTS_QUEUE = 'fintech-domain-events';
export const WEBHOOK_DELIVERY_QUEUE = 'fintech-webhook-delivery';

export const OUTBOX_DISPATCH_INTERVAL_MS = 1_000;
export const WEBHOOK_DISPATCH_INTERVAL_MS = 1_000;
export const WEBHOOK_PROCESSING_STALE_MS = 15 * 60 * 1_000;
