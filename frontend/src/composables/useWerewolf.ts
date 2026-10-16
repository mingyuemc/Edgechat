import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import api from '../api.js';
import { t } from '../i18n.js';

// 进入房间后约每 1.5 秒拉取一次 state；动作提交后立即刷新。
export const WEREWOLF_POLL_MS = 1500;

// biome-ignore lint/suspicious/noExplicitAny: 后端返回动态 JSON，先以宽松结构承接再逐字段读取。
type AnyRecord = Record<string, any>;

function errorMessage(error: unknown, fallbackKey: string) {
  const message = (error as { message?: string } | null)?.message;
  return message || t(fallbackKey);
}

export function useWerewolf() {
  const overviewLoading = ref(false);
  const overviewError = ref('');
  const busy = ref(false);

  const allowMemberCreate = ref(false);
  const canCreate = ref(false);
  const canApprove = ref(false);
  const games = ref<AnyRecord[]>([]);
  const pendingApplications = ref<AnyRecord[]>([]);
  const myApplications = ref<AnyRecord[]>([]);

  const roomId = ref<number | null>(null);
  const state = ref<AnyRecord | null>(null);
  const stateError = ref('');
  const actionError = ref('');
  const actionLoading = ref(false);

  let pollTimer: number | null = null;
  let pollingActive = false;

  async function refreshOverview() {
    overviewLoading.value = true;
    overviewError.value = '';
    try {
      const payload = await api.werewolfOverview();
      allowMemberCreate.value = Boolean(payload?.allowMemberCreate);
      canCreate.value = Boolean(payload?.canCreate);
      canApprove.value = Boolean(payload?.canApprove);
      games.value = Array.isArray(payload?.games) ? payload.games : [];
      pendingApplications.value = Array.isArray(payload?.pendingApplications) ? payload.pendingApplications : [];
      myApplications.value = Array.isArray(payload?.myApplications) ? payload.myApplications : [];
    } catch (error) {
      overviewError.value = errorMessage(error, 'werewolf.loadFailed');
    } finally {
      overviewLoading.value = false;
    }
  }

  // 提交类操作统一加锁，避免重复点击产生并发请求。
  async function runBusy(operation: () => Promise<unknown>) {
    if (busy.value) return null;
    busy.value = true;
    overviewError.value = '';
    try {
      return await operation();
    } catch (error) {
      overviewError.value = errorMessage(error, 'werewolf.actionFailed');
      return null;
    } finally {
      busy.value = false;
    }
  }

  function createGame(body: AnyRecord) {
    return runBusy(async () => {
      const payload = await api.werewolfCreateGame(body);
      await refreshOverview();
      return payload;
    });
  }

  function reviewApplication(id: number, body: AnyRecord) {
    return runBusy(async () => {
      const payload = await api.werewolfReviewApplication(id, body);
      await refreshOverview();
      return payload;
    });
  }

  function cancelApplication(id: number) {
    return runBusy(async () => {
      const payload = await api.werewolfCancelApplication(id);
      await refreshOverview();
      return payload;
    });
  }

  function joinGame(id: number) {
    return runBusy(async () => {
      const payload = await api.werewolfJoin(id);
      await refreshOverview();
      if (roomId.value === id) await fetchState();
      return payload;
    });
  }

  function leaveGame(id: number) {
    return runBusy(async () => {
      const payload = await api.werewolfLeave(id);
      await refreshOverview();
      if (roomId.value === id) await fetchState();
      return payload;
    });
  }

  async function fetchState() {
    const id = roomId.value;
    if (!id) return;
    try {
      const payload = await api.werewolfState(id);
      if (roomId.value !== id) return;
      state.value = payload;
      stateError.value = '';
    } catch (error) {
      if (roomId.value !== id) return;
      stateError.value = errorMessage(error, 'werewolf.loadFailed');
    }
  }

  function clearPollTimer() {
    if (pollTimer !== null) {
      window.clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function schedulePoll() {
    if (!pollingActive || pollTimer !== null) return;
    // 页面隐藏时暂停轮询；visibilitychange 恢复时立即补一次。
    if (typeof document !== 'undefined' && document.hidden) return;
    pollTimer = window.setTimeout(async () => {
      pollTimer = null;
      await fetchState();
      schedulePoll();
    }, WEREWOLF_POLL_MS);
  }

  function startPolling() {
    if (pollingActive) return;
    pollingActive = true;
    schedulePoll();
  }

  function stopPolling() {
    pollingActive = false;
    clearPollTimer();
  }

  function handleVisibilityChange() {
    if (!roomId.value || !pollingActive) return;
    if (document.hidden) {
      clearPollTimer();
      return;
    }
    void fetchState().finally(schedulePoll);
  }

  async function enterRoom(id: number) {
    stopPolling();
    roomId.value = id;
    state.value = null;
    stateError.value = '';
    actionError.value = '';
    await fetchState();
    startPolling();
  }

  function leaveRoom() {
    stopPolling();
    roomId.value = null;
    state.value = null;
    stateError.value = '';
    actionError.value = '';
  }

  async function runAction(action: string, extra: AnyRecord = {}) {
    const id = roomId.value;
    if (!id || actionLoading.value) return null;
    actionLoading.value = true;
    actionError.value = '';
    try {
      const payload = await api.werewolfAction(id, { action, ...extra });
      if (roomId.value === id) state.value = payload;
      return payload;
    } catch (error) {
      actionError.value = errorMessage(error, 'werewolf.actionFailed');
      return null;
    } finally {
      actionLoading.value = false;
    }
  }

  const game = computed<AnyRecord | null>(() => state.value?.game ?? null);
  const phase = computed(() => game.value?.phase ?? null);
  const status = computed(() => game.value?.status ?? null);
  const me = computed(() => state.value?.me ?? null);
  const roomParticipants = computed<AnyRecord[]>(() => state.value?.participants ?? []);
  const phaseDeadlineMs = computed<number | null>(() => state.value?.phaseDeadlineMs ?? null);
  const night = computed<AnyRecord | null>(() => state.value?.night ?? null);
  const day = computed<AnyRecord | null>(() => state.value?.day ?? null);
  const vote = computed<AnyRecord | null>(() => state.value?.vote ?? null);
  const history = computed<AnyRecord[]>(() => state.value?.history ?? []);
  const lastResult = computed<AnyRecord | null>(() => state.value?.lastResult ?? null);
  const roleConfig = computed<AnyRecord | null>(() => state.value?.roleConfig ?? null);
  const assignMode = computed(() => state.value?.assignMode ?? null);
  const winner = computed(() => game.value?.winner ?? null);

  const isCreator = computed(() => Boolean(me.value?.isCreator));
  const isParticipant = computed(() => Boolean(me.value?.isParticipant));
  const isAlive = computed(() => Boolean(me.value?.isAlive));
  const isPlaying = computed(() => status.value === 'playing');
  const myRole = computed<string | null>(() => me.value?.role ?? null);
  const hasActed = computed(() => Boolean(me.value?.hasActed));

  const aliveParticipants = computed(() =>
    roomParticipants.value.filter((participant: AnyRecord) => participant.isAlive)
  );
  const aliveOthers = computed(() =>
    aliveParticipants.value.filter((participant: AnyRecord) => Number(participant.userId) !== Number(me.value?.userId))
  );
  const votedCount = computed(() => Number(vote.value?.votedCount ?? 0));
  const voteRequired = computed(() => Number(vote.value?.requiredCount ?? 0));
  const actedCount = computed(() => Number(night.value?.actedCount ?? 0));
  const nightRequired = computed(() => Number(night.value?.requiredCount ?? 0));

  // 角色配置总数决定开局时的玩家人数；与当前参与者数量一致时才允许开始。
  const roleConfigTotal = computed(() => {
    const config = roleConfig.value || {};
    return ['wolf', 'seer', 'witch', 'villager'].reduce((sum, role) => sum + Number(config[role] || 0), 0);
  });

  const canStart = computed(
    () =>
      isPlaying.value &&
      isCreator.value &&
      phase.value === 'lobby' &&
      roomParticipants.value.length >= 4 &&
      roleConfigTotal.value === roomParticipants.value.length
  );
  const canKill = computed(
    () => phase.value === 'night' && isAlive.value && myRole.value === 'wolf' && !hasActed.value
  );
  const canCheck = computed(
    () => phase.value === 'night' && isAlive.value && myRole.value === 'seer' && !hasActed.value
  );
  const canWitch = computed(
    () =>
      phase.value === 'night' &&
      isAlive.value &&
      myRole.value === 'witch' &&
      !Boolean(night.value?.witch?.usedThisNight)
  );
  const canEndDiscussion = computed(() => phase.value === 'day' && isCreator.value);
  const canVote = computed(() => phase.value === 'vote' && isAlive.value);
  const canEndGame = computed(() => isPlaying.value && isCreator.value);

  onMounted(() => {
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', handleVisibilityChange);
  });
  onBeforeUnmount(() => {
    stopPolling();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', handleVisibilityChange);
  });

  return {
    // 大厅
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
    // 房间
    roomId,
    state,
    stateError,
    actionError,
    actionLoading,
    enterRoom,
    leaveRoom,
    fetchState,
    startPolling,
    stopPolling,
    runAction,
    // 派生量
    game,
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
    winner,
    isCreator,
    isParticipant,
    isAlive,
    isPlaying,
    myRole,
    hasActed,
    aliveParticipants,
    aliveOthers,
    votedCount,
    voteRequired,
    actedCount,
    nightRequired,
    canStart,
    canKill,
    canCheck,
    canWitch,
    canEndDiscussion,
    canVote,
    canEndGame
  };
}
