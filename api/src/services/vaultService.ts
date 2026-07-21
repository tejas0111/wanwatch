/**
 * Vault Service
 *
 * Handles on-chain interactions with RenewalVault objects:
 * - Reads vault state from the Sui chain
 * - Builds unsigned Transaction blocks for user signing
 * - Queries vault events from the indexer
 *
 * Note: PACKAGE_ID set to empty string as a placeholder.
 * Before using this service, set PACKAGE_ID in your environment
 * to the on-chain package ID after deploying the Move contract.
 */

import { SuiClient, SuiObjectResponse } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import pino from 'pino';

const logger = pino({ name: 'vault-service' });

// These MUST be set before the service can be used.
// PACKAGE_ID: the deployed package ID for auto_renewal::vault
// SYSTEM_OBJECT_ID: the Walrus System shared object ID
const PACKAGE_ID = process.env.PACKAGE_ID || '';
const SYSTEM_OBJECT_ID = process.env.SYSTEM_OBJECT_ID || '';
const FEE_CONFIG_ID = process.env.FEE_CONFIG_ID || '';

interface CreateVaultRequest {
  wallet_address: string;
  blob_id: string;
  initial_wal_amount: string;
  renew_threshold_epochs: number;
  renew_by_epochs: number;
  max_total_epochs?: number;
}

interface DepositRequest {
  wallet_address: string;
  amount: string;
}

interface UpdatePolicyRequest {
  wallet_address: string;
  renew_threshold_epochs: number;
  renew_by_epochs: number;
  max_total_epochs?: number;
  active: boolean;
}

interface WithdrawRequest {
  wallet_address: string;
  amount: string;
}

interface ReclaimRequest {
  wallet_address: string;
}

interface VaultInfo {
  id: string;
  beneficiary: string;
  blobId: string;
  walBalance: string;
  policy: {
    renewThresholdEpochs: number;
    renewByEpochs: number;
    maxTotalEpochs: number | null;
    active: boolean;
  };
  totalRenewals: number;
  totalFeesPaid: string;
  createdAtEpoch: number;
}

interface RenewalEvent {
  type: string;
  timestamp: string;
  vaultId: string;
  data: Record<string, unknown>;
}

export class VaultService {
  private client: SuiClient;

  constructor() {
    const rpcUrl = process.env.SUI_RPC_URL || 'https://fullnode.testnet.sui.io:443';
    this.client = new SuiClient({ url: rpcUrl });
  }

  /**
   * Build an unsigned transaction for creating a new vault.
   *
   * Move function:
   *   public entry fun create_vault(
   *     blob: Blob,
   *     initial_wal: Coin<WAL>,
   *     renew_threshold_epochs: u64,
   *     renew_by_epochs: u64,
   *     max_total_epochs: Option<u64>,
   *     ctx: &mut TxContext
   *   )
   */
  async buildCreateVaultTx(request: CreateVaultRequest): Promise<string> {
    this.ensurePackageId();
    const tx = new Transaction();

    tx.moveCall({
      target: `${PACKAGE_ID}::vault::create_vault`,
      arguments: [
        tx.object(request.blob_id),
        // TODO: Replace tx.gas with the user's actual WAL Coin<WAL> input.
        // tx.gas is the SUI gas coin, NOT a WAL coin.
        // The user must provide a WAL coin object ID as input.
        tx.object(request.blob_id), // placeholder — need user's WAL coin
        tx.pure.u64(request.renew_threshold_epochs),
        tx.pure.u64(request.renew_by_epochs),
        tx.pure.option('u64', request.max_total_epochs ?? null),
      ],
    });

    tx.setSender(request.wallet_address);
    return tx.serialize();
  }

  /**
   * Build an unsigned deposit transaction.
   *
   * Move function:
   *   public entry fun deposit(vault: &mut RenewalVault, coin: Coin<WAL>, ctx: &mut TxContext)
   */
  async buildDepositTx(vaultId: string, request: DepositRequest): Promise<string> {
    this.ensurePackageId();
    const tx = new Transaction();

    tx.moveCall({
      target: `${PACKAGE_ID}::vault::deposit`,
      arguments: [
        tx.object(vaultId),
        // TODO: Replace with the user's actual WAL Coin object ID
        tx.object(vaultId), // placeholder — need user's WAL coin
      ],
    });

    tx.setSender(request.wallet_address);
    return tx.serialize();
  }

  /**
   * Build an unsigned update_policy transaction.
   *
   * Move function:
   *   public entry fun update_policy(
   *     vault: &mut RenewalVault,
   *     new_policy: RenewalPolicy,
   *     ctx: &TxContext
   *   )
   *
   * Note: Constructing a Move struct inline requires passing each field
   * individually or serializing the struct. The `RenewalPolicy` struct
   * has store/copy/drop so it can be passed as a direct argument.
   */
  async buildUpdatePolicyTx(vaultId: string, request: UpdatePolicyRequest): Promise<string> {
    this.ensurePackageId();
    const tx = new Transaction();

    // Construct the RenewalPolicy as a struct argument by passing
    // the individual fields. The order matches the Move struct definition:
    //   struct RenewalPolicy has store, copy, drop {
    //     renew_threshold_epochs: u64,
    //     renew_by_epochs: u64,
    //     max_total_epochs: Option<u64>,
    //     active: bool,
    //   }
    //
    // TODO: In newer Sui SDK versions, use tx.makeMoveVec or struct
    // constructors. For now, we inline the struct fields in order.
    // The exact approach depends on the SDK's Move struct support.
    tx.moveCall({
      target: `${PACKAGE_ID}::vault::update_policy`,
      arguments: [
        tx.object(vaultId),
        // Pass the RenewalPolicy struct fields inline.
        // These get BCS-serialized into the struct on-chain.
        tx.pure.u64(request.renew_threshold_epochs),
        tx.pure.u64(request.renew_by_epochs),
        tx.pure.option('u64', request.max_total_epochs ?? null),
        tx.pure.bool(request.active),
      ],
    });

    tx.setSender(request.wallet_address);
    return tx.serialize();
  }

