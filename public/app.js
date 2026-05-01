const LS_KEY = "aula-clara:sessions:v1";
const DB_NAME = "aula-clara-audio";
const DB_STORE = "recordings";

const els = {
  apiStatus: document.querySelector("#apiStatus"),
  sessionList: document.querySelector("#sessionList"),
  newSessionBtn: document.querySelector("#newSessionBtn"),
  titleInput: document.querySelector("#titleInput"),
  timer: document.querySelector("#timer"),
  recordingState: document.querySelector("#recordingState"),
  recordBtn: document.querySelector("#recordBtn"),
  pauseBtn: document.querySelector("#pauseBtn"),
  stopBtn: document.querySelector("#stopBtn"),
  audioPlayer: document.querySelector("#audioPlayer"),
  audioFileInput: document.querySelector("#audioFileInput"),
  transcribeBtn: document.querySelector("#transcribeBtn"),
  dictationBtn: document.querySelector("#dictationBtn"),
  dictationStatus: document.querySelector("#dictationStatus"),
  transcriptInput: document.querySelector("#transcriptInput"),
  summaryBtn: document.querySelector("#summaryBtn"),
  summaryOutput: document.querySelector("#summaryOutput"),
  chatLog: document.querySelector("#chatLog"),
  questionForm: document.querySelector("#questionForm"),
  questionInput: document.querySelector("#questionInput"),
  toast: document.querySelector("#toast"),
  mobileTabs: [...document.querySelectorAll(".mobile-tab")]
};

let sessions = loadSessions();
let currentId = sessions[0]?.id || null;
let audioUrl = "";
let currentAudioBlob = null;
let recorder = null;
let chunks = [];
let stream = null;
let timerHandle = null;
let startedAt = 0;
let pausedAt = 0;
let pausedMs = 0;
let recognition = null;
let recognizing = false;
let dictationWanted = false;
let dictationRestartHandle = null;
let dictationWakeLock = null;
let saveHandle = null;
let aiReady = false;

const SPANISH_STOPWORDS = new Set([
  "a", "al", "algo", "ante", "asi", "como", "con", "contra", "cual", "cuando", "de", "del",
  "desde", "donde", "durante", "e", "el", "ella", "ellas", "ellos", "en", "entre", "era",
  "eran", "es", "esa", "esas", "ese", "eso", "esos", "esta", "estan", "estas", "este",
  "esto", "estos", "fue", "fueron", "ha", "hay", "la", "las", "lo", "los", "mas", "me",
  "mi", "muy", "no", "o", "para", "pero", "por", "porque", "que", "se", "si", "sin",
  "sobre", "son", "su", "sus", "tambien", "te", "tiene", "tienen", "un", "una", "uno",
  "unos", "y", "ya"
]);

function nowIso() {
  return new Date().toISOString();
}

function makeId() {
  return `clase_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("es-PE", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function formatDuration(seconds = 0) {
  const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
  const secs = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${mins}:${secs}`;
}

function defaultTitle() {
  return `Clase ${formatDate(nowIso())}`;
}

function loadSessions() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveSessions() {
  localStorage.setItem(LS_KEY, JSON.stringify(sessions));
}

function currentSession() {
  return sessions.find((session) => session.id === currentId) || null;
}

function scheduleSave() {
  clearTimeout(saveHandle);
  saveHandle = setTimeout(saveSessions, 200);
}

function openAudioDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withAudioStore(mode, callback) {
  const db = await openAudioDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, mode);
    const store = tx.objectStore(DB_STORE);
    const result = callback(store);
    tx.oncomplete = () => {
      db.close();
      resolve(result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveAudioBlob(id, blob) {
  await withAudioStore("readwrite", (store) => store.put(blob, id));
}

async function getAudioBlob(id) {
  const db = await openAudioDb();
  try {
    const tx = db.transaction(DB_STORE, "readonly");
    const store = tx.objectStore(DB_STORE);
    return await requestToPromise(store.get(id));
  } finally {
    db.close();
  }
}

async function deleteAudioBlob(id) {
  await withAudioStore("readwrite", (store) => store.delete(id));
}

function createSession(title = defaultTitle()) {
  const session = {
    id: makeId(),
    title,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    durationSec: 0,
    audioMeta: null,
    transcript: "",
    summary: "",
    messages: []
  };
  sessions.unshift(session);
  currentId = session.id;
  saveSessions();
  render();
  loadCurrentAudio();
}

function deleteSession(id) {
  const index = sessions.findIndex((session) => session.id === id);
  if (index === -1) return;
  sessions.splice(index, 1);
  deleteAudioBlob(id).catch(() => {});
  if (currentId === id) {
    currentId = sessions[0]?.id || null;
  }
  if (!sessions.length) {
    createSession();
    return;
  }
  saveSessions();
  render();
  loadCurrentAudio();
}

function renderSessions() {
  els.sessionList.innerHTML = "";
  for (const session of sessions) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `session-item${session.id === currentId ? " active" : ""}`;
    item.addEventListener("click", () => {
      currentId = session.id;
      render();
      loadCurrentAudio();
      if (window.matchMedia("(max-width: 760px)").matches) {
        setMobileView("record");
      }
    });

    const text = document.createElement("span");
    text.innerHTML = `<span class="session-title"></span><span class="session-meta"></span>`;
    text.querySelector(".session-title").textContent = session.title || "Clase sin titulo";
    text.querySelector(".session-meta").textContent = `${formatDate(session.updatedAt)} · ${formatDuration(session.durationSec)}`;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete-session";
    remove.title = "Eliminar clase";
    remove.textContent = "x";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteSession(session.id);
    });

    item.append(text, remove);
    els.sessionList.append(item);
  }
}

function setMobileView(view) {
  document.body.dataset.mobileView = view;
  for (const tab of els.mobileTabs) {
    tab.classList.toggle("active", tab.dataset.targetView === view);
  }
}

function renderChat(session) {
  els.chatLog.innerHTML = "";
  if (!session.messages.length) {
    const empty = document.createElement("div");
    empty.className = "chat-empty";
    empty.textContent = "Sin preguntas todavia.";
    els.chatLog.append(empty);
    return;
  }

  for (const message of session.messages) {
    const node = document.createElement("div");
    node.className = `message ${message.role}`;
    node.textContent = message.content;
    els.chatLog.append(node);
  }
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function render() {
  if (!sessions.length) {
    createSession();
    return;
  }

  const session = currentSession() || sessions[0];
  currentId = session.id;
  els.titleInput.value = session.title;
  els.transcriptInput.value = session.transcript || "";
  els.summaryOutput.textContent = session.summary || "Sin resumen todavia.";
  els.summaryOutput.classList.toggle("empty", !session.summary);
  els.timer.textContent = formatDuration(session.durationSec);
  els.transcribeBtn.disabled = !session.audioMeta;
  renderSessions();
  renderChat(session);
}

async function loadCurrentAudio() {
  if (audioUrl) {
    URL.revokeObjectURL(audioUrl);
    audioUrl = "";
  }
  currentAudioBlob = null;
  els.audioPlayer.removeAttribute("src");
  els.audioPlayer.load();

  const session = currentSession();
  if (!session?.audioMeta) {
    els.transcribeBtn.disabled = true;
    return;
  }

  try {
    const blob = await getAudioBlob(session.id);
    if (!blob || session.id !== currentId) return;
    currentAudioBlob = blob;
    audioUrl = URL.createObjectURL(blob);
    els.audioPlayer.src = audioUrl;
    els.transcribeBtn.disabled = false;
  } catch {
    showToast("No pude cargar el audio guardado.");
  }
}

function markSessionUpdated(session) {
  session.updatedAt = nowIso();
  scheduleSave();
  renderSessions();
}

function updateRecordingButtons(state) {
  const isRecording = state === "recording";
  const isPaused = state === "paused";
  els.recordBtn.disabled = isRecording || isPaused;
  els.pauseBtn.disabled = !isRecording && !isPaused;
  els.stopBtn.disabled = !isRecording && !isPaused;
  els.pauseBtn.textContent = isPaused ? "Reanudar" : "Pausar";
  els.recordingState.classList.toggle("live", isRecording || isPaused);
  els.recordingState.textContent = isRecording ? "Grabando" : isPaused ? "Pausada" : "Lista para grabar";
}

function elapsedMs() {
  if (!startedAt) return 0;
  const end = pausedAt || Date.now();
  return Math.max(0, end - startedAt - pausedMs);
}

function startTimer() {
  clearInterval(timerHandle);
  timerHandle = setInterval(() => {
    els.timer.textContent = formatDuration(Math.round(elapsedMs() / 1000));
  }, 250);
}

function stopTimer(finalSeconds) {
  clearInterval(timerHandle);
  timerHandle = null;
  els.timer.textContent = formatDuration(finalSeconds);
}

function preferredMimeType() {
  const options = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return options.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

async function startRecording() {
  const session = currentSession();
  if (!session) return;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    chunks = [];
    const mimeType = preferredMimeType();
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    startedAt = Date.now();
    pausedAt = 0;
    pausedMs = 0;

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });

    recorder.addEventListener("stop", async () => {
      const type = recorder.mimeType || "audio/webm";
      const blob = new Blob(chunks, { type });
      const finalSeconds = Math.round(elapsedMs() / 1000);
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      recorder = null;
      startedAt = 0;
      pausedAt = 0;
      pausedMs = 0;

      await saveAudioBlob(session.id, blob);
      session.durationSec = finalSeconds;
      session.audioMeta = {
        type,
        size: blob.size,
        createdAt: nowIso()
      };
      markSessionUpdated(session);
      saveSessions();
      updateRecordingButtons("idle");
      stopTimer(finalSeconds);
      await loadCurrentAudio();
      showToast("Audio guardado.");
    });

    recorder.start(1000);
    updateRecordingButtons("recording");
    startTimer();
  } catch (error) {
    updateRecordingButtons("idle");
    showToast(error.message || "No pude acceder al microfono.");
  }
}

