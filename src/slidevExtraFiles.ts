import { PluginSettings } from './types';
import stylesIndex from './slidevExtraFiles/styles-index.css';
import stylesPresenter from './slidevExtraFiles/styles-presenter.css';
import globalTopVue from './slidevExtraFiles/global-top.vue';
import globalBottomVue from './slidevExtraFiles/global-bottom.vue';
import { buildViteConfigContent } from './slidevExtraFiles/vite-config';

export const buildSlidevExtraFiles = (settings: Pick<PluginSettings, 'remoteTunnel' | 'presenterControlledNavigation'>): Record<string, string> => {
	const extraFiles: Record<string, string> = {
		'styles/index.css': stylesIndex,
		'global-bottom.vue': globalBottomVue,
		'vite.config.mjs': buildViteConfigContent(settings.remoteTunnel),
	};

	if (settings.presenterControlledNavigation) {
		extraFiles['styles/index.css'] += '\n' + stylesPresenter;
		extraFiles['global-top.vue'] = globalTopVue;
	}

	return extraFiles;
};
