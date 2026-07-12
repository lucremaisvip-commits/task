// 🔹 1. Configuração Inicial 
require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
// ❌ removido helmet por enquanto
const rateLimitLib = require("express-rate-limit"); // 🔥 renomeado para evitar conflito

const pool = require("./db");
const TelegramBot = require("node-telegram-bot-api");

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Confia no primeiro proxy (necessário no Render/Heroku/etc..)
app.set("trust proxy", 1);

// 🔒 2. CORS restrito (ajuste seu domínio)
app.use(cors({
  origin: [
    "https://task-test-nrdn.onrender.com",
    "https://highpay-ads.com"
  ],
  methods: ["GET", "POST"],
}));


// 🔒 3. Limite de requisições (anti spam)
const limiter = rateLimitLib({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 100, // 100 req por IP
});

app.use(limiter);

// 🔒 4. Limite de JSON (anti ataque)
app.use(express.json({
  limit: "10kb"
}));

const crypto = require("crypto");

// 🔒 5. funções de segurança para tarefas:

// 🔐 gerar token seguro
function gerarToken(telegram_id, tarefa_id) {
  return crypto
    .createHash("sha256")
    .update(telegram_id + tarefa_id + Date.now() + Math.random())
    .digest("hex");
}

// 🚫 rate limit simples (memória)
const rateLimitMemory = {};

function checkRateLimit(user) {
  const now = Date.now();

  if (!rateLimitMemory[user]) {
    rateLimitMemory[user] = now;
    return true;
  }

  if (now - rateLimitMemory[user] < 2000) {
    return false;
  }

  rateLimitMemory[user] = now;
  return true;
}

//6. Segurança do que é publico ou privado 

// 🔐 Middleware de segurança via URL (?key=...)
function verificarAdminHTML(req, res, next) {
  const senha = req.query.key;

  if (!senha || senha !== process.env.PRIVATE_KEY) {
    return res.status(403).send("❌ Acesso negado");
  }

  next();
}

// 📁 Servir páginas privadas (protegidas por ?key=)
app.use(
  "/private",
  verificarAdminHTML,
  express.static(path.join(__dirname, "private"))
);

// 📁 Servir arquivos públicos
app.use(express.static("public"));

// 🔹 2.WEBHOOK UNIFICADO (Stripe + Cakto Corrigido)
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
        // Usa o req.body bruto graças ao express.raw definido ali em cima
        stripeEvent = stripe.webhooks.constructEvent(req.body, stripeSignature, process.env.STRIPE_WEBHOOK_SECRET);
      } catch (err) {
        console.error("Erro na assinatura do Stripe:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      evento = stripeEvent.type;
      const session = stripeEvent.data.object;
      telegramId = session.client_reference_id;
      idTransacao = session.id;

    // 🥝 FLUXO CAKTO
    } else if (caktoToken && caktoToken === process.env.CAKTO_SECRET_TOKEN) {
      plataforma = "Cakto";
      // Como usamos express.raw, convertemos o body da Cakto em objeto manual aqui
      const body = JSON.parse(req.body.toString());
      
      evento = body.event; 
      telegramId = body.data ? body.data.utm_source : null; 
      idTransacao = body.data ? body.data.id : null;
      
    } else {
      return res.status(401).send("Não autorizado");
    }

    // Validação de segurança básica para o ID do usuário
    if (!telegramId) {
      console.log(`[Webhook ${plataforma}] Evento ${evento} recebido, mas sem ID de usuário (utm_source/client_reference_id vazio).`);
      return res.status(200).send("Sem ID de usuário associado.");
    }

    // 💰 1. PROCESSAMENTO DE PAGAMENTOS APROVADOS (Aprova VIP)
    if (evento === "checkout.session.completed" || evento === "purchase_approved") {
      const jaProcessado = await pool.query("SELECT 1 FROM historico_compras WHERE transacao_id = $1", [idTransacao]);
      if (jaProcessado.rows.length > 0) {
        return res.status(200).send("Já processado");
      }

      // Ativa o VIP e define falsos os bônus para o script de cron rodar depois
      await pool.query(
        "UPDATE usuarios SET vip = true, data_vip = NOW(), bonus_liberado = false WHERE telegram_id = $1",
        [telegramId]
      );

      await pool.query(
        "INSERT INTO historico_compras (transacao_id, telegram_id, plataforma, status, data_evento) VALUES ($1, $2, $3, $4, NOW())",
        [idTransacao, telegramId, plataforma, "approved"]
      );
      
      console.log(`[VIP ATIVADO] ${telegramId} via ${plataforma}`);
    }

    // 🚨 2. PROCESSAMENTO DE ESTORNOS/REEMBOLSOS (Remove VIP)
    const eventosReembolso = [
      "charge.refunded",       // Stripe
      "purchase_refunded",     // Cakto
      "purchase_chargedback"   // Cakto
    ];

    if (eventosReembolso.includes(evento)) {
      await pool.query("UPDATE usuarios SET vip = false WHERE telegram_id = $1", [telegramId]);
      
      // Atualiza o status no histórico para sabermos do reembolso
      await pool.query("UPDATE historico_compras SET status = 'refunded' WHERE transacao_id = $1", [idTransacao]);
      
      console.log(`[VIP REMOVIDO] ${telegramId} devido a reembolso na ${plataforma}`);
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("Erro interno no webhook:", error);
    res.status(500).send("Erro");
  }
});

