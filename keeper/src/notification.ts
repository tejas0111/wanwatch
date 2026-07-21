/**
 * Notification Service
 *
 * Forwards keeper events (InsufficientBalance, PolicyExhausted, RenewalExecuted)
 * to configured notification channels.
 *
 * Architecture:
 *   - NotificationService dispatches alerts to one or more NotificationProvider
 *     instances based on the destination configuration.
 *   - For v1, destinations are configured via environment variables.
 *     A single default email and/or webhook URL is used for all alerts.
 *   - For production, extend with a per-beneficiary preference lookup
 *     (e.g., SQLite, PostgreSQL, or a config map).
 *
 * Channels supported:
 *   - console  — structured JSON logging via pino (always active)
 *   - webhook  — POST to a configurable URL with HMAC signing
 *   - email    — via Resend API (resend.com)
 *
 * See spec.md §5.1 for full requirements.
 */

import pino from 'pino';

import {
  ConsoleProvider,
  WebhookProvider,
  EmailProvider,
  type NotificationProvider,
} from './notification-providers.js';

const logger = pino({ name: 'notification-service' });

// =============================================================================
// Types
// =============================================================================

export type AlertType = 'InsufficientBalance' | 'PolicyExhausted' | 'RenewalExecuted';

export interface AlertEvent {
  /** The type of alert */
  type: AlertType;
  /** The vault's object ID */
  vaultId: string;
  /** The Walrus blob ID (u256 string) */
  blobId: string;
  /** The vault beneficiary's Sui address */
  beneficiary: string;
  /** Unix timestamp (ms) when the alert was created */
  timestamp: number;

  // --- InsufficientBalance ---
  /** WAL amount required in MIST-equivalent */
  required?: bigint;
  /** WAL amount available in MIST-equivalent */
  available?: bigint;

  // --- PolicyExhausted ---
  /** The max_total_epochs cap that was reached */
  maxTotalEpochs?: number;

  // --- RenewalExecuted ---
  /** Actual WAL cost of the blob extension */
  actualCost?: bigint;
  /** Keeper fee paid to the executor */
  keeperFeePaid?: bigint;
}

export interface NotificationDestination {
  /** Which channel to use */
  channel: 'console' | 'webhook' | 'email';
  /** Email address (for 'email' channel) */
  email?: string;
  /** Webhook URL (for 'webhook' channel) */
  webhookUrl?: string;
}

export interface SendResult {
  success: boolean;
  provider: string;
  error?: Error;
}

// =============================================================================
// Notification Service
// =============================================================================

export interface NotificationServiceConfig {
  /** Resend API key (optional — email channel disabled if omitted) */
  resendApiKey?: string;
  /** Verified sender email for Resend */
  fromEmail?: string;
  /** Default recipient email for all alerts (optional) */
  defaultRecipientEmail?: string;
  /** Webhook URL for all alerts (optional) */
  webhookUrl?: string;
  /** Webhook HMAC secret for payload signing (optional) */
  webhookSecret?: string;
  /** Whether to log to console (default: true) */
  enableConsole?: boolean;
}

export class NotificationService {
  private providers: NotificationProvider[] = [];
  private config: NotificationServiceConfig;

  constructor(config?: Partial<NotificationServiceConfig>) {
    this.config = {
      enableConsole: true,
      ...config,
    };

    this.initProviders();
  }

  /**
   * Initialize notification providers from config.
   * Console provider is always added first (lowest overhead).
   */
  private initProviders(): void {
    if (this.config.enableConsole !== false) {
      this.providers.push(new ConsoleProvider());
    }

    const webhookUrl = this.config.webhookUrl || process.env.NOTIFICATION_WEBHOOK_URL;
    if (webhookUrl) {
      this.providers.push(
        new WebhookProvider({
          url: webhookUrl,
          secret: this.config.webhookSecret || process.env.NOTIFICATION_WEBHOOK_SECRET,
        }),
      );
    }

    const resendApiKey = this.config.resendApiKey || process.env.RESEND_API_KEY;
    const fromEmail =
      this.config.fromEmail || process.env.NOTIFICATION_FROM_EMAIL || 'alerts@autorenewal.app';
    const defaultRecipientEmail =
      this.config.defaultRecipientEmail || process.env.NOTIFICATION_EMAIL;

    if (resendApiKey) {
      this.providers.push(
        new EmailProvider({
          apiKey: resendApiKey,
          fromEmail,
          fromName: 'Auto-Renewal Keeper',
          defaultRecipientEmail: defaultRecipientEmail || undefined,
        }),
      );
    }

    if (this.providers.length === 0) {
      logger.info(
        'No notification providers configured. ' +
          'Set NOTIFICATION_EMAIL, NOTIFICATION_WEBHOOK_URL, or RESEND_API_KEY to enable alerts.',
      );
    }
  }

