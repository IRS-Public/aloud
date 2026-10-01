import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { axeCoreSource } from "./dependencies.mjs";

// Experimental Safari page driver for VoiceOver capture, ported from the
// USWDS accessibility harness. Safari WebDriver blocks native keys behind an
// automation glass pane, so VoiceOver could not type into a driven window.
// Instead Aloud opens its own normal Safari window and observes it through
// Apple Events (`do JavaScript`), which needs Safari's "Allow JavaScript from
// Apple Events" setting on the disposable runner.
//
// The driver offers the small part of Playwright's launcher, context and page
// API that the web runner uses, so run.mjs keeps one capture loop. Setup
// actions (click, fill, wait) run as page JavaScript: their events are not
// trusted input, and selectors are plain CSS, not Playwright selectors.
// Every Apple Events call goes through an injectable `io`.

const run = promisify(execFile);

// A page function and its JSON argument as page JavaScript that always
// returns a JSON envelope: { value } or { error }. `do JavaScript` returns
// nothing useful for an exception, so the page reports its own errors.
export function pageScript(fn, argument) {
  const source = typeof fn === "function" ? fn.toString() : fn;
  return `(() => { try { return JSON.stringify({ value: (${source})(${JSON.stringify(argument ?? null)}) ?? null }); } ` +
    "catch (error) { return JSON.stringify({ error: String(error && error.message || error) }); } })()";
}

// The value from a pageScript envelope. Anything else, including Safari's
// "missing value", is an observation failure, never a result.
export function pageResult(output) {
  let envelope;
  try { envelope = JSON.parse(output); } catch { envelope = null; }
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("Safari JavaScript observation failed; enable Allow JavaScript from Apple Events on the test runner");
  }
  if (Object.hasOwn(envelope, "error")) throw new Error(`Safari page script failed: ${envelope.error}`);
  if (!Object.hasOwn(envelope, "value")) throw new Error("Safari JavaScript observation returned no value");
  return envelope.value;
}

