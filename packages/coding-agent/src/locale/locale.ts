/**
 * Locale support for Step's user-facing strings.
 *
 * This mirrors the theme module (`../theme/theme.ts`): catalogs are JSON files that
 * ship next to the source, users can drop their own into `~/.stepcode/locales`, and a
 * missing entry falls back to English instead of failing.
 *
 * Two deliberate choices keep the core small:
 *
 * 1. Keys are the English source strings themselves (gettext style). There is no
 *    parallel `menu.settings.open` naming scheme to maintain, and when upstream edits a
 *    label the stale key simply stops matching and the UI falls back to English.
 * 2. There is no `en.json`. English is the identity: `t(key)` returns `key` when no
 *    catalog is loaded. Shipping an English catalog would duplicate every literal.
 *
 * Interpolation uses `{name}` rather than `${name}` so catalog values never collide
 * with JavaScript template-literal syntax.
 *
 * What is intentionally NOT translated: tool schema fields (`name`, `description`,
 * `promptSnippet`), the system prompt, settings keys and enum values, and command
 * names. Those are contracts with the model or with persisted config, not UI copy.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { getCustomLocalesDir, getLocalesDir } from "../config.ts";
import { stripBom } from "../utils/text.ts";

/** Locale identifier, e.g. `en`, `zh-CN`. */
export type LocaleCode = string;

/** A message catalog: English source string -> translated string. */
export type MessageCatalog = Readonly<Record<string, string>>;

/** Locale used when nothing else is configured. English is the fallback identity. */
export const DEFAULT_LOCALE: LocaleCode = "en";

/** Environment override, checked before settings. Mirrors `STEPCODE_DEFAULT_THEME`. */
export const STEPCODE_LOCALE_ENV = "STEPCODE_LOCALE";

/** Shape of a catalog file on disk. */
export interface LocaleCatalogFile {
	/** BCP-47-ish locale tag the catalog translates to. */
	locale: LocaleCode;
	/** Human-readable name, shown in listings. */
	name?: string;
	/** English source string -> translation. */
	messages: MessageCatalog;
}

export interface LocaleInfo {
	locale: LocaleCode;
	path: string | undefined;
}

let currentLocale: LocaleCode = DEFAULT_LOCALE;
let currentCatalog: MessageCatalog = {};
let currentSourcePath: string | undefined;

const registeredCatalogs = new Map<LocaleCode, { catalog: MessageCatalog; path?: string }>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize a user-supplied locale value. Accepts `zh-CN`, `zh_cn`, ` zh-cn ` and
 * rejects anything that is not a short tag so it can never be used as a path segment.
 */
export function normalizeLocale(value: unknown): LocaleCode | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > 35) return undefined;
	if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8})?$/.test(trimmed)) return undefined;
	return trimmed;
}

function builtinLocalesDir(): string {
	return getLocalesDir();
}

/** Directory users drop their own catalogs into. */
export function getUserLocalesDir(): string {
	return getCustomLocalesDir();
}

function parseCatalogFile(label: string, content: string): MessageCatalog {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(content));
	} catch (error) {
		throw new Error(`Failed to parse locale catalog ${label}: ${error}`);
	}
	if (!isPlainObject(parsed)) {
		throw new Error(`Locale catalog ${label} must be a JSON object`);
	}
	const { locale, name: _name, messages } = parsed as Partial<LocaleCatalogFile>;
	if (!isPlainObject(messages)) {
		throw new Error(`Locale catalog ${label} must have a "messages" object`);
	}
	const catalog: Record<string, string> = {};
	for (const [key, value] of Object.entries(messages)) {
		if (key.length === 0) {
			throw new Error(`Locale catalog ${label} has an empty key`);
		}
		if (typeof value !== "string") {
			throw new Error(`Locale catalog ${label} has a non-string value for ${JSON.stringify(key)}`);
		}
		// A value that equals its key is a no-op entry; keep it, it is harmless and
		// makes partial catalogs easy to generate.
		catalog[key] = value;
	}
	if (locale !== undefined && typeof locale !== "string") {
		throw new Error(`Locale catalog ${label} has a non-string "locale"`);
	}
	return catalog;
}

function loadCatalogFromPath(catalogPath: string): MessageCatalog {
	return parseCatalogFile(catalogPath, readFileSync(catalogPath, "utf-8"));
}

/** Catalogs shipped with the package. */
export function getBuiltinLocales(): LocaleCode[] {
	const dir = builtinLocalesDir();
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => file.endsWith(".json"))
		.map((file) => file.slice(0, -".json".length))
		.sort();
}

/** Catalogs the user added under `~/.stepcode/locales`. */
export function getUserLocales(): LocaleCode[] {
	const dir = getUserLocalesDir();
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => file.endsWith(".json"))
		.map((file) => file.slice(0, -".json".length))
		.sort();
}

