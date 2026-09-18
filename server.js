const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mysql = require("mysql2/promise");

const PORT = 3000;
const HOST = "localhost";

const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOAD_DIR = path.join(__dirname, "uploads");

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/* =========================
   MYSQL CONNECTION
========================= */

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "shritej_takbide@123",
  database: process.env.DB_NAME || "campus_marketplace",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

/* =========================
   HELPERS
========================= */

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(data));
}

function sendText(res, statusCode, text, contentType = "text/plain") {
  res.writeHead(statusCode, {
    "Content-Type": contentType
  });

  res.end(text);
}

function getToken(req) {
  const auth = req.headers.authorization || "";

  if (auth.startsWith("Bearer ")) {
    return auth.slice(7);
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
    SELECT u.*
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
    LIMIT 1
    `,
    [token]
  );

  return rows[0] || null;
}

function hashPassword(password) {
  return crypto
    .createHash("sha256")
    .update(password)
    .digest("hex");
}

function createToken() {
  return crypto.randomBytes(32).toString("hex");
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", chunk => {
      body += chunk.toString();

      if (body.length > 10 * 1024 * 1024) {
        reject(new Error("Request too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

function safeFileName(name) {
  return String(name || "document")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
}

function serveStatic(req, res) {
  let pathname = decodeURIComponent(new URL(req.url, `http://${HOST}:${PORT}`).pathname);

  if (pathname === "/") {
    pathname = "/index.html";
  }

  const filePath = path.normalize(
    path.join(PUBLIC_DIR, pathname)
  );

  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendText(res, 403, "Forbidden");
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      return sendText(res, 404, "File not found");
    }

    const ext = path.extname(filePath).toLowerCase();

    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon"
    };

    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream"
    });

    res.end(data);
  });
}

/* =========================
   DATABASE INITIALIZATION
========================= */

async function initializeDatabase() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      token VARCHAR(255) PRIMARY KEY,
      user_id INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  const [users] = await pool.execute(
    "SELECT id FROM users WHERE email = ? LIMIT 1",
    ["student@campus.local"]
  );

  let demoUserId;

  if (users.length === 0) {
    const [result] = await pool.execute(
      `
      INSERT INTO users
      (name, email, password_hash, verified, created_at)
      VALUES (?, ?, ?, ?, NOW())
      `,
      [
        "Demo Student",
        "student@campus.local",
        hashPassword("student123"),
        1
      ]
    );

    demoUserId = result.insertId;
  } else {
    demoUserId = users[0].id;
  }

  const [products] = await pool.execute(
    "SELECT COUNT(*) AS count FROM products"
  );

  if (Number(products[0].count) === 0) {
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

    for (const product of demoProducts) {
      await pool.execute(
        `
        INSERT INTO products
        (name, category, price, description, seller_id, created_at)
        VALUES (?, ?, ?, ?, ?, NOW())
        `,
        product
      );
    }
  }

  console.log("MySQL database initialized.");
}

/* =========================
   API ROUTES
========================= */

