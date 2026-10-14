import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import api from '../api.js';
import { t } from '../i18n.js';

// 进入房间后约每 1.2 秒拉取一次 state；动作提交后立即刷新。
export const TRUTH_DARE_POLL_MS = 1200;

// biome-ignore lint/suspicious/noExplicitAny: 后端返回动态 JSON，先以宽松结构承接再逐字段读取。
type AnyRecord = Record<string, any>;

function errorMessage(error: unknown, fallbackKey: string) {
  const message = (error as { message?: string } | null)?.message;
  return message || t(fallbackKey);
}

export function useTruthDare() {
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
      const payload = await api.truthDareOverview();
      allowMemberCreate.value = Boolean(payload?.allowMemberCreate);
      canCreate.value = Boolean(payload?.canCreate);
      canApprove.value = Boolean(payload?.canApprove);
      games.value = Array.isArray(payload?.games) ? payload.games : [];
      pendingApplications.value = Array.isArray(payload?.pendingApplications) ? payload.pendingApplications : [];
      myApplications.value = Array.isArray(payload?.myApplications) ? payload.myApplications : [];
    } catch (error) {
      overviewError.value = errorMessage(error, 'truthDare.loadFailed');
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
      overviewError.value = errorMessage(error, 'truthDare.actionFailed');
      return null;
    } finally {
      busy.value = false;
    }
  }

  function createGame(body: AnyRecord) {
    return runBusy(async () => {
      const payload = await api.truthDareCreateGame(body);
      await refreshOverview();
      return payload;
    });
  }

  function reviewApplication(id: number, body: AnyRecord) {
    return runBusy(async () => {
      const payload = await api.truthDareReviewApplication(id, body);
      await refreshOverview();
      return payload;
    });
  }

  function cancelApplication(id: number) {
    return runBusy(async () => {
      const payload = await api.truthDareCancelApplication(id);
      await refreshOverview();
      return payload;
    });
  }

  function joinGame(id: number) {
    return runBusy(async () => {
      const payload = await api.truthDareJoin(id);
      await refreshOverview();
      if (roomId.value === id) await fetchState();
      return payload;
    });
  }

  function leaveGame(id: number) {
    return runBusy(async () => {
      const payload = await api.truthDareLeave(id);
      await refreshOverview();
      if (roomId.value === id) await fetchState();
      return payload;
    });
  }

  async function fetchState() {
    const id = roomId.value;
    if (!id) return;
    try {
      const payload = await api.truthDareState(id);
      if (roomId.value !== id) return;
      state.value = payload;
      stateError.value = '';
    } catch (error) {
      if (roomId.value !== id) return;
      stateError.value = errorMessage(error, 'truthDare.loadFailed');
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
    }, TRUTH_DARE_POLL_MS);
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
      const payload = await api.truthDareAction(id, { action, ...extra });
      if (roomId.value === id) state.value = payload;
      return payload;
    } catch (error) {
      actionError.value = errorMessage(error, 'truthDare.actionFailed');
      return null;
    } finally {
      actionLoading.value = false;
    }
  }

  const phase = computed(() => state.value?.game?.phase ?? null);
  const status = computed(() => state.value?.game?.status ?? null);
  const me = computed(() => state.value?.me ?? null);
  const round = computed(() => state.value?.round ?? null);
  const roomParticipants = computed<AnyRecord[]>(() => state.value?.participants ?? []);
  const phaseDeadlineMs = computed<number | null>(() => state.value?.phaseDeadlineMs ?? null);

  const isCreator = computed(() => Boolean(me.value?.isCreator));
  const isParticipant = computed(() => Boolean(me.value?.isParticipant));
  const isChosen = computed(() => Boolean(me.value?.isChosen));
  const isPlaying = computed(() => status.value === 'playing');
  const hasSubmittedPrompt = computed(() =>
    Boolean(round.value?.prompts?.some((prompt: AnyRecord) => prompt.authorId === me.value?.userId))
  );
  const hasVoted = computed(() =>
    Boolean(round.value?.prompts?.some((prompt: AnyRecord) => prompt.votedByMe))
  );
  const chosenUserId = computed<number | null>(() => round.value?.chosenUserId ?? null);
  const chosenName = computed(() => round.value?.chosenName ?? '');

  const canSpin = computed(
    () => isPlaying.value && isCreator.value && (phase.value === 'idle' || phase.value === 'resolved')
  );
  const canChoose = computed(() => phase.value === 'choosing' && isChosen.value);
  const canSubmitPrompt = computed(
    () => phase.value === 'collecting' && isParticipant.value && !isChosen.value && !hasSubmittedPrompt.value
  );
  const canVote = computed(
    () => phase.value === 'voting' && isParticipant.value && !isChosen.value && !hasVoted.value
  );
  const canOpenVoting = computed(() => phase.value === 'collecting' && isCreator.value);
  const canCloseVoting = computed(() => phase.value === 'voting' && isCreator.value);
  const canAnswer = computed(() => phase.value === 'answering' && isChosen.value);
  const canConfirm = computed(
    () => phase.value === 'confirming' && isParticipant.value && !isChosen.value
  );
  const canNextRound = computed(() => phase.value === 'resolved' && isCreator.value);
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
    phase,
    status,
    me,
    round,
    roomParticipants,
    phaseDeadlineMs,
    isCreator,
    isParticipant,
    isChosen,
    isPlaying,
    hasSubmittedPrompt,
    hasVoted,
    chosenUserId,
    chosenName,
    canSpin,
    canChoose,
    canSubmitPrompt,
    canVote,
    canOpenVoting,
    canCloseVoting,
    canAnswer,
    canConfirm,
    canNextRound,
    canEndGame
  };
}
