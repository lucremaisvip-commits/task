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
console.log("🚀 Bot rodando com chave de TESTE");

const app = express();
const PORT = process.env.PORT || 3000;
const bot = new Telegraf(process.env.BOT_TOKEN);

// ✅ Confia no primeiro proxy (necessário no Render/Heroku/etc..)
app.set("trust proxy", 1);

// 🔒 2. CORS restrito (Incluindo a Netlify do FaucetTask e métodos necessários)
const allowedOrigins = [
  process.env.APP_DOMAIN, 
  "https://highpay-ads.com",
  "https://faucettask.netlify.app"
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
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-admin-key"]
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

// 6. Segurança do چه é publico ou privado 
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

// =========================================================================
// 🔹 Rota: Concluir Tarefa (Com controle automático de campanhas de usuários)
// =========================================================================
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

    const tarefa = await client.query(`SELECT id, pontos, ativa, link FROM tarefas WHERE id = $1`, [tarefaId]);
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
    const linkTarefa = tarefa.rows[0].link;

    // 🚀 1. Controle automático de cliques da campanha de usuário (se houver)
    const campanhaCheck = await client.query(
      `SELECT id, cliques_totais, cliques_entregues FROM campanhas_usuarios WHERE link = $1 AND status = 'ativa' FOR UPDATE`,
      [linkTarefa]
    );

    if (campanhaCheck.rows.length > 0) {
      const camp = campanhaCheck.rows[0];
      const novosCliquesEntregues = camp.cliques_entregues + 1;

      if (novosCliquesEntregues >= camp.cliques_totais) {
        // 🎯 Atingiu o limite de cliques! Encerra a campanha e desativa a tarefa
        await client.query(
          `UPDATE campanhas_usuarios SET cliques_entregues = $1, status = 'concluida' WHERE id = $2`,
          [novosCliquesEntregues, camp.id]
        );
        await client.query(
          `UPDATE tarefas SET ativa = false WHERE id = $1`,
          [tarefaId]
        );
      } else {
        // 🔄 Atualiza o progresso de cliques entregues
        await client.query(
          `UPDATE campanhas_usuarios SET cliques_entregues = $1 WHERE id = $2`,
          [novosCliquesEntregues, camp.id]
        );
      }
    }

    await client.query(
      `INSERT INTO historico_ganhos (telegram_id, origem, pontos, nome_tarefa, referencia_id, data_registro)
       VALUES ($1, 'tarefa', CAST($2 AS NUMERIC), $3, $4, NOW())`,
      [telegram_id, pontos, "Tarefa ID: " + tarefaId, String(tarefaId)]
    );

    await client.query(
      `UPDATE usuarios SET pontos = (COALESCE(pontos, 0)::NUMERIC + CAST($1 AS NUMERIC)), tarefas_feitas = COALESCE(tarefas_feitas, 0) + 1 WHERE telegram_id = $2`,
      [pontos, telegram_id]
    );

    const resultadoXp = await adicionarXP(telegram_id, 15, client);
    const metaBatida = await verificarMetaDiaria(client, telegram_id);

    let infoBooster = { liberado: false };
    if (metaBatida) {
        infoBooster = await verificarMissaoEntrada(client, telegram_id);
    }

    // 🔍 Busca dados de indicação
    const indicacaoRes = await client.query(
      `SELECT i.*, 
              u_ind.nome as nome_indicador,
              u_do.lang as lang_indicado
       FROM indicacoes i 
       LEFT JOIN usuarios u_ind ON i.id_indicador = u_ind.telegram_id 
       LEFT JOIN usuarios u_do ON i.id_indicado = u_do.telegram_id
       WHERE i.id_indicado = $1 AND i.pontos_ativados = false`,
      [telegram_id]
    );

    let ganhouBonusIndicacao = false;
    let nomeIndicadorDoAmigo = "";
    let langIndicado = "pt";

    if (indicacaoRes.rows.length > 0) {
      const indicacao = indicacaoRes.rows[0];
      nomeIndicadorDoAmigo = indicacao.nome_indicador || "um amigo";
      langIndicado = indicacao.lang_indicado || "pt";
      
      const tarefasRes = await client.query(
        "SELECT COUNT(*) FROM historico_ganhos WHERE telegram_id = $1 AND origem = 'tarefa'",
        [telegram_id]
      );

      // 🎯 Quando o indicado completa 3 tarefas internas
      if (parseInt(tarefasRes.rows[0].count) >= 3) {
        await client.query("UPDATE indicacoes SET pontos_ativados = true WHERE id = $1", [indicacao.id]);
        
        // 1. Premia o Indicador com 0.40 pts
        await client.query(
          `UPDATE usuarios SET pontos = (COALESCE(pontos, 0)::NUMERIC + 0.40), indicacoes = COALESCE(indicacoes, 0) + 1 WHERE telegram_id = $1`,
          [indicacao.id_indicador]
        );
        await adicionarXP(indicacao.id_indicador, 20, client);
        await client.query(
          `INSERT INTO historico_ganhos (telegram_id, origem, pontos, nome_tarefa, referencia_id, data_registro) VALUES ($1, 'indicacao', 0.40, 'Bônus por indicação', $2, NOW())`,
          [indicacao.id_indicador, String(telegram_id)]
        );

        // 🚀 NOVO: Registra notificação pendente para o indicador na tabela centralizada
        // (Usamos referencia_id ou criamos um registro único para este evento de indicação)
        await client.query(
          `INSERT INTO usuarios_notificacoes_vistas (telegram_id, tipo_alerta, referencia_data, visto, metadados)
           VALUES ($1, 'nova_indicacao', CURRENT_DATE, FALSE, $2::jsonb)
           ON CONFLICT DO NOTHING`,
          [indicacao.id_indicador, JSON.stringify({ indicado_id: telegram_id, pontos: 0.40 })]
        );

        // 2. Premia o Indicado com 0.20 pts na hora
        await client.query(
          `UPDATE usuarios SET pontos = (COALESCE(pontos, 0)::NUMERIC + 0.20) WHERE telegram_id = $1`,
          [telegram_id]
        );
        await client.query(
          `INSERT INTO historico_ganhos (telegram_id, origem, pontos, nome_tarefa, referencia_id, data_registro) VALUES ($1, 'bonus_indicado', 0.20, 'Bônus de Boas-Vindas (Indicação)', $2, NOW())`,
          [telegram_id, String(indicacao.id_indicador)]
        );

        ganhouBonusIndicacao = true;
      }
    }

    await client.query("UPDATE tarefas_sessoes SET status = 'concluido', concluido_em = NOW() WHERE token = $1", [token]);

    await client.query("COMMIT");

    // 💬 Dispara a ação bilíngue no chat do Telegram do indicado
    if (ganhouBonusIndicacao && typeof bot !== 'undefined' && bot.telegram) {
      const isEn = langIndicado === 'en';

      const mensagemNotificacao = isEn
        ? `🎉 **Congratulations!** You completed 3 initial tasks and received a bonus of **0.20 points** for being referred by **${nomeIndicadorDoAmigo}**! 🚀`
        : `🎉 **Parabéns!** Você realizou as 3 tarefas iniciais e recebeu um bônus de **0.20 pontos** por ter sido indicado por **${nomeIndicadorDoAmigo}**! 🚀`;
      
      try {
        await bot.telegram.sendMessage(telegram_id, mensagemNotificacao, { parse_mode: "Markdown" });
      } catch (notifyErr) {
        console.error("⚠️ Erro ao enviar aviso de bônus de indicação:", notifyErr.message);
      }
    }

    res.json({ mensagem: "✅ Concluído! +15 XP", metaBatida, booster: infoBooster.liberado });

   } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ erro: err.message || "Erro interno" });
  } finally {
    client.release();
  }
});

// =========================================================================
// 🔹 Rota: Criar Campanha de Tarefa pelo Usuário (Bilingue PT/EN)
// =========================================================================
app.post("/api/criar-campanha-usuario", async (req, res) => {
  let { telegram_id, titulo, link, cliques_totais, lang } = req.body;

  telegram_id = String(telegram_id || "").trim();
  titulo = String(titulo || "").trim();
  link = String(link || "").trim();
  const cliques = parseInt(cliques_totais);
  const userLang = (lang === "pt") ? "pt" : "en";

  // Dicionário de mensagens de erro/sucesso bilíngue
  const msgs = {
    pt: {
      invalidData: "Dados inválidos ou incompletos.",
      invalidPackage: "Pacote de cliques inválido.",
      activeExists: "Você já possui uma campanha ativa ou aguardando moderação no momento.",
      userNotFound: "Usuário não encontrado.",
      lowBalance: (custo) => `Saldo insuficiente. Você precisa de ${custo} pontos.`,
      success: "Campanha criada com sucesso! Ela entrará no ar após a moderação.",
      internalError: "Erro interno ao criar campanha.",
      historyName: (c) => `Criação de Campanha (${c} cliques)`
    },
    en: {
      invalidData: "Invalid or incomplete data.",
      invalidPackage: "Invalid click package.",
      activeExists: "You already have an active campaign or one awaiting moderation.",
      userNotFound: "User not found.",
      lowBalance: (custo) => `Insufficient balance. You need ${custo} points.`,
      success: "Campaign successfully created! It will go live after moderation.",
      internalError: "Internal error while creating campaign.",
      historyName: (c) => `Campaign Creation (${c} clicks)`
    }
  };

  const t = msgs[userLang];

  if (!telegram_id || !titulo || !link || isNaN(cliques)) {
    return res.status(400).json({ success: false, error: t.invalidData });
  }

  // 📦 Tabela de preços estipulada baseada na média (10, 25 ou 50 cliques)
  let custoTotalPontos = 0;
  if (cliques === 10) custoTotalPontos = 0.20;
  else if (cliques === 25) custoTotalPontos = 0.45;
  else if (cliques === 50) custoTotalPontos = 0.85;
  else {
    return res.status(400).json({ success: false, error: t.invalidPackage });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 🔒 1. Verificar se o usuário já possui uma campanha ativa ou pendente (Regra: Apenas 1 por vez)
    const activeCheck = await client.query(
      `SELECT id FROM campanhas_usuarios WHERE telegram_id = $1 AND status IN ('pendente', 'ativa')`,
      [telegram_id]
    );

    if (activeCheck.rows.length > 0) {
      throw new Error(t.activeExists);
    }

    // 🔒 2. Verificar o saldo atual de pontos do usuário
    const userRes = await client.query(
      `SELECT pontos FROM usuarios WHERE telegram_id = $1 FOR UPDATE`,
      [telegram_id]
    );

    if (userRes.rows.length === 0) {
      throw new Error(t.userNotFound);
    }

    const pontosAtuais = parseFloat(userRes.rows[0].pontos || 0);
    if (pontosAtuais < custoTotalPontos) {
      throw new Error(t.lowBalance(custoTotalPontos));
    }

    // 💰 3. Descontar os pontos imediatamente (Com CAST explícito para evitar conflito de operadores no PG)
    await client.query(
      `UPDATE usuarios SET pontos = (pontos::NUMERIC - CAST($1 AS NUMERIC)) WHERE telegram_id = $2`,
      [custoTotalPontos, telegram_id]
    );

    // 📝 4. Inserir a campanha com status 'pendente'
    await client.query(
      `INSERT INTO campanhas_usuarios 
       (telegram_id, titulo, link, cliques_totais, custo_total_pontos, status, data_inicio_agendada)
       VALUES ($1, $2, $3, $4, $5, 'pendente', CURRENT_DATE + TIME '21:00:00')`,
      [telegram_id, titulo, link, cliques, custoTotalPontos]
    );

    // 📜 5. Registrar no histórico de ganhos / transações
    await client.query(
      `INSERT INTO historico_ganhos (telegram_id, origem, pontos, nome_tarefa, referencia_id, data_registro)
       VALUES ($1, 'criacao_campanha', CAST($2 AS NUMERIC) * -1, $3, 'campanha_usuario', NOW())`,
      [telegram_id, custoTotalPontos, t.historyName(cliques)]
    );

    await client.query("COMMIT");
    res.json({ success: true, mensagem: t.success });

  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ success: false, error: err.message || t.internalError });
  } finally {
    client.release();
  }
});

app.post("/api/concluir-anuncio-extra", async (req, res) => {
  let { telegram_id } = req.body;

  telegram_id = String(telegram_id || "").trim();

  if (!telegram_id) {
    return res.status(400).json({ erro: "Dados inválidos" });
  }

  if (!checkRateLimit(telegram_id)) {
    return res.status(429).json({ erro: "Muitas requisições" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 🔒 TRAVA 1: Cooldown de 60 segundos (Evita flood contínuo)
    const cooldownRes = await client.query(
      `SELECT 1 FROM historico_ganhos 
       WHERE telegram_id = $1 AND origem = 'anuncio_extra' 
       AND data_registro > NOW() - INTERVAL '60 seconds'`,
      [telegram_id]
    );

    if (cooldownRes.rows.length > 0) {
      throw new Error("Aguarde 60 segundos entre cada anúncio extra.");
    }

    // 🔒 TRAVA 2: Limite Diário de 10 Anúncios Extras por usuário
    const limiteDiarioRes = await client.query(
      `SELECT COUNT(*) AS total FROM historico_ganhos 
       WHERE telegram_id = $1 AND origem = 'anuncio_extra' 
       AND data_registro >= CURRENT_DATE`,
      [telegram_id]
    );

    const totalHoje = parseInt(limiteDiarioRes.rows[0].total, 10);
    if (totalHoje >= 10) {
      throw new Error("Você atingiu o limite máximo de 10 anúncios extras hoje! Volte amanhã.");
    }

    // 🔒 TRAVA 3: Recompensa ajustada para 0.02 Pontos (Sustentável)
    const pontosAdicionais = 0.02; 

    // Registra no histórico de ganhos
    await client.query(
      `INSERT INTO historico_ganhos (telegram_id, origem, pontos, nome_tarefa, referencia_id, data_registro)
       VALUES ($1, 'anuncio_extra', $2, $3, $4, NOW())`,
      [telegram_id, pontosAdicionais, "📺 Anúncio Extra SDK", "extra_ad"]
    );

    // Atualiza os pontos do usuário
    await client.query(
      `UPDATE usuarios SET pontos = COALESCE(pontos, 0) + $1 WHERE telegram_id = $2`,
      [pontosAdicionais, telegram_id]
    );

    // Adiciona XP (ex: 2 XP proporcional ao novo valor)
    await adicionarXP(telegram_id, 2, client);

    await client.query("COMMIT");
    res.json({ 
      sucesso: true, 
      mensagem: `🎉 +0.02 pontos adicionados! (${totalHoje + 1}/10 hoje)` 
    });

  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ erro: err.message || "Erro interno" });
  } finally {
    client.release();
  }
});

