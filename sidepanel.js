/**
 * SIDE PANEL LOGIC
 *
 * Handles the UI for YouTube Digest: video detection, transcript analysis,
 * rendering results, and export features.
 */

const DEBUG = false;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// ============================================================
// STATE
// ============================================================

let currentVideoId = null;
let currentVideoUrl = null;
let currentAnalysis = null;
let currentTranscript = null;
let currentTranscriptText = null; // Plain text (for display/export)
let currentTranscriptTimestamped = null; // With timestamps for AI analysis
let currentTranscriptLanguage = null;
let currentVideoTitle = "";
let currentChannelName = "";
let currentVideoDescription = "";
let currentVideoDuration = 0;
let isAnalysisLoading = false; // Track if analysis is in progress
let currentOverviewMode = "zh";
const OVERVIEW_MODE_STORAGE_KEY = "ytd_overview_mode";
let youtubeTabId = null; // Store the YouTube tab ID for reliable messaging
let errorAction = null;

// --- Translation state ---
// The public transcript control intentionally supports only the original
// subtitles, Chinese, and an aligned source + Chinese view.
let currentTranscriptMode = "original";
let translationGeneration = 0; // Invalidates responses from older UI modes/videos.
let translationWorkCount = 0;
let transcriptScrollObserver = null;
// Stable keys include the video, source mode, language, and semantic segment ID.
let transcriptParagraphCache = new Map();
const TRANSLATION_MESSAGE_TIMEOUT_MS = 130_000;
const VOCABULARY_STORAGE_KEY = "ytd_vocabulary";
const LEARNING_PROFILE_STORAGE_KEY = "ytd_learning_profile";
const REVIEW_DAILY_STORAGE_KEY = "ytd_review_daily";
const DAILY_NEW_LIMIT = 10;
const DAILY_REVIEW_LIMIT = 20;
let savedVocabulary = [];
let learningItems = [];
let learningGuide = {};
let learningProfile = { known: [], fuzzy: [] };
let reviewQueue = [];
let reviewQueueIndex = 0;
let reviewDailyState = { date: "", reviewed: 0, newReviewed: 0 };
let isLearningAnalysisLoading = false;

/**
 * Prevent a stopped service worker or dead message channel from leaving the
 * transcript queue stuck forever. The underlying Chrome message cannot be
 * cancelled, so settled guards deliberately ignore any late response.
 */
function sendTranslationMessage(message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      callback(value);
    };

    timeoutId = setTimeout(() => {
      finish(
        reject,
        new Error(
          "Translation request timed out after 130 seconds. Please Retry.",
        ),
      );
    }, TRANSLATION_MESSAGE_TIMEOUT_MS);

    let messagePromise;
    try {
      messagePromise = chrome.runtime.sendMessage(message);
    } catch (error) {
      finish(reject, error);
      return;
    }

    Promise.resolve(messagePromise).then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error),
    );
  });
}

// --- Auto-scroll state (follow video playback in transcript) ---
let autoScrollEnabled = true; // True = scroll transcript to follow video playback
let autoScrollInterval = null; // setInterval ID for polling video time
let lastAutoScrollTime = 0; // Timestamp of last programmatic scroll (ignores scroll events within 1s)

// ============================================================
// TRANSCRIPT GROUPING
// ============================================================

const TRANSCRIPT_SEGMENT_LIMITS = Object.freeze({
  minChars: 60,
  idealChars: 180,
  maxChars: 320,
  maxSeconds: 20,
});

function normalizeCaptionText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, "$1$2")
    .replace(/([，。；：！？])\s+(?=[\u3400-\u9fff])/g, "$1")
    .replace(/\s+([,.;:!?，。；：！？])/g, "$1")
    .trim();
}

/**
 * Splits a single oversized thought at the strongest nearby punctuation.
 * Word boundaries are the final safety valve for captions with no punctuation.
 */
function splitOversizedThought(text, maxChars) {
  const parts = [];
  let rest = normalizeCaptionText(text);

  while (rest.length > maxChars) {
    const windowText = rest.slice(0, maxChars + 1);
    const lowerBound = Math.floor(maxChars * 0.55);
    let cut = -1;

    for (const pattern of [/[;:；：]\s*/g, /[,，]\s*/g, /\s/g]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(windowText))) {
        if (match.index >= lowerBound) cut = match.index + match[0].length;
      }
      if (cut > 0) break;
    }

    if (cut <= 0) cut = maxChars;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) parts.push(rest);
  return parts;
}

/**
 * Reconstructs complete sentences across raw caption boundaries. Each segment
 * keeps the timestamp of the first caption that contributed text. Character
 * and time limits prevent a malformed Supadata entry from becoming one giant
 * row while punctuation remains the preferred boundary.
 */
function groupTranscriptEntries(entries, limits = TRANSCRIPT_SEGMENT_LIMITS) {
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const pieces = [];
  entries.forEach((entry, entryIndex) => {
    const text = normalizeCaptionText(entry?.text);
    if (!text) return;
    const start = Number.isFinite(Number(entry.start)) ? Number(entry.start) : 0;
    const duration = Math.max(0, Number(entry.duration) || 0);
    const sentenceParts =
      text.match(/[^.!?;:,。！？；：，]+(?:[.!?;:,。！？；：，]+["')\]”’）】」』]*|$)/g) ||
      [text];
    let consumedChars = 0;

    sentenceParts.forEach((sentencePart) => {
      const cleanPart = normalizeCaptionText(sentencePart);
      if (!cleanPart) return;
      const oversizedParts = splitOversizedThought(cleanPart, limits.maxChars);
      oversizedParts.forEach((part, partIndex) => {
        const ratio = text.length ? Math.min(1, consumedChars / text.length) : 0;
        pieces.push({
          text: part,
          start: start + duration * ratio,
          semanticEnd:
            /[.!?。！？]["')\]”’）】」』]*$/.test(part) ||
            oversizedParts.length > 1,
          clauseEnd: /[;:,；：，]["')\]”’）】」』]*$/.test(part),
          sourceOrder: `${entryIndex}:${partIndex}`,
        });
        consumedChars += part.length + 1;
      });
    });
  });

  const grouped = [];
  let current = null;

  const flush = () => {
    if (!current || !current.text.trim()) return;
    const index = grouped.length;
    const text = normalizeCaptionText(current.text);
    grouped.push({
      id: `segment-${index}-${Math.round(current.start * 1000)}`,
      start: current.start,
      text,
      texts: [text],
    });
    current = null;
  };

  pieces.forEach((piece) => {
    if (!current) current = { start: piece.start, text: "" };
    current.text = normalizeCaptionText(`${current.text} ${piece.text}`);
    const elapsed = Math.max(0, piece.start - current.start);
    const comfortablySized = current.text.length >= limits.minChars;
    const reachedIdeal = current.text.length >= limits.idealChars;
    const atNaturalBoundary =
      piece.semanticEnd ||
      (piece.clauseEnd &&
        (reachedIdeal ||
          current.text.length >= limits.maxChars ||
          elapsed >= limits.maxSeconds));
    const reachedGuardrail =
      atNaturalBoundary &&
      (current.text.length >= limits.maxChars || elapsed >= limits.maxSeconds);
    const reachedHardGuardrail =
      current.text.length >= Math.round(limits.maxChars * 1.2) ||
      elapsed >= limits.maxSeconds + 5;

    if (
      (atNaturalBoundary && (comfortablySized || elapsed >= 8)) ||
      (atNaturalBoundary && reachedIdeal) ||
      reachedGuardrail ||
      reachedHardGuardrail
    ) {
      flush();
    }
  });
  flush();

  return grouped;
}

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener("DOMContentLoaded", async () => {
  setupEventListeners();
  const overviewPreference = await chrome.storage.local.get(
    OVERVIEW_MODE_STORAGE_KEY,
  );
  currentOverviewMode = ["en", "zh", "bilingual"].includes(
    overviewPreference[OVERVIEW_MODE_STORAGE_KEY],
  )
    ? overviewPreference[OVERVIEW_MODE_STORAGE_KEY]
    : "zh";
  updateOverviewModeButtons();
  await loadVocabulary();
  await evictOldCacheEntries(20);

  const configStatus = await chrome.runtime.sendMessage({
    action: "checkConfig",
  });

  if (!configStatus.hasSupadataKey || !configStatus.hasAiKey) {
    showConfigError(configStatus);
    return;
  }

  await checkCurrentTab();
});

// Listen for messages from the Digest button on YouTube page
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "startDigestFromButton") {
    // Load the digest for the current video. Served from cache when we've
    // seen this video before (no API calls); fetched fresh otherwise.
    // (This used to force-clear the cache on every click, which silently
    // burned a transcript credit + analysis tokens per click.)
    checkCurrentTab();
    sendResponse({ success: true });
  }
  if (message.action === "transcriptProgress") {
    // Background is telling us the transcript fetch status changed
    updateLoading(message.title, message.subtitle);
    sendResponse({ success: true });
  }
  if (message.action === "noteSaved") {
    // Refresh notes list when a new note is saved
    const filterAll = document
      .getElementById("notesFilterAll")
      ?.classList.contains("active");
    loadNotes(filterAll ? null : currentVideoId);
    sendResponse({ success: true });
  }
  return false;
});

// ============================================================
// FOLLOW THE ACTIVE TAB
// ============================================================
// The panel watches which tab is in front of it and reacts:
//   - Front tab is NOT YouTube  -> the panel closes itself (window.close()).
//     We do this OURSELVES rather than relying only on the background
//     script's per-tab enable/disable, because Chrome doesn't reliably
//     apply per-tab panel state to tabs spawned in unusual ways (e.g. a
//     link opened from another app) — which let the panel linger on
//     non-YouTube pages.
//   - Front tab IS YouTube but on a different video -> refresh the digest.
//     YouTube is a single-page app (clicking a video swaps content without
//     a reload), so we track URL changes; startDigest() caches per video,
//     making re-checks instant and free for already-digested videos.
//
// Everything is scoped to the window this panel lives in: tab switches in
// OTHER browser windows must not close this panel or hijack its content.

let navigationRefreshTimer = null;
let panelWindowId = null;
chrome.windows.getCurrent().then((w) => {
  panelWindowId = w.id;
});

function scheduleDigestRefresh() {
  // Small delay lets YouTube finish rendering the new video's title and
  // description before we read them. Also collapses rapid-fire URL events
  // into a single refresh.
  clearTimeout(navigationRefreshTimer);
  navigationRefreshTimer = setTimeout(() => {
    checkCurrentTab();
  }, 600);
}

function panelIsShowingResults() {
  const results = document.getElementById("resultsState");
  return results && results.style.display !== "none";
}

/**
 * Reacts to the URL now in front of the panel: close on non-YouTube,
 * refresh the digest when the video changed.
 */
function handleFrontTabUrl(url) {
  if (!(url || "").startsWith("https://www.youtube.com")) {
    // Panel is a YouTube-only tool — remove itself from non-YouTube tabs.
    window.close();
    return;
  }

  const newVideoId = extractVideoId(url);
  // Refresh when the video changed, or when we're not currently showing
  // results (e.g. user went home, then clicked back into the same video).
  if (newVideoId !== currentVideoId || !panelIsShowingResults()) {
    scheduleDigestRefresh();
  }
}

// Fires when a tab's URL changes — including YouTube's no-reload navigation.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url || !tab.active) return;
  if (panelWindowId !== null && tab.windowId !== panelWindowId) return;
  handleFrontTabUrl(changeInfo.url);
});

// Fires when a different tab comes to the front — switching tabs, or a new
// tab being opened (including ones opened by clicking links in other apps).
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (panelWindowId !== null && windowId !== panelWindowId) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    // Brand-new tabs may not have committed their URL yet — fall back to
    // the pending one so we judge where the tab is actually going.
    handleFrontTabUrl(tab.url || tab.pendingUrl || "");
  } catch (e) {
    // Tab closed before we could read it — nothing to do.
  }
});

function setupEventListeners() {
  // Tab switching
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  // Error retry
  document.getElementById("errorBtn").addEventListener("click", () => {
    if (errorAction) {
      errorAction();
      return;
    }
    if (currentVideoId) {
      startDigest(currentVideoId, currentVideoUrl);
    }
  });

  document.getElementById("settingsBtn")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "openOptions" });
  });

  // Transcript actions
  document
    .getElementById("copyTranscriptBtn")
    ?.addEventListener("click", copyTranscript);
  document
    .getElementById("exportTranscriptBtn")
    ?.addEventListener("click", openExportDialog);
  document
    .getElementById("exportVocabularyBtn")
    ?.addEventListener("click", exportVocabularyCsv);
  document
    .getElementById("smartReadingBtn")
    ?.addEventListener("click", runSmartReading);
  document
    .getElementById("vocabularySearch")
    ?.addEventListener("input", (event) => renderVocabulary(event.target.value));
  document
    .getElementById("startReviewBtn")
    ?.addEventListener("click", startVocabularyReview);
  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    button.addEventListener("click", () => {
      handleTranscriptModeChange(button.dataset.transcriptMode);
    });
  });
  document.querySelectorAll(".overview-mode-btn").forEach((button) => {
    button.addEventListener("click", async () => {
      currentOverviewMode = button.dataset.overviewMode;
      updateOverviewModeButtons();
      await chrome.storage.local.set({
        [OVERVIEW_MODE_STORAGE_KEY]: currentOverviewMode,
      });
      if (currentAnalysis) renderAnalysisResults(currentAnalysis);
    });
  });

  // Follow playback button — re-enables auto-scroll after user scrolled away
  document
    .getElementById("followPlaybackBtn")
    ?.addEventListener("click", () => {
      autoScrollEnabled = true;
      document.getElementById("followPlaybackBtn").style.display = "none";
      // Jump straight back to the line currently being spoken. We scroll
      // directly (not via playbackTrackingTick) because the tick skips
      // entries that are already highlighted — and the current line almost
      // always IS highlighted, which made this button appear to do nothing.
      if (!scrollToActiveEntry()) {
        playbackTrackingTick(); // No highlight yet — let a tick establish one
      }
    });

  // Notes filter buttons
  document.getElementById("notesFilterThis")?.addEventListener("click", () => {
    setNotesFilter(false);
    loadNotes(currentVideoId);
  });
  document.getElementById("notesFilterAll")?.addEventListener("click", () => {
    setNotesFilter(true);
    loadNotes(null); // Load all notes
  });
}

