const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
require("dotenv").config();

const mysql = require("mysql2/promise");
const fs = require("fs");

function formatValue(val) {
  if (val === null || val === undefined) {
    return "NULL";
  }
  if (typeof val === "number") {
    return Number.isFinite(val) ? String(val) : "NULL";
  }
  if (typeof val === "boolean") {
    return val ? "1" : "0";
  }
  if (val instanceof Date) {
    // Format Date as MySQL timestamp 'YYYY-MM-DD HH:MM:SS'
    return "'" + val.toISOString().slice(0, 19).replace("T", " ") + "'";
  }
  if (Buffer.isBuffer(val)) {
    return "X'" + val.toString("hex") + "'";
  }
  // String escaping
  return "'" + String(val).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r") + "'";
}

async function backupDatabase() {
  const backupDir = path.join(__dirname, "backups");
  fs.mkdirSync(backupDir, { recursive: true });

  const pool = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "campus_marketplace",
    waitForConnections: true,
    connectionLimit: 3
  });

  console.log("==================================================");
  console.log("  CAMPUS MARKETPLACE — SECURE DATABASE BACKUP     ");
  console.log("==================================================");
  console.log(`[INFO] Connected to database: ${process.env.DB_NAME}`);

  try {
    const [tables] = await pool.execute("SHOW TABLES");
    const backupData = {};

    let sqlDump = `-- ========================================================\n`;
    sqlDump += `-- Campus Marketplace Database Backup\n`;
    sqlDump += `-- Source Database: ${process.env.DB_NAME}\n`;
    sqlDump += `-- Export Timestamp: ${new Date().toISOString()}\n`;
    sqlDump += `-- Note: Does not specify a database name; safe to restore\n`;
    sqlDump += `-- into any target database (live or test environment).\n`;
    sqlDump += `-- ========================================================\n\n`;
    sqlDump += `SET FOREIGN_KEY_CHECKS = 0;\n\n`;

    for (const t of tables) {
      const tableName = Object.values(t)[0];
      const [createResult] = await pool.execute(`SHOW CREATE TABLE \`${tableName}\``);
      const [rows] = await pool.execute(`SELECT * FROM \`${tableName}\``);

      backupData[tableName] = {
        rowCount: rows.length,
        rows: rows
      };

      sqlDump += `-- --------------------------------------------------------\n`;
      sqlDump += `-- Table structure and data for: \`${tableName}\`\n`;
      sqlDump += `-- --------------------------------------------------------\n`;
      sqlDump += `DROP TABLE IF EXISTS \`${tableName}\`;\n`;
      sqlDump += `${createResult[0]["Create Table"]};\n\n`;

      if (rows.length > 0) {
        const columns = Object.keys(rows[0]).map(c => `\`${c}\``).join(", ");
        sqlDump += `INSERT INTO \`${tableName}\` (${columns}) VALUES\n`;

        const rowValues = rows.map(row => {
          const vals = Object.values(row).map(formatValue).join(", ");
          return `  (${vals})`;
        });

        sqlDump += rowValues.join(",\n") + ";\n\n";
      }
    }

    sqlDump += `SET FOREIGN_KEY_CHECKS = 1;\n`;

    const jsonPath = path.join(backupDir, "backup_pre_phase2.json");
    const sqlPath = path.join(backupDir, "backup_pre_phase2.sql");

    fs.writeFileSync(jsonPath, JSON.stringify(backupData, null, 2), "utf8");
    fs.writeFileSync(sqlPath, sqlDump, "utf8");

    console.log(`[SUCCESS] Backup files written:`);
    console.log(`  - SQL Dump:  ${sqlPath}`);
    console.log(`  - JSON Dump: ${jsonPath}`);
    console.log(`  - Tables exported: ${Object.keys(backupData).join(", ")}`);
    console.log("==================================================\n");

  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  backupDatabase().catch(err => {
    console.error("[ERROR] Backup failed:", err.message);
    process.exit(1);
  });
}

module.exports = { backupDatabase };
