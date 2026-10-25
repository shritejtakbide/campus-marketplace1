process.env.TEST_MODE = "true";
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const mysql = require("mysql2/promise");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
require("dotenv").config();

const server = require("../backend/server.js");

async function runPhase3Tests() {
  console.log("==================================================");
  console.log("  CAMPUS MARKETPLACE — PHASE 3 AUTHENTICATION TESTS");
  console.log("==================================================");

  const PORT = 3002; // Isolated test port
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
  const testBcryptEmail = `test_bcrypt_${testStamp}@campus.local`;
  const testBcryptPassword = "SecureBcryptPass123!";
  const testLegacyEmail = `test_legacy_${testStamp}@campus.local`;
  const testLegacyPassword = "LegacySha256Pass456!";

  try {
    // -----------------------------------------------------------------
    // TEST SUITE 1: BCRYPT PASSWORD STORAGE ON REGISTRATION
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 1] Registration with Bcrypt Password Storage...");

    // 1.1 Input validation checks
    const resShortPass = await makeRequest("/api/auth/register", {
      method: "POST",
      json: { name: "Short Pass", email: `short_${testStamp}@campus.local`, password: "123" }
    });
    assert("Rejects registration with password shorter than 6 characters (400)", resShortPass.status === 400);

    const resMissingEmail = await makeRequest("/api/auth/register", {
      method: "POST",
      json: { name: "No Email", password: "some_valid_pass" }
    });
    assert("Rejects registration with missing email (400)", resMissingEmail.status === 400);

    // 1.2 Valid registration
    const resReg = await makeRequest("/api/auth/register", {
      method: "POST",
      json: { name: "Bcrypt Student", email: testBcryptEmail, password: testBcryptPassword }
    });
    assert("Registration returns HTTP 201 Created", resReg.status === 201);
    assert("Response has success=true", resReg.json && resReg.json.success === true);
    assert("Response provides session token", Boolean(resReg.json && resReg.json.token));
    assert("Response user contains id, name, email", Boolean(resReg.json && resReg.json.user && resReg.json.user.id));
    assert("Response does NOT leak password_hash", resReg.json && resReg.json.user && resReg.json.user.password_hash === undefined);
    assert("Response does NOT leak any secrets", !JSON.stringify(resReg.json).includes("hash") && !JSON.stringify(resReg.json).includes("salt"));

    // 1.3 Verify database stores salted bcrypt hash with cost factor 12
    const [dbUsers] = await pool.execute(
      "SELECT id, name, email, password_hash, role, email_verified, registration_status FROM users WHERE email = ? LIMIT 1",
      [testBcryptEmail]
    );
    assert("New user found in MySQL database", dbUsers.length === 1);
    const registeredUser = dbUsers[0];
    assert("Stored password_hash is not plain text", registeredUser.password_hash !== testBcryptPassword);
    assert("Stored password_hash is not SHA-256", registeredUser.password_hash.length !== 64);
    assert("Stored password_hash starts with bcrypt prefix ($2b$)", registeredUser.password_hash.startsWith("$2b$") || registeredUser.password_hash.startsWith("$2a$"));
    assert("Stored password_hash is standard 60-character bcrypt string", registeredUser.password_hash.length === 60);

    // Verify bcrypt work factor is 12
    const costFactor = parseInt(registeredUser.password_hash.split("$")[2], 10);
    assert("Bcrypt work factor is exactly 12", costFactor === 12);

    // Verify hash validates correctly with bcrypt
    const bcryptCheck = await bcrypt.compare(testBcryptPassword, registeredUser.password_hash);
    assert("Bcrypt library validates the password against stored hash", bcryptCheck === true);

    // 1.4 Duplicate registration rejection
    const resDup = await makeRequest("/api/auth/register", {
      method: "POST",
      json: { name: "Duplicate", email: testBcryptEmail, password: testBcryptPassword }
    });
    assert("Rejects duplicate registration with HTTP 409 Conflict", resDup.status === 409);

    // -----------------------------------------------------------------
    // TEST SUITE 2: AUTHENTICATION WITH BCRYPT CREDENTIALS
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 2] Login with Bcrypt Credentials...");

    // 2.1 Valid Login
    const resLogin = await makeRequest("/api/auth/login", {
      method: "POST",
      json: { email: testBcryptEmail, password: testBcryptPassword }
    });
    assert("Login with valid bcrypt password returns HTTP 200 OK", resLogin.status === 200);
    assert("Login response returns success=true", resLogin.json && resLogin.json.success === true);
    assert("Login response returns session token", Boolean(resLogin.json && resLogin.json.token));
    assert("Login response user is sanitized (no password_hash)", resLogin.json && resLogin.json.user && resLogin.json.user.password_hash === undefined);
    assert("Login response contains user role and status", resLogin.json && resLogin.json.user && resLogin.json.user.role === "student");
    const activeToken = resLogin.json.token;

    // Verify session row in MySQL has future expires_at
    const [sessRows] = await pool.execute(
      "SELECT token, user_id, expires_at, created_at FROM sessions WHERE token = ? LIMIT 1",
      [activeToken]
    );
    assert("Session recorded in MySQL database", sessRows.length === 1);
    assert("Session expires_at is set in the future", sessRows[0].expires_at && new Date(sessRows[0].expires_at).getTime() > Date.now());

    // 2.2 Invalid Login: Wrong Password
    const resBadPass = await makeRequest("/api/auth/login", {
      method: "POST",
      json: { email: testBcryptEmail, password: "WrongPassword999!" }
    });
    assert("Login with incorrect password returns HTTP 401 Unauthorized", resBadPass.status === 401);
    assert("Generic error message returned ('Invalid email or password.')", resBadPass.json && resBadPass.json.message === "Invalid email or password.");

    // 2.3 Invalid Login: Non-existent User
    const resNoUser = await makeRequest("/api/auth/login", {
      method: "POST",
      json: { email: `nonexistent_${testStamp}@campus.local`, password: "SomePassword123!" }
    });
    assert("Login with nonexistent email returns HTTP 401 Unauthorized", resNoUser.status === 401);
    assert("Consistent generic error message returned (prevents email enumeration)", resNoUser.json && resNoUser.json.message === "Invalid email or password.");

    // 2.4 Invalid Login: Missing Credentials
    const resNoCreds = await makeRequest("/api/auth/login", {
      method: "POST",
      json: { email: "", password: "" }
    });
    assert("Login with missing credentials returns HTTP 400 Bad Request", resNoCreds.status === 400);

    // -----------------------------------------------------------------
    // TEST SUITE 3: SAFE LEGACY-PASSWORD MIGRATION (TRANSPARENT REHASH)
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 3] Safe Legacy SHA-256 Migration & Transparent Rehashing...");

    // 3.1 Directly insert a legacy account storing an unsalted single-round SHA-256 hash
    const legacySha256Hash = crypto.createHash("sha256").update(testLegacyPassword).digest("hex");
    assert("Legacy SHA-256 hash is 64 hex characters", legacySha256Hash.length === 64);
    assert("Legacy SHA-256 does NOT start with $2", !legacySha256Hash.startsWith("$2"));

    await pool.execute(
      `INSERT INTO users (name, email, password_hash, role, email_verified, registration_status, student_verification_status, verified, created_at)
       VALUES (?, ?, ?, 'student', 0, 'approved', 'unverified', 0, NOW())`,
      ["Legacy Account", testLegacyEmail, legacySha256Hash]
    );

    // Confirm legacy hash is currently in DB
    const [legacyBefore] = await pool.execute(
      "SELECT id, password_hash FROM users WHERE email = ? LIMIT 1",
      [testLegacyEmail]
    );
    assert("Legacy user registered with raw SHA-256 hash", legacyBefore[0].password_hash === legacySha256Hash);

    // 3.2 Login with legacy credentials
    const resLegacyLogin = await makeRequest("/api/auth/login", {
      method: "POST",
      json: { email: testLegacyEmail, password: testLegacyPassword }
    });
    assert("Legacy account login succeeds with HTTP 200 OK", resLegacyLogin.status === 200);
    assert("Legacy login returns session token", Boolean(resLegacyLogin.json && resLegacyLogin.json.token));
    assert("Legacy login user is sanitized (no password_hash)", resLegacyLogin.json.user.password_hash === undefined);

    // 3.3 Confirm transparent upgrade in DB to bcrypt
    const [legacyAfter] = await pool.execute(
      "SELECT id, password_hash FROM users WHERE email = ? LIMIT 1",
      [testLegacyEmail]
    );
    const upgradedHash = legacyAfter[0].password_hash;
    assert("Password hash was automatically migrated away from SHA-256", upgradedHash !== legacySha256Hash);
    assert("Upgraded password hash is now a valid bcrypt hash ($2b$)", upgradedHash.startsWith("$2b$") || upgradedHash.startsWith("$2a$"));
    assert("Upgraded password hash has length 60", upgradedHash.length === 60);

    const upgradedCostFactor = parseInt(upgradedHash.split("$")[2], 10);
    assert("Upgraded hash uses work factor 12", upgradedCostFactor === 12);

    const upgradedBcryptMatch = await bcrypt.compare(testLegacyPassword, upgradedHash);
    assert("Bcrypt library successfully verifies original password against upgraded hash", upgradedBcryptMatch === true);

    // 3.4 Verify subsequent login works using the newly upgraded bcrypt hash
    const resLegacyLogin2 = await makeRequest("/api/auth/login", {
      method: "POST",
      json: { email: testLegacyEmail, password: testLegacyPassword }
    });
    assert("Subsequent login using upgraded bcrypt hash succeeds (200)", resLegacyLogin2.status === 200);

    // 3.5 Verify wrong password still rejected on upgraded account
    const resLegacyBadPass = await makeRequest("/api/auth/login", {
      method: "POST",
      json: { email: testLegacyEmail, password: "WrongPassNow!" }
    });
    assert("Upgraded account rejects incorrect password with HTTP 401", resLegacyBadPass.status === 401);

    // -----------------------------------------------------------------
    // TEST SUITE 4: SESSION EXPIRATION ENFORCEMENT
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 4] Session Token Generation & Expiration Enforcement...");

    // 4.1 Valid token works for /api/me
    const resMeValid = await makeRequest("/api/me", { token: activeToken });
    assert("Active session token allows access to /api/me (200)", resMeValid.status === 200);
    assert("GET /api/me returns sanitized user object", resMeValid.json && resMeValid.json.user && resMeValid.json.user.email === testBcryptEmail);
    assert("GET /api/me does not expose password_hash", resMeValid.json.user.password_hash === undefined);

    // 4.2 Manually expire session in MySQL database
    await pool.execute(
      "UPDATE sessions SET expires_at = DATE_SUB(NOW(), INTERVAL 2 HOUR) WHERE token = ?",
      [activeToken]
    );

    // 4.3 Expired token is rejected on /api/me
    const resMeExpired = await makeRequest("/api/me", { token: activeToken });
    assert("Expired session token is rejected with HTTP 401 Unauthorized", resMeExpired.status === 401);
    assert("Expired session response indicates 'Not logged in.'", resMeExpired.json && resMeExpired.json.message === "Not logged in.");

    // 4.4 Expired token is rejected on protected business endpoint (POST /api/products)
    const resProdExpired = await makeRequest("/api/products", {
      method: "POST",
      token: activeToken,
      json: { name: "Expired Product Test", category: "Books", price: 100, description: "Should fail" }
    });
    assert("Expired token rejected on protected POST /api/products (401)", resProdExpired.status === 401);

    // -----------------------------------------------------------------
    // TEST SUITE 5: LOGOUT INVALIDATION
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 5] Logout Invalidation & Token Revocation...");

    // 5.1 Obtain a fresh session token
    const resFreshLogin = await makeRequest("/api/auth/login", {
      method: "POST",
      json: { email: testBcryptEmail, password: testBcryptPassword }
    });
    const freshToken = resFreshLogin.json.token;

    // Verify token works
    const resMeFresh = await makeRequest("/api/me", { token: freshToken });
    assert("Fresh login token is initially valid (200)", resMeFresh.status === 200);

    // 5.2 Execute logout
    const resLogout = await makeRequest("/api/auth/logout", {
      method: "POST",
      token: freshToken
    });
    assert("POST /api/auth/logout returns HTTP 200 OK", resLogout.status === 200);
    assert("Logout message indicates success", resLogout.json && resLogout.json.message === "Logged out successfully.");

    // 5.3 Verify token deleted from database
    const [sessDeleted] = await pool.execute(
      "SELECT COUNT(*) AS count FROM sessions WHERE token = ?",
      [freshToken]
    );
    assert("Session row was deleted from MySQL sessions table", Number(sessDeleted[0].count) === 0);

    // 5.4 Verify subsequent request with invalidated token returns 401
    const resMeLoggedOut = await makeRequest("/api/me", { token: freshToken });
    assert("Logged out token is rejected on /api/me with HTTP 401 Unauthorized", resMeLoggedOut.status === 401);

    // -----------------------------------------------------------------
    // TEST SUITE 6: UNAUTHORIZED REQUESTS & PROTECTION OF ROUTES
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 6] Unauthorized Requests & Protected Routes...");

    // 6.1 No token provided
    const resNoTokenMe = await makeRequest("/api/me");
    assert("GET /api/me without token returns HTTP 401", resNoTokenMe.status === 401);

    const resNoTokenProd = await makeRequest("/api/products", {
      method: "POST",
      json: { name: "Unauthorized Item", price: 50 }
    });
    assert("POST /api/products without token returns HTTP 401", resNoTokenProd.status === 401);

    const resNoTokenVerify = await makeRequest("/api/verification", {
      method: "POST",
      json: { studentName: "Unauthorized" }
    });
    assert("POST /api/verification without token returns HTTP 401", resNoTokenVerify.status === 401);

    const resNoTokenChat = await makeRequest("/api/chats/1", {
      method: "POST",
      json: { message: "Hello" }
    });
    assert("POST /api/chats/:id without token returns HTTP 401", resNoTokenChat.status === 401);

    // 6.2 Bogus / forged token provided
    const resBogusToken = await makeRequest("/api/me", { token: "forged_malicious_token_1234567890" });
    assert("GET /api/me with forged token returns HTTP 401", resBogusToken.status === 401);

    // -----------------------------------------------------------------
    // TEST SUITE 7: SENSITIVE FIELD NON-EXPOSURE (LEAKAGE AUDIT)
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 7] Sensitive Field Non-Exposure Audit...");

    // Inspect public product endpoints
    const resProducts = await makeRequest("/api/products");
    assert("GET /api/products returns HTTP 200", resProducts.status === 200);
    const prodBody = resProducts.body;
    assert("GET /api/products does not expose password_hash", !prodBody.includes("password_hash"));
    assert("GET /api/products does not expose password", !prodBody.includes('"password"'));
    assert("GET /api/products does not expose otp_hash", !prodBody.includes("otp_hash"));

    // Inspect single product
    const resSingleProd = await makeRequest("/api/products/1");
    if (resSingleProd.status === 200) {
      assert("GET /api/products/:id does not expose password_hash", !resSingleProd.body.includes("password_hash"));
    } else {
      assert("GET /api/products/:id responded safely (no leakage)", !resSingleProd.body.includes("password_hash"));
    }

    // -----------------------------------------------------------------
    // TEST SUITE 8: PRESERVATION OF MARKETPLACE & LIQUID GLASS ASSETS
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 8] Preservation of Liquid Glass Assets & API Contracts...");
    const resCss = await makeRequest("/style.css");
    assert("Liquid Glass CSS styles preserved (200)", resCss.status === 200 && resCss.body.includes(".glass"));
    const resIndex = await makeRequest("/");
    assert("Frontend HTML preserved (200)", resIndex.status === 200 && resIndex.body.includes("Campus Marketplace"));

    // Cleanup created test users
    await pool.execute("DELETE FROM users WHERE email IN (?, ?)", [testBcryptEmail, testLegacyEmail]);
    console.log("\n[INFO] Test accounts cleaned up from MySQL database.");

  } catch (err) {
    console.error("Test execution error:", err);
    failed++;
  } finally {
    await pool.end();
    await new Promise((resolve) => server.close(resolve));
    console.log(`\n==================================================`);
    console.log(`  PHASE 3 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log(`==================================================\n`);
    process.exit(failed > 0 ? 1 : 0);
  }
}

runPhase3Tests();
