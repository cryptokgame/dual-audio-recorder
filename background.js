// Background Service Worker (Manifest V3)
// Coordinates audio recording commands between Popup UI, Keyboard Hotkeys, Offscreen Audio Engine, and File Downloads.

let creatingOffscreenPromise = null;

async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) {
    return;
  }
  if (creatingOffscreenPromise) {
    await creatingOffscreenPromise;
    return;
  }
  creatingOffscreenPromise = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Simultaneous tab and physical mic audio recording for meetings and browser audio'
  });
  await creatingOffscreenPromise;
  creatingOffscreenPromise = null;
  console.log('Offscreen document fully initialized.');
}

function updateBadge(state) {
  if (state === 'RECORDING') {
    chrome.action.setBadgeText({ text: 'REC' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  } else if (state === 'PAUSED') {
    chrome.action.setBadgeText({ text: 'PAU' });
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'START_RECORDING') {
    handleStartRecording(message).then(res => {
      sendResponse(res);
    }).catch(err => {
      console.error('Start recording error in background:', err);
      sendResponse({ status: 'FAILED', error: err.message });
    });
    return true;
  }

  if (message.action === 'STOP_RECORDING') {
    handleStopRecording().then(res => sendResponse(res)).catch(err => sendResponse({ status: 'FAILED', error: err.message }));
    return true;
  }

  if (message.action === 'PAUSE_RECORDING') {
    chrome.runtime.sendMessage({ action: 'PAUSE_AUDIO_RECORDING' }).catch(() => {});
    updateBadge('PAUSED');
    sendResponse({ status: 'PAUSED' });
  }

  if (message.action === 'RESUME_RECORDING') {
    chrome.runtime.sendMessage({ action: 'RESUME_AUDIO_RECORDING' }).catch(() => {});
    updateBadge('RECORDING');
    sendResponse({ status: 'RESUMED' });
  }

  if (message.action === 'TOGGLE_MUTE') {
    chrome.runtime.sendMessage({ action: 'GET_RECORDING_STATUS' }, (status) => {
      if (status && status.state !== 'IDLE') {
        const newMute = !status.micMuted;
        chrome.runtime.sendMessage({ action: 'SET_MIC_MUTE', muted: newMute }).catch(() => {});
        sendResponse({ status: 'SUCCESS', muted: newMute });
      } else {
        sendResponse({ status: 'FAILED', error: 'No active recording session' });
      }
    });
    return true;
  }

  if (message.action === 'GET_STATUS') {
    chrome.runtime.sendMessage({ action: 'GET_RECORDING_STATUS' }, (status) => {
      if (chrome.runtime.lastError || !status) {
        sendResponse({ state: 'IDLE', elapsedSeconds: 0, metadata: {}, micMuted: false });
      } else {
        updateBadge(status.state);
        sendResponse(status);
      }
    });
    return true;
  }

  // Functional Execution of File Download from Offscreen Document
  if (message.action === 'EXECUTE_WAV_DOWNLOAD') {
    executeRobustDownload(message.url, message.filename);
  }

  if (message.type === 'RECORDING_COMPLETE') {
    updateBadge('IDLE');
    showNotification('Recording Saved', `Mixed audio successfully saved as ${message.filename}`);
  }
});

// Fully functional WAV Download Pipeline in Service Worker where chrome.downloads is defined
function executeRobustDownload(url, filename) {
  console.log('Executing robust WAV download via chrome.downloads API in Service Worker...');
  chrome.downloads.download({
    url: url,
    filename: filename,
    saveAs: false
  }, (downloadId) => {
    if (chrome.runtime.lastError) {
      const errMsg = chrome.runtime.lastError.message;
      console.warn('Chrome downloads API error/canceled in Service Worker:', errMsg);
      
      // If user didn't intentionally cancel, instruct visible popup to execute anchor link fallback
      if (!errMsg.toLowerCase().includes('canceled') && !errMsg.toLowerCase().includes('cancelled')) {
        console.log('Broadcasting FALLBACK_ANCHOR_DOWNLOAD to visible Popup UI...');
        chrome.runtime.sendMessage({
          action: 'FALLBACK_ANCHOR_DOWNLOAD',
          url: url,
          filename: filename
        }).catch(() => {});
      }
    } else {
      console.log('Flawless download initiated successfully with ID:', downloadId);
    }
  });
}

async function handleStartRecording({ tabId, tabTitle, micDeviceId }) {
  await ensureOffscreenDocument();

  let targetTabId = tabId;
  let targetTitle = tabTitle;

  if (!targetTabId) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length === 0) throw new Error('No active browser tab found to record.');
    targetTabId = tabs[0].id;
    targetTitle = tabs[0].title;
  }

  return new Promise((resolve) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId }, (streamId) => {
      if (chrome.runtime.lastError || !streamId) {
        const errMsg = chrome.runtime.lastError ? chrome.runtime.lastError.message : 'No stream ID generated by native tabCapture API.';
        console.error('tabCapture.getMediaStreamId failed:', errMsg);
        resolve({ status: 'FAILED', error: errMsg });
        return;
      }

      chrome.runtime.sendMessage({
        action: 'START_AUDIO_RECORDING',
        streamId,
        tabId: targetTabId,
        tabTitle: targetTitle,
        micDeviceId
      }, (response) => {
        if (chrome.runtime.lastError || !response || response.status === 'FAILED') {
          const errStr = chrome.runtime.lastError ? chrome.runtime.lastError.message : (response ? response.error : 'Offscreen audio intercept failed');
          console.error('Offscreen recording failure:', errStr);
          
          // If the functional microphone capture failed with permission dismissed or hardware locked, prompt setup
          if (errStr.toLowerCase().includes('permission') || errStr.toLowerCase().includes('locked') || errStr.toLowerCase().includes('denied')) {
            showNotification('Microphone Locked', 'Permission was denied or hardware is locked. Opening Device Setup to functionally unlock media access.');
            chrome.tabs.create({ url: 'setup.html' }).catch(() => {});
          }
          
          resolve({ status: 'FAILED', error: errStr });
        } else {
          updateBadge('RECORDING');
          resolve({ status: 'SUCCESS' });
        }
      });
    });
  });
}