// 🔹 3. Rotas de Tarefas (Modificadas para suportar Tarefas VIP)

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

    // 🔥 O filtro traz todas as comuns + as tarefas VIP se o usuário for VIP. 
    // Se não for VIP, traz apenas tarefas comuns (onde is_vip = false).
    const tarefasQuery = `
      SELECT 
        t.*, 
        CASE 
          WHEN tc.telegram_id IS NOT NULL THEN true 
          ELSE false 
        END AS concluida
      FROM tarefas t
      LEFT JOIN tarefas_concluidas tc 
        ON t.id = tc.tarefa_id
        AND tc.telegram_id = $1
        AND DATE(tc.data) = CURRENT_DATE
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
  let { telegram_id, tarefa_id, token, fingerprint } = req.body;

  telegram_id = String(telegram_id || "").trim();
  const tarefaId = Number(tarefa_id);

  if (!telegram_id || isNaN(tarefaId) || !token) {
    return res.status(400).json({ erro: "Dados inválidos" });
  }

  // 🚫 rate limit
  if (!checkRateLimit(telegram_id)) {
    return res.status(429).json({ erro: "Muitas requisições" });
  }

  // 🔒 captura IP corretamente no Render
  const ipHeader = req.headers["x-forwarded-for"];
  const ip = ipHeader ? ipHeader.split(",")[0].trim() : req.socket.remoteAddress;

  try {
    await pool.query("BEGIN");

    // 🔒 sessão
    const sessaoRes = await pool.query(
      `SELECT * FROM tarefas_sessoes 
       WHERE token = $1 FOR UPDATE`,
      [token]
    );

    if (sessaoRes.rows.length === 0) {
      await pool.query("ROLLBACK");
      return res.status(400).json({ erro: "Sessão inválida" });
    }

    const sessao = sessaoRes.rows[0];

    // 🔒 dono correto
    if (sessao.telegram_id !== telegram_id) {
      await pool.query("ROLLBACK");
      return res.status(403).json({ erro: "Acesso inválido" });
    }

    // 🔒 já usado
    if (sessao.status !== "aberto") {
      await pool.query("ROLLBACK");
      return res.status(400).json({ erro: "Token já usado" });
    }

    // 🔒 IP
    if (sessao.ip !== ip) {
      await pool.query("ROLLBACK");
      return res.status(403).json({ erro: "IP inválido" });
    }

    // 🔒 fingerprint
    if (sessao.fingerprint !== fingerprint) {
      await pool.query("ROLLBACK");
      return res.status(403).json({ erro: "Dispositivo inválido" });
    }

    // 🔒 tempo mínimo (15s)
    const tempo = Date.now() - new Date(sessao.criado_em).getTime();
    if (tempo < 15000) {
      await pool.query("ROLLBACK");
      return res.status(400).json({ erro: "Tempo insuficiente" });
    }

    // 🔒 tarefa válida
    const tarefa = await pool.query(
      `SELECT id, pontos, ativa, is_vip FROM tarefas WHERE id = $1`,
      [tarefaId]
    );

    if (tarefa.rows.length === 0 || !tarefa.rows[0].ativa) {
      await pool.query("ROLLBACK");
      return res.status(400).json({ erro: "Tarefa inválida" });
    }

    // 🔒 Proteção Extra Backend: Se a tarefa for VIP, valida se o usuário possui o VIP ativo
    if (tarefa.rows[0].is_vip) {
      const userCheck = await pool.query(
        "SELECT vip FROM usuarios WHERE telegram_id = $1",
        [telegram_id]
      );
      if (!userCheck.rows[0]?.vip) {
        await pool.query("ROLLBACK");
        return res.status(403).json({ erro: "Essa é uma tarefa VIP" });
      }
    }

    const pontos = tarefa.rows[0].pontos;

    // 🔒 duplicação
    const check = await pool.query(
      `SELECT 1 FROM tarefas_concluidas 
       WHERE telegram_id = $1 AND tarefa_id = $2 AND DATE(data) = CURRENT_DATE`,
      [telegram_id, tarefaId]
    );

    if (check.rows.length > 0) {
      await pool.query("ROLLBACK");
      return res.status(400).json({ erro: "Já concluída hoje" });
    }

    // 💰 recompensa do indicado
    await pool.query(
      `INSERT INTO tarefas_concluidas (telegram_id, tarefa_id, pontos, data)
       VALUES ($1, $2, $3, NOW())`,
      [telegram_id, tarefaId, pontos]
    );

    await pool.query(
      `UPDATE usuarios
       SET pontos = COALESCE(pontos, 0) + $1,
           tarefas_feitas = COALESCE(tarefas_feitas, 0) + 1
       WHERE telegram_id = $2`,
      [pontos, telegram_id]
    );

    // 🔹 Ativação da indicação
    const indicacaoRes = await pool.query(
      "SELECT * FROM indicacoes WHERE id_indicado = $1 AND pontos_ativados = false",
      [telegram_id]
    );

    if (indicacaoRes.rows.length > 0) {
      const indicacao = indicacaoRes.rows[0];

      // 🔥 conta direto das tarefas reais
      const tarefasRes = await pool.query(
        "SELECT COUNT(*) FROM tarefas_concluidas WHERE telegram_id = $1",
        [telegram_id]
      );

      const tarefasFeitas = parseInt(tarefasRes.rows[0].count);

      console.log("📊 Tarefas feitas:", tarefasFeitas);

      if (tarefasFeitas >= 3) {
        // Marca a indicação como ativada
        await pool.query(
          "UPDATE indicacoes SET pontos_ativados = true WHERE id = $1",
          [indicacao.id]
        );

        // Atualiza pontos e contador de indicações
        await pool.query(
          "UPDATE usuarios SET pontos = COALESCE(pontos,0) + 10, indicacoes = COALESCE(indicacoes,0) + 1 WHERE telegram_id = $1",
          [indicacao.id_indicador]
        );

        console.log(`🎉 Indicador ${indicacao.id_indicador} ganhou +10 pontos e +1 indicação!`);
      }
    }

    // 🔒 fecha sessão
    await pool.query(
      `UPDATE tarefas_sessoes 
       SET status = 'concluido', concluido_em = NOW()
       WHERE token = $1`,
      [token]
    );

    await pool.query("COMMIT");

    res.json({ mensagem: "✅ Concluído com segurança!" });

  } catch (err) {
    await pool.query("ROLLBACK");
    console.error("Erro:", err.message);
    res.status(500).json({ erro: "Erro interno" });
  }
});



app.post("/api/concluir-diaria", async (req, res) => {
  const { telegram_id } = req.body;

  if (!telegram_id || !/^\d+$/.test(telegram_id)) {
    return res.status(400).json({ erro: "ID inválido" });
  }

  try {
    // 🔍 Verifica se já fez hoje
    const check = await pool.query(
      `SELECT 1 FROM tarefas_diarias 
       WHERE telegram_id = $1 AND data = CURRENT_DATE`,
      [telegram_id]
    );

    if (check.rows.length > 0) {
      return res.status(400).json({ erro: "❌ Você já fez a tarefa diária hoje." });
    }

    const pontos = 1; // ajuste se quiser

    // 💾 Registra
    await pool.query(
      `INSERT INTO tarefas_diarias (telegram_id, data, pontos)
       VALUES ($1, CURRENT_DATE, $2)`,
      [telegram_id, pontos]
    );

    // 💰 Soma pontos no usuário
    await pool.query(
      `UPDATE usuarios
       SET pontos = COALESCE(pontos, 0) + $1
       WHERE telegram_id = $2`,
      [pontos, telegram_id]
    );

    res.json({ mensagem: "✅ Tarefa diária concluída!" });

  } catch (err) {
    console.error("Erro diária:", err.message);

    res.status(500).json({
      erro: "Erro ao concluir tarefa diária"
    });
  }
});


// 🔹 3.3 Roleta (Refatorada com Sistema de Tickets Seguros)


// 🎰 GIRAR ROLETA
app.post("/api/roleta/girar", async (req, res) => {
  const { telegram_id } = req.body;

  if (!telegram_id || typeof telegram_id !== "string") {
    return res.status(400).json({ erro: "telegram_id inválido" });
  }

  const premios = [
    { tipo: "pontos", valor: 2, chance: 30 },
    { tipo: "pontos", valor: 5, chance: 25 },
    { tipo: "pontos", valor: 10, chance: 15 },
    { tipo: "pontos", valor: 15, chance: 10 },
    { tipo: "pontos", valor: 20, chance: 5 },
    { tipo: "pontos", valor: 30, chance: 2 },
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

    // 👤 Buscar usuário e bloquear para evitar Race Condition de saldo
    const userRes = await client.query(
      "SELECT pontos, vip FROM usuarios WHERE telegram_id = $1 FOR UPDATE",
      [telegram_id]
    );

    if (userRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ erro: "Usuário não encontrado" });
    }

    const user = userRes.rows[0];

    // 📊 Limite diário geral de giros (Evita abuso mesmo se tiver infinitos tickets)
    const limiteGiros = 5;
    const girosHoje = await client.query(
      `SELECT COUNT(*) FROM roleta_giros 
       WHERE telegram_id = $1 
       AND DATE(created_at) = CURRENT_DATE`,
      [telegram_id]
    );

    if (parseInt(girosHoje.rows[0].count) >= limiteGiros) {
      await client.query("ROLLBACK");
      return res.status(400).json({ erro: "Limite diário de 5 giros atingido" });
    }

    // 🎟️ VALIDAÇÃO DE TICKETS DISPONÍVEIS
    const ticketCheck = await client.query(
      `SELECT id FROM roleta_tickets 
       WHERE telegram_id = $1 AND usado = false 
       ORDER BY id ASC LIMIT 1 FOR UPDATE`,
      [telegram_id]
    );

    let gratis = false;
    let ticketIdUsado = null;

    if (ticketCheck.rows.length > 0) {
      gratis = true;
      ticketIdUsado = ticketCheck.rows[0].id;
    }

    // 💰 Processamento de Cobrança (Paga ou consome Ticket)
    if (gratis) {
      // Consome o ticket alterando para usado
      await client.query(
        "UPDATE roleta_tickets SET usado = true, data = CURRENT_DATE WHERE id = $1",
        [ticketIdUsado]
      );
    } else {
      // Se não tem ticket disponível, desconta 10 pontos do saldo
      if (user.pontos < 10) {
        await client.query("ROLLBACK");
        return res.status(400).json({ erro: "Pontos insuficientes (Você precisa de 10 pontos ou 1 Ticket)" });
      }

      await client.query(
        "UPDATE usuarios SET pontos = pontos - 10 WHERE telegram_id = $1",
        [telegram_id]
      );
    }

    // 🎯 Executa Sorteio
    const premio = sortearPremio();

    if (premio.tipo === "pontos") {
      await client.query(
        "UPDATE usuarios SET pontos = pontos + $1 WHERE telegram_id = $2",
        [premio.valor, telegram_id]
      );
    }

    // 🔥 Nome amigável para o front-end
    const nomePremio = premio.tipo === "pontos" ? `${premio.valor} Pontos` : "Tente Novamente";

    // 📝 Salva o histórico de giros
    await client.query(
      `INSERT INTO roleta_giros 
      (telegram_id, premio, pontos_ganhos, gratis) 
      VALUES ($1, $2, $3, $4)`,
      [telegram_id, nomePremio, premio.valor, gratis]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      premio: nomePremio,
      valor: premio.valor,
      tipo: premio.tipo,
      gratis
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

  if (!telegram_id) {
    return res.status(400).json({ erro: "telegram_id obrigatório" });
  }

  try {
    // Quantidade de giros que ele já realizou hoje
    const giros = await pool.query(
      `SELECT COUNT(*) FROM roleta_giros 
       WHERE telegram_id = $1 
       AND DATE(created_at) = CURRENT_DATE`,
      [telegram_id]
    );

    // Conta quantos tickets válidos (não usados) o usuário tem guardados na carteira
    const ticketsDisponiveis = await pool.query(
      `SELECT COUNT(*) FROM roleta_tickets 
       WHERE telegram_id = $1 AND usado = false`,
      [telegram_id]
    );

    res.json({
      giros: parseInt(giros.rows[0].count),
      tickets: parseInt(ticketsDisponiveis.rows[0].count) // Retorna a contagem exata para atualizar a interface do Mini App
    });

  } catch (err) {
    console.error("Erro roleta hoje:", err.message);
    res.status(500).json({ erro: "Erro interno" });
  }
});


// 📜 HISTÓRICO DE GIROS
app.get("/api/roleta/historico", async (req, res) => {
  const { telegram_id } = req.query;

  if (!telegram_id) {
    return res.status(400).json({ erro: "telegram_id obrigatório" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT premio, pontos_ganhos, created_at, gratis
       FROM roleta_giros 
       WHERE telegram_id = $1 
       ORDER BY id DESC 
       LIMIT 10`,
      [telegram_id]
    );

    res.json(rows);

  } catch (err) {
    console.error("Erro histórico:", err.message);
    res.status(500).json({ erro: "Erro interno" });
  }
});

