// 真心话大冒险在 demo 站点的纯前端实现。
// 复用 worker/src/data 的纯逻辑（选人、超时、平局、作答结算）以保持与后端一致的语义，
// 用内存状态替代 D1；由于 demo 只有单个真人访客，其他在线玩家由“机器人”在轮询驱动下自动补齐，
// 保证一个人也能完整走完抽人、选择、出题、投票、作答、确认的全流程。
import { cloneDemo, demoState, findDemoChannel, findDemoUser, getDemoFileUrl } from './state.js';
import { demoAuthorization } from './rbac.ts';
import { hasPermission } from '../../../shared/admin-permissions.ts';
import {
  TRUTH_DARE_CHOICE_MS,
  TRUTH_DARE_CHOICES,
  TRUTH_DARE_COLLECT_MS,
  TRUTH_DARE_CONFIRM_MS,
  TRUTH_DARE_CREATE_PERMISSION,
  TRUTH_DARE_ONLINE_MS,
  TRUTH_DARE_SCOPES,
  TRUTH_DARE_VOTE_MS
} from '../../../shared/truth-dare.ts';
import {
  answerResolution,
  chooseOnlineChosen,
  resolveVotingWinner,
  timeoutTransition
} from '../../../worker/src/data/truth-dare.ts';

// 机器人每个节拍只推进一步（出题/投票等），与前端轮询间隔对齐，
// 让单个真人访客能逐步看清候选与票数的累积，而不是整段瞬间跳过。
const BOT_STEP_MS = 1200;
// 待确认阶段若真人访客正是本轮确认者，先留出这段确认窗口；超时再由机器人代确认，避免演示卡住。
const BOT_CONFIRM_WAIT_MS = 6000;

const BOT_PROMPTS = {
  truth: ['你最近一次大笑是因为什么？', '你最想和谁交换一天人生？', '说出一件你一直没敢告诉别人的小事。'],
  dare: ['模仿一种动物的叫声 10 秒。', '对着镜头做 3 个夸张鬼脸。', '用一句话夸赞在场的每个人。']
};
const BOT_ANSWERS = {
  truth: ['昨天看朋友的猫摔了一跤，笑到不行。', '想和高中同桌交换一天，看看他现在的生活。', '其实我到现在还怕黑。'],
  dare: ['已经完成！', '做完了，脸有点酸。', '当然可以，你们都很棒。']
};

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  error.payload = { error: message };
  throw error;
}

function iso() {
  return new Date().toISOString();
}

function td() {
  return demoState.truthDare;
}

function sessionUserId() {
  return Number(demoState.session.userId);
}

function userName(userId) {
  return findDemoUser(userId)?.displayName || '';
}

function channelName(channelId) {
  return channelId == null ? '' : findDemoChannel(channelId)?.name || '';
}

function isActiveUser(user) {
  return Boolean(user) && !user.deletedAt && !user.isDisabled;
}

function participantOnline(participant, viewerId) {
  // 机器人访客在 demo 中始终视为在线；真人访客按最近一次心跳判断。
  if (Number(participant.userId) !== Number(viewerId)) return true;
  const lastSeen = Number(participant.lastSeenAt || 0);
  return lastSeen > 0 && Date.now() - lastSeen <= TRUTH_DARE_ONLINE_MS;
}

function findGame(gameId) {
  return td().games.find((game) => Number(game.id) === Number(gameId));
}

function participantsOf(gameId) {
  return td().participants.filter((participant) => Number(participant.gameId) === Number(gameId));
}

function isParticipant(gameId, userId) {
  return participantsOf(gameId).some((participant) => Number(participant.userId) === Number(userId));
}

function roundsOf(gameId) {
  return td().rounds.filter((round) => Number(round.gameId) === Number(gameId));
}

function promptsOf(gameId, roundNo) {
  return td().prompts.filter(
    (prompt) => Number(prompt.gameId) === Number(gameId) && Number(prompt.roundNo) === Number(roundNo)
  );
}

function votesOf(gameId, roundNo) {
  return td().votes.filter(
    (vote) => Number(vote.gameId) === Number(gameId) && Number(vote.roundNo) === Number(roundNo)
  );
}

function findRound(gameId, roundNo) {
  return td().rounds.find(
    (round) => Number(round.gameId) === Number(gameId) && Number(round.roundNo) === Number(roundNo)
  );
}

function channelMemberIds(channelId) {
  const channel = findDemoChannel(channelId);
  if (!channel) return [];
  return channel.memberIds
    .map(Number)
    .filter((userId) => isActiveUser(findDemoUser(userId)));
}

// 手动名单支持用户名（前端输入）与数字 ID（内部调用）两种写法。
function resolveInvited(value) {
  const raw = [...new Set((value || []).map((item) => String(item).trim()).filter(Boolean))];
  const ids = [];
  for (const token of raw) {
    const user = /^\d+$/.test(token)
      ? findDemoUser(Number(token))
      : demoState.users.find((item) => item.username === token);
    if (isActiveUser(user)) ids.push(Number(user.id));
  }
  return [...new Set(ids)];
}

