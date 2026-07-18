// ML foreground segmentation via Transformers.js (loaded lazily from CDN).
// Default model is a salient-object / matting network (RMBG) that keeps the prominent
// foreground — the hands gripping cards — and drops the background, no prompting needed.
//
// NOTE on "Segment Anything": Meta's SAM / SAM2 are *promptable* (click a point/box) and
// SAM2 video tracking needs a GPU/Python backend, so it can't auto-keep "hands+cards" per
// frame in a browser. A matting model does that automatically and runs on WebGPU here.
//
// First use downloads model weights from the HF hub (needs internet; cached afterwards).
// WebGPU is used when available, else WASM (much slower).

const CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.0/dist/transformers.min.js';

let tf = null;         // the transformers module
let model = null;
let processor = null;
let loadedId = null;
let device = 'wasm';

function frameImageData(canvas) {
  return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
}

export function isReady(id) { return !!model && loadedId === id; }
export function currentDevice() { return device; }

export async function ensureModel(id, onProgress) {
  if (!tf) {
    tf = await import(/* @vite-ignore */ CDN);
    tf.env.allowLocalModels = false;
    if (tf.env.backends?.onnx?.wasm) tf.env.backends.onnx.wasm.proxy = true;
  }
  if (model && loadedId === id) return device;

  const opts = { progress_callback: onProgress };
  try {
    model = await tf.AutoModel.from_pretrained(id, { device: 'webgpu', dtype: 'fp32', ...opts });
    device = 'webgpu';
  } catch (e) {
    console.warn('WebGPU unavailable, falling back to WASM:', e.message);
    model = await tf.AutoModel.from_pretrained(id, opts);
    device = 'wasm';
  }
  processor = await tf.AutoProcessor.from_pretrained(id, opts);
  loadedId = id;
  return device;
}

// Segment one frame (a source-resolution canvas). Returns a grayscale mask canvas
// the same size as the input, ready to upload as the WebGL mask texture.
export async function segmentFrame(frameCanvas) {
  if (!model || !processor) throw new Error('model not loaded');
  const w = frameCanvas.width, h = frameCanvas.height;
  const imgData = frameImageData(frameCanvas);
  const raw = new tf.RawImage(imgData.data, w, h, 4);

  const { pixel_values } = await processor(raw);
  const out = await model({ input: pixel_values });
  // model output tensor name varies; take the first tensor
  const tensor = out.output ?? out.logits ?? Object.values(out)[0];
  const mask = await tf.RawImage.fromTensor(tensor[0].mul(255).to('uint8')).resize(w, h);
  return mask.toCanvas(); // grayscale RGBA canvas (r == mask)
}
