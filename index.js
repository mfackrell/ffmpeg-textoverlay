import functions from '@google-cloud/functions-framework';
import { Storage } from '@google-cloud/storage';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

// 1. Get the library-provided path for FFmpeg
import ffmpegPath from 'ffmpeg-static';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// 2. Get the library-provided path for the Font
const fontPath = require.resolve('@fontsource/roboto/files/roboto-latin-700-normal.woff');

const storage = new Storage();
const BUCKET_NAME = process.env.GCS_BUCKET_NAME || 'ssm-renders-8822';

// ... (keep your wrapText and download functions exactly as they are) ...

async function renderTextOverlay(fileName, videoUrl, overlays) {
  const tmp = '/tmp';
  const videoFile = path.join(tmp, 'input_video.mp4');
  const outputFile = path.join(tmp, fileName);
  
  await download(videoUrl, videoFile);

  let filterChain = '[0:v]';
  let lastLabel = '[0:v]';
  
  overlays.forEach((overlay, index) => {
    const nextLabel = `[v${index}]`;
    const cleanText = overlay.text.replace(/[\[\]]/g, "");
    const wrappedText = wrapText(cleanText, 25);
    const sanitizedText = wrappedText.replace(/:/g, "\\:").replace(/'/g, "\\'");

    // 3. Escape the fontPath specifically for FFmpeg's filter engine
    const escapedFontPath = fontPath.replace(/\\/g, '/').replace(/:/g, '\\:');

    const drawText =
      `drawtext=fontfile='${escapedFontPath}':` +
      `text='${sanitizedText}':` +
      `fontcolor=white:fontsize=36:line_spacing=20:wrap=1:box=1:boxw=w*0.8:boxcolor=black@0.5:boxborderw=20:text_align=center:x=(w-boxw)/2:y=(h-text_h)/2:enable='between(t,${overlay.start},${overlay.end})'`;

    if (index === 0) {
      filterChain += `${drawText}${nextLabel}`;
    } else {
      filterChain += `;${lastLabel}${drawText}${nextLabel}`;
    }
    lastLabel = nextLabel;
  });

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

  // 4. Use the absolute library path here
  console.log('Executing FFmpeg at:', ffmpegPath);
  execFileSync(ffmpegPath, args);

  await storage.bucket(BUCKET_NAME).upload(outputFile, { destination: fileName });
  return `https://storage.googleapis.com/${BUCKET_NAME}/${fileName}`;
}

// ... (keep your functions.http wrapper exactly as it is) ...
