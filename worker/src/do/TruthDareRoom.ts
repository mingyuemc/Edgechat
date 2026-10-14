// 真心话大冒险对局的唯一写者：所有回合状态变更都在此串行执行并落 D1，
// 通过 gameId 命名的 DO 实例天然把同一局的操作串成一条队列，避免并发交错。
import { parseVerifiedUserId } from '../verified-identity.js';
import { durableObjectHealth } from '../maintenance/do-health.ts';
import { getSiteSettings } from '../data/site-settings.js';
import { errorResponse, publicFileUrl } from '../utils.js';
import { ApiError } from '../errors.js';
import {
  answerResolution,
  chooseOnlineChosen,
  insertTruthDareAudit,
  loadGame,
  requireChosen as requireChosenUser,
  requireCreator,
  requirePhase,
  resolveVotingWinner,
  timeoutTransition,
  validateAnswerText,
  validateChoice,
  validatePromptContent
} from '../data/truth-dare.ts';
import {
  TRUTH_DARE_CHOICE_MS,
  TRUTH_DARE_COLLECT_MS,
  TRUTH_DARE_ONLINE_MS,
  TRUTH_DARE_VOTE_MS
} from '../../../shared/truth-dare.ts';

// 在线窗口直接交给 SQL 判断，避免在 JS 里解析无时区标记的 CURRENT_TIMESTAMP。
const ONLINE_SINCE = `datetime('now', '-${Math.round(TRUTH_DARE_ONLINE_MS / 1000)} seconds')`;
// 拼装某张表别名下“最近活跃”的布尔条件。
const onlineCondition = (alias) => `${alias}.last_seen_at >= ${ONLINE_SINCE}`;