// tarefas externas

app.get("/zeradsptc.php", async (req, res) => {
  const { pwd, user, amount, clicks } = req.query;

  // 1. Validação de segurança (Senha e IP)
  const rawIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress || "";
  const realIP = rawIP.split(',')[0]?.trim();
  const allowedIP = "162.0.208.108";

  if (pwd !== "NewPassword" || realIP !== allowedIP) {
    console.log("❌ Acesso negado. IP:", realIP);
    return res.status(403).send("acesso negado");
  }

  try {
    const valorZER = parseFloat(amount || 0);
    const pontos = (((valorZER * 5.0) * 0.009) * 0.4) / 0.05;

    // 2. Iniciar Transação
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 3. Atualizar saldo do usuário
      const updateResult = await client.query(
        "UPDATE usuarios SET pontos = pontos + $1 WHERE telegram_id = $2",
        [pontos, user]
      );

      if (updateResult.rowCount === 0) {
        await client.query("ROLLBACK");
        console.log("⚠️ Usuário NÃO encontrado:", user);
        return res.send("usuario nao encontrado");
      }

      // 4. Registrar na tabela zerads_concluidas
      await client.query(
        "INSERT INTO zerads_concluidas (telegram_id, pontos, nome_tarefa) VALUES ($1, $2, $3)",
        [user, pontos, 'ZerAds PTC']
      );

      await client.query("COMMIT");
      
      console.log(`✅ Pontos creditados e log registrado para o usuário ${user}`);
      res.send("ok");

    } catch (dbErr) {
      await client.query("ROLLBACK");
      throw dbErr;
    } finally {
      client.release();
    }

  } catch (err) {
    console.error("🔥 Erro ZerAds:", err);
    res.status(500).send("erro");
  }
});



