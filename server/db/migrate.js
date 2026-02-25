const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Run pending migrations against the given database.
 * Creates a `migrations` tracking table if it doesn't exist.
 */
function runMigrations(database) {
  // Ensure migrations tracking table exists
  database.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Get already-applied migrations
  const applied = new Set(
    database.prepare('SELECT name FROM migrations ORDER BY id').all().map(r => r.name)
  );

  // Read migration files, sorted by filename
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  let ran = 0;

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

    const transaction = database.transaction(() => {
      database.exec(sql);
      database.prepare('INSERT INTO migrations (name) VALUES (?)').run(file);
    });

    transaction();
    ran++;
    console.log(`Migration applied: ${file}`);
  }

  if (ran === 0) {
    console.log('No pending migrations.');
  } else {
    console.log(`Applied ${ran} migration(s).`);
  }

  return ran;
}

module.exports = { runMigrations };
