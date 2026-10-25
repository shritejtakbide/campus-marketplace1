process.env.TEST_MODE = "true";

const http = require("http");
const mysql = require("mysql2/promise");
const server = require("../backend/server.js");

const TEST_PORT = 3007;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

let passed = 0;
let failed = 0;
let pool = null;

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

async function runPhase7aTests() {
  console.log("==================================================");
  console.log("  CAMPUS MARKETPLACE — PHASE 7A-1 BACKEND TESTS   ");
  console.log("  Seller Listing Lifecycle, Status & Archival     ");
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

  async function createTestUser({ email, name, role = "student", emailVerified = 1, registrationStatus = "approved" }) {
    const [res] = await pool.execute(
      `INSERT INTO users (name, email, password_hash, role, email_verified, registration_status, student_verification_status, verified, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'unverified', 0, NOW())`,
      [name, email, testPasswordHash, role, emailVerified ? 1 : 0, registrationStatus]
    );
    const userId = res.insertId;
    const token = `p7a_token_${userId}_${timestamp}`;
    await pool.execute(
      `INSERT INTO sessions (token, user_id, expires_at, created_at)
       VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR), NOW())`,
      [token, userId]
    );
    return { id: userId, email, name, role, token };
  }

  // Create accounts
  const seller = await createTestUser({ email: `p7a_seller_${timestamp}@campus.local`, name: "Alice Seller" });
  const buyer1 = await createTestUser({ email: `p7a_buyer1_${timestamp}@campus.local`, name: "Bob Buyer" });
  const buyer2 = await createTestUser({ email: `p7a_buyer2_${timestamp}@campus.local`, name: "Charlie Buyer" });
  const otherStudent = await createTestUser({ email: `p7a_other_${timestamp}@campus.local`, name: "Dave Other" });
  const adminUser = await createTestUser({ email: `p7a_admin_${timestamp}@campus.local`, name: "Admin Mod", role: "admin" });
  const unverifiedUser = await createTestUser({ email: `p7a_unver_${timestamp}@campus.local`, name: "Unverified Student", emailVerified: 0 });
  const pendingUser = await createTestUser({ email: `p7a_pending_${timestamp}@campus.local`, name: "Pending Student", registrationStatus: "pending" });
  const rejectedUser = await createTestUser({ email: `p7a_rejected_${timestamp}@campus.local`, name: "Rejected Student", registrationStatus: "rejected" });

  // Create test products
  const [prodRes1] = await pool.execute(
    `INSERT INTO products (name, category, price, description, seller_id, status, created_at)
     VALUES (?, 'Books', 500, 'Original Textbook', ?, 'active', NOW())`,
    [`Physics Book ${timestamp}`, seller.id]
  );
  const activeProductId = prodRes1.insertId;

  const [prodRes2] = await pool.execute(
    `INSERT INTO products (name, category, price, description, seller_id, status, created_at)
     VALUES (?, 'Electronics', 1200, 'Scientific Calculator', ?, 'sold', NOW())`,
    [`Calculator ${timestamp}`, seller.id]
  );
  const soldProductId = prodRes2.insertId;

  const [prodRes3] = await pool.execute(
    `INSERT INTO products (name, category, price, description, seller_id, status, created_at)
     VALUES (?, 'Furniture', 800, 'Study Table', ?, 'archived', NOW())`,
    [`Desk ${timestamp}`, seller.id]
  );
  const archivedProductId = prodRes3.insertId;

  try {
    // -----------------------------------------------------------------
    // TEST SUITE 1: CATALOG STATUS FILTERING (GET /api/products)
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 1] Catalog Status Filtering & Status In Response...");

    const resCatalogDefault = await makeRequest("/api/products");
    assert("GET /api/products returns 200 OK", resCatalogDefault.status === 200);
    assert("Catalog response contains products array", Array.isArray(resCatalogDefault.json.products));

    const foundActive = resCatalogDefault.json.products.find(p => p.id === activeProductId);
    const foundSold = resCatalogDefault.json.products.find(p => p.id === soldProductId);
    const foundArchived = resCatalogDefault.json.products.find(p => p.id === archivedProductId);

    assert("Default catalog includes active product", Boolean(foundActive));
    assert("Active product has status = 'active'", foundActive && foundActive.status === "active");
    assert("Default catalog EXCLUDES sold product", !foundSold);
    assert("Default catalog EXCLUDES archived product", !foundArchived);

    // Query with ?status=sold
    const resCatalogSold = await makeRequest("/api/products?status=sold");
    assert("GET /api/products?status=sold returns 200 OK", resCatalogSold.status === 200);
    const foundSoldInSoldQuery = resCatalogSold.json.products.find(p => p.id === soldProductId);
    const foundActiveInSoldQuery = resCatalogSold.json.products.find(p => p.id === activeProductId);
    assert("?status=sold returns the sold product", Boolean(foundSoldInSoldQuery));
    assert("?status=sold excludes active product", !foundActiveInSoldQuery);

    // 1.3 Archived catalog privacy checks
    // Unauthenticated request for ?status=archived
    const resUnauthArchivedCatalog = await makeRequest("/api/products?status=archived");
    assert("Unauthenticated ?status=archived returns 200 OK", resUnauthArchivedCatalog.status === 200);
    assert("Unauthenticated ?status=archived returns zero products", resUnauthArchivedCatalog.json.products.length === 0);

    // Unauthenticated request for seller's archived products
    const resUnauthSellerArchived = await makeRequest(`/api/products?sellerId=${seller.id}&status=archived`);
    assert("Unauthenticated ?sellerId=&status=archived returns zero products", resUnauthSellerArchived.json.products.length === 0);

    // Unrelated student request for seller's archived products
    const resOtherStudentArchived = await makeRequest(`/api/products?sellerId=${seller.id}&status=archived`, {
      token: otherStudent.token
    });
    assert("Unrelated student ?sellerId=&status=archived returns zero products", resOtherStudentArchived.json.products.length === 0);

    // Seller request for their own archived products
    const resSellerArchived = await makeRequest("/api/products?status=archived", {
      token: seller.token
    });
    assert("Seller can retrieve their own archived listings (200 OK)", resSellerArchived.status === 200);
    const foundArchivedInSellerQuery = resSellerArchived.json.products.find(p => p.id === archivedProductId);
    assert("Seller receives their archived product in response", Boolean(foundArchivedInSellerQuery));

    // Admin request for archived products
    const resAdminArchived = await makeRequest("/api/products?status=archived", {
      token: adminUser.token
    });
    assert("Admin can retrieve archived listings across marketplace (200 OK)", resAdminArchived.status === 200);
    const foundArchivedInAdminQuery = resAdminArchived.json.products.find(p => p.id === archivedProductId);
    assert("Admin receives archived products in response", Boolean(foundArchivedInAdminQuery));

    // 1.4 Single product detail privacy checks
    const resSingleActive = await makeRequest(`/api/products/${activeProductId}`);
    assert("GET /api/products/:id returns 200 OK", resSingleActive.status === 200);
    assert("Single product payload includes status = 'active'", resSingleActive.json.product.status === "active");

    const resSingleSold = await makeRequest(`/api/products/${soldProductId}`);
    assert("Single sold product payload includes status = 'sold'", resSingleSold.json.product.status === "sold");

    // Public / unauthenticated detail request for archived product -> 404
    const resUnauthArchivedDetail = await makeRequest(`/api/products/${archivedProductId}`);
    assert("Unauthenticated GET /api/products/:archivedId returns 404 Not Found", resUnauthArchivedDetail.status === 404);

    // Unrelated student detail request for archived product -> 404
    const resOtherArchivedDetail = await makeRequest(`/api/products/${archivedProductId}`, {
      token: otherStudent.token
    });
    assert("Unrelated student GET /api/products/:archivedId returns 404 Not Found", resOtherArchivedDetail.status === 404);

    // Seller (owner) detail request for archived product -> 200 OK
    const resSellerArchivedDetail = await makeRequest(`/api/products/${archivedProductId}`, {
      token: seller.token
    });
    assert("Seller can view their own archived product details (200 OK)", resSellerArchivedDetail.status === 200);
    assert("Seller view includes status = 'archived'", resSellerArchivedDetail.json.product.status === "archived");

    // Admin detail request for archived product -> 200 OK
    const resAdminArchivedDetail = await makeRequest(`/api/products/${archivedProductId}`, {
      token: adminUser.token
    });
    assert("Admin can view archived product details (200 OK)", resAdminArchivedDetail.status === 200);
    assert("Admin view includes status = 'archived'", resAdminArchivedDetail.json.product.status === "archived");

    // -----------------------------------------------------------------
    // TEST SUITE 2: EDIT LISTING (PUT /api/products/:productId)
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 2] Product Edit Authentication, Ownership & Input Validation...");

    // 2.1 Unauthenticated edit
    const resUnauthEdit = await makeRequest(`/api/products/${activeProductId}`, {
      method: "PUT",
      json: { name: "Hacked Name", price: 100 }
    });
    assert("Unauthenticated PUT /api/products/:id returns 401", resUnauthEdit.status === 401);

    // 2.2 Unverified email
    const resUnverEdit = await makeRequest(`/api/products/${activeProductId}`, {
      method: "PUT",
      token: unverifiedUser.token,
      json: { name: "Unverified Edit", price: 100 }
    });
    assert("Email-unverified user blocked from editing listing (403)", resUnverEdit.status === 403);

    // 2.3 Pending registration
    const resPendingEdit = await makeRequest(`/api/products/${activeProductId}`, {
      method: "PUT",
      token: pendingUser.token,
      json: { name: "Pending Edit", price: 100 }
    });
    assert("Pending registration user blocked from editing listing (403)", resPendingEdit.status === 403);

    // 2.4 Rejected registration
    const resRejectedEdit = await makeRequest(`/api/products/${activeProductId}`, {
      method: "PUT",
      token: rejectedUser.token,
      json: { name: "Rejected Edit", price: 100 }
    });
    assert("Rejected registration user blocked from editing listing (403)", resRejectedEdit.status === 403);

    // 2.5 Unauthorized other student (IDOR protection)
    const resOtherEdit = await makeRequest(`/api/products/${activeProductId}`, {
      method: "PUT",
      token: otherStudent.token,
      json: { name: "Tampered by Dave", price: 50, category: "Books", description: "Tampered" }
    });
    assert("Non-seller student blocked from editing another's listing (403)", resOtherEdit.status === 403);

    // 2.6 Nonexistent product
    const resNonexistentEdit = await makeRequest("/api/products/999999", {
      method: "PUT",
      token: seller.token,
      json: { name: "Ghost Product", price: 100, category: "Books", description: "None" }
    });
    assert("Editing nonexistent product returns 404", resNonexistentEdit.status === 404);

    // 2.7 Validation errors
    const resInvalidCat = await makeRequest(`/api/products/${activeProductId}`, {
      method: "PUT",
      token: seller.token,
      json: { name: "Valid Name", category: "InvalidCategory", price: 300, description: "Valid desc" }
    });
    assert("Editing with invalid category returns 400 Bad Request", resInvalidCat.status === 400);

    const resNegativePrice = await makeRequest(`/api/products/${activeProductId}`, {
      method: "PUT",
      token: seller.token,
      json: { name: "Valid Name", category: "Books", price: -50, description: "Valid desc" }
    });
    assert("Editing with negative price returns 400 Bad Request", resNegativePrice.status === 400);

    const resEmptyName = await makeRequest(`/api/products/${activeProductId}`, {
      method: "PUT",
      token: seller.token,
      json: { name: "   ", category: "Books", price: 200, description: "Valid desc" }
    });
    assert("Editing with whitespace-only name returns 400 Bad Request", resEmptyName.status === 400);

    // 2.8 Legitimate seller edit
    const resSellerValidEdit = await makeRequest(`/api/products/${activeProductId}`, {
      method: "PUT",
      token: seller.token,
      json: {
        name: `Physics Volume 2 (${timestamp})`,
        category: "Books",
        price: 550,
        description: "Updated description: includes CD-ROM."
      }
    });
    assert("Seller updating own product returns 200 OK", resSellerValidEdit.status === 200);
    assert("Response contains updated product name", resSellerValidEdit.json.product.name === `Physics Volume 2 (${timestamp})`);
    assert("Response contains updated price", resSellerValidEdit.json.product.price === 550);

    // Verify in database
    const [dbCheckEdit] = await pool.execute("SELECT name, price, description FROM products WHERE id = ?", [activeProductId]);
    assert("Database stores updated product name", dbCheckEdit[0].name === `Physics Volume 2 (${timestamp})`);
    assert("Database stores updated price", Number(dbCheckEdit[0].price) === 550);
    assert("Database stores updated description", dbCheckEdit[0].description === "Updated description: includes CD-ROM.");

    // 2.9 Admin editing student listing
    const resAdminEdit = await makeRequest(`/api/products/${activeProductId}`, {
      method: "PUT",
      token: adminUser.token,
      json: {
        name: `Physics Volume 2 [Admin Moderated]`,
        category: "Books",
        price: 520,
        description: "Admin reviewed textbook listing."
      }
    });
    assert("Admin authorized to update student listing (200 OK)", resAdminEdit.status === 200);

    // -----------------------------------------------------------------
    // TEST SUITE 3: STATUS TOGGLE (PATCH /api/products/:productId/status)
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 3] Availability Status Toggle (active <-> sold)...");

    // 3.1 Unauthenticated status toggle
    const resUnauthStatus = await makeRequest(`/api/products/${activeProductId}/status`, {
      method: "PATCH",
      json: { status: "sold" }
    });
    assert("Unauthenticated PATCH /status returns 401", resUnauthStatus.status === 401);

    // 3.2 Non-seller status toggle
    const resOtherStatus = await makeRequest(`/api/products/${activeProductId}/status`, {
      method: "PATCH",
      token: otherStudent.token,
      json: { status: "sold" }
    });
    assert("Non-seller student blocked from changing status (403)", resOtherStatus.status === 403);

    // 3.3 Invalid status value
    const resInvalidStatus = await makeRequest(`/api/products/${activeProductId}/status`, {
      method: "PATCH",
      token: seller.token,
      json: { status: "destroyed" }
    });
    assert("Invalid status value returns 400 Bad Request", resInvalidStatus.status === 400);

    // 3.4 Direct transition to 'archived' rejected in PATCH /status
    const resRejectArchivedStatus = await makeRequest(`/api/products/${activeProductId}/status`, {
      method: "PATCH",
      token: seller.token,
      json: { status: "archived" }
    });
    assert("PATCH /status rejects 'archived' status value (400 Bad Request)", resRejectArchivedStatus.status === 400);

    // 3.4 Seller marks active product as 'sold'
    const resMarkSold = await makeRequest(`/api/products/${activeProductId}/status`, {
      method: "PATCH",
      token: seller.token,
      json: { status: "sold" }
    });
    assert("Seller marking product as 'sold' returns 200 OK", resMarkSold.status === 200);
    assert("Response product status is 'sold'", resMarkSold.json.product.status === "sold");

    const [dbCheckSold] = await pool.execute("SELECT status FROM products WHERE id = ?", [activeProductId]);
    assert("Database confirms product status is 'sold'", dbCheckSold[0].status === "sold");

    // Product is now excluded from default catalog
    const resCatalogAfterSold = await makeRequest("/api/products");
    const foundInDefaultAfterSold = resCatalogAfterSold.json.products.find(p => p.id === activeProductId);
    assert("Now-sold product is hidden from default catalog", !foundInDefaultAfterSold);

    // 3.5 Seller toggles product back to 'active'
    const resMarkActive = await makeRequest(`/api/products/${activeProductId}/status`, {
      method: "PATCH",
      token: seller.token,
      json: { status: "active" }
    });
    assert("Seller toggling product back to 'active' returns 200 OK", resMarkActive.status === 200);

    const [dbCheckActive] = await pool.execute("SELECT status FROM products WHERE id = ?", [activeProductId]);
    assert("Database confirms product status is 'active'", dbCheckActive[0].status === "active");

    // -----------------------------------------------------------------
    // TEST SUITE 4: SOFT ARCHIVAL (DELETE /api/products/:productId)
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 4] Soft Archival Removal (DELETE /api/products/:id)...");

    // Create a product specifically for deletion test
    const [delProdRes] = await pool.execute(
      `INSERT INTO products (name, category, price, description, seller_id, status, created_at)
       VALUES (?, 'Accessories', 250, 'Backpack', ?, 'active', NOW())`,
      [`Backpack to Archive ${timestamp}`, seller.id]
    );
    const delProductId = delProdRes.insertId;

    // 4.1 Unauthenticated delete
    const resUnauthDel = await makeRequest(`/api/products/${delProductId}`, { method: "DELETE" });
    assert("Unauthenticated DELETE /api/products/:id returns 401", resUnauthDel.status === 401);

    // 4.2 Non-seller delete
    const resOtherDel = await makeRequest(`/api/products/${delProductId}`, {
      method: "DELETE",
      token: otherStudent.token
    });
    assert("Non-seller student blocked from deleting product (403)", resOtherDel.status === 403);

    // 4.3 Nonexistent product delete
    const resNonexistentDel = await makeRequest("/api/products/999999", {
      method: "DELETE",
      token: seller.token
    });
    assert("Deleting nonexistent product returns 404", resNonexistentDel.status === 404);

    // 4.4 Seller soft-archives product
    const resSellerDel = await makeRequest(`/api/products/${delProductId}`, {
      method: "DELETE",
      token: seller.token
    });
    assert("Seller deleting product returns 200 OK", resSellerDel.status === 200);
    assert("Response indicates status = 'archived'", resSellerDel.json.status === "archived");

    // CRITICAL CHECK: Verify product record STILL EXISTS in database (NO hard delete)
    const [dbCheckArchived] = await pool.execute("SELECT id, status FROM products WHERE id = ?", [delProductId]);
    assert("Product row still exists in database (not physically deleted)", dbCheckArchived.length === 1);
    assert("Database status is 'archived'", dbCheckArchived[0].status === "archived");

    // Archived item cannot be edited
    const resEditArchived = await makeRequest(`/api/products/${delProductId}`, {
      method: "PUT",
      token: seller.token,
      json: { name: "Try Edit Archived", price: 300, category: "Accessories", description: "Desc" }
    });
    assert("Attempting to edit an archived product returns 400 Bad Request", resEditArchived.status === 400);

    // Archived item cannot be revived via PATCH /status
    const resReviveArchived = await makeRequest(`/api/products/${delProductId}/status`, {
      method: "PATCH",
      token: seller.token,
      json: { status: "active" }
    });
    assert("Attempting to revive archived listing via PATCH /status returns 400 Bad Request", resReviveArchived.status === 400);
    assert("Response explains archived listings cannot be updated", resReviveArchived.json.message.includes("Archived listings cannot be updated"));

    // -----------------------------------------------------------------
    // TEST SUITE 5: CHAT HISTORY PRESERVATION & INQUIRY BLOCKING
    // -----------------------------------------------------------------
    console.log("\n[TEST SUITE 5] Chat Preservation After Archival & Inquiry Gating...");

    // Create a dedicated product with an active chat thread between seller and buyer1
    const [chatProdRes] = await pool.execute(
      `INSERT INTO products (name, category, price, description, seller_id, status, created_at)
       VALUES (?, 'Electronics', 3500, 'Graphing Calculator with Cable', ?, 'active', NOW())`,
      [`Chat Retention Test Prod ${timestamp}`, seller.id]
    );
    const chatProductId = chatProdRes.insertId;

    // Buyer1 sends message on product
    const resBuyer1Msg = await makeRequest(`/api/chats/${chatProductId}`, {
      method: "POST",
      token: buyer1.token,
      json: { message: "Hello! Is the cable included?" }
    });
    assert("Buyer1 initiates conversation (201 Created)", resBuyer1Msg.status === 201);
    const threadId = resBuyer1Msg.json.message.threadId;

    // Seller replies on thread
    const resSellerMsg = await makeRequest(`/api/chats/thread/${threadId}`, {
      method: "POST",
      token: seller.token,
      json: { message: "Yes, original USB cable included." }
    });
    assert("Seller replies on thread (201 Created)", resSellerMsg.status === 201);

    // Verify messages exist in DB
    const [msgsBeforeArchive] = await pool.execute("SELECT COUNT(*) AS c FROM chat_messages WHERE thread_id = ?", [threadId]);
    assert("Thread has 2 messages in database", msgsBeforeArchive[0].c === 2);

    // NOW SELLER ARCHIVES THE PRODUCT
    const resArchiveChatProd = await makeRequest(`/api/products/${chatProductId}`, {
      method: "DELETE",
      token: seller.token
    });
    assert("Seller archives product (200 OK)", resArchiveChatProd.status === 200);

    // VERIFY CHAT THREAD STILL EXISTS AND IS NOT CASCADE DELETED
    const [threadsAfterArchive] = await pool.execute("SELECT * FROM chat_threads WHERE id = ?", [threadId]);
    assert("Chat thread survives product archival (foreign key NOT cascaded)", threadsAfterArchive.length === 1);

    const [msgsAfterArchive] = await pool.execute("SELECT COUNT(*) AS c FROM chat_messages WHERE thread_id = ?", [threadId]);
    assert("All chat messages survive product archival", msgsAfterArchive[0].c === 2);

    // Buyer 1 can still read the entire conversation thread
    const resBuyerReadArchivedThread = await makeRequest(`/api/chats/thread/${threadId}`, { token: buyer1.token });
    assert("Buyer 1 can read chat history on archived product (200 OK)", resBuyerReadArchivedThread.status === 200);
    assert("Buyer 1 sees both messages", resBuyerReadArchivedThread.json.messages.length === 2);

    // Seller can still read the entire conversation thread
    const resSellerReadArchivedThread = await makeRequest(`/api/chats/thread/${threadId}`, { token: seller.token });
    assert("Seller can read chat history on archived product (200 OK)", resSellerReadArchivedThread.status === 200);

    // Authorized chat participant can access product details of archived item (via thread context)
    const resBuyer1ArchivedDetail = await makeRequest(`/api/products/${chatProductId}`, { token: buyer1.token });
    assert("Authorized chat participant can view archived product details (200 OK)", resBuyer1ArchivedDetail.status === 200);
    assert("Participant view contains product status = 'archived'", resBuyer1ArchivedDetail.json.product.status === "archived");

    // Unrelated buyer cannot view archived product details
    const resBuyer2ArchivedDetail = await makeRequest(`/api/products/${chatProductId}`, { token: buyer2.token });
    assert("Unrelated student cannot view archived product details (404 Not Found)", resBuyer2ArchivedDetail.status === 404);

    // Existing participants can still post replies on their existing thread
    const resBuyerReplyArchived = await makeRequest(`/api/chats/thread/${threadId}`, {
      method: "POST",
      token: buyer1.token,
      json: { message: "Great, thanks for confirming earlier." }
    });
    assert("Buyer 1 can post reply on existing thread of archived product (201 Created)", resBuyerReplyArchived.status === 201);

    // BUT an unrelated buyer2 CANNOT initiate a new conversation on the archived product
    const resBuyer2BlockedArchive = await makeRequest(`/api/chats/${chatProductId}`, {
      method: "POST",
      token: buyer2.token,
      json: { message: "Can I buy this archived item?" }
    });
    assert("New buyer blocked from messaging on archived product (400 Bad Request)", resBuyer2BlockedArchive.status === 400);
    assert("Response explains listing is archived", resBuyer2BlockedArchive.json.message.includes("archived"));

    // 5.2 Test inquiry blocking on SOLD product
    // Create product and mark it as sold
    const [soldProdRes] = await pool.execute(
      `INSERT INTO products (name, category, price, description, seller_id, status, created_at)
       VALUES (?, 'Accessories', 300, 'Sold Wristwatch', ?, 'sold', NOW())`,
      [`Sold Watch ${timestamp}`, seller.id]
    );
    const soldTestProductId = soldProdRes.insertId;

    // Buyer2 attempts to initiate NEW inquiry on sold product
    const resBuyer2BlockedSold = await makeRequest(`/api/chats/${soldTestProductId}`, {
      method: "POST",
      token: buyer2.token,
      json: { message: "Is the watch still available?" }
    });
    assert("New buyer blocked from initiating inquiry on sold product (400 Bad Request)", resBuyer2BlockedSold.status === 400);
    assert("Response explains product has been marked as sold", resBuyer2BlockedSold.json.message.includes("sold"));

  } finally {
    console.log("\n[INFO] Cleaning up Phase 7A test records...");
    try {
      await pool.execute("DELETE FROM products WHERE seller_id IN (?, ?, ?, ?, ?, ?, ?, ?)", [
        seller.id, buyer1.id, buyer2.id, otherStudent.id, adminUser.id, unverifiedUser.id, pendingUser.id, rejectedUser.id
      ]);
      await pool.execute(
        `DELETE FROM users WHERE email LIKE 'p7a_%_${timestamp}@campus.local'`
      );
    } catch (e) {
      console.warn("Cleanup warning:", e.message);
    }

    await pool.end();
    await new Promise((resolve) => server.close(resolve));
    console.log("\n==================================================");
    console.log(`  PHASE 7A-1 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log("==================================================\n");
    process.exit(failed > 0 ? 1 : 0);
  }
}

runPhase7aTests().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