app.get("/cpalead-postback", async (req, res) => {
  const { subid, payout, offer_id, campaign_name } = req.query;
  const telegram_id = subid.replace("telegram_", "");
  const pontos = (parseFloat(payout) * 50) * 0.4;

  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 1. Idempotência
      const check = await client.query("SELECT 1 FROM cpalead_concluidas WHERE offer_id = $1 AND telegram_id = $2", [offer_id, telegram_id]);
      if (check.rowCount > 0) {
        await client.query("ROLLBACK");
        return res.status(200).send("✅ Tarefa já registrada.");
      }

      // 2. Log na tabela nova
      await client.query(
        "INSERT INTO cpalead_concluidas (telegram_id, offer_id, pontos, nome_tarefa) VALUES ($1, $2, $3, $4)",
        [telegram_id, offer_id, pontos, campaign_name]
      );

      // 3. Update saldo
      await client.query(
        "UPDATE usuarios SET pontos = pontos + $1, tarefas_feitas = tarefas_feitas + 1 WHERE telegram_id = $2",
        [pontos, telegram_id]
      );

      await client.query("COMMIT");
      res.status(200).send("✅ Sucesso.");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).send("❌ Erro interno.");
  }
});


const SECRET = '555406b2062d06a989af47844f99b39a265860bf9a237a54';

