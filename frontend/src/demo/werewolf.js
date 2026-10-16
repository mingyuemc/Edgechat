// 狼人杀在 demo 站点的纯前端实现。
// 复用 worker/src/data 的纯逻辑（分角色、平票、夜晚死亡、胜负判定）以保持与后端一致的语义，
// 用内存状态替代 D1；由于 demo 只有单个真人访客，其他在线玩家由“机器人”在轮询驱动下自动行动，
// 保证一个人也能完整走完开局、夜晚、白天、投票、结算的整局流程。
import { cloneDemo, demoState, findDemoChannel, findDemoUser } from './state.js';
import { demoAuthorization } from './rbac.ts';
import { hasPermission } from '../../../shared/admin-permissions.ts';
import {
  WEREWOLF_CREATE_PERMISSION,
  WEREWOLF_MAX_PLAYERS,
  WEREWOLF_MIN_PLAYERS,
  WEREWOLF_ONLINE_MS,
  WEREWOLF_SCOPES,
  WEREWOLF_TITLE_MAX
} from '../../../shared/werewolf.ts';
import {
  assignRoles,
  checkWinner,
  parseRoleConfig,
  resolveExile,
  resolveNightDeaths,
  resolvePlurality
} from '../../../worker/src/data/werewolf.ts';

// demo 的兜底时限比线上更短，让单个访客在有限时间内也能看到完整回合推进。
const NIGHT_MS = 20000;
const DAY_MS = 12000;
const VOTE_MS = 20000;
// 机器人每个节拍只推进一步（刀人/查验/用药/投票），与前端轮询间隔对齐。
const BOT_STEP_MS = 1200;
const ROLE_KEYS = ['wolf', 'seer', 'witch', 'villager'];
const NIGHT_ACTOR_ROLES = ['wolf', 'seer', 'witch'];

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  error.payload = { error: message };
  throw error;
}

function iso() {
  return new Date().toISOString();
}

