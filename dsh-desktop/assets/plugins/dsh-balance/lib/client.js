window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-balance",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		/**
		 * DeepSeek 账户余额 + 本轮会话费用，内联渲染在对话底部统计栏
		 * （conversation.composer.dock list slot，排在 StatsLine 之后）。
		 *
		 * 数据来源：DSH Desktop 壳层通过 preload 派发的
		 * window "dsh-balance-changed" 事件（detail = { ok, balances, prices }）；
		 * 纯浏览器环境（无桌面壳）时只显示“本轮费用”，价格用内置默认档。
		 */
		const FALLBACK_PRICES = { peak: { cacheMiss: 2, cacheHit: 0.5, output: 8 }, offpeak: { cacheMiss: 2, cacheHit: 0.5, output: 8 } };

		function money(value) {
			const v = Number(value) || 0;
			if (v >= 10) return v.toFixed(2);
			if (v >= 0.1) return v.toFixed(3);
			return v.toFixed(4);
		}

		/** tokenUsage 投影 → 本轮费用（¥）。缓存写入按 miss 价计费（与官方一致）。 */
		function sessionCost(usage, prices) {
			if (!usage) return 0;
			const p = { ...FALLBACK_PRICES.offpeak, ...(prices || {}) };
			const perM = (n) => (Number(n) || 0) / 1e6;
			return (
				perM(usage.uncachedInputTokens + usage.cacheWriteTokens) * p.cacheMiss +
				perM(usage.cacheReadTokens) * p.cacheHit +
				perM(usage.outputTokens) * p.output
			);
		}

		function hasUsage(usage) {
			return !!usage && (usage.outputTokens > 0 ||
				(usage.uncachedInputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0) > 0);
		}

		/** 订阅桌面壳推送的余额数据（含一次主动拉取）。 */
		function useBalanceData() {
			const [data, setData] = react.useState(null);
			react.useEffect(() => {
				let alive = true;
				const apply = (next) => { if (alive && next) setData(next); };
				const handler = (event) => apply(event.detail);
				window.addEventListener("dsh-balance-changed", handler);
				const bridge = window.dshDesktop;
				if (bridge && typeof bridge.refreshBalance === "function") {
					bridge.refreshBalance().then(apply).catch(() => {});
				}
				return () => {
					alive = false;
					window.removeEventListener("dsh-balance-changed", handler);
				};
			}, []);
			return data;
		}

		function BalanceDock({ useProjection }) {
			const usage = typeof useProjection === "function" ? useProjection("tokenUsage") : void 0;
			const data = useBalanceData();
			// 峰谷计费（2026-08-17 官方定价）：pricing.prices 携带高峰/空闲两档，
			// 按本地时钟在 nextAt 切点换档；纯浏览器环境（无壳推送）回退单档价格。
			const [_, setTock] = react.useState(0);
			react.useEffect(() => {
				const t = setInterval(() => setTock((n) => n + 1), 30000);
				return () => clearInterval(t);
			}, []);
			const pricing = data && data.pricing && data.pricing.prices ? data.pricing : null;
			const nowTs = Date.now();
			let period = pricing ? pricing.period : "offpeak";
			if (pricing && pricing.nextAt && nowTs >= (pricing.nextAt || 0)) {
				period = period === "peak" ? "offpeak" : "peak";
			}
			const prices = pricing
				? pricing.prices[period] || pricing.prices.offpeak || FALLBACK_PRICES.offpeak
				: data && data.prices ? data.prices : FALLBACK_PRICES.offpeak;
			const balances = data && Array.isArray(data.balances) ? data.balances : [];
			const primary = balances.find((b) => b.currency === "CNY") || balances[0];
			const hasBalance = !!(data && data.ok && primary);
			const usageKnown = hasUsage(usage);
			if (!hasBalance && !usageKnown && !pricing) return null;
			const parts = [];
			if (usageKnown) parts.push("本轮 ¥" + money(sessionCost(usage, prices)));
			if (hasBalance) parts.push("余额 ¥" + money(primary.total));
			const title = hasBalance
				? `${primary.currency} 余额 ¥${money(primary.total)}（充值 ¥${money(primary.toppedUp)} · 赠送 ¥${money(primary.granted)}）；本轮费用按 token 用量估算（¥/百万 token：命中 ${prices?.cacheHit ?? FALLBACK_PRICES.offpeak.cacheHit} / 未命中 ${prices?.cacheMiss ?? FALLBACK_PRICES.offpeak.cacheMiss} / 输出 ${prices?.output ?? FALLBACK_PRICES.offpeak.output}），点击前往充值`
				: "本轮费用按 token 用量估算；未读取到 DeepSeek API Key，无法显示余额";
			let dock = null;
			if (pricing && pricing.windows && pricing.windows.length) {
				const windowsTxt = pricing.windows.map((w) => w.join(" - ")).join("、");
				const msLeft = Math.max(0, (pricing.nextAt || nowTs) - nowTs);
				const h = Math.floor(msLeft / 3600000);
				const m = Math.floor((msLeft % 3600000) / 60000);
				const countdown = h > 0 ? `${h} 时 ${m} 分` : `${m} 分`;
				const isPeakNow = period === "peak";
				// nextAt 过期（已切段、宿主下次轮询未到）时只显示时段名；
				// period 已按本地时钟翻转，档位/颜色同步正确。
				const label = (isPeakNow ? "高峰价" : "空闲价") + (msLeft > 0 ? " · 剩 " + countdown : "");
				dock = react_jsx_runtime.jsx("span", {
					className: "dsh-balance-dock-period " + (isPeakNow ? "peak" : "offpeak"),
					title: "高峰时段 " + windowsTxt + "（UTC+8）为高峰价，其余为空闲价（半价）。可在设置 pricing.peakWindows 调整。",
					children: label
				});
			}
			const children = [];
			const text = parts.join(" · ");
			if (text) children.push(text);
			if (dock) { if (text) children.push(" · "); children.push(dock); }
			return react_jsx_runtime.jsx("a", {
				className: "dsh-balance-dock",
				href: "https://platform.deepseek.com/top_up",
				target: "_blank",
				rel: "noreferrer",
				title,
				children
			});
		}

		const CSS = [
			".dsh-balance-dock{display:inline-flex;align-items:center;box-sizing:border-box;",
			"color:var(--eac-widget-fg,var(--dsw-alias-label-tertiary));font-size:12px;line-height:16px;text-decoration:none;",
			"white-space:nowrap;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;",
			"padding:1px 8px;margin:0 2px;cursor:pointer;font-variant-numeric:tabular-nums;",
			"transition:color .15s,border-color .15s}",
			".dsh-balance-dock:hover{color:var(--eac-widget-fg,var(--dsw-alias-label-secondary));border-color:var(--dsw-alias-border-l2)}",
			".dsh-balance-dock-period{display:inline-flex;align-items:center;color:inherit;background:transparent;border:1px solid;border-radius:999px;padding:0 6px;font-size:12px;line-height:16px;white-space:nowrap;font-variant-numeric:tabular-nums}",
			".dsh-balance-dock-period.peak{color:#ffb86b;border-color:rgba(255,184,107,.4)}",
			".dsh-balance-dock-period.offpeak{color:#7fd6a0;border-color:rgba(127,214,160,.4)}"
		].join("");

		const TAG = "@deepseek-ai/dsh-balance/client.css";
		function ensureCss() {
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(TAG) + "]")) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-balance";
			tag.dataset.pluginCss = TAG;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/**
		 * Client plugin body: register a dock entry right after the session stats
		 * line. The slot's standard kit supplies `useProjection` (session-scoped).
		 */
		function apply(ctx) {
			ensureCss();
			ctx.effect(() => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "balance",
				order: 100
			}, BalanceDock), "dsh-balance: composer dock entry");
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	}
});
