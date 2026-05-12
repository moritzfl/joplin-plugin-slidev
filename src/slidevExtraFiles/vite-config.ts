export const buildViteConfigContent = (remoteTunnel: boolean): string => `import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [{
    name: 'joplin-slidev-resource-resolver',
    enforce: 'pre',
    resolveId(source, importer) {
      if (importer?.includes('slides.md__slidev_')) {
        if (source.startsWith('./resources/')) return resolve(__dirname, source.slice(2));
        if (source.startsWith('resources/')) return resolve(__dirname, source);
      }
      return null;
    },
  }],
${remoteTunnel ? `  server: {
    allowedHosts: ['trycloudflare.com', '.trycloudflare.com'],
  },
` : ''}});
`;
