import functions from '@google-cloud/functions-framework';
import { Storage } from '@google-cloud/storage';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffmpegStatic from 'ffmpeg-static';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fontPath = path.join(__dirname, 'node_modules/@fontsource/roboto/files/roboto-latin-700-normal.woff');

const storage = new Storage();
const BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'ssm-renders-8822';
const ffmpegPath = process.env.FFMPEG_PATH || ffmpegInstaller.path || ffmpegStatic;

// 1. Text wrapping remains the same
function wrapText(text, maxWidth) {
  const words = text.split(' ');
  let lines = [];
  let currentLine = words[0];
  for (let i = 1; i < words.length; i++) {
    if (currentLine.length + 1 + words[i].length <= maxWidth) {
      currentLine += ' ' + words[i];
    } else {
      lines.push(currentLine);
      currentLine = words[i];
    }
  }
  lines.push(currentLine);
  return lines.join('\n');
}

// 2. Download helper remains the same
async function download(url, dest) {
  const writer = fs.createWriteStream(dest);
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// ... (Imports and fontPath remain the same)

async function renderTextOverlay(fileName, videoUrl, audioUrl, overlays) {
  const tmp = '/tmp';
  // 1. GENERATE A TRULY UNIQUE ID INSIDE THE FUNCTION
  const uniqueId = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  
  const videoFile = path.join(tmp, `v_${uniqueId}.mp4`);
  const audioFile = path.join(tmp, `a_${uniqueId}.mp3`);
  const outputFile = path.join(tmp, `out_${uniqueId}.mp4`);
  const createdFiles = [videoFile, audioFile, outputFile];

  try {
    console.log(`[${uniqueId}] Downloading assets...`);
    await Promise.all([download(videoUrl, videoFile), download(audioUrl, audioFile)]);

    // 2. FIX THE LABEL INDEXING (Input [v0] -> Output [v1])
    const filterParts = [`[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[vinit]`];

    overlays.forEach((overlay, index) => {
      const inputLabel = index === 0 ? '[vinit]' : `[v${index}]`;
      const outputLabel = `[v${index + 1}]`;
      
      // 3. USE UNIQUE TEXT FILENAMES TO PREVENT COLLISION
      const textFile = path.join(tmp, `text_${uniqueId}_${index}.txt`);
      fs.writeFileSync(textFile, wrapText(overlay.text.replace(/[\[\]]/g, ""), 28), 'utf8');
      createdFiles.push(textFile);

      const escapedFont = fontPath.replace(/\\/g, '/').replace(/:/g, '\\:');
      const escapedText = textFile.replace(/\\/g, '/').replace(/:/g, '\\:');

      filterParts.push(
        `${inputLabel}drawtext=fontfile='${escapedFont}':textfile='${escapedText}':` +
        `fontcolor=white:fontsize=46:line_spacing=12:box=1:boxcolor=black@0.45:boxborderw=40:` +
        `x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,${overlay.start},${overlay.end})'${outputLabel}`
      );
    });

    const lastVideoLabel = `[v${overlays.length}]`;

    const args = [
      '-i', videoFile,
      '-i', audioFile,
      '-filter_complex', filterParts.join(';'),
      '-map', lastVideoLabel, 
      '-map', '1:a',          // 4. MAP AUDIO DIRECTLY (Removes anull overhead)
      '-c:v', 'libx264',
      '-preset', 'superfast', 
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      '-y',
      outputFile
    ];

    console.log(`[${uniqueId}] Executing FFmpeg...`);
    execFileSync(ffmpegPath, args);

    await storage.bucket(BUCKET_NAME).upload(outputFile, { destination: fileName });
    return `https://storage.googleapis.com/${BUCKET_NAME}/${fileName}`;

  } finally {
    // 5. GUARANTEED CLEANUP (Prevents /tmp disk exhaustion)
    createdFiles.forEach(f => {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });
  }
}

functions.http('ffmpegTextOverlay', async (req, res) => {
  const { videoUrl, audioUrl, overlays } = req.body;
  if (!videoUrl || !audioUrl || !Array.isArray(overlays)) {
    return res.status(400).json({ error: 'videoUrl, audioUrl, overlays required' });
  }

  const fileName = `overlay_${Date.now()}.mp4`;

  try {
    const url = await renderTextOverlay(fileName, videoUrl, audioUrl, overlays);
    res.status(200).json({ status: 'completed', url });
  } catch (err) {
    console.error('Render failed:', err);
    res.status(500).json({ error: err.message });
  }
});
