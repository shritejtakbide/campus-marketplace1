const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
require("dotenv").config();

const mysql = require("mysql2/promise");

async function runMigration() {
  console.log("==================================================");
  console.log("  CAMPUS MARKETPLACE — PHASE 2 MIGRATION RUNNER   ");
  console.log("==================================================");

  const pool = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "campus_marketplace",
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0
  });

  const startTime = Date.now();

  try {
    const conn = await pool.getConnection();
    console.log(`[INFO] Connected to MySQL database: ${process.env.DB_NAME}`);

    // Helper to check if a column exists on a table
    async function columnExists(table, column) {
      const [rows] = await conn.execute(
        `SELECT COUNT(*) AS count 
         FROM information_schema.columns 
         WHERE table_schema = DATABASE() 
           AND table_name = ? 
           AND column_name = ?`,
        [table, column]
      );
      return Number(rows[0].count) > 0;
    }

    // Helper to check if a table exists
    async function tableExists(table) {
      const [rows] = await conn.execute(
        `SELECT COUNT(*) AS count 
         FROM information_schema.tables 
         WHERE table_schema = DATABASE() 
           AND table_name = ?`,
        [table]
      );
      return Number(rows[0].count) > 0;
    }

    // Helper to check if an index exists on a table
    async function indexExists(table, indexName) {
      const [rows] = await conn.execute(
        `SELECT COUNT(*) AS count 
         FROM information_schema.statistics 
         WHERE table_schema = DATABASE() 
           AND table_name = ? 
           AND index_name = ?`,
        [table, indexName]
      );
      return Number(rows[0].count) > 0;
    }

    // 1. UPGRADE USERS TABLE
    console.log("\n[STEP 1] Upgrading `users` table...");
    await conn.execute("ALTER TABLE `users` MODIFY COLUMN `email` VARCHAR(255) NOT NULL");
    await conn.execute("ALTER TABLE `users` MODIFY COLUMN `password_hash` VARCHAR(255) NOT NULL");

    if (!(await columnExists("users", "role"))) {
      await conn.execute(
        "ALTER TABLE `users` ADD COLUMN `role` ENUM('student', 'admin') NOT NULL DEFAULT 'student' AFTER `password_hash`"
      );
      console.log("  + Added column `users.role`");
    } else {
      console.log("  = Column `users.role` already exists");
    }

    if (!(await columnExists("users", "email_verified"))) {
      await conn.execute(
        "ALTER TABLE `users` ADD COLUMN `email_verified` BOOLEAN NOT NULL DEFAULT 0 AFTER `role`"
      );
      console.log("  + Added column `users.email_verified`");
    } else {
      console.log("  = Column `users.email_verified` already exists");
    }

    if (!(await columnExists("users", "registration_status"))) {
      await conn.execute(
        "ALTER TABLE `users` ADD COLUMN `registration_status` ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending' AFTER `email_verified`"
      );
      console.log("  + Added column `users.registration_status`");
    } else {
      console.log("  = Column `users.registration_status` already exists");
    }

    if (!(await columnExists("users", "student_verification_status"))) {
      await conn.execute(
        "ALTER TABLE `users` ADD COLUMN `student_verification_status` ENUM('unverified', 'pending', 'verified', 'rejected') NOT NULL DEFAULT 'unverified' AFTER `registration_status`"
      );
      console.log("  + Added column `users.student_verification_status`");
    } else {
      console.log("  = Column `users.student_verification_status` already exists");
    }

    if (!(await columnExists("users", "updated_at"))) {
      await conn.execute(
        "ALTER TABLE `users` ADD COLUMN `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `created_at`"
      );
      console.log("  + Added column `users.updated_at`");
    } else {
      console.log("  = Column `users.updated_at` already exists");
    }

    if (!(await columnExists("users", "registration_reviewed_by"))) {
      await conn.execute("ALTER TABLE `users` ADD COLUMN `registration_reviewed_by` INT NULL AFTER `registration_status`");
      console.log("  + Added column `users.registration_reviewed_by`");
    } else {
      console.log("  = Column `users.registration_reviewed_by` already exists");
    }

    if (!(await columnExists("users", "registration_reviewed_at"))) {
      await conn.execute("ALTER TABLE `users` ADD COLUMN `registration_reviewed_at` TIMESTAMP NULL AFTER `registration_reviewed_by`");
      console.log("  + Added column `users.registration_reviewed_at`");
    } else {
      console.log("  = Column `users.registration_reviewed_at` already exists");
    }

    if (!(await columnExists("users", "registration_rejection_reason"))) {
      await conn.execute("ALTER TABLE `users` ADD COLUMN `registration_rejection_reason` VARCHAR(255) NULL AFTER `registration_reviewed_at`");
      console.log("  + Added column `users.registration_rejection_reason`");
    } else {
      console.log("  = Column `users.registration_rejection_reason` already exists");
    }

    // 2. UPGRADE SESSIONS TABLE
    console.log("\n[STEP 2] Upgrading `sessions` table...");
    if (!(await columnExists("sessions", "expires_at"))) {
      await conn.execute("ALTER TABLE `sessions` ADD COLUMN `expires_at` TIMESTAMP NULL AFTER `user_id`");
      console.log("  + Added column `sessions.expires_at`");
    } else {
      console.log("  = Column `sessions.expires_at` already exists");
    }

    // 3. UPGRADE PRODUCTS TABLE
    console.log("\n[STEP 3] Upgrading `products` table...");
    await conn.execute("ALTER TABLE `products` MODIFY COLUMN `name` VARCHAR(255) NOT NULL");
    if (!(await columnExists("products", "status"))) {
      await conn.execute(
        "ALTER TABLE `products` ADD COLUMN `status` ENUM('active', 'sold', 'archived') NOT NULL DEFAULT 'active' AFTER `seller_id`"
      );
      console.log("  + Added column `products.status`");
    } else {
      console.log("  = Column `products.status` already exists");
    }

    // 4. UPGRADE VERIFICATION TABLE
    console.log("\n[STEP 4] Upgrading `verification` table...");
    if (!(await columnExists("verification", "admin_notes"))) {
      await conn.execute("ALTER TABLE `verification` ADD COLUMN `admin_notes` TEXT NULL AFTER `status`");
      console.log("  + Added column `verification.admin_notes`");
    } else {
      console.log("  = Column `verification.admin_notes` already exists");
    }

    if (!(await columnExists("verification", "reviewed_by"))) {
      await conn.execute("ALTER TABLE `verification` ADD COLUMN `reviewed_by` INT NULL AFTER `admin_notes`");
      console.log("  + Added column `verification.reviewed_by`");
    } else {
      console.log("  = Column `verification.reviewed_by` already exists");
    }

    if (!(await columnExists("verification", "reviewed_at"))) {
      await conn.execute("ALTER TABLE `verification` ADD COLUMN `reviewed_at` TIMESTAMP NULL AFTER `reviewed_by`");
      console.log("  + Added column `verification.reviewed_at`");
    } else {
      console.log("  = Column `verification.reviewed_at` already exists");
    }

    // 5. CREATE EMAIL OTPS TABLE
    console.log("\n[STEP 5] Checking `email_otps` table...");
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS \`email_otps\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`email\` VARCHAR(255) NOT NULL,
        \`otp_hash\` VARCHAR(64) NOT NULL,
        \`attempts\` TINYINT UNSIGNED NOT NULL DEFAULT 0,
        \`expires_at\` TIMESTAMP NOT NULL,
        \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX \`idx_otp_email_expires\` (\`email\`, \`expires_at\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log("  ✓ `email_otps` table verified/created");

    // 6. CREATE CHAT THREADS TABLE
    console.log("\n[STEP 6] Checking `chat_threads` table...");
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS \`chat_threads\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`product_id\` INT NOT NULL,
        \`buyer_id\` INT NOT NULL,
        \`seller_id\` INT NOT NULL,
        \`last_message_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY \`uq_product_buyer_seller\` (\`product_id\`, \`buyer_id\`, \`seller_id\`),
        FOREIGN KEY (\`product_id\`) REFERENCES \`products\`(\`id\`) ON DELETE CASCADE,
        FOREIGN KEY (\`buyer_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE,
        FOREIGN KEY (\`seller_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log("  ✓ `chat_threads` table verified/created");

    if (!(await indexExists("chat_threads", "idx_thread_product"))) {
      try {
        await conn.execute("ALTER TABLE `chat_threads` ADD INDEX `idx_thread_product` (`product_id`)");
        console.log("  + Added index `idx_thread_product` to `chat_threads`");
      } catch (e) {
        console.warn("  = Note on index_thread_product:", e.message);
      }
    }

    // 7. CREATE CHAT MESSAGES TABLE
    console.log("\n[STEP 7] Checking `chat_messages` table...");
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS \`chat_messages\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`thread_id\` INT NOT NULL,
        \`sender_id\` INT NOT NULL,
        \`message\` TEXT NOT NULL,
        \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (\`thread_id\`) REFERENCES \`chat_threads\`(\`id\`) ON DELETE CASCADE,
        FOREIGN KEY (\`sender_id\`) REFERENCES \`users\`(\`id\`) ON DELETE CASCADE,
        INDEX \`idx_thread_messages\` (\`thread_id\`, \`created_at\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log("  ✓ `chat_messages` table verified/created");

    // 8. BACKFILL EXISTING RECORDS NON-DESTRUCTIVELY
    console.log("\n[STEP 8] Non-destructive data synchronization & backfill...");
    
    // Sessions: set expires_at for existing sessions if null
    const [sessRes] = await conn.execute(
      "UPDATE `sessions` SET `expires_at` = DATE_ADD(`created_at`, INTERVAL 30 DAY) WHERE `expires_at` IS NULL"
    );
    if (sessRes.affectedRows > 0) {
      console.log(`  + Backfilled ${sessRes.affectedRows} existing session expiration timestamps.`);
    }

    // Existing demo student: update statuses
    const [demoRes] = await conn.execute(`
      UPDATE \`users\`
      SET \`email_verified\` = 1,
          \`registration_status\` = 'approved',
          \`student_verification_status\` = 'verified'
      WHERE \`email\` = 'student@campus.local'
    `);
    if (demoRes.affectedRows > 0) {
      console.log("  + Synchronized demo student (student@campus.local) account statuses.");
    }

    // Legacy User Policy:
    // Preserve existing accounts with registration_status = 'approved' so users are not dropped,
    // but strictly enforce email_verified = 0 (unverified) until cryptographic OTP evidence is submitted.
    const [userRes] = await conn.execute(`
      UPDATE \`users\`
      SET \`registration_status\` = 'approved',
          \`email_verified\` = 0
      WHERE \`email\` != 'student@campus.local' AND \`role\` != 'admin'
    `);
    if (userRes.affectedRows > 0) {
      console.log(`  + Preserved ${userRes.affectedRows} legacy account(s) with registration_status='approved' and email_verified=0.`);
    }

    // Clean up any insecure auto-generated admin account using default hardcoded credentials
    const crypto = require("crypto");
    const defaultInsecureHash = crypto.createHash("sha256").update("admin123").digest("hex");
    const [cleanupRes] = await conn.execute(
      "DELETE FROM `users` WHERE `email` = 'admin@campus.local' AND `password_hash` = ?",
      [defaultInsecureHash]
    );
    if (cleanupRes.affectedRows > 0) {
      console.log("  ✓ Removed insecure default administrator account (hardcoded credentials purged).");
    }

    // Secure Admin Setup via Explicit Environment Configuration
    const adminEmail = process.env.INITIAL_ADMIN_EMAIL ? process.env.INITIAL_ADMIN_EMAIL.trim().toLowerCase() : "";
    const adminPassword = process.env.INITIAL_ADMIN_PASSWORD || "";

    if (adminEmail && adminPassword) {
      if (adminPassword.length < 8) {
        throw new Error("INITIAL_ADMIN_PASSWORD must be at least 8 characters long.");
      }
      const bcrypt = require("bcrypt");
      const adminHash = await bcrypt.hash(adminPassword, 12);
      const [adminCheck] = await conn.execute(
        "SELECT id FROM `users` WHERE `email` = ? LIMIT 1",
        [adminEmail]
      );
      if (adminCheck.length === 0) {
        await conn.execute(`
          INSERT INTO \`users\` (name, email, password_hash, role, email_verified, registration_status, student_verification_status, verified, created_at)
          VALUES ('Campus Administrator', ?, ?, 'admin', 1, 'approved', 'verified', 1, NOW())
        `, [adminEmail, adminHash]);
        console.log(`  ✓ Initialized administrator account for '${adminEmail}' from environment variables.`);
      } else {
        await conn.execute(
          "UPDATE `users` SET `role` = 'admin', `password_hash` = ? WHERE `id` = ?",
          [adminHash, adminCheck[0].id]
        );
        console.log(`  ✓ Updated credentials for administrator account '${adminEmail}'.`);
      }
    } else {
      console.log("  ℹ No INITIAL_ADMIN_EMAIL/INITIAL_ADMIN_PASSWORD configured in environment.");
      console.log("  ℹ To securely provision an admin, set variables in .env or run: node database/create_admin.js");
    }

    conn.release();

    const elapsed = Date.now() - startTime;
    console.log(`\n==================================================`);
    console.log(`  MIGRATION COMPLETED SUCCESSFULLY in ${elapsed} ms!`);
    console.log(`==================================================\n`);

  } catch (error) {
    console.error("\n[ERROR] Migration failed:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  runMigration();
}

module.exports = runMigration;
