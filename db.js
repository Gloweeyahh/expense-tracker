const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { SCHEMA_SQL } = require('./schema');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'expenses.db');

function openDatabase(dbPath = DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  return db;
}

module.exports = { openDatabase, DB_PATH };