app.post('/api/moneyrain-callback', express.raw({ type: 'application/json' }), async (req, res) => {
    const signature = req.headers['x-moneyrain-signature'];
    const percentualRepasse = 0.4; // 60% de margem de lucro para você

    // 1. Garantir que o body seja um Buffer para verificação de assinatura
    let bodyBuffer;
    if (Buffer.isBuffer(req.body)) {
        bodyBuffer = req.body;
    } else {
        bodyBuffer = Buffer.from(JSON.stringify(req.body));
    }

    // 2. Verificar Assinatura HMAC (Segurança contra falsificação)
    const hmac = crypto.createHmac('sha256', SECRET);
    hmac.update(bodyBuffer); 
    const hash = hmac.digest('hex');
    const expectedSignature = 'sha256=' + hash;
    
    if (signature !== expectedSignature) {
        console.error("❌ Assinatura inválida no MoneyRain");
        return res.status(403).send('Bad signature');
    }

    // 3. Converter para objeto
    let data;
    try {
        data = JSON.parse(bodyBuffer.toString('utf8'));
    } catch (e) {
        return res.status(400).send('Invalid JSON');
    }
    
    if (data.event === 'reward.completed') {
        const userId = data.external_uid;
        // Aplicação da margem de lucro no cálculo dos pontos
        const pontos = parseFloat(data.reward_currency_amount) * percentualRepasse;
        const viewId = data.view_id;

        if (!userId || !viewId) {
            return res.status(400).send('Missing user or view ID');
        }

        try {
            // 4. Verifica se esta view já foi processada (Idempotência)
            const check = await pool.query(
                "SELECT id FROM moneyrain_concluidas WHERE view_id = $1", 
                [viewId.toString()]
            );

            if (check.rowCount > 0) {
                console.log(`ℹ️ Tarefa ${viewId} já creditada anteriormente.`);
                return res.status(200).send('Already credited');
            }

            // 5. Registra no banco de dados com Transação (BEGIN/COMMIT/ROLLBACK)
            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                await client.query(
                    `INSERT INTO moneyrain_concluidas (telegram_id, view_id, pontos, data, origem, nome_tarefa) 
                     VALUES ($1, $2, $3, NOW(), 'moneyrain', 'MoneyRain Ad')`,
                    [userId, viewId.toString(), pontos]
                );

                await client.query(
                    `UPDATE usuarios SET pontos = COALESCE(pontos, 0) + $1 WHERE telegram_id = $2`,
                    [pontos, userId]
                );

                await client.query('COMMIT');
                console.log(`✅ Sucesso! Usuário ${userId} recebeu ${pontos} pontos (View: ${viewId})`);
                return res.status(200).send('OK');

            } catch (dbErr) {
                await client.query('ROLLBACK');
                throw dbErr;
            } finally {
                client.release();
            }

        } catch (err) {
            console.error("🔥 Erro ao processar banco de dados:", err);
            return res.status(500).send('Database error');
        }
    }
    
    res.status(400).send('Invalid event');
});


