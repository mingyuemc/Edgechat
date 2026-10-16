<script setup>
import { ArrowLeft, Eye, FlaskConical, Moon, Skull, Sun, Vote } from '@lucide/vue';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { t } from '../../i18n.js';

const props = defineProps({
  game: { type: Object, default: null },
  me: { type: Object, default: null },
  phase: { type: String, default: '' },
  status: { type: String, default: '' },
  participants: { type: Array, default: () => [] },
  phaseDeadlineMs: { type: Number, default: null },
  actionLoading: { type: Boolean, default: false },
  actionError: { type: String, default: '' },
  night: { type: Object, default: null },
  day: { type: Object, default: null },
  vote: { type: Object, default: null },
  history: { type: Array, default: () => [] },
  lastResult: { type: Object, default: null },
  roleConfig: { type: Object, default: null },
  roleConfigTotal: { type: Number, default: 0 },
  assignMode: { type: String, default: 'auto' },
  myRole: { type: String, default: null },
  winner: { type: String, default: null },
  hasActed: { type: Boolean, default: false },
  isCreator: Boolean,
  canStart: Boolean,
  canKill: Boolean,
  canCheck: Boolean,
  canWitch: Boolean,
  canEndDiscussion: Boolean,
  canVote: Boolean,
  canEndGame: Boolean,
  isParticipant: Boolean,
  isAlive: Boolean
});

const emit = defineEmits([
  'start',
  'kill',
  'check',
  'witch',
  'end-discussion',
  'vote',
  'end-game',
  'back',
  'leave',
  'join'
]);

const ROLE_KEYS = ['wolf', 'seer', 'witch', 'villager'];

const nowTick = ref(Date.now());
const killTargetId = ref(null);
const checkTargetId = ref(null);
const poisonTargetId = ref(null);
const voteTargetId = ref(null);
const manualRoles = ref({});
let countdownTimer = null;

const roundNo = computed(() => Number(props.game?.roundNo || 0));

// 手动分配：稳定签名只在阶段/配置/参与者集合变化时变化，避免轮询刷新把创建人的选择清空。
const assignmentSignature = computed(
  () => `${props.phase}|${JSON.stringify(props.roleConfig || {})}|${props.participants.map((participant) => participant.userId).join(',')}`
);

function initializeManualRoles() {
  // 按角色配置的顺序给出一个合法初值，创建人可在此基础上调整。
  const order = [];
  for (const role of ROLE_KEYS) {
    for (let index = 0; index < Number(props.roleConfig?.[role] || 0); index += 1) order.push(role);
  }
  const existing = manualRoles.value;
  const next = {};
  props.participants.forEach((participant, index) => {
    const previous = existing[participant.userId];
    next[participant.userId] = ROLE_KEYS.includes(previous) ? previous : (order[index] || 'villager');
  });
  manualRoles.value = next;
}

watch(assignmentSignature, initializeManualRoles, { immediate: true });

const manualCounts = computed(() => {
  const counts = { wolf: 0, seer: 0, witch: 0, villager: 0 };
  for (const role of Object.values(manualRoles.value)) {
    if (role in counts) counts[role] += 1;
  }
  return counts;
});

const manualValid = computed(() => {
  if (props.participants.length < 4) return false;
  if (props.participants.some((participant) => !ROLE_KEYS.includes(manualRoles.value[participant.userId]))) return false;
  const config = props.roleConfig || {};
  return ROLE_KEYS.every((role) => Number(config[role] || 0) === manualCounts.value[role]);
});

const isManual = computed(() => props.assignMode === 'manual');
const canStartManual = computed(() => props.isCreator && props.phase === 'lobby' && manualValid.value);
const canStartNow = computed(() => (isManual.value ? canStartManual.value : props.canStart));
const startDisabled = computed(() => props.actionLoading || !canStartNow.value);
const startBlockReason = computed(() => {
  if (canStartNow.value) return '';
  if (props.participants.length < 4) return 'minPlayers';
  return isManual.value ? 'manualAssign' : 'configMismatch';
});

