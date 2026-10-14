<script setup>
import { Check, CircleCheck, Crown, Mic, Sparkles, Square, ThumbsUp, UserCheck } from '@lucide/vue';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import api from '../../api.js';
import { useVoiceRecorder } from '../../composables/useVoiceRecorder.ts';
import { t } from '../../i18n.js';
import { formatVoiceDuration } from '../../voice-message.js';
import SpinWheel from './SpinWheel.vue';

const props = defineProps({
  game: { type: Object, default: null },
  me: { type: Object, default: null },
  phase: { type: String, default: '' },
  status: { type: String, default: '' },
  round: { type: Object, default: null },
  participants: { type: Array, default: () => [] },
  phaseDeadlineMs: { type: Number, default: null },
  actionLoading: { type: Boolean, default: false },
  actionError: { type: String, default: '' },
  wheelSpinning: { type: Boolean, default: false },
  wheelTargetIndex: { type: Number, default: -1 },
  canSpin: Boolean,
  canChoose: Boolean,
  canSubmitPrompt: Boolean,
  canVote: Boolean,
  canOpenVoting: Boolean,
  canCloseVoting: Boolean,
  canAnswer: Boolean,
  canConfirm: Boolean,
  canNextRound: Boolean,
  canEndGame: Boolean,
  hasSubmittedPrompt: Boolean,
  hasVoted: Boolean
});

const emit = defineEmits([
  'spin',
  'wheel-settled',
  'choose',
  'prompt',
  'open-voting',
  'vote',
  'close-voting',
  'answer',
  'confirm',
  'next-round',
  'end-game',
  'back',
  'leave',
  'join'
]);

const CHOOSE_WINDOW_MS = 10000;
const COUNTDOWN_CIRCUMFERENCE = 2 * Math.PI * 16;

const promptText = ref('');
const answerText = ref('');
const nowTick = ref(Date.now());
const pendingVoice = ref(null);
const voiceUploading = ref(false);
const voiceError = ref('');
let countdownTimer = null;

const { recording, starting, elapsedMs, liveWaveform, start, finish, cancel } = useVoiceRecorder();

const prompts = computed(() => props.round?.prompts ?? []);
const onlineCount = computed(() => props.participants.filter((participant) => participant.online).length);
const chosenParticipant = computed(() =>
  props.participants.find((participant) => participant.userId === props.round?.chosenUserId) ?? null
);
const chosenName = computed(
  () => props.round?.chosenName || chosenParticipant.value?.displayName || t('truthDare.chosenTag')
);
const isDare = computed(() => props.round?.choice === 'dare');
const winningPrompt = computed(
  () => prompts.value.find((prompt) => prompt.id === props.round?.winningPromptId) ?? null
);
const isSelfChosen = computed(() => Boolean(props.me?.isChosen));
const roundPromptsEmpty = computed(() => prompts.value.length === 0);

const remainingMs = computed(() => {
  const deadline = props.phaseDeadlineMs;
  if (!deadline) return CHOOSE_WINDOW_MS;
  return Math.max(0, deadline - nowTick.value);
});
const secondsLeft = computed(() => Math.max(0, Math.ceil(remainingMs.value / 1000)));
const countdownFraction = computed(() => Math.min(1, Math.max(0, remainingMs.value / CHOOSE_WINDOW_MS)));
const countdownOffset = computed(() => COUNTDOWN_CIRCUMFERENCE * (1 - countdownFraction.value));

const participantLabel = (participant) =>
  String(participant.displayName || participant.username || '?');

function hasSubmitted(participant) {
  return prompts.value.some((prompt) => prompt.authorId === participant.userId);
}

// 新一轮或被选中者变化时清空输入，避免把上一轮的草稿带到下一轮。
watch(
  () => props.round?.roundNo,
  () => {
    promptText.value = '';
    answerText.value = '';
    pendingVoice.value = null;
    voiceError.value = '';
  }
);

