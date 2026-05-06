<script setup lang="ts">
import type { ComputedRef } from 'vue'
import { inject, computed, watch } from 'vue'
import { useRoute } from 'vue-router'

interface SlideRoute {
  no: number
  meta: {
    layout?: string
    slide?: { frontmatter: Record<string, any> }
  }
}

interface SlidevNav {
  currentPage: ComputedRef<number>
  total: ComputedRef<number>
  currentSlideRoute: ComputedRef<SlideRoute>
}

interface SlidevContext {
  nav: SlidevNav
  configs: Record<string, any>
}

const slidevCtx = inject<SlidevContext>('$$slidev-context')!

const fm = computed(() => {
  try {
    return slidevCtx.nav.currentSlideRoute.value.meta?.slide?.frontmatter ?? {}
  } catch {
    return {}
  }
})

const numberPos = computed(() => fm.value.slideNumber || slidevCtx.configs.slideNumber || '')
const barPos = computed(() => fm.value.slideProgressBar || slidevCtx.configs.slideProgressBar || '')

const numberClass = computed(() => {
  switch (numberPos.value) {
    case 'bottom-right': return 'absolute bottom-4 right-4'
    case 'bottom-left': return 'absolute bottom-4 left-4'
    case 'top-right': return 'absolute top-4 right-4'
    case 'top-left': return 'absolute top-4 left-4'
    default: return ''
  }
})

// Stop all media on every slide navigation so audio/video from a previous
// slide does not keep playing in the background.  This lives here rather
// than in slides.md because global-bottom.vue is mounted for the entire
// lifetime of the presentation, whereas a <script setup> block injected
// into slides.md is part of slide 1's component and gets unmounted when
// the user navigates away.
const route = useRoute()
const stopMedia = () => {
  for (const el of document.querySelectorAll<HTMLMediaElement>('audio, video')) {
    el.pause()
    el.currentTime = 0
  }
}
watch(() => route.fullPath, stopMedia)
window.addEventListener('hashchange', stopMedia)
window.addEventListener('popstate', stopMedia)

</script>

<template>
  <div v-if="numberClass" :class="numberClass" class="z-9999 text-sm opacity-80 pointer-events-none">
    {{ $slidev.nav.currentPage }} / {{ $slidev.nav.total }}
  </div>
  <div v-if="barPos === 'bottom'" style="position: absolute; bottom: 0; left: 0; right: 0; height: 0.5rem; z-index: 9999; pointer-events: none;"
       :style="{ background: $slidev.nav.currentPage <= 0 || $slidev.nav.total <= 0 ? 'transparent' : `linear-gradient(to right, currentColor ${Math.round(($slidev.nav.currentPage / $slidev.nav.total) * 100)}%, transparent 0)` }">
  </div>
  <div v-if="barPos === 'top'" style="position: absolute; top: 0; left: 0; right: 0; height: 0.5rem; z-index: 9999; pointer-events: none;"
       :style="{ background: $slidev.nav.currentPage <= 0 || $slidev.nav.total <= 0 ? 'transparent' : `linear-gradient(to right, currentColor ${Math.round(($slidev.nav.currentPage / $slidev.nav.total) * 100)}%, transparent 0)` }">
  </div>
</template>
