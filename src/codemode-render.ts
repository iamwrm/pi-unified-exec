/** Display-only visual-row bound for Pi's native codemode result renderer. */
import {
	createCodemodeExtension,
	keyHint,
	type CodemodeToolDetails,
	type ExtensionAPI,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

export const CODEMODE_PREVIEW_ROWS = 10;
export const COMPACT_CODEMODE_ENV = "PI_UNIFIED_EXEC_COMPACT_CODEMODE";
type CodemodeDefinition = ToolDefinition<any, CodemodeToolDetails | undefined>;

class CompactCodemodeResult implements Component {
	constructor(
		readonly inner: Component,
		private readonly theme: Theme,
		private readonly fullOutputPath: string | undefined,
	) {}

	render(width: number): string[] {
		if (width <= 0) return [];
		const rows = this.inner.render(width);
		if (rows.length <= CODEMODE_PREVIEW_ROWS) return rows;
		// Native collapsed rendering has already hidden output. Its row
		// count cannot tell us the total hidden output; use a non-numeric hint.
		const hint = this.theme.fg("muted", "... ") + keyHint("app.tools.expand", "to expand")
			+ this.theme.fg("muted", " (clipped)");
		const footer = [truncateToWidth(hint, width, "...")];
		if (this.fullOutputPath) {
			footer.push(truncateToWidth(this.theme.fg("muted", `Full output: ${this.fullOutputPath}`), width, "..."));
		}
		return [...rows.slice(0, CODEMODE_PREVIEW_ROWS - footer.length), ...footer];
	}

	invalidate(): void {
		this.inner.invalidate();
	}
}

/**
 * Preserve the whole native definition, including MCP's parameter-schema identity.
 * Without a native result renderer there is nothing to bound: return it as is.
 */
export function compactCodemodeDefinition(definition: CodemodeDefinition): CodemodeDefinition {
	const renderResult = definition.renderResult;
	if (!renderResult) return definition;
	return {
		...definition,
		renderResult(result, options, theme, context) {
			// Native codemode owns its cached component, now a Container in Pi 0.99.2.
			// Never pass our wrapper back: Pi would catch the error and use a fallback.
			const lastComponent = context.lastComponent instanceof CompactCodemodeResult
				? context.lastComponent.inner : context.lastComponent;
			const inner = renderResult(result, options, theme, { ...context, lastComponent });
			if (options.expanded) return inner;
			return new CompactCodemodeResult(inner, theme, result.details?.fullOutputPath);
		},
	};
}

/** Whether the last `defaultTools` entry naming codemode enables it (`codemode` or `+codemode`). */
export function defaultToolsWantCodemode(defaultTools: readonly string[] | undefined): boolean {
	const entry = [...(defaultTools ?? [])].reverse().find((name) => name.replace(/^[+-]/, "") === "codemode");
	return entry === "codemode" || entry === "+codemode";
}

/**
 * Default-on presentation fix; does not activate codemode or write settings.
 *
 * Registration waits for the first `session_start`, as in Pi's dynamic-tools
 * example. A load-time `codemode` makes Pi skip `builtin:codemode` and warn
 * every user; registered later, both stay loaded and Pi's registry keeps the
 * first extension in load order, where configured packages precede built-ins.
 * The built-in therefore remains the fallback whenever this fix is off, fails
 * or loses precedence. Loaded before the first request, so the initial tool
 * set already contains the replacement.
 */
export function registerCompactCodemode(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
	if (env[COMPACT_CODEMODE_ENV] === "0") return;
	let registered = false;
	let degraded = false;
	// Use Pi's public factory, not a copy of its executor/loadout/store logic.
	// Bind forwarding methods to the real API so their receivers stay intact.
	const api = new Proxy(pi, {
		get(target, property) {
			if (property === "registerTool") {
				return (definition: CodemodeDefinition) => {
					if (definition.name !== "codemode") return target.registerTool(definition);
					// Never drop codemode itself: degrade to the native display instead.
					degraded = !definition.renderResult;
					return target.registerTool(compactCodemodeDefinition(definition));
				};
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	pi.on("session_start", async (_event, ctx) => {
		// The extension instance survives new/resume/fork; reload creates a new one.
		if (registered) return;
		registered = true;
		const shadowing = pi.getAllTools().some((tool) => tool.name === "codemode");
		createCodemodeExtension()(api);
		// Without builtin:codemode (the 0.12.1 advice), Pi resolved defaultTools
		// before this registration and dropped `+codemode`: apply it here. A
		// `--tools` selection needs nothing: Pi activates or filters named tools.
		const active = pi.getActiveTools();
		if (!shadowing && !active.includes("codemode") && defaultToolsWantCodemode(pi.getSettings().defaultTools)
			&& pi.getAllTools().some((tool) => tool.name === "codemode")) {
			pi.setActiveTools([...active, "codemode"]);
		}
		// Precedence is Pi's load order, not an API contract: report a loss.
		const tools = pi.getAllTools();
		const owner = tools.find((tool) => tool.name === "codemode")?.sourceInfo.path;
		const ours = tools.find((tool) => tool.name === "exec_command")?.sourceInfo.path;
		const reason = degraded ? "native codemode renderer not found"
			: owner !== ours ? `codemode from ${owner ?? "another extension"} takes precedence` : undefined;
		if (reason && ctx.hasUI) ctx.ui.notify(`unified-exec: ${reason}; compact codemode previews are off`, "warning");
	});
}
