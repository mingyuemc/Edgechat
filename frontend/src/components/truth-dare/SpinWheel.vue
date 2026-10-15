<script setup>
import { Sparkles } from '@lucide/vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps({
  // 参与者数组，至少包含 label（姓名缩写或显示名）。
  participants: { type: Array, default: () => [] },
  // 落点索引：必须与后端返回的 chosenUserId 在 participants 中的位置一致。
  targetIndex: { type: Number, default: -1 },
  spinning: { type: Boolean, default: false }
});

const emit = defineEmits(['settled']);

const RADIUS = 84;
const SPIN_DURATION_MS = 3000;
const SPIN_TURNS = 4;

const rotation = ref(0);
const reduceMotion = ref(false);
let mediaQuery = null;

const count = computed(() => props.participants.length);
const sectorAngle = computed(() => (count.value ? 360 / count.value : 0));

function polar(deg, radius) {
  const rad = (deg * Math.PI) / 180;
  return { x: 100 + radius * Math.sin(rad), y: 100 - radius * Math.cos(rad) };
}

const sectors = computed(() => {
  const n = count.value;
  if (!n) return [];
  const deg = 360 / n;
  return props.participants.map((participant, index) => {
    const start = index * deg;
    const end = (index + 1) * deg;
    const mid = start + deg / 2;
    const p0 = polar(start, RADIUS);
    const p1 = polar(end, RADIUS);
    const largeArc = deg > 180 ? 1 : 0;
    const hue = Math.round((index / n) * 300 + 190) % 360;
    const light = 52 + (index % 2) * 8;
    const label = String(participant.label ?? participant.displayName ?? participant.username ?? '?').slice(0, 3);
    return {
      index,
      start,
      mid,
      d: `M 100 100 L ${p0.x.toFixed(3)} ${p0.y.toFixed(3)} A ${RADIUS} ${RADIUS} 0 ${largeArc} 1 ${p1.x.toFixed(3)} ${p1.y.toFixed(3)} Z`,
      fill: `hsl(${hue} 74% ${light}%)`,
      stroke: `hsl(${hue} 82% ${Math.max(28, light - 24)}%)`,
      label,
      labelPoint: polar(mid, RADIUS * 0.64)
    };
  });
});

const rotorStyle = computed(() => ({
  transform: `rotate(${rotation.value}deg)`,
  transition: reduceMotion.value ? 'none' : `transform ${SPIN_DURATION_MS}ms cubic-bezier(0.16, 0.9, 0.12, 1)`
}));

const activeIndex = computed(() => (props.spinning ? -1 : props.targetIndex));

function alignRotationFor(index) {
  const n = count.value;
  if (!n) return null;
  const deg = 360 / n;
  const center = index * deg + deg / 2;
  const align = (((360 - center) % 360) + 360) % 360;
  const currentMod = (((rotation.value % 360) + 360) % 360);
  const delta = (((align - currentMod) % 360) + 360) % 360;
  return rotation.value + 360 * SPIN_TURNS + delta;
}

function settle(index) {
  const n = count.value;
  if (!n) return;
  const target = Math.max(0, Math.min(index, n - 1));
  const nextRotation = alignRotationFor(target);
  if (nextRotation === null) return;
  rotation.value = nextRotation;
  // 降低动效时没有过渡动画，直接落位并回报，避免房间一直等待。
  if (reduceMotion.value) nextTick(() => emit('settled', target));
}

function handleTransitionEnd(event) {
  if (event.propertyName !== 'transform') return;
  if (!props.spinning) return;
  emit('settled', props.targetIndex);
}

watch(
  () => [props.spinning, props.targetIndex],
  ([spinning, index]) => {
    if (!spinning || typeof index !== 'number' || index < 0) return;
    settle(index);
  }
);

onMounted(() => {
  if (typeof window === 'undefined' || !window.matchMedia) return;
  mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  reduceMotion.value = mediaQuery.matches;
  mediaQuery.addEventListener?.('change', (event) => {
    reduceMotion.value = event.matches;
  });
});

onBeforeUnmount(() => {
  mediaQuery = null;
});
</script>

