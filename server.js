const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const { Users, Tweets } = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me-in-production";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";

if (JWT_SECRET === "dev-secret-change-me-in-production") {
  console.warn(
    "[nova] WARNING: JWT_SECRET is not set. Set a real secret in your environment before deploying publicly."
  );
}

app.use(cors());
app.use(express.json({ limit: "6mb" }));

// ---------- avatar uploads ----------
const uploadsDir = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname) || ".jpg"}`),
  }),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) return cb(new Error("الملف يجب أن يكون صورة"));
    cb(null, true);
  },
});

app.use(express.static(path.join(__dirname, "public")));

// ---------- helpers ----------
function publicUser(u) {
  if (!u) return null;
  const { password, ...rest } = u;
  return rest;
}
function signToken(user) {
  return jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: "30d" });
}
function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "غير مسجل الدخول" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = Users.findById(payload.uid);
    if (!user) return res.status(401).json({ error: "الحساب غير موجود" });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "جلسة غير صالحة" });
  }
}
// like auth(), but doesn't fail if there's no token — used for public feed reads
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.user = Users.findById(payload.uid) || null;
    } catch {
      req.user = null;
    }
  }
  next();
}
function usernameFromName(name) {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_\u0600-\u06FF]/g, "");
  return base || "nova_user";
}
function uniqueUsername(base) {
  let candidate = base;
  let i = 1;
  while (Users.findByUsername(candidate)) {
    candidate = `${base}${i}`;
    i += 1;
  }
  return candidate;
}

// ---------- config ----------
app.get("/api/config", (req, res) => {
  res.json({ googleEnabled: Boolean(GOOGLE_CLIENT_ID), googleClientId: GOOGLE_CLIENT_ID || null });
});

// ---------- auth ----------
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: "الاسم والبريد وكلمة المرور مطلوبة" });
  if (password.length < 6) return res.status(400).json({ error: "كلمة المرور يجب أن تكون 6 أحرف على الأقل" });
  const normalizedEmail = email.trim().toLowerCase();
  if (Users.findByEmail(normalizedEmail)) return res.status(409).json({ error: "هذا البريد مسجّل مسبقاً" });

  const hash = await bcrypt.hash(password, 10);
  const user = {
    id: uuidv4(),
    name: name.trim(),
    username: uniqueUsername(usernameFromName(name)),
    email: normalizedEmail,
    password: hash,
    avatar: null,
    bio: "عضو جديد في nova 🌌",
    provider: "email",
    createdAt: Date.now(),
  };
  await Users.create(user);
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "البريد وكلمة المرور مطلوبان" });
  const user = Users.findByEmail(email);
  if (!user || !user.password) return res.status(401).json({ error: "بيانات الدخول غير صحيحة" });
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ error: "بيانات الدخول غير صحيحة" });
  res.json({ token: signToken(user), user: publicUser(user) });
});

// Optional real Google Sign-In. Only works once you set GOOGLE_CLIENT_ID
// (and GOOGLE_CLIENT_SECRET isn't even needed for this flow) — see README.
app.post("/api/auth/google", async (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(400).json({ error: "تسجيل الدخول عبر جوجل غير مُفعّل على هذا الخادم" });
  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ error: "رمز جوجل مفقود" });
  try {
    const { OAuth2Client } = require("google-auth-library");
    const client = new OAuth2Client(GOOGLE_CLIENT_ID);
    const ticket = await client.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const email = payload.email.toLowerCase();
    let user = Users.findByEmail(email);
    if (!user) {
      user = {
        id: uuidv4(),
        name: payload.name || "مستخدم جوجل",
        username: uniqueUsername(usernameFromName(payload.name || "google_user")),
        email,
        password: null,
        avatar: payload.picture || null,
        bio: "سجّلت الدخول عبر جوجل",
        provider: "google",
        createdAt: Date.now(),
      };
      await Users.create(user);
    }
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (e) {
    res.status(401).json({ error: "تعذّر التحقق من حساب جوجل" });
  }
});

app.get("/api/auth/me", auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.put("/api/auth/me", auth, async (req, res) => {
  const { name, username, bio } = req.body || {};
  const patch = {};
  if (name) patch.name = name.trim();
  if (bio !== undefined) patch.bio = bio;
  if (username) {
    const clean = username.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    if (!clean) return res.status(400).json({ error: "اسم مستخدم غير صالح" });
    const taken = Users.findByUsername(clean);
    if (taken && taken.id !== req.user.id) return res.status(409).json({ error: "اسم المستخدم مستخدم بالفعل" });
    patch.username = clean;
  }
  const updated = await Users.update(req.user.id, patch);
  res.json({ user: publicUser(updated) });
});

app.post("/api/auth/avatar", auth, upload.single("avatar"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "لم يتم إرسال صورة" });
  const url = `/uploads/${req.file.filename}`;
  const updated = await Users.update(req.user.id, { avatar: url });
  res.json({ user: publicUser(updated) });
});

// ---------- tweets ----------
app.get("/api/tweets", optionalAuth, (req, res) => {
  const tweets = Tweets.all()
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((t) => ({
      ...t,
      likesCount: (t.likedBy || []).length,
      retweetsCount: (t.retweetedBy || []).length,
      liked: req.user ? (t.likedBy || []).includes(req.user.id) : false,
      retweeted: req.user ? (t.retweetedBy || []).includes(req.user.id) : false,
      likedBy: undefined,
      retweetedBy: undefined,
    }));
  res.json({ tweets });
});

app.post("/api/tweets", auth, async (req, res) => {
  const { content } = req.body || {};
  if (!content || !content.trim()) return res.status(400).json({ error: "لا يمكن نشر تغريدة فارغة" });
  if (content.length > 280) return res.status(400).json({ error: "الحد الأقصى 280 حرفاً" });
  const tweet = {
    id: uuidv4(),
    authorId: req.user.id,
    authorName: req.user.name,
    authorUsername: req.user.username,
    authorAvatar: req.user.avatar,
    content: content.trim(),
    createdAt: Date.now(),
    replies: 0,
    likedBy: [],
    retweetedBy: [],
  };
  await Tweets.create(tweet);
  res.json({ tweet: { ...tweet, likesCount: 0, retweetsCount: 0, liked: false, retweeted: false } });
});

app.post("/api/tweets/:id/like", auth, async (req, res) => {
  const tweet = Tweets.findById(req.params.id);
  if (!tweet) return res.status(404).json({ error: "التغريدة غير موجودة" });
  const likedBy = new Set(tweet.likedBy || []);
  const liked = likedBy.has(req.user.id);
  liked ? likedBy.delete(req.user.id) : likedBy.add(req.user.id);
  const updated = await Tweets.update(tweet.id, { likedBy: [...likedBy] });
  res.json({ liked: !liked, likesCount: updated.likedBy.length });
});

app.post("/api/tweets/:id/retweet", auth, async (req, res) => {
  const tweet = Tweets.findById(req.params.id);
  if (!tweet) return res.status(404).json({ error: "التغريدة غير موجودة" });
  const retweetedBy = new Set(tweet.retweetedBy || []);
  const retweeted = retweetedBy.has(req.user.id);
  retweeted ? retweetedBy.delete(req.user.id) : retweetedBy.add(req.user.id);
  const updated = await Tweets.update(tweet.id, { retweetedBy: [...retweetedBy] });
  res.json({ retweeted: !retweeted, retweetsCount: updated.retweetedBy.length });
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`nova server running on http://localhost:${PORT}`);
});
