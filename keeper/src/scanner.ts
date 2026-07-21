/**
 * Vault Scanner
 *
 * Discovers RenewalVault shared objects from the Sui chain using
 * the raw suix_queryObjects RPC method, then filters to find vaults
 * that are due for renewal.
 *
 * A vault is "due" when:
 *   1. policy.active == true
 *   2. current_epoch + policy.renew_threshold_epochs >= blob.storage.end_epoch
 *
 * Architecture:
 *   - Primary: paginated queries via client.call('suix_queryObjects', ...)
 *   - Fallback: listen for VaultCreated events to build a local vault registry
 *     (see findDueVaultsFromEvents for the event-based approach)
 *   - Parses Move struct fields from the Sui JSON representation
 *   - Falls back to empty list if PACKAGE_ID is not configured
 *
 * Known limitations:
 *   - suix_queryObjects is not available on all RPC providers.
 *     If it fails, the scanner returns an empty list.
 *     For production, deploy a dedicated indexer or use the
 *     event-based approach (findDueVaultsFromEvents).
 *
 * See spec.md §5 for full requirements.
 */

import { SuiClient, SuiObjectResponse, PaginatedObjectsResponse } from '@mysten/sui/client';
import pino from 'pino';

const logger = pino({ name: 'vault-scanner' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DueVault {
  /** Short unique identifier for the vault (the objectId) */
  id: string;
  /** The Sui object ID of the RenewalVault shared object */
  objectId: string;
  /** Address of the user who controls this vault */
  beneficiary: string;
  /** The Walrus blob ID (u256) held by the vault */
  blobId: string;
  /** Current WAL balance in MIST-equivalent units */
  walBalance: bigint;
  /** Renew when <= this many epochs remain on the blob */
  renewThresholdEpochs: number;
  /** How many epochs to extend per renewal call */
  renewByEpochs: number;
  /** Optional absolute end-epoch cap (null if no limit) */
  maxTotalEpochs: number | null;
  /** Whether the renewal policy is currently active */
  active: boolean;
  /** The blob's current storage end epoch */
  currentEndEpoch: number;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

export class VaultScanner {
  private client: SuiClient;
  private maxVaults: number;
  private packageId: string;

  private enableEventFallback: boolean;

  /**
   * @param client                SuiClient connected to a full node
   * @param maxVaults             Max vaults to return per scan cycle (default 50)
   * @param enableEventFallback   If true, falls back to event-based vault discovery
   *                              when the primary suix_queryObjects query fails.
   *                              Defaults to false (opt-in via env var).
   * @param packageId             The on-chain package ID for auto_renewal::vault.
   *                              Falls back to PACKAGE_ID env var if not provided.
   */
  constructor(
    client: SuiClient,
    maxVaults = 50,
    enableEventFallback?: boolean,
    packageId?: string,
  ) {
    this.client = client;
    this.maxVaults = maxVaults;
    this.enableEventFallback =
      enableEventFallback ?? process.env.ENABLE_EVENT_FALLBACK === 'true';
    this.packageId = packageId || process.env.PACKAGE_ID || '';
  }

  // -----------------------------------------------------------------------
  // Public
  // -----------------------------------------------------------------------

  /**
   * Find all RenewalVault objects on chain that are due for renewal.
   *
   * Discovery strategy (two-tier):
   *
   *   Primary  — paginated suix_queryObjects (StructType filter).
   *              Fast, covers all vaults regardless of age.
   *
   *   Fallback — event-based discovery via VaultCreated events
   *              (only enabled when ENABLE_EVENT_FALLBACK=true or
   *               the constructor argument is set).
   *              Slower, only finds recently-created vaults, but
   *              works on RPC providers that block suix_queryObjects.
   *
   * If the primary path succeeds, results are returned directly.
   * If it fails AND the fallback is enabled, the fallback is tried.
   * If both fail, an empty list is returned with a warning.
   *
   * Returns vaults in the order they are discovered (not sorted).
   * Stops early if maxVaults is reached.
   */
  async findDueVaults(): Promise<DueVault[]> {
    // -- Primary path: suix_queryObjects --
    try {
      return await this.findDueVaultsPrimary();
    } catch (error) {
      logger.warn(
        { error, fallbackEnabled: this.enableEventFallback },
        'Primary vault scan failed',
      );

      if (!this.enableEventFallback) {
        // Fallback disabled — rethrow so the caller knows
        throw error;
      }

      // -- Fallback path: event-based discovery --
      logger.info('Attempting event-based vault discovery as fallback');

      try {
        const dueVaults = await this.findDueVaultsFromEvents();

        if (dueVaults.length === 0) {
          logger.warn(
            'Event-based fallback also returned no results. ' +
              'This may mean no vaults have been created recently (within the event query window).',
          );
        } else {
          logger.info(
            { count: dueVaults.length, source: 'event-fallback' },
            'Event-based fallback found due vaults',
          );
        }

        return dueVaults;
      } catch (fallbackError) {
        logger.error(
          { error: fallbackError },
          'Both primary scan and event-based fallback failed — returning empty list',
        );
        return [];
      }
    }
  }

  /**
   * Primary discovery: query vaults via suix_queryObjects and filter for due.
   */
  private async findDueVaultsPrimary(): Promise<DueVault[]> {
    const [allVaults, currentEpoch] = await Promise.all([
      this.queryAllVaults(),
      this.getCurrentEpoch(),
    ]);

    const dueVaults: DueVault[] = [];

    for (const vault of allVaults) {
      if (!vault.active) continue;

      // Due: current_epoch + threshold >= end_epoch
      if (currentEpoch + vault.renewThresholdEpochs >= vault.currentEndEpoch) {
        dueVaults.push(vault);
      }

      if (dueVaults.length >= this.maxVaults) break;
    }

    logger.info(
      { total: allVaults.length, due: dueVaults.length, epoch: currentEpoch, source: 'primary' },
      'Primary vault scan complete',
    );

    return dueVaults;
  }

  // -----------------------------------------------------------------------
  // Primary: direct object query via suix_queryObjects
  // -----------------------------------------------------------------------

  /**
   * Query all RenewalVault shared objects from the Sui chain.
   *
   * Uses the raw `suix_queryObjects` RPC method via SuiClient.call()
   * because the installed SDK version does not expose queryObjects
   * directly on the client. The filter uses StructType to match
   * only objects of type `{packageId}::vault::RenewalVault`.
   *
   * Handles pagination for large result sets.
   */
  private async queryAllVaults(): Promise<DueVault[]> {
    if (!this.packageId) {
      logger.warn(
        'PACKAGE_ID is not set — returning empty vault list. ' +
          'Set PACKAGE_ID env var or pass it to the VaultScanner constructor.',
      );
      return [];
    }

    const structType = `${this.packageId}::vault::RenewalVault`;
    let cursor: string | null = null;
    const vaults: DueVault[] = [];
    let hasMore = true;

    logger.info({ structType }, 'Querying RenewalVault objects from chain');

    while (hasMore && vaults.length < this.maxVaults) {
      const pageSize = Math.min(50, this.maxVaults - vaults.length);

      type SuiPage = PaginatedObjectsResponse;
      const response: SuiPage = await this.client.call<SuiPage>(
        'suix_queryObjects',
        [
          {
            filter: { StructType: structType },
            options: {
              showContent: true,
              showType: true,
              showOwner: true,
            },
          },
          cursor,
          pageSize,
        ],
      );

      if (response.data) {
        for (const obj of response.data) {
          const vault = this.parseVaultObject(obj);
          if (vault) {
            vaults.push(vault);
          }
        }
      }

      hasMore = response.hasNextPage;
      cursor = response.nextCursor ?? null;
    }

    logger.info({ count: vaults.length }, 'Queried and parsed vaults from chain');
    return vaults;
  }

  // -----------------------------------------------------------------------
  // Fallback: event-based vault discovery
  // -----------------------------------------------------------------------

  /**
   * Alternative discovery method: listen for VaultCreated events and
   * query each vault individually.
   *
   * This fallback is used when suix_queryObjects is not available
   * on the RPC provider. It scans recent events for VaultCreated events,
   * then fetches each vault's full details.
   *
   * Limitations:
   *   - Only finds vaults created recently (within the event query window).
   *     The default query limit of 50 events covers the ~most recent~
   *     VaultCreated events.
   *   - Does NOT detect vaults created before the event history window.
   *   - For full coverage in production, combine with a persistent
   *     registry or dedicated indexer.
   *
   * Called automatically by findDueVaults() when ENABLE_EVENT_FALLBACK=true
   * and the primary suix_queryObjects path fails.
   */
  private async findDueVaultsFromEvents(): Promise<DueVault[]> {
    if (!this.packageId) {
      logger.warn('PACKAGE_ID not set — returning empty from event scan');
      return [];
    }

    const vaultCreatedEventType = `${this.packageId}::vault::VaultCreated`;

    try {
      // Query recent VaultCreated events
      const events = await this.client.queryEvents({
        query: { MoveEventType: vaultCreatedEventType },
        limit: 50,
        order: 'descending',
      });

      if (!events.data || events.data.length === 0) {
        logger.debug('No VaultCreated events found');
        return [];
      }

      // Fetch each vault's current state
      const vaultIds = events.data
        .map((e) => {
          const parsed = e.parsedJson as { vault_id?: string } | null;
          return parsed?.vault_id;
        })
        .filter((id): id is string => !!id);

      const vaults = await this.fetchVaultsByIds(vaultIds);
      const currentEpoch = await this.getCurrentEpoch();

      logger.info(
        { eventsFound: events.data.length, vaultsResolved: vaults.length, source: 'event-fallback' },
        'Event-based vault discovery completed',
      );

      return vaults.filter(
        (v) => v.active && currentEpoch + v.renewThresholdEpochs >= v.currentEndEpoch,
      );
    } catch (error) {
      logger.error({ error }, 'Event-based vault scan failed');
      return [];
    }
  }

  /**
   * Fetch multiple vaults by their object IDs and parse them.
   */
  private async fetchVaultsByIds(ids: string[]): Promise<DueVault[]> {
    if (ids.length === 0) return [];

    try {
      const objects = await this.client.multiGetObjects({
        ids,
        options: { showContent: true, showType: true },
      });

      return objects
        .map((obj) => this.parseVaultObject(obj))
        .filter((v): v is DueVault => v !== null);
    } catch (error) {
      logger.error({ error, ids }, 'Failed to fetch vaults by IDs');
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Parsing
  // -----------------------------------------------------------------------

  /**
   * Parse a SuiObjectResponse into a DueVault.
   *
   * Expected Move JSON structure (depth-truncated):
   *
   *   fields: {
   *     beneficiary: "0x...",
   *     blob: { fields: { blob_id: "12345", storage: { fields: { end_epoch: "200" } } } },
   *     wal_balance: "1000000",
   *     policy: { fields: {
   *       renew_threshold_epochs: "5",
   *       renew_by_epochs: "30",
   *       max_total_epochs: null | { vec: [{ fields: { bits: "365" } }] },
   *       active: true,
   *     } },
   *   }
   */
  private parseVaultObject(obj: SuiObjectResponse): DueVault | null {
    if (!obj.data) {
      logger.warn('Received object response without data (likely deleted object)');
      return null;
    }

    const content = obj.data.content;
    if (!content || content.dataType !== 'moveObject') {
      logger.warn({ objectId: obj.data.objectId }, 'Object is not a Move object — skipping');
      return null;
    }

    const fields = (content as { fields: Record<string, unknown> }).fields;
    if (!fields) {
      logger.warn({ objectId: obj.data.objectId }, 'Move object has no fields — skipping');
      return null;
    }

    try {
      const objectId = obj.data.objectId;
      const beneficiary = this.asString(fields.beneficiary) || '';

      // blob is Option<Blob> — check if it's Some or None
      const blobRaw = fields.blob as Record<string, unknown> | undefined;
      const blobOptionVec = blobRaw?.vec as unknown[] | undefined;

      // Option<Blob> serializes to { vec: [ { fields: { ... } } ] } for Some
      // or { vec: [] } for None
      const blobIsPresent = blobOptionVec && blobOptionVec.length > 0;
      const blobFields = blobIsPresent
        ? (blobOptionVec![0] as Record<string, unknown>)?.fields as Record<string, unknown> | undefined
        : undefined;

      const blobId = blobFields
        ? this.asString(blobFields.blob_id) || ''
        : '';

      const storageFields = blobFields?.storage
        ? (blobFields.storage as Record<string, unknown>).fields as Record<string, unknown> | undefined
        : undefined;

      const currentEndEpoch = storageFields
        ? this.asNumber(storageFields.end_epoch)
        : 0;

      // Policy
      const policyRaw = fields.policy as Record<string, unknown> | undefined;
      const policyFields = policyRaw?.fields as Record<string, unknown> | undefined;

      const renewThresholdEpochs = policyFields
        ? this.asNumber(policyFields.renew_threshold_epochs)
        : 0;
      const renewByEpochs = policyFields
        ? this.asNumber(policyFields.renew_by_epochs)
        : 0;
      const maxTotalEpochs = policyFields
        ? this.parseOptionU64(policyFields.max_total_epochs)
        : null;
      const active = policyFields ? this.asBoolean(policyFields.active) : false;

      const walBalance = this.asBigInt(fields.wal_balance);

      return {
        id: objectId,
        objectId,
        beneficiary,
        blobId,
        walBalance,
        renewThresholdEpochs,
        renewByEpochs,
        maxTotalEpochs,
        active,
        currentEndEpoch,
      };
    } catch (error) {
      logger.warn(
        { objectId: obj.data.objectId, error },
        'Failed to parse vault object — skipping',
      );
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Type coercion helpers
  // -----------------------------------------------------------------------

  private asString(val: unknown): string {
    if (typeof val === 'string') return val;
    if (typeof val === 'number') return String(val);
    if (val === null || val === undefined) return '';
    if (typeof val === 'object') {
      const obj = val as Record<string, unknown>;
      if (obj.fields && typeof obj.fields === 'object') {
        const f = obj.fields as Record<string, unknown>;
        if (typeof f.bits === 'string') return f.bits;
        if (typeof f.bits === 'number') return String(f.bits);
      }
      if (typeof obj.id === 'string') return obj.id;
    }
    return String(val);
  }

  private asNumber(val: unknown): number {
    const str = this.asString(val);
    const n = parseInt(str, 10);
    return Number.isFinite(n) ? n : 0;
  }

  private asBigInt(val: unknown): bigint {
    const str = this.asString(val);
    try {
      return BigInt(str);
    } catch {
      return BigInt(0);
    }
  }

  private asBoolean(val: unknown): boolean {
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') return val === 'true';
    return false;
  }

  private parseOptionU64(val: unknown): number | null {
    if (val === null || val === undefined) return null;
    if (typeof val === 'string' || typeof val === 'number') {
      return this.asNumber(val);
    }
    const obj = val as Record<string, unknown>;
    if (obj.vec && Array.isArray(obj.vec)) {
      if (obj.vec.length === 0) return null;
      const inner = obj.vec[0] as Record<string, unknown> | undefined;
      if (inner) {
        const f = inner.fields as Record<string, unknown> | undefined;
        if (f && f.bits !== undefined) {
          return this.asNumber(f.bits);
        }
        return this.asNumber(inner);
      }
      return null;
    }
    return this.asNumber(val);
  }

  // -----------------------------------------------------------------------
  // Epoch helper
  // -----------------------------------------------------------------------

  private async getCurrentEpoch(): Promise<number> {
    const seq = await this.client.getLatestCheckpointSequenceNumber();
    const checkpoint = await this.client.getCheckpoint({ id: seq });
    return Number(checkpoint.epoch);
  }
}
