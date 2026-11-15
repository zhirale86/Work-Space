/**
 * Сборка демонстрационной версии: `npm run build:demo` → dist-demo/docflow-demo.html —
 * один автономный файл (JS, CSS, шрифт и логотип встроены), открывается двойным щелчком.
 * Обычная сборка (vite.config.ts) от этого файла не зависит.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { type Plugin, defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const DEMO_FILE = 'docflow-demo.html';
const ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * Демонстрационная сборка: шрифт и логотип встраиваются как data URI (страница открывается
 * с file:// без единого сетевого запроса). Остаётся один вариативный шрифт Inter — он покрывает
 * все начертания, отдельные файлы Regular/Medium/SemiBold не нужны.
 */
function inlineBrandAssets(): Plugin {
  const pub = path.resolve(ROOT, 'public');
  const dataUri = (rel: string, mime: string) => `data:${mime};base64,${fs.readFileSync(path.join(pub, rel)).toString('base64')}`;
  let logo = '';
  let font = '';
  return {
    name: 'docflow-demo-inline-assets',
    enforce: 'pre',
    buildStart() {
      logo = dataUri('brand/utech-logo.jpg', 'image/jpeg');
      font = dataUri('fonts/InterVariable.woff2', 'font/woff2');
    },
    transform(code, id) {
      if (id.includes('node_modules')) return null;
      let out = code;
      if (id.endsWith('.css')) {
        out = out.replace(/@font-face\s*{[^}]*Inter-(Regular|Medium|SemiBold)\.woff2[^}]*}/g, '');
        out = out.split('/fonts/InterVariable.woff2').join(font);
      }
      out = out.split('/brand/utech-logo.jpg').join(logo);
      return out === code ? null : { code: out, map: null };
    },
  };
}

/** Итоговый файл называется docflow-demo.html. */
function renameDemoHtml(outDir: string): Plugin {
  return {
    name: 'docflow-demo-rename',
    closeBundle() {
      const from = path.join(outDir, 'index.html');
      if (fs.existsSync(from)) fs.renameSync(from, path.join(outDir, DEMO_FILE));
    },
  };
}

export default defineConfig(() => {
  const outDir = path.resolve(ROOT, 'dist-demo');
  return {
    mode: 'demo',
    plugins: [inlineBrandAssets(), react(), viteSingleFile({ removeViteModuleLoader: true }), renameDemoHtml(outDir)],
    define: { 'import.meta.env.VITE_DEMO': JSON.stringify('1') },
    base: './',
    publicDir: false,
    server: { host: '127.0.0.1', port: 5174, strictPort: true },
    build: { outDir, emptyOutDir: true, sourcemap: false, assetsInlineLimit: 100_000_000, cssCodeSplit: false, modulePreload: false },
  };
});
