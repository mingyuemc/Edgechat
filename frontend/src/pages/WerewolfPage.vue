<script setup>
import { ArrowLeft, Moon, Plus, RefreshCw, X } from '@lucide/vue';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import api from '../api.js';
import WerewolfRoom from '../components/werewolf/WerewolfRoom.vue';
import { useWerewolf } from '../composables/useWerewolf.ts';
import { formatDateTime, t } from '../i18n.js';

const router = useRouter();

const {
  overviewLoading,
  overviewError,
  busy,
  allowMemberCreate,
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
  roomParticipants,
  phaseDeadlineMs,
  night,
  day,
  vote,
  history,
  lastResult,
  roleConfig,
  roleConfigTotal,
  assignMode,
  myRole,
  winner,
  hasActed,
  isCreator,
  isParticipant,
  isAlive,
  canStart,
  canKill,
  canCheck,
  canWitch,
  canEndDiscussion,
  canVote,
  canEndGame
} = useWerewolf();

const showCreate = ref(false);
const channels = ref([]);
const channelsLoading = ref(false);
const notice = ref('');
const reviewReasons = reactive({});

const ROLE_KEYS = ['wolf', 'seer', 'witch', 'villager'];

const form = reactive({
  scope: 'public',
  channelId: '',
  invitedUsersText: '',
  note: '',
  title: '',
  assignMode: 'auto',
  roleConfig: { wolf: 1, seer: 1, witch: 1, villager: 1 }
});

const channelOptions = computed(() =>
  channels.value.map((channel) => ({ value: channel.id, label: channel.name || channel.title || `#${channel.id}` }))
);

const scopeOptions = computed(() => [
  { value: 'public', label: t('werewolf.scope.public') },
  { value: 'channel', label: t('werewolf.scope.channel') },
  { value: 'manual', label: t('werewolf.scope.manual') }
]);

const assignModeOptions = computed(() => [
  { value: 'auto', label: t('werewolf.assignMode.auto') },
  { value: 'manual', label: t('werewolf.assignMode.manual') }
]);

const formRoleTotal = computed(() => ROLE_KEYS.reduce((sum, role) => sum + Number(form.roleConfig[role] || 0), 0));

const createNote = computed(() =>
  allowMemberCreate.value ? t('werewolf.createAllowed') : t('werewolf.createApprovalRequired')
);

const canSubmit = computed(() => {
  if (busy.value) return false;
  if (formRoleTotal.value < 4 || formRoleTotal.value > 18) return false;
  if (form.scope === 'channel' && !form.channelId) return false;
  if (form.scope === 'manual' && !form.invitedUsersText.trim()) return false;
  return true;
});

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
  const roleConfigPayload = Object.fromEntries(ROLE_KEYS.map((role) => [role, Number(form.roleConfig[role] || 0)]));
  const payload = {
    scope,
    assignMode: form.assignMode,
    roleConfig: roleConfigPayload,
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
    notice.value = t('werewolf.createApprovalRequired');
  }
}

async function decide(application, approve) {
  await reviewApplication(application.id, { approve, reason: String(reviewReasons[application.id] || '').trim() });
  reviewReasons[application.id] = '';
}

async function cancelMine(application) {
  if (!window.confirm(t('werewolf.cancelApplicationConfirm'))) return;
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
  void refreshOverview();
}

function goBackToChat() {
  void router.push('/');
}

async function onJoin() {
  if (roomId.value) await joinGame(roomId.value);
}

async function onLeave() {
  if (!roomId.value) return;
  if (!window.confirm(t('werewolf.leaveConfirm'))) return;
  await leaveGame(roomId.value);
  backToLobby();
}

async function onStart(payload) {
  await runAction('start', payload || {});
}

async function onEndGame() {
  if (!window.confirm(t('werewolf.endGameConfirm'))) return;
  await runAction('endGame');
}

function scopeLabel(scope) {
  return t(`werewolf.scope.${scope || 'public'}`);
}

function statusLabel(value) {
  return t(`werewolf.status.${value || 'playing'}`);
}

onMounted(() => {
  void refreshOverview();
});
</script>

