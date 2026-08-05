export const buildViteConfigContent = (remoteTunnel: boolean): string => `import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const resourceRoot = fileURLToPath(new URL('./resources/', import.meta.url));

const resolveResource = (source) => {
  const prefix = source.startsWith('./resources/') ? './resources/' : 'resources/';
  const target = resolve(resourceRoot, source.slice(prefix.length));
  const relativeTarget = relative(resourceRoot, target);
  if (!relativeTarget || relativeTarget === '..' || relativeTarget.startsWith('..' + sep) || isAbsolute(relativeTarget)) return null;
  return target;
};

export default defineConfig({
  plugins: [{
    name: 'joplin-slidev-resource-resolver',
    enforce: 'pre',
    resolveId(source, importer) {
      if (importer?.includes('slides.md__slidev_')) {
        if (source.startsWith('./resources/') || source.startsWith('resources/')) {
          const resolved = resolveResource(source);
          if (!resolved) throw new Error('Joplin resource path escapes the presentation resource directory');
          return resolved;
        }
      }
      return null;
    },
  }],
${remoteTunnel ? `  server: {
    allowedHosts: ['trycloudflare.com', '.trycloudflare.com'],
  },
` : ''}});
`;
