// Render the evidence page (index.html) for one report dir. Pure: takes the
// aggregated screen data and returns an HTML string, so report.mjs keeps the
// IO and the gate, and tests can render without a filesystem.
//
// The page is the artifact adopters forward to their 508 coordinator, so it
// holds itself to the same bar it audits: semantic landmarks, real heading
// order, visible focus, 4.5:1 contrast in light and dark, reduced motion
// respected, and zero external requests (works from file://).

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// Exact wording required above the first audio control on the page.
export const AUDIO_NOTE =
  "Audio is reconstructed: synthesized from the captured transcript, not a recording of the device.";

const speakerFor = (source) =>
  source === "computed-voiceover" ? "Computed VoiceOver" : source === "voiceover" ? "VoiceOver said" : "TalkBack said";

// Display order: failing screens first (most errors first), then everything
// else alphabetically. summary.json keeps the plain sorted order — only the
// page reorders.
export function displayOrder(ids, screens) {
  const failing = ids
    .filter((id) => (screens[id].gate?.errors ?? 0) > 0)
    .sort((a, b) => screens[b].gate.errors - screens[a].gate.errors || a.localeCompare(b));
  const rest = ids.filter((id) => !((screens[id].gate?.errors ?? 0) > 0)).sort();
  return [...failing, ...rest];
}

function statusOf(s) {
  if (!s.gate) return { key: "nodata", label: "No tree check" };
  if (s.gate.errors === 0 && s.source === "voiceover") {
    return { key: "nodata", label: "Review · partial VoiceOver" };
  }
  if (s.gate.errors === 0 && s.appleAudit?.issues.length) {
    return { key: "nodata", label: `Review · ${s.appleAudit.issues.length} Apple finding(s)` };
  }
  return s.gate.errors > 0
    ? { key: "fail", label: `Fail · ${s.gate.errors} error${s.gate.errors === 1 ? "" : "s"}` }
    : { key: "pass", label: "Pass" };
}

function findingsHtml(s) {
  if (!s.gate) return `<p class="none">No tree check in this run.</p>`;
  const items = (s.violations ?? [])
    .map((v) => {
      const sev = v.severity === "error" ? "error" : "warn";
      const sevLabel = sev === "error" ? "Error" : "Warning";
      return `<li class="finding ${sev}">
        <p class="finding-head"><span class="sev sev-${sev}">${sevLabel}</span> <code class="rule">${esc(v.ruleId)}</code> <span class="wcag">WCAG ${esc(v.wcag)}</span></p>
        <p class="finding-detail">${esc(v.detail)}</p>
        ${v.element ? `<code class="el">${esc(v.element)}</code>` : ""}
      </li>`;
    })
    .join("\n");
  return items ? `<ul class="findings">${items}</ul>` : `<p class="none">No findings on this screen.</p>`;
}

function transcriptHtml(s, id, audioEntries, includeAudioNote) {
  const lines = s.transcript ?? [];
  const speaker = speakerFor(s.source);
  const byIndex = new Map((audioEntries ?? []).map((e) => [e.i, e]));
  const coverageNote = s.source === "voiceover"
    ? `<p><strong>Partial traversal:</strong> ${esc(s.voiceOver?.coverage.reason ?? "unknown")}. Capture starts at current focus; it does not prove every element was visited.</p>
      ${s.voiceOver?.steps?.[0]?.utterance === null ? "<p>The initial speech read timed out; the transcript contains only speech returned by subsequent steps.</p>" : ""}
      <p><a href="voiceover/${esc(encodeURIComponent(id))}.json">Raw VoiceOver evidence and toolchain</a></p>` : "";
  const note = coverageNote + (includeAudioNote ? `<p class="audio-note">${esc(AUDIO_NOTE)}</p>` : "");
  if (lines.length === 0) {
    return `<h3 class="speaker">${esc(speaker)}</h3>
      ${note}<p class="none">No speech captured in this run.</p>`;
  }
  const items = lines
    .map((u, idx) => {
      const entry = byIndex.get(idx);
      const btn = entry
        ? ` <button type="button" class="play" data-src="${esc(entry.file)}" aria-label="Play line ${idx + 1} of ${esc(s.title ?? id)}">Play</button>`
        : "";
      return `<li><q class="said">${esc(u)}</q>${btn}</li>`;
    })
    .join("\n");
  return `<h3 class="speaker">${esc(speaker)}${s.source === "computed-voiceover" ? ` <span class="computed-tag">computed, not recorded</span>` : ""}</h3>
    ${note}<ol class="dialogue">${items}</ol>`;
}

