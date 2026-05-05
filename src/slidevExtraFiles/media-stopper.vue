<script setup>
import { onMounted, onUnmounted, watch } from 'vue'
import { useRoute } from 'vue-router'

const stopMedia = () => {
  for (const el of document.querySelectorAll('audio, video')) {
    el.pause()
    el.currentTime = 0
  }
}

const route = useRoute()
let unwatch

onMounted(() => {
  unwatch = watch(() => route.fullPath, stopMedia)
  window.addEventListener('hashchange', stopMedia)
  window.addEventListener('popstate', stopMedia)
})

onUnmounted(() => {
  unwatch?.()
  window.removeEventListener('hashchange', stopMedia)
  window.removeEventListener('popstate', stopMedia)
})
</script>