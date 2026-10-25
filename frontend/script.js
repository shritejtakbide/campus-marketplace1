/* =========================================================
   CAMPUS MARKETPLACE — FINAL FULL-STACK FRONTEND
   Talks to the local Node.js backend in server.js.
========================================================= */

const API = "/api";
const KEY = {
  token:"cm_token",
  email:"cm_email",
  name:"cm_name",
  currentChat:"cm_current_chat"
};

let products = [];
let myListings = [];
let sessionUser = null;
let currentMyListingsTab = "all";
let pendingArchiveProductId = null;
let toastTimer;
let authMode = "login";

function token(){ return localStorage.getItem(KEY.token) || ""; }

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  if (token()) headers.Authorization = `Bearer ${token()}`;

  const res = await fetch(API + path, { ...options, headers });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    if (res.status === 401) {
      localStorage.removeItem(KEY.token);
      sessionUser = null;
      updateAuthButton();
    }
    throw new Error(data.message || data.error || `Request failed (${res.status})`);
  }
  return data;
}

const VALID_PAGES = new Set([
  "home",
  "products",
  "sell",
  "my-listings",
  "verification",
  "chat",
  "admin",
  "login",
  "register",
  "terms",
  "privacy"
]);

function syncBodyScrollLock() {
  const hasOpenModal = Array.from(document.querySelectorAll(".market-modal")).some(m => !m.classList.contains("hidden"));
  document.body.classList.toggle("body-modal-open", hasOpenModal);
}

function closeAllModals() {
  closeProductModal();
  closeOtpModal();
  closeAdminRejectModal();
  closeEditProductModal();
  closeArchiveModal();
}

function toggleMobileNav() {
  const nav = document.getElementById("mainNavLinks");
  if (nav) nav.classList.toggle("nav-open");
}

function closeMobileNav() {
  const nav = document.getElementById("mainNavLinks");
  if (nav) nav.classList.remove("nav-open");
}

function updateNavActiveState(pageName) {
  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.classList.toggle("active", btn.getAttribute("data-page") === pageName);
  });
}

function showPage(name, updateHash = true) {
  closeMobileNav();
  closeAllModals();

  if (!VALID_PAGES.has(name)) {
    name = "home";
  }

  // Auth gate for protected pages
  if (name === "my-listings" && !token()) {
    showToast("Please login to view your listings.");
    if (updateHash) {
      history.replaceState(null, "", "#login");
    }
    showPage("login", false);
    return;
  }

  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  const page = document.getElementById(name);
  if (!page) return;
  page.classList.add("active");
  updateNavActiveState(name);
  window.scrollTo({ top: 0, behavior: "smooth" });

  if (updateHash) {
    if (window.location.hash !== "#" + name) {
      history.pushState(null, "", "#" + name);
    }
  }

  if (name === "products") loadProducts();
  if (name === "my-listings") loadMyListings();
  if (name === "verification") loadVerificationStatus();
  if (name === "chat") loadChat();
  if (name === "admin") loadAdminRegistrations();
}

window.addEventListener("popstate", () => {
  const rawHash = (window.location.hash || "").replace(/^#/, "");
  const targetPage = VALID_PAGES.has(rawHash) ? rawHash : "home";
  showPage(targetPage, false);
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" || e.key === "Esc") {
    closeAllModals();
  }
});

async function loadProducts(){
  try {
    const data = await api("/products");
    products = data.products || [];
    filterProducts();
  } catch (err) {
    showToast(err.message);
  }
}

function displayProducts(list = products){
  const grid = document.getElementById("productGrid");
  if (!grid) return;
  grid.innerHTML = "";

  if (!list.length) {
    grid.innerHTML = `<div class="empty-state glass"><div>🔍</div><h3>No products found</h3><p>Try another search or category.</p></div>`;
    return;
  }

  list.forEach(p => {
    const isOwner = Boolean(
      sessionUser && (
        Number(sessionUser.id) === Number(p.sellerId || p.seller_id) ||
        sessionUser.role === "admin"
      )
    );

    const isSold = p.status === "sold";
    const statusPill = isSold
      ? '<span class="status-pill status-sold" style="margin-left:6px;">Sold</span>'
      : '';

    let actionButtons = "";
    if (isOwner) {
      actionButtons = `
        <button class="outline-button small-button" onclick="openProductDetails('${esc(p.id)}',event)">Details</button>
        <button class="outline-button small-button" onclick="openEditProductModal('${esc(p.id)}')">✏️ Edit</button>
      `;
    } else {
      if (isSold) {
        actionButtons = `
          <button class="outline-button small-button" onclick="openProductDetails('${esc(p.id)}',event)">Details</button>
          <button class="outline-button small-button" disabled style="opacity:0.6; cursor:not-allowed;">Sold</button>
        `;
      } else {
        actionButtons = `
          <button class="outline-button small-button" onclick="openProductDetails('${esc(p.id)}',event)">Details</button>
          <button class="primary-button small-button" onclick="contactSeller('${esc(p.id)}',event)">Contact Seller</button>
        `;
      }
    }

    const card = document.createElement("article");
    card.className = "product-card glass";
    card.innerHTML = `
      <div class="product-image">${esc(p.icon || getCategoryIcon(p.category))}</div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 6px;">
        <span class="product-category">${esc(p.category || "General")}</span>
        ${statusPill}
      </div>
      <h3>${esc(p.name)}</h3>
      <div class="product-price">₹${Number(p.price).toLocaleString("en-IN")}</div>
      <div class="product-seller">Seller: ${esc(p.sellerName || p.seller || "Student")}</div>
      <div>${p.verified ? '<span class="verified-small">✓ Verified Seller</span>' : '<span class="verified-small unverified">⚠ Not Verified</span>'}</div>
      <div class="card-actions">
        ${actionButtons}
      </div>`;
    grid.appendChild(card);
  });
}

function filterProducts(){
  const q = (document.getElementById("searchInput")?.value || "").trim().toLowerCase();
  const c = document.getElementById("categoryFilter")?.value || "all";
  displayProducts(products.filter(p =>
    `${p.name} ${p.category} ${p.sellerName || p.seller}`.toLowerCase().includes(q) &&
    (c === "all" || p.category === c)
  ));
}