<template>
  <div
    class="spin-wheel"
    :class="{ 'spin-wheel--spinning': spinning, 'spin-wheel--empty': !count }"
    role="img"
  >
    <div class="spin-wheel__halo" aria-hidden="true"></div>
    <div class="spin-wheel__particles" aria-hidden="true">
      <span v-for="n in 10" :key="n" :style="{ '--particle-index': n }"></span>
    </div>

    <svg class="spin-wheel__svg" viewBox="0 0 200 200" aria-hidden="true">
      <circle cx="100" cy="100" :r="RADIUS + 4" class="spin-wheel__ring" />
      <g class="spin-wheel__rotor" :style="rotorStyle" @transitionend="handleTransitionEnd">
        <template v-if="count === 1">
          <circle cx="100" cy="100" :r="RADIUS" :fill="sectors[0]?.fill" :stroke="sectors[0]?.stroke" stroke-width="1.5" />
        </template>
        <template v-else>
          <path
            v-for="sector in sectors"
            :key="sector.index"
            :d="sector.d"
            :fill="sector.fill"
            :stroke="sector.stroke"
            stroke-width="1.5"
            :class="{ 'spin-wheel__sector--active': sector.index === activeIndex }"
          />
        </template>
        <text
          v-for="sector in sectors"
          :key="`label-${sector.index}`"
          class="spin-wheel__label"
          :x="sector.labelPoint.x"
          :y="sector.labelPoint.y"
          text-anchor="middle"
          dominant-baseline="middle"
        >
          {{ sector.label }}
        </text>
      </g>
      <circle cx="100" cy="100" r="18" class="spin-wheel__hub" />
    </svg>

    <div class="spin-wheel__pointer" aria-hidden="true">
      <svg viewBox="0 0 24 32" aria-hidden="true" focusable="false">
        <path d="M12 32 2 4a4 4 0 0 1 3.6-5.7h12.8A4 4 0 0 1 22 4z" />
      </svg>
    </div>
    <div class="spin-wheel__hub-icon" aria-hidden="true">
      <Sparkles :size="18" />
    </div>

    <p v-if="!count" class="spin-wheel__empty-text">
      <slot name="empty" />
    </p>
  </div>
</template>

<style scoped>
.spin-wheel {
  position: relative;
  width: min(320px, 74vw);
  aspect-ratio: 1;
  margin: 0 auto;
  display: grid;
  place-items: center;
  /* 转盘纯展示、无交互，整体不接收指针事件，避免光晕与 SVG 外扩区域遮挡页面按钮。 */
  pointer-events: none;
  filter: drop-shadow(0 18px 34px rgba(56, 189, 248, 0.22));
}

.spin-wheel__halo {
  position: absolute;
  inset: -14%;
  border-radius: 50%;
  /* 纯装饰光晕，不接收指针事件，避免其模糊外扩区域遮挡页面上的按钮。 */
  pointer-events: none;
  background:
    radial-gradient(circle at 50% 50%, rgba(236, 72, 153, 0.28), transparent 62%),
    conic-gradient(from 0deg, #22d3ee, #6366f1, #ec4899, #f59e0b, #22d3ee);
  filter: blur(26px);
  opacity: 0.65;
  animation: spin-wheel-halo 8s linear infinite;
}

.spin-wheel--spinning .spin-wheel__halo {
  opacity: 0.9;
  animation-duration: 2.4s;
}

.spin-wheel__particles {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  pointer-events: none;
}

.spin-wheel__particles span {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 5px;
  height: 5px;
  margin: -2.5px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 8px 2px rgba(255, 255, 255, 0.85);
  transform: rotate(calc(var(--particle-index) * 36deg)) translateY(-54%) translateX(46vw);
  opacity: 0;
  animation: spin-wheel-particle 2.6s ease-in-out infinite;
  animation-delay: calc(var(--particle-index) * -0.26s);
}

.spin-wheel--spinning .spin-wheel__particles span {
  animation-duration: 1.4s;
}

.spin-wheel__svg {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: visible;
}

.spin-wheel__ring {
  fill: rgba(15, 23, 42, 0.85);
  stroke: rgba(255, 255, 255, 0.28);
  stroke-width: 1;
}

/* SVG 分组默认以 viewBox 左上角(0,0)为旋转原点，必须显式设为圆心，
   否则转盘会绕角旋转而不是绕圆心旋转。 */
.spin-wheel__rotor {
  transform-box: view-box;
  transform-origin: 50% 50%;
}

.spin-wheel__sector--active {
  filter: drop-shadow(0 0 10px rgba(255, 255, 255, 0.95));
  stroke: #fff;
  stroke-width: 2.5;
}

.spin-wheel__label {
  fill: #0b1120;
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.02em;
  pointer-events: none;
}

.spin-wheel__hub {
  fill: #0b1120;
  stroke: rgba(255, 255, 255, 0.6);
  stroke-width: 2;
}

.spin-wheel__pointer {
  position: absolute;
  top: -4px;
  left: 50%;
  z-index: 3;
  width: 22px;
  height: 30px;
  transform: translateX(-50%);
  filter: drop-shadow(0 3px 6px rgba(0, 0, 0, 0.45));
}

.spin-wheel__pointer svg {
  width: 100%;
  height: 100%;
  fill: #f8fafc;
  stroke: #0b1120;
  stroke-width: 1;
}

.spin-wheel__hub-icon {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 2;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  color: #fde047;
}

.spin-wheel__empty-text {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  margin: 0;
  padding: 0 18%;
  text-align: center;
  color: rgba(226, 232, 240, 0.9);
  font-size: 13px;
}

@keyframes spin-wheel-halo {
  to { transform: rotate(360deg); }
}

@keyframes spin-wheel-particle {
  0% { opacity: 0; }
  30% { opacity: 1; }
  100% { opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .spin-wheel__halo,
  .spin-wheel__particles span {
    animation: none;
  }
}
</style>
