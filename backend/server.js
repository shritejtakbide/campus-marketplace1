const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const mysql = require("mysql2/promise");

// Ensure .env is loaded from explicit project path across all working directories
require("./env_loader.js");

/* =========================
   CONFIGURATION
========================= */

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "localhost";
const BCRYPT_SALT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS || 12);
const SESSION_LIFETIME_HOURS = Number(process.env.SESSION_LIFETIME_HOURS || 24);
const OTP_EXPIRY_MINUTES = Number(process.env.OTP_EXPIRY_MINUTES || 10);
const OTP_RESEND_COOLDOWN_SECONDS = Number(process.env.OTP_RESEND_COOLDOWN_SECONDS || 60);

// Phase 5: Authentication Security & Rate Limiting Configurations
const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = Number(process.env.LOGIN_RATE_LIMIT_MAX_ATTEMPTS || 5);
const LOGIN_RATE_LIMIT_WINDOW_MINUTES = Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MINUTES || 15);
const PASSWORD_RESET_EXPIRY_MINUTES = Number(process.env.PASSWORD_RESET_EXPIRY_MINUTES || 30);
const RECOVERY_RATE_LIMIT_MAX_ATTEMPTS = Number(process.env.RECOVERY_RATE_LIMIT_MAX_ATTEMPTS || 5);
const RECOVERY_RATE_LIMIT_WINDOW_MINUTES = Number(process.env.RECOVERY_RATE_LIMIT_WINDOW_MINUTES || 15);
const RESET_RATE_LIMIT_MAX_ATTEMPTS = Number(process.env.RESET_RATE_LIMIT_MAX_ATTEMPTS || 5);
const RESET_RATE_LIMIT_WINDOW_MINUTES = Number(process.env.RESET_RATE_LIMIT_WINDOW_MINUTES || 15);

const {
  isSmtpConfigured,
  generateOtp,
  hashOtp,
  sendOTPEmail,
  buildPasswordResetEmailHtml,
  sendPasswordResetEmail
} = require("./email_service.js");

const FRONTEND_DIR = process.env.FRONTEND_DIR ||
  (fs.existsSync(path.resolve(__dirname, "..", "frontend"))
    ? path.resolve(__dirname, "..", "frontend")
    : path.resolve(__dirname, "..", "public"));

const PUBLIC_DIR = FRONTEND_DIR;

/*
  IMPORTANT:
  Verification documents are NOT stored in a local
  uploads folder because Vercel's filesystem is not
  persistent.
  
  Verification documents are stored in MySQL instead.
*/

/* =========================
   MYSQL CONNECTION
========================= */

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "campus_marketplace",

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

/* =========================
   DATABASE INITIALIZATION
========================= */

let databaseInitialization = null;

/* =========================
   HELPERS
========================= */

function sendJSON(res, statusCode, data) {
  if (res.headersSent) {
    return;
  }

  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "strict-origin-when-cross-origin"
  });

  res.end(JSON.stringify(data));
}

function sendText(
  res,
  statusCode,
  text,
  contentType = "text/plain; charset=utf-8"
) {
  if (res.headersSent) {
    return;
  }

  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "strict-origin-when-cross-origin"
  });

  res.end(text);
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded && typeof forwarded === "string") {
    const first = forwarded.split(",")[0].trim();
    if (first) return first;
  }
  return req.socket.remoteAddress || "127.0.0.1";
}

function getAppBaseUrl() {
  const configured = process.env.APP_BASE_URL || process.env.FRONTEND_URL;
  if (configured && typeof configured === "string") {
    const trimmed = configured.trim().replace(/\/+$/, "");
    try {
      const u = new URL(trimmed);
      if (u.protocol === "http:" || u.protocol === "https:") {
        return trimmed;
      }
    } catch {
      console.warn("[AUTH] Invalid APP_BASE_URL configured, falling back to default.");
    }
  }

  const host = process.env.HOST || "localhost";
  const port = Number(process.env.PORT || 3000);
  return `http://${host}:${port}`;
}

async function checkRateLimit(dbPool, rateKey, maxAttempts) {
  try {
    const [rows] = await dbPool.execute(
      `SELECT attempts, 
              UNIX_TIMESTAMP(expires_at) - UNIX_TIMESTAMP(NOW()) AS seconds_remaining
       FROM email_otps
       WHERE email = ? AND otp_hash = 'rate_limit' AND expires_at > NOW()
       ORDER BY id DESC
       LIMIT 1`,
      [rateKey]
    );

    if (rows.length > 0 && rows[0].attempts >= maxAttempts) {
      return {
        limited: true,
        attempts: rows[0].attempts,
        secondsRemaining: Math.max(1, Number(rows[0].seconds_remaining) || 1)
      };
    }

    return {
      limited: false,
      attempts: rows.length > 0 ? rows[0].attempts : 0
    };
  } catch (err) {
    console.error("[RATE-LIMIT] Error checking rate limit:", err.message);
    return { limited: false, attempts: 0, secondsRemaining: 0 };
  }
}

async function recordFailedAttempt(dbPool, rateKey, windowMinutes) {
  try {
    const [rows] = await dbPool.execute(
      `SELECT id, attempts FROM email_otps
       WHERE email = ? AND otp_hash = 'rate_limit' AND expires_at > NOW()
       LIMIT 1`,
      [rateKey]
    );

    if (rows.length > 0) {
      await dbPool.execute(
        `UPDATE email_otps SET attempts = attempts + 1 WHERE id = ?`,
        [rows[0].id]
      );
    } else {
      // Clean up any stale/expired record for this key first
      await dbPool.execute(
        `DELETE FROM email_otps WHERE email = ? AND otp_hash = 'rate_limit'`,
        [rateKey]
      );
      await dbPool.execute(
        `INSERT INTO email_otps (email, otp_hash, attempts, expires_at, created_at)
         VALUES (?, 'rate_limit', 1, DATE_ADD(NOW(), INTERVAL ? MINUTE), NOW())`,
        [rateKey, windowMinutes]
      );
    }
  } catch (err) {
    console.error("[RATE-LIMIT] Error recording failed attempt:", err.message);
  }
}

async function resetRateLimit(dbPool, rateKey) {
  try {
    await dbPool.execute(
      `DELETE FROM email_otps WHERE email = ? AND otp_hash = 'rate_limit'`,
      [rateKey]
    );
  } catch (err) {
    console.error("[RATE-LIMIT] Error resetting rate limit:", err.message);
  }
}

async function cleanupExpiredRateLimits(dbPool) {
  try {
    await dbPool.execute(
      `DELETE FROM email_otps WHERE otp_hash = 'rate_limit' AND expires_at <= NOW()`
    );
  } catch (err) {
    console.error("[RATE-LIMIT] Error cleaning up expired limits:", err.message);
  }
}

function getToken(req) {
  const auth = req.headers.authorization || "";

  if (auth.startsWith("Bearer ")) {
    return auth.slice(7).trim();
  }

  return null;
}

async function getCurrentUser(req) {
  const token = getToken(req);

  if (!token) {
    return null;
  }

  const [rows] = await pool.execute(
    `
    SELECT
      u.id,
      u.name,
      u.email,
      u.role,
      u.email_verified,
      u.registration_status,
      u.registration_reviewed_by,
      u.registration_reviewed_at,
      u.registration_rejection_reason,
      u.student_verification_status,
      u.verified,
      u.created_at,
      s.expires_at
    FROM sessions s
    JOIN users u
      ON u.id = s.user_id
    WHERE s.token = ?
      AND (s.expires_at IS NULL OR s.expires_at > NOW())
    LIMIT 1
    `,
    [token]
  );

  return rows[0] || null;
}

async function requireAdmin(req, res) {
  const user = await getCurrentUser(req);
  if (!user) {
    sendJSON(res, 401, {
      success: false,
      message: "Authentication required."
    });
    return null;
  }

  // Always query database directly to verify role (never trust client or cached token claims)
  const [rows] = await pool.execute(
    "SELECT id, name, email, role, registration_status FROM users WHERE id = ? LIMIT 1",
    [user.id]
  );

  if (rows.length === 0 || rows[0].role !== "admin") {
    sendJSON(res, 403, {
      success: false,
      message: "Administrator authorization required. Access denied."
    });
    return null;
  }

  return { ...user, role: rows[0].role };
}

async function requireChatUser(req, res) {
  const user = await getCurrentUser(req);
  if (!user) {
    sendJSON(res, 401, {
      success: false,
      message: "Please login to use chat."
    });
    return null;
  }

  if (!user.email_verified) {
    sendJSON(res, 403, {
      success: false,
      message: "Please verify your email before using chat."
    });
    return null;
  }

  if (user.role !== "admin" && user.registration_status !== "approved") {
    sendJSON(res, 403, {
      success: false,
      message:
        user.registration_status === "rejected"
          ? "Your registration has been rejected. Chat access is disabled."
          : "Your registration is pending admin approval."
    });
    return null;
  }

  return user;
}

async function requireApprovedUser(req, res, customAuthMsg = "Authentication required.") {
  const user = await getCurrentUser(req);
  if (!user) {
    sendJSON(res, 401, {
      success: false,
      message: customAuthMsg
    });
    return null;
  }

  if (!user.email_verified) {
    sendJSON(res, 403, {
      success: false,
      message: "Please verify your email before managing listings."
    });
    return null;
  }

  if (user.role !== "admin" && user.registration_status !== "approved") {
    sendJSON(res, 403, {
      success: false,
      message:
        user.registration_status === "rejected"
          ? "Your registration has been rejected. Marketplace access is disabled."
          : "Your registration is pending admin approval."
    });
    return null;
  }

  return user;
}

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
}

function hashLegacySha256(password) {
  return crypto
    .createHash("sha256")
    .update(password)
    .digest("hex");
}

async function verifyPassword(password, storedHash) {
  if (!storedHash) {
    return false;
  }

  // Check if stored hash is a bcrypt hash ($2a$, $2b$, or $2y$)
  if (storedHash.startsWith("$2")) {
    return bcrypt.compare(password, storedHash);
  }

  // Fallback check for legacy unsalted SHA-256
  const legacyHash = hashLegacySha256(password);
  return storedHash === legacyHash;
}

function isLegacyHash(storedHash) {
  return Boolean(storedHash && !storedHash.startsWith("$2"));
}

function createToken() {
  return crypto.randomBytes(32).toString("hex");
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let finished = false;

    /*
      Vercel Functions have a request payload limit.
      Keep this below the platform limit.
    */
    const MAX_BODY_SIZE = 4 * 1024 * 1024;

    req.on("data", chunk => {
      if (finished) {
        return;
      }

      body += chunk.toString();

      if (
        Buffer.byteLength(body, "utf8") >
        MAX_BODY_SIZE
      ) {
        finished = true;

        reject(
          new Error(
            "Request too large. Maximum request size is 4 MB."
          )
        );

        req.resume();
      }
    });

    req.on("end", () => {
      if (finished) {
        return;
      }

      try {
        resolve(
          body
            ? JSON.parse(body)
            : {}
        );
      } catch {
        reject(
          new Error("Invalid JSON")
        );
      }
    });

    req.on("error", error => {
      if (!finished) {
        reject(error);
      }
    });
  });
}

function safeFileName(name) {
  return String(name || "document")
    .replace(
      /[^a-zA-Z0-9._-]/g,
      "_"
    )
    .slice(0, 255);
}

function getContentType(filePath) {
  const ext =
    path.extname(filePath)
      .toLowerCase();

  const types = {
    ".html":
      "text/html; charset=utf-8",

    ".css":
      "text/css; charset=utf-8",

    ".js":
      "application/javascript; charset=utf-8",

    ".json":
      "application/json; charset=utf-8",

    ".png":
      "image/png",

    ".jpg":
      "image/jpeg",

    ".jpeg":
      "image/jpeg",

    ".gif":
      "image/gif",

    ".svg":
      "image/svg+xml",

    ".ico":
      "image/x-icon",

    ".webp":
      "image/webp",

    ".txt":
      "text/plain; charset=utf-8"
  };

  return (
    types[ext] ||
    "application/octet-stream"
  );
}