function ww() {
  return demoState.werewolf;
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

function findGame(gameId) {
  return ww().games.find((game) => Number(game.id) === Number(gameId));
}

function participantsOf(gameId) {
  return ww().participants.filter((participant) => Number(participant.gameId) === Number(gameId));
}

function participantOf(gameId, userId) {
  return participantsOf(gameId).find((participant) => Number(participant.userId) === Number(userId));
}

function isParticipant(gameId, userId) {
  return Boolean(participantOf(gameId, userId));
}

function roundsOf(gameId) {
  return ww().rounds.filter((round) => Number(round.gameId) === Number(gameId));
}

function findRound(gameId, roundNo) {
  return ww().rounds.find(
    (round) => Number(round.gameId) === Number(gameId) && Number(round.roundNo) === Number(roundNo)
  );
}

function nightActionsOf(gameId, roundNo) {
  return ww().nightActions.filter(
    (action) => Number(action.gameId) === Number(gameId) && Number(action.roundNo) === Number(roundNo)
  );
}

function votesOf(gameId, roundNo) {
  return ww().votes.filter(
    (vote) => Number(vote.gameId) === Number(gameId) && Number(vote.roundNo) === Number(roundNo)
  );
}

function channelMemberIds(channelId) {
  const channel = findDemoChannel(channelId);
  if (!channel) return [];
  return channel.memberIds.map(Number).filter((userId) => isActiveUser(findDemoUser(userId)));
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
  return ww().applications.some(
    (application) =>
      Number(application.gameId) === Number(gameId) &&
      application.status === 'approved' &&
      (application.invitedUserIds || []).map(Number).includes(Number(userId))
  );
}

// ---------- 校验 ----------

function validateScope(raw) {
  const scope = String(raw ?? '');
  if (!WEREWOLF_SCOPES.includes(scope)) fail('游戏范围无效');
  return scope;
}

function validateGameTitle(raw) {
  const title = String(raw ?? '').trim();
  if (title.length > WEREWOLF_TITLE_MAX) fail(`标题不能超过 ${WEREWOLF_TITLE_MAX} 字`);
  return title;
}

function roleConfigTotal(config) {
  const parsed = parseRoleConfig(config);
  return ROLE_KEYS.reduce((sum, role) => sum + Number(parsed[role] || 0), 0);
}

function normalizeRoleConfig(raw) {
  const config = parseRoleConfig(raw);
  const total = roleConfigTotal(config);
  if (total < WEREWOLF_MIN_PLAYERS) fail(`至少需要 ${WEREWOLF_MIN_PLAYERS} 名玩家`);
  if (total > WEREWOLF_MAX_PLAYERS) fail(`最多 ${WEREWOLF_MAX_PLAYERS} 名玩家`);
  return config;
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
  return ww()
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
  return ww()
    .applications.filter((application) => application.status === 'pending')
    .sort((left, right) => Number(right.id) - Number(left.id))
    .slice(0, 100)
    .map(mapPendingApplication);
}

function listMyApplications(userId) {
  return ww()
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

function insertParticipant(game, userId, isCreator, role = null) {
  if (isParticipant(game.id, userId)) return;
  ww().participants.push({
    gameId: Number(game.id),
    userId: Number(userId),
    isCreator: Boolean(isCreator),
    role: role || null,
    alive: true,
    deathRound: null,
    deathCause: null,
    antidoteUsed: false,
    poisonUsed: false,
    lastSeenAt: Date.now(),
    joinedAt: iso()
  });
}

function touchParticipant(gameId, userId) {
  const participant = participantOf(gameId, userId);
  if (participant) participant.lastSeenAt = Date.now();
}

function createGameWithParticipants({
  creatorId,
  scope,
  channelId = null,
  title = '',
  participantUserIds = [],
  roleConfig = {},
  assignMode = 'auto'
}) {
  const config = normalizeRoleConfig(roleConfig);
  const mode = assignMode === 'manual' ? 'manual' : 'auto';
  const id = ww().nextGameId++;
  const game = {
    id,
    creatorId: Number(creatorId),
    scope,
    channelId: channelId == null ? null : Number(channelId),
    title: String(title || ''),
    status: 'playing',
    phase: 'lobby',
    roundNo: 0,
    roleConfig: config,
    assignMode: mode,
    winner: null,
    phaseDeadlineMs: null,
    phaseStartedAt: Date.now(),
    createdAt: iso(),
    endedAt: null
  };
  ww().games.push(game);
  const ids = [...new Set([Number(creatorId), ...participantUserIds.map(Number)])].filter(
    (userId) => Number.isInteger(userId) && userId > 0
  );
  for (const userId of ids) insertParticipant(game, userId, userId === Number(creatorId));
  return id;
}

function createApplication({
  applicantId,
  scope,
  channelId = null,
  invitedUserIds = [],
  note = '',
  roleConfig = {},
  assignMode = 'auto'
}) {
  const config = normalizeRoleConfig(roleConfig);
  const mode = assignMode === 'manual' ? 'manual' : 'auto';
  const id = ww().nextApplicationId++;
  ww().applications.push({
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
    roleConfig: config,
    assignMode: mode,
    createdAt: iso(),
    reviewedAt: null
  });
  return id;
}

// 汇总建局时的参与者池，并把人数裁到与角色配置一致，保证单个访客创建后即可直接开局。
function resolveParticipantIds({ scope, channelId, invitedUserIds, creatorId, total }) {
  let pool = [];
  if (scope === 'channel' && channelId != null) {
    pool = channelMemberIds(channelId);
  } else if (scope === 'manual') {
    pool = resolveInvited(invitedUserIds);
  } else {
    // demo 公共房没有其他真实访客，用其他演示用户充当“在线玩家”。
    pool = demoState.users
      .filter((user) => isActiveUser(user) && Number(user.id) !== Number(creatorId))
      .map((user) => Number(user.id));
  }
  const ids = [...new Set([Number(creatorId), ...pool.map(Number)])].filter(
    (userId) => Number.isInteger(userId) && userId > 0
  );
  return ids.slice(0, total);
}

// ---------- 阶段推进 ----------

function setPhase(game, phase, deadlineMs) {
  game.phase = phase;
  game.phaseDeadlineMs = deadlineMs == null ? null : Number(deadlineMs);
  game.phaseStartedAt = Date.now();
}

function aliveByRole(gameId) {
  const counts = { wolf: 0, seer: 0, witch: 0, villager: 0 };
  for (const participant of participantsOf(gameId)) {
    if (participant.alive && participant.role in counts) counts[participant.role] += 1;
  }
  return counts;
}

function aliveCount(gameId) {
  return participantsOf(gameId).filter((participant) => participant.alive).length;
}

function nightActorCount(gameId) {
  const counts = aliveByRole(gameId);
  return counts.wolf + counts.seer + counts.witch;
}

function nightActionOf(game, userId) {
  return ww().nightActions.find(
    (action) =>
      Number(action.gameId) === Number(game.id) &&
      Number(action.roundNo) === Number(game.roundNo) &&
      Number(action.actorId) === Number(userId)
  );
}

function insertNightAction(game, actorId, action, targetUserId) {
  const roundNo = Number(game.roundNo);
  const normalizedTarget = targetUserId == null ? null : Number(targetUserId);
  const existing = nightActionOf(game, actorId);
  if (existing) {
    existing.action = action;
    existing.targetUserId = normalizedTarget;
    return;
  }
  ww().nightActions.push({
    gameId: Number(game.id),
    roundNo,
    actorId: Number(actorId),
    action,
    targetUserId: normalizedTarget
  });
}

function voteOf(game, userId) {
  return ww().votes.find(
    (vote) =>
      Number(vote.gameId) === Number(game.id) &&
      Number(vote.roundNo) === Number(game.roundNo) &&
      Number(vote.voterId) === Number(userId)
  );
}

function insertVote(game, voterId, targetUserId) {
  const roundNo = Number(game.roundNo);
  const normalizedTarget = targetUserId == null ? null : Number(targetUserId);
  const existing = voteOf(game, voterId);
  if (existing) {
    existing.targetUserId = normalizedTarget;
    return;
  }
  ww().votes.push({
    gameId: Number(game.id),
    roundNo,
    voterId: Number(voterId),
    targetUserId: normalizedTarget
  });
}

function maybeResolveNight(game) {
  if (nightActionsOf(game.id, game.roundNo).length < nightActorCount(game.id)) return;
  resolveNight(game);
}

function maybeResolveVote(game) {
  if (votesOf(game.id, game.roundNo).length < aliveCount(game.id)) return;
  resolveVote(game);
}

function endRound(game, winner) {
  game.status = 'ended';
  game.phase = 'ended';
  game.phaseDeadlineMs = null;
  game.winner = winner;
  game.endedAt = iso();
}

function resolveNight(game) {
  const roundNo = Number(game.roundNo);
  const actions = nightActionsOf(game.id, roundNo);
  const tally = {};
  for (const action of actions) {
    if (action.action !== 'wolf_kill' || action.targetUserId == null) continue;
    const id = Number(action.targetUserId);
    tally[id] = (tally[id] || 0) + 1;
  }
  const wolfTarget = resolvePlurality(
    Object.entries(tally).map(([id, count]) => ({ id: Number(id), count }))
  );
  const saved = actions.some((action) => action.action === 'witch_save');
  const poisonRow = actions.find((action) => action.action === 'witch_poison' && action.targetUserId != null);
  const poisonTarget = poisonRow ? Number(poisonRow.targetUserId) : null;
  const deaths = resolveNightDeaths({ wolfTarget, saved, poisonTarget });

  const round = findRound(game.id, roundNo);
  if (round) {
    round.wolfTargetUserId = wolfTarget;
    round.saved = saved;
    round.poisonedUserId = poisonTarget;
    round.deaths = deaths;
    round.resolvedAt = iso();
  }
  for (const death of deaths) {
    const participant = participantOf(game.id, death.userId);
    if (participant) {
      participant.alive = false;
      participant.deathRound = roundNo;
      participant.deathCause = death.cause;
    }
  }
  if (saved) for (const participant of participantsOf(game.id)) if (participant.role === 'witch') participant.antidoteUsed = true;
  if (poisonTarget != null) for (const participant of participantsOf(game.id)) if (participant.role === 'witch') participant.poisonUsed = true;

  const counts = aliveByRole(game.id);
  const winner = checkWinner(counts.wolf, counts.seer + counts.witch + counts.villager);
  if (winner) {
    endRound(game, winner);
    return;
  }
  setPhase(game, 'day', Date.now() + DAY_MS);
}

function resolveVote(game) {
  const roundNo = Number(game.roundNo);
  const tally = {};
  for (const vote of votesOf(game.id, roundNo)) {
    if (vote.targetUserId == null) continue;
    const id = Number(vote.targetUserId);
    tally[id] = (tally[id] || 0) + 1;
  }
  const exiled = resolveExile(
    Object.entries(tally).map(([id, count]) => ({ id: Number(id), count }))
  );
  const round = findRound(game.id, roundNo);
  if (round) {
    round.exiledUserId = exiled;
    round.resolvedAt = iso();
  }
  if (exiled != null) {
    const participant = participantOf(game.id, exiled);
    if (participant) {
      participant.alive = false;
      participant.deathRound = roundNo;
      participant.deathCause = 'vote';
    }
  }
  const counts = aliveByRole(game.id);
  const winner = checkWinner(counts.wolf, counts.seer + counts.witch + counts.villager);
  if (winner) {
    endRound(game, winner);
    return;
  }
  const nextRound = roundNo + 1;
  game.roundNo = nextRound;
  ww().rounds.push({
    id: ww().nextRoundId++,
    gameId: Number(game.id),
    roundNo: nextRound,
    wolfTargetUserId: null,
    saved: false,
    poisonedUserId: null,
    deaths: [],
    exiledUserId: null,
    createdAt: iso(),
    resolvedAt: null
  });
  setPhase(game, 'night', Date.now() + NIGHT_MS);
}

function applyDeadlines(game) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (game.status !== 'playing') return;
    const deadline = game.phaseDeadlineMs == null ? null : Number(game.phaseDeadlineMs);
    if (deadline == null || Date.now() < deadline) return;
    if (game.phase === 'night') {
      resolveNight(game);
    } else if (game.phase === 'day') {
      setPhase(game, 'vote', Date.now() + VOTE_MS);
    } else if (game.phase === 'vote') {
      resolveVote(game);
    } else {
      game.phaseDeadlineMs = null;
      return;
    }
  }
}