function isInvitedToGame(gameId, userId) {
  return td().applications.some(
    (application) =>
      Number(application.gameId) === Number(gameId) &&
      application.status === 'approved' &&
      (application.invitedUserIds || []).map(Number).includes(Number(userId))
  );
}

// ---------- 投影 ----------

function mapGameSummary(game, userId) {
  const participants = participantsOf(game.id);
  return {
    id: Number(game.id),
    title: game.title || '',
    scope: game.scope,
    channelId: game.channelId == null ? null : Number(game.channelId),
    channelName: channelName(game.channelId),
    status: game.status,
    phase: game.phase,
    roundNo: Number(game.roundNo || 0),
    participantCount: participants.length,
    isParticipant: participants.some((participant) => Number(participant.userId) === Number(userId)),
    isCreator: Number(game.creatorId) === Number(userId),
    creatorName: userName(game.creatorId),
    createdAt: game.createdAt
  };
}

function mapApplication(application) {
  return {
    id: Number(application.id),
    scope: application.scope,
    channelId: application.channelId == null ? null : Number(application.channelId),
    channelName: channelName(application.channelId),
    note: application.note || '',
    status: application.status,
    reviewReason: application.reviewReason || '',
    gameId: application.gameId == null ? null : Number(application.gameId),
    createdAt: application.createdAt,
    reviewedAt: application.reviewedAt || null
  };
}

function mapPendingApplication(application) {
  return {
    id: Number(application.id),
    applicantId: Number(application.applicantId),
    applicantName: userName(application.applicantId),
    scope: application.scope,
    channelId: application.channelId == null ? null : Number(application.channelId),
    channelName: channelName(application.channelId),
    invitedUserIds: (application.invitedUserIds || []).map(Number),
    note: application.note || '',
    createdAt: application.createdAt
  };
}

function listVisibleGames(userId) {
  return td()
    .games.filter(
      (game) =>
        game.scope === 'public' ||
        isParticipant(game.id, userId) ||
        Number(game.creatorId) === Number(userId)
    )
    .sort((left, right) => Number(right.id) - Number(left.id))
    .slice(0, 100)
    .map((game) => mapGameSummary(game, userId));
}

function listPendingApplications() {
  return td()
    .applications.filter((application) => application.status === 'pending')
    .sort((left, right) => Number(right.id) - Number(left.id))
    .slice(0, 100)
    .map(mapPendingApplication);
}

function listMyApplications(userId) {
  return td()
    .applications.filter((application) => Number(application.applicantId) === Number(userId))
    .sort((left, right) => Number(right.id) - Number(left.id))
    .slice(0, 100)
    .map(mapApplication);
}

function loadGameForUser(gameId, userId) {
  const game = findGame(gameId);
  if (!game) return null;
  const participant = isParticipant(gameId, userId);
  const isCreator = Number(game.creatorId) === Number(userId);
  return { game, isParticipant: participant, isCreator, visible: game.scope === 'public' || participant || isCreator };
}

// ---------- 写操作 ----------

function insertParticipant(gameId, userId, isCreator = false) {
  if (isParticipant(gameId, userId)) return;
  td().participants.push({
    gameId: Number(gameId),
    userId: Number(userId),
    isCreator: Boolean(isCreator),
    lastSeenAt: Date.now()
  });
}

function touchParticipant(gameId, userId) {
  const participant = participantsOf(gameId).find((item) => Number(item.userId) === Number(userId));
  if (participant) participant.lastSeenAt = Date.now();
}

function createGameWithParticipants({ creatorId, scope, channelId = null, title = '', participantUserIds = [] }) {
  const id = td().nextGameId++;
  td().games.push({
    id,
    creatorId: Number(creatorId),
    scope,
    channelId: channelId == null ? null : Number(channelId),
    title: String(title || ''),
    status: 'playing',
    phase: 'idle',
    roundNo: 0,
    chosenUserId: null,
    choice: null,
    winningPromptId: null,
    phaseDeadlineMs: null,
    phaseStartedAt: Date.now(),
    createdAt: iso(),
    endedAt: null
  });
  const ids = [...new Set([Number(creatorId), ...participantUserIds.map(Number)])].filter(
    (userId) => Number.isInteger(userId) && userId > 0
  );
  for (const userId of ids) insertParticipant(id, userId, userId === Number(creatorId));
  return id;
}

function createApplication({ applicantId, scope, channelId = null, invitedUserIds = [], note = '' }) {
  const id = td().nextApplicationId++;
  td().applications.push({
    id,
    applicantId: Number(applicantId),
    scope,
    channelId: channelId == null ? null : Number(channelId),
    invitedUserIds: (invitedUserIds || []).map(Number),
    note: String(note || ''),
    status: 'pending',
    reviewReason: '',
    gameId: null,
    reviewerId: null,
    createdAt: iso(),
    reviewedAt: null
  });
  return id;
}

function resolveParticipantIds({ scope, channelId, invitedUserIds }) {
  if (scope === 'channel' && channelId != null) return channelMemberIds(channelId);
  if (scope === 'manual') return resolveInvited(invitedUserIds);
  return [];
}

