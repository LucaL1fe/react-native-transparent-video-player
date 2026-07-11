import { createRequire } from 'node:module';
import path from 'node:path';
import { defineConfig, normalizePath } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

// The @ffmpeg packages are hoisted to the workspace root — resolve their real
// location instead of assuming ./node_modules. resolve() lands on dist/umd/,
// so step up two levels to the package dir.
const require = createRequire(import.meta.url);
function ffmpegCoreGlob(pkg: string): string {
  const pkgDir = path.dirname(path.dirname(path.dirname(require.resolve(pkg))));
  return normalizePath(path.join(pkgDir, 'dist/esm/*'));
}

// Project-pages base path; override with BASE_PATH=/ for a custom domain.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/react-native-transparent-video-skia/',
  // Real COOP/COEP headers in dev/preview — the coi-serviceworker shim is
  // only needed on GitHub Pages, which cannot set response headers.
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  plugins: [
    viteStaticCopy({
      targets: [
        { src: ffmpegCoreGlob('@ffmpeg/core-mt'), dest: 'ffmpeg/core-mt' },
        { src: ffmpegCoreGlob('@ffmpeg/core'), dest: 'ffmpeg/core-st' },
      ],
    }),
  ],
  // @ffmpeg/ffmpeg spawns an inner module worker; Vite's dep pre-bundling
  // breaks its URL resolution, so leave both packages unbundled.
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'] },
});
