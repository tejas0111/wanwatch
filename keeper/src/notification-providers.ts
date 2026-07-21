/**
 * Notification Providers
 *
 * Concrete implementations of notification delivery channels.
 * Supports console logging (dev), webhook (custom integrations),
 * and email via the Resend API (https://resend.com).
 *
 * Providers are designed to be composable — the NotificationService
 * dispatches each alert to all enabled providers based on the
 * destination's channel configuration.
 */

import pino from 'pino';
import type { AlertEvent, NotificationDestination, SendResult } from './notification.js';

const logger = pino({ name: 'notification-providers' });

// =============================================================================
// Provider Interface
// =============================================================================

export interface NotificationProvider {
  readonly name: string;
  send(event: AlertEvent, destination: NotificationDestination): Promise<SendResult>;
}

// =============================================================================
// Console Provider — logs all alerts to the application logger
// =============================================================================

export class ConsoleProvider implements NotificationProvider {
  readonly name = 'console';

  async send(event: AlertEvent, _destination: NotificationDestination): Promise<SendResult> {
    const level = event.type === 'RenewalExecuted' ? 'info' : 'warn';

    logger[level](
      {
        type: event.type,
        vaultId: event.vaultId,
        blobId: event.blobId,
        beneficiary: event.beneficiary,
        required: event.required?.toString(),
        available: event.available?.toString(),
        maxTotalEpochs: event.maxTotalEpochs,
        actualCost: event.actualCost?.toString(),
        keeperFeePaid: event.keeperFeePaid?.toString(),
      },
      `[${event.type}] vault=${event.vaultId} blob=${event.blobId}`,
    );

    return { success: true, provider: 'console' };
  }
}

// =============================================================================
// Webhook Provider — POSTs JSON payload to a configurable URL
// =============================================================================

export interface WebhookProviderConfig {
  /** Base webhook URL (can include path). May contain {vaultId} / {type} template vars. */
  url: string;
  /** Optional HMAC secret key for signing the payload (SHA-256). */
  secret?: string;
  /** Request timeout in ms (default 10s). */
  timeoutMs?: number;
  /** Max retries on failure (default 2). */
  maxRetries?: number;
}

export class WebhookProvider implements NotificationProvider {
  readonly name = 'webhook';

  private config: Required<WebhookProviderConfig>;

  constructor(config?: Partial<WebhookProviderConfig>) {
    this.config = {
      url: config?.url || '',
      secret: config?.secret || '',
      timeoutMs: config?.timeoutMs ?? 10_000,
      maxRetries: config?.maxRetries ?? 2,
    };
  }

  async send(event: AlertEvent, destination: NotificationDestination): Promise<SendResult> {
    const url = destination.webhookUrl || this.config.url;
    if (!url) {
      return { success: false, provider: 'webhook', error: new Error('No webhook URL configured') };
    }

    const payload = this.buildPayload(event);

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'User-Agent': 'AutoRenewalKeeper/0.1.0',
        };

        // Add HMAC signature if secret is configured
        if (this.config.secret) {
          headers['X-Signature-256'] = await this.signPayload(
            JSON.stringify(payload),
            this.config.secret,
          );
        }

        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (!response.ok) {
          throw new Error(`Webhook returned ${response.status}: ${await response.text().catch(() => 'unknown')}`);
        }

        logger.info({ url, attempt, eventType: event.type }, 'Webhook delivered successfully');
        return { success: true, provider: 'webhook' };
      } catch (error) {
        lastError = error as Error;
        logger.warn({ url, attempt, error }, 'Webhook delivery failed');

        if (attempt < this.config.maxRetries) {
          await this.delay(1000 * attempt);
        }
      }
    }

    return { success: false, provider: 'webhook', error: lastError! };
  }

  private buildPayload(event: AlertEvent): Record<string, unknown> {
    return {
      event: event.type,
      timestamp: event.timestamp,
      vaultId: event.vaultId,
      blobId: event.blobId,
      beneficiary: event.beneficiary,
      details: {
        required: event.required?.toString(),
        available: event.available?.toString(),
        maxTotalEpochs: event.maxTotalEpochs,
        actualCost: event.actualCost?.toString(),
        keeperFeePaid: event.keeperFeePaid?.toString(),
      },
    };
  }

  private async signPayload(payload: string, secret: string): Promise<string> {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(payload));
    return Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// =============================================================================
// Email Provider — sends via Resend API (https://resend.com)
// =============================================================================