// ---------- 阶段推进 ----------

function setPhase(game, phase, deadlineMs) {
  game.phase = phase;
  game.phaseDeadlineMs = deadlineMs == null ? null : Number(deadlineMs);
  game.phaseStartedAt = Date.now();
}

function insertPrompt(game, authorId, kind, content) {
  td().prompts.push({
    id: td().nextPromptId++,
    gameId: Number(game.id),
    roundNo: Number(game.roundNo),
    authorId: Number(authorId),
    kind,
    content
  });
}

function insertVote(game, voterId, promptId) {
  const existing = td().votes.find(
    (vote) =>
      Number(vote.gameId) === Number(game.id) &&
      Number(vote.roundNo) === Number(game.roundNo) &&
      Number(vote.voterId) === Number(voterId)
  );
  if (existing) existing.promptId = Number(promptId);
  else
    td().votes.push({
      gameId: Number(game.id),
      roundNo: Number(game.roundNo),
      voterId: Number(voterId),
      promptId: Number(promptId)
    });
}

function resolveRound(game) {
  const round = findRound(game.id, game.roundNo);
  if (round) round.resolvedAt = iso();
  setPhase(game, 'resolved', null);
}

function enterVoting(game, deadlineMs) {
  setPhase(game, 'voting', deadlineMs);
}

function closeVoting(game) {
  const prompts = promptsOf(game.id, game.roundNo).map((prompt) => ({
    id: Number(prompt.id),
    voteCount: votesOf(game.id, game.roundNo).filter((vote) => Number(vote.promptId) === Number(prompt.id)).length
  }));
  const winner = resolveVotingWinner(prompts);
  const round = findRound(game.id, game.roundNo);
  if (round) round.winningPromptId = winner;
  game.winningPromptId = winner;
  setPhase(game, 'answering', null);
}

function finalizeAnswer(game) {
  if (answerResolution(game.choice) === 'resolved') {
    const round = findRound(game.id, game.roundNo);
    if (round) round.resolvedAt = iso();
    setPhase(game, 'resolved', null);
    return;
  }
  setPhase(game, 'confirming', Date.now() + TRUTH_DARE_CONFIRM_MS);
}

function confirmRound(game, userId) {
  const round = findRound(game.id, game.roundNo);
  if (!round) return;
  round.confirmedBy = Number(userId);
  round.resolvedAt = iso();
  setPhase(game, 'resolved', null);
}

function countOnlineOthers(game) {
  return participantsOf(game.id).filter(
    (participant) =>
      participantOnline(participant, sessionUserId()) &&
      Number(participant.userId) !== Number(game.chosenUserId)
  ).length;
}

function countOnlineAuthors(game) {
  const authors = new Set(
    promptsOf(game.id, game.roundNo)
      .filter((prompt) => Number(prompt.authorId) !== Number(game.chosenUserId))
      .filter((prompt) => {
        const participant = participantsOf(game.id).find(
          (item) => Number(item.userId) === Number(prompt.authorId)
        );
        return participant && participantOnline(participant, sessionUserId());
      })
      .map((prompt) => Number(prompt.authorId))
  );
  return authors.size;
}

function countOnlineVoters(game) {
  const voters = new Set(
    votesOf(game.id, game.roundNo)
      .filter((vote) => Number(vote.voterId) !== Number(game.chosenUserId))
      .filter((vote) => {
        const participant = participantsOf(game.id).find(
          (item) => Number(item.userId) === Number(vote.voterId)
        );
        return participant && participantOnline(participant, sessionUserId());
      })
      .map((vote) => Number(vote.voterId))
  );
  return voters.size;
}

function maybeAutoOpenVoting(game) {
  const onlineCount = countOnlineOthers(game);
  if (onlineCount <= 0) return;
  if (countOnlineAuthors(game) < onlineCount) return;
  enterVoting(game, Date.now() + TRUTH_DARE_VOTE_MS);
}

function maybeAutoCloseVoting(game) {
  const onlineCount = countOnlineOthers(game);
  if (onlineCount <= 0) return;
  if (countOnlineVoters(game) < onlineCount) return;
  closeVoting(game);
}

function applyTimeout(game, transition) {
  if (transition.kind === 'auto_dare') {
    const round = findRound(game.id, game.roundNo);
    if (round) {
      round.choice = 'dare';
      round.choiceAuto = true;
    }
    game.choice = 'dare';
    setPhase(game, 'collecting', transition.deadlineMs);
    return;
  }
  if (transition.kind === 'to_voting') {
    enterVoting(game, transition.deadlineMs);
    return;
  }
  if (transition.kind === 'resolve') {
    resolveRound(game);
    return;
  }
  if (transition.kind === 'close_voting') {
    closeVoting(game);
    return;
  }
  if (transition.kind === 'auto_confirm') {
    resolveRound(game);
  }
}