function appleAuditHtml(s, id) {
  if (!s.appleAudit) return "";
  const issues = s.appleAudit.issues;
  const items = issues.map((issue) => `<li class="finding warn">
    <p class="finding-head"><span class="sev sev-warn">Review</span> ${esc(issue.types.join(", "))}</p>
    <p class="finding-detail">${esc(issue.compactDescription)}</p>
    ${issue.detailedDescription ? `<p>${esc(issue.detailedDescription)}</p>` : ""}
    ${issue.element ? `<code class="el">${esc(issue.element.label || issue.element.identifier || "Unlabeled element")}</code>` : ""}
  </li>`).join("\n");
  return `<h3>Apple accessibility audit (${issues.length})</h3>
    <p>Completed on this screen. These findings need review; they do not affect the tree-check gate or OpenACR conformance levels.</p>
    ${items ? `<ul class="findings">${items}</ul>` : `<p class="none">Apple reported no issues on this screen.</p>`}
    <p><a href="apple-audit/${esc(encodeURIComponent(id))}.json">Raw Apple audit evidence</a></p>`;
}

const CSS = `
  :root {
    --bg: #f6f5f3; --surface: #ffffff; --ink: #1b1b19; --muted: #5b5852;
    --line: #dcdad5; --accent: #1f6f64; --accent-ink: #175f55;
    --err: #a3251c; --warnc: #8a5a00;
    --badge-fail-bg: #a3251c; --badge-fail-ink: #ffffff;
    --badge-pass-bg: #166534; --badge-pass-ink: #ffffff;
    --badge-nodata-bg: #e5e3de; --badge-nodata-ink: #44423d;
    --bubble: #ffffff; --bubble-line: #dcdad5;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #15171a; --surface: #1d2024; --ink: #e9e7e3; --muted: #a5a19b;
      --line: #33373c; --accent: #58c7b6; --accent-ink: #6ed3c3;
      --err: #ff9089; --warnc: #e8b661;
      --badge-fail-bg: #ff9089; --badge-fail-ink: #1b1b19;
      --badge-pass-bg: #57c274; --badge-pass-ink: #14261a;
      --badge-nodata-bg: #33373c; --badge-nodata-ink: #d5d2cc;
      --bubble: #1d2024; --bubble-line: #3a3f45;
    }
  }
  * { box-sizing: border-box; }
  html { color-scheme: light dark; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Roboto, sans-serif;
  }
  code, .rule, .el, .screen-id, .dialogue li::marker {
    font-family: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
  }
  .wrap { max-width: 68rem; margin: 0 auto; padding: 0 1.25rem; }
  a { color: var(--accent-ink); }
  :focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
  .skip {
    position: absolute; left: -999px; top: 0; background: var(--surface);
    color: var(--ink); padding: .6rem 1rem; z-index: 10; border: 1px solid var(--line);
  }
  .skip:focus { left: .5rem; top: .5rem; }

  header.banner { border-bottom: 1px solid var(--line); padding: 2.5rem 0 2rem; }
  .eyebrow {
    text-transform: uppercase; letter-spacing: .14em; font-size: .75rem;
    color: var(--muted); margin: 0 0 .5rem;
  }
  h1 { font-size: 1.9rem; line-height: 1.2; margin: 0 0 .35rem; letter-spacing: -.015em; }
  .meta { color: var(--muted); margin: 0 0 1.25rem; font-size: .9rem; }
  .stats { display: flex; flex-wrap: wrap; gap: .75rem 2rem; margin: 0; }
  .stats div { margin: 0; }
  .stats dt { font-size: .75rem; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); }
  .stats dd { margin: .1rem 0 0; font-size: 1.45rem; font-weight: 650; font-variant-numeric: tabular-nums; }
  .stats dd.is-fail { color: var(--err); }
  .stats dd.is-pass { color: var(--accent-ink); }
  .callout {
    margin: 1.25rem 0 0; padding: .7rem 1rem; border-left: 4px solid var(--accent);
    background: var(--surface); border-radius: 0 6px 6px 0; font-size: .95rem; max-width: 46rem;
  }

  nav.toc { padding: 1.1rem 0; border-bottom: 1px solid var(--line); }
  nav.toc h2 { font-size: .8rem; text-transform: uppercase; letter-spacing: .12em; color: var(--muted); margin: 0 0 .6rem; }
  nav.toc ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: .5rem; }
  nav.toc a {
    display: inline-flex; align-items: center; gap: .45rem; text-decoration: none;
    color: var(--ink); border: 1px solid var(--line); background: var(--surface);
    border-radius: 999px; padding: .3rem .8rem; font-size: .85rem;
  }
  nav.toc a:hover { border-color: var(--accent); }
  .dot { inline-size: .55rem; block-size: .55rem; border-radius: 50%; flex: none; }
  .dot-fail { background: var(--err); }
  .dot-pass { background: var(--badge-pass-bg); }
  .dot-nodata { background: var(--muted); }

  main { padding-bottom: 3rem; }
  section.screen { border-bottom: 1px solid var(--line); padding: 2.25rem 0; }
  .screen-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: .5rem 1rem; margin-bottom: 1.25rem; }
  h2 { font-size: 1.35rem; margin: 0; letter-spacing: -.01em; }
  .screen-id { color: var(--muted); font-size: .85rem; }
  .badge {
    font-size: .75rem; font-weight: 650; letter-spacing: .05em; text-transform: uppercase;
    border-radius: 4px; padding: .2rem .55rem; white-space: nowrap;
  }
  .badge-fail { background: var(--badge-fail-bg); color: var(--badge-fail-ink); }
  .badge-pass { background: var(--badge-pass-bg); color: var(--badge-pass-ink); }
  .badge-nodata { background: var(--badge-nodata-bg); color: var(--badge-nodata-ink); }

  .cols { display: grid; grid-template-columns: 232px 1fr; gap: 2rem; align-items: start; }
  .cols.no-shot { grid-template-columns: 1fr; }
  @media (max-width: 44rem) { .cols { grid-template-columns: 1fr; } }
  figure.shot { margin: 0; }
  figure.shot img {
    width: 100%; max-width: 232px; height: auto; display: block;
    border: 1px solid var(--line); border-radius: 10px; background: var(--surface);
  }
  figure.shot figcaption { font-size: .8rem; color: var(--muted); margin-top: .4rem; }

  h3 { font-size: 1rem; margin: 1.4rem 0 .6rem; }
  h3:first-child { margin-top: 0; }
  h3.speaker { text-transform: uppercase; letter-spacing: .12em; font-size: .8rem; color: var(--muted); }
  .computed-tag {
    text-transform: none; letter-spacing: 0; font-size: .75rem; font-weight: 650;
    color: var(--accent-ink); border: 1px solid var(--accent); border-radius: 999px;
    padding: .1rem .55rem; margin-left: .35rem; vertical-align: middle;
  }
  ol.dialogue { margin: 0; padding-left: 2.4rem; }
  ol.dialogue li { margin: .45rem 0; }
  ol.dialogue li::marker { color: var(--muted); font-size: .8rem; }
  q.said {
    display: inline-block; font-family: Georgia, "Times New Roman", ui-serif, serif;
    font-size: 1.02rem; background: var(--bubble); border: 1px solid var(--bubble-line);
    border-left: 3px solid var(--accent); border-radius: 2px 8px 8px 2px;
    padding: .35rem .75rem; max-width: 44rem; overflow-wrap: anywhere;
  }
  q.said::before { content: "\\201C"; color: var(--muted); }
  q.said::after { content: "\\201D"; color: var(--muted); }
  .audio-note { color: var(--muted); font-size: .85rem; max-width: 44rem; margin: .4rem 0 .8rem; }
  button.play {
    font-family: inherit; font-size: .78rem; font-weight: 650; line-height: 1;
    color: var(--accent-ink);
    background: transparent; border: 1px solid var(--accent); border-radius: 999px;
    padding: .28rem .7rem; margin-left: .5rem; cursor: pointer; vertical-align: middle;
  }
  button.play:hover { background: var(--surface); }
  button.play[aria-pressed="true"] { background: var(--accent); color: var(--bg); }
  button.play[disabled] { border-color: var(--line); color: var(--muted); cursor: default; }

  ul.findings { list-style: none; margin: 0; padding: 0; }
  ul.findings li.finding {
    background: var(--surface); border: 1px solid var(--line); border-radius: 8px;
    padding: .75rem .9rem; margin: .55rem 0; max-width: 46rem;
  }
  li.finding.error { border-left: 3px solid var(--err); }
  li.finding.warn { border-left: 3px solid var(--warnc); }
  .finding-head { margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: .55rem; }
  .sev { font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
  .sev-error { color: var(--err); }
  .sev-warn { color: var(--warnc); }
  .rule { font-size: .85rem; }
  .wcag { color: var(--muted); font-size: .8rem; }
  .finding-detail { margin: .35rem 0 0; }
  code.el {
    display: block; margin-top: .5rem; font-size: .78rem; color: var(--muted);
    overflow-wrap: anywhere;
  }
  .none { color: var(--muted); }

  footer { border-top: 1px solid var(--line); color: var(--muted); font-size: .85rem; padding: 1.25rem 0 2.5rem; }
  footer p { margin: .25rem 0; }

  @media (prefers-reduced-motion: no-preference) {
    html { scroll-behavior: smooth; }
    nav.toc a, button.play { transition: border-color .15s ease, background-color .15s ease; }
  }
  @media print {
    nav.toc, button.play { display: none; }
    section.screen { break-inside: avoid; }
  }
`;

