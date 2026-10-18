type TurnstileEnv = Record<string, unknown> | undefined | null;

export type TurnstileConfig = {
	siteKey: string;
	secretKey: string;
	enabled: boolean;
};

export function turnstileConfig(env: TurnstileEnv): TurnstileConfig {
	const siteKey = String(env?.TURNSTILE_SITE_KEY ?? "").trim();
	const secretKey = String(env?.TURNSTILE_SECRET_KEY ?? "").trim();
	// 公开的 site key 与私密 secret key 必须同时配置才启用，避免半配置时前端无法渲染却仍强制校验。
	return { siteKey, secretKey, enabled: Boolean(siteKey && secretKey) };
}

export function publicTurnstileSiteKey(env: TurnstileEnv): string {
	const config = turnstileConfig(env);
	return config.enabled ? config.siteKey : "";
}

export async function verifyTurnstile(
	env: TurnstileEnv,
	token: unknown,
	remoteIp?: string | null,
): Promise<{ ok: boolean }> {
	const { enabled, secretKey } = turnstileConfig(env);
	if (!enabled) {
		// 未配置密钥时自动跳过人机验证。
		return { ok: true };
	}

	const response = String(token ?? "").trim();
	if (!response) {
		return { ok: false };
	}

	const body = new FormData();
	body.append("secret", secretKey);
	body.append("response", response);
	if (remoteIp) {
		body.append("remoteip", remoteIp);
	}

	try {
		const result = await fetch(
			"https://challenges.cloudflare.com/turnstile/v0/siteverify",
			{ method: "POST", body },
		);
		const payload = (await result.json().catch(() => null)) as {
			success?: boolean;
		} | null;
		return { ok: Boolean(payload?.success) };
	} catch {
		// 校验服务不可用时按失败处理，避免攻击者借网络故障绕过。
		return { ok: false };
	}
}
