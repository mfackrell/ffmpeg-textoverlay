import functions from '@google-cloud/functions-framework';
import { Storage } from '@google-cloud/storage';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';

// 1. Get the library-provided path for FFmpeg
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffmpegStatic from 'ffmpeg-static';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 2. Correct way to find the font path in ES Modules
const fontPath = path.join(__dirname, 'node_modules/@fontsource/roboto/files/roboto-latin-700-normal.woff');

const storage = new Storage();
const BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'ssm-renders-8822';
const ffmpegPath = process.env.FFMPEG_PATH || ffmpegInstaller.path || ffmpegStatic;

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

async function renderTextOverlay(fileName, videoUrl, overlays) {
  const tmp = '/tmp';
  const videoFile = path.join(tmp, 'input_video.mp4');
  const outputFile = path.join(tmp, fileName);
  
  console.log('Downloading input video...', videoUrl);
  await download(videoUrl, videoFile);

  const filterParts = [];
  let lastLabel = '[0:v]';

  overlays.forEach((overlay, index) => {
    const inputLabel = index === 0 ? '[0:v]' : `[v${index - 1}]`;
    const outputLabel = `[v${index}]`;
    const cleanText = overlay.text.replace(/[\[\]]/g, "");
    const wrappedText = wrapText(cleanText, 25);
    const textFile = path.join(tmp, `overlay_${index}.txt`);
    fs.writeFileSync(textFile, wrappedText, 'utf8');

    // Escape the fontPath for FFmpeg's filter engine
    const escapedFontPath = fontPath.replace(/\\/g, '/').replace(/:/g, '\\:');
    const escapedTextFile = textFile.replace(/\\/g, '/').replace(/:/g, '\\:');

    const drawText =
      `${inputLabel}drawtext=fontfile='${escapedFontPath}':` +
      `textfile='${escapedTextFile}':` +
      `fontcolor=white:fontsize=36:line_spacing=20:box=1:boxcolor=black@0.5:boxborderw=20:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,${overlay.start},${overlay.end})'` +
      `${outputLabel}`;

    filterParts.push(drawText);
    lastLabel = outputLabel;
  });

  const filterChain = filterParts.join(';');

  const args = [
    '-i', videoFile,
    '-filter_complex', filterChain,
    '-map', lastLabel,
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-c:a', 'copy',
    '-y',
    outputFile
  ];

  console.log('Executing FFmpeg...');
  execFileSync(ffmpegPath, args);

  console.log(`Uploading ${fileName}...`);
  await storage.bucket(BUCKET_NAME).upload(outputFile, { destination: fileName });

  return `https://storage.googleapis.com/${BUCKET_NAME}/${fileName}`;
}

// 3. THE MISSING WRAPPER: This allows Cloud Run to "see" your function
functions.http('ffmpegTextOverlay', async (req, res) => {
  const body = req.body;
  if (!body.videoUrl || !body.overlays || !Array.isArray(body.overlays)) {
    return res.status(400).json({ error: 'Payload must include videoUrl and overlays array.' });
  }

  const fileName = `overlay_${Date.now()}.mp4`;

  try {
    const url = await renderTextOverlay(fileName, body.videoUrl, body.overlays);
    res.status(200).json({ status: 'completed', url });
  } catch (err) {
    console.error('Render failed:', err);
    res.status(500).json({ error: err.message });
  }
});