// 被选中者开始选择时启动倒计时刷新，其余阶段停止计时器节省开销。
watch(
  () => props.phase,
  (phase) => {
    if (phase === 'choosing') {
      nowTick.value = Date.now();
      if (countdownTimer === null) countdownTimer = window.setInterval(() => (nowTick.value = Date.now()), 250);
    } else if (countdownTimer !== null) {
      window.clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }
);

onMounted(() => {
  if (props.phase === 'choosing' && countdownTimer === null) {
    countdownTimer = window.setInterval(() => (nowTick.value = Date.now()), 250);
  }
});
onBeforeUnmount(() => {
  if (countdownTimer !== null) window.clearInterval(countdownTimer);
});

function submitPrompt() {
  const content = promptText.value.trim();
  if (!content) return;
  emit('prompt', content);
}

function submitAnswer() {
  const text = answerText.value.trim();
  if (!text && !pendingVoice.value) return;
  emit('answer', {
    ...(text ? { text } : {}),
    ...(pendingVoice.value
      ? { voiceKey: pendingVoice.value.key, voiceDurationMs: pendingVoice.value.durationMs }
      : {})
  });
}

async function startVoice() {
  voiceError.value = '';
  try {
    await start();
  } catch (error) {
    voiceError.value = t(
      error?.message === 'voice_recording_unsupported'
        ? 'truthDare.voiceUnsupported'
        : 'truthDare.voiceDenied'
    );
  }
}

async function stopVoice() {
  voiceError.value = '';
  try {
    const result = await finish();
    if (!result) return;
    if (result.durationMs < 500) {
      voiceError.value = t('truthDare.voiceTooShort');
      return;
    }
    voiceUploading.value = true;
    const payload = await api.uploadFile(result.file);
    pendingVoice.value = {
      key: payload?.file?.key || payload?.file?.url,
      durationMs: result.durationMs
    };
  } catch (error) {
    voiceError.value = error?.message || t('truthDare.actionFailed');
  } finally {
    voiceUploading.value = false;
  }
}

function clearVoice() {
  pendingVoice.value = null;
}
</script>

<template>
  <section class="td-room">
    <header class="td-room__header">
      <button type="button" class="td-room__back" @click="emit('back')">
        {{ t('truthDare.backToLobby') }}
      </button>
      <div class="td-room__titles">
        <h2>
          <Sparkles :size="18" aria-hidden="true" />
          {{ game?.title || t('truthDare.gameTitleFallback') }}
        </h2>
        <p class="td-room__meta">
          <span>{{ t(`truthDare.scope.${game?.scope || 'public'}`) }}</span>
          <span v-if="game?.channelName">· {{ game.channelName }}</span>
          <span>· {{ t(`truthDare.status.${game?.status || 'playing'}`) }}</span>
          <span v-if="round?.roundNo">· {{ t('truthDare.roundNo', { n: round.roundNo }) }}</span>
        </p>
      </div>
      <div class="td-room__header-actions">
        <button
          v-if="game?.status === 'playing'"
          type="button"
          class="td-btn td-btn--ghost"
          :disabled="actionLoading"
          @click="emit('leave')"
        >
          {{ t('truthDare.leave') }}
        </button>
      </div>
    </header>

    <p v-if="actionError" class="td-alert" role="alert">{{ actionError }}</p>

    <div class="td-room__body">
      <div class="td-room__stage">
        <SpinWheel
          :participants="participants.map((p) => ({ ...p, label: participantLabel(p) }))"
          :target-index="wheelTargetIndex"
          :spinning="wheelSpinning"
          @settled="emit('wheel-settled')"
        >
          <template #empty>{{ t('truthDare.noOnlinePlayers') }}</template>
        </SpinWheel>

        <div class="td-phase" :class="`td-phase--${phase || 'idle'}`">
          <span class="td-phase__badge">{{ t(`truthDare.phase.${phase || 'idle'}`) }}</span>
          <template v-if="phase === 'choosing'">
            <div class="td-countdown">
              <svg viewBox="0 0 36 36" class="td-countdown__ring" aria-hidden="true">
                <circle cx="18" cy="18" r="16" class="td-countdown__track" />
                <circle
                  cx="18"
                  cy="18"
                  r="16"
                  class="td-countdown__value"
                  :stroke-dasharray="COUNTDOWN_CIRCUMFERENCE.toFixed(2)"
                  :stroke-dashoffset="countdownOffset.toFixed(2)"
                />
              </svg>
              <strong>{{ secondsLeft }}</strong>
            </div>
            <p class="td-phase__text">
              {{ isSelfChosen ? t('truthDare.youAreChosen') : t('truthDare.choosing', { name: chosenName }) }}
              <small>{{ t('truthDare.chooseTimeout') }}</small>
            </p>
          </template>
          <template v-else-if="phase === 'idle'">
            <p class="td-phase__text">{{ canSpin ? t('truthDare.phase.idle') : t('truthDare.waitingCreator') }}</p>
          </template>
          <template v-else-if="phase === 'resolved'">
            <p class="td-phase__text">{{ t('truthDare.resolvedTitle') }} · {{ t('truthDare.selectedAs', { name: chosenName }) }}</p>
          </template>
          <template v-else>
            <p class="td-phase__text">{{ t('truthDare.chosenLabel', { name: chosenName }) }}</p>
          </template>
        </div>
      </div>

      <aside class="td-room__side">
        <h3>{{ t('truthDare.participants') }} <span class="td-muted">{{ onlineCount }}/{{ participants.length }}</span></h3>
        <ul class="td-participants">
          <li
            v-for="participant in participants"
            :key="participant.userId"
            :class="{ 'td-participants__item--chosen': participant.userId === round?.chosenUserId }"
          >
            <span class="td-dot" :class="{ 'td-dot--online': participant.online }" :title="participant.online ? t('truthDare.online') : t('truthDare.offline')"></span>
            <div class="td-participants__info">
              <strong>{{ participantLabel(participant) }}</strong>
              <small>
                <span v-if="participant.isCreator"><Crown :size="12" aria-hidden="true" /> {{ t('truthDare.creatorTag') }}</span>
                <span v-if="participant.userId === me?.userId">· {{ t('truthDare.youTag') }}</span>
              </small>
            </div>
            <span v-if="hasSubmitted(participant)" class="td-participants__mark" :title="t('truthDare.submitPrompt')"><Check :size="14" aria-hidden="true" /></span>
            <span v-if="participant.userId === round?.chosenUserId" class="td-participants__chosen">{{ t('truthDare.chosenTag') }}</span>
          </li>
          <li v-if="!participants.length" class="td-empty">{{ t('truthDare.noOnlinePlayers') }}</li>
        </ul>
      </aside>
    </div>

    <!-- 阶段操作区：按 phase 与 me 条件渲染，被选中者不出现出题/投票入口。 -->
    <div class="td-actions">
      <template v-if="phase === 'idle'">
        <button v-if="canSpin" type="button" class="td-btn td-btn--primary td-btn--big" :disabled="actionLoading || onlineCount === 0" @click="emit('spin')">
          <Sparkles :size="18" aria-hidden="true" />{{ wheelSpinning ? t('truthDare.spinning') : t('truthDare.spin') }}
        </button>
        <p v-else class="td-hint">{{ t('truthDare.waitingCreator') }}</p>
      </template>

      <template v-else-if="phase === 'choosing'">
        <template v-if="canChoose">
          <button type="button" class="td-btn td-btn--primary td-btn--big" :disabled="actionLoading" @click="emit('choose', 'truth')">
            {{ t('truthDare.truth') }}
          </button>
          <button type="button" class="td-btn td-btn--danger td-btn--big" :disabled="actionLoading" @click="emit('choose', 'dare')">
            {{ t('truthDare.dare') }}
          </button>
        </template>
        <p v-else class="td-hint">{{ t('truthDare.choosing', { name: chosenName }) }}</p>
      </template>

      <template v-else-if="phase === 'collecting'">
        <template v-if="isSelfChosen">
          <p class="td-hint">{{ t('truthDare.participantCannotPrompt') }}</p>
        </template>
        <template v-else-if="canSubmitPrompt">
          <label class="td-field">
            <span>{{ t('truthDare.promptPrompt') }} <small>{{ t('truthDare.promptLimit') }}</small></span>
            <textarea
              v-model="promptText"
              rows="2"
              :placeholder="t(isDare ? 'truthDare.promptPlaceholder.dare' : 'truthDare.promptPlaceholder.truth')"
            ></textarea>
          </label>
          <button type="button" class="td-btn td-btn--primary" :disabled="actionLoading || !promptText.trim()" @click="submitPrompt">
            {{ t('truthDare.submitPrompt') }}
          </button>
        </template>
        <p v-else-if="hasSubmittedPrompt" class="td-hint">{{ t('truthDare.promptSubmitted') }}</p>
        <p v-else class="td-hint">{{ t('truthDare.promptLimit') }}</p>
        <button v-if="canOpenVoting" type="button" class="td-btn td-btn--secondary" :disabled="actionLoading" @click="emit('open-voting')">
          {{ t('truthDare.openVoting') }}
        </button>
      </template>

      <template v-else-if="phase === 'voting'">
        <div class="td-candidates">
          <h4>{{ t('truthDare.candidates') }}</h4>
          <p v-if="roundPromptsEmpty" class="td-empty">{{ t('truthDare.noCandidates') }}</p>
          <ul v-else>
            <li
              v-for="prompt in prompts"
              :key="prompt.id"
              :class="{ 'td-candidates__item--winner': prompt.id === round?.winningPromptId }"
            >
              <div class="td-candidates__text">
                <strong>{{ prompt.content }}</strong>
                <small>{{ prompt.authorName }} · {{ t('truthDare.voteCount', { count: prompt.voteCount }) }}</small>
              </div>
              <button
                v-if="phase === 'voting' && canVote"
                type="button"
                class="td-btn td-btn--small"
                :disabled="actionLoading || prompt.votedByMe"
                @click="emit('vote', prompt.id)"
              >
                <ThumbsUp :size="14" aria-hidden="true" />{{ prompt.votedByMe ? t('truthDare.voted') : t('truthDare.vote') }}
              </button>
              <span v-else-if="prompt.votedByMe" class="td-voted">{{ t('truthDare.voted') }}</span>
            </li>
          </ul>
        </div>
        <p v-if="phase === 'voting' && isSelfChosen" class="td-hint">{{ t('truthDare.participantCannotPrompt') }}</p>
        <button v-if="canCloseVoting" type="button" class="td-btn td-btn--secondary" :disabled="actionLoading" @click="emit('close-voting')">
          {{ t('truthDare.closeVoting') }}
        </button>
      </template>

      <template v-else-if="phase === 'answering'">
        <template v-if="canAnswer">
          <div class="td-answer">
            <div v-if="winningPrompt || round?.winningContent" class="td-winning">
              <span>{{ t('truthDare.winningPrompt') }}</span>
              <strong>{{ winningPrompt?.content || round?.winningContent }}</strong>
            </div>
            <label class="td-field">
              <span>{{ t('truthDare.answerTextLabel') }}</span>
              <textarea v-model="answerText" rows="3" :placeholder="t('truthDare.answerPlaceholder')"></textarea>
            </label>
            <div class="td-voice">
              <button
                v-if="!recording"
                type="button"
                class="td-btn td-btn--secondary"
                :disabled="actionLoading || starting || voiceUploading"
                @click="startVoice"
              >
                <Mic :size="16" aria-hidden="true" />{{ t('truthDare.recordStart') }}
              </button>
              <template v-else>
                <span class="td-recording-dot" aria-hidden="true"></span>
                <span class="td-recording-time">{{ formatVoiceDuration(elapsedMs) }}</span>
                <div class="td-recording-wave" aria-hidden="true">
                  <span v-for="(sample, index) in liveWaveform" :key="index" :style="{ height: `${Math.max(16, sample)}%` }"></span>
                </div>
                <button type="button" class="td-btn td-btn--danger" :disabled="actionLoading" @click="stopVoice">
                  <Square :size="16" aria-hidden="true" />{{ t('truthDare.recordStop') }}
                </button>
              </template>
            </div>
            <p v-if="pendingVoice" class="td-voice-ready">
              {{ t('truthDare.answerVoiceLabel') }} · {{ formatVoiceDuration(pendingVoice.durationMs) }}
              <button type="button" class="td-link" @click="clearVoice">{{ t('common.remove') }}</button>
            </p>
            <p v-if="voiceUploading" class="td-hint">{{ t('common.uploading') }}</p>
            <p v-if="voiceError" class="td-alert" role="alert">{{ voiceError }}</p>
            <button type="button" class="td-btn td-btn--primary td-btn--big" :disabled="actionLoading || (!answerText.trim() && !pendingVoice)" @click="submitAnswer">
              {{ t('truthDare.submitAnswer') }}
            </button>
          </div>
        </template>
        <p v-else class="td-hint">{{ t('truthDare.choosing', { name: chosenName }) }}</p>
      </template>

      <template v-else-if="phase === 'confirming'">
        <div class="td-winning">
          <span>{{ t('truthDare.winningPrompt') }}</span>
          <strong>{{ winningPrompt?.content || round?.winningContent || t('truthDare.winningPromptEmpty') }}</strong>
        </div>
        <div v-if="round?.answerText" class="td-answer-display">{{ round.answerText }}</div>
        <p class="td-hint">{{ t('truthDare.awaitConfirm') }}</p>
        <button v-if="canConfirm" type="button" class="td-btn td-btn--primary td-btn--big" :disabled="actionLoading" @click="emit('confirm')">
          <UserCheck :size="18" aria-hidden="true" />{{ t('truthDare.confirm') }}
        </button>
        <p v-else-if="round?.confirmedBy" class="td-confirmed"><CircleCheck :size="16" aria-hidden="true" />{{ t('truthDare.confirmedBy', { name: round.confirmedBy }) }}</p>
      </template>

      <template v-else-if="phase === 'resolved'">
        <div class="td-winning">
          <span>{{ t('truthDare.winningPrompt') }}</span>
          <strong>{{ winningPrompt?.content || round?.winningContent || t('truthDare.winningPromptEmpty') }}</strong>
        </div>
        <div v-if="round?.answerText" class="td-answer-display">{{ round.answerText }}</div>
        <div v-else-if="round?.answerVoiceUrl || round?.answerVoiceKey" class="td-answer-display">
          <!-- biome-ignore lint/a11y/useMediaCaption: Voice answers have no caption tracks. -->
          <audio controls :src="api.getFileUrl(round.answerVoiceUrl || round.answerVoiceKey)"></audio>
        </div>
        <button v-if="canSpin" type="button" class="td-btn td-btn--primary td-btn--big" :disabled="actionLoading" @click="emit('spin')">
          {{ t('truthDare.nextRound') }}
        </button>
      </template>

      <!-- 旁观者可在本局进行中加入并参与。 -->
      <div v-if="!me?.isParticipant && status === 'playing'" class="td-join-banner">
        <p class="td-hint">{{ t('truthDare.spectatorHint') }}</p>
        <button type="button" class="td-btn td-btn--primary" :disabled="actionLoading" @click="emit('join')">
          {{ t('truthDare.join') }}
        </button>
      </div>

      <div v-if="canEndGame" class="td-actions__footer">
        <button type="button" class="td-btn td-btn--ghost" :disabled="actionLoading" @click="emit('end-game')">
          {{ t('truthDare.endGame') }}
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.td-room {
  display: grid;
  gap: 16px;
  width: min(1080px, 100%);
  margin: 0 auto;
  color: #e8eef6;
}

.td-room__header {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.td-room__back {
  min-height: 40px;
  padding: 0 14px;
  border: 1px solid rgba(148, 163, 184, 0.35);
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.6);
  color: #e2e8f0;
  font: inherit;
  cursor: pointer;
}

.td-room__titles {
  flex: 1;
  min-width: 0;
}

.td-room__titles h2 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 1.2rem;
  color: #f8fafc;
}

