export const ADMIN_PERMISSIONS = [
  ['dashboard.read', 'dashboard', '查看仪表盘', '仅聚合数量和状态'],
  ['users.read', 'users', '查看用户', '基础资料、账号状态与管理身份'],
  ['users.create', 'users', '创建用户', '仅创建普通账号', 'users.read'],
  ['users.profile.update', 'users', '编辑用户资料', '仅未受保护普通用户的显示名', 'users.read'],
  ['users.ban', 'users', '封禁和解封', '仅未受保护普通用户', 'users.read'],
  ['users.delete', 'users', '删除用户', '仅未受保护普通用户', 'users.read', 'high'],
  ['users.login_history.read', 'users', '查看登录记录', '仅未受保护普通用户的 IP、UA 与登录时间', 'users.read', 'sensitive'],
  ['invites.read', 'invites', '查看注册邀请', '状态与次数，不含可用邀请凭据'],
  ['invites.create', 'invites', '创建注册邀请', '普通用户邀请及有效链接凭据', 'invites.read'],
  ['invites.revoke', 'invites', '撤销注册邀请', '不改变受邀账号的权限', 'invites.read'],
  ['channels.read', 'channels', '查看群组清单', '仅群组元数据，不含消息或成员明细'],
  ['channels.delete', 'channels', '删除群组', '系统 general 群不可删除', 'channels.read', 'high'],
  ['storage.read', 'storage', '查看存储统计', '用量摘要，不含对象路径或文件正文'],
  ['storage.scan', 'storage', '扫描存储', '每页最多 1000 个对象，单用户限速', 'storage.read'],
  ['site.read', 'site', '查看站点外观', '公开名称与图标，不含安全配置'],
  ['site.appearance.update', 'site', '修改站点外观', '仅名称和合法图标', 'site.read'],
  ['telegram.read', 'telegram', '查看 Telegram 桥接', '子管理员仅查看自己拥有的群'],
  ['telegram.mappings.manage', 'telegram', '管理 Telegram 映射', '子管理员必须是目标群主，不含 Bot 凭据', 'telegram.read', 'high'],
  ['instance_bridge.read', 'instance_bridge', '查看实例桥接', '子管理员仅查看自己拥有的群'],
  ['instance_bridge.manage', 'instance_bridge', '管理实例桥接', '子管理员必须是目标群主', 'instance_bridge.read', 'high'],
  ['maintenance.read', 'maintenance', '查看健康摘要', '脱敏状态，不含完整诊断'],
  ['truth_dare.read', 'truth_dare', '查看真心话大冒险', '对局清单、受邀名单与站点开关状态'],
  ['truth_dare.create', 'truth_dare', '允许创建游戏', '可直接开局，并审批他人的开局申请', 'truth_dare.read'],
  ['truth_dare.settings.update', 'truth_dare', '修改游戏设置', '仅站点级“允许成员创建游戏”开关', 'truth_dare.read'],
  ['werewolf.read', 'werewolf', '查看狼人杀', '对局清单、受邀名单与站点开关状态'],
  ['werewolf.create', 'werewolf', '允许创建狼人杀游戏', '可直接开局，并审批他人的开局申请', 'werewolf.read'],
  ['werewolf.settings.update', 'werewolf', '修改狼人杀设置', '仅站点级“允许成员创建游戏”开关', 'werewolf.read'],
].map(([key, module, name, description, dependency, risk]) => ({
  key: key!, module: module!, name: name!, description: description!,
  dependencies: dependency ? [dependency] : [], risk: risk || 'normal',
}));

export const PERMISSION_KEYS = ADMIN_PERMISSIONS.map((p) => p.key);
export type Authorization = { isSuperAdmin?: boolean; canAccessAdmin?: boolean; permissions?: string[] };
export function hasPermission(auth: Authorization | null | undefined, key: string) {
  return PERMISSION_KEYS.includes(key) && Boolean(auth?.isSuperAdmin || auth?.permissions?.includes(key));
}
export function validatePermissions(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((key) => typeof key === 'string' &&
    ADMIN_PERMISSIONS.some((p) => p.key === key && p.dependencies.every((d) => value.includes(d))));
}
export function togglePermission(current: string[], key: string, enabled: boolean) {
  const selected = new Set(current);
  if (enabled) {
    selected.add(key);
    for (const dependency of ADMIN_PERMISSIONS.find((p) => p.key === key)?.dependencies || []) selected.add(dependency);
  } else {
    selected.delete(key);
    for (const permission of ADMIN_PERMISSIONS) if (permission.dependencies.includes(key)) selected.delete(permission.key);
  }
  return PERMISSION_KEYS.filter((permission) => selected.has(permission));
}
