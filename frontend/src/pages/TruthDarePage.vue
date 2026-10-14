<script setup>
import { ArrowLeft, Dices, Plus, RefreshCw, Sparkles, X } from '@lucide/vue';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import api from '../api.js';
import TruthDareRoom from '../components/truth-dare/TruthDareRoom.vue';
import { useTruthDare } from '../composables/useTruthDare.ts';
import { formatDateTime, t } from '../i18n.js';

const router = useRouter();

const {
  overviewLoading,
  overviewError,
  busy,
  allowMemberCreate,
  canCreate,
  canApprove,
  games,
  pendingApplications,
  myApplications,
  refreshOverview,
  createGame,
  reviewApplication,
  cancelApplication,
  joinGame,
  leaveGame,
  roomId,
  state,
  stateError,
  actionError,
  actionLoading,
  enterRoom,
  leaveRoom,
  runAction,
  phase,
  status,
  me,
  round,
  roomParticipants,
  phaseDeadlineMs,
  canSpin,
  canChoose,
  canSubmitPrompt,
  canVote,
  canOpenVoting,
  canCloseVoting,
  canAnswer,
  canConfirm,
  canEndGame,
  hasSubmittedPrompt,
  hasVoted
} = useTruthDare();

const showCreate = ref(false);
const channels = ref([]);
const channelsLoading = ref(false);
const notice = ref('');
const reviewReasons = reactive({});
const form = reactive({ scope: 'public', channelId: '', invitedUsersText: '', note: '', title: '' });

const channelOptions = computed(() =>
  channels.value.map((channel) => ({ value: channel.id, label: channel.name || channel.title || `#${channel.id}` }))
);

const wheelSpinning = ref(false);
const wheelTargetIndex = computed(() => {
  const chosenId = round.value?.chosenUserId;
  if (!chosenId) return -1;
  return roomParticipants.value.findIndex((participant) => participant.userId === chosenId);
});

const scopeOptions = computed(() => [
  { value: 'public', label: t('truthDare.scope.public') },
  { value: 'channel', label: t('truthDare.scope.channel') },
  { value: 'manual', label: t('truthDare.scope.manual') }
]);

const createNote = computed(() =>
  canCreate.value ? t('truthDare.createAllowed') : t('truthDare.createApprovalRequired')
);

async function loadChannels() {
  if (channels.value.length || channelsLoading.value) return;
  channelsLoading.value = true;
  try {
    channels.value = (await api.getChannels()).channels || [];
  } catch {
    channels.value = [];
  } finally {
    channelsLoading.value = false;
  }
}

watch(
  () => form.scope,
  (scope) => {
    if (scope === 'channel') void loadChannels();
  }
);

function parseInvitedUsers(text) {
  return [...new Set(
    String(text || '')
      .split(/[\n,，]/)
      .map((value) => value.trim())
      .filter(Boolean)
  )];
}

function toggleCreate() {
  showCreate.value = !showCreate.value;
  notice.value = '';
  if (showCreate.value) void loadChannels();
}

async function submitCreate() {
  const scope = form.scope;
  const payload = {
    scope,
    ...(scope === 'channel' && form.channelId ? { channelId: Number(form.channelId) } : {}),
    ...(scope === 'manual' ? { invitedUserIds: parseInvitedUsers(form.invitedUsersText) } : {}),
    ...(form.note.trim() ? { note: form.note.trim() } : {}),
    ...(form.title.trim() ? { title: form.title.trim() } : {})
  };
  const result = await createGame(payload);
  if (!result) return;
  showCreate.value = false;
  form.note = '';
  form.title = '';
  form.invitedUsersText = '';
  if (result.created?.id) {
    await enterRoom(result.created.id);
  } else if (result.application) {
    notice.value = t('truthDare.createApprovalRequired');
  }
}

async function decide(application, approve) {
  await reviewApplication(application.id, { approve, reason: String(reviewReasons[application.id] || '').trim() });
  reviewReasons[application.id] = '';
}

async function cancelMine(application) {
  if (!window.confirm(t('truthDare.cancelApplicationConfirm'))) return;
  await cancelApplication(application.id);
}

