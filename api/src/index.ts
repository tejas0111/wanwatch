/**
 * Auto-Renewal Keeper — REST API
 *
 * Provides endpoints for vault CRUD operations.
 * The server never signs on the user's behalf — it builds unsigned
 * transactions that the user signs with their own wallet.
 *
 * See spec.md §6 for full API specification.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serve } from '@hono/node-server';
import pino from 'pino';

import { vaultRoutes } from './routes/vaults.js';

const log = pino({ name: 'auto-renewal-api' });

const app = new Hono();

// Middleware
app.use('*', cors({
  origin: ['http://localhost:5173', 'http://localhost:3000'],
  credentials: true,
}));
app.use('*', logger());

// Health check
app.get('/health', (c) => c.json({ status: 'ok', service: 'auto-renewal-api', version: '0.1.0' }));

// Vault routes
app.route('/api/vaults', vaultRoutes);

// Start server
const port = parseInt(process.env.PORT || '3001', 10);

serve({
  fetch: app.fetch,
  port,
}, (info: { port: number }) => {
  log.info({ port: info.port }, 'Auto-renewal API server started');
});
