// 真心话大冒险的共享常量：前后端与 Worker 端共用，避免魔法字符串漂移。
export const TRUTH_DARE_SCOPES = ['public', 'channel', 'manual'] as const;
export type TruthDareScope = (typeof TRUTH_DARE_SCOPES)[number];

export const TRUTH_DARE_CHOICES = ['truth', 'dare'] as const;
export type TruthDareChoice = (typeof TRUTH_DARE_CHOICES)[number];

export const TRUTH_DARE_PHASES = [
  'idle',
  'choosing',
  'collecting',
  'voting',
  'answering',
  'confirming',
  'resolved'
] as const;
export type TruthDarePhase = (typeof TRUTH_DARE_PHASES)[number];

// 选择真心话/大冒险的强制时限；超时由服务端自动判定为大冒险。
export const TRUTH_DARE_CHOICE_MS = 10000;
// 出题与投票阶段的兜底时限，避免有人掉线导致整局卡住。
export const TRUTH_DARE_COLLECT_MS = 60000;
export const TRUTH_DARE_VOTE_MS = 60000;
// 参与者被视为“在线”的最近活跃窗口。
export const TRUTH_DARE_ONLINE_MS = 30000;
// 候选台词与作答的长度上限。
export const TRUTH_DARE_PROMPT_MAX = 200;
export const TRUTH_DARE_ANSWER_MAX = 2000;
// 允许创建游戏的后台权限键；站点级开关用于放开“普通成员免审批直接开局”。
export const TRUTH_DARE_CREATE_PERMISSION = 'truth_dare.create';