// Keyboard Hotkey Command Listeners (Keeping exact hotkeys intact)
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-recording') {
    chrome.runtime.sendMessage({ action: 'GET_RECORDING_STATUS' }, async (status) => {
      if (!status || status.state === 'IDLE') {
        try {
          const prefs = await chrome.storage.local.get({ selectedMic: 'default' });
          await handleStartRecording({ micDeviceId: prefs.selectedMic });
          showNotification('Dual Audio Recorder', 'Simultaneous active tab and physical microphone recording started.');
        } catch (err) {
          showNotification('Capture Initialization Error', err.message);
        }
      } else if (status.state === 'RECORDING' || status.state === 'PAUSED') {
        await handleStopRecording();
        showNotification('Dual Audio Recorder', 'Recording stopped. Formatting 16-bit PCM WAV file...');
      }
    });
  }

  if (command === 'toggle-mute') {
    chrome.runtime.sendMessage({ action: 'GET_RECORDING_STATUS' }, (status) => {
      if (status && status.state !== 'IDLE') {
        const newMute = !status.micMuted;
        chrome.runtime.sendMessage({ action: 'SET_MIC_MUTE', muted: newMute }).catch(() => {});
        showNotification('Dual Audio Recorder', newMute ? 'Microphone Muted' : 'Microphone Unmuted');
      }
    });
  }
});

async function handleStopRecording() {
  updateBadge('IDLE');
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'STOP_AUDIO_RECORDING' }, () => {
      if (chrome.runtime.lastError) {
        resolve({ status: 'FAILED', error: chrome.runtime.lastError.message });
      } else {
        resolve({ status: 'SUCCESS' });
      }
    });
  });
}

function showNotification(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon48.png',
    title: title,
    message: message,
    priority: 1
  }).catch(() => {});
}