// ---------- 机器人补齐其他在线玩家 ----------

function pickByUser(participant, items) {
  if (!items.length) return null;
  return items[Number(participant.userId) % items.length];
}

function botNightAction(game, actor) {
  const others = participantsOf(game.id).filter(
    (participant) => participant.alive && Number(participant.userId) !== Number(actor.userId)
  );
  if (actor.role === 'wolf') {
    // 优先咬非狼，避免机器人误杀同为狼人的真人访客。
    const nonWolves = others.filter((participant) => participant.role !== 'wolf');
    const target = pickByUser(actor, nonWolves.length ? nonWolves : others);
    if (target) insertNightAction(game, actor.userId, 'wolf_kill', target.userId);
    else insertNightAction(game, actor.userId, 'wolf_skip', null);
    return;
  }
  if (actor.role === 'seer') {
    const target = pickByUser(actor, others);
    if (target) insertNightAction(game, actor.userId, 'seer_check', target.userId);
    else insertNightAction(game, actor.userId, 'seer_skip', null);
    return;
  }
  if (actor.role === 'witch') {
    // demo 女巫固定不使用药水，避免夜晚长期无死亡导致回合停滞；仅记录行动以满足结算要求。
    insertNightAction(game, actor.userId, 'witch_skip', null);
  }
}

