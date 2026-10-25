process.env.TEST_MODE = "true";
const http = require("http");
const path = require("path");
const mysql = require("mysql2/promise");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
require("dotenv").config();

const server = require("../backend/server.js");

const TEST_PORT = 3006;
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

async function runPhase6Tests() {
  console.log("==================================================");
  console.log("  CAMPUS MARKETPLACE — PHASE 6 CHAT PRIVACY TESTS ");
  console.log("==================================================");

  pool = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "campus_marketplace",
    waitForConnections: true,
    connectionLimit: 5
  });

  await new Promise((resolve) => {
    server.listen(TEST_PORT, "127.0.0.1", () => {
      console.log(`[TEST] Server listening on ${BASE_URL}`);
      resolve();
    });
  });

  const timestamp = Date.now();
  const bcrypt = require("bcrypt");
  const testPasswordHash = await bcrypt.hash("Password123!", 10);

  // Helper to create test user
  async function createTestUser({ email, name, role = "student", emailVerified = 1, registrationStatus = "approved" }) {
    const [res] = await pool.execute(
      `INSERT INTO users (name, email, password_hash, role, email_verified, registration_status, student_verification_status, verified, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'unverified', 0, NOW())`,
      [name, email, testPasswordHash, role, emailVerified ? 1 : 0, registrationStatus]
    );
    const userId = res.insertId;
    const token = `p6_token_${userId}_${timestamp}`;
    await pool.execute(
      `INSERT INTO sessions (token, user_id, expires_at, created_at)
       VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR), NOW())`,
      [token, userId]
    );
    return { id: userId, email, name, token };
  }

  // Create accounts
  const seller = await createTestUser({ email: `p6_seller_${timestamp}@campus.local`, name: "Alice Seller" });
  const buyer1 = await createTestUser({ email: `p6_buyer1_${timestamp}@campus.local`, name: "Bob Buyer" });
  const buyer2 = await createTestUser({ email: `p6_buyer2_${timestamp}@campus.local`, name: "Charlie Buyer" });
  const unrelatedUser = await createTestUser({ email: `p6_unrelated_${timestamp}@campus.local`, name: "Eve Unrelated" });
  const unverifiedUser = await createTestUser({ email: `p6_unver_${timestamp}@campus.local`, name: "Unverified User", emailVerified: 0 });
  const pendingUser = await createTestUser({ email: `p6_pending_${timestamp}@campus.local`, name: "Pending User", registrationStatus: "pending" });
  const rejectedUser = await createTestUser({ email: `p6_rejected_${timestamp}@campus.local`, name: "Rejected User", registrationStatus: "rejected" });

  // Seller creates a test product
  const [prodRes] = await pool.execute(
    `INSERT INTO products (name, category, price, description, seller_id, status, created_at)
     VALUES (?, 'Books', 450, 'Textbook in great condition', ?, 'active', NOW())`,
    [`Physics Textbook ${timestamp}`, seller.id]
  );
  const productId = prodRes.insertId;

  try {
    // -----------------------------------------------------------------
    // TEST SUITE 1: UNAUTHENTICATED CHAT READS AND WRITES (401)
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 1] Unauthenticated Requests to Chat Endpoints (401)...");

    const resUnauthGetProd = await makeRequest(`/api/chats/${productId}`);
    assert("GET /api/chats/:productId without token returns 401", resUnauthGetProd.status === 401);
    assert("Response indicates login required", resUnauthGetProd.json && resUnauthGetProd.json.message.includes("login"));

    const resUnauthPostProd = await makeRequest(`/api/chats/${productId}`, {
      method: "POST",
      json: { message: "Hello seller" }
    });
    assert("POST /api/chats/:productId without token returns 401", resUnauthPostProd.status === 401);

    const resUnauthThreads = await makeRequest("/api/chats/threads");
    assert("GET /api/chats/threads without token returns 401", resUnauthThreads.status === 401);

    const resUnauthGetThread = await makeRequest("/api/chats/thread/1");
    assert("GET /api/chats/thread/:id without token returns 401", resUnauthGetThread.status === 401);

    const resUnauthPostThread = await makeRequest("/api/chats/thread/1", {
      method: "POST",
      json: { message: "Hello thread" }
    });
    assert("POST /api/chats/thread/:id without token returns 401", resUnauthPostThread.status === 401);

    // -----------------------------------------------------------------
    // TEST SUITE 2: UNAPPROVED AND EMAIL-UNVERIFIED ACCOUNTS (403)
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 2] Unapproved and Email-Unverified Access Restrictions (403)...");

    // Email-unverified
    const resUnverGet = await makeRequest(`/api/chats/${productId}`, { token: unverifiedUser.token });
    assert("Email-unverified user blocked from GET /api/chats/:productId (403)", resUnverGet.status === 403);
    assert("Response indicates email verification required", resUnverGet.json && resUnverGet.json.message.includes("verify your email"));

    const resUnverPost = await makeRequest(`/api/chats/${productId}`, {
      method: "POST",
      token: unverifiedUser.token,
      json: { message: "Should be blocked" }
    });
    assert("Email-unverified user blocked from POST /api/chats/:productId (403)", resUnverPost.status === 403);
    assert("Response indicates email verification required", resUnverPost.json && resUnverPost.json.message.includes("verify your email"));

    const resUnverThreads = await makeRequest("/api/chats/threads", { token: unverifiedUser.token });
    assert("Email-unverified user blocked from GET /api/chats/threads (403)", resUnverThreads.status === 403);

    // Pending registration
    const resPendingGet = await makeRequest(`/api/chats/${productId}`, { token: pendingUser.token });
    assert("Pending registration user blocked from GET /api/chats/:productId (403)", resPendingGet.status === 403);

    const resPendingPost = await makeRequest(`/api/chats/${productId}`, {
      method: "POST",
      token: pendingUser.token,
      json: { message: "Should be blocked" }
    });
    assert("Pending registration user blocked from POST /api/chats/:productId (403)", resPendingPost.status === 403);
    assert("Response indicates registration pending approval", resPendingPost.json && resPendingPost.json.message.includes("pending"));

    // Rejected registration
    const resRejectedGet = await makeRequest(`/api/chats/${productId}`, { token: rejectedUser.token });
    assert("Rejected registration user blocked from GET /api/chats/:productId (403)", resRejectedGet.status === 403);
    assert("Response indicates registration rejected", resRejectedGet.json && resRejectedGet.json.message.includes("rejected"));

    const resRejectedPost = await makeRequest(`/api/chats/${productId}`, {
      method: "POST",
      token: rejectedUser.token,
      json: { message: "Should be blocked" }
    });
    assert("Rejected registration user blocked from POST /api/chats/:productId (403)", resRejectedPost.status === 403);

    // -----------------------------------------------------------------
    // TEST SUITE 3: BUYER MESSAGING & INITIAL READING (200 / 201)
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 3] Legitimate Buyer Initiating and Reading Conversation (200 / 201)...");

    // Buyer reads before any messages exist
    const resBuyerInitialGet = await makeRequest(`/api/chats/${productId}`, { token: buyer1.token });
    assert("Buyer initial GET returns 200 OK", resBuyerInitialGet.status === 200);
    assert("Buyer initially has 0 messages", Array.isArray(resBuyerInitialGet.json.messages) && resBuyerInitialGet.json.messages.length === 0);
    assert("Buyer initial threadId is null", resBuyerInitialGet.json.threadId === null);
    assert("isSeller flag is false for buyer", resBuyerInitialGet.json.isSeller === false);

    // Buyer sends first message
    const resBuyerSend = await makeRequest(`/api/chats/${productId}`, {
      method: "POST",
      token: buyer1.token,
      json: { message: "Hi Alice, is the physics book available?" }
    });
    assert("Buyer sending message returns 201 Created", resBuyerSend.status === 201);
    assert("Returned message has correct senderId", resBuyerSend.json.message.senderId === buyer1.id);
    assert("Returned message has isSelf = true", resBuyerSend.json.message.isSelf === true);
    assert("Returned message contains threadId", Boolean(resBuyerSend.json.message.threadId));

    const threadId1 = resBuyerSend.json.message.threadId;

    // Buyer re-reads product chat
    const resBuyerRead = await makeRequest(`/api/chats/${productId}`, { token: buyer1.token });
    assert("Buyer re-read returns 200 OK", resBuyerRead.status === 200);
    assert("Buyer sees 1 message", resBuyerRead.json.messages.length === 1);
    assert("Message content matches", resBuyerRead.json.messages[0].message === "Hi Alice, is the physics book available?");
    assert("Buyer message has isSelf = true", resBuyerRead.json.messages[0].isSelf === true);

    // Database verification: chat_threads
    const [dbThreads] = await pool.execute("SELECT * FROM chat_threads WHERE id = ?", [threadId1]);
    assert("chat_threads row exists in database", dbThreads.length === 1);
    assert("chat_threads product_id matches", dbThreads[0].product_id === productId);
    assert("chat_threads buyer_id matches buyer1", dbThreads[0].buyer_id === buyer1.id);
    assert("chat_threads seller_id matches seller", dbThreads[0].seller_id === seller.id);

    // Database verification: dual-write in legacy chats table
    const [dbLegacyChats] = await pool.execute("SELECT * FROM chats WHERE product_id = ? AND sender_id = ?", [productId, buyer1.id]);
    assert("Legacy chats table receives dual-written record", dbLegacyChats.length >= 1);
    assert("Legacy chat message text matches", dbLegacyChats[0].message === "Hi Alice, is the physics book available?");

    // -----------------------------------------------------------------
    // TEST SUITE 4: SELLER READING & RESPONDING TO BUYER (200 / 201)
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 4] Seller Reading Inquiries and Responding to Buyer (200 / 201)...");

    // Seller reads product chat
    const resSellerGet = await makeRequest(`/api/chats/${productId}`, { token: seller.token });
    assert("Seller GET /api/chats/:productId returns 200 OK", resSellerGet.status === 200);
    assert("isSeller flag is true for seller", resSellerGet.json.isSeller === true);
    assert("Seller sees buyer's thread in threads list", Array.isArray(resSellerGet.json.threads) && resSellerGet.json.threads.length === 1);
    assert("Seller sees buyer's name", resSellerGet.json.threads[0].buyerName === "Bob Buyer");

    // Seller reads direct thread: GET /api/chats/thread/:threadId
    const resSellerThreadGet = await makeRequest(`/api/chats/thread/${threadId1}`, { token: seller.token });
    assert("Seller GET /api/chats/thread/:id returns 200 OK", resSellerThreadGet.status === 200);
    assert("Seller sees 1 incoming message", resSellerThreadGet.json.messages.length === 1);
    assert("Buyer message has isSelf = false for seller", resSellerThreadGet.json.messages[0].isSelf === false);
    assert("Thread userRole is 'seller'", resSellerThreadGet.json.thread.userRole === "seller");

    // Seller replies to buyer via thread endpoint: POST /api/chats/thread/:threadId
    const resSellerReply = await makeRequest(`/api/chats/thread/${threadId1}`, {
      method: "POST",
      token: seller.token,
      json: { message: "Yes Bob, it is available for ₹450!" }
    });
    assert("Seller reply to thread returns 201 Created", resSellerReply.status === 201);
    assert("Seller reply has senderId = seller.id", resSellerReply.json.message.senderId === seller.id);
    assert("Seller reply has isSelf = true for seller", resSellerReply.json.message.isSelf === true);

    // Buyer reads conversation: sees both messages
    const resBuyerReadAfterReply = await makeRequest(`/api/chats/thread/${threadId1}`, { token: buyer1.token });
    assert("Buyer thread read returns 200 OK", resBuyerReadAfterReply.status === 200);
    assert("Buyer thread now has 2 messages", resBuyerReadAfterReply.json.messages.length === 2);
    assert("Buyer message 1 isSelf = true", resBuyerReadAfterReply.json.messages[0].isSelf === true);
    assert("Seller message 2 isSelf = false for buyer", resBuyerReadAfterReply.json.messages[1].isSelf === false);
    assert("Message 2 sender is 'Alice Seller'", resBuyerReadAfterReply.json.messages[1].sender === "Alice Seller");

    // Seller responds via product endpoint specifying threadId
    const resSellerProductPost = await makeRequest(`/api/chats/${productId}`, {
      method: "POST",
      token: seller.token,
      json: { message: "We can meet at the library.", threadId: threadId1 }
    });
    assert("Seller POST /api/chats/:productId with threadId returns 201 Created", resSellerProductPost.status === 201);

    // -----------------------------------------------------------------
    // TEST SUITE 5: UNRELATED STUDENT IDOR & COMPLETE ISOLATION DEFENSE (403)
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 5] Conversation Privacy & Unrelated Student IDOR Defense (403)...");

    // Unrelated student attempts to read buyer1's thread directly
    const resEveReadThread = await makeRequest(`/api/chats/thread/${threadId1}`, { token: unrelatedUser.token });
    assert("Unrelated student blocked from GET /api/chats/thread/:id (403 Forbidden)", resEveReadThread.status === 403);
    assert("Unauthorized message returned", resEveReadThread.json && resEveReadThread.json.message.includes("not authorized"));

    // Unrelated student attempts to post to buyer1's thread
    const resEvePostThread = await makeRequest(`/api/chats/thread/${threadId1}`, {
      method: "POST",
      token: unrelatedUser.token,
      json: { message: "Eve snooping into Bob and Alice conversation" }
    });
    assert("Unrelated student blocked from POST /api/chats/thread/:id (403 Forbidden)", resEvePostThread.status === 403);
    assert("Unauthorized message returned", resEvePostThread.json && resEvePostThread.json.message.includes("not authorized"));

    // Unrelated student calls GET /api/chats/:productId
    // MUST NOT leak buyer1's messages!
    const resEveGetProd = await makeRequest(`/api/chats/${productId}`, { token: unrelatedUser.token });
    assert("Unrelated student GET /api/chats/:productId returns 200 OK", resEveGetProd.status === 200);
    assert("Unrelated student sees ZERO messages (privacy preserved)", resEveGetProd.json.messages.length === 0);
    assert("Unrelated student threadId is null", resEveGetProd.json.threadId === null);

    // Buyer 2 initiates inquiry on the same product
    const resBuyer2Send = await makeRequest(`/api/chats/${productId}`, {
      method: "POST",
      token: buyer2.token,
      json: { message: "Hello from Charlie Buyer" }
    });
    assert("Buyer 2 sending message returns 201 Created", resBuyer2Send.status === 201);
    const threadId2 = resBuyer2Send.json.message.threadId;
    assert("Buyer 2 receives a distinct thread ID", threadId2 !== threadId1);

    // Buyer 1 reads again: must STILL only see buyer 1's messages, NOT buyer 2's
    const resBuyer1Check = await makeRequest(`/api/chats/${productId}`, { token: buyer1.token });
    const buyer1HasCharlieMsg = resBuyer1Check.json.messages.some(m => m.message.includes("Charlie Buyer"));
    assert("Buyer 1 does NOT see Buyer 2 messages (strict thread isolation)", !buyer1HasCharlieMsg);

    // Buyer 2 tries to read buyer 1's thread directly
    const resBuyer2ProbeBuyer1 = await makeRequest(`/api/chats/thread/${threadId1}`, { token: buyer2.token });
    assert("Buyer 2 blocked from reading Buyer 1 thread (403 Forbidden)", resBuyer2ProbeBuyer1.status === 403);

    // -----------------------------------------------------------------
    // TEST SUITE 6: ID SPOOFING & TAMPERING DEFENSE
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 6] Parameter Tampering & Identity Spoofing Defense...");

    // Buyer 1 sends payload spoofing senderId, buyerId, sellerId, role
    const resSpoof = await makeRequest(`/api/chats/${productId}`, {
      method: "POST",
      token: buyer1.token,
      json: {
        message: "Attempting to spoof sender identity",
        senderId: unrelatedUser.id,
        buyerId: unrelatedUser.id,
        sellerId: unrelatedUser.id,
        role: "admin"
      }
    });
    assert("Request handled without crash (201 Created)", resSpoof.status === 201);
    assert("Backend derived senderId strictly from session", resSpoof.json.message.senderId === buyer1.id);

    // Database verification: sender_id must be buyer1.id, not unrelatedUser.id
    const [dbMsgCheck] = await pool.execute(
      "SELECT sender_id FROM chat_messages WHERE id = ?",
      [resSpoof.json.message.id]
    );
    assert("Database stores authenticated user ID as sender_id", dbMsgCheck[0].sender_id === buyer1.id);

    // Seller attempts to respond using a threadId belonging to another seller/product
    // Create product for buyer 2
    const [otherProd] = await pool.execute(
      "INSERT INTO products (name, category, price, description, seller_id, created_at) VALUES ('Other Item', 'Electronics', 1000, 'Test', ?, NOW())",
      [buyer2.id]
    );
    const [otherThread] = await pool.execute(
      "INSERT INTO chat_threads (product_id, buyer_id, seller_id, created_at) VALUES (?, ?, ?, NOW())",
      [otherProd.insertId, buyer1.id, buyer2.id]
    );
    const foreignThreadId = otherThread.insertId;

    const resSellerTamperThread = await makeRequest(`/api/chats/${productId}`, {
      method: "POST",
      token: seller.token,
      json: { message: "Malicious reply to foreign thread", threadId: foreignThreadId }
    });
    assert("Seller tampering with foreign threadId rejected (403/404)", resSellerTamperThread.status === 403 || resSellerTamperThread.status === 404);

    // -----------------------------------------------------------------
    // TEST SUITE 7: SELLER INITIATING FAKE BUYER MESSAGES / SELF-MESSAGING (400)
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 7] Seller Self-Messaging & Fake Buyer Initiation Defense (400)...");

    // Seller attempts to send message to own product without a buyer thread
    const resSellerSelfMsg = await makeRequest(`/api/chats/${productId}`, {
      method: "POST",
      token: seller.token,
      json: { message: "Seller trying to chat with self" }
    });
    assert("Seller messaging own product without buyer thread returns 400 Bad Request", resSellerSelfMsg.status === 400);
    assert("Response explains sellers cannot initiate conversations with themselves", resSellerSelfMsg.json && resSellerSelfMsg.json.message.includes("themselves"));

    // Seller attempts to pass buyerId = seller.id
    const resSellerFakeBuyer = await makeRequest(`/api/chats/${productId}`, {
      method: "POST",
      token: seller.token,
      json: { message: "Seller faking buyer identity", buyerId: seller.id }
    });
    assert("Seller targeting self as buyer returns 400 Bad Request", resSellerFakeBuyer.status === 400);

    // -----------------------------------------------------------------
    // TEST SUITE 8: NONEXISTENT PRODUCT AND THREAD IDS (404)
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 8] Nonexistent Products and Threads (404)...");

    const resNonexistentProdGet = await makeRequest("/api/chats/999999", { token: buyer1.token });
    assert("GET /api/chats/999999 returns 404 Not Found", resNonexistentProdGet.status === 404);

    const resNonexistentProdPost = await makeRequest("/api/chats/999999", {
      method: "POST",
      token: buyer1.token,
      json: { message: "Test for nonexistent product" }
    });
    assert("POST /api/chats/999999 returns 404 Not Found", resNonexistentProdPost.status === 404);

    const resNonexistentThreadGet = await makeRequest("/api/chats/thread/999999", { token: buyer1.token });
    assert("GET /api/chats/thread/999999 returns 404 Not Found", resNonexistentThreadGet.status === 404);

    const resNonexistentThreadPost = await makeRequest("/api/chats/thread/999999", {
      method: "POST",
      token: buyer1.token,
      json: { message: "Test for nonexistent thread" }
    });
    assert("POST /api/chats/thread/999999 returns 404 Not Found", resNonexistentThreadPost.status === 404);

    // -----------------------------------------------------------------
    // TEST SUITE 9: MESSAGE INPUT VALIDATION (400)
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 9] Message Length and Content-Type Validation (400)...");

    const resEmptyMsg = await makeRequest(`/api/chats/${productId}`, {
      method: "POST",
      token: buyer1.token,
      json: { message: "" }
    });
    assert("Empty message returns 400 Bad Request", resEmptyMsg.status === 400);

    const resWhitespaceMsg = await makeRequest(`/api/chats/${productId}`, {
      method: "POST",
      token: buyer1.token,
      json: { message: "     " }
    });
    assert("Whitespace-only message returns 400 Bad Request", resWhitespaceMsg.status === 400);

    const resObjectMsg = await makeRequest(`/api/chats/${productId}`, {
      method: "POST",
      token: buyer1.token,
      json: { message: { evil: "payload" } }
    });
    assert("Non-string message object returns 400 Bad Request", resObjectMsg.status === 400);

    const resNumberMsg = await makeRequest(`/api/chats/${productId}`, {
      method: "POST",
      token: buyer1.token,
      json: { message: 12345 }
    });
    assert("Non-string numeric message returns 400 Bad Request", resNumberMsg.status === 400);

    const longMessage = "A".repeat(2001);
    const resOversizedMsg = await makeRequest(`/api/chats/${productId}`, {
      method: "POST",
      token: buyer1.token,
      json: { message: longMessage }
    });
    assert("Message exceeding 2000 chars returns 400 Bad Request", resOversizedMsg.status === 400);
    assert("Response explains maximum allowed length", resOversizedMsg.json && resOversizedMsg.json.message.includes("2000"));

    // Valid 2000-char message succeeds
    const exactMessage = "B".repeat(2000);
    const resExactMsg = await makeRequest(`/api/chats/${productId}`, {
      method: "POST",
      token: buyer1.token,
      json: { message: exactMessage }
    });
    assert("Message with exactly 2000 characters succeeds (201 Created)", resExactMsg.status === 201);

    // -----------------------------------------------------------------
    // TEST SUITE 10: USER THREADS DIRECTORY: GET /api/chats/threads
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 10] User Threads Directory (GET /api/chats/threads)...");

    // Buyer 1 queries their threads
    const resBuyerThreads = await makeRequest("/api/chats/threads", { token: buyer1.token });
    assert("Buyer GET /api/chats/threads returns 200 OK", resBuyerThreads.status === 200);
    assert("Buyer sees their active thread", resBuyerThreads.json.threads.some(t => t.id === threadId1));
    const buyerThread = resBuyerThreads.json.threads.find(t => t.id === threadId1);
    assert("Thread userRole is 'buyer'", buyerThread.userRole === "buyer");
    assert("Thread counterpartyName is 'Alice Seller'", buyerThread.counterpartyName === "Alice Seller");

    // Seller queries their threads
    const resSellerThreads = await makeRequest("/api/chats/threads", { token: seller.token });
    assert("Seller GET /api/chats/threads returns 200 OK", resSellerThreads.status === 200);
    assert("Seller sees both buyer threads", resSellerThreads.json.threads.length >= 2);
    const sellerViewThread1 = resSellerThreads.json.threads.find(t => t.id === threadId1);
    assert("Seller thread userRole is 'seller'", sellerViewThread1.userRole === "seller");
    assert("Seller thread counterpartyName is 'Bob Buyer'", sellerViewThread1.counterpartyName === "Bob Buyer");

    // Unrelated user with no threads
    const resUnrelatedThreads = await makeRequest("/api/chats/threads", { token: unrelatedUser.token });
    assert("Unrelated student receives empty threads array", Array.isArray(resUnrelatedThreads.json.threads) && resUnrelatedThreads.json.threads.length === 0);

    // -----------------------------------------------------------------
    // TEST SUITE 11: PRIVACY & SENSITIVE DATA AUDIT
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 11] Privacy & Non-Exposure Audit...");

    // Confirm product detail endpoint does NOT expose chat messages
    const resProdDetail = await makeRequest(`/api/products/${productId}`);
    assert("GET /api/products/:id does not include messages", !resProdDetail.json.product.messages);
    assert("GET /api/products/:id does not include chats", !resProdDetail.json.product.chats);

    // Confirm product list endpoint does NOT expose chat messages
    const resProdList = await makeRequest("/api/products");
    const foundProd = resProdList.json.products.find(p => p.id === productId);
    assert("GET /api/products does not expose messages array", !foundProd.messages);
    assert("GET /api/products does not expose chats array", !foundProd.chats);

    // -----------------------------------------------------------------
    // TEST SUITE 12: REGRESSION VERIFICATION (REGISTRATION, OTP, PRODUCT, LOGIN)
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 12] Regression Checks for Auth, OTP, Products, and Login...");

    // Registration
    const regEmail = `p6_reg_${timestamp}@campus.local`;
    const resReg = await makeRequest("/api/auth/register", {
      method: "POST",
      json: { name: "Regression Student", email: regEmail, password: "Password123!" }
    });
    assert("Student registration succeeds (201 Created)", resReg.status === 201);
    assert("Registration status is pending", resReg.json.user.registrationStatus === "pending");
    assert("Email verified is false", resReg.json.user.emailVerified === false);

    // Login with new account
    const resLogin = await makeRequest("/api/auth/login", {
      method: "POST",
      json: { email: regEmail, password: "Password123!" }
    });
    assert("Login succeeds (200 OK)", resLogin.status === 200);
    assert("Returns session token", Boolean(resLogin.json.token));

    // Logout
    const resLogout = await makeRequest("/api/auth/logout", {
      method: "POST",
      token: resLogin.json.token
    });
    assert("Logout succeeds (200 OK)", resLogout.status === 200);

    // Expired session verification
    const resExpiredCheck = await makeRequest("/api/me", { token: resLogin.json.token });
    assert("Revoked token is rejected on /api/me (401)", resExpiredCheck.status === 401);

    // -----------------------------------------------------------------
    // TEST SUITE 13: ATOMIC WRITE CONSISTENCY & ROLLBACK (PHASE 6.2)
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 13] Chat Write Atomicity & Transaction Rollback (Phase 6.2)...");

    // 13.1 Rollback on POST /api/chats/thread/:threadId when write fails before legacy insert
    const [beforeThRow1] = await pool.execute(
      "SELECT UNIX_TIMESTAMP(last_message_at) AS ts FROM chat_threads WHERE id = ?",
      [threadId1]
    );
    const beforeTs1 = beforeThRow1[0].ts;

    const rollbackMsg1 = `Rollback test thread before_chats ${timestamp}`;
    const resRollbackThread1 = await makeRequest(`/api/chats/thread/${threadId1}`, {
      method: "POST",
      token: buyer1.token,
      headers: { "x-test-induce-chat-failure": "before_chats" },
      json: { message: rollbackMsg1 }
    });
    assert("POST /api/chats/thread/:id with induced failure returns 500", resRollbackThread1.status === 500);
    assert("Induced failure response has success = false", resRollbackThread1.json && resRollbackThread1.json.success === false);
    assert("Induced failure does not expose raw database error", resRollbackThread1.json.message === "Could not send message due to a database error.");

    // Verify rollback in DB: chat_messages must have 0 rows for rollbackMsg1
    const [rolledBackMsgs1] = await pool.execute(
      "SELECT * FROM chat_messages WHERE message = ?",
      [rollbackMsg1]
    );
    assert("Rollback leaves no partial message in chat_messages", rolledBackMsgs1.length === 0);

    // Verify rollback in DB: legacy chats must have 0 rows for rollbackMsg1
    const [rolledBackLegacy1] = await pool.execute(
      "SELECT * FROM chats WHERE message = ?",
      [rollbackMsg1]
    );
    assert("Rollback leaves no record in legacy chats table", rolledBackLegacy1.length === 0);

    // Verify rollback in DB: chat_threads.last_message_at was NOT updated
    const [afterThRow1] = await pool.execute(
      "SELECT UNIX_TIMESTAMP(last_message_at) AS ts FROM chat_threads WHERE id = ?",
      [threadId1]
    );
    assert("Rollback preserves original chat_threads.last_message_at timestamp", afterThRow1[0].ts === beforeTs1);

    // 13.2 Rollback on POST /api/chats/thread/:threadId when failure is induced before commit
    const rollbackMsg2 = `Rollback test thread before_commit ${timestamp}`;
    const resRollbackThread2 = await makeRequest(`/api/chats/thread/${threadId1}`, {
      method: "POST",
      token: seller.token,
      headers: { "x-test-induce-chat-failure": "before_commit" },
      json: { message: rollbackMsg2 }
    });
    assert("POST /api/chats/thread/:id with induced failure before commit returns 500", resRollbackThread2.status === 500);
    assert("Induced failure before commit has success = false", resRollbackThread2.json && resRollbackThread2.json.success === false);

    const [rolledBackMsgs2] = await pool.execute(
      "SELECT * FROM chat_messages WHERE message = ?",
      [rollbackMsg2]
    );
    assert("Pre-commit rollback leaves no row in chat_messages", rolledBackMsgs2.length === 0);

    const [rolledBackLegacy2] = await pool.execute(
      "SELECT * FROM chats WHERE message = ?",
      [rollbackMsg2]
    );
    assert("Pre-commit rollback leaves no row in chats", rolledBackLegacy2.length === 0);

    // 13.3 Rollback on POST /api/chats/:productId when write fails before legacy insert
    const [beforeProdTh] = await pool.execute(
      "SELECT UNIX_TIMESTAMP(last_message_at) AS ts FROM chat_threads WHERE id = ?",
      [threadId1]
    );
    const beforeProdTs = beforeProdTh[0].ts;

    const rollbackProdMsg1 = `Rollback test product before_chats ${timestamp}`;
    const resRollbackProd1 = await makeRequest(`/api/chats/${productId}`, {
      method: "POST",
      token: buyer1.token,
      headers: { "x-test-induce-chat-failure": "before_chats" },
      json: { message: rollbackProdMsg1 }
    });
    assert("POST /api/chats/:productId with induced failure returns 500", resRollbackProd1.status === 500);
    assert("Induced failure on product endpoint has success = false", resRollbackProd1.json && resRollbackProd1.json.success === false);

    const [rolledBackProdMsgs1] = await pool.execute(
      "SELECT * FROM chat_messages WHERE message = ?",
      [rollbackProdMsg1]
    );
    assert("Product endpoint rollback leaves no partial message in chat_messages", rolledBackProdMsgs1.length === 0);

    const [rolledBackProdLegacy1] = await pool.execute(
      "SELECT * FROM chats WHERE message = ?",
      [rollbackProdMsg1]
    );
    assert("Product endpoint rollback leaves no record in legacy chats", rolledBackProdLegacy1.length === 0);

    const [afterProdTh] = await pool.execute(
      "SELECT UNIX_TIMESTAMP(last_message_at) AS ts FROM chat_threads WHERE id = ?",
      [threadId1]
    );
    assert("Product endpoint rollback preserves thread last_message_at timestamp", afterProdTh[0].ts === beforeProdTs);

    // 13.4 Rollback on POST /api/chats/:productId when failure is induced before commit
    const rollbackProdMsg2 = `Rollback test product before_commit ${timestamp}`;
    const resRollbackProd2 = await makeRequest(`/api/chats/${productId}`, {
      method: "POST",
      token: buyer1.token,
      headers: { "x-test-induce-chat-failure": "before_commit" },
      json: { message: rollbackProdMsg2 }
    });
    assert("POST /api/chats/:productId with pre-commit failure returns 500", resRollbackProd2.status === 500);
    assert("Pre-commit failure on product endpoint has success = false", resRollbackProd2.json && resRollbackProd2.json.success === false);

    const [rolledBackProdMsgs2] = await pool.execute(
      "SELECT * FROM chat_messages WHERE message = ?",
      [rollbackProdMsg2]
    );
    assert("Pre-commit rollback leaves no message in chat_messages for product endpoint", rolledBackProdMsgs2.length === 0);

    const [rolledBackProdLegacy2] = await pool.execute(
      "SELECT * FROM chats WHERE message = ?",
      [rollbackProdMsg2]
    );
    assert("Pre-commit rollback leaves no row in chats for product endpoint", rolledBackProdLegacy2.length === 0);

    // 13.5 Successful atomic persistence verification across both endpoints
    const successMsgThread = `Atomic success thread msg ${timestamp}`;
    const resSuccessThread = await makeRequest(`/api/chats/thread/${threadId1}`, {
      method: "POST",
      token: buyer1.token,
      json: { message: successMsgThread }
    });
    assert("Valid POST /api/chats/thread/:id returns 201 Created", resSuccessThread.status === 201);
    assert("Thread endpoint returns success: true", resSuccessThread.json.success === true);
    assert("Thread endpoint returned message id is positive integer", typeof resSuccessThread.json.message.id === "number" && resSuccessThread.json.message.id > 0);

    // Verify row in chat_messages
    const [persistedThreadMsg] = await pool.execute(
      "SELECT * FROM chat_messages WHERE id = ?",
      [resSuccessThread.json.message.id]
    );
    assert("Message atomically persisted in chat_messages", persistedThreadMsg.length === 1 && persistedThreadMsg[0].message === successMsgThread);

    // Verify row in legacy chats
    const [persistedThreadLegacy] = await pool.execute(
      "SELECT * FROM chats WHERE product_id = ? AND message = ?",
      [productId, successMsgThread]
    );
    assert("Message atomically mirrored in chats table", persistedThreadLegacy.length === 1 && persistedThreadLegacy[0].sender_id === buyer1.id);

    // 13.6 Successful atomic persistence verification on POST /api/chats/:productId
    const successMsgProd = `Atomic success product msg ${timestamp}`;
    const resSuccessProd = await makeRequest(`/api/chats/${productId}`, {
      method: "POST",
      token: buyer1.token,
      json: { message: successMsgProd }
    });
    assert("Valid POST /api/chats/:productId returns 201 Created", resSuccessProd.status === 201);
    assert("Product endpoint returns success: true", resSuccessProd.json.success === true);
    assert("Product endpoint returned message id is positive integer", typeof resSuccessProd.json.message.id === "number" && resSuccessProd.json.message.id > 0);

    const [persistedProdMsg] = await pool.execute(
      "SELECT * FROM chat_messages WHERE id = ?",
      [resSuccessProd.json.message.id]
    );
    assert("Product message atomically persisted in chat_messages", persistedProdMsg.length === 1 && persistedProdMsg[0].message === successMsgProd);

    const [persistedProdLegacy] = await pool.execute(
      "SELECT * FROM chats WHERE product_id = ? AND message = ?",
      [productId, successMsgProd]
    );
    assert("Product message atomically mirrored in chats table", persistedProdLegacy.length === 1 && persistedProdLegacy[0].sender_id === buyer1.id);

    // 13.7 Consistency of response contract between endpoints
    assert("Both endpoints return message object with id, threadId, productId, senderId, sender, message, text, createdAt, isSelf",
      resSuccessThread.json.message.threadId === resSuccessProd.json.message.threadId &&
      resSuccessThread.json.message.productId === resSuccessProd.json.message.productId &&
      resSuccessThread.json.message.isSelf === true &&
      resSuccessProd.json.message.isSelf === true
    );
  } finally {
    // Clean up test data
    console.log("\n[INFO] Cleaning up Phase 6 test records...");
    try {
      await pool.execute("DELETE FROM products WHERE id = ?", [productId]);
      await pool.execute(
        `DELETE FROM users WHERE email LIKE 'p6_%_${timestamp}@campus.local'`
      );
    } catch (e) {
      console.warn("Cleanup warning:", e.message);
    }

    await pool.end();
    await new Promise((resolve) => server.close(resolve));
    console.log("\n==================================================");
    console.log(`  PHASE 6 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log("==================================================\n");
    process.exit(failed > 0 ? 1 : 0);
  }
}

if (require.main === module) {
  runPhase6Tests().catch((err) => {
    console.error("[FATAL ERROR] Phase 6 test runner crashed:", err);
    process.exit(1);
  });
}

module.exports = runPhase6Tests;