/* =========================
   STATIC FILE SERVER
========================= */

function serveStatic(req, res) {
  let pathname;

  try {
    pathname = decodeURIComponent(
      new URL(
        req.url,
        `http://${req.headers.host || `${HOST}:${PORT}`}`
      ).pathname
    );
  } catch {
    return sendText(
      res,
      400,
      "Bad request"
    );
  }

  if (pathname === "/") {
    pathname = "/index.html";
  }

  const requestedPath =
    pathname.replace(/^\/+/, "");

  const filePath = path.resolve(
    PUBLIC_DIR,
    requestedPath
  );

  const publicRoot =
    path.resolve(PUBLIC_DIR);

  /*
    Prevent directory traversal and hidden file exposure.
  */

  if (
    requestedPath.startsWith(".") ||
    path.basename(filePath).startsWith(".") ||
    (filePath !== publicRoot &&
      !filePath.startsWith(
        publicRoot + path.sep
      ))
  ) {
    return sendText(
      res,
      403,
      "Forbidden"
    );
  }

  fs.readFile(
    filePath,
    (err, data) => {
      if (err) {
        if (err.code === "ENOENT") {
          return sendText(
            res,
            404,
            "File not found"
          );
        }

        console.error(
          "Static file error:",
          err
        );

        return sendText(
          res,
          500,
          "Could not load requested file."
        );
      }

      res.writeHead(200, {
        "Content-Type":
          getContentType(filePath),
        "Cache-Control":
          "public, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "SAMEORIGIN",
        "Referrer-Policy": "strict-origin-when-cross-origin"
      });

      res.end(data);
    }
  );
}

/* =========================
   DATABASE INITIALIZATION
========================= */