function botVote(game, voter) {
  const others = participantsOf(game.id).filter(
    (participant) => participant.alive && Number(participant.userId) !== Number(voter.userId)
  );
  if (!others.length) return;
  const nonWolves = others.filter((participant) => participant.role !== 'wolf');
  const pool = voter.role === 'wolf' && nonWolves.length ? nonWolves : others;
  const target = pickByUser(voter, pool);
  if (target) insertVote(game, voter.userId, target.userId);
}

function progressBots(game) {
  if (!game) return;
  applyDeadlines(game);
  if (game.status !== 'playing') return;
  if (game.phaseStartedAt == null) game.phaseStartedAt = Date.now();
  if (Date.now() - Number(game.phaseStartedAt) < BOT_STEP_MS) return;

  const viewerId = sessionUserId();
  const bots = participantsOf(game.id).filter((participant) => Number(participant.userId) !== viewerId);
  // 每个节拍只推进一步并重置节拍起点，让每一步子阶段都至少间隔一个节拍可见。
  const step = () => {
    game.phaseStartedAt = Date.now();
  };

  if (game.phase === 'night') {
    const actor = bots.find(
      (participant) =>
        participant.alive &&
        NIGHT_ACTOR_ROLES.includes(participant.role) &&
        !nightActionOf(game, participant.userId)
    );
    if (!actor) return;
    botNightAction(game, actor);
    step();
    maybeResolveNight(game);
    return;
  }

  if (game.phase === 'vote') {
    const voter = bots.find((participant) => participant.alive && !voteOf(game, participant.userId));
    if (!voter) return;
    botVote(game, voter);
    step();
    maybeResolveVote(game);
  }
}

// ---------- 守卫 ----------

function requireCreator(game, userId, message) {
  if (Number(game.creatorId) !== Number(userId)) fail(message, 403);
}

function requirePhase(game, phases, message) {
  if (!phases.includes(game.phase)) fail(message, 409);
}

function requireAlive(gameId, userId, message) {
  const participant = participantOf(gameId, userId);
  if (!participant || !participant.alive) fail(message, 403);
}

function requireRole(gameId, userId, role, message) {
  const participant = participantOf(gameId, userId);
  if (!participant || participant.role !== role) fail(message, 403);
}

// ---------- 动作实现 ----------

// 让真人访客优先拿到狼人身份，保证他能体验到夜晚行动；不会破坏角色数量配置。
function biasViewerRole(participants, roles, viewerId) {
  if (!(viewerId in roles) || roles[viewerId] === 'wolf') return roles;
  const wolfId = participants.map((participant) => Number(participant.userId)).find((id) => roles[id] === 'wolf');
  if (wolfId == null) return roles;
  const next = { ...roles };
  next[wolfId] = roles[viewerId];
  next[viewerId] = 'wolf';
  return next;
}

function startGame(game, userId, payload) {
  requireCreator(game, userId, '只有发起人可以开始游戏');
  requirePhase(game, ['lobby'], '当前阶段不能开始游戏');
  const participants = participantsOf(game.id);
  if (participants.length < WEREWOLF_MIN_PLAYERS) fail(`至少需要 ${WEREWOLF_MIN_PLAYERS} 名玩家`);
  const mode = game.assignMode === 'manual' ? 'manual' : 'auto';
  const ids = participants.map((participant) => Number(participant.userId));
  let roles;
  if (mode === 'manual' && payload.roleAssignment) {
    roles = assignRoles(ids, game.roleConfig, 'manual', payload.roleAssignment);
  } else if (mode === 'manual' && participants.every((participant) => participant.role)) {
    roles = Object.fromEntries(participants.map((participant) => [Number(participant.userId), participant.role]));
  } else {
    roles = assignRoles(ids, game.roleConfig, 'auto');
    roles = biasViewerRole(participants, roles, Number(userId));
  }
  for (const participant of participants) participant.role = roles[Number(participant.userId)];
  game.roundNo = 1;
  ww().rounds.push({
    id: ww().nextRoundId++,
    gameId: Number(game.id),
    roundNo: 1,
    wolfTargetUserId: null,
    saved: false,
    poisonedUserId: null,
    deaths: [],
    exiledUserId: null,
    createdAt: iso(),
    resolvedAt: null
  });
  setPhase(game, 'night', Date.now() + NIGHT_MS);
}

