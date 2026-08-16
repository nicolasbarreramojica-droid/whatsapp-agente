const express = require("express");
const crypto = require("crypto");
const app = express();
app.use(express.json());

// ─── Config from environment variables ───────────────────────────────────────
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mi_token_secreto";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const INSTAGRAM_TOKEN = process.env.INSTAGRAM_TOKEN;
const RELEVANCE_API_KEY = process.env.RELEVANCE_API_KEY;
const RELEVANCE_AGENT_ID = process.env.RELEVANCE_AGENT_ID;
const RELEVANCE_TOURS_AGENT_ID = process.env.RELEVANCE_TOURS_AGENT_ID;
const BOLD_API_KEY = process.env.BOLD_API_KEY;
const BOLD_SECRET_KEY = process.env.BOLD_SECRET_KEY;

// ─── Memoria de conversaciones ────────────────────────────────────────────────
const conversaciones = {};
const agentesActivos = {};

// ─── Verificación del webhook (GET) ──────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado correctamente");
    res.status(200).send(challenge);
  } else {
    console.error("❌ Token de verificación incorrecto");
    res.sendStatus(403);
  }
});

// ─── Crear link de pago en Bold ───────────────────────────────────────────────
async function crearLinkBold(monto, descripcion, referencia) {
  try {
    const orderId = referencia || `CSV-${Date.now()}`;
    const currency = "COP";
    const amountInCents = Math.round(monto);

    // Generar firma de integridad
    const integrity = crypto
      .createHash("sha256")
      .update(`${orderId}${amountInCents}${currency}${BOLD_SECRET_KEY}`)
      .digest("hex");

    const response = await fetch("https://integrations.api.bold.co/online/link/v1", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `x-api-key ${BOLD_API_KEY}`,
      },
      body: JSON.stringify({
        amount_type: "CLOSE",
        amount: {
          currency,
          total_amount: amountInCents,
          tip_amount: 0,
        },
        description: descripcion || "Reserva Cartagena Stay Venture",
        reference: orderId,
        payment_methods: ["CREDIT_CARD"],
      }),
    });

    const data = await response.json();
    console.log("💳 Link Bold creado:", JSON.stringify(data));

    if (data?.payload?.url) {
      return data.payload.url;
    }
    return null;
  } catch (err) {
    console.error("❌ Error creando link Bold:", err.message);
    console.error("❌ Error completo Bold:", JSON.stringify(err, Object.getOwnPropertyNames(err)));
    return null;
  }
}

// ─── Recepción de mensajes (POST) ────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const body = req.body;
  console.log("📨 Webhook recibido:", JSON.stringify(body).substring(0, 300));

  // ── WhatsApp ──────────────────────────────────────────────────────────────
  if (body.object === "whatsapp_business_account") {
    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (message && message.type === "text") {
      const from = message.from;
      const text = message.text.body;
      console.log(`📩 WhatsApp de ${from}: ${text}`);
      res.sendStatus(200);
      await handleMessage(text, from, "whatsapp");
    } else {
      res.sendStatus(200);
    }
    return;
  }

  // ── Instagram ─────────────────────────────────────────────────────────────
  if (body.object === "instagram") {
    const messaging = body.entry?.[0]?.messaging?.[0];
    if (messaging && messaging.message && !messaging.message.is_echo) {
      const from = messaging.sender.id;
      const text = messaging.message.text;
      if (text) {
        console.log(`📸 Instagram de ${from}: ${text}`);
        res.sendStatus(200);
        await handleMessage(text, from, "instagram");
      } else {
        res.sendStatus(200);
      }
    } else {
      res.sendStatus(200);
    }
    return;
  }

  res.sendStatus(404);
});

// ─── Endpoint de prueba Bold ──────────────────────────────────────────────────
app.get("/test-bold", async (req, res) => {
  try {
    console.log("🧪 Probando conexión a Bold...");
    const response = await fetch("https://integrations.api.bold.co/online/link/v1/payment_methods", {
      method: "GET",
      headers: {
        Authorization: `x-api-key ${BOLD_API_KEY}`,
      },
    });
    const text = await response.text();
    console.log("✅ Bold responde:", text.substring(0, 200));
    res.json({ status: response.status, body: text.substring(0, 200) });
  } catch (err) {
    console.error("❌ Bold no responde:", err.message, err.cause?.message);
    res.json({ error: err.message, cause: err.cause?.message });
  }
});
app.post("/crear-pago", async (req, res) => {
  const { monto, descripcion, referencia } = req.body;
  if (!monto) return res.status(400).json({ error: "Monto requerido" });

  const link = await crearLinkBold(monto, descripcion, referencia);
  if (link) {
    res.json({ link });
  } else {
    res.status(500).json({ error: "No se pudo crear el link de pago" });
  }
});

