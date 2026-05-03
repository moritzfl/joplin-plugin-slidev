import { PluginSettings } from './types';

export const buildSlidevExtraFiles = (settings: Pick<PluginSettings, 'slideProgress'>): Record<string, string> => {
	const extraFiles: Record<string, string> = {
		'styles/index.css': 'button[title="Edit Notes"] { display: none !important; }\n',
	};

	if (settings.slideProgress === 'slide-number') {
		extraFiles['global-bottom.vue'] = `<template>
  <div class="absolute bottom-4 right-4 z-9999 text-sm opacity-80 pointer-events-none">
    {{$slidev.nav.currentPage}} / {{$slidev.nav.total}}
  </div>
</template>
`;
	} else if (settings.slideProgress === 'progress-bar') {
		extraFiles['global-bottom.vue'] = `<template>
  <div class="absolute bottom-0 left-0 right-0 z-9999 h-2 pointer-events-none"
       :style="{ background: $slidev.nav.currentPage <= 0 || $slidev.nav.total <= 0 ? 'transparent' : \`linear-gradient(to right, currentColor \${Math.round(($slidev.nav.currentPage / $slidev.nav.total) * 100)}%, transparent 0)\` }">
  </div>
</template>
`;
	} else if (settings.slideProgress === 'slide-number-and-bar') {
		extraFiles['global-bottom.vue'] = `<template>
  <div class="absolute bottom-4 right-4 z-9999 text-sm opacity-80 pointer-events-none">
    {{$slidev.nav.currentPage}} / {{$slidev.nav.total}}
  </div>
  <div class="absolute bottom-0 left-0 right-0 z-9999 h-2 pointer-events-none"
       :style="{ background: $slidev.nav.currentPage <= 0 || $slidev.nav.total <= 0 ? 'transparent' : \`linear-gradient(to right, currentColor \${Math.round(($slidev.nav.currentPage / $slidev.nav.total) * 100)}%, transparent 0)\` }">
  </div>
</template>
`;
	}

	return extraFiles;
};