function wolfKill(game, userId, payload) {
  requirePhase(game, ['night'], '当前阶段不能击杀');
  requireAlive(game.id, userId, '只有存活玩家可以行动');
  requireRole(game.id, userId, 'wolf', '只有狼人可以选择击杀');
  const targetUserId = Number(payload.targetUserId);
  requireAlive(game.id, targetUserId, '只能击杀存活玩家');
  insertNightAction(game, userId, 'wolf_kill', targetUserId);
  maybeResolveNight(game);
}

function seerCheck(game, userId, payload) {
  requirePhase(game, ['night'], '当前阶段不能查验');
  requireAlive(game.id, userId, '只有存活玩家可以行动');
  requireRole(game.id, userId, 'seer', '只有预言家可以查验');
  const targetUserId = Number(payload.targetUserId);
  if (!participantOf(game.id, targetUserId)) fail('只能查验本局玩家', 403);
  insertNightAction(game, userId, 'seer_check', targetUserId);
  maybeResolveNight(game);
}

function witchAct(game, userId, payload) {
  requirePhase(game, ['night'], '当前阶段不能使用药水');
  requireAlive(game.id, userId, '只有存活玩家可以行动');
  requireRole(game.id, userId, 'witch', '只有女巫可以使用药水');
  const me = participantOf(game.id, userId);
  if (nightActionOf(game, userId)) fail('每晚最多使用一瓶药水', 409);
  const mode = String(payload.mode || '');
  if (mode === 'save') {
    if (me?.antidoteUsed) fail('解药已经用过了', 409);
    insertNightAction(game, userId, 'witch_save', null);
  } else if (mode === 'poison') {
    if (me?.poisonUsed) fail('毒药已经用过了', 409);
    const targetUserId = Number(payload.targetUserId);
    requireAlive(game.id, targetUserId, '只能毒杀存活玩家');
    insertNightAction(game, userId, 'witch_poison', targetUserId);
  } else if (mode === 'skip') {
    insertNightAction(game, userId, 'witch_skip', null);
  } else {
    fail('药水选择无效');
  }
  maybeResolveNight(game);
}

function endDiscussion(game, userId) {
  requireCreator(game, userId, '只有发起人可以结束讨论');
  requirePhase(game, ['day'], '当前阶段不能结束讨论');
  setPhase(game, 'vote', Date.now() + VOTE_MS);
}

function voteAction(game, userId, payload) {
  requirePhase(game, ['vote'], '当前阶段不能投票');
  requireAlive(game.id, userId, '只有存活玩家可以投票');
  const targetUserId = payload.targetUserId == null ? null : Number(payload.targetUserId);
  if (targetUserId != null) requireAlive(game.id, targetUserId, '只能投票给存活玩家');
  insertVote(game, userId, targetUserId);
  maybeResolveVote(game);
}

function endGame(game, userId) {
  requireCreator(game, userId, '只有发起人可以结束游戏');
  if (game.status === 'ended') return;
  const counts = aliveByRole(game.id);
  endRound(game, checkWinner(counts.wolf, counts.seer + counts.witch + counts.villager));
}

function handleAction(game, userId, payload) {
  const action = String(payload.action || '');
  if (action !== 'endGame' && game.status !== 'playing') fail('游戏已结束', 409);
  switch (action) {
    case 'start':
      return startGame(game, userId, payload);
    case 'wolfKill':
      return wolfKill(game, userId, payload);
    case 'seerCheck':
      return seerCheck(game, userId, payload);
    case 'witchAct':
      return witchAct(game, userId, payload);
    case 'endDiscussion':
      return endDiscussion(game, userId);
    case 'vote':
      return voteAction(game, userId, payload);
    case 'endGame':
      return endGame(game, userId);
    default:
      fail('未知的游戏操作', 400);
  }
}

// ---------- 状态读取 ----------

function participantOnline(participant, viewerId) {
  // 机器人访客在 demo 中始终视为在线；真人访客按最近一次心跳判断。
  if (Number(participant.userId) !== Number(viewerId)) return true;
  const lastSeen = Number(participant.lastSeenAt || 0);
  return lastSeen > 0 && Date.now() - lastSeen <= WEREWOLF_ONLINE_MS;
}