async function openProductDetails(id, event){
  if(event) event.stopPropagation();

  let p = products.find(x => String(x.id) === String(id));
  if(!p && Array.isArray(myListings)){
    p = myListings.find(x => String(x.id) === String(id));
  }

  const detailsBox = document.getElementById("productDetails");
  if(!detailsBox) return;

  detailsBox.innerHTML = '<div class="admin-loading-spinner">⏳ Loading product details...</div>';
  document.getElementById("productModal")?.classList.remove("hidden");
  syncBodyScrollLock();

  try {
    const resData = await api(`/products/${id}`);
    if(resData && resData.product){
      p = resData.product;
    }
  } catch(err) {
    if(!p){
      detailsBox.innerHTML = `
        <div class="error-box" style="text-align:center; padding:25px;">
          <div style="font-size:35px; margin-bottom:8px;">⚠️</div>
          <h4>Product Unavailable</h4>
          <p>${esc(err.message)}</p>
          <button class="outline-button small-button" onclick="closeProductModal()" style="margin-top:14px;">Close</button>
        </div>`;
      return;
    }
  }

  const status = p.status || "active";
  let statusBadge = "";
  if(status === "active"){
    statusBadge = '<span class="status-pill status-active">Active</span>';
  } else if(status === "sold"){
    statusBadge = '<span class="status-pill status-sold">Sold</span>';
  } else if(status === "archived"){
    statusBadge = '<span class="status-pill status-archived">Archived</span>';
  }

  const isOwner = Boolean(
    sessionUser && (
      Number(sessionUser.id) === Number(p.sellerId || p.seller_id) ||
      sessionUser.role === "admin"
    )
  );

  let actionButtons = "";
  if (isOwner) {
    let statusAction = "";
    if (status === "active") {
      statusAction = `<button class="primary-button seller-action-btn btn-mark-sold" onclick="handleToggleStatus('${esc(p.id)}', 'sold')">✓ Mark as Sold</button>`;
    } else if (status === "sold") {
      statusAction = `<button class="primary-button seller-action-btn btn-mark-active" onclick="handleToggleStatus('${esc(p.id)}', 'active')">↺ Relist as Active</button>`;
    }

    let editAction = "";
    let archiveAction = "";
    if (status !== "archived") {
      editAction = `<button class="outline-button seller-action-btn" onclick="openEditProductModal('${esc(p.id)}')">✏️ Edit Listing</button>`;
      archiveAction = `<button class="outline-button seller-action-btn btn-archive" onclick="openArchiveModal('${esc(p.id)}', '${esc(p.name)}')">📦 Archive Listing</button>`;
    } else {
      archiveAction = `<span style="font-size:12px; color:#94a3b8; padding:8px 0;">This listing has been archived (private).</span>`;
    }

    actionButtons = `
      <div class="seller-modal-actions" style="display:flex; flex-wrap:wrap; gap:8px; margin-top:20px; align-items:center;">
        ${editAction}
        ${statusAction}
        ${archiveAction}
        <button class="outline-button seller-action-btn" onclick="closeProductModal()">Close</button>
      </div>
    `;
  } else {
    if (status === "active") {
      actionButtons = `
        <div class="detail-actions">
          <button class="primary-button" onclick="contactSeller('${esc(p.id)}')">💬 Contact Seller</button>
          <button class="outline-button" onclick="closeProductModal()">Close</button>
        </div>
      `;
    } else {
      actionButtons = `
        <div class="detail-actions">
          <button class="outline-button" disabled style="opacity:0.6; cursor:not-allowed;">Item Sold (Inquiries Closed)</button>
          <button class="outline-button" onclick="closeProductModal()">Close</button>
        </div>
      `;
    }
  }

  detailsBox.innerHTML = `
    <div class="detail-icon">${esc(p.icon || getCategoryIcon(p.category))}</div>
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
      <div class="tag">${esc(p.category || "General").toUpperCase()}</div>
      ${statusBadge}
    </div>
    <h2>${esc(p.name)}</h2>
    <div class="detail-price">₹${Number(p.price).toLocaleString("en-IN")}</div>
    <p class="detail-description">${esc(p.description || "No description provided.")}</p>
    <div class="seller-box">
      <strong>Seller</strong>
      <span>${esc(p.sellerName || p.seller || "Student")}
        ${p.verified ? '<b class="verified-text">✓ Verified Student</b>' : '<b class="warning-text">Not Verified</b>'}
      </span>
    </div>
    ${actionButtons}
  `;
}

function closeProductModal(){
  document.getElementById("productModal")?.classList.add("hidden");
  syncBodyScrollLock();
}

function closeModal(e){
  if(e.target.id === "productModal") closeProductModal();
}

async function contactSeller(id,event){
  if(event) event.stopPropagation();
  let p = products.find(x => String(x.id) === String(id));
  if(!p && Array.isArray(myListings)){
    p = myListings.find(x => String(x.id) === String(id));
  }
  if(!p) return;

  if(!token()){
    showToast("Please login first.");
    showPage("login");
    return;
  }

  if (sessionUser && Number(sessionUser.id) === Number(p.sellerId || p.seller_id)) {
    showToast("You cannot message yourself about your own product.");
    return;
  }

  localStorage.setItem(KEY.currentChat,id);
  currentChatThreadId = null;
  closeProductModal();
  showPage("chat");
  await loadChat();
  showToast(`Chat opened with ${p.sellerName || p.seller || "Seller"}`);
}

const sellForm = document.getElementById("sellForm");
if(sellForm) sellForm.addEventListener("submit", async e => {
  e.preventDefault();

  if(!token()){
    showToast("Please login before listing a product.");
    showPage("login");
    return;
  }

  const name = document.getElementById("productName").value.trim();
  const category = document.getElementById("productCategory").value;
  const rawPrice = document.getElementById("productPrice").value.trim();
  const price = Number(rawPrice);
  const description = document.getElementById("productDescription").value.trim();

  if(!name || !category || !description || rawPrice === "" || !Number.isFinite(price) || price < 0){
    showToast("Please enter valid product details. Price cannot be negative.");
    return;
  }

  try {
    await api("/products", {
      method:"POST",
      body:JSON.stringify({name,category,price,description})
    });

    sellForm.reset();
    document.getElementById("sellMessage").innerHTML =
      '<div class="success-box">✓ Product listed successfully and saved in the marketplace database.</div>';
    showToast("Product listed successfully!");
    await loadProducts();
  } catch(err) {
    showToast(err.message);
    if(err.message && err.message.toLowerCase().includes("verify your email")){
      setTimeout(() => openOtpModal(), 400);
    }
  }
});

function getCategoryIcon(c){
  return {Books:"📚",Electronics:"💻",Furniture:"🪑",Accessories:"🎒"}[c] || "📦";
}

