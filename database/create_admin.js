const path = require("path");
const crypto = require("crypto");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
require("dotenv").config();

const bcrypt = require("bcrypt");
const mysql = require("mysql2/promise");

const BCRYPT_SALT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS || 12);

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
}

async function createOrUpdateAdmin(email, password, name = "Campus Administrator") {
  if (!email || !email.includes("@")) {
    throw new Error("A valid administrator email address is required.");
  }
  if (!password || password.length < 8) {
    throw new Error("Administrator password must be at least 8 characters long.");
  }

  const pool = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "campus_marketplace",
    waitForConnections: true,
    connectionLimit: 3
  });

  try {
    const [existing] = await pool.execute(
      "SELECT id, name, role FROM `users` WHERE `email` = ? LIMIT 1",
      [email.toLowerCase().trim()]
    );

    const passwordHash = await hashPassword(password);

    if (existing.length > 0) {
      await pool.execute(
        `UPDATE \`users\`
         SET \`role\` = 'admin',
             \`password_hash\` = ?,
             \`registration_status\` = 'approved',
             \`email_verified\` = 1,
             \`updated_at\` = NOW()
         WHERE \`id\` = ?`,
        [passwordHash, existing[0].id]
      );
      console.log(`[SUCCESS] Existing user '${email}' has been updated to role 'admin' with updated credentials.`);
    } else {
      await pool.execute(
        `INSERT INTO \`users\`
         (\`name\`, \`email\`, \`password_hash\`, \`role\`, \`email_verified\`, \`registration_status\`, \`student_verification_status\`, \`verified\`, \`created_at\`)
         VALUES (?, ?, ?, 'admin', 1, 'approved', 'verified', 1, NOW())`,
        [name.trim(), email.toLowerCase().trim(), passwordHash]
      );
      console.log(`[SUCCESS] New administrator account '${email}' created successfully.`);
    }
  } finally {
    await pool.end();
  }
}

// CLI Argument parser: --email <email> --password <password> [--name <name>]
async function main() {
  const args = process.argv.slice(2);
  let email = process.env.INITIAL_ADMIN_EMAIL || "";
  let password = process.env.INITIAL_ADMIN_PASSWORD || "";
  let name = "Campus Administrator";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--email" && args[i + 1]) {
      email = args[i + 1];
      i++;
    } else if (args[i] === "--password" && args[i + 1]) {
      password = args[i + 1];
      i++;
    } else if (args[i] === "--name" && args[i + 1]) {
      name = args[i + 1];
      i++;
    }
  }

  if (!email || !password) {
    console.error("==================================================");
    console.error("  ADMIN SETUP ERROR: Missing required credentials ");
    console.error("==================================================");
    console.error("Usage:");
    console.error("  node database/create_admin.js --email <admin_email> --password <min_8_char_password> [--name <name>]");
    console.error("Or set in .env:");
    console.error("  INITIAL_ADMIN_EMAIL=admin@yourcampus.edu");
    console.error("  INITIAL_ADMIN_PASSWORD=your_secure_password");
    console.error("==================================================");
    process.exit(1);
  }

  try {
    await createOrUpdateAdmin(email, password, name);
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { createOrUpdateAdmin };