// One shared Audio element drives every play button. Injected only when the
// page has audio controls.
const AUDIO_JS = `
  (function () {
    var player = new Audio();
    var current = null;
    function reset(btn) {
      if (!btn) return;
      btn.textContent = "Play";
      btn.setAttribute("aria-pressed", "false");
      btn.setAttribute("aria-label", btn.getAttribute("aria-label").replace(/^Stop/, "Play"));
    }
    player.addEventListener("ended", function () { reset(current); current = null; });
    player.addEventListener("error", function () {
      if (!current) return;
      current.textContent = "Audio unavailable";
      current.disabled = true;
      current = null;
    });
    document.querySelectorAll("button.play").forEach(function (btn) {
      btn.setAttribute("aria-pressed", "false");
      btn.addEventListener("click", function () {
        if (current === btn) {
          player.pause();
          player.currentTime = 0;
          reset(btn);
          current = null;
          return;
        }
        if (current) reset(current);
        current = btn;
        btn.textContent = "Stop";
        btn.setAttribute("aria-pressed", "true");
        btn.setAttribute("aria-label", btn.getAttribute("aria-label").replace(/^Play/, "Stop"));
        player.src = btn.getAttribute("data-src");
        player.play().catch(function () {
          reset(btn);
          if (current === btn) current = null;
        });
      });
    });
  })();
`;

