/**
 * Auto-Renewal Keeper Worker
 *
 * Background service that scans RenewalVault objects on Sui and executes
 * due renewals. Permissionless — any keeper can call execute_renewal,
 * but this worker provides reliable, low-latency execution.
 *
 * Architecture:
 *   1. Poll all vaults due for renewal (via on-chain query)
 *   2. Batch-build execute_renewal transactions
 *   3. Submit using a dedicated gas-funded hot wallet
 *   4. Emit metrics and forward alerts to notification service
 *
 * Environment variables:
 *   SUI_RPC_URL              Sui RPC endpoint (default: testnet)
 *   KEEPER_PRIVATE_KEY       Ed25519 private key as base64 string
 *   SCAN_SCHEDULE            Cron schedule (default: every 2 minutes)
 *   MAX_VAULTS_PER_CYCLE     Max vaults to scan per cycle (default: 50)
 *   RETRY_DELAY_MS           Delay between retries (default: 5000)
 *   PACKAGE_ID               Deployed Move package ID (required)
 *   SYSTEM_OBJECT_ID         Walrus System shared object ID (required)
 *
 *   NOTIFICATION_EMAIL       Email address for alerts (optional)
 *   NOTIFICATION_WEBHOOK_URL Webhook URL for alerts (optional)
 *   NOTIFICATION_WEBHOOK_SECRET HMAC secret for webhook signing (optional)
 *   NOTIFICATION_FROM_EMAIL  Sender email for Resend (optional)
 *   RESEND_API_KEY           Resend API key for email alerts (optional)
 *
 * See spec.md §5 for full details.
 */

import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import pino from 'pino';
import cron from 'node-cron';

import { VaultScanner } from './scanner.js';
import { RenewalExecutor } from './executor.js';
import { MetricsCollector } from './metrics.js';
import { createNotificationServiceFromEnv } from './notification.js';

const logger = pino({ name: 'auto-renewal-keeper' });

interface KeeperConfig {
  rpcUrl: string;
  keeperPrivateKey: string;
  scanSchedule: string;
  maxVaultsPerCycle: number;
  retryDelayMs: number;
}

function loadConfig(): KeeperConfig {
  return {
    rpcUrl: process.env.SUI_RPC_URL || 'https://fullnode.testnet.sui.io:443',
    keeperPrivateKey: process.env.KEEPER_PRIVATE_KEY || '',
    scanSchedule: process.env.SCAN_SCHEDULE || '*/2 * * * *',
    maxVaultsPerCycle: parseInt(process.env.MAX_VAULTS_PER_CYCLE || '50', 10),
    retryDelayMs: parseInt(process.env.RETRY_DELAY_MS || '5000', 10),
  };
}

async function main() {
  const config = loadConfig();

  if (!config.keeperPrivateKey) {
    logger.error(
      'KEEPER_PRIVATE_KEY environment variable is required.\n' +
        'Generate an Ed25519 keypair and export the base64-encoded secret key.\n' +
        'Example: export KEEPER_PRIVATE_KEY="$(sui keytool generate ed25519 | grep secret | cut -d: -f2)"',
    );
    process.exit(1);
  }

  if (!process.env.PACKAGE_ID) {
    logger.error('PACKAGE_ID environment variable is required (the deployed contract package ID)');
    process.exit(1);
  }

  if (!process.env.SYSTEM_OBJECT_ID) {
    logger.error('SYSTEM_OBJECT_ID environment variable is required (the Walrus System object ID)');
    process.exit(1);
  }

  const client = new SuiClient({ url: config.rpcUrl });
  const keypair = Ed25519Keypair.fromSecretKey(config.keeperPrivateKey);
  const keeperAddress = keypair.getPublicKey().toSuiAddress();

  // Initialize notification service
  const notifications = createNotificationServiceFromEnv();

  if (notifications.hasExternalProviders) {
    logger.info('Notification service configured with external providers');
  } else {
    logger.info(
      'No external notification providers configured. ' +
        'Set NOTIFICATION_EMAIL, NOTIFICATION_WEBHOOK_URL, or RESEND_API_KEY to enable alerts.',
    );
  }

  logger.info({ keeperAddress, rpcUrl: config.rpcUrl }, 'Keeper worker starting');

  const scanner = new VaultScanner(
    client,
    config.maxVaultsPerCycle,
    process.env.ENABLE_EVENT_FALLBACK === 'true',
  );
  const executor = new RenewalExecutor(
    client,
    keypair,
    config.retryDelayMs,
    process.env.PACKAGE_ID,
  );
  const metrics = new MetricsCollector();

  // Track alerts collected during a cycle for digest
  let pendingAlerts: Awaited<ReturnType<typeof notifications.sendAlert>> = [];

  // Scheduled vault scanning and renewal execution
  cron.schedule(config.scanSchedule, async () => {
    logger.info('Starting scan cycle');
    const cycleStart = Date.now();

    try {
      const dueVaults = await scanner.findDueVaults();

      if (dueVaults.length === 0) {
        logger.debug('No due vaults found');
        return;
      }

      logger.info({ count: dueVaults.length }, 'Due vaults found, executing renewals');

      for (const vault of dueVaults) {
        metrics.recordStart(vault.id);

        try {
          const result = await executor.executeRenewal(vault);
          metrics.recordSuccess(result);
          logger.info({ vaultId: vault.id, txDigest: result.digest }, 'Renewal executed');

          // Forward any events that need user attention
          if (result.alerts.length > 0) {
            for (const alert of result.alerts) {
              const results = await notifications.sendAlert(alert);
              pendingAlerts.push(...results);
            }
          }
        } catch (error) {
          metrics.recordFailure(vault.id, error as Error);
          logger.error({ vaultId: vault.id, error }, 'Renewal failed');
        }
      }
    } catch (error) {
      logger.error({ error }, 'Scan cycle failed');
    }

    const cycleDuration = Date.now() - cycleStart;
    const summary = metrics.summarize();
    logger.info({ ...summary, cycleDurationMs: cycleDuration, alertsSent: pendingAlerts.filter(r => r.success).length }, 'Scan cycle complete');
    metrics.reset();
    pendingAlerts = [];
  });

  logger.info({ schedule: config.scanSchedule }, 'Keeper worker initialized');

  // Keep process alive
  process.on('SIGTERM', () => {
    logger.info('Shutting down keeper worker');
    process.exit(0);
  });
}

main().catch((error) => {
  logger.fatal({ error }, 'Failed to start keeper worker');
  process.exit(1);
});
