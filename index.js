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
const candidateFontPaths = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf'
];

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

function escapeFfmpegFilterValue(value) {
  return value
    .replace(/\\/g, '/')
    .replace(/'/g, "\\\\'")
    .replace(/:/g, '\\:');
}

function resolveFontPath() {
  if (process.env.FFMPEG_FONT_PATH) {
    return process.env.FFMPEG_FONT_PATH;
  }

  return candidateFontPaths.find((candidatePath) => fs.existsSync(candidatePath)) || null;
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

async function renderTextOverlay(fileName, videoUrl, audioUrl, overlays) {
  const tmp = '/tmp';
  const uniqueId = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const fontPath = resolveFontPath();

  const videoFile = path.join(tmp, `v_${uniqueId}.mp4`);
  const audioFile = path.join(tmp, `a_${uniqueId}.mp3`);
  const outputFile = path.join(tmp, `out_${uniqueId}.mp4`);
  const createdFiles = [videoFile, audioFile, outputFile];

  if (!fontPath) {
    throw new Error(
      `No compatible TTF font found. Set FFMPEG_FONT_PATH to a readable .ttf file. Checked: ${candidateFontPaths.join(', ')}`
    );
  }

  try {
    console.log(`[${uniqueId}] Using font: ${fontPath}`);
    console.log(`[${uniqueId}] Downloading assets...`);
    await Promise.all([download(videoUrl, videoFile), download(audioUrl, audioFile)]);

    const filterParts = [`[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[vinit]`];
    let currentLabel = '[vinit]';

    overlays.forEach((overlay, index) => {
      const outputLabel = `[v${index + 1}]`;
      const textFile = path.join(tmp, `text_${uniqueId}_${index}.txt`);
      const cleanedText = overlay.text.replace(/[\[\]]/g, '');

      fs.writeFileSync(textFile, wrapText(cleanedText, 28), 'utf8');
      createdFiles.push(textFile);

      const escapedFont = escapeFfmpegFilterValue(fontPath);
      const escapedText = escapeFfmpegFilterValue(textFile);

      filterParts.push(
        `${currentLabel}drawtext=fontfile='${escapedFont}':textfile='${escapedText}':` +
        `fontcolor=white:fontsize=46:line_spacing=12:box=1:boxcolor=black@0.45:boxborderw=40:` +
        `x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,${overlay.start},${overlay.end})'${outputLabel}`
      );

      currentLabel = outputLabel;
    });

    const args = [
      '-stream_loop', '-1',
      '-i', videoFile,
      '-i', audioFile,
      '-filter_complex', filterParts.join(';'),
      '-map', currentLabel,
      '-map', '1:a',
      '-c:v', 'libx264',
      '-preset', 'superfast',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      '-shortest',
      '-y',
      outputFile
    ];

    console.log(`[${uniqueId}] Executing FFmpeg...`);
    execFileSync(ffmpegPath, args, { stdio: 'inherit' });

    await storage.bucket(BUCKET_NAME).upload(outputFile, {
      destination: fileName,
      metadata: { contentType: 'video/mp4' }
    });
    return `https://storage.googleapis.com/${BUCKET_NAME}/${fileName}`;
  } finally {
    createdFiles.forEach((file) => {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
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