/**
 * @param {object} p
 * @param {Record<string, object>} p.screens  aggregated per-screen data
 * @param {string[]} p.ids                   sorted screen ids
 * @param {string} p.generated               ISO timestamp
 * @param {Set<string>} p.shots              ids that have shots/<id>.png
 * @param {Record<string, Array<{i:number,file:string,text?:string}>>|null} p.audioManifest
 */
export function renderReportHtml({ screens, ids, generated, shots, audioManifest }) {
  const order = displayOrder(ids, screens);
  const hasComputed = order.some((id) => screens[id].source === "computed-voiceover");
  const hasVoiceOver = order.some((id) => screens[id].source === "voiceover");
  const isIosLeg = hasComputed || hasVoiceOver;

  const withGate = order.filter((id) => screens[id].gate);
  const failCount = withGate.filter((id) => screens[id].gate.errors > 0).length;
  const passCount = withGate.length - failCount;
  const errorTotal = withGate.reduce((n, id) => n + screens[id].gate.errors, 0);
  const warnTotal = order.reduce(
    (n, id) => n + (screens[id].violations?.filter((v) => v.severity === "warn").length ?? 0),
    0,
  );

  const appleIssueTotal = order.reduce((n, id) => n + (screens[id].appleAudit?.issues.length ?? 0), 0);
  const hasAppleAudit = order.some((id) => screens[id].appleAudit);
  const legLabel = isIosLeg ? (hasVoiceOver ? "iOS · VoiceOver evidence" : "iOS · Computed VoiceOver") : "Android · TalkBack";
  const legNote = (hasComputed
    ? `<p class="callout"><strong>Honest label:</strong> Transcripts labeled Computed VoiceOver are computed from the accessibility tree, not spoken by a device. Real speech can differ slightly.</p>`
    : "") + (hasVoiceOver ? `<p class="callout"><strong>Partial VoiceOver capture:</strong> These utterances come from Apple's VoiceOver service. Complete traversal has not been established. Tree checks are separate; partial speech cannot pass the audit gate.</p>` : "");

  // The reconstructed-audio note goes directly above the first audio control
  // on the page, in display order.
  const hasAudio = (id) => {
    const entries = audioManifest?.[id];
    if (!entries?.length) return false;
    const len = screens[id].transcript?.length ?? 0;
    return entries.some((e) => Number.isInteger(e.i) && e.i >= 0 && e.i < len);
  };
  const firstAudioId = audioManifest ? order.find(hasAudio) : undefined;
  const anyAudio = firstAudioId !== undefined;

  const toc = order
    .map((id) => {
      const st = statusOf(screens[id]);
      const dot = st.key === "fail" ? "dot-fail" : st.key === "pass" ? "dot-pass" : "dot-nodata";
      return `<li><a href="#screen-${esc(id)}"><span class="dot ${dot}" aria-hidden="true"></span>${esc(screens[id].title ?? id)}</a></li>`;
    })
    .join("\n");

  const sections = order
    .map((id) => {
      const s = screens[id];
      const st = statusOf(s);
      const hasShot = shots.has(id);
      const shot = hasShot
        ? `<figure class="shot">
        <img src="shots/${esc(encodeURIComponent(id))}.png" alt="Screenshot of the ${esc(s.title ?? id)} screen as audited" loading="lazy">
        <figcaption>As captured during the tree pass.</figcaption>
      </figure>`
        : "";
      return `<section class="screen" id="screen-${esc(id)}" aria-labelledby="h-${esc(id)}">
    <div class="screen-head">
      <h2 id="h-${esc(id)}">${esc(s.title ?? id)}</h2>
      <span class="screen-id">${esc(id)}</span>
      <span class="badge badge-${st.key}">${esc(st.label)}</span>
    </div>
    <div class="cols${hasShot ? "" : " no-shot"}">
      ${shot}
      <div>
        ${transcriptHtml(s, id, audioManifest?.[id], id === firstAudioId)}
        <h3>Findings (${s.violations?.length ?? 0})</h3>
        ${findingsHtml(s)}
        ${appleAuditHtml(s, id)}
      </div>
    </div>
  </section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>aloud 508 evidence — ${esc(legLabel)}</title>
<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#main">Skip to screens</a>
<header class="banner">
  <div class="wrap">
    <p class="eyebrow">aloud · Section 508 evidence</p>
    <h1>${esc(legLabel)}</h1>
    <p class="meta">${order.length} screen${order.length === 1 ? "" : "s"} · generated ${esc(generated)}</p>
    <dl class="stats">
      <div><dt>Screens</dt><dd>${order.length}</dd></div>
      <div><dt>${hasAppleAudit || hasVoiceOver ? "Tree pass" : "Pass"}</dt><dd class="is-pass">${passCount}</dd></div>
      <div><dt>${hasAppleAudit || hasVoiceOver ? "Tree fail" : "Fail"}</dt><dd${failCount ? ` class="is-fail"` : ""}>${failCount}</dd></div>
      <div><dt>Errors</dt><dd${errorTotal ? ` class="is-fail"` : ""}>${errorTotal}</dd></div>
      <div><dt>Warnings</dt><dd>${warnTotal}</dd></div>
      ${hasAppleAudit ? `<div><dt>Apple findings to review</dt><dd>${appleIssueTotal}</dd></div>` : ""}
    </dl>
    ${legNote}
  </div>
</header>
<nav class="toc" aria-label="Screens">
  <div class="wrap">
    <h2>Jump to a screen</h2>
    <ul>${toc}</ul>
  </div>
</nav>
<main id="main" class="wrap">
${sections}
</main>
<footer>
  <div class="wrap">
    <p>Generated by the aloud audit tool. Failing screens sort first.</p>
    <p>The transcript shows what the screen reader spoke, in order. Findings come from the accessibility tree checks.</p>
  </div>
</footer>
${anyAudio ? `<script>${AUDIO_JS}</script>` : ""}
</body>
</html>
`;
}