// A structural outline of the page computed from the DOM in the page: roles
// from ARIA or the HTML element, a simple accessible name, and common states.
// Safari offers no accessibility snapshot to scripts, so this is an
// approximation labelled safari-dom-outline, not the browser's accessibility
// tree. It runs in the page, so it must not use anything outside itself.
export function domOutline() {
  const inputRoles = { checkbox: "checkbox", radio: "radio", button: "button", submit: "button", reset: "button",
    image: "button", range: "slider", number: "spinbutton", search: "searchbox", hidden: null };
  const implicit = {
    A: (el) => el.hasAttribute("href") ? "link" : null, BUTTON: () => "button", SUMMARY: () => "button",
    H1: () => "heading", H2: () => "heading", H3: () => "heading", H4: () => "heading", H5: () => "heading", H6: () => "heading",
    NAV: () => "navigation", MAIN: () => "main",
    // A header or footer inside sectioning content is generic (HTML-AAM);
    // only a page-level one is a banner or contentinfo landmark.
    HEADER: (el, scoped) => scoped ? null : "banner", FOOTER: (el, scoped) => scoped ? null : "contentinfo",
    ARTICLE: () => "article", ASIDE: () => "complementary", FORM: () => "form", SECTION: () => "region", DIALOG: () => "dialog",
    UL: () => "list", OL: () => "list", LI: () => "listitem", TABLE: () => "table", TR: () => "row",
    TH: () => "columnheader", TD: () => "cell", FIELDSET: () => "group", DETAILS: () => "group", P: () => "paragraph",
    IMG: (el) => el.getAttribute("alt") === "" ? null : "img", TEXTAREA: () => "textbox", OPTION: () => "option",
    SELECT: (el) => el.multiple || el.size > 1 ? "listbox" : "combobox",
    INPUT: (el) => {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      return Object.hasOwn(inputRoles, type) ? inputRoles[type] : "textbox";
    },
  };
  // Roles named by their content, and roles listed only when named.
  const fromContent = ["link", "button", "heading", "tab", "option", "cell", "columnheader", "menuitem", "treeitem"];
  const namedOnly = ["region", "form"];
  // Elements and roles that scope a header or footer to their section.
  const sectioningTags = ["ARTICLE", "ASIDE", "MAIN", "NAV", "SECTION"];
  const sectioningRoles = ["article", "complementary", "main", "navigation", "region"];
  const skipped = ["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "HEAD"];
  const collapse = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  // Removed with its whole subtree: nothing inside can be exposed.
  const removed = (el) => {
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return true;
    return getComputedStyle(el).display === "none";
  };
  // Invisible itself, but a descendant can set visibility: visible again,
  // so only this element and its own text are left out.
  const invisible = (el) => ["hidden", "collapse"].includes(getComputedStyle(el).visibility);
  const contentText = (el) => collapse(el.innerText ?? el.textContent);
  const name = (el, role) => {
    const labelledBy = collapse(el.getAttribute("aria-labelledby"));
    if (labelledBy) {
      const label = labelledBy.split(" ").map((id) => document.getElementById(id)).filter(Boolean).map(contentText).join(" ");
      if (collapse(label)) return collapse(label);
    }
    if (collapse(el.getAttribute("aria-label"))) return collapse(el.getAttribute("aria-label"));
    if (el.labels && el.labels.length) return collapse([...el.labels].map(contentText).join(" "));
    if (el.tagName === "IMG" || el.tagName === "INPUT" && el.getAttribute("type") === "image") {
      if (collapse(el.getAttribute("alt"))) return collapse(el.getAttribute("alt"));
    }
    if (el.tagName === "FIELDSET") {
      const legend = [...el.childNodes].find((child) => child.tagName === "LEGEND");
      if (legend) return contentText(legend);
    }
    if (fromContent.includes(role) && contentText(el)) return contentText(el);
    if (el.tagName === "INPUT" && ["button", "submit", "reset"].includes((el.getAttribute("type") || "").toLowerCase())) {
      return collapse(el.value);
    }
    return collapse(el.getAttribute("title") || el.getAttribute("placeholder"));
  };
  const states = (el, role) => {
    const found = [];
    const checked = el.getAttribute("aria-checked") ?? (["checkbox", "radio"].includes(role) ? String(Boolean(el.checked)) : null);
    if (checked !== null) found.push(`checked=${checked}`);
    if (el.disabled || el.getAttribute("aria-disabled") === "true") found.push("disabled");
    for (const key of ["expanded", "pressed", "selected"]) {
      const value = el.getAttribute(`aria-${key}`);
      if (value !== null) found.push(`${key}=${value}`);
    }
    if (role === "heading") {
      // aria-level, then the h1-h6 number, then ARIA's default level 2.
      const level = el.getAttribute("aria-level") || (/^H[1-6]$/.test(el.tagName) ? el.tagName.slice(1) : "2");
      found.push(`level=${level}`);
    }
    return found.length ? ` [${found.join(", ")}]` : "";
  };
  const lines = [];
  // `shown` says whether the node itself is visible, which decides its own
  // text; `scoped` says whether it sits inside sectioning content.
  const walk = (node, depth, { shown, scoped }) => {
    const children = node.shadowRoot ? node.shadowRoot.childNodes : node.childNodes;
    for (const child of children) {
      if (child.nodeType === 3) {
        const value = collapse(child.textContent);
        if (value && shown) lines.push(`${"  ".repeat(depth)}- text: ${JSON.stringify(value)}`);
        continue;
      }
      if (child.nodeType !== 1 || skipped.includes(child.tagName) || removed(child)) continue;
      const explicit = collapse(child.getAttribute("role")).split(" ")[0];
      let role = explicit || (implicit[child.tagName] ? implicit[child.tagName](child, scoped) : null);
      if (role === "presentation" || role === "none") role = null;
      const childShown = !invisible(child);
      if (!childShown) role = null;
      const label = role ? name(child, role) : "";
      if (role && namedOnly.includes(role) && !label) role = null;
      const inside = {
        shown: childShown,
        scoped: scoped || sectioningTags.includes(child.tagName) || sectioningRoles.includes(role),
      };
      if (!role) {
        walk(child, depth, inside);
        continue;
      }
      lines.push(`${"  ".repeat(depth)}- ${role}${label ? ` ${JSON.stringify(label)}` : ""}${states(child, role)}`);
      // Content already named the item; its descendants would repeat it.
      if (!fromContent.includes(role)) walk(child, depth + 1, inside);
    }
  };
  walk(document.body, 0, { shown: !invisible(document.body), scoped: false });
  return lines.join("\n");
}

// An AppleScript run with argv: item 1 is the owned window's id, as `w`.
export const windowScript = (body) =>
  `on run argv\n  tell application "Safari"\n    set w to window id ((item 1 of argv) as integer)\n${body}\n  end tell\nend run`;

// Runs the page JavaScript in the file named by item 2 of argv. `source` is
// a Safari property (a page's HTML), so it cannot name the variable: inside
// the tell block the property would take the name, not the file contents.
export const javascriptScript = windowScript(
  "    set aloudScript to read (POSIX file (item 2 of argv)) as «class utf8»\n" +
  "    return do JavaScript aloudScript in current tab of w");

// The real Safari, through osascript. Page JavaScript travels in a temporary
// file so large sources such as axe-core stay under argument limits.
export function safariIo() {
  const osascript = async (script, args = []) => {
    const { stdout } = await run("/usr/bin/osascript", ["-e", script, ...args],
      { encoding: "utf8", timeout: 15000, maxBuffer: 64 * 1024 * 1024 });
    return stdout.replace(/\n$/, "");
  };
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    version: () => osascript('return version of application "Safari"'),
    openWindow: () => osascript(`tell application "Safari"
    activate
    make new document with properties {URL:"about:blank"}
    return id of front window
  end tell`),
    closeWindow: (id) => osascript(windowScript("    close w"), [id]),
    bounds: async (id) => (await osascript(windowScript("    return bounds of w"), [id])).split(",").map((n) => Number(n.trim())),
    setBounds: (id, [left, top, right, bottom]) => osascript(windowScript(
      "    set bounds of w to {(item 2 of argv) as integer, (item 3 of argv) as integer, (item 4 of argv) as integer, (item 5 of argv) as integer}"),
    [id, left, top, right, bottom].map(String)),
    activate: (id) => osascript(windowScript("    set index of w to 1\n    activate"), [id]),
    setUrl: (id, url) => osascript(windowScript("    set URL of current tab of w to item 2 of argv\n    set index of w to 1\n    activate"), [id, url]),
    javascript: async (id, source) => {
      const dir = mkdtempSync(join(tmpdir(), "aloud-safari-"));
      try {
        const file = join(dir, "page.js");
        writeFileSync(file, source);
        return await osascript(javascriptScript, [id, file]);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
    // The window's screen rectangle. Needs Screen Recording permission for
    // Safari's content, which the runner setup is expected to grant.
    screenshot: (path, [left, top, right, bottom]) =>
      run("/usr/sbin/screencapture", ["-x", "-R", `${left},${top},${right - left},${bottom - top}`, path], { timeout: 15000 }),
    fetch: (url, options) => fetch(url, options),
    axeSource: axeCoreSource,
  };
}

const text = (value) => typeof value === "string" && value.trim().length > 0;

// A Playwright-shaped launcher over one owned Safari window.
export function createSafari(io = safariIo()) {
  return {
    async launch() {
      const version = await io.version();
      if (!text(version)) throw new Error("Safari did not report its version");
      return {
        version: () => version,
        newContext: (options) => openContext(io, options),
        // The owned window closes with its context. Safari itself is left
        // running: it may hold windows this run did not create.
        close: async () => {},
      };
    },
  };
}

async function openContext(io, { locale, viewport, storageState } = {}) {
  if (storageState) throw new Error("Safari capture cannot load Playwright storage state; authenticate another way or use Chromium");
  const id = await io.openWindow();
  if (!/^\d+$/.test(id)) throw new Error("Safari did not create a capture window");
  let timeoutMs = 30000, navigationTimeoutMs = 30000, closed = false;
  const context = {
    setDefaultTimeout(ms) { timeoutMs = ms; },
    setDefaultNavigationTimeout(ms) { navigationTimeoutMs = ms; },
    newPage: async () => page,
    close: async () => {
      if (closed) return;
      closed = true;
      await io.closeWindow(id);
    },
  };
  const evaluate = async (fn, argument) => pageResult(await io.javascript(id, pageScript(fn, argument)));
  // Poll `check` until it returns true; page scripts can fail while Safari
  // replaces a document, so failures only count once time runs out.
  const until = async (check, ms, message) => {
    const started = io.now();
    let lastError;
    for (;;) {
      try {
        if (await check()) return;
        lastError = undefined;
      } catch (error) { lastError = error; }
      if (io.now() - started >= ms) throw new Error(message, { cause: lastError });
      await io.sleep(100);
    }
  };
  const visible = (selector) => evaluate(([sel]) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const style = getComputedStyle(el);
    return el.getClientRects().length > 0 && style.visibility !== "hidden";
  }, [selector]);
  const locator = (selector) => ({
    waitFor: async ({ state = "visible" } = {}) => {
      const check = state === "attached"
        ? () => evaluate((sel) => document.querySelector(sel) !== null, selector)
        : () => visible(selector);
      await until(check, timeoutMs, `${selector} was not ${state} within ${timeoutMs}ms`);
    },
    // Focus first, as a pointer click would, then click. Not trusted input.
    click: async () => {
      await locator(selector).waitFor();
      await evaluate((sel) => {
        const el = document.querySelector(sel);
        el.scrollIntoView({ block: "center" });
        el.focus({ preventScroll: true });
        el.click();
        return true;
      }, selector);
    },
    // Set the value through the element's own setter so frameworks see it,
    // then fire input and change. Not trusted input.
    fill: async (value) => {
      await locator(selector).waitFor();
      await evaluate(([sel, next]) => {
        const el = document.querySelector(sel);
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
        if (setter) setter.call(el, next); else el.value = next;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }, [selector, value]);
    },
    evaluate: (fn) => evaluate(`(sel) => { const el = document.querySelector(sel); ` +
      `if (!el) throw new Error("no element matches " + sel); return (${fn.toString()})(el); }`, selector),
  });
  let axe;
  const page = {
    evaluate,
    locator,
    url: () => evaluate(() => document.URL),
    bringToFront: () => io.activate(id),
    // Safari returns from setting a URL before it navigates, so the old page
    // would pass a load check. Mark the current document and wait for one
    // without the mark. Apple Events cannot see the HTTP status, so a direct
    // request checks it first, and Safari's navigation timing too when it
    // reports one.
    goto: async (url) => {
      const preflight = await preflightRequest(io, url, navigationTimeoutMs);
      if (!preflight.ok) return { ok: () => false, status: () => preflight.status };
      // A URL that differs from the current one only by its fragment keeps
      // the same document, so the mark never goes away. Wait for the URL
      // itself instead.
      const current = await evaluate(() => document.URL);
      const sameDocument = sameDocumentUrl(current, url);
      await evaluate(() => { document.aloudPrevious = true; return true; });
      await io.setUrl(id, url);
      const loaded = sameDocument
        ? () => evaluate((target) => document.URL === target && document.readyState === "complete", url)
        : () => evaluate(() => !document.aloudPrevious && document.readyState === "complete");
      await until(loaded, navigationTimeoutMs, `Safari did not load ${url} within ${navigationTimeoutMs}ms`);
      if (sameDocument) await evaluate(() => { delete document.aloudPrevious; return true; });
      const status = await evaluate(() => performance.getEntriesByType("navigation")[0]?.responseStatus ?? null);
      const ok = status === null || status === 0 ? preflight.ok : status >= 200 && status < 300;
      return { ok: () => ok, status: () => status || preflight.status };
    },
    screenshot: async ({ path }) => io.screenshot(path, await io.bounds(id)),
    structuralSnapshot: () => evaluate(domOutline),
    // Inject the pinned axe-core and run it in the page. Results come back
    // through a page variable because `do JavaScript` cannot await.
    axe: async () => {
      axe ??= io.axeSource();
      await io.javascript(id, `${axe.source}\n;true`);
      const started = await evaluate(() => {
        window.aloudAxe = null;
        window.axe.run(document).then(
          (result) => { window.aloudAxe = JSON.stringify({ result }); },
          (error) => { window.aloudAxe = JSON.stringify({ error: String(error && error.message || error) }); });
        return window.axe.version;
      });
      if (started !== axe.version) throw new Error(`Safari ran axe-core ${started}; expected ${axe.version}`);
      let output = null;
      await until(async () => (output = await evaluate(() => window.aloudAxe)) !== null, timeoutMs, `axe scan did not finish within ${timeoutMs}ms`);
      const outcome = JSON.parse(output);
      if (outcome.error) throw new Error(`axe scan failed in Safari: ${outcome.error}`);
      return outcome.result;
    },
  };
  try {
    // The window must answer page scripts before any reader starts.
    if (await evaluate(() => 1) !== 1) throw new Error("Safari JavaScript observation is unavailable");
    // Safari's language comes from the system, not the run; refuse a mismatch
    // instead of recording a locale the page never had.
    const language = await evaluate(() => navigator.language);
    if (locale && String(language).toLowerCase() !== locale.toLowerCase()) {
      throw new Error(`Safari's language is ${language}; set web.locale to match (Safari cannot switch language per run)`);
    }
    if (viewport) await sizeWindow(io, id, evaluate, viewport);
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
  return context;
}

// True when going from `current` to `target` is a same-document fragment
// navigation: the target has a fragment and otherwise matches the current
// URL. Safari keeps the document, as browsers do for in-page links.
export function sameDocumentUrl(current, target) {
  let from, to;
  try { from = new URL(current); to = new URL(target); } catch { return false; }
  if (!to.hash && !target.endsWith("#")) return false;
  from.hash = "";
  to.hash = "";
  return from.href === to.href;
}

// The direct request that stands in for the HTTP status Apple Events cannot
// see. It is bounded by the navigation timeout, so a server that accepts the
// connection and never answers fails the run instead of hanging it. The body
// is not needed and is cancelled.
export async function preflightRequest(io, url, timeoutMs) {
  let response;
  // A held timer, not AbortSignal.timeout: Node 22 unrefs that timer, so a
  // request that holds nothing open could let the process exit before it fires.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), timeoutMs);
  try {
    response = await io.fetch(url, { signal: controller.signal, redirect: "follow" });
  } catch (error) {
    const reason = error?.name === "TimeoutError" ? `no response within ${timeoutMs}ms` : error?.message ?? String(error);
    throw new Error(`Safari capture could not request ${url} from Node to check its status: ${reason}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
  await response.body?.cancel().catch(() => {});
  return { ok: response.ok, status: response.status };
}

// Size the window so the page area matches the viewport: set the outer size,
// measure the page, correct once for the window's chrome, and verify.
async function sizeWindow(io, id, evaluate, { width, height }) {
  const inner = () => evaluate(() => [window.innerWidth, window.innerHeight]);
  await io.setBounds(id, [0, 0, width, height]);
  const [firstWidth, firstHeight] = await inner();
  await io.setBounds(id, [0, 0, width + (width - firstWidth), height + (height - firstHeight)]);
  const [finalWidth, finalHeight] = await inner();
  if (finalWidth !== width || finalHeight !== height) {
    throw new Error(`Safari could not size its page to ${width} × ${height} (got ${finalWidth} × ${finalHeight})`);
  }
}

export const safari = createSafari();