function emitStart() {
  emit('start', isManual.value ? { roleAssignment: { ...manualRoles.value } } : {});
}

function configCountOf(role) {
  return Number(props.roleConfig?.[role] || 0);
}
const aliveTargets = computed(() =>
  props.participants.filter(
    (participant) => participant.isAlive && Number(participant.userId) !== Number(props.me?.userId)
  )
);
const deadNames = computed(() =>
  (props.lastResult?.deaths ?? []).map((death) => death.displayName || '?').join('、')
);
const wolfTargetNames = computed(() =>
  (props.night?.wolfTargetUserIds ?? [])
    .map((userId) => props.participants.find((participant) => Number(participant.userId) === Number(userId))?.displayName || '?')
    .join('、')
);

const remainingMs = computed(() => {
  const deadline = props.phaseDeadlineMs;
  if (!deadline) return 0;
  return Math.max(0, deadline - nowTick.value);
});
const secondsLeft = computed(() => Math.max(0, Math.ceil(remainingMs.value / 1000)));
const showCountdown = computed(
  () => Boolean(props.phaseDeadlineMs) && ['night', 'day', 'vote'].includes(props.phase)
);

const winnerLabel = computed(() => {
  if (props.winner === 'wolves') return t('werewolf.ended.winnerWolves');
  if (props.winner === 'villagers') return t('werewolf.ended.winnerVillagers');
  return t('werewolf.ended.winnerUnknown');
});

function phaseLabel(value) {
  return t(`werewolf.phase.${value || 'lobby'}`);
}

function roleLabel(participant) {
  if (!participant?.role) return t('werewolf.role.hidden');
  return t(`werewolf.role.${participant.role}`);
}

function deathCauseLabel(cause) {
  return t(`werewolf.deathCause.${cause || 'vote'}`);
}

function displayNameOf(userId) {
  return props.participants.find((participant) => Number(participant.userId) === Number(userId))?.displayName || '?';
}

function nameList(ids) {
  return (ids ?? []).map((id) => displayNameOf(id)).join('、');
}

// 每进入新的夜晚/白天/投票阶段就清空上一阶段的选择，避免误提交旧目标。
watch(
  () => `${props.phase}:${roundNo.value}`,
  () => {
    killTargetId.value = null;
    checkTargetId.value = null;
    poisonTargetId.value = null;
    voteTargetId.value = null;
  }
);