function applyDeadlines(game) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (game.status !== 'playing') return;
    const deadline = game.phaseDeadlineMs == null ? null : Number(game.phaseDeadlineMs);
    if (deadline == null || Date.now() < deadline) return;
    const hasPrompts = game.phase === 'collecting' && promptsOf(game.id, game.roundNo).length > 0;
    const transition = timeoutTransition(game.phase, Date.now(), hasPrompts);
    if (!transition) {
      game.phaseDeadlineMs = null;
      return;
    }
    applyTimeout(game, transition);
  }
}

// ---------- 机器人补齐其他在线玩家 ----------

function botPrompt(kind, roundNo, authorId) {
  const pool = BOT_PROMPTS[kind] || BOT_PROMPTS.truth;
  return pool[(roundNo + authorId) % pool.length];
}

function botAnswer(kind, roundNo, chosenId) {
  const pool = BOT_ANSWERS[kind] || BOT_ANSWERS.truth;
  return pool[(roundNo + chosenId) % pool.length];
}

function progressBots(game) {
  if (!game) return;
  applyDeadlines(game);
  if (game.status !== 'playing') return;
  if (game.phaseStartedAt == null) game.phaseStartedAt = Date.now();
  if (Date.now() - Number(game.phaseStartedAt) < BOT_STEP_MS) return;

  const viewerId = sessionUserId();
  const chosenId = game.chosenUserId == null ? null : Number(game.chosenUserId);
  const bots = participantsOf(game.id).filter((participant) => Number(participant.userId) !== viewerId);
  // 每个节拍只推进一步，并重置节拍起点，让每一步子阶段都至少间隔一个节拍可见。
  const step = () => {
    game.phaseStartedAt = Date.now();
  };

  if (game.phase === 'choosing') {
    // 被选中者是机器人时，代表他做出选择；真人在场时留给他自己选（超时后走自动大冒险）。
    if (chosenId != null && chosenId !== viewerId) {
      // 机器人被选中的轮次固定选“大冒险”，这样真人访客（本轮的非被选中参与者）
      // 才能作为“确认者”体验确认环节，而不是被机器人选“真心话”后直接结算跳过。
      const choice = 'dare';
      const round = findRound(game.id, game.roundNo);
      if (round) round.choice = choice;
      game.choice = choice;
      setPhase(game, 'collecting', Date.now() + TRUTH_DARE_COLLECT_MS);
    }
    return;
  }

  if (game.phase === 'collecting') {
    const kind = game.choice === 'dare' ? 'dare' : 'truth';
    const bot = bots.find(
      (candidate) =>
        Number(candidate.userId) !== chosenId &&
        !promptsOf(game.id, game.roundNo).some((prompt) => Number(prompt.authorId) === Number(candidate.userId))
    );
    if (bot) {
      insertPrompt(game, Number(bot.userId), kind, botPrompt(kind, Number(game.roundNo), Number(bot.userId)));
      step();
    }
    maybeAutoOpenVoting(game);
    return;
  }

  if (game.phase === 'voting') {
    const prompts = promptsOf(game.id, game.roundNo);
    const bot = prompts.length
      ? bots.find(
          (candidate) =>
            Number(candidate.userId) !== chosenId &&
            !votesOf(game.id, game.roundNo).some((vote) => Number(vote.voterId) === Number(candidate.userId))
        )
      : null;
    if (bot) {
      insertVote(game, Number(bot.userId), prompts[Number(bot.userId) % prompts.length].id);
      step();
    }
    maybeAutoCloseVoting(game);
    return;
  }

  if (game.phase === 'answering') {
    if (chosenId != null && chosenId !== viewerId) {
      const round = findRound(game.id, game.roundNo);
      if (round) round.answerText = botAnswer(game.choice, Number(game.roundNo), chosenId);
      finalizeAnswer(game);
    }
    return;
  }

  if (game.phase === 'confirming') {
    // 若真人访客正是本轮确认者（参与者且非被选中者），先留出确认窗口；
    // 超过窗口仍未确认，再由机器人代确认，既让访客能点到“确认”，也不会长时间卡住。
    const viewerCanConfirm = Number(viewerId) !== Number(chosenId) && isParticipant(game.id, viewerId);
    if (viewerCanConfirm && Date.now() - Number(game.phaseStartedAt) < BOT_CONFIRM_WAIT_MS) return;
    const confirmer = bots.find((participant) => Number(participant.userId) !== chosenId);
    if (confirmer) confirmRound(game, Number(confirmer.userId));
    else step();
  }
}

// ---------- 守卫 ----------

function requireCreator(game, userId, message) {
  if (Number(game.creatorId) !== Number(userId)) fail(message, 403);
}

function requireChosen(game, userId, message) {
  if (game.chosenUserId == null || Number(game.chosenUserId) !== Number(userId)) fail(message, 403);
}

function requirePhase(game, phases, message) {
  if (!phases.includes(game.phase)) fail(message, 409);
}

function requireParticipant(gameId, userId, message) {
  if (!isParticipant(gameId, userId)) fail(message, 403);
}

function validateChoice(raw) {
  const choice = String(raw ?? '');
  if (!TRUTH_DARE_CHOICES.includes(choice)) fail('必须选择真心话或大冒险');
  return choice;
}