/** Every locale that can be loaded, built-in first. */
export function getAvailableLocales(): LocaleCode[] {
	const seen = new Set<LocaleCode>();
	const result: LocaleCode[] = [];
	for (const locale of [...getBuiltinLocales(), ...getUserLocales(), ...registeredCatalogs.keys()]) {
		if (seen.has(locale)) continue;
		seen.add(locale);
		result.push(locale);
	}
	return result;
}

export function getAvailableLocalesWithPaths(): LocaleInfo[] {
	const result: LocaleInfo[] = [];
	const seen = new Set<LocaleCode>();
	const add = (info: LocaleInfo) => {
		if (seen.has(info.locale)) return;
		seen.add(info.locale);
		result.push(info);
	};
	for (const locale of getBuiltinLocales()) {
		add({ locale, path: path.join(builtinLocalesDir(), `${locale}.json`) });
	}
	for (const locale of getUserLocales()) {
		add({ locale, path: path.join(getUserLocalesDir(), `${locale}.json`) });
	}
	for (const [locale, entry] of registeredCatalogs.entries()) {
		add({ locale, path: entry.path });
	}
	return result;
}

/**
 * Register a catalog in memory. Used by extensions that ship their own translations
 * and by tests.
 */
export function registerLocaleCatalog(locale: LocaleCode, catalog: MessageCatalog, catalogPath?: string): void {
	registeredCatalogs.set(locale, { catalog, path: catalogPath });
}

export function clearRegisteredLocaleCatalogs(): void {
	registeredCatalogs.clear();
}

function resolveCatalog(locale: LocaleCode): { catalog: MessageCatalog; path?: string } {
	const registered = registeredCatalogs.get(locale);
	if (registered) return registered;
	const builtinPath = path.join(builtinLocalesDir(), `${locale}.json`);
	if (existsSync(builtinPath)) return { catalog: loadCatalogFromPath(builtinPath), path: builtinPath };
	const userPath = path.join(getUserLocalesDir(), `${locale}.json`);
	if (existsSync(userPath)) return { catalog: loadCatalogFromPath(userPath), path: userPath };
	throw new Error(`Locale not found: ${locale}`);
}

/** Load a catalog by name without activating it. Throws when the locale is unknown. */
export function loadLocaleCatalog(locale: LocaleCode): MessageCatalog {
	return resolveCatalog(locale).catalog;
}

/** Load a catalog from an explicit path. */
export function loadLocaleCatalogFromPath(catalogPath: string): MessageCatalog {
	return loadCatalogFromPath(catalogPath);
}

/**
 * Activate a locale. English (and any unknown-but-normalizable value that has no
 * catalog) degrades to the identity catalog rather than throwing, so a typo in config
 * never breaks the UI.
 */
export function setLocale(locale: LocaleCode | undefined): void {
	const normalized = normalizeLocale(locale) ?? DEFAULT_LOCALE;
	if (normalized === DEFAULT_LOCALE) {
		currentLocale = DEFAULT_LOCALE;
		currentCatalog = {};
		currentSourcePath = undefined;
		return;
	}
	try {
		const resolved = resolveCatalog(normalized);
		currentLocale = normalized;
		currentCatalog = resolved.catalog;
		currentSourcePath = resolved.path;
	} catch {
		// Unknown locale: stay on English. The setting stays as requested so a catalog
		// dropped into ~/.stepcode/locales later takes effect on the next start.
		currentLocale = normalized;
		currentCatalog = {};
		currentSourcePath = undefined;
	}
}

export function getLocale(): LocaleCode {
	return currentLocale;
}

export function getLocaleCatalogPath(): string | undefined {
	return currentSourcePath;
}

/** True when a catalog is loaded and has an entry for `key`. */
export function hasTranslation(key: string): boolean {
	return Object.hasOwn(currentCatalog, key);
}

function interpolate(template: string, vars: Record<string, string | number> | undefined): string {
	if (!vars) return template;
	return template.replace(/\{(\w+)\}/g, (match, name: string) => {
		const value = vars[name];
		return value === undefined ? match : String(value);
	});
}

/**
 * Translate a user-facing string.
 *
 * The key is the English source literal. When the active catalog has no entry the key
 * is returned unchanged, which is what makes upstream copy edits safe.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
	const translated = currentCatalog[key];
	if (translated === undefined) return key;
	return interpolate(translated, vars);
}

/**
 * Initialize the locale for a session. Mirrors `initTheme`: an unknown or unset locale
 * degrades to English instead of throwing, so a bad value can never break startup.
 */
export function initLocale(locale: LocaleCode | undefined): void {
	setLocale(normalizeLocale(locale) ?? DEFAULT_LOCALE);
}

/** Reset to the default locale. Intended for tests. */
export function resetLocale(): void {
	currentLocale = DEFAULT_LOCALE;
	currentCatalog = {};
	currentSourcePath = undefined;
}
