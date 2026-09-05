(function () {
  const api = typeof browser !== "undefined" ? browser : chrome;
  const FEATURE = "instagram_stories";
  const FEATURES = [
    "instagram_stories",
    "instagram_messages",
    "instagram_typing"
  ];
  const INJECT_URL = api.runtime.getURL("content/instagram-inject.js");

  function recordBlock(feature, url) {
    // The background owns the counters -- it serializes writes so bursts of
    // seen signals from a single story view don't clobber each other.
    try {
      const ret = api.runtime.sendMessage({
        source: "stay-unseen",
        type: "block",
        feature: feature || FEATURE,
        url: url || ""
      });
      if (ret && typeof ret.catch === "function") ret.catch(() => {});
    } catch (err) {}
  }

  function recordCapture(d) {
    api.storage.local.get(["captured_requests"], (r) => {
      const list = (r && r.captured_requests) || [];
      const last = list[0];
      if (
        last &&
        last.url === d.url &&
        last.body === d.body &&
        last.method === (d.method || "GET")
      )
        return;
      list.unshift({
        f: FEATURE,
        url: d.url || "",
        body: d.body || "",
        method: d.method || "GET",
        t: Date.now()
      });
      api.storage.local.set({ captured_requests: list.slice(0, 30) });
    });
  }

  function recordWsCapture(d) {
    api.storage.local.get(["ws_captures"], (r) => {
      const list = (r && r.ws_captures) || [];
      const last = list[0];
      if (last && last.url === d.url && last.snippet === d.snippet) return;
      list.unshift({
        f: FEATURE,
        url: d.url || "",
        snippet: d.snippet || "",
        t: d.t || Date.now()
      });
      api.storage.local.set({ ws_captures: list.slice(0, 20) });
    });
  }

  function recordModuleProbe(d) {
    // Diagnostic only: names the page patch saw and recognised as seen/read
    // shaped, tagged with how it classified them ("" when nothing matched).
    // Deduped and capped -- when Meta renames a module this is the list to read
    // the new name off, instead of guessing at it.
    const name = String(d.name || "").slice(0, 120);
    if (!name) return;
    api.storage.local.get(["module_probes"], (r) => {
      const list = (r && r.module_probes) || [];
      if (list.some((entry) => entry && entry.name === name)) return;
      list.unshift({
        f: FEATURE,
        name,
        kind: String(d.kind || "").slice(0, 24),
        t: d.t || Date.now()
      });
      api.storage.local.set({ module_probes: list.slice(0, 60) });
    });
  }

  function forwardEnabled(feature, enabled) {
    window.postMessage(
      { source: "stay-unseen", type: "set", feature, enabled },
      "*"
    );
  }

  function storageGet(keys, callback) {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      callback(result || {});
    };
    try {
      const result = api.storage.local.get(keys, finish);
      if (result && typeof result.then === "function") {
        result.then(finish, () => finish({}));
      }
    } catch (err) {
      try {
        const result = api.storage.local.get(keys);
        if (result && typeof result.then === "function") {
          result.then(finish, () => finish({}));
        } else {
          finish(result);
        }
      } catch (retryErr) {
        finish({});
      }
    }
  }

  function inject() {
    if (injected) return;
    const root = document.documentElement || document.head;
    if (!root) {
      document.addEventListener("DOMContentLoaded", inject, { once: true });
      return;
    }
    if (root.querySelector("script[data-stay-unseen]")) return;
    const s = document.createElement("script");
    s.dataset.stayUnseen = FEATURE;
    s.src = INJECT_URL;
    s.async = false;
    root.appendChild(s);
    injected = true;
  }

  const enabled = {};
  let injected = false;
  let settingsLoaded = false;
  FEATURES.forEach((feature) => {
    enabled[feature] = true;
  });

  function forwardAllEnabled() {
    if (!settingsLoaded) return;
    FEATURES.forEach((feature) => forwardEnabled(feature, enabled[feature]));
  }

  // Instagram captures fetch/WebSocket and registers modules during its first
  // bootstrap task, so the page-world hook must already be present at
  // document_start. It remains fail-open until this settings read completes.
  storageGet(FEATURES.map((f) => `enabled_${f}`), (r) => {
    FEATURES.forEach((feature) => {
      enabled[feature] =
        r && r[`enabled_${feature}`] !== undefined
          ? r[`enabled_${feature}`] !== false
          : true;
    });
    settingsLoaded = true;
    if (injected) setTimeout(forwardAllEnabled, 0);
  });

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    FEATURES.forEach((feature) => {
      if (changes[`enabled_${feature}`]) {
        enabled[feature] = changes[`enabled_${feature}`].newValue !== false;
        forwardEnabled(feature, enabled[feature]);
      }
    });
  });

  window.addEventListener("message", (e) => {
    // Firefox can expose same-window events through a different WindowProxy
    // (or null) in an isolated content script. The stay-unseen source/type tag
    // below is the protocol guard, so do not compare event.source identities.
    if (!e.data) return;
    const d = e.data;
    if (d.source !== "stay-unseen") return;
    if (d.type === "block") {
      // Forward whatever the page patch attributed the block to. Filtering on
      // FEATURE here used to drop blocks that matched a different feature's
      // body keyword, so the request was blocked but never counted.
      recordBlock(d.feature, d.url);
    } else if (d.type === "capture") {
      recordCapture(d);
    } else if (d.type === "wscapture") {
      recordWsCapture(d);
    } else if (d.type === "moduleprobe") {
      recordModuleProbe(d);
    } else if (d.type === "ready") {
      forwardAllEnabled();
      const data = {};
      FEATURES.forEach((f) => {
        data[`diag_main_${f}`] = true;
      });
      api.storage.local.set(data);
    }
  });

  inject();

  const diag = {};
  FEATURES.forEach((f) => {
    diag[`diag_content_${f}`] = true;
  });
  api.storage.local.set(diag);

})();
