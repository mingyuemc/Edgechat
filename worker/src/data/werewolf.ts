// 狼人杀的数据访问与状态机纯逻辑。
// 纯逻辑（分角色/平票/死亡结算/胜负/超时/校验）不依赖 D1，便于单测；持久化函数集中在此，
// 由 API 路由与 WerewolfRoom 复用，避免同一套 SQL 散落多处。
import { ApiError } from '../errors.js';
import {
  WEREWOLF_MAX_PLAYERS,
  WEREWOLF_MIN_PLAYERS,
  WEREWOLF_ROLES,
  WEREWOLF_SCOPES,
  WEREWOLF_TITLE_MAX,
  WEREWOLF_VOTE_MS
} from '../../../shared/werewolf.ts';

// ---------- 纯逻辑 ----------

// 从数组中按 rng（返回 [0,1)）等概率取一项；空数组返回 null。
export function chooseRandom(items, random = Math.random) {
  if (!items?.length) return null;
  const index = Math.min(items.length - 1, Math.max(0, Math.floor(random() * items.length)));
  return items[index];
}

// 角色数量配置：把任意输入归一成 {wolf, seer, witch, villager} 四个非负整数。
export function parseRoleConfig(raw) {
  const config = { wolf: 0, seer: 0, witch: 0, villager: 0 };
  let source = raw;
  if (typeof raw === 'string') {
    try {
      source = JSON.parse(raw || '{}');
    } catch {
      source = {};
    }
  }
  if (source && typeof source === 'object') {
    for (const role of WEREWOLF_ROLES) config[role] = Number(source[role] || 0);
  }
  return config;
}

// 分角色：把玩家按配置分配成狼人/预言家/女巫/村民。
// auto 随机洗牌后按数量分配；manual 严格采用房主给定的 userId→role 映射。
// 四种角色数量之和必须与玩家数量一致，否则拒绝。
export function assignRoles(participantIds, roleConfig, assignMode, roleAssignment, random = Math.random) {
  const ids = [...new Set((participantIds || []).map(Number))].filter((id) => Number.isInteger(id) && id > 0);
  const config = parseRoleConfig(roleConfig);
  const total = WEREWOLF_ROLES.reduce((sum, role) => sum + config[role], 0);
  if (ids.length < WEREWOLF_MIN_PLAYERS) throw new ApiError(`至少需要 ${WEREWOLF_MIN_PLAYERS} 名玩家`);
  if (total !== ids.length) throw new ApiError('角色配置与玩家数量不匹配');
  const roles = {};
  if (String(assignMode) === 'manual') {
    const mapping = validateRoleAssignment(roleAssignment);
    const counts = { wolf: 0, seer: 0, witch: 0, villager: 0 };
    for (const id of ids) {
      const role = mapping[id];
      if (!role) throw new ApiError('角色分配与玩家数量不匹配');
      counts[role] += 1;
      roles[id] = role;
    }
    for (const role of WEREWOLF_ROLES) {
      if (counts[role] !== config[role]) throw new ApiError('角色分配与玩家数量不匹配');
    }
    return roles;
  }
  // auto：先按数量铺成一个角色池，再用 Fisher–Yates 洗牌。
  const pool = [];
  for (const role of WEREWOLF_ROLES) for (let i = 0; i < config[role]; i += 1) pool.push(role);
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.min(i, Math.max(0, Math.floor(random() * (i + 1))));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  ids.forEach((id, index) => {
    roles[id] = pool[index];
  });
  return roles;
}

// 取票/击杀的最高票：最高票唯一时胜出，平票时在最高者中随机挑一个；无候选取 null。
export function resolvePlurality(entries, random = Math.random) {
  if (!entries?.length) return null;
  let max = -Infinity;
  for (const entry of entries) if (entry.count > max) max = entry.count;
  const top = entries.filter((entry) => entry.count === max);
  return chooseRandom(top, random)?.id ?? null;
}

// 放逐结算：与多数票结算同义，返回被放逐的 userId（平票随机），无候选取 null。
export function resolveExile(entries, random = Math.random) {
  return resolvePlurality(entries, random);
}

