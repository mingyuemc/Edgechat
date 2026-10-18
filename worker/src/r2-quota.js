import { cleanupR2Keys } from "./gc.js";
import {
	listEvictionCandidates,
	sumTrackedR2Bytes,
} from "./data/uploaded-files.js";

// R2 免费额度为 10GiB；写入前先确保不超限，否则淘汰最早的文件，仍不足则直接拒绝写入。
export const DEFAULT_R2_MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024;
export const R2_QUOTA_EXCEEDED_MESSAGE = "存储空间已满，暂时无法上传新文件";
const EVICTION_CANDIDATE_LIMIT = 90;
const MAX_EVICTION_ROUNDS = 5;

export class R2QuotaExceededError extends Error {
	constructor(message = R2_QUOTA_EXCEEDED_MESSAGE) {
		super(message);
		this.name = "R2QuotaExceededError";
		this.status = 507;
	}
}

export function resolveR2MaxTotalBytes(env) {
	const parsed = Number(env?.R2_MAX_TOTAL_BYTES);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_R2_MAX_TOTAL_BYTES;
	return Math.floor(parsed);
}

// 写入 R2 之前调用：保证“当前占用 + requiredBytes”不超过配额。
// 不足时按创建时间淘汰最早的未引用文件；若引用占用已经顶满，则抛错阻止写入，从源头杜绝超限。
export async function ensureR2Capacity(
	env,
	requiredBytes,
	{
		protectedKey = "",
		cleanup = cleanupR2Keys,
		sumBytes = sumTrackedR2Bytes,
		listCandidates = listEvictionCandidates,
	} = {},
) {
	const quota = resolveR2MaxTotalBytes(env);
	const summary = { quota, deletedFiles: 0, skippedReferenced: 0, rounds: 0 };
	if (!env?.DB || !env?.FILES) return summary;
	const required = Math.max(0, Number(requiredBytes) || 0);

	for (let round = 0; round < MAX_EVICTION_ROUNDS; round += 1) {
		summary.rounds = round + 1;
		const total = await sumBytes(env.DB);
		if (total + required <= quota) return summary;

		const candidates = await listCandidates(
			env.DB,
			EVICTION_CANDIDATE_LIMIT,
			protectedKey,
		);
		if (!candidates.length) break;

		// 只挑最少的早期文件覆盖缺口，避免一次超限淘汰过多对象。
		const deficit = total + required - quota;
		const selected = [];
		let covered = 0;
		for (const candidate of candidates) {
			selected.push(candidate.key);
			covered += candidate.size;
			if (covered >= deficit) break;
		}

		// cleanupR2Keys 会跳过仍被消息/头像/站点图标引用的对象，避免淘汰破坏引用。
		const result = await cleanup(env, selected);
		const deleted = Number(result?.r2Deleted || 0);
		summary.deletedFiles += deleted;
		summary.skippedReferenced += Number(result?.r2SkippedReferenced || 0);
		// 一轮下来若没有任何文件被真正删除（例如最早的都仍被引用），继续循环也没有意义。
		if (!deleted) break;
	}

	const finalTotal = await sumBytes(env.DB);
	if (finalTotal + required > quota) throw new R2QuotaExceededError();
	return summary;
}