function togglePause() {
  if (!recorder) return;
  if (recorder.state === "recording") {
    recorder.pause();
    pausedAt = Date.now();
    updateRecordingButtons("paused");
    return;
  }
  if (recorder.state === "paused") {
    pausedMs += Date.now() - pausedAt;
    pausedAt = 0;
    recorder.resume();
    updateRecordingButtons("recording");
  }
}

function stopRecording() {
  if (!recorder || recorder.state === "inactive") return;
  recorder.stop();
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function extensionForMime(mimeType = "") {
  if (mimeType.includes("wav")) return ".wav";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return ".mp3";
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return ".m4a";
  if (mimeType.includes("ogg")) return ".ogg";
  return ".webm";
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "La solicitud fallo.");
  }
  return payload;
}

function normalizeText(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function tokenize(text) {
  return normalizeText(text)
    .split(/[^a-z0-9]+/i)
    .filter((word) => word.length > 2 && !SPANISH_STOPWORDS.has(word));
}

function splitSentences(text) {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 35);
}

function scoreSentences(sentences, preferredWords = []) {
  const frequency = new Map();
  const preferred = new Set(preferredWords);

  for (const sentence of sentences) {
    for (const word of tokenize(sentence)) {
      frequency.set(word, (frequency.get(word) || 0) + 1);
    }
  }

  return sentences
    .map((sentence, index) => {
      const words = tokenize(sentence);
      const baseScore = words.reduce((total, word) => total + (frequency.get(word) || 0), 0);
      const questionBoost = words.reduce((total, word) => total + (preferred.has(word) ? 5 : 0), 0);
      const lengthPenalty = Math.max(1, Math.abs(words.length - 22) / 22);
      return {
        sentence,
        index,
        score: (baseScore + questionBoost) / lengthPenalty
      };
    })
    .sort((a, b) => b.score - a.score);
}

