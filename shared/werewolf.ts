// 狼人杀的共享常量：前后端与 Worker 端共用，避免魔法字符串漂移。
export const WEREWOLF_SCOPES = ['public', 'channel', 'manual'] as const;
export type WerewolfScope = (typeof WEREWOLF_SCOPES)[number];

export const WEREWOLF_ROLES = ['wolf', 'seer', 'witch', 'villager'] as const;
export type WerewolfRole = (typeof WEREWOLF_ROLES)[number];

export const WEREWOLF_PHASES = ['lobby', 'night', 'day', 'vote', 'ended'] as const;
export type WerewolfPhase = (typeof WEREWOLF_PHASES)[number];

// 夜晚行动（狼人、预言家、女巫）的兜底时限；到点自动结算当晚。
export const WEREWOLF_NIGHT_MS = 60000;
// 白天讨论兜底时限；到点进入投票。
export const WEREWOLF_DAY_MS = 60000;
// 投票兜底时限；到点结算放逐。
export const WEREWOLF_VOTE_MS = 60000;
// 参与者被视为“在线”的最近活跃窗口。
export const WEREWOLF_ONLINE_MS = 30000;
// 房间标题长度上限。
export const WEREWOLF_TITLE_MAX = 60;
// 开局的玩家数量上下限。
export const WEREWOLF_MIN_PLAYERS = 4;
export const WEREWOLF_MAX_PLAYERS = 18;
// 允许创建游戏的后台权限键；站点级开关用于放开“普通成员免审批直接开局”。
export const WEREWOLF_CREATE_PERMISSION = 'werewolf.create';
