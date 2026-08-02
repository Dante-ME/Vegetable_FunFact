# Hosting the text model on your own Hugging Face repository

The app downloads its text-generation model straight from the Hugging Face
Hub with Transformers.js. Which repo it downloads from is controlled by one
build-time variable:

```
VITE_HF_MODEL_ID=<your-username>/SmolLM2-135M-Instruct
```

If that variable is unset the app uses `DanteME/SmolLM2-135M-Instruct`, this
project's own copy of the model, so a fresh clone runs with no configuration.

This document is the full procedure for creating your own copy of the model
and pointing the app at it.

---

## 1. Repository type

**Model repository.** Not a Dataset, not a Space.

On <https://huggingface.co/new> the "Model" tab is the default. Transformers.js
resolves files as `https://huggingface.co/<owner>/<name>/resolve/main/<file>`,
which is the model-repo URL layout; dataset repos live under a different
prefix (`/datasets/...`) and would not resolve.

| Field | Value |
| --- | --- |
| Owner | your username (or an org you belong to) |
| Model name | `SmolLM2-135M-Instruct` |
| License | `apache-2.0` (SmolLM2's upstream license — keep it) |
| Visibility | **Public** (see below) |

Keeping the name identical to upstream is convenient but not required. If you
rename it, use the new name in `VITE_HF_MODEL_ID` and avoid `--` in the name —
Transformers.js validates the id with `isValidHfModelId()` and rejects that
sequence before making any request.

## 2. Public or private?

**Public. This is a requirement, not a preference.**

The model is fetched by the visitor's browser, from client-side JavaScript,
with no credentials attached. A private repo answers those requests with
`401`, and the only way to make it work would be to embed a Hugging Face
access token in the bundle — where anyone can read it with View Source. A
leaked token is usable against your whole account, so a private repo here is
strictly worse than a public one: it does not protect the weights and it does
expose your account.

The weights themselves are a verbatim copy of a publicly available Apache-2.0
model, so there is nothing to keep private in the first place.

## 3. What to upload

`npm run fetch-model` used to place exactly the needed files in
`public/models/SmolLM2-135M-Instruct/`. Those files have been moved to
**`model-upload/SmolLM2-135M-Instruct/`** in this repo (gitignored) — that
directory *is* the upload payload, already correct and complete.

If you no longer have it, download the same six files from
<https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct>.

| File | Size | Why it is needed |
| --- | ---: | --- |
| `config.json` | 861 B | Model architecture; first file Transformers.js requests |
| `tokenizer.json` | 2.1 MB | Fast-tokenizer vocab + merges |
| `tokenizer_config.json` | 3.8 KB | Holds the **chat template** — generation is chat-formatted, so this is mandatory |
| `generation_config.json` | 132 B | Default generation params / special token ids |
| `onnx/model_q4f16.onnx` | 117.7 MB | Weights used on the **WebGPU** backend |
| `onnx/model_q4.onnx` | 182.1 MB | Weights used on the **WASM** fallback backend |

**Total: ~302 MB.**

Both ONNX files are required: the app tries WebGPU first and falls back to
WASM, and each backend requests its own dtype variant
(`TEXT_MODEL_DTYPE_BY_BACKEND` in [textModel.config.js](../src/config/textModel.config.js)).
Upload only one and half your visitors get a load failure.

### What NOT to upload

- `model.safetensors` (~269 MB) — PyTorch weights, unused by ONNX Runtime Web.
- `onnx/model.onnx`, `model_fp16.onnx`, `model_q8.onnx`, `model_uint8.onnx`, etc.
  — other dtype variants this app never requests.
- `vocab.json` / `merges.txt` — already embedded inside `tokenizer.json`.
- Training artifacts, `.gitattributes` from your local copy (the Hub creates
  its own).

Uploading them is harmless for the app (nothing requests them) but bloats the
repo and your storage quota.

## 4. Folder structure in the repo

The layout must match upstream exactly — in particular the `onnx/`
subdirectory, because Transformers.js builds the weight path as
`onnx/model_<dtype>.onnx` relative to the repo root.

```
<your-username>/SmolLM2-135M-Instruct
├── README.md                  (auto-created model card; optional to edit)
├── config.json
├── generation_config.json
├── tokenizer.json
├── tokenizer_config.json
└── onnx/
    ├── model_q4f16.onnx
    └── model_q4.onnx
```

A flattened repo (ONNX files at the root) will 404 at load time.

## 5. Is Git LFS required?

**Yes for the two `.onnx` files — but you usually do not manage it yourself.**

Every Hugging Face repo is a Git repo with LFS enabled and a `.gitattributes`
that already tracks `*.onnx` (among ~40 binary patterns). Files over 10 MB
must go through LFS; the Hub hard-rejects a non-LFS file over 50 MB. So:

| Upload method | LFS handling |
| --- | --- |
| Web UI (drag & drop) | Automatic — the browser uploads to LFS storage for you. Nothing to install. |
| `hf upload` CLI / `huggingface_hub` Python | Automatic — uses the HTTP upload API, no local LFS needed. |
| `git push` | **Manual** — you must have `git-lfs` installed (`git lfs install`) before committing, or the push is rejected. |

Recommendation: use the CLI (option B below). It is the least error-prone for
300 MB of binaries, and resumes if the connection drops.

### Option A — Web UI (no tooling)

1. Open your new repo → **Files and versions** → **Add file** → **Upload files**.
2. Drag `config.json`, `generation_config.json`, `tokenizer.json`,
   `tokenizer_config.json` into the drop zone. Commit.
3. **Add file → Upload files** again. Before dropping the ONNX files, type
   `onnx/` into the filename/path box so they land in the subfolder — or drag
   the whole `onnx` folder in, which preserves the path automatically.
4. Commit. The two large files are stored as LFS pointers; the UI shows an
   "LFS" badge and "Stored with Git LFS" on each file page.

### Option B — CLI (recommended)

```bash
pip install -U "huggingface_hub[cli]"
hf auth login                      # paste a token with WRITE permission

hf upload <your-username>/SmolLM2-135M-Instruct \
  ./model-upload/SmolLM2-135M-Instruct \
  --repo-type model
```

`hf upload` creates the repo if it does not exist, walks the local directory,
preserves the `onnx/` subfolder, and routes large files through LFS storage
automatically. (On `huggingface_hub` older than 0.34 the command is
`huggingface-cli upload` with the same arguments.)

### Option C — git push

```bash
git lfs install
git clone https://huggingface.co/<your-username>/SmolLM2-135M-Instruct
cd SmolLM2-135M-Instruct
cp -r ../model-upload/SmolLM2-135M-Instruct/* .
git add .
git commit -m "Add ONNX weights for Transformers.js"
git push
```

Do not skip `git lfs install` — without it the ONNX files are committed as
raw blobs and the push fails.

## 6. Point the app at your repo

Create a `.env` file in the project root (it is gitignored):

```
VITE_HF_MODEL_ID=<your-username>/SmolLM2-135M-Instruct
```

Vite inlines `import.meta.env.*` at **build time**, so this must be set
wherever you build — on Vercel/Netlify/Cloudflare Pages, add it as an
environment variable in the project's build settings, then redeploy. Changing
it later requires a rebuild, not just a restart.

Then:

```bash
npm run dev     # or: npm run build && npm run preview
```

## 7. Verifying the upload

Work through these in order; each one isolates a different failure.

**a. Files resolve over plain HTTP.** Every URL must return `200` (after
redirects to the CDN). A `401` means the repo is still private; a `404` means
a wrong path — most often ONNX files at the repo root instead of `onnx/`.

```bash
REPO=<your-username>/SmolLM2-135M-Instruct
for f in config.json tokenizer.json tokenizer_config.json \
         generation_config.json onnx/model_q4f16.onnx onnx/model_q4.onnx; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -L \
    "https://huggingface.co/$REPO/resolve/main/$f")
  echo "$code  $f"
done
```

PowerShell equivalent:

```powershell
$repo = '<your-username>/SmolLM2-135M-Instruct'
'config.json','tokenizer.json','tokenizer_config.json',
'generation_config.json','onnx/model_q4f16.onnx','onnx/model_q4.onnx' | ForEach-Object {
  $r = Invoke-WebRequest -Method Head -Uri "https://huggingface.co/$repo/resolve/main/$_"
  "{0}  {1}" -f $r.StatusCode, $_
}
```

**b. Sizes match, i.e. LFS actually stored the bytes.** The classic silent
failure is a 133-byte LFS *pointer text file* served instead of the weights —
the download "succeeds" and then ONNX Runtime throws a parse error. Check the
content length:

```bash
curl -sIL "https://huggingface.co/$REPO/resolve/main/onnx/model_q4f16.onnx" \
  | grep -i '^content-length'
```

Expect ~117691126 for `model_q4f16.onnx` and ~182068553 for `model_q4.onnx`.
Anything in the hundreds of bytes means the file was committed without LFS —
delete it and re-upload with the CLI.

**c. The repo page looks right.** On the Hub, each ONNX file's page should say
"Stored with Git LFS" and show its size; the file tree should show an `onnx`
folder, not two loose `.onnx` files.

**d. End to end in the app.** Run `npm run dev`, open DevTools, and trigger a
detection so a fun fact is generated. In the Console you should see:

```
[PERF] Model source in use: https://huggingface.co/<your-username>/SmolLM2-135M-Instruct/resolve/main/
```

If that line shows a repo other than the one you set, the env variable did not
reach the build — check the file is named exactly `.env`, the key is spelled
`VITE_HF_MODEL_ID` (the `VITE_` prefix is what makes Vite expose it), and
restart the dev server.

In the **Network** tab, filter by `huggingface.co` and confirm requests to
your repo returning `200`, with the ONNX request in the ~118 MB range. On the
second load those requests disappear — Transformers.js caches model files in
the browser's Cache Storage, so a warm load hits no network at all. Use a
hard reload with "Disable cache" (or clear Cache Storage in the Application
tab) if you want to re-observe the cold path.

## 8. Notes and gotchas

- **CORS is already handled.** `huggingface.co` serves model files with
  permissive CORS headers, so no configuration is needed on your side.
- **First load is a ~118 MB download** on WebGPU (~182 MB on the WASM
  fallback), at whatever throughput the Hub CDN gives your users. It is paid
  once per browser, then cached.
- **Keep the repo public and the files in place** after deploying. Deleting or
  privatising it later breaks the deployed app at runtime, with no fallback —
  the app has no bundled copy of the model.
- **`main` is the revision used.** Transformers.js requests
  `/resolve/main/...` by default, so uploads to a branch other than `main`
  will not be seen.
