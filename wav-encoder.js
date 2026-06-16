// High-quality, robust PCM WAV Encoder
// Converts an uncompressed Web Audio API AudioBuffer into a pristine 16-bit PCM WAV Blob.

export function audioBufferToWav(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // 1 = Linear PCM
  const bitDepth = 16; // 16-bit audio
  
  // 44 bytes for RIFF/WAVE headers + PCM data size
  const blockAlign = numChannels * (bitDepth / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = buffer.length * blockAlign;
  const bufferSize = 44 + dataSize;
  
  const arrayBuffer = new ArrayBuffer(bufferSize);
  const view = new DataView(arrayBuffer);
  
  // 1. RIFF Chunk Descriptor
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true); // Total file size minus 8
  writeString(view, 8, 'WAVE');
  
  // 2. fmt Subchunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, format, true); // AudioFormat
  view.setUint16(22, numChannels, true); // NumChannels
  view.setUint32(24, sampleRate, true); // SampleRate
  view.setUint32(28, byteRate, true); // ByteRate
  view.setUint16(32, blockAlign, true); // BlockAlign
  view.setUint16(34, bitDepth, true); // BitsPerSample
  
  // 3. data Subchunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true); // Subchunk2Size
  
  // 4. Write uncompressed PCM samples
  const channelBuffers = [];
  for (let i = 0; i < numChannels; i++) {
    channelBuffers.push(buffer.getChannelData(i));
  }
  
  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let channel = 0; channel < numChannels; channel++) {
      let sample = channelBuffers[channel][i];
      // Hard clamping to prevent integer overflow/underflow distortion
      sample = Math.max(-1, Math.min(1, sample));
      // Convert Float32 (-1.0 to 1.0) to Int16 (-32768 to 32767)
      const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(offset, intSample, true);
      offset += 2;
    }
  }
  
  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}
