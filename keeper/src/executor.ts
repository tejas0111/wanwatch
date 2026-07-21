/**
 * Renewal Executor
 *
 * Builds and submits execute_renewal transactions for due vaults.
 * Uses a dedicated gas-funded hot wallet that never holds user WAL.
 *
 * The keeper pays SUI gas only; the WAL cost and fees are handled
 * inside the Move contract from the vault's balance.
 *
 * After execution, the executor parses emitted Move events and returns
 * them so the caller can forward alerts to the notification service.
 */

import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import pino from 'pino';

import type { DueVault } from './scanner.js';
import type { AlertEvent } from './notification.js';

const logger = pino({ name: 'renewal-executor' });

export interface RenewalResult {
  vaultId: string;
  digest: string;
  gasUsed: bigint;
  /** Parsed Move events that may trigger user notifications */
  alerts: AlertEvent[];
}

export class RenewalExecutor {
  private client: SuiClient;
  private keypair: Ed25519Keypair;
  private retryDelayMs: number;
  private maxRetries = 3;
  private packageId: string;

  constructor(
    client: SuiClient,
    keypair: Ed25519Keypair,
    retryDelayMs = 5000,
    packageId?: string,
  ) {
    this.client = client;
    this.keypair = keypair;
    this.retryDelayMs = retryDelayMs;
    this.packageId = packageId || process.env.PACKAGE_ID || '';
  }

  /**
   * Build and submit an execute_renewal transaction for a due vault.
   * Returns the result including any Move events that were emitted.
   */
  async executeRenewal(vault: DueVault): Promise<RenewalResult> {
    const packageId = this.packageId;
    if (!packageId) {
      throw new Error('PACKAGE_ID environment variable is required to execute renewals');
    }

    const systemObjectId = process.env.SYSTEM_OBJECT_ID || '';
    if (!systemObjectId) {
      throw new Error('SYSTEM_OBJECT_ID environment variable is required to execute renewals');
    }

    // Find the FeeConfig shared object
    const feeConfigObjectId = await this.findFeeConfigObject(packageId);

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const tx = this.buildTransaction(vault, packageId, systemObjectId, feeConfigObjectId);
        const result = await this.client.signAndExecuteTransaction({
          transaction: tx,
          signer: this.keypair,
          options: {
            showEffects: true,
            showEvents: true,
          },
        });

        // Parse events from the transaction result
        const alerts = this.parseEvents(vault, result.events || []);

        const isSuccess = result.effects?.status?.status === 'success';

        const effects = result.effects;
        if (!effects) {
          throw new Error('Transaction effects missing from RPC response');
        }

        if (!isSuccess) {
          const errorMsg = effects.status?.error || 'Unknown failure';

          // Even on failure, the contract may have emitted InsufficientBalance
          // before aborting — those alerts should still be forwarded
          logger.warn(
            { vaultId: vault.id, error: errorMsg, eventsFound: alerts.length },
            'Transaction failed but events were emitted',
          );

          // Return partial result with alerts even on failure
          return {
            vaultId: vault.id,
            digest: result.digest,
            gasUsed: BigInt(effects.gasUsed?.computationCost || '0'),
            alerts,
          };
        }

        logger.info(
          { vaultId: vault.id, digest: result.digest, alertsFound: alerts.length },
          'Renewal executed successfully',
        );

        return {
          vaultId: vault.id,
          digest: result.digest,
          gasUsed: BigInt(effects.gasUsed?.computationCost || '0'),
          alerts,
        };
      } catch (error) {
        lastError = error as Error;
        logger.warn({ vaultId: vault.id, attempt, error }, 'Renewal attempt failed');

        if (attempt < this.maxRetries) {
          await this.delay(this.retryDelayMs * attempt);
        }
      }
    }

    throw lastError || new Error('Max retries exceeded');
  }

  /**
   * Parse Move events from the transaction result into AlertEvent objects.
   *
   * The auto_renewal::vault module emits:
   *   - RenewalExecuted     — successful renewal
   *   - InsufficientBalance — vault ran out of WAL
   *   - PolicyExhausted     — max_total_epochs cap reached
   *
   * Each event's parsedJson contains the event-specific fields.
   */
  private parseEvents(vault: DueVault, events: any[]): AlertEvent[] {
    const alerts: AlertEvent[] = [];
    const now = Date.now();

    for (const event of events) {
      const type = event.type as string;
      const parsed = event.parsedJson as Record<string, unknown> | null;
      if (!parsed) continue;

      // RenewalExecuted: successful renewal
      if (type.endsWith('::vault::RenewalExecuted')) {
        alerts.push({
          type: 'RenewalExecuted',
          vaultId: vault.id,
          blobId: (parsed.blob_id as string) || vault.blobId,
          beneficiary: vault.beneficiary,
          timestamp: now,
          actualCost: BigInt(String(parsed.actual_cost || '0')),
          keeperFeePaid: BigInt(String(parsed.keeper_fee_paid || '0')),
        });
      }

      // InsufficientBalance: vault WAL balance too low
      if (type.endsWith('::vault::InsufficientBalance')) {
        alerts.push({
          type: 'InsufficientBalance',
          vaultId: vault.id,
          blobId: vault.blobId,
          beneficiary: vault.beneficiary,
          timestamp: now,
          required: BigInt(String(parsed.required || '0')),
          available: BigInt(String(parsed.available || '0')),
        });
      }

      // PolicyExhausted: max_total_epochs cap reached
      if (type.endsWith('::vault::PolicyExhausted')) {
        alerts.push({
          type: 'PolicyExhausted',
          vaultId: vault.id,
          blobId: (parsed.blob_id as string) || vault.blobId,
          beneficiary: vault.beneficiary,
          timestamp: now,
          maxTotalEpochs: Number(parsed.max_total_epochs || 0),
        });
      }
    }

    return alerts;
  }

  /**
   * Find the FeeConfig shared object for this package.
   */
  private async findFeeConfigObject(packageId: string): Promise<string> {
    const feeConfigType = `${packageId}::vault::FeeConfig`;

    const result = await this.client.call<any>('suix_queryObjects', [
      {
        filter: { StructType: feeConfigType },
        options: { showType: true },
      },
      null,
      10,
    ]);

    if (!result.data || result.data.length === 0) {
      throw new Error(
        `FeeConfig shared object not found for type ${feeConfigType}. ` +
          'Make sure the contract has been deployed and init() has run.',
      );
    }

    return result.data[0].data.objectId;
  }

  /**
   * Build an execute_renewal transaction block.
   */
  private buildTransaction(
    vault: DueVault,
    packageId: string,
    systemObjectId: string,
    feeConfigObjectId: string,
  ): Transaction {
    const tx = new Transaction();

    tx.moveCall({
      target: `${packageId}::vault::execute_renewal`,
      arguments: [
        tx.object(vault.objectId),
        tx.object(feeConfigObjectId),
        tx.object(systemObjectId),
      ],
    });

    tx.setSender(this.keypair.getPublicKey().toSuiAddress());
    return tx;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
