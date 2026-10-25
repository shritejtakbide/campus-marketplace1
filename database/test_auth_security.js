process.env.TEST_MODE = "true";
process.env.TEST_EMAIL_TRANSPORT = "json";

const http = require("http");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const mysql = require("mysql2/promise");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
require("dotenv").config();

const server = require("../backend/server.js");
const { resolveEnvPath, loadEnv } = require("../backend/env_loader.js");
const {
  isSmtpConfigured,
  getSmtpDiagnostic,
  verifySmtpConnection,
  sendPasswordResetEmail,
  buildPasswordResetEmailHtml
} = require("../backend/email_service.js");

const TEST_PORT = 3009;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

let pool;
let passed = 0;
let failed = 0;

function assert(description, condition, details = "") {
  if (condition) {
    console.log(`  ✓ PASS: ${description}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${description} ${details ? `(${details})` : ""}`);
    failed++;
  }
}

function makeRequest(endpoint, { method = "GET", headers = {}, body = null, json = null, token = null } = {}) {
  return new Promise((resolve, reject) => {
    const reqHeaders = { ...headers };
    let reqBody = body;

    if (json !== null) {
      reqHeaders["Content-Type"] = "application/json";
      reqBody = JSON.stringify(json);
    }
    if (token) {
      reqHeaders["Authorization"] = `Bearer ${token}`;
    }

    const url = new URL(endpoint, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: reqHeaders
    };

    const req = http.request(options, (res) => {
      let rawData = "";
      res.on("data", (chunk) => (rawData += chunk));
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = JSON.parse(rawData);
        } catch {
          parsed = rawData;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: rawData,
          json: typeof parsed === "object" ? parsed : null
        });
      });
    });

    req.on("error", reject);
    if (reqBody) req.write(reqBody);
    req.end();
  });
}

