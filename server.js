/***************************************************************************
 * 🌐 LUCREMAISTASK - BACKEND SERVER MESTRE
 ***************************************************************************/

// =========================================================================
// 🔹 1. Configuração Inicial e Importações
// =========================================================================
require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
// ❌ removido helmet por enquanto
const rateLimitLib = require("express-rate-limit"); // 🔥 renomeado para evitar conflito
const APP_DOMAIN = process.env.APP_DOMAIN || "https://task-test-nrdn.onrender.com";
const pool = require("./db");
const { Telegraf } = require("telegraf");
const cron = require("node-cron");
const axios = require("axios");

const FAUCETPAY_API_KEY = "651358d8dd7a03537c613db2c33bb8c79ac2961bb824f6985eab53b3a92a8a0d"; 
console.log("🚀 Bot rodando com chave de TESTE");

const app = express();
const PORT = process.env.PORT || 3000;
const bot = new Telegraf(process.env.BOT_TOKEN);

// ✅ Confia no primeiro proxy (necessário no Render/Heroku/etc..)
app.set("trust proxy", 1);

// 🔒 2. CORS restrito (ajuste seu domínio)
const allowedOrigins = [
  process.env.APP_DOMAIN, 
  "https://highpay-ads.com"
].filter(Boolean);

app.use(cors({
  origin: function(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.log("❌ CORS BLOCK:", origin);
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST"]
}));

// 🔒 3. Limite de requisições (anti spam)
const limiter = rateLimitLib({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 100, // 100 req por IP
});

app.use(limiter);

const saqueLimiter = rateLimitLib({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 3, // Limite de 3 tentativas de saque por IP por hora
  message: "Muitas tentativas. Tente novamente mais tarde."
});

// 🔒 4. Limite de JSON (anti ataque)
app.use(express.json({
  limit: "10kb"
}));

const crypto = require("crypto");

// 🔒 5. Funções de segurança para tarefas:
function gerarToken(telegram_id, tarefa_id) {
  return crypto
    .createHash("sha256")
    .update(telegram_id.toString() + tarefa_id.toString() + Date.now() + Math.random())
    .digest("hex");
}

const rateLimitMemory = {};

function checkRateLimit(user) {
  const now = Date.now();
  const userId = user.toString(); 

  if (!rateLimitMemory[userId]) {
    rateLimitMemory[userId] = now;
    return true;
  }

  if (now - rateLimitMemory[userId] < 2000) {
    return false;
  }

  rateLimitMemory[userId] = now;
  return true;
}

// 6. Segurança do que é publico ou privado 
function verificarAdminHTML(req, res, next) {
  const senha = req.query.key;

  if (!senha || senha !== process.env.PRIVATE_KEY) {
    return res.status(403).send("❌ Acesso negado");
  }

  next();
}

app.use(
  "/private",
  verificarAdminHTML,
  express.static(path.join(__dirname, "private"))
);

app.use(express.static("public"));

app.get("/api/config", (req, res) => {
  res.json({
    app_domain: process.env.APP_DOMAIN || "https://task-test-nrdn.onrender.com"
  });
});

// =========================================================================
// 🔹 2. WEBHOOK UNIFICADO (Stripe + Cakto)
// =========================================================================
app.post("/api/webhooks/vendas-vip", express.raw({ type: "application/json" }), async (req, res) => {
  let plataforma = "";
  let evento = "";
  let telegramId = "";
  let idTransacao = "";

  const stripeSignature = req.headers["stripe-signature"];
  const caktoToken = req.headers["x-cakto-token"];

  try {
    // 💳 FLUXO STRIPE
    if (stripeSignature) {
      plataforma = "Stripe";
      const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
      let stripeEvent;
      
      try {
        stripeEvent = stripe.webhooks.constructEvent(req.body, stripeSignature, process.env.STRIPE_WEBHOOK_SECRET);
      } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      evento = stripeEvent.type;
      const session = stripeEvent.data.object;
      telegramId = session.client_reference_id;
      idTransacao = session.id;

    // 🥝 FLUXO CAKTO
    } else if (caktoToken && caktoToken === process.env.CAKTO_SECRET_TOKEN) {
      plataforma = "Cakto";
      const body = JSON.parse(req.body.toString());
      
      evento = body.event; 
      telegramId = body.data ? body.data.utm_source : null; 
      idTransacao = body.data ? body.data.id : null;
      
    } else {
      return res.status(401).send("Não autorizado");
    }

    if (!telegramId) return res.status(200).send("Sem ID de usuário.");

    // Convertendo para BigInt para coincidir com a coluna da tabela 'usuarios'
    const tgId = BigInt(telegramId);

    // 💰 1. PROCESSAMENTO DE PAGAMENTOS APROVADOS
    if (evento === "checkout.session.completed" || evento === "purchase_approved") {
      const jaProcessado = await pool.query("SELECT 1 FROM historico_compras WHERE transacao_id = $1", [idTransacao]);
      if (jaProcessado.rows.length > 0) return res.status(200).send("Já processado");

      // Atualiza VIP na tabela usuarios (data_vip removido pois não existe na sua tabela)
      await pool.query(
        "UPDATE usuarios SET vip = true WHERE telegram_id = $1",
        [tgId]
      );

      // Insere no histórico com o padrão data_registro
      await pool.query(
        "INSERT INTO historico_compras (transacao_id, telegram_id, plataforma, status, data_registro) VALUES ($1, $2, $3, $4, NOW())",
        [idTransacao, tgId, plataforma, "approved"]
      );
      
      console.log(`[VIP ATIVADO] ${tgId} via ${plataforma}`);
    }

    // 🚨 2. PROCESSAMENTO DE ESTORNOS/REEMBOLSOS
    const eventosReembolso = ["charge.refunded", "purchase_refunded", "purchase_chargedback"];

    if (eventosReembolso.includes(evento)) {
      await pool.query("UPDATE usuarios SET vip = false WHERE telegram_id = $1", [tgId]);
      await pool.query("UPDATE historico_compras SET status = 'refunded' WHERE transacao_id = $1", [idTransacao]);
      
      console.log(`[VIP REMOVIDO] ${tgId} devido a reembolso na ${plataforma}`);
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("Erro interno no webhook:", error);
    res.status(500).send("Erro");
  }
});
// =========================================================================
// 🔹 3. Rotas de Tarefas (Modificadas para suportar Tarefas VIP)
// =========================================================================
app.post("/api/iniciar-tarefa", async (req, res) => {
  const { telegram_id, tarefa_id, fingerprint } = req.body;

  if (!telegram_id || !tarefa_id) {
    return res.status(400).json({ erro: "Dados inválidos" });
  }

  // 🔒 captura IP corretamente no Render
  const ipHeader = req.headers["x-forwarded-for"];
  const ip = ipHeader ? ipHeader.split(",")[0].trim() : req.socket.remoteAddress;

  const token = gerarToken(telegram_id, tarefa_id);

  try {
    // 🔒 Validar se a tarefa é VIP e se o usuário tem permissão antes de iniciar a sessão
    const tarefaCheck = await pool.query(
      "SELECT is_vip, ativa FROM tarefas WHERE id = $1",
      [tarefa_id]
    );

    if (tarefaCheck.rows.length === 0 || !tarefaCheck.rows[0].ativa) {
      return res.status(400).json({ erro: "Tarefa inválida ou inativa" });
    }

    if (tarefaCheck.rows[0].is_vip) {
      const userCheck = await pool.query(
        "SELECT vip FROM usuarios WHERE telegram_id = $1",
        [telegram_id]
      );
      if (!userCheck.rows[0]?.vip) {
        return res.status(403).json({ erro: "Acesso restrito para usuários VIP" });
      }
    }

    await pool.query(
      `INSERT INTO tarefas_sessoes 
       (telegram_id, tarefa_id, token, ip, fingerprint)
       VALUES ($1, $2, $3, $4, $5)`,
      [telegram_id, tarefa_id, token, ip, fingerprint]
    );

    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Erro ao iniciar tarefa" });
  }
});


app.get("/api/tarefas", async (req, res) => {
  const telegram_id = req.query.telegram_id;

  if (!telegram_id || typeof telegram_id !== "string") {
    return res.status(400).json({ erro: "telegram_id inválido ou ausente" });
  }

  try {
    // 🔒 buscar status VIP do usuário
    const usuario = await pool.query(
      "SELECT vip FROM usuarios WHERE telegram_id = $1",
      [telegram_id]
    );

    const isVip = usuario.rows[0]?.vip === true;

    // 🔥 Query otimizada: Consulta a tabela centralizada historico_ganhos
    // t.id::text = hg.referencia_id garante a conexão com a tarefa específica
    const tarefasQuery = `
      SELECT 
        t.*, 
        CASE 
          WHEN hg.telegram_id IS NOT NULL THEN true 
          ELSE false 
        END AS concluida
      FROM tarefas t
      LEFT JOIN historico_ganhos hg 
        ON hg.referencia_id = t.id::text
        AND hg.telegram_id = $1
        AND hg.origem = 'tarefa'
        AND hg.data_registro::date = CURRENT_DATE
      WHERE t.ativa = true 
        AND (t.is_vip = false OR $2 = true)
      ORDER BY t.is_vip DESC, t.id DESC
    `;

    const { rows } = await pool.query(tarefasQuery, [telegram_id, isVip]);

    // 🔥 envia o status junto para que o frontend saiba renderizar o layout VIP
    res.json({
      vip: isVip,
      tarefas: rows
    });

  } catch (error) {
    console.error("Erro ao buscar tarefas:", error.message);

    res.status(500).json({
      erro: "Erro ao listar tarefas",
      detalhe: error.message
    });
  }
});

app.post("/api/concluir-tarefa", async (req, res) => {
  let { telegram_id, tarefa_id, token } = req.body;

  telegram_id = String(telegram_id || "").trim();
  const tarefaId = Number(tarefa_id);

  if (!telegram_id || isNaN(tarefaId) || !token) {
    return res.status(400).json({ erro: "Dados inválidos" });
  }

  if (!checkRateLimit(telegram_id)) {
    return res.status(429).json({ erro: "Muitas requisições" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const sessaoRes = await client.query(
      `SELECT * FROM tarefas_sessoes WHERE token = $1 FOR UPDATE`,
      [token]
    );

    if (sessaoRes.rows.length === 0) {
      throw new Error("Sessão inválida");
    }

    const sessao = sessaoRes.rows[0];

    if (sessao.telegram_id !== telegram_id || sessao.status !== "aberto") {
      throw new Error("Sessão inválida");
    }

    const tempo = Date.now() - new Date(sessao.data_registro).getTime(); 
    if (tempo < 13000) {
      throw new Error("Tempo insuficiente");
    }

    const tarefa = await client.query(`SELECT id, pontos, ativa FROM tarefas WHERE id = $1`, [tarefaId]);
    if (tarefa.rows.length === 0 || !tarefa.rows[0].ativa) {
      throw new Error("Tarefa inválida");
    }

    const check = await client.query(
      `SELECT 1 FROM historico_ganhos WHERE telegram_id = $1 AND referencia_id = $2 AND origem = 'tarefa' AND data_registro::date = CURRENT_DATE`,
      [telegram_id, String(tarefaId)]
    );
    if (check.rows.length > 0) {
      throw new Error("Já concluída hoje");
    }

    const pontos = tarefa.rows[0].pontos;

    await client.query(
      `INSERT INTO historico_ganhos (telegram_id, origem, pontos, nome_tarefa, referencia_id, data_registro)
       VALUES ($1, 'tarefa', $2, $3, $4, NOW())`,
      [telegram_id, pontos, "Tarefa ID: " + tarefaId, String(tarefaId)]
    );

    await client.query(
      `UPDATE usuarios SET pontos = COALESCE(pontos, 0) + $1, tarefas_feitas = COALESCE(tarefas_feitas, 0) + 1 WHERE telegram_id = $2`,
      [pontos, telegram_id]
    );

    const resultadoXp = await adicionarXP(telegram_id, 15, client);
    const metaBatida = await verificarMetaDiaria(client, telegram_id);

    let infoBooster = { liberado: false };
    if (metaBatida) {
        infoBooster = await verificarMissaoEntrada(client, telegram_id);
    }

    const indicacaoRes = await client.query(
      "SELECT * FROM indicacoes WHERE id_indicado = $1 AND pontos_ativados = false",
      [telegram_id]
    );

    if (indicacaoRes.rows.length > 0) {
      const indicacao = indicacaoRes.rows[0];
      const tarefasRes = await client.query(
        "SELECT COUNT(*) FROM historico_ganhos WHERE telegram_id = $1 AND origem = 'tarefa'",
        [telegram_id]
      );

      if (parseInt(tarefasRes.rows[0].count) >= 3) {
        await client.query("UPDATE indicacoes SET pontos_ativados = true WHERE id = $1", [indicacao.id]);
        
        await client.query(
          `UPDATE usuarios SET pontos = COALESCE(pontos, 0) + 0.40, indicacoes = COALESCE(indicacoes, 0) + 1 WHERE telegram_id = $1`,
          [indicacao.id_indicador]
        );

        await adicionarXP(indicacao.id_indicador, 20, client);

        await client.query(
          `INSERT INTO historico_ganhos (telegram_id, origem, pontos, nome_tarefa, referencia_id, data_registro) VALUES ($1, 'indicacao', 0.40, 'Bônus por indicação', $2, NOW())`,
          [indicacao.id_indicador, String(telegram_id)]
        );
      }
    }

    await client.query("UPDATE tarefas_sessoes SET status = 'concluido', concluido_em = NOW() WHERE token = $1", [token]);

    await client.query("COMMIT");
    res.json({ mensagem: "✅ Concluído! +15 XP", metaBatida, booster: infoBooster.liberado });

  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ erro: err.message || "Erro interno" });
  } finally {
    client.release();
  }
});



// 🔹 3.3 Roleta (Refatorada com Sistema de Tickets Seguros)


// 🎰 GIRAR ROLETA - ATUALIZADA
app.post("/api/roleta/girar", async (req, res) => {
  const { telegram_id } = req.body;

  if (!telegram_id) {
    return res.status(400).json({ erro: "telegram_id inválido" });
  }

  const premios = [
    { tipo: "pontos", valor: 0.10, chance: 30 },
    { tipo: "pontos", valor: 0.25, chance: 25 },
    { tipo: "pontos", valor: 0.50, chance: 15 },
    { tipo: "pontos", valor: 0.75, chance: 10 },
    { tipo: "pontos", valor: 1.00, chance: 5 },
    { tipo: "pontos", valor: 1.50, chance: 2 },
    { tipo: "nada", valor: 0, chance: 13 }
  ];

  function sortearPremio() {
    const rand = Math.random() * 100;
    let acumulado = 0;
    for (const p of premios) {
      acumulado += p.chance;
      if (rand <= acumulado) return p;
    }
    return premios[0];
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const userRes = await client.query(
      "SELECT pontos, nivel FROM usuarios WHERE telegram_id = $1 FOR UPDATE",
      [telegram_id]
    );

    if (userRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ erro: "Usuário não encontrado" });
    }

    const user = userRes.rows[0];
    const nivelAtual = user.nivel || 1;
    const limiteGiros = TABELA_NIVEIS[nivelAtual].giros;

    const girosHoje = await client.query(
      `SELECT COUNT(*) FROM roleta_giros WHERE telegram_id = $1 AND data_registro::date = CURRENT_DATE`,
      [telegram_id]
    );

    if (parseInt(girosHoje.rows[0].count) >= limiteGiros) {
      await client.query("ROLLBACK");
      return res.status(400).json({ erro: `Limite diário de ${limiteGiros} giros atingido` });
    }

    const ticketCheck = await client.query(
      `SELECT id FROM roleta_tickets WHERE telegram_id = $1 AND usado = false ORDER BY id ASC LIMIT 1 FOR UPDATE`,
      [telegram_id]
    );

    let gratis = false;
    let ticketIdUsado = null;

    if (ticketCheck.rows.length > 0) {
      gratis = true;
      ticketIdUsado = ticketCheck.rows[0].id;
    }

    const CUSTO_GIRO = 0.20;

    if (gratis) {
      await client.query(
        "UPDATE roleta_tickets SET usado = true, data_registro = NOW() WHERE id = $1",
        [ticketIdUsado]
      );
    } else {
      if (parseFloat(user.pontos) < CUSTO_GIRO) {
        await client.query("ROLLBACK");
        return res.status(400).json({ erro: "Pontos insuficientes" });
      }
      await client.query(
        "UPDATE usuarios SET pontos = (pontos::NUMERIC - $1::NUMERIC) WHERE telegram_id = $2", 
        [CUSTO_GIRO.toFixed(2), telegram_id]
      );
    }

    const premio = sortearPremio();
    
    await client.query(
      "UPDATE usuarios SET pontos = (pontos::NUMERIC + $1::NUMERIC) WHERE telegram_id = $2", 
      [premio.valor.toFixed(2), telegram_id]
    );

    const resultadoXp = await adicionarXP(telegram_id, 30, client);

    const nomePremio = premio.tipo === "pontos" ? `${premio.valor} Pontos` : "Tente Novamente";

    const giroRes = await client.query(
      `INSERT INTO roleta_giros (telegram_id, premio, pontos_ganhos, gratis, data_registro) 
       VALUES ($1, $2, $3, $4, NOW()) RETURNING id`,
      [telegram_id, nomePremio, premio.valor, gratis]
    );

    await client.query(
      `INSERT INTO historico_ganhos (telegram_id, origem, pontos, nome_tarefa, referencia_id, data_registro)
       VALUES ($1, 'roleta', $2, $3, $4, NOW())`,
      [telegram_id, premio.valor, nomePremio, String(giroRes.rows[0].id)]
    );

    await client.query("COMMIT");
    
    res.json({ 
      success: true, 
      premio: nomePremio, 
      valor: premio.valor, 
      tipo: premio.tipo, 
      gratis, 
      xp: 30,
      subiuDeNivel: resultadoXp.subiuDeNivel,
      novoNivel: resultadoXp.novoNivel 
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Erro roleta:", err.message);
    res.status(500).json({ erro: "Erro interno" });
  } finally {
    client.release();
  }
}); 

    

// 📊 GIROS E TICKETS DISPONÍVEIS HOJE
app.get("/api/roleta/hoje", async (req, res) => {
  const { telegram_id } = req.query;
  try {
    const giros = await pool.query(
      `SELECT COUNT(*) FROM roleta_giros WHERE telegram_id = $1 AND data_registro::date = CURRENT_DATE`,
      [telegram_id]
    );
    const ticketsDisponiveis = await pool.query(
      `SELECT COUNT(*) FROM roleta_tickets WHERE telegram_id = $1 AND usado = false`,
      [telegram_id]
    );
    res.json({ giros: parseInt(giros.rows[0].count), tickets: parseInt(ticketsDisponiveis.rows[0].count) });
  } catch (err) {
    res.status(500).json({ erro: "Erro interno" });
  }
});

// 📜 HISTÓRICO DE GIROS
app.get("/api/roleta/historico", async (req, res) => {
  const { telegram_id } = req.query;
  try {
    const { rows } = await pool.query(
      `SELECT premio, pontos_ganhos, data_registro, gratis FROM roleta_giros 
       WHERE telegram_id = $1 ORDER BY id DESC LIMIT 10`,
      [telegram_id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ erro: "Erro interno" });
  }
});



// 🎟️ COMPRAR PACOTE DE TICKETS - CORRIGIDA
app.post("/api/roleta/comprar-tickets", async (req, res) => {
  const { telegram_id } = req.body;
  
  if (!telegram_id) {
    return res.status(400).json({ erro: "telegram_id é obrigatório." });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    
    // 1. Busca usuário e VIP (FOR UPDATE para travar a linha e evitar double-spend)
    const userRes = await client.query(
      "SELECT pontos, vip FROM usuarios WHERE telegram_id = $1 FOR UPDATE", 
      [telegram_id]
    );

    if (userRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ erro: "Usuário não encontrado." });
    }

    // Garante que pontos seja um número tratado
    const pontos = parseFloat(userRes.rows[0].pontos || 0);
    const vip = userRes.rows[0].vip;

    // 2. Regra de Preço: 0.80 para não VIP, 0.70 para VIP
    const preco = vip ? 0.70 : 0.80;

    if (pontos < preco) {
      await client.query("ROLLBACK");
      return res.status(400).json({ erro: "Pontos insuficientes para o pacote." });
    }

    // 3. Desconta pontos com cast explícito
    await client.query(
      "UPDATE usuarios SET pontos = (pontos::NUMERIC - CAST($1 AS NUMERIC)) WHERE telegram_id = $2", 
      [preco.toFixed(2), telegram_id]
    );

    // 4. Insere 5 tickets
    await client.query(`
      INSERT INTO roleta_tickets (telegram_id, usado, data_registro) 
      VALUES 
      ($1, false, CURRENT_DATE),
      ($1, false, CURRENT_DATE),
      ($1, false, CURRENT_DATE),
      ($1, false, CURRENT_DATE),
      ($1, false, CURRENT_DATE)
    `, [telegram_id]);

    // 5. Registra no histórico de ganhos/gastos (pontos como negativo, cast para NUMERIC)
    await client.query(`
      INSERT INTO historico_ganhos (telegram_id, origem, pontos, nome_tarefa, data_registro)
      VALUES ($1, 'compra_tickets', CAST($2 AS NUMERIC) * -1, 'Pacote de 5 Tickets', NOW())
    `, [telegram_id, preco.toFixed(2)]);

    await client.query("COMMIT");
    res.json({ success: true, mensagem: "Pacote de 5 tickets comprado com sucesso!" });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Erro ao comprar tickets:", err);
    res.status(500).json({ erro: "Erro interno do servidor." });
  } finally {
    client.release();
  }
});




