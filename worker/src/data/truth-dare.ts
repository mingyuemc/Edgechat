// 真心话大冒险的数据访问与状态机纯逻辑。
// 纯逻辑（选人/超时/平局/守卫/校验）不依赖 D1，便于单测；持久化函数集中在此，
// 由 API 路由与 TruthDareRoom 复用，避免同一套 SQL 散落多处。
import { ApiError } from '../errors.js';
import {
  TRUTH_DARE_ANSWER_MAX,
  TRUTH_DARE_CHOICES,
  TRUTH_DARE_COLLECT_MS,
  TRUTH_DARE_PROMPT_MAX,
  TRUTH_DARE_SCOPES,
  TRUTH_DARE_VOTE_MS
} from '../../../shared/truth-dare.ts';

// ---------- 纯逻辑 ----------

// 从数组中按 rng（返回 [0,1)）等概率取一项；空数组返回 null。
export function chooseRandom(items, random = Math.random) {
  if (!items?.length) return null;
  const index = Math.min(items.length - 1, Math.max(0, Math.floor(random() * items.length)));
  return items[index];
}

// 只在在线参与者中随机抽人；无人在线返回 null。
export function chooseOnlineChosen(participants, random = Math.random) {
  return chooseRandom((participants || []).filter((participant) => participant.online), random);
}

// 依据当前阶段与兜底时限计算超时后的推进动作；无超时的阶段返回 null。
// kind=auto_dare：选择超时强制大冒险；to_voting：出题超时进入投票；
// resolve：出题超时且无人提问直接结算本轮；close_voting：投票超时结算票选；
// auto_confirm：待确认超时（无人确认）自动结算。
export function timeoutTransition(phase, nowMs, hasPrompts) {
  if (phase === 'choosing') {
    return { kind: 'auto_dare', choice: 'dare', choiceAuto: true, deadlineMs: nowMs + TRUTH_DARE_COLLECT_MS };
  }
  if (phase === 'collecting') {
    return hasPrompts
      ? { kind: 'to_voting', deadlineMs: nowMs + TRUTH_DARE_VOTE_MS }
      : { kind: 'resolve', deadlineMs: null };
  }
  if (phase === 'voting') {
    return { kind: 'close_voting', deadlineMs: null };
  }
  if (phase === 'confirming') {
    return { kind: 'auto_confirm', deadlineMs: null };
  }
  return null;
}

// 投票结算：取最高票；平票时在最高者中随机挑一条。无候选返回 null。
export function resolveVotingWinner(prompts, random = Math.random) {
  if (!prompts?.length) return null;
  let max = -Infinity;
  for (const prompt of prompts) if (prompt.voteCount > max) max = prompt.voteCount;
  const top = prompts.filter((prompt) => prompt.voteCount === max);
  return chooseRandom(top, random)?.id ?? null;
}

// 每人每轮只能提交一条台词，唯一约束之外的快速判断。
export function authorHasPrompt(prompts, userId) {
  return (prompts || []).some((prompt) => Number(prompt.authorId) === Number(userId));
}

// 作答后的阶段：大冒险需他人确认，真心话直接结算。
export function answerResolution(choice) {
  return choice === 'dare' ? 'confirming' : 'resolved';
}

// ---------- 守卫与校验（失败抛中文 ApiError） ----------

export function requireCreator(game, userId, message = '只有发起人可以操作') {
  if (Number(game?.creator_id) !== Number(userId)) throw new ApiError(message, 403);
}

export function requireChosen(game, userId, message = '只有被选中的人可以进行此操作') {
  if (game?.chosen_user_id == null || Number(game.chosen_user_id) !== Number(userId)) {
    throw new ApiError(message, 403);
  }
}

export function requirePhase(game, phases, message = '当前阶段不能进行此操作') {
  if (!phases.includes(game?.phase)) throw new ApiError(message, 409);
}

export function validateScope(raw) {
  const scope = String(raw ?? '');
  if (!(TRUTH_DARE_SCOPES as readonly string[]).includes(scope)) throw new ApiError('游戏范围无效');
  return scope;
}

export function validateGameTitle(raw) {
  const title = String(raw ?? '').trim();
  if (title.length > 60) throw new ApiError('标题不能超过 60 字');
  return title;
}

export function validateChoice(raw) {
  const choice = String(raw ?? '');
  if (!(TRUTH_DARE_CHOICES as readonly string[]).includes(choice)) {
    throw new ApiError('必须选择真心话或大冒险');
  }
  return choice;
}

export function validatePromptContent(raw) {
  const content = String(raw ?? '').trim();
  if (!content) throw new ApiError('台词不能为空');
  if (content.length > TRUTH_DARE_PROMPT_MAX) throw new ApiError(`台词不能超过 ${TRUTH_DARE_PROMPT_MAX} 字`);
  return content;
}

