require("dotenv").config();const http = require("http");

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mysql = require("mysql2/promise");

/* =========================
   CONFIGURATION
========================= */

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "localhost";

const PUBLIC_DIR = path.join(__dirname, "public");

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
    "Cache-Control": "no-store"
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
    "Content-Type": contentType
  });

  res.end(text);
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
      u.verified,
      u.created_at
    FROM sessions s
    JOIN users u
      ON u.id = s.user_id
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
    Prevent directory traversal.
  */

  if (
    filePath !== publicRoot &&
    !filePath.startsWith(
      publicRoot + path.sep
    )
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
          "public, max-age=3600"
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
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
    )
  `);

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
    const [result] =
      await pool.execute(
        `
        INSERT INTO users
        (
          name,
          email,
          password_hash,
          verified,
          created_at
        )
        VALUES (?, ?, ?, ?, NOW())
        `,
        [
          "Demo Student",
          "student@campus.local",
          hashPassword("student123"),
          1
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

    const [result] =
      await pool.execute(
        `
        INSERT INTO users
        (
          name,
          email,
          password_hash,
          verified,
          created_at
        )
        VALUES (?, ?, ?, 0, NOW())
        `,
        [
          name,
          email,
          hashPassword(password)
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
        created_at
      )
      VALUES (?, ?, NOW())
      `,
      [
        token,
        result.insertId
      ]
    );

    return sendJSON(
      res,
      201,
      {
        success: true,
        token,

        user: {
          id: result.insertId,
          name,
          email,
          verified: false
        }
      }
    );
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

    const [rows] =
      await pool.execute(
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
      rows[0].password_hash !==
        hashPassword(password)
    ) {
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

    const token =
      createToken();

    await pool.execute(
      `
      INSERT INTO sessions
      (
        token,
        user_id,
        created_at
      )
      VALUES (?, ?, NOW())
      `,
      [
        token,
        user.id
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
          verified:
            Boolean(
              user.verified
            )
        }
      }
    );
  }

  /* =========================
     PRODUCTS LIST
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
      LEFT JOIN users u
        ON u.id = p.seller_id
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
     SINGLE PRODUCT
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

    const body =
      await parseBody(req);

    const studentName =
      String(
        body.studentName || ""
      ).trim();

    const studentEmail =
      String(
        body.studentEmail || ""
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
        body.documentName ||
          "college_id"
      );

    const documentData =
      String(
        body.documentData || ""
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

      return sendJSON(
        res,
        200,
        {
          success: true,
          message:
            "Verification submitted successfully.",
          status:
            "pending"
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

  /* =========================
     CHAT
  ========================= */

  const chatMatch =
    pathname.match(
      /^\/api\/chats\/(\d+)$/
    );

  /* =========================
     CHAT GET
  ========================= */

  if (
    req.method === "GET" &&
    chatMatch
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
            "Please login to use chat."
        }
      );
    }

    const productId =
      Number(
        chatMatch[1]
      );

    const [rows] =
      await pool.execute(
        `
        SELECT
          c.id,
          c.product_id,
          c.sender_id,
          u.name AS sender,
          c.message,
          c.created_at
        FROM chats c
        LEFT JOIN users u
          ON u.id = c.sender_id
        WHERE c.product_id = ?
        ORDER BY c.created_at ASC
        `,
        [productId]
      );

    return sendJSON(
      res,
      200,
      {
        success: true,

        messages:
          rows.map(
            message => ({
              id:
                message.id,

              productId:
                message.product_id,

              senderId:
                message.sender_id,

              sender:
                message.sender ||
                "User",

              message:
                message.message,

              text:
                message.message,

              createdAt:
                message.created_at
            })
          )
      }
    );
  }

  /* =========================
     CHAT POST
  ========================= */

  if (
    req.method === "POST" &&
    chatMatch
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
            "Please login to use chat."
        }
      );
    }

    const productId =
      Number(
        chatMatch[1]
      );

    const body =
      await parseBody(req);

    const message =
      String(
        body.message ||
          body.text ||
          ""
      ).trim();

    if (!message) {
      return sendJSON(
        res,
        400,
        {
          success: false,
          message:
            "Message cannot be empty."
        }
      );
    }

    const [products] =
      await pool.execute(
        `
        SELECT id
        FROM products
        WHERE id = ?
        LIMIT 1
        `,
        [productId]
      );

    if (!products.length) {
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

    const [result] =
      await pool.execute(
        `
        INSERT INTO chats
        (
          product_id,
          sender_id,
          message,
          created_at
        )
        VALUES (?, ?, ?, NOW())
        `,
        [
          productId,
          user.id,
          message
        ]
      );

    return sendJSON(
      res,
      201,
      {
        success: true,

        message: {
          id:
            result.insertId,

          productId,

          senderId:
            user.id,

          sender:
            user.name,

          message,

          text:
            message
        }
      }
    );
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

if (!process.env.VERCEL) {
  startLocalServer();
}

/*
  Export the HTTP server for Vercel.
*/

module.exports = server;