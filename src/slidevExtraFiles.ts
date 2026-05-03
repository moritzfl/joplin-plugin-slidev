import { PluginSettings } from './types';

export const buildSlidevExtraFiles = (settings: Pick<PluginSettings, 'slideProgress' | 'remoteTunnel' | 'presenterControlledNavigation'>): Record<string, string> => {
	const extraFiles: Record<string, string> = {
		'styles/index.css': 'button[title="Edit Notes"] { display: none !important; }\n',
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
		extraFiles['styles/index.css'] += `
body.presenter-controlled-navigation #page-root [class*="bottom-0"],
body.presenter-controlled-navigation #slidev-controls {
  display: none !important;
}
`;
		extraFiles['global-top.vue'] = `<script setup>
import { onMounted, onUnmounted } from 'vue'

const isViewerRoute = () => !location.pathname.startsWith('/presenter') && !location.pathname.startsWith('/entry') && !location.pathname.startsWith('/overview')
const navKeys = new Set([' ', 'ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'PageDown', 'PageUp'])

const stopViewerNavigation = (event) => {
  if (!isViewerRoute()) return
  const target = event.target
  if (event.type === 'keydown' && navKeys.has(event.key)) {
    event.preventDefault()
    event.stopImmediatePropagation()
  } else if (event.type === 'pointerdown' && target?.id === 'slide-container') {
    event.preventDefault()
    event.stopImmediatePropagation()
  } else if (event.type.startsWith('touch')) {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
}

onMounted(() => {
  document.body.classList.add('presenter-controlled-navigation')
  window.addEventListener('keydown', stopViewerNavigation, true)
  window.addEventListener('pointerdown', stopViewerNavigation, true)
  window.addEventListener('touchstart', stopViewerNavigation, { capture: true, passive: false })
  window.addEventListener('touchmove', stopViewerNavigation, { capture: true, passive: false })
  window.addEventListener('touchend', stopViewerNavigation, { capture: true, passive: false })
})

onUnmounted(() => {
  document.body.classList.remove('presenter-controlled-navigation')
  window.removeEventListener('keydown', stopViewerNavigation, true)
  window.removeEventListener('pointerdown', stopViewerNavigation, true)
  window.removeEventListener('touchstart', stopViewerNavigation, true)
  window.removeEventListener('touchmove', stopViewerNavigation, true)
  window.removeEventListener('touchend', stopViewerNavigation, true)
})
</script>

<template></template>
`;
	}

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
