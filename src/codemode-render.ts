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
		// Native collapsed rendering has already hidden logical lines. Its row
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

/** Preserve the whole native definition, including MCP's parameter-schema identity. */
export function compactCodemodeDefinition(definition: CodemodeDefinition): CodemodeDefinition {
	const renderResult = definition.renderResult;
	if (!renderResult) throw new Error("unified-exec: native codemode result renderer missing");
	return {
		...definition,
		renderResult(result, options, theme, context) {
			// Native codemode reuses its Text via lastComponent.setText(). Never
			// pass our wrapper back: Pi would catch the error and use a fallback.
			const lastComponent = context.lastComponent instanceof CompactCodemodeResult
				? context.lastComponent.inner : context.lastComponent;
			const inner = renderResult(result, options, theme, { ...context, lastComponent });
			if (options.expanded) return inner;
			return new CompactCodemodeResult(inner, theme, result.details?.fullOutputPath);
		},
	};
}

/** Default-on presentation fix; does not activate codemode or write settings. */
export function registerCompactCodemode(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void | Promise<void> {
	if (env[COMPACT_CODEMODE_ENV] === "0") return;
	// Use Pi's public factory, not a copy of its executor/loadout/store logic.
	// Bind forwarding methods to the real API so their receivers stay intact.
	const api = new Proxy(pi, {
		get(target, property) {
			if (property === "registerTool") {
				return (definition: CodemodeDefinition) => target.registerTool(
					definition.name === "codemode" ? compactCodemodeDefinition(definition) : definition,
				);
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return createCodemodeExtension()(api);
}
