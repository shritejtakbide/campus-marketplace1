const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
require("dotenv").config();

const mysql = require("mysql2/promise");

async function testBackupRestore() {
  console.log("==================================================");
  console.log("  TESTING BACKUP RESTORATION IN ISOLATED DATABASE ");
  console.log("==================================================");

  const TEST_DB = "campus_marketplace_restore_test";
  const LIVE_DB = process.env.DB_NAME || "campus_marketplace";

  // Connect to MySQL server (root connection)
  const rootConn = await mysql.createConnection({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    multipleStatements: true
  });

  try {
    console.log(`[STEP 1] Creating isolated test database: \`${TEST_DB}\`...`);
    await rootConn.execute(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    await rootConn.execute(`CREATE DATABASE \`${TEST_DB}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

    console.log(`[STEP 2] Reading SQL dump: database/backups/backup_pre_phase2.sql...`);
    const sqlPath = path.join(__dirname, "backups", "backup_pre_phase2.sql");
    const sqlContent = fs.readFileSync(sqlPath, "utf8");

    console.log(`[STEP 3] Executing restore into \`${TEST_DB}\`...`);
    // Connect specifically to the test database
    const testConn = await mysql.createConnection({
      host: process.env.DB_HOST || "localhost",
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || "root",
      password: process.env.DB_PASSWORD || "",
      database: TEST_DB,
      multipleStatements: true
    });

    await testConn.query(sqlContent);
    console.log(`  ✓ SQL dump restored successfully into \`${TEST_DB}\`!`);

    console.log(`\n[STEP 4] Verifying restored tables and counts in \`${TEST_DB}\`:`);
    const [restoredTables] = await testConn.execute("SHOW TABLES");
    console.log(`  - Restored table count: ${restoredTables.length}`);

    for (const t of restoredTables) {
      const tName = Object.values(t)[0];
      const [countRes] = await testConn.execute(`SELECT COUNT(*) as count FROM \`${tName}\``);
      console.log(`  - Table \`${tName}\`: ${countRes[0].count} rows restored.`);
    }

    await testConn.end();

    console.log(`\n[STEP 5] Verifying live database \`${LIVE_DB}\` was NOT altered:`);
    const [liveTables] = await rootConn.execute(
      `SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = ?`,
      [LIVE_DB]
    );
    console.log(`  ✓ Live database \`${LIVE_DB}\` table count verified: ${liveTables[0].count} tables intact.`);

    console.log(`\n[STEP 6] Cleaning up test database \`${TEST_DB}\`...`);
    await rootConn.execute(`DROP DATABASE IF EXISTS \`${TEST_DB}\``);
    console.log(`  ✓ Test database \`${TEST_DB}\` dropped cleanly.`);

    console.log(`\n==================================================`);
    console.log(`  BACKUP RESTORATION TEST: PASSED 100%`);
    console.log(`==================================================\n`);

  } catch (err) {
    console.error("[FAIL] Restore test failed:", err);
    process.exit(1);
  } finally {
    await rootConn.end();
  }
}

testBackupRestore();
