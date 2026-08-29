const express = require("express");
const crypto = require("crypto");
const app = express();
app.use(express.json());

// ─── Google Sheets via Service Account ───────────────────────────────────────
async function getGoogleAccessToken() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  })).toString("base64url");

  const { createSign } = require("crypto");
  const sign = createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(credentials.private_key, "base64url");
  const jwt = `${header}.${payload}.${signature}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  const data = await response.json();
  return data.access_token;
}

async function actualizarDisponibilidadSheets(tours, fecha) {
  try {
    const token = await getGoogleAccessToken();
    const spreadsheetId = "1QulBkGv6uFxMewGl72mXy36poh9WM0jIQS0fA8hK1Bc";
    const sheetName = "Tours";
    const sheetRange = encodeURIComponent(`${sheetName}!A:C`);

    // Primero leer los tours existentes
    const readRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${sheetRange}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const readData = await readRes.json();
    const filas = readData.values || [];

    // Marcar todos como NO DISPONIBLE primero
    const toursExistentes = filas.slice(0).map(f => f[0]);
    
    // Preparar nuevas filas
    const nuevasFilas = tours.map(tour => [tour, "SI", fecha]);
    
    // Tours existentes no mencionados → NO
    const toursNoMencionados = toursExistentes
      .filter(t => t && !tours.includes(t))
      .map(t => [t, "NO", fecha]);

    // Escribir todos los tours desde fila 9
    const todosLosTours = [...nuevasFilas, ...toursNoMencionados];
    const writeRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${sheetRange}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: todosLosTours })
      }
    );
    const writeData = await writeRes.json();
    console.log("📊 Respuesta Sheets:", JSON.stringify(writeData));

    console.log(`✅ Disponibilidad actualizada en Sheets: ${tours.join(", ")}`);
    return true;
  } catch (err) {
    console.error("❌ Error actualizando disponibilidad en Sheets:", err.message);
    return false;
  }
}

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
const usuariosNuevos = new Set();

// ─── Mensaje de bienvenida ───────────────────────────────────────────────────
const MENSAJE_BIENVENIDA = `¡Hola! 🌴 Gracias por escribir a *Cartagena Stay Venture*, tu refugio en Cartagena, donde una gran experiencia comienza aquí ⛵🏖️☀️

Te ayudamos con:

🏠 *Alojamiento* — Apartamentos turísticos a pasos de la playa, con piscina en la azotea y gimnasio. Muy bien ubicados cerca de la playa, el aeropuerto y el centro histórico.
_(Torre Primis · 3 hab · y Edificio Acualina · 2 hab)_

⛵ *Tours y experiencias* — Islas del Rosario, Mambo Beach, Volcán del Totumo, plancton bioluminiscente, cultura y más.
🚁 *Tours en helicóptero* — Vive Cartagena desde el aire con una vista espectacular de la ciudad amurallada, el mar Caribe y las islas. Una experiencia única e inolvidable.

Para darte la mejor opción, cuéntanos:
📅 Fechas
👥 Número de personas
✨ ¿Alojamiento, tours o ambos?

Dame tus fechas aproximadas y te doy disponibilidad y precio al instante.

