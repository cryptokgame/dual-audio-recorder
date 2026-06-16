// Setup Engine for Standalone Dedicated Device Authorization Tab

const authorizeBtn = document.getElementById('authorizeBtn');
const deviceSelect = document.getElementById('deviceSelect');
const canvasMeter = document.getElementById('canvasMeter');
const successAlert = document.getElementById('successAlert');
const permissionStep = document.getElementById('permissionStep');

let audioContext = null;
let activeStream = null;
let analyserNode = null;
let visualizerFrame = null;
let selectedDeviceId = 'default';

document.addEventListener('DOMContentLoaded', async () => {
  await loadSavedPreference();
  await checkExistingPermission();
});

async function loadSavedPreference() {
  const prefs = await chrome.storage.local.get({ selectedMic: 'default' });
  selectedDeviceId = prefs.selectedMic;
}

// Check if we already have fully unlocked labels
async function checkExistingPermission() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(d => d.kind === 'audioinput');

    // If we see genuine device labels (not empty), permission is already active
    if (audioInputs.some(d => d.label.length > 0)) {
      showAuthorizedState();
      await populateDropdown(audioInputs);
      await startLiveVisualizer(selectedDeviceId);
    }
  } catch (err) {
    console.warn('Could not enumerate on boot:', err);
  }
}

authorizeBtn.addEventListener('click', async () => {
  authorizeBtn.disabled = true;
  authorizeBtn.querySelector('span').textContent = 'Requesting Native Chrome Prompt...';

  try {
    // This triggers Chrome's top-left native permission bar
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    // Switch to active test stream
    activeStream = stream;
    
    showAuthorizedState();
    
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(d => d.kind === 'audioinput');
    await populateDropdown(audioInputs);
    
    await startLiveVisualizer(selectedDeviceId, stream);
    successAlert.classList.remove('hidden');
  } catch (err) {
    console.error('Microphone authorization denied or canceled:', err);
    authorizeBtn.disabled = false;
    authorizeBtn.querySelector('span').textContent = 'Grant Microphone Permission';
    alert('Permission was denied. Please click the site settings icon (padlock/tune) in the Chrome address bar, allow Microphone, and reload this page.');
  }
});

function showAuthorizedState() {
  authorizeBtn.classList.add('btn-success');
  authorizeBtn.querySelector('span').textContent = 'Microphone Authorized';
  permissionStep.style.opacity = '0.7';
}

async function populateDropdown(audioInputs) {
  deviceSelect.innerHTML = '';
  
  audioInputs.forEach(device => {
    const opt = document.createElement('option');
    opt.value = device.deviceId;
    opt.textContent = device.label || `Microphone (${device.deviceId.substring(0, 5)})`;
    if (device.deviceId === selectedDeviceId) {
      opt.selected = true;
    }
    deviceSelect.appendChild(opt);
  });
}

deviceSelect.addEventListener('change', async (e) => {
  selectedDeviceId = e.target.value;
  await chrome.storage.local.set({ selectedMic: selectedDeviceId });
  
  // Restart visualizer with new device
  await startLiveVisualizer(selectedDeviceId);
  successAlert.classList.remove('hidden');
});

async function startLiveVisualizer(deviceId, optionalStream = null) {
  // Clean up old
  if (visualizerFrame) cancelAnimationFrame(visualizerFrame);
  if (activeStream && !optionalStream) {
    activeStream.getTracks().forEach(t => t.stop());
  }
  if (audioContext && !optionalStream) {
    await audioContext.close();
    audioContext = null;
  }

  try {
    let stream = optionalStream;
    if (!stream) {
      const constraints = {
        audio: deviceId === 'default' ? true : { deviceId: { exact: deviceId } }
      };
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      activeStream = stream;
    }

    audioContext = new AudioContext();
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 256;

    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyserNode);

    drawCanvas();
  } catch (err) {
    console.error('Visualizer capture error:', err);
  }
}

function drawCanvas() {
  const canvas = canvasMeter;
  const ctx = canvas.getContext('2d');
  const bufferLength = analyserNode.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function render() {
    visualizerFrame = requestAnimationFrame(render);

    analyserNode.getByteFrequencyData(dataArray);

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const barWidth = (canvas.width / bufferLength) * 2.5;
    let barHeight;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      barHeight = dataArray[i] / 4; // Scale nicely

      // Premium gradient
      const gradient = ctx.createLinearGradient(0, canvas.height, 0, 0);
      gradient.addColorStop(0, '#3b82f6'); // primary
      gradient.addColorStop(1, '#10b981'); // success

      ctx.fillStyle = gradient;
      ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);

      x += barWidth + 1;
    }
  }

  render();
}