// 夜晚死亡结算：狼人击杀目标若未被女巫解药救下则死于 wolf，毒杀目标死于 poison。
// 返回按 userId 去重后的死亡名单。
export function resolveNightDeaths({ wolfTarget = null, saved = false, poisonTarget = null } = {}) {
  const deaths = [];
  if (wolfTarget != null && !saved) deaths.push({ userId: Number(wolfTarget), cause: 'wolf' });
  if (poisonTarget != null) deaths.push({ userId: Number(poisonTarget), cause: 'poison' });
  const unique = [];
  for (const death of deaths) {
    if (!unique.some((entry) => entry.userId === death.userId)) unique.push(death);
  }
  return unique;
}

// 胜负判定：狼人全灭 → 村民胜利；狼人数 >= 其他存活人数 → 狼人胜利；否则继续。
export function checkWinner(aliveWolves, aliveOthers) {
  if (aliveWolves <= 0) return 'villagers';
  if (aliveWolves >= aliveOthers) return 'wolves';
  return null;
}

// 依据当前阶段与兜底时限计算超时后的推进动作；无兜底的阶段返回 null。
// kind=resolve_night：夜晚超时结算；to_vote：白天超时进入投票；resolve_vote：投票超时结算放逐。
export function timeoutTransition(phase, nowMs, _state) {
  if (phase === 'night') return { kind: 'resolve_night', deadlineMs: null };
  if (phase === 'day') return { kind: 'to_vote', deadlineMs: nowMs + WEREWOLF_VOTE_MS };
  if (phase === 'vote') return { kind: 'resolve_vote', deadlineMs: null };
  return null;
}

// ---------- 守卫与校验（失败抛中文 ApiError） ----------

export function requireCreator(game, userId, message = '只有发起人可以操作') {
  if (Number(game?.creator_id) !== Number(userId)) throw new ApiError(message, 403);
}

export function requirePhase(game, phases, message = '当前阶段不能进行此操作') {
  if (!phases.includes(game?.phase)) throw new ApiError(message, 409);
}

export function validateScope(raw) {
  const scope = String(raw ?? '');
  if (!(WEREWOLF_SCOPES as readonly string[]).includes(scope)) throw new ApiError('游戏范围无效');
  return scope;
}

export function validateGameTitle(raw) {
  const title = String(raw ?? '').trim();
  if (title.length > WEREWOLF_TITLE_MAX) throw new ApiError(`标题不能超过 ${WEREWOLF_TITLE_MAX} 字`);
  return title;
}

export function validateRoleConfig(raw) {
  const config = parseRoleConfig(raw);
  for (const role of WEREWOLF_ROLES) {
    if (!Number.isInteger(config[role]) || config[role] < 0) throw new ApiError('角色配置无效');
  }
  const total = WEREWOLF_ROLES.reduce((sum, role) => sum + config[role], 0);
  if (total < WEREWOLF_MIN_PLAYERS) throw new ApiError(`至少需要 ${WEREWOLF_MIN_PLAYERS} 名玩家`);
  if (total > WEREWOLF_MAX_PLAYERS) throw new ApiError(`最多 ${WEREWOLF_MAX_PLAYERS} 名玩家`);
  return config;
}

export function validateAssignMode(raw) {
  const mode = String(raw ?? '');
  if (mode !== 'auto' && mode !== 'manual') throw new ApiError('分配方式无效');
  return mode;
}

export function validateRoleAssignment(raw) {
  let source = raw;
  if (typeof raw === 'string') {
    try {
      source = JSON.parse(raw || '{}');
    } catch {
      source = {};
    }
  }
  const assignment = {};
  if (source && typeof source === 'object') {
    for (const [key, value] of Object.entries(source)) {
      const userId = Number(key);
      const role = String(value ?? '');
      if (!Number.isInteger(userId) || userId <= 0) throw new ApiError('角色分配无效');
      if (!(WEREWOLF_ROLES as readonly string[]).includes(role)) throw new ApiError('角色分配无效');
      assignment[userId] = role;
    }
  }
  return assignment;
}

