import functions from '@google-cloud/functions-framework';
import { Storage } from '@google-cloud/storage';
import { spawnSync } from 'child_process';
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
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 30000,
    maxRedirects: 5,
    validateStatus: (status) => status >= 200 && status < 300
  });

  return new Promise((resolve, reject) => {
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      writer.destroy();
      reject(err);
    };

    writer.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve();
    });

    writer.on('error', fail);
    response.data.on('error', fail);
    response.data.on('aborted', () => fail(new Error(`Download aborted: ${url}`)));
    response.data.on('close', () => {
      if (!response.data.complete && !settled) {
        fail(new Error(`Download closed before completion: ${url}`));
      }
    });

    response.data.pipe(writer);
  });
}

function runCommand(command, args, label) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';

  if (stdout.trim()) {
    console.log(`[${label}] stdout:\n${stdout}`);
  }

  if (stderr.trim()) {
    console.log(`[${label}] stderr:\n${stderr}`);
  }

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}${stderr ? `\n${stderr}` : ''}`);
  }

  return { stdout, stderr };
}

function validateDownloadedFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} file was not created: ${filePath}`);
  }

  const stats = fs.statSync(filePath);
  console.log(`[${label}] path=${filePath} bytes=${stats.size}`);

  if (stats.size <= 0) {
    throw new Error(`${label} file is empty: ${filePath}`);
  }

  return stats;
}

function validateAudioFile(audioFile, uniqueId) {
  validateDownloadedFile(audioFile, `${uniqueId} audio`);

  runCommand(
    ffmpegPath,
    ['-v', 'error', '-i', audioFile, '-map', '0:a:0', '-f', 'null', '-'],
    `${uniqueId} audio-validate`
  );
}

function validateVideoFile(videoFile, uniqueId) {
  validateDownloadedFile(videoFile, `${uniqueId} video`);

  runCommand(
    ffmpegPath,
    ['-v', 'error', '-i', videoFile, '-map', '0:v:0', '-frames:v', '1', '-f', 'null', '-'],
    `${uniqueId} video-validate`
  );
}

async function renderTextOverlay(fileName, videoUrl, audioUrl, overlays) {
  const tmp = '/tmp';
  const uniqueId = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;

  const videoFile = path.join(tmp, `v_${uniqueId}.mp4`);
  const audioFile = path.join(tmp, `a_${uniqueId}.mp3`);
  const outputFile = path.join(tmp, `out_${uniqueId}.mp4`);
  const createdFiles = [videoFile, audioFile, outputFile];

  try {
    console.log(`[${uniqueId}] Downloading assets...`);
    await Promise.all([download(videoUrl, videoFile), download(audioUrl, audioFile)]);

    validateVideoFile(videoFile, uniqueId);
    validateAudioFile(audioFile, uniqueId);

    const filterParts = [`[0:v]loop=loop=-1:size=30000:start=0,scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[vinit]`];

    overlays.forEach((overlay, index) => {
      const inputLabel = index === 0 ? '[vinit]' : `[v${index}]`;
      const outputLabel = `[v${index + 1}]`;

      const textFile = path.join(tmp, `text_${uniqueId}_${index}.txt`);
      fs.writeFileSync(textFile, wrapText(overlay.text.replace(/[\[\]]/g, ''), 28), 'utf8');
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
      '-map', '1:a:0',
      '-c:v', 'libx264',
      '-preset', 'superfast',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-ac', '2',
      '-ar', '48000',
      '-b:a', '192k',
      '-movflags', '+faststart',
      '-shortest',
      '-y',
      outputFile
    ];

    console.log(`[${uniqueId}] Executing FFmpeg...`);
    runCommand(ffmpegPath, args, `${uniqueId} render`);

    validateDownloadedFile(outputFile, `${uniqueId} output`);

    await storage.bucket(BUCKET_NAME).upload(outputFile, { destination: fileName });
    return `https://storage.googleapis.com/${BUCKET_NAME}/${fileName}`;
  } finally {
    createdFiles.forEach((f) => {
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
