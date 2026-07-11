import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

const BASE = import.meta.env.BASE_URL;

export interface Engine {
  ffmpeg: FFmpeg;
  mt: boolean;
}

export async function loadFFmpeg(): Promise<Engine> {
  const mt = typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated;
  const dir = mt ? `${BASE}ffmpeg/core-mt` : `${BASE}ffmpeg/core-st`;
  const ffmpeg = new FFmpeg();
  // Core files are copied from node_modules into the site at build time, so
  // they are same-origin — no toBlobURL CDN workaround needed.
  await ffmpeg.load({
    coreURL: `${dir}/ffmpeg-core.js`,
    wasmURL: `${dir}/ffmpeg-core.wasm`,
    ...(mt ? { workerURL: `${dir}/ffmpeg-core.worker.js` } : {}),
  });
  // Debug handle for the browser console / automated tests.
  (globalThis as Record<string, unknown>).__ffmpeg = ffmpeg;
  return { ffmpeg, mt };
}

export interface ProbeResult {
  pixFmt: string;
  codec: string;
  width: number;
  height: number;
  duration: number;
  hasAlpha: boolean;
  vp9Alpha: boolean;
}

// Mirrors the pack-alpha-video CLI's ffprobe preflight, plus WebM alpha_mode
// detection (VP8/VP9 alpha is a container tag, not part of pix_fmt).
export async function probe(ffmpeg: FFmpeg, inName: string): Promise<ProbeResult> {
  await ffmpeg.ffprobe([
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries',
    'stream=codec_name,pix_fmt,width,height:stream_tags=alpha_mode:format=duration',
    '-of', 'json', inName, '-o', 'probe.json',
  ]);
  const raw = (await ffmpeg.readFile('probe.json')) as Uint8Array;
  const j = JSON.parse(new TextDecoder().decode(raw));
  const s = j.streams?.[0] ?? {};
  const pixFmt: string = s.pix_fmt ?? '';
  const codec: string = s.codec_name ?? '';
  const vp9Alpha = ['vp8', 'vp9'].includes(codec) && s.tags?.alpha_mode === '1';
  return {
    pixFmt,
    codec,
    width: s.width ?? 0,
    height: s.height ?? 0,
    duration: parseFloat(j.format?.duration ?? '0') || 0,
    hasAlpha: pixFmt.includes('a') || vp9Alpha,
    vp9Alpha,
  };
}

export interface PackOptions {
  fps: number;
  crf: number;
  /** Downscale to this width (keeps aspect, even dimensions). Omit for source width. */
  width?: number;
}

export class NoAlphaError extends Error {}

export async function writeInput(ffmpeg: FFmpeg, file: File): Promise<string> {
  const dot = file.name.lastIndexOf('.');
  const inName = 'input' + (dot >= 0 ? file.name.slice(dot) : '.mov');
  await ffmpeg.writeFile(inName, await fetchFile(file));
  return inName;
}

export async function pack(
  ffmpeg: FFmpeg,
  inName: string,
  probed: ProbeResult,
  opts: PackOptions,
  onProgress: (ratio: number) => void
): Promise<Uint8Array> {
  // Exact filter chain from the pack-alpha-video CLI: premultiply color by
  // alpha (kills edge fringe under bilinear sampling), then stack the color
  // frame on top of the alpha matte into one double-height H.264 frame.
  const scale = opts.width ? `scale=${opts.width}:-2,` : '';
  const filter =
    `[0:v]fps=${opts.fps},${scale}format=rgba,premultiply=inplace=1,format=rgba,` +
    `split[c][a];[a]alphaextract[m];[c][m]vstack`;

  const onProg = ({ progress }: { progress: number }) => {
    if (Number.isFinite(progress)) onProgress(Math.min(1, Math.max(0, progress)));
  };
  // Fallback: the progress event is officially experimental — also derive
  // progress from "time=HH:MM:SS.xx" log lines against the probed duration.
  const onLog = ({ message }: { message: string }) => {
    const m = message.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m && probed.duration > 0) {
      const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      onProgress(Math.min(1, t / probed.duration));
    }
  };
  ffmpeg.on('progress', onProg);
  ffmpeg.on('log', onLog);
  try {
    const code = await ffmpeg.exec([
      // The native vp9 decoder ignores alpha; libvpx-vp9 (before -i) decodes it.
      ...(probed.vp9Alpha ? ['-c:v', probed.codec === 'vp8' ? 'libvpx' : 'libvpx-vp9'] : []),
      '-i', inName,
      '-filter_complex', filter,
      '-c:v', 'libx264', '-crf', String(opts.crf), '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', '-an',
      'out.mp4',
    ]);
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);
    return (await ffmpeg.readFile('out.mp4')) as Uint8Array;
  } finally {
    ffmpeg.off('progress', onProg);
    ffmpeg.off('log', onLog);
    await cleanup(ffmpeg, [inName, 'out.mp4', 'probe.json']);
  }
}

export async function cleanup(ffmpeg: FFmpeg, names: string[]): Promise<void> {
  for (const n of names) {
    try {
      await ffmpeg.deleteFile(n);
    } catch {
      /* file may not exist */
    }
  }
}