// 🔹 4. Rotas de Usuário
app.get("/api/usuarios/:telegram_id", async (req, res) => {
  try {
    const { telegram_id } = req.params;

    // validação básica
    if (!telegram_id) {
      return res.status(400).json({
        success: false,
        error: "telegram_id não informado"
      });
    }

    const result = await pool.query(
      "SELECT * FROM usuarios WHERE telegram_id = $1",
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


// 🔹 5. Ranking
app.get("/api/ranking", async (req, res) => {
  try {
    const rankingTarefas = await pool.query(`
      SELECT telegram_id, nome, pontos
      FROM usuarios
      ORDER BY pontos DESC
      LIMIT 5
    `);

    const rankingIndicacoes = await pool.query(`
      SELECT telegram_id, nome, indicacoes
      FROM usuarios
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

// validado até aqui niveis de segurança


// 🔹 6. Saques (Versão Global com Retenção de Pontos Quebrados)
app.post("/api/solicitar-saque", async (req, res) => {
  const { telegram_id, chave_pix, cpf } = req.body;

  // Validação básica universal
  if (!telegram_id) {
    return res.status(400).json({ error: "O campo telegram_id é obrigatório." });
  }

  // REGRAS ECONÔMICAS DO SEU BOT
  const VALOR_DO_PONTO_EM_BRL = 0.05; // Cada ponto vale R$ 0,05
  const COTACAO_DOLAR = 5.50;         // Cotação fixa para evitar prejuízos

  const client = await pool.connect();

  try {
    // Inicia uma transação para garantir segurança total contra fraudes de cliques rápidos
    await client.query("BEGIN");

    // 👤 Busca os dados do usuário travando a linha para alteração (FOR UPDATE)
    const userResult = await client.query(
      "SELECT pontos, vip, lang FROM usuarios WHERE telegram_id = $1 FOR UPDATE", 
      [telegram_id]
    );

    if (userResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Usuário não encontrado." });
    }

    const { pontos, vip, lang } = userResult.rows[0];
    
    // 🌍 VALIDAÇÃO CONDICIONAL POR IDIOMA: Exige Pix e CPF apenas se for brasileiro
    if (lang === "pt" && (!chave_pix || !cpf)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Chave PIX e CPF são obrigatórios para usuários do Brasil." });
    }

    // 🔢 LOGICA DE ARREDONDAMENTO (Justa e Antifraude de tabelas)
    const pontosParaSacar = Math.floor(pontos); // Pega apenas a parte inteira (Ex: 400 de 400.0003)
    const pontosQueFicam = pontos - pontosParaSacar; // Guarda o resto decimal (Ex: 0.0003)

    const pontosMinimos = vip ? 200 : 400;

    if (pontosParaSacar < pontosMinimos) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: `Pontos inteiros insuficientes para realizar o saque. Mínimo: ${pontosMinimos}` });
    }

    // 📊 Validação de limite diário (Apenas 1 saque por dia)
    const saqueHoje = await client.query(`
      SELECT 1 FROM saques
      WHERE telegram_id = $1 AND DATE(data_solicitacao) = CURRENT_DATE
    `, [telegram_id]);

    if (saqueHoje.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Você já solicitou um saque hoje. Aguarde a análise do pagamento." });
    }

    // 💰 CONVERSÃO DE VALOR SUSTENTÁVEL baseado nos pontos inteiros sacados
    let valorCalculado = pontosParaSacar * VALOR_DO_PONTO_EM_BRL;

    // Se o usuário NÃO for brasileiro, aplica a taxa cambial dividindo pelo Dólar
    if (lang !== "pt") {
      valorCalculado = valorCalculado / COTACAO_DOLAR;
    }

    const valorFinalFormatado = valorCalculado.toFixed(2);

    // 📝 Salva a solicitação de saque no banco (Envia null se chave_pix ou cpf não existirem)
    await client.query(`
      INSERT INTO saques (telegram_id, pontos_solicitados, valor_solicitado, chave_pix, cpf, status, data_solicitacao)
      VALUES ($1, $2, $3, $4, $5, 'pendente', NOW())
    `, [telegram_id, pontosParaSacar, valorFinalFormatado, chave_pix || null, cpf || null]);

    // 🔄 Atualiza o usuário retendo apenas os pontos fracionados/quebrados na conta dele
    await client.query(
      "UPDATE usuarios SET pontos = $1 WHERE telegram_id = $2", 
      [pontosQueFicam, telegram_id]
    );

    // Aplica as alterações no banco de dados definitivamente
    await client.query("COMMIT");

    res.json({ 
      success: true, 
      message: "Saque solicitado com sucesso.", 
      valor: valorFinalFormatado,
      moeda: lang === "pt" ? "BRL" : "USD",
      pontos_restantes: pontosQueFicam
    });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Erro ao solicitar saque:", err);
    res.status(500).json({ error: "Erro interno do servidor." });
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
      "SELECT * FROM saques WHERE telegram_id = $1 ORDER BY data_solicitacao DESC",
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
    const { utm_source, utm_medium, utm_campaign, is_converted } = req.body;
    
    // Usando o seu objeto 'pool' (que já está configurado no seu server.js)
    try {
        const query = `
            INSERT INTO traffic_logs (utm_source, utm_medium, utm_campaign, is_converted, created_at)
            VALUES ($1, $2, $3, $4, NOW())
        `;
        const values = [utm_source, utm_medium, utm_campaign, is_converted];
        
        await pool.query(query, values);
        
        res.status(200).json({ success: true });
    } catch (err) {
        console.error("Erro ao salvar log de tráfego:", err.message);
        res.status(500).json({ error: "Erro interno ao salvar log" });
    }
});

// 🔹 8. Anuncios

// Usuário envia pedido de anúncio (salva em anuncios_pedidos)
app.post("/api/anuncios/pedidos", async (req, res) => {
  const { tipo, descricao, link, nome, contato } = req.body;

  try {
    await pool.query(
      `INSERT INTO anuncios_pedidos (tipo, descricao, link, nome, contato, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [tipo, descricao, link, nome, contato]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Erro ao salvar pedido" });
  }
});

// Frontend consulta anúncios ativos por posição (exibição em rodapé, painel, etc.)
app.get("/api/anuncios", async (req, res) => {
  const { posicao } = req.query;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM anuncios 
       WHERE ativo = true AND posicao = $1 
       AND NOW() BETWEEN data_inicio AND data_fim
       ORDER BY prioridade DESC, created_at DESC`,
      [posicao]
    );
    res.json(rows.length ? rows : [{ titulo: "Anuncie aqui", posicao }]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Erro ao buscar anúncios" });
  }
});

// POST /api/anuncio-evento
app.post("/api/anuncio-evento", async (req, res) => {
  const { anuncio_id, tipo } = req.body;

  const ip =
    req.headers["x-forwarded-for"] ||
    req.socket.remoteAddress;

  const userAgent = req.headers["user-agent"];

  try {
    await pool.query(
      `INSERT INTO anuncios_eventos (anuncio_id, tipo, ip, user_agent)
       VALUES ($1, $2, $3, $4)`,
      [anuncio_id, tipo, ip, userAgent]
    );
    res.sendStatus(200);
  } catch (err) {
    console.error("Erro evento anúncio:", err);
    res.status(500).send("erro");
  }
});




// 🔹 9. Admin
// Middleware de segurança (protege todas as rotas admin)
function verificarAdmin(req, res, next) {
  const senha = req.headers["x-admin-key"];
  if (!senha || senha !== process.env.ADMIN_KEY) {
    return res.status(403).send("❌ Acesso negado");
  }
  next();
}

// Admin lista pedidos pendentes (anuncios_pedidos)
app.get("/admin/anuncios/pending", verificarAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM anuncios_pedidos WHERE status = 'pending' ORDER BY id DESC"
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Erro ao listar pedidos.");
  }
});

// Admin aprova pedido como tarefa (insere em tarefas)
app.post("/admin/tarefa", verificarAdmin, async (req, res) => {
  const { titulo, link, pontos } = req.body;
  try {
    await pool.query(
      "INSERT INTO tarefas (titulo, link, pontos, ativa, status) VALUES ($1, $2, $3, true, 'ativo')",
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
    await pool.query(
      `INSERT INTO anuncios (titulo, tipo, descricao, link_url, imagem_url, anunciante, posicao, prioridade, data_inicio, data_fim, ativo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)`,
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
    await pool.query("DELETE FROM anuncios_pedidos WHERE id = $1", [req.params.id]);
    res.send("❌ Pedido recusado e removido.");
  } catch (err) {
    console.error(err);
    res.status(500).send("Erro ao recusar pedido.");
  }
});

// Admin lista todos os anúncios ativos
app.get("/admin/anuncios/ativos", verificarAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM anuncios ORDER BY id DESC");
    res.json(rows);
  } catch (err) {
    console.error(err);
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
    console.error(err);
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
    console.error(err);
    res.status(500).send("Erro ao atualizar status.");
  }
});

// Admin exclui banner ativo
app.delete("/admin/anuncio/:id", verificarAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM anuncios WHERE id = $1", [req.params.id]);
    res.send("❌ Banner excluído!");
  } catch (err) {
    console.error(err);
    res.status(500).send("Erro ao excluir banner.");
  }
});
// Métricas de um anúncio específico
app.get("/api/admin/anuncio-metricas/:id", verificarAdmin, async (req, res) => {
  const anuncioId = req.params.id;

  try {
    const result = await pool.query(
      `SELECT tipo, COUNT(*) AS total
       FROM anuncios_eventos
       WHERE anuncio_id = $1
       GROUP BY tipo`,
      [anuncioId]
    );

    const metrics = { visita: 0, clique: 0, contato: 0 };
    result.rows.forEach(r => {
      metrics[r.tipo] = parseInt(r.total, 10);
    });

    res.json(metrics);
  } catch (err) {
    console.error("Erro métricas admin:", err);
    res.status(500).send("erro");
  }
});

// Ranking geral de todos os anúncios
app.get("/api/admin/anuncios-metricas", verificarAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.id, a.titulo,
             COALESCE(SUM(CASE WHEN e.tipo='visita' THEN 1 ELSE 0 END),0) AS visitas,
             COALESCE(SUM(CASE WHEN e.tipo='clique' THEN 1 ELSE 0 END),0) AS cliques,
             COALESCE(SUM(CASE WHEN e.tipo='contato' THEN 1 ELSE 0 END),0) AS contatos
      FROM anuncios a
      LEFT JOIN anuncios_eventos e ON a.id = e.anuncio_id
      GROUP BY a.id, a.titulo
      ORDER BY a.id;
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("Erro listar métricas admin:", err);
    res.status(500).send("erro");
  }
});


app.post("/admin/sql", async (req, res) => {
  const senha = req.headers["x-admin-key"];

  // 🔐 Verificação de acesso
  if (!senha || senha !== process.env.ADMIN_KEY) {
    return res.status(403).send("❌ Acesso negado");
  }

  const { sql } = req.body;

  // ⚠️ Validação básica
  if (!sql || typeof sql !== "string") {
    return res.status(400).send("SQL inválido");
  }

  // 🚫 Bloqueio de comandos perigosos
//  const comandosPerigosos = /(drop|delete|truncate|alter)/i;
 // if (comandosPerigosos.test(sql)) {
   // return res.status(403).send("❌ Comando SQL bloqueado por segurança");
 // }

  try {
    const { rows } = await pool.query(sql);
    res.json(rows);
  } catch (err) {
    console.error("Erro SQL:", err.message);
    res.status(400).send("Erro SQL: " + err.message);
  }
});

// =========================================================================
// 🔹 10. Telegram Bot Core (Lógica de Comandos)
// =========================================================================
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const GRUPO_VIP_ID = -1002605364157;

// Dicionário de Mensagens Bilíngue para o Comando /start
const msgsStart = {
  pt: {
    indicacao_ok: "🎉 Indicação registrada! Você ganhou 5 pontos.",
    indicacao_ja: "ℹ️ Você já foi indicado anteriormente.",
    boas_vindas: "🎉 Bem-vindo ao LucreMaisTask!\n\n🚀 Aqui você pode ganhar pontos todos os dias:\n" +
                 "• 📌 Tarefa diária\n" +
                 "• 🎰 Roleta da sorte\n" +
                 "• 📲 Tarefas externas\n\n" +
                 "Quanto mais você participa, mais pontos acumula e mais recompensas recebe!\n\n" +
                 "👉 Clique abaixo para começar:",
    btn_app: "📲 Abrir Mini App",
    erro: "⚠️ Erro no cadastro: "
  },
  en: {
    indicacao_ok: "🎉 Referral registered! You earned 5 points.",
    indicacao_ja: "ℹ️ You have already been referred before.",
    boas_vindas: "🎉 Welcome to CashTaskBot!\n\n🚀 Here you can earn points every day:\n" +
                 "• 📌 Daily task\n" +
                 "• 🎰 Lucky Wheel\n" +
                 "• 📲 External offers\n\n" +
                 "The more you participate, the more points you accumulate and the more rewards you get!\n\n" +
                 "👉 Click below to start:",
    btn_app: "📲 Open Mini App",
    erro: "⚠️ Registration error: "
  }
};

// 🔹 Rota Única do Mini App para capturar IP e carregar a aplicação
app.get("/", (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log("🌐 IP capturado do Mini App:", ip);

  // Aqui você pode dar um res.sendFile() da sua index.html se ela estiver no servidor,
  // ou manter apenas o indicador de carregamento
  res.send("Mini App carregado");
});

bot.onText(/\/startTrim(?:\s+(\d+))?/, async (msg, match) => {
  // Mantendo o comportamento padrão para aceitar variações e espaços
});

bot.onText(/\/start(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const indicadoId = msg.from.id;
  const indicadorId = match[1];
  const nome = msg.from.first_name;

  // 🌍 Detecta o idioma do aplicativo do usuário (padrão: en)
  const telegramLang = msg.from.language_code || "";
  const userLang = telegramLang.startsWith("pt") ? "pt" : "en";

  try {
    // 🔹 Cria usuário se não existir e já salva ou atualiza o idioma 'lang'
    await pool.query(
      `INSERT INTO usuarios (telegram_id, nome, lang)
       VALUES ($1, $2, $3)
       ON CONFLICT (telegram_id) 
       DO UPDATE SET lang = EXCLUDED.lang`, 
      [indicadoId, nome, userLang]
    );

    // 🔹 Lógica de indicação
    if (indicadorId && indicadorId !== indicadoId.toString()) {
      const check = await pool.query(
        "SELECT * FROM indicacoes WHERE id_indicado = $1",
        [indicadoId]
      );

      if (check.rowCount === 0) {
        const ip = "0.0.0.0";

        await pool.query(
          `INSERT INTO indicacoes (id_indicador, id_indicado, ip, data, pontos_ativados)
           VALUES ($1, $2, $3, NOW(), false)`,
          [indicadorId, indicadoId, ip]
        );

        // 🎁 Bônus para o indicado
        await pool.query(
          `UPDATE usuarios SET pontos = COALESCE(pontos, 0) + 5 WHERE telegram_id = $1`,
          [indicadoId]
        );

        bot.sendMessage(chatId, msgsStart[userLang].indicacao_ok);
      } else {
        bot.sendMessage(chatId, msgsStart[userLang].indicacao_ja);
      }
    }

    // 🔹 Verifica se o usuário pertence ao grupo VIP para atualizar status
    try {
      const member = await bot.getChatMember(GRUPO_VIP_ID, chatId);
      const status = member?.status;

      const isVip =
        status === "member" ||
        status === "administrator" ||
        status === "creator";

      await pool.query(
        "UPDATE usuarios SET vip = $1 WHERE telegram_id = $2",
        [isVip, chatId]
      );
    } catch (err) {
      console.error("Erro ao verificar status VIP:", err.message);
    }

    // 🔹 Mensagem final dinâmica enviando o idioma correspondente por parâmetro na URL do Mini App
    bot.sendMessage(chatId, msgsStart[userLang].boas_vindas, {
      reply_markup: {
        inline_keyboard: [[
          {
            text: msgsStart[userLang].btn_app,
            web_app: { url: `https://telegrambot-mlfd.onrender.com/?id=${chatId}&lang=${userLang}` }
          }
        ]]
      }
    });

  } catch (err) {
    console.error("Erro no bot:", err.message);
    const langErro = msgsStart[userLang] ? userLang : "en";
    bot.sendMessage(chatId, `${msgsStart[langErro].erro}${err.message}`);
  }
});

