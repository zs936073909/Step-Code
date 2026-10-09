import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import {
	DEFAULT_LOCALE,
	getAvailableLocales,
	getLocale,
	hasTranslation,
	initLocale,
	loadLocaleCatalogFromPath,
	normalizeLocale,
	registerLocaleCatalog,
	resetLocale,
	t,
} from "../src/locale/locale.ts";
import { STEP_PERMISSION_PRESETS } from "../src/step/permissions.ts";

beforeEach(() => {
	resetLocale();
	process.env.STEP_CODING_AGENT_DIR = process.env.STEP_CODING_AGENT_DIR ?? join(tmpdir(), "step-locale-tests");
});

afterEach(() => {
	resetLocale();
	delete process.env.STEP_CODING_AGENT_DIR;
});

function catalog(messages: Record<string, string>): Record<string, string> {
	return messages;
}

describe("normalizeLocale", () => {
	test("accepts plain and regional tags", () => {
		expect(normalizeLocale("en")).toBe("en");
		expect(normalizeLocale("zh-CN")).toBe("zh-CN");
		expect(normalizeLocale("  zh-CN  ")).toBe("zh-CN");
		expect(normalizeLocale("pt-BR")).toBe("pt-BR");
	});

	test("rejects values that are not locale tags", () => {
		expect(normalizeLocale(undefined)).toBeUndefined();
		expect(normalizeLocale("")).toBeUndefined();
		expect(normalizeLocale("   ")).toBeUndefined();
		expect(normalizeLocale("../../etc/passwd")).toBeUndefined();
		expect(normalizeLocale("zh CN")).toBeUndefined();
		expect(normalizeLocale("x")).toBeUndefined();
		expect(normalizeLocale("a".repeat(36))).toBeUndefined();
		expect(normalizeLocale(42)).toBeUndefined();
	});
});

describe("t", () => {
	test("returns the key when no catalog is loaded", () => {
		expect(t("Open settings menu")).toBe("Open settings menu");
		expect(getLocale()).toBe(DEFAULT_LOCALE);
	});

	test("returns the translation when a catalog is loaded", () => {
		registerLocaleCatalog("zh-CN", catalog({ "Open settings menu": "打开设置菜单" }));
		initLocale("zh-CN");
		expect(t("Open settings menu")).toBe("打开设置菜单");
		expect(getLocale()).toBe("zh-CN");
		expect(hasTranslation("Open settings menu")).toBe(true);
	});

	test("falls back to English for keys missing from the catalog", () => {
		registerLocaleCatalog("zh-CN", catalog({ "Open settings menu": "打开设置菜单" }));
		initLocale("zh-CN");
		// Upstream copy edits surface as English, never as a crash or a raw key name.
		expect(t("Some label upstream renamed")).toBe("Some label upstream renamed");
	});

	test("interpolates {name} placeholders and leaves unknown ones alone", () => {
		registerLocaleCatalog("zh-CN", catalog({ "Quit {name}": "退出 {name}" }));
		initLocale("zh-CN");
		expect(t("Quit {name}", { name: "step" })).toBe("退出 step");
		expect(t("Quit {name}", { name: 42 })).toBe("退出 42");
		expect(t("Quit {name}")).toBe("退出 {name}");
		expect(t("Quit {name}", { other: "x" })).toBe("退出 {name}");
	});
});

describe("initLocale", () => {
	test("degrades to English for an unknown locale instead of throwing", () => {
		expect(() => initLocale("xx-YY")).not.toThrow();
		expect(t("Open settings menu")).toBe("Open settings menu");
		expect(getLocale()).toBe("xx-YY");
	});

	test("explicit English clears any active catalog", () => {
		registerLocaleCatalog("zh-CN", catalog({ "Open settings menu": "打开设置菜单" }));
		initLocale("zh-CN");
		initLocale("en");
		expect(t("Open settings menu")).toBe("Open settings menu");
		expect(getLocale()).toBe(DEFAULT_LOCALE);
	});
});

describe("loadLocaleCatalog", () => {
	test("reads a catalog file and rejects malformed ones", async () => {
		const root = await mkdtemp(join(tmpdir(), "step-locale-catalog-"));
		const good = join(root, "zh-CN.json");
		await writeFile(good, JSON.stringify({ locale: "zh-CN", messages: { Ask: "询问" } }), "utf-8");
		expect(loadLocaleCatalogFromPath(good)).toEqual({ Ask: "询问" });

		const noMessages = join(root, "bad.json");
		await writeFile(noMessages, JSON.stringify({ locale: "bad" }), "utf-8");
		expect(() => loadLocaleCatalogFromPath(noMessages)).toThrow(/must have a "messages" object/);

		const notJson = join(root, "worse.json");
		await writeFile(notJson, "{ not json", "utf-8");
		expect(() => loadLocaleCatalogFromPath(notJson)).toThrow(/Failed to parse locale catalog/);

		const nonString = join(root, "nonstring.json");
		await writeFile(nonString, JSON.stringify({ locale: "x", messages: { Ask: 1 } }), "utf-8");
		expect(() => loadLocaleCatalogFromPath(nonString)).toThrow(/non-string value/);
	});
});

describe("getAvailableLocales", () => {
	test("lists registered catalogs", () => {
		registerLocaleCatalog("zh-CN", catalog({}));
		registerLocaleCatalog("ja-JP", catalog({}));
		expect(getAvailableLocales()).toContain("zh-CN");
		expect(getAvailableLocales()).toContain("ja-JP");
	});
});

describe("render-time translation", () => {
	// Regression guard: exported data must stay canonical English and be translated at
	// the render site. Translating inside the data module would freeze the strings at
	// import time, before initLocale() runs, so the UI would stay English forever.
	test("exported data stays English while t() translates it", () => {
		const command = BUILTIN_SLASH_COMMANDS.find((entry) => entry.name === "settings");
		expect(command?.description).toBe("Open settings menu");
		expect(STEP_PERMISSION_PRESETS.map((preset) => preset.id)).toEqual(["ask", "read-only", "bypass", "autopilot"]);

		expect(t(command?.description ?? "")).toBe("Open settings menu");

		registerLocaleCatalog("zh-CN", catalog({ "Open settings menu": "打开设置菜单", Bypass: "绕过" }));
		initLocale("zh-CN");

		// Data unchanged, render translated.
		expect(command?.description).toBe("Open settings menu");
		expect(t(command?.description ?? "")).toBe("打开设置菜单");
		expect(STEP_PERMISSION_PRESETS.find((preset) => preset.id === "bypass")?.label).toBe("Bypass");
		expect(t(STEP_PERMISSION_PRESETS.find((preset) => preset.id === "bypass")?.label ?? "")).toBe("绕过");
	});
});