export function parseIdList(raw) {
  try {
    const list = JSON.parse(raw || '[]');
    return Array.isArray(list) ? list.map(Number).filter((id) => Number.isInteger(id) && id > 0) : [];
  } catch {
    return [];
  }
}

// ---------- 读取投影 ----------

export function mapGameSummary(row) {
  return {
    id: Number(row.id),
    title: row.title || '',
    scope: row.scope,
    channelId: row.channel_id == null ? null : Number(row.channel_id),
    channelName: row.channel_name || '',
    status: row.status,
    phase: row.phase,
    roundNo: Number(row.round_no || 0),
    participantCount: Number(row.participant_count || 0),
    isParticipant: Boolean(Number(row.is_participant)),
    isCreator: Boolean(Number(row.is_creator)),
    creatorName: row.creator_name || '',
    createdAt: row.created_at
  };
}

export function mapApplication(row) {
  return {
    id: Number(row.id),
    scope: row.scope,
    channelId: row.channel_id == null ? null : Number(row.channel_id),
    channelName: row.channel_name || '',
    note: row.note || '',
    status: row.status,
    reviewReason: row.review_reason || '',
    gameId: row.game_id == null ? null : Number(row.game_id),
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at || null
  };
}

export function mapPendingApplication(row) {
  return {
    id: Number(row.id),
    applicantId: Number(row.applicant_id),
    applicantName: row.applicant_name || '',
    scope: row.scope,
    channelId: row.channel_id == null ? null : Number(row.channel_id),
    channelName: row.channel_name || '',
    invitedUserIds: parseIdList(row.invited_user_ids),
    note: row.note || '',
    createdAt: row.created_at
  };
}

const GAME_SUMMARY_SELECT = `g.id, g.title, g.scope, g.channel_id, c.name AS channel_name,
  g.status, g.phase, g.round_no, g.created_at, creator.display_name AS creator_name,
  (SELECT COUNT(*) FROM werewolf_participants p WHERE p.game_id = g.id) AS participant_count,
  EXISTS (SELECT 1 FROM werewolf_participants p WHERE p.game_id = g.id AND p.user_id = ?) AS is_participant,
  (g.creator_id = ?) AS is_creator`;

// 可见对局 = 公开 ∪ 我是参与者 ∪ 我是创建者（包含已结束）。
export async function listVisibleGames(db, userId) {
  const { results } = await db
    .prepare(
      `SELECT ${GAME_SUMMARY_SELECT}
       FROM werewolf_games g
       LEFT JOIN users creator ON creator.id = g.creator_id
       LEFT JOIN channels c ON c.id = g.channel_id
       WHERE g.scope = 'public'
          OR EXISTS (SELECT 1 FROM werewolf_participants p WHERE p.game_id = g.id AND p.user_id = ?)
          OR g.creator_id = ?
       ORDER BY g.id DESC
       LIMIT 100`
    )
    .bind(userId, userId, userId, userId)
    .all();
  return results.map(mapGameSummary);
}

export async function getGameSummary(db, gameId, userId) {
  const row = await db
    .prepare(
      `SELECT ${GAME_SUMMARY_SELECT}
       FROM werewolf_games g
       LEFT JOIN users creator ON creator.id = g.creator_id
       LEFT JOIN channels c ON c.id = g.channel_id
       WHERE g.id = ?`
    )
    .bind(userId, userId, gameId)
    .first();
  return row ? mapGameSummary(row) : null;
}

// 完整对局行（含创建者名与群名），供 DO 与可见性判断使用。
export async function loadGame(db, gameId) {
  return db
    .prepare(
      `SELECT g.*, creator.display_name AS creator_name, c.name AS channel_name
       FROM werewolf_games g
       LEFT JOIN users creator ON creator.id = g.creator_id
       LEFT JOIN channels c ON c.id = g.channel_id
       WHERE g.id = ?`
    )
    .bind(gameId)
    .first();
}

