# 🧪 Test Plan & Verification Matrix — Campus Marketplace

- **Project Name:** Campus Marketplace
- **Document Version:** 1.0
- **Status:** Draft / Pending User Approval
- **Cross-References:** [PRD.md](file:///c:/Users/Downe/OneDrive/Documents/Campus_Marketplace_Final/docs/PRD.md) | [SRS.md](file:///c:/Users/Downe/OneDrive/Documents/Campus_Marketplace_Final/docs/SRS.md) | [TRD.md](file:///c:/Users/Downe/OneDrive/Documents/Campus_Marketplace_Final/docs/TRD.md) | [SECURITY_PLAN.md](file:///c:/Users/Downe/OneDrive/Documents/Campus_Marketplace_Final/docs/SECURITY_PLAN.md)

---

## 1. Test Strategy & Scope

This Test Plan defines the verification criteria, test environments, detailed test scenarios, and expected outcomes required to validate the Campus Marketplace.

### 1.1. Testing Scope
- **Core Marketplace Flows**: Browsing, filtering, searching, product creation, modal viewing.
- **Authentication & Lifecycle Flows**: Registration, Email OTP dispatch and validation, Admin approval gate, Login, Session expiration, Logout.
- **Administrative Functions**: Role enforcement (RBAC), registration queue management, student ID verification review, status synchronization.
- **Chat & Messaging**: Scoped thread resolution, message persistence, authorization enforcement, and UI bubble alignment.
- **Security & Resilience**: SQL injection, XSS escaping, IDOR chat privacy, payload size boundaries, rate-limiting.

---

## 2. Test Scenarios & Verification Matrix

### 2.1. Authentication, OTP & Account Lifecycle (TS-AUTH)

| Test ID | Test Case Summary | Preconditions | Input / Action | Expected Result | Pass/Fail |
| :--- | :--- | :--- | :--- | :--- | :---: |
| **TS-AUTH-01** | Standard Student Registration | Unregistered campus email | Submit valid Name, Email, Password | User created with `email_verified=false`, `registration_status='pending'`. 6-digit OTP sent via email. | Pending |
| **TS-AUTH-02** | Valid OTP Submission | User registered; OTP received | Submit correct 6-digit OTP to `/api/auth/verify-otp` | Response 200 OK; `users.email_verified` becomes `true`. UI updates to "Pending Admin Approval". | Pending |
| **TS-AUTH-03** | Incorrect OTP Handling | Valid unverified user | Submit wrong 6-digit OTP | Response 400 Bad Request; error message indicating remaining attempts; attempts counter incremented. | Pending |
| **TS-AUTH-04** | OTP Attempt Exhaustion | 2 previous failed attempts | Submit 3rd incorrect OTP | Response 403 Forbidden; OTP record deleted; user required to request a fresh OTP. | Pending |
| **TS-AUTH-05** | Expired OTP Submission | OTP generated > 10 min ago | Submit expired OTP | Response 400 Bad Request; error message: "OTP has expired. Please request a new one." | Pending |
| **TS-AUTH-06** | Login with Unapproved Account | `email_verified=true`, `registration_status='pending'` | Attempt `POST /api/auth/login` | Response 403 Forbidden; message: "Account registration is pending administrator approval." Token is NOT issued. | Pending |
| **TS-AUTH-07** | Login with Approved Account | `email_verified=true`, `registration_status='approved'` | Attempt `POST /api/auth/login` | Response 200 OK; 32-byte Bearer token issued; session persisted with 24-hour expiration. | Pending |
| **TS-AUTH-08** | Session Expiration Enforcement | Session created > 24 hrs ago | Request `/api/me` with expired token | Response 401 Unauthorized; client clears LocalStorage and redirects to `#login`. | Pending |

---

### 2.2. Administrator Management & RBAC (TS-ADMIN)

| Test ID | Test Case Summary | Preconditions | Input / Action | Expected Result | Pass/Fail |
| :--- | :--- | :--- | :--- | :--- | :---: |
| **TS-ADMIN-01** | Student Access to Admin Route | Logged in as `role='student'` | Request `GET /api/admin/registrations` | Response **403 Forbidden**; access denied by server-side RBAC middleware. | **PASS** |
| **TS-ADMIN-02** | Unauthenticated Admin Request | No Authorization header | Request `GET /api/admin/registrations` | Response **401 Unauthorized**. | **PASS** |
| **TS-ADMIN-03** | Admin Registration Approval | User in `'pending'` state | Admin calls `POST /api/admin/registrations/:id/approve` | Response 200 OK; `users.registration_status` set to `'approved'`; reviewer recorded. | **PASS** |
| **TS-ADMIN-04** | Admin Registration Rejection | User in `'pending'` state | Admin calls `POST /api/admin/registrations/:id/reject` with reason | Response 200 OK; `users.registration_status` set to `'rejected'`; active sessions purged. | **PASS** |
| **TS-ADMIN-05** | Direct Approval of Rejected Account | User in `'rejected'` state | Admin calls `POST /api/admin/registrations/:id/approve` | Response 400 Bad Request; re-review required. | **PASS** |
| **TS-ADMIN-06** | Explicit Re-Review Process | User in `'rejected'` state | Admin calls `POST /api/admin/registrations/:id/re-review` | Response 200 OK; status reset to `'pending'`, re-evaluation enabled. | **PASS** |
| **TS-ADMIN-07** | Marketplace Route Protection | Account pending or rejected | Attempt `POST /api/products`, `POST /api/verification`, `POST /api/chats/:id` | Response 403 Forbidden; operations strictly blocked on backend. | **PASS** |
| **TS-ADMIN-08** | Status Decoupling Verification | Account approved | Verify email & student verification status | `email_verified` and `student_verification_status` remain decoupled. | **PASS** |
| **TS-ADMIN-09** | Role Tampering Defense | Student registers with `role='admin'` | Request `POST /api/auth/register` with role payload | Request accepted but role forced to `'student'` and status to `'pending'`. | **PASS** |
| **TS-ADMIN-10** | Sensitive Field Audit | Admin queries list/detail | Inspect JSON payload | Zero leakage of `password_hash`, `otp_hash`, or session tokens. | **PASS** |

---

### 2.3. Student Verification & Badging (TS-VERIF)

| Test ID | Test Case Summary | Preconditions | Input / Action | Expected Result | Pass/Fail |
| :--- | :--- | :--- | :--- | :--- | :---: |
| **TS-VERIF-01** | Valid Student ID Submission | Approved student logged in | Fill form, select PNG ID card (< 4 MB), submit | Request saved as `pending`; UI badge displays "Verification Pending". | Pending |
| **TS-VERIF-02** | Oversized File Rejection | Approved student logged in | Select 6 MB file | Client rejects file before upload; error: "College ID file must be 4 MB or smaller." | Pending |
| **TS-VERIF-03** | Verified Seller Badge Display | Student verification approved | View listed products in `#products` | Products listed by this student render the `✓ Verified Seller` green badge. | Pending |

---

### 2.4. Scoped Peer-to-Peer Chat (TS-CHAT)

| Test ID | Test Case Summary | Preconditions | Input / Action | Expected Result | Pass/Fail |
| :--- | :--- | :--- | :--- | :--- | :---: |
| **TS-CHAT-01** | Thread Initialization | Buyer viewing Product A | Buyer clicks "Contact Seller" | System finds or creates unique thread `(product_id, buyer_id, seller_id)`. Chat pane opens. | Pending |
| **TS-CHAT-02** | Message Dispatch | Buyer in active thread | Submits message text | Message saved in `chat_messages` with `sender_id = buyer_id`. Rendered immediately in thread. | Pending |
| **TS-CHAT-03** | Chat Bubble Alignment | Message history loaded | Buyer inspects chat window | Messages sent by Buyer render right-aligned (`sent`); messages sent by Seller render left-aligned (`received`). | Pending |
| **TS-CHAT-04** | IDOR Privacy Isolation | User C is third-party student | User C calls `GET /api/chats/thread/:threadId` | Response **403 Forbidden**; User C cannot read conversation between User A and User B. | Pending |

---

### 2.5. Security & Injection Defenses (TS-SEC)

| Test ID | Test Case Summary | Input / Action | Expected Result | Pass/Fail |
| :--- | :--- | :--- | :--- | :---: |
| **TS-SEC-01** | SQL Injection in Search | Query `GET /api/products?search=' OR '1'='1` | Input escaped via parameterized query; matches only literal string; returns no unauthorized rows. | Pending |
| **TS-SEC-02** | SQL Injection in Auth | Login email: `admin' --` | Query executes as string literal; returns 401 Invalid email or password. | Pending |
| **TS-SEC-03** | Stored XSS in Product Name | Product title: `<script>alert('XSS')</script>` | Content sanitized through `esc()`; renders as `&lt;script&gt;` text; script does NOT execute. | Pending |
| **TS-SEC-04** | Tampered Bearer Token | Header: `Authorization: Bearer fake_token_abc` | Rejected with 401 Unauthorized; access blocked. | Pending |

---

## 3. Defect Severity & Pass/Fail Criteria

- **Blocker (Severity 1)**: Any failure in password hashing, session validation, or RBAC route protection.
- **Critical (Severity 2)**: Failure in OTP delivery/verification, failure in registration approval gate, or chat data leak across users.
- **Major (Severity 3)**: Product listing failure, incorrect verification badge display, or file upload failure under 4 MB.
- **Minor (Severity 4)**: Cosmetic alignment discrepancies or toast message wording.

**Sign-off Criterion**: 100% pass rate on Severity 1 and 2 tests; > 95% pass rate on Severity 3 tests.
