const express = require("express");
const app = express();
app.use(express.json());

// ─── Config from environment variables ───────────────────────────────────────
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mi_token_secreto";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const INSTAGRAM_TOKEN = process.env.INSTAGRAM_TOKEN;
const RELEVANCE_API_KEY = process.env.RELEVANCE_API_KEY;
const RELEVANCE_AGENT_ID = process.env.RELEVANCE_AGENT_ID;         // Agente apartamentos
const RELEVANCE_TOURS_AGENT_ID = process.env.RELEVANCE_TOURS_AGENT_ID; // Agente tours

// ─── Palabras clave para detectar consultas de tours ─────────────────────────
const TOUR_KEYWORDS = [
  "tour", "tours", "excursion", "excursión", "isla", "islas", "actividad",
  "actividades", "paseo", "paseos", "playa", "playas", "buceo", "snorkel",
  "experiencia", "experiencias", "mambo", "rosario", "totumo", "aviario",
  "oceanario", "flamingo", "golden hour", "city tour", "chiva", "pub crawl",
  "lancha", "baru", "barú", "plancton", "cata", "ron"
];

// ─── Memoria de conversaciones (por usuario) ──────────────────────────────────
const conversaciones = {};      // conversation_id por usuario
const agentesActivos = {};      // qué agente está usando cada usuario

// ─── Detectar si es consulta de tours ────────────────────────────────────────
function esTour(texto) {
  const textoLower = texto.toLowerCase();
  return TOUR_KEYWORDS.some(keyword => textoLower.includes(keyword));
}

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

// ─── Manejo central de mensajes ───────────────────────────────────────────────
async function handleMessage(text, from, platform) {
  try {
    // Detectar qué agente usar
    let agentId;
    let tipoAgente;

    // Si el usuario ya está en una conversación activa, continuar con ese agente
    if (agentesActivos[from]) {
      agentId = agentesActivos[from];
      tipoAgente = agentId === RELEVANCE_TOURS_AGENT_ID ? "tours" : "apartamentos";
      console.log(`🔁 Continuando con agente de ${tipoAgente} para ${from}`);
    } else {
      // Primera vez o nuevo tema — detectar por palabras clave
      if (esTour(text)) {
        agentId = RELEVANCE_TOURS_AGENT_ID;
        tipoAgente = "tours";
      } else {
        agentId = RELEVANCE_AGENT_ID;
        tipoAgente = "apartamentos";
      }
      agentesActivos[from] = agentId;
      console.log(`🆕 Nuevo agente de ${tipoAgente} para ${from}`);
    }

    // Recuperar conversation_id existente
    const conversationKey = `${from}_${tipoAgente}`;
    const conversationId = conversaciones[conversationKey] || null;

    // 1. Disparar el agente
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
    console.log(`🚀 Agente ${tipoAgente} disparado:`, JSON.stringify(triggerData));

    const studioId = triggerData?.job_info?.studio_id;
    const jobId = triggerData?.job_info?.job_id;
    const newConversationId = triggerData?.conversation_id;

    // Guardar conversation_id
    if (newConversationId) {
      conversaciones[conversationKey] = newConversationId;
    }

    if (!studioId || !jobId) {
      console.error("❌ No se obtuvo studio_id o job_id");
      await sendMessage(from, "Lo siento, hubo un error al procesar tu mensaje.", platform);
      return;
    }

    // 2. Polling para obtener la respuesta
    const agentReply = await pollForReply(studioId, jobId);

    // 3. Enviar respuesta
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
