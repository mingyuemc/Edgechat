import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from './errors.js';
import {
  answerResolution,
  authorHasPrompt,
  chooseOnlineChosen,
  requireCreator,
  requirePhase,
  resolveVotingWinner,
  timeoutTransition,
  validateAnswerText,
  validateChoice,
  validatePromptContent,
  validateScope
} from './data/truth-dare.ts';

test('随机抽人只在在线参与者中进行', () => {
  const participants = [
    { userId: 1, online: false },
    { userId: 2, online: true },
    { userId: 3, online: false }
  ];
  // rng 恒为 0 → 命中过滤后列表的第一项，即唯一在线的 2 号。
  assert.equal(chooseOnlineChosen(participants, () => 0).userId, 2);
  // 无人在线或空列表都不抽人。
  assert.equal(chooseOnlineChosen([{ userId: 1, online: false }], () => 0.5), null);
  assert.equal(chooseOnlineChosen([], () => 0), null);
});

test('选择阶段超时自动判定为大冒险', () => {
  const transition = timeoutTransition('choosing', 1000, false);
  assert.equal(transition.kind, 'auto_dare');
  assert.equal(transition.choice, 'dare');
  assert.equal(transition.choiceAuto, true);
  assert.equal(transition.deadlineMs, 1000 + 60000);
});

test('出题阶段超时：有台词进入投票，无人提问直接结算本轮', () => {
  const none = timeoutTransition('collecting', 2000, false);
  assert.equal(none.kind, 'resolve');
  assert.equal(none.deadlineMs, null);
  const some = timeoutTransition('collecting', 2000, true);
  assert.equal(some.kind, 'to_voting');
  assert.equal(some.deadlineMs, 2000 + 60000);
});

test('投票阶段超时触发结算票选，其他阶段无兜底时限', () => {
  assert.equal(timeoutTransition('voting', 5, true).kind, 'close_voting');
  assert.equal(timeoutTransition('answering', 5, true), null);
  assert.equal(timeoutTransition('resolved', 5, true), null);
});

test('投票平局时在最高票中随机裁决', () => {
  const prompts = [
    { id: 1, voteCount: 2 },
    { id: 2, voteCount: 2 },
    { id: 3, voteCount: 1 }
  ];
  assert.equal(resolveVotingWinner(prompts, () => 0), 1);
  assert.equal(resolveVotingWinner(prompts, () => 0.999), 2);
  // 唯一最高直接胜出，零票也一样取最高。
  assert.equal(resolveVotingWinner([{ id: 7, voteCount: 5 }], () => 0.5), 7);
  assert.equal(resolveVotingWinner([], () => 0), null);
});

test('同一轮每位参与者只能提交一条台词', () => {
  const prompts = [{ authorId: 5, content: 'x' }];
  assert.equal(authorHasPrompt(prompts, 5), true);
  assert.equal(authorHasPrompt(prompts, 6), false);
});

test('大冒险作答后必须由他人确认，真心话直接结算', () => {
  assert.equal(answerResolution('dare'), 'confirming');
  assert.equal(answerResolution('truth'), 'resolved');
});

test('只有发起人可以抽人或结束游戏', () => {
  const game = { creator_id: 7, phase: 'idle' };
  assert.doesNotThrow(() => requireCreator(game, 7));
  assert.throws(
    () => requireCreator(game, 8, '只有发起人可以抽人'),
    (error) => error instanceof ApiError && error.status === 403 && /发起人/.test(error.message)
  );
});

test('阶段守卫拒绝非法阶段的操作', () => {
  assert.doesNotThrow(() => requirePhase({ phase: 'idle' }, ['idle', 'resolved']));
  assert.throws(
    () => requirePhase({ phase: 'voting' }, ['idle', 'resolved'], '当前阶段不能抽人'),
    (error) => error instanceof ApiError && error.status === 409 && /当前阶段/.test(error.message)
  );
});

test('输入校验返回中文错误并规范化内容', () => {
  assert.equal(validateScope('public'), 'public');
  assert.throws(() => validateScope('bad'), (error) => error instanceof ApiError && /范围无效/.test(error.message));

  assert.equal(validateChoice('dare'), 'dare');
  assert.throws(() => validateChoice('nope'), (error) => /真心话或大冒险/.test(error.message));

  assert.equal(validatePromptContent('  你好  '), '你好');
  assert.throws(() => validatePromptContent('   '), (error) => /台词不能为空/.test(error.message));
  assert.throws(() => validatePromptContent('啊'.repeat(201)), (error) => /台词不能超过/.test(error.message));

  assert.equal(validateAnswerText('  ok  '), 'ok');
  assert.throws(() => validateAnswerText('啊'.repeat(2001)), (error) => /作答不能超过/.test(error.message));
});
