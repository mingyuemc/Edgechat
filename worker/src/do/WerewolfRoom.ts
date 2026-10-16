// 狼人杀对局的唯一写者：所有回合状态变更都在此串行执行并落 D1，
// 通过 gameId 命名的 DO 实例天然把同一局的操作串成一条队列，避免并发交错。
import { parseVerifiedUserId } from '../verified-identity.js';
import { durableObjectHealth } from '../maintenance/do-health.ts';
import { getSiteSettings } from '../data/site-settings.js';
import { errorResponse, publicFileUrl } from '../utils.js';
import { ApiError } from '../errors.js';
import {
  assignRoles,
  checkWinner,
  insertWerewolfAudit,
  loadGame,
  parseRoleConfig,
  requireCreator,
  requirePhase,
  resolveExile,
  resolveNightDeaths,
  resolvePlurality,
  timeoutTransition
} from '../data/werewolf.ts';
import {
  WEREWOLF_DAY_MS,
  WEREWOLF_NIGHT_MS,
  WEREWOLF_ONLINE_MS,
  WEREWOLF_VOTE_MS
} from '../../../shared/werewolf.ts';

// 在线窗口直接交给 SQL 判断，避免在 JS 里解析无时区标记的 CURRENT_TIMESTAMP。
const ONLINE_SINCE = `datetime('now', '-${Math.round(WEREWOLF_ONLINE_MS / 1000)} seconds')`;
// 拼装某张表别名下“最近活跃”的布尔条件。
const onlineCondition = (alias) => `${alias}.last_seen_at >= ${ONLINE_SINCE}`;

export class WerewolfRoom {
  state;
  env;
  queue = Promise.resolve();

  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  // 串行化整段动作，避免同一局的两个请求在读改写 D1 时交错。
  serial(task) {
    const next = this.queue.then(task);
    this.queue = next.catch(() => {});
    return next;
  }

  db() {
    return this.env.DB;
  }

  // crypto 在 Workers 可用；取 32 位无符号整数归一化到 [0,1)。
  random() {
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    return buffer[0] / 4294967296;
  }

  async fetch(request) {
    const health = durableObjectHealth(request, 'WerewolfRoom');
    if (health) return health;
    return this.serial(async () => {
      try {
        const userId = parseVerifiedUserId(request);
        if (!userId) return errorResponse('未登录', 401);
        const url = new URL(request.url);
        const gameId = Number(url.searchParams.get('gameId'));
        if (!Number.isInteger(gameId) || gameId <= 0) return errorResponse('对局不存在', 404);
        const game = await loadGame(this.db(), gameId);
        if (!game) return errorResponse('对局不存在', 404);
        // alarm 无法自带参数，把实例对应的 gameId 固化到存储里。
        await this.state.storage.put('gameId', gameId);

        if (url.pathname === '/state') {
          await this.touchParticipant(gameId, userId);
          await this.applyDeadlines(gameId, Date.now());
          return Response.json(await this.buildState(gameId, userId));
        }
        if (url.pathname === '/action') {
          let payload: Record<string, unknown>;
          try {
            payload = await request.json();
          } catch {
            return errorResponse('无效的游戏请求', 400);
          }
          if (!payload || typeof payload !== 'object') return errorResponse('无效的游戏请求', 400);
          await this.applyDeadlines(gameId, Date.now());
          await this.handleAction(gameId, userId, payload);
          await this.syncAlarm(gameId);
          return Response.json(await this.buildState(gameId, userId));
        }
        return errorResponse('接口不存在', 404);
      } catch (error) {
        if (error instanceof ApiError) return errorResponse(error.message, error.status);
        console.error('werewolf_action_failed');
        return errorResponse('游戏暂时不可用', 503);
      }
    });
  }

  async alarm() {
    await this.serial(async () => {
      const stored = await this.state.storage.get('gameId');
      const gameId = Number(stored);
      if (!Number.isInteger(gameId) || gameId <= 0) return;
      await this.applyDeadlines(gameId, Date.now());
      await this.syncAlarm(gameId);
    });
  }