// tarefas externas

app.get("/zeradsptc.php", async (req, res) => {
  const { pwd, user, amount, clicks } = req.query;

  // 1. Validação de segurança
  const rawIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress || "";
  const realIP = rawIP.split(',')[0]?.trim();
  const allowedIP = "162.0.208.108";

  if (pwd !== "NewPassword" || realIP !== allowedIP) {
    return res.status(403).send("acesso negado");
  }

  const client = await pool.connect();
  try {
    const valorZER = parseFloat(amount || 0);
    const totalClicks = parseInt(clicks || 0);

    if (valorZER <= 0) {
      return res.send("ok");
    }

    await client.query("BEGIN");

    // 2. Busca a cotação mais recente do banco (gerenciada pelo Cron)
    const cotacaoRes = await client.query(
      "SELECT valor_zer FROM cotacoes ORDER BY data_registro DESC, id DESC LIMIT 1"
    );

    const valorZerPorPonto = cotacaoRes.rows.length > 0 ? parseFloat(cotacaoRes.rows[0].valor_zer) : 2.5;

    // 3. Cálculo Dinâmico Baseado na Cotação Atual (Fator de repasse de 40%)
    const percentualRepasse = 0.40; 
    const pontosCalculados = (valorZER / valorZerPorPonto) * percentualRepasse;
    
    // Formata rigorosamente para string com 8 casas decimais para casar perfeitamente com o tipo NUMERIC do PostgreSQL
    const pontosFinal = pontosCalculados.toFixed(8);
    const xpGerado = totalClicks * 6;

    // 4. Atualizar pontos do usuário de forma segura via cast para NUMERIC
    const updateResult = await client.query(
      "UPDATE usuarios SET pontos = COALESCE(pontos, 0) + CAST($1 AS NUMERIC) WHERE telegram_id = $2",
      [pontosFinal, user]
    );

    if (updateResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.send("usuario nao encontrado");
    }

    // --- CHAMADA DA FUNÇÃO DE XP E NÍVEL ---
    await adicionarXP(user, xpGerado, client);
    // ---------------------------------------

    // 5. Registrar no histórico unificado (historico_ganhos)
    await client.query(
      `INSERT INTO historico_ganhos (telegram_id, origem, pontos, nome_tarefa, data_registro) 
       VALUES ($1, $2, CAST($3 AS NUMERIC), $4, NOW())`,
      [user, 'zerads', pontosFinal, 'ZerAds PTC']
    );

    // --- DISPARO DE METAS E BOOSTERS ---
    const metaBatida = await verificarMetaDiaria(client, user);
    
    let infoBooster = { liberado: false };
    if (metaBatida) {
        infoBooster = await verificarMissaoEntrada(client, user);
    }
    // -----------------------------------

    await client.query("COMMIT");
    
    console.log(`✅ Créditos ZerAds: ${pontosFinal} pts (Base ZER: ${valorZerPorPonto}) | XP: ${xpGerado} | Usuário: ${user} | Meta: ${metaBatida}`);
    res.send("ok");

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("🔥 Erro ZerAds:", err);
    res.status(500).send("erro");
  } finally {
    client.release();
  }
});


