"use strict";
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Stripe = require("stripe");
const { pool, init } = require("./db");
const { hashPassword, verifyPassword, sign, verify } = require("./auth");

const PORT = process.env.PORT || 4000;
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
if (!stripe) {
  console.warn("ATTENTION : STRIPE_SECRET_KEY n'est pas définie. L'abonnement (paiement) ne fonctionnera pas tant qu'elle n'est pas renseignée.");
}
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

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function readBody(req) {
  return readRawBody(req).then((buf) => {
    if (!buf.length) return {};
    return JSON.parse(buf.toString("utf8"));
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

function userRow(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    subscriptionStatus: row.subscription_status || "none",
    subscriptionPlan: row.subscription_plan || null,
    subscriptionCurrentPeriodEnd: row.subscription_current_period_end || null
  };
}

// Le catalogue est consultable librement par tout le monde. En revanche,
// envoyer une demande de mise en relation nécessite un compte Client avec un
// abonnement actif (ou en période d'essai) ; l'Administrateur a toujours accès.
function hasAccess(user) {
  if (!user) return false;
  if (user.role === "ADMIN") return true;
  return user.subscription_status === "active" || user.subscription_status === "trialing";
}

// Met à jour en base l'état d'abonnement d'un utilisateur à partir d'un objet
// Subscription Stripe (ou le remet à "none" si sub est absent).
async function applySubscriptionToUser(userId, sub, customerId) {
  const status = sub ? sub.status : "none";
  let plan = null;
  if (sub && sub.items && sub.items.data && sub.items.data[0]) {
    const priceId = sub.items.data[0].price.id;
    if (priceId === process.env.STRIPE_PRICE_ANNUAL) plan = "annual";
    else if (priceId === process.env.STRIPE_PRICE_MONTHLY) plan = "monthly";
  }
  const periodEnd = sub && sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
  await pool.query(
    `UPDATE users SET stripe_customer_id = COALESCE($1, stripe_customer_id), subscription_status = $2, subscription_plan = $3, subscription_current_period_end = $4 WHERE id = $5`,
    [customerId || null, status, plan, periodEnd, userId]
  );
}

function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "yacht"
  );
}

