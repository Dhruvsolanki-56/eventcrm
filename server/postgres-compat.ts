import { AsyncLocalStorage } from 'node:async_hooks';
import pg, { type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

const { Pool } = pg;
type Queryable = { query: (text: string, values?: unknown[]) => Promise<QueryResult<QueryResultRow>> };
type NamedValues = Record<string, unknown>;
type SyncOrAsync<T> = T | Promise<T>;

const activeTransaction = new AsyncLocalStorage<PoolClient>();
let pool: pg.Pool | null = null;

export const getPostgresPool = () => {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error('DATABASE_URL is required for PostgreSQL mode.');
  if (!pool) {
    pool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: true },
    });
    pool.on('error', (error) => console.error(JSON.stringify({ event: 'postgres_idle_client_error', message: error.message })));
  }
  return pool;
};

export function bindParameters(sql: string, input: unknown[] | NamedValues = []) {
  if (!Array.isArray(input)) {
    const values: unknown[] = [];
    const positions = new Map<string, number>();
    let output = '';
    let index = 0;
    while (index < sql.length) {
      const char = sql[index]!;
      if (char === "'") {
        const start = index++;
        while (index < sql.length) {
          if (sql[index] === "'" && sql[index + 1] === "'") { index += 2; continue; }
          if (sql[index++] === "'") break;
        }
        output += sql.slice(start, index);
        continue;
      }
      if (char === '"') {
        const start = index++;
        while (index < sql.length) {
          if (sql[index] === '"' && sql[index + 1] === '"') { index += 2; continue; }
          if (sql[index++] === '"') break;
        }
        output += sql.slice(start, index);
        continue;
      }
      if (char === '-' && sql[index + 1] === '-') {
        const end = sql.indexOf('\n', index);
        const stop = end < 0 ? sql.length : end;
        output += sql.slice(index, stop);
        index = stop;
        continue;
      }
      if (char === '@' && /[A-Za-z_]/.test(sql[index + 1] ?? '')) {
        let stop = index + 2;
        while (/[A-Za-z0-9_]/.test(sql[stop] ?? '')) stop++;
        const name = sql.slice(index + 1, stop);
        let position = positions.get(name);
        if (!position) {
          if (!Object.hasOwn(input, name)) throw new Error(`Missing SQL parameter: ${name}`);
          values.push(input[name]);
          position = values.length;
          positions.set(name, position);
        }
        output += `$${position}`;
        index = stop;
        continue;
      }
      output += char;
      index++;
    }
    return { text: normalizeSql(output), values };
  }

  const values = input;
  let output = '';
  let index = 0;
  let position = 0;
  while (index < sql.length) {
    const char = sql[index]!;
    if (char === "'") {
      const start = index++;
      while (index < sql.length) {
        if (sql[index] === "'" && sql[index + 1] === "'") { index += 2; continue; }
        if (sql[index++] === "'") break;
      }
      output += sql.slice(start, index);
      continue;
    }
    if (char === '"') {
      const start = index++;
      while (index < sql.length) {
        if (sql[index] === '"' && sql[index + 1] === '"') { index += 2; continue; }
        if (sql[index++] === '"') break;
      }
      output += sql.slice(start, index);
      continue;
    }
    if (char === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index);
      const stop = end < 0 ? sql.length : end;
      output += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2);
      const stop = end < 0 ? sql.length : end + 2;
      output += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === '?') {
      position++;
      output += `$${position}`;
      index++;
      continue;
    }
    output += char;
    index++;
  }
  if (position !== values.length) throw new Error(`SQL has ${position} positional parameters but ${values.length} values were supplied.`);
  return { text: normalizeSql(output), values };
}

export function normalizeSql(sql: string) {
  let normalized = sql.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT INTO');
  normalized = normalized.replace(/\b([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(\$\d+)\s+COLLATE\s+NOCASE\b/gi, 'lower($1) = lower($2)');
  normalized = normalized.replace(/\s+COLLATE\s+NOCASE\b/gi, '');
  normalized = normalized.replace(/\bON\s+CONFLICT\s*\(\s*email\s*\)/gi, 'ON CONFLICT (lower(email))');
  normalized = replaceLikeOperator(normalized);
  normalized = normalized.replace(/\bMAX\(\s*created_count\s*,\s*excluded\.created_count\s*\)/gi, 'GREATEST(created_count, excluded.created_count)');
  if (/\bINSERT\s+OR\s+IGNORE\s+INTO\b/i.test(sql) && !/\bON\s+CONFLICT\b/i.test(normalized)) {
    normalized = normalized.replace(/;?\s*$/, ' ON CONFLICT DO NOTHING');
  }
  normalized = normalized.replace(/length\s*\(\s*CAST\s*\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s+AS\s+BLOB\s*\)\s*\)/gi, "octet_length(convert_to($1, 'UTF8'))");
  return normalized;
}

function replaceLikeOperator(sql: string) {
  let output = '';
  let index = 0;
  while (index < sql.length) {
    const char = sql[index]!;
    if (char === "'" || char === '"') {
      const quote = char;
      const start = index++;
      while (index < sql.length) {
        if (sql[index] === quote && sql[index + 1] === quote) { index += 2; continue; }
        if (sql[index++] === quote) break;
      }
      output += sql.slice(start, index);
      continue;
    }
    if (char === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index);
      const stop = end < 0 ? sql.length : end;
      output += sql.slice(index, stop);
      index = stop;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = index++;
      while (/[A-Za-z0-9_]/.test(sql[index] ?? '')) index++;
      const word = sql.slice(start, index);
      output += word.toUpperCase() === 'LIKE' ? 'ILIKE' : word;
      continue;
    }
    output += char;
    index++;
  }
  return output;
}

export class PostgresDatabase {
  constructor(private readonly queryable: Queryable = getPostgresPool()) {}

  prepare(sql: string) {
    const execute = async (values: unknown[] | NamedValues = []) => {
      const bound = bindParameters(sql, values);
      const transaction = activeTransaction.getStore();
      const target = transaction ?? this.queryable;
      return target.query(bound.text, bound.values);
    };
    const argumentsToValues = (values: unknown[]) =>
      values.length === 1 && values[0] !== null && typeof values[0] === 'object' && !Array.isArray(values[0])
        ? values[0] as NamedValues
        : values;
    return {
      all: async (...values: unknown[]) => (await execute(argumentsToValues(values))).rows,
      get: async (...values: unknown[]) => (await execute(argumentsToValues(values))).rows[0],
      run: async (...values: unknown[]) => ({ changes: (await execute(argumentsToValues(values))).rowCount ?? 0 }),
    };
  }

  async exec(sql: string) {
    const transaction = activeTransaction.getStore();
    return (transaction ?? this.queryable).query(sql);
  }

  transaction<T extends (...args: never[]) => SyncOrAsync<unknown>>(work: T) {
    return async (...args: Parameters<T>): Promise<Awaited<ReturnType<T>>> => {
      const client = await getPostgresPool().connect();
      try {
        await client.query('BEGIN');
        const value = await activeTransaction.run(client, () => work(...args));
        await client.query('COMMIT');
        return value as Awaited<ReturnType<T>>;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    };
  }
}

export async function closePostgresPool() {
  const activePool = pool;
  pool = null;
  if (activePool) await activePool.end();
}