app.get("/cpalead-postback", async (req, res) => {
  const { subid, payout, offer_id, campaign_name } = req.query;
  
  if (!subid) {
    return res.status(400).send("❌ Subid ausente.");
  }

  const telegram_id = subid.replace("telegram_", "");

  const client = await pool.connect();
  try {
    const valorPayout = parseFloat(payout || 0);

    if (valorPayout <= 0) {
      return res.status(200).send("✅ Payout zerado ignorado.");
    }

    await client.query("BEGIN");

    // 1. Busca a cotação USD mais recente do banco (gerenciada pelo Cron)
    const cotacaoRes = await client.query(
      "SELECT valor_usd FROM cotacoes ORDER BY data_registro DESC, id DESC LIMIT 1"
    );

    // Valor base padrão caso a tabela esteja vazia (ex: 0.00909091)
    const valorUsdPorPonto = cotacaoRes.rows.length > 0 ? parseFloat(cotacaoRes.rows[0].valor_usd) : 0.00909091;

    // 2. Cálculo Dinâmico Baseado no Payout em USD e Fator de Repasse (40%)
    // O payout vem em dólares (ex: $0.50). Dividimos pelo valor de USD de 1 ponto e aplicamos o repasse.
    const percentualRepasse = 0.40;
    const pontosCalculados = (valorPayout / valorUsdPorPonto) * percentualRepasse;
    
    // Formata com 8 casas decimais para garantir compatibilidade perfeita com o tipo NUMERIC
    const pontosFinal = pontosCalculados.toFixed(8);

    // 3. Idempotência: Checa na historico_ganhos
    const check = await client.query(
      "SELECT 1 FROM historico_ganhos WHERE referencia_id = $1 AND origem = 'cpalead'", 
      [offer_id]
    );
    
    if (check.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(200).send("✅ Tarefa já registrada.");
    }

    // 4. Log na tabela unificada (historico_ganhos)
    await client.query(
      `INSERT INTO historico_ganhos 
      (telegram_id, origem, pontos, nome_tarefa, referencia_id, data_registro) 
      VALUES ($1, 'cpalead', CAST($3 AS NUMERIC), $4, $5, NOW())`,
      [telegram_id, 'cpalead', pontosFinal, campaign_name || 'Oferta CPALead', offer_id]
    );

    // 5. Update saldo e tarefas de forma segura via cast para NUMERIC
    await client.query(
      `UPDATE usuarios 
         SET pontos = COALESCE(pontos, 0) + CAST($1 AS NUMERIC), 
             tarefas_feitas = COALESCE(tarefas_feitas, 0) + 1 
         WHERE telegram_id = $2`,
      [pontosFinal, telegram_id]
    );

    // --- CHAMADA DA FUNÇÃO DE XP E NÍVEL ---
    await adicionarXP(telegram_id, 5, client);
    // ---------------------------------------

    await client.query("COMMIT");
    
    console.log(`✅ CPALead Sucesso: ${pontosFinal} pts (Base USD: ${valorUsdPorPonto}) | Usuário: ${telegram_id} | Oferta: ${offer_id}`);
    res.status(200).send("✅ Sucesso.");

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Erro CPALead:", err.message);
    res.status(500).send("❌ Erro interno.");
  } finally {
    client.release();
  }
});

// moneyrain verificar secret

const SECRET = '555406b2062d06a989af47844f99b39a265860bf9a237a54';

app.post('/api/moneyrain-callback', express.raw({ type: 'application/json' }), async (req, res) => {
    const signature = req.headers['x-moneyrain-signature'];
    const percentualRepasse = 0.4;

    let bodyBuffer;
    if (Buffer.isBuffer(req.body)) {
        bodyBuffer = req.body;
    } else {
        bodyBuffer = Buffer.from(JSON.stringify(req.body));
    }

    // 2. Verificar Assinatura HMAC
    const hmac = crypto.createHmac('sha256', SECRET);
    hmac.update(bodyBuffer); 
    const hash = hmac.digest('hex');
    const expectedSignature = 'sha256=' + hash;
    
    if (signature !== expectedSignature) {
        console.error("❌ Assinatura inválida no MoneyRain");
        return res.status(403).send('Bad signature');
    }

    let data;
    try {
        data = JSON.parse(bodyBuffer.toString('utf8'));
    } catch (e) {
        return res.status(400).send('Invalid JSON');
    }
    
    if (data.event === 'reward.completed') {
        const userId = data.external_uid;
        const rewardAmount = parseFloat(data.reward_currency_amount || 0);
        const viewId = data.view_id;
        const adType = data.ad_type ? data.ad_type.toUpperCase() : "Ad";
        const nomeTarefa = `MoneyRain ${adType}`;

        if (!userId || !viewId) return res.status(400).send('Missing user or view ID');
        if (rewardAmount <= 0) return res.status(200).send('Reward zero ignored');

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // 1. Idempotência: Checa na historico_ganhos
            const check = await client.query(
                "SELECT 1 FROM historico_ganhos WHERE referencia_id = $1 AND origem = 'moneyrain'", 
                [viewId.toString()]
            );

            if (check.rowCount > 0) {
                await client.query('ROLLBACK');
                return res.status(200).send('Already credited');
            }

            // 2. Busca a cotação USD mais recente do banco (gerenciada pelo Cron)
            const cotacaoRes = await client.query(
                "SELECT valor_usd FROM cotacoes ORDER BY data_registro DESC, id DESC LIMIT 1"
            );

            const valorUsdPorPonto = cotacaoRes.rows.length > 0 ? parseFloat(cotacaoRes.rows[0].valor_usd) : 0.00909091;

            // 3. Cálculo Dinâmico Baseado na Cotação Atual e Fator de Repasse (40%)
            const pontosCalculados = (rewardAmount / valorUsdPorPonto) * percentualRepasse;
            const pontosFinal = pontosCalculados.toFixed(8); // Compatível com colunas NUMERIC

            // 4. Inserção no histórico de ganhos
            await client.query(
                `INSERT INTO historico_ganhos (telegram_id, origem, pontos, nome_tarefa, referencia_id, data_registro) 
                 VALUES ($1, 'moneyrain', CAST($2 AS NUMERIC), $3, $4, NOW())`,
                [userId, pontosFinal, nomeTarefa, viewId.toString()]
            );

            // 5. Atualização de Saldo do usuário
            await client.query(
                `UPDATE usuarios 
                 SET pontos = COALESCE(pontos, 0) + CAST($1 AS NUMERIC)
                 WHERE telegram_id = $2`,
                [pontosFinal, userId]
            );

            // 6. Integração de Nível e XP
            const resultadoXp = await adicionarXP(userId, 5, client);

            // 7. Disparo de Metas e Boosters
            const metaBatida = await verificarMetaDiaria(client, userId);
            
            let infoBooster = { liberado: false };
            if (metaBatida) {
                infoBooster = await verificarMissaoEntrada(client, userId);
            }

            await client.query('COMMIT');
            console.log(`✅ MoneyRain Sucesso! Usuário ${userId} recebeu ${pontosFinal} pts (Base USD: ${valorUsdPorPonto}) | Meta: ${metaBatida}`);
            return res.status(200).send('OK');

        } catch (dbErr) {
            await client.query('ROLLBACK');
            console.error("🔥 Erro no Banco (MoneyRain):", dbErr);
            return res.status(500).send('Database error');
        } finally {
            client.release();
        }
    }
    
    res.status(400).send('Invalid event');
});

