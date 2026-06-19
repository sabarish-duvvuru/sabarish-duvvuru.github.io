// dither.js — WebGPU ordered (Bayer) dithering compute shader + CPU fallback.
// Pipeline: input frame (image/animation) → quantize to N levels → apply
// Bayer threshold matrix → output to canvas. Engineering framing: data
// reduction / signal quantization, the same instinct that turns noisy
// validation data into review-ready signal.
//
// Architecture note: the source frame is passed as a storage buffer of RGBA
// bytes (not a texture_2d). Storage-buffer GPU→CPU readback is the one path
// verified reliable across swiftshader + real GPUs; texture roundtrips were
// not. The shader reads src[x,y] from the buffer directly.

import { hasWebGPU, viewportLoop, prefersReducedMotion, setStatus, clamp } from './common.js';

// 8x8 Bayer threshold matrix, normalized 0..1. Classic ordered dithering —
// deterministic, no error propagation artifacts, GPU-friendly.
const BAYER8 = (() => {
  const m = new Float32Array(64);
  const base = [[0, 2], [3, 1]];
  const n = 8;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let v = 0, cx = x, cy = y;
      for (let s = 4; s >= 1; s /= 2) {
        v = v * 4 + base[(cy / s) | 0][(cx / s) | 0];
        cx %= s; cy %= s;
      }
      m[y * n + x] = v / 64;
    }
  }
  return m;
})();

// WGSL compute shader. src is a storage buffer of raw RGBA u32 words (one per
// pixel, 0xAABBGGRR). Bayer matrix is a uniform array. Output is a storage
// buffer of packed 0xAABBGGRR words. One work-item per pixel.
const WGSL = /* wgsl */`
struct Params {
  levels: f32,
  threshold: f32,
  width: f32,
  height: f32,
  time: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> src: array<u32>;
@group(0) @binding(2) var<storage, read_write> out: array<u32>;
@group(0) @binding(3) var<storage, read> bayer: array<f32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let w = u32(params.width);
  let h = u32(params.height);
  if (gid.x >= w || gid.y >= h) { return; }

  let idx = gid.y * w + gid.x;
  let packed = src[idx];
  // unpack 0xAABBGGRR → normalize
  let r = f32((packed >> 0u) & 0xFFu) / 255.0;
  let g = f32((packed >> 8u) & 0xFFu) / 255.0;
  let b = f32((packed >> 16u) & 0xFFu) / 255.0;

  // luminance (Rec. 709) with gentle live motion so a still frame has life
  let motion = 0.92 + 0.08 * sin(params.time + f32(idx) * 0.03);
  let lum = dot(vec3<f32>(r, g, b) * motion, vec3<f32>(0.2126, 0.7152, 0.0722));

  let bx = gid.x % 8u;
  let by = gid.y % 8u;
  let bm = bayer[by * 8u + bx];
  let dithered = lum + (bm - 0.5) * (1.0 / params.levels) - params.threshold;
  let lv = max(2.0, params.levels);
  let q = clamp(round(dithered * lv) / (lv - 1.0), 0.0, 1.0);

  // navy palette ramp (paper→navy), quantized
  let lo = vec3<f32>(0.965, 0.957, 0.933);
  let hi = vec3<f32>(0.118, 0.227, 0.373);
  let rgb = mix(lo, hi, q);

  let or = u32(clamp(rgb.r, 0.0, 1.0) * 255.0);
  let og = u32(clamp(rgb.g, 0.0, 1.0) * 255.0);
  let ob = u32(clamp(rgb.b, 0.0, 1.0) * 255.0);
  out[idx] = 0xFF000000u | (ob << 16u) | (og << 8u) | or;
}
`;

