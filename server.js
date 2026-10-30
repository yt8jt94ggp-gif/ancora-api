"use strict";
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pool, init } = require("./db");
const { hashPassword, verifyPassword, sign, verify } = require("./auth");

const PORT = process.env.PORT || 4000;
const INDEX_PATH = path.join(__dirname, "public", "index.html");
let INDEX_HTML = "";
try {
  INDEX_HTML = fs.readFileSync(INDEX_PATH, "utf8");
} catch (e) {
  console.warn("Pas de fichier public/index.html trouvé :", e.message);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = "";
    req.on("data", (c) => (chunks += c));
    req.on("end", () => {
      if (!chunks) return resolve({});
      try { resolve(JSON.parse(chunks)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function yachtRow(row) {
  return {
    id: row.id, name: row.name, port: row.port, zone: row.zone, country: row.country,
    length: row.length_m, cabins: row.cabins, guests: row.max_guests, crew: row.crew,
    year: row.year, type: row.type, price: row.price_per_week, desc: row.description,
    highlights: typeof row.highlights === "string" ? JSON.parse(row.highlights || "[]") : (row.highlights || [])
  };
}

async function currentUser(req) {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const payload = verify(token);
  if (!payload) return null;
  const { rows } = await pool.query("SELECT id, name, email, role FROM users WHERE id = $1", [payload.sub]);
  return rows[0] || null;
}

async function requireAdmin(req) {
  const user = await currentUser(req);
  if (!user || user.role !== "ADMIN") return null;
  return user;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean); // ["api","yachts", ...]

  if (req.method === "OPTIONS") return send(res, 204, {});

  // Sert le site (SPA) pour toute requête GET qui n'est pas un appel d'API
  if (req.method === "GET" && parts[0] !== "api") {
    if (INDEX_HTML) return sendHtml(res, 200, INDEX_HTML);
    return sendHtml(res, 404, "<h1>Site non trouvé</h1>");
  }

  try {
    // GET /api/yachts
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "yachts" && !parts[2]) {
      let sql = "SELECT * FROM yachts WHERE 1=1";
      const args = [];
      const zone = url.searchParams.get("zone");
      const maxPrice = url.searchParams.get("maxPrice");
      const minGuests = url.searchParams.get("minGuests");
      const type = url.searchParams.get("type");
      if (zone) { args.push(zone); sql += ` AND zone = $${args.length}`; }
      if (maxPrice) { args.push(Number(maxPrice)); sql += ` AND price_per_week <= $${args.length}`; }
      if (minGuests) { args.push(Number(minGuests)); sql += ` AND max_guests >= $${args.length}`; }
      if (type) { args.push(type); sql += ` AND type = $${args.length}`; }
      sql += " ORDER BY price_per_week ASC";
      const { rows } = await pool.query(sql, args);
      return send(res, 200, { yachts: rows.map(yachtRow) });
    }

    // GET /api/yachts/:id
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "yachts" && parts[2]) {
      const { rows } = await pool.query("SELECT * FROM yachts WHERE id = $1", [parts[2]]);
      if (!rows[0]) return send(res, 404, { error: "Yacht introuvable" });
      return send(res, 200, { yacht: yachtRow(rows[0]) });
    }

    // POST /api/auth/signup
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "auth" && parts[2] === "signup") {
      const { name, email, password, role } = await readBody(req);
      if (!name || !email || !password || !["CLIENT", "OWNER"].includes(role)) {
        return send(res, 400, { error: "Champs manquants ou rôle invalide (CLIENT ou OWNER)" });
      }
      const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
      if (existing.rows[0]) return send(res, 409, { error: "Un compte existe déjà avec cet e-mail" });
      const password_hash = hashPassword(password);
      const inserted = await pool.query(
        "INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id",
        [name, email, password_hash, role]
      );
      const id = inserted.rows[0].id;
      const token = sign({ sub: id });
      return send(res, 201, { token, user: { id, name, email, role } });
    }

    // POST /api/auth/login
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "auth" && parts[2] === "login") {
      const { email, password } = await readBody(req);
      const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email || ""]);
      const row = rows[0];
      if (!row || !verifyPassword(password || "", row.password_hash)) {
        return send(res, 401, { error: "E-mail ou mot de passe incorrect" });
      }
      const token = sign({ sub: row.id });
      return send(res, 200, { token, user: { id: row.id, name: row.name, email: row.email, role: row.role } });
    }

    // GET /api/auth/me  (auth required)
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "auth" && parts[2] === "me") {
      const user = await currentUser(req);
      if (!user) return send(res, 401, { error: "Connexion requise" });
      return send(res, 200, { user });
    }

    // POST /api/bookings  (auth required)
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "bookings" && !parts[2]) {
      const user = await currentUser(req);
      if (!user) return send(res, 401, { error: "Connexion requise" });
      const { yachtId, startDate, endDate, guests } = await readBody(req);
      const { rows: yrows } = await pool.query("SELECT * FROM yachts WHERE id = $1", [yachtId || ""]);
      const yacht = yrows[0];
      if (!yacht) return send(res, 404, { error: "Yacht introuvable" });
      if (!startDate || !endDate) return send(res, 400, { error: "Dates manquantes" });
      if (guests && guests > yacht.max_guests) {
        return send(res, 400, { error: `Ce yacht accueille au maximum ${yacht.max_guests} invités` });
      }
      const reference = "ANC-" + crypto.randomBytes(3).toString("hex").toUpperCase();
      const inserted = await pool.query(
        `INSERT INTO bookings (yacht_id, user_id, start_date, end_date, guests, total_price, status, reference)
         VALUES ($1,$2,$3,$4,$5,$6,'CONFIRMED',$7) RETURNING id`,
        [yacht.id, user.id, startDate, endDate, guests || yacht.max_guests, yacht.price_per_week, reference]
      );
      return send(res, 201, {
        booking: {
          id: inserted.rows[0].id, reference, status: "CONFIRMED",
          startDate, endDate, guests: guests || yacht.max_guests,
          totalPrice: yacht.price_per_week, yacht: yachtRow(yacht)
        }
      });
    }

    // GET /api/bookings/me  (auth required)
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "bookings" && parts[2] === "me") {
      const user = await currentUser(req);
      if (!user) return send(res, 401, { error: "Connexion requise" });
      const { rows } = await pool.query(
        `SELECT b.*, y.name AS yacht_name, y.port AS yacht_port, y.country AS yacht_country
         FROM bookings b JOIN yachts y ON y.id = b.yacht_id
         WHERE b.user_id = $1 ORDER BY b.created_at DESC`,
        [user.id]
      );
      return send(res, 200, {
        bookings: rows.map((r) => ({
          id: r.id, reference: r.reference, status: r.status,
          startDate: r.start_date, endDate: r.end_date, guests: r.guests, totalPrice: r.total_price,
          yacht: { name: r.yacht_name, port: r.yacht_port, country: r.yacht_country }
        }))
      });
    }

    // ---------- administration (réservé au rôle ADMIN) ----------

    // GET /api/admin/stats
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "stats") {
      const admin = await requireAdmin(req);
      if (!admin) return send(res, 403, { error: "Accès réservé aux administrateurs" });
      const { rows: userCounts } = await pool.query("SELECT role, COUNT(*)::int AS n FROM users GROUP BY role");
      const { rows: yachtCount } = await pool.query("SELECT COUNT(*)::int AS n FROM yachts");
      const { rows: bookingAgg } = await pool.query(
        "SELECT COUNT(*)::int AS n, COALESCE(SUM(total_price),0)::bigint AS revenue FROM bookings"
      );
      const byRole = {};
      userCounts.forEach((r) => { byRole[r.role] = r.n; });
      return send(res, 200, {
        stats: {
          totalUsers: userCounts.reduce((sum, r) => sum + r.n, 0),
          totalClients: byRole.CLIENT || 0,
          totalOwners: byRole.OWNER || 0,
          totalAdmins: byRole.ADMIN || 0,
          totalYachts: yachtCount[0].n,
          totalBookings: bookingAgg[0].n,
          totalRevenue: Number(bookingAgg[0].revenue)
        }
      });
    }

    // GET /api/admin/users
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "users") {
      const admin = await requireAdmin(req);
      if (!admin) return send(res, 403, { error: "Accès réservé aux administrateurs" });
      const { rows } = await pool.query("SELECT id, name, email, role, created_at FROM users ORDER BY created_at DESC");
      return send(res, 200, {
        users: rows.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, createdAt: u.created_at }))
      });
    }

    // GET /api/admin/bookings
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "bookings") {
      const admin = await requireAdmin(req);
      if (!admin) return send(res, 403, { error: "Accès réservé aux administrateurs" });
      const { rows } = await pool.query(
        `SELECT b.*, y.name AS yacht_name, y.port AS yacht_port, y.country AS yacht_country,
                u.name AS user_name, u.email AS user_email
         FROM bookings b
         JOIN yachts y ON y.id = b.yacht_id
         JOIN users u ON u.id = b.user_id
         ORDER BY b.created_at DESC`
      );
      return send(res, 200, {
        bookings: rows.map((r) => ({
          id: r.id, reference: r.reference, status: r.status,
          startDate: r.start_date, endDate: r.end_date, guests: r.guests, totalPrice: r.total_price,
          yacht: { name: r.yacht_name, port: r.yacht_port, country: r.yacht_country },
          user: { name: r.user_name, email: r.user_email }
        }))
      });
    }

    send(res, 404, { error: "Route inconnue" });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: "Erreur serveur", detail: String(err.message || err) });
  }
});

init()
  .then(() => {
    server.listen(PORT, () => console.log(`Ancora API démarrée sur le port ${PORT}`));
  })
  .catch((err) => {
    console.error("Impossible d'initialiser la base de données :", err.message);
    process.exit(1);
  });