function validatePromptContent(raw) {
  const content = String(raw ?? '').trim();
  if (!content) fail('台词不能为空');
  if (content.length > 200) fail('台词不能超过 200 字');
  return content;
}

function validateAnswerText(raw) {
  const text = String(raw ?? '').trim();
  if (text.length > 2000) fail('作答不能超过 2000 字');
  return text;
}

function validateScope(raw) {
  const scope = String(raw ?? '');
  if (!TRUTH_DARE_SCOPES.includes(scope)) fail('游戏范围无效');
  return scope;
}

function validateGameTitle(raw) {
  const title = String(raw ?? '').trim();
  if (title.length > 60) fail('标题不能超过 60 字');
  return title;
}

// ---------- 动作分发 ----------

function handleAction(game, userId, payload) {
  const action = String(payload.action || '');
  if (action !== 'endGame' && game.status !== 'playing') fail('游戏已结束', 409);
  switch (action) {
    case 'spin':
      return actionSpin(game, userId);
    case 'choose':
      return actionChoose(game, userId, payload);
    case 'prompt':
      return actionPrompt(game, userId, payload);
    case 'openVoting':
      return actionOpenVoting(game, userId);
    case 'vote':
      return actionVote(game, userId, payload);
    case 'closeVoting':
      return actionCloseVoting(game, userId);
    case 'answer':
      return actionAnswer(game, userId, payload);
    case 'confirm':
      return actionConfirm(game, userId);
    case 'endGame':
      return actionEndGame(game, userId);
    default:
      fail('未知的游戏操作', 400);
  }
}

function actionSpin(game, userId) {
  requireCreator(game, userId, '只有发起人可以抽人');
  requirePhase(game, ['idle', 'resolved'], '当前阶段不能抽人');
  const participants = participantsOf(game.id).map((participant) => ({
    userId: Number(participant.userId),
    online: participantOnline(participant, sessionUserId())
  }));
  const roundNo = Number(game.roundNo) + 1;
  // demo 只有单个真人访客：奇数轮固定由真人当主角，让他能完整体验选择/作答；
  // 偶数轮再随机抽给其他演示玩家，方便体验出题与投票，避免“永远抽不到自己”。
  const viewer = participants.find((participant) => Number(participant.userId) === Number(userId) && participant.online);
  const chosen = roundNo % 2 === 1 && viewer ? viewer : chooseOnlineChosen(participants);
  if (!chosen) fail('当前没有在线玩家');
  td().rounds.push({
    id: td().nextRoundId++,
    gameId: Number(game.id),
    roundNo,
    chosenUserId: Number(chosen.userId),
    choice: null,
    choiceAuto: false,
    winningPromptId: null,
    answerText: '',
    answerVoiceKey: '',
    answerVoiceDurationMs: null,
    confirmedBy: null,
    createdAt: iso(),
    resolvedAt: null
  });
  game.chosenUserId = Number(chosen.userId);
  game.choice = null;
  game.winningPromptId = null;
  game.roundNo = roundNo;
  setPhase(game, 'choosing', Date.now() + TRUTH_DARE_CHOICE_MS);
}

function actionChoose(game, userId, payload) {
  requirePhase(game, ['choosing'], '当前阶段不能选择');
  requireChosen(game, userId, '只有被选中的人可以选择');
  const choice = validateChoice(payload.choice);
  const round = findRound(game.id, game.roundNo);
  if (round) round.choice = choice;
  game.choice = choice;
  setPhase(game, 'collecting', Date.now() + TRUTH_DARE_COLLECT_MS);
}

function actionPrompt(game, userId, payload) {
  requirePhase(game, ['collecting'], '当前阶段不能出题');
  requireParticipant(game.id, userId, '只有参与者可以出题');
  if (Number(game.chosenUserId) === Number(userId)) fail('被选中的人不能出题', 403);
  const content = validatePromptContent(payload.content);
  if (promptsOf(game.id, game.roundNo).some((prompt) => Number(prompt.authorId) === Number(userId))) {
    fail('每人只能提交一条');
  }
  const kind = game.choice === 'truth' || game.choice === 'dare' ? game.choice : 'truth';
  insertPrompt(game, userId, kind, content);
  maybeAutoOpenVoting(game);
}

function actionOpenVoting(game, userId) {
  requireCreator(game, userId, '只有发起人可以开启投票');
  requirePhase(game, ['collecting'], '当前阶段不能开启投票');
  if (!promptsOf(game.id, game.roundNo).length) {
    resolveRound(game);
    return;
  }
  enterVoting(game, Date.now() + TRUTH_DARE_VOTE_MS);
}

function actionVote(game, userId, payload) {
  requirePhase(game, ['voting'], '当前阶段不能投票');
  requireParticipant(game.id, userId, '只有参与者可以投票');
  if (Number(game.chosenUserId) === Number(userId)) fail('被选中的人不能投票', 403);
  const promptId = Number(payload.promptId);
  const prompt = promptsOf(game.id, game.roundNo).find((item) => Number(item.id) === promptId);
  if (!prompt) fail('只能投给本轮的台词');
  insertVote(game, userId, promptId);
  maybeAutoCloseVoting(game);
}

