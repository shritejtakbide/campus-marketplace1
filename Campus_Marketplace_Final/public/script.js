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
      updateAuthButton();
    }
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function showPage(name){
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  const page = document.getElementById(name);
  if (!page) return;
  page.classList.add("active");
  window.scrollTo({top:0, behavior:"smooth"});

  if(name === "products") loadProducts();
  if(name === "verification") loadVerificationStatus();
  if(name === "chat") loadChat();
}

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
    const card = document.createElement("article");
    card.className = "product-card glass";
    card.innerHTML = `
      <div class="product-image">${esc(p.icon || "📦")}</div>
      <h3>${esc(p.name)}</h3>
      <p class="product-category">${esc(p.category)}</p>
      <div class="product-price">₹${Number(p.price).toLocaleString("en-IN")}</div>
      <div class="product-seller">Seller: ${esc(p.sellerName || p.seller || "Student")}</div>
      <div>${p.verified ? '<span class="verified-small">✓ Verified Seller</span>' : '<span class="verified-small unverified">⚠ Not Verified</span>'}</div>
      <div class="card-actions">
        <button class="outline-button small-button" onclick="openProductDetails('${esc(p.id)}',event)">View Details</button>
        <button class="primary-button small-button" onclick="contactSeller('${esc(p.id)}',event)">Contact Seller</button>
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

function openProductDetails(id,event){
  if(event) event.stopPropagation();
  const p = products.find(x => x.id === id);
  if(!p) return;

  document.getElementById("productDetails").innerHTML = `
    <div class="detail-icon">${esc(p.icon || "📦")}</div>
    <div class="tag">${esc(p.category).toUpperCase()}</div>
    <h2>${esc(p.name)}</h2>
    <div class="detail-price">₹${Number(p.price).toLocaleString("en-IN")}</div>
    <p class="detail-description">${esc(p.description || "No description provided.")}</p>
    <div class="seller-box">
      <strong>Seller</strong>
      <span>${esc(p.sellerName || p.seller || "Student")}
        ${p.verified ? '<b class="verified-text">✓ Verified Student</b>' : '<b class="warning-text">Not Verified</b>'}
      </span>
    </div>
    <div class="detail-actions">
      <button class="primary-button" onclick="contactSeller('${esc(p.id)}')">💬 Contact Seller</button>
      <button class="outline-button" onclick="closeProductModal()">Close</button>
    </div>`;

  document.getElementById("productModal").classList.remove("hidden");
}

function closeProductModal(){
  document.getElementById("productModal")?.classList.add("hidden");
}

function closeModal(e){
  if(e.target.id === "productModal") closeProductModal();
}

async function contactSeller(id,event){
  if(event) event.stopPropagation();
  const p = products.find(x => x.id === id);
  if(!p) return;

  if(!token()){
    showToast("Please login first.");
    showPage("login");
    return;
  }

  localStorage.setItem(KEY.currentChat,id);
  closeProductModal();
  showPage("chat");
  await loadChat();
  showToast(`Chat opened with ${p.sellerName || p.seller}`);
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
  const price = Number(document.getElementById("productPrice").value);
  const description = document.getElementById("productDescription").value.trim();

  if(!name || !category || !description || !Number.isFinite(price) || price <= 0){
    showToast("Please enter valid product details.");
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
      (authMode === "login" ? "Login successful!" : "Account created and logged in!") +
      '</span>';
    updateAuthButton();
    showToast("Welcome to CampusMarket! 👋");
    setTimeout(()=>showPage("home"),500);
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
    updateAuthButton();
    showToast("Logged out.");
    showPage("home");
  } else {
    showPage("login");
  }
}

function updateAuthButton(){
  const b = document.getElementById("authButton");
  if(b) b.textContent = token() ? "Logout" : "Login";
}

function getCurrentProduct(){
  const id = localStorage.getItem(KEY.currentChat);
  return products.find(x => x.id === id);
}

async function loadChat(){
  const id = localStorage.getItem(KEY.currentChat);
  const p = getCurrentProduct();
  const box = document.getElementById("chatMessages");
  const input = document.getElementById("chatInput");
  const send = document.querySelector(".chat-input button");
  const title = document.querySelector(".chat-header h2");
  const sub = document.querySelector(".chat-header p");
  if(!box) return;

  if(!token()){
    title.textContent = "💬 Student Chat";
    sub.textContent = "Login to chat with marketplace users";
    box.innerHTML = '<div class="empty-chat">🔐<br><span>Please login first, then contact a seller.</span></div>';
    input.disabled = true;
    send.disabled = true;
    return;
  }

  if(!id || !p){
    title.textContent = "💬 Student Chat";
    sub.textContent = "Select “Contact Seller” from a product.";
    box.innerHTML = '<div class="empty-chat">💬<br><span>Open a product and contact its seller to start a conversation.</span></div>';
    input.disabled = true;
    send.disabled = true;
    return;
  }

  title.textContent = `💬 ${p.sellerName || p.seller}`;
  sub.textContent = `${p.name} • ₹${Number(p.price).toLocaleString("en-IN")}`;
  input.disabled = false;
  send.disabled = false;

  try {
    const data = await api(`/chats/${encodeURIComponent(id)}`);
    box.innerHTML = "";
    (data.messages || []).forEach(m=>{
      const d = document.createElement("div");
      d.className = "chat-message " + (m.sender === "buyer" ? "sent" : "received");
      d.textContent = m.text;
      box.appendChild(d);
    });
    if(!data.messages?.length){
      box.innerHTML = '<div class="empty-chat">💬<br><span>Start the conversation.</span></div>';
    }
    box.scrollTop = box.scrollHeight;
  } catch(err) {
    showToast(err.message);
  }
}

async function sendMessage(){
  const input = document.getElementById("chatInput");
  const id = localStorage.getItem(KEY.currentChat);
  const text = input.value.trim();
  if(!id || !text || !token()) return;

  try {
    await api(`/chats/${encodeURIComponent(id)}`,{
      method:"POST",
      body:JSON.stringify({text})
    });
    input.value = "";
    await loadChat();
  } catch(err) {
    showToast(err.message);
  }
}

function handleChat(e){
  if(e.key === "Enter"){
    e.preventDefault();
    sendMessage();
  }
}

async function boot(){
  updateAuthButton();

  const status = document.getElementById("serverStatus");
  try {
    await api("/health");
    status.classList.add("online");
    status.innerHTML = '<span class="status-dot-small"></span> CampusMarket server online';
  } catch {
    status.innerHTML = '<span class="status-dot-small"></span> Server offline — run start.bat';
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
