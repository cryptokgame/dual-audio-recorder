import { audioBufferToWav } from './wav-encoder.js';

let audioContext = null;
let mediaRecorder = null;
let recordedChunks = [];
let tabStream = null;
let micStream = null;
let tabGain = null;
let micGain = null;
let tabAnalyser = null;
let micAnalyser = null;
let levelInterval = null;

let recordingState = 'IDLE'; // IDLE, STARTING, RECORDING, PAUSED, STOPPING
let recordingStartTime = 0;
let totalPausedTime = 0;
let pauseStartTime = 0;
let recordedMetadata = {};

// 1. Handshake with Background Script when loaded
chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => {});

// 2. Listen for recording commands from Background Script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'START_AUDIO_RECORDING') {
    startRecording(message).then(success => {
      sendResponse({ status: success ? 'STARTED' : 'FAILED' });
    }).catch(err => {
      console.error('Error starting recording in offscreen:', err);
      sendResponse({ status: 'FAILED', error: err.message });
    });
    return true; // async channel
  }
  
  if (message.action === 'STOP_AUDIO_RECORDING') {
    stopRecording().then(() => {
      sendResponse({ status: 'STOPPED' });
    }).catch(err => {
      console.error('Error stopping recording in offscreen:', err);
      sendResponse({ status: 'FAILED', error: err.message });
    });
    return true;
  }

  if (message.action === 'PAUSE_AUDIO_RECORDING') {
    pauseRecording();
    sendResponse({ status: 'PAUSED' });
  }

  if (message.action === 'RESUME_AUDIO_RECORDING') {
    resumeRecording();
    sendResponse({ status: 'RESUMED' });
  }

  if (message.action === 'SET_MIC_MUTE') {
    setMicMute(message.muted);
    sendResponse({ status: 'MUTE_UPDATED', muted: message.muted });
  }
  
  if (message.action === 'GET_RECORDING_STATUS') {
    sendResponse(getCurrentStatus());
  }
});

async function startRecording({ streamId, tabId, tabTitle, micDeviceId }) {
  if (recordingState !== 'IDLE') {
    console.warn('Already active capture or stopping state, ignoring request.');
    return false;
  }

  recordingState = 'STARTING';
  recordedChunks = [];
  recordedMetadata = { tabId, tabTitle: tabTitle || 'Browser Tab', micDeviceId };

  // 1. Functionally Capture Browser Tab Audio Intercept via chromeMediaSourceId
  try {
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });
    console.log('Browser Tab audio stream captured successfully.');
  } catch (err) {
    console.error('Failed to capture tab audio intercept:', err);
    recordingState = 'IDLE';
    throw new Error('Could not connect to browser tab audio output. Please ensure you are recording an active open tab.');
  }

  // 2. Functionally Capture Physical Microphone Hardware
  // No synthetic dummy tracks. We request genuine physical audio access.
  try {
    const micConstraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    };

    if (micDeviceId && micDeviceId !== 'default') {
      micConstraints.audio.deviceId = micDeviceId;
    }

    micStream = await navigator.mediaDevices.getUserMedia(micConstraints);
    console.log('Genuine physical microphone stream captured successfully.');
  } catch (micErr) {
    console.error('Microphone capture failed or hardware locked:', micErr.message);
    recordingState = 'IDLE';
    if (tabStream) {
      tabStream.getTracks().forEach(t => t.stop());
      tabStream = null;
    }
    // Functional error that informs the backend to prompt the user or resolve the permission lock
    throw new Error(`Microphone access denied or hardware locked (${micErr.message}). Please click "Device Setup" in the extension popup to unlock media permissions.`);
  }

  // 3. Initialize Web Audio API AudioContext for uncompromised dual audio mixing
  audioContext = new AudioContext({ sampleRate: 48000 });
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }

  // Create Web Audio Sources
  const tabSource = audioContext.createMediaStreamSource(tabStream);
  const micSource = audioContext.createMediaStreamSource(micStream);

  // Create Gain Nodes for precise volume balancing and instant UI muting
  tabGain = audioContext.createGain();
  micGain = audioContext.createGain();
  tabGain.gain.value = 1.0;
  micGain.gain.value = 1.0;

  tabSource.connect(tabGain);
  micSource.connect(micGain);

  // Create Analysers for professional live UI VU meters
  tabAnalyser = audioContext.createAnalyser();
  micAnalyser = audioContext.createAnalyser();
  tabAnalyser.fftSize = 256;
  micAnalyser.fftSize = 256;

  tabGain.connect(tabAnalyser);
  micGain.connect(micAnalyser);

  // 4. Route Tab Audio back to computer speakers so user can still hear their call perfectly!
  // Note: We do NOT connect Mic Audio to speakers to prevent any feedback loops or audio echo.
  tabGain.connect(audioContext.destination);

  // 5. Create Merged MediaStream Destination for Real-Time Mix Recording
  const mixedDest = audioContext.createMediaStreamDestination();
  tabGain.connect(mixedDest);
  micGain.connect(mixedDest);

  // 6. Initialize high-performance native MediaRecorder on the Merged Mix Stream
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';

  mediaRecorder = new MediaRecorder(mixedDest.stream, { mimeType });

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      recordedChunks.push(event.data);
    }
  };

  // 7. Start active monitoring and capture
  recordingStartTime = Date.now();
  totalPausedTime = 0;
  recordingState = 'RECORDING';
  
  startLevelMonitor();

  mediaRecorder.start();
  console.log('Simultaneous tab and physical mic recording active.');
  return true;
}

