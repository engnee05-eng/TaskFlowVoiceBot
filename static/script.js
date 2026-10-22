(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const state = {
    active: false,
    processing: false,
    ending: false,
    recognition: null,
    recognitionUnavailable: false,
    shouldListen: false,
    recognitionStopResolve: null,
    stream: null,
    recorder: null,
    recordingChunks: [],
    recordingBlob: null,
    recordingUrl: null,
    startedAt: null,
    timer: null,
    pendingText: "",
    textTimer: null,
    transcript: [],
    callId: null,
    lastStatus: "No Response",
    processingPromise: null,
  };

  const elements = {
    actionHint: $("#action-hint"),
    analysisBody: $("#analysis-body"),
    callDuration: $("#call-duration"),
    callState: $("#call-state"),
    consent: $("#recording-consent"),
    consentRow: $("#consent-row"),
    customerMessage: $("#customer-message"),
    deleteAllCalls: $("#delete-all-calls"),
    emptyConversation: $("#empty-conversation"),
    endCall: $("#end-call"),
    historyCount: $("#history-count"),
    historyList: $("#history-list"),
    language: $("#language-select"),
    liveIndicator: $("#live-indicator"),
    recentCount: $("#recent-count"),
    refreshHistory: $("#refresh-history"),
    retryVoice: $("#retry-voice"),
    voiceError: $("#voice-error"),
    voiceRetry: $("#voice-retry"),
    startCall: $("#start-call"),
    textFallback: $("#text-fallback"),
    today: $("#today-label"),
    toastRegion: $("#toast-region"),
    transcript: $("#transcript"),
  };

  const statusClasses = {
    Converted: "status-converted",
    Interested: "status-interested",
    "Follow-up Required": "status-follow-up",
    "Not Interested": "status-not-interested",
    "Demo Requested": "status-demo",
    "No Response": "status-no-response",
  };
  const greetings = {
    "en-US": "Hi! I’m TaskFlow’s AI assistant. TaskFlow helps teams organize projects, assign tasks, collaborate, and track deadlines.",
    "hi-IN": "नमस्ते! मैं TaskFlow का AI सहायक हूँ। TaskFlow टीमों को प्रोजेक्ट व्यवस्थित करने, काम बाँटने, साथ मिलकर काम करने और समय-सीमा पर नज़र रखने में मदद करता है।",
    "te-IN": "నమస్కారం! నేను TaskFlow AI సహాయకుడిని. ప్రాజెక్టులను నిర్వహించడానికి, పనులను కేటాయించడానికి, కలిసి పనిచేయడానికి, గడువులను ట్రాక్ చేయడానికి TaskFlow బృందాలకు సహాయపడుతుంది।",
  };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);
  }

  function toast(message, kind = "error") {
    const item = document.createElement("div");
    item.className = `toast${kind === "success" ? " success" : ""}`;
    item.textContent = message;
    elements.toastRegion.append(item);
    window.setTimeout(() => item.remove(), 6000);
  }

  async function apiRequest(path, options = {}) {
    let response;
    try {
      response = await fetch(path, {
        ...options,
        headers: {
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...options.headers,
        },
      });
    } catch (error) {
      throw new Error("Could not reach the app server. Check that the backend is running.");
    }
    let body;
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    if (!response.ok) {
      throw new Error(body.detail || `Request failed (${response.status}).`);
    }
    return body;
  }

  function showCallState(label, mode = "ready") {
    elements.callState.className = `call-state ${mode}`;
    elements.callState.querySelector("span").textContent = label;
  }

  function setTranscriptPlaceholder() {
    const existing = $("#empty-conversation");
    if (existing) existing.remove();
  }

  function addMessage(speaker, text, isError = false, isThinking = false) {
    setTranscriptPlaceholder();
    const isCustomer = speaker === "Customer";
    const message = document.createElement("div");
    message.className = `message ${isCustomer ? "customer" : "assistant"}${isThinking ? " thinking" : ""}`;
    const avatar = isCustomer ? "C" : "✦";
    const bubble = isThinking
      ? '<span>Preparing a reply</span><span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>'
      : escapeHtml(text);
    message.innerHTML = `
      <div class="message-meta">
        <span class="message-avatar">${avatar}</span>
        <span>${isCustomer ? "Customer" : "TaskFlow AI"}</span>
      </div>
      <div class="message-bubble${isError ? " error" : ""}">${bubble}</div>
    `;
    elements.transcript.append(message);
    elements.transcript.scrollTop = elements.transcript.scrollHeight;
    return message;
  }

  function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
    const remainder = Math.floor(seconds % 60).toString().padStart(2, "0");
    return `${minutes}:${remainder}`;
  }

  function updateDuration() {
    if (!state.active || !state.startedAt) return;
    elements.callDuration.textContent = formatTime((Date.now() - state.startedAt) / 1000);
  }

  function updateStartButton() {
    elements.startCall.disabled = !elements.consent.checked || state.active;
    elements.deleteAllCalls.disabled = Number(elements.historyCount.textContent) === 0;
    if (!elements.consent.checked && !state.active) {
      elements.actionHint.textContent = "Recording starts after you give consent.";
    } else if (!state.active) {
      elements.actionHint.textContent = "Your consent lets us save the call recording.";
    }
  }

  function currentLanguageName() {
    return elements.language.options[elements.language.selectedIndex].text;
  }

  function createRecognition() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) return null;
    const recognition = new Recognition();
    recognition.lang = elements.language.value;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      let interimText = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const phrase = result[0]?.transcript?.trim();
        if (!phrase) continue;
        if (result.isFinal) state.pendingText = `${state.pendingText} ${phrase}`.trim();
        else interimText = `${interimText} ${phrase}`.trim();
      }
      if (interimText) {
        elements.actionHint.textContent = `Hearing: “${interimText.slice(0, 70)}”`;
      } else if (state.pendingText) {
        elements.actionHint.textContent = "Got it — preparing a reply…";
      }
      if (state.pendingText) {
        window.clearTimeout(state.textTimer);
        state.textTimer = window.setTimeout(flushCustomerText, 900);
      }
    };
    recognition.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return;

      state.shouldListen = false;
      state.recognitionUnavailable = true;
      elements.liveIndicator.classList.add("hidden");
      elements.textFallback.classList.remove("hidden");
      elements.voiceRetry.classList.remove("hidden");

      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        elements.voiceError.textContent = "Microphone speech permission was denied. Allow it in browser settings, or type below.";
        elements.actionHint.textContent = "Speech permission denied. Allow microphone access or type a response.";
      } else if (event.error === "network") {
        elements.voiceError.textContent = "Browser speech recognition could not connect. Check internet access or type below.";
        elements.actionHint.textContent = "Speech service disconnected. Retry voice or type a response.";
      } else {
        elements.voiceError.textContent = `Speech recognition stopped (${event.error}). Retry voice or type below.`;
        elements.actionHint.textContent = "Speech recognition stopped. Retry voice or type a response.";
      }
      showCallState("Voice unavailable", "active");
    };
    recognition.onend = () => {
      if (state.pendingText && !state.processing) {
        window.clearTimeout(state.textTimer);
        flushCustomerText();
        if (state.recognitionStopResolve) {
          state.recognitionStopResolve();
          state.recognitionStopResolve = null;
        }
        return;
      }
      if (state.shouldListen && state.active && !state.processing && !state.recognitionUnavailable) {
        window.setTimeout(startRecognition, 350);
      }
      if (state.recognitionStopResolve) {
        state.recognitionStopResolve();
        state.recognitionStopResolve = null;
      }
    };
    return recognition;
  }

  function startRecognition() {
    if (!state.active || !state.shouldListen || state.processing || !state.recognition) return;
    try {
      state.recognition.lang = elements.language.value;
      state.recognition.start();
      elements.liveIndicator.classList.remove("hidden");
      showCallState("Listening", "active");
    } catch (error) {
      if (error.name !== "InvalidStateError") {
        state.shouldListen = false;
        state.recognitionUnavailable = true;
        elements.liveIndicator.classList.add("hidden");
        elements.textFallback.classList.remove("hidden");
        elements.voiceRetry.classList.remove("hidden");
        elements.voiceError.textContent = "Could not start browser speech recognition. Retry voice or type below.";
        elements.actionHint.textContent = "Could not start voice recognition. Type a response instead.";
        showCallState("Voice unavailable", "active");
      }
    }
  }

  function pauseRecognition() {
    state.shouldListen = false;
    elements.liveIndicator.classList.add("hidden");
    if (state.recognition) {
      try { state.recognition.stop(); } catch { /* Recognition may already be stopped. */ }
    }
  }

  async function pauseRecognitionAndWait() {
    if (!state.recognition) return;
    let timeoutId;
    const stopped = new Promise((resolve) => {
      state.recognitionStopResolve = resolve;
      timeoutId = window.setTimeout(resolve, 1200);
    });
    pauseRecognition();
    await stopped;
    window.clearTimeout(timeoutId);
    state.recognitionStopResolve = null;
  }

  function speak(text) {
    return new Promise((resolve, reject) => {
      if (!("speechSynthesis" in window)) {
        reject(new Error("Speech playback is unavailable in this browser."));
        return;
      }
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = elements.language.value;
      utterance.rate = 1;
      utterance.onend = resolve;
      utterance.onerror = (event) => reject(new Error(event.error || "Speech playback failed."));
      window.speechSynthesis.speak(utterance);
    });
  }

  async function processCustomerText(text) {
    const normalized = text.trim();
    if (!normalized || !state.active || state.processing) return;
    state.processing = true;
    pauseRecognition();
    showCallState("Thinking", "thinking");
    elements.actionHint.textContent = "TaskFlow is thinking…";
    addMessage("Customer", normalized);
    state.transcript.push({ speaker: "Customer", text: normalized });
    const thinkingMessage = addMessage("TaskFlow AI", "", false, true);
    try {
      const result = await apiRequest("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          message: normalized,
          history: state.transcript.slice(-6, -1),
        }),
      });
      thinkingMessage.remove();
      state.lastStatus = result.status;
      state.transcript.push({ speaker: "TaskFlow AI", text: result.reply });
      addMessage("TaskFlow AI", result.reply);
      showCallState("Speaking", "thinking");
      try {
        await speak(result.reply);
      } catch (error) {
        toast(`The AI reply is ready as text, but could not be spoken: ${error.message}`);
      }
      if (state.active) elements.actionHint.textContent = "Ready for the customer's next response.";
    } catch (error) {
      thinkingMessage.remove();
      addMessage("TaskFlow AI", error.message, true);
      toast(error.message);
      if (state.active) elements.actionHint.textContent = "Reply failed. Try speaking or typing again.";
    } finally {
      state.processing = false;
      if (state.active && !state.ending && state.recognition && !state.recognitionUnavailable) {
        state.shouldListen = true;
        startRecognition();
      } else if (state.active && !state.ending) {
        showCallState("Call active", "active");
        elements.textFallback.classList.remove("hidden");
      }
    }
  }

  function flushCustomerText() {
    window.clearTimeout(state.textTimer);
    const text = state.pendingText.trim();
    state.pendingText = "";
    if (!text) return;
    state.processingPromise = processCustomerText(text);
  }

  function pickRecordingType() {
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
    return candidates.find((type) => window.MediaRecorder?.isTypeSupported(type)) || "";
  }

  async function startCall() {
    if (!elements.consent.checked) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      toast("This browser cannot record audio. Try an up-to-date Chrome or Edge browser.");
      return;
    }
    elements.startCall.disabled = true;
    elements.actionHint.textContent = "Requesting microphone permission…";
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const mimeType = pickRecordingType();
      state.recorder = new MediaRecorder(state.stream, mimeType ? { mimeType } : {});
      state.recordingChunks = [];
      state.recorder.ondataavailable = (event) => {
        if (event.data?.size) state.recordingChunks.push(event.data);
      };
      state.recorder.start(1000);
    } catch (error) {
      releaseMicrophone();
      elements.startCall.disabled = false;
      if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
        elements.actionHint.textContent = "Microphone is blocked. Click the site icon by the address, allow Microphone, then reload.";
        toast("Microphone access is blocked. Allow it in your browser's site settings, then reload the page.");
      } else {
        elements.actionHint.textContent = "Could not start the microphone. Check that it is connected and try again.";
        toast(`Could not start recording: ${error.message}`);
      }
      return;
    }

    state.active = true;
    state.callId = crypto.randomUUID ? crypto.randomUUID() : `call-${Date.now()}`;
    state.startedAt = Date.now();
    state.transcript = [];
    state.lastStatus = "No Response";
    state.pendingText = "";
    state.recognitionUnavailable = false;
    state.recordingBlob = null;
    state.recognition = createRecognition();
    elements.startCall.classList.add("hidden");
    elements.endCall.classList.remove("hidden");
    elements.endCall.disabled = false;
    elements.consentRow.classList.add("hidden");
    elements.language.disabled = true;
    elements.actionHint.textContent = "Call recording is active. You can speak with the customer.";
    showCallState("Connecting", "active");
    state.timer = window.setInterval(updateDuration, 1000);
    updateDuration();

    const greeting = greetings[elements.language.value] || greetings["en-US"];
    state.transcript.push({ speaker: "TaskFlow AI", text: greeting });
    addMessage("TaskFlow AI", greeting);
    elements.actionHint.textContent = "Introducing TaskFlow…";
    showCallState("Speaking", "thinking");
    try {
      await speak(greeting);
    } catch (error) {
      toast(`The greeting is visible as text, but could not be spoken: ${error.message}`);
    }
    if (!state.active) return;

    if (state.recognition) {
      state.shouldListen = true;
      startRecognition();
      elements.textFallback.classList.remove("hidden");
    }
    if (!state.active) return;
    if (!state.recognition) {
      elements.textFallback.classList.remove("hidden");
      showCallState("Call active", "active");
      elements.actionHint.textContent = "Voice recognition is unavailable. Type customer responses below.";
      toast("This browser does not support speech recognition. Use the text response box to continue.");
    }
  }

  function releaseMicrophone() {
    if (state.stream) {
      state.stream.getTracks().forEach((track) => track.stop());
      state.stream = null;
    }
  }

  async function stopRecorder() {
    if (!state.recorder) return null;
    const recorder = state.recorder;
    if (recorder.state !== "recording") {
      state.recordingBlob = new Blob(state.recordingChunks, { type: recorder.mimeType || "audio/webm" });
      return state.recordingBlob;
    }
    return new Promise((resolve, reject) => {
      recorder.onstop = () => {
        state.recordingBlob = new Blob(state.recordingChunks, { type: recorder.mimeType || "audio/webm" });
        resolve(state.recordingBlob);
      };
      recorder.onerror = () => reject(new Error("The browser could not finish the call recording."));
      try {
        recorder.stop();
      } catch (error) {
        reject(error);
      }
    });
  }

  function toBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const encoded = String(reader.result).split(",", 2)[1];
        if (!encoded) reject(new Error("Could not encode the call recording."));
        else resolve(encoded);
      };
      reader.onerror = () => reject(new Error("Could not read the call recording."));
      reader.readAsDataURL(blob);
    });
  }

  function renderInviteForm() {
    return `
      <form class="invite-form" id="invite-form">
        <label for="invite-email">Invite customer to your TaskFlow workspace</label>
        <div class="invite-entry">
          <input id="invite-email" name="recipient" type="email" maxlength="254" placeholder="customer@example.com" autocomplete="email" required>
          <button class="button button-start" type="submit">Send invite</button>
        </div>
        <p>Configure your workspace invite URL and SMTP email settings in .env. Nothing is sent until you click this button.</p>
      </form>
    `;
  }

  function renderAnalysis(summary) {
    const statusClass = statusClasses[summary.status] || "";
    elements.analysisBody.innerHTML = `
      <div class="analysis-result">
        <div class="status-row"><span class="result-label">Sales outcome</span><span class="status-pill ${statusClass}">${escapeHtml(summary.status)}</span></div>
        <div class="analysis-field"><h3><i class="field-dot"></i>Conversation summary</h3><p>${escapeHtml(summary.summary)}</p></div>
        <div class="analysis-field"><h3><i class="field-dot"></i>Customer requirements</h3><p>${escapeHtml(summary.needs)}</p></div>
        <div class="analysis-field"><h3><i class="field-dot"></i>Objections</h3><p>${escapeHtml(summary.objections)}</p></div>
        <div class="analysis-field"><h3><i class="field-dot"></i>Recommended next step</h3><p>${escapeHtml(summary.nextStep)}</p></div>
        ${renderInviteForm()}
      </div>
    `;
  }

  function showAnalysisLoading(message) {
    elements.analysisBody.innerHTML = `<div class="analysis-loading"><span class="loading-spinner"></span><span>${escapeHtml(message)}</span></div>`;
  }

  async function createSummary() {
    if (!state.transcript.length) {
      const noResponse = {
        summary: "No conversation was captured.",
        needs: "No specific requirements identified.",
        objections: "No objections identified.",
        nextStep: "No response was received. Follow up only if appropriate.",
        status: "No Response",
      };
      renderAnalysis(noResponse);
      return noResponse;
    }
    showAnalysisLoading("Analyzing the conversation…");
    try {
      const summary = await apiRequest("/api/summarize", {
        method: "POST",
        body: JSON.stringify({ transcript: state.transcript }),
      });
      state.lastStatus = summary.status;
      renderAnalysis(summary);
      return summary;
    } catch (error) {
      elements.analysisBody.innerHTML = `<div class="analysis-placeholder"><strong>Summary unavailable</strong><p>${escapeHtml(error.message)}</p></div>${renderInviteForm()}`;
      toast(`The call ended, but AI analysis failed: ${error.message}`);
      return null;
    }
  }

  async function endCall() {
    if (!state.active || state.ending) return;
    state.ending = true;
    window.clearInterval(state.timer);
    window.clearTimeout(state.textTimer);
    await pauseRecognitionAndWait();
    if (state.pendingText.trim()) {
      const remaining = state.pendingText.trim();
      state.pendingText = "";
      state.processingPromise = processCustomerText(remaining);
      await state.processingPromise;
    } else if (state.processingPromise) {
      await state.processingPromise;
    }
    state.active = false;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    elements.endCall.disabled = true;
    showCallState("Analyzing", "thinking");
    elements.actionHint.textContent = "Preparing the summary and saving this call…";

    let recording;
    try {
      recording = await stopRecorder();
    } catch (error) {
      toast(error.message);
    } finally {
      releaseMicrophone();
    }
    const duration = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
    elements.callDuration.textContent = formatTime(duration);
    const summary = await createSummary();
    if (summary) state.lastStatus = summary.status;

    if (recording?.size) {
      if (recording.size > 15 * 1024 * 1024) {
        toast("This recording is larger than the 15 MB save limit. Its transcript and summary are displayed, but the call could not be archived.");
      } else {
        try {
          const payload = {
            id: state.callId,
            started_at: new Date(state.startedAt).toISOString(),
            duration_seconds: duration,
            recording_consent: true,
            transcript: state.transcript,
            summary: summary?.summary ?? null,
            needs: summary?.needs ?? null,
            objections: summary?.objections ?? null,
            next_step: summary?.nextStep ?? null,
            status: state.lastStatus,
            recording_base64: await toBase64(recording),
            recording_mime_type: recording.type || "audio/webm",
          };
          await apiRequest("/api/calls", { method: "POST", body: JSON.stringify(payload) });
          toast("Call, recording, transcript, and analysis saved.", "success");
          await loadHistory();
        } catch (error) {
          toast(`Call ended but could not be saved: ${error.message}`);
        }
      }
      if (state.recordingUrl) URL.revokeObjectURL(state.recordingUrl);
      state.recordingUrl = URL.createObjectURL(recording);
      renderLocalRecording(state.recordingUrl, recording.type);
    } else {
      toast("Call recording was not created, so this call could not be archived.");
    }

    state.recognition = null;
    state.recorder = null;
    state.ending = false;
    elements.startCall.classList.remove("hidden");
    elements.endCall.classList.add("hidden");
    elements.endCall.disabled = true;
    elements.consentRow.classList.remove("hidden");
    elements.language.disabled = false;
    elements.textFallback.classList.add("hidden");
    elements.consent.checked = false;
    elements.startCall.disabled = true;
    elements.actionHint.textContent = "Call ended. Give consent before starting another recording.";
    showCallState("Call ended", "ready");
  }

  function renderLocalRecording(url, mimeType) {
    const existing = $("#local-recording");
    if (existing) existing.remove();
    const player = document.createElement("div");
    player.id = "local-recording";
    player.className = "local-recording";
    player.innerHTML = `<span>Call recording</span><audio controls preload="metadata" src="${url}"></audio>`;
    elements.analysisBody.append(player);
    const audio = player.querySelector("audio");
    audio.type = mimeType || "audio/webm";
  }

  async function loadHistory() {
    try {
      const calls = await apiRequest("/api/calls");
      renderHistory(calls);
    } catch (error) {
      elements.historyList.innerHTML = `<div class="history-empty"><strong>Could not load call history</strong><span>${escapeHtml(error.message)}</span></div>`;
      toast(`Call history could not be loaded: ${error.message}`);
    }
  }

  function formatCallDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Unknown date";
    return new Intl.DateTimeFormat(undefined, {
      month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
    }).format(date);
  }

  function formatCallDuration(seconds) {
    const value = Number(seconds) || 0;
    const minutes = Math.floor(value / 60);
    const remainder = value % 60;
    return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
  }

  function renderHistory(calls) {
    elements.historyCount.textContent = String(calls.length);
    elements.recentCount.textContent = String(calls.length);
    elements.deleteAllCalls.disabled = calls.length === 0;
    if (!calls.length) {
      elements.historyList.innerHTML = `<div class="history-empty"><span class="history-empty-icon">◷</span><strong>No calls yet</strong><span>Your call recordings and summaries will appear here.</span></div>`;
      return;
    }
    elements.historyList.innerHTML = calls.map((call) => {
      const transcript = Array.isArray(call.transcript) ? call.transcript : [];
      const turns = transcript.map((turn) => `
        <div class="history-turn"><strong>${escapeHtml(turn.speaker)}</strong><p>${escapeHtml(turn.text)}</p></div>
      `).join("");
      const statusClass = statusClasses[call.status] || "";
      return `
        <details class="history-card">
          <summary>
            <span class="history-date"><span class="history-date-icon">◷</span><span><strong>${escapeHtml(formatCallDate(call.started_at))}</strong><span>Conversation details</span></span></span>
            <span class="history-status ${statusClass}">${escapeHtml(call.status)}</span>
            <span class="history-duration">${escapeHtml(formatCallDuration(call.duration_seconds))}</span>
            <span class="history-chevron" aria-hidden="true">⌄</span>
          </summary>
          <div class="history-detail">
            <button class="history-delete" type="button" data-call-id="${escapeHtml(call.id)}" aria-label="Delete this call" title="Delete this call">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2m3 0-.8 14H5.8L5 6m4 4v6m6-6v6"/></svg>
            </button>
            <div class="history-summary">
              <h3>CALL ANALYSIS</h3>
              <p><b>Summary:</b> ${escapeHtml(call.summary || "AI summary unavailable.")}</p>
              <p><b>Requirements:</b> ${escapeHtml(call.needs || "No specific requirements identified.")}</p>
              <p><b>Objections:</b> ${escapeHtml(call.objections || "No objections identified.")}</p>
              <p><b>Next step:</b> ${escapeHtml(call.next_step || "No next step recorded.")}</p>
              <audio class="history-audio" controls preload="none" src="/api/calls/${encodeURIComponent(call.id)}/recording"></audio>
            </div>
            <div class="history-transcript"><h3>TRANSCRIPT</h3>${turns || "<p>No transcript saved.</p>"}</div>
          </div>
        </details>
      `;
    }).join("");
  }

  async function checkHealth() {
    try {
      const health = await apiRequest("/api/health");
      if (!health.llm_ready) {
        toast("Gemini is not configured. Check the server environment, then restart.");
      }
    } catch (error) {
      toast(error.message);
    }
  }

  elements.today.textContent = new Intl.DateTimeFormat(undefined, {
    weekday: "short", month: "short", day: "numeric",
  }).format(new Date());
  elements.consent.addEventListener("change", updateStartButton);
  elements.startCall.addEventListener("click", startCall);
  elements.endCall.addEventListener("click", endCall);
  elements.analysisBody.addEventListener("submit", async (event) => {
    if (event.target.id !== "invite-form") return;
    event.preventDefault();
    const form = event.target;
    const button = form.querySelector('button[type="submit"]');
    const email = new FormData(form).get("recipient");
    if (typeof email !== "string" || !email.trim()) return;
    button.disabled = true;
    try {
      const result = await apiRequest("/api/invites", {
        method: "POST",
        body: JSON.stringify({ recipient: email.trim() }),
      });
      toast(result.message, "success");
      form.reset();
    } catch (error) {
      toast(`Could not send workspace invite: ${error.message}`);
    } finally {
      button.disabled = false;
    }
  });
  elements.refreshHistory.addEventListener("click", loadHistory);
  elements.deleteAllCalls.addEventListener("click", async () => {
    const count = Number(elements.historyCount.textContent);
    if (!count || !window.confirm(`Delete all ${count} saved calls? This cannot be undone.`)) return;
    elements.deleteAllCalls.disabled = true;
    try {
      await apiRequest("/api/calls", { method: "DELETE" });
      toast("All saved calls were deleted.", "success");
      await loadHistory();
    } catch (error) {
      toast(`Could not delete calls: ${error.message}`);
      elements.deleteAllCalls.disabled = false;
    }
  });
  elements.historyList.addEventListener("click", async (event) => {
    const button = event.target.closest(".history-delete");
    if (!button) return;
    const callId = button.dataset.callId;
    if (!callId || !window.confirm("Delete this saved call? This cannot be undone.")) return;
    button.disabled = true;
    try {
      await apiRequest(`/api/calls/${encodeURIComponent(callId)}`, { method: "DELETE" });
      toast("Call deleted.", "success");
      await loadHistory();
    } catch (error) {
      toast(`Could not delete this call: ${error.message}`);
      button.disabled = false;
    }
  });
  elements.retryVoice.addEventListener("click", () => {
    if (!state.active || !state.recognition) return;
    state.recognitionUnavailable = false;
    state.shouldListen = true;
    elements.voiceRetry.classList.add("hidden");
    elements.actionHint.textContent = "Retrying speech recognition…";
    startRecognition();
  });
  elements.language.addEventListener("change", () => {
    if (state.recognition) state.recognition.lang = elements.language.value;
  });
  $("#text-fallback").addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = elements.customerMessage.value.trim();
    if (!message || !state.active || state.processing) return;
    elements.customerMessage.value = "";
    state.processingPromise = processCustomerText(message);
  });

  updateStartButton();
  checkHealth();
  loadHistory();
})();