  /**
   * Build an unsigned withdraw transaction.
   *
   * Move function:
   *   public entry fun withdraw(vault: &mut RenewalVault, amount: u64, ctx: &mut TxContext)
   */
  async buildWithdrawTx(vaultId: string, request: WithdrawRequest): Promise<string> {
    this.ensurePackageId();
    const tx = new Transaction();

    tx.moveCall({
      target: `${PACKAGE_ID}::vault::withdraw`,
      arguments: [
        tx.object(vaultId),
        tx.pure.u64(BigInt(request.amount)),
      ],
    });

    tx.setSender(request.wallet_address);
    return tx.serialize();
  }

  /**
   * Build an unsigned reclaim_blob transaction.
   *
   * Move function:
   *   public entry fun reclaim_blob(vault: &mut RenewalVault, ctx: &mut TxContext)
   */
  async buildReclaimTx(vaultId: string, request: ReclaimRequest): Promise<string> {
    this.ensurePackageId();
    const tx = new Transaction();

    tx.moveCall({
      target: `${PACKAGE_ID}::vault::reclaim_blob`,
      arguments: [
        tx.object(vaultId),
      ],
    });

    tx.setSender(request.wallet_address);
    return tx.serialize();
  }

  /**
   * Get all vaults for a wallet address.
   */
  async getVaults(walletAddress: string): Promise<VaultInfo[]> {
    if (!PACKAGE_ID) {
      logger.warn('PACKAGE_ID not set — returning empty vault list');
      return [];
    }

    const vaultType = `${PACKAGE_ID}::vault::RenewalVault`;

    try {
      const result = await this.client.call<{ data: SuiObjectResponse[] }>('suix_queryObjects', [
        {
          filter: { StructType: vaultType },
          options: { showContent: true, showType: true },
        },
        null,
        50,
      ]);

      if (!result.data) return [];

      return result.data
        .filter((obj: SuiObjectResponse) => {
          if (!obj.data?.content || obj.data.content.dataType !== 'moveObject') return false;
          const fields = (obj.data.content as any).fields;
          return fields?.beneficiary === walletAddress;
        })
        .map((obj: SuiObjectResponse) => {
          const fields = (obj.data!.content as any).fields;
          const policyFields = fields.policy?.fields || {};

          // blob is now Option<Blob> — unwrap the vec
          const blobOption = fields.blob?.vec;
          const blobData = blobOption?.[0]?.fields;
          const blobId = blobData?.blob_id?.toString() || '';

          return {
            id: obj.data!.objectId,
            beneficiary: fields.beneficiary || '',
            blobId,
            walBalance: fields.wal_balance || '0',
            policy: {
              renewThresholdEpochs: parseInt(policyFields.renew_threshold_epochs || '0', 10),
              renewByEpochs: parseInt(policyFields.renew_by_epochs || '0', 10),
              maxTotalEpochs: policyFields.max_total_epochs
                ? parseInt(policyFields.max_total_epochs, 10)
                : null,
              active: policyFields.active === true,
            },
            totalRenewals: parseInt(fields.total_renewals_executed || '0', 10),
            totalFeesPaid: fields.total_fees_paid || '0',
            createdAtEpoch: parseInt(fields.created_at_epoch || '0', 10),
          };
        });
    } catch (error) {
      logger.error({ error, walletAddress }, 'Failed to get vaults');
      return [];
    }
  }

  /**
   * Get paginated renewal history for a vault.
   */
  async getVaultHistory(
    vaultId: string,
    page: number,
    limit: number,
  ): Promise<RenewalEvent[]> {
    if (!PACKAGE_ID) {
      logger.warn('PACKAGE_ID not set — returning empty history');
      return [];
    }

    const eventType = `${PACKAGE_ID}::vault::RenewalExecuted`;

    try {
      const result = await this.client.queryEvents({
        query: { MoveEventType: eventType },
        cursor: page > 1 ? undefined : null,
        limit,
        order: 'descending',
      });

      if (!result.data) return [];

      return result.data
        .filter((event) => {
          const parsed = event.parsedJson as Record<string, unknown> | null;
          return parsed?.vault_id === vaultId;
        })
        .map((event) => ({
          type: event.type,
          timestamp: event.timestampMs || '',
          vaultId,
          data: (event.parsedJson as Record<string, unknown>) || {},
        }));
    } catch (error) {
      logger.error({ error, vaultId }, 'Failed to get vault history');
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private ensurePackageId(): void {
    if (!PACKAGE_ID) {
      throw new Error(
        'PACKAGE_ID environment variable is not set. ' +
          'Deploy the Move contract and set PACKAGE_ID before calling transaction-building methods.',
      );
    }
  }
}