function setNotesFilter(showAll) {
  const thisVideoButton = document.getElementById("notesFilterThis");
  const allNotesButton = document.getElementById("notesFilterAll");
  thisVideoButton?.classList.toggle("active", !showAll);
  thisVideoButton?.setAttribute("aria-pressed", String(!showAll));
  allNotesButton?.classList.toggle("active", showAll);
  allNotesButton?.setAttribute("aria-pressed", String(showAll));
}

// ============================================================
// VIDEO DETECTION
// ============================================================

async function checkCurrentTab() {
  try {
    // Try multiple strategies to find the YouTube tab
    let tab = null;

    // Strategy 1: Active tab in last focused window
    let tabs = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (tabs[0]?.url?.includes("youtube.com")) {
      tab = tabs[0];
    }

    // Strategy 2: Any active YouTube tab
    if (!tab) {
      tabs = await chrome.tabs.query({
        url: "https://www.youtube.com/*",
        active: true,
      });
      if (tabs[0]) tab = tabs[0];
    }

    // Strategy 3: Any YouTube tab (last resort)
    if (!tab) {
      tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
      if (tabs[0]) tab = tabs[0];
    }

    debugLog("[YouTube Digest Panel] Found tab:", tab?.id, tab?.url);

    if (!tab?.url) {
      showState("welcome");
      return;
    }

    // Store the tab ID for reliable messaging later
    youtubeTabId = tab.id;

    const videoId = extractVideoId(tab.url);

    if (videoId) {
      currentVideoUrl = tab.url;

      try {
        // Route through background script for reliable message passing
        const result = await chrome.runtime.sendMessage({
          action: "relayToContent",
          payload: { action: "getVideoInfo" },
        });
        debugLog("[YouTube Digest Panel] getVideoInfo result:", result);
        if (result.success && result.response) {
          currentVideoTitle = result.response.title || "";
          currentChannelName = result.response.channelName || "";
          currentVideoDescription = result.response.description || "";
          currentVideoDuration = result.response.duration || 0;
        }
      } catch (e) {
        console.error("[YouTube Digest Panel] getVideoInfo error:", e);
        currentVideoTitle = "";
        currentChannelName = "";
        currentVideoDescription = "";
        currentVideoDuration = 0;
      }

      startDigest(videoId, tab.url);
    } else {
      showState("welcome");
    }
  } catch (error) {
    console.error("Tab check error:", error);
    showState("welcome");
  }
}

function extractVideoId(url) {
  try {
    const urlObj = new URL(url);

    if (
      urlObj.hostname.includes("youtube.com") &&
      urlObj.searchParams.has("v")
    ) {
      return urlObj.searchParams.get("v");
    }

    if (urlObj.hostname === "youtu.be") {
      return urlObj.pathname.slice(1);
    }

    if (urlObj.pathname.startsWith("/embed/")) {
      return urlObj.pathname.split("/")[2];
    }

    return null;
  } catch {
    return null;
  }
}

// ============================================================
// DIGEST PIPELINE
// ============================================================

async function startDigest(videoId, videoUrl) {
  // Check if we already have this video loaded in memory
  if (videoId === currentVideoId && currentAnalysis) {
    showState("results");
    return;
  }

  // Every video change invalidates observer work and in-flight translations.
  if (videoId !== currentVideoId) {
    translationGeneration += 1;
    learningItems = [];
    learningGuide = {};
    isLearningAnalysisLoading = false;
    if (transcriptScrollObserver) transcriptScrollObserver.disconnect();
    transcriptScrollObserver = null;
  }

  // Check cache for this video
  const cached = await loadFromCache(videoId);
  if (cached) {
    debugLog("Loading from cache:", videoId);
    currentVideoId = videoId;
    currentVideoUrl = videoUrl;
    currentAnalysis = cached.analysis || null;
    currentTranscript = cached.transcript;
    currentTranscriptText = cached.transcriptText;
    currentTranscriptTimestamped = cached.transcriptTimestamped;
    currentTranscriptLanguage = cached.transcriptLanguage || null;
    isAnalysisLoading = false;

    // Restore semantic-segment translations from persistent storage.
    if (cached.paragraphCache) {
      for (const [key, value] of Object.entries(cached.paragraphCache)) {
        transcriptParagraphCache.set(key, value);
      }
    }

    if (currentVideoTitle || currentChannelName) {
      const videoInfo = document.getElementById("videoInfo");
      document.getElementById("videoTitle").textContent = currentVideoTitle;
      document.getElementById("videoChannel").textContent = currentChannelName;
      videoInfo.style.display = "block";
    }

    // Always render transcript first
    renderTranscript();

    // Render analysis if we have it cached
    if (currentAnalysis) {
      renderAnalysisResults(currentAnalysis);
      highlightMomentsOnPage(currentAnalysis.keyMoments);
    }

    showState("results");
    document.getElementById("tabsNav").style.display = "flex";

    // Load notes for this video
    loadNotes(videoId);

    // Setup explain feature
    setupExplainFeature();
    if (currentTranscriptMode !== "original") translateTranscript();
    void runSmartReading({ automatic: true });
    return;
  }

  currentVideoId = videoId;
  currentVideoUrl = videoUrl;
  currentAnalysis = null;
  currentTranscript = null;
  currentTranscriptText = null;
  currentTranscriptTimestamped = null;
  currentTranscriptLanguage = null;
  isAnalysisLoading = false;

  if (currentVideoTitle || currentChannelName) {
    const videoInfo = document.getElementById("videoInfo");
    document.getElementById("videoTitle").textContent = currentVideoTitle;
    document.getElementById("videoChannel").textContent = currentChannelName;
    videoInfo.style.display = "block";
  }

  showState("loading");
  updateLoading("Fetching transcript", "");

  const transcriptResult = await chrome.runtime.sendMessage({
    action: "fetchTranscript",
    videoId: videoId,
  });

  if (!transcriptResult.success) {
    if (transcriptResult.error === "NO_SUPADATA_KEY") {
      showError(
        "API key missing",
        "Add your Supadata API key in YouTube Digest Settings.",
      );
      return;
    }
    showError(
      "No transcript found",
      transcriptResult.message || transcriptResult.error,
    );
    return;
  }

  currentTranscript = transcriptResult.transcript;
  currentTranscriptText = transcriptResult.transcriptText;
  currentTranscriptTimestamped = transcriptResult.transcriptTextTimestamped;
  currentTranscriptLanguage = transcriptResult.language || null;

  // Render transcript immediately (no LLM needed)
  renderTranscript();
  showState("results");
  document.getElementById("tabsNav").style.display = "flex";

  // Load notes for this video
  loadNotes(videoId);

  // Setup explain feature for text selection
  setupExplainFeature();
  if (currentTranscriptMode !== "original") translateTranscript();
  void runSmartReading({ automatic: true });

  // Save transcript to cache (without analysis)
  await saveToCache(videoId);

  // DON'T run LLM analysis automatically - wait for user to click Overview tab
  // This saves tokens when user just wants to see the transcript
}

// ============================================================
// RENDERING
// ============================================================

/**
 * Renders the analysis results into the Overview tab.
 * Shows chapters and key quotes only.
 */
function renderAnalysisResults(analysis) {
  const mode = currentOverviewMode;
  const isChinese = mode === "zh";
  const isBilingual = mode === "bilingual";
  const pickText = (english, chinese) =>
    isChinese ? chinese || english || "" : english || chinese || "";
  const bilingualText = (english, chinese, className = "") => {
    if (!isBilingual) return escapeHtml(pickText(english, chinese));
    return `<span class="overview-bilingual-primary ${className}">${escapeHtml(english || chinese || "")}</span><span class="overview-bilingual-translation">${escapeHtml(chinese || english || "")}</span>`;
  };

  document.getElementById("overviewQuickTitle").textContent =
    mode === "en" ? "Quick Overview" : mode === "zh" ? "快速了解" : "Quick Overview · 快速了解";
  document.getElementById("overviewChaptersTitle").textContent =
    mode === "en" ? "Chapters" : mode === "zh" ? "章节" : "Chapters · 章节";
  document.getElementById("overviewQuotesTitle").textContent =
    mode === "en" ? "Key Quotes" : mode === "zh" ? "重点引用" : "Key Quotes · 重点引用";

  const quickCard = document.getElementById("overviewQuickCard");
  if (quickCard) {
    const fallbackSummary = analysis.chapters?.[0]?.summary || "";
    const fallbackSummaryZh = analysis.chapters?.[0]?.summaryZh || "";
    quickCard.innerHTML = bilingualText(
      analysis.quickSummary || fallbackSummary,
      analysis.quickSummaryZh || fallbackSummaryZh,
    );
  }

  // Chapters
  const chapterList = document.getElementById("chapterList");
  chapterList.innerHTML = "";
  (analysis.chapters || []).forEach((chapter) => {
    const li = document.createElement("li");
    li.className = "chapter-item";
    li.dataset.seconds = chapter.timestampSeconds;
    li.innerHTML = `
      <span class="chapter-timestamp">${escapeHtml(chapter.timestamp)}</span>
      <div class="chapter-content">
        <span class="chapter-title">${bilingualText(chapter.title, chapter.titleZh)}</span>
        <span class="chapter-summary">${bilingualText(chapter.summary, chapter.summaryZh)}</span>
      </div>
    `;
    li.addEventListener("click", () => {
      debugLog(
        "[YouTube Digest Panel] Chapter clicked:",
        chapter.timestamp,
        chapter.timestampSeconds,
      );
      seekTo(chapter.timestampSeconds);
    });
    chapterList.appendChild(li);
  });

  // Quotes - sort by timestamp (chronological order)
  const quotesList = document.getElementById("quotesList");
  quotesList.innerHTML = "";
  const sortedQuotes = [...(analysis.keyQuotes || [])].sort(
    (a, b) => (a.timestampSeconds || 0) - (b.timestampSeconds || 0),
  );
  sortedQuotes.forEach((quote) => {
    const div = document.createElement("div");
    div.className = "quote-item";
    div.dataset.seconds = quote.timestampSeconds;
    div.innerHTML = `
      <div class="quote-text">${bilingualText(quote.quote, quote.quoteZh)}</div>
      <div class="quote-meta">
        <span class="quote-timestamp">${escapeHtml(quote.timestamp)}</span>
        <div class="quote-actions">
          <button class="quote-save-note-btn" title="Save this quote as a note">📝 Note</button>
          <button class="quote-copy-btn" title="Copy this quote">⧉ Copy</button>
        </div>
      </div>
    `;
    div.addEventListener("click", () => {
      debugLog(
        "[YouTube Digest Panel] Quote clicked:",
        quote.timestamp,
        quote.timestampSeconds,
      );
      seekTo(quote.timestampSeconds);
    });

    const quoteCopyBtn = div.querySelector(".quote-copy-btn");
    quoteCopyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(quote.quote);
        quoteCopyBtn.textContent = "✓ Copied";
        setTimeout(() => {
          quoteCopyBtn.textContent = "⧉ Copy";
        }, 1500);
      } catch (err) {
        console.error("Copy failed:", err);
      }
    });

    const quoteSaveNoteBtn = div.querySelector(".quote-save-note-btn");
    quoteSaveNoteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await saveQuoteAsNote(quote, quoteSaveNoteBtn);
    });

    quotesList.appendChild(div);
  });
}

function hasBilingualOverview(analysis) {
  if (!analysis?.quickSummary || !analysis?.quickSummaryZh) return false;
  const chapters = Array.isArray(analysis.chapters) ? analysis.chapters : [];
  const quotes = Array.isArray(analysis.keyQuotes) ? analysis.keyQuotes : [];
  return (
    chapters.length > 0 &&
    chapters.every((chapter) => chapter.titleZh && chapter.summaryZh) &&
    quotes.every((quote) => quote.quoteZh)
  );
}