async function runAuthSecurityTests() {
  console.log("==================================================");
  console.log("  CAMPUS MARKETPLACE — PHASE 5 AUTH SECURITY TESTS");
  console.log("==================================================");

  pool = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "campus_marketplace",
    waitForConnections: true,
    connectionLimit: 10
  });

  // Start server on TEST_PORT
  await new Promise((resolve) => {
    server.listen(TEST_PORT, "127.0.0.1", () => {
      console.log(`[TEST] Server listening on ${BASE_URL}`);
      resolve();
    });
  });

  const timestamp = Date.now();
  const testStudentEmail = `sec_student_${timestamp}@campus.local`;
  const testStudentPass = "OriginalSecureP@ss123!";
  let testStudentId;

  try {
    // -----------------------------------------------------------------
    // SETUP: Provision verified and approved test student
    // -----------------------------------------------------------------
    const initialHash = await bcrypt.hash(testStudentPass, 12);
    const [insRes] = await pool.execute(
      `INSERT INTO users (name, email, password_hash, role, email_verified, registration_status, student_verification_status, verified, created_at)
       VALUES ('Security Student', ?, ?, 'student', 1, 'approved', 'verified', 1, NOW())`,
      [testStudentEmail, initialHash]
    );
    testStudentId = insRes.insertId;

    // -----------------------------------------------------------------
    // TEST SUITE 1: LOGIN RATE LIMITING THRESHOLD & HTTP 429
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 1] Login Rate Limiting Threshold & HTTP 429 Response...");

    const testIp = "192.0.2.10"; // Test client IP
    const rateLimitHeaders = { "X-Forwarded-For": testIp };

    // Clean any prior limits for this test
    await pool.execute("DELETE FROM email_otps WHERE email LIKE 'rl:%'");

    // Attempts 1 to 5: all should fail with HTTP 401 Unauthorized
    for (let i = 1; i <= 5; i++) {
      const resWrong = await makeRequest("/api/auth/login", {
        method: "POST",
        headers: rateLimitHeaders,
        json: { email: testStudentEmail, password: "WrongPassword!" }
      });
      assert(`Failed login attempt ${i}/5 returns HTTP 401 Unauthorized`, resWrong.status === 401);
      assert(`Failed login attempt ${i}/5 has generic error message`, resWrong.json && resWrong.json.message === "Invalid email or password.");
    }

    // Attempt 6: should be blocked by rate limiter with HTTP 429 Too Many Requests
    const resBlocked = await makeRequest("/api/auth/login", {
      method: "POST",
      headers: rateLimitHeaders,
      json: { email: testStudentEmail, password: "WrongPassword!" }
    });

    assert("6th failed login attempt is rate-limited with HTTP 429 Too Many Requests", resBlocked.status === 429);
    assert("Rate-limit response has success = false", resBlocked.json && resBlocked.json.success === false);
    assert("Rate-limit response contains safe informative message", resBlocked.json && resBlocked.json.message.includes("Too many failed login attempts"));
    assert("Rate-limit response provides retryAfter in seconds", Boolean(resBlocked.json && resBlocked.json.retryAfter));
    assert("Response sets Retry-After HTTP header", Boolean(resBlocked.headers["retry-after"]));

    // Even with the correct password, blocked account/IP remains blocked during window
    const resBlockedCorrect = await makeRequest("/api/auth/login", {
      method: "POST",
      headers: rateLimitHeaders,
      json: { email: testStudentEmail, password: testStudentPass }
    });
    assert("Correct credentials on rate-limited IP/account are still rejected with HTTP 429", resBlockedCorrect.status === 429);

    // -----------------------------------------------------------------
    // TEST SUITE 2: RATE LIMIT COUNTER RESET UPON SUCCESSFUL LOGIN
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 2] Rate Limit Counter Reset Upon Successful Login...");

    const resetUserEmail = `sec_reset_user_${timestamp}@campus.local`;
    const resetUserPass = "ResetPass123!";
    const resetUserHash = await bcrypt.hash(resetUserPass, 12);
    const [u2Res] = await pool.execute(
      `INSERT INTO users (name, email, password_hash, role, email_verified, registration_status, student_verification_status, verified, created_at)
       VALUES ('Reset User', ?, ?, 'student', 1, 'approved', 'verified', 1, NOW())`,
      [resetUserEmail, resetUserHash]
    );

    const resetIp = "192.0.2.20";
    const resetHeaders = { "X-Forwarded-For": resetIp };

    // 3 failed attempts (under threshold of 5)
    for (let i = 1; i <= 3; i++) {
      const resFail = await makeRequest("/api/auth/login", {
        method: "POST",
        headers: resetHeaders,
        json: { email: resetUserEmail, password: "BadPassword" }
      });
      assert(`Partial failed attempt ${i}/3 returns 401`, resFail.status === 401);
    }

    // Now log in successfully with correct password
    const resSuccessLogin = await makeRequest("/api/auth/login", {
      method: "POST",
      headers: resetHeaders,
      json: { email: resetUserEmail, password: resetUserPass }
    });
    assert("Successful login returns HTTP 200 OK", resSuccessLogin.status === 200);
    assert("Successful login returns session token", Boolean(resSuccessLogin.json && resSuccessLogin.json.token));

    // Verify rate limit record was purged from shared database store
    const [rateRows] = await pool.execute(
      "SELECT * FROM email_otps WHERE email = ? AND otp_hash = 'rate_limit'",
      [`rl:login:${resetUserEmail}::${resetIp}`]
    );
    assert("Failure counter was deleted from shared database store upon successful login", rateRows.length === 0);

    // -----------------------------------------------------------------
    // TEST SUITE 3: RATE LIMIT KEY ISOLATION (ACCOUNT / IP COMBINATION)
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 3] Rate Limit Key Isolation (Account / IP Combination)...");

    // Legitimate user from a different IP (e.g. 192.0.2.30) is NOT blocked
    const legitIpHeaders = { "X-Forwarded-For": "192.0.2.30" };
    const resLegitLogin = await makeRequest("/api/auth/login", {
      method: "POST",
      headers: legitIpHeaders,
      json: { email: testStudentEmail, password: testStudentPass }
    });
    assert("Legitimate user from separate IP is NOT blocked by attacker IP's rate limit", resLegitLogin.status === 200);

    // Different user from the locked IP is NOT blocked
    const differentUserEmail = `diff_user_${timestamp}@campus.local`;
    const diffPass = "DiffPass123!";
    const diffHash = await bcrypt.hash(diffPass, 12);
    await pool.execute(
      `INSERT INTO users (name, email, password_hash, role, email_verified, registration_status, student_verification_status, verified, created_at)
       VALUES ('Diff User', ?, ?, 'student', 1, 'approved', 'verified', 1, NOW())`,
      [differentUserEmail, diffHash]
    );

    const resDiffUser = await makeRequest("/api/auth/login", {
      method: "POST",
      headers: rateLimitHeaders, // same IP as test 1
      json: { email: differentUserEmail, password: diffPass }
    });
    assert("Different account on same IP is NOT blocked (preventing cross-account DoS)", resDiffUser.status === 200);

    // Nonexistent user gets rate limited identically to prevent account enumeration
    const nonExistentEmail = `ghost_${timestamp}@campus.local`;
    const ghostIp = "192.0.2.40";
    const ghostHeaders = { "X-Forwarded-For": ghostIp };

    for (let i = 1; i <= 5; i++) {
      await makeRequest("/api/auth/login", {
        method: "POST",
        headers: ghostHeaders,
        json: { email: nonExistentEmail, password: "RandomPassword" }
      });
    }
    const resGhostBlocked = await makeRequest("/api/auth/login", {
      method: "POST",
      headers: ghostHeaders,
      json: { email: nonExistentEmail, password: "RandomPassword" }
    });
    assert("Non-existent accounts trigger identical HTTP 429 when brute-forced (anti-enumeration)", resGhostBlocked.status === 429);

    // -----------------------------------------------------------------
    // TEST SUITE 4: GENERIC FORGOT-PASSWORD RESPONSES (ANTI-ENUMERATION)
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 4] Generic Forgot-Password Responses (Anti-Enumeration)...");

    const recoveryIp = "192.0.2.50";
    const recoveryHeaders = { "X-Forwarded-For": recoveryIp };

    // Request for existing account
    const resForgotExisting = await makeRequest("/api/auth/forgot-password", {
      method: "POST",
      headers: recoveryHeaders,
      json: { email: testStudentEmail }
    });
    assert("Forgot-password for existing account returns HTTP 200 OK", resForgotExisting.status === 200);
    assert("Response returns success = true", resForgotExisting.json && resForgotExisting.json.success === true);
    assert("Generic safe message returned", resForgotExisting.json && resForgotExisting.json.message.includes("password reset instructions have been sent"));
    assert("Response does NOT leak whether account exists", !resForgotExisting.json.user && !resForgotExisting.json.userId);
    assert("Response does NOT leak any token or token hash", !resForgotExisting.json.token && !resForgotExisting.json.resetToken);

    // Request for non-existent account
    const resForgotNonexistent = await makeRequest("/api/auth/forgot-password", {
      method: "POST",
      headers: recoveryHeaders,
      json: { email: `nobody_exists_${timestamp}@campus.local` }
    });
    assert("Forgot-password for non-existent account returns HTTP 200 OK", resForgotNonexistent.status === 200);
    assert("Response message for nonexistent account is EXACTLY identical (prevents email enumeration)",
      resForgotNonexistent.json.message === resForgotExisting.json.message);

    // Invalid email input validation
    const resForgotInvalidEmail = await makeRequest("/api/auth/forgot-password", {
      method: "POST",
      headers: recoveryHeaders,
      json: { email: "invalid-email-format" }
    });
    assert("Forgot-password with invalid email returns HTTP 400 Bad Request", resForgotInvalidEmail.status === 400);

    // -----------------------------------------------------------------
    // TEST SUITE 5: PASSWORD RECOVERY RATE LIMITING
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 5] Password Recovery Rate Limiting...");

    const spamRecoveryIp = "192.0.2.60";
    const spamHeaders = { "X-Forwarded-For": spamRecoveryIp };

    // 5 recovery requests
    for (let i = 1; i <= 5; i++) {
      await makeRequest("/api/auth/forgot-password", {
        method: "POST",
        headers: spamHeaders,
        json: { email: testStudentEmail }
      });
    }

    // 6th recovery request should be rate-limited
    const resRecoveryRateLimited = await makeRequest("/api/auth/forgot-password", {
      method: "POST",
      headers: spamHeaders,
      json: { email: testStudentEmail }
    });
    assert("Excessive recovery requests trigger HTTP 429 Too Many Requests", resRecoveryRateLimited.status === 429);
    assert("Recovery rate-limit response contains safe message", resRecoveryRateLimited.json.message.includes("Too many password recovery requests"));
    assert("Recovery rate-limit response provides retryAfter", Boolean(resRecoveryRateLimited.json.retryAfter));

    // -----------------------------------------------------------------
    // TEST SUITE 6: VALID RESET TOKEN CONSUMPTION & BCRYPT STORAGE
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 6] Valid Reset Token Consumption & Bcrypt Storage...");

    // Generate a valid recovery token for test student
    const rawResetToken = crypto.randomBytes(32).toString("hex");
    const resetTokenHash = crypto.createHash("sha256").update(rawResetToken).digest("hex");

    await pool.execute(
      `UPDATE users
       SET password_reset_token_hash = ?,
           password_reset_expires_at = DATE_ADD(NOW(), INTERVAL 30 MINUTE),
           password_reset_used_at = NULL
       WHERE id = ?`,
      [resetTokenHash, testStudentId]
    );

    // Verify token hash is stored, never raw token
    const [userRow] = await pool.execute(
      "SELECT password_reset_token_hash FROM users WHERE id = ?",
      [testStudentId]
    );
    assert("Database stores only 64-character SHA-256 token hash", userRow[0].password_reset_token_hash === resetTokenHash);
    assert("Raw reset token is not stored in plaintext", userRow[0].password_reset_token_hash !== rawResetToken);

    // Verify token validation helper endpoint
    const resVerifyToken = await makeRequest(`/api/auth/verify-reset-token?token=${rawResetToken}`);
    assert("GET /api/auth/verify-reset-token with valid token returns HTTP 200 OK", resVerifyToken.status === 200);
    assert("Token verification reports valid = true", resVerifyToken.json && resVerifyToken.json.valid === true);

    // Reset password with valid token
    const brandNewPassword = "BrandNewSuperSecureP@ss123!";
    const resResetSuccess = await makeRequest("/api/auth/reset-password", {
      method: "POST",
      json: { token: rawResetToken, newPassword: brandNewPassword }
    });

    assert("Reset password with valid token returns HTTP 200 OK", resResetSuccess.status === 200);
    assert("Response indicates success = true", resResetSuccess.json && resResetSuccess.json.success === true);
    assert("Response message indicates password has been reset", resResetSuccess.json.message.includes("Password has been reset successfully"));

    // Verify updated password hash in database
    const [updatedUser] = await pool.execute(
      "SELECT password_hash, password_reset_token_hash, password_reset_used_at FROM users WHERE id = ?",
      [testStudentId]
    );
    assert("New password hash is valid bcrypt hash starting with $2b$", updatedUser[0].password_hash.startsWith("$2b$"));
    assert("New password hash is 60 characters long", updatedUser[0].password_hash.length === 60);
    assert("New bcrypt hash verifies successfully against new password", await bcrypt.compare(brandNewPassword, updatedUser[0].password_hash));
    assert("Database records password_reset_used_at timestamp", Boolean(updatedUser[0].password_reset_used_at));
    assert("Database clears password_reset_token_hash on use", updatedUser[0].password_reset_token_hash === null);

    // Old password fails login
    const resOldLogin = await makeRequest("/api/auth/login", {
      method: "POST",
      headers: { "X-Forwarded-For": "192.0.2.71" },
      json: { email: testStudentEmail, password: testStudentPass }
    });
    assert("Old password is now rejected with HTTP 401 Unauthorized", resOldLogin.status === 401);

    // New password succeeds login
    const resNewLogin = await makeRequest("/api/auth/login", {
      method: "POST",
      headers: { "X-Forwarded-For": "192.0.2.72" },
      json: { email: testStudentEmail, password: brandNewPassword }
    });
    assert("New password succeeds login with HTTP 200 OK", resNewLogin.status === 200);
    assert("New session token returned", Boolean(resNewLogin.json && resNewLogin.json.token));

    // -----------------------------------------------------------------
    // TEST SUITE 7: SINGLE-USE ENFORCEMENT & REPLAY ATTACK DEFENSE
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 7] Single-Use Enforcement & Replay Attack Defense...");

    // Submitting the already-consumed token again must fail
    const resReplayReset = await makeRequest("/api/auth/reset-password", {
      method: "POST",
      json: { token: rawResetToken, newPassword: "AnotherPassword123!" }
    });
    assert("Submitting consumed token is rejected with HTTP 400 Bad Request", resReplayReset.status === 400);
    assert("Replay rejection indicates token invalid or already used",
      resReplayReset.json && (resReplayReset.json.message.includes("already been used") || resReplayReset.json.message.includes("Invalid or expired")));

    // Verify token validation endpoint also rejects consumed token
    const resVerifyReplay = await makeRequest(`/api/auth/verify-reset-token?token=${rawResetToken}`);
    assert("GET /api/auth/verify-reset-token rejects consumed token with HTTP 400", resVerifyReplay.status === 400);
    assert("Token verification reports valid = false", resVerifyReplay.json && resVerifyReplay.json.valid === false);

    // -----------------------------------------------------------------
    // TEST SUITE 8: EXPIRED RESET TOKEN ENFORCEMENT
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 8] Expired Reset Token Enforcement...");

    const expiredToken = crypto.randomBytes(32).toString("hex");
    const expiredHash = crypto.createHash("sha256").update(expiredToken).digest("hex");

    // Set expiry in the past
    await pool.execute(
      `UPDATE users
       SET password_reset_token_hash = ?,
           password_reset_expires_at = DATE_SUB(NOW(), INTERVAL 5 MINUTE),
           password_reset_used_at = NULL
       WHERE id = ?`,
      [expiredHash, testStudentId]
    );

    const resExpiredReset = await makeRequest("/api/auth/reset-password", {
      method: "POST",
      json: { token: expiredToken, newPassword: "ExpiredPassword123!" }
    });
    assert("Expired reset token is rejected with HTTP 400 Bad Request", resExpiredReset.status === 400);
    assert("Expired token message indicates expiration", resExpiredReset.json && resExpiredReset.json.message.includes("expired"));

    // -----------------------------------------------------------------
    // TEST SUITE 9: INVALID, MALFORMED & FORGED RESET TOKENS
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 9] Invalid, Malformed & Forged Reset Tokens...");

    // Random forged token that doesn't exist
    const forgedToken = crypto.randomBytes(32).toString("hex");
    const resForged = await makeRequest("/api/auth/reset-password", {
      method: "POST",
      json: { token: forgedToken, newPassword: "ForgedPassword123!" }
    });
    assert("Forged reset token is rejected with HTTP 400 Bad Request", resForged.status === 400);

    // Missing token
    const resMissingToken = await makeRequest("/api/auth/reset-password", {
      method: "POST",
      json: { token: "", newPassword: "SomePassword123!" }
    });
    assert("Missing reset token is rejected with HTTP 400 Bad Request", resMissingToken.status === 400);

    // Password too short (< 6 characters)
    const validTokenForShortPass = crypto.randomBytes(32).toString("hex");
    const validHashForShortPass = crypto.createHash("sha256").update(validTokenForShortPass).digest("hex");
    await pool.execute(
      `UPDATE users
       SET password_reset_token_hash = ?,
           password_reset_expires_at = DATE_ADD(NOW(), INTERVAL 30 MINUTE),
           password_reset_used_at = NULL
       WHERE id = ?`,
      [validHashForShortPass, testStudentId]
    );

    const resShortPass = await makeRequest("/api/auth/reset-password", {
      method: "POST",
      json: { token: validTokenForShortPass, newPassword: "123" }
    });
    assert("Short password (< 6 chars) is rejected with HTTP 400 Bad Request", resShortPass.status === 400);
    assert("Message explains minimum length requirement", resShortPass.json && resShortPass.json.message.includes("6 characters"));

    // -----------------------------------------------------------------
    // TEST SUITE 10: CONCURRENT TOKEN CONSUMPTION ATOMICITY (RACE CONDITION DEFENSE)
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 10] Concurrent Token Consumption Atomicity (Race Condition Defense)...");

    const raceToken = crypto.randomBytes(32).toString("hex");
    const raceHash = crypto.createHash("sha256").update(raceToken).digest("hex");

    await pool.execute(
      `UPDATE users
       SET password_reset_token_hash = ?,
           password_reset_expires_at = DATE_ADD(NOW(), INTERVAL 30 MINUTE),
           password_reset_used_at = NULL
       WHERE id = ?`,
      [raceHash, testStudentId]
    );

    // Launch two simultaneous requests attempting to consume the exact same token
    const [resRace1, resRace2] = await Promise.all([
      makeRequest("/api/auth/reset-password", {
        method: "POST",
        json: { token: raceToken, newPassword: "RaceWinnerPassword1!" }
      }),
      makeRequest("/api/auth/reset-password", {
        method: "POST",
        json: { token: raceToken, newPassword: "RaceLoserPassword2!" }
      })
    ]);

    const statuses = [resRace1.status, resRace2.status].sort();
    assert("Exactly one concurrent request succeeds (200) and the other fails (400)",
      statuses[0] === 200 && statuses[1] === 400);

    // -----------------------------------------------------------------
    // TEST SUITE 11: EXISTING SESSION INVALIDATION AFTER PASSWORD RESET
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 11] Existing Session Invalidation After Password Reset...");

    // First login and acquire active session token
    const loginBeforeReset = await makeRequest("/api/auth/login", {
      method: "POST",
      headers: { "X-Forwarded-For": "192.0.2.80" },
      json: { email: testStudentEmail, password: "RaceWinnerPassword1!" }
    });
    const activeSessionToken = loginBeforeReset.json.token;

    // Verify session token is initially valid
    const resMeBefore = await makeRequest("/api/me", { token: activeSessionToken });
    assert("Session token is initially valid on /api/me (HTTP 200 OK)", resMeBefore.status === 200);

    // Now reset password via a new reset token
    const postLoginToken = crypto.randomBytes(32).toString("hex");
    const postLoginHash = crypto.createHash("sha256").update(postLoginToken).digest("hex");
    await pool.execute(
      `UPDATE users
       SET password_reset_token_hash = ?,
           password_reset_expires_at = DATE_ADD(NOW(), INTERVAL 30 MINUTE),
           password_reset_used_at = NULL
       WHERE id = ?`,
      [postLoginHash, testStudentId]
    );

    await makeRequest("/api/auth/reset-password", {
      method: "POST",
      json: { token: postLoginToken, newPassword: "FinalPassword123!" }
    });

    // Session token MUST now be invalidated
    const resMeAfter = await makeRequest("/api/me", { token: activeSessionToken });
    assert("Pre-reset session token is immediately invalidated with HTTP 401 Unauthorized", resMeAfter.status === 401);

    const [dbSessions] = await pool.execute(
      "SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?",
      [testStudentId]
    );
    assert("All sessions for user were purged from database sessions table", Number(dbSessions[0].count) === 0);

    // -----------------------------------------------------------------
    // TEST SUITE 12: SMTP SERVICE & SECRET NON-EXPOSURE AUDIT
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 12] SMTP Service & Secret Non-Exposure Audit...");

    // Verify HTML email generator includes base URL and Liquid Glass tokens
    const sampleResetUrl = "http://localhost:3000/#reset-password?token=abcdef123456";
    const sampleHtml = buildPasswordResetEmailHtml(sampleResetUrl, 30);
    assert("Email template contains reset URL", sampleHtml.includes(sampleResetUrl));
    assert("Email template contains Liquid Glass styling tokens", sampleHtml.includes("linear-gradient"));
    assert("Email template specifies expiration time", sampleHtml.includes("30 minutes"));

    // Verify sendPasswordResetEmail input validation
    let threwOnBadEmail = false;
    try {
      await sendPasswordResetEmail("bad-email", sampleResetUrl, 30);
    } catch {
      threwOnBadEmail = true;
    }
    assert("sendPasswordResetEmail rejects invalid email format", threwOnBadEmail);

    // Safe SMTP configuration diagnostic & dotenv path audit
    const resolvedPath = resolveEnvPath();
    assert("resolveEnvPath returns absolute path to .env", path.isAbsolute(resolvedPath) && resolvedPath.endsWith(".env"));

    const diag = getSmtpDiagnostic();
    assert("getSmtpDiagnostic returns valid diagnostic object", typeof diag === "object" && typeof diag.isConfigured === "boolean");
    assert("Diagnostic correctly reports resolved envPath", diag.envPath === resolvedPath);
    assert("Diagnostic accurately reports envFileExists boolean", typeof diag.envFileExists === "boolean");
    assert("Diagnostic provides transporterConfigured status", typeof diag.transporterConfigured === "boolean");
    assert("Diagnostic provides safe provider identification", typeof diag.provider === "string");
    assert("Diagnostic fields object contains expected SMTP keys", Boolean(diag.fields.SMTP_HOST && diag.fields.SMTP_USER && diag.fields.SMTP_PASS));
    assert("Diagnostic NEVER leaks raw password string in fields", typeof diag.fields.SMTP_PASS.value === "undefined");
    assert("Diagnostic reports missing fields array safely", Array.isArray(diag.missingFields));
    assert("Diagnostic recommendations do not expose secrets", !JSON.stringify(diag.recommendations).includes("secret"));

    // Verify placeholder rejection
    const savedHost = process.env.SMTP_HOST;
    const savedUser = process.env.SMTP_USER;
    const savedPass = process.env.SMTP_PASS;
    try {
      process.env.SMTP_HOST = "smtp.gmail.com";
      process.env.SMTP_USER = "your_gmail_address@gmail.com"; // placeholder
      process.env.SMTP_PASS = "your_16_char_gmail_app_password"; // placeholder
      assert("isSmtpConfigured rejects example placeholders", isSmtpConfigured() === false);
      const placeholderDiag = getSmtpDiagnostic();
      assert("Diagnostic flags placeholder user as unconfigured", placeholderDiag.fields.SMTP_USER.configured === false);
    } finally {
      if (savedHost !== undefined) process.env.SMTP_HOST = savedHost; else delete process.env.SMTP_HOST;
      if (savedUser !== undefined) process.env.SMTP_USER = savedUser; else delete process.env.SMTP_USER;
      if (savedPass !== undefined) process.env.SMTP_PASS = savedPass; else delete process.env.SMTP_PASS;
    }

    // Verify SMTP connection verification behavior in test environment
    const connVerify = await verifySmtpConnection();
    assert("verifySmtpConnection returns structured result", typeof connVerify === "object" && typeof connVerify.success === "boolean");
    assert("verifySmtpConnection result includes diagnostic report", typeof connVerify.diagnostic === "object");
    if (!connVerify.success) {
      assert("Unsuccessful SMTP verification provides safe non-secret error message", Boolean(connVerify.error) && !connVerify.error.includes("password"));
    }

    // Sensitive field non-exposure audit on reset responses
    const auditRes = await makeRequest(`/api/auth/verify-reset-token?token=${forgedToken}`);
    const rawAudit = auditRes.data || "";
    assert("Responses never leak password hashes ($2b$)", !rawAudit.includes("$2b$"));
    assert("Responses never leak database column names or SQL fragments", !rawAudit.includes("password_reset_token_hash"));
    assert("Responses never leak SMTP passwords or host secrets", !rawAudit.includes("SMTP_PASS"));

    // -----------------------------------------------------------------
    // TEST SUITE 13: SQL INJECTION DEFENSE ON AUTH ENDPOINTS
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 13] SQL Injection Defense on Auth Endpoints...");

    const sqlPayloads = [
      "' OR '1'='1",
      "admin' --",
      "'; DROP TABLE users; --",
      "' UNION SELECT null, null, null --"
    ];

    for (const payload of sqlPayloads) {
      const resSqlLogin = await makeRequest("/api/auth/login", {
        method: "POST",
        headers: { "X-Forwarded-For": "192.0.2.99" },
        json: { email: payload, password: "password" }
      });
      assert(`SQL injection payload '${payload.slice(0, 15)}...' in login handled safely`,
        resSqlLogin.status === 400 || resSqlLogin.status === 401 || resSqlLogin.status === 429);

      const resSqlForgot = await makeRequest("/api/auth/forgot-password", {
        method: "POST",
        json: { email: payload }
      });
      assert(`SQL injection payload in forgot-password handled safely`,
        resSqlForgot.status === 400 || resSqlForgot.status === 200 || resSqlForgot.status === 429);
    }

    // -----------------------------------------------------------------
    // TEST SUITE 14: REGRESSION CHECKS FOR EXISTING AUTHENTICATION FLOWS
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 14] Regression Checks for Existing Authentication Flows...");

    // Registration flow
    const regEmail = `reg_flow_${timestamp}@campus.local`;
    const regPass = "FlowPassword123!";
    const resReg = await makeRequest("/api/auth/register", {
      method: "POST",
      json: { name: "Flow Student", email: regEmail, password: regPass }
    });
    assert("Existing student registration still succeeds with HTTP 201 Created", resReg.status === 201);
    assert("Registration returns session token", Boolean(resReg.json && resReg.json.token));
    const flowToken = resReg.json.token;

    // /api/me with session token
    const resMe = await makeRequest("/api/me", { token: flowToken });
    assert("GET /api/me works with registration session token (HTTP 200 OK)", resMe.status === 200);
    assert("User email matches registered email", resMe.json.user.email === regEmail);

    // Logout flow
    const resLogout = await makeRequest("/api/auth/logout", {
      method: "POST",
      token: flowToken
    });
    assert("POST /api/auth/logout still succeeds with HTTP 200 OK", resLogout.status === 200);

    const resMeAfterLogout = await makeRequest("/api/me", { token: flowToken });
    assert("Logged out session is rejected with HTTP 401 Unauthorized", resMeAfterLogout.status === 401);

    // -----------------------------------------------------------------
    // CLEANUP
    // -----------------------------------------------------------------
    console.log("\n[INFO] Cleaning up test accounts and rate limits...");
    await pool.execute("DELETE FROM users WHERE email LIKE 'sec_%' OR email LIKE 'diff_%' OR email LIKE 'reg_flow_%'");
    await pool.execute("DELETE FROM email_otps WHERE email LIKE 'rl:%'");
    console.log("  ✓ Test cleanup complete.");

  } catch (err) {
    console.error("[FATAL ERROR during tests]:", err);
    failed++;
  } finally {
    console.log("\n==================================================");
    console.log(`  PHASE 5 AUTH SECURITY RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log("==================================================\n");

    if (pool) await pool.end();
    server.close();
    process.exit(failed > 0 ? 1 : 0);
  }
}

runAuthSecurityTests();