export async function loadGameForUser(db, gameId, userId) {
  const game = await loadGame(db, gameId);
  if (!game) return null;
  const participant = await db
    .prepare('SELECT 1 AS ok FROM werewolf_participants WHERE game_id = ? AND user_id = ? LIMIT 1')
    .bind(gameId, userId)
    .first();
  const isParticipant = Boolean(participant);
  const isCreator = Number(game.creator_id) === Number(userId);
  return {
    game,
    isParticipant,
    isCreator,
    visible: game.scope === 'public' || isParticipant || isCreator
  };
}

export async function listPendingApplications(db) {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.applicant_id, applicant.display_name AS applicant_name, a.scope, a.channel_id,
          c.name AS channel_name, a.invited_user_ids, a.note, a.created_at
       FROM werewolf_applications a
       LEFT JOIN users applicant ON applicant.id = a.applicant_id
       LEFT JOIN channels c ON c.id = a.channel_id
       WHERE a.status = 'pending'
       ORDER BY a.id DESC
       LIMIT 100`
    )
    .all();
  return results.map(mapPendingApplication);
}

export async function listMyApplications(db, userId) {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.scope, a.channel_id, c.name AS channel_name, a.note, a.status,
          a.review_reason, a.game_id, a.created_at, a.reviewed_at
       FROM werewolf_applications a
       LEFT JOIN channels c ON c.id = a.channel_id
       WHERE a.applicant_id = ?
       ORDER BY a.id DESC
       LIMIT 100`
    )
    .bind(userId)
    .all();
  return results.map(mapApplication);
}

export async function getApplication(db, applicationId) {
  return db
    .prepare(
      `SELECT a.*, applicant.display_name AS applicant_name, c.name AS channel_name
       FROM werewolf_applications a
       LEFT JOIN users applicant ON applicant.id = a.applicant_id
       LEFT JOIN channels c ON c.id = a.channel_id
       WHERE a.id = ?`
    )
    .bind(applicationId)
    .first();
}

// ---------- 写入 ----------

export async function listChannelMemberIds(db, channelId) {
  const { results } = await db
    .prepare(
      `SELECT cm.user_id
       FROM channel_members cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.channel_id = ? AND u.deleted_at IS NULL`
    )
    .bind(channelId)
    .all();
  return results.map((row) => Number(row.user_id));
}

// 只有未删除且未被封禁的站内用户才可作为受邀对象。
// 前端手动名单提交的是用户名，这里同时兼容用户名与数字 ID 两种写法。
export async function validUserIds(db, userIds) {
  const raw = [...new Set((userIds || []).map((value) => String(value).trim()).filter(Boolean))];
  if (!raw.length) return [];
  const numeric = raw.filter((value) => /^\d+$/.test(value)).map(Number).filter((id) => id > 0);
  const usernames = raw.filter((value) => !/^\d+$/.test(value));
  const ids = [];
  if (numeric.length) {
    const placeholders = numeric.map(() => '?').join(', ');
    const { results } = await db
      .prepare(
        `SELECT id FROM users
         WHERE deleted_at IS NULL
           AND is_disabled = 0
           AND (disabled_until IS NULL OR datetime(disabled_until) <= CURRENT_TIMESTAMP)
           AND id IN (${placeholders})`
      )
      .bind(...numeric)
      .all();
    ids.push(...results.map((row) => Number(row.id)));
  }
  if (usernames.length) {
    const placeholders = usernames.map(() => '?').join(', ');
    const { results } = await db
      .prepare(
        `SELECT id FROM users
         WHERE deleted_at IS NULL
           AND is_disabled = 0
           AND (disabled_until IS NULL OR datetime(disabled_until) <= CURRENT_TIMESTAMP)
           AND username IN (${placeholders})`
      )
      .bind(...usernames)
      .all();
    ids.push(...results.map((row) => Number(row.id)));
  }
  return [...new Set(ids)];
}

