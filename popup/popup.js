(function () {
  const api = typeof browser !== "undefined" ? browser : chrome;

  const isFirefox = /Firefox/.test(navigator.userAgent);

  // Insertion order is the order of the Features list. Grouped by site here,
  // unlike background.js -- there the array order fixes the DNR rule ids, so
  // the typing features had to be appended instead.
  const FEATURES = {
    instagram_stories: "Instagram Stories",
    instagram_messages: "Instagram DMs",
    instagram_typing: "Instagram typing",
    facebook_stories: "Facebook Stories",
    facebook_messages: "Facebook Messages",
    facebook_typing: "Messenger typing"
  };

  const HINTS = {
    instagram_stories: "Hide your story views",
    instagram_messages: "No read receipts sent",
    instagram_typing: "No “typing…” shown to others",
    facebook_stories: "Hide your story views",
    facebook_messages: "No read receipts sent",
    facebook_typing: "No “typing…” shown to others"
  };

  const STORY_FEATURES = ["instagram_stories", "facebook_stories"];
  const MESSAGE_FEATURES = ["instagram_messages", "facebook_messages"];
  const TYPING_FEATURES = ["instagram_typing", "facebook_typing"];

  // Display preferences, not blocking features: nothing is counted and no
  // network rule depends on them, so they get their own list. The keys are
  // deliberately not prefixed enabled_ -- background.js resyncs the whole DNR
  // ruleset whenever an enabled_* key changes, and these have nothing to do
  // with network rules.
  const OPTIONS = {
    ui_keep_unread_marker: {
      label: "Keep unread in the UI",
      hint: "Accent dot on stories and chats opened while blocking was on, until you reload"
    }
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function clock(ts) {
    const d = new Date(ts);
    return (
      String(d.getHours()).padStart(2, "0") +
      ":" +
      String(d.getMinutes()).padStart(2, "0") +
      ":" +
      String(d.getSeconds()).padStart(2, "0")
    );
  }

  function ago(ts) {
    if (!ts) return "never";
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 45) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch (err) {
      return url || "";
    }
  }

  // Every list shares the same time-then-detail row, so the only thing that
  // varies per list is what goes in the detail column.
  function logRow(ts, buildWhat) {
    const li = document.createElement("li");
    const time = document.createElement("time");
    if (ts) {
      time.dateTime = new Date(ts).toISOString();
      time.textContent = clock(ts);
    }
    li.appendChild(time);
    const what = el("div", "what");
    buildWhat(what);
    li.appendChild(what);
    return li;
  }

  function fillList(node, pill, items, emptyText, buildWhat) {
    if (!node) return;
    node.textContent = "";
    if (pill) pill.textContent = String(items.length);
    if (!items.length) {
      node.appendChild(el("li", "empty", emptyText));
      return;
    }
    items.forEach((entry) => {
      node.appendChild(logRow(entry.t, (what) => buildWhat(what, entry)));
    });
  }

  // Both lists use the same control; only the key it writes differs.
  function switchFor(id, on, srLabel, onChange) {
    const label = el("label", "switch");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = id;
    input.checked = on;
    input.addEventListener("change", () => onChange(input.checked));
    const track = el("span", "track");
    track.setAttribute("aria-hidden", "true");
    track.appendChild(el("span", "knob"));
    label.appendChild(input);
    label.appendChild(track);
    label.appendChild(el("span", "sr", srLabel));
    return label;
  }

  function renderFeatures(data) {
    const list = document.getElementById("features");
    if (!list) return;
    list.textContent = "";

    Object.keys(FEATURES).forEach((f) => {
      const on = data[`enabled_${f}`] !== false;
      const count = data[`count_${f}`] || 0;

      const row = el("li", "feature" + (on ? "" : " off"));

      const left = el("div");
      const name = el("div", "fname");
      name.appendChild(el("span", null, FEATURES[f]));
      const badge = el("span", "fcount" + (count ? "" : " zero"), String(count));
      badge.title = count ? "Blocked " + count + " times" : "Nothing blocked yet";
      name.appendChild(badge);
      left.appendChild(name);
      left.appendChild(el("p", "fhint", HINTS[f]));
      row.appendChild(left);

      row.appendChild(
        switchFor(`t-${f}`, on, "Block " + FEATURES[f], (checked) => {
          api.storage.local.set({ [`enabled_${f}`]: checked });
        })
      );

      list.appendChild(row);
    });
  }

  function renderOptions(data) {
    const list = document.getElementById("options");
    if (!list) return;
    list.textContent = "";

    Object.keys(OPTIONS).forEach((key) => {
      const on = data[key] !== false;
      const row = el("li", "feature" + (on ? "" : " off"));

      const left = el("div");
      const name = el("div", "fname");
      name.appendChild(el("span", null, OPTIONS[key].label));
      left.appendChild(name);
      left.appendChild(el("p", "fhint", OPTIONS[key].hint));
      row.appendChild(left);

      row.appendChild(
        switchFor(`t-${key}`, on, OPTIONS[key].label, (checked) => {
          api.storage.local.set({ [key]: checked });
        })
      );

      list.appendChild(row);
    });
  }

  function renderTiles(data) {
    const sum = (keys) =>
      keys.reduce((acc, f) => acc + (data[`count_${f}`] || 0), 0);

    const total = sum(Object.keys(FEATURES));
    const totalEl = document.getElementById("total");
    if (totalEl) totalEl.textContent = String(total);

    const storiesEl = document.getElementById("statStories");
    if (storiesEl) storiesEl.textContent = String(sum(STORY_FEATURES));

    const messagesEl = document.getElementById("statMessages");
    if (messagesEl) messagesEl.textContent = String(sum(MESSAGE_FEATURES));

    const typingEl = document.getElementById("statTyping");
    if (typingEl) typingEl.textContent = String(sum(TYPING_FEATURES));

    const anyOn = Object.keys(FEATURES).some(
      (f) => data[`enabled_${f}`] !== false
    );
    const status = document.getElementById("status");
    if (status) {
      status.textContent = anyOn
        ? "Protecting Instagram, Facebook & Messenger"
        : "Paused — receipts are being sent";
      status.className = "status " + (anyOn ? "on" : "off");
    }
  }

  function renderStatus(data) {
    Object.keys(FEATURES).forEach((f) => {
      const diag = document.getElementById(`d-${f}`);
      if (!diag) return;
      const wr = data[`diag_wr_${f}`] || 0;
      const pm = data[`diag_pm_${f}`] || 0;
      let label;
      let cls = "";
      if (data[`diag_main_${f}`]) {
        label = `active (wr:${wr} pm:${pm})`;
        cls = "ok";
      } else if (data[`diag_content_${f}`]) {
        label = `pending (wr:${wr} pm:${pm})`;
        cls = "warn";
      } else {
        label = `not detected (wr:${wr} pm:${pm})`;
      }
      diag.textContent = label;
      diag.className = cls;
    });

    const network = document.getElementById("network");
    if (network) {
      network.textContent = isFirefox ? "active (webRequest)" : "active (DNR)";
      network.className = "ok";
    }

    // The marker script sets diag_ui_marker the first time it runs anywhere, so
    // "not detected" here means it has never loaded -- distinct from loaded but
    // switched off.
    const marker = document.getElementById("d-ui_marker");
    if (marker) {
      const loadedOnce = !!data.diag_ui_marker;
      const on = data.ui_keep_unread_marker !== false;
      marker.textContent = !loadedOnce ? "not detected" : on ? "active" : "off";
      marker.className = loadedOnce ? (on ? "ok" : "warn") : "";
    }

    const loaded = Object.keys(FEATURES).filter((f) => data[`diag_content_${f}`]);
    const site = document.getElementById("site");
    if (site) {
      site.textContent = loaded.length ? loaded.join(", ") : "none";
      site.className = loaded.length ? "ok" : "";
    }

    // The summary pill mirrors the site row so the drawer can stay closed:
    // "is it actually running here?" is answerable without expanding it.
    const pill = document.getElementById("sitePill");
    if (pill) {
      const active = Object.keys(FEATURES).some((f) => data[`diag_main_${f}`]);
      pill.textContent = active ? "active" : loaded.length ? "pending" : "none";
      pill.className = "pill" + (active ? " ok" : loaded.length ? " warn" : "");
    }

    const diagLine = document.getElementById("diag");
    if (diagLine) {
      if (loaded.length) {
        diagLine.hidden = true;
      } else {
        diagLine.hidden = false;
        diagLine.className = "diag warn";
        diagLine.textContent =
          "Not active on this tab — reload the page so the patch loads before Meta’s code.";
      }
    }
  }

  // Verification lists stay collapsed unless asked for. Kept in storage rather
  // than popup-local state so it survives the popup closing; ui_ prefixed like
  // the display options so background.js does not resync the DNR ruleset for it.
  const DIAG_KEY = "ui_show_diagnostics";

  function renderDiagnostics(data) {
    const panel = document.getElementById("diagnostics");
    const btn = document.getElementById("diagToggle");
    if (!panel || !btn) return;
    const on = data[DIAG_KEY] === true;
    panel.hidden = !on;
    btn.textContent = on ? "Hide diagnostics" : "Show diagnostics";
    btn.setAttribute("aria-expanded", on ? "true" : "false");
  }

  function renderLists(data) {
    const recent = Array.isArray(data.recent_blocks)
      ? data.recent_blocks.slice(0, 20)
      : [];
    fillList(
      document.getElementById("recent"),
      document.getElementById("recentCount"),
      recent,
      "No blocks recorded yet.",
      (what, b) => {
        what.appendChild(el("span", "tag blocked", "blocked "));
        what.appendChild(document.createTextNode(FEATURES[b.f] || b.f));
        // One action trips several suppressions at once, and they count as one
        // block. Show how many signals it stood for so the number is checkable
        // rather than just smaller.
        const host = hostOf(b.url);
        what.appendChild(
          el("div", "meta", b.n > 1 ? host + " — " + b.n + " signals" : host)
        );
      }
    );

    const captured = Array.isArray(data.captured_requests)
      ? data.captured_requests.slice(0, 20)
      : [];
    fillList(
      document.getElementById("captured"),
      document.getElementById("capturedCount"),
      captured,
      "Nothing captured. Reload IG/FB and view a story or open a chat.",
      (what, b) => {
        what.appendChild(el("span", "tag seen", (b.method || "GET") + " "));
        what.appendChild(document.createTextNode(hostOf(b.url)));
        if (b.body) what.appendChild(el("span", "body", b.body));
      }
    );

    const ws = Array.isArray(data.ws_captures)
      ? data.ws_captures.slice(0, 20)
      : [];
    fillList(
      document.getElementById("wscaptured"),
      document.getElementById("wsCount"),
      ws,
      "No websocket frames captured.",
      (what, b) => {
        what.appendChild(el("span", "tag frame", "frame "));
        what.appendChild(document.createTextNode(hostOf(b.url)));
        if (b.snippet) what.appendChild(el("span", "body", b.snippet));
      }
    );

    const bridge = Array.isArray(data.bridge_captures)
      ? data.bridge_captures.slice(0, 20)
      : [];
    fillList(
      document.getElementById("bridgecaptured"),
      document.getElementById("bridgeCount"),
      bridge,
      "Nothing captured. Reload the page, then send a message.",
      (what, b) => {
        const tag =
          b.action === "dropped"
            ? "blocked"
            : b.action === "stripped"
              ? "seen"
              : "frame";
        what.appendChild(el("span", "tag " + tag, (b.action || "forwarded") + " "));
        if (b.snippet) what.appendChild(el("span", "body", b.snippet));
      }
    );

    const ig = Array.isArray(data.ig_requests) ? data.ig_requests.slice(0, 20) : [];
    fillList(
      document.getElementById("ignet"),
      document.getElementById("ignetCount"),
      ig,
      "Nothing logged. Reload IG and view a story.",
      (what, b) => {
        let host = "";
        let path = "";
        try {
          const u = new URL(b.url);
          host = u.hostname;
          path = u.pathname;
        } catch (err) {}
        what.appendChild(el("span", "tag seen", (b.m || "GET") + " "));
        what.appendChild(document.createTextNode(host + path));
      }
    );

    const probes = Array.isArray(data.module_probes)
      ? data.module_probes.slice(0, 60)
      : [];
    fillList(
      document.getElementById("probes"),
      document.getElementById("probeCount"),
      probes,
      "Nothing seen yet. Reload IG/FB and view a story or open a chat.",
      (what, b) => {
        // The kind is the useful column: "story"/"storyHook"/"read" means the
        // patch is touching it, an empty kind means it slipped through.
        what.appendChild(el("span", "tag frame", (b.kind || "no match") + " "));
        what.appendChild(document.createTextNode(b.name || ""));
      }
    );
  }

  function render() {
    const keys = [
      ...Object.keys(FEATURES).flatMap((f) => [
        `enabled_${f}`,
        `count_${f}`,
        `diag_main_${f}`,
        `diag_content_${f}`,
        `diag_wr_${f}`,
        `diag_pm_${f}`
      ]),
      "recent_blocks",
      "captured_requests",
      "ws_captures",
      "bridge_captures",
      "ig_requests",
      "module_probes",
      ...Object.keys(OPTIONS),
      "diag_ui_marker",
      DIAG_KEY
    ];

    api.storage.local.get(keys, (r) => {
      const data = r || {};
      renderTiles(data);
      renderFeatures(data);
      renderOptions(data);
      renderStatus(data);
      renderDiagnostics(data);
      renderLists(data);
    });
  }

  const resetBtn = document.getElementById("reset");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      const keys = Object.keys(FEATURES).map((f) => `count_${f}`);
      keys.push(
        "recent_blocks",
        "captured_requests",
        "ws_captures",
        "bridge_captures",
        "ig_requests",
        "module_probes",
        // Without this the first block after a reset lands inside the old
        // coalescing window and is swallowed.
        "count_gate"
      );
      api.storage.local.remove(keys, render);
    });
  }

  const refreshBtn = document.getElementById("refresh");
  if (refreshBtn) {
    // Inside a <details><summary>, a click would toggle the drawer shut.
    refreshBtn.addEventListener("click", (e) => {
      e.preventDefault();
      render();
    });
  }

  const diagToggle = document.getElementById("diagToggle");
  if (diagToggle) {
    diagToggle.addEventListener("click", () => {
      const panel = document.getElementById("diagnostics");
      const next = panel ? panel.hidden : true;
      // Flip now so the click feels immediate, then persist -- the storage
      // change fires render() again and lands on the same state.
      renderDiagnostics({ [DIAG_KEY]: next });
      api.storage.local.set({ [DIAG_KEY]: next });
    });
  }

  // One text blob with everything a bug report needs: feature toggles, patch
  // status, counters, and the diagnostics lists. Far easier to paste than to
  // walk five drawers, and the lists are already body-snippet-only (the page
  // patch strips user text before persisting them).
  const copyDiagBtn = document.getElementById("copyDiag");
  if (copyDiagBtn) {
    copyDiagBtn.addEventListener("click", () => {
      const keys = [
        ...Object.keys(FEATURES).flatMap((f) => [
          `enabled_${f}`,
          `count_${f}`,
          `diag_main_${f}`,
          `diag_content_${f}`,
          `diag_wr_${f}`,
          `diag_pm_${f}`
        ]),
      "recent_blocks",
      "captured_requests",
      "ws_captures",
      "bridge_captures",
      "ig_requests",
      "module_probes",
      "module_fires",
      ...Object.keys(OPTIONS),
      "diag_ui_marker"
    ];
      api.storage.local.get(keys, (r) => {
        const data = r || {};
        const manifest = api.runtime.getManifest();
        const lines = [];
        lines.push("Stay Unseen diagnostics v" + (manifest.version || ""));
        lines.push(
          "browser: " + (isFirefox ? "Firefox" : "Chromium") + "  " + new Date().toISOString()
        );
        lines.push("");
        lines.push("features (enabled / blocked count / patch detected):");
        for (const f of Object.keys(FEATURES)) {
          lines.push(
            "  " +
              f +
              ": " +
              (data["enabled_" + f] !== false ? "on" : "off") +
              " / " +
              (data["count_" + f] || 0) +
              (data["diag_main_" + f]
                ? " / main+content"
                : data["diag_content_" + f]
                  ? " / content"
                  : " / none")
          );
        }
        const list = (label, items, fmt) => {
          lines.push("");
          lines.push(label + " (" + (items ? items.length : 0) + "):");
          if (items && items.length) items.forEach((b) => lines.push("  " + fmt(b)));
        };
        list("recent blocks", data.recent_blocks, (b) =>
          [clock(b.t), b.f, b.s || "", (b.n || 1) + "x", hostOf(b.url)].join(" ")
        );
        list("seen signals detected", data.captured_requests, (b) =>
          [clock(b.t), b.method || "GET", b.url, b.body || ""].join(" ")
        );
        list("websocket frames", data.ws_captures, (b) =>
          [clock(b.t), b.url, b.snippet || ""].join(" ")
        );
        list("worker bridge frames", data.bridge_captures, (b) =>
          [clock(b.t), b.action || "forwarded", b.snippet || ""].join(" ")
        );
        list("ig requests", data.ig_requests, (b) =>
          [clock(b.t), b.m || "GET", b.type || "", b.url].join(" ")
        );
        list("seen/read modules", data.module_probes, (b) =>
          [clock(b.t), b.kind || "no-match", b.name].join(" ")
        );
        list("module firings (wrapped exports/hooks that ran)", data.module_fires, (b) =>
          [clock(b.t), b.action || "", b.name].join(" ")
        );
        const text = lines.join("\n");
        const done = () => {
          copyDiagBtn.textContent = "Copied";
          setTimeout(() => (copyDiagBtn.textContent = "Copy diagnostics"), 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, () => {});
        }
      });
    });
  }

  const versionEl = document.getElementById("version");
  if (versionEl) {
    const manifest = api.runtime.getManifest();
    versionEl.textContent = "Stay Unseen v" + (manifest.version || "");
  }

  api.storage.onChanged.addListener((changes, area) => {
    if (area === "local") render();
  });

  render();
})();
