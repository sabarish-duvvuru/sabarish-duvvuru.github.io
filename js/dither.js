// dither.js — WebGPU ordered (Bayer) dithering compute shader + CPU fallback.
// Pipeline: input frame (image/animation) → quantize to N levels → apply
// Bayer threshold matrix → output to canvas. Engineering framing: data
// reduction / signal quantization, the same instinct that turns noisy
// validation data into review-ready signal.

import { hasWebGPU, viewportLoop, prefersReducedMotion, setStatus, clamp } from './common.js';

// 8x8 Bayer threshold matrix, normalized 0..1. Classic ordered dithering —
// deterministic, no error propagation artifacts, GPU-friendly.
const BAYER8 = (() => {
  // Recursively construct a Bayer matrix via the standard pattern.
  const m = new Float32Array(64);
  const base = [[0, 2], [3, 1]];
  const n = 8;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let v = 0;
      let cx = x, cy = y;
      for (let s = 4; s >= 1; s /= 2) {
        const bx = (cx / s) | 0, by = (cy / s) | 0;
        v = v * 4 + base[by][bx];
        cx %= s; cy %= s;
      }
      m[y * n + x] = v / 64;
    }
  }
  return m;
})();

// WGSL compute shader. One work item per output pixel. Reads source texture,
// applies luminance quantization + Bayer dither, writes to storage buffer that
// the CPU maps back to the canvas (simplest correct path for cross-browser).
const WGSL = /* wgsl */`
struct Params {
  levels: f32,        // quantization levels (e.g. 2..8)
  threshold: f32,     // user threshold 0..1 bias
  width: u32,
  height: u32,
  time: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> out: array<u32>;
@group(0) @binding(3) var bayer: texture_2d<f32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let w = params.width;
  let h = params.height;
  if (gid.x >= w || gid.y >= h) { return; }

  let texCoord = vec2<f32>(f32(gid.x), f32(gid.y));
  let srcSize = textureDimensions(src);
  let scaled = vec2<u32>(
    u32(f32(texCoord.x) / f32(w) * f32(srcSize.x)),
    u32(f32(texCoord.y) / f32(h) * f32(srcSize.y))
  );
  var c = textureLoad(src, scaled, 0);
  // gentle live motion so the still image has life even when idle
  c = c * (0.92 + 0.08 * sin(params.time + f32(gid.x + gid.y) * 0.03));

  // luminance (Rec. 709)
  let lum = dot(c.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
  let b = textureLoad(bayer, vec2<u32>(gid.x % 8u, gid.y % 8u), 0).r;
  let dithered = lum + (b - 0.5) * (1.0 / params.levels) - params.threshold;
  let q = clamp(round(dithered * params.levels) / (params.levels - 1.0), 0.0, 1.0);

  // output: navy palette ramp (paper→navy), quantized
  let lo = vec3<f32>(0.965, 0.957, 0.933); // warm paper
  let hi = vec3<f32>(0.118, 0.227, 0.373); // navy
  let rgb = mix(lo, hi, q);

  // pack to 0xRRGGBB (canvas writes opaque)
  let r = u32(clamp(rgb.r, 0.0, 1.0) * 255.0);
  let g = u32(clamp(rgb.g, 0.0, 1.0) * 255.0);
  let b2 = u32(clamp(rgb.b, 0.0, 1.0) * 255.0);
  out[gid.y * w + gid.x] = 0xFF000000u | (b2 << 16u) | (g << 8u) | r;
}
`;

