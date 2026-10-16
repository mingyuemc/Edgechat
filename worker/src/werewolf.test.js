import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from './errors.js';
import {
  assignRoles,
  checkWinner,
  resolveExile,
  resolveNightDeaths,
  resolvePlurality,
  timeoutTransition,
  validateAssignMode,
  validateRoleAssignment,
  validateRoleConfig,
  validateScope
} from './data/werewolf.ts';
import { WEREWOLF_VOTE_MS } from '../../shared/werewolf.ts';

test('自动分配按配置铺满角色池并随机打乱', () => {
  const config = { wolf: 1, seer: 1, witch: 1, villager: 2 };
  // rng 恒为 0 → Fisher–Yates 每一步都与首位交换，结果固定。
  const roles = assignRoles([1, 2, 3, 4, 5], config, 'auto', null, () => 0);
  const counts = { wolf: 0, seer: 0, witch: 0, villager: 0 };
  for (const role of Object.values(roles)) counts[role] += 1;
  assert.deepEqual(counts, config);
  assert.deepEqual(roles, { 1: 'seer', 2: 'witch', 3: 'villager', 4: 'villager', 5: 'wolf' });
});

test('手动分配严格采用房主给定的映射', () => {
  const config = { wolf: 1, seer: 1, witch: 0, villager: 2 };
  const mapping = { 1: 'wolf', 2: 'seer', 3: 'villager', 4: 'villager' };
  assert.deepEqual(assignRoles([1, 2, 3, 4], config, 'manual', mapping, () => 0), mapping);
});

test('角色配置与玩家数量不匹配时拒绝', () => {
  assert.throws(
    () => assignRoles([1, 2, 3, 4], { wolf: 2, seer: 1, witch: 1, villager: 1 }, 'auto', null, () => 0),
    (error) => error instanceof ApiError && /不匹配/.test(error.message)
  );
  // 手动映射数量与配置不符同样拒绝。
  assert.throws(
    () => assignRoles([1, 2, 3, 4], { wolf: 1, seer: 1, witch: 0, villager: 2 }, 'manual', { 1: 'wolf', 2: 'wolf', 3: 'villager', 4: 'villager' }, () => 0),
    (error) => error instanceof ApiError && /不匹配/.test(error.message)
  );
  // 不足 4 人拒绝开局。
  assert.throws(
    () => assignRoles([1, 2, 3], { wolf: 0, seer: 0, witch: 0, villager: 3 }, 'auto', null, () => 0),
    (error) => error instanceof ApiError && /至少需要/.test(error.message)
  );
});

test('取最高票：平票时在最高者中随机裁决', () => {
  const entries = [
    { id: 1, count: 2 },
    { id: 2, count: 2 },
    { id: 3, count: 1 }
  ];
  assert.equal(resolvePlurality(entries, () => 0), 1);
  assert.equal(resolvePlurality(entries, () => 0.999), 2);
  // 唯一最高直接胜出，零票也一样取最高。
  assert.equal(resolvePlurality([{ id: 7, count: 5 }], () => 0.5), 7);
  assert.equal(resolvePlurality([], () => 0), null);
});

test('放逐结算与多数票结算同义', () => {
  const entries = [
    { id: 3, count: 1 },
    { id: 4, count: 3 },
    { id: 5, count: 3 }
  ];
  assert.equal(resolveExile(entries, () => 0.999), 5);
  assert.equal(resolveExile([], () => 0), null);
});

test('夜晚结算：解药取消狼人击杀，毒药追加死亡', () => {
  assert.deepEqual(resolveNightDeaths({ wolfTarget: 3, saved: false, poisonTarget: 5 }), [
    { userId: 3, cause: 'wolf' },
    { userId: 5, cause: 'poison' }
  ]);
  // 解药救下狼人目标后不再有狼人死亡。
  assert.deepEqual(resolveNightDeaths({ wolfTarget: 3, saved: true, poisonTarget: null }), []);
  // 只使用毒药时只结算毒杀。
  assert.deepEqual(resolveNightDeaths({ wolfTarget: null, saved: false, poisonTarget: 5 }), [{ userId: 5, cause: 'poison' }]);
});

test('胜负判定：狼人全灭或狼人占优时结束，否则继续', () => {
  assert.equal(checkWinner(0, 3), 'villagers');
  assert.equal(checkWinner(2, 2), 'wolves');
  assert.equal(checkWinner(2, 1), 'wolves');
  assert.equal(checkWinner(1, 3), null);
});

test('阶段超时推进：夜晚结算、白天进入投票、投票结算放逐', () => {
  assert.equal(timeoutTransition('night', 1000, {}).kind, 'resolve_night');
  assert.equal(timeoutTransition('night', 1000, {}).deadlineMs, null);
  const day = timeoutTransition('day', 2000, {});
  assert.equal(day.kind, 'to_vote');
  assert.equal(day.deadlineMs, 2000 + WEREWOLF_VOTE_MS);
  assert.equal(timeoutTransition('vote', 3000, {}).kind, 'resolve_vote');
  assert.equal(timeoutTransition('vote', 3000, {}).deadlineMs, null);
  assert.equal(timeoutTransition('lobby', 3000, {}), null);
  assert.equal(timeoutTransition('ended', 3000, {}), null);
});

test('输入校验返回中文错误并规范化内容', () => {
  assert.equal(validateScope('public'), 'public');
  assert.throws(() => validateScope('bad'), (error) => error instanceof ApiError && /范围无效/.test(error.message));

  assert.equal(validateAssignMode('manual'), 'manual');
  assert.throws(() => validateAssignMode('bad'), (error) => error instanceof ApiError && /分配方式无效/.test(error.message));

  assert.deepEqual(validateRoleConfig({ wolf: 1, seer: 1, witch: 1, villager: 1 }), { wolf: 1, seer: 1, witch: 1, villager: 1 });
  assert.throws(
    () => validateRoleConfig({ wolf: 1, seer: 1, witch: 1, villager: 20 }),
    (error) => error instanceof ApiError && /最多/.test(error.message)
  );
  assert.throws(
    () => validateRoleConfig({ wolf: -1, seer: 1, witch: 1, villager: 1 }),
    (error) => error instanceof ApiError && /角色配置无效/.test(error.message)
  );

  assert.deepEqual(validateRoleAssignment({ 1: 'wolf', 2: 'villager' }), { 1: 'wolf', 2: 'villager' });
  assert.throws(
    () => validateRoleAssignment({ 1: 'dragon' }),
    (error) => error instanceof ApiError && /角色分配无效/.test(error.message)
  );
});