¡Bienvenido/a al Caribe colombiano! ☀️`;

// ─── Health check para UptimeRobot ───────────────────────────────────────────
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", message: "Servidor activo 🚀" });
});

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
        amount: { currency, total_amount: amountInCents, tip_amount: 0 },
        description: descripcion || "Reserva Cartagena Stay Venture",
        reference: orderId,
        payment_methods: ["CREDIT_CARD"],
      }),
    });

    const data = await response.json();
    console.log("💳 Link Bold creado:", JSON.stringify(data));
    return data?.payload?.url || null;
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
      // Enviar bienvenida si es la primera vez
      if (!usuariosNuevos.has(from)) {
        usuariosNuevos.add(from);
        await sendWhatsAppMessage(from, MENSAJE_BIENVENIDA);
      }

      // No enviar mensaje intermedio si es actualización de Next Tour
      if (text.includes("NEXXTOURS")) {
        console.log(`📢 Detectado mensaje Next Tour de ${from}`);
        
        // Extraer tours disponibles del mensaje
        const lineas = text.split("\n");
        const tours = [];
        for (const linea of lineas) {
          if (linea.includes("✅")) {
            const tourNombre = linea
              .replace(/[✅🚌🚤🌴🪼🦚🤿🦝🌊🐬🌋🐢☀️]/gu, "")
              .replace(/[-*•]/g, "")
              .replace(/\(por tierra.*?\)/gi, "")
              .replace(/\(por lancha.*?\)/gi, "")
              .trim();
            if (tourNombre.length > 3 && !tourNombre.toLowerCase().includes("tenemos") && !tourNombre.toLowerCase().includes("disponib")) {
              tours.push(tourNombre);
            }
          }
        }
        
        const fecha = new Date().toISOString().split("T")[0];
        if (tours.length > 0) {
          const ok = await actualizarDisponibilidadSheets(tours, fecha);
          if (ok) {
            await sendWhatsAppMessage(from, "✅ Disponibilidad de Next Tour actualizada.");
            return;
          }
        }
        
        await handleMessage(text, from, "whatsapp");
        return;
      }
      console.log(`📝 Procesando mensaje normal de ${from}: ${text.substring(0, 50)}`);

      // Mensaje intermedio según contexto
      const textoLower = text.toLowerCase();
      let mensajeIntermedio = "⏳ Dame un momento, estoy procesando tu mensaje...";

      if (textoLower.includes("disponib") || textoLower.includes("fecha") || textoLower.includes("reserv")) {
        mensajeIntermedio = "🔍 Estoy verificando la disponibilidad para esas fechas. Dame un momento, por favor.";
      } else if (textoLower.includes("precio") || textoLower.includes("costo") || textoLower.includes("cuánto") || textoLower.includes("cuanto")) {
        mensajeIntermedio = "💰 Estoy calculando el precio para ti. Dame un momento, por favor.";
      } else if (textoLower.includes("tour") || textoLower.includes("isla") || textoLower.includes("excursion") || textoLower.includes("experiencia") || textoLower.includes("helicoptero") || textoLower.includes("helicóptero")) {
        mensajeIntermedio = "🌴 Estoy revisando las opciones de tours disponibles para ti. Dame un momento, por favor.";
      } else if (textoLower.includes("pago") || textoLower.includes("nequi") || textoLower.includes("transferencia") || textoLower.includes("tarjeta") || textoLower.includes("daviplata")) {
        mensajeIntermedio = "💳 Estoy procesando la información de pago. Dame un momento, por favor.";
      } else {
        mensajeIntermedio = "⏳ Estoy trabajando en tu solicitud. Dame un momento, por favor.";
      }

      setTimeout(async () => {
        await sendWhatsAppMessage(from, mensajeIntermedio);
      }, 4000);

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
    const response = await fetch("https://integrations.api.bold.co/online/link/v1/payment_methods", {
      method: "GET",
      headers: { Authorization: `x-api-key ${BOLD_API_KEY}` },
    });
    const text = await response.text();
    res.json({ status: response.status, body: text.substring(0, 200) });
  } catch (err) {
    res.json({ error: err.message, cause: err.cause?.message });
  }
});

// ─── Endpoint para crear link de pago Bold ────────────────────────────────────
app.post("/crear-pago", async (req, res) => {
  const { monto, descripcion, referencia } = req.body;
  if (!monto) return res.status(400).json({ error: "Monto requerido" });
  const link = await crearLinkBold(monto, descripcion, referencia);
  link ? res.json({ link }) : res.status(500).json({ error: "No se pudo crear el link de pago" });
});

// ─── Manejo central de mensajes ───────────────────────────────────────────────
async function handleMessage(text, from, platform) {
  try {
    let agenteActual = agentesActivos[from] || "apartamentos";
    let agentId = agenteActual === "tours" ? RELEVANCE_TOURS_AGENT_ID : RELEVANCE_AGENT_ID;

    // Si el mensaje es de disponibilidad de Next Tour → ya fue procesado en webhook, no redirigir

    // Si es confirmación de pago → redirigir al agente correcto según booking_id
    if (text.startsWith("🔑 PAGO CONFIRMADO:")) {
      console.log(`💰 Confirmación de pago recibida: ${text}`);
      const bookingId = text.replace("🔑 PAGO CONFIRMADO:", "").trim();
      // Si el booking_id empieza con TOUR → agente de tours
      if (bookingId.startsWith("TOUR-")) {
        agentId = RELEVANCE_TOURS_AGENT_ID;
        agenteActual = "tours";
        console.log(`🌴 Redirigiendo confirmación al Agente de Tours`);
      } else {
        agentId = RELEVANCE_AGENT_ID;
        agenteActual = "apartamentos";
        console.log(`🏠 Redirigiendo confirmación al Agente de Apartamentos`);
      }
    }

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

    // Detectar señal de envío de QR Nequi
    if (agentReply.includes("ENVIAR_QR_NEQUI")) {
      console.log(`📲 Enviando QR Nequi a ${from}`);
      agentReply = agentReply.replace("ENVIAR_QR_NEQUI", "").trim();
      await sendWhatsAppImage(
        from,
        "https://raw.githubusercontent.com/nicolasbarreramojica-droid/whatsapp-agente/main/qr_nequi.jpg",
        "📲 Escanea este QR desde la app de tu banco para pagar fácil y rápido. — Cartagena Stay Venture"
      );
    }

    // Detectar señal de transferencia a tours
    if (agentReply.includes("CAMBIAR_A_TOURS")) {
      console.log(`🔀 Transfiriendo a agente de tours para ${from}`);
      agentesActivos[from] = "tours";
      delete conversaciones[`${from}_tours`];
      agentReply = agentReply.replace("CAMBIAR_A_TOURS", "").trim();
    }

    // Detectar señal de aviso de tour/paquete
    const avisoMatch = agentReply.match(/AVISO_TOUR\(([^)]+)\)/);
    if (avisoMatch) {
      const datos = avisoMatch[1].split(",");
      const nombre = datos[0]?.trim() || "N/A";
      const tour = datos[1]?.trim() || "N/A";
      const fecha = datos[2]?.trim() || "N/A";
      const personas = datos[3]?.trim() || "N/A";
      const telefono = datos[4]?.trim() || "N/A";

      const mensajeAviso = `🔔 *Nueva reserva pendiente de confirmar:*