  /**
   * Forward an alert event to all enabled notification providers.
   *
   * Each provider determines delivery based on its configuration and the
   * destination. The service aggregates results and logs any failures.
   *
   * @returns Array of results, one per provider that attempted delivery.
   */
  async sendAlert(event: AlertEvent): Promise<SendResult[]> {
    const destinations = this.resolveDestinations(event);

    const results: SendResult[] = [];

    for (const provider of this.providers) {
      for (const destination of destinations) {
        // Skip if the provider doesn't match the destination channel
        if (
          (provider.name === 'console' && destination.channel !== 'console') ||
          (provider.name === 'webhook' && destination.channel !== 'webhook') ||
          (provider.name === 'email' && destination.channel !== 'email')
        ) {
          continue;
        }

        try {
          const result = await provider.send(event, destination);
          results.push(result);

          if (!result.success && result.error) {
            logger.warn(
              { provider: provider.name, error: result.error },
              'Notification delivery failed',
            );
          }
        } catch (error) {
          results.push({ success: false, provider: provider.name, error: error as Error });
          logger.error(
            { provider: provider.name, error },
            'Unexpected error in notification provider',
          );
        }
      }
    }

    return results;
  }

  /**
   * Send a digest of multiple alerts.
   *
   * For v1, this sends each alert individually. In a future version,
   * this could batch multiple alerts into a single email/webhook.
   */
  async sendDigest(alerts: AlertEvent[]): Promise<SendResult[][]> {
    logger.info({ count: alerts.length }, `Sending digest of ${alerts.length} alerts`);
    return Promise.all(alerts.map((alert) => this.sendAlert(alert)));
  }

  /**
   * Resolve the notification destinations for an alert.
   *
   * For v1, we use the configured defaults (NOTIFICATION_EMAIL, NOTIFICATION_WEBHOOK_URL).
   * The console provider is always included.
   *
   * For production, extend this to look up per-beneficiary preferences
   * from a database or config file.
   */
  private resolveDestinations(_event: AlertEvent): NotificationDestination[] {
    const destinations: NotificationDestination[] = [];

    // Console is always included for local logging
    destinations.push({ channel: 'console' });

    // Email (if configured)
    const email = this.config.defaultRecipientEmail || process.env.NOTIFICATION_EMAIL;
    if (email) {
      destinations.push({ channel: 'email', email });
    }

    // Webhook (if configured — providers already configured with URL)
    if (this.config.webhookUrl || process.env.NOTIFICATION_WEBHOOK_URL) {
      destinations.push({ channel: 'webhook' });
    }

    return destinations;
  }

  /**
   * Check if any providers are configured (beyond console).
   */
  get hasExternalProviders(): boolean {
    return this.providers.some((p) => p.name !== 'console');
  }
}

// =============================================================================
// Factory — create from env vars
// =============================================================================

/**
 * Create a NotificationService from environment variables.
 *
 * Reads:
 *   NOTIFICATION_EMAIL         — default recipient email for alerts
 *   NOTIFICATION_WEBHOOK_URL   — webhook URL for alert POSTs
 *   NOTIFICATION_WEBHOOK_SECRET— optional HMAC secret for webhook signing
 *   NOTIFICATION_FROM_EMAIL    — sender email address for Resend
 *   RESEND_API_KEY             — Resend API key (enables email channel)
 */
export function createNotificationServiceFromEnv(): NotificationService {
  return new NotificationService({
    resendApiKey: process.env.RESEND_API_KEY,
    fromEmail: process.env.NOTIFICATION_FROM_EMAIL,
    defaultRecipientEmail: process.env.NOTIFICATION_EMAIL,
    webhookUrl: process.env.NOTIFICATION_WEBHOOK_URL,
    webhookSecret: process.env.NOTIFICATION_WEBHOOK_SECRET,
    enableConsole: process.env.NOTIFICATION_ENABLE_CONSOLE !== 'false',
  });
}