/**
 * Verifica se o usuário cumpriu a meta do dia:
 * 1. Pelo menos 3 tarefas de origem 'zerads'
 * 2. Pelo menos 3 tarefas de origem 'moneyrain'
 * 3. Pelo menos 1 tarefa de origem 'tarefa' (interna)
 * 4. Pelo menos 1.01401 pontos no total
 */
async function verificarMetaDiaria(client, telegram_id) {
    const res = await client.query(`
        SELECT 
            COUNT(*) FILTER (WHERE origem = 'zerads') as total_zerads,
            COUNT(*) FILTER (WHERE origem = 'moneyrain') as total_moneyrain,
            COUNT(*) FILTER (WHERE origem = 'tarefa') as total_tarefas,
            SUM(pontos) as total_pontos
        FROM historico_ganhos 
        WHERE telegram_id = $1 AND data_registro::date = CURRENT_DATE
    `, [telegram_id]);

    const stats = res.rows[0];
    const zerads = parseInt(stats.total_zerads) || 0;
    const moneyrain = parseInt(stats.total_moneyrain) || 0;
    const tarefas = parseInt(stats.total_tarefas) || 0;
    const pontos = parseFloat(stats.total_pontos) || 0;

    const metaCumprida = zerads >= 3 && moneyrain >= 3 && tarefas >= 1 && pontos >= 1.01401;

    if (metaCumprida) {
        // Usamos FOR UPDATE para bloquear a linha e evitar concorrência
        const check = await client.query(`
            SELECT meta_cumprida_hoje FROM usuarios_streaks WHERE telegram_id = $1 FOR UPDATE
        `, [telegram_id]);

        if (check.rows.length > 0 && !check.rows[0].meta_cumprida_hoje) {
            await client.query(`
                UPDATE usuarios_streaks 
                SET meta_cumprida_hoje = TRUE, streak_atual = streak_atual + 1
                WHERE telegram_id = $1
            `, [telegram_id]);
        }
    }
    return metaCumprida;
}


async function verificarMissaoEntrada(client, telegram_id) {
    try {
        // 1. Verifica se o usuário cumpre os requisitos e trava a linha para update (FOR UPDATE)
        const query = `
            SELECT u.pontos
            FROM usuarios u
            JOIN usuarios_streaks us ON u.telegram_id = us.telegram_id
            WHERE u.telegram_id = $1 
            AND u.booster_usado = FALSE
            AND us.meta_cumprida_hoje = TRUE
            FOR UPDATE
        `;

        const res = await client.query(query, [telegram_id]);

        if (res.rows.length > 0) {
            const saldoAtual = parseFloat(res.rows[0].pontos) || 0;
            const metaSaque = 2.02802;
            const pontosParaCompletar = metaSaque > saldoAtual ? (metaSaque - saldoAtual) : 0;

            // 2. Se faltam pontos, aplica o ajuste (booster)
            if (pontosParaCompletar > 0) {
                await client.query(`
                    UPDATE usuarios 
                    SET pontos = pontos + $1, 
                        booster_usado = TRUE 
                    WHERE telegram_id = $2
                `, [pontosParaCompletar, telegram_id]);

                await client.query(`
                    INSERT INTO historico_ganhos (telegram_id, origem, pontos, nome_tarefa, data_registro)
                    VALUES ($1, 'booster_entrada', $2, 'Missão de Entrada (Ajuste)', NOW())
                `, [telegram_id, pontosParaCompletar]);
            } else {
                // 3. Caso ele já tenha atingido o mínimo sozinho, apenas marca o booster como usado
                await client.query(`
                    UPDATE usuarios 
                    SET booster_usado = TRUE 
                    WHERE telegram_id = $1
                `, [telegram_id]);
            }

            return { 
                liberado: true, 
                mensagem: "🎉 Parabéns! Missão de entrada concluída com sucesso." 
            };
        }
        
        return { liberado: false };

    } catch (error) {
        console.error("Erro na Missão de Entrada:", error);
        throw error; // Propaga o erro para que a rota pai saiba que precisa fazer o ROLLBACK
    }
}

app.post("/api/abrir-bau", async (req, res) => {
    const { telegram_id } = req.body;
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // 1. Verifica se o baú está disponível
        const checkRes = await client.query(`
            SELECT us.bau_disponivel, u.nivel 
            FROM usuarios_streaks us
            JOIN usuarios u ON us.telegram_id = u.telegram_id
            WHERE us.telegram_id = $1 FOR UPDATE
        `, [telegram_id]);

        if (checkRes.rows.length === 0 || !checkRes.rows[0].bau_disponivel) {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, error: "Baú não disponível." });
        }

        const nivel = checkRes.rows[0].nivel;

        // 2. Calcula o prêmio conforme a fórmula definida
        const base = 0.40;
        const fatorNivel = 0.05;
        const teto = 0.80;
        const premioPontos = Math.min(base + (nivel * fatorNivel), teto);
        const premioTickets = 2; 

        // 3. Atualiza Saldo do Usuário
        await client.query(`
            UPDATE usuarios 
            SET pontos = pontos + $1 
            WHERE telegram_id = $2
        `, [premioPontos, telegram_id]);

        // 4. Insere no Histórico de Ganhos
        await client.query(`
            INSERT INTO historico_ganhos 
            (telegram_id, origem, pontos, nome_tarefa, data_registro) 
            VALUES ($1, 'bau_semanal', $2, 'Baú de 7 Dias (Nível ' || $3 || ')', NOW())
        `, [telegram_id, premioPontos, nivel]);

        // 5. Insere os 2 tickets na tabela roleta_tickets
        await client.query(`
            INSERT INTO roleta_tickets (telegram_id, usado, data_registro) 
            VALUES 
            ($1, false, CURRENT_DATE),
            ($1, false, CURRENT_DATE)
        `, [telegram_id]);

        // 6. Atualiza o status do baú na tabela streaks
        await client.query(`
            UPDATE usuarios_streaks 
            SET bau_disponivel = FALSE 
            WHERE telegram_id = $1
        `, [telegram_id]);

        await client.query("COMMIT");

        res.json({
            success: true,
            mensagem: "🎉 Baú aberto com sucesso!",
            premioPontos: premioPontos.toFixed(8),
            premioTickets: premioTickets
        });

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Erro ao abrir baú:", err);
        res.status(500).json({ success: false, error: "Erro interno ao processar baú." });
    } finally {
        client.release();
    }
});


app.post("/api/limpar-aviso-reset", async (req, res) => {
    const { telegram_id } = req.body;
    
    if (!telegram_id) {
        return res.status(400).json({ success: false, error: "telegram_id não informado" });
    }

    try {
        await pool.query(
            "UPDATE usuarios_streaks SET streak_quebrado = FALSE WHERE telegram_id = $1",
            [telegram_id]
        );
        res.json({ success: true });
    } catch (err) {
        console.error("Erro ao limpar aviso de reset:", err);
        res.status(500).json({ success: false, error: "Erro interno no servidor" });
    }
});

// =========================================================================
// 🔹 4. Rotas de Usuário & Mini App Health Check
// =========================================================================
app.get("/", (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log("🌐 Acesso Mini App - IP:", ip);
  res.send("Mini App carregado - Sistema LucreMaisTask ativo.");
});


app.get("/api/status-checklist", async (req, res) => {
    const { telegram_id } = req.query;
    const client = await pool.connect();
    try {
        const result = await client.query(`
            SELECT 
                u.data_registro::date as data_criacao,
                us.streak_atual, 
                us.bau_disponivel,
                us.streak_quebrado,
                (SELECT COUNT(*) FROM historico_ganhos WHERE telegram_id = u.telegram_id AND origem = 'zerads' AND data_registro::date = CURRENT_DATE) as zerads,
                (SELECT COUNT(*) FROM historico_ganhos WHERE telegram_id = u.telegram_id AND origem = 'moneyrain' AND data_registro::date = CURRENT_DATE) as moneyrain,
                (SELECT COUNT(*) FROM historico_ganhos WHERE telegram_id = u.telegram_id AND origem = 'tarefa' AND data_registro::date = CURRENT_DATE) as tarefas
            FROM usuarios u
            LEFT JOIN usuarios_streaks us ON u.telegram_id = us.telegram_id
            WHERE u.telegram_id = $1
        `, [telegram_id]);

        const data = result.rows[0];

        if (!data) {
            return res.status(404).json({ error: "Usuário não encontrado" });
        }

        // Calcula se o checklist do dia foi concluído com base nas metas atingidas
        const zeradsCount = parseInt(data.zerads) || 0;
        const moneyrainCount = parseInt(data.moneyrain) || 0;
        const tarefasCount = parseInt(data.tarefas) || 0;
        const checklistConcluido = (zeradsCount >= 3 && moneyrainCount >= 3 && tarefasCount >= 1);

        res.json({
            progresso: { 
                zerads: zeradsCount, 
                moneyrain: moneyrainCount, 
                tarefas: tarefasCount 
            },
            streak: { 
                streak_atual: data.streak_atual || 0, 
                bau_disponivel: data.bau_disponivel || false,
                streak_quebrado: data.streak_quebrado || false
            },
            checklist_concluido: checklistConcluido,
            data_criacao: data.data_criacao
        });
    } finally {
        client.release();
    }
});

// Padronizado conforme Dossiê: uso de BIGINT para telegram_id
app.get("/api/usuarios/:telegram_id", async (req, res) => {
  try {
    const { telegram_id } = req.params;

    // Validação básica: garante que o ID seja tratado como string para a query
    if (!telegram_id) {
      return res.status(400).json({
        success: false,
        error: "telegram_id não informado"
      });
    }

    // A busca utiliza o índice B-Tree criado para telegram_id (performance otimizada)
    // Incluídos u.nivel e u.xp para suportar o painel de saques e outras telas
    const result = await pool.query(
      "SELECT telegram_id, nome, pontos, vip, lang, indicacoes, nivel, xp FROM usuarios WHERE telegram_id = $1",
      [telegram_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Usuário não encontrado"
      });
    }

    return res.json({
      success: true,
      data: result.rows[0]
    });

  } catch (err) {
    console.error("Erro /api/usuarios:", err);

    return res.status(500).json({
      success: false,
      error: "Erro interno no servidor"
    });
  }
});

