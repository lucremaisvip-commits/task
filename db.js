const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  ssl: {
    rejectUnauthorized: false
  },

  idleTimeoutMillis: 30000,       // fecha conexões ociosas
  connectionTimeoutMillis: 5000   // evita travamento ao conectar
});

// 🔍 Log opcional (ajuda debug)
pool.on("connect", () => {
  console.log("✅ Conectado ao PostgreSQL (Supabase)");
});

pool.on("error", (err) => {
  console.error("❌ Erro inesperado no pool:", err);
});

module.exports = pool;
