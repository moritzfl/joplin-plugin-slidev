<script setup lang="ts">
import type { ComputedRef } from 'vue'
import { inject, computed } from 'vue'

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

const variant = computed(() => fm.value.slideProgress || slidevCtx.configs.slideProgress || '')
</script>

<template>
  <template v-if="variant === 'slide-number'">
    <div class="absolute bottom-4 right-4 z-9999 text-sm opacity-80 pointer-events-none">
      {{ $slidev.nav.currentPage }} / {{ $slidev.nav.total }}
    </div>
  </template>

  <template v-if="variant === 'progress-bar'">
    <div class="absolute bottom-0 left-0 right-0 z-9999 h-2 pointer-events-none"
         :style="{ background: $slidev.nav.currentPage <= 0 || $slidev.nav.total <= 0 ? 'transparent' : `linear-gradient(to right, currentColor ${Math.round(($slidev.nav.currentPage / $slidev.nav.total) * 100)}%, transparent 0)` }">
    </div>
  </template>

  <template v-if="variant === 'slide-number-and-bar'">
    <div class="absolute bottom-4 right-4 z-9999 text-sm opacity-80 pointer-events-none">
      {{ $slidev.nav.currentPage }} / {{ $slidev.nav.total }}
    </div>
    <div class="absolute bottom-0 left-0 right-0 z-9999 h-2 pointer-events-none"
         :style="{ background: $slidev.nav.currentPage <= 0 || $slidev.nav.total <= 0 ? 'transparent' : `linear-gradient(to right, currentColor ${Math.round(($slidev.nav.currentPage / $slidev.nav.total) * 100)}%, transparent 0)` }">
    </div>
  </template>
</template>