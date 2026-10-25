# 🎓 Campus Marketplace

> A trusted peer-to-peer student marketplace platform for university campuses, featuring student ID verification, product-anchored chat, and a Liquid Glassmorphism UI.

---

## ⚡ Quick Start

### 1. Requirements
- Node.js (v18+)
- MySQL (v8.0+)

### 2. Configure Environment
Copy `.env.example` to `.env` and configure your local MySQL credentials:
```bash
cp .env.example .env
```
Ensure your credentials are set in [`.env`](file:///.env):
```env
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=campus_marketplace
PORT=3000
```

### 3. Database Migration
Run the non-destructive database migrations to initialize tables and columns:
```bash
npm run migrate
```

### 4. Run Application
```bash
npm start
```
Open **[http://localhost:3000](http://localhost:3000)** in your browser. (On Windows, you can also double-click `start.bat`).

### 5. Run Verification Tests
```bash
npm test
```

### 🔑 Accounts & Authentication
- **Demo Student:** `student@campus.local` / `student123`
- **Administrator Setup:** Initial admin setup requires explicit configuration. Set `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` in `.env`, or run:
  ```bash
  node database/create_admin.js --email admin@campus.edu --password <secure-password>
  ```

---

## 📂 Project Architecture

```plaintext
Campus_Marketplace_Final/
├── frontend/                          # Client Single-Page Application (SPA)
│   ├── index.html                     # Semantic markup & pages
│   ├── script.js                      # Client logic & API fetcher
│   └── style.css                      # Liquid Glassmorphism UI
│
├── backend/                           # Server & API Layer
│   └── server.js                      # Node.js native HTTP server + MySQL pool
│
├── database/                          # Database Schemas & Migrations
│   ├── schema.sql                     # Authoritative MySQL DDL
│   ├── migrate.js                     # Migration runner
│   ├── backup.js                      # Database backup utility
│   ├── test_phase2.js                 # Automated integration tests
│   ├── backups/                       # Local database snapshots (gitignored)
│   └── migrations/                    # Versioned SQL migrations
│       ├── 001_initial_schema.sql
│       └── 002_phase2_migration.sql
│
├── docs/                              # Phase 1 Documentation Package
│   ├── PRD.md
│   ├── SRS.md
│   ├── TRD.md
│   ├── WBS.md
│   ├── DATABASE_DESIGN.md
│   ├── SECURITY_PLAN.md
│   ├── TEST_PLAN.md
│   └── RISK_REGISTER.md
│
├── .env.example                       # Sanitized configuration template
├── package.json                       # Scripts: start, test, migrate, backup
└── start.bat                          # One-click Windows launcher
```

---

## 📖 Full Documentation
For complete technical documentation including database schemas, system architecture diagrams, API references, and security mechanisms, see:
👉 **[docs/PRD.md](file:///docs/PRD.md)** | **[docs/SRS.md](file:///docs/SRS.md)** | **[DOCUMENTATION.md](file:///DOCUMENTATION.md)**
