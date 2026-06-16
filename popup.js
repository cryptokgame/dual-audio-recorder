// Popup UI Controller (Manifest V3)
// Handles highly professional, minimalist user interactions, live VU audio meters, and history playback.

let activeTabId = null;
let activeTabTitle = '';
let recordingTimer = null;
let elapsedSeconds = 0;
let isRecordingPaused = false;
let isMicMuted = false;
let selectedMicId = 'default';

// DOM Elements
const statusPill = document.getElementById('statusPill');
const alertBox = document.getElementById('alertBox');
const alertMessage = document.getElementById('alertMessage');
const alertClose = document.getElementById('alertClose');

const tabFavicon = document.getElementById('tabFavicon');
const tabTitle = document.getElementById('tabTitle');

const micSelect = document.getElementById('micSelect');
const setupMicsLink = document.getElementById('setupMicsLink');
const refreshMicsBtn = document.getElementById('refreshMicsBtn');

const idleActions = document.getElementById('idleActions');
const startBtn = document.getElementById('startBtn');

const recordingView = document.getElementById('recordingView');
const elapsedTimer = document.getElementById('elapsedTimer');
const tabMeterBar = document.getElementById('tabMeterBar');
const micMeterBar = document.getElementById('micMeterBar');
const micMutedBadge = document.getElementById('micMutedBadge');

const pauseResumeBtn = document.getElementById('pauseResumeBtn');
const pauseIcon = document.getElementById('pauseIcon');
const pauseText = document.getElementById('pauseText');

const muteMicBtn = document.getElementById('muteMicBtn');
const muteIcon = document.getElementById('muteIcon');
const muteText = document.getElementById('muteText');
const stopBtn = document.getElementById('stopBtn');

const encodingView = document.getElementById('encodingView');

const historyList = document.getElementById('historyList');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');

// Inline Professional SVGs
const SVG_ALERT_WARN = `<polygon points="12 2 2 22 22 22 12 2"></polygon><line x1="12" y1="13" x2="12" y2="17"></line><line x1="12" y1="20" x2="12.01" y2="20"></line>`;
const SVG_ALERT_SUCCESS = `<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline>`;
const SVG_PAUSE = `<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>`;
const SVG_RESUME = `<polygon points="5 3 19 12 5 21 5 3" style="fill: currentColor;"></polygon>`;
const SVG_MIC = `<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line>`;
const SVG_MIC_MUTED = `<line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line>`;
const SVG_DOWNLOAD = `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line>`;
const SVG_TRASH = `<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>`;

// Initialize Popup
document.addEventListener('DOMContentLoaded', async () => {
  await fetchActiveTab();
  await loadMicPreferences();
  await syncRecordingStatus();
  await renderHistory();

  setupEventListeners();
  setupRuntimeListeners();
});

// 1. Fetch current active browser tab info
async function fetchActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length > 0) {
      activeTabId = tabs[0].id;
      activeTabTitle = tabs[0].title || 'Browser Tab';
      tabTitle.textContent = activeTabTitle;

      if (tabs[0].favIconUrl) {
        tabFavicon.src = tabs[0].favIconUrl;
        tabFavicon.classList.remove('hidden');
      }
    }
  } catch (err) {
    console.error('Error fetching active tab:', err);
    tabTitle.textContent = 'Active Browser Tab';
  }
}

// 2. Microphone setup and permissions
async function loadMicPreferences() {
  try {
    const prefs = await chrome.storage.local.get({ selectedMic: 'default' });
    selectedMicId = prefs.selectedMic;

    await populateMicDropdown();
  } catch (err) {
    console.error('Error loading mic preferences:', err);
  }
}

