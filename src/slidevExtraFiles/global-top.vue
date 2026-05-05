<script setup>
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
