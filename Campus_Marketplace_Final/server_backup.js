const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const url = require("url");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const DB_FILE = path.join(DATA_DIR, "db.json");
const PUBLIC_DIR = path.join(ROOT, "public");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const DEFAULT_PRODUCTS = [
  {id:"p1",name:"Engineering Mathematics Book",category:"Books",price:350,icon:"📚",description:"Engineering mathematics book in good condition.",sellerName:"Rahul",sellerEmail:"rahul@campus.local",verified:true},
  {id:"p2",name:"Programming in C Book",category:"Books",price:400,icon:"📘",description:"Useful C programming reference book for college students.",sellerName:"Aman",sellerEmail:"aman@campus.local",verified:true},
  {id:"p3",name:"Scientific Calculator",category:"Electronics",price:650,icon:"🧮",description:"Scientific calculator suitable for engineering classes.",sellerName:"Rohit",sellerEmail:"rohit@campus.local",verified:true},
  {id:"p4",name:"Wireless Earphones",category:"Electronics",price:800,icon:"🎧",description:"Wireless earphones in like-new condition.",sellerName:"Priya",sellerEmail:"priya@campus.local",verified:true},
  {id:"p5",name:"Study Table",category:"Furniture",price:1200,icon:"🪑",description:"Compact study table suitable for hostel use.",sellerName:"Karan",sellerEmail:"karan@campus.local",verified:true},
  {id:"p6",name:"College Backpack",category:"Accessories",price:500,icon:"🎒",description:"Durable backpack with multiple compartments.",sellerName:"Sneha",sellerEmail:"sneha@campus.local",verified:true}
];

function initialDB(){
  return {
    users: [
      {id:"u_demo",name:"Demo Student",email:"student@campus.local",passwordHash:hashPassword("student123"),verified:true,studentId:"CM001",department:"Computer Science",collegeIdFile:null}
    ],
    products: DEFAULT_PRODUCTS,
    sessions: {},
    messages: {}
  };
}

function readDB(){
  try {
    if(!fs.existsSync(DB_FILE)){
      const db = initialDB();
      writeDB(db);
      return db;
    }
    const db = JSON.parse(fs.readFileSync(DB_FILE,"utf8"));
    db.users ||= []; db.products ||= []; db.sessions ||= {}; db.messages ||= {};
    return db;
  } catch {
    return initialDB();
  }
}

function writeDB(db){
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db,null,2), "utf8");
  fs.renameSync(tmp, DB_FILE);
}

function hashPassword(password){
  return crypto.createHash("sha256").update(String(password)).digest("hex");
}

function makeId(prefix){
  return prefix + "_" + crypto.randomBytes(8).toString("hex");
}

function json(res,status,data){
  const body = JSON.stringify(data);
  res.writeHead(status,{
    "Content-Type":"application/json; charset=utf-8",
    "Content-Length":Buffer.byteLength(body),
    "Cache-Control":"no-store"
  });
  res.end(body);
}

function readBody(req){
  return new Promise((resolve,reject)=>{
    let data = "";
    let size = 0;
    req.on("data",chunk=>{
      size += chunk.length;
      if(size > 8 * 1024 * 1024){
        reject(new Error("Request too large"));
        req.destroy();
        return;
      }
      data += chunk.toString();
    });
    req.on("end",()=>{
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error("Invalid JSON request")); }
    });
    req.on("error",reject);
  });
}

function authUser(req,db){
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const userId = db.sessions[token];
  if(!userId) return null;
  return db.users.find(u=>u.id===userId) || null;
}

function publicUser(user){
  return {
    id:user.id,name:user.name,email:user.email,verified:!!user.verified,
    studentId:user.studentId || "",department:user.department || "",
    collegeIdFile:user.collegeIdFile ? user.collegeIdFile.name : null
  };
}

