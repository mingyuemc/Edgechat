import { cleanupR2Keys } from "./gc.js";
import {
	listEvictionCandidates,
	sumUploadedFileBytes,
} from "./data/uploaded-files.js";

// R2 免费额度为 10GiB；超过后在新上传落地时按创建时间淘汰最早的文件。
export const DEFAULT_R2_MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024;
const EVICTION_CANDIDATE_LIMIT = 90;
const MAX_EVICTION_ROUNDS = 5;

export function resolveR2MaxTotalBytes(env) {
	const parsed = Number(env?.R2_MAX_TOTAL_BYTES);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_R2_MAX_TOTAL_BYTES;
	return Math.floor(parsed);
}

// 上传登记成功后调用：只要登记占用超出配额，就循环淘汰最早的文件，直到回落或无法继续。
export async function enforceR2Quota(
	env,
	{
		protectedKey = "",
		cleanup = cleanupR2Keys,
		sumBytes = sumUploadedFileBytes,
		listCandidates = listEvictionCandidates,
	} = {},
) {
	const quota = resolveR2MaxTotalBytes(env);
	const summary = { quota, deletedFiles: 0, skippedReferenced: 0, rounds: 0 };
	if (!env?.DB || !env?.FILES) return summary;

	for (let round = 0; round < MAX_EVICTION_ROUNDS; round += 1) {
		summary.rounds = round + 1;
		const total = await sumBytes(env.DB);
		if (total <= quota) break;

		const candidates = await listCandidates(
			env.DB,
			EVICTION_CANDIDATE_LIMIT,
			protectedKey,
		);
		if (!candidates.length) break;

		// 只挑最少的早期文件覆盖缺口，避免一次超限淘汰过多对象。
		const needed = total - quota;
		const selected = [];
		let covered = 0;
		for (const candidate of candidates) {
			selected.push(candidate.key);
			covered += candidate.size;
			if (covered >= needed) break;
		}

		// cleanupR2Keys 会跳过仍被消息/头像/站点图标引用的对象，避免淘汰破坏引用。
		const result = await cleanup(env, selected);
		const deleted = Number(result?.r2Deleted || 0);
		summary.deletedFiles += deleted;
		summary.skippedReferenced += Number(result?.r2SkippedReferenced || 0);
		// 一轮下来若没有任何文件被真正删除（例如最早的都仍被引用），继续循环也没有意义。
		if (!deleted) break;
	}

	return summary;
}
