/**
 * One-time fetch of the text-generation model into public/models/, so the
 * app can serve it from its own origin instead of downloading it from
 * Hugging Face at runtime (measured at ~150-170 KB/s for this project,
 * which dominated the whole detection-to-display flow).
 *
 *   npm run fetch-model
 *
 * This is a BUILD/SETUP step, not application code - nothing here ships to
 * the browser. Run it once after cloning, and again if TEXT_MODEL_ID or the
 * dtype set in src/config/textModel.config.js ever changes.
 *
 * The downloaded weights are gitignored: the two ONNX files are 118MB and
 * 182MB, and GitHub hard-rejects any file over 100MB. For deployment, the
 * same directory is uploaded to a static host / CDN and pointed at with
 * VITE_MODEL_HOST - see .env.example.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, stat, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Upstream source. Kept in one place so it is obvious this is the ONLY
// point at which Hugging Face is involved - setup time, never runtime.
const SOURCE_REPO = 'HuggingFaceTB/SmolLM2-135M-Instruct';
const SOURCE_REVISION = 'main';

// Must match TEXT_MODEL_ID in src/config/textModel.config.js.
const MODEL_DIR_NAME = 'SmolLM2-135M-Instruct';

/**
 * Exactly the files transformers.js requests for a decoder-only
 * text-generation model, verified against the installed library source:
 *   - config.json          configs.js:54          (required)
 *   - tokenizer.json       tokenizers.js:70       (required)
 *   - tokenizer_config.json tokenizers.js:71      (required, holds the chat template)
 *   - generation_config.json models.js            (optional but requested)
 *   - onnx/model_<dtype>.onnx                     (one per backend)
 *
 * Deliberately NOT included: model.safetensors (269MB, the PyTorch weights
 * - unused by ONNX Runtime), vocab.json/merges.txt (already embedded in
 * tokenizer.json's fast-tokenizer format), and the training artifacts.
 * Copying the whole repo would roughly double the download for no benefit.
 */
const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'generation_config.json',
  // Backend preference in textModel.config.js: WebGPU -> q4f16, WASM -> q4.
  'onnx/model_q4f16.onnx',
  'onnx/model_q4.onnx',
];

const targetDir = join(ROOT, 'public', 'models', MODEL_DIR_NAME);

function mb(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

async function alreadyComplete(dest, expectedBytes) {
  try {
    const info = await stat(dest);
    // A partial file from an interrupted run must not be treated as done.
    return expectedBytes !== null && info.size === expectedBytes;
  } catch {
    return false;
  }
}

async function fetchFile(file) {
  const url = `https://huggingface.co/${SOURCE_REPO}/resolve/${SOURCE_REVISION}/${file}`;
  const dest = join(targetDir, file);
  await mkdir(dirname(dest), { recursive: true });

  const head = await fetch(url, { method: 'HEAD', redirect: 'follow' });
  const expected = head.ok && head.headers.get('content-length')
    ? Number(head.headers.get('content-length'))
    : null;

  if (await alreadyComplete(dest, expected)) {
    console.log(`  skip   ${file} (already present, ${mb(expected)})`);
    return;
  }

  const started = Date.now();
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`${file}: HTTP ${res.status} ${res.statusText}`);
  }

  // Stream to disk rather than buffering - the q4 file is 182MB.
  try {
    await streamPipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  } catch (err) {
    // Never leave a truncated file behind; it would look valid next run.
    await rm(dest, { force: true });
    throw err;
  }

  const { size } = await stat(dest);
  if (expected !== null && size !== expected) {
    await rm(dest, { force: true });
    throw new Error(`${file}: incomplete (${size} of ${expected} bytes)`);
  }

  const secs = (Date.now() - started) / 1000;
  console.log(`  ok     ${file} (${mb(size)} in ${secs.toFixed(1)}s, ${mb(size / secs)}/s)`);
}

async function main() {
  console.log(`Fetching ${SOURCE_REPO} -> public/models/${MODEL_DIR_NAME}/`);
  console.log('This is a one-time setup step and may be slow.\n');

  let total = 0;
  for (const file of FILES) {
    await fetchFile(file);
    try {
      total += (await stat(join(targetDir, file))).size;
    } catch { /* counted only for the summary */ }
  }

  console.log(`\nDone. ${FILES.length} files, ${mb(total)} total.`);
  console.log('`npm run dev` will now serve the model from this origin.');
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