function enterGame(game) {
  notice.value = '';
  void enterRoom(game.id);
}

async function joinAndEnter(game) {
  const result = await joinGame(game.id);
  if (result !== null) void enterRoom(game.id);
}

function backToLobby() {
  leaveRoom();
  wheelSpinning.value = false;
  void refreshOverview();
}

function goBackToChat() {
  void router.push('/');
}

async function onSpin() {
  if (wheelSpinning.value) return;
  wheelSpinning.value = true;
  const result = await runAction('spin');
  if (result === null) wheelSpinning.value = false;
}

async function onJoin() {
  if (roomId.value) await joinGame(roomId.value);
}

async function onLeave() {
  if (!roomId.value) return;
  if (!window.confirm(t('truthDare.leaveConfirm'))) return;
  await leaveGame(roomId.value);
  backToLobby();
}

async function onEndGame() {
  if (!window.confirm(t('truthDare.endGameConfirm'))) return;
  await runAction('endGame');
}

function scopeLabel(scope) {
  return t(`truthDare.scope.${scope || 'public'}`);
}

function statusLabel(value) {
  return t(`truthDare.status.${value || 'playing'}`);
}

onMounted(() => {
  void refreshOverview();
});
</script>

<template>
  <div class="td-page">
    <!-- 房间视图：进入对局后接管整个页面。 -->
    <TruthDareRoom
      v-if="roomId"
      :game="state?.game"
      :me="me"
      :phase="phase"
      :status="status"
      :round="round"
      :participants="roomParticipants"
      :phase-deadline-ms="phaseDeadlineMs"
      :action-loading="actionLoading"
      :action-error="actionError || stateError"
      :wheel-spinning="wheelSpinning"
      :wheel-target-index="wheelTargetIndex"
      :can-spin="canSpin"
      :can-choose="canChoose"
      :can-submit-prompt="canSubmitPrompt"
      :can-vote="canVote"
      :can-open-voting="canOpenVoting"
      :can-close-voting="canCloseVoting"
      :can-answer="canAnswer"
      :can-confirm="canConfirm"
      :can-end-game="canEndGame"
      :has-submitted-prompt="hasSubmittedPrompt"
      :has-voted="hasVoted"
      @spin="onSpin"
      @wheel-settled="wheelSpinning = false"
      @choose="(choice) => runAction('choose', { choice })"
      @prompt="(content) => runAction('prompt', { content })"
      @open-voting="runAction('openVoting')"
      @vote="(promptId) => runAction('vote', { promptId })"
      @close-voting="runAction('closeVoting')"
      @answer="(payload) => runAction('answer', payload)"
      @confirm="runAction('confirm')"
      @end-game="onEndGame"
      @join="onJoin"
      @leave="onLeave"
      @back="backToLobby"
    />

    <!-- 大厅视图。 -->
    <div v-else class="td-lobby">
      <header class="td-lobby__header">
        <button type="button" class="td-btn td-btn--ghost" @click="goBackToChat">
          <ArrowLeft :size="16" aria-hidden="true" />{{ t('truthDare.backToChat') }}
        </button>
        <div class="td-lobby__titles">
          <h1><Sparkles :size="22" aria-hidden="true" />{{ t('truthDare.title') }}</h1>
          <p>{{ t('truthDare.subtitle') }}</p>
        </div>
        <div class="td-lobby__header-actions">
          <button type="button" class="td-btn td-btn--ghost" :disabled="overviewLoading" @click="refreshOverview">
            <RefreshCw :size="16" aria-hidden="true" />{{ t('common.refresh') }}
          </button>
          <button type="button" class="td-btn td-btn--primary" @click="toggleCreate">
            <Plus :size="16" aria-hidden="true" />{{ t('truthDare.openCreate') }}
          </button>
        </div>
      </header>

      <p class="td-lobby__note"><Dices :size="15" aria-hidden="true" />{{ allowMemberCreate ? t('truthDare.createAllowed') : createNote }}</p>

      <p v-if="overviewError" class="td-alert" role="alert">{{ overviewError }}</p>
      <p v-else-if="notice" class="td-notice">{{ notice }}</p>

      <!-- 开一局表单。 -->
      <form v-if="showCreate" class="td-panel td-create" @submit.prevent="submitCreate">
        <div class="td-create__head">
          <h2>{{ t('truthDare.createTitle') }}</h2>
          <button type="button" class="td-link" :aria-label="t('common.close')" @click="showCreate = false"><X :size="18" aria-hidden="true" /></button>
        </div>

        <div class="td-scope">
          <button
            v-for="option in scopeOptions"
            :key="option.value"
            type="button"
            class="td-scope__option"
            :class="{ 'td-scope__option--active': form.scope === option.value }"
            @click="form.scope = option.value"
          >
            {{ option.label }}
          </button>
        </div>

        <label v-if="form.scope === 'channel'" class="td-field">
          <span>{{ t('truthDare.channel') }}</span>
          <select v-model="form.channelId">
            <option value="">{{ channelsLoading ? t('common.loading') : t('truthDare.channelPlaceholder') }}</option>
            <option v-for="channel in channelOptions" :key="channel.value" :value="channel.value">{{ channel.label }}</option>
          </select>
        </label>

        <label v-if="form.scope === 'manual'" class="td-field">
          <span>{{ t('truthDare.invitedUsers') }}</span>
          <textarea v-model="form.invitedUsersText" rows="3" :placeholder="t('truthDare.invitedUsersPlaceholder')"></textarea>
        </label>

        <label class="td-field">
          <span>{{ t('truthDare.titleInput') }}</span>
          <input v-model="form.title" type="text" :placeholder="t('truthDare.titlePlaceholder')" />
        </label>

        <label class="td-field">
          <span>{{ t('truthDare.note') }}</span>
          <textarea v-model="form.note" rows="2" :placeholder="t('truthDare.notePlaceholder')"></textarea>
        </label>

        <p class="td-hint">{{ createNote }}</p>
        <div class="td-create__actions">
          <button type="button" class="td-btn td-btn--ghost" @click="showCreate = false">{{ t('common.cancel') }}</button>
          <button type="submit" class="td-btn td-btn--primary" :disabled="busy || (form.scope === 'channel' && !form.channelId)">
            {{ busy ? t('truthDare.submitting') : t('truthDare.submit') }}
          </button>
        </div>
      </form>

      <!-- 待审批列表（仅审批人可见）。 -->
      <section v-if="canApprove" class="td-panel">
        <h2>{{ t('truthDare.pendingApplications') }}</h2>
        <p v-if="!pendingApplications.length" class="td-empty">{{ t('truthDare.noPendingApplications') }}</p>
        <ul v-else class="td-applications">
          <li v-for="application in pendingApplications" :key="application.id">
            <div class="td-applications__info">
              <strong>{{ application.applicantName }}</strong>
              <small>
                {{ scopeLabel(application.scope) }}
                <template v-if="application.channelName"> · {{ application.channelName }}</template>
                · {{ formatDateTime(application.createdAt) }}
              </small>
              <p v-if="application.note" class="td-applications__note">{{ application.note }}</p>
            </div>
            <input v-model="reviewReasons[application.id]" type="text" class="td-applications__reason" :placeholder="t('truthDare.reasonPlaceholder')" />
            <div class="td-applications__actions">
              <button type="button" class="td-btn td-btn--primary td-btn--small" :disabled="busy" @click="decide(application, true)">{{ t('truthDare.approve') }}</button>
              <button type="button" class="td-btn td-btn--danger td-btn--small" :disabled="busy" @click="decide(application, false)">{{ t('truthDare.reject') }}</button>
            </div>
          </li>
        </ul>
      </section>

      <!-- 可见对局列表。 -->
      <section class="td-panel">
        <h2>{{ t('truthDare.gamesList') }}</h2>
        <p v-if="overviewLoading && !games.length" class="td-empty">{{ t('common.loading') }}</p>
        <p v-else-if="!games.length" class="td-empty">{{ t('truthDare.empty') }}<br /><small>{{ t('truthDare.emptyHint') }}</small></p>
        <ul v-else class="td-games">
          <li v-for="game in games" :key="game.id" class="td-game">
            <div class="td-game__main">
              <strong>{{ game.title || t('truthDare.gameTitleFallback') }}</strong>
              <div class="td-game__meta">
                <span class="td-badge" :class="`td-badge--${game.status}`">{{ statusLabel(game.status) }}</span>
                <span>{{ scopeLabel(game.scope) }}</span>
                <span v-if="game.channelName">· {{ game.channelName }}</span>
                <span>· {{ t('truthDare.participantCount', { count: game.participantCount }) }}</span>
                <span v-if="game.roundNo">· {{ t('truthDare.roundNo', { n: game.roundNo }) }}</span>
              </div>
            </div>
            <div class="td-game__actions">
              <span v-if="game.isParticipant" class="td-tag">{{ t('truthDare.joinedTag') }}</span>
              <button v-if="game.isParticipant" type="button" class="td-btn td-btn--primary td-btn--small" @click="enterGame(game)">{{ t('truthDare.enter') }}</button>
              <button v-else-if="game.status === 'playing'" type="button" class="td-btn td-btn--primary td-btn--small" :disabled="busy" @click="joinAndEnter(game)">{{ t('truthDare.join') }}</button>
              <button v-else type="button" class="td-btn td-btn--small" @click="enterGame(game)">{{ t('truthDare.enter') }}</button>
            </div>
          </li>
        </ul>
      </section>

      <!-- 我的申请列表。 -->
      <section class="td-panel">
        <h2>{{ t('truthDare.myApplications') }}</h2>
        <p v-if="!myApplications.length" class="td-empty">{{ t('truthDare.noMyApplications') }}</p>
        <ul v-else class="td-applications">
          <li v-for="application in myApplications" :key="application.id">
            <div class="td-applications__info">
              <strong>{{ scopeLabel(application.scope) }}<template v-if="application.channelName"> · {{ application.channelName }}</template></strong>
              <small>
                <span class="td-badge" :class="`td-badge--${application.status}`">{{ statusLabel(application.status) }}</span>
                · {{ formatDateTime(application.createdAt) }}
              </small>
              <p v-if="application.note" class="td-applications__note">{{ application.note }}</p>
              <p v-if="application.reviewReason" class="td-applications__reason-text">{{ t('truthDare.reason') }}: {{ application.reviewReason }}</p>
            </div>
            <div class="td-applications__actions">
              <button v-if="application.gameId" type="button" class="td-btn td-btn--primary td-btn--small" @click="enterRoom(application.gameId)">{{ t('truthDare.enter') }}</button>
              <button v-else-if="application.status === 'pending'" type="button" class="td-btn td-btn--ghost td-btn--small" :disabled="busy" @click="cancelMine(application)">{{ t('truthDare.cancelApplication') }}</button>
            </div>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.td-page {
  min-height: 100dvh;
  padding: max(16px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom));
  background: radial-gradient(circle at 20% 0%, #1e293b, #020617 70%);
  color: #e8eef6;
}