function actionCloseVoting(game, userId) {
  requireCreator(game, userId, '只有发起人可以结束投票');
  requirePhase(game, ['voting'], '当前阶段不能结束投票');
  closeVoting(game);
}

function actionAnswer(game, userId, payload) {
  requirePhase(game, ['answering'], '当前阶段不能作答');
  requireChosen(game, userId, '只有被选中的人可以作答');
  const text = validateAnswerText(payload.text);
  const voiceKey = payload.voiceKey ? String(payload.voiceKey) : '';
  const voiceDuration = payload.voiceDurationMs == null ? null : Number(payload.voiceDurationMs);
  if (!text && !voiceKey) fail('请填写作答内容或录音');
  const round = findRound(game.id, game.roundNo);
  if (round) {
    round.answerText = text;
    round.answerVoiceKey = voiceKey;
    round.answerVoiceDurationMs = voiceDuration;
  }
  finalizeAnswer(game);
}

function actionConfirm(game, userId) {
  requirePhase(game, ['confirming'], '当前阶段不能确认');
  requireParticipant(game.id, userId, '只有参与者可以确认');
  if (Number(game.chosenUserId) === Number(userId)) fail('不能自己确认', 403);
  confirmRound(game, userId);
}

function actionEndGame(game, userId) {
  requireCreator(game, userId, '只有发起人可以结束游戏');
  if (game.status === 'ended') return;
  game.status = 'ended';
  game.endedAt = iso();
  setPhase(game, 'resolved', null);
}

// ---------- 状态读取 ----------

function loadParticipants(game) {
  const viewerId = sessionUserId();
  return participantsOf(game.id)
    .map((participant) => {
      const user = findDemoUser(participant.userId);
      return {
        userId: Number(participant.userId),
        displayName: user?.displayName || '',
        avatarUrl: user?.avatarUrl || '',
        isCreator: Boolean(participant.isCreator),
        online: participantOnline(participant, viewerId),
        isChosen: Number(game.chosenUserId) === Number(participant.userId)
      };
    })
    .sort((left, right) => Number(right.isCreator) - Number(left.isCreator));
}

function loadRound(game, userId) {
  const round = findRound(game.id, game.roundNo);
  if (!round) return null;
  const votes = votesOf(game.id, game.roundNo);
  const prompts = promptsOf(game.id, game.roundNo).map((prompt) => ({
    id: Number(prompt.id),
    authorId: Number(prompt.authorId),
    authorName: userName(prompt.authorId),
    content: prompt.content,
    voteCount: votes.filter((vote) => Number(vote.promptId) === Number(prompt.id)).length,
    votedByMe: votes.some(
      (vote) => Number(vote.promptId) === Number(prompt.id) && Number(vote.voterId) === Number(userId)
    )
  }));
  const winner =
    round.winningPromptId == null
      ? null
      : td().prompts.find((prompt) => Number(prompt.id) === Number(round.winningPromptId));
  const voiceKey = round.answerVoiceKey || '';
  return {
    roundNo: Number(round.roundNo),
    chosenUserId: round.chosenUserId == null ? null : Number(round.chosenUserId),
    chosenName: userName(round.chosenUserId),
    choice: round.choice || null,
    prompts,
    winningPromptId: round.winningPromptId == null ? null : Number(round.winningPromptId),
    winningContent: winner?.content || '',
    answerText: round.answerText || '',
    answerVoiceKey: voiceKey,
    answerVoiceUrl: voiceKey ? getDemoFileUrl(voiceKey) : '',
    answerVoiceDurationMs: round.answerVoiceDurationMs == null ? null : Number(round.answerVoiceDurationMs),
    confirmedBy: round.confirmedBy == null ? null : Number(round.confirmedBy),
    confirmedByName: round.confirmedBy == null ? '' : userName(round.confirmedBy)
  };
}

function buildState(game, userId) {
  touchParticipant(game.id, userId);
  const participants = loadParticipants(game);
  const me = participants.find((participant) => participant.userId === Number(userId)) || null;
  return {
    game: {
      id: Number(game.id),
      title: game.title || '',
      scope: game.scope,
      status: game.status,
      phase: game.phase,
      roundNo: Number(game.roundNo || 0),
      creatorId: Number(game.creatorId),
      creatorName: userName(game.creatorId),
      channelId: game.channelId == null ? null : Number(game.channelId),
      channelName: channelName(game.channelId)
    },
    me: {
      userId: Number(userId),
      isCreator: Number(game.creatorId) === Number(userId),
      isParticipant: Boolean(me),
      isChosen: game.chosenUserId != null && Number(game.chosenUserId) === Number(userId),
      isOnline: Boolean(me?.online)
    },
    allowMemberCreate: td().allowMemberCreate,
    phaseDeadlineMs: game.phaseDeadlineMs == null ? null : Number(game.phaseDeadlineMs),
    participants,
    round: Number(game.roundNo) > 0 ? loadRound(game, Number(userId)) : null
  };
}