function topKeywords(text, limit = 10) {
  const frequency = new Map();
  for (const word of tokenize(text)) {
    frequency.set(word, (frequency.get(word) || 0) + 1);
  }

  return [...frequency.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}

function createLocalSummary(transcript) {
  const sentences = splitSentences(transcript);
  if (!sentences.length) {
    return "Resumen local (gratis)\n\nLa transcripcion es muy corta para resumir con confianza.";
  }

  const picked = scoreSentences(sentences)
    .slice(0, Math.min(5, sentences.length))
    .sort((a, b) => a.index - b.index)
    .map((item) => item.sentence);
  const keywords = topKeywords(transcript, 8);

  return [
    "Resumen local (gratis)",
    "",
    "Resumen breve:",
    ...picked.map((sentence) => `- ${sentence}`),
    "",
    "Ideas clave detectadas:",
    ...(keywords.length ? keywords.map((word) => `- ${word}`) : ["- No se detectaron palabras clave suficientes."]),
    "",
    "Posibles preguntas de estudio:",
    ...keywords.slice(0, 4).map((word) => `- Que se explico sobre ${word}?`),
    "",
    "Nota: este resumen es automatico y basico; revisa la transcripcion antes de estudiar."
  ].join("\n");
}

function createLocalAnswer(transcript, question) {
  const sentences = splitSentences(transcript);
  const questionWords = tokenize(question);
  const matches = scoreSentences(sentences, questionWords)
    .filter((item) => item.score > 0)
    .slice(0, 3)
    .sort((a, b) => a.index - b.index);

  if (!matches.length) {
    return "Modo local gratis: no encontre una parte clara de la transcripcion que responda eso. Prueba con otras palabras o revisa el texto manualmente.";
  }

  return [
    "Modo local gratis: encontre estas partes relacionadas:",
    "",
    ...matches.map((item) => `- ${item.sentence}`),
    "",
    "Respuesta corta:",
    matches[0].sentence
  ].join("\n");
}

async function transcribeCurrentAudio() {
  const session = currentSession();
  if (!session || !currentAudioBlob) return;

  els.transcribeBtn.disabled = true;
  els.transcribeBtn.textContent = "Transcribiendo...";
  try {
    const audioDataUrl = await blobToDataUrl(currentAudioBlob);
    const result = await fetchJson("/api/transcribe", {
      method: "POST",
      body: JSON.stringify({
        audioDataUrl,
        mimeType: currentAudioBlob.type,
        language: "es",
        filename: session.audioMeta?.name || `${session.id}${extensionForMime(currentAudioBlob.type)}`
      })
    });
    session.transcript = result.text.trim();
    els.transcriptInput.value = session.transcript;
    markSessionUpdated(session);
    saveSessions();
    showToast("Transcripcion lista.");
  } catch (error) {
    showToast("No hay cuota para transcribir audio. Usa Dictado en vivo para hacerlo gratis.");
  } finally {
    els.transcribeBtn.textContent = "Transcribir audio";
    els.transcribeBtn.disabled = !currentSession()?.audioMeta;
  }
}

async function generateCurrentSummary() {
  const session = currentSession();
  if (!session?.transcript.trim()) {
    showToast("Necesito una transcripcion primero.");
    return;
  }

  els.summaryBtn.disabled = true;
  els.summaryBtn.textContent = "Generando...";
  try {
    if (aiReady) {
      const result = await fetchJson("/api/summarize", {
        method: "POST",
        body: JSON.stringify({ transcript: session.transcript })
      });
      session.summary = result.text.trim();
    } else {
      session.summary = createLocalSummary(session.transcript);
    }
    els.summaryOutput.textContent = session.summary || "Sin resumen todavia.";
    els.summaryOutput.classList.toggle("empty", !session.summary);
    markSessionUpdated(session);
    saveSessions();
    showToast(aiReady ? "Resumen generado." : "Resumen local generado.");
  } catch (error) {
    session.summary = createLocalSummary(session.transcript);
    els.summaryOutput.textContent = session.summary;
    els.summaryOutput.classList.remove("empty");
    markSessionUpdated(session);
    saveSessions();
    showToast("La API fallo; genere un resumen local gratis.");
  } finally {
    els.summaryBtn.disabled = false;
    els.summaryBtn.textContent = "Generar";
  }
}

async function askQuestion(question) {
  const session = currentSession();
  if (!session?.transcript.trim()) {
    showToast("Necesito una transcripcion primero.");
    return;
  }

  session.messages.push({ role: "user", content: question, createdAt: nowIso() });
  session.messages.push({ role: "assistant", content: "Pensando...", createdAt: nowIso(), pending: true });
  renderChat(session);
  markSessionUpdated(session);

  try {
    const result = aiReady
      ? await fetchJson("/api/ask", {
          method: "POST",
          body: JSON.stringify({ transcript: session.transcript, question })
        })
      : { text: createLocalAnswer(session.transcript, question) };
    const pending = session.messages.find((message) => message.pending);
    if (pending) {
      pending.content = result.text.trim();
      delete pending.pending;
    }
    markSessionUpdated(session);
    saveSessions();
    renderChat(session);
  } catch (error) {
    const pending = session.messages.find((message) => message.pending);
    if (pending) {
      pending.content = createLocalAnswer(session.transcript, question);
      delete pending.pending;
    }
    renderChat(session);
    showToast("La API fallo; respondi en modo local gratis.");
  }
}

async function importAudio(file) {
  const session = currentSession();
  if (!session || !file) return;

  await saveAudioBlob(session.id, file);
  session.durationSec = 0;
  session.audioMeta = {
    type: file.type || "audio/webm",
    size: file.size,
    createdAt: nowIso(),
    name: file.name
  };
  markSessionUpdated(session);
  saveSessions();
  await loadCurrentAudio();
  showToast("Audio importado.");
}

function compactText(text) {
  return normalizeText(text)
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function removeDictationOverlap(existingText, incomingText) {
  const incomingWords = incomingText.trim().split(/\s+/).filter(Boolean);
  if (!incomingWords.length) return "";

  const existingWords = compactText(existingText).split(/\s+/).filter(Boolean);
  const incomingKeys = incomingWords.map((word) => compactText(word)).filter(Boolean);
  if (!incomingKeys.length) return "";

  const existingTail = existingWords.slice(-80).join(" ");
  const incomingKey = incomingKeys.join(" ");
  if (existingTail.endsWith(incomingKey)) {
    return "";
  }

  const maxOverlap = Math.min(existingWords.length, incomingKeys.length);
  let overlap = 0;
  for (let size = maxOverlap; size > 0; size -= 1) {
    const tail = existingWords.slice(-size).join(" ");
    const head = incomingKeys.slice(0, size).join(" ");
    if (tail === head) {
      overlap = size;
      break;
    }
  }

  return incomingWords.slice(overlap).join(" ").trim();
}

function appendDictationText(text) {
  const cleanText = text.trim().replace(/\s+/g, " ");
  if (!cleanText) return;

  const newText = removeDictationOverlap(els.transcriptInput.value, cleanText);
  if (!newText) return;

  const session = currentSession();
  const separator = els.transcriptInput.value.trim() ? "\n" : "";
  els.transcriptInput.value += `${separator}${newText}`;
  if (session) {
    session.transcript = els.transcriptInput.value;
    markSessionUpdated(session);
  }
}

function updateDictationUi(status) {
  els.dictationBtn.textContent = dictationWanted ? "Detener dictado" : "Dictado en vivo";
  els.dictationStatus.textContent = status || "";
}

async function requestDictationWakeLock() {
  if (!("wakeLock" in navigator) || dictationWakeLock) return;
  try {
    dictationWakeLock = await navigator.wakeLock.request("screen");
    dictationWakeLock.addEventListener("release", () => {
      dictationWakeLock = null;
      if (dictationWanted && document.visibilityState === "visible") {
        requestDictationWakeLock();
      }
    });
  } catch {
    dictationWakeLock = null;
  }
}

async function releaseDictationWakeLock() {
  if (!dictationWakeLock) return;
  const lock = dictationWakeLock;
  dictationWakeLock = null;
  try {
    await lock.release();
  } catch {
    // The browser may already have released it.
  }
}

function scheduleDictationRestart(delay = 500) {
  if (!dictationWanted) return;
  clearTimeout(dictationRestartHandle);
  dictationRestartHandle = setTimeout(() => {
    if (dictationWanted && !recognizing && document.visibilityState === "visible") {
      startDictation();
    }
  }, delay);
}

async function startDictation() {
  if (!recognition || recognizing) return;
  dictationWanted = true;
  clearTimeout(dictationRestartHandle);
  updateDictationUi("Activando microfono...");
  requestDictationWakeLock();
  try {
    recognition.start();
  } catch {
    scheduleDictationRestart(900);
  }
}

async function stopDictation() {
  dictationWanted = false;
  clearTimeout(dictationRestartHandle);
  releaseDictationWakeLock();
  if (!recognition || !recognizing) {
    recognizing = false;
    updateDictationUi("");
    return;
  }
  recognition.stop();
}

function setupDictation() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    els.dictationBtn.disabled = true;
    els.dictationStatus.textContent = "Dictado no disponible en este navegador";
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = "es-PE";
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onstart = () => {
    recognizing = true;
    updateDictationUi("Escuchando en continuo");
  };

  recognition.onend = () => {
    recognizing = false;
    if (dictationWanted) {
      updateDictationUi("Reanudando escucha...");
      scheduleDictationRestart(450);
    } else {
      updateDictationUi("");
    }
  };

  recognition.onerror = (event) => {
    if (["not-allowed", "service-not-allowed"].includes(event.error)) {
      dictationWanted = false;
      releaseDictationWakeLock();
    }
    if (event.error !== "no-speech") {
      showToast(event.error || "Error de dictado.");
    }
    if (dictationWanted) {
      scheduleDictationRestart(event.error === "no-speech" ? 350 : 900);
    }
  };

  recognition.onresult = (event) => {
    let finalText = "";
    let interimText = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const text = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalText += text.trim() + " ";
      } else {
        interimText += text;
      }
    }

    if (finalText) {
      appendDictationText(finalText);
    }
    updateDictationUi(interimText ? interimText.trim() : "Escuchando en continuo");
  };
}

