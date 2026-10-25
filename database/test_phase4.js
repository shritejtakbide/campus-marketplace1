process.env.TEST_MODE = "true";
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const mysql = require("mysql2/promise");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
require("dotenv").config();

const server = require("../backend/server.js");
const { generateOtp, hashOtp, isSmtpConfigured } = require("../backend/email_service.js");

async function runPhase4Tests() {
  console.log("==================================================");
  console.log("  CAMPUS MARKETPLACE — PHASE 4 EMAIL OTP TESTS    ");
  console.log("==================================================");

  const PORT = 3003; // Dedicated isolated test port
  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  console.log(`[TEST] Server listening on http://127.0.0.1:${PORT}`);

  const pool = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "campus_marketplace",
    waitForConnections: true,
    connectionLimit: 3
  });

  function makeRequest(reqPath, options = {}) {
    return new Promise((resolve, reject) => {
      const headers = Object.assign({}, options.headers || {});
      if (options.token) {
        headers["Authorization"] = `Bearer ${options.token}`;
      }
      if (options.json) {
        headers["Content-Type"] = "application/json";
      }

      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: PORT,
          path: reqPath,
          method: options.method || "GET",
          headers
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            let json = null;
            try {
              json = JSON.parse(body);
            } catch {}
            resolve({ status: res.statusCode, headers: res.headers, body, json });
          });
        }
      );
      req.on("error", reject);
      if (options.json) {
        req.write(JSON.stringify(options.json));
      } else if (options.body) {
        req.write(options.body);
      }
      req.end();
    });
  }

  let passed = 0;
  let failed = 0;

  function assert(desc, condition) {
    if (condition) {
      console.log(`  ✓ PASS: ${desc}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${desc}`);
      failed++;
    }
  }

  const testStamp = Date.now();
  const testEmail = `test_otp_${testStamp}@campus.local`;
  const testPassword = "SecurePassPhase4!";
  let testUserId = null;
  let testUserToken = null;

  try {
    // -----------------------------------------------------------------
    // TEST SUITE 1: CRYPTOGRAPHIC OTP GENERATION & AT-REST HASH STORAGE
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 1] Cryptographic OTP Generation & Hash Storage...");

    const sampleOtp = generateOtp();
    assert("Generated OTP is a string", typeof sampleOtp === "string");
    assert("Generated OTP is exactly 6 digits", /^\d{6}$/.test(sampleOtp));
    const sampleInt = parseInt(sampleOtp, 10);
    assert("Generated OTP is within range [100000, 999999]", sampleInt >= 100000 && sampleInt <= 999999);

    const sampleHash = hashOtp(sampleOtp);
    assert("Hash of OTP is 64 hex characters (SHA-256)", sampleHash.length === 64);
    assert("Hash is not plain text OTP", sampleHash !== sampleOtp);

    // Verify hashing uniqueness and reproducibility
    const sampleHash2 = hashOtp(sampleOtp);
    assert("Hashing identical OTP produces identical SHA-256 output", sampleHash === sampleHash2);
    const diffHash = hashOtp("999999");
    assert("Different OTP produces completely different hash", sampleHash !== diffHash);

    // -----------------------------------------------------------------
    // TEST SUITE 2: USER REGISTRATION & INITIAL UNVERIFIED STATE
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 2] User Registration & Initial Unverified State...");

    const resReg = await makeRequest("/api/auth/register", {
      method: "POST",
      json: { name: "OTP Student", email: testEmail, password: testPassword }
    });
    assert("Registration returns HTTP 201 Created", resReg.status === 201);
    assert("User object has emailVerified = false", resReg.json && resReg.json.user && resReg.json.user.emailVerified === false);
    assert("User object has registrationStatus = 'pending'", resReg.json.user.registrationStatus === "pending");
    assert("User object has studentVerificationStatus = 'unverified'", resReg.json.user.studentVerificationStatus === "unverified");

    testUserId = resReg.json.user.id;
    testUserToken = resReg.json.token;

    // Verify directly in MySQL
    const [dbUser] = await pool.execute(
      "SELECT id, email, email_verified, registration_status, student_verification_status FROM users WHERE id = ?",
      [testUserId]
    );
    assert("Database confirms users.email_verified = 0", Number(dbUser[0].email_verified) === 0);
    assert("Database confirms users.registration_status = 'pending'", dbUser[0].registration_status === "pending");
    assert("Database confirms users.student_verification_status = 'unverified'", dbUser[0].student_verification_status === "unverified");

    // -----------------------------------------------------------------
    // TEST SUITE 3: REAL SMTP DELIVERY REPORTING & FAILURE HANDLING
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 3] Real SMTP Delivery Reporting & Failure Handling...");

    // When SMTP is unconfigured or points to unreachable host, it must NOT claim delivery succeeded
    // Ensure TEST_EMAIL_TRANSPORT is not set for this test
    const oldTransportEnv = process.env.TEST_EMAIL_TRANSPORT;
    delete process.env.TEST_EMAIL_TRANSPORT;

    const resUnconfSend = await makeRequest("/api/auth/send-otp", {
      method: "POST",
      json: { email: testEmail }
    });
    // Should fail with 503 because real SMTP is not configured in .env
    assert("Unconfigured SMTP returns HTTP 503 Service Unavailable", resUnconfSend.status === 503);
    assert("Response reports that SMTP email service is not configured or failed", resUnconfSend.json && resUnconfSend.json.success === false);
    assert("Server does NOT simulate or fake successful delivery", resUnconfSend.json.message.includes("Failed to deliver") || resUnconfSend.json.message.includes("SMTP"));

    // -----------------------------------------------------------------
    // TEST SUITE 4: VALID EMAIL OTP VERIFICATION & SINGLE USE
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 4] Valid Email OTP Verification & Single Use...");

    // Insert an authentic test OTP into email_otps using the cryptographic SHA-256 hash
    const validOtp = generateOtp();
    const validOtpHash = hashOtp(validOtp);

    await pool.execute(
      `INSERT INTO email_otps (email, otp_hash, attempts, expires_at, created_at)
       VALUES (?, ?, 0, DATE_ADD(NOW(), INTERVAL 10 MINUTE), NOW())`,
      [testEmail, validOtpHash]
    );

    // Verify only the hash is in the database, never the plaintext
    const [otpHold] = await pool.execute(
      "SELECT id, otp_hash FROM email_otps WHERE email = ?",
      [testEmail]
    );
    assert("Database stores only the 64-character SHA-256 hash", otpHold.length === 1 && otpHold[0].otp_hash === validOtpHash);
    assert("Raw OTP is nowhere present in the database table", otpHold[0].otp_hash !== validOtp);

    // Verify with invalid format first (not 6 digits)
    const resFormatErr = await makeRequest("/api/auth/verify-otp", {
      method: "POST",
      json: { email: testEmail, otp: "123" }
    });
    assert("Rejects non-6-digit OTP format with HTTP 400", resFormatErr.status === 400);

    // Verify with correct OTP code
    const resVerifyOk = await makeRequest("/api/auth/verify-otp", {
      method: "POST",
      json: { email: testEmail, otp: validOtp }
    });
    assert("Valid OTP verification returns HTTP 200 OK", resVerifyOk.status === 200);
    assert("Response indicates email verified successfully", resVerifyOk.json && resVerifyOk.json.success === true);
    assert("Response returns emailVerified = true", resVerifyOk.json.emailVerified === true);

    // Verify in database: users.email_verified is now 1
    const [userVerified] = await pool.execute(
      "SELECT email_verified, registration_status, student_verification_status, role FROM users WHERE id = ?",
      [testUserId]
    );
    assert("Database users.email_verified updated to 1", Number(userVerified[0].email_verified) === 1);
    assert("registration_status remains 'pending' (NOT auto-approved)", userVerified[0].registration_status === "pending");
    assert("student_verification_status remains 'unverified' (NOT auto-verified)", userVerified[0].student_verification_status === "unverified");
    assert("role remains 'student' (NOT escalated)", userVerified[0].role === "student");

    // Single-use check: OTP record must be purged from database
    const [otpPurged] = await pool.execute(
      "SELECT COUNT(*) AS count FROM email_otps WHERE email = ?",
      [testEmail]
    );
    assert("OTP record purged from database immediately after use (single-use enforced)", Number(otpPurged[0].count) === 0);

    // -----------------------------------------------------------------
    // TEST SUITE 5: REUSED OTP REJECTION (REPLAY ATTACK DEFENSE)
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 5] Reused OTP Replay Attack Defense...");

    // Reset user to email_verified = 0 temporarily to test replay rejection
    await pool.execute("UPDATE users SET email_verified = 0 WHERE id = ?", [testUserId]);

    const resReplay = await makeRequest("/api/auth/verify-otp", {
      method: "POST",
      json: { email: testEmail, otp: validOtp }
    });
    assert("Submitting consumed OTP is rejected with HTTP 400 Bad Request", resReplay.status === 400);
    assert("Replay rejection message indicates no active code found", resReplay.json && resReplay.json.message.includes("No active verification code"));

    // -----------------------------------------------------------------
    // TEST SUITE 6: ATTEMPT CAPPING & BRUTE-FORCE DEFENSE (MAX 3)
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 6] Attempt Capping & Brute-Force Defense (Max 3)...");

    const bruteOtp = "555123";
    const bruteOtpHash = hashOtp(bruteOtp);
    await pool.execute(
      `INSERT INTO email_otps (email, otp_hash, attempts, expires_at, created_at)
       VALUES (?, ?, 0, DATE_ADD(NOW(), INTERVAL 10 MINUTE), NOW())`,
      [testEmail, bruteOtpHash]
    );

    // Attempt 1: Wrong guess
    const resGuess1 = await makeRequest("/api/auth/verify-otp", {
      method: "POST",
      json: { email: testEmail, otp: "000001" }
    });
    assert("Attempt 1 with wrong code returns HTTP 400", resGuess1.status === 400);
    assert("Message indicates 2 attempts remaining", resGuess1.json && resGuess1.json.message.includes("2 attempt(s) remaining"));

    const [dbAttempts1] = await pool.execute("SELECT attempts FROM email_otps WHERE email = ?", [testEmail]);
    assert("Database attempts incremented to 1", Number(dbAttempts1[0].attempts) === 1);

    // Attempt 2: Wrong guess
    const resGuess2 = await makeRequest("/api/auth/verify-otp", {
      method: "POST",
      json: { email: testEmail, otp: "000002" }
    });
    assert("Attempt 2 with wrong code returns HTTP 400", resGuess2.status === 400);
    assert("Message indicates 1 attempt remaining", resGuess2.json && resGuess2.json.message.includes("1 attempt(s) remaining"));

    const [dbAttempts2] = await pool.execute("SELECT attempts FROM email_otps WHERE email = ?", [testEmail]);
    assert("Database attempts incremented to 2", Number(dbAttempts2[0].attempts) === 2);

    // Attempt 3: Wrong guess (exceeds limit)
    const resGuess3 = await makeRequest("/api/auth/verify-otp", {
      method: "POST",
      json: { email: testEmail, otp: "000003" }
    });
    assert("Attempt 3 with wrong code returns HTTP 403 Forbidden (Lockout)", resGuess3.status === 403);
    assert("Message indicates maximum attempts exceeded / code invalidated", resGuess3.json && resGuess3.json.message.includes("Maximum attempts exceeded"));

    // Verify OTP row was automatically invalidated/deleted on 3rd failure
    const [dbBrutePurged] = await pool.execute("SELECT COUNT(*) AS count FROM email_otps WHERE email = ?", [testEmail]);
    assert("OTP row permanently deleted after 3 failed attempts", Number(dbBrutePurged[0].count) === 0);

    // Attempt 4: Subsequent attempt with original correct code fails because it was purged
    const resGuess4 = await makeRequest("/api/auth/verify-otp", {
      method: "POST",
      json: { email: testEmail, otp: bruteOtp }
    });
    assert("Subsequent attempt with original code rejected (400)", resGuess4.status === 400);

    // -----------------------------------------------------------------
    // TEST SUITE 7: EXPIRED OTP ENFORCEMENT
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 7] Expired OTP Enforcement...");

    const expiredOtp = "888222";
    const expiredOtpHash = hashOtp(expiredOtp);
    await pool.execute(
      `INSERT INTO email_otps (email, otp_hash, attempts, expires_at, created_at)
       VALUES (?, ?, 0, DATE_SUB(NOW(), INTERVAL 5 MINUTE), DATE_SUB(NOW(), INTERVAL 15 MINUTE))`,
      [testEmail, expiredOtpHash]
    );

    const resExpired = await makeRequest("/api/auth/verify-otp", {
      method: "POST",
      json: { email: testEmail, otp: expiredOtp }
    });
    assert("Submitting expired OTP returns HTTP 400 Bad Request", resExpired.status === 400);
    assert("Response indicates code has expired", resExpired.json && resExpired.json.message.includes("expired"));

    const [dbExpiredPurged] = await pool.execute("SELECT COUNT(*) AS count FROM email_otps WHERE email = ?", [testEmail]);
    assert("Expired OTP row purged on access", Number(dbExpiredPurged[0].count) === 0);

    // -----------------------------------------------------------------
    // TEST SUITE 8: RESEND COOLDOWN / RATE LIMITING (60 SECONDS)
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 8] Resend Cooldown / Rate Limiting (60 Seconds)...");

    // Enable JSON test transport for rate limiting test so dispatch succeeds
    process.env.TEST_EMAIL_TRANSPORT = "json";

    const resSend1 = await makeRequest("/api/auth/send-otp", {
      method: "POST",
      json: { email: testEmail }
    });
    assert("First send-otp request succeeds with HTTP 200", resSend1.status === 200);

    // Immediate second send-otp request within < 60 seconds
    const resSend2 = await makeRequest("/api/auth/send-otp", {
      method: "POST",
      json: { email: testEmail }
    });
    assert("Immediate resend request rejected with HTTP 429 Too Many Requests", resSend2.status === 429);
    assert("Response indicates seconds remaining to wait", resSend2.json && resSend2.json.message.includes("Please wait"));
    assert("Response provides retryAfter property", Boolean(resSend2.json && resSend2.json.retryAfter));

    // Reset env
    if (oldTransportEnv) {
      process.env.TEST_EMAIL_TRANSPORT = oldTransportEnv;
    } else {
      delete process.env.TEST_EMAIL_TRANSPORT;
    }

    // -----------------------------------------------------------------
    // TEST SUITE 9: BACKEND ENFORCEMENT ON PROTECTED MARKETPLACE OPERATIONS
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 9] Backend Enforcement on Protected Marketplace Operations...");

    // Make sure test user is unverified
    await pool.execute("UPDATE users SET email_verified = 0 WHERE id = ?", [testUserId]);

    // 9.1 Attempt to list product directly via API while unverified
    const resUnverProduct = await makeRequest("/api/products", {
      method: "POST",
      token: testUserToken,
      json: { name: "Bypass Item", category: "Books", price: 200, description: "Should be blocked" }
    });
    assert("Unverified user blocked from POST /api/products with HTTP 403 Forbidden", resUnverProduct.status === 403);
    assert("Response message explicitly mentions email verification", resUnverProduct.json && resUnverProduct.json.message.includes("verify your email"));

    // Confirm product was NOT inserted into MySQL
    const [dbBypassProd] = await pool.execute("SELECT COUNT(*) AS count FROM products WHERE seller_id = ?", [testUserId]);
    assert("No product was saved in the database", Number(dbBypassProd[0].count) === 0);

    // 9.2 Attempt to upload student ID verification directly while unverified
    const resUnverVerify = await makeRequest("/api/verification", {
      method: "POST",
      token: testUserToken,
      json: { studentName: "Unverified", studentEmail: testEmail, studentId: "ID123", department: "CS" }
    });
    assert("Unverified user blocked from POST /api/verification with HTTP 403 Forbidden", resUnverVerify.status === 403);
    assert("Response message explicitly mentions email verification", resUnverVerify.json && resUnverVerify.json.message.includes("verify your email"));

    // 9.3 Attempt to send chat message directly while unverified
    const resUnverChat = await makeRequest("/api/chats/1", {
      method: "POST",
      token: testUserToken,
      json: { message: "Hello from unverified user" }
    });
    assert("Unverified user blocked from POST /api/chats/:id with HTTP 403 Forbidden", resUnverChat.status === 403);
    assert("Response message explicitly mentions email verification", resUnverChat.json && resUnverChat.json.message.includes("verify your email"));

    // 9.4 Verify user and approve registration, then re-test: operations must now be permitted
    await pool.execute("UPDATE users SET email_verified = 1, registration_status = 'approved' WHERE id = ?", [testUserId]);

    const resVerProduct = await makeRequest("/api/products", {
      method: "POST",
      token: testUserToken,
      json: { name: "Verified Item", category: "Books", price: 200, description: "Should succeed" }
    });
    assert("Verified user permitted to list product (HTTP 201 Created)", resVerProduct.status === 201);

    // -----------------------------------------------------------------
    // TEST SUITE 10: DECOUPLING OF STATUSES (AUDIT REQUIREMENT 7)
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 10] Decoupling of Verification Statuses (Audit Requirement 7)...");

    const [dbFinalUser] = await pool.execute(
      "SELECT email_verified, registration_status, student_verification_status, role FROM users WHERE id = ?",
      [testUserId]
    );
    assert("email_verified is strictly 1", Number(dbFinalUser[0].email_verified) === 1);
    assert("registration_status is approved", dbFinalUser[0].registration_status === "approved");
    assert("student_verification_status remains 'unverified' (NOT auto-verified)", dbFinalUser[0].student_verification_status === "unverified");
    assert("role remains 'student' (NOT escalated)", dbFinalUser[0].role === "student");

    // -----------------------------------------------------------------
    // CLEANUP
    // -----------------------------------------------------------------
    await pool.execute("DELETE FROM products WHERE seller_id = ?", [testUserId]);
    await pool.execute("DELETE FROM users WHERE id = ?", [testUserId]);
    await pool.execute("DELETE FROM email_otps WHERE email = ?", [testEmail]);
    console.log("\n[INFO] Cleaned up Phase 4 test accounts, products, and OTP rows.");

  } catch (err) {
    console.error("Test execution error:", err);
    failed++;
  } finally {
    await pool.end();
    await new Promise((resolve) => server.close(resolve));
    console.log(`\n==================================================`);
    console.log(`  PHASE 4 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log(`==================================================\n`);
    process.exit(failed > 0 ? 1 : 0);
  }
}

runPhase4Tests();