// 建局：插入对局并一次性写入参与者（创建者标记 is_creator），角色留空待开局再分；
// 若为 manual 且房主已给出角色分配，则建局时直接写入参与者 role。
export async function createGameWithParticipants(db, { creatorId, scope, channelId = null, title = '', participantUserIds = [], roleConfig = {}, assignMode = 'auto', roleAssignment = null }) {
  const config = validateRoleConfig(roleConfig);
  const mode = validateAssignMode(assignMode);
  const result = await db
    .prepare(
      `INSERT INTO werewolf_games (creator_id, scope, channel_id, title, status, phase, role_config, assign_mode)
       VALUES (?, ?, ?, ?, 'playing', 'lobby', ?, ?)`
    )
    .bind(Number(creatorId), scope, channelId == null ? null : Number(channelId), String(title || ''), JSON.stringify(config), mode)
    .run();
  const gameId = Number(result.meta.last_row_id);
  const ids = [...new Set([Number(creatorId), ...participantUserIds.map(Number)])].filter((id) => Number.isInteger(id) && id > 0);
  const manual = mode === 'manual' && roleAssignment ? validateRoleAssignment(roleAssignment) : null;
  await db.batch(
    ids.map((id) =>
      db
        .prepare('INSERT OR IGNORE INTO werewolf_participants (game_id, user_id, is_creator, role) VALUES (?, ?, ?, ?)')
        .bind(gameId, id, id === Number(creatorId) ? 1 : 0, manual ? (manual[id] || null) : null)
    )
  );
  return gameId;
}

export async function createApplication(db, { applicantId, scope, channelId = null, invitedUserIds = [], note = '', roleConfig = {}, assignMode = 'auto' }) {
  const config = validateRoleConfig(roleConfig);
  const mode = validateAssignMode(assignMode);
  const result = await db
    .prepare(
      `INSERT INTO werewolf_applications (applicant_id, scope, channel_id, invited_user_ids, note, status, role_config, assign_mode)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
    )
    .bind(Number(applicantId), scope, channelId == null ? null : Number(channelId), JSON.stringify(invitedUserIds || []), String(note || ''), JSON.stringify(config), mode)
    .run();
  return Number(result.meta.last_row_id);
}

export async function approveApplication(db, { applicationId, gameId, reviewerId, reason = '' }) {
  await db
    .prepare(
      `UPDATE werewolf_applications
       SET status = 'approved', game_id = ?, reviewer_id = ?, review_reason = ?, reviewed_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(gameId, reviewerId, String(reason || ''), applicationId)
    .run();
}

export async function rejectApplication(db, { applicationId, reviewerId, reason = '' }) {
  await db
    .prepare(
      `UPDATE werewolf_applications
       SET status = 'rejected', reviewer_id = ?, review_reason = ?, reviewed_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(reviewerId, String(reason || ''), applicationId)
    .run();
}

export async function cancelApplication(db, applicationId) {
  await db
    .prepare(`UPDATE werewolf_applications SET status = 'cancelled', reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(applicationId)
    .run();
}

export async function joinGame(db, gameId, userId) {
  await db
    .prepare('INSERT OR IGNORE INTO werewolf_participants (game_id, user_id, is_creator) VALUES (?, ?, 0)')
    .bind(gameId, userId)
    .run();
}

export async function leaveGame(db, gameId, userId) {
  await db
    .prepare('DELETE FROM werewolf_participants WHERE game_id = ? AND user_id = ?')
    .bind(gameId, userId)
    .run();
}

// manual 范围的对局，受邀名单记录在审批通过后指向该局的申请里。
export async function isInvitedToGame(db, gameId, userId) {
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM werewolf_applications
       WHERE game_id = ? AND status = 'approved'
         AND EXISTS (SELECT 1 FROM json_each(invited_user_ids) WHERE CAST(value AS INTEGER) = ?)
       LIMIT 1`
    )
    .bind(gameId, userId)
    .first();
  return Boolean(row);
}

export async function insertWerewolfAudit(db, { requestId, actorId, actorName, action, target, summary }) {
  await db
    .prepare(
      `INSERT INTO admin_audit_log (request_id, actor_id, actor_name, action, target, summary)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(requestId, actorId, actorName || '', action, String(target ?? ''), JSON.stringify(summary || {}))
    .run();
}
