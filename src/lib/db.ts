import { Pool, PoolClient, QueryResult } from 'pg';

// ═══════════════════════════════════════════════════════════════
// Direct PostgreSQL connection pool
// Replaces @supabase/supabase-js entirely
// Queries run locally on VPS: 1-5ms vs 50-150ms over internet
// ═══════════════════════════════════════════════════════════════

let _pool: Pool | null = null;

export function getPool(): Pool {
  if (!_pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is not set');
    }
    _pool = new Pool({
      connectionString,
      // Connection pool: keep 2 alive, allow up to 20 concurrent
      min: 2,
      max: 20,
      // Kill idle connections after 30s to free resources
      idleTimeoutMillis: 30_000,
      // Fail fast if can't connect in 3s
      connectionTimeoutMillis: 3_000,
      // SSL not needed for localhost
      ssl: false,
    });

    // Log pool errors (don't crash the app)
    _pool.on('error', (err) => {
      console.error('PostgreSQL pool error:', err);
    });
  }
  return _pool;
}

// ── Typed query helper ─────────────────────────────────────────
// Usage: const { rows } = await query('SELECT * FROM orders WHERE order_id = $1', [id])
export async function query<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const pool = getPool();
  return pool.query<T>(sql, params);
}

// ── Transaction helper ─────────────────────────────────────────
// Usage: await withTransaction(async (client) => { ... })
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Single-row helper ──────────────────────────────────────────
// Returns null if not found instead of throwing
export async function queryOne<T = Record<string, unknown>>(
  sql: string,
  params?: unknown[]
): Promise<T | null> {
  const result = await query<T>(sql, params);
  return result.rows[0] ?? null;
}

// ── Count helper ───────────────────────────────────────────────
export async function queryCount(sql: string, params?: unknown[]): Promise<number> {
  const result = await query<{ count: string }>(sql, params);
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

export default { query, queryOne, queryCount, withTransaction, getPool };
