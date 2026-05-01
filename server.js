const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.resolve(__dirname, "public");
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-5";
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function readJson(req, maxBytes = 80 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error("El archivo es demasiado grande para este prototipo.");
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        error.statusCode = 400;
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

function extractOutputText(response) {
  if (typeof response.output_text === "string") {
    return response.output_text;
  }

  const chunks = [];
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") {
        chunks.push(content.text);
      }
    }
  }

  return chunks.join("\n").trim();
}

async function openaiRequest(endpoint, options = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const error = new Error("Falta OPENAI_API_KEY en el entorno del servidor.");
    error.statusCode = 401;
    throw error;
  }

  const response = await fetch(`${OPENAI_BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const raw = await response.text();
    let detail = raw;
    try {
      const parsed = JSON.parse(raw);
      detail = parsed.error?.message || raw;
    } catch {
      // Keep the raw upstream response.
    }

    const error = new Error(detail || "OpenAI devolvio un error.");
    error.statusCode = response.status;
    throw error;
  }

  return response.json();
}

function parseDataUrl(dataUrl, fallbackMimeType) {
  const match = /^data:([^;,]+)?;base64,(.+)$/s.exec(dataUrl || "");
  if (!match) {
    const error = new Error("El audio no llego en formato base64 valido.");
    error.statusCode = 400;
    throw error;
  }

  return {
    mimeType: fallbackMimeType || match[1] || "audio/webm",
    buffer: Buffer.from(match[2], "base64")
  };
}

function extensionForMime(mimeType) {
  if (mimeType.includes("wav")) return ".wav";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return ".mp3";
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return ".m4a";
  if (mimeType.includes("ogg")) return ".ogg";
  return ".webm";
}

async function transcribeAudio(payload) {
  const { audioDataUrl, mimeType, filename } = payload;
  const parsed = parseDataUrl(audioDataUrl, mimeType);
  const form = new FormData();
  const blob = new Blob([parsed.buffer], { type: parsed.mimeType });
  const uploadName = filename || `clase-${Date.now()}${extensionForMime(parsed.mimeType)}`;

  form.append("file", blob, uploadName);
  form.append("model", TRANSCRIBE_MODEL);
  form.append("language", payload.language || "es");
  form.append("response_format", "json");
  if (payload.prompt) {
    form.append("prompt", payload.prompt);
  }

  const result = await openaiRequest("/audio/transcriptions", {
    method: "POST",
    body: form
  });

  return {
    text: result.text || "",
    model: TRANSCRIBE_MODEL
  };
}

async function generateSummary(transcript) {
  const response = await openaiRequest("/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: TEXT_MODEL,
      instructions:
        "Eres un tutor de estudio. Resume clases en espanol claro, sin inventar datos. " +
        "Usa solo la transcripcion recibida. Si algo no aparece, dilo como duda o pendiente.",
      input:
        "Transcripcion de clase:\n\n" +
        transcript +
        "\n\nCrea un resumen con estas secciones: Resumen breve, Ideas clave, Conceptos y definiciones, Posibles preguntas de examen, Pendientes o dudas."
    })
  });

  return {
    text: extractOutputText(response),
    model: TEXT_MODEL
  };
}

async function answerQuestion(transcript, question) {
  const response = await openaiRequest("/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: TEXT_MODEL,
      instructions:
        "Responde como asistente de estudio. Usa exclusivamente la transcripcion dada. " +
        "Si la respuesta no esta en la transcripcion, dilo de forma directa y sugiere que parte revisar.",
      input:
        "Transcripcion de clase:\n\n" +
        transcript +
        "\n\nPregunta del estudiante:\n" +
        question
    })
  });

  return {
    text: extractOutputText(response),
    model: TEXT_MODEL
  };
}

function serveStatic(req, res, url) {
  const requestedPath = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const filePath = path.resolve(PUBLIC_DIR, requestedPath);

  if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendText(res, error.code === "ENOENT" ? 404 : 500, error.code === "ENOENT" ? "Not found" : "Server error");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": contentTypes[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        aiReady: Boolean(process.env.OPENAI_API_KEY),
        textModel: TEXT_MODEL,
        transcribeModel: TRANSCRIBE_MODEL
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/transcribe") {
      const payload = await readJson(req);
      const result = await transcribeAudio(payload);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/summarize") {
      const payload = await readJson(req, 4 * 1024 * 1024);
      if (!payload.transcript?.trim()) {
        sendJson(res, 400, { error: "Necesito una transcripcion para resumir." });
        return;
      }
      const result = await generateSummary(payload.transcript);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/ask") {
      const payload = await readJson(req, 4 * 1024 * 1024);
      if (!payload.transcript?.trim() || !payload.question?.trim()) {
        sendJson(res, 400, { error: "Necesito transcripcion y pregunta." });
        return;
      }
      const result = await answerQuestion(payload.transcript, payload.question);
      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 404, { error: "Ruta no encontrada." });
  } catch (error) {
    sendJson(res, error.statusCode || 500, {
      error: error.message || "Error inesperado."
    });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url);
    return;
  }
  serveStatic(req, res, url);
});

function getNetworkUrls(port) {
  const urls = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) {
        urls.push(`http://${address.address}:${port}`);
      }
    }
  }
  return urls;
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Aula Clara listo en http://localhost:${PORT}`);
  for (const url of getNetworkUrls(PORT)) {
    console.log(`Celular en el mismo Wi-Fi: ${url}`);
  }
});