.td-room__meta {
  display: flex;
  gap: 6px;
  margin: 4px 0 0;
  flex-wrap: wrap;
  color: #94a3b8;
  font-size: 0.8rem;
}

.td-room__body {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}

.td-room__stage {
  display: grid;
  justify-items: center;
  gap: 18px;
  padding: 22px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 24px;
  background: radial-gradient(circle at 50% 20%, rgba(30, 41, 59, 0.9), rgba(2, 6, 23, 0.95));
}

.td-room__side {
  padding: 18px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 20px;
  background: rgba(15, 23, 42, 0.75);
}

.td-room__side h3 {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin: 0 0 10px;
  font-size: 0.95rem;
  color: #e2e8f0;
}

.td-participants {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.td-participants li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 12px;
  background: rgba(148, 163, 184, 0.08);
}

.td-participants__item--chosen {
  background: linear-gradient(90deg, rgba(236, 72, 153, 0.28), rgba(99, 102, 241, 0.18));
  box-shadow: inset 0 0 0 1px rgba(244, 114, 182, 0.5);
}

.td-participants__info {
  display: grid;
  min-width: 0;
  flex: 1;
}

.td-participants__info strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.88rem;
}

.td-participants__info small {
  display: flex;
  align-items: center;
  gap: 3px;
  color: #94a3b8;
  font-size: 0.72rem;
}

