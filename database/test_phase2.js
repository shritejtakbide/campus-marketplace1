process.env.TEST_MODE = "true";
const http = require("http");
const path = require("path");
const mysql = require("mysql2/promise");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
require("dotenv").config();

// Require backend server and admin provisioner
const server = require("../backend/server.js");
const { createOrUpdateAdmin } = require("./create_admin.js");

async function runTests() {
  console.log("==================================================");
  console.log("  CAMPUS MARKETPLACE — PHASE 2.1 SECURITY & TESTS ");
  console.log("==================================================");

  const PORT = 3001; // isolated test port
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

  function makeRequest(path, options = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: PORT,
          path,
          method: options.method || "GET",
          headers: options.headers || {}
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
      if (options.body) {
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

  try {
    // 1. Static HTML serving from frontend/
    console.log("\n[TEST 1] Static Frontend HTML Serving (from frontend/)...");
    const resHome = await makeRequest("/");
    assert("HTTP Status is 200", resHome.status === 200);
    assert("Content-Type is text/html", resHome.headers["content-type"].includes("text/html"));
    assert("Body contains 'Campus Marketplace'", resHome.body.includes("Campus Marketplace"));
    assert("Body loads style.css and script.js", resHome.body.includes("style.css") && resHome.body.includes("script.js"));

    // 2. Static CSS serving from frontend/
    console.log("\n[TEST 2] Static Frontend CSS Serving (from frontend/)...");
    const resCss = await makeRequest("/style.css");
    assert("HTTP Status is 200", resCss.status === 200);
    assert("Content-Type is text/css", resCss.headers["content-type"].includes("text/css"));
    assert("Contains Liquid Glass tokens (.background)", resCss.body.includes(".background"));

    // 3. Static JS serving from frontend/
    console.log("\n[TEST 3] Static Frontend JS Serving (from frontend/)...");
    const resJs = await makeRequest("/script.js");
    assert("HTTP Status is 200", resJs.status === 200);
    assert("Content-Type is application/javascript", resJs.headers["content-type"].includes("application/javascript"));
    assert("Contains client API fetcher", resJs.body.includes("const API = \"/api\";"));

    // 4. API Health Check
    console.log("\n[TEST 4] API Health Check...");
    const resHealth = await makeRequest("/api/health");
    assert("HTTP Status is 200", resHealth.status === 200);
    assert("Database is MySQL", resHealth.json && resHealth.json.database === "MySQL");
    assert("API running message", resHealth.json && resHealth.json.success === true);

    // 5. API Products List
    console.log("\n[TEST 5] API Products Retrieval...");
    const resProducts = await makeRequest("/api/products");
    assert("HTTP Status is 200", resProducts.status === 200);
    assert("Returns products array", resProducts.json && Array.isArray(resProducts.json.products));
    assert("Contains at least 6 seed products", resProducts.json && resProducts.json.products.length >= 6);

    // 6. API Authentication (Login with Demo Student)
    console.log("\n[TEST 6] Student Login Authentication...");
    const loginPayload = JSON.stringify({
      email: "student@campus.local",
      password: "student123"
    });
    const resLogin = await makeRequest("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(loginPayload) },
      body: loginPayload
    });
    assert("HTTP Status is 200", resLogin.status === 200);
    assert("Session token returned", resLogin.json && Boolean(resLogin.json.token));
    assert("User email matches", resLogin.json && resLogin.json.user && resLogin.json.user.email === "student@campus.local");
    const authToken = resLogin.json ? resLogin.json.token : null;

    // 7. API Authenticated Endpoint (/api/me)
    console.log("\n[TEST 7] Current User (/api/me) with Bearer Token...");
    const resMe = await makeRequest("/api/me", {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert("HTTP Status is 200", resMe.status === 200);
    assert("User profile returned", resMe.json && resMe.json.user && resMe.json.user.name === "Demo Student");

    // 8. SECURITY TEST: Insecure Hardcoded Admin Absence
    console.log("\n[TEST 8] Security: Insecure Default Admin Absence...");
    const insecureAdminPayload = JSON.stringify({
      email: "admin@campus.local",
      password: "admin123"
    });
    const resInsecureAdmin = await makeRequest("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(insecureAdminPayload) },
      body: insecureAdminPayload
    });
    assert("Hardcoded admin credentials rejected with 401 Unauthorized", resInsecureAdmin.status === 401);
    assert("No session token issued for unprovisioned default admin", !resInsecureAdmin.json || !resInsecureAdmin.json.token);

    // 9. SECURITY TEST: Explicit Admin Provisioning & Login
    console.log("\n[TEST 9] Security: Explicit Admin Account Provisioning...");
    const tempAdminEmail = "test_sysadmin@campus.local";
    const tempAdminPassword = "Secure_Admin_Pass_2026!";
    await createOrUpdateAdmin(tempAdminEmail, tempAdminPassword, "Test Administrator");

    const secureAdminPayload = JSON.stringify({
      email: tempAdminEmail,
      password: tempAdminPassword
    });
    const resSecureAdmin = await makeRequest("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(secureAdminPayload) },
      body: secureAdminPayload
    });
    assert("Explicitly provisioned admin login succeeds with 200 OK", resSecureAdmin.status === 200);
    assert("Admin session token issued", resSecureAdmin.json && Boolean(resSecureAdmin.json.token));

    // Verify role in database
    const [adminRow] = await pool.execute(
      "SELECT role, email_verified, registration_status FROM `users` WHERE `email` = ?",
      [tempAdminEmail]
    );
    assert("Admin user role is strictly 'admin'", adminRow.length > 0 && adminRow[0].role === "admin");
    assert("Admin registration_status is 'approved'", adminRow.length > 0 && adminRow[0].registration_status === "approved");

    // Clean up temporary test admin
    await pool.execute("DELETE FROM `users` WHERE `email` = ?", [tempAdminEmail]);
    console.log("  ✓ Cleaned up temporary test administrator.");

    // 10. INTEGRITY TEST: Legacy Account Email Verification Status
    console.log("\n[TEST 10] Integrity: Legacy User Email Verification Status...");
    const [legacyUsers] = await pool.execute(
      "SELECT id, email, email_verified, registration_status FROM `users` WHERE `email` != 'student@campus.local'"
    );
    for (const u of legacyUsers) {
      assert(`Legacy user ${u.email} has email_verified = 0 (unverified)`, Number(u.email_verified) === 0);
      assert(`Legacy user ${u.email} has registration_status = 'approved'`, u.registration_status === "approved");
    }

    // 11. SCHEMA TEST: Table Count & Column Integrity
    console.log("\n[TEST 11] Schema: Table Count & Column Integrity...");
    const [tables] = await pool.execute(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()`
    );
    const tableNames = tables.map(t => Object.values(t)[0]);
    assert("Database has exactly 8 tables", tableNames.length === 8);
    const expectedTables = [
      "users", "email_otps", "sessions", "products",
      "verification", "chats", "chat_threads", "chat_messages"
    ];
    for (const et of expectedTables) {
      assert(`Table \`${et}\` exists`, tableNames.includes(et));
    }

    // Verify key columns
    const [userCols] = await pool.execute(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users'"
    );
    const uColNames = userCols.map(c => c.COLUMN_NAME);
    assert("`users` has `role` column", uColNames.includes("role"));
    assert("`users` has `email_verified` column", uColNames.includes("email_verified"));
    assert("`users` has `registration_status` column", uColNames.includes("registration_status"));
    assert("`users` has `student_verification_status` column", uColNames.includes("student_verification_status"));
    assert("`users` has `updated_at` column", uColNames.includes("updated_at"));

    const [sessCols] = await pool.execute(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'sessions'"
    );
    const sColNames = sessCols.map(c => c.COLUMN_NAME);
    assert("`sessions` has `expires_at` column", sColNames.includes("expires_at"));

    const [prodCols] = await pool.execute(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'products'"
    );
    const pColNames = prodCols.map(c => c.COLUMN_NAME);
    assert("`products` has `status` column", pColNames.includes("status"));

  } catch (err) {
    console.error("Test execution error:", err);
    failed++;
  } finally {
    await pool.end();
    await new Promise((resolve) => server.close(resolve));
    console.log(`\n==================================================`);
    console.log(`  PHASE 2.1 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log(`==================================================\n`);
    process.exit(failed > 0 ? 1 : 0);
  }
}

runTests();