// ---------- 路由 ----------

function requireVisibleGame(gameId, userId) {
  if (!Number.isInteger(gameId) || gameId <= 0) fail('对局不存在', 404);
  const access = loadGameForUser(gameId, userId);
  if (!access) fail('对局不存在', 404);
  if (!access.visible) fail('无权查看该对局', 403);
  return access.game;
}

function overview(userId) {
  const auth = demoAuthorization(findDemoUser(userId));
  const canCreate = hasPermission(auth, TRUTH_DARE_CREATE_PERMISSION);
  return {
    allowMemberCreate: td().allowMemberCreate,
    canCreate,
    canApprove: canCreate,
    games: listVisibleGames(userId),
    pendingApplications: canCreate ? listPendingApplications() : [],
    myApplications: listMyApplications(userId)
  };
}

function createGame(userId, payload) {
  const scope = validateScope(payload.scope);
  const title = validateGameTitle(payload.title);
  let channelId = null;
  let participantUserIds = [];
  if (scope === 'channel') {
    channelId = Number(payload.channelId);
    if (!Number.isInteger(channelId) || channelId <= 0) fail('请选择群组');
    const channel = findDemoChannel(channelId);
    if (!channel || !['public', 'private'].includes(channel.kind)) fail('群组不存在', 404);
    if (!(channel.memberIds || []).map(Number).includes(Number(userId))) fail('你不是该群组成员', 403);
    participantUserIds = channelMemberIds(channelId);
  } else if (scope === 'manual') {
    const raw = Array.isArray(payload.invitedUserIds) ? payload.invitedUserIds : [];
    participantUserIds = resolveInvited(raw);
    if (!participantUserIds.length) {
      // 区分“没填名单”与“名单里的用户名都无效”，给出准确提示。
      fail(raw.some((value) => String(value).trim()) ? '邀请的用户不存在或不可用，请检查用户名' : '请至少邀请一位玩家');
    }
  } else if (scope === 'public') {
    // demo 公共房没有其他真实访客，用其他演示用户充当“在线玩家”，保证单个访客也能走完整个流程。
    participantUserIds = demoState.users
      .filter((user) => isActiveUser(user) && Number(user.id) !== Number(userId))
      .map((user) => Number(user.id));
  }

  const auth = demoAuthorization(findDemoUser(userId));
  const canCreate = hasPermission(auth, TRUTH_DARE_CREATE_PERMISSION);
  if (td().allowMemberCreate || canCreate) {
    const id = createGameWithParticipants({ creatorId: userId, scope, channelId, title, participantUserIds });
    return { created: mapGameSummary(findGame(id), userId), application: null, needApproval: false };
  }
  const applicationId = createApplication({
    applicantId: userId,
    scope,
    channelId,
    invitedUserIds: scope === 'manual' ? participantUserIds : [],
    note: String(payload.note || '').trim()
  });
  const application = mapApplication(td().applications.find((item) => Number(item.id) === applicationId));
  return { created: null, application, needApproval: true };
}

function reviewApplication(userId, applicationId, payload) {
  const auth = demoAuthorization(findDemoUser(userId));
  if (!hasPermission(auth, TRUTH_DARE_CREATE_PERMISSION)) fail('没有审批权限', 403);
  const application = td().applications.find((item) => Number(item.id) === Number(applicationId));
  if (!application) fail('申请不存在', 404);
  if (application.status !== 'pending') fail('该申请已处理', 409);
  const approve = Boolean(payload.approve);
  const reason = String(payload.reason || '').trim();
  application.reviewerId = Number(userId);
  application.reviewReason = reason;
  application.reviewedAt = iso();
  if (!approve) {
    application.status = 'rejected';
    return { ok: true };
  }
  const participantUserIds = resolveParticipantIds({
    scope: application.scope,
    channelId: application.channelId,
    invitedUserIds: application.invitedUserIds
  });
  const gameId = createGameWithParticipants({
    creatorId: application.applicantId,
    scope: application.scope,
    channelId: application.channelId,
    title: '',
    participantUserIds
  });
  application.status = 'approved';
  application.gameId = gameId;
  return { ok: true, game: mapGameSummary(findGame(gameId), userId) };
}

function joinGame(userId, gameId) {
  const access = loadGameForUser(gameId, userId);
  if (!access) fail('对局不存在', 404);
  if (access.isParticipant) return { ok: true };
  const { game } = access;
  let allowed = false;
  if (game.scope === 'public') allowed = true;
  else if (game.scope === 'channel') {
    const channel = findDemoChannel(game.channelId);
    allowed = Boolean(channel && (channel.memberIds || []).map(Number).includes(Number(userId)));
  } else if (game.scope === 'manual') allowed = isInvitedToGame(gameId, userId);
  if (!allowed) fail('你不在该对局的受邀范围内', 403);
  insertParticipant(gameId, userId, false);
  return { ok: true };
}

