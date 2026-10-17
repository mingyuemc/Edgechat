-- 真心话大冒险/狼人杀：开局申请补充房间标题，审批通过后据此建局。

ALTER TABLE truth_dare_applications ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE werewolf_applications ADD COLUMN title TEXT NOT NULL DEFAULT '';