.td-lobby {
  display: grid;
  gap: 18px;
  width: min(960px, 100%);
  margin: 0 auto;
}

.td-lobby__header {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.td-lobby__titles {
  flex: 1;
  min-width: 0;
}

.td-lobby__titles h1 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 1.35rem;
  color: #f8fafc;
}

.td-lobby__titles p {
  margin: 4px 0 0;
  color: #94a3b8;
  font-size: 0.85rem;
}

.td-lobby__header-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.td-lobby__note {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 10px 14px;
  border-radius: 12px;
  background: rgba(99, 102, 241, 0.14);
  color: #c7d2fe;
  font-size: 0.83rem;
}

.td-panel {
  display: grid;
  gap: 12px;
  padding: 18px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 18px;
  background: rgba(15, 23, 42, 0.72);
}

.td-panel h2 {
  margin: 0;
  font-size: 1rem;
  color: #e2e8f0;
}

.td-create__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.td-create__actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.td-scope {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.td-scope__option {
  min-height: 38px;
  padding: 0 16px;
  border: 1px solid rgba(148, 163, 184, 0.3);
  border-radius: 999px;
  background: transparent;
  color: #cbd5e1;
  font: inherit;
  cursor: pointer;
}

.td-scope__option--active {
  border-color: transparent;
  background: linear-gradient(135deg, #6366f1, #ec4899);
  color: #fff;
}

.td-field { display: grid; gap: 6px; }
.td-field > span { font-size: 0.82rem; color: #cbd5e1; }
.td-field input,
.td-field textarea,
.td-field select {
  width: 100%;
  min-height: 42px;
  padding: 10px 12px;
  border: 1px solid rgba(148, 163, 184, 0.3);
  border-radius: 12px;
  background: rgba(2, 6, 23, 0.7);
  color: #f1f5f9;
  font: inherit;
}
.td-field textarea { resize: vertical; }

.td-games { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
.td-game {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 14px 16px;
  border-radius: 14px;
  background: rgba(148, 163, 184, 0.08);
}
.td-game__main { display: grid; gap: 4px; min-width: 0; }
.td-game__main strong { font-size: 0.98rem; overflow-wrap: anywhere; }
.td-game__meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; color: #94a3b8; font-size: 0.78rem; }
.td-game__actions { display: flex; align-items: center; gap: 8px; }

.td-applications { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
.td-applications li {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 12px 14px;
  border-radius: 12px;
  background: rgba(148, 163, 184, 0.08);
}
.td-applications__info { display: grid; gap: 3px; flex: 1; min-width: 160px; }
.td-applications__info small { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; color: #94a3b8; font-size: 0.75rem; }
.td-applications__note { margin: 0; color: #cbd5e1; font-size: 0.82rem; overflow-wrap: anywhere; }
.td-applications__reason-text { margin: 0; color: #fca5a5; font-size: 0.8rem; }
.td-applications__reason {
  flex: 1 1 200px;
  min-height: 38px;
  padding: 8px 12px;
  border: 1px solid rgba(148, 163, 184, 0.3);
  border-radius: 10px;
  background: rgba(2, 6, 23, 0.7);
  color: #f1f5f9;
  font: inherit;
}
.td-applications__actions { display: flex; gap: 8px; }

.td-badge { padding: 2px 10px; border-radius: 999px; background: rgba(148, 163, 184, 0.2); color: #cbd5e1; font-size: 0.72rem; }
.td-badge--playing, .td-badge--approved { background: rgba(34, 197, 94, 0.2); color: #4ade80; }
.td-badge--ended, .td-badge--rejected, .td-badge--cancelled { background: rgba(148, 163, 184, 0.2); color: #cbd5e1; }
.td-badge--pending { background: rgba(250, 204, 21, 0.18); color: #facc15; }

.td-tag { padding: 2px 10px; border-radius: 999px; background: rgba(56, 189, 248, 0.16); color: #7dd3fc; font-size: 0.72rem; }
.td-empty { margin: 0; padding: 18px; text-align: center; color: #94a3b8; font-size: 0.85rem; }
.td-hint { margin: 0; color: #94a3b8; font-size: 0.82rem; }
.td-notice { margin: 0; padding: 10px 14px; border-radius: 12px; background: rgba(56, 189, 248, 0.14); color: #7dd3fc; font-size: 0.82rem; }
.td-alert { margin: 0; padding: 10px 14px; border: 1px solid #f87171; border-radius: 12px; background: rgba(248, 113, 113, 0.12); color: #fca5a5; font-size: 0.82rem; }

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
.td-btn--danger { border-color: transparent; background: linear-gradient(135deg, #f97316, #ef4444); color: #fff; }
.td-btn--ghost { background: transparent; color: #cbd5e1; }
.td-btn--small { min-height: 36px; padding: 0 12px; font-size: 0.82rem; }

.td-link { display: inline-flex; align-items: center; border: 0; background: transparent; color: #cbd5e1; cursor: pointer; }

@media (max-width: 640px) {
  .td-lobby__header-actions { width: 100%; }
  .td-lobby__header-actions .td-btn { flex: 1; }
  .td-applications li { align-items: stretch; }
}

@media (prefers-reduced-motion: reduce) {
  .td-btn, .td-scope__option { transition: none; }
}
</style>