function updateOverviewModeButtons() {
  document.querySelectorAll(".overview-mode-btn").forEach((button) => {
    const active = button.dataset.overviewMode === currentOverviewMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

/**
 * Saves a key quote as a timestamped note.
 */
async function saveQuoteAsNote(quote, btn) {
  if (!currentVideoId) return;

  const originalText = btn.textContent;
  btn.textContent = "Saving...";
  btn.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({
      action: "saveNote",
      videoId: currentVideoId,
      timestamp: quote.timestampSeconds,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
    });

    if (result.success) {
      btn.textContent = "✓ Saved";
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1500);
      // Refresh notes list if on Notes tab
      loadNotes(currentVideoId);
    } else {
      console.error("[YouTube Digest] Save quote as note failed:", result.error);
      btn.textContent = "Error";
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1500);
    }
  } catch (error) {
    console.error("[YouTube Digest] Save quote as note error:", error);
    btn.textContent = "Error";
    setTimeout(() => {
      btn.textContent = originalText;
      btn.disabled = false;
    }, 1500);
  }
}

/**
 * Legacy function for backwards compatibility with cached data.
 * Renders both transcript and analysis.
 */
function renderResults(analysis) {
  renderAnalysisResults(analysis);

  renderTranscript();

  document.getElementById("tabsNav").style.display = "flex";

  // Setup explain feature for text selection
  setupExplainFeature();
}

/**
 * Returns true while the user has a range of text selected.
 * Transcript row clicks must not seek in that state: the click emitted after
 * selection mouseup belongs to the selection/explain interaction, not playback.
 */
function hasNonCollapsedTextSelection() {
  const selection = window.getSelection();
  return Boolean(
    selection && selection.rangeCount > 0 && !selection.isCollapsed,
  );
}

/**
 * Preserves normal row-click seeking while keeping text selection inert.
 */
