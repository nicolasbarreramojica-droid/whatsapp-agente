const express = require("express");
const app = express();
app.use(express.json());

// ─── Config from environment variables ───────────────────────────────────────
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mi_token_secreto";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN; // Token de acceso de Meta
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; // ID del número en Meta
const RELEVANCE_API_KEY = process.env.RELEVANCE_API_KEY;
const RELEVANCE_AGENT_ID = process.env.RELEVANCE_AGENT_ID;
const RELEVANCE_REGION = process.env.RELEVANCE_REGION || "us-east-1"; // Cambia si tu región es diferente

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

  const from = message.from; // Número del usuario
  const text = message.text.body;

  console.log(`📩 Mensaje de ${from}: ${text}`);

  try {
    // 1. Enviar mensaje al agente de Relevance AI
    const relevanceRes = await fetch(
      `https://api-${RELEVANCE_REGION}.stack.tryrelevance.com/latest/agents/trigger`,
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

    const relevanceData = await relevanceRes.json();
    console.log("🤖 Respuesta Relevance:", JSON.stringify(relevanceData));

    // 2. Extraer respuesta del agente
    const agentReply =
      relevanceData?.output?.output?.answer ||
      relevanceData?.output?.answer ||
      relevanceData?.message ||
      "Lo siento, no pude procesar tu mensaje.";

    // 3. Enviar respuesta por WhatsApp
    await sendWhatsAppMessage(from, agentReply);
  } catch (err) {
    console.error("❌ Error:", err.message);
    await sendWhatsAppMessage(from, "Ocurrió un error. Intenta de nuevo.");
  }

  res.sendStatus(200);
});

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
