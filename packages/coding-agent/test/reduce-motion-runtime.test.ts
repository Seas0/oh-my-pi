import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "../src/config/settings";
import { LiveVisualizer } from "../src/live/visualizer";
import { AssistantMessageComponent } from "../src/modes/components/assistant-message";
import { ToolExecutionComponent, type ToolExecutionUi } from "../src/modes/components/tool-execution";
import { CURRENT_SETUP_VERSION, runSetupWizard, type SetupScene } from "../src/modes/setup-wizard";
import type { SetupWizardComponent } from "../src/modes/setup-wizard/wizard-overlay";
import { initTheme } from "../src/modes/theme/theme";
import type { InteractiveModeContext } from "../src/modes/types";
import type { TodoToolDetails } from "../src/tools/todo";
import { createAssistantMessage } from "./helpers/agent-session-setup";

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe.each(["on", "strict"] as const)("reduce motion %s", level => {
	for (const invalidate of [true, false]) {
		it(`stops an active thinking pulse ${invalidate ? "on invalidation" : "at the next tick"} and can resume`, () => {
			vi.useFakeTimers();
			const repaint = vi.fn();
			const component = new AssistantMessageComponent(undefined, true, repaint);
			const message = createAssistantMessage("");
			message.content = [{ type: "thinking", thinking: "private reasoning" }];
			try {
				component.updateContent(message);
				vi.advanceTimersByTime(100);
				expect(repaint).toHaveBeenCalled();

				settings.override("display.reduceMotion", level);
				if (invalidate) component.invalidate(); // /config invalidates the TUI tree.
				repaint.mockClear();
				vi.advanceTimersByTime(300);
				expect(repaint).not.toHaveBeenCalled();
				const frozen = component.render(100).join("\n");
				expect(frozen).toContain("Thinking");
				expect(frozen).not.toContain("private reasoning");
				vi.advanceTimersByTime(1_000);
				expect(component.render(100).join("\n")).toBe(frozen);
				expect(repaint).not.toHaveBeenCalled();

				settings.override("display.reduceMotion", "off");
				component.invalidate();
				vi.advanceTimersByTime(100);
				expect(repaint).toHaveBeenCalled();
				component.updateContent(createAssistantMessage("Visible answer"));
				expect(component.render(100).join("\n")).toContain("Visible answer");
			} finally {
				component.dispose();
			}
		});

		it(`settles an active todo strike ${invalidate ? "on invalidation" : "at the next tick"}`, () => {
			vi.useFakeTimers();
			const repaint = vi.fn();
			const ui: ToolExecutionUi = {
				requestRender: vi.fn(),
				requestComponentRender: repaint,
				resetDisplay: vi.fn(),
			};
			const component = new ToolExecutionComponent(
				"todo",
				{ op: "done", task: "finished task" },
				{},
				undefined,
				ui,
				process.cwd(),
			);
			const details: TodoToolDetails = {
				op: "done",
				phases: [{ name: "Execution", tasks: [{ content: "finished task", status: "completed" }] }],
				storage: "memory",
				completedTasks: [{ phase: "Execution", content: "finished task" }],
			};
			try {
				component.updateResult({ content: [], details });
				component.setExpanded(true);
				const fullStrike = "\x1b[9mfinished task\x1b[29m";
				expect(component.render(100).join("\n")).not.toContain(fullStrike);
				vi.advanceTimersByTime(65);
				expect(repaint).toHaveBeenCalled();

				settings.override("display.reduceMotion", level);
				if (invalidate) component.invalidate();
				else vi.advanceTimersByTime(65);
				const settled = component.render(100).join("\n");
				expect(settled).toContain(fullStrike);
				repaint.mockClear();
				vi.advanceTimersByTime(1_000);
				expect(component.render(100).join("\n")).toBe(settled);
				expect(repaint).not.toHaveBeenCalled();

				component.updateResult({ content: [{ type: "text", text: "Todo failed" }], isError: true });
				expect(Bun.stripANSI(component.render(100).join("\n"))).toContain("Todo failed");
			} finally {
				component.stopAnimation();
			}
		});
	}

	it("freezes spectrum phase but preserves volume changes, decay and transcripts", () => {
		const visualizer = new LiveVisualizer({ onStop() {}, onToggleMute() {} });
		visualizer.setPhase("working");
		visualizer.setInputLevel(0.1);
		visualizer.setFrame(3);
		const animated = visualizer.render(80);
		// Toggle without a new frame: the render cache must also observe the setting.
		settings.override("display.reduceMotion", level);
		const frozen = visualizer.render(80);
		expect(frozen).not.toEqual(animated);
		for (const frame of [4, 11, 25]) {
			visualizer.setFrame(frame);
			expect(visualizer.render(80)).toEqual(frozen);
		}

		visualizer.setInputLevel(0.02);
		visualizer.setFrame(26);
		const decay = visualizer.render(80);
		expect(decay.slice(1, 3)).not.toEqual(frozen.slice(1, 3));
		for (let frame = 27; frame < 60; frame++) visualizer.setFrame(frame);
		const quiet = visualizer.render(80);
		expect(quiet.slice(1, 3)).not.toEqual(decay.slice(1, 3));
		visualizer.setInputLevel(0.15);
		expect(visualizer.render(80).slice(1, 3)).not.toEqual(quiet.slice(1, 3));
		visualizer.setTranscript("still listening");
		expect(visualizer.render(80).join("\n")).toContain("still listening");
		visualizer.setPhase("muted");
		expect(Bun.stripANSI(visualizer.render(80)[1])).toBe(`│${" ".repeat(78)}│`);

		visualizer.setPhase("working");
		settings.override("display.reduceMotion", "off");
		const resumed = visualizer.render(80);
		visualizer.setFrame(61);
		expect(visualizer.render(80)).not.toEqual(resumed);
	});

	it("runs setup scenes immediately, saves completion, and skips cosmetic timers and welcome", async () => {
		vi.useFakeTimers();
		const setupSettings = Settings.isolated({ "display.reduceMotion": level });
		const requestRender = vi.fn();
		const hide = vi.fn();
		const playWelcomeIntro = vi.fn();
		const mounted: string[] = [];
		const disposed: string[] = [];
		const scenes: SetupScene[] = ["first", "second"].map(id => ({
			id,
			title: id,
			minVersion: 1,
			mount: host => ({
				title: id,
				onMount: () => {
					mounted.push(id);
				},
				handleInput: () => host.finish("done"),
				render: () => [`configure ${id}`],
				dispose: () => {
					disposed.push(id);
				},
			}),
		}));
		let component: SetupWizardComponent | undefined;
		const ctx = {
			settings: setupSettings,
			playWelcomeIntro,
			ui: {
				terminal: { rows: 30 },
				showOverlay: (next: SetupWizardComponent) => {
					component = next;
					return { hide };
				},
				setFocus: vi.fn(),
				requestRender,
			},
		} as unknown as InteractiveModeContext;
		const pending = runSetupWizard(ctx, scenes);
		try {
			if (!component) throw new Error("Setup overlay was not mounted");
			expect(mounted).toEqual(["first"]);
			const frame = component.render(80);
			expect(frame.join("\n")).toContain("configure first");
			requestRender.mockClear();
			vi.advanceTimersByTime(3_000);
			expect(component.render(80)).toEqual(frame);
			expect(requestRender).not.toHaveBeenCalled();
			component.handleInput("\r");
			expect(mounted).toEqual(["first", "second"]);
			expect(component.render(80).join("\n")).toContain("configure second");
			component.handleInput("\r");
			await pending; // No outro timer or extra input is needed to finish.
			expect(disposed).toEqual(["first", "second"]);
			expect(setupSettings.get("setupVersion")).toBe(CURRENT_SETUP_VERSION);
			expect(hide).toHaveBeenCalledTimes(1);
			expect(playWelcomeIntro).not.toHaveBeenCalled();
			requestRender.mockClear();
			vi.advanceTimersByTime(3_000);
			expect(requestRender).not.toHaveBeenCalled();
		} finally {
			component?.dispose();
		}
	});
});