// 🔹 11. CRON - Engajamento Dia 2 (Otimizado Internacional)
const cron = require("node-cron");

cron.schedule("0 10 * * *", async () => {
  console.log("⏰ Rodando cron de engajamento...");

  try {
    const ontem = new Date();
    ontem.setDate(ontem.getDate() - 1);
    const dataFormatada = ontem.toISOString().slice(0, 10);

    // Busca usuários trazendo a coluna lang
    const { rows } = await pool.query(
      "SELECT telegram_id, COALESCE(lang, 'en') as lang FROM usuarios WHERE DATE(criado_em) = $1",
      [dataFormatada]
    );

    console.log(`📊 Usuários encontrados para engajamento: ${rows.length}`);

    for (const u of rows) {
      const lang = u.lang === 'pt' ? 'pt' : 'en';

      if (lang === 'pt') {
        // Envio em Português
        await bot.sendMessage(
          u.telegram_id,
          `🎁 *BÔNUS DE RETORNO LIBERADO!*\n\n` +
          `👋 Olá! Notamos que você deixou pontos pendentes no seu saldo ontem.\n\n` +
          `🎡 *1 Giro Grátis na Roleta* foi adicionado à sua conta e expira em poucas horas!\n` +
          `💰 Não perca a chance de acumular pontos e pedir seu PIX hoje mesmo.\n\n` +
          `👇 Clique abaixo para coletar e girar agora:`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🎰 Girar Roleta Grátis", web_app: { url: `https://telegrambot-mlfd.onrender.com/roleta.html?id=${u.telegram_id}&lang=pt` } }],
                [
                  { text: "🚀 Ver Tarefas LucreMais", web_app: { url: `https://telegrambot-mlfd.onrender.com/tarefas.html?id=${u.telegram_id}&lang=pt` } },
                  { text: "🏠 Ir para o Início", web_app: { url: `https://telegrambot-mlfd.onrender.com/index.html?id=${u.telegram_id}&lang=pt` } }
                ]
              ]
            }
          }
        );
      } else {
        // Envio em Inglês (Global)
        await bot.sendMessage(
          u.telegram_id,
          `🎁 *RETURN BONUS UNLOCKED!*\n\n` +
          `👋 Hello! We noticed you left some unclaimed points in your balance yesterday.\n\n` +
          `🎡 *1 Free Wheel Spin* has been added to your account and expires in a few hours!\n` +
          `💰 Don't miss out on accumulating points and claiming your crypto reward today.\n\n` +
          `👇 Click below to collect and spin right now:`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🎰 Spin Free Wheel", web_app: { url: `https://telegrambot-mlfd.onrender.com/roleta.html?id=${u.telegram_id}&lang=en` } }],
                [
                  { text: "🚀 View CashTasks", web_app: { url: `https://telegrambot-mlfd.onrender.com/tarefas.html?id=${u.telegram_id}&lang=en` } },
                  { text: "🏠 Go to Home", web_app: { url: `https://telegrambot-mlfd.onrender.com/index.html?id=${u.telegram_id}&lang=en` } }
                ]
              ]
            }
          }
        );
      }
    }

  } catch (err) {
    console.error("Erro no cron de engajamento:", err.message);
  }
});

// 🔹 12. Inicializar servidor
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
});