export class TruthDareRoom {
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
    const health = durableObjectHealth(request, 'TruthDareRoom');
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
        console.error('truth_dare_action_failed');
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
      .prepare('UPDATE truth_dare_participants SET last_seen_at = CURRENT_TIMESTAMP WHERE game_id = ? AND user_id = ?')
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
      const hasPrompts = game.phase === 'collecting' ? await this.roundHasPrompts(gameId, game.round_no) : false;
      const transition = timeoutTransition(game.phase, now, hasPrompts);
      if (!transition) {
        // 未知阶段：清掉时限，避免 alarm 空转。
        await db
          .prepare('UPDATE truth_dare_games SET phase_deadline_ms = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .bind(gameId)
          .run();
        return;
      }
      await this.applyTimeout(game, transition);
    }
  }

  async applyTimeout(game, transition) {
    const db = this.db();
    if (transition.kind === 'auto_dare') {
      await db.batch([
        db
          .prepare('UPDATE truth_dare_rounds SET choice = ?, choice_auto = 1 WHERE game_id = ? AND round_no = ?')
          .bind('dare', game.id, game.round_no),
        db
          .prepare(`UPDATE truth_dare_games SET choice = ?, phase = 'collecting', phase_deadline_ms = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .bind('dare', transition.deadlineMs, game.id)
      ]);
      return;
    }
    if (transition.kind === 'to_voting') {
      await this.enterVoting(game, transition.deadlineMs);
      return;
    }
    if (transition.kind === 'resolve') {
      await this.resolveRound(game);
      return;
    }
    if (transition.kind === 'close_voting') {
      await this.closeVoting(game);
    }
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
      case 'spin': return this.spin(game, userId);
      case 'choose': return this.choose(game, userId, payload);
      case 'prompt': return this.submitPrompt(game, userId, payload);
      case 'openVoting': return this.openVoting(game, userId);
      case 'vote': return this.vote(game, userId, payload);
      case 'closeVoting': return this.chooseVotingClose(game, userId);
      case 'answer': return this.answer(game, userId, payload);
      case 'confirm': return this.confirm(game, userId, payload);
      case 'endGame': return this.endGame(game, userId);
      default: throw new ApiError('未知的游戏操作', 400);
    }
  }

  async spin(game, userId) {
    requireCreator(game, userId, '只有发起人可以抽人');
    requirePhase(game, ['idle', 'resolved'], '当前阶段不能抽人');
    const participants = await this.loadParticipants(game.id);
    const chosen = chooseOnlineChosen(participants, () => this.random());
    if (!chosen) throw new ApiError('当前没有在线玩家');
    const roundNo = Number(game.round_no) + 1;
    const deadline = Date.now() + TRUTH_DARE_CHOICE_MS;
    await this.db().batch([
      this.db()
        .prepare('INSERT INTO truth_dare_rounds (game_id, round_no, chosen_user_id) VALUES (?, ?, ?)')
        .bind(game.id, roundNo, chosen.userId),
      this.db()
        .prepare(
          `UPDATE truth_dare_games
           SET phase = 'choosing', chosen_user_id = ?, choice = NULL, winning_prompt_id = NULL,
               round_no = ?, phase_deadline_ms = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
        .bind(chosen.userId, roundNo, deadline, game.id)
    ]);
  }

  async choose(game, userId, payload) {
    requirePhase(game, ['choosing'], '当前阶段不能选择');
    requireChosenUser(game, userId, '只有被选中的人可以选择');
    const choice = validateChoice(payload.choice);
    const deadline = Date.now() + TRUTH_DARE_COLLECT_MS;
    await this.db().batch([
      this.db()
        .prepare('UPDATE truth_dare_rounds SET choice = ? WHERE game_id = ? AND round_no = ?')
        .bind(choice, game.id, game.round_no),
      this.db()
        .prepare(`UPDATE truth_dare_games SET choice = ?, phase = 'collecting', phase_deadline_ms = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(choice, deadline, game.id)
    ]);
  }

  async submitPrompt(game, userId, payload) {
    requirePhase(game, ['collecting'], '当前阶段不能出题');
    await this.requireParticipant(game.id, userId, '只有参与者可以出题');
    if (Number(game.chosen_user_id) === Number(userId)) throw new ApiError('被选中的人不能出题', 403);
    const content = validatePromptContent(payload.content);
    const kind = game.choice === 'truth' || game.choice === 'dare' ? game.choice : 'truth';
    try {
      await this.db()
        .prepare('INSERT INTO truth_dare_prompts (game_id, round_no, author_id, kind, content) VALUES (?, ?, ?, ?, ?)')
        .bind(game.id, game.round_no, userId, kind, content)
        .run();
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new ApiError('每人只能提交一条');
      throw error;
    }
    await this.maybeAutoOpenVoting(game);
  }

  async openVoting(game, userId) {
    requireCreator(game, userId, '只有发起人可以开启投票');
    requirePhase(game, ['collecting'], '当前阶段不能开启投票');
    if (!(await this.roundHasPrompts(game.id, game.round_no))) {
      await this.resolveRound(game);
      return;
    }
    await this.enterVoting(game, Date.now() + TRUTH_DARE_VOTE_MS);
  }

  async vote(game, userId, payload) {
    requirePhase(game, ['voting'], '当前阶段不能投票');
    await this.requireParticipant(game.id, userId, '只有参与者可以投票');
    if (Number(game.chosen_user_id) === Number(userId)) throw new ApiError('被选中的人不能投票', 403);
    const promptId = Number(payload.promptId);
    const prompt = await this.db()
      .prepare('SELECT id FROM truth_dare_prompts WHERE id = ? AND game_id = ? AND round_no = ?')
      .bind(promptId, game.id, game.round_no)
      .first();
    if (!prompt) throw new ApiError('只能投给本轮的台词');
    await this.db()
      .prepare('INSERT OR REPLACE INTO truth_dare_votes (game_id, round_no, voter_id, prompt_id) VALUES (?, ?, ?, ?)')
      .bind(game.id, game.round_no, userId, promptId)
      .run();
    await this.maybeAutoCloseVoting(game);
  }

  async chooseVotingClose(game, userId) {
    requireCreator(game, userId, '只有发起人可以结束投票');
    requirePhase(game, ['voting'], '当前阶段不能结束投票');
    await this.closeVoting(game);
  }

  async answer(game, userId, payload) {
    requirePhase(game, ['answering'], '当前阶段不能作答');
    requireChosenUser(game, userId, '只有被选中的人可以作答');
    const text = validateAnswerText(payload.text);
    const voiceKey = payload.voiceKey ? String(payload.voiceKey) : '';
    const voiceDuration = payload.voiceDurationMs == null ? null : Number(payload.voiceDurationMs);
    if (!text && !voiceKey) throw new ApiError('请填写作答内容或录音');
    const statements = [
      this.db()
        .prepare('UPDATE truth_dare_rounds SET answer_text = ?, answer_voice_key = ?, answer_voice_duration_ms = ? WHERE game_id = ? AND round_no = ?')
        .bind(text, voiceKey || null, voiceDuration, game.id, game.round_no)
    ];
    if (answerResolution(game.choice) === 'resolved') {
      statements.push(
        this.db()
          .prepare('UPDATE truth_dare_rounds SET resolved_at = CURRENT_TIMESTAMP WHERE game_id = ? AND round_no = ?')
          .bind(game.id, game.round_no),
        this.db()
          .prepare(`UPDATE truth_dare_games SET phase = 'resolved', phase_deadline_ms = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .bind(game.id)
      );
    } else {
      statements.push(
        this.db()
          .prepare(`UPDATE truth_dare_games SET phase = 'confirming', phase_deadline_ms = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .bind(game.id)
      );
    }
    await this.db().batch(statements);
  }

  async confirm(game, userId, _payload) {
    requirePhase(game, ['confirming'], '当前阶段不能确认');
    await this.requireParticipant(game.id, userId, '只有参与者可以确认');
    if (Number(game.chosen_user_id) === Number(userId)) throw new ApiError('不能自己确认', 403);
    await this.db().batch([
      this.db()
        .prepare('UPDATE truth_dare_rounds SET confirmed_by = ?, resolved_at = CURRENT_TIMESTAMP WHERE game_id = ? AND round_no = ?')
        .bind(userId, game.id, game.round_no),
      this.db()
        .prepare(`UPDATE truth_dare_games SET phase = 'resolved', phase_deadline_ms = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(game.id)
    ]);
  }

  async endGame(game, userId) {
    requireCreator(game, userId, '只有发起人可以结束游戏');
    if (game.status === 'ended') return;
    const row = await this.db().prepare('SELECT display_name FROM users WHERE id = ?').bind(userId).first();
    await this.db()
      .prepare(
        `UPDATE truth_dare_games
         SET status = 'ended', ended_at = CURRENT_TIMESTAMP, phase = 'resolved', phase_deadline_ms = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .bind(game.id)
      .run();
    await insertTruthDareAudit(this.db(), {
      requestId: crypto.randomUUID(),
      actorId: userId,
      actorName: row?.display_name || '',
      action: 'truth_dare.game.end',
      target: String(game.id),
      summary: { scope: game.scope, channelId: game.channel_id == null ? null : Number(game.channel_id), title: game.title || '' }
    });
  }

  // ---------- 阶段推进 ----------

  async enterVoting(game, deadlineMs) {
    await this.db()
      .prepare(`UPDATE truth_dare_games SET phase = 'voting', phase_deadline_ms = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(deadlineMs, game.id)
      .run();
  }

  async resolveRound(game) {
    await this.db().batch([
      this.db()
        .prepare('UPDATE truth_dare_rounds SET resolved_at = CURRENT_TIMESTAMP WHERE game_id = ? AND round_no = ?')
        .bind(game.id, game.round_no),
      this.db()
        .prepare(`UPDATE truth_dare_games SET phase = 'resolved', phase_deadline_ms = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(game.id)
    ]);
  }

  // 若“在线且非被选中者”都已出题，则自动进入投票。
  async maybeAutoOpenVoting(game) {
    const onlineCount = await this.countOnlineOthers(game.id, game.chosen_user_id);
    if (onlineCount <= 0) return;
    const submitted = await this.countOnlineAuthors(game.id, game.round_no, game.chosen_user_id);
    if (submitted < onlineCount) return;
    await this.enterVoting(game, Date.now() + TRUTH_DARE_VOTE_MS);
  }

  // 若“在线且非被选中者”都已投票，则自动结算票选。
  async maybeAutoCloseVoting(game) {
    const onlineCount = await this.countOnlineOthers(game.id, game.chosen_user_id);
    if (onlineCount <= 0) return;
    const voted = await this.countOnlineVoters(game.id, game.round_no, game.chosen_user_id);
    if (voted < onlineCount) return;
    await this.closeVoting(game);
  }

  async closeVoting(game) {
    const { results } = await this.db()
      .prepare(
        `SELECT p.id,
           (SELECT COUNT(*) FROM truth_dare_votes v WHERE v.game_id = p.game_id AND v.round_no = p.round_no AND v.prompt_id = p.id) AS vote_count
         FROM truth_dare_prompts p
         WHERE p.game_id = ? AND p.round_no = ?`
      )
      .bind(game.id, game.round_no)
      .all();
    const winner = resolveVotingWinner(
      results.map((row) => ({ id: Number(row.id), voteCount: Number(row.vote_count || 0) })),
      () => this.random()
    );
    await this.db().batch([
      this.db()
        .prepare('UPDATE truth_dare_rounds SET winning_prompt_id = ? WHERE game_id = ? AND round_no = ?')
        .bind(winner, game.id, game.round_no),
      this.db()
        .prepare(`UPDATE truth_dare_games SET winning_prompt_id = ?, phase = 'answering', phase_deadline_ms = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(winner, game.id)
    ]);
  }

  // ---------- 计数与读取 ----------

  async roundHasPrompts(gameId, roundNo) {
    const row = await this.db()
      .prepare('SELECT 1 AS ok FROM truth_dare_prompts WHERE game_id = ? AND round_no = ? LIMIT 1')
      .bind(gameId, roundNo)
      .first();
    return Boolean(row);
  }

  async requireParticipant(gameId, userId, message) {
    const row = await this.db()
      .prepare('SELECT 1 AS ok FROM truth_dare_participants WHERE game_id = ? AND user_id = ? LIMIT 1')
      .bind(gameId, userId)
      .first();
    if (!row) throw new ApiError(message, 403);
  }

  async countOnlineOthers(gameId, chosenUserId) {
    const row = await this.db()
      .prepare(
        `SELECT COUNT(*) AS total FROM truth_dare_participants p
         WHERE p.game_id = ? AND p.user_id != ? AND ${onlineCondition('p')}`
      )
      .bind(gameId, Number(chosenUserId))
      .first();
    return Number(row?.total || 0);
  }

  async countOnlineAuthors(gameId, roundNo, chosenUserId) {
    const row = await this.db()
      .prepare(
        `SELECT COUNT(*) AS total FROM truth_dare_prompts pr
         WHERE pr.game_id = ? AND pr.round_no = ? AND pr.author_id != ?
           AND EXISTS (SELECT 1 FROM truth_dare_participants p
                       WHERE p.game_id = pr.game_id AND p.user_id = pr.author_id AND ${onlineCondition('p')})`
      )
      .bind(gameId, roundNo, Number(chosenUserId))
      .first();
    return Number(row?.total || 0);
  }

  async countOnlineVoters(gameId, roundNo, chosenUserId) {
    const row = await this.db()
      .prepare(
        `SELECT COUNT(*) AS total FROM truth_dare_votes v
         WHERE v.game_id = ? AND v.round_no = ? AND v.voter_id != ?
           AND EXISTS (SELECT 1 FROM truth_dare_participants p
                       WHERE p.game_id = v.game_id AND p.user_id = v.voter_id AND ${onlineCondition('p')})`
      )
      .bind(gameId, roundNo, Number(chosenUserId))
      .first();
    return Number(row?.total || 0);
  }

  async loadParticipants(gameId) {
    const { results } = await this.db()
      .prepare(
        `SELECT p.user_id, p.is_creator, u.display_name, u.avatar_key,
            CASE WHEN ${onlineCondition('p')} THEN 1 ELSE 0 END AS online
         FROM truth_dare_participants p
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
      online: Boolean(Number(row.online))
    }));
  }

  async buildState(gameId, userId) {
    const db = this.db();
    const game = await loadGame(db, gameId);
    const participants = await this.loadParticipants(gameId);
    const me = participants.find((participant) => participant.userId === Number(userId)) || null;
    const site = await getSiteSettings(db);
    const isChosen = game.chosen_user_id != null && Number(game.chosen_user_id) === Number(userId);
    const round = Number(game.round_no) > 0 ? await this.loadRound(game, userId) : null;
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
        channelName: game.channel_name || ''
      },
      me: {
        userId: Number(userId),
        isCreator: Number(game.creator_id) === Number(userId),
        isParticipant: Boolean(me),
        isChosen,
        isOnline: Boolean(me?.online)
      },
      allowMemberCreate: site.allowMemberCreateGame,
      phaseDeadlineMs: game.phase_deadline_ms == null ? null : Number(game.phase_deadline_ms),
      participants: participants.map((participant) => ({
        userId: participant.userId,
        displayName: participant.displayName,
        avatarUrl: participant.avatarKey ? publicFileUrl(participant.avatarKey) : '',
        isCreator: participant.isCreator,
        online: participant.online,
        isChosen: participant.userId === Number(game.chosen_user_id)
      })),
      round
    };
  }

  async loadRound(game, userId) {
    const db = this.db();
    const round = await db
      .prepare(
        `SELECT r.round_no, r.chosen_user_id, r.choice, r.winning_prompt_id,
            r.answer_text, r.answer_voice_key, r.answer_voice_duration_ms, r.confirmed_by,
            chosen.display_name AS chosen_name
         FROM truth_dare_rounds r
         LEFT JOIN users chosen ON chosen.id = r.chosen_user_id
         WHERE r.game_id = ? AND r.round_no = ?`
      )
      .bind(game.id, game.round_no)
      .first();
    if (!round) return null;
    const { results: prompts } = await db
      .prepare(
        `SELECT p.id, p.author_id, p.content, u.display_name AS author_name,
            (SELECT COUNT(*) FROM truth_dare_votes v WHERE v.game_id = p.game_id AND v.round_no = p.round_no AND v.prompt_id = p.id) AS vote_count,
            EXISTS (SELECT 1 FROM truth_dare_votes v WHERE v.game_id = p.game_id AND v.round_no = p.round_no AND v.prompt_id = p.id AND v.voter_id = ?) AS voted_by_me
         FROM truth_dare_prompts p
         JOIN users u ON u.id = p.author_id
         WHERE p.game_id = ? AND p.round_no = ?
         ORDER BY p.id ASC`
      )
      .bind(userId, game.id, game.round_no)
      .all();
    let winningContent = '';
    if (round.winning_prompt_id != null) {
      const winner = await db
        .prepare('SELECT content FROM truth_dare_prompts WHERE id = ?')
        .bind(Number(round.winning_prompt_id))
        .first();
      winningContent = winner?.content || '';
    }
    return {
      roundNo: Number(round.round_no),
      chosenUserId: round.chosen_user_id == null ? null : Number(round.chosen_user_id),
      chosenName: round.chosen_name || '',
      choice: round.choice || null,
      prompts: prompts.map((row) => ({
        id: Number(row.id),
        authorId: Number(row.author_id),
        authorName: row.author_name || '',
        content: row.content,
        voteCount: Number(row.vote_count || 0),
        votedByMe: Boolean(Number(row.voted_by_me))
      })),
      winningPromptId: round.winning_prompt_id == null ? null : Number(round.winning_prompt_id),
      winningContent,
      answerText: round.answer_text || '',
      answerVoiceUrl: round.answer_voice_key ? publicFileUrl(round.answer_voice_key) : '',
      answerVoiceDurationMs: round.answer_voice_duration_ms == null ? null : Number(round.answer_voice_duration_ms),
      confirmedBy: round.confirmed_by == null ? null : Number(round.confirmed_by)
    };
  }
}