function seekFromTranscriptEntryClick(event, seconds) {
  if (hasNonCollapsedTextSelection()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  seekTo(seconds);
}

function renderTranscript() {
  if (!currentTranscript) return;

  const transcriptList = document.getElementById("transcriptList");
  transcriptList.innerHTML = "";

  // Show a small badge indicating the transcript came from the video's
  // existing subtitles. (We no longer AI-transcribe audio, so subtitles
  // are the only source.)
  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();

  const badge = document.createElement("div");
  badge.id = "transcriptSourceBadge";
  badge.className = "transcript-source-badge";
  badge.innerHTML = `<span class="source-dot source-dot--subs"></span> From video subtitles · ${escapeHtml(getOriginalTranscriptLabel())}`;
  transcriptList.parentElement.insertBefore(badge, transcriptList);

  // Group entries using smart sentence-boundary + time-guardrail logic
  const grouped = groupTranscriptEntries(currentTranscript);

  grouped.forEach((group) => {
    const div = document.createElement("div");
    div.className = "transcript-entry";
    div.dataset.seconds = group.start;

    const minutes = Math.floor(group.start / 60);
    const seconds = Math.floor(group.start % 60);
    const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

    div.innerHTML = `
      <span class="transcript-time">${timestamp}</span>
      <span class="transcript-text">${renderSubtitleInlineMarkup(group.text)}</span>
    `;

    div.addEventListener("click", (event) =>
      seekFromTranscriptEntryClick(event, group.start),
    );
    transcriptList.appendChild(div);
  });

  applyVocabularyHighlights();
  applyLearningHighlights();

  // Start tracking video playback for auto-scroll
  startPlaybackTracking();
}

function copyTranscript() {
  copyToClipboardWithFeedback(currentTranscriptText || "", "copyTranscriptBtn");
}

function exportTranscript() {
  const transcriptContent = currentTranscriptText || "";
  const videoUrl = `https://youtube.com/watch?v=${currentVideoId}`;

  let exportText = "";
  exportText += `TRANSCRIPT\n`;
  exportText += `${"=".repeat(60)}\n\n`;
  exportText += `Title: ${currentVideoTitle || "Unknown"}\n`;
  exportText += `Channel: ${currentChannelName || "Unknown"}\n`;
  exportText += `URL: ${videoUrl}\n`;
  exportText += `\n${"—".repeat(60)}\n\n`;

  if (currentVideoDescription) {
    exportText += `DESCRIPTION:\n${currentVideoDescription}\n`;
    exportText += `\n${"—".repeat(60)}\n\n`;
  }

  exportText += `TRANSCRIPT:\n\n${transcriptContent}\n`;
  exportText += `\n${"—".repeat(60)}\n`;
  exportText += `Exported by YouTube Digest\n`;

  const filename = `${sanitizeFilename(currentVideoTitle)}-transcript.txt`;
  downloadTextFile(exportText, filename);
}

function getExportRows() {
  return getActiveTranscriptSegments().map((segment) => ({
    timestamp: `${Math.floor(segment.start / 60)}:${String(Math.floor(segment.start % 60)).padStart(2, "0")}`,
    original: normalizeCaptionText(segment.text),
    translated:
      transcriptParagraphCache.get(transcriptTranslationCacheKey(segment)) || "",
  }));
}

function openExportDialog() {
  document.getElementById("exportDialog")?.remove();
  const modal = document.createElement("div");
  modal.id = "exportDialog";
  modal.className = "explain-modal-overlay";
  modal.innerHTML = `
    <div class="explain-modal export-dialog">
      <div class="explain-modal-header"><div class="explain-modal-title">Export transcript</div><button class="explain-modal-close" data-close>✕</button></div>
      <div class="export-options">
        <label>Language<select id="exportLanguage"><option value="original">English / original</option><option value="zh">中文</option><option value="bilingual">双语（上英下中）</option></select></label>
        <label>Format<select id="exportFormat"><option value="study_pdf">英语精读 PDF（推荐）</option><option value="study">英语精读 HTML</option><option value="html">普通逐字稿 HTML</option><option value="md">Markdown</option><option value="txt">Plain text</option></select></label>
        <label class="export-checkbox"><input id="exportTimestamps" type="checkbox" checked /> Include timestamps</label>
        <label class="export-checkbox"><input id="exportWords" type="checkbox" checked /> Append this video's vocabulary</label>
        <p class="export-hint">For Chinese or bilingual export, first open that transcript mode and let all visible segments finish translating.</p>
        <button class="enhance-btn export-confirm" id="exportConfirmBtn">Export</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector("[data-close]").addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (event) => { if (event.target === modal) modal.remove(); });
  modal.querySelector("#exportConfirmBtn").addEventListener("click", () => {
    exportTranscriptAdvanced({
      language: modal.querySelector("#exportLanguage").value,
      format: modal.querySelector("#exportFormat").value,
      timestamps: modal.querySelector("#exportTimestamps").checked,
      appendWords: modal.querySelector("#exportWords").checked,
    });
    modal.remove();
  });
}

function exportTranscriptAdvanced(options) {
  const rows = getExportRows();
  const needsTranslation = options.language !== "original";
  if (needsTranslation && rows.some((row) => !row.translated)) {
    alert("Some Chinese translations are not ready. Open 中文 or 双语, scroll through the transcript until translation finishes, then export again.");
    return;
  }
  const words = options.appendWords
    ? savedVocabulary.filter((item) => item.sources?.some((source) => source.videoId === currentVideoId))
    : [];
  const title = currentVideoTitle || "Untitled video";
  const meta = { title, channel: currentChannelName || "Unknown", url: `https://youtube.com/watch?v=${currentVideoId}` };
  const lineText = (row) => {
    const stamp = options.timestamps ? `[${row.timestamp}] ` : "";
    if (options.language === "zh") return `${stamp}${row.translated}`;
    if (options.language === "bilingual") return `${stamp}${row.original}\n${row.translated}`;
    return `${stamp}${row.original}`;
  };
  const suffix = options.language === "bilingual" ? "-bilingual" : options.language === "zh" ? "-zh" : "-original";
  if (options.format === "study" || options.format === "study_pdf") {
    exportIntensiveReading(rows, meta, words, options.format === "study_pdf");
    return;
  }
  if (options.format === "html") {
    const body = rows.map((row) => `<section class="line"><div class="time">${options.timestamps ? escapeHtml(row.timestamp) : ""}</div><div>${options.language !== "zh" ? `<p class="original">${escapeHtml(row.original)}</p>` : ""}${options.language !== "original" ? `<p class="translation">${escapeHtml(row.translated)}</p>` : ""}</div></section>`).join("");
    const wordList = words.length ? `<section class="word-list"><h2>Vocabulary</h2>${words.map((word) => `<p><strong>${escapeHtml(word.term)}</strong>${word.note ? ` — ${escapeHtml(word.note)}` : ""}</p>`).join("")}</section>` : "";
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>@page{margin:18mm}body{font:11pt/1.6 Georgia,serif;color:#24211d;max-width:800px;margin:auto}h1{font:700 24pt Arial,sans-serif}.meta{color:#666;border-bottom:1px solid #ccc;padding-bottom:12px}.line{display:grid;grid-template-columns:52px 1fr;gap:12px;padding:10px 0;border-bottom:1px solid #eee;break-inside:avoid}.time{color:#c8674f;font:9pt Arial}.original,.translation{margin:0}.translation{margin-top:5px;color:#4e4942}.word-list{page-break-before:always}a{color:#555}@media print{body{max-width:none}}</style></head><body><h1>${escapeHtml(title)}</h1><p class="meta">${escapeHtml(meta.channel)} · <a href="${escapeHtml(meta.url)}">${escapeHtml(meta.url)}</a></p>${body}${wordList}</body></html>`;
    downloadFile(html, `${sanitizeFilename(title)}${suffix}.html`, "text/html");
    return;
  }
  const heading = options.format === "md" ? `# ${title}\n\n${meta.channel} · ${meta.url}\n\n` : `${title}\n${meta.channel}\n${meta.url}\n\n`;
  let output = heading + rows.map(lineText).join("\n\n");
  if (words.length) output += `\n\n${options.format === "md" ? "## Vocabulary" : "VOCABULARY"}\n\n${words.map((word) => `- ${word.term}${word.note ? ` — ${word.note}` : ""}`).join("\n")}`;
  downloadFile(output, `${sanitizeFilename(title)}${suffix}.${options.format}`, "text/plain");
}

function exportIntensiveReading(rows, meta, words, printAsPdf = false) {
  const curatedItems = [
    ...learningItems.filter((item) => item.type === "word").slice(0, 12),
    ...learningItems.filter((item) => item.type === "phrase").slice(0, 15),
    ...learningItems.filter((item) => item.type === "sentence").slice(0, 5),
  ];
  const highlight = (text) => {
    let html = escapeHtml(text);
    [...curatedItems].sort((a, b) => b.term.length - a.term.length).forEach((item) => {
      const escaped = escapeHtml(item.term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      html = html.replace(new RegExp(`(^|[^\\p{L}\\p{N}])(${escaped})(?=$|[^\\p{L}\\p{N}])`, "giu"), `$1<mark class="${item.type}">$2</mark>`);
    });
    return html;
  };
  const mergedRows = [];
  rows.forEach((row) => {
    const previous = mergedRows.at(-1);
    const combinedLength = (previous?.original.length || 0) + row.original.length;
    if (previous && combinedLength < 620) {
      previous.original = `${previous.original} ${row.original}`;
      previous.translated = `${previous.translated} ${row.translated}`.trim();
    } else {
      mergedRows.push({ ...row });
    }
  });
  const lines = mergedRows.map((row, index) => `<section class="line"><div class="time">${String(index + 1).padStart(2, "0")} · ${escapeHtml(row.timestamp)}</div><div><p class="en">${highlight(row.original)}</p>${row.translated ? `<p class="zh">${escapeHtml(row.translated)}</p>` : ""}</div></section>`).join("");
  const byType = (type) => curatedItems.filter((item) => item.type === type);
  const cards = (items, vocabulary = false) => items.length ? `<div class="cards">${items.map((item, index) => `<article class="card"><div class="card-index">${String(index + 1).padStart(2, "0")}</div><div><h3>${escapeHtml(item.term)} ${item.partOfSpeech ? `<span class="pos">${escapeHtml(item.partOfSpeech)}</span>` : ""} <small>${escapeHtml(item.level)}</small></h3>${vocabulary && (item.ipaUk || item.ipaUs) ? `<p class="ipa">UK ${escapeHtml(item.ipaUk || "-")} &nbsp; US ${escapeHtml(item.ipaUs || "-")}</p>` : ""}<p class="meaning">${escapeHtml(item.meaningZh)}</p>${item.sourceContext ? `<p class="context"><b>原文</b> ${escapeHtml(item.sourceContext)}</p>` : ""}<p class="why">${escapeHtml(item.reasonZh)}</p>${item.example ? `<p class="example"><b>Example</b> ${escapeHtml(item.example)}</p>` : ""}</div></article>`).join("")}</div>` : `<p class="muted">本视频暂未生成这一类内容。</p>`;
  const savedTerms = new Set(words.map((word) => normalizeVocabularyTerm(word.term)));
  const savedBadges = savedTerms.size ? `<p class="saved-note">★ 表示已加入个人生词本</p>` : "";
  const topic = learningGuide.topicZh || "从真实对话中学习自然英语表达与思考方式";
  const coreQuestion = learningGuide.coreQuestion || "What is the most useful idea in this conversation, and why?";
  const ideas = (learningGuide.ideas || []).map((idea, index) => `<div class="idea"><b>0${index + 1}</b><span>${escapeHtml(idea)}</span></div>`).join("");
  const critical = (learningGuide.criticalQuestions || []).map((question) => `<li>${escapeHtml(question)}</li>`).join("");
  const retelling = learningGuide.retelling || "This episode is mainly about… The speaker argues that… One example that stood out to me was…";
  const personalResponse = learningGuide.personalResponse || "From my perspective… This connects with my experience because… One action I want to take is…";
  const quoteSection = byType("sentence").length ? `<section class="section"><div class="kicker">MEMORABLE LINES</div><h2>QUOTES WORTH KEEPING</h2>${cards(byType("sentence"))}</section>` : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(meta.title)} · 英语精读</title><style>
  :root{--navy:#173a5e;--blue:#2774aa;--pale:#edf5f9;--ink:#26333f;--muted:#687887;--orange:#c57918;--rule:#cedde7}
  *{box-sizing:border-box}@page{size:A4;margin:16mm 17mm 18mm}html{background:#eef1f3}body{font:10.3pt/1.58 Arial,"PingFang SC",sans-serif;color:var(--ink);max-width:210mm;margin:20px auto;background:#fff;padding:16mm 17mm;box-shadow:0 4px 20px #0002}.cover{min-height:250mm;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}.kicker{font-size:9pt;letter-spacing:.08em;color:var(--blue);margin-bottom:8px}.cover h1{font-size:26pt;line-height:1.24;color:var(--navy);max-width:160mm;margin:8px 0}.cover .topic{font-size:14pt;color:var(--navy);margin:8px 0 26px}.chapter-band{width:135mm;padding:12px;background:var(--pale);border:1px solid var(--rule);color:var(--muted)}.cover .features{margin-top:42px;color:var(--muted)}.meta{margin-top:70px;font-size:8.5pt;color:var(--muted)}.section{break-before:page}.section.compact{break-before:auto;margin-top:34px}h2{font-size:20pt;color:var(--navy);font-weight:500;margin:0 0 16px;padding-bottom:11px;border-bottom:1px solid var(--rule)}h3{color:var(--navy)}.guide-list{line-height:2}.core-question{margin:24px auto;padding:13px 18px;background:var(--pale);border:1px solid var(--rule);text-align:center;color:var(--navy)}.line{padding:15px 0;border-bottom:1px solid var(--rule);break-inside:avoid}.time{font-size:8.2pt;color:var(--blue);margin-bottom:5px}.line p{margin:0}.line .en{font-size:10.7pt;line-height:1.55}.line .zh{margin-top:7px;color:#435564}mark{background:transparent;color:var(--orange);padding:0}.phrase{color:var(--navy);border-bottom:1.5px solid var(--blue)}.sentence{color:var(--orange);font-weight:600}.cards{display:grid;grid-template-columns:1fr 1fr;column-gap:24px}.card{display:grid;grid-template-columns:25px 1fr;gap:8px;padding:11px 0;border-bottom:1px solid var(--rule);break-inside:avoid}.card-index{font-size:8pt;color:var(--blue);padding-top:4px}.card h3{font-size:12pt;margin:0 0 3px}.card p{margin:3px 0}.pos,small{font-size:8pt;color:var(--orange)}.ipa{font-size:8.6pt;color:var(--muted)}.meaning{font-weight:600}.context,.example{font-size:9pt}.context b,.example b{color:var(--blue)}.why{font-size:8.8pt;color:var(--muted)}.saved-note{color:var(--orange);font-size:8.5pt}.idea{display:grid;grid-template-columns:30px 1fr;gap:12px;padding:13px 0;border-bottom:1px solid var(--rule)}.idea b{color:var(--blue)}.questions,.practice{margin-top:22px;padding:16px 18px;background:var(--pale);border:1px solid var(--rule)}.practice p{line-height:1.75}.writing-lines{height:65px;background:repeating-linear-gradient(to bottom,transparent 0,transparent 25px,var(--rule) 26px)}a{color:inherit;text-decoration:none}@media print{html{background:#fff}body{margin:0;max-width:none;padding:0;box-shadow:none}.cover{min-height:250mm}}
  </style></head><body><section class="cover"><div class="kicker">PODCAST DEEP READING · PERSONAL EDITION</div><h1>${escapeHtml(meta.title)}</h1><p class="topic">${escapeHtml(topic)}</p><div class="chapter-band">Bilingual transcript · Personalized vocabulary · Natural expressions · Speaking practice</div><p class="features">英中对照精读 · 个性化选词 · 金句收藏 · 口语复述训练</p><p class="meta">${escapeHtml(meta.channel)} · ${escapeHtml(meta.url)}</p></section><section class="section"><div class="kicker">LEARNING GUIDE</div><h2>HOW TO USE THIS CHAPTER</h2><ol class="guide-list"><li>第一遍听：不查词，先理解主线。</li><li>第二遍精读：先读英文，再对照中文和橙色重点。</li><li>第三遍跟读：模仿重音、停顿和语气。</li><li>最后复述：使用文末参考稿，转化为自己的表达。</li></ol><div class="core-question">${escapeHtml(coreQuestion)}</div></section><section class="section"><div class="kicker">BILINGUAL TRANSCRIPT</div><h2>中英对照精读</h2>${lines}</section><section class="section"><div class="kicker">LANGUAGE NOTES</div><h2>KEY VOCABULARY</h2>${savedBadges}${cards(byType("word"), true)}</section><section class="section"><div class="kicker">NATURAL ENGLISH</div><h2>USEFUL PHRASES</h2>${cards(byType("phrase"))}</section>${quoteSection}<section class="section"><div class="kicker">IDEAS & CRITICAL READING</div><h2>IDEAS TO TAKE AWAY</h2>${ideas || `<p>请写下本期最值得保留的三个观点。</p>`}<div class="questions"><h3>Critical Questions</h3><ol>${critical || `<li>这个观点适用于所有情境吗？</li><li>有哪些可能的反例？</li>`}</ol></div></section><section class="section"><div class="kicker">SPEAKING PRACTICE</div><h2>RETELL & RESPOND</h2><div class="practice"><h3>30-second retelling · 参考稿</h3><p>${escapeHtml(retelling)}</p></div><div class="practice"><h3>60-second personal response · 表达框架</h3><p>${escapeHtml(personalResponse)}</p><div class="writing-lines"></div></div></section></body></html>`;
  if (printAsPdf) {
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      alert("Chrome 阻止了打印窗口。请允许弹出式窗口后重试。");
      return;
    }
    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.addEventListener("load", () => setTimeout(() => printWindow.print(), 250), { once: true });
    return;
  }
  downloadFile(html, `${sanitizeFilename(meta.title)}-intensive-reading.html`, "text/html");
}

// ============================================================
// UI STATE MANAGEMENT
// ============================================================

function showState(state) {
  document.getElementById("welcomeState").style.display =
    state === "welcome" ? "flex" : "none";
  document.getElementById("loadingState").style.display =
    state === "loading" ? "block" : "none";
  document.getElementById("errorState").style.display =
    state === "error" ? "block" : "none";
  const uploadEl = document.getElementById("uploadState");
  if (uploadEl) uploadEl.style.display = "none"; // Upload state removed — always hidden
  document.getElementById("resultsState").style.display =
    state === "results" ? "block" : "none";

  // The tab bar only belongs on the results view. We toggle it HERE, in one
  // place, so it tracks the view automatically. Previously each caller had to
  // remember to re-show it after showState("results"), and one path forgot —
  // which is why the tabs could vanish when re-opening an already-analyzed video.
  document.getElementById("tabsNav").style.display =
    state === "results" ? "flex" : "none";

  if (state !== "results") {
    stopPlaybackTracking();
  }
}

function updateLoading(title, subtitle) {
  document.getElementById("loadingText").textContent = title;
  document.getElementById("loadingSubtext").textContent = subtitle;
}

function showError(title, message) {
  errorAction = null;
  showState("error");
  document.getElementById("errorTitle").textContent = title;
  document.getElementById("errorMessage").textContent = message;
  document.getElementById("errorBtn").textContent = "Try Again";
}

function showConfigError(configStatus) {
  const missingKeys = [];
  if (!configStatus.hasSupadataKey) missingKeys.push("Supadata");
  if (!configStatus.hasAiKey) missingKeys.push("AI provider");

  showState("error");
  document.getElementById("errorTitle").textContent = "API Keys Missing";
  document.getElementById("errorMessage").textContent =
    `Add your ${missingKeys.join(" and ")} API key${missingKeys.length === 1 ? "" : "s"} in YouTube Digest Settings.`;
  document.getElementById("errorBtn").textContent = "Open Settings";
  errorAction = () => chrome.runtime.sendMessage({ action: "openOptions" });
}

// ============================================================
// TAB SWITCHING
// ============================================================

function switchTab(tabName) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });

  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === tabName);
  });

  // Start/stop playback tracking based on which tab is active
  if (tabName === "transcript") {
    startPlaybackTracking();
  } else {
    stopPlaybackTracking();
  }

  // Lazy-load LLM analysis when user switches to Overview tab
  if (
    tabName === "overview" &&
    !hasBilingualOverview(currentAnalysis) &&
    !isAnalysisLoading
  ) {
    triggerAnalysis();
  }
  if (tabName === "vocabulary") loadVocabulary();
}

/**
 * Triggers the LLM analysis (lazy-loaded when user clicks Overview or Quotes tab).
 * This saves tokens by not running analysis until needed.
 */
async function triggerAnalysis() {
  if (
    !currentTranscriptTimestamped ||
    isAnalysisLoading ||
    hasBilingualOverview(currentAnalysis)
  )
    return;

  isAnalysisLoading = true;

  // Show loading indicators in the Overview tab
  const chapterList = document.getElementById("chapterList");
  const quotesList = document.getElementById("quotesList");

  if (chapterList)
    chapterList.innerHTML =
      '<li class="chapter-item" style="color: var(--text-muted); border: none;">Loading chapters...</li>';
  if (quotesList)
    quotesList.innerHTML =
      '<div class="quote-item" style="color: var(--text-muted); border-left-color: var(--border);">Loading quotes...</div>';

  try {
    const analysisResult = await chrome.runtime.sendMessage({
      action: "analyzeTranscript",
      transcriptText: currentTranscriptTimestamped,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      videoDescription: currentVideoDescription,
      videoDuration: currentVideoDuration,
    });

    if (!analysisResult.success) {
      if (chapterList)
        chapterList.innerHTML = `<li class="chapter-item" style="color: var(--accent); border: none;">Analysis failed: ${escapeHtml(analysisResult.error || "Unknown error")}</li>`;
      isAnalysisLoading = false;
      return;
    }

    currentAnalysis = analysisResult.analysis;
    renderAnalysisResults(currentAnalysis);
    highlightMomentsOnPage(currentAnalysis.keyMoments);

    // Save to cache now that we have analysis
    await saveToCache(currentVideoId);
  } catch (error) {
    console.error("[YouTube Digest Panel] Analysis error:", error);
    if (chapterList)
      chapterList.innerHTML = `<li class="chapter-item" style="color: var(--accent); border: none;">Error: ${escapeHtml(error.message)}</li>`;
  }

  isAnalysisLoading = false;
}

// ============================================================
// TIMESTAMP / SEEK
// ============================================================

async function seekTo(seconds) {
  debugLog("[YouTube Digest Panel] seekTo called with:", seconds);
  if (seconds === undefined || seconds === null) {
    debugLog("[YouTube Digest Panel] seekTo aborted - no seconds value");
    return;
  }

  const payload = {
    action: "seekTo",
    seconds: Number(seconds),
  };

  try {
    // Try direct messaging to the stored YouTube tab first (fastest/reliable)
    if (youtubeTabId) {
      try {
        await chrome.tabs.sendMessage(youtubeTabId, payload);
        debugLog("[YouTube Digest Panel] seekTo direct success");
        return;
      } catch (directErr) {
        debugLog(
          "[YouTube Digest Panel] Direct seekTo failed, falling back to relay:",
          directErr.message,
        );
      }
    }

    // Fallback: route through background script
    const result = await chrome.runtime.sendMessage({
      action: "relayToContent",
      payload,
    });
    debugLog("[YouTube Digest Panel] seekTo relay result:", result);
  } catch (error) {
    console.error("[YouTube Digest Panel] seekTo error:", error);
  }
}

/**
 * Plays a saved note at its timestamp.
 * - If the note belongs to the video currently open, we seek the player in place.
 * - If it belongs to a DIFFERENT video (e.g. viewing "All Notes"), seeking the
 *   current player would jump to the wrong content, so we open that video in a
 *   new tab at the right timestamp instead.
 */
function playNote(note) {
  if (note.videoId && note.videoId === currentVideoId) {
    seekTo(note.timestampSeconds);
  } else {
    // note.timestampedUrl already includes the &t=<seconds>s anchor
    chrome.tabs.create({ url: note.timestampedUrl });
  }
}

async function highlightMomentsOnPage(moments) {
  if (!moments || !moments.length) return;

  try {
    // Route through background script for reliable message passing
    await chrome.runtime.sendMessage({
      action: "relayToContent",
      payload: {
        action: "highlightMoments",
        moments: moments,
        videoDuration: currentVideoDuration,
      },
    });
  } catch (error) {
    console.error("Highlight error:", error);
  }
}

// ============================================================
// UTILITY
// ============================================================

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

/**
 * Renders the small subset of inline formatting commonly present in subtitle
 * tracks and model translations. Everything is escaped first; only exact,
 * attribute-free allowlisted tags are restored as markup afterwards.
 */
function renderSubtitleInlineMarkup(text) {
  return escapeHtml(text).replace(
    /&lt;(\/?)(i|em|b|strong|u)&gt;|&lt;br(?:\s*\/)?&gt;/gi,
    (_match, closing, tagName) =>
      tagName ? `<${closing}${tagName.toLowerCase()}>` : "<br>",
  );
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.error("Copy failed:", error);
    return false;
  }
}

async function copyToClipboardWithFeedback(text, buttonId) {
  const btn = document.getElementById(buttonId);
  const original = btn.textContent;

  const success = await copyToClipboard(text);
  if (success) {
    btn.textContent = "✓ Copied";
    setTimeout(() => {
      btn.textContent = original;
    }, 2000);
  }
}

function downloadTextFile(text, filename) {
  downloadFile(text, filename, "text/plain");
}

function downloadFile(text, filename, mimeType) {
  const blob = new Blob([text], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function sanitizeFilename(str) {
  return (str || "untitled")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .substring(0, 50)
    .toLowerCase();
}

// ============================================================
// TEXT SELECTION — EXPLAIN FEATURE
// ============================================================

/**
 * Sets up text selection handling in the transcript.
 * When user selects text, shows an "Explain" button.
 */
function setupExplainFeature() {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return;

  // Remove existing tooltip if any
  const existingTooltip = document.getElementById("explainTooltip");
  if (existingTooltip) existingTooltip.remove();

  // Create the explain tooltip/button
  const tooltip = document.createElement("div");
  tooltip.id = "explainTooltip";
  tooltip.className = "explain-tooltip";
  tooltip.innerHTML = `<button class="explain-btn">💡 Explain</button><button class="explain-btn save-word-btn">＋ Save word</button>`;
  tooltip.style.display = "none";
  document.body.appendChild(tooltip);

  let selectedText = "";

  // Interacting with Explain must preserve the transcript selection and stay
  // isolated from document/row click behavior.
  tooltip.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  tooltip.addEventListener("mouseup", (event) => {
    event.stopPropagation();
  });
  tooltip.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  // Listen for text selection
  document.addEventListener("mouseup", (e) => {
    const selection = window.getSelection();
    const text = selection.toString().trim();

    // Only show if selecting within transcript
    const isInTranscript = transcriptList.contains(selection.anchorNode);

    // Allow any selection length (removed 10+ char requirement)
    if (text.length > 0 && isInTranscript) {
      selectedText = text;

      // Position the tooltip near the selection
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      tooltip.style.display = "block";
      tooltip.style.top = `${rect.bottom + window.scrollY + 8}px`;
      tooltip.style.left = `${rect.left + rect.width / 2}px`;
    } else {
      tooltip.style.display = "none";
    }
  });

  // Hide tooltip when clicking elsewhere
  document.addEventListener("mousedown", (e) => {
    if (!tooltip.contains(e.target)) {
      tooltip.style.display = "none";
    }
  });

  // Handle explain button click
  tooltip
    .querySelector(".explain-btn")
    .addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!selectedText) return;

      tooltip.style.display = "none";
      await showExplanation(selectedText);
    });
  tooltip.querySelector(".save-word-btn").addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!selectedText) return;
    tooltip.style.display = "none";
    await saveVocabularyTerm(selectedText, getTranscriptContext(selectedText));
  });
}

/**
 * Shows the explanation modal and fetches it from the configured AI provider.
 */
async function showExplanation(selectedText) {
  // Create modal
  const modal = document.createElement("div");
  modal.id = "explainModal";
  modal.className = "explain-modal-overlay";
  modal.innerHTML = `
    <div class="explain-modal">
      <div class="explain-modal-header">
        <div class="explain-modal-title">Explain</div>
        <button class="explain-modal-close" id="closeExplain">✕</button>
      </div>
      <div class="explain-selected-text">"${escapeHtml(selectedText.substring(0, 200))}${selectedText.length > 200 ? "..." : ""}"</div>
      <div class="explain-modal-content" id="explanationContent">
        <div class="explain-loading">
          <div class="loading-bar"></div>
          <span>Analyzing...</span>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Close handlers
  document
    .getElementById("closeExplain")
    .addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });

  // Get some context around the selection from the transcript
  const transcriptContext = getTranscriptContext(selectedText);

  // Fetch explanation
  try {
    const result = await chrome.runtime.sendMessage({
      action: "explainSelection",
      selectedText: selectedText,
      transcriptContext: transcriptContext,
      videoTitle: currentVideoTitle,
    });

    const contentDiv = document.getElementById("explanationContent");
    if (result.success) {
      contentDiv.innerHTML = `<div class="explain-text">${escapeHtml(result.explanation).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>")}</div>`;
    } else {
      contentDiv.innerHTML = `<div class="explain-error">Failed to get explanation: ${escapeHtml(result.error)}</div>`;
    }
  } catch (error) {
    const contentDiv = document.getElementById("explanationContent");
    contentDiv.innerHTML = `<div class="explain-error">Error: ${escapeHtml(error.message)}</div>`;
  }
}

/**
 * Gets surrounding context from the transcript for the selected text.
 */
function getTranscriptContext(selectedText) {
  const fullText = currentTranscriptText || "";
  const index = fullText.indexOf(selectedText);

  if (index === -1) return "";

  // Get 200 chars before and after
  const start = Math.max(0, index - 200);
  const end = Math.min(fullText.length, index + selectedText.length + 200);

  return fullText.substring(start, end);
}

// ============================================================
// VOCABULARY — local word/phrase collection and cross-video highlighting
// ============================================================

function normalizeVocabularyTerm(term) {
  return String(term || "").trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'-]+$/gu, "").replace(/\s+/g, " ").toLowerCase();
}

function getVocabularyType(term) {
  return /^[A-Za-z]+(?:['’-][A-Za-z]+)*$/.test(String(term || "").trim()) ? "word" : "phrase";
}

function getLearningMetadata(term) {
  const normalized = normalizeVocabularyTerm(term);
  const match = learningItems.find((item) => normalizeVocabularyTerm(item.term) === normalized);
  if (!match) return { type: getVocabularyType(term) };
  return {
    type: match.type === "word" ? "word" : "phrase",
    ipaUk: match.type === "word" ? match.ipaUk || "" : "",
    ipaUs: match.type === "word" ? match.ipaUs || "" : "",
    partOfSpeech: match.type === "word" ? match.partOfSpeech || "" : "",
    definitionEn: match.definitionEn || "",
    meaningZh: match.meaningZh || "",
    example: match.example || "",
    level: match.level || "",
  };
}

async function syncLearningMetadataToVocabulary() {
  let changed = false;
  savedVocabulary.forEach((item) => {
    const metadata = getLearningMetadata(item.term);
    Object.entries(metadata).forEach(([key, value]) => {
      if (value && item[key] !== value) {
        item[key] = value;
        changed = true;
      }
    });
  });
  if (changed) {
    await chrome.storage.local.set({ [VOCABULARY_STORAGE_KEY]: savedVocabulary });
    renderVocabulary(document.getElementById("vocabularySearch")?.value || "");
  }
}

function speakVocabularyTerm(term) {
  if (!term || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(term);
  utterance.lang = "en-US";
  utterance.rate = 0.82;
  const voices = window.speechSynthesis.getVoices();
  utterance.voice = voices.find((voice) => voice.lang === "en-US" && /Samantha|Ava|Google US English/i.test(voice.name))
    || voices.find((voice) => voice.lang === "en-US")
    || voices.find((voice) => voice.lang.startsWith("en"))
    || null;
  window.speechSynthesis.speak(utterance);
}

function vocabularyPronunciationHtml(item) {
  if (item.type !== "word") return "";
  const ipa = [item.ipaUs ? `US ${item.ipaUs}` : "", item.ipaUk ? `UK ${item.ipaUk}` : ""].filter(Boolean).join(" · ");
  return `<div class="vocabulary-pronunciation">${item.partOfSpeech ? `<span>${escapeHtml(item.partOfSpeech)}</span>` : ""}${ipa ? `<span>${escapeHtml(ipa)}</span>` : ""}<button class="vocabulary-speak" type="button" title="Play pronunciation" aria-label="Play pronunciation">🔊</button></div>`;
}

async function loadVocabulary() {
  const result = await chrome.storage.local.get([VOCABULARY_STORAGE_KEY, REVIEW_DAILY_STORAGE_KEY]);
  savedVocabulary = Array.isArray(result[VOCABULARY_STORAGE_KEY]) ? result[VOCABULARY_STORAGE_KEY] : [];
  reviewDailyState = normalizeReviewDailyState(result[REVIEW_DAILY_STORAGE_KEY]);
  let migrated = false;
  savedVocabulary.forEach((item) => {
    if (!item.type) {
      item.type = getVocabularyType(item.term);
      migrated = true;
    }
    if (!item.review) {
      item.review = createInitialReviewState(item);
      migrated = true;
    }
  });
  if (migrated) await chrome.storage.local.set({ [VOCABULARY_STORAGE_KEY]: savedVocabulary });
  updateReviewCenter();
  renderVocabulary(document.getElementById("vocabularySearch")?.value || "");
  applyVocabularyHighlights();
  return savedVocabulary;
}

async function saveVocabularyTerm(selectedText, context, metadata = null) {
  const term = normalizeVocabularyTerm(selectedText);
  if (!term || term.length > 100) return;
  const source = {
    videoId: currentVideoId,
    videoTitle: currentVideoTitle,
    url: `https://youtube.com/watch?v=${currentVideoId}`,
    context: normalizeCaptionText(context),
    addedAt: new Date().toISOString(),
  };
  const existing = savedVocabulary.find((item) => item.normalized === term);
  const learningMetadata = metadata || getLearningMetadata(selectedText);
  if (existing) {
    existing.lookupCount = (existing.lookupCount || 1) + 1;
    existing.sources = Array.isArray(existing.sources) ? existing.sources : [];
    if (!existing.sources.some((item) => item.videoId === currentVideoId && item.context === source.context)) existing.sources.unshift(source);
    Object.entries(learningMetadata).forEach(([key, value]) => { if (value && !existing[key]) existing[key] = value; });
  } else {
    savedVocabulary.unshift({ id: crypto.randomUUID(), term: selectedText.trim(), normalized: term, note: "", status: "learning", lookupCount: 1, createdAt: new Date().toISOString(), sources: [source], review: createInitialReviewState(), ...learningMetadata });
  }
  await chrome.storage.local.set({ [VOCABULARY_STORAGE_KEY]: savedVocabulary });
  updateReviewCenter();
  renderVocabulary();
  applyVocabularyHighlights();
}

async function removeVocabularyTerm(id) {
  savedVocabulary = savedVocabulary.filter((item) => item.id !== id);
  await chrome.storage.local.set({ [VOCABULARY_STORAGE_KEY]: savedVocabulary });
  updateReviewCenter();
  renderVocabulary(document.getElementById("vocabularySearch")?.value || "");
  if (currentTranscriptMode === "original") renderTranscript(); else renderTranscriptModeRows(getActiveTranscriptSegments(), currentTranscriptMode);
}

function createInitialReviewState(item = {}) {
  const mastered = item.status === "known" || item.status === "mastered";
  return {
    dueAt: mastered ? new Date(Date.now() + 14 * 86400000).toISOString() : new Date().toISOString(),
    intervalDays: mastered ? 14 : 0,
    repetitions: 0,
    lapses: 0,
    lastReviewedAt: null,
    lastRating: null,
  };
}

function isVocabularyDue(item, now = Date.now()) {
  const due = Date.parse(item.review?.dueAt || "");
  return !Number.isFinite(due) || due <= now;
}

function getLocalReviewDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeReviewDailyState(value) {
  const today = getLocalReviewDate();
  if (!value || value.date !== today) return { date: today, reviewed: 0, newReviewed: 0 };
  return {
    date: today,
    reviewed: Math.max(0, Number(value.reviewed) || 0),
    newReviewed: Math.max(0, Number(value.newReviewed) || 0),
  };
}

function wasReviewedToday(item) {
  const last = item.review?.lastReviewedAt;
  return Boolean(last) && getLocalReviewDate(new Date(last)) === getLocalReviewDate();
}

function getEligibleReviewItems() {
  reviewDailyState = normalizeReviewDailyState(reviewDailyState);
  const remainingReviews = Math.max(0, DAILY_REVIEW_LIMIT - reviewDailyState.reviewed);
  const remainingNew = Math.max(0, DAILY_NEW_LIMIT - reviewDailyState.newReviewed);
  const due = savedVocabulary
    .filter((item) => isVocabularyDue(item) && !wasReviewedToday(item))
    .sort((a, b) => Date.parse(a.review?.dueAt || 0) - Date.parse(b.review?.dueAt || 0));
  const established = due.filter((item) => (item.review?.repetitions || 0) > 0);
  const newItems = due.filter((item) => (item.review?.repetitions || 0) === 0).slice(0, remainingNew);
  return [...established, ...newItems].slice(0, remainingReviews);
}

function updateReviewCenter() {
  reviewDailyState = normalizeReviewDailyState(reviewDailyState);
  const allDue = savedVocabulary.filter((item) => isVocabularyDue(item) && !wasReviewedToday(item)).length;
  const eligible = getEligibleReviewItems().length;
  const deferred = Math.max(0, allDue - eligible);
  const setText = (id, value) => { const node = document.getElementById(id); if (node) node.textContent = String(value); };
  setText("reviewDueCount", eligible);
  setText("reviewTodayCount", `${reviewDailyState.reviewed}/${DAILY_REVIEW_LIMIT}`);
  setText("reviewNewCount", `${reviewDailyState.newReviewed}/${DAILY_NEW_LIMIT}`);
  const note = document.getElementById("reviewLimitNote");
  if (note) note.textContent = deferred
    ? `今天可复习 ${eligible} 项，另有 ${deferred} 项自动顺延。`
    : "每天最多 10 个新词、20 个复习项，超出部分自动顺延。";
  const button = document.getElementById("startReviewBtn");
  if (button) {
    button.disabled = eligible === 0;
    button.textContent = eligible ? `开始今日复习（${eligible}）` : "今日复习已完成";
  }
}

function startVocabularyReview() {
  reviewQueue = getEligibleReviewItems();
  reviewQueueIndex = 0;
  renderReviewCard();
}

function renderReviewCard() {
  const session = document.getElementById("reviewSession");
  const card = document.getElementById("reviewCard");
  const progress = document.getElementById("reviewProgress");
  if (!session || !card || !progress) return;
  session.hidden = false;
  if (reviewQueueIndex >= reviewQueue.length) {
    progress.textContent = "本轮复习完成";
    card.innerHTML = `<div class="review-finished">做得很好。复习结果已用于调整后续视频的个性化高亮。</div>`;
    updateReviewCenter();
    return;
  }

  const item = reviewQueue[reviewQueueIndex];
  const context = item.sources?.[0]?.context || "暂无原视频例句";
  progress.textContent = `${reviewQueueIndex + 1} / ${reviewQueue.length}`;
  const englishAnswer = item.definitionEn || item.note || "Try to recall its meaning from the original sentence.";
  card.innerHTML = `<div class="review-prompt"><strong>${escapeHtml(item.term)}</strong>${vocabularyPronunciationHtml(item)}<span>${escapeHtml(context)}</span></div><button class="review-reveal" type="button">显示答案</button><div class="review-answer" hidden><p class="vocabulary-definition">${escapeHtml(englishAnswer)}</p>${item.example ? `<p class="vocabulary-example"><b>Example</b> ${escapeHtml(item.example)}</p>` : ""}${item.meaningZh ? `<details class="vocabulary-chinese"><summary>查看中文</summary><p>${escapeHtml(item.meaningZh)}</p></details>` : ""}<div class="review-ratings"><button data-rating="forgot">忘记了</button><button data-rating="fuzzy">有点模糊</button><button data-rating="remembered">想起来了</button><button data-rating="mastered">已经熟练</button></div></div>`;
  card.querySelector(".vocabulary-speak")?.addEventListener("click", () => speakVocabularyTerm(item.term));
  card.querySelector(".review-reveal").addEventListener("click", (event) => {
    event.currentTarget.hidden = true;
    card.querySelector(".review-answer").hidden = false;
  });
  card.querySelectorAll("[data-rating]").forEach((button) => {
    button.addEventListener("click", () => rateVocabularyReview(item, button.dataset.rating));
  });
}

async function rateVocabularyReview(item, rating) {
  const now = new Date();
  const wasNew = (item.review?.repetitions || 0) === 0;
  const schedules = {
    forgot: { days: 0, status: "learning" },
    fuzzy: { days: 1, status: "fuzzy" },
    remembered: { days: Math.max(4, Math.min(14, Math.round((item.review?.intervalDays || 2) * 2.2))), status: "learning" },
    mastered: { days: Math.max(14, Math.min(45, Math.round((item.review?.intervalDays || 7) * 2.5))), status: "known" },
  };
  const result = schedules[rating] || schedules.fuzzy;
  const dueDelay = rating === "forgot" ? 6 * 60 * 60 * 1000 : result.days * 86400000;
  item.status = result.status;
  item.review = {
    ...(item.review || createInitialReviewState(item)),
    dueAt: new Date(now.getTime() + dueDelay).toISOString(),
    intervalDays: result.days,
    repetitions: (item.review?.repetitions || 0) + 1,
    lapses: (item.review?.lapses || 0) + (rating === "forgot" ? 1 : 0),
    lastReviewedAt: now.toISOString(),
    lastRating: rating,
  };
  await chrome.storage.local.set({ [VOCABULARY_STORAGE_KEY]: savedVocabulary });
  reviewDailyState = normalizeReviewDailyState(reviewDailyState);
  reviewDailyState.reviewed += 1;
  if (wasNew) reviewDailyState.newReviewed += 1;
  await chrome.storage.local.set({ [REVIEW_DAILY_STORAGE_KEY]: reviewDailyState });
  await syncReviewResultToLearningProfile(item);
  reviewQueueIndex += 1;
  renderVocabulary(document.getElementById("vocabularySearch")?.value || "");
  renderReviewCard();
}

async function syncReviewResultToLearningProfile(item) {
  await loadLearningProfile();
  const term = normalizeVocabularyTerm(item.term);
  learningProfile.known = (learningProfile.known || []).filter((value) => value !== term);
  learningProfile.fuzzy = (learningProfile.fuzzy || []).filter((value) => value !== term);
  if (item.status === "known") learningProfile.known.push(term);
  if (item.status === "fuzzy") learningProfile.fuzzy.push(term);
  await chrome.storage.local.set({
    [LEARNING_PROFILE_STORAGE_KEY]: {
      known: [...new Set(learningProfile.known)],
      fuzzy: [...new Set(learningProfile.fuzzy)],
    },
  });
}

function renderVocabulary(query = "") {
  const list = document.getElementById("vocabularyList");
  if (!list) return;
  const needle = normalizeVocabularyTerm(query);
  const items = savedVocabulary.filter((item) => !needle || item.normalized.includes(needle) || String(item.note || "").toLowerCase().includes(needle) || String(item.definitionEn || "").toLowerCase().includes(needle));
  list.innerHTML = items.length ? "" : `<div class="vocabulary-empty">No saved vocabulary yet.</div>`;
  items.forEach((item) => {
    const row = document.createElement("article");
    row.className = "vocabulary-item";
    const dueLabel = isVocabularyDue(item) ? "今日复习" : `下次 ${new Date(item.review.dueAt).toLocaleDateString()}`;
    row.innerHTML = `<div class="vocabulary-item-head"><strong>${escapeHtml(item.term)}</strong><button class="note-delete" title="Delete word">✕</button></div>${vocabularyPronunciationHtml(item)}${item.definitionEn ? `<p class="vocabulary-definition">${escapeHtml(item.definitionEn)}</p>` : `<p class="vocabulary-definition vocabulary-definition-empty">English definition will appear after this item is included in smart analysis.</p>`}${item.example ? `<p class="vocabulary-example"><b>Example</b> ${escapeHtml(item.example)}</p>` : ""}${item.meaningZh ? `<details class="vocabulary-chinese"><summary>查看中文</summary><p>${escapeHtml(item.meaningZh)}</p></details>` : ""}<label class="vocabulary-note-label">Personal note<textarea placeholder="Add your own memory cue (optional)">${escapeHtml(item.note || "")}</textarea></label><div class="vocabulary-meta">Seen ${item.lookupCount || 1} time${item.lookupCount === 1 ? "" : "s"} · ${item.sources?.length || 0} source${item.sources?.length === 1 ? "" : "s"} · ${escapeHtml(dueLabel)}</div>${item.sources?.[0]?.context ? `<p class="vocabulary-context"><b>Original</b> ${escapeHtml(item.sources[0].context)}</p>` : ""}`;
    row.querySelector(".vocabulary-speak")?.addEventListener("click", () => speakVocabularyTerm(item.term));
    row.querySelector("textarea").addEventListener("change", async (event) => { item.note = event.target.value.trim(); await chrome.storage.local.set({ [VOCABULARY_STORAGE_KEY]: savedVocabulary }); });
    row.querySelector(".note-delete").addEventListener("click", () => removeVocabularyTerm(item.id));
    list.appendChild(row);
  });
}

function applyVocabularyHighlights() {
  const root = document.getElementById("transcriptList");
  if (!root || !savedVocabulary.length) return;
  root.querySelectorAll("mark.vocabulary-highlight").forEach((mark) => mark.replaceWith(document.createTextNode(mark.textContent)));
  const terms = savedVocabulary.map((item) => item.normalized).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!terms.length) return;
  const escapedTerms = terms.map((term) =>
    term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const pattern = new RegExp(
    `(^|[^\\p{L}\\p{N}])(${escapedTerms.join("|")})(?=$|[^\\p{L}\\p{N}])`,
    "giu",
  );
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) if (!walker.currentNode.parentElement.closest(".transcript-time,.translation-error,button,mark")) nodes.push(walker.currentNode);
  nodes.forEach((node) => {
    const text = node.nodeValue;
    pattern.lastIndex = 0;
    if (!pattern.test(text)) return;
    pattern.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      const prefixLength = match[1].length;
      const start = match.index + prefixLength;
      fragment.append(document.createTextNode(text.slice(last, start)));
      const mark = document.createElement("mark");
      mark.className = "vocabulary-highlight";
      mark.textContent = match[2];
      mark.title = "Saved vocabulary";
      fragment.append(mark);
      last = start + match[2].length;
    }
    fragment.append(document.createTextNode(text.slice(last)));
    node.replaceWith(fragment);
  });
}

async function loadLearningProfile() {
  const result = await chrome.storage.local.get([
    LEARNING_PROFILE_STORAGE_KEY,
    VOCABULARY_STORAGE_KEY,
  ]);
  const stored = result[LEARNING_PROFILE_STORAGE_KEY] || {};
  const legacyIgnored = Array.isArray(stored.ignored) ? stored.ignored : [];
  const fuzzy = Array.isArray(stored.fuzzy) ? stored.fuzzy : legacyIgnored;
  learningProfile = {
    known: Array.isArray(stored.known) ? stored.known : [],
    fuzzy: [...new Set(fuzzy.map(normalizeVocabularyTerm).filter(Boolean))],
    learning: [...new Set(
      (Array.isArray(result[VOCABULARY_STORAGE_KEY])
        ? result[VOCABULARY_STORAGE_KEY]
        : [])
        .map((item) => normalizeVocabularyTerm(item.term))
        .filter(Boolean),
    )],
  };
}

function learningProfileFingerprint(profile) {
  const values = [
    ...(profile.known || []).map((item) => `k:${item}`),
    ...(profile.fuzzy || []).map((item) => `f:${item}`),
    ...(profile.learning || []).map((item) => `l:${item}`),
  ].sort();
  let hash = 2166136261;
  for (const char of values.join("|")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

async function runSmartReading({ automatic = false } = {}) {
  if (!currentTranscriptText || !currentVideoId || isLearningAnalysisLoading) return;
  const button = document.getElementById("smartReadingBtn");
  const intensity = document.getElementById("learningIntensity")?.value || "balanced";
  isLearningAnalysisLoading = true;
  button.disabled = true;
  button.textContent = automatic ? "自动分析中…" : "分析中…";
  try {
    await loadLearningProfile();
    const profileVersion = learningProfileFingerprint(learningProfile);
    const cacheKey = `learning_v5_${currentVideoId}_${intensity}_${profileVersion}`;
    const cached = await chrome.storage.local.get(cacheKey);
    if (Array.isArray(cached[cacheKey]?.items)) {
      learningItems = cached[cacheKey].items;
      learningGuide = cached[cacheKey].guide || {};
    } else {
      const result = await chrome.runtime.sendMessage({ action: "analyzeLearningItems", transcriptText: currentTranscriptText, videoTitle: currentVideoTitle, intensity, profile: learningProfile });
      if (!result?.success) throw new Error(result?.error || "智能精读分析失败");
      learningItems = result.items || [];
      learningGuide = result.guide || {};
      await chrome.storage.local.set({ [cacheKey]: { items: learningItems, guide: learningGuide, createdAt: new Date().toISOString() } });
    }
    await syncLearningMetadataToVocabulary();
    applyLearningHighlights();
    await updateCache();
    button.textContent = `已高亮 ${learningItems.length} 项`;
  } catch (error) {
    button.textContent = "重试智能精读";
    if (!automatic) alert(error.message);
  } finally {
    isLearningAnalysisLoading = false;
    button.disabled = false;
  }
}

function applyLearningHighlights() {
  const root = document.getElementById("transcriptList");
  if (!root) return;
  root.querySelectorAll("mark.learning-highlight").forEach((mark) => mark.replaceWith(document.createTextNode(mark.textContent)));
  const items = learningItems.filter((item) => item.term).sort((a, b) => b.term.length - a.term.length);
  if (!items.length) return;
  const lookup = new Map(items.map((item) => [item.term.toLocaleLowerCase(), item]));
  const terms = items.map((item) => item.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])(${terms.join("|")})(?=$|[^\\p{L}\\p{N}])`, "giu");
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) if (!walker.currentNode.parentElement.closest(".transcript-time,.transcript-translation,button,mark")) nodes.push(walker.currentNode);
  nodes.forEach((node) => {
    const text = node.nodeValue; pattern.lastIndex = 0;
    if (!pattern.test(text)) return; pattern.lastIndex = 0;
    const fragment = document.createDocumentFragment(); let last = 0;
    for (const match of text.matchAll(pattern)) {
      const start = match.index + match[1].length;
      fragment.append(document.createTextNode(text.slice(last, start)));
      const item = lookup.get(match[2].toLocaleLowerCase());
      const mark = document.createElement("mark");
      mark.className = `learning-highlight learning-${item?.type || "phrase"}`;
      mark.textContent = match[2];
      mark.title = `${item?.meaningZh || ""}\n${item?.reasonZh || ""}`.trim();
      mark.addEventListener("click", (event) => { event.stopPropagation(); openLearningCard(item, mark); });
      fragment.append(mark); last = start + match[2].length;
    }
    fragment.append(document.createTextNode(text.slice(last))); node.replaceWith(fragment);
  });
}

function openLearningCard(item, anchor) {
  document.getElementById("learningCard")?.remove();
  const card = document.createElement("div");
  card.id = "learningCard"; card.className = "learning-card";
  card.innerHTML = `<button class="learning-card-close">✕</button><strong>${escapeHtml(item.term)}</strong><span class="learning-level">${escapeHtml(item.level)}</span>${vocabularyPronunciationHtml(item)}${item.definitionEn ? `<p class="vocabulary-definition">${escapeHtml(item.definitionEn)}</p>` : ""}<p class="learning-reason">${escapeHtml(item.reasonZh)}</p>${item.example ? `<p class="vocabulary-example"><b>Example</b> ${escapeHtml(item.example)}</p>` : ""}${item.meaningZh ? `<details class="vocabulary-chinese"><summary>查看中文</summary><p>${escapeHtml(item.meaningZh)}</p></details>` : ""}<div><button data-action="save">加入生词本</button><button data-action="known">已掌握</button><button data-action="fuzzy">模糊</button></div>`;
  document.body.appendChild(card);
  const rect = anchor.getBoundingClientRect(); card.style.top = `${Math.min(window.innerHeight - card.offsetHeight - 12, rect.bottom + 8)}px`;
  card.querySelector(".learning-card-close").onclick = () => card.remove();
  card.querySelector(".vocabulary-speak")?.addEventListener("click", () => speakVocabularyTerm(item.term));
  card.querySelector('[data-action="save"]').onclick = async () => { await saveVocabularyTerm(item.term, item.sourceContext || item.example || item.reasonZh, getLearningMetadata(item.term)); card.remove(); };
  ["known", "fuzzy"].forEach((action) => card.querySelector(`[data-action="${action}"]`).onclick = async () => {
    await loadLearningProfile();
    const key = action === "known" ? "known" : "fuzzy";
    if (!learningProfile[key].includes(item.term.toLocaleLowerCase())) learningProfile[key].push(item.term.toLocaleLowerCase());
    const opposite = action === "known" ? "fuzzy" : "known";
    learningProfile[opposite] = learningProfile[opposite].filter(
      (term) => term !== item.term.toLocaleLowerCase(),
    );
    await chrome.storage.local.set({
      [LEARNING_PROFILE_STORAGE_KEY]: {
        known: learningProfile.known,
        fuzzy: learningProfile.fuzzy,
      },
    });
    learningItems = learningItems.filter((entry) => entry.term !== item.term); card.remove(); applyLearningHighlights();
  });
}

function exportVocabularyCsv() {
  const quote = (value) => `"${String(value || "").replace(/"/g, '""')}"`;
  const rows = [["term", "type", "part_of_speech", "ipa_us", "ipa_uk", "english_definition", "chinese_meaning", "note", "status", "lookup_count", "source_video", "source_context"], ...savedVocabulary.map((item) => [item.term, item.type, item.partOfSpeech, item.ipaUs, item.ipaUk, item.definitionEn, item.meaningZh, item.note, item.status, item.lookupCount, item.sources?.[0]?.videoTitle, item.sources?.[0]?.context])];
  downloadFile(`\uFEFF${rows.map((row) => row.map(quote).join(",")).join("\n")}`, "youtube-digest-vocabulary.csv", "text/csv");
}

// ============================================================
// CACHING
// ============================================================

/**
 * Saves the current digest results to persistent local storage.
 * Results survive browser restarts — reopening the same video loads from cache
 * without consuming API tokens or Supadata calls.
 * Cache expires after 30 days. Oldest entries evicted when > 20 videos cached.
 */
async function saveToCache(videoId) {
  if (!videoId || !currentTranscript) return;

  try {
    // Persist semantic-segment translations for this video.
    const paragraphCacheForVideo = {};
    for (const [key, value] of transcriptParagraphCache.entries()) {
      if (key.startsWith(`${videoId}:`)) {
        paragraphCacheForVideo[key] = value;
      }
    }

    const cacheData = {
      analysis: currentAnalysis, // May be null if not yet analyzed
      transcript: currentTranscript,
      transcriptText: currentTranscriptText,
      transcriptTimestamped: currentTranscriptTimestamped,
      transcriptLanguage: currentTranscriptLanguage,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      paragraphCache: paragraphCacheForVideo,
      compactSegments: getActiveTranscriptSegments().map(({ id, start, text }) => ({ id, start, text })),
      timestamp: Date.now(),
    };

    await chrome.storage.local.set({ [`digest_${videoId}`]: cacheData });
    debugLog(
      "Saved to cache:",
      videoId,
      currentAnalysis ? "(with analysis)" : "(transcript only)",
    );

    // Evict old entries if we have more than 20 videos cached
    await evictOldCacheEntries(20);
  } catch (error) {
    console.error("Cache save error:", error);
  }
}

/**
 * Keeps the cache from growing unbounded.
 * Removes the oldest entries when we exceed maxEntries videos.
 *
 * @param {number} maxEntries - Maximum number of cached videos to keep
 */
async function evictOldCacheEntries(maxEntries) {
  try {
    const allData = await chrome.storage.local.get(null);
    let digestKeys = Object.keys(allData).filter((k) =>
      k.startsWith("digest_"),
    );
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const expired = digestKeys.filter((key) => {
      const timestamp = Number(allData[key]?.timestamp) || 0;
      return Date.now() - timestamp > THIRTY_DAYS;
    });
    if (expired.length) {
      await chrome.storage.local.remove(expired);
      const expiredSet = new Set(expired);
      digestKeys = digestKeys.filter((key) => !expiredSet.has(key));
    }

    if (digestKeys.length <= maxEntries) return;

    // Sort by timestamp (oldest first) and remove excess
    const sorted = digestKeys
      .map((k) => ({ key: k, ts: allData[k]?.timestamp || 0 }))
      .sort((a, b) => a.ts - b.ts);

    const toRemove = sorted
      .slice(0, sorted.length - maxEntries)
      .map((e) => e.key);
    if (toRemove.length > 0) {
      await chrome.storage.local.remove(toRemove);
      debugLog(`[YouTube Digest] Evicted ${toRemove.length} old cache entries`);
    }
  } catch (error) {
    console.error("Cache eviction error:", error);
  }
}

/**
 * Loads digest results from persistent local storage.
 * Returns null if not cached or expired (30-day expiry).
 */
async function loadFromCache(videoId) {
  if (!videoId) return null;

  try {
    const result = await chrome.storage.local.get(`digest_${videoId}`);
    const cached = result[`digest_${videoId}`];

    if (!cached) return null;

    // Cache expires after 30 days
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - cached.timestamp > THIRTY_DAYS) {
      await chrome.storage.local.remove(`digest_${videoId}`);
      return null;
    }

    return cached;
  } catch (error) {
    console.error("Cache load error:", error);
    return null;
  }
}

/**
 * Updates the cache after enhance or translation operations.
 */
async function updateCache() {
  if (currentVideoId) {
    await saveToCache(currentVideoId);
  }
}

// ============================================================
// NOTES
// ============================================================

/**
 * Loads and renders notes from storage.
 * @param {string|null} videoId - Filter by video ID, or null for all notes
 */
async function loadNotes(videoId) {
  try {
    const result = await chrome.runtime.sendMessage({
      action: "getNotes",
      videoId: videoId,
    });

    if (result.success) {
      renderNotes(result.notes, videoId);
    }
  } catch (error) {
    console.error("[YouTube Digest Panel] Load notes error:", error);
  }
}

/**
 * Renders the notes list in the Notes tab.
 */
function renderNotes(notes, filteredVideoId) {
  const notesList = document.getElementById("notesList");
  const notesIntro = document.getElementById("notesIntro");

  if (!notesList) return;

  notesList.innerHTML = "";

  if (!notes || notes.length === 0) {
    notesIntro.style.display = "block";
    notesIntro.textContent = filteredVideoId
      ? "No notes for this video yet. Hover over the video and click 📝 Note to save."
      : "No notes saved yet. Hover over a video and click 📝 Note to save.";
    return;
  }

  notesIntro.style.display = "none";

  notes.forEach((note) => {
    const noteEl = document.createElement("div");
    noteEl.className = "note-item";
    noteEl.innerHTML = `
      <div class="note-header">
        <span class="note-timestamp" data-url="${escapeHtml(note.timestampedUrl)}" data-seconds="${Number(note.timestampSeconds) || 0}">${escapeHtml(note.timestamp)}</span>
        ${!filteredVideoId ? `<span class="note-video-title">${escapeHtml(note.videoTitle)}</span>` : ""}
        <button class="note-delete" data-id="${escapeHtml(note.id)}" title="Delete note">✕</button>
      </div>
      <div class="note-text">"${escapeHtml(note.text)}"</div>
      <div class="note-actions">
        <button class="note-action-btn note-copy-text">⧉ Copy text</button>
        <button class="note-action-btn note-copy-link" data-url="${escapeHtml(note.timestampedUrl)}">🔗 Copy timestamp</button>
        <button class="note-action-btn note-play" data-seconds="${Number(note.timestampSeconds) || 0}">▶ Play</button>
      </div>
    `;

    // Timestamp click - play from this point (in this tab or a new one)
    noteEl.querySelector(".note-timestamp").addEventListener("click", () => {
      playNote(note);
    });

    // Delete button
    noteEl
      .querySelector(".note-delete")
      .addEventListener("click", async (e) => {
        e.stopPropagation();
        await deleteNote(note.id);
        loadNotes(filteredVideoId);
      });

    // Copy text button — copies just the note's text
    noteEl
      .querySelector(".note-copy-text")
      .addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(note.text);
          const btn = noteEl.querySelector(".note-copy-text");
          btn.textContent = "✓ Copied!";
          setTimeout(() => {
            btn.textContent = "⧉ Copy text";
          }, 2000);
        } catch (err) {
          console.error("Copy failed:", err);
        }
      });

    // Copy timestamp button — copies the timestamped YouTube link
    noteEl
      .querySelector(".note-copy-link")
      .addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(note.timestampedUrl);
          const btn = noteEl.querySelector(".note-copy-link");
          btn.textContent = "✓ Copied!";
          setTimeout(() => {
            btn.textContent = "🔗 Copy timestamp";
          }, 2000);
        } catch (err) {
          console.error("Copy failed:", err);
        }
      });

    // Play button (in this tab if it's the current video, else a new tab)
    noteEl.querySelector(".note-play").addEventListener("click", () => {
      playNote(note);
    });

    notesList.appendChild(noteEl);
  });
}