export interface EmailProviderConfig {
  /** Resend API key */
  apiKey: string;
  /** "From" email address (must be verified in Resend) */
  fromEmail: string;
  /** Optional "From" display name */
  fromName?: string;
  /** Default recipient email (overridden by destination.email if provided) */
  defaultRecipientEmail?: string;
}

export class EmailProvider implements NotificationProvider {
  readonly name = 'email';

  private config: EmailProviderConfig;
  private baseUrl = 'https://api.resend.com';

  constructor(config: EmailProviderConfig) {
    this.config = config;
  }

  async send(event: AlertEvent, destination: NotificationDestination): Promise<SendResult> {
    const to = destination.email || this.config.defaultRecipientEmail;
    if (!to) {
      return { success: false, provider: 'email', error: new Error('No recipient email configured') };
    }

    try {
      const { subject, html } = this.renderEmail(event);

      const response = await fetch(`${this.baseUrl}/emails`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.config.fromName
            ? `${this.config.fromName} <${this.config.fromEmail}>`
            : this.config.fromEmail,
          to: [to],
          subject,
          html,
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => 'unknown');
        throw new Error(`Resend API returned ${response.status}: ${body}`);
      }

      logger.info({ to, eventType: event.type }, 'Email alert sent successfully');
      return { success: true, provider: 'email' };
    } catch (error) {
      logger.error({ to, eventType: event.type, error }, 'Email delivery failed');
      return { success: false, provider: 'email', error: error as Error };
    }
  }

  /**
   * Render an HTML email body and subject line for the alert event.
   */
  private renderEmail(event: AlertEvent): { subject: string; html: string } {
    const vaultLink = `https://testnet.suivision.xyz/object/${event.vaultId}`;
    const blobLink = `https://testnet.suivision.xyz/object/${event.blobId}`;

    switch (event.type) {
      case 'InsufficientBalance':
        return {
          subject: `⚠️ Blob Renewal Alert — Insufficient WAL Balance`,
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 560px; margin: 0 auto;">
              <h2 style="color: #dc2626;">⚠️ Insufficient Balance for Blob Renewal</h2>
              <p>Your auto-renewal vault <strong>${event.vaultId.slice(0, 10)}...</strong> does not have enough WAL to renew blob storage.</p>
              <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
                <tr><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">Blob ID</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;"><code>${event.blobId.slice(0, 16)}...</code></td></tr>
                <tr><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">Required</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb; font-weight: bold;">${(Number(event.required || 0n) / 1_000_000_000).toFixed(2)} WAL</td></tr>
                <tr><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">Available</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb; color: #dc2626;">${(Number(event.available || 0n) / 1_000_000_000).toFixed(2)} WAL</td></tr>
              </table>
              <p style="color: #6b7280; font-size: 14px;">Deposit more WAL into your vault to prevent blob expiry.</p>
              <a href="${vaultLink}" style="display: inline-block; background: #2563eb; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none;">View Vault</a>
            </div>
          `,
        };

      case 'PolicyExhausted':
        return {
          subject: `⛔ Blob Renewal — Policy Cap Reached`,
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 560px; margin: 0 auto;">
              <h2 style="color: #f59e0b;">⛔ Renewal Policy Exhausted</h2>
              <p>Your auto-renewal policy for blob <strong>${event.blobId.slice(0, 16)}...</strong> has reached its maximum total epochs cap.</p>
              <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
                <tr><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">Max Total Epochs</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${event.maxTotalEpochs ?? 'N/A'}</td></tr>
              </table>
              <p style="color: #6b7280; font-size: 14px;">Update the vault's policy to increase the cap or create a new vault.</p>
              <a href="${vaultLink}" style="display: inline-block; background: #2563eb; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none;">View Vault</a>
            </div>
          `,
        };

      case 'RenewalExecuted':
        return {
          subject: `✅ Blob Renewal Successful`,
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 560px; margin: 0 auto;">
              <h2 style="color: #16a34a;">✅ Blob Renewal Executed</h2>
              <p>Your blob storage has been successfully renewed.</p>
              <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
                <tr><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">Blob ID</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;"><code>${event.blobId.slice(0, 16)}...</code></td></tr>
                <tr><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">Cost</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${(Number(event.actualCost || 0n) / 1_000_000_000).toFixed(2)} WAL</td></tr>
                <tr><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">Keeper Fee</td><td style="padding: 8px; border-bottom: 1px solid #e5e7eb;">${(Number(event.keeperFeePaid || 0n) / 1_000_000_000).toFixed(2)} WAL</td></tr>
              </table>
              <a href="${vaultLink}" style="display: inline-block; background: #2563eb; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none;">View Vault</a>
            </div>
          `,
        };
    }
  }
}