async function populateMicDropdown() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(d => d.kind === 'audioinput');

    micSelect.innerHTML = '';
    
    if (audioInputs.length === 0 || (audioInputs.length === 1 && !audioInputs[0].label)) {
      const opt = document.createElement('option');
      opt.value = 'default';
      opt.textContent = 'Default Microphone (Click Device Setup)';
      micSelect.appendChild(opt);
    } else {
      audioInputs.forEach(device => {
        const opt = document.createElement('option');
        opt.value = device.deviceId;
        opt.textContent = device.label || `Microphone (${device.deviceId.substring(0, 5)})`;
        if (device.deviceId === selectedMicId) opt.selected = true;
        micSelect.appendChild(opt);
      });
    }
  } catch (err) {
    console.warn('Could not enumerate devices:', err);
  }
}

// 3. Status Synchronization with Background Script
async function syncRecordingStatus() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'GET_STATUS' }, (status) => {
      if (chrome.runtime.lastError || !status) {
        setUiState('IDLE');
        resolve();
        return;
      }

      elapsedSeconds = status.elapsedSeconds || 0;
      isMicMuted = status.micMuted || false;

      if (status.state === 'RECORDING') {
        isRecordingPaused = false;
        setUiState('RECORDING');
      } else if (status.state === 'PAUSED') {
        isRecordingPaused = true;
        setUiState('PAUSED');
      } else if (status.state === 'STOPPING') {
        setUiState('ENCODING');
      } else {
        setUiState('IDLE');
      }
      resolve();
    });
  });
}

function setUiState(state) {
  idleActions.classList.add('hidden');
  recordingView.classList.add('hidden');
  encodingView.classList.add('hidden');

  if (state === 'IDLE') {
    idleActions.classList.remove('hidden');
    startBtn.disabled = false;
    updateStatusPill('Ready', false);
    stopTimer();
  } else if (state === 'RECORDING' || state === 'PAUSED') {
    recordingView.classList.remove('hidden');
    updateStatusPill(state === 'PAUSED' ? 'Paused' : 'Recording...', state === 'RECORDING');
    
    updatePauseBtnUi();
    updateMuteBtnUi();
    updateTimerDisplay();

    if (state === 'RECORDING') {
      startTimer();
    } else {
      stopTimer();
    }
  } else if (state === 'ENCODING') {
    encodingView.classList.remove('hidden');
    updateStatusPill('Encoding WAV...', false);
    stopTimer();
  }
}

function updateStatusPill(text, isRed) {
  statusPill.querySelector('.status-text').textContent = text;
  if (isRed) {
    statusPill.classList.add('recording');
    statusPill.classList.remove('paused');
  } else if (text === 'Paused') {
    statusPill.classList.add('paused');
    statusPill.classList.remove('recording');
  } else {
    statusPill.classList.remove('recording');
    statusPill.classList.remove('paused');
  }
}

// 4. Timer utilities
function startTimer() {
  stopTimer();
  recordingTimer = setInterval(() => {
    if (!isRecordingPaused) {
      elapsedSeconds++;
      updateTimerDisplay();
    }
  }, 1000);
}

function stopTimer() {
  if (recordingTimer) {
    clearInterval(recordingTimer);
    recordingTimer = null;
  }
}

function updateTimerDisplay() {
  const hrs = Math.floor(elapsedSeconds / 3600);
  const mins = Math.floor((elapsedSeconds % 3600) / 60);
  const secs = elapsedSeconds % 60;

  elapsedTimer.textContent = [
    hrs > 0 ? String(hrs).padStart(2, '0') : null,
    String(mins).padStart(2, '0'),
    String(secs).padStart(2, '0')
  ].filter(Boolean).join(':');
}

// 5. Button UI Modifiers
function updatePauseBtnUi() {
  if (isRecordingPaused) {
    pauseIcon.innerHTML = SVG_RESUME;
    pauseText.textContent = 'Resume';
    pauseResumeBtn.classList.add('btn-primary');
    pauseResumeBtn.classList.remove('btn-secondary');
  } else {
    pauseIcon.innerHTML = SVG_PAUSE;
    pauseText.textContent = 'Pause';
    pauseResumeBtn.classList.add('btn-secondary');
    pauseResumeBtn.classList.remove('btn-primary');
  }
}

