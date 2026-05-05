import { PluginSettings } from './types';
import stylesIndex from './slidevExtraFiles/styles-index.css';
import stylesPresenter from './slidevExtraFiles/styles-presenter.css';
import globalTopVue from './slidevExtraFiles/global-top.vue';
import globalBottomVue from './slidevExtraFiles/global-bottom.vue';

export const EXTRA_FILE_PATHS = [
	'styles/index.css',
	'global-bottom.vue',
	'global-top.vue',
	'vite.config.ts',
] as const;

export const buildSlidevExtraFiles = (settings: Pick<PluginSettings, 'remoteTunnel' | 'presenterControlledNavigation'>): Record<string, string> => {
	const extraFiles: Record<string, string> = {
		'styles/index.css': stylesIndex,
		'global-bottom.vue': globalBottomVue,
	};

	if (settings.remoteTunnel) {
		extraFiles['vite.config.ts'] = `import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    allowedHosts: ['trycloudflare.com', '.trycloudflare.com'],
  },
});
`;
	}

	if (settings.presenterControlledNavigation) {
		extraFiles['styles/index.css'] += '\n' + stylesPresenter;
		extraFiles['global-top.vue'] = globalTopVue;
	}

	return extraFiles;
};