function hasActed(game, userId) {
  if (game.phase === 'night') return Boolean(nightActionOf(game, userId));
  if (game.phase === 'vote') return Boolean(voteOf(game, userId));
  return false;
}

function loadSeerChecks(gameId, userId) {
  return ww()
    .nightActions.filter(
      (action) =>
        Number(action.gameId) === Number(gameId) &&
        Number(action.actorId) === Number(userId) &&
        action.action === 'seer_check' &&
        action.targetUserId != null
    )
    .sort((left, right) => Number(left.roundNo) - Number(right.roundNo))
    .map((action) => ({
      roundNo: Number(action.roundNo),
      targetUserId: Number(action.targetUserId),
      targetName: userName(action.targetUserId),
      isWolf: participantOf(gameId, action.targetUserId)?.role === 'wolf'
    }));
}

function buildNight(game, userId, participants) {
  const actions = nightActionsOf(game.id, game.roundNo);
  const me = participants.find((participant) => Number(participant.userId) === Number(userId));
  const myRow = actions.find((action) => Number(action.actorId) === Number(userId));
  // 狼队目标仅对狼人可见；查验记录仅对预言家可见；药水状态仅对女巫可见。
  const wolfTargetUserIds =
    me?.role === 'wolf'
      ? [
          ...new Set(
            actions
              .filter((action) => action.action === 'wolf_kill' && action.targetUserId != null)
              .map((action) => Number(action.targetUserId))
          )
        ]
      : null;
  return {
    myAction: myRow
      ? { action: myRow.action, targetUserId: myRow.targetUserId == null ? null : Number(myRow.targetUserId) }
      : null,
    wolfTargetUserIds,
    seerChecks: me?.role === 'seer' ? loadSeerChecks(game.id, userId) : [],
    witch:
      me?.role === 'witch'
        ? { hasAntidote: !me.antidoteUsed, hasPoison: !me.poisonUsed, usedTonight: Boolean(myRow) }
        : null,
    actedCount: actions.length,
    requiredCount: participants.filter(
      (participant) => participant.alive && NIGHT_ACTOR_ROLES.includes(participant.role)
    ).length
  };
}

function buildVote(game, userId, participants) {
  const rows = votesOf(game.id, game.roundNo);
  const nameMap = new Map(
    participants.map((participant) => [Number(participant.userId), participant.displayName || userName(participant.userId)])
  );
  const nameOf = (userId) => nameMap.get(Number(userId)) || userName(userId);
  const tallyMap = {};
  for (const row of rows) {
    if (row.targetUserId == null) continue;
    const id = Number(row.targetUserId);
    tallyMap[id] = (tallyMap[id] || 0) + 1;
  }
  const tally = Object.entries(tallyMap).map(([id, count]) => ({
    targetUserId: Number(id),
    targetName: nameOf(id),
    count
  }));
  const votes = rows.map((row) => ({
    voterUserId: Number(row.voterId),
    voterName: nameOf(row.voterId),
    targetUserId: row.targetUserId == null ? null : Number(row.targetUserId),
    targetName: row.targetUserId == null ? '' : nameOf(row.targetUserId)
  }));
  const myRow = rows.find((row) => Number(row.voterId) === Number(userId));
  return {
    myVoteTargetUserId: myRow ? (myRow.targetUserId == null ? null : Number(myRow.targetUserId)) : null,
    votedCount: rows.length,
    requiredCount: participants.filter((participant) => participant.alive).length,
    tally,
    votes
  };
}

function buildHistory(game, participants) {
  const names = new Map(
    participants.map((participant) => [Number(participant.userId), participant.displayName || userName(participant.userId)])
  );
  return ww()
    .rounds.filter((round) => Number(round.gameId) === Number(game.id) && round.resolvedAt)
    .sort((left, right) => Number(left.roundNo) - Number(right.roundNo))
    .map((round) => ({
      roundNo: Number(round.roundNo),
      deaths: (round.deaths || []).map((death) => ({
        userId: Number(death.userId),
        displayName: names.get(Number(death.userId)) || userName(death.userId),
        cause: death.cause
      })),
      exiled:
        round.exiledUserId == null
          ? null
          : {
              userId: Number(round.exiledUserId),
              displayName: names.get(Number(round.exiledUserId)) || userName(round.exiledUserId)
            }
    }));
}