async function currentUser(req) {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const payload = verify(token);
  if (!payload) return null;
  const { rows } = await pool.query(
    `SELECT id, name, email, role, stripe_customer_id, subscription_status, subscription_plan, subscription_current_period_end
     FROM users WHERE id = $1`,
    [payload.sub]
  );
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
    // POST /api/stripe/webhook — appelé par Stripe, pas par le site. Nécessite
    // le corps brut (non parsé) pour vérifier la signature.
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "stripe" && parts[2] === "webhook") {
      if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
        res.writeHead(500);
        return res.end("Stripe non configuré");
      }
      const sig = req.headers["stripe-signature"];
      const raw = await readRawBody(req);
      let event;
      try {
        event = stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET);
      } catch (err) {
        res.writeHead(400);
        return res.end(`Webhook signature invalide : ${err.message}`);
      }
      try {
        if (event.type === "checkout.session.completed") {
          const session = event.data.object;
          const userId = Number(session.client_reference_id);
          if (userId && session.subscription) {
            const sub = await stripe.subscriptions.retrieve(session.subscription);
            await applySubscriptionToUser(userId, sub, session.customer);
          }
        } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
          const sub = event.data.object;
          const { rows } = await pool.query("SELECT id FROM users WHERE stripe_customer_id = $1", [sub.customer]);
          if (rows[0]) await applySubscriptionToUser(rows[0].id, sub, sub.customer);
        }
      } catch (err) {
        console.error("Erreur traitement webhook Stripe :", err);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ received: true }));
    }

    // POST /api/subscribe/checkout  (auth required) — crée une session Stripe
    // Checkout en mode abonnement et renvoie son URL.
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "subscribe" && parts[2] === "checkout") {
      if (!stripe) return send(res, 500, { error: "Stripe non configuré côté serveur" });
      const user = await currentUser(req);
      if (!user) return send(res, 401, { error: "Connexion requise" });
      const { plan } = await readBody(req);
      const priceId = plan === "annual" ? process.env.STRIPE_PRICE_ANNUAL : process.env.STRIPE_PRICE_MONTHLY;
      if (!priceId) return send(res, 500, { error: "Tarif Stripe non configuré côté serveur" });
      let customerId = user.stripe_customer_id;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email, name: user.name, metadata: { userId: String(user.id) }
        });
        customerId = customer.id;
        await pool.query("UPDATE users SET stripe_customer_id = $1 WHERE id = $2", [customerId, user.id]);
      }
      const origin = req.headers.origin || `https://${req.headers.host}`;
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        client_reference_id: String(user.id),
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${origin}/?checkout=success`,
        cancel_url: `${origin}/?checkout=cancel`
      });
      return send(res, 200, { url: session.url });
    }

    // POST /api/subscribe/portal  (auth required) — lien vers le portail de
    // gestion d'abonnement Stripe (annulation, moyen de paiement, factures).
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "subscribe" && parts[2] === "portal") {
      if (!stripe) return send(res, 500, { error: "Stripe non configuré côté serveur" });
      const user = await currentUser(req);
      if (!user) return send(res, 401, { error: "Connexion requise" });
      if (!user.stripe_customer_id) return send(res, 400, { error: "Aucun abonnement associé à ce compte" });
      const origin = req.headers.origin || `https://${req.headers.host}`;
      const portalSession = await stripe.billingPortal.sessions.create({
        customer: user.stripe_customer_id,
        return_url: `${origin}/`
      });
      return send(res, 200, { url: portalSession.url });
    }

    // GET /api/yachts  (catalogue public, consultable sans compte)
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

    // GET /api/yachts/:id  (catalogue public, consultable sans compte)
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "yachts" && parts[2]) {
      const { rows } = await pool.query("SELECT * FROM yachts WHERE id = $1", [parts[2]]);
      if (!rows[0]) return send(res, 404, { error: "Yacht introuvable" });
      return send(res, 200, { yacht: yachtRow(rows[0]) });
    }

    // POST /api/yachts (réservé à l'administrateur : il gère seul le catalogue)
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "yachts" && !parts[2]) {
      const admin = await requireAdmin(req);
      if (!admin) return send(res, 403, { error: "Réservé à l'administrateur" });
      const user = admin;
      const body = await readBody(req);
      const required = ["name", "port", "zone", "country", "lengthM", "cabins", "maxGuests", "crew", "year", "type", "pricePerWeek"];
      for (const field of required) {
        if (body[field] === undefined || body[field] === null || body[field] === "") {
          return send(res, 400, { error: `Champ manquant : ${field}` });
        }
      }
      if (!["Moteur", "Voile"].includes(body.type)) {
        return send(res, 400, { error: "Type invalide (Moteur ou Voile)" });
      }
      const numeric = {
        lengthM: Number(body.lengthM),
        cabins: Math.round(Number(body.cabins)),
        maxGuests: Math.round(Number(body.maxGuests)),
        crew: Math.round(Number(body.crew)),
        year: Math.round(Number(body.year)),
        pricePerWeek: Math.round(Number(body.pricePerWeek))
      };
      for (const key of Object.keys(numeric)) {
        if (!Number.isFinite(numeric[key]) || numeric[key] <= 0) {
          return send(res, 400, { error: `Valeur invalide pour ${key}` });
        }
      }
      let id = slugify(body.name);
      let candidate = id, suffix = 0;
      // garantit l'unicité de l'identifiant du yacht
      while (true) {
        const { rows } = await pool.query("SELECT 1 FROM yachts WHERE id = $1", [candidate]);
        if (!rows[0]) break;
        suffix += 1;
        candidate = id + "-" + suffix;
      }
      id = candidate;
      const highlights = Array.isArray(body.highlights) ? body.highlights.filter(Boolean) : [];
      const inserted = await pool.query(
        `INSERT INTO yachts (id, owner_id, name, port, zone, country, length_m, cabins, max_guests, crew, year, type, price_per_week, description, highlights)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [id, user.id, body.name, body.port, body.zone, body.country, numeric.lengthM, numeric.cabins, numeric.maxGuests, numeric.crew, numeric.year, body.type, numeric.pricePerWeek, body.description || "", JSON.stringify(highlights)]
      );
      return send(res, 201, { yacht: yachtRow(inserted.rows[0]) });
    }

    // POST /api/auth/signup — uniquement des comptes Client ; le catalogue est
    // géré par l'administrateur, il n'y a pas de compte Propriétaire.
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "auth" && parts[2] === "signup") {
      const { name, email, password } = await readBody(req);
      if (!name || !email || !password) {
        return send(res, 400, { error: "Champs manquants" });
      }
      const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
      if (existing.rows[0]) return send(res, 409, { error: "Un compte existe déjà avec cet e-mail" });
      const password_hash = hashPassword(password);
      const role = "CLIENT";
      const inserted = await pool.query(
        "INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id",
        [name, email, password_hash, role]
      );
      const id = inserted.rows[0].id;
      const token = sign({ sub: id });
      return send(res, 201, {
        token,
        user: userRow({ id, name, email, role, subscription_status: "none", subscription_plan: null, subscription_current_period_end: null })
      });
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
      return send(res, 200, { token, user: userRow(row) });
    }

    // GET /api/auth/me  (auth required)
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "auth" && parts[2] === "me") {
      const user = await currentUser(req);
      if (!user) return send(res, 401, { error: "Connexion requise" });
      return send(res, 200, { user: userRow(user) });
    }

    // POST /api/inquiries  (auth required) — demande de renseignement, pas de paiement
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "inquiries" && !parts[2]) {
      const user = await currentUser(req);
      if (!user) return send(res, 401, { error: "Connexion requise" });
      if (!hasAccess(user)) return send(res, 402, { error: "Abonnement requis", code: "SUBSCRIPTION_REQUIRED" });
      const { yachtId, startDate, endDate, guests, phone, message } = await readBody(req);
      const { rows: yrows } = await pool.query("SELECT * FROM yachts WHERE id = $1", [yachtId || ""]);
      const yacht = yrows[0];
      if (!yacht) return send(res, 404, { error: "Yacht introuvable" });
      if (!phone) return send(res, 400, { error: "Merci d'indiquer un numéro de téléphone" });
      if (guests && guests > yacht.max_guests) {
        return send(res, 400, { error: `Ce yacht accueille au maximum ${yacht.max_guests} invités` });
      }
      const reference = "ANC-" + crypto.randomBytes(3).toString("hex").toUpperCase();
      const inserted = await pool.query(
        `INSERT INTO inquiries (yacht_id, user_id, start_date, end_date, guests, phone, message, total_price, status, reference)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'NOUVELLE',$9) RETURNING id`,
        [yacht.id, user.id, startDate || null, endDate || null, guests || null, phone, message || null, yacht.price_per_week, reference]
      );
      return send(res, 201, {
        inquiry: {
          id: inserted.rows[0].id, reference, status: "NOUVELLE",
          startDate: startDate || null, endDate: endDate || null, guests: guests || null,
          yacht: yachtRow(yacht)
        }
      });
    }

    // GET /api/inquiries/me  (auth required)
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "inquiries" && parts[2] === "me") {
      const user = await currentUser(req);
      if (!user) return send(res, 401, { error: "Connexion requise" });
      if (!hasAccess(user)) return send(res, 402, { error: "Abonnement requis", code: "SUBSCRIPTION_REQUIRED" });
      const { rows } = await pool.query(
        `SELECT i.*, y.name AS yacht_name, y.port AS yacht_port, y.country AS yacht_country
         FROM inquiries i JOIN yachts y ON y.id = i.yacht_id
         WHERE i.user_id = $1 ORDER BY i.created_at DESC`,
        [user.id]
      );
      return send(res, 200, {
        inquiries: rows.map((r) => ({
          id: r.id, reference: r.reference, status: r.status,
          startDate: r.start_date, endDate: r.end_date, guests: r.guests,
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
      const { rows: inquiryAgg } = await pool.query("SELECT COUNT(*)::int AS n FROM inquiries");
      const { rows: activeSubs } = await pool.query(
        "SELECT COUNT(*)::int AS n FROM users WHERE subscription_status IN ('active','trialing')"
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
          totalInquiries: inquiryAgg[0].n,
          totalActiveSubscribers: activeSubs[0].n
        }
      });
    }

    // GET /api/admin/users
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "users") {
      const admin = await requireAdmin(req);
      if (!admin) return send(res, 403, { error: "Accès réservé aux administrateurs" });
      const { rows } = await pool.query(
        "SELECT id, name, email, role, subscription_status, subscription_plan, created_at FROM users ORDER BY created_at DESC"
      );
      return send(res, 200, {
        users: rows.map((u) => ({
          id: u.id, name: u.name, email: u.email, role: u.role,
          subscriptionStatus: u.subscription_status, subscriptionPlan: u.subscription_plan,
          createdAt: u.created_at
        }))
      });
    }

    // GET /api/admin/inquiries
    if (req.method === "GET" && parts[0] === "api" && parts[1] === "admin" && parts[2] === "inquiries") {
      const admin = await requireAdmin(req);
      if (!admin) return send(res, 403, { error: "Accès réservé aux administrateurs" });
      const { rows } = await pool.query(
        `SELECT i.*, y.name AS yacht_name, y.port AS yacht_port, y.country AS yacht_country,
                u.name AS user_name, u.email AS user_email
         FROM inquiries i
         JOIN yachts y ON y.id = i.yacht_id
         JOIN users u ON u.id = i.user_id
         ORDER BY i.created_at DESC`
      );
      return send(res, 200, {
        inquiries: rows.map((r) => ({
          id: r.id, reference: r.reference, status: r.status,
          startDate: r.start_date, endDate: r.end_date, guests: r.guests,
          phone: r.phone, message: r.message,
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