.td-participants__mark {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: rgba(34, 197, 94, 0.22);
  color: #4ade80;
}

.td-participants__chosen {
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(244, 114, 182, 0.25);
  color: #f9a8d4;
  font-size: 0.7rem;
}

.td-dot {
  width: 9px;
  height: 9px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: #64748b;
}

.td-dot--online {
  background: #22c55e;
  box-shadow: 0 0 8px 2px rgba(34, 197, 94, 0.6);
}

.td-muted { color: #94a3b8; font-weight: 400; }
.td-empty { padding: 12px; text-align: center; color: #94a3b8; font-size: 0.85rem; }
.td-hint { margin: 0; color: #94a3b8; font-size: 0.85rem; }
.td-alert { margin: 0; padding: 10px 14px; border: 1px solid #f87171; border-radius: 12px; background: rgba(248, 113, 113, 0.12); color: #fca5a5; font-size: 0.82rem; }

.td-phase {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  justify-content: center;
}

.td-phase__badge {
  padding: 4px 12px;
  border-radius: 999px;
  background: rgba(56, 189, 248, 0.18);
  color: #7dd3fc;
  font-size: 0.78rem;
  font-weight: 700;
}

.td-phase__text {
  margin: 0;
  text-align: center;
  font-size: 0.9rem;
  color: #e2e8f0;
}

.td-phase__text small { display: block; color: #94a3b8; font-size: 0.75rem; }

.td-countdown {
  position: relative;
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
}

.td-countdown__ring { width: 100%; height: 100%; transform: rotate(-90deg); }
.td-countdown__track { fill: none; stroke: rgba(148, 163, 184, 0.25); stroke-width: 3; }
.td-countdown__value { fill: none; stroke: #f472b6; stroke-width: 3; stroke-linecap: round; transition: stroke-dashoffset 0.25s linear; }
.td-countdown strong { position: absolute; font-size: 0.9rem; color: #f8fafc; }

.td-actions {
  display: grid;
  gap: 12px;
  padding: 18px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 20px;
  background: rgba(15, 23, 42, 0.7);
}

.td-actions__footer {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  padding-top: 10px;
  border-top: 1px solid rgba(148, 163, 184, 0.16);
}

.td-join-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 14px;
  border-radius: 12px;
  background: rgba(56, 189, 248, 0.1);
}

.td-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 42px;
  padding: 0 16px;
  border: 1px solid rgba(148, 163, 184, 0.35);
  border-radius: 12px;
  background: rgba(148, 163, 184, 0.12);
  color: #e2e8f0;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  transition: transform 0.15s ease, background 0.15s ease;
}

.td-btn:hover:not(:disabled) { transform: translateY(-1px); background: rgba(148, 163, 184, 0.22); }
.td-btn:disabled { cursor: not-allowed; opacity: 0.5; }
.td-btn--primary { border-color: transparent; background: linear-gradient(135deg, #6366f1, #ec4899); color: #fff; }
.td-btn--secondary { border-color: rgba(56, 189, 248, 0.5); background: rgba(56, 189, 248, 0.14); color: #7dd3fc; }
.td-btn--danger { border-color: transparent; background: linear-gradient(135deg, #f97316, #ef4444); color: #fff; }
.td-btn--ghost { background: transparent; color: #cbd5e1; }
.td-btn--big { min-height: 52px; font-size: 1rem; }
.td-btn--small { min-height: 34px; padding: 0 12px; font-size: 0.8rem; }

.td-field { display: grid; gap: 6px; }
.td-field > span { font-size: 0.82rem; color: #cbd5e1; }
.td-field > span small { color: #94a3b8; }
.td-field textarea {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid rgba(148, 163, 184, 0.3);
  border-radius: 12px;
  background: rgba(2, 6, 23, 0.7);
  color: #f1f5f9;
  font: inherit;
  resize: vertical;
}

.td-candidates { display: grid; gap: 8px; }
.td-candidates h4 { margin: 0; font-size: 0.9rem; color: #e2e8f0; }
.td-candidates ul { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.td-candidates li { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 12px; background: rgba(148, 163, 184, 0.1); }
.td-candidates__item--winner { background: linear-gradient(90deg, rgba(34, 197, 94, 0.25), rgba(56, 189, 248, 0.18)); box-shadow: inset 0 0 0 1px rgba(74, 222, 128, 0.5); }
.td-candidates__text { display: grid; gap: 2px; flex: 1; min-width: 0; }
.td-candidates__text strong { overflow-wrap: anywhere; font-size: 0.9rem; }
.td-candidates__text small { color: #94a3b8; font-size: 0.75rem; }
.td-voted { color: #4ade80; font-size: 0.78rem; }

.td-answer { display: grid; gap: 12px; }
.td-winning { display: grid; gap: 2px; padding: 12px 14px; border-radius: 12px; background: rgba(236, 72, 153, 0.14); }
.td-winning span { color: #f9a8d4; font-size: 0.75rem; }
.td-winning strong { font-size: 0.95rem; overflow-wrap: anywhere; }
.td-answer-display { padding: 12px 14px; border-radius: 12px; background: rgba(148, 163, 184, 0.12); overflow-wrap: anywhere; }
.td-answer-display audio { width: 100%; }

.td-voice { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.td-recording-dot { width: 10px; height: 10px; border-radius: 50%; background: #ef4444; animation: td-pulse 1.2s ease-in-out infinite; }
.td-recording-time { font-variant-numeric: tabular-nums; color: #f8fafc; }
.td-recording-wave { display: flex; align-items: center; gap: 2px; height: 22px; min-width: 60px; }
.td-recording-wave span { flex: 1 1 2px; min-width: 2px; max-width: 4px; border-radius: 2px; background: #22d3ee; }
.td-voice-ready { display: flex; align-items: center; gap: 8px; margin: 0; color: #7dd3fc; font-size: 0.82rem; }
.td-link { border: 0; background: transparent; color: #fca5a5; font: inherit; font-size: 0.78rem; cursor: pointer; text-decoration: underline; }
.td-confirmed { display: flex; align-items: center; gap: 6px; margin: 0; color: #4ade80; font-size: 0.85rem; }

@keyframes td-pulse { 50% { opacity: 0.35; } }

@media (max-width: 900px) {
  .td-room__body { grid-template-columns: minmax(0, 1fr); }
}

@media (prefers-reduced-motion: reduce) {
  .td-btn, .td-countdown__value, .td-recording-dot { transition: none; animation: none; }
}
</style>