// =========================================================================
// 🔹 3.3 Roleta (Refatorada com Sistema de Tickets e Margem Global de Seguranca)
// =========================================================================

// 🎰 GIRAR ROLETA - MODELO COM MARGEM DE SEGURANÇA GLOBAL
app.post("/api/roleta/girar", async (req, res) => {
  const { telegram_id } = req.body;

  if (!telegram_id) {
    return res.status(400).json({ erro: "telegram_id inválido" });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1. Busca usuário e trava a linha contra acessos concorrentes
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

    // 2. Valida limite diário de giros do nível
    const girosHoje = await client.query(
      `SELECT COUNT(*) FROM roleta_giros WHERE telegram_id = $1 AND data_registro::date = CURRENT_DATE`,
      [telegram_id]
    );

    if (parseInt(girosHoje.rows[0].count) >= limiteGiros) {
      await client.query("ROLLBACK");
      return res.status(400).json({ erro: `Limite diário de ${limiteGiros} giros atingido` });
    }

    // 3. Verifica se o usuário tem tickets disponíveis
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

    // 4. Processa o custo do giro (consome ticket ou desconta pontos)
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

    // =========================================================================
    // 🛡️ CONTROLE DE MARGEM DE SEGURANÇA GLOBAL (NOVA LÓGICA)
    // =========================================================================
    // Calcula o total de pontos pagos nos últimos 30 giros globais de todos os usuários
    const caixaRes = await client.query(
      `SELECT COALESCE(SUM(pontos_ganhos), 0) as total_pago_recente 
       FROM (SELECT pontos_ganhos FROM roleta_giros ORDER BY id DESC LIMIT 30) t`
    );
    
    const totalPagoRecente = parseFloat(caixaRes.rows[0].total_pago_recente);

    // Tabela base de prêmios e porcentagens
    let premiosDisponiveis = [
      { tipo: "pontos", valor: 0.05, chance: 30 },
      { tipo: "pontos", valor: 0.10, chance: 25 },
      { tipo: "pontos", valor: 0.25, chance: 15 },
      { tipo: "pontos", valor: 0.50, chance: 8 },
      { tipo: "pontos", valor: 1.00, chance: 3 },
      { tipo: "pontos", valor: 1.50, chance: 1 },
      { tipo: "nada", valor: 0, chance: 18 }
    ];

    // TRAVA AUTOMÁTICA: Se os últimos 30 giros pagaram mais de 5.0 pontos no total,
    // bloqueia prêmios maiores ou iguais a 0.50 e injeta chance no "Tente Novamente"
    const TETO_MAXIMO_PAGO = 5.0; 
    if (totalPagoRecente > TETO_MAXIMO_PAGO) {
      premiosDisponiveis = premiosDisponiveis.filter(p => p.valor < 0.50);
      
      const nadaObj = premiosDisponiveis.find(p => p.tipo === "nada");
      if (nadaObj) {
        nadaObj.chance += 40; // Garante que a casa recupere a margem rapidamente
      }
    }

    // Algoritmo de Sorteio Ponderado Padrão
    function sortearPremioSeguro(lista) {
      const somaChances = lista.reduce((acc, p) => acc + p.chance, 0);
      const rand = Math.random() * somaChances;
      let acumulado = 0;
      for (const p of lista) {
        acumulado += p.chance;
        if (rand <= acumulado) return p;
      }
      return lista[0];
    }

    const premio = sortearPremioSeguro(premiosDisponiveis);
    // =========================================================================

    // 5. Credita o prêmio ganho na conta do usuário
    await client.query(
      "UPDATE usuarios SET pontos = (pontos::NUMERIC + $1::NUMERIC) WHERE telegram_id = $2", 
      [premio.valor.toFixed(2), telegram_id]
    );

    // 6. Registra experiência (XP)
    const resultadoXp = await adicionarXP(telegram_id, 30, client);

    const nomePremio = premio.tipo === "pontos" ? `${premio.valor} Pontos` : "Tente Novamente";

    // 7. Registra giro na tabela de auditoria da roleta
    const giroRes = await client.query(
      `INSERT INTO roleta_giros (telegram_id, premio, pontos_ganhos, gratis, data_registro) 
       VALUES ($1, $2, $3, $4, NOW()) RETURNING id`,
      [telegram_id, nomePremio, premio.valor, gratis]
    );

    // 8. Registra entrada no histórico de ganhos
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

// 🎟️ COMPRAR PACOTE DE TICKETS
app.post("/api/roleta/comprar-tickets", async (req, res) => {
  const { telegram_id } = req.body;
  
  if (!telegram_id) {
    return res.status(400).json({ erro: "telegram_id é obrigatório." });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    
    // 1. Busca usuário e VIP com trava de linha
    const userRes = await client.query(
      "SELECT pontos, vip FROM usuarios WHERE telegram_id = $1 FOR UPDATE", 
      [telegram_id]
    );

    if (userRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ erro: "Usuário não encontrado." });
    }

    const pontos = parseFloat(userRes.rows[0].pontos || 0);
    const vip = userRes.rows[0].vip;

    // Preço: 0.80 para normal, 0.70 para VIP
    const preco = vip ? 0.70 : 0.80;

    if (pontos < preco) {
      await client.query("ROLLBACK");
      return res.status(400).json({ erro: "Pontos insuficientes para o pacote." });
    }

    // 2. Desconta os pontos
    await client.query(
      "UPDATE usuarios SET pontos = (pontos::NUMERIC - CAST($1 AS NUMERIC)) WHERE telegram_id = $2", 
      [preco.toFixed(2), telegram_id]
    );

    // 3. Credita 5 tickets
    await client.query(`
      INSERT INTO roleta_tickets (telegram_id, usado, data_registro) 
      VALUES 
      ($1, false, CURRENT_DATE),
      ($1, false, CURRENT_DATE),
      ($1, false, CURRENT_DATE),
      ($1, false, CURRENT_DATE),
      ($1, false, CURRENT_DATE)
    `, [telegram_id]);

    // 4. Registra no histórico de movimentações
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

  // 1. Validação de segurança rigorosa
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

    if (valorZER <= 0 || !user) {
      return res.send("ok");
    }

    await client.query("BEGIN");

    // 2. Busca o fator de câmbio (valor_zer) mais recente da tabela cotacoes
    const cotacaoRes = await client.query(
      "SELECT valor_zer FROM cotacoes ORDER BY data_registro DESC, id DESC LIMIT 1"
    );

    // Se houver valor cadastrado na tabela, usa ele como multiplicador (exchange), senão usa um padrão seguro
    const fatorExchange = cotacaoRes.rows.length > 0 ? parseFloat(cotacaoRes.rows[0].valor_zer) : 0.36;
    
    // Aplicação direta do modelo do ZerAds (amount * exchange) já aplicando os 40% de repasse
    const percentualRepasse = 0.40; 
    const pontosCalculados = (valorZER * fatorExchange) * percentualRepasse;
    
    const pontosFinal = pontosCalculados.toFixed(8);
    const xpGerado = totalClicks * 6;

    // 3. Atualizar pontos do usuário de forma segura
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

    // 4. Registrar no histórico unificado (historico_ganhos)
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
    
    console.log(`✅ Créditos ZerAds Corrigidos: ${pontosFinal} pts | ZER: ${valorZER} | Fator: ${fatorExchange} | XP: ${xpGerado} | Usuário: ${user}`);
    res.send("ok");

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("🔥 Erro ZerAds:", err);
    res.status(500).send("erro");
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

            // 2. Cálculo Direto e Seguro (Respeitando os 40% de repasse sobre a recompensa configurada)
            const pontosCalculados = rewardAmount * percentualRepasse;
            const pontosFinal = pontosCalculados.toFixed(8); // Compatível com colunas NUMERIC

            // 3. Inserção no histórico de ganhos
            await client.query(
                `INSERT INTO historico_ganhos (telegram_id, origem, pontos, nome_tarefa, referencia_id, data_registro) 
                 VALUES ($1, 'moneyrain', CAST($2 AS NUMERIC), $3, $4, NOW())`,
                [userId, pontosFinal, nomeTarefa, viewId.toString()]
            );

            // 4. Atualização de Saldo do usuário
            await client.query(
                `UPDATE usuarios 
                 SET pontos = COALESCE(pontos, 0) + CAST($1 AS NUMERIC)
                 WHERE telegram_id = $2`,
                [pontosFinal, userId]
            );

            // 5. Integração de Nível e XP
            const resultadoXp = await adicionarXP(userId, 5, client);

            // 6. Disparo de Metas e Boosters
            const metaBatida = await verificarMetaDiaria(client, userId);
            
            let infoBooster = { liberado: false };
            if (metaBatida) {
                infoBooster = await verificarMissaoEntrada(client, userId);
            }

            await client.query('COMMIT');
            console.log(`✅ MoneyRain Sucesso! Usuário ${userId} recebeu ${pontosFinal} pts | Meta: ${metaBatida}`);
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

async function verificarMetaDiaria(client, telegram_id) {
    // 1. Soma os pontos de hoje considerando o fuso de Brasília
    const res = await client.query(`
        SELECT SUM(pontos) as total_pontos
        FROM historico_ganhos 
        WHERE telegram_id = $1 
        AND (data_registro AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
    `, [telegram_id]);

    const stats = res.rows[0];
    const pontosHoje = parseFloat(stats.total_pontos) || 0;

    // Nova meta diária flexível: atingir 0.30 pontos no total do dia
    const metaCumprida = pontosHoje >= 0.30;

    if (metaCumprida) {
        const check = await client.query(`
            SELECT meta_cumprida_hoje FROM usuarios_streaks WHERE telegram_id = $1 FOR UPDATE
        `, [telegram_id]);

        // Apenas MARCA que a meta do dia foi cumprida. O incremento do streak acontece na virada do dia!
        if (check.rows.length > 0 && !check.rows[0].meta_cumprida_hoje) {
            await client.query(`
                UPDATE usuarios_streaks 
                SET meta_cumprida_hoje = TRUE
                WHERE telegram_id = $1
            `, [telegram_id]);
        }
    }
    return metaCumprida;
}

async function verificarMissaoEntrada(client, telegram_id) {
    try {
        const query = `
            SELECT u.booster_usado,
                   (SELECT COUNT(*) FROM historico_ganhos WHERE telegram_id = u.telegram_id AND origem = 'moneyrain') as total_moneyrain
            FROM usuarios u
            WHERE u.telegram_id = $1 
            FOR UPDATE
        `;

        const res = await client.query(query, [telegram_id]);

        if (res.rows.length > 0) {
            const usuario = res.rows[0];
            const totalMoneyRain = parseInt(usuario.total_moneyrain) || 0;
            const jaUsou = usuario.booster_usado;

            // Fez 1 MoneyRain na vida e ainda não havia resgatado a missão de entrada
            if (totalMoneyRain >= 1 && !jaUsou) {
                await client.query(`
                    UPDATE usuarios 
                    SET booster_usado = TRUE 
                    WHERE telegram_id = $1
                `, [telegram_id]);

                return { 
                    liberado: true, 
                    mensagem: "🎉 Missão de entrada concluída! Você já pode realizar seu saque imediato." 
                };
            }
        }
        
        return { liberado: false };

    } catch (error) {
        console.error("Erro na Missão de Entrada:", error);
        throw error;
    }
}

app.post("/api/resgatar-bonus-reativacao", async (req, res) => {
  let { telegram_id } = req.body;

  telegram_id = String(telegram_id || "").trim();

  if (!telegram_id) {
    return res.status(400).json({ erro: "Dados inválidos" });
  }

  if (!checkRateLimit(telegram_id)) {
    return res.status(429).json({ erro: "Muitas requisições. Aguarde um instante." });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 🔒 1. Verifica se o usuário existe e se já resgatou o bônus antes
    const userRes = await client.query(
      `SELECT bonus_reativacao_resgatado FROM usuarios WHERE telegram_id = $1`,
      [telegram_id]
    );

    if (userRes.rows.length === 0) {
      throw new Error("Usuário não encontrado.");
    }

    if (userRes.rows[0].bonus_reativacao_resgatado) {
      throw new Error("Você já resgatou este bônus de reativação anteriormente!");
    }

    // 💰 2. Valor do Bônus (0.05 pontos calculados para ser seguro e atraente)
    const bonusPontos = 0.05;
    const xpGerado = 15;

    // 📝 3. Marca como resgatado na tabela usuarios
    await client.query(
      `UPDATE usuarios SET bonus_reativacao_resgatado = TRUE, pontos = COALESCE(pontos, 0) + $1 WHERE telegram_id = $2`,
      [bonusPontos, telegram_id]
    );

    // 📊 4. Registra no histórico unificado de ganhos
    await client.query(
      `INSERT INTO historico_ganhos (telegram_id, origem, pontos, nome_tarefa, referencia_id, data_registro)
       VALUES ($1, 'bonus_reativacao', $2, $3, $4, NOW())`,
      [telegram_id, bonusPontos, "🎁 Bônus de Reativação + Monetag", "reativacao_ad"]
    );

    // ⭐ 5. Adiciona XP para movimentar o nível
    await adicionarXP(telegram_id, xpGerado, client);

    await client.query("COMMIT");
    
    console.log(`✅ Bônus Reativação Resgatado: +${bonusPontos} pts | Usuário: ${telegram_id}`);
    res.json({ 
      sucesso: true, 
      mensagem: "🎉 Bônus de reativação resgatado com sucesso!" 
    });

  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ erro: err.message || "Erro interno ao processar bônus." });
  } finally {
    client.release();
  }
});

app.post("/api/abrir-bau", async (req, res) => {
    const { telegram_id } = req.body;
    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        // 1. Check de consistência híbrido: Verifica dias distintos reais no histórico E o status do streak
        const checkRes = await client.query(`
            SELECT 
                us.bau_disponivel, 
                us.streak_atual, 
                u.nivel,
                (
                    SELECT COUNT(DISTINCT (h.data_registro AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date) 
                    FROM historico_ganhos h 
                    WHERE h.telegram_id = $1
                ) as dias_ativos
            FROM usuarios_streaks us
            JOIN usuarios u ON us.telegram_id = u.telegram_id
            WHERE us.telegram_id = $1 FOR UPDATE
        `, [telegram_id]);

        if (checkRes.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ success: false, error: "Usuário ou dados de streak não encontrados." });
        }

        const dadosUsuario = checkRes.rows[0];
        const diasAtivos = parseInt(dadosUsuario.dias_ativos || 0);
        const streakAtual = parseInt(dadosUsuario.streak_atual || 0);
        const bauDisponivel = dadosUsuario.bau_disponivel;
        const nivel = dadosUsuario.nivel;

        // 2. NOVA TRAVA DE SEGURANÇA: Verificar data da última abertura de baú no histórico
        const ultimaAberturaBauRes = await client.query(`
            SELECT data_registro 
            FROM historico_ganhos 
            WHERE telegram_id = $1 AND origem = 'bau_semanal' 
            ORDER BY data_registro DESC 
            LIMIT 1
        `, [telegram_id]);

        if (ultimaAberturaBauRes.rows.length > 0) {
            const ultimaData = new Date(ultimaAberturaBauRes.rows[0].data_registro);
            const agora = new Date();
            const diferencaDias = (agora - ultimaData) / (1000 * 60 * 60 * 24);

            // Se tentou abrir com menos de 5 dias da última abertura, é fraude/exploit!
            if (diferencaDias < 5) {
                const adminId = process.env.ADMIN_TELEGRAM_ID || "1677694125";
                if (adminId && typeof bot !== 'undefined' && bot.telegram) {
                    const alertaFraude = `🚨 **ALERTA DE SEGURANÇA: TENTATIVA DE EXPLOIT EM BAÚ!**\n\n` +
                        `👤 **Usuário ID:** \`${telegram_id}\`\n` +
                        `⏱️ **Intervalo Suspeito:** Último baú aberto há apenas ${diferencaDias.toFixed(2)} dias.\n` +
                        `⚠️ *A ação foi bloqueada automaticamente pelo servidor.*`;
                    
                    await bot.telegram.sendMessage(adminId, alertaFraude, { parse_mode: "Markdown" }).catch(()=>{});
                }

                await client.query("ROLLBACK");
                return res.status(400).json({ 
                    success: false, 
                    error: "Ação bloqueada por segurança: Intervalo mínimo entre baús não respeitado." 
                });
            }
        }

        // 3. Validação rigorosa padrão: exige pelo menos 5 dias distintos reais E streak atual >= 5
        if (!bauDisponivel || diasAtivos < 5 || streakAtual < 5) {
            await client.query("ROLLBACK");
            return res.status(400).json({ 
                success: false, 
                error: `Baú não disponível. Você possui ${diasAtivos} dia(s) ativo(s) e streak de ${streakAtual}. São necessários 5 dias cumpridos.` 
            });
        }

        // 4. Calcula o prêmio em pontos para o ciclo de 5 dias
        const base = 0.30;
        const fatorNivel = 0.05;
        const teto = 0.60;
        const premioPontos = Math.min(base + (nivel * fatorNivel), teto);

        // 5. Atualiza Saldo do Usuário
        await client.query(`
            UPDATE usuarios 
            SET pontos = pontos + $1 
            WHERE telegram_id = $2
        `, [premioPontos, telegram_id]);

        // 6. Insere no Histórico de Ganhos
        await client.query(`
            INSERT INTO historico_ganhos 
            (telegram_id, origem, pontos, nome_tarefa, data_registro) 
            VALUES ($1, 'bau_semanal', $2, 'Baú de 5 Dias (Nível ' || $3 || ')', NOW())
        `, [telegram_id, premioPontos, nivel]);

        // 7. Atualiza o status do baú na tabela streaks e reseta o streak para o próximo ciclo
        await client.query(`
            UPDATE usuarios_streaks 
            SET bau_disponivel = FALSE, streak_atual = 0 
            WHERE telegram_id = $1
        `, [telegram_id]);

        await client.query("COMMIT");

        res.json({
            success: true,
            mensagem: "🎉 Baú de 5 dias aberto com sucesso!",
            premioPontos: premioPontos.toFixed(8)
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

app.post('/api/marcar-alerta-visto', async (req, res) => {
    const telegramId = req.headers['x-telegram-id'] || req.body.telegram_id;
    const { tipo_alerta } = req.body;

    if (!telegramId || !tipo_alerta) {
        return res.status(400).json({ success: false, error: 'Parâmetros ausentes' });
    }

    try {
        // Substitua 'client' por 'pool' (ou verifique se sua conexão se chama pool)
        await pool.query(
            `INSERT INTO usuarios_notificacoes_vistas (telegram_id, tipo_alerta, data_visto) 
             VALUES ($1, $2, CURRENT_DATE) 
             ON CONFLICT (telegram_id, tipo_alerta, data_visto) DO NOTHING`,
            [telegramId, tipo_alerta]
        );

        res.json({ success: true });
    } catch (err) {
        console.error("Erro ao marcar alerta visto:", err);
        res.status(500).json({ success: false, error: err.message });
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
    
    if (!telegram_id) {
        return res.status(400).json({ error: "telegram_id é obrigatório" });
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // 1. Busca dados do usuário, streaks, data de criação e pontos de hoje usando hora confiável do banco
        const result = await client.query(`
            SELECT 
                u.data_registro::date as data_criacao,
                u.booster_usado,
                u.pontos as saldo_total,
                u.escudos,
                us.streak_atual, 
                us.bau_disponivel,
                us.streak_quebrado,
                us.meta_cumprida_hoje,
                us.ultima_data_checkin,
                COALESCE((
                    SELECT SUM(pontos::numeric) 
                    FROM historico_ganhos 
                    WHERE telegram_id = u.telegram_id 
                    AND (data_registro AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
                ), 0) as pontos_hoje,
                COALESCE((
                    SELECT COUNT(*) 
                    FROM historico_ganhos 
                    WHERE telegram_id = u.telegram_id 
                    AND origem = 'moneyrain'
                ), 0) as total_moneyrain
            FROM usuarios u
            JOIN usuarios_streaks us ON u.telegram_id = us.telegram_id
            WHERE u.telegram_id = $1
            FOR UPDATE OF u, us
        `, [telegram_id]);

        let data = result.rows[0];

        if (!data) {
            await client.query("ROLLBACK");
            return res.status(404).json({ error: "Usuário não encontrado" });
        }

        const pontosHoje = parseFloat(data.pontos_hoje) || 0;
        const metaDiariaAlvo = 0.30;
        const metaBatidaHoje = pontosHoje >= metaDiariaAlvo || data.meta_cumprida_hoje === true;

        // =========================================================================
        // 🛡️ TRAVAS DE SEGURANÇA MESTRES CONTRA MANIPULAÇÃO DE STREAK E RELÓGIO
        // =========================================================================

        let streakAtual = parseInt(data.streak_atual || 0);

        // A. Trava Absoluta da Idade da Conta (Anti-Fake Streak)
        const diasDeVidaContaRes = await client.query(`SELECT EXTRACT(DAY FROM (NOW() - $1::timestamp))::int as dias`, [data.data_criacao]);
        const diasDeVidaConta = Math.max(0, parseInt(diasDeVidaContaRes.rows[0]?.dias || 0));

        if (streakAtual > (diasDeVidaConta + 1)) {
            console.warn(`🚨 [ALERTA DE FRAUDE] Usuário ${telegram_id} tentou burlar streak! Streak: ${streakAtual}, Dias de vida: ${diasDeVidaConta}`);
            streakAtual = Math.min(streakAtual, diasDeVidaConta + 1);
            
            // Notifica o Admin no Telegram sobre a tentativa de fraude
            const adminId = process.env.ADMIN_TELEGRAM_ID || "1677694125";
            if (adminId && typeof bot !== 'undefined' && bot.telegram) {
                const alertaFraude = `🚨 **TENTATIVA DE FRAUDE DETECTADA (STREAK)**\n\n` +
                    `👤 **Usuário ID:** \`${telegram_id}\`\n` +
                    `⚠️ *O streak foi corrigido à força para o limite real de vida da conta (${diasDeVidaConta} dias).*`;
                await bot.telegram.sendMessage(adminId, alertaFraude, { parse_mode: "Markdown" }).catch(()=>{});
            }
        }

        // B. Horário Confiável Oficial do Servidor PostgreSQL (NOW())
        const horaOficialRes = await client.query(`SELECT NOW() AT TIME ZONE 'America/Sao_Paulo' as agora_oficial`);
        const hojeBr = new Date(horaOficialRes.rows[0].agora_oficial).toLocaleDateString('sv-SE');
        
        const ultimaDataCheckinBr = data.ultima_data_checkin 
            ? new Date(data.ultima_data_checkin).toLocaleDateString('sv-SE') 
            : null;

        let streakQuebrado = data.streak_quebrado || false;
        let bauDisponivel = data.bau_disponivel || false;
        let metaCumpridaHojeBanco = data.meta_cumprida_hoje || false;

        // =========================================================================
        // 🔄 VIRADA DE DIA E AUDITORIA RETROSPECTIVA
        // =========================================================================
        if (ultimaDataCheckinBr && ultimaDataCheckinBr < hojeBr) {
            
            // Auditoria Retrospectiva Cega: Soma o que o usuário REALMENTE fez no dia anterior no histórico
            const auditoriaDiaAnterior = await client.query(`
                SELECT COALESCE(SUM(pontos::numeric), 0) as total_dia
                FROM historico_ganhos
                WHERE telegram_id = $1 
                  AND (data_registro AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date = $2::date
            `, [telegram_id, ultimaDataCheckinBr]);

            const pontosReaisOntem = parseFloat(auditoriaDiaAnterior.rows[0].total_dia);
            const bateuMetaRealOntem = pontosReaisOntem >= 0.30;
            const escudosAtuais = parseInt(data.escudos || 0);

            if (bateuMetaRealOntem) {
                streakAtual += 1; // Incrementa apenas se o extrato comprovar a meta real
            } else if (escudosAtuais > 0) {
                await client.query(`UPDATE usuarios SET escudos = escudos - 1 WHERE telegram_id = $1`, [telegram_id]);
            } else {
                streakAtual = 0;
                streakQuebrado = true;
            }

            // Validação de dias distintos reais para liberação do Baú
            if (streakAtual >= 5) {
                const diasComAtividadeRes = await client.query(`
                    SELECT COUNT(DISTINCT (data_registro AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date) as dias_validos
                    FROM historico_ganhos
                    WHERE telegram_id = $1
                      AND data_registro >= CURRENT_DATE - INTERVAL '6 days'
                `, [telegram_id]);

                const diasValidosReais = parseInt(diasComAtividadeRes.rows[0].dias_validos || 0);
                bauDisponivel = (diasValidosReais >= 5);
            }

            metaCumpridaHojeBanco = false; 

            // Atualiza o banco com os dados auditados
            await client.query(`
                UPDATE usuarios_streaks 
                SET streak_atual = $1,
                    meta_cumprida_hoje = $2,
                    ultima_data_checkin = $3,
                    streak_quebrado = $4,
                    bau_disponivel = $5
                WHERE telegram_id = $6
            `, [streakAtual, metaCumpridaHojeBanco, hojeBr, streakQuebrado, bauDisponivel, telegram_id]);
            
        } else if (!ultimaDataCheckinBr) {
            await client.query(`
                UPDATE usuarios_streaks 
                SET ultima_data_checkin = $1 
                WHERE telegram_id = $2
            `, [hojeBr, telegram_id]);
        }

        if (metaBatidaHoje && !metaCumpridaHojeBanco) {
            await client.query(`
                UPDATE usuarios_streaks 
                SET meta_cumprida_hoje = TRUE 
                WHERE telegram_id = $1
            `, [telegram_id]);
        }

        const notifRes = await client.query(`
            SELECT tipo_alerta FROM usuarios_notificacoes_vistas 
            WHERE telegram_id = $1 AND referencia_data = CURRENT_DATE
        `, [telegram_id]);

        const vistasHoje = notifRes.rows.map(r => r.tipo_alerta);

        await client.query("COMMIT");

        const totalMoneyRain = parseInt(data.total_moneyrain) || 0;
        const missaoEntradaConcluida = totalMoneyRain >= 1 || data.booster_usado === true;

        const alertasPendentes = {
            streak_perdido: streakQuebrado && !vistasHoje.includes('streak_perdido'),
            meta_concluida: metaBatidaHoje && !vistasHoje.includes('meta_concluida'),
            bau_pronto: bauDisponivel && !vistasHoje.includes('bau_pronto')
        };

        res.json({
            success: true,
            progresso_pontos: {
                atual: pontosHoje.toFixed(2),
                meta: metaDiariaAlvo.toFixed(2),
                porcentagem: Math.min((pontosHoje / metaDiariaAlvo) * 100, 100).toFixed(1),
                concluido: metaBatidaHoje
            },
            missao_entrada: {
                concluida: missaoEntradaConcluida,
                saque_liberado: missaoEntradaConcluida,
                booster_registrado: data.booster_usado
            },
            streak: { 
                streak_atual: streakAtual, 
                bau_disponivel: bauDisponivel,
                streak_quebrado: streakQuebrado
            },
            alertas_pendentes: alertasPendentes,
            data_criacao: data.data_criacao
        });

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("Erro na rota /api/status-checklist:", err);
        res.status(500).json({ error: "Erro interno no servidor" });
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
    2: { xp_min: 100, titulo: "Explorador", limite_saque: 2, giros: 6, tempo_ad: 14, premios: { tickets: 0 } }, // Reduzido de 1 para 0
    3: { xp_min: 300, titulo: "Caçador", limite_saque: 3, giros: 7, tempo_ad: 13, premios: { tickets: 1, escudo: 1 } }, // Reduzido de 2 para 1
    4: { xp_min: 600, titulo: "Mestre", limite_saque: 4, giros: 8, tempo_ad: 10, premios: { tickets: 1 } }, // Reduzido de 3 para 1
    5: { xp_min: 1000, titulo: "Lenda", limite_saque: 5, giros: 10, tempo_ad: 8, premios: { tickets: 2 } } // Reduzido de 5 para 2
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

    // Busca o ID e a data da última premiação de indicação
    const historicoRes = await pool.query(
      "SELECT id, data_registro FROM historico_ganhos WHERE telegram_id = $1 AND origem = 'indicacao' ORDER BY data_registro DESC LIMIT 1",
      [telegram_id]
    );

    res.json({
      totalAprovadas: parseInt(totalRes.rows[0].count),
      ultimaPremiacaoId: historicoRes.rows.length > 0 ? historicoRes.rows[0].id : null,
      ultimaPremiacaoData: historicoRes.rows.length > 0 ? historicoRes.rows[0].data_registro : null
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
  // 🛡️ Captura o fingerprint enviado pelo frontend no corpo da requisição e o IP real
  const { telegram_id, chave_pix, fingerprint } = req.body;
  
  if (!telegram_id) {
    return res.status(401).json({ error: "User identification missing / Identificação do usuário ausente." });
  }

  const rawIP = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";
  const ip = rawIP.split(",")[0].trim();

  const emailLimpo = chave_pix ? chave_pix.trim().toLowerCase() : "";
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(emailLimpo)) {
    return res.status(400).json({ error: "Invalid email format / Formato de e-mail inválido." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Busca dados do usuário, status e idioma para garantir mensagens corretas
    const userResult = await client.query(
      `SELECT u.pontos, u.vip, u.lang, u.status_conta, u.nivel, u.booster_usado,
              (SELECT COUNT(*) FROM historico_ganhos WHERE telegram_id = u.telegram_id AND origem = 'moneyrain') as total_moneyrain,
              (SELECT COUNT(*) FROM saques WHERE telegram_id = u.telegram_id AND LOWER(status) != 'cancelado') as total_saques_anteriores
       FROM usuarios u WHERE u.telegram_id = $1 FOR UPDATE`, 
      [telegram_id]
    );

    if (userResult.rows.length === 0) throw new Error("USUARIO_NAO_ENCONTRADO");
    const user = userResult.rows[0];
    if (user.status_conta === 'banido') throw new Error("USUARIO_BANIDO");
    
    const { pontos, vip, lang, nivel, total_moneyrain, total_saques_anteriores } = user;
    const isEn = lang === 'en';

    // 🛡️ TRAVA DE SEGURANÇA: Verificar se o Dispositivo (Fingerprint) ou IP já foi usado por OUTRA conta para sacar
    if (fingerprint || ip) {
      const farmCheck = await client.query(
        `SELECT telegram_id FROM saques_dispositivos 
         WHERE (fingerprint = $1 AND fingerprint IS NOT NULL AND fingerprint != '') 
            OR (ip = $2 AND ip IS NOT NULL AND ip != '')`,
        [fingerprint, ip]
      );

      // Se encontrou um registro e o telegram_id associado é DIFERENTE do usuário atual
      if (farmCheck.rows.length > 0 && farmCheck.rows[0].telegram_id.toString() !== telegram_id.toString()) {
        const contaOriginal = farmCheck.rows[0].telegram_id;
        console.warn(`🚨 [TESTE DE SEGURANÇA] Dispositivo/IP compartilhado detectado! Tentativa de saque na conta ${telegram_id} vinculada à conta original ${contaOriginal}`);

        // 🔔 NOTIFICAÇÃO AO ADMIN NO TELEGRAM (Apenas avisa e barra o saque, SEM bloquear a conta)
        const adminId = process.env.ADMIN_TELEGRAM_ID || "1677694125";
        if (adminId && typeof bot !== 'undefined' && bot.telegram) {
          const mensagemAlerta = `🚨 **ALERTA: DISPOSITIVO DUPLICADO EM SAQUE!**\n\n` +
            `👤 **Conta Tentando Sacar:** \`${telegram_id}\`\n` +
            `🔗 **Conta Original do Aparelho:** \`${contaOriginal}\`\n` +
            `💻 **Fingerprint:** \`${fingerprint || 'N/D'}\`\n` +
            `🌐 **IP:** \`${ip}\`\n\n` +
            `⚠️ *O saque foi impedido pelo sistema de segurança.*`;
          
          await bot.telegram.sendMessage(adminId, mensagemAlerta, { parse_mode: "Markdown" }).catch(() => {});
        }

        throw new Error("DISPOSITIVO_DUPLICADO");
      }
    }

    // 🛡️ TRAVA CENTRALIZADA DE CHAVE FAUCETPAY / PIX
    const fpControleCheck = await client.query(
      `SELECT telegram_id_original, status FROM faucetpay_controle WHERE chave_faucetpay = $1`,
      [emailLimpo]
    );

    if (fpControleCheck.rows.length > 0) {
      const registroFp = fpControleCheck.rows[0];

      // 1. Se a chave estiver bloqueada por fraude anterior
      if (registroFp.status === 'bloqueado') {
        console.warn(`🚨 [SAQUE BLOQUEADO] Tentativa com chave FaucetPay banida: ${emailLimpo} na conta ${telegram_id}`);
        throw new Error("CHAVE_FAUCETPAY_BLOQUEADA");
      }

      // 2. Se a chave já pertence a OUTRO telegram_id (Tentativa de Multi-conta / Farm)
      if (registroFp.telegram_id_original.toString() !== telegram_id.toString()) {
        console.warn(`🚨 [FARM DETECTADA] A chave FaucetPay ${emailLimpo} da conta original ${registroFp.telegram_id_original} foi tentada pela conta ${telegram_id}`);

        // Atualiza para 'bloqueado' e soma a tentativa na tabela unificada
        await client.query(
          `UPDATE faucetpay_controle 
           SET status = 'bloqueado', 
               motivo_bloqueio = $1, 
               vezes_tentadas = vezes_tentadas + 1,
               data_ultimo_uso = NOW() 
           WHERE chave_faucetpay = $2`,
          [`Uso cruzado entre contas (${registroFp.telegram_id_original} e ${telegram_id})`, emailLimpo]
        );

        // 🔔 ALERTA NO TELEGRAM PARA O ADMINISTRADOR
        const adminId = process.env.ADMIN_TELEGRAM_ID || "1677694125";
        if (adminId && typeof bot !== 'undefined' && bot.telegram) {
          const mensagemAlerta = `🚨 **ALERTA: FRAUDE DE CHAVE FAUCETPAY COMPARTILHADA!**\n\n` +
            `👤 **Conta Tentando Sacar:** \`${telegram_id}\`\n` +
            `🔗 **Dono Original da Chave:** \`${registroFp.telegram_id_original}\`\n` +
            `💳 **Chave/E-mail:** \`${emailLimpo}\`\n\n` +
            `🔒 *A chave foi bloqueada automaticamente e o saque impedido.*`;
          
          await bot.telegram.sendMessage(adminId, mensagemAlerta, { parse_mode: "Markdown" }).catch(() => {});
        }

        throw new Error("CHAVE_FAUCETPAY_DUPLICADA");
      }
    } else {
      // Se a chave nunca foi usada, cadastra ela vinculada a este usuário pela primeira vez
      await client.query(
        `INSERT INTO faucetpay_controle (chave_faucetpay, telegram_id_original, status, data_primeiro_uso, data_ultimo_uso)
         VALUES ($1, $2, 'ativo', NOW(), NOW())`,
        [emailLimpo, telegram_id]
      );
    }

    // 🔒 TRAVA ANTI-DUPLICAÇÃO: Impede novo saque se houver pendente ('Aguardando Chat' ou 'Waiting')
    const saquePendenteRes = await client.query(
      `SELECT id FROM saques 
       WHERE telegram_id = $1 
         AND status IN ('Aguardando Chat', 'Waiting')`,
      [telegram_id]
    );

    if (saquePendenteRes.rows.length > 0) {
      throw new Error("SAQUE_PENDENTE_EXISTENTE");
    }

    const limiteSaques = (typeof TABELA_NIVEIS !== 'undefined' && TABELA_NIVEIS[nivel]?.limite_saque) ? TABELA_NIVEIS[nivel].limite_saque : 1;
    const saquesHoje = await client.query(`
      SELECT COUNT(*) FROM saques 
      WHERE telegram_id = $1 AND DATE(data_solicitacao) = CURRENT_DATE
    `, [telegram_id]);

    if (parseInt(saquesHoje.rows[0].count) >= limiteSaques) throw new Error("LIMITE_ATINGIDO");

    // 💡 REGRA DA MISSÃO DE ENTRADA: 
    const éPrimeiroSaqueMoneyRain = (parseInt(total_saques_anteriores) === 0 && parseInt(total_moneyrain) >= 1);

    // 🎯 Mínimo de 0.15 para VIP e 0.30 para Usuários Padrão
    const pontosMinimos = vip ? 0.15 : 0.30;

    if (!éPrimeiroSaqueMoneyRain && pontos < pontosMinimos) {
      throw new Error("PONTOS_INSUFICIENTES");
    }

    if (pontos <= 0) {
      throw new Error("PONTOS_INSUFICIENTES");
    }

    const VALOR_DO_PONTO_EM_BRL = 0.05;
    let valorCalculado = pontos * VALOR_DO_PONTO_EM_BRL;
    
    const saqueInsert = await client.query(`
      INSERT INTO saques (telegram_id, pontos_solicitados, valor_solicitado, chave_pix, status, data_solicitacao)
      VALUES ($1, $2, $3, $4, 'Aguardando Chat', NOW()) RETURNING id
    `, [telegram_id, pontos, valorCalculado.toFixed(2), emailLimpo]);

    const saqueId = saqueInsert.rows[0].id;

    // Registra ou atualiza o vínculo deste telegram_id com este fingerprint/IP na tabela de controle
    if (fingerprint || ip) {
      await client.query(
        `INSERT INTO saques_dispositivos (telegram_id, fingerprint, ip, data_registro)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (telegram_id) 
         DO UPDATE SET fingerprint = COALESCE(EXCLUDED.fingerprint, saques_dispositivos.fingerprint),
                       ip = COALESCE(EXCLUDED.ip, saques_dispositivos.ip)`,
        [telegram_id, fingerprint, ip]
      );
    }

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

    res.json({ success: true, message: isEn ? "Check your Telegram chat to confirm the withdrawal." : "Verifique seu chat do Telegram para confirmar o saque." });

  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`[ERRO SAQUE] Usuário: ${telegram_id}, Erro: ${err.message}`);
    
    // Identifica o idioma atualizado do usuário para a resposta do erro
    let isEn = false;
    try {
      const langCheck = await pool.query("SELECT lang FROM usuarios WHERE telegram_id = $1", [telegram_id]);
      isEn = langCheck.rows[0]?.lang === 'en';
    } catch (e) {}

    let msg = isEn ? "Internal error processing withdrawal." : "Erro interno ao processar saque.";
    
    if (err.message === "SAQUE_PENDENTE_EXISTENTE") {
      msg = isEn 
        ? "You already have a pending withdrawal request. Complete or cancel it before requesting a new one." 
        : "Você já possui um pedido de saque pendente. Conclua ou cancele o anterior antes de solicitar um novo.";
    } else if (err.message === "DISPOSITIVO_DUPLICADO") {
      msg = isEn 
        ? "Security restriction: This device has already been linked to another payout account." 
        : "Restrição de segurança: Este dispositivo já está vinculado a outra conta de pagamento.";
    } else if (err.message === "CHAVE_FAUCETPAY_BLOQUEADA" || err.message === "CHAVE_FAUCETPAY_DUPLICADA") {
      msg = isEn 
        ? "Security restriction: This payment email is already linked to another account or restricted." 
        : "Restrição de segurança: Este e-mail de pagamento já está vinculado a outra conta ou possui restrições.";
    } else if (err.message === "USUARIO_NAO_ENCONTRADO") {
      msg = isEn ? "User not found." : "Usuário não encontrado.";
    } else if (err.message === "USUARIO_BANIDO") {
      msg = isEn ? "Account banned." : "Conta banida.";
    } else if (err.message === "LIMITE_ATINGIDO") {
      msg = isEn ? "Daily limit reached." : "Limite diário atingido.";
    } else if (err.message === "PONTOS_INSUFICIENTES") {
      msg = isEn ? "Insufficient points." : "Pontos insuficientes.";
    }
                
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


// 1. Rota para listar saques com status "Aguardando Chat"
app.get('/api/admin/pending-withdrawals', async (req, res) => {
    const { adminKey } = req.query;
    if (adminKey !== process.env.ADMIN_KEY) {
        return res.status(403).json({ success: false, message: 'ADMIN_KEY inválida.' });
    }

    try {
        const result = await db.query(
            "SELECT id, telegram_id, valor_solicitado, chave_pix FROM saques WHERE status = 'Aguardando Chat' ORDER BY data_solicitacao DESC"
        );
        res.json({ success: true, withdrawals: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// =========================================================================
// 🔹 Rota 1: Envio Rápido Direto (Individual)
// =========================================================================
app.post('/api/admin/notify', async (req, res) => {
    const { adminKey, telegramId, message } = req.body;
    
    // Suporte tanto para x-admin-key no header quanto para adminKey no body
    const keyAuth = adminKey || req.headers['x-admin-key'];
    if (keyAuth !== process.env.ADMIN_KEY) {
        return res.status(403).json({ success: false, message: 'ADMIN_KEY inválida.' });
    }

    if (!telegramId || !message) {
        return res.status(400).json({ success: false, message: 'Telegram ID ou mensagem não informados.' });
    }

    try {
        await bot.telegram.sendMessage(telegramId, message, { parse_mode: "Markdown" });
        res.json({ success: true, message: 'Mensagem enviada com sucesso.' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Erro no bot: ' + err.message });
    }
});


// =========================================================================
// 🔹 Rota 2: Central de Notificação (Individual, Lista por ';', Filtros e Massa)
// =========================================================================
app.post("/api/admin/enviar-notificacao-personalizada", verificarAdmin, async (req, res) => {
  const { tipo, telegram_id, lista_ids, filtro, mensagem_pt, mensagem_en } = req.body;

  if (!mensagem_pt && !mensagem_en) {
    return res.status(400).json({ success: false, error: "Preencha ao menos uma mensagem (PT ou EN)." });
  }

  try {
    let destinatarios = [];

    // 1. ENVIO INDIVIDUAL
    if (tipo === 'individual') {
      if (!telegram_id) {
        return res.status(400).json({ success: false, error: "Telegram ID não informado." });
      }
      destinatarios.push(String(telegram_id).trim());
    }

    // 2. ENVIO PARA LISTA DE IDs (Separados por ponto e vírgula ';')
    else if (tipo === 'lista') {
      if (!lista_ids) {
        return res.status(400).json({ success: false, error: "Nenhuma lista de IDs informada." });
      }
      destinatarios = lista_ids
        .split(';')
        .map(id => String(id).trim())
        .filter(id => id.length > 0);

      if (destinatarios.length === 0) {
        return res.status(400).json({ success: false, error: "A lista informada não contém IDs válidos." });
      }
    }

    // 3. ENVIO POR FILTROS AVANÇADOS
    else if (tipo === 'filtro') {
      let queryFiltro = "";
      let paramsFiltro = [];

      if (filtro === 'lang_pt') {
        queryFiltro = "SELECT telegram_id FROM usuarios WHERE lang = 'pt' AND (status_conta IS NULL OR status_conta = 'ativo')";
      } else if (filtro === 'lang_en') {
        queryFiltro = "SELECT telegram_id FROM usuarios WHERE lang = 'en' AND (status_conta IS NULL OR status_conta = 'ativo')";
      } else if (filtro === 'saques_pendentes') {
        // Busca usuários que possuem saques com status pendente ou aguardando chat
        queryFiltro = "SELECT DISTINCT telegram_id FROM saques WHERE status = 'pendente' OR status = 'aguardando_chat'";
      } else if (filtro === 'inativos_7d') {
        // Exemplo: usuários que não movimentam ganho há mais de 7 dias
        queryFiltro = `
          SELECT u.telegram_id FROM usuarios u 
          WHERE (u.status_conta IS NULL OR u.status_conta = 'ativo')
          AND NOT EXISTS (
            SELECT 1 FROM historico_ganhos h 
            WHERE h.telegram_id = u.telegram_id 
            AND h.data_registro >= NOW() - INTERVAL '7 days'
          )
        `;
      } else {
        return res.status(400).json({ success: false, error: "Critério de filtro inválido." });
      }

      const resFiltro = await pool.query(queryFiltro, paramsFiltro);
      destinatarios = resFiltro.rows.map(r => String(r.telegram_id));

      if (destinatarios.length === 0) {
        return res.status(400).json({ success: false, error: "Nenhum usuário encontrado para o filtro selecionado." });
      }
    }

    // 4. ENVIO EM MASSA PARA TODOS OS USUÁRIOS ATIVOS
    else if (tipo === 'massa') {
      const { rows: usuarios } = await pool.query(
        "SELECT telegram_id FROM usuarios WHERE status_conta IS NULL OR status_conta = 'ativo'"
      );
      destinatarios = usuarios.map(u => String(u.telegram_id));

      if (destinatarios.length === 0) {
        return res.status(400).json({ success: false, error: "Nenhum usuário ativo encontrado na base." });
      }
    } else {
      return res.status(400).json({ success: false, error: "Tipo de envio inválido." });
    }

    // Processamento de Disparo com Rate Limit do Telegram e verificação de idioma individual
    let enviados = 0;
    let erros = 0;

    for (const tid of destinatarios) {
      try {
        // Consulta o idioma do usuário para garantir o bilinguismo correto
        const userRes = await pool.query("SELECT lang FROM usuarios WHERE telegram_id = $1", [tid]);
        const userLang = userRes.rows[0]?.lang || 'pt';
        const textoFinal = userLang === 'en' ? (mensagem_en || mensagem_pt) : (mensagem_pt || mensagem_en);

        if (!textoFinal) continue;

        await bot.telegram.sendMessage(tid, textoFinal, { parse_mode: "Markdown" });
        enviados++;

        // Atraso de 50ms para prevenir bloqueios de taxa (Flood Control / Too Many Requests) da API do Telegram
        await new Promise(resolve => setTimeout(resolve, 50));
      } catch (err) {
        erros++;
        // Se o usuário bloqueou o bot, atualiza o status automaticamente no banco
        if (err.code === 403 || (err.message && err.message.includes('blocked by the user'))) {
          await pool.query("UPDATE usuarios SET status_conta = 'bloqueado' WHERE telegram_id = $1", [tid]).catch(() => {});
        }
      }
    }

    return res.json({ 
      success: true, 
      message: `Disparo concluído! Enviadas com sucesso: ${enviados} | Falhas/Bloqueados: ${erros} (Total processado: ${destinatarios.length})` 
    });

  } catch (err) {
    console.error("Erro ao processar notificação personalizada:", err);
    res.status(500).json({ success: false, error: "Erro interno ao processar os disparos." });
  }
});

// 🔹 7. trafico e mensurização
app.post('/api/log-traffic', async (req, res) => {
    const { utm_source, utm_medium, utm_campaign, is_converted } = req.body;
    
    // Captura os dados técnicos da requisição
    const user_ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const user_agent = req.headers['user-agent'] || null;
    const referrer = req.headers['referer'] || null;
    
    try {
        const query = `
            INSERT INTO traffic_logs (utm_source, utm_medium, utm_campaign, user_ip, user_agent, referrer, is_converted, data_registro)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        `;
        const values = [
            utm_source || 'direct', 
            utm_medium || 'none', 
            utm_campaign || 'none', 
            user_ip, 
            user_agent, 
            referrer, 
            !!is_converted
        ];
        
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

// =========================================================================
// 🔹 Rotas Admin: Gestão de Campanhas de Usuários
// =========================================================================

// Listar campanhas pendentes para moderação
app.get("/admin/campanhas-pendentes", async (req, res) => {
  const adminKey = req.headers["x-admin-key"];
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ erro: "Não autorizado" });
  }

  try {
    const result = await pool.query(
      `SELECT c.*, u.nome as nome_criador FROM campanhas_usuarios c 
       LEFT JOIN usuarios u ON c.telegram_id = u.telegram_id 
       WHERE c.status = 'pendente' ORDER BY c.id ASC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ erro: "Erro ao buscar campanhas pendentes" });
  }
});

// Aprovar ou Rejeitar Campanha
app.post("/admin/moderar-campanha", async (req, res) => {
  const adminKey = req.headers["x-admin-key"];
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ erro: "Não autorizado" });
  }

  let { campanha_id, acao } = req.body; // acao: 'aprovar' ou 'rejeitar'
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const campRes = await client.query(
      `SELECT * FROM campanhas_usuarios WHERE id = $1 FOR UPDATE`,
      [campanha_id]
    );

    if (campRes.rows.length === 0) {
      throw new Error("Campanha não encontrada.");
    }

    const camp = campRes.rows[0];

    if (acao === 'aprovar') {
      // 1. Atualiza status da campanha para ativa
      await client.query(
        `UPDATE campanhas_usuarios SET status = 'ativa' WHERE id = $1`,
        [campanha_id]
      );

      // 2. Insere na tabela oficial de tarefas para começar a rodar nas rotações (ex: Grupo 1 padrão)
      await client.query(
        `INSERT INTO tarefas (titulo, link, pontos, ativa, status, grupo_rotacao, is_vip)
         VALUES ($1, $2, $3, true, 'ativo', 1, false)`,
        [camp.titulo, camp.link, camp.pontos_por_clique]
      );

    } else if (acao === 'rejeitar') {
      // 1. Atualiza status para rejeitada
      await client.query(
        `UPDATE campanhas_usuarios SET status = 'rejeitada' WHERE id = $1`,
        [campanha_id]
      );

      // 2. Estorna/Reembolsa os pontos integrais de volta para o usuário
      await client.query(
        `UPDATE usuarios SET pontos = pontos + $1 WHERE telegram_id = $2`,
        [camp.custo_total_pontos, camp.telegram_id]
      );

      // 3. Registra estorno no histórico
      await client.query(
        `INSERT INTO historico_ganhos (telegram_id, origem, pontos, nome_tarefa, referencia_id, data_registro)
         VALUES ($1, 'estorno_campanha', $2, $3, 'campanha_rejeitada', NOW())`,
        [camp.telegram_id, camp.custo_total_pontos, `Estorno por Campanha Rejeitada (ID: ${camp.id})`]
      );
    }

    await client.query("COMMIT");
    res.json({ success: true, mensagem: `Campanha ${acao}da com sucesso!` });

  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ success: false, erro: err.message });
  } finally {
    client.release();
  }
});

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
    console.log("❌ Tentativa de aprovação sem autorização");
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
    const pontosFormatados = parseFloat(saque.pontos_solicitados).toFixed(2);

    // Atualiza o status no banco informando que foi aprovado/pago manualmente (sem ID de transação)
    await pool.query(
      "UPDATE saques SET status = 'ok', data_aprovacao = NOW() WHERE id = $1",
      [saque_id]
    );

    // Mensagem de notificação limpa para o usuário
    const mensagemSucesso = isEn
      ? `🎉 **Withdrawal Approved!**\n\nYour payout of **${pontosFormatados} Pts** has been successfully sent/approved by the admin.`
      : `🎉 **Saque Aprovado!**\n\nSeu pagamento de **${pontosFormatados} Pts** foi processado e enviado com sucesso pela administração.`;

    try {
      await bot.telegram.sendMessage(saque.telegram_id, mensagemSucesso, {
        parse_mode: "Markdown",
        disable_web_page_preview: true
      });
    } catch (telegramErr) {
      console.error(`⚠️ Erro ao enviar aviso de aprovação no chat do usuário ${saque.telegram_id}:`, telegramErr.message);
    }

    res.json({ success: true, message: "Saque marcado como aprovado com sucesso." });

  } catch (err) {
    console.error("❌ Erro fatal ao aprovar saque:", err.message);
    res.status(500).json({ error: "Erro interno do servidor ao processar aprovação." });
  }
});

// 🔹 Endpoint de Dados para o Painel de Histórico (Com Multi-Campanha A/B)
app.get('/admin/historico-dados', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  const envKey = process.env.ADMIN_KEY || "lucremais_9xK!p#2026";

  if (!adminKey || adminKey !== envKey) {
    return res.status(403).json({ error: "Acesso negado. Chave inválida." });
  }

  const { inicio, fim, campanhas } = req.query;
  const dataInicio = inicio ? `${inicio} 00:00:00` : new Date(Date.now() - 7*24*60*60*1000).toISOString();
  const dataFim = fim ? `${fim} 23:59:59` : new Date().toISOString();

  const listCampanhas = campanhas ? campanhas.split(',').filter(c => c && c !== 'TODAS') : [];
  const filtrarPorCampanha = listCampanhas.length > 0;

  const client = await pool.connect();
  try {
    // Lista todas as campanhas existentes no banco para preencher o select
    const resumoCampanhas = await client.query("SELECT DISTINCT utm_campaign FROM traffic_logs WHERE utm_campaign IS NOT NULL");
    const listaCampanhas = resumoCampanhas.rows.map(r => r.utm_campaign);

    // Condicional SQL para filtrar usuários vinculados às campanhas escolhidas via traffic_logs
    let sqlJoinTraffic = "";
    let paramsBase = [dataInicio, dataFim];

    if (filtrarPorCampanha) {
      sqlJoinTraffic = ` AND u.telegram_id::text IN (SELECT DISTINCT telegram_id::text FROM traffic_logs WHERE utm_campaign = ANY($3::text[]))`;
      paramsBase.push(listCampanhas);
    }

    // 1. KPIs
    const novosUsuarios = await client.query(
      `SELECT COUNT(*) FROM usuarios u WHERE u.data_registro BETWEEN $1 AND $2${sqlJoinTraffic}`,
      paramsBase
    );

    const usuariosAtivos = await client.query(
      `SELECT COUNT(DISTINCT h.telegram_id) FROM historico_ganhos h WHERE h.data_registro BETWEEN $1 AND $2` +
      (filtrarPorCampanha ? ` AND h.telegram_id::text IN (SELECT DISTINCT telegram_id::text FROM traffic_logs WHERE utm_campaign = ANY($3::text[]))` : ``),
      paramsBase
    );

    const retornoUsuarios = await client.query(
      `SELECT COUNT(*) FROM (
         SELECT h.telegram_id FROM historico_ganhos h 
         WHERE h.data_registro BETWEEN $1 AND $2 ` +
         (filtrarPorCampanha ? ` AND h.telegram_id::text IN (SELECT DISTINCT telegram_id::text FROM traffic_logs WHERE utm_campaign = ANY($3::text[]))` : ``) +
         ` GROUP BY h.telegram_id HAVING COUNT(DISTINCT h.data_registro::date) > 1
       ) as t`,
      paramsBase
    );

    const bloqueiosBot = await client.query(
      `SELECT COUNT(*) FROM usuarios u WHERE u.status_conta = 'bloqueado' AND u.data_registro BETWEEN $1 AND $2${sqlJoinTraffic}`,
      paramsBase
    );

    const tarefasFeitas = await client.query(
      `SELECT COUNT(*) FROM historico_ganhos h WHERE h.origem != 'saque' AND h.data_registro BETWEEN $1 AND $2` +
      (filtrarPorCampanha ? ` AND h.telegram_id::text IN (SELECT DISTINCT telegram_id::text FROM traffic_logs WHERE utm_campaign = ANY($3::text[]))` : ``),
      paramsBase
    );

    const saquesSolicitados = await client.query(
      `SELECT COUNT(*) FROM saques s WHERE s.data_solicitacao BETWEEN $1 AND $2` +
      (filtrarPorCampanha ? ` AND s.telegram_id::text IN (SELECT DISTINCT telegram_id::text FROM traffic_logs WHERE utm_campaign = ANY($3::text[]))` : ``),
      paramsBase
    );

    // 2. Séries para Gráficos
    const serieUsuarios = await client.query(
      `SELECT DATE(u.data_registro) as dia, COUNT(*) as total FROM usuarios u WHERE u.data_registro BETWEEN $1 AND $2${sqlJoinTraffic} GROUP BY DATE(u.data_registro) ORDER BY dia ASC`,
      paramsBase
    );

    const serieAtivos = await client.query(
      `SELECT DATE(h.data_registro) as dia, COUNT(DISTINCT h.telegram_id) as total FROM historico_ganhos h WHERE h.data_registro BETWEEN $1 AND $2` +
      (filtrarPorCampanha ? ` AND h.telegram_id::text IN (SELECT DISTINCT telegram_id::text FROM traffic_logs WHERE utm_campaign = ANY($3::text[]))` : ``) +
      ` GROUP BY DATE(h.data_registro) ORDER BY dia ASC`,
      paramsBase
    );

    const tiposTarefas = await client.query(
      `SELECT h.origem, COUNT(*) as total FROM historico_ganhos h WHERE h.origem != 'saque' AND h.data_registro BETWEEN $1 AND $2` +
      (filtrarPorCampanha ? ` AND h.telegram_id::text IN (SELECT DISTINCT telegram_id::text FROM traffic_logs WHERE utm_campaign = ANY($3::text[]))` : ``) +
      ` GROUP BY h.origem ORDER BY total DESC`,
      paramsBase
    );

    const serieTarefas = await client.query(
      `SELECT DATE(h.data_registro) as dia, COUNT(*) as total FROM historico_ganhos h WHERE h.origem != 'saque' AND h.data_registro BETWEEN $1 AND $2` +
      (filtrarPorCampanha ? ` AND h.telegram_id::text IN (SELECT DISTINCT telegram_id::text FROM traffic_logs WHERE utm_campaign = ANY($3::text[]))` : ``) +
      ` GROUP BY DATE(h.data_registro) ORDER BY dia ASC`,
      paramsBase
    );

    const serieSaques = await client.query(
      `SELECT DATE(s.data_solicitacao) as dia, COUNT(*) as total FROM saques s WHERE s.data_solicitacao BETWEEN $1 AND $2` +
      (filtrarPorCampanha ? ` AND s.telegram_id::text IN (SELECT DISTINCT telegram_id::text FROM traffic_logs WHERE utm_campaign = ANY($3::text[]))` : ``) +
      ` GROUP BY DATE(s.data_solicitacao) ORDER BY dia ASC`,
      paramsBase
    );

    const serieCampanhas = await client.query(
      filtrarPorCampanha
        ? `SELECT utm_campaign, COUNT(*) as total FROM traffic_logs WHERE data_registro BETWEEN $1 AND $2 AND utm_campaign = ANY($3::text[]) GROUP BY utm_campaign ORDER BY total DESC`
        : `SELECT utm_campaign, COUNT(*) as total FROM traffic_logs WHERE data_registro BETWEEN $1 AND $2 GROUP BY utm_campaign ORDER BY total DESC`,
      paramsBase
    );

    res.json({
      listaCampanhas,
      kpis: {
        usuarios: parseInt(novosUsuarios.rows[0].count),
        ativos: parseInt(usuariosAtivos.rows[0].count),
        retorno: parseInt(retornoUsuarios.rows[0].count),
        bloqueios: parseInt(bloqueiosBot.rows[0].count),
        tarefas: parseInt(tarefasFeitas.rows[0].count),
        saques: parseInt(saquesSolicitados.rows[0].count)
      },
      graficos: {
        usuarios: serieUsuarios.rows,
        ativosDiarios: serieAtivos.rows,
        tiposTarefas: tiposTarefas.rows,
        tarefas: serieTarefas.rows,
        saques: serieSaques.rows,
        campanhas: serieCampanhas.rows
      }
    });

  } catch (err) {
    console.error("Erro ao buscar dados históricos:", err);
    res.status(500).json({ error: "Erro interno no servidor." });
  } finally {
    client.release();
  }
});

// =========================================================================
// 💰 MÓDULO FINANCEIRO - ADAPTADO À ESTRUTURA REAL DO BANCO
// =========================================================================

const verificarAdminKey = (req, res, next) => {
    const key = req.headers['x-admin-key'] || req.query.key;
    if (!key || key !== process.env.ADMIN_KEY) {
        return res.status(403).json({ success: false, error: "ADMIN_KEY inválida ou não informada." });
    }
    next();
};

app.get('/api/financeiro/overview', verificarAdminKey, async (req, res) => {
    try {
        const saldosParceiros = await pool.query('SELECT * FROM financeiro_saldos_parceiros ORDER BY id ASC');
        
        const totalSaques = await pool.query(`
            SELECT COALESCE(SUM(valor_solicitado), 0) as total_pago,
                   COALESCE(SUM(pontos_solicitados), 0) as total_pontos,
                   COUNT(*) as qtd_saques 
            FROM saques 
            WHERE LOWER(status) = 'ok' OR LOWER(status) = 'pago'
        `);

        const transacoesResumo = await pool.query(`
            SELECT tipo, 
                   COALESCE(SUM(valor_usd), 0) as total_usd, 
                   COALESCE(SUM(valor_zer), 0) as total_zer 
            FROM financeiro_transacoes 
            GROUP BY tipo
        `);
        
        const mktResumo = await pool.query(`
            SELECT COALESCE(SUM(valor_investido_usd), 0) as total_mkt_usd, 
                   COALESCE(SUM(valor_investido_zer), 0) as total_mkt_zer 
            FROM financeiro_campanhas_mkt 
            WHERE status = 'ativa'
        `);

        // Busca despesas registradas nas transações
        const despesasRes = await pool.query(`
            SELECT origem_destino as nome_despesa, valor_usd as valor, 'USD' as moeda, observacao, data_registro 
            FROM financeiro_transacoes 
            WHERE tipo = 'saida_despesa' 
            ORDER BY data_registro DESC LIMIT 10
        `);

        // Busca campanhas de marketing recentes
        const marketingRes = await pool.query(`
            SELECT plataforma, tipo_anuncio, utm_source, utm_campaign, valor_investido_usd as valor, 'USD' as moeda, data_inicio as data_registro 
            FROM financeiro_campanhas_mkt 
            ORDER BY data_inicio DESC LIMIT 10
        `);

        const cotacaoRes = await pool.query(`
            SELECT valor_ltc, valor_usd, valor_zer, valor_brl, data_registro 
            FROM cotacoes 
            ORDER BY data_registro DESC, id DESC LIMIT 1
        `);

        res.json({
            success: true,
            cotacao_atual: cotacaoRes.rows[0] || null,
            saldos_parceiros: saldosParceiros.rows,
            estatisticas_saques_usuarios: totalSaques.rows[0],
            resumo_transacoes: transacoesResumo.rows,
            resumo_marketing: mktResumo.rows[0],
            despesas_recentes: despesasRes.rows,
            marketing_recente: marketingRes.rows
        });
    } catch (err) {
        console.error("🔥 Erro no overview financeiro:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 2. GET /api/admin/financeiro/geracao-renda - Relatório Detalhado de Renda & Lucro Teórico (Corrigido e Blindado)
app.get('/api/admin/financeiro/geracao-renda', verificarAdminKey, async (req, res) => {
    const client = await pool.connect();
    try {
        const cotacaoRes = await client.query(`
            SELECT valor_usd, valor_ltc 
            FROM cotacoes 
            ORDER BY data_registro DESC, id DESC 
            LIMIT 1
        `);

        const cotacaoUSD = cotacaoRes.rows.length > 0 ? parseFloat(cotacaoRes.rows[0].valor_usd) : 0.01006036;
        const cotacaoLTC = cotacaoRes.rows.length > 0 ? parseFloat(cotacaoRes.rows[0].valor_ltc) : 0.00018609;

        // Histórico excluindo origens administrativas ou estornos de correcao
        const historicoRes = await client.query(`
            SELECT 
                origem,
                COUNT(*) as total_acoes,
                COALESCE(SUM(pontos::numeric), 0) as total_pontos_y
            FROM historico_ganhos
            WHERE origem NOT IN ('teste_admin', 'saque', 'saques', 'roleta', 'compra_tickets', 'criacao_campanha', 'correcao', 'estorno_campanha')
            GROUP BY origem
        `);

        // 📊 Campanhas criadas por usuários
        const campanhasRes = await client.query(`
            SELECT COUNT(*) as total_acoes, COALESCE(SUM(custo_total_pontos::numeric), 0) as total_arrecadado_pontos
            FROM campanhas_usuarios
        `);
        const totalAcoesCampanha = parseInt(campanhasRes.rows[0]?.total_acoes || 0);
        const receitaCampanhasPontos = parseFloat(campanhasRes.rows[0]?.total_arrecadado_pontos || 0);

        const pagoCampanhasRes = await client.query(`
            SELECT COALESCE(SUM(pontos::numeric), 0) as total_pago_campanhas
            FROM historico_ganhos
            WHERE origem = 'tarefa'
        `);
        const pagoCampanhasPontos = parseFloat(pagoCampanhasRes.rows[0]?.total_pago_campanhas || 0);

        // Cálculos da Roleta e Tickets
        const girosComSaldoRes = await client.query(`SELECT COUNT(*) as qtd_giros_saldo FROM roleta_giros WHERE gratis = false`);
        const qtdGirosComSaldo = parseInt(girosComSaldoRes.rows[0]?.qtd_giros_saldo || 0);
        const receitaGirosPontos = qtdGirosComSaldo * 0.20;

        const compraTicketsRes = await client.query(`
            SELECT COALESCE(SUM(ABS(pontos::numeric)), 0) as total_compras_tickets
            FROM historico_ganhos WHERE origem = 'compra_tickets'
        `);
        const receitaTicketsPontos = parseFloat(compraTicketsRes.rows[0]?.total_compras_tickets || 0);

        const roletaGirosPremiosRes = await client.query(`
            SELECT COUNT(*) as total_acoes_roleta, COALESCE(SUM(pontos_ganhos::numeric), 0) as total_pago_roleta
            FROM roleta_giros
        `);
        const acoesRoletaTotal = parseInt(roletaGirosPremiosRes.rows[0]?.total_acoes_roleta || 0);
        const pagoRoletaPontos = parseFloat(roletaGirosPremiosRes.rows[0]?.total_pago_roleta || 0);
        const receitaRoletaPontos = receitaGirosPontos + receitaTicketsPontos;

        const relatorio = [];

        const formatarValores = (pontos) => {
            // Conversão direta segura baseada na cotação real do ponto
            const usd = pontos * cotacaoUSD;
            const ltc = pontos * cotacaoLTC;
            return {
                pontos: pontos.toFixed(4),
                usd: usd.toFixed(4),
                ltc: ltc.toFixed(8)
            };
        };

        for (const row of historicoRes.rows) {
            const origem = row.origem;
            const numAcoes = parseInt(row.total_acoes);
            const yPontos = parseFloat(row.total_pontos_y);
            let xPontos = 0;

            switch (origem) {
                case 'zerads':
                case 'moneyrain':
                    // Casa ganha 100%, repassa 40% (y), logo a receita bruta em pontos equivalentes é y / 0.40
                    xPontos = yPontos > 0 ? yPontos / 0.40 : 0; 
                    break;
                case 'anuncio_extra':
                    // Monetag paga média exata de $0.00316 USD por clique. Convertemos para pontos equivalentes para manter a tabela coesa.
                    {
                        const receitaUsdPorClique = 0.00316;
                        const receitaTotalUsd = numAcoes * receitaUsdPorClique;
                        xPontos = cotacaoUSD > 0 ? receitaTotalUsd / cotacaoUSD : 0;
                    }
                    break;
                case 'tarefa':
                    // Tarefas padrão internas (mantidas neutras ou equivalentes)
                    xPontos = yPontos;
                    break;
                case 'indicacao':
                case 'bonus_indicado':
                case 'booster_entrada':
                case 'bau_semanal':
                case 'bonus_reativacao':
                    // Custos de aquisição e retenção pura (Investimento da casa, x = 0)
                    xPontos = 0;
                    break;
                default:
                    xPontos = yPontos;
                    break;
            }

            relatorio.push({
                origem,
                acoes: numAcoes,
                pontos_totais: yPontos,
                receita_x: formatarValores(xPontos),
                pago_y: formatarValores(yPontos),
                lucro_teorico: formatarValores(xPontos - yPontos)
            });
        }

        // Adiciona a linha de Criação de Campanhas
        relatorio.push({
            origem: 'criacao_campanha',
            acoes: totalAcoesCampanha,
            pontos_totais: pagoCampanhasPontos,
            receita_x: formatarValores(receitaCampanhasPontos),
            pago_y: formatarValores(pagoCampanhasPontos),
            lucro_teorico: formatarValores(receitaCampanhasPontos - pagoCampanhasPontos)
        });

        // Adiciona a linha da Roleta
        relatorio.push({
            origem: 'roleta',
            acoes: acoesRoletaTotal,
            pontos_totais: pagoRoletaPontos,
            receita_x: formatarValores(receitaRoletaPontos),
            pago_y: formatarValores(pagoRoletaPontos),
            lucro_teorico: formatarValores(receitaRoletaPontos - pagoRoletaPontos)
        });

        res.json({
            sucesso: true,
            cotacao_atual: { valor_usd: cotacaoUSD, valor_ltc: cotacaoLTC },
            dados: relatorio
        });

    } catch (err) {
        console.error("🔥 Erro ao gerar relatório financeiro:", err);
        res.status(500).json({ success: false, erro: err.message });
    } finally {
        client.release();
    }
});

// 3. GET /api/financeiro/transacoes - Histórico de Transações
app.get('/api/financeiro/transacoes', verificarAdminKey, async (req, res) => {
    try {
        const { limit = 50, offset = 0 } = req.query;
        const result = await pool.query(
            'SELECT * FROM financeiro_transacoes ORDER BY data_registro DESC LIMIT $1 OFFSET $2',
            [parseInt(limit), parseInt(offset)]
        );
        res.json({ success: true, transacoes: result.rows });
    } catch (err) {
        console.error("🔥 Erro ao listar transações:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 4. POST /api/financeiro/transacoes - Lança Transação com Split Automático (30/30/20/20)
app.post('/api/financeiro/transacoes', verificarAdminKey, async (req, res) => {
    const { 
        tipo, origem_destino, valor_usd = 0, valor_zer = 0, 
        valor_brl = 0, cotacao_usd_zer = 0, categoria = '', 
        referencia_id = null, observacao = '' 
    } = req.body;
    
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        let split_faucetpay = 0;
        let split_lucro = 0;
        let split_reserva = 0;
        let split_mkt = 0;

        if (tipo === 'entrada_parceiro' && parseFloat(valor_usd) > 0) {
            const baseUsd = parseFloat(valor_usd);
            split_faucetpay = baseUsd * 0.30;
            split_lucro = baseUsd * 0.30;
            split_reserva = baseUsd * 0.20;
            split_mkt = baseUsd * 0.20;
        }

        const query = `
            INSERT INTO financeiro_transacoes 
            (tipo, origem_destino, valor_usd, valor_zer, valor_brl, cotacao_usd_zer, split_faucetpay, split_lucro, split_reserva, split_mkt, categoria, referencia_id, observacao, data_registro)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW()) RETURNING *;
        `;
        
        const values = [
            tipo, origem_destino, valor_usd, valor_zer, valor_brl, cotacao_usd_zer,
            split_faucetpay, split_lucro, split_reserva, split_mkt, categoria, referencia_id, observacao
        ];

        const novoMovimento = await client.query(query, values);
        await client.query("COMMIT");

        res.json({ success: true, transacao: novoMovimento.rows[0] });

    } catch (err) {
        await client.query("ROLLBACK");
        console.error("🔥 Erro ao inserir transação financeira:", err);
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.release();
    }
});

// 5. POST /api/admin/financeiro/marketing - Registrar Investimento com UTMs e Tipo de Anúncio
app.post('/api/admin/financeiro/marketing', verificarAdminKey, async (req, res) => {
    const { plataforma, utm_source, utm_campaign, tipo_anuncio, valor, moeda } = req.body;
    
    try {
        const valorUsd = (moeda === 'USD' || moeda === 'LTC' || moeda === 'BRL') ? valor : 0;
        const valorZer = moeda === 'ZER' ? valor : 0;
        const nomeCampanha = `${utm_source || 'geral'} - ${utm_campaign || 'padrao'}`;

        const result = await pool.query(
            `INSERT INTO financeiro_campanhas_mkt 
             (plataforma, nome_campanha, utm_source, utm_campaign, tipo_anuncio, valor_investido_usd, valor_investido_zer, status, data_inicio)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'ativa', NOW()) RETURNING *;`,
            [plataforma, nomeCampanha, utm_source, utm_campaign, tipo_anuncio, valorUsd, valorZer]
        );

        res.json({ success: true, sucesso: true, mensagem: 'Investimento detalhado salvo com sucesso!', campanha: result.rows[0] });
    } catch (err) {
        console.error("🔥 Erro ao registrar marketing:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});


// POST /api/admin/financeiro/despesas - Salva despesa operacional na tabela de transações
app.post('/api/admin/financeiro/despesas', verificarAdminKey, async (req, res) => {
    const { nome_despesa, valor, moeda, observacao } = req.body;

    if (!nome_despesa || valor <= 0) {
        return res.status(400).json({ success: false, message: "Nome e valor da despesa são obrigatórios." });
    }

    try {
        let valorUsd = valor;
        let valorZer = 0;
        let valorBrl = 0;

        // Converte para USD com base na cotação atual se necessário, ou armazena direto
        if (moeda === 'BRL') valorBrl = valor;
        if (moeda === 'ZER') valorZer = valor;

        await pool.query(`
            INSERT INTO financeiro_transacoes (tipo, origem_destino, valor_usd, valor_zer, valor_brl, categoria, observacao, data_registro)
            VALUES ('saida_despesa', $1, $2, $3, $4, 'despesa_operacional', $5, NOW())
        `, [nome_despesa, valorUsd, valorZer, valorBrl, observacao]);

        return res.json({ success: true, sucesso: true, message: "Despesa registrada com sucesso!" });
    } catch (err) {
        console.error("Erro ao salvar despesa:", err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 7. POST /api/saldos-parceiros - Atualizar Saldos (Usando financeiro_saldos_parceiros)
app.post('/api/saldos-parceiros', verificarAdminKey, async (req, res) => {
    const { parceiro, saldo_pendente_usd, saldo_pendente_zer, cliques_disponiveis, previsao_saque, status_saque, observacao } = req.body;
    
    if (!parceiro) {
        return res.status(400).json({ success: false, error: "O campo 'parceiro' é obrigatório." });
    }

    try {
        await pool.query(`
            INSERT INTO financeiro_saldos_parceiros (parceiro, saldo_pendente_usd, saldo_pendente_zer, cliques_disponiveis, previsao_saque, status_saque, observacao, data_atualizacao)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
            ON CONFLICT (parceiro) DO UPDATE SET 
                saldo_pendente_usd = EXCLUDED.saldo_pendente_usd,
                saldo_pendente_zer = EXCLUDED.saldo_pendente_zer,
                cliques_disponiveis = EXCLUDED.cliques_disponiveis,
                previsao_saque = EXCLUDED.previsao_saque,
                status_saque = EXCLUDED.status_saque,
                observacao = EXCLUDED.observacao,
                data_atualizacao = NOW()
        `, [
            parceiro, 
            saldo_pendente_usd || 0, 
            saldo_pendente_zer || 0, 
            cliques_disponiveis || 0, 
            previsao_saque || null, 
            status_saque || 'acumulando', 
            observacao || ''
        ]);

        res.json({ success: true, message: 'Parceiro atualizado com sucesso!' });
    } catch (err) {
        console.error("🔥 Erro ao atualizar saldo do parceiro:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 8. GET /api/financeiro/kpis-cac-ltv - Cálculo de CAC e LTV usando a tabela 'usuarios'
app.get('/api/financeiro/kpis-cac-ltv', verificarAdminKey, async (req, res) => {
    try {
        const mktRes = await pool.query(`
            SELECT COALESCE(SUM(valor_investido_usd), 0) as total_investido 
            FROM financeiro_campanhas_mkt
        `);
        const totalInvestidoUsd = parseFloat(mktRes.rows[0].total_investido || 0);

        // Contando os usuários na sua tabela real 'usuarios'
        const usuariosRes = await pool.query(`SELECT COUNT(*) as total FROM usuarios`);
        const totalUsuarios = parseInt(usuariosRes.rows[0].total || 1);

        const receitaRes = await pool.query(`
            SELECT COALESCE(SUM(pontos::numeric), 0) as total_pontos_pagos 
            FROM historico_ganhos 
            WHERE origem IN ('zerads', 'moneyrain', 'tarefa', 'anuncio_extra')
        `);
        
        const cotRes = await pool.query(`SELECT valor_usd FROM cotacoes ORDER BY data_registro DESC, id DESC LIMIT 1`);
        const cotacaoUsd = cotRes.rows.length > 0 ? parseFloat(cotRes.rows[0].valor_usd) : 0.00909091;

        const totalPontosPagos = parseFloat(receitaRes.rows[0].total_pontos_pagos || 0);
        const receitaBrutaExternaUsd = (totalPontosPagos / 0.40) * cotacaoUsd;

        const cac = totalInvestidoUsd / totalUsuarios;
        const ltvBruto = receitaBrutaExternaUsd / totalUsuarios;
        const ltvLucroLiquido = ltvBruto * 0.60;

        res.json({
            success: true,
            cac: cac.toFixed(4),
            ltv_bruto: ltvBruto.toFixed(4),
            ltv_lucro: ltvLucroLiquido.toFixed(4),
            total_usuarios: totalUsuarios,
            total_investido_mkt: totalInvestidoUsd.toFixed(4)
        });

    } catch (err) {
        console.error("🔥 Erro ao calcular CAC e LTV:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 9. GET /api/admin/faucetpay/saques - Totais de Saques Aprovados (Banco Local)
app.get('/api/admin/faucetpay/saques', verificarAdminKey, async (req, res) => {
  try {
    // Busca o total e a quantidade de saques aprovados/pagos no banco local
    const dbRes = await pool.query(`
      SELECT 
        COUNT(*) as qtd, 
        COALESCE(SUM(valor_solicitado), 0) as total_usd,
        COALESCE(SUM(pontos_solicitados), 0) as total_pontos
      FROM saques 
      WHERE LOWER(status) IN ('ok', 'aprovado', 'pago')
    `);

    const totalUsdLocal = parseFloat(dbRes.rows[0].total_usd || 0);
    const totalPontosLocal = parseFloat(dbRes.rows[0].total_pontos || 0);
    const qtdSaques = parseInt(dbRes.rows[0].qtd || 0);

    // Busca a cotação do LTC para calcular o equivalente estimado
    const cotRes = await pool.query(`
      SELECT valor_usd, valor_ltc 
      FROM cotacoes 
      ORDER BY data_registro DESC, id DESC 
      LIMIT 1
    `);
    
    const cotacaoLtcUsd = cotRes.rows.length > 0 ? (parseFloat(cotRes.rows[0].valor_usd) / parseFloat(cotRes.rows[0].valor_ltc)) : 88.5;
    const totalLtcEquivalente = cotacaoLtcUsd > 0 ? (totalUsdLocal / cotacaoLtcUsd) : 0;

    return res.json({
      success: true,
      sucesso: true,
      fonte_dados: 'Banco de Dados Local (Saques Aprovados)',
      qtd_saques: qtdSaques,
      total_usd_pago: totalUsdLocal.toFixed(4),
      total_pontos_pago: totalPontosLocal.toFixed(2),
      total_ltc_pago: totalLtcEquivalente.toFixed(8)
    });

  } catch (err) {
    console.error("❌ Erro ao calcular totais de saques aprovados:", err.message);
    return res.status(500).json({ 
      error: "Erro interno ao consultar histórico de saques aprovados." 
    });
  }
});
// POST /api/admin/financeiro/parceiros - Cadastra ou atualiza saldo de parceiros externos
app.post('/api/admin/financeiro/parceiros', verificarAdminKey, async (req, res) => {
    const { parceiro, saldo_pendente_usd, saldo_pendente_zer, cliques_disponiveis, status_saque, observacao } = req.body;

    if (!parceiro) {
        return res.status(400).json({ success: false, message: "Nome do parceiro é obrigatório." });
    }

    try {
        // Verifica se o parceiro já existe para atualizar, ou insere um novo (Upsert lógico)
        const check = await pool.query(`SELECT id FROM financeiro_saldos_parceiros WHERE LOWER(parceiro) = LOWER($1)`, [parceiro]);

        if (check.rows.length > 0) {
            await pool.query(`
                UPDATE financeiro_saldos_parceiros 
                SET saldo_pendente_usd = $1, saldo_pendente_zer = $2, cliques_disponiveis = $3, status_saque = $4, observacao = $5, data_atualizacao = NOW()
                WHERE LOWER(parceiro) = LOWER($6)
            `, [saldo_pendente_usd, saldo_pendente_zer, cliques_disponiveis, status_saque, observacao, parceiro]);
        } else {
            await pool.query(`
                INSERT INTO financeiro_saldos_parceiros (parceiro, saldo_pendente_usd, saldo_pendente_zer, cliques_disponiveis, status_saque, observacao, data_atualizacao)
                VALUES ($1, $2, $3, $4, $5, $6, NOW())
            `, [parceiro, saldo_pendente_usd, saldo_pendente_zer, cliques_disponiveis, status_saque, observacao]);
        }

        return res.json({ success: true, sucesso: true, message: "Parceiro salvo com sucesso!" });
    } catch (err) {
        console.error("Erro ao salvar parceiro financeiro:", err);
        return res.status(500).json({ success: false, message: err.message });
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

// =========================================================================
// 🔹 FLUXO DE CONFIRMAÇÃO DE SAQUE PELO USUÁRIO + MOTOR DE ALERTA INTELIGENTE
// =========================================================================

bot.action(/conf_saque_(\d+)/, async (ctx) => {
  const saqueId = ctx.match[1];
  const telegram_id = ctx.from.id.toString();

  try {
    await ctx.answerCbQuery("Processando validações de segurança...");
  } catch (e) {}

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Busca dados do usuário
    const userRes = await client.query(
      "SELECT pontos, lang FROM usuarios WHERE telegram_id = $1 FOR UPDATE", 
      [telegram_id]
    );
    
    if (userRes.rows.length === 0) throw new Error("USUARIO_NAO_ENCONTRADO");
    const user = userRes.rows[0];
    const isEn = user.lang === 'en';
    const saldoAtual = parseFloat(user.pontos);

    // 2. Busca o pedido de saque
    const saqueRes = await client.query(
      "SELECT * FROM saques WHERE id = $1 AND telegram_id = $2 AND status = 'Aguardando Chat' FOR UPDATE",
      [saqueId, telegram_id]
    );

    if (saqueRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return ctx.editMessageText(isEn ? "⚠️ This withdrawal request is no longer available or was already processed." : "⚠️ Este pedido de saque não está mais disponível ou já foi processado.");
    }

    const saque = saqueRes.rows[0];
    const pontosSolicitados = parseFloat(saque.pontos_solicitados);

    if (saldoAtual < pontosSolicitados) {
      await client.query("ROLLBACK");
      await pool.query("UPDATE saques SET status = 'Cancelado' WHERE id = $1", [saqueId]);
      return ctx.editMessageText(isEn ? "⚠️ Insufficient balance to complete this withdrawal." : "⚠️ Saldo insuficiente para concluir este saque.");
    }

    // =========================================================================
    // 🛡️ AVALIAÇÃO DE SEGURANÇA (HISTÓRICO + VELOCIDADE)
    // =========================================================================
    const analiseSeguranca = await client.query(`
      WITH tarefas_usuario AS (
          SELECT 
              origem,
              pontos,
              data_registro,
              LAG(data_registro) OVER (ORDER BY data_registro ASC) AS data_anterior
          FROM historico_ganhos
          WHERE telegram_id = $1
      ),
      metricas AS (
          SELECT 
              COALESCE(SUM(pontos), 0) AS total_pontos_historico,
              COUNT(CASE 
                  WHEN (EXTRACT(EPOCH FROM (data_registro - data_anterior)) < 1.0) 
                       AND origem IN ('zerads', 'moneyrain', 'tarefa') 
                  THEN 1 
              END) AS acoes_extrema_velocidade
          FROM tarefas_usuario
      )
      SELECT 
          total_pontos_historico,
          acoes_extrema_velocidade
      FROM metricas
    `, [telegram_id]);

    const risco = analiseSeguranca.rows[0];
    const totalHistorico = parseFloat(risco.total_pontos_historico || 0);
    const acoesExtremas = parseInt(risco.acoes_extrema_velocidade || 0);

    // =========================================================================
    // ⚙️ TETO DE SAQUE AUTOMÁTICO (AJUSTADO PARA 1.00 PONTO)
    // =========================================================================
    const TETO_SAQUE_AUTOMATICO = 1.00; 

    // Verifica se o saque está dentro dos parâmetros normais
    const dentroDosParametros = acoesExtremas <= 5 && totalHistorico >= pontosSolicitados && pontosSolicitados <= TETO_SAQUE_AUTOMATICO;

    // Debita os pontos do usuário preventivamente e coloca o status como 'Waiting' para revisão no saques.html
    await client.query("UPDATE usuarios SET pontos = pontos - $1 WHERE telegram_id = $2", [pontosSolicitados, telegram_id]);
    
    await client.query(`
      INSERT INTO historico_ganhos (telegram_id, origem, pontos, nome_tarefa, referencia_id, data_registro)
      VALUES ($1, 'saque', $2, 'Solicitação de Saque', $3, NOW())
    `, [telegram_id, -Math.abs(pontosSolicitados), saqueId]);

    await client.query("UPDATE saques SET status = 'Waiting', data_aprovacao = NULL WHERE id = $1", [saqueId]);
    await client.query("COMMIT");

    // =========================================================================
    // 🚨 SISTEMA DE ALERTA INTELIGENTE (DISPARA SÓ SE HOUVER ANOMALIA)
    // =========================================================================
    const adminId = process.env.ADMIN_TELEGRAM_ID || "1677694125";

    if (!dentroDosParametros && adminId && typeof bot !== 'undefined') {
      const motivoAlerta = acoesExtremas > 5 
        ? `⚠️ *Alerta de Anomalia:* Alta frequência de cliques extremos detectada (${acoesExtremas} ações < 1s).` 
        : `⚠️ *Alerta de Teto:* Saque acima do teto automático (${pontosSolicitados} Pts) ou histórico sob revisão.`;
      
      const mensagemAdmin = `🚨 **ATENÇÃO: SAQUE SUSPEITO / ACIMA DO TETO!**\n\n` +
        `${motivoAlerta}\n` +
        `🆔 **ID do Saque:** #${saqueId}\n` +
        `👤 **Usuário ID:** \`${telegram_id}\`\n` +
        `💰 **Pontos Solicitados:** ${pontosSolicitados} Pts\n` +
        `💵 **Valor em USD/LRL:** $ ${saque.valor_solicitado}\n` +
        `📧 **Chave / FaucetPay:** \`${saque.chave_pix}\`\n\n` +
        `👉 _Acesse o painel saques.html para analisar e pagar manualmente._`;

      try {
        await bot.telegram.sendMessage(adminId, mensagemAdmin, { parse_mode: "Markdown", disable_web_page_preview: true });
      } catch (e) {
        console.error("Erro ao enviar alerta para o admin:", e.message);
      }
    }

    // Resposta padrão ao usuário (informando que o pedido entrou na fila de análise/processamento)
    await ctx.editMessageText(isEn 
      ? `✅ **Withdrawal Confirmed!**\n\nYour request has been registered and will be processed by the administration soon.`
      : `✅ **Saque Confirmado!**\n\nSeu pedido foi registrado com sucesso e será processado em breve pela administração.`
    );

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Erro ao confirmar saque via chat:", err);
    try {
      await ctx.editMessageText("⚠️ Erro interno ao processar a confirmação do saque.");
    } catch (e) {}
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
  valor_ltc: 0.00017760,     // Atualizado para a nova proporção (0.05 / 281.53)
  valor_usd: 0.01005600,     // Proporcional ao dólar atual
  valor_zer: 0.35515000,     // Alinhado com a nova paridade do ZERAds (1 LTC = 2.000 ZER)
  valor_brl: 0.05000000      // Âncora fixa por ponto em Reais
};

const LIMIAR_VARIACAO_PERCENTUAL = 10.0; 

// =========================================================================
// 🔹 FUNÇÃO DE COTAÇÃO EM CASCATA COM NOTIFICAÇÃO DE FALHA NO TELEGRAM
// =========================================================================

async function obterPrecoLTC() {
  const adminId = process.env.ADMIN_TELEGRAM_ID || "1677694125";
  const headersCustom = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json'
  };

  // -------------------------------------------------------------
  // TENTATIVA 1: COINGECKO (Sem cabeçalho, depois com cabeçalho)
  // -------------------------------------------------------------
  try {
    console.log("🔄 [COTAÇÕES] Tentando CoinGecko (sem cabeçalho)...");
    const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd,brl', { timeout: 6000 });
    if (res.data && res.data.litecoin) {
      console.log("✅ [COTAÇÕES] Sucesso na CoinGecko (sem cabeçalho).");
      return { usd: parseFloat(res.data.litecoin.usd), brl: parseFloat(res.data.litecoin.brl) };
    }
  } catch (err1) {
    console.warn("⚠️ [COTAÇÕES] CoinGecko sem cabeçalho falhou. Tentando com cabeçalho...");
    try {
      const res2 = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd,brl', { headers: headersCustom, timeout: 6000 });
      if (res2.data && res2.data.litecoin) {
        console.log("✅ [COTAÇÕES] Sucesso na CoinGecko (com cabeçalho).");
        return { usd: parseFloat(res2.data.litecoin.usd), brl: parseFloat(res2.data.litecoin.brl) };
      }
    } catch (err2) {
      console.warn("⚠️ [COTAÇÕES] CoinGecko com cabeçalho também falhou.");
    }
  }

  // -------------------------------------------------------------
  // TENTATIVA 2: BINANCE (Sem cabeçalho, depois com cabeçalho)
  // -------------------------------------------------------------
  try {
    console.log("🔄 [COTAÇÕES] Tentando Binance (sem cabeçalho)...");
    const resBin = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=LTCUSDT', { timeout: 6000 });
    const usd = parseFloat(resBin.data.price);
    console.log("✅ [COTAÇÕES] Sucesso na Binance (sem cabeçalho).");
    return { usd: usd, brl: usd * 4.97 };
  } catch (errBin1) {
    console.warn("⚠️ [COTAÇÕES] Binance sem cabeçalho falhou. Tentando com cabeçalho...");
    try {
      const resBin2 = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=LTCUSDT', { headers: headersCustom, timeout: 6000 });
      const usd = parseFloat(resBin2.data.price);
      console.log("✅ [COTAÇÕES] Sucesso na Binance (com cabeçalho).");
      return { usd: usd, brl: usd * 4.97 };
    } catch (errBin2) {
      console.warn("⚠️ [COTAÇÕES] Binance com cabeçalho também falhou (provável erro 451 no Render).");
    }
  }

  // -------------------------------------------------------------
  // TENTATIVA 3: COINPAPRIKA (API de contingência livre de bloqueio)
  // -------------------------------------------------------------
  try {
    console.log("🔄 [COTAÇÕES] Tentando CoinPaprika...");
    const resPaprika = await axios.get('https://api.coinpaprika.com/v1/tickers/ltc-litecoin', { timeout: 6000 });
    const usd = parseFloat(resPaprika.data.quotes.USD.price);
    console.log("✅ [COTAÇÕES] Sucesso via CoinPaprika.");
    return { usd: usd, brl: usd * 4.97 };
  } catch (errPaprika) {
    console.warn("⚠️ [COTAÇÕES] CoinPaprika falhou:", errPaprika.message);
  }

  // -------------------------------------------------------------
  // ❌ ALERTA CRÍTICO: TODAS AS APIS FALHARAM -> AVISAR O ADMIN NO TELEGRAM
  // -------------------------------------------------------------
  console.error("🔥 [COTAÇÕES] ERRO CRÍTICO: Todas as fontes de cotação falharam!");
  
  if (adminId && typeof bot !== 'undefined') {
    const mensagemAlerta = `🚨 **ALERTA CRÍTICO DE COTAÇÃO!**\n\n` +
      `❌ *Todas as APIs de preço do Litecoin (CoinGecko, Binance e CoinPaprika) falharam ao tentar atualizar no Render.*\n\n` +
      `⚠️ O sistema continuará operando com a última cotação salva no banco, mas verifique o servidor urgentemente!`;

    try {
      await bot.telegram.sendMessage(adminId, mensagemAlerta, { parse_mode: "Markdown" });
      console.log("📩 Alerta de falha de cotação enviado para o Telegram do Admin.");
    } catch (telErr) {
      console.error("❌ Erro ao enviar alerta crítico para o Telegram:", telErr.message);
    }
  }

  return null;
}

async function atualizarCotacoesAutomaticamente() {
  try {
    const dadosPreco = await obterPrecoLTC();
    
    if (!dadosPreco) {
      console.error("❌ [COTAÇÕES] Erro crítico: Não foi possível obter o preço do Litecoin de nenhuma API.");
      return;
    }

    const precoLtcUsdAtual = dadosPreco.usd;
    const precoLtcBrlAtual = dadosPreco.brl;

    const valorBrlPorPonto = VALOR_BASE.valor_brl;
    const valorLtcPorPonto = valorBrlPorPonto / precoLtcBrlAtual;
    const valorUsdPorPonto = valorBrlPorPonto / (precoLtcBrlAtual / precoLtcUsdAtual);
    const valorZerPorPonto = VALOR_BASE.valor_zer; 

    const valLtcStr = valorLtcPorPonto.toFixed(18);
    const valUsdStr = valorUsdPorPonto.toFixed(18);
    const valZerStr = valorZerPorPonto.toFixed(18);
    const valBrlStr = valorBrlPorPonto.toFixed(18);

    const ultimaCotacaoRes = await pool.query(
      "SELECT * FROM cotacoes ORDER BY data_registro DESC, id DESC LIMIT 1"
    );

    let registrarNoBanco = true;

    // Datas ajustadas para o fuso horário de Brasília
    const dataHoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });

    if (ultimaCotacaoRes.rows.length > 0) {
      const ultima = ultimaCotacaoRes.rows[0];
      const ltcAnterior = parseFloat(ultima.valor_ltc);
      const ltcNovo = parseFloat(valLtcStr);

      const variacaoPercentual = Math.abs(((ltcNovo - ltcAnterior) / ltcAnterior) * 100);

      console.log(`📊 [COMPARAÇÃO] LTC Anterior: ${ltcAnterior} | LTC Novo: ${ltcNovo} | Variação: ${variacaoPercentual.toFixed(2)}%`);

      if (variacaoPercentual >= LIMIAR_VARIACAO_PERCENTUAL) {
        console.warn(`🚨 [ALERTA DE PREJUÍZO] O Litecoin mudou ${variacaoPercentual.toFixed(2)}% em relação ao último registro!`);
      }

      const dataUltimoRegistro = new Date(ultima.data_registro).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });

      if (dataUltimoRegistro === dataHoje) {
        console.log("ℹ️ [COTAÇÕES] Já existe cotação registrada para hoje. Atualizando registro de hoje para manter precisão...");
        await pool.query(
          `UPDATE cotacoes 
           SET valor_ltc = $1, valor_usd = $2, valor_zer = $3, valor_brl = $4 
           WHERE id = $5`,
          [valLtcStr, valUsdStr, valZerStr, valBrlStr, ultima.id]
        );
        return;
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

// ⏱️ Agendado para rodar todos os dias às 15:00 UTC (12:00 de Brasília)
cron.schedule('0 15 * * *', () => {
  atualizarCotacoesAutomaticamente();
});

// Executa uma vez ao iniciar o servidor para checar a cotação
atualizarCotacoesAutomaticamente();

// =========================================================================
// 🔹 CRON JOBS E ROTINAS DE ENGAJAMENTO (MANTIDOS)
// =========================================================================

async function dispararEngajamento(lang, tipo) {
  try {
    let query;
    if (tipo === 'inativo') {
      query = `SELECT u.telegram_id 
               FROM usuarios u 
               WHERE u.lang = $1 
               AND (u.status_conta IS NULL OR u.status_conta = 'ativo')
               AND COALESCE(u.notif_inativo_enviada, FALSE) = FALSE
               AND COALESCE(u.bonus_reativacao_resgatado, FALSE) = FALSE
               AND NOT EXISTS (
                 SELECT 1 FROM historico_ganhos h 
                 WHERE h.telegram_id = u.telegram_id 
                 AND h.data_registro > NOW() - INTERVAL '48 hours'
               )`;
    } else {
      query = `SELECT u.telegram_id 
               FROM usuarios u 
               WHERE u.lang = $1 
               AND (u.status_conta IS NULL OR u.status_conta = 'ativo')
               AND COALESCE(u.notif_iniciante_enviada, FALSE) = FALSE
               AND EXISTS (
                 SELECT 1 FROM historico_ganhos h 
                 WHERE h.telegram_id = u.telegram_id 
                 AND h.data_registro > NOW() - INTERVAL '48 hours'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM historico_ganhos h 
                 WHERE h.telegram_id = u.telegram_id 
                 AND h.data_registro > NOW() - INTERVAL '24 hours'
               )`;
    }

    const { rows } = await pool.query(query, [lang]);
    console.log(`🚀 Disparando ${tipo} (${lang}): ${rows.length} usuários.`);

    for (const u of rows) {
      const isPt = lang === 'pt';
      
      const mensagem = tipo === 'inativo' 
        ? (isPt ? "🎁 Sentimos sua falta! Deixamos um bônus especial de **0.05 pontos** te esperando no Mini App para impulsionar seu saldo. Resgate agora antes que expire!" : "🎁 We missed you! We left a special bonus of **0.05 points** waiting for you in the Mini App to boost your balance. Claim it now before it expires!")
        : (isPt ? "🚀 Você está indo bem! Faltam poucas tarefas para seu bônus de consistência. Volte agora e garanta seus pontos!" : "🚀 You're doing great! Only a few tasks left for your consistency bonus. Come back now and secure your points!");

      const urlDestino = tipo === 'inativo' ? 'reativacao.html' : 'tarefas.html';
      const btnText = isPt 
        ? (tipo === 'inativo' ? "🎁 Resgatar Bônus Agora" : "📲 Fazer Tarefas Agora") 
        : (tipo === 'inativo' ? "🎁 Claim Bonus Now" : "📲 Complete Tasks Now");

      try {
        await bot.telegram.sendMessage(u.telegram_id, mensagem, {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[
              { text: btnText, web_app: { url: `${process.env.APP_DOMAIN}/${urlDestino}?id=${u.telegram_id}&lang=${lang}` } }
            ]]
          }
        });

        const colunaFlag = tipo === 'inativo' ? 'notif_inativo_enviada' : 'notif_iniciante_enviada';
        await pool.query(
          `UPDATE usuarios SET ${colunaFlag} = TRUE WHERE telegram_id = $1`,
          [u.telegram_id]
        );

      } catch (e) {
        if (e.code === 403 || (e.message && e.message.includes('blocked by the user'))) {
          try {
            await pool.query(
              `UPDATE usuarios 
               SET status_conta = 'bloqueado', 
                   data_bloqueio = COALESCE(data_bloqueio, NOW()) 
               WHERE telegram_id = $1`, 
              [u.telegram_id]
            );
            console.log(`🚫 Usuário ${u.telegram_id} bloqueou o bot. Status 'bloqueado' e data de bloqueio salvas.`);
          } catch (dbErr) {
            console.error(`Erro ao atualizar status do usuário ${u.telegram_id}:`, dbErr.message);
          }
        } else {
          console.error(`Erro ao enviar para ${u.telegram_id}:`, e.message);
        }
      }
    }
  } catch (err) {
    console.error(`Erro no disparo ${tipo} (${lang}):`, err);
  }
}

// Disparos automatizados de Inativos e Iniciantes (Manhã)
cron.schedule("0 10 * * *", async () => {
  await dispararEngajamento('pt', 'inativo');
  await dispararEngajamento('pt', 'iniciante');
}, { timezone: "America/Sao_Paulo" });

cron.schedule("0 10 * * *", async () => {
  await dispararEngajamento('en', 'inativo');
  await dispararEngajamento('en', 'iniciante');
}, { timezone: "America/New_York" });

// Cron Job de Fidelidade VIP (Mantido)
cron.schedule("0 12 * * *", async () => {
  try {
    const query = `
      SELECT h.telegram_id, u.lang 
      FROM historico_compras h
      JOIN usuarios u ON h.telegram_id = u.telegram_id
      WHERE u.vip = true 
      AND (u.status_conta IS NULL OR u.status_conta = 'ativo')
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

      await bot.telegram.sendMessage(row.telegram_id, mensagem).catch(async (e) => {
        if (e.code === 403 || (e.message && e.message.includes('blocked by the user'))) {
          await pool.query(
            `UPDATE usuarios 
             SET status_conta = 'bloqueado', 
                 data_bloqueio = COALESCE(data_bloqueio, NOW()) 
             WHERE telegram_id = $1`, 
            [row.telegram_id]
          );
          console.log(`🚫 Usuário VIP ${row.telegram_id} bloqueou o bot. Atualizado status e data no banco.`);
        }
      });
    }
  } catch (err) {
    console.error("Erro no cron de fidelidade:", err);
  }
});

// ❌ O CRON JOB DE STREAKS MEIA-NOITE ('5 0 * * *') FOI REMOVIDO DAQUI.
// Agora a lógica de streak e virada de dia roda de forma inteligente e sob demanda 
// diretamente na rota /api/status-checklist quando o usuário abre o app.

// Tratamento de Erros Global para o Bot (Mantido)
bot.catch(async (err, ctx) => {
  console.error(`Erro crítico no Telegraf para o update ${ctx.updateType}:`, err);
  if (err.code === 403 || (err.message && err.message.includes('blocked by the user'))) {
    const telegramId = ctx.from?.id;
    if (telegramId) {
      try {
        await pool.query(
          `UPDATE usuarios 
           SET status_conta = 'bloqueado', 
               data_bloqueio = COALESCE(data_bloqueio, NOW()) 
           WHERE telegram_id = $1`, 
          [telegramId]
        );
        console.log(`🚫 Usuário ${telegramId} bloqueou o bot durante interação. Atualizado status e data_bloqueio no banco.`);
      } catch (dbErr) {
        console.error("Erro ao atualizar status via bot.catch:", dbErr.message);
      }
    }
  }
});

// Inicialização do Servidor e do Bot (Mantido)
app.listen(PORT, async () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);

  try {
    await bot.stop();
  } catch (e) {
    // Silencia o erro caso seja a primeira inicialização
  }

  bot.launch({ dropPendingUpdates: true })
    .then(() => {
      console.log("🤖 Telegram Bot iniciado com sucesso via Telegraf!");
    })
    .catch((err) => {
      console.error("❌ Erro ao iniciar o bot do Telegram:", err);
    });
});