function pauseRecording() {
  if (recordingState !== 'RECORDING' || !mediaRecorder) return;
  mediaRecorder.pause();
  recordingState = 'PAUSED';
  pauseStartTime = Date.now();
}

function resumeRecording() {
  if (recordingState !== 'PAUSED' || !mediaRecorder) return;
  mediaRecorder.resume();
  recordingState = 'RECORDING';
  totalPausedTime += (Date.now() - pauseStartTime);
}

function setMicMute(muted) {
  if (!micGain || !audioContext) return;
  micGain.gain.setValueAtTime(muted ? 0 : 1.0, audioContext.currentTime);
}

function getCurrentStatus() {
  const elapsed = recordingState === 'IDLE' ? 0 : Math.floor((Date.now() - recordingStartTime - (recordingState === 'PAUSED' ? (Date.now() - pauseStartTime) : 0) - totalPausedTime) / 1000);
  return {
    state: recordingState,
    elapsedSeconds: Math.max(0, elapsed),
    metadata: recordedMetadata,
    micMuted: micGain ? micGain.gain.value === 0 : false
  };
}

function startLevelMonitor() {
  if (levelInterval) clearInterval(levelInterval);
  const tabData = new Uint8Array(tabAnalyser.frequencyBinCount);
  const micData = new Uint8Array(micAnalyser.frequencyBinCount);

  levelInterval = setInterval(() => {
    if (recordingState !== 'RECORDING') return;

    tabAnalyser.getByteFrequencyData(tabData);
    micAnalyser.getByteFrequencyData(micData);

    const tabLevel = getAverageVolume(tabData) / 255;
    const micLevel = getAverageVolume(micData) / 255;

    const status = getCurrentStatus();

    chrome.runtime.sendMessage({
      type: 'LIVE_AUDIO_LEVELS',
      tabLevel,
      micLevel,
      elapsedSeconds: status.elapsedSeconds,
      state: status.state,
      micMuted: status.micMuted
    }).catch(() => {});
  }, 100);
}

function getAverageVolume(array) {
  let sum = 0;
  for (let i = 0; i < array.length; i++) {
    sum += array[i];
  }
  return array.length === 0 ? 0 : sum / array.length;
}