function safeProduct(p){
  return {
    id:p.id,name:p.name,category:p.category,price:p.price,icon:p.icon,
    description:p.description,sellerName:p.sellerName,sellerEmail:p.sellerEmail,
    sellerId:p.sellerId || null,verified:!!p.verified,createdAt:p.createdAt || null
  };
}

async function route(req,res){
  const parsed = url.parse(req.url,true);
  const pathname = parsed.pathname;
  const method = req.method;

  if(method === "OPTIONS"){
    res.writeHead(204,{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type, Authorization"});
    return res.end();
  }

  if(pathname === "/api/health" && method === "GET"){
    return json(res,200,{ok:true,service:"CampusMarket"});
  }

  const db = readDB();

  if(pathname === "/api/auth/register" && method === "POST"){
    const body = await readBody(req);
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if(name.length < 2) return json(res,400,{error:"Enter your full name."});
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res,400,{error:"Enter a valid email."});
    if(password.length < 6) return json(res,400,{error:"Password must be at least 6 characters."});
    if(db.users.some(u=>u.email===email)) return json(res,409,{error:"An account with this email already exists."});

    const user = {id:makeId("u"),name,email,passwordHash:hashPassword(password),verified:false,studentId:"",department:"",collegeIdFile:null};
    db.users.push(user);
    const token = makeId("sess");
    db.sessions[token] = user.id;
    writeDB(db);
    return json(res,201,{token,user:publicUser(user)});
  }

  if(pathname === "/api/auth/login" && method === "POST"){
    const body = await readBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const user = db.users.find(u=>u.email===email && u.passwordHash===hashPassword(password));
    if(!user) return json(res,401,{error:"Invalid email or password."});
    const token = makeId("sess");
    db.sessions[token] = user.id;
    writeDB(db);
    return json(res,200,{token,user:publicUser(user)});
  }

  if(pathname === "/api/me" && method === "GET"){
    const user = authUser(req,db);
    if(!user) return json(res,401,{error:"Please login first."});
    return json(res,200,{user:publicUser(user)});
  }

  if(pathname === "/api/products" && method === "GET"){
    const products = [...db.products].sort((a,b)=>String(b.createdAt||"").localeCompare(String(a.createdAt||"")));
    return json(res,200,{products:products.map(safeProduct)});
  }

  if(pathname === "/api/products" && method === "POST"){
    const user = authUser(req,db);
    if(!user) return json(res,401,{error:"Please login before listing a product."});
    const body = await readBody(req);
    const name = String(body.name || "").trim();
    const category = String(body.category || "").trim();
    const description = String(body.description || "").trim();
    const price = Number(body.price);
    const allowed = ["Books","Electronics","Furniture","Accessories"];
    if(!name || name.length > 100) return json(res,400,{error:"Product name is required (max 100 characters)."});
    if(!allowed.includes(category)) return json(res,400,{error:"Choose a valid category."});
    if(!Number.isFinite(price) || price <= 0 || price > 10000000) return json(res,400,{error:"Enter a valid price."});
    if(!description || description.length > 1000) return json(res,400,{error:"Description is required (max 1000 characters)."});

    const icons = {Books:"📚",Electronics:"💻",Furniture:"🪑",Accessories:"🎒"};
    const product = {
      id:makeId("p"),name,category,price,description,icon:icons[category] || "📦",
      sellerId:user.id,sellerName:user.name,sellerEmail:user.email,verified:!!user.verified,
      createdAt:new Date().toISOString()
    };
    db.products.push(product);
    writeDB(db);
    return json(res,201,{product:safeProduct(product)});
  }

  const productMatch = pathname.match(/^\/api\/products\/([^/]+)$/);
  if(productMatch && method === "GET"){
    const product = db.products.find(p=>p.id===decodeURIComponent(productMatch[1]));
    if(!product) return json(res,404,{error:"Product not found."});
    return json(res,200,{product:safeProduct(product)});
  }

  const verificationMatch = pathname === "/api/verification";
  if(verificationMatch && method === "POST"){
    const user = authUser(req,db);
    if(!user) return json(res,401,{error:"Please login first."});

    const body = await readBody(req);
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const studentId = String(body.studentId || "").trim();
    const department = String(body.department || "").trim();
    const fileName = path.basename(String(body.fileName || ""));
    const fileType = String(body.fileType || "");
    const fileData = String(body.fileData || "");

    if(!name || !email || !studentId || !department || !fileName || !fileData)
      return json(res,400,{error:"Complete all verification fields."});
    if(fileData.length > 7 * 1024 * 1024)
      return json(res,400,{error:"College ID file is too large."});

    const ext = path.extname(fileName).toLowerCase().replace(/[^a-z0-9.]/g,"");
    const storedName = user.id + "_" + Date.now() + (ext || ".bin");
    try {
      fs.writeFileSync(path.join(UPLOAD_DIR,storedName),Buffer.from(fileData,"base64"));
    } catch {
      return json(res,500,{error:"Could not save the college ID file."});
    }

    user.name = name;
    user.email = email;
    user.studentId = studentId;
    user.department = department;
    user.verified = true;
    user.collegeIdFile = {name:fileName,type:fileType,storedName,uploadedAt:new Date().toISOString()};

    db.products.forEach(p=>{
      if(p.sellerId === user.id) p.sellerName = user.name;
      if(p.sellerId === user.id) p.verified = true;
    });

    writeDB(db);
    return json(res,200,{message:"Verification successful.",user:publicUser(user)});
  }

  const chatMatch = pathname.match(/^\/api\/chats\/([^/]+)$/);
  if(chatMatch){
    const user = authUser(req,db);
    if(!user) return json(res,401,{error:"Please login first."});
    const productId = decodeURIComponent(chatMatch[1]);
    const product = db.products.find(p=>p.id===productId);
    if(!product) return json(res,404,{error:"Product not found."});

    if(method === "GET"){
      const key = `${user.id}:${productId}`;
      return json(res,200,{messages:db.messages[key] || []});
    }

    if(method === "POST"){
      const body = await readBody(req);
      const text = String(body.text || "").trim();
      if(!text || text.length > 500) return json(res,400,{error:"Message must be 1–500 characters."});

      const key = `${user.id}:${productId}`;
      db.messages[key] ||= [];
      db.messages[key].push({id:makeId("m"),sender:"buyer",text,createdAt:new Date().toISOString()});

      // Demo seller response is persisted server-side so the chat remains functional.
      const replies = [
        "Yes, it is currently available 👍",
        "Sure! We can discuss the details here.",
        "Thanks for your message. I’ll get back to you soon.",
        "Yes, we can arrange a convenient campus meeting point."
      ];
      db.messages[key].push({
        id:makeId("m"),sender:"seller",
        text:replies[db.messages[key].length % replies.length],
        createdAt:new Date().toISOString()
      });

      writeDB(db);
      return json(res,201,{messages:db.messages[key]});
    }
  }

  return serveStatic(req,res,pathname);
}

function serveStatic(req,res,pathname){
  let filePath = path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname);
  if(!filePath.startsWith(PUBLIC_DIR)) return json(res,403,{error:"Forbidden"});
  if(!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()){
    return json(res,404,{error:"Not found"});
  }

  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html":"text/html; charset=utf-8",
    ".css":"text/css; charset=utf-8",
    ".js":"application/javascript; charset=utf-8",
    ".json":"application/json; charset=utf-8",
    ".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",
    ".svg":"image/svg+xml",".ico":"image/x-icon"
  };
  res.writeHead(200,{"Content-Type":types[ext] || "application/octet-stream"});
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req,res)=>{
  route(req,res).catch(err=>{
    console.error(err);
    json(res,500,{error:"Server error. Check the terminal for details."});
  });
});

server.listen(PORT,()=>{
  console.log(`\nCampusMarket running at http://localhost:${PORT}`);
  console.log("Demo login: student@campus.local / student123");
  console.log("Press Ctrl+C to stop the server.\n");
});