  // ---------- 时限推进 ----------

  async touchParticipant(gameId, userId) {
    await this.db()
      .prepare('UPDATE werewolf_participants SET last_seen_at = CURRENT_TIMESTAMP WHERE game_id = ? AND user_id = ?')
      .bind(gameId, userId)
      .run();
  }

  // 幂等：按当前阶段与 phase_deadline_ms 推算是否越过兜底时限，可能连续跨阶段。
  async applyDeadlines(gameId, now) {
    const db = this.db();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const game = await loadGame(db, gameId);
      if (!game || game.status !== 'playing') return;
      const deadline = game.phase_deadline_ms == null ? null : Number(game.phase_deadline_ms);
      if (deadline == null || now < deadline) return;
      const transition = timeoutTransition(game.phase, now, {});
      if (!transition) {
        // 未知阶段：清掉时限，避免 alarm 空转。
        await db
          .prepare('UPDATE werewolf_games SET phase_deadline_ms = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .bind(gameId)
          .run();
        return;
      }
      await this.applyTimeout(game, transition);
    }
  }

  async applyTimeout(game, transition) {
    const db = this.db();
    if (transition.kind === 'resolve_night') return this.resolveNight(game);
    if (transition.kind === 'to_vote') {
      await db
        .prepare(`UPDATE werewolf_games SET phase = 'vote', phase_deadline_ms = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(transition.deadlineMs, game.id)
        .run();
      return;
    }
    if (transition.kind === 'resolve_vote') return this.resolveVote(game);
  }

  async syncAlarm(gameId) {
    const game = await loadGame(this.db(), gameId);
    const deadline = !game || game.status !== 'playing' || game.phase_deadline_ms == null
      ? null
      : Number(game.phase_deadline_ms);
    if (deadline == null) {
      await this.state.storage.deleteAlarm();
      return;
    }
    await this.state.storage.setAlarm(deadline);
  }

  // ---------- 动作分发 ----------

  async handleAction(gameId, userId, payload) {
    const game = await loadGame(this.db(), gameId);
    if (!game) throw new ApiError('对局不存在', 404);
    const action = String(payload.action || '');
    // 已结束的对局只允许再次调用 endGame（幂等），其余动作一律拒绝。
    if (action !== 'endGame' && game.status !== 'playing') throw new ApiError('游戏已结束', 409);
    switch (action) {
      case 'start': return this.start(game, userId, payload);
      case 'wolfKill': return this.wolfKill(game, userId, payload);
      case 'seerCheck': return this.seerCheck(game, userId, payload);
      case 'witchAct': return this.witchAct(game, userId, payload);
      case 'endDiscussion': return this.endDiscussion(game, userId);
      case 'vote': return this.vote(game, userId, payload);
      case 'endGame': return this.endGame(game, userId);
      default: throw new ApiError('未知的游戏操作', 400);
    }
  }

  // 开局：按 roleConfig/assignMode/roleAssignment 分角色，进入夜晚第一轮。
  async start(game, userId, payload) {
    requireCreator(game, userId, '只有发起人可以开始游戏');
    requirePhase(game, ['lobby'], '当前阶段不能开始游戏');
    const participants = await this.loadParticipants(game.id);
    const mode = String(game.assign_mode);
    const statements = [];
    if (mode === 'manual' && !payload.roleAssignment && participants.every((participant) => participant.role)) {
      // 已在建局时完成手动分配，沿用参与者身上的角色。
    } else {
      const roles = assignRoles(
        participants.map((participant) => participant.userId),
        game.role_config,
        mode,
        payload.roleAssignment,
        () => this.random()
      );
      for (const participant of participants) {
        statements.push(
          this.db()
            .prepare('UPDATE werewolf_participants SET role = ? WHERE game_id = ? AND user_id = ?')
            .bind(roles[participant.userId], game.id, participant.userId)
        );
      }
    }
    statements.push(this.db().prepare('INSERT INTO werewolf_rounds (game_id, round_no) VALUES (?, 1)').bind(game.id));
    statements.push(
      this.db()
        .prepare(`UPDATE werewolf_games SET phase = 'night', round_no = 1, phase_deadline_ms = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(Date.now() + WEREWOLF_NIGHT_MS, game.id)
    );
    await this.db().batch(statements);
  }

  async wolfKill(game, userId, payload) {
    requirePhase(game, ['night'], '当前阶段不能击杀');
    await this.requireAlive(game.id, userId, '只有存活玩家可以行动');
    await this.requireRole(game.id, userId, 'wolf', '只有狼人可以选择击杀');
    const targetUserId = Number(payload.targetUserId);
    await this.requireAlive(game.id, targetUserId, '只能击杀存活玩家');
    await this.insertNightAction(game, userId, 'wolf_kill', targetUserId);
    await this.maybeResolveNight(game);
  }

  async seerCheck(game, userId, payload) {
    requirePhase(game, ['night'], '当前阶段不能查验');
    await this.requireAlive(game.id, userId, '只有存活玩家可以行动');
    await this.requireRole(game.id, userId, 'seer', '只有预言家可以查验');
    const targetUserId = Number(payload.targetUserId);
    await this.requireParticipant(game.id, targetUserId, '只能查验本局玩家');
    await this.insertNightAction(game, userId, 'seer_check', targetUserId);
    await this.maybeResolveNight(game);
  }

  // 女巫：每晚最多用一瓶药水；解药与毒药各只能使用一次。
  async witchAct(game, userId, payload) {
    requirePhase(game, ['night'], '当前阶段不能使用药水');
    await this.requireAlive(game.id, userId, '只有存活玩家可以行动');
    await this.requireRole(game.id, userId, 'witch', '只有女巫可以使用药水');
    const mode = String(payload.mode || '');
    const participant = await this.loadParticipant(game.id, userId);
    if (await this.getNightAction(game.id, game.round_no, userId)) throw new ApiError('每晚最多使用一瓶药水', 409);
    let action = null;
    let targetUserId = null;
    if (mode === 'save') {
      if (Number(participant?.antidote_used)) throw new ApiError('解药已经用过了', 409);
      action = 'witch_save';
    } else if (mode === 'poison') {
      if (Number(participant?.poison_used)) throw new ApiError('毒药已经用过了', 409);
      action = 'witch_poison';
      targetUserId = Number(payload.targetUserId);
      await this.requireAlive(game.id, targetUserId, '只能毒杀存活玩家');
    } else if (mode === 'skip') {
      action = 'witch_skip';
    } else {
      throw new ApiError('药水选择无效');
    }
    await this.insertNightAction(game, userId, action, targetUserId);
    await this.maybeResolveNight(game);
  }

  async endDiscussion(game, userId) {
    requireCreator(game, userId, '只有发起人可以结束讨论');
    requirePhase(game, ['day'], '当前阶段不能结束讨论');
    await this.db()
      .prepare(`UPDATE werewolf_games SET phase = 'vote', phase_deadline_ms = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(Date.now() + WEREWOLF_VOTE_MS, game.id)
      .run();
  }

  async vote(game, userId, payload) {
    requirePhase(game, ['vote'], '当前阶段不能投票');
    await this.requireAlive(game.id, userId, '只有存活玩家可以投票');
    const targetUserId = payload.targetUserId == null ? null : Number(payload.targetUserId);
    if (targetUserId != null) await this.requireAlive(game.id, targetUserId, '只能投票给存活玩家');
    await this.db()
      .prepare('INSERT OR REPLACE INTO werewolf_votes (game_id, round_no, voter_id, target_user_id) VALUES (?, ?, ?, ?)')
      .bind(game.id, game.round_no, userId, targetUserId)
      .run();
    await this.maybeResolveVote(game);
  }

  async endGame(game, userId) {
    requireCreator(game, userId, '只有发起人可以结束游戏');
    if (game.status === 'ended') return;
    const counts = await this.countAliveByRole(game.id);
    const winner = checkWinner(counts.wolf, counts.seer + counts.witch + counts.villager);
    const row = await this.db().prepare('SELECT display_name FROM users WHERE id = ?').bind(userId).first();
    await this.db()
      .prepare(
        `UPDATE werewolf_games
         SET status = 'ended', ended_at = CURRENT_TIMESTAMP, phase = 'ended', phase_deadline_ms = NULL,
             winner = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .bind(winner, game.id)
      .run();
    await insertWerewolfAudit(this.db(), {
      requestId: crypto.randomUUID(),
      actorId: userId,
      actorName: row?.display_name || '',
      action: 'werewolf.game.end',
      target: String(game.id),
      summary: { scope: game.scope, channelId: game.channel_id == null ? null : Number(game.channel_id), title: game.title || '' }
    });
  }

  // ---------- 阶段结算 ----------

  // 夜晚结算：多数票击杀（平票随机）→ 女巫解药/毒药 → 死亡名单 → 判定胜负，否则进入白天。
  async resolveNight(game) {
    const db = this.db();
    const roundNo = Number(game.round_no);
    const { results } = await db
      .prepare('SELECT action, target_user_id FROM werewolf_night_actions WHERE game_id = ? AND round_no = ?')
      .bind(game.id, roundNo)
      .all();
    const tally = {};
    for (const row of results) {
      if (row.action !== 'wolf_kill' || row.target_user_id == null) continue;
      const id = Number(row.target_user_id);
      tally[id] = (tally[id] || 0) + 1;
    }
    const wolfTarget = resolvePlurality(
      Object.entries(tally).map(([id, count]) => ({ id: Number(id), count })),
      () => this.random()
    );
    const saved = results.some((row) => row.action === 'witch_save');
    const poisonRow = results.find((row) => row.action === 'witch_poison' && row.target_user_id != null);
    const poisonTarget = poisonRow ? Number(poisonRow.target_user_id) : null;
    const deaths = resolveNightDeaths({ wolfTarget, saved, poisonTarget });
    const statements = [
      db
        .prepare(
          `UPDATE werewolf_rounds
           SET wolf_target_user_id = ?, saved = ?, poisoned_user_id = ?, deaths = ?, resolved_at = CURRENT_TIMESTAMP
           WHERE game_id = ? AND round_no = ?`
        )
        .bind(wolfTarget, saved ? 1 : 0, poisonTarget, JSON.stringify(deaths), game.id, roundNo)
    ];
    for (const death of deaths) {
      statements.push(
        db
          .prepare('UPDATE werewolf_participants SET alive = 0, death_round = ?, death_cause = ? WHERE game_id = ? AND user_id = ?')
          .bind(roundNo, death.cause, game.id, death.userId)
      );
    }
    if (saved) {
      statements.push(db.prepare(`UPDATE werewolf_participants SET antidote_used = 1 WHERE game_id = ? AND role = 'witch'`).bind(game.id));
    }
    if (poisonTarget != null) {
      statements.push(db.prepare(`UPDATE werewolf_participants SET poison_used = 1 WHERE game_id = ? AND role = 'witch'`).bind(game.id));
    }
    await db.batch(statements);
    // 结算后判定胜负；未分胜负则进入白天讨论。
    const counts = await this.countAliveByRole(game.id);
    const winner = checkWinner(counts.wolf, counts.seer + counts.witch + counts.villager);
    if (winner) {
      await this.endRound(game, winner);
      return;
    }
    await db
      .prepare(`UPDATE werewolf_games SET phase = 'day', phase_deadline_ms = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(Date.now() + WEREWOLF_DAY_MS, game.id)
      .run();
  }

  async resolveVote(game) {
    const db = this.db();
    const roundNo = Number(game.round_no);
    const { results } = await db
      .prepare('SELECT target_user_id FROM werewolf_votes WHERE game_id = ? AND round_no = ? AND target_user_id IS NOT NULL')
      .bind(game.id, roundNo)
      .all();
    const tally = {};
    for (const row of results) {
      const id = Number(row.target_user_id);
      tally[id] = (tally[id] || 0) + 1;
    }
    const exiled = resolveExile(
      Object.entries(tally).map(([id, count]) => ({ id: Number(id), count })),
      () => this.random()
    );
    const statements = [
      db
        .prepare('UPDATE werewolf_rounds SET exiled_user_id = ?, resolved_at = CURRENT_TIMESTAMP WHERE game_id = ? AND round_no = ?')
        .bind(exiled, game.id, roundNo)
    ];
    if (exiled != null) {
      statements.push(
        db
          .prepare(`UPDATE werewolf_participants SET alive = 0, death_round = ?, death_cause = 'vote' WHERE game_id = ? AND user_id = ?`)
          .bind(roundNo, game.id, exiled)
      );
    }
    await db.batch(statements);
    // 放逐后再次判定胜负；未分胜负则进入下一轮夜晚。
    const counts = await this.countAliveByRole(game.id);
    const winner = checkWinner(counts.wolf, counts.seer + counts.witch + counts.villager);
    if (winner) {
      await this.endRound(game, winner);
      return;
    }
    const nextRound = roundNo + 1;
    await db.batch([
      db.prepare('INSERT INTO werewolf_rounds (game_id, round_no) VALUES (?, ?)').bind(game.id, nextRound),
      db
        .prepare(`UPDATE werewolf_games SET phase = 'night', round_no = ?, phase_deadline_ms = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(nextRound, Date.now() + WEREWOLF_NIGHT_MS, game.id)
    ]);
  }

  // 判定出胜负后结束对局并记录胜方。
  async endRound(game, winner) {
    await this.db()
      .prepare(
        `UPDATE werewolf_games
         SET status = 'ended', phase = 'ended', phase_deadline_ms = NULL, winner = ?,
             ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .bind(winner, game.id)
      .run();
  }

  // 夜晚所有必行动者（存活狼人、预言家、女巫）都行动后自动结算。
  async maybeResolveNight(game) {
    const required = await this.countNightActors(game.id);
    const acted = await this.countNightActions(game.id, game.round_no);
    if (acted < required) return;
    await this.resolveNight(game);
  }

  // 投票阶段所有存活玩家都投票后自动结算放逐。
  async maybeResolveVote(game) {
    const required = await this.countAlive(game.id);
    const voted = await this.countVotes(game.id, game.round_no);
    if (voted < required) return;
    await this.resolveVote(game);
  }

  // ---------- 计数与读取 ----------

  async countAliveByRole(gameId) {
    const { results } = await this.db()
      .prepare('SELECT role, COUNT(*) AS total FROM werewolf_participants WHERE game_id = ? AND alive = 1 GROUP BY role')
      .bind(gameId)
      .all();
    const counts = { wolf: 0, seer: 0, witch: 0, villager: 0 };
    for (const row of results) if (row.role in counts) counts[row.role] = Number(row.total || 0);
    return counts;
  }

  async countNightActors(gameId) {
    const counts = await this.countAliveByRole(gameId);
    return counts.wolf + counts.seer + counts.witch;
  }

  async countAlive(gameId) {
    const row = await this.db()
      .prepare('SELECT COUNT(*) AS total FROM werewolf_participants WHERE game_id = ? AND alive = 1')
      .bind(gameId)
      .first();
    return Number(row?.total || 0);
  }

  async countNightActions(gameId, roundNo) {
    const row = await this.db()
      .prepare('SELECT COUNT(*) AS total FROM werewolf_night_actions WHERE game_id = ? AND round_no = ?')
      .bind(gameId, roundNo)
      .first();
    return Number(row?.total || 0);
  }

  async countVotes(gameId, roundNo) {
    const row = await this.db()
      .prepare('SELECT COUNT(*) AS total FROM werewolf_votes WHERE game_id = ? AND round_no = ?')
      .bind(gameId, roundNo)
      .first();
    return Number(row?.total || 0);
  }

  async getNightAction(gameId, roundNo, actorId) {
    return this.db()
      .prepare('SELECT action, target_user_id FROM werewolf_night_actions WHERE game_id = ? AND round_no = ? AND actor_id = ? LIMIT 1')
      .bind(gameId, roundNo, actorId)
      .first();
  }

  async insertNightAction(game, userId, action, targetUserId) {
    await this.db()
      .prepare('INSERT OR REPLACE INTO werewolf_night_actions (game_id, round_no, actor_id, action, target_user_id) VALUES (?, ?, ?, ?, ?)')
      .bind(game.id, game.round_no, userId, action, targetUserId == null ? null : Number(targetUserId))
      .run();
  }

  async requireParticipant(gameId, userId, message) {
    const row = await this.db()
      .prepare('SELECT 1 AS ok FROM werewolf_participants WHERE game_id = ? AND user_id = ? LIMIT 1')
      .bind(gameId, Number(userId))
      .first();
    if (!row) throw new ApiError(message, 403);
  }

  async requireAlive(gameId, userId, message) {
    const row = await this.db()
      .prepare('SELECT 1 AS ok FROM werewolf_participants WHERE game_id = ? AND user_id = ? AND alive = 1 LIMIT 1')
      .bind(gameId, Number(userId))
      .first();
    if (!row) throw new ApiError(message, 403);
  }

  async requireRole(gameId, userId, role, message) {
    const row = await this.db()
      .prepare('SELECT 1 AS ok FROM werewolf_participants WHERE game_id = ? AND user_id = ? AND role = ? LIMIT 1')
      .bind(gameId, Number(userId), role)
      .first();
    if (!row) throw new ApiError(message, 403);
  }

  async loadParticipant(gameId, userId) {
    return this.db()
      .prepare('SELECT * FROM werewolf_participants WHERE game_id = ? AND user_id = ? LIMIT 1')
      .bind(gameId, Number(userId))
      .first();
  }

  async loadParticipants(gameId) {
    const { results } = await this.db()
      .prepare(
        `SELECT p.user_id, p.is_creator, p.role, p.alive, p.death_round, p.death_cause, p.antidote_used, p.poison_used,
            u.display_name, u.avatar_key,
            CASE WHEN ${onlineCondition('p')} THEN 1 ELSE 0 END AS online
         FROM werewolf_participants p
         JOIN users u ON u.id = p.user_id
         WHERE p.game_id = ?
         ORDER BY p.is_creator DESC, p.joined_at ASC`
      )
      .bind(gameId)
      .all();
    return results.map((row) => ({
      userId: Number(row.user_id),
      displayName: row.display_name || '',
      avatarKey: row.avatar_key || '',
      isCreator: Boolean(Number(row.is_creator)),
      online: Boolean(Number(row.online)),
      role: row.role || null,
      alive: Boolean(Number(row.alive)),
      deathRound: row.death_round == null ? null : Number(row.death_round),
      deathCause: row.death_cause || null,
      antidoteUsed: Boolean(Number(row.antidote_used)),
      poisonUsed: Boolean(Number(row.poison_used))
    }));
  }

  async buildState(gameId, userId) {
    const db = this.db();
    const game = await loadGame(db, gameId);
    const participants = await this.loadParticipants(gameId);
    const me = participants.find((participant) => participant.userId === Number(userId)) || null;
    const site = await getSiteSettings(db);
    const meRole = me?.role || null;
    const ended = game.status === 'ended' || game.phase === 'ended';
    // 真实身份只在“是我 / 已死亡 / 已结束 / 我是狼人且对方也是狼人”时公开。
    const roleRevealed = (participant) =>
      participant.role != null &&
      (participant.userId === Number(userId) || !participant.alive || ended || (meRole === 'wolf' && participant.role === 'wolf'));
    const history = await this.buildHistory(game, participants);
    return {
      game: {
        id: Number(game.id),
        title: game.title || '',
        scope: game.scope,
        status: game.status,
        phase: game.phase,
        roundNo: Number(game.round_no || 0),
        creatorId: Number(game.creator_id),
        creatorName: game.creator_name || '',
        channelId: game.channel_id == null ? null : Number(game.channel_id),
        channelName: game.channel_name || '',
        winner: game.winner || null
      },
      me: {
        userId: Number(userId),
        isCreator: Number(game.creator_id) === Number(userId),
        isParticipant: Boolean(me),
        isAlive: Boolean(me?.alive),
        isOnline: Boolean(me?.online),
        role: me?.role || null,
        hasActed: await this.hasActed(game, userId)
      },
      phaseDeadlineMs: game.phase_deadline_ms == null ? null : Number(game.phase_deadline_ms),
      allowMemberCreate: site.allowMemberCreateWerewolf,
      roleConfig: parseRoleConfig(game.role_config),
      assignMode: game.assign_mode,
      participants: participants.map((participant) => ({
        userId: participant.userId,
        displayName: participant.displayName,
        avatarUrl: participant.avatarKey ? publicFileUrl(participant.avatarKey) : '',
        isCreator: participant.isCreator,
        online: participant.online,
        isAlive: participant.alive,
        roleRevealed: roleRevealed(participant),
        role: roleRevealed(participant) ? participant.role : null,
        deathRound: participant.deathRound,
        deathCause: participant.deathCause
      })),
      night: game.phase === 'night' ? await this.buildNight(game, userId, participants) : null,
      day: game.phase === 'day' ? { roundNo: Number(game.round_no) } : null,
      vote: game.phase === 'vote' ? await this.buildVote(game, userId, participants) : null,
      history,
      lastResult: history.length ? { ...history.at(-1), winner: game.winner || null } : null
    };
  }

  async hasActed(game, userId) {
    if (game.phase === 'night') {
      const row = await this.db()
        .prepare('SELECT 1 AS ok FROM werewolf_night_actions WHERE game_id = ? AND round_no = ? AND actor_id = ? LIMIT 1')
        .bind(game.id, game.round_no, userId)
        .first();
      return Boolean(row);
    }
    if (game.phase === 'vote') {
      const row = await this.db()
        .prepare('SELECT 1 AS ok FROM werewolf_votes WHERE game_id = ? AND round_no = ? AND voter_id = ? LIMIT 1')
        .bind(game.id, game.round_no, userId)
        .first();
      return Boolean(row);
    }
    return false;
  }

  async buildNight(game, userId, participants) {
    const db = this.db();
    const roundNo = Number(game.round_no);
    const { results } = await db
      .prepare('SELECT actor_id, action, target_user_id FROM werewolf_night_actions WHERE game_id = ? AND round_no = ?')
      .bind(game.id, roundNo)
      .all();
    const me = participants.find((participant) => participant.userId === Number(userId));
    const myRow = results.find((row) => Number(row.actor_id) === Number(userId));
    // wolfTargetUserIds 仅对狼人可见；seerChecks 仅对预言家可见；witch 仅对女巫可见。
    const wolfTargetUserIds = me?.role === 'wolf'
      ? [...new Set(results.filter((row) => row.action === 'wolf_kill' && row.target_user_id != null).map((row) => Number(row.target_user_id)))]
      : null;
    const seerChecks = me?.role === 'seer' ? await this.loadSeerChecks(game.id, userId) : [];
    const witch = me?.role === 'witch'
      ? { hasAntidote: !Number(me.antidoteUsed), hasPoison: !Number(me.poisonUsed), usedThisNight: Boolean(myRow) }
      : null;
    return {
      myAction: myRow ? { action: myRow.action, targetUserId: myRow.target_user_id == null ? null : Number(myRow.target_user_id) } : null,
      wolfTargetUserIds,
      seerChecks,
      witch,
      actedCount: results.length,
      requiredCount: participants.filter((participant) => participant.alive && ['wolf', 'seer', 'witch'].includes(participant.role)).length
    };
  }

  async loadSeerChecks(gameId, userId) {
    const { results } = await this.db()
      .prepare(
        `SELECT a.round_no, a.target_user_id, u.display_name AS target_name, p.role AS target_role
         FROM werewolf_night_actions a
         JOIN users u ON u.id = a.target_user_id
         JOIN werewolf_participants p ON p.game_id = a.game_id AND p.user_id = a.target_user_id
         WHERE a.game_id = ? AND a.actor_id = ? AND a.action = 'seer_check'
         ORDER BY a.round_no ASC`
      )
      .bind(gameId, Number(userId))
      .all();
    return results.map((row) => ({
      roundNo: Number(row.round_no),
      targetUserId: Number(row.target_user_id),
      targetName: row.target_name || '',
      isWolf: row.target_role === 'wolf'
    }));
  }

  async buildVote(game, userId, participants) {
    const db = this.db();
    const roundNo = Number(game.round_no);
    const { results } = await db
      .prepare(
        `SELECT v.voter_id, v.target_user_id, voter.display_name AS voter_name, target.display_name AS target_name
         FROM werewolf_votes v
         JOIN users voter ON voter.id = v.voter_id
         LEFT JOIN users target ON target.id = v.target_user_id
         WHERE v.game_id = ? AND v.round_no = ?`
      )
      .bind(game.id, roundNo)
      .all();
    const nameMap = new Map(participants.map((participant) => [participant.userId, participant.displayName]));
    const tallyMap = {};
    for (const row of results) {
      if (row.target_user_id == null) continue;
      const id = Number(row.target_user_id);
      tallyMap[id] = (tallyMap[id] || 0) + 1;
    }
    const tally = Object.entries(tallyMap).map(([id, count]) => ({
      targetUserId: Number(id),
      targetName: nameMap.get(Number(id)) || '',
      count
    }));
    const votes = results.map((row) => ({
      voterUserId: Number(row.voter_id),
      voterName: row.voter_name || '',
      targetUserId: row.target_user_id == null ? null : Number(row.target_user_id),
      targetName: row.target_name || ''
    }));
    const myRow = results.find((row) => Number(row.voter_id) === Number(userId));
    return {
      myVoteTargetUserId: myRow ? (myRow.target_user_id == null ? null : Number(myRow.target_user_id)) : null,
      votedCount: results.length,
      requiredCount: participants.filter((participant) => participant.alive).length,
      tally,
      votes
    };
  }

  async buildHistory(game, participants) {
    const { results } = await this.db()
      .prepare(
        `SELECT r.round_no, r.deaths, r.exiled_user_id, e.display_name AS exiled_name
         FROM werewolf_rounds r
         LEFT JOIN users e ON e.id = r.exiled_user_id
         WHERE r.game_id = ? AND r.resolved_at IS NOT NULL
         ORDER BY r.round_no ASC`
      )
      .bind(game.id)
      .all();
    const names = new Map(participants.map((participant) => [participant.userId, participant.displayName]));
    return results.map((row) => {
      let deaths = [];
      try {
        deaths = JSON.parse(row.deaths || '[]');
      } catch {
        deaths = [];
      }
      return {
        roundNo: Number(row.round_no),
        deaths: deaths.map((death) => ({
          userId: Number(death.userId),
          displayName: names.get(Number(death.userId)) || '',
          cause: death.cause
        })),
        exiled: row.exiled_user_id == null ? null : { userId: Number(row.exiled_user_id), displayName: row.exiled_name || '' }
      };
    });
  }
}