<template>
  <div class="ww-page">
    <!-- 房间视图：进入对局后接管整个页面。 -->
    <WerewolfRoom
      v-if="roomId"
      :game="state?.game"
      :me="me"
      :phase="phase"
      :status="status"
      :participants="roomParticipants"
      :phase-deadline-ms="phaseDeadlineMs"
      :action-loading="actionLoading"
      :action-error="actionError || stateError"
      :night="night"
      :day="day"
      :vote="vote"
      :history="history"
      :last-result="lastResult"
      :role-config="roleConfig"
      :role-config-total="roleConfigTotal"
      :assign-mode="assignMode"
      :my-role="myRole"
      :winner="winner"
      :has-acted="hasActed"
      :is-creator="isCreator"
      :is-participant="isParticipant"
      :is-alive="isAlive"
      :can-start="canStart"
      :can-kill="canKill"
      :can-check="canCheck"
      :can-witch="canWitch"
      :can-end-discussion="canEndDiscussion"
      :can-vote="canVote"
      :can-end-game="canEndGame"
      @start="onStart"
      @kill="(targetUserId) => runAction('wolfKill', { targetUserId })"
      @check="(targetUserId) => runAction('seerCheck', { targetUserId })"
      @witch="(payload) => runAction('witchAct', payload)"
      @end-discussion="runAction('endDiscussion')"
      @vote="(targetUserId) => runAction('vote', { targetUserId })"
      @end-game="onEndGame"
      @join="onJoin"
      @leave="onLeave"
      @back="backToLobby"
    />

    <!-- 大厅视图。 -->
    <div v-else class="ww-lobby">
      <header class="ww-lobby__header">
        <button type="button" class="ww-btn ww-btn--ghost" @click="goBackToChat">
          <ArrowLeft :size="16" aria-hidden="true" />{{ t('werewolf.backToChat') }}
        </button>
        <div class="ww-lobby__titles">
          <h1><Moon :size="22" aria-hidden="true" />{{ t('werewolf.title') }}</h1>
          <p>{{ t('werewolf.subtitle') }}</p>
        </div>
        <div class="ww-lobby__header-actions">
          <button type="button" class="ww-btn ww-btn--ghost" :disabled="overviewLoading" @click="refreshOverview">
            <RefreshCw :size="16" aria-hidden="true" />{{ t('common.refresh') }}
          </button>
          <button type="button" class="ww-btn ww-btn--primary" @click="toggleCreate">
            <Plus :size="16" aria-hidden="true" />{{ t('werewolf.openCreate') }}
          </button>
        </div>
      </header>

      <p class="ww-lobby__note"><Moon :size="15" aria-hidden="true" />{{ createNote }}</p>

      <p v-if="overviewError" class="ww-alert" role="alert">{{ overviewError }}</p>
      <p v-else-if="notice" class="ww-notice">{{ notice }}</p>

      <!-- 开一局表单。 -->
      <form v-if="showCreate" class="ww-panel ww-create" @submit.prevent="submitCreate">
        <div class="ww-create__head">
          <h2>{{ t('werewolf.createTitle') }}</h2>
          <button type="button" class="ww-link" :aria-label="t('common.close')" @click="showCreate = false"><X :size="18" aria-hidden="true" /></button>
        </div>

        <div class="ww-scope">
          <button
            v-for="option in scopeOptions"
            :key="option.value"
            type="button"
            class="ww-scope__option"
            :class="{ 'ww-scope__option--active': form.scope === option.value }"
            @click="form.scope = option.value"
          >
            {{ option.label }}
          </button>
        </div>

        <label v-if="form.scope === 'channel'" class="ww-field">
          <span>{{ t('werewolf.channel') }}</span>
          <select v-model="form.channelId">
            <option value="">{{ channelsLoading ? t('common.loading') : t('werewolf.channelPlaceholder') }}</option>
            <option v-for="channel in channelOptions" :key="channel.value" :value="channel.value">{{ channel.label }}</option>
          </select>
        </label>

        <label v-if="form.scope === 'manual'" class="ww-field">
          <span>{{ t('werewolf.invitedUsers') }}</span>
          <textarea v-model="form.invitedUsersText" rows="3" :placeholder="t('werewolf.invitedUsersPlaceholder')"></textarea>
        </label>

        <label class="ww-field">
          <span>{{ t('werewolf.titleInput') }}</span>
          <input v-model="form.title" type="text" :placeholder="t('werewolf.titlePlaceholder')" />
        </label>

        <!-- 角色配置。 -->
        <div class="ww-field">
          <span>{{ t('werewolf.roleConfig') }}<small class="ww-field__total">{{ t('werewolf.roleConfigTotal', { count: formRoleTotal }) }}</small></span>
          <div class="ww-roleconfig">
            <label v-for="role in ROLE_KEYS" :key="role" class="ww-roleconfig__item">
              <span>{{ t(`werewolf.role.${role}`) }}</span>
              <input v-model.number="form.roleConfig[role]" type="number" min="0" max="18" />
            </label>
          </div>
          <p class="ww-hint">{{ t('werewolf.roleConfigHint', { min: 4, max: 18 }) }}</p>
        </div>

        <!-- 分配方式。 -->
        <div class="ww-field">
          <span>{{ t('werewolf.assignMode') }}</span>
          <div class="ww-scope">
            <button
              v-for="option in assignModeOptions"
              :key="option.value"
              type="button"
              class="ww-scope__option"
              :class="{ 'ww-scope__option--active': form.assignMode === option.value }"
              @click="form.assignMode = option.value"
            >
              {{ option.label }}
            </button>
          </div>
          <p class="ww-hint">
            {{ form.assignMode === 'manual' ? t('werewolf.assignMode.manualHint') : t('werewolf.assignMode.autoHint') }}
          </p>
        </div>

        <label class="ww-field">
          <span>{{ t('werewolf.note') }}</span>
          <textarea v-model="form.note" rows="2" :placeholder="t('werewolf.notePlaceholder')"></textarea>
        </label>

        <div class="ww-create__actions">
          <button type="button" class="ww-btn ww-btn--ghost" @click="showCreate = false">{{ t('common.cancel') }}</button>
          <button type="submit" class="ww-btn ww-btn--primary" :disabled="!canSubmit">
            {{ busy ? t('werewolf.submitting') : t('werewolf.submit') }}
          </button>
        </div>
      </form>

      <!-- 待审批列表（仅审批人可见）。 -->
      <section v-if="canApprove" class="ww-panel">
        <h2>{{ t('werewolf.pendingApplications') }}</h2>
        <p v-if="!pendingApplications.length" class="ww-empty">{{ t('werewolf.noPendingApplications') }}</p>
        <ul v-else class="ww-applications">
          <li v-for="application in pendingApplications" :key="application.id">
            <div class="ww-applications__info">
              <strong>{{ application.applicantName }}</strong>
              <small>
                {{ scopeLabel(application.scope) }}
                <template v-if="application.channelName"> · {{ application.channelName }}</template>
                · {{ formatDateTime(application.createdAt) }}
              </small>
              <p v-if="application.note" class="ww-applications__note">{{ application.note }}</p>
            </div>
            <input v-model="reviewReasons[application.id]" type="text" class="ww-applications__reason" :placeholder="t('werewolf.reasonPlaceholder')" />
            <div class="ww-applications__actions">
              <button type="button" class="ww-btn ww-btn--primary ww-btn--small" :disabled="busy" @click="decide(application, true)">{{ t('werewolf.approve') }}</button>
              <button type="button" class="ww-btn ww-btn--danger ww-btn--small" :disabled="busy" @click="decide(application, false)">{{ t('werewolf.reject') }}</button>
            </div>
          </li>
        </ul>
      </section>

      <!-- 可见对局列表。 -->
      <section class="ww-panel">
        <h2>{{ t('werewolf.gamesList') }}</h2>
        <p v-if="overviewLoading && !games.length" class="ww-empty">{{ t('common.loading') }}</p>
        <p v-else-if="!games.length" class="ww-empty">{{ t('werewolf.empty') }}<br /><small>{{ t('werewolf.emptyHint') }}</small></p>
        <ul v-else class="ww-games">
          <li v-for="game in games" :key="game.id" class="ww-game">
            <div class="ww-game__main">
              <strong>{{ game.title || t('werewolf.gameTitleFallback') }}</strong>
              <div class="ww-game__meta">
                <span class="ww-badge" :class="`ww-badge--${game.status}`">{{ statusLabel(game.status) }}</span>
                <span>{{ scopeLabel(game.scope) }}</span>
                <span v-if="game.channelName">· {{ game.channelName }}</span>
                <span>· {{ t('werewolf.participantCount', { count: game.participantCount }) }}</span>
                <span v-if="game.roundNo">· {{ t('werewolf.roundNo', { n: game.roundNo }) }}</span>
              </div>
            </div>
            <div class="ww-game__actions">
              <span v-if="game.isParticipant" class="ww-tag">{{ t('werewolf.joinedTag') }}</span>
              <button v-if="game.isParticipant" type="button" class="ww-btn ww-btn--primary ww-btn--small" @click="enterGame(game)">{{ t('werewolf.enter') }}</button>
              <button v-else-if="game.status === 'playing'" type="button" class="ww-btn ww-btn--primary ww-btn--small" :disabled="busy" @click="joinAndEnter(game)">{{ t('werewolf.join') }}</button>
              <button v-else type="button" class="ww-btn ww-btn--small" @click="enterGame(game)">{{ t('werewolf.enter') }}</button>
            </div>
          </li>
        </ul>
      </section>

      <!-- 我的申请列表。 -->
      <section class="ww-panel">
        <h2>{{ t('werewolf.myApplications') }}</h2>
        <p v-if="!myApplications.length" class="ww-empty">{{ t('werewolf.noMyApplications') }}</p>
        <ul v-else class="ww-applications">
          <li v-for="application in myApplications" :key="application.id">
            <div class="ww-applications__info">
              <strong>{{ scopeLabel(application.scope) }}<template v-if="application.channelName"> · {{ application.channelName }}</template></strong>
              <small>
                <span class="ww-badge" :class="`ww-badge--${application.status}`">{{ statusLabel(application.status) }}</span>
                · {{ formatDateTime(application.createdAt) }}
              </small>
              <p v-if="application.note" class="ww-applications__note">{{ application.note }}</p>
              <p v-if="application.reviewReason" class="ww-applications__reason-text">{{ t('werewolf.reason') }}: {{ application.reviewReason }}</p>
            </div>
            <div class="ww-applications__actions">
              <button v-if="application.gameId" type="button" class="ww-btn ww-btn--primary ww-btn--small" @click="enterRoom(application.gameId)">{{ t('werewolf.enter') }}</button>
              <button v-else-if="application.status === 'pending'" type="button" class="ww-btn ww-btn--ghost ww-btn--small" :disabled="busy" @click="cancelMine(application)">{{ t('werewolf.cancelApplication') }}</button>
            </div>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.ww-page {
  min-height: 100dvh;
  padding: max(16px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom));
  background: radial-gradient(circle at 20% 0%, #1e293b, #020617 70%);
  color: #e8eef6;
}