/**
 * Deletes a note by ID.
 */
async function deleteNote(noteId) {
  try {
    await chrome.runtime.sendMessage({
      action: "deleteNote",
      noteId: noteId,
    });
  } catch (error) {
    console.error("[YouTube Digest Panel] Delete note error:", error);
  }
}

// ============================================================
// AUTO-SCROLL — Follow video playback in transcript
// ============================================================
// While a video plays, the transcript automatically scrolls to show which
// 30-second chunk is currently being spoken. If the user manually scrolls
// (e.g., to read ahead), auto-scroll pauses and a "Follow playback" button
// appears so they can resume it. Highlight always stays active regardless.

/**
 * Starts polling the video's current time and highlighting/scrolling
 * to the matching transcript entry.
 */
function startPlaybackTracking() {
  if (!currentTranscript || !currentTranscript.length) return;

  // Don't restart if already tracking (preserves user's auto-scroll state)
  if (autoScrollInterval) return;

  autoScrollEnabled = true;
  document.getElementById("followPlaybackBtn").style.display = "none";

  // Poll video time every 500ms
  autoScrollInterval = setInterval(() => playbackTrackingTick(), 500);
  // Establish the current row immediately instead of waiting for the first
  // interval. Transcript mode is intentionally strict-follow: it always keeps
  // the spoken row visible, so the learner never has to swipe the panel.
  playbackTrackingTick();
}

