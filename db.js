"use strict";
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.warn("ATTENTION : DATABASE_URL n'est pas définie. Renseigne-la (voir .env.example) avant de démarrer le serveur.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ---- catalogue de départ (même liste que le prototype visuel Ancora) ----
const SEED_YACHTS = [
  { id: "seraphine", name: "Séraphine", port: "Antibes", zone: "Côte d'Azur", country: "France", length_m: 42, cabins: 6, max_guests: 12, crew: 8, year: 2019, type: "Moteur", price_per_week: 185000,
    description: "Yacht moteur de 42 mètres basé à Antibes, taillé pour les grandes semaines en Méditerranée.",
    highlights: ["Jacuzzi pont supérieur", "Jet-skis inclus", "Chef étoilé", "Wifi satellite"] },
  { id: "lumen", name: "Lumen", port: "Monaco", zone: "Côte d'Azur", country: "Monaco", length_m: 28, cabins: 4, max_guests: 8, crew: 5, year: 2021, type: "Moteur", price_per_week: 95000,
    description: "Construit en 2021, Lumen est le choix discret pour une semaine entre Monaco et Portofino.",
    highlights: ["Amarrage Monaco", "Fonds marins (bar à palmes)", "Paddle & kayak"] },
  { id: "calypso-nord", name: "Calypso Nord", port: "Palma de Majorque", zone: "Baléares", country: "Espagne", length_m: 35, cabins: 5, max_guests: 10, crew: 6, year: 2017, type: "Moteur", price_per_week: 140000,
    description: "Calypso Nord sillonne les Baléares depuis 2017, idéal pour explorer les criques de Majorque et Minorque.",
    highlights: ["Cave à vin", "Massage à bord", "Plage arrière rabattable"] },
  { id: "horizon-bleu", name: "Horizon Bleu", port: "Porto Cervo", zone: "Sardaigne", country: "Italie", length_m: 50, cabins: 7, max_guests: 14, crew: 10, year: 2022, type: "Moteur", price_per_week: 265000,
    description: "Le plus grand de la flotte : 50 mètres, hélipad et piscine à débordement.",
    highlights: ["Piscine à débordement", "Hélipad", "Cinéma à bord", "Spa complet"] },
  { id: "meridienne", name: "Méridienne", port: "Ibiza", zone: "Baléares", country: "Espagne", length_m: 24, cabins: 3, max_guests: 6, crew: 4, year: 2020, type: "Voile", price_per_week: 68000,
    description: "Voilier de 24 mètres pour une traversée plus intime des Baléares.",
    highlights: ["Navigation à la voile", "Snorkeling guidé", "Ambiance intimiste"] },
  { id: "aether", name: "Aether", port: "Saint-Tropez", zone: "Côte d'Azur", country: "France", length_m: 38, cabins: 5, max_guests: 10, crew: 7, year: 2018, type: "Voile", price_per_week: 155000,
    description: "Voilier performant de 38 mètres au départ de Saint-Tropez.",
    highlights: ["Grand-voile automatisée", "Salon panoramique", "Toys nautiques complets"] },
  { id: "thalassa", name: "Thalassa", port: "Mykonos", zone: "Cyclades", country: "Grèce", length_m: 30, cabins: 4, max_guests: 9, crew: 5, year: 2020, type: "Voile", price_per_week: 88000,
    description: "Thalassa relie les Cyclades au gré du vent, entre Mykonos, Paros et Santorin.",
    highlights: ["Mouillages isolés", "Cuisine grecque à bord", "Coucher de soleil à Santorin"] },
  { id: "adriana", name: "Adriana", port: "Dubrovnik", zone: "Dalmatie", country: "Croatie", length_m: 33, cabins: 5, max_guests: 10, crew: 6, year: 2016, type: "Moteur", price_per_week: 120000,
    description: "Adriana part de Dubrovnik pour longer les îles de Dalmatie.",
    highlights: ["Parc national des Kornati", "Dégustation de vins croates", "Kayak de mer"] },
  { id: "ponente", name: "Ponente", port: "Porto-Vecchio", zone: "Corse", country: "France", length_m: 27, cabins: 4, max_guests: 8, crew: 5, year: 2023, type: "Moteur", price_per_week: 105000,
    description: "Livré en 2023, Ponente dessert les eaux turquoise du sud de la Corse.",
    highlights: ["Îles Lavezzi", "Falaises de Bonifacio", "Yacht récent"] },
  { id: "elysia", name: "Elysia", port: "Formentera", zone: "Baléares", country: "Espagne", length_m: 22, cabins: 3, max_guests: 6, crew: 3, year: 2021, type: "Voile", price_per_week: 58000,
    description: "Le plus abordable de la flotte : un voilier de 22 mètres pour découvrir Formentera.",
    highlights: ["Eaux turquoise de Formentera", "Format intimiste", "Bon rapport qualité-prix"] }
];

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('CLIENT','OWNER','ADMIN')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Migration : abonnement (conciergerie sur abonnement, géré via Stripe).
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'none'`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_plan TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_current_period_end TIMESTAMPTZ`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS yachts (
      id TEXT PRIMARY KEY,
      owner_id INTEGER REFERENCES users(id),
      name TEXT NOT NULL,
      port TEXT NOT NULL,
      zone TEXT NOT NULL,
      country TEXT NOT NULL,
      length_m REAL NOT NULL,
      cabins INTEGER NOT NULL,
      max_guests INTEGER NOT NULL,
      crew INTEGER NOT NULL,
      year INTEGER NOT NULL,
      type TEXT NOT NULL,
      price_per_week INTEGER NOT NULL,
      description TEXT,
      highlights TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Migration : le modèle "réservation + paiement en ligne" devient "demande
  // de renseignement" (prix sur demande, pas de paiement sur le site). On
  // renomme l'ancienne table "bookings" si elle existe encore sous ce nom.
  const { rows: bookingsExists } = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'bookings'`
  );
  const { rows: inquiriesExists } = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'inquiries'`
  );
  if (bookingsExists[0] && !inquiriesExists[0]) {
    await pool.query(`ALTER TABLE bookings RENAME TO inquiries`);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS inquiries (
      id SERIAL PRIMARY KEY,
      yacht_id TEXT NOT NULL REFERENCES yachts(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      start_date TEXT,
      end_date TEXT,
      guests INTEGER,
      phone TEXT,
      message TEXT,
      total_price INTEGER,
      status TEXT NOT NULL DEFAULT 'NOUVELLE',
      reference TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Si la table existait déjà sous l'ancien schéma (colonnes obligatoires,
  // pas de téléphone/message), on assouplit les contraintes et on complète.
  await pool.query(`ALTER TABLE inquiries ALTER COLUMN start_date DROP NOT NULL`);
  await pool.query(`ALTER TABLE inquiries ALTER COLUMN end_date DROP NOT NULL`);
  await pool.query(`ALTER TABLE inquiries ALTER COLUMN guests DROP NOT NULL`);
  await pool.query(`ALTER TABLE inquiries ALTER COLUMN total_price DROP NOT NULL`);
  await pool.query(`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS phone TEXT`);
  await pool.query(`ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS message TEXT`);
  await pool.query(`ALTER TABLE inquiries ALTER COLUMN status SET DEFAULT 'NOUVELLE'`);

  // Migration : autorise le rôle ADMIN même si la table "users" existait déjà
  // (créée avant l'ajout de ce rôle) avec une contrainte plus restrictive.
  await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);
  await pool.query(`ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('CLIENT','OWNER','ADMIN'))`);

  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM yachts");
  if (rows[0].n === 0) {
    for (const y of SEED_YACHTS) {
      await pool.query(
        `INSERT INTO yachts (id, name, port, zone, country, length_m, cabins, max_guests, crew, year, type, price_per_week, description, highlights)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (id) DO NOTHING`,
        [y.id, y.name, y.port, y.zone, y.country, y.length_m, y.cabins, y.max_guests, y.crew, y.year, y.type, y.price_per_week, y.description, JSON.stringify(y.highlights)]
      );
    }
    console.log(`Seeded ${SEED_YACHTS.length} yachts.`);
  }
}

module.exports = { pool, init };