.ww-lobby {
  display: grid;
  gap: 18px;
  width: min(960px, 100%);
  margin: 0 auto;
}

.ww-lobby__header {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.ww-lobby__titles {
  flex: 1;
  min-width: 0;
}

.ww-lobby__titles h1 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 1.35rem;
  color: #f8fafc;
}

.ww-lobby__titles p {
  margin: 4px 0 0;
  color: #94a3b8;
  font-size: 0.85rem;
}

.ww-lobby__header-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.ww-lobby__note {
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

.ww-panel {
  display: grid;
  gap: 12px;
  padding: 18px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 18px;
  background: rgba(15, 23, 42, 0.72);
}

.ww-panel h2 {
  margin: 0;
  font-size: 1rem;
  color: #e2e8f0;
}

.ww-create__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.ww-create__actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.ww-scope {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.ww-scope__option {
  min-height: 38px;
  padding: 0 16px;
  border: 1px solid rgba(148, 163, 184, 0.3);
  border-radius: 999px;
  background: transparent;
  color: #cbd5e1;
  font: inherit;
  cursor: pointer;
}

.ww-scope__option--active {
  border-color: transparent;
  background: linear-gradient(135deg, #6366f1, #ec4899);
  color: #fff;
}

.ww-field { display: grid; gap: 6px; }
.ww-field > span { display: flex; align-items: center; gap: 8px; font-size: 0.82rem; color: #cbd5e1; }
.ww-field__total { color: #94a3b8; font-size: 0.75rem; font-weight: 400; }
.ww-field input,
.ww-field textarea,
.ww-field select {
  width: 100%;
  min-height: 42px;
  padding: 10px 12px;
  border: 1px solid rgba(148, 163, 184, 0.3);
  border-radius: 12px;
  background: rgba(2, 6, 23, 0.7);
  color: #f1f5f9;
  font: inherit;
}
.ww-field textarea { resize: vertical; }

.ww-roleconfig { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.ww-roleconfig__item { display: grid; gap: 4px; font-size: 0.78rem; color: #cbd5e1; }
.ww-roleconfig__item input { min-height: 38px; }

.ww-games { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
.ww-game {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 14px 16px;
  border-radius: 14px;
  background: rgba(148, 163, 184, 0.08);
}
.ww-game__main { display: grid; gap: 4px; min-width: 0; }
.ww-game__main strong { font-size: 0.98rem; overflow-wrap: anywhere; }
.ww-game__meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; color: #94a3b8; font-size: 0.78rem; }
.ww-game__actions { display: flex; align-items: center; gap: 8px; }

.ww-applications { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
.ww-applications li {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 12px 14px;
  border-radius: 12px;
  background: rgba(148, 163, 184, 0.08);
}
.ww-applications__info { display: grid; gap: 3px; flex: 1; min-width: 160px; }
.ww-applications__info small { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; color: #94a3b8; font-size: 0.75rem; }
.ww-applications__note { margin: 0; color: #cbd5e1; font-size: 0.82rem; overflow-wrap: anywhere; }
.ww-applications__reason-text { margin: 0; color: #fca5a5; font-size: 0.8rem; }
.ww-applications__reason {
  flex: 1 1 200px;
  min-height: 38px;
  padding: 8px 12px;
  border: 1px solid rgba(148, 163, 184, 0.3);
  border-radius: 10px;
  background: rgba(2, 6, 23, 0.7);
  color: #f1f5f9;
  font: inherit;
}
.ww-applications__actions { display: flex; gap: 8px; }

.ww-badge { padding: 2px 10px; border-radius: 999px; background: rgba(148, 163, 184, 0.2); color: #cbd5e1; font-size: 0.72rem; }
.ww-badge--playing, .ww-badge--approved { background: rgba(34, 197, 94, 0.2); color: #4ade80; }
.ww-badge--ended, .ww-badge--rejected, .ww-badge--cancelled { background: rgba(148, 163, 184, 0.2); color: #cbd5e1; }
.ww-badge--pending { background: rgba(250, 204, 21, 0.18); color: #facc15; }

.ww-tag { padding: 2px 10px; border-radius: 999px; background: rgba(56, 189, 248, 0.16); color: #7dd3fc; font-size: 0.72rem; }
.ww-empty { margin: 0; padding: 18px; text-align: center; color: #94a3b8; font-size: 0.85rem; }
.ww-hint { margin: 0; color: #94a3b8; font-size: 0.82rem; }
.ww-notice { margin: 0; padding: 10px 14px; border-radius: 12px; background: rgba(56, 189, 248, 0.14); color: #7dd3fc; font-size: 0.82rem; }
.ww-alert { margin: 0; padding: 10px 14px; border: 1px solid #f87171; border-radius: 12px; background: rgba(248, 113, 113, 0.12); color: #fca5a5; font-size: 0.82rem; }

.ww-btn {
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
.ww-btn:hover:not(:disabled) { transform: translateY(-1px); background: rgba(148, 163, 184, 0.22); }
.ww-btn:disabled { cursor: not-allowed; opacity: 0.5; }
.ww-btn--primary { border-color: transparent; background: linear-gradient(135deg, #6366f1, #ec4899); color: #fff; }
.ww-btn--danger { border-color: transparent; background: linear-gradient(135deg, #f97316, #ef4444); color: #fff; }
.ww-btn--ghost { background: transparent; color: #cbd5e1; }
.ww-btn--small { min-height: 36px; padding: 0 12px; font-size: 0.82rem; }

.ww-link { display: inline-flex; align-items: center; border: 0; background: transparent; color: #cbd5e1; cursor: pointer; }

@media (max-width: 640px) {
  .ww-lobby__header-actions { width: 100%; }
  .ww-lobby__header-actions .ww-btn { flex: 1; }
  .ww-applications li { align-items: stretch; }
}

@media (prefers-reduced-motion: reduce) {
  .ww-btn, .ww-scope__option { transition: none; }
}
</style>