// 🔹 Rota de Status do Usuário (Otimizada para o HUD do RPG)
app.get('/api/status-usuario', async (req, res) => {
    const { telegram_id } = req.query;

    if (!telegram_id) {
        return res.status(400).json({ error: "telegram_id é obrigatório" });
    }

    try {
        const query = `
            SELECT 
                u.xp, 
                u.nivel, 
                u.vip,
                s.streak_atual,
                s.bau_disponivel,
                COALESCE(u.escudos, 0) as escudos
            FROM usuarios u
            LEFT JOIN usuarios_streaks s ON u.telegram_id = s.telegram_id
            WHERE u.telegram_id = $1
        `;

        const result = await pool.query(query, [telegram_id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Usuário não encontrado" });
        }

        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        console.error("Erro ao buscar status do usuário:", err);
        res.status(500).json({ error: "Erro interno no servidor" });
    }
});


// Tabela de Níveis e Benefícios (Configuração Mestre)
const TABELA_NIVEIS = {
    1: { xp_min: 0, titulo: "Novato", limite_saque: 1, giros: 5, tempo_ad: 15 },
    2: { xp_min: 100, titulo: "Explorador", limite_saque: 2, giros: 6, tempo_ad: 14, premios: { tickets: 1 } },
    3: { xp_min: 300, titulo: "Caçador", limite_saque: 3, giros: 7, tempo_ad: 13, premios: { tickets: 2, escudo: 1 } },
    4: { xp_min: 600, titulo: "Mestre", limite_saque: 4, giros: 8, tempo_ad: 10, premios: { tickets: 3 } },
    5: { xp_min: 1000, titulo: "Lenda", limite_saque: 5, giros: 10, tempo_ad: 8, premios: { tickets: 5 } }
};

// Função para processar ganho de XP e verificar Level UP
async function adicionarXP(telegram_id, xpGanho, client) {
    const userRes = await client.query("SELECT xp, nivel FROM usuarios WHERE telegram_id = $1", [telegram_id]);
    if (userRes.rows.length === 0) return;

    let { xp, nivel } = userRes.rows[0];
    let novoXp = xp + xpGanho;
    let novoNivel = nivel; 

    // Procura o maior nível alcançável com o novo XP
    for (let n = 5; n >= 1; n--) {
        if (novoXp >= TABELA_NIVEIS[n].xp_min) {
            novoNivel = n; // Define o maior nível atingido
            break; 
        }
    }

    let subiuDeNivel = (novoNivel > nivel);

    // 3. Atualiza o banco
    await client.query("UPDATE usuarios SET xp = $1, nivel = $2 WHERE telegram_id = $3", [novoXp, novoNivel, telegram_id]);

    // 4. Entrega os prêmios (apenas se realmente subiu)
    if (subiuDeNivel) {
        const beneficios = TABELA_NIVEIS[novoNivel].premios;
        
        if (beneficios?.tickets) {
            // Verifica se a tabela existe e está recebendo os dados corretamente
            for (let i = 0; i < beneficios.tickets; i++) {
                await client.query("INSERT INTO roleta_tickets (telegram_id, usado, data_registro) VALUES ($1, false, CURRENT_DATE)", [telegram_id]);
            }
        }
        
        if (beneficios?.escudo) {
            await client.query("UPDATE usuarios_streaks SET escudos = escudos + $1 WHERE telegram_id = $2", [beneficios.escudo, telegram_id]);
        }
    }

    return { novoXp, novoNivel, subiuDeNivel };
}

app.get("/api/indicacoes-info", async (req, res) => {
  const { telegram_id } = req.query;
  if (!telegram_id) return res.status(400).json({ erro: "ID necessário" });

  try {
    // Busca o total de indicações validadas pelo sistema (pontos_ativados = true)
    const totalRes = await pool.query(
      "SELECT COUNT(*) FROM indicacoes WHERE id_indicador = $1 AND pontos_ativados = true",
      [telegram_id]
    );

    // Busca apenas o evento mais recente de premiação de indicação para o front comparar
    const historicoRes = await pool.query(
      "SELECT id, data_registro FROM historico_ganhos WHERE telegram_id = $1 AND origem = 'indicacao' ORDER BY data_registro DESC LIMIT 1",
      [telegram_id]
    );

    res.json({
      totalAprovadas: parseInt(totalRes.rows[0].count),
      ultimaPremiacao: historicoRes.rows.length > 0 ? historicoRes.rows[0].data_registro : null
    });
  } catch (err) {
    console.error("Erro ao buscar indicações:", err);
    res.status(500).json({ erro: "Erro ao buscar dados" });
  }
});


// =========================================================================
// 🔹 5. Ranking Otimizado com critérios de desempate
// =========================================================================
// 🔹 5. Ranking Otimizado com critérios de desempate
app.get("/api/ranking", async (req, res) => {
  try {
    // Ranking de Tarefas (Baseado na soma de pontos ganhos)
    // Desempate: VIP primeiro (true vem antes de false no DESC), depois Total Gerado (Soma de pontos)
    const rankingTarefas = await pool.query(`
      SELECT 
        u.telegram_id, 
        u.nome, 
        u.pontos,
        COALESCE(SUM(h.pontos), 0) as total_gerado
      FROM usuarios u
      LEFT JOIN historico_ganhos h ON u.telegram_id = h.telegram_id
      GROUP BY u.telegram_id, u.nome, u.pontos, u.vip
      ORDER BY 
        u.pontos DESC, 
        u.vip DESC, 
        total_gerado DESC
      LIMIT 5
    `);

    // Ranking de Indicações
    const rankingIndicacoes = await pool.query(`
      SELECT telegram_id, nome, indicacoes
      FROM usuarios
      WHERE indicacoes > 0
      ORDER BY indicacoes DESC
      LIMIT 5
    `);

    res.json({
      tarefas: rankingTarefas.rows,
      indicacoes: rankingIndicacoes.rows
    });
  } catch (err) {
    console.error("Erro ao buscar ranking:", err.message);
    res.status(500).json({ erro: "Erro ao buscar ranking" });
  }
});



// =========================================================================
// 🔹 6. Saques (Versão Global Integrada ao historico_ganhos, chat e FaucetPay)
// =========================================================================

const dicionarioSaque = {
  pt: {
    escolha: "Escolha seu idioma / Choose your language:",
    boas_vindas_novo: "🎉 Bem-vindo ao LucreMaisTask!\n\n🎁 MISSÃO DE ENTRADA: Complete suas tarefas diárias com o booster de entrada e saque para sua FaucetPay ainda hoje!",
    boas_vindas_recorrente: "👋 Bem-vindo de volta!\n\n💰 Saldo atual: {saldo} pontos.\n🚀 Novas oportunidades disponíveis. Ganhe mais agora!",
    btn_app: "📲 Abrir Mini App",
    erro: "⚠️ Erro no sistema, tente novamente."
  },
  en: {
    escolha: "Choose your language / Escolha seu idioma:",
    boas_vindas_novo: "🎉 Welcome to LucreMaisTask!\n\n🎁 WELCOME MISSION: Complete your daily tasks with the entry booster and withdraw to your FaucetPay today!",
    boas_vindas_recorrente: "👋 Welcome back!\n\n💰 Current balance: {saldo} points.\n🚀 New opportunities available. Earn more now!",
    btn_app: "📲 Open Mini App",
    erro: "⚠️ System error, please try again."
  }
};

const dicionario = dicionarioSaque;

async function getSaldoUsuario(telegramId) {
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(pontos), 0) as total FROM historico_ganhos WHERE telegram_id = $1`,
      [telegramId]
    );
    return parseInt(rows[0].total);
  } catch (err) {
    console.error("Erro ao buscar saldo:", err);
    return 0;
  }
}

app.get("/api/ltc-hoje", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT * FROM cotacoes ORDER BY data_registro DESC LIMIT 1"
        );
        res.json(result.rows[0] || {});
    } catch (err) {
        console.error("Erro ao buscar cotação ltc:", err);
        res.status(500).json({ error: "Erro ao buscar cotação" });
    }
});

app.post("/api/solicitar-saque", saqueLimiter, async (req, res) => {
  const { telegram_id, chave_pix } = req.body;
  
  if (!telegram_id) {
    return res.status(401).json({ error: "Identificação do usuário ausente." });
  }

  const emailLimpo = chave_pix ? chave_pix.trim().toLowerCase() : "";
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(emailLimpo)) {
    return res.status(400).json({ error: "Formato de e-mail inválido." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const userResult = await client.query(
      "SELECT pontos, vip, lang, status_conta, nivel FROM usuarios WHERE telegram_id = $1 FOR UPDATE", 
      [telegram_id]
    );

    if (userResult.rows.length === 0) throw new Error("USUARIO_NAO_ENCONTRADO");
    const user = userResult.rows[0];
    if (user.status_conta === 'banido') throw new Error("USUARIO_BANIDO");
    
    const { pontos, vip, lang, nivel } = user;
    const isEn = lang === 'en';

    const limiteSaques = (typeof TABELA_NIVEIS !== 'undefined' && TABELA_NIVEIS[nivel]?.limite_saque) ? TABELA_NIVEIS[nivel].limite_saque : 1;
    const saquesHoje = await client.query(`
      SELECT COUNT(*) FROM saques 
      WHERE telegram_id = $1 AND DATE(data_solicitacao) = CURRENT_DATE
    `, [telegram_id]);

    if (parseInt(saquesHoje.rows[0].count) >= limiteSaques) throw new Error("LIMITE_ATINGIDO");

    const pontosMinimos = vip ? 1.01401 : 2.02802;
    if (pontos < pontosMinimos) throw new Error("PONTOS_INSUFICIENTES");

    const VALOR_DO_PONTO_EM_BRL = 0.05;
    let valorCalculado = pontos * VALOR_DO_PONTO_EM_BRL;
    
    const saqueInsert = await client.query(`
      INSERT INTO saques (telegram_id, pontos_solicitados, valor_solicitado, chave_pix, status, data_solicitacao)
      VALUES ($1, $2, $3, $4, 'Aguardando Chat', NOW()) RETURNING id
    `, [telegram_id, pontos, valorCalculado.toFixed(2), emailLimpo]);

    const saqueId = saqueInsert.rows[0].id;

    await client.query("COMMIT");

    const mensagemTexto = isEn
      ? `⚠️ **Withdrawal Confirmation**\n\nYou requested a payout of **${parseFloat(pontos).toFixed(2)} Pts** to the email:\n\`${emailLimpo}\`\n\nDo you want to confirm this withdrawal?`
      : `⚠️ **Confirmação de Saque**\n\nVocê solicitou o resgate de **${parseFloat(pontos).toFixed(2)} Pts** para o e-mail:\n\`${emailLimpo}\`\n\nDeseja confirmar este saque?`;

    const btnConfirmar = isEn ? "✅ Confirm Withdrawal" : "✅ Confirmar Saque";
    const btnCancelar = isEn ? "❌ Cancel" : "❌ Cancelar";

    if (typeof bot !== 'undefined' && bot.telegram) {
      await bot.telegram.sendMessage(telegram_id, mensagemTexto, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: btnConfirmar, callback_data: `conf_saque_${saqueId}` },
              { text: btnCancelar, callback_data: `canc_saque_${saqueId}` }
            ]
          ]
        }
      });
    }

    res.json({ success: true, message: "Verifique seu chat do Telegram para confirmar o saque." });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`[ERRO SAQUE] Usuário: ${telegram_id}, Erro: ${err.message}`);
    
    const msg = err.message === "USUARIO_NAO_ENCONTRADO" ? "Usuário não encontrado." :
                err.message === "LIMITE_ATINGIDO" ? "Limite diário atingido." :
                err.message === "PONTOS_INSUFICIENTES" ? "Pontos insuficientes." :
                "Erro interno ao processar saque.";
                
    res.status(400).json({ error: msg });
  } finally {
    client.release();
  }
});