function updateMuteBtnUi() {
  if (isMicMuted) {
    muteIcon.innerHTML = SVG_MIC_MUTED;
    muteText.textContent = 'Unmute';
    muteMicBtn.classList.add('btn-danger');
    muteMicBtn.classList.remove('btn-secondary');
    micMutedBadge.classList.remove('hidden');
  } else {
    muteIcon.innerHTML = SVG_MIC;
    muteText.textContent = 'Mute Mic';
    muteMicBtn.classList.add('btn-secondary');
    muteMicBtn.classList.remove('btn-danger');
    micMutedBadge.classList.add('hidden');
  }
}

// 6. Interactive Click Listeners
function setupEventListeners() {
  alertClose.addEventListener('click', () => alertBox.classList.add('hidden'));

  micSelect.addEventListener('change', async (e) => {
    selectedMicId = e.target.value;
    await chrome.storage.local.set({ selectedMic: selectedMicId });
  });

  setupMicsLink.addEventListener('click', () => {
    chrome.tabs.create({ url: 'setup.html' });
  });

  refreshMicsBtn.addEventListener('click', async () => {
    await populateMicDropdown();
    showAlert('Device List Refreshed', 'Available audio hardware sources reloaded successfully.', true);
  });

  // Start Recording
  startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    startBtn.querySelector('.btn-text').textContent = 'Initializing Audio Intercept...';

    chrome.runtime.sendMessage({
      action: 'START_RECORDING',
      tabId: activeTabId,
      tabTitle: activeTabTitle,
      micDeviceId: selectedMicId
    }, (response) => {
      startBtn.disabled = false;
      startBtn.querySelector('.btn-text').textContent = 'Start Simultaneous Recording';

      if (chrome.runtime.lastError || !response || response.status === 'FAILED') {
        const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : (response ? response.error : 'Unknown error');
        showAlert('Recording Initialization Failed', err);
      } else {
        elapsedSeconds = 0;
        isRecordingPaused = false;
        setUiState('RECORDING');
      }
    });
  });

  // Pause / Resume
  pauseResumeBtn.addEventListener('click', () => {
    const targetAction = isRecordingPaused ? 'RESUME_RECORDING' : 'PAUSE_RECORDING';
    chrome.runtime.sendMessage({ action: targetAction }, (res) => {
      if (res && (res.status === 'PAUSED' || res.status === 'RESUMED')) {
        isRecordingPaused = res.status === 'PAUSED';
        updateStatusPill(isRecordingPaused ? 'Paused' : 'Recording...', !isRecordingPaused);
        updatePauseBtnUi();
      }
    });
  });

  // Toggle Mute
  muteMicBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'TOGGLE_MUTE' }, (res) => {
      if (res && res.status === 'SUCCESS') {
        isMicMuted = res.muted;
        updateMuteBtnUi();
      }
    });
  });

  // Stop Recording
  stopBtn.addEventListener('click', () => {
    stopBtn.disabled = true;
    setUiState('ENCODING');
    chrome.runtime.sendMessage({ action: 'STOP_RECORDING' }, () => {
      stopBtn.disabled = false;
    });
  });

  clearHistoryBtn.addEventListener('click', async () => {
    await chrome.storage.local.set({ recordingsHistory: [] });
    await renderHistory();
  });
}

// 7. Listen for real-time runtime broadcasts
function setupRuntimeListeners() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'LIVE_AUDIO_LEVELS') {
      if (tabMeterBar) tabMeterBar.style.width = `${Math.min(100, Math.floor(message.tabLevel * 100))}%`;
      if (micMeterBar) {
        if (message.micMuted) {
          micMeterBar.style.width = '0%';
        } else {
          micMeterBar.style.width = `${Math.min(100, Math.floor(message.micLevel * 100))}%`;
        }
      }
      
      if (message.elapsedSeconds !== undefined && Math.abs(elapsedSeconds - message.elapsedSeconds) > 2) {
        elapsedSeconds = message.elapsedSeconds;
        updateTimerDisplay();
      }
    }

    if (message.type === 'ENCODING_WAV') {
      setUiState('ENCODING');
    }

    if (message.type === 'RECORDING_COMPLETE') {
      setUiState('IDLE');
      showAlert('Capture Completed', `Successfully saved mixed audio: ${message.filename}`, true);
      renderHistory();
    }

    if (message.action === 'FALLBACK_ANCHOR_DOWNLOAD') {
      console.log('Executing invisible anchor link download fallback in visible popup...');
      try {
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = message.url;
        a.download = message.filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => document.body.removeChild(a), 500);
      } catch (linkErr) {
        console.error('Anchor fallback download failed:', linkErr);
      }
    }
  });
}