// Complete Rewrite of the Wave Encoding and Download Logic
function stopRecording() {
  return new Promise((resolve, reject) => {
    if (recordingState === 'IDLE' || recordingState === 'STOPPING') {
      resolve();
      return;
    }

    console.log('Stopping capture, orchestrating uncompressed 16-bit PCM WAV encoding...');
    recordingState = 'STOPPING';
    
    if (levelInterval) {
      clearInterval(levelInterval);
      levelInterval = null;
    }

    if (!mediaRecorder) {
      cleanupAudio();
      resolve();
      return;
    }

    mediaRecorder.onstop = async () => {
      try {
        const webmBlob = new Blob(recordedChunks, { type: mediaRecorder.mimeType });
        console.log(`Recorded raw audio Blob size: ${(webmBlob.size / 1024 / 1024).toFixed(2)} MB`);

        chrome.runtime.sendMessage({ type: 'ENCODING_WAV' }).catch(() => {});

        // 1. Decode WebM/Opus into a pristine Web Audio AudioBuffer
        const arrayBuffer = await webmBlob.arrayBuffer();
        const decodedBuffer = await audioContext.decodeAudioData(arrayBuffer);
        console.log(`Decoded Web Audio Buffer: ${decodedBuffer.numberOfChannels} channels, ${decodedBuffer.sampleRate} Hz, ${decodedBuffer.duration.toFixed(2)} sec`);

        // 2. Encode uncompressed AudioBuffer to Canonical 16-bit Linear PCM WAV Blob
        const wavBlob = audioBufferToWav(decodedBuffer);
        console.log(`Generated canonical 16-bit Linear PCM WAV Blob size: ${(wavBlob.size / 1024 / 1024).toFixed(2)} MB`);

        // 3. Construct descriptive professional filename
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        const cleanTitle = (recordedMetadata.tabTitle || 'Recording').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
        const filename = `DualAudioMix_${cleanTitle}_${timestamp}.wav`;

        // Create Object URL
        const wavUrl = URL.createObjectURL(wavBlob);

        // 4. Save recording metadata to local storage history
        await saveRecordingHistory({
          id: timestamp,
          filename: filename,
          title: recordedMetadata.tabTitle || 'Browser Call Mix',
          date: new Date().toISOString(),
          duration: decodedBuffer.duration,
          fileSize: wavBlob.size,
          url: wavUrl
        });

        // 5. Broadcast completion state
        chrome.runtime.sendMessage({
          type: 'RECORDING_COMPLETE',
          filename: filename,
          url: wavUrl
        }).catch(() => {});

        // 6. Critical Bug Fix: Functionally execute download via Background Service Worker
        // (Since chrome.downloads is completely undefined inside Manifest V3 offscreen documents)
        console.log('Sending EXECUTE_WAV_DOWNLOAD to Background Service Worker...');
        chrome.runtime.sendMessage({
          action: 'EXECUTE_WAV_DOWNLOAD',
          url: wavUrl,
          filename: filename
        }).catch(() => {});

        cleanupAudio();
        resolve();
      } catch (err) {
        console.error('Error during WAV encoding orchestration:', err);
        cleanupAudio();
        reject(err);
      }
    };

    try {
      mediaRecorder.stop();
    } catch (e) {
      cleanupAudio();
      resolve();
    }
  });
}

function cleanupAudio() {
  recordingState = 'IDLE';
  if (tabStream) {
    tabStream.getTracks().forEach(t => t.stop());
    tabStream = null;
  }
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }
  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  mediaRecorder = null;
  recordedChunks = [];
}

async function saveRecordingHistory(item) {
  try {
    const data = await chrome.storage.local.get({ recordingsHistory: [] });
    const list = data.recordingsHistory || [];
    list.unshift(item);
    const trimmed = list.slice(0, 20);
    await chrome.storage.local.set({ recordingsHistory: trimmed });
  } catch (err) {
    console.error('Failed to save metadata to storage history:', err);
  }
}