app.get("/api/saques", async (req, res) => {
  const { telegram_id } = req.query;

  if (!telegram_id) {
    return res.status(400).json({ error: "telegram_id é obrigatório" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, pontos_solicitados, valor_solicitado, status, data_solicitacao, comprovante 
       FROM saques 
       WHERE telegram_id = $1 
       ORDER BY data_solicitacao DESC`,
      [telegram_id]
    );

    res.json(rows);
  } catch (err) {
    console.error("Erro ao buscar histórico de saques:", err.message);
    res.status(500).json({ error: "Erro ao buscar histórico de saques" });
  }
});



// 🔹 7. trafico e mensurização
app.post('/api/log-traffic', async (req, res) => {
    // Adicionamos o telegram_id para fechar o ciclo de rastreio
    const { utm_source, utm_medium, utm_campaign, is_converted, telegram_id } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    
    try {
        const query = `
            INSERT INTO traffic_logs (telegram_id, utm_source, utm_medium, utm_campaign, is_converted, ip, data_registro)
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
        `;
        const values = [telegram_id || null, utm_source, utm_medium, utm_campaign, !!is_converted, ip];
        
        await pool.query(query, values);
        
        res.status(200).json({ success: true });
    } catch (err) {
        console.error("Erro ao salvar log de tráfego:", err.message);
        res.status(500).json({ error: "Erro interno ao salvar log" });
    }
});


// 🔹 8. Anúncios

// Usuário envia pedido de anúncio (salva em anuncios_pedidos)
app.post("/api/anuncios/pedidos", async (req, res) => {
  const { tipo, descricao, link, nome, contato } = req.body;

  try {
    await pool.query(
      `INSERT INTO anuncios_pedidos (tipo, descricao, link, nome, contato, status, data_registro)
       VALUES ($1, $2, $3, $4, $5, 'pending', NOW())`,
      [tipo, descricao, link, nome, contato]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Erro ao salvar pedido de anúncio:", err);
    res.status(500).json({ erro: "Erro ao salvar pedido" });
  }
});

// Frontend consulta anúncios ativos por posição
app.get("/api/anuncios", async (req, res) => {
  const { posicao } = req.query;
  try {
    // Corrigido: Substituído created_at por data_registro
    const { rows } = await pool.query(
      `SELECT id, titulo, tipo, descricao, link_url, imagem_url, posicao, prioridade
       FROM anuncios 
       WHERE ativo = true 
       AND posicao = $1 
       AND NOW() BETWEEN data_inicio AND data_fim
       ORDER BY prioridade DESC, data_registro DESC`,
      [posicao]
    );
    res.json(rows.length ? rows : [{ titulo: "Anuncie aqui", posicao }]);
  } catch (err) {
    console.error("Erro ao buscar anúncios:", err);
    res.status(500).json({ erro: "Erro ao buscar anúncios" });
  }
});

// POST /api/anuncio-evento
app.post("/api/anuncio-evento", async (req, res) => {
  const { anuncio_id, tipo } = req.body;

  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const userAgent = req.headers["user-agent"];

  try {
    // Adicionado data_registro conforme padrão do dossiê
    await pool.query(
      `INSERT INTO anuncios_eventos (anuncio_id, tipo, ip, user_agent, data_registro)
       VALUES ($1, $2, $3, $4, NOW())`,
      [anuncio_id, tipo, ip, userAgent]
    );
    res.sendStatus(200);
  } catch (err) {
    console.error("Erro evento anúncio:", err);
    res.status(500).send("erro");
  }
});

// =========================================================================
// 🔹 9. Admin - Gestão de Pedidos e Aprovações (FaucetPay)
// =========================================================================

// Middleware de segurança (protege todas as rotas admin)
function verificarAdmin(req, res, next) {
  const senha = req.headers["x-admin-key"];
  if (!senha || senha !== process.env.ADMIN_KEY) {
    return res.status(403).send("❌ Acesso negado");
  }
  next();
}

// Admin - Gestão de Pedidos e Aprovações

// Admin lista pedidos pendentes (anuncios_pedidos)
app.get("/admin/anuncios/pending", verificarAdmin, async (req, res) => {
  try {
    // Agora ordenado por data_registro para mostrar os mais recentes primeiro
    const { rows } = await pool.query(
      "SELECT id, tipo, descricao, link, nome, contato, status, data_registro FROM anuncios_pedidos WHERE status = 'pending' ORDER BY data_registro DESC"
    );
    res.json(rows);
  } catch (err) {
    console.error("Erro ao listar pedidos:", err);
    res.status(500).send("Erro ao listar pedidos.");
  }
});

// Admin aprova pedido como tarefa (insere em tarefas)
app.post("/admin/tarefa", verificarAdmin, async (req, res) => {
  const { titulo, link, pontos } = req.body;
  try {
    // Inserido data_registro
    await pool.query(
      "INSERT INTO tarefas (titulo, link, pontos, ativa, status, data_registro) VALUES ($1, $2, $3, true, 'ativo', NOW())",
      [titulo, link, pontos]
    );
    res.send("✅ Tarefa criada com sucesso!");
  } catch (err) {
    console.error("Erro ao criar tarefa:", err.message);
    res.status(500).send("Erro ao criar tarefa.");
  }
});

// Admin aprova pedido como banner (insere em anuncios)
app.post("/admin/anuncio", verificarAdmin, async (req, res) => {
  const { pedido_id, titulo, tipo, descricao, link_url, imagem_url, anunciante, posicao, prioridade, data_inicio, data_fim } = req.body;
  try {
    // Inserido data_registro
    await pool.query(
      `INSERT INTO anuncios (titulo, tipo, descricao, link_url, imagem_url, anunciante, posicao, prioridade, data_inicio, data_fim, ativo, data_registro)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, NOW())`,
      [titulo, tipo, descricao, link_url, imagem_url, anunciante, posicao, prioridade || 0, data_inicio, data_fim]
    );
    await pool.query("UPDATE anuncios_pedidos SET status = 'aprovado' WHERE id = $1", [pedido_id]);
    res.send("✅ Anúncio aprovado e ativado!");
  } catch (err) {
    console.error("Erro ao aprovar anúncio:", err.message);
    res.status(500).send("Erro ao aprovar anúncio.");
  }
});

// Admin recusa pedido (remove de anuncios_pedidos)
app.delete("/admin/anuncios/:id", verificarAdmin, async (req, res) => {
  try {
    // Mantido DELETE, mas agora temos a data_registro caso precise de auditoria futura (soft delete)
    await pool.query("DELETE FROM anuncios_pedidos WHERE id = $1", [req.params.id]);
    res.send("❌ Pedido recusado e removido.");
  } catch (err) {
    console.error("Erro ao recusar pedido:", err);
    res.status(500).send("Erro ao recusar pedido.");
  }
});


// Admin lista todos os anúncios ativos (com colunas explícitas)
app.get("/admin/anuncios/ativos", verificarAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, titulo, tipo, posicao, prioridade, ativo, data_inicio, data_fim, data_registro 
       FROM anuncios ORDER BY data_registro DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error("Erro ao listar anúncios ativos:", err);
    res.status(500).send("Erro ao listar anúncios ativos.");
  }
});

// Admin altera posição/local do banner
app.patch("/admin/anuncio/:id/posicao", verificarAdmin, async (req, res) => {
  const { posicao } = req.body;
  try {
    await pool.query("UPDATE anuncios SET posicao = $1 WHERE id = $2", [posicao, req.params.id]);
    res.send("📍 Posição atualizada!");
  } catch (err) {
    console.error("Erro ao atualizar posição:", err);
    res.status(500).send("Erro ao atualizar posição.");
  }
});

// Admin desativa/ativa banner
app.patch("/admin/anuncio/:id/status", verificarAdmin, async (req, res) => {
  const { ativo } = req.body;
  try {
    await pool.query("UPDATE anuncios SET ativo = $1 WHERE id = $2", [ativo, req.params.id]);
    res.send(ativo ? "✅ Banner ativado!" : "🚫 Banner desativado!");
  } catch (err) {
    console.error("Erro ao atualizar status:", err);
    res.status(500).send("Erro ao atualizar status.");
  }
});

// Admin exclui banner ativo (Integridade Referencial)
app.delete("/admin/anuncio/:id", verificarAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    
    // Para evitar registros órfãos, deletamos primeiro os eventos vinculados ao anúncio
    await client.query("DELETE FROM anuncios_eventos WHERE anuncio_id = $1", [req.params.id]);
    
    // Depois deletamos o anúncio
    await client.query("DELETE FROM anuncios WHERE id = $1", [req.params.id]);
    
    await client.query("COMMIT");
    res.send("❌ Banner e seus eventos excluídos com sucesso!");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Erro ao excluir banner:", err);
    res.status(500).send("Erro ao excluir banner.");
  } finally {
    client.release();
  }
});


// 🔹 9. Admin - Métricas e Relatórios de Desempenho

// Métricas de um anúncio específico
app.get("/api/admin/anuncio-metricas/:id", verificarAdmin, async (req, res) => {
  const anuncioId = req.params.id;

  try {
    // Consulta otimizada: foco na contagem por tipo de evento
    const result = await pool.query(
      `SELECT tipo, COUNT(*) AS total
       FROM anuncios_eventos
       WHERE anuncio_id = $1
       GROUP BY tipo`,
      [anuncioId]
    );

    const metrics = { visita: 0, clique: 0, contato: 0 };
    result.rows.forEach(r => {
      // Garantindo que convertemos de BigInt para Number para JSON
      metrics[r.tipo] = Number(r.total);
    });

    res.json(metrics);
  } catch (err) {
    console.error("Erro métricas admin:", err);
    res.status(500).send("Erro ao buscar métricas.");
  }
});

// Ranking geral de todos os anúncios (Otimizado com índices)
app.get("/api/admin/anuncios-metricas", verificarAdmin, async (req, res) => {
  try {
    // Query reestruturada para usar o agrupamento de forma eficiente
    // e respeitando a estrutura do nosso Dossiê
    const result = await pool.query(`
      SELECT 
        a.id, 
        a.titulo,
        COALESCE(SUM(CASE WHEN e.tipo='visita' THEN 1 ELSE 0 END), 0)::INT AS visitas,
        COALESCE(SUM(CASE WHEN e.tipo='clique' THEN 1 ELSE 0 END), 0)::INT AS cliques,
        COALESCE(SUM(CASE WHEN e.tipo='contato' THEN 1 ELSE 0 END), 0)::INT AS contatos
      FROM anuncios a
      LEFT JOIN anuncios_eventos e ON a.id = e.anuncio_id
      GROUP BY a.id, a.titulo
      ORDER BY a.id DESC;
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("Erro listar métricas admin:", err);
    res.status(500).send("Erro ao listar métricas.");
  }
});


app.post("/admin/sql", async (req, res) => {
  const senhaEnviada = req.headers["x-admin-key"];
  const senhaCorreta = process.env.ADMIN_KEY;


  // 🔐 Verificação de acesso
  if (!senhaEnviada || senhaEnviada !== senhaCorreta) {
    console.log("❌ Falha na autenticação!");
    return res.status(403).send("❌ Acesso negado");
  }

  const { sql } = req.body;

  // ⚠️ Validação básica
  if (!sql || typeof sql !== "string") {
    return res.status(400).send("SQL inválido");
  }

  try {
    const { rows } = await pool.query(sql);
    res.json(rows);
  } catch (err) {
    console.error("Erro SQL:", err.message);
    res.status(400).send("Erro SQL: " + err.message);
  }
});



app.post("/api/pagar-saque", async (req, res) => {
  const senhaEnviada = req.headers["x-admin-key"];
  const { saque_id } = req.body;

  if (!senhaEnviada || senhaEnviada !== process.env.ADMIN_KEY) {
    console.log("❌ Tentativa de pagamento sem autorização");
    return res.status(403).send("❌ Acesso negado");
  }

  try {
    const saqueResult = await pool.query(`
      SELECT s.*, u.lang 
      FROM saques s
      JOIN usuarios u ON s.telegram_id = u.telegram_id
      WHERE s.id = $1 AND s.status = 'Waiting'
    `, [saque_id]);

    if (saqueResult.rows.length === 0) {
      return res.status(404).json({ error: "Saque não encontrado ou já processado." });
    }
    
    const saque = saqueResult.rows[0];
    const isEn = saque.lang === 'en';

    const TAXA_PONTO_LTC = 0.000001; 
    const amountEmSatoshis = Math.round((parseFloat(saque.pontos_solicitados) * TAXA_PONTO_LTC) * 100000000);

    const response = await axios.post("https://faucetpay.io/api/v1/send", new URLSearchParams({
      api_key: FAUCETPAY_API_KEY, 
      amount: amountEmSatoshis,
      to: saque.chave_pix,       
      currency: "LTC"
    }).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (response.data.status === 200) {
      const payoutId = response.data.payout_id;

      await pool.query(
        "UPDATE saques SET status = 'ok', comprovante = $1, data_aprovacao = NOW() WHERE id = $2",
        [payoutId, saque_id]
      );
      
      const linkComprovante = `https://faucetpay.io/payout/${payoutId}`;
      const pontosFormatados = parseFloat(saque.pontos_solicitados).toFixed(2);

      const mensagemSucesso = isEn
        ? `🎉 **Withdrawal Paid Successfully!**\n\nYour payout of **${pontosFormatados} Pts** has been sent to your FaucetPay account.\n\n🔗 [View Receipt on FaucetPay](${linkComprovante})`
        : `🎉 **Saque Pago com Sucesso!**\n\nSeu pagamento de **${pontosFormatados} Pts** foi enviado para a sua conta FaucetPay.\n\n🔗 [Ver Comprovante na FaucetPay](${linkComprovante})`;

      try {
        await bot.telegram.sendMessage(saque.telegram_id, mensagemSucesso, {
          parse_mode: "Markdown",
          disable_web_page_preview: true
        });
      } catch (telegramErr) {
        console.error(`⚠️ Erro ao enviar aviso de pagamento no chat do usuário ${saque.telegram_id}:`, telegramErr.message);
      }

      res.json({ success: true, tx: payoutId });
    } else {
      console.error("❌ Erro FaucetPay:", response.data.message);
      res.status(400).json({ error: "Erro FaucetPay: " + response.data.message });
    }

  } catch (err) {
    console.error("❌ Erro fatal ao pagar saque:", err.message);
    res.status(500).json({ error: "Erro interno do servidor ao processar pagamento." });
  }
});

// =========================================================================
// 🔹 10. Telegram Bot Core (Estrutura Otimizada com Telegraf)
// =========================================================================
bot.start(async (ctx) => {
  const textoMatch = ctx.message.text.split(' ');
  const indicadorId = textoMatch[1] ? textoMatch[1] : "0";

  const keyboard = {
    inline_keyboard: [
      [{ text: "🇧🇷 Português", callback_data: `lang_pt_${indicadorId}` }],
      [{ text: "🇺🇸 English", callback_data: `lang_en_${indicadorId}` }]
    ]
  };

  await ctx.reply("Escolha seu idioma / Choose your language:", { reply_markup: keyboard });
});

bot.action(/^lang_(pt|en)_(.+)$/, async (ctx) => {
  const lang = ctx.match[1];
  const indicadorId = ctx.match[2];
  
  const indicadoId = ctx.from.id;
  const nome = ctx.from.first_name;

  try {
    await pool.query('BEGIN');

    await pool.query(
      `INSERT INTO usuarios (telegram_id, nome, lang, data_registro)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (telegram_id) DO UPDATE SET lang = EXCLUDED.lang`,
      [indicadoId, nome, lang]
    );

    await pool.query(
      `INSERT INTO usuarios_streaks (telegram_id, streak_atual, meta_cumprida_hoje, bau_disponivel, data_registro)
       VALUES ($1, 0, FALSE, FALSE, NOW())
       ON CONFLICT (telegram_id) DO NOTHING`,
      [indicadoId]
    );

    const check = await pool.query("SELECT id FROM indicacoes WHERE id_indicado = $1", [indicadoId]);
    if (check.rowCount === 0) {
      await pool.query(
        `INSERT INTO indicacoes (id_indicador, id_indicado, data_registro, pontos_ativados)
         VALUES ($1, $2, NOW(), false)`,
        [indicadorId, indicadoId]
      );
    }

    await pool.query('COMMIT');

    const saldo = await getSaldoUsuario(indicadoId);
    let texto = (saldo === 0 && check.rowCount === 0) 
      ? dicionario[lang].boas_vindas_novo 
      : dicionario[lang].boas_vindas_recorrente.replace("{saldo}", saldo);

    await ctx.editMessageText(texto, {
      reply_markup: {
        inline_keyboard: [[
          {
            text: dicionario[lang].btn_app,
            web_app: { url: `${process.env.APP_DOMAIN}/?id=${indicadoId}&lang=${lang}` }
          }
        ]]
      }
    });

  } catch (err) {
    console.error("Erro no processamento do idioma:", err);
    await ctx.reply(dicionario[lang || 'en'].erro);
  }
});

bot.action(/conf_saque_(\d+)/, async (ctx) => {
  const saqueId = ctx.match[1];
  const telegram_id = ctx.from.id.toString();

  try {
    await ctx.answerCbQuery("Processando...");
  } catch (e) {}

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const userRes = await client.query("SELECT lang FROM usuarios WHERE telegram_id = $1", [telegram_id]);
    const isEn = userRes.rows[0]?.lang === 'en';

    const saqueRes = await client.query(
      "SELECT * FROM saques WHERE id = $1 AND telegram_id = $2 AND status = 'Aguardando Chat' FOR UPDATE",
      [saqueId, telegram_id]
    );

    if (saqueRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return ctx.editMessageText(isEn ? "⚠️ This withdrawal request is no longer available or was already processed." : "⚠️ Este pedido de saque não está mais disponível ou já foi processado.");
    }

    const saque = saqueRes.rows[0];

    // 1. Debita os pontos do usuário de verdade AGORA que ele confirmou
    await client.query("UPDATE usuarios SET pontos = pontos - $1 WHERE telegram_id = $2", [saque.pontos_solicitados, telegram_id]);

    // 2. Registra a saída no histórico de ganhos
    await client.query(`
      INSERT INTO historico_ganhos (telegram_id, origem, pontos, nome_tarefa, referencia_id, data_registro)
      VALUES ($1, 'saque', $2, 'Saque Solicitado', $3, NOW())
    `, [telegram_id, -Math.abs(saque.pontos_solicitados), saqueId]);

    // 3. Altera o status para 'Waiting' (Exatamente como o seu painel admin espera encontrar)
    await client.query("UPDATE saques SET status = 'Waiting' WHERE id = $1", [saqueId]);

    await client.query("COMMIT");

    await ctx.editMessageText(isEn 
      ? `✅ **Withdrawal Confirmed Successfully!**\n\nYour request has been queued for payment.`
      : `✅ **Saque Confirmado com Sucesso!**\n\nSeu pedido foi enfileirado para pagamento no painel!`
    );

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Erro ao confirmar saque via chat:", err);
  } finally {
    client.release();
  }
});

bot.action(/canc_saque_(\d+)/, async (ctx) => {
  const saqueId = ctx.match[1];
  const telegram_id = ctx.from.id.toString();

  try {
    await ctx.answerCbQuery("Cancelando...");
  } catch (e) {}

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const userRes = await client.query("SELECT lang FROM usuarios WHERE telegram_id = $1", [telegram_id]);
    const isEn = userRes.rows[0]?.lang === 'en';

    const saqueRes = await client.query(
      "SELECT * FROM saques WHERE id = $1 AND telegram_id = $2 AND status = 'Aguardando Chat' FOR UPDATE",
      [saqueId, telegram_id]
    );

    if (saqueRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return ctx.editMessageText(isEn ? "⚠️ This withdrawal request cannot be cancelled." : "⚠️ Este pedido de saque não pode mais ser cancelado.");
    }

    // Apenas marca como cancelado (como os pontos nunca tinham saído, não precisa estornar)
    await client.query("UPDATE saques SET status = 'Cancelado' WHERE id = $1", [saqueId]);

    await client.query("COMMIT");

    await ctx.editMessageText(isEn 
      ? "❌ Withdrawal request cancelled." 
      : "❌ Pedido de saque cancelado."
    );

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Erro ao cancelar saque via chat:", err);
  } finally {
    client.release();
  }
});


