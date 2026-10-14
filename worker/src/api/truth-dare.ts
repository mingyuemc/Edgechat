// 真心话大冒险：前台对局接口与后台设置/历史接口。
// 前台对局的状态读写一律转发给 TruthDareRoom，路由层只做可见性门禁与建局/申请。
import { forwardVerifiedRequest } from '../do-bridge.js';
import { getSiteSettings, updateTruthDareSettings } from '../data/site-settings.js';
import { readAuthorization } from '../rbac/authorization.ts';
import { hasPermission } from '../../../shared/admin-permissions.ts';
import { getChannelById, getChannelMembership } from '../room-access.js';
import { ApiError } from '../errors.js';
import { errorResponse, parseJsonRequest, publicFileUrl } from '../utils.js';
import { TRUTH_DARE_CREATE_PERMISSION } from '../../../shared/truth-dare.ts';
import {
  approveApplication,
  cancelApplication,
  createApplication,
  createGameWithParticipants,
  getApplication,
  getGameSummary,
  insertTruthDareAudit,
  isInvitedToGame,
  joinGame as insertGameParticipant,
  leaveGame as removeGameParticipant,
  listChannelMemberIds,
  listMyApplications,
  listPendingApplications,
  listVisibleGames,
  loadGameForUser,
  mapApplication,
  parseIdList,
  rejectApplication,
  validUserIds,
  validateGameTitle,
  validateScope
} from '../data/truth-dare.ts';

function gameStub(c, gameId) {
  return c.env.TRUTH_DARE_ROOM.get(c.env.TRUTH_DARE_ROOM.idFromName(`truth-dare:${gameId}`));
}

// 提交申请时用于建局/审批的初始参与者范围。
async function resolveParticipantIds(db, { scope, channelId, invitedUserIds }) {
  if (scope === 'channel' && channelId != null) return listChannelMemberIds(db, channelId);
  if (scope === 'manual') return invitedUserIds;
  return [];
}