/**
 * Stops playback tracking entirely. Called when leaving transcript tab,
 * starting a new digest, or leaving results state.
 */
function stopPlaybackTracking() {
  if (autoScrollInterval) {
    clearInterval(autoScrollInterval);
    autoScrollInterval = null;
  }
  autoScrollEnabled = true; // Reset for next time
  lastAutoScrollTime = 0;
  document.getElementById("followPlaybackBtn").style.display = "none";

  // Remove active highlights
  document
    .querySelectorAll(".transcript-entry.active-playback")
    .forEach((el) => {
      el.classList.remove("active-playback");
    });
}

/**
 * One tick of the playback tracker. Gets current video time from the
 * YouTube tab and highlights + scrolls to the matching transcript entry.
 */
async function playbackTrackingTick() {
  try {
    const result = await chrome.runtime.sendMessage({
      action: "relayToContent",
      payload: { action: "getCurrentTime" },
    });

    if (!result.success || !result.response) return;

    const currentTime = result.response.currentTime || 0;
    highlightActiveEntry(currentTime);
  } catch (error) {
    // Silently ignore — YouTube tab might be closed or navigated away
  }
}

/**
 * Scrolls the transcript to the entry currently being spoken (the one
 * carrying the active-playback highlight). Returns false if nothing is
 * highlighted yet. Stamps lastAutoScrollTime BEFORE scrolling so the scroll
 * events from our own smooth animation aren't mistaken for the user
 * scrolling away (which would re-disable auto-scroll immediately).
 */