async function handleAPI(req, res) {
  const url = new URL(
    req.url,
    `http://${HOST}:${PORT}`
  );

  const pathname = url.pathname;

  /* ---------- HEALTH ---------- */

  if (req.method === "GET" && pathname === "/api/health") {
    return sendJSON(res, 200, {
      success: true,
      message: "Campus Marketplace API is running",
      database: "MySQL"
    });
  }

  /* ---------- REGISTER ---------- */

  if (
    req.method === "POST" &&
    pathname === "/api/auth/register"
  ) {
    const body = await parseBody(req);

    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    if (!name || !email || !password) {
      return sendJSON(res, 400, {
        success: false,
        message: "Name, email and password are required."
      });
    }

    if (password.length < 6) {
      return sendJSON(res, 400, {
        success: false,
        message: "Password must contain at least 6 characters."
      });
    }

    const [existing] = await pool.execute(
      "SELECT id FROM users WHERE email = ? LIMIT 1",
      [email]
    );

    if (existing.length) {
      return sendJSON(res, 409, {
        success: false,
        message: "An account with this email already exists."
      });
    }

    const [result] = await pool.execute(
      `
      INSERT INTO users
      (name, email, password_hash, verified, created_at)
      VALUES (?, ?, ?, 0, NOW())
      `,
      [
        name,
        email,
        hashPassword(password)
      ]
    );

    const token = createToken();

    await pool.execute(
      `
      INSERT INTO sessions
      (token, user_id, created_at)
      VALUES (?, ?, NOW())
      `,
      [token, result.insertId]
    );

    return sendJSON(res, 201, {
      success: true,
      token,
      user: {
        id: result.insertId,
        name,
        email,
        verified: false
      }
    });
  }

  /* ---------- LOGIN ---------- */

  if (
    req.method === "POST" &&
    pathname === "/api/auth/login"
  ) {
    const body = await parseBody(req);

    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    const [rows] = await pool.execute(
      `
      SELECT *
      FROM users
      WHERE email = ?
      LIMIT 1
      `,
      [email]
    );

    if (
      rows.length === 0 ||
      rows[0].password_hash !== hashPassword(password)
    ) {
      return sendJSON(res, 401, {
        success: false,
        message: "Invalid email or password."
      });
    }

    const user = rows[0];
    const token = createToken();

    await pool.execute(
      `
      INSERT INTO sessions
      (token, user_id, created_at)
      VALUES (?, ?, NOW())
      `,
      [token, user.id]
    );

    return sendJSON(res, 200, {
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        verified: Boolean(user.verified)
      }
    });
  }

  /* ---------- CURRENT USER ---------- */

  if (
    req.method === "GET" &&
    pathname === "/api/me"
  ) {
    const user = await getCurrentUser(req);

    if (!user) {
      return sendJSON(res, 401, {
        success: false,
        message: "Not logged in."
      });
    }

    return sendJSON(res, 200, {
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        verified: Boolean(user.verified)
      }
    });
  }

  /* ---------- PRODUCTS ---------- */

  if (
    req.method === "GET" &&
    pathname === "/api/products"
  ) {
    const search = url.searchParams.get("search") || "";
    const category = url.searchParams.get("category") || "";

    let query = `
      SELECT
        p.id,
        p.name,
        p.category,
        p.price,
        p.description,
        p.seller_id,
        p.created_at,
        u.name AS seller_name,
        u.verified AS seller_verified
      FROM products p
      LEFT JOIN users u ON u.id = p.seller_id
      WHERE 1=1
    `;

    const params = [];

    if (search) {
      query += `
        AND (
          p.name LIKE ?
          OR p.description LIKE ?
          OR p.category LIKE ?
        )
      `;

      const term = `%${search}%`;

      params.push(term, term, term);
    }

    if (category) {
      query += " AND p.category = ?";
      params.push(category);
    }

    query += " ORDER BY p.created_at DESC";

    const [rows] = await pool.execute(query, params);

    const products = rows.map(product => ({
      id: product.id,
      name: product.name,
      category: product.category,
      price: Number(product.price),
      description: product.description,
      sellerId: product.seller_id,
      seller: product.seller_name || "Unknown Seller",
      verified: Boolean(product.seller_verified),
      createdAt: product.created_at
    }));

    return sendJSON(res, 200, {
      success: true,
      products
    });
  }

  /* ---------- SINGLE PRODUCT ---------- */

  const productMatch = pathname.match(
    /^\/api\/products\/(\d+)$/
  );

  if (
    req.method === "GET" &&
    productMatch
  ) {
    const productId = Number(productMatch[1]);

    const [rows] = await pool.execute(
      `
      SELECT
        p.id,
        p.name,
        p.category,
        p.price,
        p.description,
        p.seller_id,
        p.created_at,
        u.name AS seller_name,
        u.email AS seller_email,
        u.verified AS seller_verified
      FROM products p
      LEFT JOIN users u ON u.id = p.seller_id
      WHERE p.id = ?
      LIMIT 1
      `,
      [productId]
    );

    if (!rows.length) {
      return sendJSON(res, 404, {
        success: false,
        message: "Product not found."
      });
    }

    const product = rows[0];

    return sendJSON(res, 200, {
      success: true,
      product: {
        id: product.id,
        name: product.name,
        category: product.category,
        price: Number(product.price),
        description: product.description,
        sellerId: product.seller_id,
        seller: product.seller_name,
        sellerEmail: product.seller_email,
        verified: Boolean(product.seller_verified),
        createdAt: product.created_at
      }
    });
  }

  /* ---------- SELL PRODUCT ---------- */

  if (
    req.method === "POST" &&
    pathname === "/api/products"
  ) {
    const user = await getCurrentUser(req);

    if (!user) {
      return sendJSON(res, 401, {
        success: false,
        message: "Please login before selling a product."
      });
    }

    const body = await parseBody(req);

    const name = String(body.name || "").trim();
    const category = String(body.category || "").trim();
    const description = String(body.description || "").trim();
    const price = Number(body.price);

    if (!name || !category || !description || !Number.isFinite(price)) {
      return sendJSON(res, 400, {
        success: false,
        message: "Please fill all product details correctly."
      });
    }

    if (price < 0) {
      return sendJSON(res, 400, {
        success: false,
        message: "Price cannot be negative."
      });
    }

    const [result] = await pool.execute(
      `
      INSERT INTO products
      (name, category, price, description, seller_id, created_at)
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

    return sendJSON(res, 201, {
      success: true,
      message: "Product listed successfully.",
      product: {
        id: result.insertId,
        name,
        category,
        price,
        description,
        sellerId: user.id,
        seller: user.name,
        verified: Boolean(user.verified)
      }
    });
  }

  /* ---------- VERIFICATION ---------- */

  if (
    req.method === "POST" &&
    pathname === "/api/verification"
  ) {
    const user = await getCurrentUser(req);

    if (!user) {
      return sendJSON(res, 401, {
        success: false,
        message: "Please login before submitting verification."
      });
    }

    const body = await parseBody(req);

    const studentName = String(body.studentName || "").trim();
    const studentEmail = String(body.studentEmail || "").trim();
    const studentId = String(body.studentId || "").trim();
    const department = String(body.department || "").trim();
    const documentName = safeFileName(body.documentName || "college_id");
    const documentData = body.documentData || "";

    if (
      !studentName ||
      !studentEmail ||
      !studentId ||
      !department ||
      !documentData
    ) {
      return sendJSON(res, 400, {
        success: false,
        message: "Please complete all verification fields."
      });
    }

    const extension =
      path.extname(documentName) || ".bin";

    const savedName =
      `${Date.now()}_${user.id}${extension}`;

    const filePath =
      path.join(UPLOAD_DIR, savedName);

    try {
      const base64 = documentData.includes(",")
        ? documentData.split(",")[1]
        : documentData;

      fs.writeFileSync(
        filePath,
        Buffer.from(base64, "base64")
      );
    } catch {
      return sendJSON(res, 400, {
        success: false,
        message: "Could not save verification document."
      });
    }

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
        status,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NOW())
      `,
      [
        user.id,
        studentName,
        studentEmail,
        studentId,
        department,
        documentName,
        savedName
      ]
    );

    return sendJSON(res, 200, {
      success: true,
      message: "Verification submitted successfully.",
      status: "pending"
    });
  }

  /* ---------- CHAT GET ---------- */

  const chatMatch = pathname.match(
    /^\/api\/chats\/(\d+)$/
  );

  if (
    req.method === "GET" &&
    chatMatch
  ) {
    const user = await getCurrentUser(req);

    if (!user) {
      return sendJSON(res, 401, {
        success: false,
        message: "Please login to use chat."
      });
    }

    const productId = Number(chatMatch[1]);

    const [rows] = await pool.execute(
      `
      SELECT
        c.id,
        c.product_id,
        c.sender_id,
        u.name AS sender,
        c.message,
        c.created_at
      FROM chats c
      LEFT JOIN users u ON u.id = c.sender_id
      WHERE c.product_id = ?
      ORDER BY c.created_at ASC
      `,
      [productId]
    );

    return sendJSON(res, 200, {
      success: true,
      messages: rows.map(message => ({
        id: message.id,
        productId: message.product_id,
        senderId: message.sender_id,
        sender: message.sender || "User",
        message: message.message,
        text: message.message,
        createdAt: message.created_at
      }))
    });
  }

  /* ---------- CHAT POST ---------- */

  if (
    req.method === "POST" &&
    chatMatch
  ) {
    const user = await getCurrentUser(req);

    if (!user) {
      return sendJSON(res, 401, {
        success: false,
        message: "Please login to use chat."
      });
    }

    const productId = Number(chatMatch[1]);

    const body = await parseBody(req);

    const message = String(
      body.message || body.text || ""
    ).trim();

    if (!message) {
      return sendJSON(res, 400, {
        success: false,
        message: "Message cannot be empty."
      });
    }

    const [products] = await pool.execute(
      "SELECT id FROM products WHERE id = ? LIMIT 1",
      [productId]
    );

    if (!products.length) {
      return sendJSON(res, 404, {
        success: false,
        message: "Product not found."
      });
    }

    const [result] = await pool.execute(
      `
      INSERT INTO chats
      (product_id, sender_id, message, created_at)
      VALUES (?, ?, ?, NOW())
      `,
      [
        productId,
        user.id,
        message
      ]
    );

    return sendJSON(res, 201, {
      success: true,
      message: {
        id: result.insertId,
        productId,
        senderId: user.id,
        sender: user.name,
        message,
        text: message
      }
    });
  }

  return sendJSON(res, 404, {
    success: false,
    message: "API endpoint not found."
  });
}

/* =========================
   SERVER
========================= */

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) {
      await handleAPI(req, res);
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    console.error("Server error:", error);

    sendJSON(res, 500, {
      success: false,
      message: "Internal server error.",
      error: error.message
    });
  }
});

/* =========================
   START
========================= */

async function startServer() {
  try {
    await pool.query("SELECT 1");

    console.log("MySQL connection successful.");

    await initializeDatabase();

    server.listen(PORT, HOST, () => {
      console.log("");
      console.log("====================================");
      console.log(" Campus Marketplace");
      console.log(" MySQL backend running");
      console.log(` http://${HOST}:${PORT}`);
      console.log("====================================");
      console.log("");
      console.log("Demo login:");
      console.log("Email: student@campus.local");
      console.log("Password: student123");
    });
  } catch (error) {
    console.error("");
    console.error("DATABASE CONNECTION FAILED");
    console.error("------------------------------------");
    console.error(error.message);
    console.error("");
    console.error("Check your MySQL password in server.js");
    console.error("");
    process.exit(1);
  }
}

startServer();