// Minimal JSON-file database. No native bindings, so it installs and
// deploys cleanly on any free Node host (Render, Railway, Fly.io, etc).
// For real production scale you'd swap this for Postgres/Mongo, but the
// read/write functions below are the only thing you'd need to change.

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const TWEETS_FILE = path.join(DATA_DIR, "tweets.json");

function ensureFile(file, initial) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(initial, null, 2));
}
ensureFile(USERS_FILE, []);
ensureFile(TWEETS_FILE, []);

// Extremely small write queue so concurrent requests don't corrupt the
// file by interleaving writes.
let writeChain = Promise.resolve();
function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function writeJSON(file, data) {
  writeChain = writeChain.then(
    () =>
      new Promise((resolve, reject) => {
        fs.writeFile(file, JSON.stringify(data, null, 2), (err) => (err ? reject(err) : resolve()));
      })
  );
  return writeChain;
}

const Users = {
  all() {
    return readJSON(USERS_FILE);
  },
  findByEmail(email) {
    return this.all().find((u) => u.email === email.trim().toLowerCase()) || null;
  },
  findById(id) {
    return this.all().find((u) => u.id === id) || null;
  },
  findByUsername(username) {
    return this.all().find((u) => u.username === username) || null;
  },
  async create(user) {
    const users = this.all();
    users.push(user);
    await writeJSON(USERS_FILE, users);
    return user;
  },
  async update(id, patch) {
    const users = this.all();
    const idx = users.findIndex((u) => u.id === id);
    if (idx === -1) return null;
    users[idx] = { ...users[idx], ...patch };
    await writeJSON(USERS_FILE, users);
    return users[idx];
  },
};

const Tweets = {
  all() {
    return readJSON(TWEETS_FILE);
  },
  findById(id) {
    return this.all().find((t) => t.id === id) || null;
  },
  async create(tweet) {
    const tweets = this.all();
    tweets.unshift(tweet);
    await writeJSON(TWEETS_FILE, tweets);
    return tweet;
  },
  async update(id, patch) {
    const tweets = this.all();
    const idx = tweets.findIndex((t) => t.id === id);
    if (idx === -1) return null;
    tweets[idx] = { ...tweets[idx], ...patch };
    await writeJSON(TWEETS_FILE, tweets);
    return tweets[idx];
  },
};

module.exports = { Users, Tweets };