// Source image — a synthetic engineering "scope" pattern: concentric gradients
// + a moving sinusoidal test signal. Generated procedurally on a 2D canvas so
// the demo has zero external image dependency and always looks intentional.
function drawSourceFrame(ctx, w, h, t) {
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) / w, dy = (y - cy) / h;
      const r = Math.sqrt(dx * dx + dy * dy);
      // radial gradient + moving sine wave = recognizable "signal"
      const wave = 0.5 + 0.5 * Math.sin(r * 60 - t * 1.5);
      const v = clamp(0.15 + wave * 0.85 - r * 0.6, 0, 1);
      const i = (y * w + x) * 4;
      d[i] = v * 255; d[i + 1] = v * 245; d[i + 2] = v * 230; d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
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
    mode: modeInput.value, // 'bayer' | 'fs'
    useGPU: false,
  };

  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = W; srcCanvas.height = H;
  const srcCtx = srcCanvas.getContext('2d');

  let ctx2d = null; // CPU fallback target

  // ---- WebGPU path ----
  let device, pipeline, uniformBuf, outBuf, srcTex, bayerTex, uniformBind;
  async function setupGPU() {
    const adapter = await navigator.gpu.requestAdapter();
    device = await adapter.requestDevice();
    const module = device.createShaderModule({ code: WGSL });

    pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });

    uniformBuf = device.createBuffer({
      size: 32, // 5 f32 + padding → 32 bytes (one vec4 + one vec4)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    outBuf = device.createBuffer({
      size: W * H * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    srcTex = device.createTexture({
      size: [W, H], format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING |
             GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const bayerData = new Float32Array(BAYER8);
    bayerTex = device.createTexture({
      size: [8, 8], format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: bayerTex }, bayerData, { bytesPerRow: 32 }, { width: 8, height: 8 });

    const readBuf = device.createBuffer({
      size: W * H * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    return { readBuf };
  }

  function dispatchGPU(time, readBuf) {
    // upload source frame
    drawSourceFrame(srcCtx, W, H, time);
    device.queue.copyExternalImageToTexture(
      { source: srcCanvas }, { texture: srcTex }, [W, H]);

    // uniforms
    const u = new ArrayBuffer(32);
    new Float32Array(u, 0, 4).set([state.levels, state.threshold, W, H]);
    new Float32Array(u, 16, 2).set([time, 0]);
    device.queue.writeBuffer(uniformBuf, 0, u);

    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuf } },
        { binding: 1, resource: srcTex.createView() },
        { binding: 2, resource: { buffer: outBuf } },
        { binding: 3, resource: bayerTex.createView() },
      ],
    }));
    pass.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8));
    pass.end();
    enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, W * H * 4);
    device.queue.submit([enc.finish()]);

    return readBuf.mapAsync(GPUMapMode.READ).then(() => {
      const data = new Uint8Array(readBuf.getMappedRange().slice(0));
      readBuf.unmap();
      // copy into visible canvas
      if (!ctx2d) ctx2d = canvas.getContext('2d');
      const img = ctx2d.createImageData(W, H);
      img.data.set(data);
      ctx2d.putImageData(img, 0, 0);
    });
  }

  // ---- CPU fallback (Floyd–Steinberg or ordered) ----
  function cpuPass(time) {
    if (!ctx2d) ctx2d = canvas.getContext('2d');
    drawSourceFrame(srcCtx, W, H, time);
    const src = srcCtx.getImageData(0, 0, W, H);
    const out = ctx2d.createImageData(W, H);
    const d = src.data, o = out.data;
    const lv = state.levels;
    const lo = [0.965, 0.957, 0.933], hi = [0.118, 0.227, 0.373];

    if (state.mode === 'fs') {
      // Floyd–Steinberg error diffusion
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
          const rgb = [
            lo[0] + (hi[0] - lo[0]) * q,
            lo[1] + (hi[1] - lo[1]) * q,
            lo[2] + (hi[2] - lo[2]) * q,
          ];
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
      // ordered (Bayer) — matches the GPU kernel
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const p = y * W + x;
          const lum = (0.2126 * d[p * 4] + 0.7152 * d[p * 4 + 1] + 0.0722 * d[p * 4 + 2]) / 255;
          const b = BAYER8[(y % 8) * 8 + (x % 8)];
          const dithered = lum + (b - 0.5) * (1 / lv) - state.threshold;
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
      const { readBuf } = await setupGPU();
      state.useGPU = true;
      setStatus(root, 'WebGPU compute active · running live', 'ok');
      let pending = false;
      const loop = viewportLoop(canvas, (dt, t) => {
        if (pending) return;
        pending = true;
        dispatchGPU(t / 1000, readBuf).catch(() => {
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
    if (reduced) {
      cpuPass(0); // single static frame
      return;
    }
    const loop = viewportLoop(canvas, (dt, t) => cpuPass(t / 1000));
    loop.start();
  }
  cpuInit();
}