const verificationForm = document.getElementById("verificationForm");
if(verificationForm) verificationForm.addEventListener("submit", async e => {
  e.preventDefault();

  if(!token()){
    showToast("Please login before verification.");
    showPage("login");
    return;
  }

  const name = document.getElementById("verifyName").value.trim();
  const email = document.getElementById("verifyEmail").value.trim();
  const studentId = document.getElementById("studentId").value.trim();
  const department = document.getElementById("department").value;
  const file = document.getElementById("collegeId").files[0];

  if(!name || !email || !studentId || !department || !file){
    showToast("Please complete all verification fields.");
    return;
  }

  const badge = document.getElementById("verificationBadge");
  badge.className = "verification-badge pending";
  badge.textContent = "Verification Pending";
  document.getElementById("verificationResult").innerHTML =
    '<div class="info-box"><h3>🔍 Verification in progress</h3><p>Saving your student verification record...</p></div>';

  try {
    const base64 = await fileToBase64(file);
    const result = await api("/verification", {
      method:"POST",
      body:JSON.stringify({
        name,email,studentId,department,
        fileName:file.name,
        fileType:file.type,
        fileData:base64
      })
    });

    localStorage.setItem(KEY.name,name);
    badge.className = "verification-badge verified-badge";
    badge.textContent = "✓ Verified";

    document.getElementById("verificationResult").innerHTML = `
      <div class="success-box">
        <h3>✓ Verification Successful</h3>
        <p><strong>Name:</strong> ${esc(result.user.name)}<br>
        <strong>Email:</strong> ${esc(result.user.email)}<br>
        <strong>Student ID:</strong> ${esc(result.user.studentId)}<br>
        <strong>Department:</strong> ${esc(result.user.department)}</p>
        <span class="verified-small">✓ Verified Student</span>
      </div>`;
    showToast("🎉 Account verified!");
    updateAuthButton();
  } catch(err) {
    badge.className = "verification-badge pending";
    badge.textContent = "Not Verified";
    document.getElementById("verificationResult").innerHTML =
      `<div class="error-box">⚠ ${esc(err.message)}</div>`;
    showToast(err.message);
    if(err.message && err.message.toLowerCase().includes("verify your email")){
      setTimeout(() => openOtpModal(), 400);
    }
  }
});