function leaveGame(userId, gameId) {
  const access = loadGameForUser(gameId, userId);
  if (!access) fail('对局不存在', 404);
  if (access.isCreator) fail('创建者不能退出，请结束游戏', 409);
  demoState.truthDare.participants = td().participants.filter(
    (participant) => !(Number(participant.gameId) === Number(gameId) && Number(participant.userId) === Number(userId))
  );
  return { ok: true };
}

function historyPayload(offset) {
  const games = td()
    .games.slice()
    .sort((left, right) => Number(right.id) - Number(left.id))
    .slice(0, 50)
    .map((game) => ({
      id: Number(game.id),
      title: game.title || '',
      scope: game.scope,
      status: game.status,
      creatorName: userName(game.creatorId),
      roundCount: roundsOf(game.id).length,
      createdAt: game.createdAt,
      endedAt: game.endedAt || null
    }));
  const allRounds = td().rounds.slice().sort((left, right) => Number(right.id) - Number(left.id));
  const gameTitle = (gameId) => findGame(gameId)?.title || '';
  const rounds = allRounds.slice(offset, offset + 50).map((round) => {
    const winner =
      round.winningPromptId == null
        ? null
        : td().prompts.find((prompt) => Number(prompt.id) === Number(round.winningPromptId));
    const voiceKey = round.answerVoiceKey || '';
    return {
      id: Number(round.id),
      gameId: Number(round.gameId),
      gameTitle: gameTitle(round.gameId),
      roundNo: Number(round.roundNo),
      chosenName: userName(round.chosenUserId),
      choice: round.choice || null,
      choiceAuto: Boolean(round.choiceAuto),
      promptContent: winner?.content || '',
      answerText: round.answerText || '',
      answerVoiceUrl: voiceKey ? getDemoFileUrl(voiceKey) : '',
      confirmedByName: round.confirmedBy == null ? '' : userName(round.confirmedBy),
      createdAt: round.createdAt,
      resolvedAt: round.resolvedAt || null
    };
  });
  return { total: allRounds.length, games, rounds };
}

export function demoTruthDare(pathname, method, body = {}, url = new URL('https://edgechat.demo')) {
  const userId = sessionUserId();

  if (pathname === '/admin/truth-dare/settings') {
    if (method === 'GET') return { allowMemberCreate: td().allowMemberCreate };
    if (method === 'PUT') {
      if (typeof body.allowMemberCreate !== 'boolean') fail('参数无效');
      td().allowMemberCreate = body.allowMemberCreate;
      return { allowMemberCreate: td().allowMemberCreate };
    }
  }
  if (method === 'GET' && pathname === '/admin/truth-dare/history') {
    const offset = Number(url.searchParams.get('offset') || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) fail('分页参数无效');
    return historyPayload(offset);
  }
  if (method === 'GET' && pathname === '/admin/truth-dare/history/export') {
    return {
      exportedAt: iso(),
      games: cloneDemo(td().games),
      rounds: cloneDemo(td().rounds),
      prompts: cloneDemo(td().prompts),
      votes: cloneDemo(td().votes)
    };
  }

  if (method === 'GET' && pathname === '/truth-dare/overview') {
    return overview(userId);
  }
  if (method === 'POST' && pathname === '/truth-dare/games') {
    return createGame(userId, body);
  }

  let match = pathname.match(/^\/truth-dare\/applications\/(\d+)\/review$/);
  if (method === 'POST' && match) {
    return reviewApplication(userId, Number(match[1]), body);
  }

  match = pathname.match(/^\/truth-dare\/applications\/(\d+)\/cancel$/);
  if (method === 'POST' && match) {
    const application = td().applications.find((item) => Number(item.id) === Number(match[1]));
    if (!application) fail('申请不存在', 404);
    if (Number(application.applicantId) !== Number(userId)) fail('只能取消自己的申请', 403);
    if (application.status !== 'pending') fail('只能取消待审批的申请', 409);
    application.status = 'cancelled';
    application.reviewedAt = iso();
    return { ok: true };
  }

  match = pathname.match(/^\/truth-dare\/games\/(\d+)\/join$/);
  if (method === 'POST' && match) {
    const gameId = Number(match[1]);
    if (!Number.isInteger(gameId) || gameId <= 0) fail('对局不存在', 404);
    return joinGame(userId, gameId);
  }

  match = pathname.match(/^\/truth-dare\/games\/(\d+)\/leave$/);
  if (method === 'POST' && match) {
    const gameId = Number(match[1]);
    if (!Number.isInteger(gameId) || gameId <= 0) fail('对局不存在', 404);
    return leaveGame(userId, gameId);
  }

  match = pathname.match(/^\/truth-dare\/games\/(\d+)\/state$/);
  if (method === 'GET' && match) {
    const game = requireVisibleGame(Number(match[1]), userId);
    progressBots(game);
    return buildState(game, userId);
  }

  match = pathname.match(/^\/truth-dare\/games\/(\d+)\/action$/);
  if (method === 'POST' && match) {
    const game = requireVisibleGame(Number(match[1]), userId);
    // 先让机器人推进到当前时间点，再执行真人动作，保证动作落在合法阶段上。
    progressBots(game);
    handleAction(game, userId, body);
    return buildState(game, userId);
  }

  return null;
}
