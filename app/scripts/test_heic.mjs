import fs from 'fs';
import heicConvert from 'heic-convert';

async function run() {
  console.log("Loading buffer...");
  const inputBuffer = fs.readFileSync('./data/Lasku varma työeläke.HEIC');
  console.log("Converting...", inputBuffer.length, "bytes");
  try {
    const outputBuffer = await heicConvert({
      buffer: inputBuffer,
      format: "JPEG",
      quality: 0.9,
    });
    console.log("Converted!", outputBuffer.length);
  } catch (err) {
    console.error("heic-convert failed:", err);
  }
}
run();