function toggleDictation() {
  if (!recognition) return;
  if (recognizing || dictationWanted) {
    stopDictation();
  } else {
    startDictation();
  }
}

async function checkApiStatus() {
  try {
    const health = await fetchJson("/api/health");
    aiReady = Boolean(health.aiReady);
    els.apiStatus.classList.toggle("ready", health.aiReady);
    els.apiStatus.classList.toggle("missing", !health.aiReady);
    els.apiStatus.textContent = health.aiReady ? "IA conectada" : "Modo gratis local";
  } catch {
    aiReady = false;
    els.apiStatus.classList.add("missing");
    els.apiStatus.textContent = "Modo gratis local";
  }
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(showToast.handle);
  showToast.handle = setTimeout(() => {
    els.toast.classList.remove("show");
  }, 3200);
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

function bindEvents() {
  document.addEventListener("visibilitychange", () => {
    if (!dictationWanted) return;
    if (document.visibilityState === "visible") {
      requestDictationWakeLock();
      scheduleDictationRestart(300);
    }
  });

  for (const tab of els.mobileTabs) {
    tab.addEventListener("click", () => setMobileView(tab.dataset.targetView));
  }

  els.newSessionBtn.addEventListener("click", () => {
    createSession();
    if (window.matchMedia("(max-width: 760px)").matches) {
      setMobileView("record");
    }
  });
  els.titleInput.addEventListener("input", () => {
    const session = currentSession();
    if (!session) return;
    session.title = els.titleInput.value || "Clase sin titulo";
    markSessionUpdated(session);
  });
  els.transcriptInput.addEventListener("input", () => {
    const session = currentSession();
    if (!session) return;
    session.transcript = els.transcriptInput.value;
    markSessionUpdated(session);
  });
  els.recordBtn.addEventListener("click", startRecording);
  els.pauseBtn.addEventListener("click", togglePause);
  els.stopBtn.addEventListener("click", stopRecording);
  els.transcribeBtn.addEventListener("click", transcribeCurrentAudio);
  els.summaryBtn.addEventListener("click", generateCurrentSummary);
  els.dictationBtn.addEventListener("click", toggleDictation);
  els.audioFileInput.addEventListener("change", (event) => {
    importAudio(event.target.files?.[0]);
    event.target.value = "";
  });
  els.questionForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const question = els.questionInput.value.trim();
    if (!question) return;
    els.questionInput.value = "";
    askQuestion(question);
  });
}

bindEvents();
setupDictation();
registerServiceWorker();
if (!sessions.length) createSession();
render();
loadCurrentAudio();
checkApiStatus();
updateRecordingButtons("idle");
