(function () {
  const api = typeof browser !== "undefined" ? browser : chrome;
  const FEATURES = [
    "facebook_stories",
    "facebook_messages",
    "facebook_typing"
  ];
  const SITE_FEATURES = /(^|\.)messenger\.com$/i.test(
    String(window.location && window.location.hostname)
  )
    ? ["facebook_messages", "facebook_typing"]
    : FEATURES;
  const INJECT_URL = api.runtime.getURL("content/facebook-inject.js");

  function recordBlock(feature, url) {
    // The background owns the counters -- it serializes writes so bursts of
    // seen signals don't clobber each other.
    try {
      const ret = api.runtime.sendMessage({
        source: "stay-unseen",
        type: "block",
        feature,
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
        f: d.feature || "facebook",
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
        f: "facebook",
        url: d.url || "",
        snippet: d.snippet || "",
        t: d.t || Date.now()
      });
      api.storage.local.set({ ws_captures: list.slice(0, 20) });
    });
  }

  function recordBridgeCapture(d) {
    // Diagnostic only: worker-bridge traffic around sends and receipts --
    // what crossed, and what the inspector did with it (forwarded / dropped
    // / stripped). The snippet is user-text-stripped and capped before it
    // leaves the page patch.
    api.storage.local.get(["bridge_captures"], (r) => {
      const list = (r && r.bridge_captures) || [];
      const last = list[0];
      if (
        last &&
        last.snippet === d.snippet &&
        last.action === (d.action || "forwarded")
      )
        return;
      list.unshift({
        f: "facebook",
        action: d.action || "forwarded",
        snippet: String(d.snippet || "").slice(0, 400),
        t: d.t || Date.now()
      });
      api.storage.local.set({ bridge_captures: list.slice(0, 20) });
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
        f: "facebook",
        name,
        kind: String(d.kind || "").slice(0, 24),
        t: d.t || Date.now()
      });
      api.storage.local.set({ module_probes: list.slice(0, 60) });
    });
  }

  function recordModuleFire(d) {
    // Diagnostic only: WHICH wrapped export or hook actually fired, and when.
    // The block counters fold firings into anonymous counts, which hid the
    // module breaking a group send behind a "13x module-export" row. Not
    // deduped by name -- the sequence and the timestamps are the point.
    const name = String(d.name || "").slice(0, 120);
    if (!name) return;
    api.storage.local.get(["module_fires"], (r) => {
      const list = (r && r.module_fires) || [];
      const last = list[0];
      if (
        last &&
        last.name === name &&
        last.action === String(d.action || "") &&
        Date.now() - (last.t || 0) < 2000
      )
        return;
      list.unshift({
        f: "facebook",
        name,
        action: String(d.action || "").slice(0, 24),
        t: d.t || Date.now()
      });
      api.storage.local.set({ module_fires: list.slice(0, 40) });
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
    s.dataset.stayUnseen = "facebook";
    s.src = INJECT_URL;
    s.async = false;
    root.appendChild(s);
    injected = true;
  }

  const enabled = {};
  let injected = false;
  FEATURES.forEach((feature) => {
    enabled[feature] = true;
  });

  function forwardAllEnabled() {
    FEATURES.forEach((feature) => forwardEnabled(feature, enabled[feature]));
  }

  function maybeInject() {
    if (!SITE_FEATURES.some((feature) => enabled[feature])) return;
    const wasInjected = injected;
    inject();
    if (!wasInjected && injected) setTimeout(forwardAllEnabled, 0);
  }

  // The page-world patch is deliberately not installed for an all-off setup.
  // Its hooks alter Web APIs and Meta's module loader; even when every wrapper
  // would call through, installing them during chat bootstrap can prevent the
  // Messenger shell from hydrating. Load all settings first, then opt in.
  storageGet(FEATURES.map((f) => `enabled_${f}`), (r) => {
    FEATURES.forEach((feature) => {
      enabled[feature] =
        r && r[`enabled_${feature}`] !== undefined
          ? r[`enabled_${feature}`] !== false
          : true;
    });
    maybeInject();
    if (injected) {
      // The main-world script posts `ready` as soon as it starts. This delayed
      // send also covers browsers that execute an extension resource before
      // the ready message crosses realms.
      setTimeout(forwardAllEnabled, 0);
    }
  });

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    FEATURES.forEach((feature) => {
      if (changes[`enabled_${feature}`]) {
        enabled[feature] = changes[`enabled_${feature}`].newValue !== false;
        maybeInject();
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
    if (d.type === "block" && FEATURES.includes(d.feature)) {
      recordBlock(d.feature, d.url);
    } else if (d.type === "capture") {
      recordCapture(d);
    } else if (d.type === "wscapture") {
      recordWsCapture(d);
    } else if (d.type === "bridgecapture") {
      recordBridgeCapture(d);
    } else if (d.type === "moduleprobe") {
      recordModuleProbe(d);
    } else if (d.type === "modulefire") {
      recordModuleFire(d);
    } else if (d.type === "ready") {
      forwardAllEnabled();
      const data = {};
      FEATURES.forEach((f) => {
        data[`diag_main_${f}`] = true;
      });
      api.storage.local.set(data);
    }
  });

  const diag = {};
  FEATURES.forEach((f) => {
    diag[`diag_content_${f}`] = true;
  });
  api.storage.local.set(diag);

})();