function showAlert(title, text, isSuccess = false) {
  const alertIcon = document.getElementById('alertIcon');
  alertIcon.innerHTML = isSuccess ? SVG_ALERT_SUCCESS : SVG_ALERT_WARN;
  alertMessage.innerHTML = `<strong>${title}:</strong> ${text}`;
  alertBox.className = `alert-box ${isSuccess ? 'success' : ''}`;
}

// 8. Render Recordings History List
async function renderHistory() {
  try {
    const data = await chrome.storage.local.get({ recordingsHistory: [] });
    const list = data.recordingsHistory || [];

    historyList.innerHTML = '';

    if (list.length === 0) {
      historyList.innerHTML = `<div class="history-empty">No recordings yet in this session.</div>`;
      return;
    }

    list.forEach((item, index) => {
      const div = document.createElement('div');
      div.className = 'history-item';

      const formattedDuration = formatDuration(item.duration);
      const formattedSize = (item.fileSize / 1024 / 1024).toFixed(2) + ' MB';
      const formattedDate = new Date(item.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      div.innerHTML = `
        <div class="history-item-top">
          <span class="history-item-title" title="${item.title}">${item.title}</span>
          <span class="history-item-size">${formattedSize} (${formattedDuration})</span>
        </div>
        <div class="history-item-mid">
          <audio controls src="${item.url}" class="history-audio-player" preload="none"></audio>
        </div>
        <div class="history-item-actions">
          <span class="history-item-date">Saved at ${formattedDate}</span>
          <div class="history-btns">
            <button class="btn btn-outline btn-mini download-history-btn" data-url="${item.url}" data-filename="${item.filename}">
              <svg class="svg-icon" viewBox="0 0 24 24" style="width: 13px; height: 13px;">${SVG_DOWNLOAD}</svg>
              <span>Download</span>
            </button>
            <button class="btn btn-outline btn-mini delete-history-btn" data-index="${index}" title="Delete">
              <svg class="svg-icon" viewBox="0 0 24 24" style="width: 13px; height: 13px;">${SVG_TRASH}</svg>
            </button>
          </div>
        </div>
      `;

      const player = div.querySelector('.history-audio-player');
      player.addEventListener('error', () => {
        const mid = div.querySelector('.history-item-mid');
        mid.innerHTML = `<span style="font-size: 11px; color: var(--danger);">Audio buffer expired. Please open your physical computer Downloads folder.</span>`;
      });

      historyList.appendChild(div);
    });

    historyList.querySelectorAll('.download-history-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const targetBtn = e.target.closest('.download-history-btn');
        const url = targetBtn.getAttribute('data-url');
        const filename = targetBtn.getAttribute('data-filename');
        
        try {
          const check = await fetch(url);
          if (!check.ok) throw new Error('Expired blob');
          chrome.downloads.download({ url, filename, saveAs: true }).catch(() => {
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
          });
        } catch (expiredErr) {
          showAlert('Download Unavailable', 'This recording buffer expired. Please check your system standard Downloads directory where it was originally saved.');
        }
      });
    });

    historyList.querySelectorAll('.delete-history-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const idx = parseInt(e.target.closest('.delete-history-btn').getAttribute('data-index'), 10);
        list.splice(idx, 1);
        await chrome.storage.local.set({ recordingsHistory: list });
        renderHistory();
      });
    });

  } catch (err) {
    console.error('Error rendering history:', err);
  }
}

function formatDuration(sec) {
  if (!sec) return '00:00';
  const mins = Math.floor(sec / 60);
  const secs = Math.floor(sec % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}