` +
        `🌴 Tour/Paquete: ${tour}
` +
        `👤 Cliente: ${nombre}
` +
        `📅 Fecha: ${fecha}
` +
        `👥 Personas: ${personas}
` +
        `📱 Teléfono: ${telefono}

` +
        `⚠️ Verificar disponibilidad con proveedor y confirmar al cliente.`;

      console.log(`🔔 Enviando aviso a número personal: ${mensajeAviso}`);
      await sendWhatsAppMessage("573222810384", mensajeAviso);
      agentReply = agentReply.replace(avisoMatch[0], "").trim();
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

// ─── Polling mejorado — espera que el agente termine TODAS las herramientas ───
async function pollForReply(studioId, jobId, maxAttempts = 60, interval = 3000) {
  const url = `https://api-bcbe5a.stack.tryrelevance.com/latest/studios/${studioId}/async_poll/${jobId}`;

  let lastAnswer = "";
  let completedAt = null;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, interval));

    try {
      const res = await fetch(url, {
        headers: { Authorization: RELEVANCE_API_KEY },
      });

      const data = await res.json();
      console.log(`🔄 Intento ${i + 1} - type: ${data?.type}`);

      const updates = data?.updates || [];
      for (const update of updates) {
        if (update?.type === "chain-success") {
          const output = update?.output?.output?.answer ||
                        update?.output?.answer ||
                        update?.output?.text ||
                        update?.output;
          if (output && typeof output === "string") {
            lastAnswer = output;
            console.log("📝 Respuesta parcial guardada:", output.substring(0, 100));
          }
        }
      }

      // Cuando complete, esperar 2 rondas más para que terminen email y Sheets
      if (data?.type === "complete" || data?.status === "complete") {
        if (!completedAt) {
          completedAt = i;
          console.log(`✅ Agente completó en intento ${i + 1} — esperando rondas adicionales`);
        } else if (i - completedAt >= 2) {
          if (lastAnswer) {
            console.log("✅ Respuesta final:", lastAnswer.substring(0, 200));
            return lastAnswer;
          }
        }
      }

    } catch (err) {
      console.error(`❌ Error en polling intento ${i + 1}:`, err.message);
    }
  }

  return lastAnswer || "Lo siento, el agente tardó demasiado en responder. Intenta de nuevo.";
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

// ─── Enviar imagen QR por WhatsApp ───────────────────────────────────────────
async function sendWhatsAppImage(to, imageUrl, caption) {
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
      type: "image",
      image: {
        link: imageUrl,
        caption: caption || "",
      },
    }),
  });
  const data = await response.json();
  console.log("📤 Imagen enviada:", JSON.stringify(data));
  return data;
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