// =========================================================================
// 🔹 AUTOMATIZAÇÃO DE COTAÇÕES (1 VEZ AO DIA ÀS 12:00 DE BRASÍLIA)
// =========================================================================

const VALOR_BASE = {
  valor_ltc: 0.00010309,
  valor_usd: 0.00909091,
  valor_zer: 2.50000000,
  valor_brl: 0.05000000
};

const LIMIAR_VARIACAO_PERCENTUAL = 10.0; 

async function atualizarCotacoesAutomaticamente() {
  try {
    console.log("🔄 [COTAÇÕES] Consultando valor atual do Litecoin (LTC) na API...");

    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd,brl');
    const data = response.data;
    
    if (!data.litecoin) {
      console.error("❌ [COTAÇÕES] Erro: Dados do Litecoin não retornados pela API.");
      return;
    }

    const precoLtcUsdAtual = data.litecoin.usd;
    const precoLtcBrlAtual = data.litecoin.brl;

    const valorBrlPorPonto = VALOR_BASE.valor_brl;
    const valorUsdPorPonto = valorBrlPorPonto / (precoLtcBrlAtual / precoLtcUsdAtual); 
    const valorLtcPorPonto = valorBrlPorPonto / precoLtcBrlAtual;
    const valorZerPorPonto = VALOR_BASE.valor_zer; 

    const valLtcStr = valorLtcPorPonto.toFixed(18);
    const valUsdStr = valorUsdPorPonto.toFixed(18);
    const valZerStr = valorZerPorPonto.toFixed(18);
    const valBrlStr = valorBrlPorPonto.toFixed(18);

    const ultimaCotacaoRes = await pool.query(
      "SELECT * FROM cotacoes ORDER BY data_registro DESC, id DESC LIMIT 1"
    );

    let registrarNoBanco = true;

    if (ultimaCotacaoRes.rows.length > 0) {
      const ultima = ultimaCotacaoRes.rows[0];
      const ltcAnterior = parseFloat(ultima.valor_ltc);
      const ltcNovo = parseFloat(valLtcStr);

      const variacaoPercentual = Math.abs(((ltcNovo - ltcAnterior) / ltcAnterior) * 100);

      console.log(`📊 [COMPARAÇÃO] LTC Anterior: ${ltcAnterior} | LTC Novo: ${ltcNovo} | Variação: ${variacaoPercentual.toFixed(2)}%`);

      if (variacaoPercentual >= LIMIAR_VARIACAO_PERCENTUAL) {
        console.warn(`🚨 [ALERTA DE PREJUÍZO] O Litecoin mudou ${variacaoPercentual.toFixed(2)}% em relação ao último registro!`);
      }

      const dataHoje = new Date().toISOString().split('T')[0];
      const dataUltimoRegistro = new Date(ultima.data_registro).toISOString().split('T')[0];

      if (dataUltimoRegistro === dataHoje) {
        console.log("ℹ️ [COTAÇÕES] Já existe cotação registrada para hoje. Pulando inserção diária.");
        registrarNoBanco = false; 
      }
    } else {
      console.log("📌 [COTAÇÕES] Tabela vazia. Inserindo valor base inicial...");
      await pool.query(
        `INSERT INTO cotacoes (valor_ltc, valor_usd, valor_zer, valor_brl, data_registro) 
         VALUES ($1, $2, $3, $4, CURRENT_DATE)`,
        [VALOR_BASE.valor_ltc, VALOR_BASE.valor_usd, VALOR_BASE.valor_zer, VALOR_BASE.valor_brl]
      );
      return;
    }

    if (registrarNoBanco) {
      await pool.query(
        `INSERT INTO cotacoes (valor_ltc, valor_usd, valor_zer, valor_brl, data_registro) 
         VALUES ($1, $2, $3, $4, CURRENT_DATE)`,
        [valLtcStr, valUsdStr, valZerStr, valBrlStr]
      );
      console.log(`✅ [COTAÇÕES] Cotação diária salva com sucesso! 1 Ponto = ${valLtcStr} LTC`);
    }

  } catch (error) {
    console.error("❌ [COTAÇÕES] Erro ao atualizar cotações automaticamente:", error.message);
  }
}