export function registerTruthDareRoutes(app) {
  app.get('/api/truth-dare/overview', async (c) => {
    const session = c.get('session');
    const db = c.env.DB;
    const site = await getSiteSettings(db);
    const auth = await readAuthorization(db, session.userId);
    const canCreate = hasPermission(auth, TRUTH_DARE_CREATE_PERMISSION);
    const games = await listVisibleGames(db, session.userId);
    const pendingApplications = canCreate ? await listPendingApplications(db) : [];
    const myApplications = await listMyApplications(db, session.userId);
    return c.json({
      allowMemberCreate: site.allowMemberCreateGame,
      canCreate,
      canApprove: canCreate,
      games,
      pendingApplications,
      myApplications
    });
  });

  app.post('/api/truth-dare/games', async (c) => {
    const session = c.get('session');
    const db = c.env.DB;
    const payload = await parseJsonRequest(c.req.raw);
    const scope = validateScope(payload.scope);
    const title = validateGameTitle(payload.title);

    let channelId = null;
    let participantUserIds = [];
    if (scope === 'channel') {
      channelId = Number(payload.channelId);
      if (!Number.isInteger(channelId) || channelId <= 0) throw new ApiError('请选择群组');
      const channel = await getChannelById(db, channelId);
      if (!channel || !['public', 'private'].includes(channel.kind)) throw new ApiError('群组不存在', 404);
      const membership = await getChannelMembership(db, channelId, session.userId);
      if (!membership) throw new ApiError('你不是该群组成员', 403);
      participantUserIds = await listChannelMemberIds(db, channelId);
    } else if (scope === 'manual') {
      const raw = Array.isArray(payload.invitedUserIds) ? payload.invitedUserIds : [];
      const invited = await validUserIds(db, raw);
      if (!invited.length) {
        // 区分“没填名单”与“名单里的用户名都无效”，给出准确提示。
        throw new ApiError(raw.some((value) => String(value).trim()) ? '邀请的用户不存在或不可用，请检查用户名' : '请至少邀请一位玩家');
      }
      participantUserIds = invited;
    }

    const site = await getSiteSettings(db);
    const auth = await readAuthorization(db, session.userId);
    const canCreate = hasPermission(auth, TRUTH_DARE_CREATE_PERMISSION);

    if (site.allowMemberCreateGame || canCreate) {
      const gameId = await createGameWithParticipants(db, {
        creatorId: session.userId,
        scope,
        channelId,
        title,
        participantUserIds
      });
      return c.json({ created: await getGameSummary(db, gameId, session.userId), application: null, needApproval: false });
    }

    const applicationId = await createApplication(db, {
      applicantId: session.userId,
      scope,
      channelId,
      // 只有 manual 需要留存受邀名单；channel 范围审批时按当时的群成员重新解析。
      invitedUserIds: scope === 'manual' ? participantUserIds : [],
      note: String(payload.note || '').trim()
    });
    const application = mapApplication(await getApplication(db, applicationId));
    return c.json({ created: null, application, needApproval: true });
  });

  app.post('/api/truth-dare/applications/:id/review', async (c) => {
    const session = c.get('session');
    const db = c.env.DB;
    const applicationId = Number(c.req.param('id'));
    if (!Number.isInteger(applicationId) || applicationId <= 0) throw new ApiError('申请不存在', 404);

    const auth = await readAuthorization(db, session.userId);
    if (!hasPermission(auth, TRUTH_DARE_CREATE_PERMISSION)) throw new ApiError('没有审批权限', 403);

    const payload = await parseJsonRequest(c.req.raw);
    const approve = Boolean(payload.approve);
    const reason = String(payload.reason || '').trim();
    const application = await getApplication(db, applicationId);
    if (!application) throw new ApiError('申请不存在', 404);
    if (application.status !== 'pending') throw new ApiError('该申请已处理', 409);

    const summary = { scope: application.scope, channelId: application.channel_id, note: application.note };
    if (!approve) {
      await rejectApplication(db, { applicationId, reviewerId: session.userId, reason });
      await insertTruthDareAudit(db, {
        requestId: crypto.randomUUID(),
        actorId: session.userId,
        actorName: session.username,
        action: 'truth_dare.application.reject',
        target: String(applicationId),
        summary
      });
      return c.json({ ok: true });
    }

    const invitedUserIds = parseIdList(application.invited_user_ids);
    const participantUserIds = await resolveParticipantIds(db, {
      scope: application.scope,
      channelId: application.channel_id,
      invitedUserIds
    });
    const gameId = await createGameWithParticipants(db, {
      creatorId: application.applicant_id,
      scope: application.scope,
      channelId: application.channel_id,
      title: '',
      participantUserIds
    });
    await approveApplication(db, { applicationId, gameId, reviewerId: session.userId, reason });
    await insertTruthDareAudit(db, {
      requestId: crypto.randomUUID(),
      actorId: session.userId,
      actorName: session.username,
      action: 'truth_dare.application.approve',
      target: String(applicationId),
      summary
    });
    return c.json({ ok: true, game: await getGameSummary(db, gameId, session.userId) });
  });

  app.post('/api/truth-dare/applications/:id/cancel', async (c) => {
    const session = c.get('session');
    const db = c.env.DB;
    const applicationId = Number(c.req.param('id'));
    if (!Number.isInteger(applicationId) || applicationId <= 0) throw new ApiError('申请不存在', 404);
    const application = await getApplication(db, applicationId);
    if (!application) throw new ApiError('申请不存在', 404);
    if (Number(application.applicant_id) !== Number(session.userId)) throw new ApiError('只能取消自己的申请', 403);
    if (application.status !== 'pending') throw new ApiError('只能取消待审批的申请', 409);
    await cancelApplication(db, applicationId);
    return c.json({ ok: true });
  });

  app.post('/api/truth-dare/games/:id/join', async (c) => {
    const session = c.get('session');
    const db = c.env.DB;
    const gameId = Number(c.req.param('id'));
    if (!Number.isInteger(gameId) || gameId <= 0) throw new ApiError('对局不存在', 404);
    const access = await loadGameForUser(db, gameId, session.userId);
    if (!access) throw new ApiError('对局不存在', 404);
    if (access.isParticipant) return c.json({ ok: true });

    const { game } = access;
    let allowed = false;
    if (game.scope === 'public') {
      allowed = true;
    } else if (game.scope === 'channel') {
      const membership = await getChannelMembership(db, game.channel_id, session.userId);
      allowed = Boolean(membership);
    } else if (game.scope === 'manual') {
      allowed = await isInvitedToGame(db, gameId, session.userId);
    }
    if (!allowed) throw new ApiError('你不在该对局的受邀范围内', 403);

    await insertGameParticipant(db, gameId, session.userId);
    return c.json({ ok: true });
  });

  app.post('/api/truth-dare/games/:id/leave', async (c) => {
    const session = c.get('session');
    const db = c.env.DB;
    const gameId = Number(c.req.param('id'));
    if (!Number.isInteger(gameId) || gameId <= 0) throw new ApiError('对局不存在', 404);
    const access = await loadGameForUser(db, gameId, session.userId);
    if (!access) throw new ApiError('对局不存在', 404);
    if (access.isCreator) throw new ApiError('创建者不能退出，请结束游戏', 409);
    await removeGameParticipant(db, gameId, session.userId);
    return c.json({ ok: true });
  });

  app.get('/api/truth-dare/games/:id/state', async (c) => {
    const gameId = await requireVisibleGame(c);
    return forwardVerifiedRequest({
      stub: gameStub(c, gameId),
      request: c.req.raw,
      pathname: '/state',
      searchParams: { gameId },
      principal: c.get('session')
    });
  });

  app.post('/api/truth-dare/games/:id/action', async (c) => {
    const gameId = await requireVisibleGame(c);
    return forwardVerifiedRequest({
      stub: gameStub(c, gameId),
      request: c.req.raw,
      pathname: '/action',
      searchParams: { gameId },
      principal: c.get('session')
    });
  });
}