function scrollToActiveEntry() {
  const activeEntry = document.querySelector(
    "#transcriptList .transcript-entry.active-playback",
  );
  if (!activeEntry) return false;

  lastAutoScrollTime = Date.now();
  activeEntry.scrollIntoView({ behavior: "smooth", block: "center" });
  return true;
}

/**
 * Finds the transcript entry matching the current playback time,
 * highlights it, and scrolls to it (if auto-scroll is enabled).
 *
 * @param {number} currentSeconds - Current video playback time in seconds
 */
function highlightActiveEntry(currentSeconds) {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return;

  const entries = transcriptList.querySelectorAll(".transcript-entry");
  if (entries.length === 0) return;

  // Find the entry whose time range contains the current playback time
  let activeEntry = null;
  entries.forEach((entry, index) => {
    const entrySeconds = parseInt(entry.dataset.seconds);
    const nextEntry = entries[index + 1];
    const nextSeconds = nextEntry
      ? parseInt(nextEntry.dataset.seconds)
      : Infinity;

    if (currentSeconds >= entrySeconds && currentSeconds < nextSeconds) {
      activeEntry = entry;
    }
  });

  if (!activeEntry) return;

  // Skip if this entry is already highlighted (no DOM thrashing)
  if (activeEntry.classList.contains("active-playback")) return;

  // Remove old highlight, add new one
  entries.forEach((e) => e.classList.remove("active-playback"));
  activeEntry.classList.add("active-playback");

  // Only scroll if auto-scroll is enabled
  if (autoScrollEnabled) {
    lastAutoScrollTime = Date.now();
    activeEntry.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

/**
 * Scroll event handler for the content area.
 * Detects manual scrolling and disables auto-scroll so the user
 * can read at their own pace without being yanked back.
 */
function onContentAreaScroll() {
  // Kept as a no-op for compatibility with older loaded panel instances.
  // Current transcript mode always follows playback automatically.
}

// ============================================================
// TRANSCRIPT MODE UI — Original / Chinese / aligned bilingual
// ============================================================

function getOriginalTranscriptLabel() {
  const language = String(currentTranscriptLanguage || "").trim();
  return /^[A-Za-z0-9-]{1,20}$/.test(language)
    ? `Original (${language})`
    : "Original";
}

function getActiveTranscriptSegments() {
  return groupTranscriptEntries(currentTranscript || []);
}

function transcriptTranslationCacheKey(segment) {
  return `${currentVideoId}:zh:semantic:${segment.id}`;
}

function setTranscriptModeButtons(mode) {
  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    const active = button.dataset.transcriptMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

async function handleTranscriptModeChange(mode) {
  if (!["original", "zh", "bilingual"].includes(mode)) return;
  if (mode === currentTranscriptMode) return;

  currentTranscriptMode = mode;
  translationGeneration += 1;
  translationWorkCount = 0;
  setTranslatingSpinner(false);
  if (transcriptScrollObserver) transcriptScrollObserver.disconnect();
  transcriptScrollObserver = null;
  setTranscriptModeButtons(mode);

  if (mode === "original") {
    renderTranscript();
    playbackTrackingTick();
    return;
  }

  await translateTranscript();
  playbackTrackingTick();
}

function renderTranscriptSegmentContent(segment, mode, translated, error) {
  const original = renderSubtitleInlineMarkup(segment.text);
  let translationHtml = "";
  if (translated) {
    translationHtml = renderSubtitleInlineMarkup(translated);
  } else if (error) {
    translationHtml = `${escapeHtml(error)}<button class="translation-retry-btn" type="button">Retry</button>`;
  } else {
    translationHtml = "Waiting for translation…";
  }

  if (mode === "bilingual") {
    return `<span class="transcript-copy"><span class="transcript-original">${original}</span><span class="transcript-translation ${translated ? "" : error ? "translation-error" : "translation-pending"}">${translationHtml}</span></span>`;
  }

  return `<span class="transcript-copy"><span class="transcript-translation ${translated ? "" : error ? "translation-error" : "translation-pending"}">${translationHtml}</span></span>`;
}

function renderTranscriptModeRows(segments, mode) {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return [];
  transcriptList.innerHTML = "";

  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();
  const badge = document.createElement("div");
  badge.id = "transcriptSourceBadge";
  badge.className = "transcript-source-badge";
  const originalLabel = getOriginalTranscriptLabel();
  const modeLabel =
    mode === "bilingual"
      ? `${originalLabel} + 简体中文`
      : `简体中文 · translated from ${originalLabel}`;
  badge.innerHTML = `<span class="source-dot source-dot--subs"></span> From video subtitles · ${modeLabel}`;
  transcriptList.parentElement.insertBefore(badge, transcriptList);

  const rows = [];
  segments.forEach((segment, index) => {
    const div = document.createElement("div");
    const cached = transcriptParagraphCache.get(
      transcriptTranslationCacheKey(segment),
    );
    div.className = `transcript-entry ${cached ? "translated" : "translating"}`;
    div.dataset.seconds = segment.start;
    div.dataset.segmentId = segment.id;
    div.dataset.segmentIndex = index;

    const minutes = Math.floor(segment.start / 60);
    const seconds = Math.floor(segment.start % 60);
    const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;
    div.innerHTML = `
      <span class="transcript-time">${timestamp}</span>
      ${renderTranscriptSegmentContent(segment, mode, cached, "")}
    `;
    div.addEventListener("click", (event) =>
      seekFromTranscriptEntryClick(event, segment.start),
    );
    transcriptList.appendChild(div);
    rows.push(div);
  });

  startPlaybackTracking();
  applyVocabularyHighlights();
  applyLearningHighlights();
  return rows;
}

/**
 * Rebuilds a provider response in source order. Unknown IDs are ignored and
 * missing IDs remain explicit errors, never positional guesses.
 */
function alignTranslatedSegmentBatch(sourceSegments, responseSegments) {
  const translatedById = new Map();
  if (Array.isArray(responseSegments)) {
    responseSegments.forEach((item) => {
      if (!item || typeof item.id !== "string" || typeof item.text !== "string")
        return;
      const text = item.text.trim();
      if (text && !translatedById.has(item.id)) {
        translatedById.set(item.id, text);
      }
    });
  }

  return sourceSegments.map((segment) => ({
    id: segment.id,
    text: translatedById.get(segment.id) || "",
    error: translatedById.has(segment.id) ? "" : "Translation unavailable.",
  }));
}

function updateTranslatedRow(segment, index, alignedItem, generation) {
  if (generation !== translationGeneration) return;
  const row = document.querySelector(
    `.transcript-entry[data-segment-id="${CSS.escape(segment.id)}"]`,
  );
  if (!row) return;

  if (alignedItem.text) {
    transcriptParagraphCache.set(
      transcriptTranslationCacheKey(segment),
      alignedItem.text,
    );
  }

  const copy = row.querySelector(".transcript-copy");
  if (copy) {
    copy.outerHTML = renderTranscriptSegmentContent(
      segment,
      currentTranscriptMode,
      alignedItem.text,
      alignedItem.error,
    );
  }
  row.classList.toggle("translated", !!alignedItem.text);
  row.classList.toggle("translating", false);
  row.classList.toggle("translation-failed", !alignedItem.text);
  applyVocabularyHighlights();
  applyLearningHighlights();

  const retry = row.querySelector(".translation-retry-btn");
  if (retry) {
    ["mousedown", "mouseup"].forEach((eventName) => {
      retry.addEventListener(eventName, (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    });
    retry.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      retryTranslationSegment(index, generation);
    });
  }
}

let activeTranslationQueue = null;

async function requestTranscriptTranslationBatch(
  indices,
  segments,
  generation,
  videoId,
  mode,
) {
  const sourceBatch = indices.map((index) => segments[index]);
  setTranslatingSpinner(true);
  try {
    const result = await sendTranslationMessage({
      action: "translateContent",
      content: {
        segments: sourceBatch.map(({ id, text }) => ({ id, text })),
      },
      contentType: "transcriptBatch",
      targetLanguage: "zh",
      videoTitle: currentVideoTitle,
    });

    const isStale =
      generation !== translationGeneration ||
      videoId !== currentVideoId ||
      mode !== currentTranscriptMode;
    if (isStale) return;

    const responseSegments = result?.success
      ? result.translatedContent?.segments
      : [];
    const aligned = alignTranslatedSegmentBatch(sourceBatch, responseSegments);
    aligned.forEach((item, batchIndex) => {
      if (!result?.success) {
        item.error = result?.error || "Translation failed.";
      }
      updateTranslatedRow(
        sourceBatch[batchIndex],
        indices[batchIndex],
        item,
        generation,
      );
    });
    await updateCache();
  } catch (error) {
    if (generation !== translationGeneration) return;
    sourceBatch.forEach((segment, batchIndex) => {
      updateTranslatedRow(
        segment,
        indices[batchIndex],
        { id: segment.id, text: "", error: error.message || "Translation failed." },
        generation,
      );
    });
  } finally {
    setTranslatingSpinner(false);
  }
}

function retryTranslationSegment(index, generation) {
  if (generation !== translationGeneration || !activeTranslationQueue) return;
  const row = document.querySelector(
    `.transcript-entry[data-segment-index="${index}"]`,
  );
  if (row) {
    row.classList.add("translating");
    row.classList.remove("translation-failed");
    const translation = row.querySelector(".transcript-translation");
    if (translation) {
      translation.className = "transcript-translation translation-pending";
      translation.textContent = "Retrying…";
    }
  }
  activeTranslationQueue.enqueue(index, true);
}

/**
 * Renders immediately, translates the first small batch, then observes the
 * remaining rows. Batches are sequential so the provider is never flooded.
 */
async function translateTranscript() {
  const segments = getActiveTranscriptSegments();
  if (!segments.length || currentTranscriptMode === "original") return;

  translationGeneration += 1;
  const generation = translationGeneration;
  const videoId = currentVideoId;
  const mode = currentTranscriptMode;
  if (transcriptScrollObserver) transcriptScrollObserver.disconnect();

  const rows = renderTranscriptModeRows(segments, mode);
  const queue = [];
  const queued = new Set();
  let processing = false;

  const processNext = async () => {
    if (processing || queue.length === 0 || generation !== translationGeneration)
      return;
    processing = true;
    const indices = queue.splice(0, 3);
    indices.forEach((index) => queued.delete(index));
    try {
      await requestTranscriptTranslationBatch(
        indices,
        segments,
        generation,
        videoId,
        mode,
      );
    } finally {
      processing = false;
      if (queue.length && generation === translationGeneration) processNext();
    }
  };

  const enqueue = (index, force = false) => {
    if (!Number.isInteger(index) || !segments[index]) return;
    const cached = transcriptParagraphCache.has(
      transcriptTranslationCacheKey(segments[index]),
    );
    if ((!force && cached) || queued.has(index)) return;
    queue.push(index);
    queued.add(index);
    // Let all entries reported in the same viewport turn collect before the
    // worker starts, producing one small contextual multi-segment request.
    Promise.resolve().then(processNext);
  };
  activeTranslationQueue = { enqueue };

  transcriptScrollObserver = new IntersectionObserver(
    (observerEntries) => {
      observerEntries
        .filter((entry) => entry.isIntersecting)
        .sort(
          (a, b) =>
            Number(a.target.dataset.segmentIndex) -
            Number(b.target.dataset.segmentIndex),
        )
        .forEach((entry) => enqueue(Number(entry.target.dataset.segmentIndex)));
    },
    {
      root: document.getElementById("contentArea"),
      rootMargin: "320px 0px",
      threshold: 0,
    },
  );

  rows.forEach((row, index) => {
    if (!row.classList.contains("translated")) transcriptScrollObserver.observe(row);
    if (index < 3) enqueue(index);
  });
}

function setTranslatingSpinner(show) {
  if (show) translationWorkCount += 1;
  else translationWorkCount = Math.max(0, translationWorkCount - 1);
  const isTranslating = translationWorkCount > 0;
  const spinner = document.getElementById("langSpinner");
  if (spinner) spinner.classList.toggle("visible", isTranslating);
}

// Pure helpers are exposed for the repository's Node tests. The extension does
// not read this object at runtime.
globalThis.__YTD_TRANSCRIPT_TESTING__ = {
  sendTranslationMessage,
  groupTranscriptEntries,
  splitOversizedThought,
  alignTranslatedSegmentBatch,
  renderSubtitleInlineMarkup,
  renderTranscriptSegmentContent,
};