function fileToBase64(file){
  return new Promise((resolve,reject)=>{
    if(file.size > 5 * 1024 * 1024){
      reject(new Error("College ID file must be 5 MB or smaller."));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(new Error("Could not read the selected file."));
    reader.readAsDataURL(file);
  });
}

const collegeId = document.getElementById("collegeId");
if(collegeId) collegeId.addEventListener("change", function(){
  document.getElementById("fileName").textContent =
    this.files?.length ? "📎 " + this.files[0].name : "";
});

async function loadVerificationStatus(){
  const b = document.getElementById("verificationBadge");
  if(!b) return;

  if(!token()){
    b.className = "verification-badge pending";
    b.textContent = "Not Verified";
    return;
  }

  try {
    const data = await api("/me");
    b.className = data.user.verified ? "verification-badge verified-badge" : "verification-badge pending";
    b.textContent = data.user.verified ? "✓ Verified" : "Not Verified";

    if(data.user.verified){
      document.getElementById("verifyName").value = data.user.name || "";
      document.getElementById("verifyEmail").value = data.user.email || "";
      document.getElementById("studentId").value = data.user.studentId || "";
      document.getElementById("department").value = data.user.department || "";
    }
  } catch {}
}

const loginForm = document.getElementById("loginForm");
if(loginForm) loginForm.addEventListener("submit", async e => {
  e.preventDefault();

  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  const msg = document.getElementById("loginMessage");

  if(!email || !password){
    msg.innerHTML = '<span class="error-text">Please enter email and password.</span>';
    return;
  }

  try {
    const endpoint = authMode === "login" ? "/auth/login" : "/auth/register";
    const body = authMode === "login"
      ? {email,password}
      : {name:document.getElementById("loginEmail").dataset.name || "Student",email,password};

    const data = await api(endpoint,{method:"POST",body:JSON.stringify(body)});
    localStorage.setItem(KEY.token,data.token);
    localStorage.setItem(KEY.email,data.user.email);
    localStorage.setItem(KEY.name,data.user.name || "Student");

    msg.innerHTML = '<span class="success-text">✓ ' +
      (authMode === "login" ? "Login successful!" : (data.message || "Account created!")) +
      '</span>';
    updateAuthButton();

    if(data.user && !data.user.emailVerified){
      showToast(authMode === "register" ? "Account created! Please verify your email ✉️" : "Welcome back! Please verify your email ✉️");
      setTimeout(()=>{
        showPage("home");
        openOtpModal(data.user.email, data.message);
      }, 500);
    } else {
      showToast("Welcome to CampusMarket! 👋");
      setTimeout(()=>showPage("home"),500);
    }
  } catch(err) {
    msg.innerHTML = `<span class="error-text">⚠ ${esc(err.message)}</span>`;
  }
});

function setAuthMode(mode){
  authMode = mode;
  const title = document.querySelector("#login h1");
  const subtitle = document.querySelector("#login-card-subtitle");
  const switchText = document.getElementById("authSwitchText");
  const switchButton = document.getElementById("authSwitchButton");

  if(mode === "register"){
    if(title) title.textContent = "Create Account";
    if(subtitle) subtitle.textContent = "Register your Campus Market account.";
    if(switchText) switchText.textContent = "Already a student?";
    if(switchButton) switchButton.textContent = "Login";
  } else {
    if(title) title.textContent = "Welcome Back";
    if(subtitle) subtitle.textContent = "Login to your Campus Market account.";
    if(switchText) switchText.textContent = "New student?";
    if(switchButton) switchButton.textContent = "Create account";
  }
}

document.getElementById("authSwitchButton")?.addEventListener("click", ()=>{
  if(authMode === "login"){
    const name = prompt("Enter your full name");
    if(!name || !name.trim()) return;
    document.getElementById("loginEmail").dataset.name = name.trim();
    setAuthMode("register");
  } else {
    setAuthMode("login");
  }
});

function handleAuthButton(){
  if(token()){
    localStorage.removeItem(KEY.token);
    localStorage.removeItem(KEY.email);
    localStorage.removeItem(KEY.name);
    sessionUser = null;
    updateAuthButton();
    showToast("Logged out.");
    showPage("home");
  } else {
    showPage("login");
  }
}

async function updateAuthButton(){
  const b = document.getElementById("authButton");
  const vBadge = document.getElementById("emailVerifyBadge");
  const adminBtn = document.getElementById("adminNavBtn");
  const myListingsBtn = document.getElementById("myListingsNavBtn");
  const banner = document.getElementById("accountStatusBanner");
  const icon = document.getElementById("accountStatusIcon");
  const title = document.getElementById("accountStatusTitle");
  const msg = document.getElementById("accountStatusMessage");
  const profileBadge = document.getElementById("userProfileBadge");

  if(b) b.textContent = token() ? "Logout" : "Login";

  if(!token()){
    sessionUser = null;
    if(profileBadge) {
      profileBadge.classList.add("hidden");
      profileBadge.textContent = "";
    }
    if(vBadge) vBadge.classList.add("hidden");
    if(adminBtn) adminBtn.classList.add("hidden");
    if(myListingsBtn) myListingsBtn.classList.add("hidden");
    if(banner) banner.classList.add("hidden");
    if(products && products.length > 0) filterProducts();
    return;
  }

  try {
    const data = await api("/me");
    if(data.user){
      sessionUser = data.user;
      if(myListingsBtn) myListingsBtn.classList.remove("hidden");

      if(profileBadge){
        const roleIcon = data.user.role === "admin" ? "🛡️" : "👤";
        const displayName = data.user.name || (data.user.email ? data.user.email.split("@")[0] : "Account");
        profileBadge.textContent = `${roleIcon} ${displayName}`;
        profileBadge.classList.remove("hidden");
      }

      // 1. Role-based Admin navigation
      if(data.user.role === "admin"){
        if(adminBtn) adminBtn.classList.remove("hidden");
        if(banner) banner.classList.add("hidden");
      } else {
        if(adminBtn) adminBtn.classList.add("hidden");

        // 2. Student registration status banner
        if(banner && icon && title && msg){
          if(data.user.registrationStatus === "pending"){
            banner.className = "account-status-banner pending";
            icon.textContent = "⏳";
            title.textContent = "Registration Pending Administrator Approval";
            msg.textContent = "Your account is currently awaiting admin authorization. Marketplace selling and chat are disabled until approved.";
            banner.classList.remove("hidden");
          } else if(data.user.registrationStatus === "rejected"){
            banner.className = "account-status-banner rejected";
            icon.textContent = "⛔";
            title.textContent = "Registration Rejected";
            msg.textContent = `Your registration was rejected by an administrator (${data.user.registrationRejectionReason || "Administrative review decision"}). Marketplace selling, student verification, and chat are disabled.`;
            banner.classList.remove("hidden");
          } else {
            banner.classList.add("hidden");
          }
        }
      }

      // 3. Email verification badge
      if(vBadge){
        if(!data.user.emailVerified){
          vBadge.classList.remove("hidden");
        } else {
          vBadge.classList.add("hidden");
        }
      }
    }
    if(products && products.length > 0) filterProducts();
  } catch {
    sessionUser = null;
    if(profileBadge) {
      profileBadge.classList.add("hidden");
      profileBadge.textContent = "";
    }
    if(vBadge) vBadge.classList.add("hidden");
    if(adminBtn) adminBtn.classList.add("hidden");
    if(myListingsBtn) myListingsBtn.classList.add("hidden");
    if(banner) banner.classList.add("hidden");
    if(products && products.length > 0) filterProducts();
  }
}

let currentOtpEmail = "";
let otpCooldownTimer = null;

function openOtpModal(email, customMsg){
  currentOtpEmail = email || localStorage.getItem(KEY.email) || "";
  const modal = document.getElementById("otpModal");
  const subtitle = document.getElementById("otpModalSubtitle");
  const msg = document.getElementById("otpMessage");
  const input = document.getElementById("otpCodeInput");

  if(subtitle){
    subtitle.textContent = currentOtpEmail
      ? `Enter the 6-digit code sent to ${currentOtpEmail}`
      : "Enter the 6-digit code sent to your email";
  }
  if(msg){
    msg.innerHTML = customMsg
      ? `<span class="success-text">${esc(customMsg)}</span>`
      : "";
  }
  if(input){
    input.value = "";
  }
  if(modal){
    modal.classList.remove("hidden");
    syncBodyScrollLock();
    setTimeout(() => input?.focus(), 100);
  }
}

function closeOtpModal(e){
  if(e && e.target && e.target.id !== "otpModal" && !e.target.classList.contains("modal-close")){
    return;
  }
  const modal = document.getElementById("otpModal");
  if(modal) modal.classList.add("hidden");
  syncBodyScrollLock();
}

async function handleVerifyOtp(e){
  if(e) e.preventDefault();
  const input = document.getElementById("otpCodeInput");
  const msg = document.getElementById("otpMessage");
  const btn = document.getElementById("verifyOtpBtn");
  const otp = input?.value.trim() || "";
  const email = currentOtpEmail || localStorage.getItem(KEY.email) || "";

  if(!otp || otp.length !== 6){
    if(msg) msg.innerHTML = '<span class="error-text">Please enter a valid 6-digit code.</span>';
    return;
  }

  if(btn) btn.disabled = true;
  if(msg) msg.innerHTML = '<span>Verifying code...</span>';

  try {
    const res = await api("/auth/verify-otp", {
      method: "POST",
      body: JSON.stringify({ email, otp })
    });

    if(msg) msg.innerHTML = '<span class="success-text">✓ Email verified successfully!</span>';
    showToast("Email verified successfully! 🎉");
    updateAuthButton();
    loadVerificationStatus();

    setTimeout(() => {
      closeOtpModal();
    }, 1200);
  } catch(err) {
    if(msg) msg.innerHTML = `<span class="error-text">⚠ ${esc(err.message)}</span>`;
  } finally {
    if(btn) btn.disabled = false;
  }
}

async function handleResendOtp(){
  const email = currentOtpEmail || localStorage.getItem(KEY.email) || "";
  const msg = document.getElementById("otpMessage");
  const btn = document.getElementById("resendOtpBtn");
  const cooldownText = document.getElementById("otpCooldownText");

  if(!email){
    showToast("Email address required to resend code.");
    return;
  }

  if(btn) btn.disabled = true;
  if(msg) msg.innerHTML = '<span>Sending new verification code...</span>';

  try {
    const res = await api("/auth/resend-otp", {
      method: "POST",
      body: JSON.stringify({ email })
    });

    if(msg) msg.innerHTML = `<span class="success-text">✓ ${esc(res.message || "Code sent!")}</span>`;
    showToast("Verification code resent! ✉️");

    let seconds = 60;
    if(btn) btn.disabled = true;
    if(cooldownText) cooldownText.textContent = `Resend in ${seconds}s`;

    if(otpCooldownTimer) clearInterval(otpCooldownTimer);
    otpCooldownTimer = setInterval(() => {
      seconds--;
      if(seconds <= 0){
        clearInterval(otpCooldownTimer);
        if(btn) btn.disabled = false;
        if(cooldownText) cooldownText.textContent = "Didn't receive code?";
      } else {
        if(cooldownText) cooldownText.textContent = `Resend in ${seconds}s`;
      }
    }, 1000);
  } catch(err) {
    if(msg) msg.innerHTML = `<span class="error-text">⚠ ${esc(err.message)}</span>`;
    if(btn) btn.disabled = false;
  }
}

let currentChatThreadId = null;

function getCurrentProduct(){
  const id = localStorage.getItem(KEY.currentChat);
  return products.find(x => String(x.id) === String(id));
}

function handleChatError(err){
  const box = document.getElementById("chatMessages");
  const input = document.getElementById("chatInput");
  const send = document.querySelector(".chat-input button");
  const threadBar = document.getElementById("chatThreadSelector");
  const msg = err.message || "Failed to load chat.";

  if (threadBar) threadBar.classList.add("hidden");
  if (input) input.disabled = true;
  if (send) send.disabled = true;

  if (msg.toLowerCase().includes("verify your email")) {
    if (box) {
      box.innerHTML = `
        <div class="empty-chat">
          ⚠️<br>
          <span style="color:#fbbf24; font-weight:600;">Email Verification Required</span><br>
          <span style="font-size:12px; color:#aaa;">Please verify your campus email address before chatting.</span><br><br>
          <button class="primary-button small-button" onclick="openOtpModal()" style="margin: 0 auto; display: inline-block;">Verify Email Now</button>
        </div>`;
    }
  } else if (msg.toLowerCase().includes("pending admin approval") || msg.toLowerCase().includes("under review")) {
    if (box) {
      box.innerHTML = `
        <div class="empty-chat">
          ⏳<br>
          <span style="color:#60a5fa; font-weight:600;">Registration Under Review</span><br>
          <span style="font-size:12px; color:#aaa;">Chat is disabled until an administrator approves your account.</span>
        </div>`;
    }
  } else if (msg.toLowerCase().includes("rejected")) {
    if (box) {
      box.innerHTML = `
        <div class="empty-chat">
          🚫<br>
          <span style="color:#f87171; font-weight:600;">Account Registration Rejected</span><br>
          <span style="font-size:12px; color:#aaa;">Access to marketplace chat has been disabled.</span>
        </div>`;
    }
  } else {
    if (box) {
      box.innerHTML = `<div class="empty-chat">⚠️<br><span>${esc(msg)}</span></div>`;
    }
  }
  showToast(msg);
}

async function loadChat(){
  const id = localStorage.getItem(KEY.currentChat);
  const p = getCurrentProduct();
  const box = document.getElementById("chatMessages");
  const input = document.getElementById("chatInput");
  const send = document.querySelector(".chat-input button");
  const title = document.querySelector(".chat-header h2");
  const sub = document.querySelector(".chat-header p");
  const threadBar = document.getElementById("chatThreadSelector");
  if(!box) return;

  if(!token()){
    title.textContent = "💬 Student Chat";
    sub.textContent = "Login to chat with marketplace users";
    box.innerHTML = '<div class="empty-chat">🔐<br><span>Please login first, then contact a seller.</span></div>';
    if(threadBar) threadBar.classList.add("hidden");
    if(input) input.disabled = true;
    if(send) send.disabled = true;
    return;
  }

  // If no product is selected, try loading user's active threads
  if(!id){
    try {
      const data = await api("/chats/threads");
      const threads = data.threads || [];
      if(threads.length > 0){
        const first = threads[0];
        localStorage.setItem(KEY.currentChat, String(first.productId));
        currentChatThreadId = first.id;
        return loadChat();
      } else {
        title.textContent = "💬 Student Chat";
        sub.textContent = "Select “Contact Seller” from a product.";
        box.innerHTML = '<div class="empty-chat">💬<br><span>Open a product and contact its seller to start a conversation.</span></div>';
        if(threadBar) threadBar.classList.add("hidden");
        if(input) input.disabled = true;
        if(send) send.disabled = true;
        return;
      }
    } catch(err) {
      handleChatError(err);
      return;
    }
  }

  try {
    let endpoint = `/chats/${encodeURIComponent(id)}`;
    if(currentChatThreadId){
      endpoint += `?threadId=${encodeURIComponent(currentChatThreadId)}`;
    }
    const data = await api(endpoint);

    currentChatThreadId = data.threadId || currentChatThreadId;

    if(p){
      title.textContent = data.isSeller ? `💬 Inquiries: ${p.name}` : `💬 ${p.sellerName || p.seller}`;
      sub.textContent = `${p.name} • ₹${Number(p.price).toLocaleString("en-IN")}`;
    } else {
      title.textContent = "💬 Marketplace Chat";
      sub.textContent = "Active conversation";
    }

    if(input) input.disabled = false;
    if(send) send.disabled = false;

    if(threadBar){
      if(data.isSeller && data.threads && data.threads.length > 0){
        threadBar.classList.remove("hidden");
        threadBar.innerHTML = "";
        data.threads.forEach(t => {
          const pill = document.createElement("button");
          pill.className = "chat-thread-pill" + (t.id === currentChatThreadId ? " active" : "");
          pill.textContent = `👤 ${t.buyerName || "Buyer"}`;
          pill.onclick = () => {
            currentChatThreadId = t.id;
            loadChat();
          };
          threadBar.appendChild(pill);
        });
      } else {
        threadBar.classList.add("hidden");
      }
    }

    box.innerHTML = "";
    const msgs = data.messages || [];
    msgs.forEach(m => {
      const d = document.createElement("div");
      d.className = "chat-message " + (m.isSelf ? "sent" : "received");
      d.textContent = m.text || m.message;
      box.appendChild(d);
    });

    if(!msgs.length){
      box.innerHTML = `<div class="empty-chat">💬<br><span>${data.isSeller ? "No buyer messages yet for this item." : "Start the conversation."}</span></div>`;
    }
    box.scrollTop = box.scrollHeight;
  } catch(err) {
    handleChatError(err);
  }
}

async function sendMessage(){
  const input = document.getElementById("chatInput");
  const id = localStorage.getItem(KEY.currentChat);
  const text = input ? input.value.trim() : "";
  if(!text || !token()) return;

  try {
    if(currentChatThreadId){
      await api(`/chats/thread/${encodeURIComponent(currentChatThreadId)}`, {
        method:"POST",
        body:JSON.stringify({text})
      });
    } else if(id){
      const res = await api(`/chats/${encodeURIComponent(id)}`, {
        method:"POST",
        body:JSON.stringify({text})
      });
      if(res && res.message && res.message.threadId){
        currentChatThreadId = res.message.threadId;
      }
    } else {
      showToast("Please open a product to send a message.");
      return;
    }
    if(input) input.value = "";
    await loadChat();
  } catch(err) {
    showToast(err.message);
    if(err.message && err.message.toLowerCase().includes("verify your email")){
      setTimeout(() => openOtpModal(), 400);
    }
  }
}

function handleChat(e){
  if(e.key === "Enter"){
    e.preventDefault();
    sendMessage();
  }
}

async function boot(){
  const yr = document.getElementById("footerYear");
  if (yr) yr.textContent = new Date().getFullYear();

  await updateAuthButton();

  const status = document.getElementById("serverStatus");
  try {
    await api("/health");
    status.classList.add("online");
    status.innerHTML = '<span class="status-dot-small"></span> CampusMarket server online';
  } catch {
    status.innerHTML = '<span class="status-dot-small"></span> Server offline — run start.bat';
  }

  // Restore page from initial hash or default to home
  const initialHash = (window.location.hash || "").replace(/^#/, "");
  if (initialHash && VALID_PAGES.has(initialHash)) {
    showPage(initialHash, false);
  } else {
    showPage("home", false);
  }

  await loadProducts();
  await loadVerificationStatus();
  await loadChat();
}

function showToast(message){
  const t = document.getElementById("toast");
  if(!t) return;
  clearTimeout(toastTimer);
  t.textContent = message;
  t.classList.add("show");
  toastTimer = setTimeout(()=>t.classList.remove("show"),2400);
}

function esc(v){
  return String(v ?? "")
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#039;");
}

document.addEventListener("DOMContentLoaded", boot);

/* =========================================================
   ADMIN REGISTRATION APPROVAL & DASHBOARD
========================================================= */

let currentAdminTab = "pending";
let currentAdminPage = 1;
let currentAdminTotalPages = 1;
let pendingRejectUserId = null;

function setAdminTab(status, btn) {
  currentAdminTab = status;
  currentAdminPage = 1;
  document.querySelectorAll(".admin-tab").forEach(t => t.classList.remove("active"));
  if (btn) btn.classList.add("active");
  loadAdminRegistrations();
}

async function loadAdminRegistrations() {
  const container = document.getElementById("adminRegistrationsList");
  const pendingCountBadge = document.getElementById("adminPendingCount");
  const pagination = document.getElementById("adminPagination");
  if (!container) return;

  container.innerHTML = '<div class="admin-loading-spinner">⏳ Loading registrations...</div>';

  try {
    const data = await api(`/admin/registrations?status=${encodeURIComponent(currentAdminTab)}&page=${currentAdminPage}&limit=10`);
    const list = data.registrations || [];
    const pag = data.pagination || { page: 1, totalPages: 1, total: 0 };
    currentAdminPage = pag.page;
    currentAdminTotalPages = pag.totalPages;

    if (currentAdminTab === "pending" && pendingCountBadge) {
      pendingCountBadge.textContent = `Pending: ${pag.total}`;
    }

    if (!list.length) {
      container.innerHTML = `
        <div class="empty-state glass">
          <div>📋</div>
          <h3>No ${esc(currentAdminTab)} registrations</h3>
          <p>No student accounts currently match this filter.</p>
        </div>`;
      if (pagination) pagination.classList.add("hidden");
      return;
    }

    container.innerHTML = "";
    list.forEach(r => {
      const card = document.createElement("div");
      card.className = "admin-reg-card glass";

      const createdDate = r.createdAt ? new Date(r.createdAt).toLocaleString() : "Unknown";
      const statusClass = `status-${r.registrationStatus}`;
      const emailStatusBadge = r.emailVerified
        ? '<span class="status-badge badge-subtle" style="color:#4ade80;">✓ Email Verified</span>'
        : '<span class="status-badge badge-subtle" style="color:#fbbf24;">⚠️ Email Unverified</span>';
      const idStatusBadge = r.studentVerificationStatus === "verified"
        ? '<span class="status-badge badge-subtle" style="color:#60a5fa;">🎓 ID Verified</span>'
        : '<span class="status-badge badge-subtle">ID Unverified</span>';

      let reviewerInfo = "";
      if (r.registrationReviewedAt) {
        const revDate = new Date(r.registrationReviewedAt).toLocaleDateString();
        reviewerInfo = `<span>Reviewed by: <b>${esc(r.reviewerName || "Admin")}</b> on ${revDate}</span>`;
      }
      if (r.registrationRejectionReason) {
        reviewerInfo += `<span style="color:#f87171;">Reason: <i>${esc(r.registrationRejectionReason)}</i></span>`;
      }

      let actionButtons = "";
      if (r.registrationStatus === "pending") {
        actionButtons = `
          <button class="btn-approve" onclick="handleApproveRegistration(${r.id}, '${esc(r.name)}')">✓ Approve</button>
          <button class="btn-reject" onclick="openAdminRejectModal(${r.id}, '${esc(r.name)}')">✕ Reject</button>
        `;
      } else if (r.registrationStatus === "approved") {
        actionButtons = `
          <button class="btn-reject" onclick="openAdminRejectModal(${r.id}, '${esc(r.name)}')">✕ Reject</button>
        `;
      } else if (r.registrationStatus === "rejected") {
        actionButtons = `
          <button class="btn-re-review" onclick="handleReReviewRegistration(${r.id}, '${esc(r.name)}')">↺ Return to Review</button>
        `;
      }

      card.innerHTML = `
        <div class="admin-reg-info">
          <div class="admin-reg-header">
            <span class="admin-reg-name">${esc(r.name)}</span>
            <span class="status-badge ${statusClass}">● ${esc(r.registrationStatus)}</span>
          </div>
          <div class="admin-reg-email">✉ ${esc(r.email)}</div>
          <div class="admin-reg-badges">
            ${emailStatusBadge}
            ${idStatusBadge}
          </div>
          <div class="admin-reg-meta" style="margin-top: 10px;">
            <span>Registered: ${createdDate}</span>
            ${reviewerInfo}
          </div>
        </div>
        <div class="admin-reg-actions">
          ${actionButtons}
        </div>
      `;

      container.appendChild(card);
    });

    if (pagination) {
      if (currentAdminTotalPages > 1) {
        pagination.classList.remove("hidden");
        const pageInfo = document.getElementById("adminPageInfo");
        const prevBtn = document.getElementById("adminPrevPageBtn");
        const nextBtn = document.getElementById("adminNextPageBtn");

        if (pageInfo) pageInfo.textContent = `Page ${currentAdminPage} of ${currentAdminTotalPages} (${pag.total} total)`;
        if (prevBtn) prevBtn.disabled = currentAdminPage <= 1;
        if (nextBtn) nextBtn.disabled = currentAdminPage >= currentAdminTotalPages;
      } else {
        pagination.classList.add("hidden");
      }
    }
  } catch (err) {
    container.innerHTML = `
      <div class="error-box">
        <h4>Error loading registrations</h4>
        <p>${esc(err.message)}</p>
      </div>`;
    showToast(err.message);
  }
}

function changeAdminPage(delta) {
  const target = currentAdminPage + delta;
  if (target >= 1 && target <= currentAdminTotalPages) {
    currentAdminPage = target;
    loadAdminRegistrations();
  }
}

async function handleApproveRegistration(id, name) {
  try {
    await api(`/admin/registrations/${id}/approve`, { method: "POST" });
    showToast(`Approved registration for ${name}! ✓`);
    loadAdminRegistrations();
  } catch (err) {
    showToast(`Approval failed: ${err.message}`);
  }
}

function openAdminRejectModal(id, name) {
  pendingRejectUserId = id;
  const prompt = document.getElementById("adminRejectPrompt");
  const input = document.getElementById("adminRejectReasonInput");
  const modal = document.getElementById("adminRejectModal");

  if (prompt) prompt.textContent = `Are you sure you want to reject ${name}'s registration? Marketplace access and chat will be disabled, and any active sessions will be terminated.`;
  if (input) input.value = "";
  if (modal) {
    modal.classList.remove("hidden");
    syncBodyScrollLock();
  }
}

function closeAdminRejectModal(e) {
  if (e && e.target && e.target.id !== "adminRejectModal" && !e.target.classList.contains("modal-close") && e.target.tagName !== "BUTTON") {
    return;
  }
  const modal = document.getElementById("adminRejectModal");
  if (modal) modal.classList.add("hidden");
  pendingRejectUserId = null;
  syncBodyScrollLock();
}

async function submitRejectRegistration() {
  if (!pendingRejectUserId) return;
  const input = document.getElementById("adminRejectReasonInput");
  const reason = input ? input.value.trim() : "";

  try {
    await api(`/admin/registrations/${pendingRejectUserId}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason })
    });
    showToast("Registration rejected.");
    closeAdminRejectModal();
    loadAdminRegistrations();
  } catch (err) {
    showToast(`Rejection failed: ${err.message}`);
  }
}

async function handleReReviewRegistration(id, name) {
  try {
    await api(`/admin/registrations/${id}/re-review`, { method: "POST" });
    showToast(`Moved ${name} back to pending for re-review.`);
    loadAdminRegistrations();
  } catch (err) {
    showToast(`Action failed: ${err.message}`);
  }
}

/* =========================================================
   PHASE 7A-2: SELLER LISTING MANAGEMENT & LIFECYCLE
========================================================= */

function setMyListingsTab(status, btn) {
  currentMyListingsTab = status;
  document.querySelectorAll(".my-listings-tab").forEach(t => t.classList.remove("active"));
  if (btn) btn.classList.add("active");
  loadMyListings();
}

async function ensureSessionUser() {
  if (sessionUser && sessionUser.id) return sessionUser;
  if (!token()) return null;
  try {
    const data = await api("/me");
    if (data && data.user) {
      sessionUser = data.user;
      return sessionUser;
    }
  } catch {}
  return null;
}

async function loadMyListings() {
  const container = document.getElementById("myListingsContainer");
  if (!container) return;

  if (!token()) {
    container.innerHTML = `
      <div class="empty-state glass" style="grid-column: 1/-1;">
        <div>🔐</div>
        <h3>Login Required</h3>
        <p>Please log in to manage your campus marketplace listings.</p>
        <button class="primary-button small-button" onclick="showPage('login')" style="margin-top:14px;">Go to Login</button>
      </div>`;
    return;
  }

  container.innerHTML = '<div class="admin-loading-spinner" style="grid-column: 1/-1;">⏳ Loading your listings...</div>';

  const user = await ensureSessionUser();
  if (!user || !user.id) {
    container.innerHTML = `
      <div class="empty-state glass" style="grid-column: 1/-1;">
        <div>⚠️</div>
        <h3>Session Expired</h3>
        <p>Could not verify your student identity. Please sign in again.</p>
        <button class="primary-button small-button" onclick="showPage('login')" style="margin-top:14px;">Sign In</button>
      </div>`;
    return;
  }

  try {
    const data = await api(`/products?sellerId=${user.id}&status=${encodeURIComponent(currentMyListingsTab)}`);
    myListings = data.products || [];
    renderMyListings(myListings);
  } catch (err) {
    container.innerHTML = `
      <div class="empty-state glass" style="grid-column: 1/-1;">
        <div>⚠️</div>
        <h3>Failed to Load Listings</h3>
        <p>${esc(err.message)}</p>
        <button class="outline-button small-button" onclick="loadMyListings()" style="margin-top:14px;">🔄 Retry</button>
      </div>`;
    showToast(err.message);
  }
}

function renderMyListings(list) {
  const container = document.getElementById("myListingsContainer");
  if (!container) return;
  container.innerHTML = "";

  if (!list || list.length === 0) {
    let emptyMsg = "No listings found in this filter.";
    if (currentMyListingsTab === "all") {
      emptyMsg = "You haven't listed any products yet. Put your unused items to good use!";
    } else if (currentMyListingsTab === "active") {
      emptyMsg = "You have no active listings right now.";
    } else if (currentMyListingsTab === "sold") {
      emptyMsg = "You have no sold listings yet.";
    } else if (currentMyListingsTab === "archived") {
      emptyMsg = "You have no archived listings.";
    }

    container.innerHTML = `
      <div class="empty-state glass" style="grid-column: 1/-1;">
        <div>📦</div>
        <h3>No ${esc(currentMyListingsTab === "all" ? "" : currentMyListingsTab)} Listings</h3>
        <p>${esc(emptyMsg)}</p>
        <button class="primary-button small-button" onclick="showPage('sell')" style="margin-top:14px;">+ List a Product</button>
      </div>`;
    return;
  }

  list.forEach(p => {
    const status = p.status || "active";
    let statusBadge = "";
    if (status === "active") {
      statusBadge = '<span class="status-pill status-active">Active</span>';
    } else if (status === "sold") {
      statusBadge = '<span class="status-pill status-sold">Sold</span>';
    } else if (status === "archived") {
      statusBadge = '<span class="status-pill status-archived">Archived</span>';
    }

    let actions = "";
    if (status === "active") {
      actions = `
        <div class="card-actions" style="grid-template-columns: 1fr 1fr; gap: 8px;">
          <button class="outline-button small-button" onclick="openProductDetails('${esc(p.id)}', event)">Details</button>
          <button class="outline-button small-button" onclick="openEditProductModal('${esc(p.id)}')">✏️ Edit</button>
          <button class="seller-action-btn btn-mark-sold" onclick="handleToggleStatus('${esc(p.id)}', 'sold')">✓ Mark Sold</button>
          <button class="seller-action-btn btn-archive" onclick="openArchiveModal('${esc(p.id)}', '${esc(p.name)}')">📦 Archive</button>
        </div>
      `;
    } else if (status === "sold") {
      actions = `
        <div class="card-actions" style="grid-template-columns: 1fr 1fr; gap: 8px;">
          <button class="outline-button small-button" onclick="openProductDetails('${esc(p.id)}', event)">Details</button>
          <button class="outline-button small-button" onclick="openEditProductModal('${esc(p.id)}')">✏️ Edit</button>
          <button class="seller-action-btn btn-mark-active" onclick="handleToggleStatus('${esc(p.id)}', 'active')">↺ Relist</button>
          <button class="seller-action-btn btn-archive" onclick="openArchiveModal('${esc(p.id)}', '${esc(p.name)}')">📦 Archive</button>
        </div>
      `;
    } else {
      actions = `
        <div class="card-actions" style="grid-template-columns: 1fr; gap: 8px;">
          <button class="outline-button small-button" onclick="openProductDetails('${esc(p.id)}', event)">View Details</button>
        </div>
      `;
    }

    const card = document.createElement("article");
    card.className = "product-card glass";
    card.innerHTML = `
      <div class="product-image">${esc(p.icon || getCategoryIcon(p.category))}</div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 6px;">
        <span class="product-category">${esc(p.category || "General")}</span>
        ${statusBadge}
      </div>
      <h3>${esc(p.name)}</h3>
      <div class="product-price">₹${Number(p.price).toLocaleString("en-IN")}</div>
      <p class="detail-description" style="font-size:12px; margin-bottom:10px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">
        ${esc(p.description || "No description provided.")}
      </p>
      ${actions}
    `;
    container.appendChild(card);
  });
}

async function openEditProductModal(id) {
  let p = myListings.find(x => String(x.id) === String(id));
  if (!p) {
    p = products.find(x => String(x.id) === String(id));
  }

  try {
    const resData = await api(`/products/${id}`);
    if (resData && resData.product) p = resData.product;
  } catch (err) {
    showToast(err.message);
    return;
  }

  if (!p) {
    showToast("Product not found.");
    return;
  }

  if (p.status === "archived") {
    showToast("Archived listings cannot be edited.");
    return;
  }

  document.getElementById("editProductId").value = p.id;
  document.getElementById("editProductName").value = p.name || "";
  document.getElementById("editProductCategory").value = p.category || "Books";
  document.getElementById("editProductPrice").value = (p.price !== undefined && p.price !== null) ? p.price : 0;
  document.getElementById("editProductDescription").value = p.description || "";
  document.getElementById("editProductMessage").innerHTML = "";

  const modal = document.getElementById("editProductModal");
  if (modal) {
    modal.classList.remove("hidden");
    syncBodyScrollLock();
  }
}

function closeEditProductModal(e) {
  if (e && e.target && e.target.id !== "editProductModal" && !e.target.classList.contains("modal-close") && e.target.tagName !== "BUTTON") {
    return;
  }
  const modal = document.getElementById("editProductModal");
  if (modal) modal.classList.add("hidden");
  syncBodyScrollLock();
}

async function handleSaveProductEdit(e) {
  e.preventDefault();

  const id = document.getElementById("editProductId").value;
  const name = document.getElementById("editProductName").value.trim();
  const category = document.getElementById("editProductCategory").value;
  const rawPrice = document.getElementById("editProductPrice").value.trim();
  const price = Number(rawPrice);
  const description = document.getElementById("editProductDescription").value.trim();
  const msg = document.getElementById("editProductMessage");
  const btn = document.getElementById("saveEditProductBtn");

  if (!name || !category || !description || rawPrice === "" || !Number.isFinite(price) || price < 0) {
    if (msg) msg.innerHTML = '<span class="error-text">Please provide valid product details. Price cannot be negative.</span>';
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = "Saving...";
  }

  try {
    await api(`/products/${id}`, {
      method: "PUT",
      body: JSON.stringify({ name, category, price, description })
    });

    showToast("Listing updated successfully! ✓");
    closeEditProductModal();
    await loadProducts();
    await loadMyListings();

    const detailsModal = document.getElementById("productModal");
    if (detailsModal && !detailsModal.classList.contains("hidden")) {
      openProductDetails(id);
    }
  } catch (err) {
    if (msg) msg.innerHTML = `<span class="error-text">⚠ ${esc(err.message)}</span>`;
    showToast(err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Save Changes";
    }
  }
}

function openArchiveModal(id, name) {
  pendingArchiveProductId = id;
  const prompt = document.getElementById("archiveConfirmPrompt");
  if (prompt) {
    prompt.textContent = `Are you sure you want to archive "${name || "this listing"}"? It will be removed from the public marketplace, but your conversation history will be preserved.`;
  }
  const modal = document.getElementById("archiveConfirmModal");
  if (modal) {
    modal.classList.remove("hidden");
    syncBodyScrollLock();
  }
}

function closeArchiveModal(e) {
  if (e && e.target && e.target.id !== "archiveConfirmModal" && !e.target.classList.contains("modal-close") && e.target.tagName !== "BUTTON") {
    return;
  }
  const modal = document.getElementById("archiveConfirmModal");
  if (modal) modal.classList.add("hidden");
  pendingArchiveProductId = null;
  syncBodyScrollLock();
}

async function submitArchiveProduct() {
  if (!pendingArchiveProductId) return;

  const btn = document.getElementById("confirmArchiveBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Archiving...";
  }

  const id = pendingArchiveProductId;

  try {
    await api(`/products/${id}`, { method: "DELETE" });
    showToast("Listing archived successfully. 📦");
    closeArchiveModal();
    closeProductModal();
    await loadProducts();
    await loadMyListings();
  } catch (err) {
    showToast(`Archival failed: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Archive Listing";
    }
  }
}

async function handleToggleStatus(id, newStatus) {
  try {
    await api(`/products/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: newStatus })
    });
    showToast(`Listing marked as ${newStatus}! ✓`);
    await loadProducts();
    await loadMyListings();

    const detailsModal = document.getElementById("productModal");
    if (detailsModal && !detailsModal.classList.contains("hidden")) {
      openProductDetails(id);
    }
  } catch (err) {
    showToast(`Status update failed: ${err.message}`);
  }
}
