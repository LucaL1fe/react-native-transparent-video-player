export function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

export function show(...ids: string[]): void {
  for (const id of ids) el(id).classList.remove('hidden');
}

export function hide(...ids: string[]): void {
  for (const id of ids) el(id).classList.add('hidden');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function formatDuration(seconds: number): string {
  if (!seconds) return '?';
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(0)}s`;
}

/** Even width ≥ 16 — yuv420p needs even dimensions. */
export function evenWidth(w: number): number {
  return Math.max(16, 2 * Math.round(w / 2));
}

/**
 * Rough packed-output size estimate: H.264 at CRF 18 lands around 0.1 bits
 * per pixel for animation-style content; each CRF step of 6 roughly doubles
 * or halves the rate. The packed frame is twice the display height.
 */
export function estimateSize(
  width: number,
  srcWidth: number,
  srcHeight: number,
  fps: number,
  crf: number,
  duration: number
): number {
  if (!srcWidth || !duration) return 0;
  const height = (srcHeight / srcWidth) * width;
  const bpp = 0.1 * Math.pow(2, (18 - crf) / 6);
  return (width * height * 2 * fps * duration * bpp) / 8;
}

interface ChipSpec {
  label: string;
  value: number;
  detail?: string;
}

export function renderChips(
  container: HTMLElement,
  specs: ChipSpec[],
  selected: number,
  onPick: (value: number) => void
): void {
  container.innerHTML = '';
  for (const spec of specs) {
    const btn = document.createElement('button');
    btn.className = 'chip' + (spec.value === selected ? ' active' : '');
    btn.textContent = spec.detail ? `${spec.label} · ${spec.detail}` : spec.label;
    btn.addEventListener('click', () => onPick(spec.value));
    container.appendChild(btn);
  }
}
