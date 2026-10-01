import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';

export class AsyncSqliteDatabase {
  private tail: Promise<void> = Promise.resolve();
  private readonly inTransaction = new AsyncLocalStorage<boolean>();

  constructor(private readonly database: Database.Database) {}

  private async exclusive<T>(work: () => T | Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await work(); }
    finally { release(); }
  }

  private run<T>(work: () => T): Promise<T> {
    if (this.inTransaction.getStore()) return Promise.resolve(work());
    return this.exclusive(work);
  }

  prepare(sql: string) {
    const statement = this.database.prepare(sql);
    return {
      all: (...values: unknown[]) => this.run(() => statement.all(...values)),
      get: (...values: unknown[]) => this.run(() => statement.get(...values)),
      run: (...values: unknown[]) => this.run(() => statement.run(...values)),
    };
  }

  exec(sql: string) {
    return this.run(() => this.database.exec(sql));
  }

  pragma(source: string) {
    return this.database.pragma(source);
  }

  transaction<Args extends unknown[], Result>(work: (...args: Args) => Result | Promise<Result>) {
    return async (...args: Args): Promise<Awaited<Result>> => {
      const execute = async (): Promise<Awaited<Result>> => {
        this.database.exec('BEGIN');
        try {
          const value = await Promise.resolve(this.inTransaction.run(true, () => work(...args))) as Awaited<Result>;
          this.database.exec('COMMIT');
          return value;
        } catch (error) {
          this.database.exec('ROLLBACK');
          throw error;
        }
      };
      return this.exclusive(execute) as Promise<Awaited<Result>>;
    };
  }

  backup(targetPath: string) {
    return this.exclusive(() => this.database.backup(targetPath));
  }

  close() {
    return this.exclusive(() => this.database.close());
  }
}
