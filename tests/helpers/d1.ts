// TEST ONLY. A minimal D1Database over node:sqlite (in-memory), with the real
// migrations applied and foreign keys enforced like D1. Implements exactly the
// subset OpenADS uses: prepare/bind/first/all/run and transactional batch.
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

class Statement {
  readonly db: DatabaseSync;
  readonly sql: string;
  readonly params: SQLInputValue[];
  constructor(db: DatabaseSync, sql: string, params: SQLInputValue[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params: unknown[]): Statement {
    for (const value of params) {
      if (value === undefined || typeof value === 'boolean' || (typeof value === 'object' && value !== null)) {
        throw new TypeError(`D1 cannot bind ${typeof value}`);
      }
    }
    return new Statement(this.db, this.sql, params as SQLInputValue[]);
  }

  rows(): Record<string, unknown>[] {
    return this.db.prepare(this.sql).all(...this.params).map(row => ({ ...row }));
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.rows()[0];
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }

  async all<T>() {
    return { results: this.rows() as T[], success: true, meta: {} };
  }

  runSync() {
    const result = this.db.prepare(this.sql).run(...this.params);
    return { results: [], success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }

  async run() {
    return this.runSync();
  }
}

export interface TestD1 {
  readonly db: D1Database;
  readonly sqlite: DatabaseSync;
  /** Every row of a table, for assertions. */
  rows(table: string): Record<string, unknown>[];
}

export function createTestD1(): TestD1 {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const dir = new URL('../../migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  }
  const db = {
    prepare: (sql: string) => new Statement(sqlite, sql),
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map(statement => statement.runSync());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },
  };
  return {
    db: db as unknown as D1Database,
    sqlite,
    rows: table => sqlite.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row })),
  };
}