// ⏱️ Agendado para rodar todos os dias às 15:00 UTC (que equivale exatamente às 12:00 no Horário de Brasília)
cron.schedule('0 15 * * *', () => {
  atualizarCotacoesAutomaticamente();
});

// Executa uma vez ao iniciar o servidor para checar se já existe cotação do dia
atualizarCotacoesAutomaticamente();



// =========================================================================
// 🔹 11, 12, 13, 14. CRON JOBS E ROTINAS DIÁRIAS
// =========================================================================
async function dispararEngajamento(lang, tipo) {
  try {
    let query;
    if (tipo === 'inativo') {
      query = `SELECT u.telegram_id 
               FROM usuarios u 
               WHERE u.lang = $1 
               AND NOT EXISTS (SELECT 1 FROM historico_ganhos h WHERE h.telegram_id = u.telegram_id AND h.data_registro > NOW() - INTERVAL '48 hours')`;
    } else {
      query = `SELECT u.telegram_id 
               FROM usuarios u 
               WHERE u.lang = $1 
               AND EXISTS (SELECT 1 FROM historico_ganhos h WHERE h.telegram_id = u.telegram_id AND h.data_registro > NOW() - INTERVAL '48 hours')
               AND NOT EXISTS (SELECT 1 FROM historico_ganhos h WHERE h.telegram_id = u.telegram_id AND h.data_registro > NOW() - INTERVAL '24 hours')`;
    }

    const { rows } = await pool.query(query, [lang]);
    console.log(`🚀 Disparando ${tipo} (${lang}): ${rows.length} usuários.`);

    for (const u of rows) {
      const isPt = lang === 'pt';
      const mensagem = tipo === 'inativo' 
        ? (isPt ? "👋 Olá! São apenas 2 minutos para ganhar seus primeiros pontos no LucreMaisTask. Não perca essa chance!" : "👋 Hello! It only takes 2 minutes to earn your first points on CashTaskBot. Don't miss out!")
        : (isPt ? "🚀 Você está indo bem! Faltam poucas tarefas para seu bônus de consistência. Volte agora e garanta seus pontos!" : "🚀 You're doing great! Only a few tasks left for your consistency bonus. Come back now and secure your points!");

      const btnText = isPt ? "📲 Fazer Tarefas Agora" : "📲 Complete Tasks Now";

      await bot.telegram.sendMessage(u.telegram_id, mensagem, {
        reply_markup: {
          inline_keyboard: [[
            { text: btnText, web_app: { url: `${process.env.APP_DOMAIN}/tarefas.html?id=${u.telegram_id}&lang=${lang}` } }
          ]]
        }
      }).catch(e => console.error(`Erro ao enviar para ${u.telegram_id}:`, e.message));
    }
  } catch (err) {
    console.error(`Erro no disparo ${tipo} (${lang}):`, err);
  }
}

cron.schedule("0 10 * * *", async () => {
  await dispararEngajamento('pt', 'inativo');
  await dispararEngajamento('pt', 'iniciante');
}, { timezone: "America/Sao_Paulo" });

cron.schedule("0 10 * * *", async () => {
  await dispararEngajamento('en', 'inativo');
  await dispararEngajamento('en', 'iniciante');
}, { timezone: "America/New_York" });

cron.schedule("0 12 * * *", async () => {
  try {
    const query = `
      SELECT h.telegram_id, u.lang 
      FROM historico_compras h
      JOIN usuarios u ON h.telegram_id = u.telegram_id
      WHERE u.vip = true 
      AND h.data_registro::date = (CURRENT_DATE - INTERVAL '10 days')
      AND NOT EXISTS (
        SELECT 1 FROM roleta_tickets rt 
        WHERE rt.telegram_id = h.telegram_id 
        AND rt.data_registro = CURRENT_DATE
      )
    `;

    const { rows } = await pool.query(query);

    for (const row of rows) {
      const tickets = 5; 
      const mensagem = row.lang === 'pt' 
        ? `🎁 Parabéns! Você é um VIP fiel e completou 10 dias conosco. Ganhou ${tickets} tickets para a roleta!`
        : `🎁 Congrats! You've been a loyal VIP for 10 days. Enjoy ${tickets} free spins on the wheel!`;

      await pool.query(
        "INSERT INTO roleta_tickets (telegram_id, data_registro, usado) VALUES ($1, CURRENT_DATE, false)",
        [row.telegram_id]
      );

      await bot.telegram.sendMessage(row.telegram_id, mensagem);
    }
  } catch (err) {
    console.error("Erro no cron de fidelidade:", err);
  }
});

cron.schedule('5 0 * * *', async () => {
    console.log("🕒 Iniciando processamento diário de streaks e XP com proteção de escudos...");
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        await client.query(`
            UPDATE usuarios_streaks us
            SET 
                streak_quebrado = CASE 
                    WHEN us.meta_cumprida_hoje = FALSE 
                         AND us.streak_atual > 0 
                         AND (u.escudos = 0 OR u.escudos IS NULL) THEN TRUE 
                    ELSE FALSE 
                END,
                
                streak_atual = CASE 
                    WHEN us.meta_cumprida_hoje = TRUE THEN us.streak_atual + 1 
                    WHEN (u.escudos > 0 AND us.meta_cumprida_hoje = FALSE) THEN us.streak_atual 
                    ELSE 0 
                END,
                
                bau_disponivel = CASE 
                    WHEN (us.streak_atual + (CASE WHEN us.meta_cumprida_hoje = TRUE THEN 1 ELSE 0 END)) >= 7 THEN TRUE 
                    ELSE us.bau_disponivel 
                END,
                
                meta_cumprida_hoje = FALSE
            FROM usuarios u
            WHERE us.telegram_id = u.telegram_id
        `);

        await client.query(`
            UPDATE usuarios 
            SET escudos = escudos - 1
            WHERE telegram_id IN (
                SELECT us.telegram_id 
                FROM usuarios_streaks us 
                WHERE us.meta_cumprida_hoje = FALSE 
                AND us.streak_atual > 0 
                AND escudos > 0
            )
        `);

        await client.query(`
            UPDATE usuarios 
            SET xp = FLOOR(xp * 0.90),
                nivel = FLOOR(SQRT(FLOOR(xp * 0.90) / 100)) + 1
            WHERE (escudos = 0 OR escudos IS NULL)
            AND telegram_id IN (
                SELECT us.telegram_id 
                FROM usuarios_streaks us 
                WHERE us.meta_cumprida_hoje = FALSE 
                AND us.streak_atual > 0
            )
        `);

        await client.query("COMMIT");
        console.log("✅ Processamento diário concluído com sucesso.");
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("❌ Erro fatal no processamento diário de streaks:", err);
    } finally {
        client.release();
    }
});

// Inicialização do Servidor e do Bot
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  bot.launch().then(() => {
    console.log("🤖 Telegram Bot iniciado com sucesso via Telegraf!");
  }).catch((err) => {
    console.error("❌ Erro ao iniciar o bot do Telegram:", err);
  });
});

// Encerramento gracioso
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
