import { DatabaseSync } from 'node:sqlite';

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      repo TEXT PRIMARY KEY,
      installation_id INTEGER,
      max_open_prs INTEGER NOT NULL DEFAULT 5,
      test_command TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS users (
      login TEXT PRIMARY KEY,
      token_hash TEXT UNIQUE,
      merged INTEGER NOT NULL DEFAULT 0,
      reviews INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      kind TEXT NOT NULL,              -- build | review
      issue_number INTEGER,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open', -- open | claimed | submitted | merged | done | closed
      claimed_by TEXT,
      lease_expires INTEGER,
      pr_number INTEGER,
      pr_url TEXT,
      author TEXT,
      parent_id INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', -- open | ready | approved | closed
      created_at INTEGER NOT NULL
    );
    -- One row per volunteer: an agent can only be pledged to one proposal at a time.
    CREATE TABLE IF NOT EXISTS pledges (
      login TEXT PRIMARY KEY,
      proposal_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  // Columns added after the first version; ignored when they already exist.
  for (const ddl of [
    'ALTER TABLE projects ADD COLUMN proposal_threshold INTEGER NOT NULL DEFAULT 3',
    'ALTER TABLE tasks ADD COLUMN proposal_id INTEGER',
    'ALTER TABLE tasks ADD COLUMN plan TEXT',
    'ALTER TABLE users ADD COLUMN plans INTEGER NOT NULL DEFAULT 0',
  ]) {
    try {
      db.exec(ddl);
    } catch {}
  }
  return db;
}