function buildState(gameId, userId) {
  touchParticipant(gameId, userId);
  const game = findGame(gameId);
  const participants = participantsOf(gameId);
  const me = participantOf(gameId, userId) || null;
  const meRole = me?.role || null;
  const ended = game.status === 'ended' || game.phase === 'ended';
  // 真实身份只在“是我 / 已死亡 / 已结束 / 我是狼人且对方也是狼人”时公开。
  const revealRole = (participant) =>
    participant.role != null &&
    (Number(participant.userId) === Number(userId) ||
      !participant.alive ||
      ended ||
      (meRole === 'wolf' && participant.role === 'wolf'));
  const history = buildHistory(game, participants);
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
      channelName: channelName(game.channelId),
      winner: game.winner || null
    },
    me: {
      userId: Number(userId),
      isCreator: Number(game.creatorId) === Number(userId),
      isParticipant: Boolean(me),
      isAlive: Boolean(me?.alive),
      isOnline: Boolean(me && participantOnline(me, userId)),
      role: meRole,
      hasActed: hasActed(game, userId)
    },
    phaseDeadlineMs: game.phaseDeadlineMs == null ? null : Number(game.phaseDeadlineMs),
    allowMemberCreate: ww().allowMemberCreate,
    roleConfig: parseRoleConfig(game.roleConfig),
    assignMode: game.assignMode,
    participants: participants.map((participant) => ({
      userId: Number(participant.userId),
      displayName: participant.displayName || userName(participant.userId),
      avatarUrl: findDemoUser(participant.userId)?.avatarUrl || '',
      isCreator: Boolean(participant.isCreator),
      online: participantOnline(participant, userId),
      isAlive: Boolean(participant.alive),
      roleRevealed: revealRole(participant),
      role: revealRole(participant) ? participant.role : null,
      deathRound: participant.deathRound == null ? null : Number(participant.deathRound),
      deathCause: participant.deathCause || null
    })),
    night: game.phase === 'night' ? buildNight(game, userId, participants) : null,
    day: game.phase === 'day' ? { roundNo: Number(game.roundNo) } : null,
    vote: game.phase === 'vote' ? buildVote(game, userId, participants) : null,
    history,
    lastResult: history.length ? { ...history.at(-1), winner: game.winner || null } : null
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
  const canCreate = hasPermission(auth, WEREWOLF_CREATE_PERMISSION);
  return {
    allowMemberCreate: ww().allowMemberCreate,
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
  const roleConfig = normalizeRoleConfig(payload.roleConfig);
  const assignMode = payload.assignMode === 'manual' ? 'manual' : 'auto';
  const total = roleConfigTotal(roleConfig);

  let channelId = null;
  let invitedUserIds = [];
  if (scope === 'channel') {
    channelId = Number(payload.channelId);
    if (!Number.isInteger(channelId) || channelId <= 0) fail('请选择群组');
    const channel = findDemoChannel(channelId);
    if (!channel || !['public', 'private'].includes(channel.kind)) fail('群组不存在', 404);
    if (!(channel.memberIds || []).map(Number).includes(Number(userId))) fail('你不是该群组成员', 403);
  } else if (scope === 'manual') {
    invitedUserIds = Array.isArray(payload.invitedUserIds) ? payload.invitedUserIds : [];
    if (!resolveInvited(invitedUserIds).length) {
      // 区分“没填名单”与“名单里的用户名都无效”，给出准确提示。
      fail(invitedUserIds.some((value) => String(value).trim()) ? '邀请的用户不存在或不可用，请检查用户名' : '请至少邀请一位玩家');
    }
  }

  const auth = demoAuthorization(findDemoUser(userId));
  const canCreate = hasPermission(auth, WEREWOLF_CREATE_PERMISSION);
  if (ww().allowMemberCreate || canCreate) {
    const participantUserIds = resolveParticipantIds({ scope, channelId, invitedUserIds, creatorId: userId, total });
    const id = createGameWithParticipants({
      creatorId: userId,
      scope,
      channelId,
      title,
      participantUserIds,
      roleConfig,
      assignMode
    });
    return { created: mapGameSummary(findGame(id), userId), application: null, needApproval: false };
  }
  const applicationId = createApplication({
    applicantId: userId,
    scope,
    channelId,
    invitedUserIds: scope === 'manual' ? resolveInvited(invitedUserIds) : [],
    note: String(payload.note || '').trim(),
    roleConfig,
    assignMode
  });
  const application = mapApplication(ww().applications.find((item) => Number(item.id) === applicationId));
  return { created: null, application, needApproval: true };
}

