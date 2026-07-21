/**
 * Vault Routes
 *
 * Implements the vault CRUD endpoints from spec.md §6.
 * All mutation endpoints return unsigned Transaction blocks
 * that the user signs client-side with their own wallet.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import pino from 'pino';

import { VaultService } from '../services/vaultService.js';

const router = new Hono();
const log = pino({ name: 'vault-routes' });
const vaultService = new VaultService();

// Validation schemas
const createVaultSchema = z.object({
  wallet_address: z.string().min(1),
  blob_id: z.string().min(1),
  initial_wal_amount: z.string().min(1),
  renew_threshold_epochs: z.number().int().positive(),
  renew_by_epochs: z.number().int().positive(),
  max_total_epochs: z.number().int().positive().optional(),
});

const depositSchema = z.object({
  wallet_address: z.string().min(1),
  amount: z.string().min(1),
});

const updatePolicySchema = z.object({
  wallet_address: z.string().min(1),
  renew_threshold_epochs: z.number().int().positive(),
  renew_by_epochs: z.number().int().positive(),
  max_total_epochs: z.number().int().positive().optional(),
  active: z.boolean(),
});

const withdrawSchema = z.object({
  wallet_address: z.string().min(1),
  amount: z.string().min(1),
});

const reclaimSchema = z.object({
  wallet_address: z.string().min(1),
});

// POST /api/vaults — Build create_vault transaction
router.post('/', zValidator('json', createVaultSchema), async (c) => {
  try {
    const body = c.req.valid('json');
    const tx = await vaultService.buildCreateVaultTx(body);
    return c.json({ transaction: tx });
  } catch (error) {
    log.error({ error }, 'Failed to build create vault tx');
    return c.json({ error: 'Failed to build transaction' }, 500);
  }
});

// GET /api/vaults/:walletAddress — Get all vaults for a wallet
router.get('/:walletAddress', async (c) => {
  try {
    const { walletAddress } = c.req.param();
    const vaults = await vaultService.getVaults(walletAddress);
    return c.json({ vaults });
  } catch (error) {
    log.error({ error }, 'Failed to get vaults');
    return c.json({ error: 'Failed to get vaults' }, 500);
  }
});

// POST /api/vaults/:vaultId/deposit — Build deposit transaction
router.post('/:vaultId/deposit', zValidator('json', depositSchema), async (c) => {
  try {
    const { vaultId } = c.req.param();
    const body = c.req.valid('json');
    const tx = await vaultService.buildDepositTx(vaultId, body);
    return c.json({ transaction: tx });
  } catch (error) {
    log.error({ error }, 'Failed to build deposit tx');
    return c.json({ error: 'Failed to build transaction' }, 500);
  }
});

// POST /api/vaults/:vaultId/policy — Build update_policy transaction
router.post('/:vaultId/policy', zValidator('json', updatePolicySchema), async (c) => {
  try {
    const { vaultId } = c.req.param();
    const body = c.req.valid('json');
    const tx = await vaultService.buildUpdatePolicyTx(vaultId, body);
    return c.json({ transaction: tx });
  } catch (error) {
    log.error({ error }, 'Failed to build update policy tx');
    return c.json({ error: 'Failed to build transaction' }, 500);
  }
});

// POST /api/vaults/:vaultId/withdraw — Build withdraw transaction
router.post('/:vaultId/withdraw', zValidator('json', withdrawSchema), async (c) => {
  try {
    const { vaultId } = c.req.param();
    const body = c.req.valid('json');
    const tx = await vaultService.buildWithdrawTx(vaultId, body);
    return c.json({ transaction: tx });
  } catch (error) {
    log.error({ error }, 'Failed to build withdraw tx');
    return c.json({ error: 'Failed to build transaction' }, 500);
  }
});

// POST /api/vaults/:vaultId/reclaim — Build reclaim_blob transaction
router.post('/:vaultId/reclaim', zValidator('json', reclaimSchema), async (c) => {
  try {
    const { vaultId } = c.req.param();
    const body = c.req.valid('json');
    const tx = await vaultService.buildReclaimTx(vaultId, body);
    return c.json({ transaction: tx });
  } catch (error) {
    log.error({ error }, 'Failed to build reclaim tx');
    return c.json({ error: 'Failed to build transaction' }, 500);
  }
});

// GET /api/vaults/:vaultId/history — Get renewal history
router.get('/:vaultId/history', async (c) => {
  try {
    const { vaultId } = c.req.param();
    const page = parseInt(c.req.query('page') || '1', 10);
    const limit = parseInt(c.req.query('limit') || '50', 10);
    const history = await vaultService.getVaultHistory(vaultId, page, limit);
    return c.json({ history, page, limit });
  } catch (error) {
    log.error({ error }, 'Failed to get vault history');
    return c.json({ error: 'Failed to get vault history' }, 500);
  }
});

export { router as vaultRoutes };
