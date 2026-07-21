/**
 * Notification Service Tests
 *
 * Tests the notification providers and the NotificationService class.
 * Uses mocked fetch for webhook and email provider tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  ConsoleProvider,
  WebhookProvider,
  EmailProvider,
} from '../notification-providers.js';

import {
  NotificationService,
  createNotificationServiceFromEnv,
  type AlertEvent,
} from '../notification.js';

// =============================================================================
// Fixtures
// =============================================================================

const insufficientBalanceEvent: AlertEvent = {
  type: 'InsufficientBalance',
  vaultId: '0x1234567890abcdef',
  blobId: '12345',
  beneficiary: '0xbeneficiary',
  timestamp: Date.now(),
  required: 1000000n,
  available: 500000n,
};

const policyExhaustedEvent: AlertEvent = {
  type: 'PolicyExhausted',
  vaultId: '0x1234567890abcdef',
  blobId: '12345',
  beneficiary: '0xbeneficiary',
  timestamp: Date.now(),
  maxTotalEpochs: 365,
};

const renewalExecutedEvent: AlertEvent = {
  type: 'RenewalExecuted',
  vaultId: '0x1234567890abcdef',
  blobId: '12345',
  beneficiary: '0xbeneficiary',
  timestamp: Date.now(),
  actualCost: 500000n,
  keeperFeePaid: 1000n,
};

// =============================================================================
// ConsoleProvider
// =============================================================================

describe('ConsoleProvider', () => {
  const provider = new ConsoleProvider();

  it('should deliver successfully', async () => {
    const result = await provider.send(insufficientBalanceEvent, { channel: 'console' });
    expect(result.success).toBe(true);
    expect(result.provider).toBe('console');
  });

  it('should handle all event types', async () => {
    const events = [insufficientBalanceEvent, policyExhaustedEvent, renewalExecutedEvent];
    for (const event of events) {
      const result = await provider.send(event, { channel: 'console' });
      expect(result.success).toBe(true);
    }
  });
});

// =============================================================================
// WebhookProvider
// =============================================================================

describe('WebhookProvider', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should deliver successfully on 200 response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve('OK'),
    } as Response);

    const provider = new WebhookProvider({ url: 'https://hooks.example.com/alerts' });
    const result = await provider.send(insufficientBalanceEvent, { channel: 'webhook' });
    expect(result.success).toBe(true);
    expect(result.provider).toBe('webhook');

    // Verify fetch was called with correct payload
    expect(fetch).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(fetch).mock.calls[0];
    expect(callArgs[0]).toBe('https://hooks.example.com/alerts');
    expect((callArgs[1] as RequestInit).method).toBe('POST');
    const body = JSON.parse((callArgs[1] as RequestInit).body as string);
    expect(body.event).toBe('InsufficientBalance');
    expect(body.vaultId).toBe(insufficientBalanceEvent.vaultId);
  });

  it('should retry on failure', async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error('Network error'))
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve('OK'),
      } as Response);

    const provider = new WebhookProvider({ url: 'https://hooks.example.com/alerts', maxRetries: 3 });
    const result = await provider.send(insufficientBalanceEvent, { channel: 'webhook' });
    expect(result.success).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('should fail after exhausting retries', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

    const provider = new WebhookProvider({ url: 'https://hooks.example.com/alerts', maxRetries: 2 });
    const result = await provider.send(insufficientBalanceEvent, { channel: 'webhook' });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('should fail without a URL', async () => {
    const provider = new WebhookProvider({ url: '' });
    const result = await provider.send(insufficientBalanceEvent, { channel: 'webhook' });
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('No webhook URL configured');
  });

  it('should include HMAC signature when secret is configured', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve('OK'),
    } as Response);

    const provider = new WebhookProvider({
      url: 'https://hooks.example.com/alerts',
      secret: 'my-secret-key',
    });
    const result = await provider.send(insufficientBalanceEvent, { channel: 'webhook' });
    expect(result.success).toBe(true);

    const headers = (vi.mocked(fetch).mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-Signature-256']).toBeDefined();
    expect(headers['X-Signature-256'].length).toBe(64); // SHA-256 hex is 64 chars
  });
});

// =============================================================================
// EmailProvider
// =============================================================================

describe('EmailProvider', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const baseConfig = {
    apiKey: 're_test_key',
    fromEmail: 'alerts@autorenewal.app',
    defaultRecipientEmail: 'admin@example.com',
  };

  it('should deliver successfully on 200 response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve('OK'),
    } as Response);

    const provider = new EmailProvider(baseConfig);
    const result = await provider.send(insufficientBalanceEvent, { channel: 'email', email: 'admin@example.com' });
    expect(result.success).toBe(true);
    expect(result.provider).toBe('email');

    expect(fetch).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(fetch).mock.calls[0];
    expect(callArgs[0]).toBe('https://api.resend.com/emails');
    const body = JSON.parse((callArgs[1] as RequestInit).body as string);
    expect(body.to).toContain('admin@example.com');
    expect(body.subject).toContain('Insufficient');
  });

  it('should fail without recipient', async () => {
    const provider = new EmailProvider({ ...baseConfig, defaultRecipientEmail: undefined });
    const result = await provider.send(insufficientBalanceEvent, { channel: 'email' });
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('No recipient email configured');
  });

  it('should render all event types', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('OK'),
    } as Response);

    const provider = new EmailProvider(baseConfig);

    const events = [insufficientBalanceEvent, policyExhaustedEvent, renewalExecutedEvent];
    for (const event of events) {
      const result = await provider.send(event, { channel: 'email', email: 'admin@example.com' });
      expect(result.success).toBe(true);
    }

    // Should have been called 3 times
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('should handle Resend API errors', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: () => Promise.resolve('{"error": "Invalid recipient"}'),
    } as Response);

    const provider = new EmailProvider(baseConfig);
    const result = await provider.send(insufficientBalanceEvent, { channel: 'email', email: 'bad-email' });
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('422');
  });
});

// =============================================================================
// NotificationService
// =============================================================================

describe('NotificationService', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should deliver to console by default', async () => {
    const service = new NotificationService();
    const results = await service.sendAlert(insufficientBalanceEvent);
    // Console is always active
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].provider).toBe('console');
    expect(results[0].success).toBe(true);
  });

  it('should deliver to email when configured', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve('OK'),
    } as Response);

    const service = new NotificationService({
      resendApiKey: 're_test',
      fromEmail: 'alerts@test.com',
      defaultRecipientEmail: 'admin@example.com',
    });

    const results = await service.sendAlert(insufficientBalanceEvent);
    // Should have console + email
    const consoleResult = results.find((r) => r.provider === 'console');
    const emailResult = results.find((r) => r.provider === 'email');
    expect(consoleResult?.success).toBe(true);
    expect(emailResult?.success).toBe(true);
  });

  it('should deliver to webhook when configured', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve('OK'),
    } as Response);

    const service = new NotificationService({
      webhookUrl: 'https://hooks.example.com/alerts',
    });

    const results = await service.sendAlert(insufficientBalanceEvent);
    const consoleResult = results.find((r) => r.provider === 'console');
    const webhookResult = results.find((r) => r.provider === 'webhook');
    expect(consoleResult?.success).toBe(true);
    expect(webhookResult?.success).toBe(true);
  });

  it('should deliver to all channels simultaneously', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('OK'),
    } as Response);

    const service = new NotificationService({
      resendApiKey: 're_test',
      fromEmail: 'alerts@test.com',
      defaultRecipientEmail: 'admin@example.com',
      webhookUrl: 'https://hooks.example.com/alerts',
    });

    const results = await service.sendAlert(insufficientBalanceEvent);
    // Should have console + webhook + email
    expect(results.length).toBe(3);
    expect(results.every((r) => r.success)).toBe(true);
  });

  it('should have no external providers when minimally configured', () => {
    const service = new NotificationService();
    expect(service.hasExternalProviders).toBe(false);
  });

  it('should detect external email provider', () => {
    const service = new NotificationService({
      resendApiKey: 're_test',
      fromEmail: 'test@test.com',
      defaultRecipientEmail: 'admin@test.com',
    });
    expect(service.hasExternalProviders).toBe(true);
  });

  it('should send a digest of multiple alerts', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('OK'),
    } as Response);

    const service = new NotificationService({
      webhookUrl: 'https://hooks.example.com/alerts',
    });

    const allResults = await service.sendDigest([
      insufficientBalanceEvent,
      policyExhaustedEvent,
      renewalExecutedEvent,
    ]);

    expect(allResults.length).toBe(3); // 3 alerts
    for (const results of allResults) {
      expect(results.length).toBe(2); // console + webhook
      expect(results.every((r) => r.success)).toBe(true);
    }
  });

  it('should handle provider errors gracefully', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

    const service = new NotificationService({
      webhookUrl: 'https://hooks.example.com/alerts',
    });

    const results = await service.sendAlert(insufficientBalanceEvent);
    const consoleResult = results.find((r) => r.provider === 'console');
    const webhookResult = results.find((r) => r.provider === 'webhook');
    expect(consoleResult?.success).toBe(true); // Console always works
    expect(webhookResult?.success).toBe(false); // Webhook failed
    expect(webhookResult?.error).toBeDefined();
  });

  it('should create from env vars with factory', () => {
    vi.stubEnv('RESEND_API_KEY', 're_test');
    vi.stubEnv('NOTIFICATION_EMAIL', 'admin@example.com');

    const service = createNotificationServiceFromEnv();
    expect(service.hasExternalProviders).toBe(true);

    vi.unstubAllEnvs();
  });
});