async function initializeDatabase() {
  /*
    Create sessions table if it doesn't exist.
  */

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      token VARCHAR(255) PRIMARY KEY,
      user_id INT NOT NULL,
      expires_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
    )
  `);

  try {
    await pool.execute(`
      ALTER TABLE sessions
      ADD COLUMN expires_at TIMESTAMP NULL
    `);
  } catch (err) {
    if (err.errno !== 1060) {
      console.warn("Sessions table migration warning:", err.message);
    }
  }

  /*
    Create email_otps table if it doesn't exist.
  */
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS email_otps (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      otp_hash VARCHAR(64) NOT NULL,
      attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_otp_email_expires (email, expires_at),
      INDEX idx_otp_email_created (email, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  try {
    await pool.execute(`ALTER TABLE users ADD COLUMN registration_reviewed_by INT NULL AFTER registration_status`);
  } catch (e) { if (e.errno !== 1060) console.warn("User column migration warning:", e.message); }
  try {
    await pool.execute(`ALTER TABLE users ADD COLUMN registration_reviewed_at TIMESTAMP NULL AFTER registration_reviewed_by`);
  } catch (e) { if (e.errno !== 1060) console.warn("User column migration warning:", e.message); }
  try {
    await pool.execute(`ALTER TABLE users ADD COLUMN registration_rejection_reason VARCHAR(255) NULL AFTER registration_reviewed_at`);
  } catch (e) { if (e.errno !== 1060) console.warn("User column migration warning:", e.message); }

  try {
    await pool.execute(`ALTER TABLE users ADD COLUMN password_reset_token_hash VARCHAR(64) NULL AFTER password_hash`);
  } catch (e) { if (e.errno !== 1060) console.warn("User column migration warning:", e.message); }
  try {
    await pool.execute(`ALTER TABLE users ADD COLUMN password_reset_expires_at TIMESTAMP NULL AFTER password_reset_token_hash`);
  } catch (e) { if (e.errno !== 1060) console.warn("User column migration warning:", e.message); }
  try {
    await pool.execute(`ALTER TABLE users ADD COLUMN password_reset_used_at TIMESTAMP NULL AFTER password_reset_expires_at`);
  } catch (e) { if (e.errno !== 1060) console.warn("User column migration warning:", e.message); }
  try {
    await pool.execute(`ALTER TABLE users ADD INDEX idx_reset_token_hash (password_reset_token_hash)`);
  } catch (e) { if (e.errno !== 1061) console.warn("User index migration warning:", e.message); }

  /*
    Add document_data to verification table.

    This stores the Base64 document in MySQL
    instead of the Vercel filesystem.
  */

  try {
    await pool.execute(`
      ALTER TABLE verification
      ADD COLUMN document_data LONGTEXT NULL
    `);

    console.log(
      "Added verification.document_data column."
    );
  } catch (error) {
    /*
      MySQL error 1060 means the column
      already exists.
    */

    if (error.errno !== 1060) {
      console.error(
        "Could not verify document_data column:",
        error.message
      );
    }
  }

  /*
    Create chat_threads and chat_messages tables if they don't exist.
  */
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS chat_threads (
      id INT AUTO_INCREMENT PRIMARY KEY,
      product_id INT NOT NULL,
      buyer_id INT NOT NULL,
      seller_id INT NOT NULL,
      last_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_product_buyer_seller (product_id, buyer_id, seller_id),
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
      FOREIGN KEY (buyer_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (seller_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX idx_thread_buyer (buyer_id),
      INDEX idx_thread_seller (seller_id),
      INDEX idx_thread_product (product_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      thread_id INT NOT NULL,
      sender_id INT NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (thread_id) REFERENCES chat_threads(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX idx_thread_messages (thread_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  /*
    Create demo user if necessary.
  */

  const [users] =
    await pool.execute(
      `
      SELECT id
      FROM users
      WHERE email = ?
      LIMIT 1
      `,
      [
        "student@campus.local"
      ]
    );

  let demoUserId;

  if (users.length === 0) {
    const demoPasswordHash = await hashPassword("student123");
    const [result] =
      await pool.execute(
        `
        INSERT INTO users
        (
          name,
          email,
          password_hash,
          role,
          email_verified,
          registration_status,
          student_verification_status,
          verified,
          created_at
        )
        VALUES (?, ?, ?, 'student', 1, 'approved', 'verified', 1, NOW())
        `,
        [
          "Demo Student",
          "student@campus.local",
          demoPasswordHash
        ]
      );

    demoUserId =
      result.insertId;
  } else {
    demoUserId =
      users[0].id;
  }

  /*
    Add demo products if the database
    currently has no products.
  */

  const [products] =
    await pool.execute(
      `
      SELECT COUNT(*) AS count
      FROM products
      `
    );

  if (
    Number(products[0].count) === 0
  ) {
    const demoProducts = [
      [
        "Engineering Mathematics Book",
        "Books",
        350,
        "Engineering Mathematics reference book in good condition.",
        demoUserId
      ],

      [
        "Programming in C Book",
        "Books",
        400,
        "Programming in C textbook suitable for engineering students.",
        demoUserId
      ],

      [
        "Scientific Calculator",
        "Electronics",
        650,
        "Scientific calculator in working condition.",
        demoUserId
      ],

      [
        "Wireless Earphones",
        "Electronics",
        800,
        "Wireless earphones with good battery backup.",
        demoUserId
      ],

      [
        "Study Table",
        "Furniture",
        1200,
        "Compact study table suitable for hostel rooms.",
        demoUserId
      ],

      [
        "College Backpack",
        "Accessories",
        500,
        "College backpack with multiple compartments.",
        demoUserId
      ]
    ];

    for (
      const product of demoProducts
    ) {
      await pool.execute(
        `
        INSERT INTO products
        (
          name,
          category,
          price,
          description,
          seller_id,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, NOW())
        `,
        product
      );
    }
  }

  console.log(
    "MySQL database initialized."
  );
}

function ensureDatabaseInitialized() {
  if (!databaseInitialization) {
    databaseInitialization =
      initializeDatabase()
        .catch(error => {
          databaseInitialization =
            null;

          throw error;
        });
  }

  return databaseInitialization;
}

/* =========================
   API ROUTES
========================= */

async function handleAPI(req, res) {
  const url = new URL(
    req.url,
    `http://${req.headers.host || `${HOST}:${PORT}`}`
  );

  const pathname =
    url.pathname;

  /* =========================
     PREFLIGHT (OPTIONS)
  ========================= */

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
      "X-Content-Type-Options": "nosniff"
    });
    return res.end();
  }

  /* =========================
     HEALTH
  ========================= */

  if (
    req.method === "GET" &&
    pathname === "/api/health"
  ) {
    try {
      await pool.query(
        "SELECT 1"
      );

      return sendJSON(
        res,
        200,
        {
          success: true,
          message:
            "Campus Marketplace API is running",
          database: "MySQL"
        }
      );
    } catch (error) {
      console.error(
        "Health check failed:",
        error
      );

      return sendJSON(
        res,
        503,
        {
          success: false,
          message:
            "Database connection failed."
        }
      );
    }
  }

  /* =========================
     REGISTER
  ========================= */

  if (
    req.method === "POST" &&
    pathname ===
      "/api/auth/register"
  ) {
    const body =
      await parseBody(req);

    const name =
      String(
        body.name || ""
      ).trim();

    const email =
      String(
        body.email || ""
      )
        .trim()
        .toLowerCase();

    const password =
      String(
        body.password || ""
      );

    if (
      !name ||
      !email ||
      !password
    ) {
      return sendJSON(
        res,
        400,
        {
          success: false,
          message:
            "Name, email and password are required."
        }
      );
    }

    if (name.length > 100) {
      return sendJSON(
        res,
        400,
        {
          success: false,
          message:
            "Name is too long."
        }
      );
    }

    if (email.length > 255) {
      return sendJSON(
        res,
        400,
        {
          success: false,
          message:
            "Email address is too long."
        }
      );
    }

    if (password.length < 6) {
      return sendJSON(
        res,
        400,
        {
          success: false,
          message:
            "Password must contain at least 6 characters."
        }
      );
    }

    const [existing] =
      await pool.execute(
        `
        SELECT id
        FROM users
        WHERE email = ?
        LIMIT 1
        `,
        [email]
      );

    if (existing.length) {
      return sendJSON(
        res,
        409,
        {
          success: false,
          message:
            "An account with this email already exists."
        }
      );
    }

    const passwordHash = await hashPassword(password);

    const [result] =
      await pool.execute(
        `
        INSERT INTO users
        (
          name,
          email,
          password_hash,
          role,
          email_verified,
          registration_status,
          student_verification_status,
          verified,
          created_at
        )
        VALUES (?, ?, ?, 'student', 0, 'pending', 'unverified', 0, NOW())
        `,
        [
          name,
          email,
          passwordHash
        ]
      );

    const token =
      createToken();

    await pool.execute(
      `
      INSERT INTO sessions
      (
        token,
        user_id,
        expires_at,
        created_at
      )
      VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR), NOW())
      `,
      [
        token,
        result.insertId,
        SESSION_LIFETIME_HOURS
      ]
    );

    // Automatic OTP generation & dispatch attempt on registration
    let emailSent = false;
    let registrationMessage = "Registration successful.";
    const rawOtp = generateOtp();
    const otpHash = hashOtp(rawOtp);

    try {
      if (isSmtpConfigured() || process.env.TEST_EMAIL_TRANSPORT === "json") {
        await sendOTPEmail(email, rawOtp, OTP_EXPIRY_MINUTES);
        await pool.execute("DELETE FROM email_otps WHERE email = ?", [email]);
        await pool.execute(
          `INSERT INTO email_otps (email, otp_hash, attempts, expires_at, created_at)
           VALUES (?, ?, 0, DATE_ADD(NOW(), INTERVAL ? MINUTE), NOW())`,
          [email, otpHash, OTP_EXPIRY_MINUTES]
        );
        emailSent = true;
        registrationMessage = "Registration successful! A 6-digit verification code has been sent to your email.";
      } else {
        registrationMessage = "Registration successful. Please configure SMTP in .env to receive verification emails.";
      }
    } catch (mailErr) {
      console.error("[AUTH] Automatic registration OTP email failed:", mailErr.message);
      registrationMessage = `Registration successful, but verification email could not be sent: ${mailErr.message}`;
    }

    return sendJSON(
      res,
      201,
      {
        success: true,
        token,
        emailSent,
        message: registrationMessage,

        user: {
          id: result.insertId,
          name,
          email,
          role: "student",
          emailVerified: false,
          registrationStatus: "pending",
          studentVerificationStatus: "unverified",
          verified: false
        }
      }
    );
  }

  /* =========================
     SEND / RESEND EMAIL OTP
  ========================= */

  if (
    req.method === "POST" &&
    (pathname === "/api/auth/send-otp" ||
      pathname === "/api/auth/resend-otp" ||
      pathname === "/api/auth/request-otp")
  ) {
    const body = await parseBody(req);
    let email = String(body.email || "")
      .trim()
      .toLowerCase();

    // Fallback to authenticated user email if not supplied in request body
    if (!email) {
      const currentUser = await getCurrentUser(req);
      if (currentUser && currentUser.email) {
        email = currentUser.email.toLowerCase();
      }
    }

    if (!email || !email.includes("@")) {
      return sendJSON(res, 400, {
        success: false,
        message: "A valid email address is required."
      });
    }

    const [userRows] = await pool.execute(
      `SELECT id, name, email, email_verified FROM users WHERE email = ? LIMIT 1`,
      [email]
    );

    if (userRows.length === 0) {
      return sendJSON(res, 404, {
        success: false,
        message: "No account found with this email address."
      });
    }

    const user = userRows[0];
    if (Boolean(user.email_verified)) {
      return sendJSON(res, 400, {
        success: false,
        message: "This email address is already verified."
      });
    }

    // Enforce 60-second resend cooldown
    const [recentOtps] = await pool.execute(
      `SELECT id, created_at, TIMESTAMPDIFF(SECOND, created_at, NOW()) AS elapsed_seconds
       FROM email_otps
       WHERE email = ?
       ORDER BY id DESC
       LIMIT 1`,
      [email]
    );

    if (recentOtps.length > 0) {
      const elapsed = Number(recentOtps[0].elapsed_seconds);
      if (elapsed !== null && elapsed < OTP_RESEND_COOLDOWN_SECONDS) {
        const waitSeconds = OTP_RESEND_COOLDOWN_SECONDS - elapsed;
        return sendJSON(res, 429, {
          success: false,
          message: `Please wait ${waitSeconds} second(s) before requesting another code.`,
          retryAfter: waitSeconds
        });
      }
    }

    const rawOtp = generateOtp();
    const otpHash = hashOtp(rawOtp);

    // Attempt real email dispatch via SMTP
    try {
      await sendOTPEmail(email, rawOtp, OTP_EXPIRY_MINUTES);
    } catch (mailErr) {
      console.error("[AUTH] Failed to send OTP email:", mailErr.message);
      return sendJSON(res, 503, {
        success: false,
        message: `Failed to deliver verification email: ${mailErr.message}. Real SMTP configuration is required.`
      });
    }

    // Persist hashed OTP; invalidate any previous codes for this email
    await pool.execute("DELETE FROM email_otps WHERE email = ?", [email]);
    await pool.execute(
      `INSERT INTO email_otps (email, otp_hash, attempts, expires_at, created_at)
       VALUES (?, ?, 0, DATE_ADD(NOW(), INTERVAL ? MINUTE), NOW())`,
      [email, otpHash, OTP_EXPIRY_MINUTES]
    );

    return sendJSON(res, 200, {
      success: true,
      message: "Verification code sent to your email address.",
      expiresInMinutes: OTP_EXPIRY_MINUTES
    });
  }

  /* =========================
     VERIFY EMAIL OTP
  ========================= */

  if (
    req.method === "POST" &&
    pathname === "/api/auth/verify-otp"
  ) {
    const body = await parseBody(req);
    let email = String(body.email || "")
      .trim()
      .toLowerCase();
    const otp = String(body.otp || body.code || "").trim();

    if (!email) {
      const currentUser = await getCurrentUser(req);
      if (currentUser && currentUser.email) {
        email = currentUser.email.toLowerCase();
      }
    }

    if (!email || !otp) {
      return sendJSON(res, 400, {
        success: false,
        message: "Email address and 6-digit verification code are required."
      });
    }

    if (!/^\d{6}$/.test(otp)) {
      return sendJSON(res, 400, {
        success: false,
        message: "Verification code must be exactly 6 digits."
      });
    }

    const [userRows] = await pool.execute(
      `SELECT id, name, email, email_verified FROM users WHERE email = ? LIMIT 1`,
      [email]
    );

    if (userRows.length === 0) {
      return sendJSON(res, 404, {
        success: false,
        message: "Account not found."
      });
    }

    const user = userRows[0];
    if (Boolean(user.email_verified)) {
      return sendJSON(res, 200, {
        success: true,
        message: "Email is already verified.",
        emailVerified: true
      });
    }

    const [otpRows] = await pool.execute(
      `SELECT id, otp_hash, attempts, expires_at,
              TIMESTAMPDIFF(SECOND, NOW(), expires_at) AS seconds_left
       FROM email_otps
       WHERE email = ?
       ORDER BY id DESC
       LIMIT 1`,
      [email]
    );

    if (otpRows.length === 0) {
      return sendJSON(res, 400, {
        success: false,
        message: "No active verification code found. Please request a new code."
      });
    }

    const otpRecord = otpRows[0];

    // Check expiration
    if (Number(otpRecord.seconds_left) <= 0) {
      await pool.execute("DELETE FROM email_otps WHERE id = ?", [otpRecord.id]);
      return sendJSON(res, 400, {
        success: false,
        message: "Verification code has expired. Please request a new code."
      });
    }

    // Check attempt limits (max 3)
    if (Number(otpRecord.attempts) >= 3) {
      await pool.execute("DELETE FROM email_otps WHERE id = ?", [otpRecord.id]);
      return sendJSON(res, 403, {
        success: false,
        message: "Too many failed attempts. This code has been invalidated. Please request a new code."
      });
    }

    const submittedHash = hashOtp(otp);
    if (submittedHash !== otpRecord.otp_hash) {
      const newAttempts = Number(otpRecord.attempts) + 1;
      await pool.execute(
        "UPDATE email_otps SET attempts = ? WHERE id = ?",
        [newAttempts, otpRecord.id]
      );

      const attemptsRemaining = 3 - newAttempts;
      if (attemptsRemaining <= 0) {
        await pool.execute("DELETE FROM email_otps WHERE id = ?", [otpRecord.id]);
        return sendJSON(res, 403, {
          success: false,
          message: "Incorrect verification code. Maximum attempts exceeded. Please request a new code."
        });
      }

      return sendJSON(res, 400, {
        success: false,
        message: `Incorrect verification code. ${attemptsRemaining} attempt(s) remaining.`,
        attemptsRemaining
      });
    }

    // Success! Single-use: delete from email_otps
    await pool.execute("DELETE FROM email_otps WHERE email = ?", [email]);

    // Strictly update email_verified only (do NOT alter registration_status or student_verification_status)
    await pool.execute(
      "UPDATE users SET email_verified = 1, updated_at = NOW() WHERE id = ?",
      [user.id]
    );

    return sendJSON(res, 200, {
      success: true,
      message: "Email verified successfully.",
      emailVerified: true
    });
  }

  /* =========================
     LOGIN
  ========================= */

  if (
    req.method === "POST" &&
    pathname ===
      "/api/auth/login"
  ) {
    const body =
      await parseBody(req);

    const email =
      String(
        body.email || ""
      )
        .trim()
        .toLowerCase();

    const password =
      String(
        body.password || ""
      );

    if (
      !email ||
      !password
    ) {
      return sendJSON(
        res,
        400,
        {
          success: false,
          message:
            "Email and password are required."
        }
      );
    }

    const clientIp = getClientIp(req);
    const loginRateKey = `rl:login:${email}::${clientIp}`;

    // Rate limiting check
    const rateCheck = await checkRateLimit(pool, loginRateKey, LOGIN_RATE_LIMIT_MAX_ATTEMPTS);
    if (rateCheck.limited) {
      res.setHeader("Retry-After", String(rateCheck.secondsRemaining));
      return sendJSON(res, 429, {
        success: false,
        message: `Too many failed login attempts. Please try again in ${Math.ceil(rateCheck.secondsRemaining / 60)} minutes.`,
        retryAfter: rateCheck.secondsRemaining
      });
    }

    const [rows] =
      await pool.execute(
        `
        SELECT
          id,
          name,
          email,
          password_hash,
          role,
          email_verified,
          registration_status,
          student_verification_status,
          verified
        FROM users
        WHERE email = ?
        LIMIT 1
        `,
        [email]
      );

    if (rows.length === 0) {
      await recordFailedAttempt(pool, loginRateKey, LOGIN_RATE_LIMIT_WINDOW_MINUTES);
      return sendJSON(
        res,
        401,
        {
          success: false,
          message:
            "Invalid email or password."
        }
      );
    }

    const user =
      rows[0];

    const isValidPassword =
      await verifyPassword(
        password,
        user.password_hash
      );

    if (!isValidPassword) {
      await recordFailedAttempt(pool, loginRateKey, LOGIN_RATE_LIMIT_WINDOW_MINUTES);
      return sendJSON(
        res,
        401,
        {
          success: false,
          message:
            "Invalid email or password."
        }
      );
    }

    // Reset failed login counter upon successful authentication
    await resetRateLimit(pool, loginRateKey);

    /*
      Transparent legacy-hash migration:
      If account is using legacy SHA-256, upgrade to bcrypt on successful login.
      Never reset or expose user password.
    */
    if (isLegacyHash(user.password_hash)) {
      try {
        const upgradedHash =
          await hashPassword(password);

        await pool.execute(
          `
          UPDATE users
          SET password_hash = ?,
              updated_at = NOW()
          WHERE id = ?
          `,
          [
            upgradedHash,
            user.id
          ]
        );

        console.log(
          `[AUTH] Upgraded legacy password hash to bcrypt for user ID ${user.id} (${user.email}).`
        );
      } catch (upgradeErr) {
        console.error(
          `[AUTH] Failed to upgrade legacy password hash for user ID ${user.id}:`,
          upgradeErr.message
        );
      }
    }

    const token =
      createToken();

    await pool.execute(
      `
      INSERT INTO sessions
      (
        token,
        user_id,
        expires_at,
        created_at
      )
      VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR), NOW())
      `,
      [
        token,
        user.id,
        SESSION_LIFETIME_HOURS
      ]
    );

    return sendJSON(
      res,
      200,
      {
        success: true,
        token,

        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role || "student",
          emailVerified: Boolean(user.email_verified),
          registrationStatus: user.registration_status || "pending",
          studentVerificationStatus: user.student_verification_status || "unverified",
          verified:
            Boolean(
              user.verified
            )
        }
      }
    );
  }

  /* =========================
     LOGOUT
  ========================= */

  if (
    req.method === "POST" &&
    pathname ===
      "/api/auth/logout"
  ) {
    const token =
      getToken(req);

    if (token) {
      await pool.execute(
        `
        DELETE FROM sessions
        WHERE token = ?
        `,
        [token]
      );
    }

    return sendJSON(
      res,
      200,
      {
        success: true,
        message:
          "Logged out successfully."
      }
    );
  }

  /* =========================
     FORGOT PASSWORD (PHASE 5)
  ========================= */

  if (
    req.method === "POST" &&
    pathname === "/api/auth/forgot-password"
  ) {
    const clientIp = getClientIp(req);
    const recoveryRateKey = `rl:recovery:${clientIp}`;

    // Rate limiting recovery requests
    const rateCheck = await checkRateLimit(pool, recoveryRateKey, RECOVERY_RATE_LIMIT_MAX_ATTEMPTS);
    if (rateCheck.limited) {
      res.setHeader("Retry-After", String(rateCheck.secondsRemaining));
      return sendJSON(res, 429, {
        success: false,
        message: "Too many password recovery requests. Please try again later.",
        retryAfter: rateCheck.secondsRemaining
      });
    }

    const body = await parseBody(req);
    const email = String(body.email || "").trim().toLowerCase();

    if (!email || !email.includes("@")) {
      return sendJSON(res, 400, {
        success: false,
        message: "A valid campus email address is required."
      });
    }

    // Record recovery attempt for rate limiting
    await recordFailedAttempt(pool, recoveryRateKey, RECOVERY_RATE_LIMIT_WINDOW_MINUTES);

    // Generic response regardless of whether email exists or not (anti-enumeration)
    const GENERIC_RESPONSE_MSG = "If that email address is registered, password reset instructions have been sent.";

    const [rows] = await pool.execute(
      "SELECT id, name, email FROM users WHERE email = ? LIMIT 1",
      [email]
    );

    if (rows.length === 0) {
      return sendJSON(res, 200, {
        success: true,
        message: GENERIC_RESPONSE_MSG
      });
    }

    const user = rows[0];

    // Generate cryptographic random reset token (32 bytes hex = 64 characters)
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    // Atomically persist token hash and expiry on user row
    await pool.execute(
      `UPDATE users
       SET password_reset_token_hash = ?,
           password_reset_expires_at = DATE_ADD(NOW(), INTERVAL ? MINUTE),
           password_reset_used_at = NULL,
           updated_at = NOW()
       WHERE id = ?`,
      [tokenHash, PASSWORD_RESET_EXPIRY_MINUTES, user.id]
    );

    // Build reset URL using validated application base URL (never untrusted host header)
    const baseUrl = getAppBaseUrl();
    const resetUrl = `${baseUrl}/#reset-password?token=${rawToken}`;

    // Dispatch email safely without leaking sensitive information
    try {
      await sendPasswordResetEmail(user.email, resetUrl, PASSWORD_RESET_EXPIRY_MINUTES);
    } catch (err) {
      // Never log raw tokens, reset URLs, passwords, or SMTP credentials
      console.error("[AUTH] Failed to send password reset email:", err.message);
    }

    return sendJSON(res, 200, {
      success: true,
      message: GENERIC_RESPONSE_MSG
    });
  }

  /* =========================
     VERIFY RESET TOKEN (PHASE 5)
  ========================= */

  if (
    req.method === "GET" &&
    pathname === "/api/auth/verify-reset-token"
  ) {
    const rawToken = String(url.searchParams.get("token") || "").trim();

    if (!rawToken) {
      return sendJSON(res, 400, {
        success: false,
        valid: false,
        message: "Reset token is required."
      });
    }

    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    const [rows] = await pool.execute(
      `SELECT id, password_reset_used_at, 
              UNIX_TIMESTAMP(password_reset_expires_at) - UNIX_TIMESTAMP(NOW()) AS seconds_remaining
       FROM users
       WHERE password_reset_token_hash = ?
       LIMIT 1`,
      [tokenHash]
    );

    if (rows.length === 0) {
      return sendJSON(res, 400, {
        success: false,
        valid: false,
        reason: "invalid",
        message: "Invalid or expired password reset token."
      });
    }

    const record = rows[0];

    if (record.password_reset_used_at !== null) {
      return sendJSON(res, 400, {
        success: false,
        valid: false,
        reason: "used",
        message: "This password reset token has already been used."
      });
    }

    if (Number(record.seconds_remaining) <= 0) {
      return sendJSON(res, 400, {
        success: false,
        valid: false,
        reason: "expired",
        message: "This password reset token has expired."
      });
    }

    return sendJSON(res, 200, {
      success: true,
      valid: true,
      message: "Reset token is valid."
    });
  }

  /* =========================
     RESET PASSWORD (PHASE 5)
  ========================= */

  if (
    req.method === "POST" &&
    pathname === "/api/auth/reset-password"
  ) {
    const clientIp = getClientIp(req);
    const resetRateKey = `rl:reset:${clientIp}`;

    // Rate limiting reset attempts
    const rateCheck = await checkRateLimit(pool, resetRateKey, RESET_RATE_LIMIT_MAX_ATTEMPTS);
    if (rateCheck.limited) {
      res.setHeader("Retry-After", String(rateCheck.secondsRemaining));
      return sendJSON(res, 429, {
        success: false,
        message: "Too many password reset attempts. Please try again later.",
        retryAfter: rateCheck.secondsRemaining
      });
    }

    const body = await parseBody(req);
    const rawToken = String(body.token || "").trim();
    const newPassword = String(body.newPassword || body.password || "");

    if (!rawToken) {
      return sendJSON(res, 400, {
        success: false,
        message: "Reset token is required."
      });
    }

    if (!newPassword || newPassword.length < 6) {
      return sendJSON(res, 400, {
        success: false,
        message: "Password must be at least 6 characters long."
      });
    }

    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    // Atomically validate and consume token within a transaction with row lock
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [users] = await conn.execute(
        `SELECT id, email, password_reset_token_hash, password_reset_expires_at, password_reset_used_at,
                UNIX_TIMESTAMP(password_reset_expires_at) - UNIX_TIMESTAMP(NOW()) AS seconds_remaining
         FROM users
         WHERE password_reset_token_hash = ?
         FOR UPDATE`,
        [tokenHash]
      );

      if (users.length === 0) {
        await conn.rollback();
        await recordFailedAttempt(pool, resetRateKey, RESET_RATE_LIMIT_WINDOW_MINUTES);
        return sendJSON(res, 400, {
          success: false,
          message: "Invalid or expired password reset token."
        });
      }

      const userRecord = users[0];

      if (userRecord.password_reset_used_at !== null) {
        await conn.rollback();
        await recordFailedAttempt(pool, resetRateKey, RESET_RATE_LIMIT_WINDOW_MINUTES);
        return sendJSON(res, 400, {
          success: false,
          message: "This password reset token has already been used."
        });
      }

      if (Number(userRecord.seconds_remaining) <= 0) {
        await conn.rollback();
        await recordFailedAttempt(pool, resetRateKey, RESET_RATE_LIMIT_WINDOW_MINUTES);
        return sendJSON(res, 400, {
          success: false,
          message: "This password reset token has expired."
        });
      }

      // Hash new password using bcrypt with standard work factor
      const newHash = await hashPassword(newPassword);

      // Atomically update password, mark token as used, and clear token hash
      await conn.execute(
        `UPDATE users
         SET password_hash = ?,
             password_reset_used_at = NOW(),
             password_reset_token_hash = NULL,
             updated_at = NOW()
         WHERE id = ?`,
        [newHash, userRecord.id]
      );

      // Invalidate all existing active sessions for this user
      await conn.execute(
        "DELETE FROM sessions WHERE user_id = ?",
        [userRecord.id]
      );

      await conn.commit();

      // Reset any failure counter for this IP
      await resetRateLimit(pool, resetRateKey);

      return sendJSON(res, 200, {
        success: true,
        message: "Password has been reset successfully. Please login with your new password."
      });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /* =========================
     CURRENT USER
  ========================= */

  if (
    req.method === "GET" &&
    pathname === "/api/me"
  ) {
    const user =
      await getCurrentUser(req);

    if (!user) {
      return sendJSON(
        res,
        401,
        {
          success: false,
          message:
            "Not logged in."
        }
      );
    }

    return sendJSON(
      res,
      200,
      {
        success: true,

        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role || "student",
          emailVerified: Boolean(user.email_verified),
          registrationStatus: user.registration_status || "pending",
          registrationRejectionReason: user.registration_rejection_reason || null,
          studentVerificationStatus: user.student_verification_status || "unverified",
          verified:
            Boolean(
              user.verified
            )
        }
      }
    );
  }

  /* ========================================================
     ADMIN: REGISTRATION APPROVAL & MANAGEMENT ENDPOINTS
  ======================================================== */

  // 1. LIST REGISTRATIONS (GET /api/admin/registrations)
  if (
    req.method === "GET" &&
    pathname === "/api/admin/registrations"
  ) {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const statusFilter = (url.searchParams.get("status") || "pending").toLowerCase();
    const allowedStatuses = ["pending", "approved", "rejected", "all"];
    if (!allowedStatuses.includes(statusFilter)) {
      return sendJSON(res, 400, {
        success: false,
        message: "Invalid status filter. Allowed values: pending, approved, rejected, all."
      });
    }

    const pageParam = parseInt(url.searchParams.get("page") || "1", 10);
    const page = Number.isInteger(pageParam) && pageParam > 0 ? pageParam : 1;

    const limitParam = parseInt(url.searchParams.get("limit") || "20", 10);
    const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 20;

    const offset = (page - 1) * limit;
    const search = (url.searchParams.get("search") || "").trim();

    let countSql = "SELECT COUNT(*) AS total FROM users WHERE role = 'student'";
    let dataSql = `SELECT u.id, u.name, u.email, u.role, u.email_verified, u.registration_status,
                          u.registration_reviewed_by, u.registration_reviewed_at, u.registration_rejection_reason,
                          u.student_verification_status, u.verified, u.created_at,
                          rev.name AS reviewer_name, rev.email AS reviewer_email
                   FROM users u
                   LEFT JOIN users rev ON rev.id = u.registration_reviewed_by
                   WHERE u.role = 'student'`;
    const countParams = [];
    const dataParams = [];

    if (statusFilter !== "all") {
      countSql += " AND registration_status = ?";
      dataSql += " AND u.registration_status = ?";
      countParams.push(statusFilter);
      dataParams.push(statusFilter);
    }

    if (search) {
      const term = `%${search}%`;
      countSql += " AND (name LIKE ? OR email LIKE ?)";
      dataSql += " AND (u.name LIKE ? OR u.email LIKE ?)";
      countParams.push(term, term);
      dataParams.push(term, term);
    }

    dataSql += " ORDER BY u.created_at DESC LIMIT ? OFFSET ?";
    dataParams.push(limit, offset);

    const [countResult] = await pool.execute(countSql, countParams);
    const total = Number(countResult[0]?.total || 0);

    const [rows] = await pool.execute(dataSql, dataParams);
    const registrations = rows.map(r => ({
      id: r.id,
      name: r.name,
      email: r.email,
      role: r.role,
      emailVerified: Boolean(r.email_verified),
      registrationStatus: r.registration_status,
      registrationReviewedBy: r.registration_reviewed_by,
      registrationReviewedAt: r.registration_reviewed_at,
      registrationRejectionReason: r.registration_rejection_reason,
      reviewerName: r.reviewer_name || null,
      reviewerEmail: r.reviewer_email || null,
      studentVerificationStatus: r.student_verification_status,
      verified: Boolean(r.verified),
      createdAt: r.created_at
    }));

    return sendJSON(res, 200, {
      success: true,
      registrations,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1
      }
    });
  }

  // 2. VIEW SINGLE REGISTRATION DETAILS (GET /api/admin/registrations/:id)
  const adminSingleRegMatch = pathname.match(/^\/api\/admin\/registrations\/([^\/]+)$/);
  if (req.method === "GET" && adminSingleRegMatch) {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const rawId = adminSingleRegMatch[1];
    const regId = parseInt(rawId, 10);
    if (!Number.isInteger(regId) || regId <= 0 || String(regId) !== rawId) {
      return sendJSON(res, 400, {
        success: false,
        message: "Invalid registration ID."
      });
    }

    const [rows] = await pool.execute(
      `SELECT u.id, u.name, u.email, u.role, u.email_verified, u.registration_status,
              u.registration_reviewed_by, u.registration_reviewed_at, u.registration_rejection_reason,
              u.student_verification_status, u.verified, u.created_at,
              rev.name AS reviewer_name, rev.email AS reviewer_email
       FROM users u
       LEFT JOIN users rev ON rev.id = u.registration_reviewed_by
       WHERE u.id = ? AND u.role = 'student'
       LIMIT 1`,
      [regId]
    );

    if (rows.length === 0) {
      return sendJSON(res, 404, {
        success: false,
        message: "Registration not found."
      });
    }

    const r = rows[0];
    return sendJSON(res, 200, {
      success: true,
      registration: {
        id: r.id,
        name: r.name,
        email: r.email,
        role: r.role,
        emailVerified: Boolean(r.email_verified),
        registrationStatus: r.registration_status,
        registrationReviewedBy: r.registration_reviewed_by,
        registrationReviewedAt: r.registration_reviewed_at,
        registrationRejectionReason: r.registration_rejection_reason,
        reviewerName: r.reviewer_name || null,
        reviewerEmail: r.reviewer_email || null,
        studentVerificationStatus: r.student_verification_status,
        verified: Boolean(r.verified),
        createdAt: r.created_at
      }
    });
  }

  // 3. APPROVE REGISTRATION (POST /api/admin/registrations/:id/approve)
  const adminApproveMatch = pathname.match(/^\/api\/admin\/registrations\/([^\/]+)\/approve$/);
  if (req.method === "POST" && adminApproveMatch) {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const rawId = adminApproveMatch[1];
    const regId = parseInt(rawId, 10);
    if (!Number.isInteger(regId) || regId <= 0 || String(regId) !== rawId) {
      return sendJSON(res, 400, {
        success: false,
        message: "Invalid registration ID."
      });
    }

    const [rows] = await pool.execute(
      "SELECT id, role, registration_status FROM users WHERE id = ? LIMIT 1",
      [regId]
    );

    if (rows.length === 0) {
      return sendJSON(res, 404, {
        success: false,
        message: "Registration record not found."
      });
    }

    const target = rows[0];
    if (target.role === "admin") {
      return sendJSON(res, 400, {
        success: false,
        message: "Cannot modify administrator accounts."
      });
    }

    if (target.registration_status === "approved") {
      return sendJSON(res, 400, {
        success: false,
        message: "Registration is already approved."
      });
    }

    if (target.registration_status === "rejected") {
      return sendJSON(res, 400, {
        success: false,
        message: "Cannot approve a rejected registration directly without an explicit re-review."
      });
    }

    await pool.execute(
      `UPDATE users
       SET registration_status = 'approved',
           registration_reviewed_by = ?,
           registration_reviewed_at = NOW(),
           registration_rejection_reason = NULL,
           updated_at = NOW()
       WHERE id = ?`,
      [admin.id, regId]
    );

    return sendJSON(res, 200, {
      success: true,
      message: "Registration approved successfully.",
      registrationStatus: "approved"
    });
  }

  // 4. REJECT REGISTRATION (POST /api/admin/registrations/:id/reject)
  const adminRejectMatch = pathname.match(/^\/api\/admin\/registrations\/([^\/]+)\/reject$/);
  if (req.method === "POST" && adminRejectMatch) {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const rawId = adminRejectMatch[1];
    const regId = parseInt(rawId, 10);
    if (!Number.isInteger(regId) || regId <= 0 || String(regId) !== rawId) {
      return sendJSON(res, 400, {
        success: false,
        message: "Invalid registration ID."
      });
    }

    const [rows] = await pool.execute(
      "SELECT id, role, registration_status FROM users WHERE id = ? LIMIT 1",
      [regId]
    );

    if (rows.length === 0) {
      return sendJSON(res, 404, {
        success: false,
        message: "Registration record not found."
      });
    }

    const target = rows[0];
    if (target.role === "admin") {
      return sendJSON(res, 400, {
        success: false,
        message: "Cannot modify administrator accounts."
      });
    }

    if (target.registration_status === "rejected") {
      return sendJSON(res, 400, {
        success: false,
        message: "Registration is already rejected."
      });
    }

    const body = await parseBody(req);
    const reason = String(body.reason || "").trim().slice(0, 255) || null;

    await pool.execute(
      `UPDATE users
       SET registration_status = 'rejected',
           registration_reviewed_by = ?,
           registration_reviewed_at = NOW(),
           registration_rejection_reason = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [admin.id, reason, regId]
    );

    // Invalidate active sessions immediately upon rejection
    await pool.execute("DELETE FROM sessions WHERE user_id = ?", [regId]);

    return sendJSON(res, 200, {
      success: true,
      message: "Registration rejected successfully.",
      registrationStatus: "rejected",
      reason: reason || undefined
    });
  }

  // 5. RE-REVIEW REGISTRATION (POST /api/admin/registrations/:id/re-review)
  const adminReReviewMatch = pathname.match(/^\/api\/admin\/registrations\/([^\/]+)\/re-review$/);
  if (req.method === "POST" && adminReReviewMatch) {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const rawId = adminReReviewMatch[1];
    const regId = parseInt(rawId, 10);
    if (!Number.isInteger(regId) || regId <= 0 || String(regId) !== rawId) {
      return sendJSON(res, 400, {
        success: false,
        message: "Invalid registration ID."
      });
    }

    const [rows] = await pool.execute(
      "SELECT id, role, registration_status FROM users WHERE id = ? LIMIT 1",
      [regId]
    );

    if (rows.length === 0) {
      return sendJSON(res, 404, {
        success: false,
        message: "Registration record not found."
      });
    }

    const target = rows[0];
    if (target.role === "admin") {
      return sendJSON(res, 400, {
        success: false,
        message: "Cannot modify administrator accounts."
      });
    }

    if (target.registration_status !== "rejected") {
      return sendJSON(res, 400, {
        success: false,
        message: "Only rejected registrations can be moved to re-review."
      });
    }

    await pool.execute(
      `UPDATE users
       SET registration_status = 'pending',
           registration_reviewed_by = ?,
           registration_reviewed_at = NOW(),
           registration_rejection_reason = NULL,
           updated_at = NOW()
       WHERE id = ?`,
      [admin.id, regId]
    );

    return sendJSON(res, 200, {
      success: true,
      message: "Registration returned to pending for re-review.",
      registrationStatus: "pending"
    });
  }

  /* =========================
     PRODUCTS LIST: GET /api/products
  ========================= */

  if (
    req.method === "GET" &&
    pathname ===
      "/api/products"
  ) {
    const search =
      url.searchParams.get(
        "search"
      ) || "";

    const category =
      url.searchParams.get(
        "category"
      ) || "";

    const statusParam =
      url.searchParams.get(
        "status"
      );

    const sellerIdParam =
      url.searchParams.get(
        "sellerId"
      );

    let query = `
      SELECT
        p.id,
        p.name,
        p.category,
        p.price,
        p.description,
        p.seller_id,
        p.status,
        p.created_at,
        u.name AS seller_name,
        u.verified AS seller_verified
      FROM products p
      LEFT JOIN users u
        ON u.id = p.seller_id
      WHERE 1=1
    `;

    const params = [];

    const currentUser = await getCurrentUser(req);

    // Filter by status: default to 'active' only
    if (statusParam === "sold") {
      query += ` AND p.status = 'sold'`;
    } else if (statusParam === "archived") {
      // Archived listings are strictly private to the listing owner or an admin
      if (!currentUser) {
        query += ` AND 1=0`;
      } else if (currentUser.role === "admin") {
        query += ` AND p.status = 'archived'`;
      } else {
        // Authenticated non-admin: can only retrieve their own archived listings
        if (sellerIdParam && Number(sellerIdParam) !== currentUser.id) {
          query += ` AND 1=0`;
        } else {
          query += ` AND p.status = 'archived' AND p.seller_id = ?`;
          params.push(currentUser.id);
        }
      }
    } else if (statusParam === "all") {
      if (currentUser && currentUser.role === "admin") {
        // Admin sees all
      } else if (currentUser && sellerIdParam && Number(sellerIdParam) === currentUser.id) {
        // Seller sees all their own listings
      } else {
        query += ` AND p.status != 'archived'`;
      }
    } else {
      // Default: only active products are returned in the catalog
      query += ` AND p.status = 'active'`;
    }

    if (sellerIdParam) {
      if (statusParam !== "archived" || currentUser?.role === "admin") {
        query += ` AND p.seller_id = ?`;
        params.push(Number(sellerIdParam));
      }
    }

    if (search) {
      query += `
        AND (
          p.name LIKE ?
          OR p.description LIKE ?
          OR p.category LIKE ?
        )
      `;

      const term =
        `%${search}%`;

      params.push(
        term,
        term,
        term
      );
    }

    if (category) {
      query += `
        AND p.category = ?
      `;

      params.push(
        category
      );
    }

    query += `
      ORDER BY p.created_at DESC
    `;

    const [rows] =
      await pool.execute(
        query,
        params
      );

    const products =
      rows.map(
        product => ({
          id: product.id,

          name:
            product.name,

          category:
            product.category,

          price:
            Number(
              product.price
            ),

          description:
            product.description,

          sellerId:
            product.seller_id,

          status:
            product.status || "active",

          seller:
            product.seller_name ||
            "Unknown Seller",

          verified:
            Boolean(
              product.seller_verified
            ),

          createdAt:
            product.created_at
        })
      );

    return sendJSON(
      res,
      200,
      {
        success: true,
        products
      }
    );
  }

  /* =========================
     SINGLE PRODUCT: GET /api/products/:productId
  ========================= */

  const productMatch =
    pathname.match(
      /^\/api\/products\/(\d+)$/
    );

  if (
    req.method === "GET" &&
    productMatch
  ) {
    const productId =
      Number(
        productMatch[1]
      );

    const [rows] =
      await pool.execute(
        `
        SELECT
          p.id,
          p.name,
          p.category,
          p.price,
          p.description,
          p.seller_id,
          p.status,
          p.created_at,
          u.name AS seller_name,
          u.email AS seller_email,
          u.verified AS seller_verified
        FROM products p
        LEFT JOIN users u
          ON u.id = p.seller_id
        WHERE p.id = ?
        LIMIT 1
        `,
        [productId]
      );

    if (!rows.length) {
      return sendJSON(
        res,
        404,
        {
          success: false,
          message:
            "Product not found."
        }
      );
    }

    const product =
      rows[0];

    if (product.status === "archived") {
      const currentUser = await getCurrentUser(req);
      let allowed = false;

      if (currentUser) {
        if (currentUser.id === product.seller_id || currentUser.role === "admin") {
          allowed = true;
        } else if (
          currentUser.email_verified &&
          (currentUser.registration_status === "approved" || currentUser.role === "admin")
        ) {
          const [threadRows] = await pool.execute(
            `SELECT id FROM chat_threads WHERE product_id = ? AND (buyer_id = ? OR seller_id = ?) LIMIT 1`,
            [productId, currentUser.id, currentUser.id]
          );
          if (threadRows.length > 0) {
            allowed = true;
          }
        }
      }

      if (!allowed) {
        return sendJSON(res, 404, {
          success: false,
          message: "Product not found."
        });
      }
    }

    return sendJSON(
      res,
      200,
      {
        success: true,

        product: {
          id: product.id,

          name:
            product.name,

          category:
            product.category,

          price:
            Number(
              product.price
            ),

          description:
            product.description,

          sellerId:
            product.seller_id,

          status:
            product.status || "active",

          seller:
            product.seller_name,

          sellerEmail:
            product.seller_email,

          verified:
            Boolean(
              product.seller_verified
            ),

          createdAt:
            product.created_at
        }
      }
    );
  }

  /* =========================
     EDIT PRODUCT: PUT /api/products/:productId
  ========================= */

  if (
    req.method === "PUT" &&
    productMatch
  ) {
    const user =
      await requireApprovedUser(
        req,
        res,
        "Authentication required to edit listings."
      );
    if (!user) return;

    const productId =
      Number(
        productMatch[1]
      );

    const [pRows] =
      await pool.execute(
        `SELECT id, name, category, price, description, seller_id, status FROM products WHERE id = ? LIMIT 1`,
        [productId]
      );

    if (pRows.length === 0) {
      return sendJSON(
        res,
        404,
        {
          success: false,
          message:
            "Product not found."
        }
      );
    }

    const product =
      pRows[0];

    // Enforce ownership: only seller or admin can edit
    if (user.role !== "admin" && product.seller_id !== user.id) {
      return sendJSON(
        res,
        403,
        {
          success: false,
          message:
            "You are not authorized to edit this listing."
        }
      );
    }

    if (product.status === "archived" && user.role !== "admin") {
      return sendJSON(
        res,
        400,
        {
          success: false,
          message:
            "Archived listings cannot be edited."
        }
      );
    }

    const body =
      await parseBody(req);

    const name =
      String(
        body.name !== undefined ? body.name : product.name
      ).trim();

    const category =
      String(
        body.category !== undefined ? body.category : product.category
      ).trim();

    const description =
      String(
        body.description !== undefined ? body.description : product.description
      ).trim();

    const rawPrice =
      body.price !== undefined ? body.price : product.price;
    const price =
      Number(rawPrice);

    const ALLOWED_CATEGORIES = [
      "Books",
      "Electronics",
      "Furniture",
      "Accessories"
    ];

    if (
      !name ||
      !category ||
      !description ||
      !Number.isFinite(price)
    ) {
      return sendJSON(
        res,
        400,
        {
          success: false,
          message:
            "Please fill all product details correctly."
        }
      );
    }

    if (!ALLOWED_CATEGORIES.includes(category)) {
      return sendJSON(
        res,
        400,
        {
          success: false,
          message:
            "Invalid product category. Allowed categories: " +
            ALLOWED_CATEGORIES.join(", ")
        }
      );
    }

    if (price < 0) {
      return sendJSON(
        res,
        400,
        {
          success: false,
          message:
            "Price cannot be negative."
        }
      );
    }

    if (name.length > 255) {
      return sendJSON(
        res,
        400,
        {
          success: false,
          message:
            "Product name is too long (maximum 255 characters)."
        }
      );
    }

    await pool.execute(
      `UPDATE products SET name = ?, category = ?, price = ?, description = ? WHERE id = ?`,
      [name, category, price, description, productId]
    );

    return sendJSON(
      res,
      200,
      {
        success: true,
        message:
          "Product listing updated successfully.",
        product: {
          id: productId,
          name,
          category,
          price,
          description,
          sellerId: product.seller_id,
          status: product.status || "active"
        }
      }
    );
  }

  /* =========================
     ARCHIVE PRODUCT: DELETE /api/products/:productId
  ========================= */

  if (
    req.method === "DELETE" &&
    productMatch
  ) {
    const user =
      await requireApprovedUser(
        req,
        res,
        "Authentication required to archive listings."
      );
    if (!user) return;

    const productId =
      Number(
        productMatch[1]
      );

    const [pRows] =
      await pool.execute(
        `SELECT id, seller_id, status FROM products WHERE id = ? LIMIT 1`,
        [productId]
      );

    if (pRows.length === 0) {
      return sendJSON(
        res,
        404,
        {
          success: false,
          message:
            "Product not found."
        }
      );
    }

    const product =
      pRows[0];

    // Enforce ownership: only seller or admin can archive
    if (user.role !== "admin" && product.seller_id !== user.id) {
      return sendJSON(
        res,
        403,
        {
          success: false,
          message:
            "You are not authorized to archive this listing."
        }
      );
    }

    // Soft-archival only — NEVER execute physical DELETE to preserve foreign key cascades and chat threads
    await pool.execute(
      `UPDATE products SET status = 'archived' WHERE id = ?`,
      [productId]
    );

    return sendJSON(
      res,
      200,
      {
        success: true,
        message:
          "Product listing archived successfully.",
        productId,
        status: "archived"
      }
    );
  }

  /* =========================
     TOGGLE STATUS: PATCH /api/products/:productId/status
  ========================= */

  const productStatusMatch =
    pathname.match(
      /^\/api\/products\/(\d+)\/status$/
    );

  if (
    req.method === "PATCH" &&
    productStatusMatch
  ) {
    const user =
      await requireApprovedUser(
        req,
        res,
        "Authentication required to update listing status."
      );
    if (!user) return;

    const productId =
      Number(
        productStatusMatch[1]
      );

    const [pRows] =
      await pool.execute(
        `SELECT id, seller_id, status FROM products WHERE id = ? LIMIT 1`,
        [productId]
      );

    if (pRows.length === 0) {
      return sendJSON(
        res,
        404,
        {
          success: false,
          message:
            "Product not found."
        }
      );
    }

    const product =
      pRows[0];

    // Enforce ownership: only seller or admin can update status
    if (user.role !== "admin" && product.seller_id !== user.id) {
      return sendJSON(
        res,
        403,
        {
          success: false,
          message:
            "You are not authorized to update the status of this listing."
        }
      );
    }

    if (product.status === "archived") {
      return sendJSON(
        res,
        400,
        {
          success: false,
          message:
            "Archived listings cannot be updated."
        }
      );
    }

    const body =
      await parseBody(req);

    const newStatus =
      String(body.status || "")
        .trim()
        .toLowerCase();

    const ALLOWED_STATUSES = [
      "active",
      "sold"
    ];

    if (!ALLOWED_STATUSES.includes(newStatus)) {
      return sendJSON(
        res,
        400,
        {
          success: false,
          message:
            "Invalid status value. Allowed statuses: " +
            ALLOWED_STATUSES.join(", ")
        }
      );
    }

    await pool.execute(
      `UPDATE products SET status = ? WHERE id = ?`,
      [newStatus, productId]
    );

    return sendJSON(
      res,
      200,
      {
        success: true,
        message:
          `Product status updated to ${newStatus}.`,
        product: {
          id: productId,
          status: newStatus
        }
      }
    );
  }

  /* =========================
     SELL PRODUCT
  ========================= */

  if (
    req.method === "POST" &&
    pathname ===
      "/api/products"
  ) {
    const user =
      await getCurrentUser(req);

    if (!user) {
      return sendJSON(
        res,
        401,
        {
          success: false,
          message:
            "Please login before selling a product."
        }
      );
    }

    if (!user.email_verified) {
      return sendJSON(
        res,
        403,
        {
          success: false,
          message:
            "Please verify your email before listing products."
        }
      );
    }

    if (user.role !== "admin" && user.registration_status !== "approved") {
      return sendJSON(
        res,
        403,
        {
          success: false,
          message:
            user.registration_status === "rejected"
              ? "Your registration has been rejected. Marketplace access is disabled."
              : "Your registration is pending admin approval."
        }
      );
    }

    const body =
      await parseBody(req);

    const name =
      String(
        body.name || ""
      ).trim();

    const category =
      String(
        body.category || ""
      ).trim();

    const description =
      String(
        body.description || ""
      ).trim();

    const price =
      Number(
        body.price
      );

    if (
      !name ||
      !category ||
      !description ||
      !Number.isFinite(price)
    ) {
      return sendJSON(
        res,
        400,
        {
          success: false,
          message:
            "Please fill all product details correctly."
        }
      );
    }

    if (price < 0) {
      return sendJSON(
        res,
        400,
        {
          success: false,
          message:
            "Price cannot be negative."
        }
      );
    }

    const [result] =
      await pool.execute(
        `
        INSERT INTO products
        (
          name,
          category,
          price,
          description,
          seller_id,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, NOW())
        `,
        [
          name,
          category,
          price,
          description,
          user.id
        ]
      );

    return sendJSON(
      res,
      201,
      {
        success: true,

        message:
          "Product listed successfully.",

        product: {
          id:
            result.insertId,

          name,

          category,

          price,

          description,

          sellerId:
            user.id,

          seller:
            user.name,

          verified:
            Boolean(
              user.verified
            )
        }
      }
    );
  }

  /* =========================
     VERIFICATION
  ========================= */

  if (
    req.method === "POST" &&
    pathname ===
      "/api/verification"
  ) {
    const user =
      await getCurrentUser(req);

    if (!user) {
      return sendJSON(
        res,
        401,
        {
          success: false,
          message:
            "Please login before submitting verification."
        }
      );
    }

    if (!user.email_verified) {
      return sendJSON(
        res,
        403,
        {
          success: false,
          message:
            "Please verify your email before submitting student ID verification."
        }
      );
    }

    if (user.role !== "admin" && user.registration_status !== "approved") {
      return sendJSON(
        res,
        403,
        {
          success: false,
          message:
            user.registration_status === "rejected"
              ? "Your registration has been rejected. Student ID verification is disabled."
              : "Your registration is pending admin approval."
        }
      );
    }

    const body =
      await parseBody(req);

    const studentName =
      String(
        body.studentName || body.name || ""
      ).trim();

    const studentEmail =
      String(
        body.studentEmail || body.email || ""
      )
        .trim()
        .toLowerCase();

    const studentId =
      String(
        body.studentId || ""
      ).trim();

    const department =
      String(
        body.department || ""
      ).trim();

    const documentName =
      safeFileName(
        body.documentName || body.fileName ||
          "college_id"
      );

    const documentData =
      String(
        body.documentData || body.fileData || ""
      );

    if (
      !studentName ||
      !studentEmail ||
      !studentId ||
      !department ||
      !documentData
    ) {
      return sendJSON(
        res,
        400,
        {
          success: false,
          message:
            "Please complete all verification fields."
        }
      );
    }

    /*
      The frontend sends the document
      as Base64 or a data URL.

      Example:

      data:application/pdf;base64,....

      We store the complete value in MySQL.
    */

    const cleanedDocumentData =
      documentData.includes(",")
        ? documentData
            .split(",")
            .slice(1)
            .join(",")
        : documentData;

    if (!cleanedDocumentData) {
      return sendJSON(
        res,
        400,
        {
          success: false,
          message:
            "Invalid verification document."
        }
      );
    }

    try {
      await pool.execute(
        `
        INSERT INTO verification
        (
          user_id,
          student_name,
          student_email,
          student_id,
          department,
          document_name,
          document_path,
          document_data,
          status,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW())
        `,
        [
          user.id,
          studentName,
          studentEmail,
          studentId,
          department,
          documentName,
          "mysql",
          documentData
        ]
      );

      await pool.execute(
        `UPDATE users
         SET student_verification_status = 'pending',
             updated_at = NOW()
         WHERE id = ?`,
        [user.id]
      );

      return sendJSON(
        res,
        200,
        {
          success: true,
          message:
            "Verification submitted successfully.",
          status:
            "pending",
          user: {
            id: user.id,
            name: studentName,
            email: studentEmail,
            studentId,
            department
          }
        }
      );

    } catch (error) {
      console.error(
        "Verification database error:",
        error
      );

      return sendJSON(
        res,
        500,
        {
          success: false,
          message:
            "Could not save verification document."
        }
      );
    }
  }

  /* =========================================================
     PHASE 6: CHAT PRIVACY & PARTICIPANT AUTHORIZATION
  ========================================================= */

  /* ---------------------------------------------------------
     1. LIST USER THREADS: GET /api/chats/threads
  --------------------------------------------------------- */
  if (req.method === "GET" && pathname === "/api/chats/threads") {
    const user = await requireChatUser(req, res);
    if (!user) return;

    const [rows] = await pool.execute(
      `SELECT
        t.id,
        t.product_id AS productId,
        t.buyer_id AS buyerId,
        t.seller_id AS sellerId,
        t.last_message_at AS lastMessageAt,
        t.created_at AS createdAt,
        p.name AS productName,
        p.price AS productPrice,
        p.status AS productStatus,
        buyer.name AS buyerName,
        seller.name AS sellerName,
        (SELECT m.message FROM chat_messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS lastMessage,
        (SELECT m.created_at FROM chat_messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS lastMessageTime,
        (SELECT m.sender_id FROM chat_messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS lastSenderId
      FROM chat_threads t
      JOIN products p ON p.id = t.product_id
      JOIN users buyer ON buyer.id = t.buyer_id
      JOIN users seller ON seller.id = t.seller_id
      WHERE t.buyer_id = ? OR t.seller_id = ?
      ORDER BY t.last_message_at DESC`,
      [user.id, user.id]
    );

    const threads = rows.map(t => {
      const isSeller = t.sellerId === user.id;
      return {
        id: t.id,
        productId: t.productId,
        productName: t.productName,
        productPrice: Number(t.productPrice),
        productStatus: t.productStatus,
        buyerId: t.buyerId,
        buyerName: t.buyerName,
        sellerId: t.sellerId,
        sellerName: t.sellerName,
        counterpartyName: isSeller ? t.buyerName : t.sellerName,
        userRole: isSeller ? "seller" : "buyer",
        lastMessage: t.lastMessage || "",
        lastMessageTime: t.lastMessageTime || t.lastMessageAt,
        isLastSenderSelf: t.lastSenderId === user.id
      };
    });

    return sendJSON(res, 200, {
      success: true,
      threads
    });
  }

  /* ---------------------------------------------------------
     2. GET SINGLE THREAD MESSAGES: GET /api/chats/thread/:threadId
  --------------------------------------------------------- */
  const singleThreadMatch = pathname.match(/^\/api\/chats\/thread\/(\d+)$/);

  if (req.method === "GET" && singleThreadMatch) {
    const user = await requireChatUser(req, res);
    if (!user) return;

    const threadId = Number(singleThreadMatch[1]);

    const [tRows] = await pool.execute(
      `SELECT
        t.id,
        t.product_id AS productId,
        t.buyer_id AS buyerId,
        t.seller_id AS sellerId,
        p.name AS productName,
        p.price AS productPrice,
        buyer.name AS buyerName,
        seller.name AS sellerName
      FROM chat_threads t
      JOIN products p ON p.id = t.product_id
      JOIN users buyer ON buyer.id = t.buyer_id
      JOIN users seller ON seller.id = t.seller_id
      WHERE t.id = ?
      LIMIT 1`,
      [threadId]
    );

    if (tRows.length === 0) {
      return sendJSON(res, 404, {
        success: false,
        message: "Conversation not found."
      });
    }

    const thread = tRows[0];

    // Enforce participant authorization
    if (thread.buyerId !== user.id && thread.sellerId !== user.id) {
      return sendJSON(res, 403, {
        success: false,
        message: "You are not authorized to view this conversation."
      });
    }

    const [mRows] = await pool.execute(
      `SELECT
        m.id,
        m.thread_id AS threadId,
        m.sender_id AS senderId,
        u.name AS sender,
        m.message,
        m.created_at AS createdAt
      FROM chat_messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.thread_id = ?
      ORDER BY m.created_at ASC, m.id ASC`,
      [threadId]
    );

    return sendJSON(res, 200, {
      success: true,
      thread: {
        id: thread.id,
        productId: thread.productId,
        productName: thread.productName,
        productPrice: Number(thread.productPrice),
        buyerId: thread.buyerId,
        buyerName: thread.buyerName,
        sellerId: thread.sellerId,
        sellerName: thread.sellerName,
        userRole: thread.sellerId === user.id ? "seller" : "buyer"
      },
      messages: mRows.map(m => ({
        id: m.id,
        threadId: m.threadId,
        productId: thread.productId,
        senderId: m.senderId,
        sender: m.sender || "Student",
        message: m.message,
        text: m.message,
        createdAt: m.createdAt,
        isSelf: m.senderId === user.id
      }))
    });
  }

  /* ---------------------------------------------------------
     3. SEND MESSAGE TO THREAD: POST /api/chats/thread/:threadId
  --------------------------------------------------------- */
  if (req.method === "POST" && singleThreadMatch) {
    const user = await requireChatUser(req, res);
    if (!user) return;

    const threadId = Number(singleThreadMatch[1]);

    const body = await parseBody(req);
    const rawMsg = body.message !== undefined ? body.message : body.text;

    if (typeof rawMsg !== "string") {
      return sendJSON(res, 400, {
        success: false,
        message: "Message content must be text."
      });
    }

    const message = rawMsg.trim();
    if (!message) {
      return sendJSON(res, 400, {
        success: false,
        message: "Message cannot be empty."
      });
    }

    if (message.length > 2000) {
      return sendJSON(res, 400, {
        success: false,
        message: "Message is too long. Maximum allowed length is 2000 characters."
      });
    }

    const [tRows] = await pool.execute(
      `SELECT t.id, t.product_id AS productId, t.buyer_id AS buyerId, t.seller_id AS sellerId
       FROM chat_threads t
       WHERE t.id = ?
       LIMIT 1`,
      [threadId]
    );

    if (tRows.length === 0) {
      return sendJSON(res, 404, {
        success: false,
        message: "Conversation not found."
      });
    }

    const thread = tRows[0];

    // Enforce participant authorization
    if (thread.buyerId !== user.id && thread.sellerId !== user.id) {
      return sendJSON(res, 403, {
        success: false,
        message: "You are not authorized to send messages to this conversation."
      });
    }

    const conn = await pool.getConnection();
    let insertId = null;
    try {
      await conn.beginTransaction();

      const [insertResult] = await conn.execute(
        `INSERT INTO chat_messages (thread_id, sender_id, message, created_at)
         VALUES (?, ?, ?, NOW())`,
        [threadId, user.id, message]
      );
      insertId = insertResult.insertId;

      await conn.execute(
        `UPDATE chat_threads SET last_message_at = NOW() WHERE id = ?`,
        [threadId]
      );

      // Safe test-only failure mechanism: induce write error before legacy mirror
      if (process.env.NODE_ENV !== "production" && process.env.TEST_MODE === "true" && req.headers["x-test-induce-chat-failure"] === "before_chats") {
        throw new Error("Induced chat write failure before legacy write for rollback verification");
      }

      // Dual-write to legacy chats table for data integrity and compatibility
      await conn.execute(
        `INSERT INTO chats (product_id, sender_id, message, created_at)
         VALUES (?, ?, ?, NOW())`,
        [thread.productId, user.id, message]
      );

      // Safe test-only failure mechanism: induce write error before commit
      if (process.env.NODE_ENV !== "production" && process.env.TEST_MODE === "true" && req.headers["x-test-induce-chat-failure"]) {
        throw new Error("Induced chat write failure before commit for rollback verification");
      }

      await conn.commit();
    } catch (txErr) {
      try {
        await conn.rollback();
      } catch (rollbackErr) {
        console.error("Rollback failed:", rollbackErr);
      }
      console.error("Chat message write failed, transaction rolled back:", txErr.message);
      return sendJSON(res, 500, {
        success: false,
        message: "Could not send message due to a database error."
      });
    } finally {
      conn.release();
    }

    return sendJSON(res, 201, {
      success: true,
      message: {
        id: insertId,
        threadId: thread.id,
        productId: thread.productId,
        senderId: user.id,
        sender: user.name,
        message,
        text: message,
        createdAt: new Date().toISOString(),
        isSelf: true
      }
    });
  }

  /* ---------------------------------------------------------
     4. PRODUCT-ANCHORED CHAT: GET /api/chats/:productId
  --------------------------------------------------------- */
  const chatMatch = pathname.match(/^\/api\/chats\/(\d+)$/);

  if (req.method === "GET" && chatMatch) {
    const user = await requireChatUser(req, res);
    if (!user) return;

    const productId = Number(chatMatch[1]);

    const [pRows] = await pool.execute(
      `SELECT id, name, price, seller_id FROM products WHERE id = ? LIMIT 1`,
      [productId]
    );

    if (pRows.length === 0) {
      return sendJSON(res, 404, {
        success: false,
        message: "Product not found."
      });
    }

    const product = pRows[0];
    const isSeller = product.seller_id === user.id;

    if (isSeller) {
      // Seller view
      const qThreadId = url.searchParams.get("threadId");
      const qBuyerId = url.searchParams.get("buyerId");

      if (qThreadId) {
        const [tRows] = await pool.execute(
          `SELECT id, product_id, buyer_id, seller_id FROM chat_threads WHERE id = ? LIMIT 1`,
          [Number(qThreadId)]
        );
        if (tRows.length === 0 || tRows[0].seller_id !== user.id || tRows[0].product_id !== productId) {
          return sendJSON(res, 404, { success: false, message: "Conversation not found." });
        }
        const threadId = tRows[0].id;
        const [mRows] = await pool.execute(
          `SELECT m.id, m.thread_id AS threadId, m.sender_id AS senderId, u.name AS sender, m.message, m.created_at AS createdAt
           FROM chat_messages m
           JOIN users u ON u.id = m.sender_id
           WHERE m.thread_id = ?
           ORDER BY m.created_at ASC, m.id ASC`,
          [threadId]
        );
        return sendJSON(res, 200, {
          success: true,
          isSeller: true,
          threadId,
          messages: mRows.map(m => ({
            id: m.id,
            threadId: m.threadId,
            productId,
            senderId: m.senderId,
            sender: m.sender || "Student",
            message: m.message,
            text: m.message,
            createdAt: m.createdAt,
            isSelf: m.senderId === user.id
          }))
        });
      }

      if (qBuyerId) {
        const [tRows] = await pool.execute(
          `SELECT id FROM chat_threads WHERE product_id = ? AND buyer_id = ? AND seller_id = ? LIMIT 1`,
          [productId, Number(qBuyerId), user.id]
        );
        if (tRows.length === 0) {
          return sendJSON(res, 200, { success: true, isSeller: true, threadId: null, messages: [] });
        }
        const threadId = tRows[0].id;
        const [mRows] = await pool.execute(
          `SELECT m.id, m.thread_id AS threadId, m.sender_id AS senderId, u.name AS sender, m.message, m.created_at AS createdAt
           FROM chat_messages m
           JOIN users u ON u.id = m.sender_id
           WHERE m.thread_id = ?
           ORDER BY m.created_at ASC, m.id ASC`,
          [threadId]
        );
        return sendJSON(res, 200, {
          success: true,
          isSeller: true,
          threadId,
          messages: mRows.map(m => ({
            id: m.id,
            threadId: m.threadId,
            productId,
            senderId: m.senderId,
            sender: m.sender || "Student",
            message: m.message,
            text: m.message,
            createdAt: m.createdAt,
            isSelf: m.senderId === user.id
          }))
        });
      }

      // If neither threadId nor buyerId is given, return threads list for this product
      const [threads] = await pool.execute(
        `SELECT
          t.id,
          t.buyer_id AS buyerId,
          u.name AS buyerName,
          t.last_message_at AS lastMessageAt,
          (SELECT m.message FROM chat_messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS lastMessage
        FROM chat_threads t
        JOIN users u ON u.id = t.buyer_id
        WHERE t.product_id = ? AND t.seller_id = ?
        ORDER BY t.last_message_at DESC`,
        [productId, user.id]
      );

      // If there is exactly one thread, also return its messages for seamless UX
      let singleThreadMessages = [];
      let defaultThreadId = null;
      if (threads.length === 1) {
        defaultThreadId = threads[0].id;
        const [mRows] = await pool.execute(
          `SELECT m.id, m.thread_id AS threadId, m.sender_id AS senderId, u.name AS sender, m.message, m.created_at AS createdAt
           FROM chat_messages m
           JOIN users u ON u.id = m.sender_id
           WHERE m.thread_id = ?
           ORDER BY m.created_at ASC, m.id ASC`,
          [defaultThreadId]
        );
        singleThreadMessages = mRows.map(m => ({
          id: m.id,
          threadId: m.threadId,
          productId,
          senderId: m.senderId,
          sender: m.sender || "Student",
          message: m.message,
          text: m.message,
          createdAt: m.createdAt,
          isSelf: m.senderId === user.id
        }));
      }

      return sendJSON(res, 200, {
        success: true,
        isSeller: true,
        threadId: defaultThreadId,
        threads,
        messages: singleThreadMessages
      });
    }

    // Buyer view: strictly query only for this buyer's thread
    const [tRows] = await pool.execute(
      `SELECT id FROM chat_threads WHERE product_id = ? AND buyer_id = ? AND seller_id = ? LIMIT 1`,
      [productId, user.id, product.seller_id]
    );

    if (tRows.length === 0) {
      return sendJSON(res, 200, {
        success: true,
        isSeller: false,
        threadId: null,
        messages: []
      });
    }

    const threadId = tRows[0].id;
    const [mRows] = await pool.execute(
      `SELECT m.id, m.thread_id AS threadId, m.sender_id AS senderId, u.name AS sender, m.message, m.created_at AS createdAt
       FROM chat_messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.thread_id = ?
       ORDER BY m.created_at ASC, m.id ASC`,
      [threadId]
    );

    return sendJSON(res, 200, {
      success: true,
      isSeller: false,
      threadId,
      messages: mRows.map(m => ({
        id: m.id,
        threadId: m.threadId,
        productId,
        senderId: m.senderId,
        sender: m.sender || "Student",
        message: m.message,
        text: m.message,
        createdAt: m.createdAt,
        isSelf: m.senderId === user.id
      }))
    });
  }

  /* ---------------------------------------------------------
     5. SEND MESSAGE TO PRODUCT CHAT: POST /api/chats/:productId
  --------------------------------------------------------- */
  if (req.method === "POST" && chatMatch) {
    const user = await requireChatUser(req, res);
    if (!user) return;

    const productId = Number(chatMatch[1]);

    const body = await parseBody(req);
    const rawMsg = body.message !== undefined ? body.message : body.text;

    if (typeof rawMsg !== "string") {
      return sendJSON(res, 400, {
        success: false,
        message: "Message content must be text."
      });
    }

    const message = rawMsg.trim();
    if (!message) {
      return sendJSON(res, 400, {
        success: false,
        message: "Message cannot be empty."
      });
    }

    if (message.length > 2000) {
      return sendJSON(res, 400, {
        success: false,
        message: "Message is too long. Maximum allowed length is 2000 characters."
      });
    }

    const [pRows] = await pool.execute(
      `SELECT id, name, price, seller_id, status FROM products WHERE id = ? LIMIT 1`,
      [productId]
    );

    if (pRows.length === 0) {
      return sendJSON(res, 404, {
        success: false,
        message: "Product not found."
      });
    }

    const product = pRows[0];

    if (product.status === "archived") {
      return sendJSON(res, 400, {
        success: false,
        message: "This product listing has been archived and is not accepting inquiries."
      });
    }

    if (product.seller_id !== user.id && product.status === "sold") {
      // Allow existing buyer-seller participants to continue, but block new inquiries
      const [existingThread] = await pool.execute(
        `SELECT id FROM chat_threads WHERE product_id = ? AND buyer_id = ? AND seller_id = ? LIMIT 1`,
        [productId, user.id, product.seller_id]
      );
      if (existingThread.length === 0) {
        return sendJSON(res, 400, {
          success: false,
          message: "This product has been marked as sold and is not accepting new inquiries."
        });
      }
    }
    let threadId = null;

    if (product.seller_id === user.id) {
      // Seller attempting to send message on own product
      const targetThreadId = body.threadId || url.searchParams.get("threadId");
      const targetBuyerId = body.buyerId || url.searchParams.get("buyerId");

      if (!targetThreadId && !targetBuyerId) {
        return sendJSON(res, 400, {
          success: false,
          message: "Sellers cannot initiate conversations with themselves; a buyer inquiry is required."
        });
      }

      if (targetThreadId) {
        const [tRows] = await pool.execute(
          `SELECT id, product_id, buyer_id, seller_id FROM chat_threads WHERE id = ? LIMIT 1`,
          [Number(targetThreadId)]
        );
        if (tRows.length === 0 || tRows[0].seller_id !== user.id || tRows[0].product_id !== productId) {
          return sendJSON(res, 403, {
            success: false,
            message: "You are not authorized to message this conversation or conversation does not exist."
          });
        }
        threadId = tRows[0].id;
      } else if (targetBuyerId) {
        if (Number(targetBuyerId) === user.id) {
          return sendJSON(res, 400, {
            success: false,
            message: "Sellers cannot initiate conversations with themselves."
          });
        }
        const [tRows] = await pool.execute(
          `SELECT id FROM chat_threads WHERE product_id = ? AND buyer_id = ? AND seller_id = ? LIMIT 1`,
          [productId, Number(targetBuyerId), user.id]
        );
        if (tRows.length === 0) {
          return sendJSON(res, 404, {
            success: false,
            message: "No conversation thread found for this student on this product."
          });
        }
        threadId = tRows[0].id;
      }
    } else {
      // Buyer sending message: check if thread exists
      const [tRows] = await pool.execute(
        `SELECT id FROM chat_threads WHERE product_id = ? AND buyer_id = ? AND seller_id = ? LIMIT 1`,
        [productId, user.id, product.seller_id]
      );
      if (tRows.length > 0) {
        threadId = tRows[0].id;
      }
    }

    const conn = await pool.getConnection();
    let insertId = null;
    try {
      await conn.beginTransaction();

      if (!threadId) {
        await conn.execute(
          `INSERT INTO chat_threads (product_id, buyer_id, seller_id, last_message_at, created_at)
           VALUES (?, ?, ?, NOW(), NOW())
           ON DUPLICATE KEY UPDATE last_message_at = NOW()`,
          [productId, user.id, product.seller_id]
        );

        const [tRows] = await conn.execute(
          `SELECT id FROM chat_threads WHERE product_id = ? AND buyer_id = ? AND seller_id = ? LIMIT 1`,
          [productId, user.id, product.seller_id]
        );
        threadId = tRows[0].id;
      } else {
        await conn.execute(
          `UPDATE chat_threads SET last_message_at = NOW() WHERE id = ?`,
          [threadId]
        );
      }

      const [insertResult] = await conn.execute(
        `INSERT INTO chat_messages (thread_id, sender_id, message, created_at)
         VALUES (?, ?, ?, NOW())`,
        [threadId, user.id, message]
      );
      insertId = insertResult.insertId;

      // Safe test-only failure mechanism: induce write error before legacy mirror
      if (process.env.NODE_ENV !== "production" && process.env.TEST_MODE === "true" && req.headers["x-test-induce-chat-failure"] === "before_chats") {
        throw new Error("Induced chat write failure before legacy write for rollback verification");
      }

      // Dual-write to legacy chats table for backward compatibility and data preservation
      await conn.execute(
        `INSERT INTO chats (product_id, sender_id, message, created_at)
         VALUES (?, ?, ?, NOW())`,
        [productId, user.id, message]
      );

      // Safe test-only failure mechanism: induce write error before commit
      if (process.env.NODE_ENV !== "production" && process.env.TEST_MODE === "true" && req.headers["x-test-induce-chat-failure"]) {
        throw new Error("Induced chat write failure before commit for rollback verification");
      }

      await conn.commit();
    } catch (txErr) {
      try {
        await conn.rollback();
      } catch (rollbackErr) {
        console.error("Rollback failed:", rollbackErr);
      }
      console.error("Chat message write failed, transaction rolled back:", txErr.message);
      return sendJSON(res, 500, {
        success: false,
        message: "Could not send message due to a database error."
      });
    } finally {
      conn.release();
    }

    return sendJSON(res, 201, {
      success: true,
      message: {
        id: insertId,
        threadId,
        productId,
        senderId: user.id,
        sender: user.name,
        message,
        text: message,
        createdAt: new Date().toISOString(),
        isSelf: true
      }
    });
  }

  /* =========================
     UNKNOWN API ROUTE
  ========================= */

  return sendJSON(
    res,
    404,
    {
      success: false,
      message:
        "API endpoint not found."
    }
  );
}

/* =========================
   HTTP SERVER
========================= */

const server =
  http.createServer(
    async (req, res) => {
      try {
        /*
          Initialize database before
          handling requests.

          The initialization promise
          is cached during the runtime.
        */

        await ensureDatabaseInitialized();

        if (
          req.url &&
          req.url.startsWith(
            "/api/"
          )
        ) {
          await handleAPI(
            req,
            res
          );

          return;
        }

        serveStatic(
          req,
          res
        );

      } catch (error) {
        console.error(
          "Server error:",
          error
        );

        if (!res.headersSent) {
          sendJSON(
            res,
            500,
            {
              success: false,

              message:
                "Internal server error.",

              /*
                Don't expose internal
                database details in production.
              */

              error:
                process.env.NODE_ENV ===
                "production"
                  ? undefined
                  : error.message
            }
          );
        }
      }
    }
  );

/* =========================
   LOCAL DEVELOPMENT
========================= */

async function startLocalServer() {
  try {
    await pool.query(
      "SELECT 1"
    );

    console.log(
      "MySQL connection successful."
    );

    await initializeDatabase();

    server.listen(
      PORT,
      HOST,
      () => {
        console.log("");

        console.log(
          "===================================="
        );

        console.log(
          " Campus Marketplace"
        );

        console.log(
          " MySQL backend running"
        );

        console.log(
          ` http://${HOST}:${PORT}`
        );

        console.log(
          "===================================="
        );

        console.log("");

        console.log(
          "Demo login:"
        );

        console.log(
          "Email: student@campus.local"
        );

        console.log(
          "Password: student123"
        );
      }
    );

  } catch (error) {
    console.error("");

    console.error(
      "DATABASE CONNECTION FAILED"
    );

    console.error(
      "------------------------------------"
    );

    console.error(
      error.message
    );

    console.error("");

    console.error(
      "Check these environment variables:"
    );

    console.error(
      "DB_HOST"
    );

    console.error(
      "DB_PORT"
    );

    console.error(
      "DB_USER"
    );

    console.error(
      "DB_PASSWORD"
    );

    console.error(
      "DB_NAME"
    );

    console.error("");

    process.exit(1);
  }
}

/*
  LOCAL:
    node server.js

  VERCEL:
    Vercel invokes the exported server.
    server.listen() is NOT called on Vercel.
*/

if (!process.env.VERCEL && !process.env.TEST_MODE && (require.main === module || (require.main && require.main.filename && require.main.filename.endsWith("server.js")))) {
  startLocalServer();
}

/*
  Export the HTTP server and starter.
*/

module.exports = server;
module.exports.startLocalServer = startLocalServer;
module.exports.checkRateLimit = checkRateLimit;
module.exports.recordFailedAttempt = recordFailedAttempt;
module.exports.resetRateLimit = resetRateLimit;
module.exports.cleanupExpiredRateLimits = cleanupExpiredRateLimits;
module.exports.getAppBaseUrl = getAppBaseUrl;
module.exports.getClientIp = getClientIp;
module.exports.hashPassword = hashPassword;
module.exports.verifyPassword = verifyPassword;
module.exports.pool = pool;