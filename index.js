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

    const studioId = triggerData?.job_info?.studio_id;
    const jobId = triggerData?.job_info?.job_id;

    if (!studioId || !jobId) {
      console.error("❌ No se obtuvo studio_id o job_id");
      await sendWhatsAppMessage(from, "Lo siento, hubo un error al procesar tu mensaje.");
      return;
    }

    // 2. Polling para obtener la respuesta
    const agentReply = await pollForReply(studioId, jobId);

    // 3. Enviar respuesta por WhatsApp
    await sendWhatsAppMessage(from, agentReply);

  } catch (err) {
    console.error("❌ Error:", err.message);
    await sendWhatsAppMessage(from, "Ocurrió un error. Intenta de nuevo.");
  }
});

// ─── Polling usando async_poll ────────────────────────────────────────────────
async function pollForReply(studioId, jobId, maxAttempts = 30, interval = 2000) {
  const url = `https://api-bcbe5a.stack.tryrelevance.com/latest/studios/${studioId}/async_poll/${jobId}`;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, interval));

    try {
      const res = await fetch(url, {
        headers: {
          Authorization: RELEVANCE_API_KEY,
        },
      });

      const data = await res.json();
      console.log(`🔄 Intento ${i + 1}:`, JSON.stringify(data).substring(0, 300));

      // Buscar respuesta en updates
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

      // Si está completo pero sin respuesta clara
      if (data?.type === "chain-success" || data?.status === "complete") {
        const output = data?.output?.output?.answer || data?.output?.answer || data?.output;
        if (output && typeof output === "string") {
          console.log("✅ Respuesta obtenida:", output);
          return output;
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