// ─── Manejo central de mensajes ───────────────────────────────────────────────
async function handleMessage(text, from, platform) {
  try {
    const agenteActual = agentesActivos[from] || "apartamentos";
    const agentId = agenteActual === "tours" ? RELEVANCE_TOURS_AGENT_ID : RELEVANCE_AGENT_ID;

    console.log(`🤖 Usando agente de ${agenteActual} para ${from}`);

    const conversationKey = `${from}_${agenteActual}`;
    const conversationId = conversaciones[conversationKey] || null;

    const triggerBody = {
      agent_id: agentId,
      message: { role: "user", content: text },
    };

    if (conversationId) {
      triggerBody.conversation_id = conversationId;
    }

    const triggerRes = await fetch(
      "https://api-bcbe5a.stack.tryrelevance.com/latest/agents/trigger",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: RELEVANCE_API_KEY,
        },
        body: JSON.stringify(triggerBody),
      }
    );

    const triggerData = await triggerRes.json();
    console.log(`🚀 Agente disparado:`, JSON.stringify(triggerData));

    const studioId = triggerData?.job_info?.studio_id;
    const jobId = triggerData?.job_info?.job_id;
    const newConversationId = triggerData?.conversation_id;

    if (newConversationId) {
      conversaciones[conversationKey] = newConversationId;
    }

    if (!studioId || !jobId) {
      console.error("❌ No se obtuvo studio_id o job_id");
      await sendMessage(from, "Lo siento, hubo un error al procesar tu mensaje.", platform);
      return;
    }

    let agentReply = await pollForReply(studioId, jobId);

    // Detectar señal de crear link Bold
    const boldMatch = agentReply.match(/CREAR_PAGO_BOLD\((\d+),([^,]+),([^)]+)\)/);
    if (boldMatch) {
      const monto = parseInt(boldMatch[1]);
      const descripcion = boldMatch[2].trim();
      const referencia = boldMatch[3].trim();
      console.log(`💳 Creando link Bold: ${monto} COP`);
      const linkBold = await crearLinkBold(monto, descripcion, referencia);
      if (linkBold) {
        agentReply = agentReply.replace(boldMatch[0], `\n💳 *Link de pago con tarjeta:*\n${linkBold}`);
      } else {
        agentReply = agentReply.replace(boldMatch[0], "");
      }
    }

    // Detectar señal de transferencia a tours
    if (agentReply.includes("CAMBIAR_A_TOURS")) {
      console.log(`🔀 Transfiriendo a agente de tours para ${from}`);
      agentesActivos[from] = "tours";
      delete conversaciones[`${from}_tours`];
      agentReply = agentReply.replace("CAMBIAR_A_TOURS", "").trim();
    }

    // Detectar señal de regreso a apartamentos
    if (agentReply.includes("CAMBIAR_A_APARTAMENTOS")) {
      console.log(`🔀 Regresando a agente de apartamentos para ${from}`);
      agentesActivos[from] = "apartamentos";
      delete conversaciones[`${from}_apartamentos`];
      agentReply = agentReply.replace("CAMBIAR_A_APARTAMENTOS", "").trim();
    }

    await sendMessage(from, agentReply, platform);

  } catch (err) {
    console.error("❌ Error:", err.message);
    await sendMessage(from, "Ocurrió un error. Intenta de nuevo.", platform);
  }
}

// ─── Polling usando async_poll ────────────────────────────────────────────────
async function pollForReply(studioId, jobId, maxAttempts = 30, interval = 2000) {
  const url = `https://api-bcbe5a.stack.tryrelevance.com/latest/studios/${studioId}/async_poll/${jobId}`;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, interval));

    try {
      const res = await fetch(url, {
        headers: { Authorization: RELEVANCE_API_KEY },
      });

      const data = await res.json();
      console.log(`🔄 Intento ${i + 1}:`, JSON.stringify(data).substring(0, 300));

      const updates = data?.updates || [];
      for (const update of updates) {
        if (update?.type === "chain-success") {
          const output = update?.output?.output?.answer ||
                        update?.output?.answer ||
                        update?.output?.text ||
                        update?.output;
          if (output && typeof output === "string") {
            console.log("✅ Respuesta obtenida:", output);
            return output;
          }
        }
      }

      if (data?.type === "chain-success" || data?.status === "complete") {
        const output = data?.output?.output?.answer || data?.output?.answer || data?.output;
        if (output && typeof output === "string") return output;
      }

    } catch (err) {
      console.error(`❌ Error en polling intento ${i + 1}:`, err.message);
    }
  }

  return "Lo siento, el agente tardó demasiado en responder. Intenta de nuevo.";
}

// ─── Enviar mensaje según plataforma ─────────────────────────────────────────
async function sendMessage(to, text, platform) {
  if (platform === "whatsapp") {
    await sendWhatsAppMessage(to, text);
  } else if (platform === "instagram") {
    await sendInstagramMessage(to, text);
  }
}

// ─── WhatsApp ─────────────────────────────────────────────────────────────────
async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });
  const data = await response.json();
  console.log("📤 WhatsApp enviado:", JSON.stringify(data));
}

// ─── Instagram ────────────────────────────────────────────────────────────────
async function sendInstagramMessage(to, text) {
  const url = `https://graph.facebook.com/v19.0/me/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${INSTAGRAM_TOKEN}`,
    },
    body: JSON.stringify({
      recipient: { id: to },
      message: { text },
    }),
  });
  const data = await response.json();
  console.log("📤 Instagram enviado:", JSON.stringify(data));
}

// ─── Servidor ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