// 转发前先确认调用者能看到该对局，避免把无权请求打到 DO。
async function requireVisibleGame(c) {
  const gameId = Number(c.req.param('id'));
  if (!Number.isInteger(gameId) || gameId <= 0) throw new ApiError('对局不存在', 404);
  const access = await loadGameForUser(c.env.DB, gameId, c.get('session').userId);
  if (!access) throw new ApiError('对局不存在', 404);
  if (!access.visible) throw new ApiError('无权查看该对局', 403);
  return gameId;
}

export function registerTruthDareAdminRoutes(app) {
  app.get('/api/admin/truth-dare/settings', async (c) => {
    const site = await getSiteSettings(c.env.DB);
    return c.json({ allowMemberCreate: site.allowMemberCreateGame });
  });

  app.put('/api/admin/truth-dare/settings', async (c) => {
    const payload = await parseJsonRequest(c.req.raw);
    if (typeof payload.allowMemberCreate !== 'boolean') throw new ApiError('参数无效');
    const allowMemberCreate = await updateTruthDareSettings(c.env.DB, { allowMemberCreate: payload.allowMemberCreate });
    return c.json({ allowMemberCreate });
  });

  app.get('/api/admin/truth-dare/history', async (c) => {
    const offset = Number(c.req.query('offset') || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) return errorResponse('分页参数无效');
    const db = c.env.DB;
    const totalRow = await db.prepare('SELECT COUNT(*) AS total FROM truth_dare_rounds').first();
    const { results: gameRows } = await db
      .prepare(
        `SELECT g.id, g.title, g.scope, g.status, g.created_at, g.ended_at,
            creator.display_name AS creator_name,
            (SELECT COUNT(*) FROM truth_dare_rounds r WHERE r.game_id = g.id) AS round_count
         FROM truth_dare_games g
         LEFT JOIN users creator ON creator.id = g.creator_id
         ORDER BY g.id DESC
         LIMIT 50`
      )
      .all();
    const games = gameRows.map((row) => ({
      id: Number(row.id),
      title: row.title || '',
      scope: row.scope,
      status: row.status,
      creatorName: row.creator_name || '',
      roundCount: Number(row.round_count || 0),
      createdAt: row.created_at,
      endedAt: row.ended_at || null
    }));

    const { results: roundRows } = await db
      .prepare(
        `SELECT r.id, r.game_id, g.title AS game_title, r.round_no, r.choice, r.choice_auto,
            r.answer_text, r.answer_voice_key, r.created_at, r.resolved_at,
            chosen.display_name AS chosen_name,
            win.content AS prompt_content,
            conf.display_name AS confirmed_by_name
         FROM truth_dare_rounds r
         JOIN truth_dare_games g ON g.id = r.game_id
         LEFT JOIN users chosen ON chosen.id = r.chosen_user_id
         LEFT JOIN truth_dare_prompts win ON win.id = r.winning_prompt_id
         LEFT JOIN users conf ON conf.id = r.confirmed_by
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT 50 OFFSET ?`
      )
      .bind(offset)
      .all();
    const rounds = roundRows.map((row) => ({
      id: Number(row.id),
      gameId: Number(row.game_id),
      gameTitle: row.game_title || '',
      roundNo: Number(row.round_no),
      chosenName: row.chosen_name || '',
      choice: row.choice || null,
      choiceAuto: Boolean(Number(row.choice_auto)),
      promptContent: row.prompt_content || '',
      answerText: row.answer_text || '',
      answerVoiceUrl: row.answer_voice_key ? publicFileUrl(row.answer_voice_key) : '',
      confirmedByName: row.confirmed_by_name || '',
      createdAt: row.created_at,
      resolvedAt: row.resolved_at || null
    }));

    return c.json({ total: Number(totalRow?.total || 0), games, rounds });
  });

  app.get('/api/admin/truth-dare/history/export', async (c) => {
    const db = c.env.DB;
    const { results: games } = await db.prepare('SELECT * FROM truth_dare_games ORDER BY id ASC').all();
    const { results: rawRounds } = await db.prepare('SELECT * FROM truth_dare_rounds ORDER BY id ASC').all();
    const { results: prompts } = await db.prepare('SELECT * FROM truth_dare_prompts ORDER BY id ASC').all();
    const { results: votes } = await db.prepare('SELECT * FROM truth_dare_votes ORDER BY game_id, round_no, voter_id').all();

    // 语音作答只导出 /files 可访问地址，绝不暴露内部 R2 key。
    const rounds = rawRounds.map((round) => {
      const { answer_voice_key, ...rest } = round;
      const url = answer_voice_key ? publicFileUrl(answer_voice_key) : '';
      return {
        ...rest,
        answerVoiceUrl: url,
        answerVoiceDownloadUrl: url
      };
    });

    const body = JSON.stringify({ exportedAt: new Date().toISOString(), games, rounds, prompts, votes });
    return new Response(body, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="truth-dare-history.json"'
      }
    });
  });
}