// Source image — a synthetic engineering "scope" pattern: concentric gradients
// + a moving sinusoidal test signal. Returns a Uint8Array (RGBA) and also
// draws to a canvas for the CPU fallback path.
function sourcePixels(W, H, t) {
  const data = new Uint8Array(W * H * 4);
  const cx = W / 2, cy = H / 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x - cx) / W, dy = (y - cy) / H;
      const r = Math.sqrt(dx * dx + dy * dy);
      const wave = 0.5 + 0.5 * Math.sin(r * 60 - t * 1.5);
      const v = clamp(0.15 + wave * 0.85 - r * 0.6, 0, 1);
      const i = (y * W + x) * 4;
      data[i] = v * 255; data[i + 1] = v * 245; data[i + 2] = v * 230; data[i + 3] = 255;
    }
  }
  return data;
}

// Pack RGBA bytes into u32 words (0xAABBGGRR) for the storage buffer.
function packToU32(rgba) {
  const out = new Uint32Array(rgba.length / 4);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    out[p] = (rgba[i]) | (rgba[i + 1] << 8) | (rgba[i + 2] << 16) | (rgba[i + 3] << 24);
  }
  return out;
}

export async function initDither(root) {
  const canvas = root.querySelector('[data-canvas]');
  const controls = root.querySelector('[data-controls]');
  const W = 240, H = 160; // internal resolution; CSS scales up
  canvas.width = W; canvas.height = H;

  const levelsInput = controls.querySelector('[name=levels]');
  const threshInput = controls.querySelector('[name=threshold]');
  const modeInput = controls.querySelector('[name=mode]');
  const state = {
    levels: parseInt(levelsInput.value, 10),
    threshold: parseFloat(threshInput.value),
    mode: modeInput.value,
    useGPU: false,
  };

  let ctx2d = null;

  // ---- WebGPU path (storage-buffer based) ----
  let device, pipeline, uniformBuf, srcBuf, outBuf, bayerBuf, readBuf;
  async function setupGPU() {
    const adapter = await navigator.gpu.requestAdapter();
    device = await adapter.requestDevice();
    const module = device.createShaderModule({ code: WGSL });

    pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });

    uniformBuf = device.createBuffer({
      size: 32, // 5 f32, rounded up to 32 for uniform alignment
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    srcBuf = device.createBuffer({
      size: W * H * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    outBuf = device.createBuffer({
      size: W * H * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    // bayer as a uniform array: 64 f32 = 256 bytes, but uniform structs cap
    // at 16 bytes per array element rule... use a storage buffer to be safe.
    bayerBuf = device.createBuffer({
      size: 64 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(bayerBuf, 0, BAYER8);

    readBuf = device.createBuffer({
      size: W * H * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
  }

  function dispatchGPU(time) {
    // upload source frame as packed u32 storage buffer
    const srcData = sourcePixels(W, H, time);
    device.queue.writeBuffer(srcBuf, 0, packToU32(srcData));

    // uniforms: {levels, threshold, W, H, time, pad, pad, pad}
    const u = new ArrayBuffer(32);
    new Float32Array(u).set([state.levels, state.threshold, W, H, time, 0, 0, 0]);
    device.queue.writeBuffer(uniformBuf, 0, u);

    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuf } },
        { binding: 1, resource: { buffer: srcBuf } },
        { binding: 2, resource: { buffer: outBuf } },
        { binding: 3, resource: { buffer: bayerBuf } },
      ],
    }));
    pass.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8));
    pass.end();
    enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, W * H * 4);
    device.queue.submit([enc.finish()]);

    return readBuf.mapAsync(GPUMapMode.READ).then(() => {
      const data = new Uint32Array(readBuf.getMappedRange());
      if (!ctx2d) ctx2d = canvas.getContext('2d');
      const img = ctx2d.createImageData(W, H);
      const out = img.data;
      // unpack u32 (0xAABBGGRR) back to RGBA bytes
      for (let p = 0; p < data.length; p++) {
        const v = data[p];
        out[p * 4] = v & 0xFF;
        out[p * 4 + 1] = (v >> 8) & 0xFF;
        out[p * 4 + 2] = (v >> 16) & 0xFF;
        out[p * 4 + 3] = 255;
      }
      ctx2d.putImageData(img, 0, 0);
      readBuf.unmap();
    });
  }

  // ---- CPU fallback (Floyd–Steinberg or ordered) ----
  function cpuPass(time) {
    if (!ctx2d) ctx2d = canvas.getContext('2d');
    const d = sourcePixels(W, H, time);
    const out = ctx2d.createImageData(W, H);
    const o = out.data;
    const lv = state.levels;
    const lo = [0.965, 0.957, 0.933], hi = [0.118, 0.227, 0.373];

    if (state.mode === 'fs') {
      const buf = new Float32Array(W * H);
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        buf[p] = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      }
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const p = y * W + x;
          let oldv = buf[p];
          let nv = clamp(Math.round(oldv * (lv - 1)) / (lv - 1), 0, 1);
          const q = clamp(nv + (0 - state.threshold) * 0.2, 0, 1);
          const rgb = [lo[0] + (hi[0] - lo[0]) * q, lo[1] + (hi[1] - lo[1]) * q, lo[2] + (hi[2] - lo[2]) * q];
          const oi = p * 4;
          o[oi] = rgb[0] * 255; o[oi + 1] = rgb[1] * 255; o[oi + 2] = rgb[2] * 255; o[oi + 3] = 255;
          const err = oldv - nv;
          if (x + 1 < W) buf[p + 1] += err * 7 / 16;
          if (y + 1 < H) {
            if (x > 0) buf[p + W - 1] += err * 3 / 16;
            buf[p + W] += err * 5 / 16;
            if (x + 1 < W) buf[p + W + 1] += err * 1 / 16;
          }
        }
      }
    } else {
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const p = y * W + x;
          const lum = (0.2126 * d[p * 4] + 0.7152 * d[p * 4 + 1] + 0.0722 * d[p * 4 + 2]) / 255;
          const bm = BAYER8[(y % 8) * 8 + (x % 8)];
          const dithered = lum + (bm - 0.5) * (1 / lv) - state.threshold;
          const q = clamp(Math.round(dithered * lv) / (lv - 1), 0, 1);
          const oi = p * 4;
          o[oi] = (lo[0] + (hi[0] - lo[0]) * q) * 255;
          o[oi + 1] = (lo[1] + (hi[1] - lo[1]) * q) * 255;
          o[oi + 2] = (lo[2] + (hi[2] - lo[2]) * q) * 255;
          o[oi + 3] = 255;
        }
      }
    }
    ctx2d.putImageData(out, 0, 0);
  }

  // controls
  levelsInput.addEventListener('input', () => { state.levels = clamp(parseInt(levelsInput.value, 10) || 2, 2, 8); });
  threshInput.addEventListener('input', () => { state.threshold = clamp(parseFloat(threshInput.value) || 0, -0.3, 0.3); });
  modeInput.addEventListener('change', () => { state.mode = modeInput.value; });

  // init
  const gpuOK = await hasWebGPU();
  const reduced = prefersReducedMotion();

  if (gpuOK && !reduced) {
    try {
      await setupGPU();
      state.useGPU = true;
      setStatus(root, 'WebGPU compute active · running live', 'ok');
      let pending = false;
      const loop = viewportLoop(canvas, (dt, t) => {
        if (pending) return;
        pending = true;
        dispatchGPU(t / 1000).catch((e) => {
          console.warn('[lab] dither GPU dispatch failed, falling back', e);
          state.useGPU = false;
          setStatus(root, 'WebGPU lost — CPU fallback', 'warn');
          loop.stop();
          cpuInit();
        }).finally(() => { pending = false; });
      });
      loop.start();
      return;
    } catch (e) {
      console.warn('[lab] dither GPU init failed, falling back', e);
    }
  }

  function cpuInit() {
    setStatus(root, reduced ? 'CPU · static (reduced motion)' : 'CPU Floyd–Steinberg fallback', 'warn');
    if (reduced) { cpuPass(0); return; }
    const loop = viewportLoop(canvas, (dt, t) => cpuPass(t / 1000));
    loop.start();
  }
  cpuInit();
}