// 只在有兜底时限的阶段运行倒计时刷新，其余阶段停止计时器节省开销。
watch(
  () => showCountdown.value,
  (active) => {
    if (active) {
      nowTick.value = Date.now();
      if (countdownTimer === null) countdownTimer = window.setInterval(() => (nowTick.value = Date.now()), 250);
    } else if (countdownTimer !== null) {
      window.clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }
);

onMounted(() => {
  if (showCountdown.value) {
    countdownTimer = window.setInterval(() => (nowTick.value = Date.now()), 250);
  }
});
onBeforeUnmount(() => {
  if (countdownTimer !== null) {
    window.clearInterval(countdownTimer);
    countdownTimer = null;
  }
});
</script>

<template>
  <div class="ww-room">
    <header class="ww-room__header">
      <button type="button" class="ww-btn ww-btn--ghost" @click="emit('back')">
        <ArrowLeft :size="16" aria-hidden="true" />{{ t('werewolf.backToLobby') }}
      </button>
      <div class="ww-room__titles">
        <h1>{{ game?.title || t('werewolf.gameTitleFallback') }}</h1>
        <p>
          <span class="ww-badge" :class="`ww-badge--${phase}`">{{ phaseLabel(phase) }}</span>
          <span v-if="roundNo">{{ t('werewolf.roundNo', { n: roundNo }) }}</span>
          <span v-if="showCountdown">· {{ t('werewolf.phaseDeadline', { seconds: secondsLeft }) }}</span>
        </p>
      </div>
      <div class="ww-room__actions">
        <button v-if="isParticipant" type="button" class="ww-btn ww-btn--ghost" :disabled="actionLoading" @click="emit('leave')">
          {{ t('werewolf.leave') }}
        </button>
        <button v-else type="button" class="ww-btn ww-btn--primary" :disabled="actionLoading" @click="emit('join')">
          {{ t('werewolf.join') }}
        </button>
        <button v-if="canEndGame" type="button" class="ww-btn ww-btn--danger" :disabled="actionLoading" @click="emit('end-game')">
          {{ t('werewolf.endGame') }}
        </button>
      </div>
    </header>

    <p v-if="actionError" class="ww-alert" role="alert">{{ actionError }}</p>
    <p v-if="!isParticipant" class="ww-note">{{ t('werewolf.spectatorHint') }}</p>

    <section class="ww-panel">
      <h2>{{ t('werewolf.participants') }}<small>{{ t('werewolf.participantCount', { count: participants.length }) }}</small></h2>
      <ul class="ww-players">
        <li
          v-for="participant in participants"
          :key="participant.userId"
          class="ww-player"
          :class="{ 'ww-player--dead': !participant.isAlive, 'ww-player--me': Number(participant.userId) === Number(me?.userId) }"
        >
          <div class="ww-player__name">
            <strong>{{ participant.displayName }}</strong>
            <span v-if="Number(participant.userId) === Number(me?.userId)" class="ww-tag">{{ t('werewolf.youTag') }}</span>
            <span v-if="participant.isCreator" class="ww-tag ww-tag--creator">{{ t('werewolf.creatorTag') }}</span>
          </div>
          <div class="ww-player__meta">
            <span class="ww-chip" :class="`ww-chip--role-${participant.role || 'hidden'}`">{{ roleLabel(participant) }}</span>
            <span class="ww-chip" :class="participant.isAlive ? 'ww-chip--alive' : 'ww-chip--dead'">
              {{ participant.isAlive ? t('werewolf.alive') : t('werewolf.dead') }}
            </span>
            <span v-if="!participant.isAlive && participant.deathCause" class="ww-chip ww-chip--cause">
              {{ deathCauseLabel(participant.deathCause) }}
            </span>
            <span class="ww-chip" :class="participant.online ? 'ww-chip--online' : 'ww-chip--offline'">
              {{ participant.online ? t('werewolf.online') : t('werewolf.offline') }}
            </span>
          </div>
        </li>
      </ul>
      <p v-if="myRole" class="ww-hint">{{ t('werewolf.youAre', { role: t(`werewolf.role.${myRole}`) }) }}</p>
    </section>

    <!-- 准备阶段 -->
    <section v-if="phase === 'lobby'" class="ww-panel">
      <h2><Moon :size="18" aria-hidden="true" />{{ t('werewolf.phase.lobby') }}</h2>
      <p class="ww-hint">{{ t('werewolf.minPlayersHint', { min: 4 }) }}</p>

      <!-- 手动分配：仅发起人可在开局前指定每人角色。 -->
      <div v-if="isManual && isCreator" class="ww-manual">
        <p class="ww-hint">{{ t('werewolf.manualAssignHint') }}</p>
        <ul class="ww-manual__list">
          <li v-for="participant in participants" :key="participant.userId" class="ww-manual__item">
            <span class="ww-manual__name">
              {{ participant.displayName }}
              <span v-if="Number(participant.userId) === Number(me?.userId)" class="ww-tag">{{ t('werewolf.youTag') }}</span>
            </span>
            <select v-model="manualRoles[participant.userId]">
              <option v-for="role in ROLE_KEYS" :key="role" :value="role">{{ t(`werewolf.role.${role}`) }}</option>
            </select>
          </li>
        </ul>
        <p class="ww-hint ww-manual__counts">
          <span v-for="role in ROLE_KEYS" :key="role" class="ww-manual__count">
            {{ t(`werewolf.role.${role}`) }} {{ manualCounts[role] }}/{{ configCountOf(role) }}
          </span>
        </p>
      </div>

      <template v-if="isCreator">
        <p v-if="startBlockReason === 'configMismatch'" class="ww-alert">
          {{ t('werewolf.startRoleConfigMismatch', { config: roleConfigTotal, count: participants.length }) }}
        </p>
        <p v-else-if="startBlockReason === 'manualAssign'" class="ww-alert">
          {{ t('werewolf.manualAssignMismatch', { config: roleConfigTotal, count: participants.length }) }}
        </p>
        <button type="button" class="ww-btn ww-btn--primary" :disabled="startDisabled" @click="emitStart">
          {{ actionLoading ? t('werewolf.starting') : t('werewolf.startGame') }}
        </button>
      </template>
      <p v-else-if="isParticipant" class="ww-hint">{{ t('werewolf.waitingStart') }}</p>
    </section>

    <!-- 夜晚阶段 -->
    <section v-else-if="phase === 'night'" class="ww-panel">
      <h2><Moon :size="18" aria-hidden="true" />{{ t('werewolf.night.title', { n: roundNo }) }}</h2>
      <p class="ww-hint">{{ t('werewolf.night.tip') }}</p>

      <template v-if="myRole === 'wolf'">
        <p class="ww-hint">{{ t('werewolf.night.wolfHint') }}</p>
        <div class="ww-targets">
          <button
            v-for="target in aliveTargets"
            :key="target.userId"
            type="button"
            class="ww-target"
            :class="{ 'ww-target--active': Number(killTargetId) === Number(target.userId) }"
            @click="killTargetId = target.userId"
          >
            {{ target.displayName }}
          </button>
        </div>
        <p v-if="wolfTargetNames" class="ww-hint">{{ t('werewolf.night.wolfTargets', { names: wolfTargetNames }) }}</p>
        <p v-else class="ww-hint">{{ t('werewolf.night.noWolfTarget') }}</p>
        <button
          v-if="canKill"
          type="button"
          class="ww-btn ww-btn--primary"
          :disabled="actionLoading || !killTargetId"
          @click="emit('kill', Number(killTargetId))"
        >
          {{ t('werewolf.action.kill') }}
        </button>
      </template>

      <template v-else-if="myRole === 'seer'">
        <p class="ww-hint">{{ t('werewolf.night.seerHint') }}</p>
        <div class="ww-targets">
          <button
            v-for="target in aliveTargets"
            :key="target.userId"
            type="button"
            class="ww-target"
            :class="{ 'ww-target--active': Number(checkTargetId) === Number(target.userId) }"
            @click="checkTargetId = target.userId"
          >
            {{ target.displayName }}
          </button>
        </div>
        <button
          v-if="canCheck"
          type="button"
          class="ww-btn ww-btn--primary"
          :disabled="actionLoading || !checkTargetId"
          @click="emit('check', Number(checkTargetId))"
        >
          {{ t('werewolf.action.check') }}
        </button>
        <div class="ww-log">
          <h3><Eye :size="15" aria-hidden="true" />{{ t('werewolf.seer.checkLog') }}</h3>
          <p v-if="!(night?.seerChecks ?? []).length" class="ww-hint">{{ t('werewolf.seer.noChecks') }}</p>
          <ul v-else>
            <li v-for="check in night.seerChecks" :key="`${check.roundNo}:${check.targetUserId}`">
              {{ t(check.isWolf ? 'werewolf.seer.resultWolf' : 'werewolf.seer.resultGood', { n: check.roundNo, name: check.targetName }) }}
            </li>
          </ul>
        </div>
      </template>

      <template v-else-if="myRole === 'witch'">
        <p class="ww-hint">{{ t('werewolf.night.witchHint') }}</p>
        <div class="ww-chips">
          <span class="ww-chip" :class="night?.witch?.hasAntidote ? 'ww-chip--alive' : 'ww-chip--dead'">
            {{ night?.witch?.hasAntidote ? t('werewolf.witch.antidoteLeft') : t('werewolf.witch.antidoteUsed') }}
          </span>
          <span class="ww-chip" :class="night?.witch?.hasPoison ? 'ww-chip--alive' : 'ww-chip--dead'">
            {{ night?.witch?.hasPoison ? t('werewolf.witch.poisonLeft') : t('werewolf.witch.poisonUsed') }}
          </span>
        </div>
        <p v-if="night?.witch?.usedTonight" class="ww-hint">{{ t('werewolf.witch.usedTonight') }}</p>
        <template v-else-if="canWitch">
          <button
            v-if="night?.witch?.hasAntidote"
            type="button"
            class="ww-btn ww-btn--primary"
            :disabled="actionLoading"
            @click="emit('witch', { mode: 'save' })"
          >
            <FlaskConical :size="16" aria-hidden="true" />{{ t('werewolf.witch.antidote') }}
          </button>
          <template v-if="night?.witch?.hasPoison">
            <p class="ww-hint">{{ t('werewolf.witch.choosePoison') }}</p>
            <div class="ww-targets">
              <button
                v-for="target in aliveTargets"
                :key="target.userId"
                type="button"
                class="ww-target"
                :class="{ 'ww-target--active': Number(poisonTargetId) === Number(target.userId) }"
                @click="poisonTargetId = target.userId"
              >
                {{ target.displayName }}
              </button>
            </div>
            <button
              type="button"
              class="ww-btn ww-btn--danger"
              :disabled="actionLoading || !poisonTargetId"
              @click="emit('witch', { mode: 'poison', targetUserId: Number(poisonTargetId) })"
            >
              <Skull :size="16" aria-hidden="true" />{{ t('werewolf.action.poison') }}
            </button>
          </template>
          <button type="button" class="ww-btn ww-btn--ghost" :disabled="actionLoading" @click="emit('witch', { mode: 'skip' })">
            {{ t('werewolf.witch.skip') }}
          </button>
        </template>
      </template>

      <p v-else class="ww-hint">{{ isAlive ? t('werewolf.night.villagerHint') : t('werewolf.vote.notAlive') }}</p>

      <p class="ww-hint">{{ t('werewolf.night.waitingOthers', { acted: Number(night?.actedCount ?? 0), required: Number(night?.requiredCount ?? 0) }) }}</p>
    </section>

    <!-- 白天阶段 -->
    <section v-else-if="phase === 'day'" class="ww-panel">
      <h2><Sun :size="18" aria-hidden="true" />{{ t('werewolf.day.title', { n: roundNo }) }}</h2>
      <p class="ww-hint">{{ t('werewolf.day.discussion') }}</p>
      <p class="ww-hint">
        {{ deadNames ? t('werewolf.day.deathsTonight', { names: deadNames }) : t('werewolf.day.noDeathsTonight') }}
      </p>
      <button v-if="canEndDiscussion" type="button" class="ww-btn ww-btn--primary" :disabled="actionLoading" @click="emit('end-discussion')">
        {{ t('werewolf.day.endDiscussion') }}
      </button>
      <p v-else class="ww-hint">{{ t('werewolf.day.waitingCreator') }}</p>
    </section>

    <!-- 投票阶段 -->
    <section v-else-if="phase === 'vote'" class="ww-panel">
      <h2><Vote :size="18" aria-hidden="true" />{{ t('werewolf.vote.title', { n: roundNo }) }}</h2>
      <p class="ww-hint">{{ t('werewolf.vote.hint') }}</p>

      <template v-if="canVote">
        <p class="ww-hint">{{ t('werewolf.vote.target') }}</p>
        <div class="ww-targets">
          <button
            v-for="target in aliveTargets"
            :key="target.userId"
            type="button"
            class="ww-target"
            :class="{ 'ww-target--active': Number(voteTargetId) === Number(target.userId) }"
            @click="voteTargetId = target.userId"
          >
            {{ target.displayName }}
          </button>
          <button
            type="button"
            class="ww-target"
            :class="{ 'ww-target--active': voteTargetId === null }"
            @click="voteTargetId = null"
          >
            {{ t('werewolf.vote.abstain') }}
          </button>
        </div>
        <button type="button" class="ww-btn ww-btn--primary" :disabled="actionLoading" @click="emit('vote', voteTargetId === null ? null : Number(voteTargetId))">
          {{ t('werewolf.vote.confirm') }}
        </button>
      </template>
      <p v-else-if="!isAlive" class="ww-hint">{{ t('werewolf.vote.notAlive') }}</p>

      <p v-if="hasActed && vote?.myVoteTargetUserId" class="ww-hint">{{ t('werewolf.vote.voted', { name: displayNameOf(vote.myVoteTargetUserId) }) }}</p>
      <p v-else-if="hasActed" class="ww-hint">{{ t('werewolf.vote.abstained') }}</p>
      <p class="ww-hint">{{ t('werewolf.vote.progress', { voted: Number(vote?.votedCount ?? 0), required: Number(vote?.requiredCount ?? 0) }) }}</p>

      <div class="ww-log">
        <h3>{{ t('werewolf.vote.tally') }}</h3>
        <p v-if="!(vote?.tally ?? []).length" class="ww-hint">{{ t('werewolf.vote.noTally') }}</p>
        <ul v-else>
          <li v-for="row in vote.tally" :key="row.targetUserId">
            {{ row.targetName || displayNameOf(row.targetUserId) }} · {{ t('werewolf.vote.count', { count: row.count }) }}
          </li>
        </ul>
      </div>
    </section>

    <!-- 结束阶段 -->
    <section v-else-if="phase === 'ended' || status === 'ended'" class="ww-panel">
      <h2>{{ t('werewolf.phase.ended') }}</h2>
      <p class="ww-winner">{{ winnerLabel }}</p>
      <p class="ww-hint">{{ t('werewolf.roomEnded') }}</p>
    </section>

    <section v-if="history.length" class="ww-panel">
      <h2>{{ t('werewolf.history.title') }}</h2>
      <ul class="ww-history">
        <li v-for="entry in history" :key="entry.roundNo">
          <strong>{{ t('werewolf.history.round', { n: entry.roundNo }) }}</strong>
          <span>{{ entry.deaths.length ? t('werewolf.history.deaths', { names: nameList(entry.deaths.map((death) => death.userId)) }) : t('werewolf.history.noDeaths') }}</span>
          <span>{{ entry.exiled ? t('werewolf.history.exiled', { name: entry.exiled.displayName }) : t('werewolf.history.noExile') }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.ww-room {
  display: grid;
  gap: 16px;
  width: min(960px, 100%);
  margin: 0 auto;
}

.ww-room__header {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.ww-room__titles { flex: 1; min-width: 0; }
.ww-room__titles h1 { margin: 0; font-size: 1.25rem; color: #f8fafc; overflow-wrap: anywhere; }
.ww-room__titles p { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 4px 0 0; color: #94a3b8; font-size: 0.82rem; }
.ww-room__actions { display: flex; gap: 8px; flex-wrap: wrap; }

.ww-panel {
  display: grid;
  gap: 10px;
  padding: 16px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 16px;
  background: rgba(15, 23, 42, 0.72);
}
.ww-panel h2 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 1rem; color: #e2e8f0; }
.ww-panel h2 small { color: #94a3b8; font-size: 0.75rem; font-weight: 400; }
.ww-panel h3 { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 0.85rem; color: #cbd5e1; }

.ww-players { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; margin: 0; padding: 0; list-style: none; }
.ww-player { display: grid; gap: 6px; padding: 10px 12px; border-radius: 12px; background: rgba(148, 163, 184, 0.08); }
.ww-player--dead { opacity: 0.6; }
.ww-player--me { outline: 1px solid rgba(99, 102, 241, 0.6); }
.ww-player__name { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ww-player__name strong { font-size: 0.92rem; overflow-wrap: anywhere; }
.ww-player__meta { display: flex; gap: 4px; flex-wrap: wrap; }

.ww-chip { padding: 2px 8px; border-radius: 999px; background: rgba(148, 163, 184, 0.2); color: #cbd5e1; font-size: 0.7rem; }
.ww-chip--alive, .ww-chip--online { background: rgba(34, 197, 94, 0.2); color: #4ade80; }
.ww-chip--dead, .ww-chip--offline { background: rgba(148, 163, 184, 0.2); color: #94a3b8; }
.ww-chip--cause { background: rgba(248, 113, 113, 0.18); color: #fca5a5; }
.ww-chip--role-wolf { background: rgba(239, 68, 68, 0.24); color: #fca5a5; }
.ww-chip--role-seer { background: rgba(56, 189, 248, 0.22); color: #7dd3fc; }
.ww-chip--role-witch { background: rgba(168, 85, 247, 0.24); color: #d8b4fe; }
.ww-chip--role-villager { background: rgba(148, 163, 184, 0.24); color: #cbd5e1; }

.ww-tag { padding: 1px 8px; border-radius: 999px; background: rgba(56, 189, 248, 0.16); color: #7dd3fc; font-size: 0.68rem; }
.ww-tag--creator { background: rgba(250, 204, 21, 0.18); color: #facc15; }

.ww-badge { padding: 2px 10px; border-radius: 999px; background: rgba(148, 163, 184, 0.2); color: #cbd5e1; font-size: 0.72rem; }
.ww-badge--night { background: rgba(99, 102, 241, 0.24); color: #c7d2fe; }
.ww-badge--day { background: rgba(250, 204, 21, 0.2); color: #facc15; }
.ww-badge--vote { background: rgba(236, 72, 153, 0.2); color: #f9a8d4; }
.ww-badge--ended { background: rgba(148, 163, 184, 0.2); color: #cbd5e1; }

.ww-targets { display: flex; gap: 8px; flex-wrap: wrap; }
.ww-target {
  min-height: 36px;
  padding: 0 14px;
  border: 1px solid rgba(148, 163, 184, 0.3);
  border-radius: 10px;
  background: transparent;
  color: #cbd5e1;
  font: inherit;
  cursor: pointer;
}
.ww-target--active { border-color: transparent; background: linear-gradient(135deg, #6366f1, #ec4899); color: #fff; }

.ww-manual { display: grid; gap: 8px; }
.ww-manual__list { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; margin: 0; padding: 0; list-style: none; }
.ww-manual__item { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border-radius: 10px; background: rgba(148, 163, 184, 0.08); }
.ww-manual__name { display: flex; align-items: center; gap: 6px; min-width: 0; color: #e2e8f0; font-size: 0.85rem; overflow-wrap: anywhere; }
.ww-manual__item select {
  min-height: 34px;
  padding: 4px 8px;
  border: 1px solid rgba(148, 163, 184, 0.3);
  border-radius: 8px;
  background: rgba(2, 6, 23, 0.7);
  color: #f1f5f9;
  font: inherit;
  font-size: 0.82rem;
}
.ww-manual__counts { display: flex; gap: 10px; flex-wrap: wrap; }
.ww-manual__count { color: #94a3b8; font-size: 0.78rem; }

.ww-chips { display: flex; gap: 8px; flex-wrap: wrap; }
.ww-log { display: grid; gap: 6px; }
.ww-log ul { margin: 0; padding-left: 18px; color: #cbd5e1; font-size: 0.82rem; }
.ww-log li { overflow-wrap: anywhere; }

.ww-history { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; color: #cbd5e1; font-size: 0.82rem; }
.ww-history li { display: flex; gap: 10px; flex-wrap: wrap; padding: 8px 12px; border-radius: 10px; background: rgba(148, 163, 184, 0.08); }

.ww-winner { margin: 0; font-size: 1.1rem; font-weight: 700; color: #facc15; }
.ww-hint { margin: 0; color: #94a3b8; font-size: 0.82rem; }
.ww-note { margin: 0; padding: 10px 14px; border-radius: 12px; background: rgba(56, 189, 248, 0.14); color: #7dd3fc; font-size: 0.82rem; }
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

@media (prefers-reduced-motion: reduce) {
  .ww-btn, .ww-target { transition: none; }
}
</style>