function reviewApplication(userId, applicationId, payload) {
  const auth = demoAuthorization(findDemoUser(userId));
  if (!hasPermission(auth, WEREWOLF_CREATE_PERMISSION)) fail('没有审批权限', 403);
  const application = ww().applications.find((item) => Number(item.id) === Number(applicationId));
  if (!application) fail('申请不存在', 404);
  if (application.status !== 'pending') fail('该申请已处理', 409);
  const approve = Boolean(payload.approve);
  application.reviewerId = Number(userId);
  application.reviewReason = String(payload.reason || '').trim();
  application.reviewedAt = iso();
  if (!approve) {
    application.status = 'rejected';
    return { ok: true };
  }
  const total = roleConfigTotal(application.roleConfig);
  const participantUserIds = resolveParticipantIds({
    scope: application.scope,
    channelId: application.channelId,
    invitedUserIds: application.invitedUserIds,
    creatorId: application.applicantId,
    total
  });
  const gameId = createGameWithParticipants({
    creatorId: application.applicantId,
    scope: application.scope,
    channelId: application.channelId,
    title: '',
    participantUserIds,
    roleConfig: application.roleConfig,
    assignMode: application.assignMode
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
  insertParticipant(game, userId, false);
  return { ok: true };
}

function leaveGame(userId, gameId) {
  const access = loadGameForUser(gameId, userId);
  if (!access) fail('对局不存在', 404);
  if (access.isCreator) fail('创建者不能退出，请结束游戏', 409);
  ww().participants = ww().participants.filter(
    (participant) => !(Number(participant.gameId) === Number(gameId) && Number(participant.userId) === Number(userId))
  );
  return { ok: true };
}

function historyPayload(offset) {
  const allRounds = ww().rounds.slice().sort((left, right) => Number(right.id) - Number(left.id));
  const games = ww()
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
  const rounds = allRounds.slice(offset, offset + 50).map((round) => ({
    id: Number(round.id),
    gameId: Number(round.gameId),
    gameTitle: findGame(round.gameId)?.title || '',
    roundNo: Number(round.roundNo),
    wolfTargetName: userName(round.wolfTargetUserId),
    saved: Boolean(round.saved),
    poisonedName: userName(round.poisonedUserId),
    exiledName: userName(round.exiledUserId),
    deaths: (round.deaths || []).map((death) => ({
      userId: Number(death.userId),
      displayName: userName(death.userId),
      cause: death.cause
    })),
    createdAt: round.createdAt,
    resolvedAt: round.resolvedAt || null
  }));
  return { total: ww().rounds.length, games, rounds };
}

export function demoWerewolf(pathname, method, body = {}, url = new URL('https://edgechat.demo')) {
  const userId = sessionUserId();

  if (pathname === '/admin/werewolf/settings') {
    if (method === 'GET') return { allowMemberCreate: ww().allowMemberCreate };
    if (method === 'PUT') {
      if (typeof body.allowMemberCreate !== 'boolean') fail('参数无效');
      ww().allowMemberCreate = body.allowMemberCreate;
      return { allowMemberCreate: ww().allowMemberCreate };
    }
  }
  if (method === 'GET' && pathname === '/admin/werewolf/history') {
    const offset = Number(url.searchParams.get('offset') || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) fail('分页参数无效');
    return historyPayload(offset);
  }
  if (method === 'GET' && pathname === '/admin/werewolf/history/export') {
    return {
      exportedAt: iso(),
      games: cloneDemo(ww().games),
      rounds: cloneDemo(ww().rounds),
      participants: cloneDemo(ww().participants),
      nightActions: cloneDemo(ww().nightActions),
      votes: cloneDemo(ww().votes)
    };
  }

  if (method === 'GET' && pathname === '/werewolf/overview') {
    return overview(userId);
  }
  if (method === 'POST' && pathname === '/werewolf/games') {
    return createGame(userId, body);
  }

  let match = pathname.match(/^\/werewolf\/applications\/(\d+)\/review$/);
  if (method === 'POST' && match) {
    return reviewApplication(userId, Number(match[1]), body);
  }

  match = pathname.match(/^\/werewolf\/applications\/(\d+)\/cancel$/);
  if (method === 'POST' && match) {
    const application = ww().applications.find((item) => Number(item.id) === Number(match[1]));
    if (!application) fail('申请不存在', 404);
    if (Number(application.applicantId) !== Number(userId)) fail('只能取消自己的申请', 403);
    if (application.status !== 'pending') fail('只能取消待审批的申请', 409);
    application.status = 'cancelled';
    application.reviewedAt = iso();
    return { ok: true };
  }

  match = pathname.match(/^\/werewolf\/games\/(\d+)\/join$/);
  if (method === 'POST' && match) {
    const gameId = Number(match[1]);
    if (!Number.isInteger(gameId) || gameId <= 0) fail('对局不存在', 404);
    return joinGame(userId, gameId);
  }

  match = pathname.match(/^\/werewolf\/games\/(\d+)\/leave$/);
  if (method === 'POST' && match) {
    const gameId = Number(match[1]);
    if (!Number.isInteger(gameId) || gameId <= 0) fail('对局不存在', 404);
    return leaveGame(userId, gameId);
  }

  match = pathname.match(/^\/werewolf\/games\/(\d+)\/state$/);
  if (method === 'GET' && match) {
    const game = requireVisibleGame(Number(match[1]), userId);
    progressBots(game);
    return buildState(game.id, userId);
  }

  match = pathname.match(/^\/werewolf\/games\/(\d+)\/action$/);
  if (method === 'POST' && match) {
    const game = requireVisibleGame(Number(match[1]), userId);
    // 先让机器人推进到当前时间点，再执行真人动作，保证动作落在合法阶段上。
    progressBots(game);
    handleAction(game, userId, body);
    return buildState(game.id, userId);
  }

  return null;
}
