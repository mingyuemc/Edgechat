<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps({
  siteKey: {
    type: String,
    default: ''
  },
  action: {
    type: String,
    default: ''
  }
});

const emit = defineEmits(['ready', 'verified', 'expired', 'error']);

const container = ref(null);
const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let widgetId = null;
let scriptPromise = null;

function loadScript() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no_window'));
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error('turnstile_script_failed'));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

function removeWidget() {
  if (widgetId !== null && window.turnstile) {
    window.turnstile.remove(widgetId);
  }
  widgetId = null;
}

async function render() {
  if (!props.siteKey || !container.value) return;
  try {
    await loadScript();
    if (!window.turnstile || !container.value) return;
    removeWidget();
    widgetId = window.turnstile.render(container.value, {
      sitekey: props.siteKey,
      action: props.action || undefined,
      callback: (token) => emit('verified', token),
      'expired-callback': () => emit('expired'),
      'error-callback': () => emit('error')
    });
    emit('ready');
  } catch {
    emit('error');
  }
}

// 单次 token 使用后失效，登录/注册失败需要重置以重新获取。
function reset() {
  if (widgetId !== null && window.turnstile) {
    window.turnstile.reset(widgetId);
  }
}

defineExpose({ reset });

onMounted(render);
watch(
  () => props.siteKey,
  async () => {
    removeWidget();
    await render();
  }
);
onBeforeUnmount(removeWidget);
</script>

<template>
  <div v-if="siteKey" class="turnstile-widget">
    <div ref="container"></div>
  </div>
</template>

<style scoped>
.turnstile-widget {
  width: 100%;
  display: flex;
  justify-content: center;
  opacity: 0;
  animation: fadeUp 0.6s ease-out 1.5s forwards;
}

@keyframes fadeUp {
  0% { opacity: 0; transform: translateY(18px); }
  100% { opacity: 1; transform: translateY(0); }
}
</style>
