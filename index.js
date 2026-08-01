const express = require("express");
const app = express();
app.use(express.json());

// ─── Config from environment variables ───────────────────────────────────────
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mi_token_secreto";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const RELEVANCE_API_KEY = process.env.RELEVANCE_API_KEY;
const RELEVANCE_AGENT_ID = process.env.RELEVANCE_AGENT_ID;

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

  if (body.object !== "whatsapp_business_account") return res.sendStatus(404);

  const entry = body.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;
  const message = value?.messages?.[0];

  if (!message || message.type !== "text") return res.sendStatus(200);

  const from = message.from;
  const text = message.text.body;

  console.log(`📩 Mensaje de ${from}: ${text}`);

  // Responder a Meta inmediatamente para evitar timeout
  res.sendStatus(200);

  try {
    // 1. Disparar el agente de Relevance AI
    const triggerRes = await fetch(
      "https://api-bcbe5a.stack.tryrelevance.com/latest/agents/trigger",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: RELEVANCE_API_KEY,
        },
        body: JSON.stringify({
          agent_id: RELEVANCE_AGENT_ID,
          message: { role: "user", content: text },
        }),
      }
    );

    const triggerData = await triggerRes.json();
    console.log("🚀 Agente disparado:", JSON.stringify(triggerData));

    const conversationId = triggerData?.conversation_id;

    if (!conversationId) {
      console.error("❌ No se obtuvo conversation_id");
      await sendWhatsAppMessage(from, "Lo siento, hubo un error al procesar tu mensaje.");
      return;
    }

    // 2. Polling para obtener la respuesta
    const agentReply = await pollForReply(conversationId);

    // 3. Enviar respuesta por WhatsApp
    await sendWhatsAppMessage(from, agentReply);

  } catch (err) {
    console.error("❌ Error:", err.message);
    await sendWhatsAppMessage(from, "Ocurrió un error. Intenta de nuevo.");
  }
});

// ─── Polling para obtener la respuesta del agente ────────────────────────────
async function pollForReply(conversationId, maxAttempts = 20, interval = 3000) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, interval));

    try {
      const res = await fetch(
        `https://api-bcbe5a.stack.tryrelevance.com/latest/conversations/${conversationId}`,
        {
          headers: {
            Authorization: RELEVANCE_API_KEY,
          },
        }
      );

      const text = await res.text();
      console.log(`🔄 Intento ${i + 1} raw:`, text.substring(0, 300));

      const data = JSON.parse(text);
      const messages = data?.messages || [];
      const agentMessages = messages.filter(m => m.role === "agent" || m.role === "assistant");

      if (agentMessages.length > 0) {
        const lastMessage = agentMessages[agentMessages.length - 1];
        const reply = lastMessage?.content || lastMessage?.text || lastMessage?.message;
        if (reply) {
          console.log("✅ Respuesta obtenida:", reply);
          return reply;
        }
      }

    } catch (err) {
      console.error(`❌ Error en polling intento ${i + 1}:`, err.message);
    }
  }

  return "Lo siento, el agente tardó demasiado en responder. Intenta de nuevo.";
}

// ─── Función para enviar mensajes por WhatsApp ────────────────────────────────
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
  console.log("📤 Mensaje enviado:", JSON.stringify(data));
  return data;
}

// ─── Servidor ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