export function validateAnswerText(raw) {
  const text = String(raw ?? '').trim();
  if (text.length > TRUTH_DARE_ANSWER_MAX) throw new ApiError(`作答不能超过 ${TRUTH_DARE_ANSWER_MAX} 字`);
  return text;
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
    title: row.title || '',
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
    title: row.title || '',
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
  (SELECT COUNT(*) FROM truth_dare_participants p WHERE p.game_id = g.id) AS participant_count,
  EXISTS (SELECT 1 FROM truth_dare_participants p WHERE p.game_id = g.id AND p.user_id = ?) AS is_participant,
  (g.creator_id = ?) AS is_creator`;

// 可见对局 = 公开 ∪ 我是参与者 ∪ 我是创建者（包含已结束）。
export async function listVisibleGames(db, userId) {
  const { results } = await db
    .prepare(
      `SELECT ${GAME_SUMMARY_SELECT}
       FROM truth_dare_games g
       LEFT JOIN users creator ON creator.id = g.creator_id
       LEFT JOIN channels c ON c.id = g.channel_id
       WHERE g.scope = 'public'
          OR EXISTS (SELECT 1 FROM truth_dare_participants p WHERE p.game_id = g.id AND p.user_id = ?)
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
       FROM truth_dare_games g
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
       FROM truth_dare_games g
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
    .prepare('SELECT 1 AS ok FROM truth_dare_participants WHERE game_id = ? AND user_id = ? LIMIT 1')
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
          c.name AS channel_name, a.title, a.invited_user_ids, a.note, a.created_at
       FROM truth_dare_applications a
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
      `SELECT a.id, a.scope, a.channel_id, c.name AS channel_name, a.title, a.note, a.status,
          a.review_reason, a.game_id, a.created_at, a.reviewed_at
       FROM truth_dare_applications a
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
       FROM truth_dare_applications a
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

// 建局：插入对局并一次性写入参与者（创建者标记 is_creator）。
export async function createGameWithParticipants(db, { creatorId, scope, channelId = null, title = '', participantUserIds = [] }) {
  const result = await db
    .prepare(
      `INSERT INTO truth_dare_games (creator_id, scope, channel_id, title, status, phase)
       VALUES (?, ?, ?, ?, 'playing', 'idle')`
    )
    .bind(Number(creatorId), scope, channelId == null ? null : Number(channelId), String(title || ''))
    .run();
  const gameId = Number(result.meta.last_row_id);
  const ids = [...new Set([Number(creatorId), ...participantUserIds.map(Number)])].filter((id) => Number.isInteger(id) && id > 0);
  await db.batch(
    ids.map((id) =>
      db
        .prepare('INSERT OR IGNORE INTO truth_dare_participants (game_id, user_id, is_creator) VALUES (?, ?, ?)')
        .bind(gameId, id, id === Number(creatorId) ? 1 : 0)
    )
  );
  return gameId;
}

export async function createApplication(db, { applicantId, scope, channelId = null, title = '', invitedUserIds = [], note = '' }) {
  const result = await db
    .prepare(
      `INSERT INTO truth_dare_applications (applicant_id, scope, channel_id, title, invited_user_ids, note, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`
    )
    .bind(Number(applicantId), scope, channelId == null ? null : Number(channelId), String(title || ''), JSON.stringify(invitedUserIds || []), String(note || ''))
    .run();
  return Number(result.meta.last_row_id);
}

export async function approveApplication(db, { applicationId, gameId, reviewerId, reason = '' }) {
  await db
    .prepare(
      `UPDATE truth_dare_applications
       SET status = 'approved', game_id = ?, reviewer_id = ?, review_reason = ?, reviewed_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(gameId, reviewerId, String(reason || ''), applicationId)
    .run();
}

export async function rejectApplication(db, { applicationId, reviewerId, reason = '' }) {
  await db
    .prepare(
      `UPDATE truth_dare_applications
       SET status = 'rejected', reviewer_id = ?, review_reason = ?, reviewed_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(reviewerId, String(reason || ''), applicationId)
    .run();
}

export async function cancelApplication(db, applicationId) {
  await db
    .prepare(`UPDATE truth_dare_applications SET status = 'cancelled', reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(applicationId)
    .run();
}

export async function joinGame(db, gameId, userId) {
  await db
    .prepare('INSERT OR IGNORE INTO truth_dare_participants (game_id, user_id, is_creator) VALUES (?, ?, 0)')
    .bind(gameId, userId)
    .run();
}

export async function leaveGame(db, gameId, userId) {
  await db
    .prepare('DELETE FROM truth_dare_participants WHERE game_id = ? AND user_id = ?')
    .bind(gameId, userId)
    .run();
}

// manual 范围的对局，受邀名单记录在审批通过后指向该局的申请里。
export async function isInvitedToGame(db, gameId, userId) {
  const row = await db
    .prepare(
      `SELECT 1 AS ok FROM truth_dare_applications
       WHERE game_id = ? AND status = 'approved'
         AND EXISTS (SELECT 1 FROM json_each(invited_user_ids) WHERE CAST(value AS INTEGER) = ?)
       LIMIT 1`
    )
    .bind(gameId, userId)
    .first();
  return Boolean(row);
}

export async function insertTruthDareAudit(db, { requestId, actorId, actorName, action, target, summary }) {
  await db
    .prepare(
      `INSERT INTO admin_audit_log (request_id, actor_id, actor_name, action, target, summary)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(requestId, actorId, actorName || '', action, String(target ?? ''), JSON.stringify(summary || {}))
    .run();
}
