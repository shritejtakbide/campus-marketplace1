process.env.TEST_MODE = "true";
const http = require("http");
const path = require("path");
const mysql = require("mysql2/promise");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
require("dotenv").config();

const { createOrUpdateAdmin } = require("./create_admin.js");
const server = require("../backend/server.js");

const TEST_PORT = 3005;
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

async function runPhase5Tests() {
  console.log("==================================================");
  console.log("  CAMPUS MARKETPLACE — PHASE 5 ADMIN APPROVAL TESTS");
  console.log("==================================================");

  // Configure pool
  pool = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "campus_marketplace",
    waitForConnections: true,
    connectionLimit: 5
  });

  // Start server on TEST_PORT
  await new Promise((resolve) => {
    server.listen(TEST_PORT, "127.0.0.1", () => {
      console.log(`[TEST] Server listening on ${BASE_URL}`);
      resolve();
    });
  });

  // Test credentials
  const timestamp = Date.now();
  const adminEmail = `p5_admin_${timestamp}@campus.local`;
  const adminPass = "AdminP@ss123!";
  const studentEmail = `p5_student_${timestamp}@campus.local`;
  const studentPass = "StudentP@ss123!";
  const peerEmail = `p5_peer_${timestamp}@campus.local`;
  const peerPass = "PeerP@ss123!";

  let adminId, adminToken;
  let studentId, studentToken;
  let peerId, peerToken;

  try {
    // -----------------------------------------------------------------
    // TEST SUITE 1: UNAUTHENTICATED REQUESTS TO ADMIN ENDPOINTS (401)
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 1] Unauthenticated Requests to Admin Endpoints (401)...");

    const unauthList = await makeRequest("/api/admin/registrations");
    assert("GET /api/admin/registrations without token returns 401", unauthList.status === 401);

    const unauthDetail = await makeRequest("/api/admin/registrations/1");
    assert("GET /api/admin/registrations/:id without token returns 401", unauthDetail.status === 401);

    const unauthApprove = await makeRequest("/api/admin/registrations/1/approve", { method: "POST" });
    assert("POST /api/admin/registrations/:id/approve without token returns 401", unauthApprove.status === 401);

    const unauthReject = await makeRequest("/api/admin/registrations/1/reject", { method: "POST", json: { reason: "test" } });
    assert("POST /api/admin/registrations/:id/reject without token returns 401", unauthReject.status === 401);

    const unauthReReview = await makeRequest("/api/admin/registrations/1/re-review", { method: "POST" });
    assert("POST /api/admin/registrations/:id/re-review without token returns 401", unauthReReview.status === 401);

    // -----------------------------------------------------------------
    // TEST SUITE 2: STUDENT ATTEMPTING ADMIN ACTIONS (403 FORBIDDEN)
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 2] Student Attempting Admin Endpoints (403)...");

    const regStudentRes = await makeRequest("/api/auth/register", {
      method: "POST",
      json: { name: "Test Student", email: studentEmail, password: studentPass }
    });
    studentToken = regStudentRes.json.token;
    studentId = regStudentRes.json.user.id;

    const studentList = await makeRequest("/api/admin/registrations", { token: studentToken });
    assert("Student cannot list registrations (HTTP 403 Forbidden)", studentList.status === 403);
    assert("Response message reports admin authorization required", studentList.json && studentList.json.message.includes("Administrator"));

    const studentDetail = await makeRequest(`/api/admin/registrations/${studentId}`, { token: studentToken });
    assert("Student cannot view admin registration detail (HTTP 403 Forbidden)", studentDetail.status === 403);

    const studentApprove = await makeRequest(`/api/admin/registrations/${studentId}/approve`, { method: "POST", token: studentToken });
    assert("Student cannot approve registrations (HTTP 403 Forbidden)", studentApprove.status === 403);

    const studentReject = await makeRequest(`/api/admin/registrations/${studentId}/reject`, { method: "POST", token: studentToken, json: { reason: "Hacking" } });
    assert("Student cannot reject registrations (HTTP 403 Forbidden)", studentReject.status === 403);

    const studentReReview = await makeRequest(`/api/admin/registrations/${studentId}/re-review`, { method: "POST", token: studentToken });
    assert("Student cannot trigger re-review (HTTP 403 Forbidden)", studentReReview.status === 403);

    // -----------------------------------------------------------------
    // TEST SUITE 3: ADMIN PROVISIONING & AUTHENTICATION
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 3] Admin Provisioning & Authentication...");

    await createOrUpdateAdmin(adminEmail, adminPass, "Phase5 SysAdmin");

    const adminLoginRes = await makeRequest("/api/auth/login", {
      method: "POST",
      json: { email: adminEmail, password: adminPass }
    });
    assert("Admin login returns HTTP 200 OK", adminLoginRes.status === 200);
    adminToken = adminLoginRes.json.token;
    adminId = adminLoginRes.json.user.id;
    assert("Admin login returns user.role === 'admin'", adminLoginRes.json.user.role === "admin");

    const adminMe = await makeRequest("/api/me", { token: adminToken });
    assert("Admin GET /api/me returns HTTP 200 OK", adminMe.status === 200);
    assert("Admin /api/me confirms role is strictly 'admin'", adminMe.json.user.role === "admin");

    // -----------------------------------------------------------------
    // TEST SUITE 4: ADMIN LIST REGISTRATIONS & FILTERING
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 4] Admin List Registrations & Filters...");

    // Register a second student to test lists
    const regPeerRes = await makeRequest("/api/auth/register", {
      method: "POST",
      json: { name: "Peer Student", email: peerEmail, password: peerPass }
    });
    peerToken = regPeerRes.json.token;
    peerId = regPeerRes.json.user.id;

    // 4.1 Default list (pending)
    const listPending = await makeRequest("/api/admin/registrations", { token: adminToken });
    assert("Admin list returns HTTP 200 OK", listPending.status === 200);
    assert("Response contains registrations array", Array.isArray(listPending.json.registrations));
    assert("Response contains pagination metadata", listPending.json.pagination && typeof listPending.json.pagination.total === "number");
    const foundPendingStudent = listPending.json.registrations.find(r => r.id === studentId);
    assert("Newly registered student appears in pending list", Boolean(foundPendingStudent));
    assert("Student record has registrationStatus === 'pending'", foundPendingStudent && foundPendingStudent.registrationStatus === "pending");

    // 4.2 Status filter: all
    const listAll = await makeRequest("/api/admin/registrations?status=all", { token: adminToken });
    assert("Admin list with status=all returns HTTP 200", listAll.status === 200);
    assert("Both test students appear in all list", listAll.json.registrations.some(r => r.id === studentId) && listAll.json.registrations.some(r => r.id === peerId));

    // 4.3 Invalid status filter returns 400
    const listInvalidStatus = await makeRequest("/api/admin/registrations?status=unknown_filter", { token: adminToken });
    assert("Admin list with invalid status returns HTTP 400 Bad Request", listInvalidStatus.status === 400);

    // -----------------------------------------------------------------
    // TEST SUITE 5: VIEW SINGLE REGISTRATION DETAILS
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 5] View Single Registration Details...");

    const singleReg = await makeRequest(`/api/admin/registrations/${studentId}`, { token: adminToken });
    assert("GET /api/admin/registrations/:id returns HTTP 200", singleReg.status === 200);
    assert("Returns correct student name", singleReg.json.registration.name === "Test Student");
    assert("Returns correct student email", singleReg.json.registration.email === studentEmail);
    assert("Returns registrationStatus === 'pending'", singleReg.json.registration.registrationStatus === "pending");
    assert("Returns emailVerified === false", singleReg.json.registration.emailVerified === false);
    assert("Returns studentVerificationStatus === 'unverified'", singleReg.json.registration.studentVerificationStatus === "unverified");

    // -----------------------------------------------------------------
    // TEST SUITE 6: ADMIN APPROVE REGISTRATION WORKFLOW
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 6] Approve Registration Workflow...");

    const approveRes = await makeRequest(`/api/admin/registrations/${studentId}/approve`, {
      method: "POST",
      token: adminToken
    });
    assert("Approve returns HTTP 200 OK", approveRes.status === 200);
    assert("Approve response indicates success", approveRes.json.success === true);

    // Check database state
    const [dbApproved] = await pool.execute(
      "SELECT registration_status, registration_reviewed_by, registration_reviewed_at, registration_rejection_reason FROM users WHERE id = ?",
      [studentId]
    );
    assert("Database registration_status is now 'approved'", dbApproved[0].registration_status === "approved");
    assert("Database registration_reviewed_by is recorded as admin ID", Number(dbApproved[0].registration_reviewed_by) === adminId);
    assert("Database registration_reviewed_at is recorded", Boolean(dbApproved[0].registration_reviewed_at));
    assert("Database registration_rejection_reason is NULL", dbApproved[0].registration_rejection_reason === null);

    // -----------------------------------------------------------------
    // TEST SUITE 7: INVALID STATUS TRANSITIONS & SAFETY CHECKS
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 7] Invalid Status Transitions & Error Handling...");

    // 7.1 Approve an already approved account -> 400
    const reApproveRes = await makeRequest(`/api/admin/registrations/${studentId}/approve`, {
      method: "POST",
      token: adminToken
    });
    assert("Approving already approved registration returns HTTP 400 Bad Request", reApproveRes.status === 400);

    // 7.2 Nonexistent ID -> 404
    const notFoundApprove = await makeRequest("/api/admin/registrations/999999/approve", {
      method: "POST",
      token: adminToken
    });
    assert("Approving non-existent registration returns HTTP 404 Not Found", notFoundApprove.status === 404);

    // 7.3 Invalid non-numeric ID -> 400
    const invalidIdApprove = await makeRequest("/api/admin/registrations/invalid_id/approve", {
      method: "POST",
      token: adminToken
    });
    assert("Approving invalid non-numeric ID returns HTTP 400 Bad Request", invalidIdApprove.status === 400);

    // 7.4 Modifying admin account status -> 400
    const adminSelfModify = await makeRequest(`/api/admin/registrations/${adminId}/approve`, {
      method: "POST",
      token: adminToken
    });
    assert("Cannot modify administrator accounts via registration endpoints (400)", adminSelfModify.status === 400);

    // -----------------------------------------------------------------
    // TEST SUITE 8: REJECT REGISTRATION WORKFLOW & SESSION INVALIDATION
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 8] Reject Registration & Immediate Session Revocation...");

    // Verify peer has an active session
    const peerMeBefore = await makeRequest("/api/me", { token: peerToken });
    assert("Peer session is initially valid (200 OK)", peerMeBefore.status === 200);

    const rejectRes = await makeRequest(`/api/admin/registrations/${peerId}/reject`, {
      method: "POST",
      token: adminToken,
      json: { reason: "Non-institutional domain used" }
    });
    assert("Reject returns HTTP 200 OK", rejectRes.status === 200);
    assert("Reject returns registrationStatus === 'rejected'", rejectRes.json.registrationStatus === "rejected");

    // Check database state
    const [dbRejected] = await pool.execute(
      "SELECT registration_status, registration_reviewed_by, registration_reviewed_at, registration_rejection_reason FROM users WHERE id = ?",
      [peerId]
    );
    assert("Database registration_status is 'rejected'", dbRejected[0].registration_status === "rejected");
    assert("Database registration_rejection_reason stored correctly", dbRejected[0].registration_rejection_reason === "Non-institutional domain used");
    assert("Database registration_reviewed_by is recorded as admin ID", Number(dbRejected[0].registration_reviewed_by) === adminId);

    // Check immediate session revocation
    const [peerSessions] = await pool.execute("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?", [peerId]);
    assert("Active sessions for rejected user immediately deleted from MySQL", Number(peerSessions[0].count) === 0);

    const peerMeAfter = await makeRequest("/api/me", { token: peerToken });
    assert("Existing session token rejected immediately after admin rejection (HTTP 401)", peerMeAfter.status === 401);

    // 7.5 Approve an already rejected account directly -> 400 (re-review required)
    const directApproveRejected = await makeRequest(`/api/admin/registrations/${peerId}/approve`, {
      method: "POST",
      token: adminToken
    });
    assert("Direct approval of rejected account without re-review returns HTTP 400 Bad Request", directApproveRejected.status === 400);

    // 7.6 Reject an already rejected account -> 400
    const reRejectRes = await makeRequest(`/api/admin/registrations/${peerId}/reject`, {
      method: "POST",
      token: adminToken,
      json: { reason: "Another reason" }
    });
    assert("Rejecting an already rejected registration returns HTTP 400 Bad Request", reRejectRes.status === 400);

    // -----------------------------------------------------------------
    // TEST SUITE 9: EXPLICIT RE-REVIEW PROCESS
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 9] Explicit Re-Review Process...");

    const reReviewRes = await makeRequest(`/api/admin/registrations/${peerId}/re-review`, {
      method: "POST",
      token: adminToken
    });
    assert("Return to re-review returns HTTP 200 OK", reReviewRes.status === 200);

    const [dbReReviewed] = await pool.execute(
      "SELECT registration_status, registration_rejection_reason FROM users WHERE id = ?",
      [peerId]
    );
    assert("Database registration_status is now reset to 'pending'", dbReReviewed[0].registration_status === "pending");
    assert("Database rejection reason cleared on re-review", dbReReviewed[0].registration_rejection_reason === null);

    // Now approval is permitted
    const legitApproveAfterReReview = await makeRequest(`/api/admin/registrations/${peerId}/approve`, {
      method: "POST",
      token: adminToken
    });
    assert("Legitimate approval succeeds after re-review (HTTP 200 OK)", legitApproveAfterReReview.status === 200);

    // -----------------------------------------------------------------
    // TEST SUITE 10: BACKEND ENFORCEMENT ON PROTECTED MARKETPLACE OPERATIONS
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 10] Backend Authorization Enforcement across Marketplace Operations...");

    // Create a new pending user
    const pendingEmail = `p5_pending_${timestamp}@campus.local`;
    const regPendingRes = await makeRequest("/api/auth/register", {
      method: "POST",
      json: { name: "Pending User", email: pendingEmail, password: "Password123!" }
    });
    const pendingToken = regPendingRes.json.token;
    const pendingUserId = regPendingRes.json.user.id;

    // Verify email for pending user (email verified, but registration pending)
    await pool.execute("UPDATE users SET email_verified = 1 WHERE id = ?", [pendingUserId]);

    // 10.1 Pending user blocked from listing products
    const resPendingProduct = await makeRequest("/api/products", {
      method: "POST",
      token: pendingToken,
      json: { name: "Pending Product", category: "Books", price: 100, description: "Should be blocked" }
    });
    assert("Pending account blocked from POST /api/products with HTTP 403 Forbidden", resPendingProduct.status === 403);
    assert("Response explains registration is pending admin approval", resPendingProduct.json && resPendingProduct.json.message.includes("pending admin approval"));

    // 10.2 Pending user blocked from student verification submission
    const resPendingVerify = await makeRequest("/api/verification", {
      method: "POST",
      token: pendingToken,
      json: { studentName: "Pending", studentEmail: pendingEmail, studentId: "ID999", department: "Math", documentData: "test" }
    });
    assert("Pending account blocked from POST /api/verification with HTTP 403 Forbidden", resPendingVerify.status === 403);

    // 10.3 Pending user blocked from chat operations
    const resPendingChatGet = await makeRequest("/api/chats/1", { token: pendingToken });
    assert("Pending account blocked from GET /api/chats/:id with HTTP 403 Forbidden", resPendingChatGet.status === 403);

    const resPendingChatPost = await makeRequest("/api/chats/1", {
      method: "POST",
      token: pendingToken,
      json: { message: "Test chat from pending user" }
    });
    assert("Pending account blocked from POST /api/chats/:id with HTTP 403 Forbidden", resPendingChatPost.status === 403);

    // 10.4 Rejected user blocked from marketplace operations
    await pool.execute("UPDATE users SET registration_status = 'rejected' WHERE id = ?", [pendingUserId]);
    // Create temporary session for rejected user to test rejection 403 checks
    const fakeToken = "temp_rejected_token_" + timestamp;
    await pool.execute("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR))", [fakeToken, pendingUserId]);

    const resRejectedProduct = await makeRequest("/api/products", {
      method: "POST",
      token: fakeToken,
      json: { name: "Rejected Product", category: "Books", price: 100, description: "Should be blocked" }
    });
    assert("Rejected account blocked from POST /api/products with HTTP 403 Forbidden", resRejectedProduct.status === 403);
    assert("Response explains registration has been rejected", resRejectedProduct.json && resRejectedProduct.json.message.includes("rejected"));

    // 10.5 Approved but email-unverified account
    await pool.execute("UPDATE users SET registration_status = 'approved', email_verified = 0 WHERE id = ?", [pendingUserId]);
    const resApprovedUnverified = await makeRequest("/api/products", {
      method: "POST",
      token: fakeToken,
      json: { name: "Item", category: "Books", price: 100, description: "Check email" }
    });
    assert("Approved but email-unverified account blocked from listing products (403)", resApprovedUnverified.status === 403);
    assert("Message requests email verification", resApprovedUnverified.json && resApprovedUnverified.json.message.includes("verify your email"));

    // 10.6 Approved and email-verified account
    await pool.execute("UPDATE users SET registration_status = 'approved', email_verified = 1 WHERE id = ?", [pendingUserId]);
    const resApprovedVerified = await makeRequest("/api/products", {
      method: "POST",
      token: fakeToken,
      json: { name: "Approved Item", category: "Electronics", price: 500, description: "Legitimate listing" }
    });
    assert("Approved and email-verified account permitted to list product (201 Created)", resApprovedVerified.status === 201);

    // -----------------------------------------------------------------
    // TEST SUITE 11: STUDENT ROLE SELF-PROMOTION & TAMPERING PREVENTION
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 11] Privilege Escalation & Role Tampering Defense...");

    const tamperEmail = `p5_tamper_${timestamp}@campus.local`;
    const tamperRes = await makeRequest("/api/auth/register", {
      method: "POST",
      json: {
        name: "Attacker",
        email: tamperEmail,
        password: "AttackerPass123!",
        role: "admin",
        registration_status: "approved",
        email_verified: 1,
        verified: 1
      }
    });

    assert("Registration endpoint accepts request without crashing (201 Created)", tamperRes.status === 201);
    assert("Returned role in payload is strictly 'student'", tamperRes.json.user.role === "student");
    assert("Returned registrationStatus is strictly 'pending'", tamperRes.json.user.registrationStatus === "pending");

    const [dbTamper] = await pool.execute(
      "SELECT role, registration_status, email_verified, verified FROM users WHERE email = ?",
      [tamperEmail]
    );
    assert("Database confirms role is strictly 'student'", dbTamper[0].role === "student");
    assert("Database confirms registration_status is strictly 'pending'", dbTamper[0].registration_status === "pending");
    assert("Database confirms email_verified is strictly 0", Number(dbTamper[0].email_verified) === 0);

    // -----------------------------------------------------------------
    // TEST SUITE 12: SENSITIVE DATA LEAK AUDIT
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 12] Sensitive Data Non-Exposure Audit...");

    const auditList = await makeRequest("/api/admin/registrations?status=all", { token: adminToken });
    const auditDetail = await makeRequest(`/api/admin/registrations/${studentId}`, { token: adminToken });

    const auditString = JSON.stringify(auditList.json) + JSON.stringify(auditDetail.json);
    assert("Admin API responses never contain password_hash", !auditString.includes("password_hash"));
    assert("Admin API responses never contain $2b$", !auditString.includes("$2b$"));
    assert("Admin API responses never contain otp_hash", !auditString.includes("otp_hash"));
    assert("Admin API responses never contain session tokens", !auditString.includes("token\":\""));

    // -----------------------------------------------------------------
    // CLEANUP
    // -----------------------------------------------------------------
    await pool.execute("DELETE FROM products WHERE seller_id IN (?, ?, ?)", [studentId, peerId, pendingUserId]);
    await pool.execute("DELETE FROM sessions WHERE user_id IN (?, ?, ?, ?)", [studentId, peerId, pendingUserId, adminId]);
    await pool.execute("DELETE FROM users WHERE id IN (?, ?, ?)", [studentId, peerId, pendingUserId]);
    await pool.execute("DELETE FROM users WHERE email IN (?, ?)", [adminEmail, tamperEmail]);
    console.log("\n[INFO] Cleaned up Phase 5 test users, products, and sessions.");

  } catch (err) {
    console.error("Test execution error:", err);
    failed++;
  } finally {
    await pool.end();
    await new Promise((resolve) => server.close(resolve));
    console.log(`\n==================================================`);
    console.log(`  PHASE 5 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log(`==================================================\n`);
    process.exit(failed > 0 ? 1 : 0);
  }
}

runPhase5Tests();
