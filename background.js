const api = typeof browser !== "undefined" ? browser : chrome;

const FEATURES = [
  "instagram_stories",
  "instagram_messages",
  "facebook_stories",
  "facebook_messages",
  // Appended rather than grouped by site so the DNR rule ids of the original
  // four don't shift (id = 100 + featureIndex*10 + patternIndex).
  "instagram_typing",
  "facebook_typing"
];

const isFirefox =
  typeof navigator !== "undefined" && /Firefox/.test(navigator.userAgent);

const URL_PATTERNS = {
  instagram_stories: [
    /media_seen/i,
    /reels?[\/_]seen/i,
    /stor(?:y|ies)[\/_]seen/i,
    /seen[\/_](?:stor(?:y|ies)|reels?)/i,
    /media\/\d+\/seen/i
  ],
  // Instagram DM read receipts. The REST endpoint is /direct_v2/threads/<id>/items/<id>/seen/
  instagram_messages: [
    /direct_v2\/threads\/[^\/]+\/items\/[^\/]+\/seen/i,
    /direct_v2\/threads\/[^\/]+\/mark_seen/i,
    /direct_v2\/[^\/]*mark[_-]?seen/i
  ],
  facebook_messages: [
    // Facebook/Messenger chat bootstrap URLs reuse read-status words. Leave
    // this feature to the main-world body/module classifier, which can tell a
    // receipt write from a conversation load.
  ],
  facebook_stories: [
    /story_seen|seen_story|mark_story_seen/i,
    /story\/seen|stories\/seen/i,
    /(?:stories|story|reel)[\/_](?:seen|view)/i
  ],
  // Typing indicators. Instagram's REST path is
  // /direct_v2/threads/broadcast/typing/ carrying activity_status=1; the web
  // client also posts indicate_activity. The bulk of IG typing traffic is not
  // here at all -- it rides the DM websocket, which only the page patch sees.
  instagram_typing: [
    /direct_v2\/threads\/broadcast\/typing/i,
    /direct_v2\/threads\/[^\/]+\/typing/i,
    /indicate_activity/i
  ],
  // typ.php moved here out of facebook_messages: it is the typing endpoint, not
  // a read receipt, so counting it as a message block was wrong and the
  // facebook_messages toggle was silently controlling typing too.
  facebook_typing: [
    /ajax\/(?:messaging|chat|mercury)\/typ\.php/i,
    /typ\.php/i,
    /orca_typing_notifications/i,
    /thread_typing/i
  ]
};

// Seen signals only ever travel as xhr/fetch, beacons, or websocket frames.
// Blocking main_frame/script/image here could cancel a page navigation or an
// asset whose URL merely contains "stories".
const BLOCKABLE_TYPES = ["xmlhttprequest", "ping", "csp_report", "websocket", "other"];

const HOST_FILTER = {
  urls: [
    "*://*.instagram.com/*",
    "*://instagram.com/*",
    "*://*.facebook.com/*",
    "*://facebook.com/*",
    "*://*.messenger.com/*",
    "*://messenger.com/*"
  ],
  types: BLOCKABLE_TYPES
};

const enabled = {};
// Keep the network layer inert until persisted settings have been loaded.
// Starting enabled can cancel chat bootstrap requests while an all-off
// configuration is still being read from storage.
FEATURES.forEach((f) => (enabled[f] = false));

// Features are scoped to the site they belong to. The facebook_stories URL
// pattern is deliberately loose ("(seen|view).*(story|reel)"), which matches
// plenty of ordinary Instagram GraphQL URLs -- without this scoping those get
// cancelled and the profile grid never loads.
const HOST_FEATURES = {
  instagram: ["instagram_stories", "instagram_messages", "instagram_typing"],
  facebook: ["facebook_stories", "facebook_messages", "facebook_typing"],
  // Messenger does not expose Facebook's story tray, and its chat endpoints
  // reuse generic `mark_seen` URL fragments. Treating those as story writes is
  // enough to cancel chat hydration before the page can inspect the payload.
  messenger: ["facebook_messages", "facebook_typing"]
};

function featuresForUrl(url) {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch (err) {
    return [];
  }
  if (/(^|\.)instagram\.com$/i.test(host)) return HOST_FEATURES.instagram;
  if (/(^|\.)messenger\.com$/i.test(host)) return HOST_FEATURES.messenger;
  if (/(^|\.)facebook\.com$/i.test(host)) return HOST_FEATURES.facebook;
  return [];
}

// Read endpoints that load the profile grid, feed and media. Cancelling one
// of these at the network layer leaves the profile spinner turning forever,
// so they are checked before any pattern match.
const NEVER_BLOCK_URL = [
  /\/api\/v1\/feed\//i,
  /\/api\/v1\/users\/[^\/]+\/info/i,
  /\/api\/v1\/media\/[^\/]+\/info/i,
  // DM reads -- these sit next to the seen endpoint under direct_v2.
  /direct_v2\/inbox/i,
  /direct_v2\/pending_inbox/i,
  /direct_v2\/threads\/[^\/]+\/?(?:\?|$)/i,
  /direct_v2\/get_presence/i,
  /direct_v2\/threads\/[^\/]+\/items\/?(?:\?|$)/i,
  /PolarisProfile/i,
  /PolarisFeed/i,
  /ProfilePosts/i,
  /ProfileTimeline/i
];

function matchFeature(url) {
  if (typeof url !== "string") return null;
  for (const p of NEVER_BLOCK_URL) {
    if (p.test(url)) return null;
  }
  for (const f of featuresForUrl(url)) {
    if (!enabled[f]) continue;
    const ps = URL_PATTERNS[f];
    for (const p of ps) {
      if (p.test(url)) return f;
    }
  }
  return null;
}

// --- Counter plumbing ---------------------------------------------------
// All block counting funnels through here. Content scripts send a message
// instead of touching storage themselves: a read-modify-write done from two
// contexts at once loses increments, and a story view fires several seen
// signals within a few milliseconds.

function storageGet(keys) {
  return new Promise((resolve) => {
    try {
      const ret = api.storage.local.get(keys, (r) => resolve(r || {}));
      if (ret && typeof ret.then === "function") {
        ret.then((r) => resolve(r || {}), () => resolve({}));
      }
    } catch (err) {
      try {
        const ret = api.storage.local.get(keys);
        if (ret && typeof ret.then === "function") {
          ret.then((r) => resolve(r || {}), () => resolve({}));
        } else {
          resolve(ret || {});
        }
      } catch (retryErr) {
        resolve({});
      }
    }
  });
}

function storageSet(items) {
  return new Promise((resolve) => {
    try {
      const ret = api.storage.local.set(items, () => resolve());
      if (ret && typeof ret.then === "function") {
        ret.then(() => resolve(), () => resolve());
      }
    } catch (err) {
      resolve();
    }
  });
}

// Serializes every counter write so concurrent blocks can't clobber each other.
let writeQueue = Promise.resolve();
function enqueue(task) {
  const next = writeQueue.then(task, task);
  writeQueue = next.catch(() => {});
  return writeQueue;
}

// One thing the user does -- opening a thread, viewing a story -- trips several
// independent suppressions at once: the LightSpeed leaf, the mark-read mutation
// hook, the disableMarkRead flag, and whatever the network layer cancels. Each
// of those counted, so reading a single chat moved the counter by five. The
// per-feature+source throttle in the inject scripts cannot help: every mechanism
// is a different source, which is exactly what it budgets separately.
//
// These counters are labelled "read receipts" and "blocked all time", so they
// should read as things the user did. A feature's firings collapse into one
// count while they keep arriving less than COALESCE_MS apart, and the gate is
// refreshed by every firing rather than only by counted ones -- otherwise a
// burst that trickles in over a few seconds restarts the window and counts
// again, which is how one chat could reach five.
//
// Nothing is lost: diag_pm_*/diag_wr_* still count every single firing, because
// those are the "is the patch actually running" signal, and the folded firings
// are recorded on the recent_blocks row as `n` so the popup can show how many
// signals one block stood for.
const COALESCE_MS = 1500;

// source: "net" for the webRequest/DNR layer, "page" for the main-world patch.
function countBlock(feature, url, source) {
  if (!FEATURES.includes(feature)) return Promise.resolve();
  const src = source === "page" ? "page" : "net";
  return enqueue(async () => {
    const diagKey = src === "page" ? `diag_pm_${feature}` : `diag_wr_${feature}`;
    const data = await storageGet([
      `count_${feature}`,
      "recent_blocks",
      diagKey,
      "count_gate"
    ]);
    const recent = Array.isArray(data.recent_blocks) ? data.recent_blocks : [];
    const gate =
      data.count_gate && typeof data.count_gate === "object"
        ? data.count_gate
        : {};
    const now = Date.now();
    // Read the gate before refreshing it below. This also subsumes the old
    // same-url cross-source echo check -- that only caught the case where the
    // network layer and the page patch saw one identical request within 500ms,
    // and a 1500ms window on the feature covers it and everything else.
    const coalesce = now - (gate[feature] || 0) < COALESCE_MS;
    gate[feature] = now;

    // Diagnostics count raw firings and are deliberately never coalesced.
    const writes = {
      [diagKey]: (data[diagKey] || 0) + 1,
      count_gate: gate
    };

    if (coalesce) {
      // Record that the mechanism fired against the block it belongs to, so the
      // drawer still shows it without the headline counter moving again. The
      // row's timestamp stays at the first firing -- that is when the user
      // actually opened the thread.
      const head = recent[0];
      if (head && head.f === feature) {
        head.n = (head.n || 1) + 1;
        writes.recent_blocks = recent.slice(0, 20);
      }
      await storageSet(writes);
      return;
    }

    recent.unshift({ f: feature, url: url || "", t: now, s: src, n: 1 });
    writes[`count_${feature}`] = (data[`count_${feature}`] || 0) + 1;
    writes.recent_blocks = recent.slice(0, 20);
    await storageSet(writes);
  });
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.source !== "stay-unseen") return;
  if (msg.type === "block") {
    // countBlock is async (storage read, then write). Chrome runs this file as
    // an MV3 service worker and is free to tear it down the moment the listener
    // returns, so returning undefined here killed the worker mid-write and the
    // counter never moved -- while blocking, which happens in the page and at
    // the DNR layer, kept working. Firefox never showed it: manifest.firefox
    // uses a persistent background page, which stays alive to finish the write.
    //
    // Returning true holds the message port open, and the port keeps the worker
    // alive until sendResponse fires.
    countBlock(msg.feature, msg.url, "page").then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false })
    );
    return true;
  }
});


// --- Firefox: block and count at the network layer ---
if (isFirefox && api.webRequest && api.webRequest.onBeforeRequest) {
  api.webRequest.onBeforeRequest.addListener(
    (details) => {
      // Seen signals are always writes. Never cancel a GET -- if one matched,
      // it is a read query we misidentified, and cancelling it hangs the page.
      const method = String(details.method || "GET").toUpperCase();
      if (method !== "POST" && method !== "PUT") return;
      const f = matchFeature(details.url);
      if (f) {
        countBlock(f, details.url, "net");
        return { cancel: true };
      }
    },
    HOST_FILTER,
    ["blocking"]
  );
}

// --- Firefox: log IG network activity for diagnosis ---
if (isFirefox && api.webRequest && api.webRequest.onBeforeRequest) {
  api.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (!/instagram\.com/i.test(details.url)) return;
      const method = details.method || "GET";
      const isPost = method === "POST" || method === "PUT";
      const looksSeen = /seen|view|story|media|reel/i.test(details.url);
      if (isPost || looksSeen) {
        api.storage.local.get(["ig_requests"], (r) => {
          const list = (r && r.ig_requests) || [];
          const last = list[0];
          const entry = {
            m: method,
            url: details.url,
            type: details.type || "",
            t: Date.now()
          };
          if (last && last.url === entry.url && last.m === entry.m) return;
          list.unshift(entry);
          api.storage.local.set({ ig_requests: list.slice(0, 40) });
        });
      }
    },
    {
      urls: ["*://*.instagram.com/*", "*://instagram.com/*"],
      types: ["xmlhttprequest", "other", "ping", "websocket"]
    }
  );
}

// --- Chrome: block via declarativeNetRequest ---
// Keep the synchronizer callable from the storage-change handler below. A
// function declaration inside the feature block is block-scoped and used to
// make toggling a setting throw `ReferenceError: syncDnr is not defined`.
let syncDnrFn = null;
if (!isFirefox && api.declarativeNetRequest) {
  // Each rule is pinned to its own site. Sharing one domain list across all
  // three lets the loose facebook_stories regex cancel Instagram requests.
  const RULE_DOMAINS = {
    instagram_stories: ["instagram.com"],
    instagram_messages: ["instagram.com"],
    facebook_stories: ["facebook.com"],
    facebook_messages: ["facebook.com", "messenger.com"],
    instagram_typing: ["instagram.com"],
    facebook_typing: ["facebook.com", "messenger.com"]
  };

  // DNR compiles with RE2 and caps each rule at 2KB of *compiled* memory. The
  // facebook_stories catch-all -- (seen|view).*(story|reel) plus its mirror --
  // blows past that: two alternation groups either side of an unbounded .*
  // expand into a huge compiled program. Chrome then rejected the entire
  // updateDynamicRules call, so Chrome was running with no DNR rules at all and
  // every block was coming from the page patch alone.
  //
  // That catch-all stays in facebook-inject.js, where an ordinary JS regex has
  // no such limit and the request body is available for context. DNR only ever
  // sees the URL, so the literal patterns below are what it can actually use.
  const DNR_PATTERNS = {
    instagram_stories: URL_PATTERNS.instagram_stories,
    instagram_messages: URL_PATTERNS.instagram_messages,
    facebook_stories: [
      // Facebook.com only. Messenger reuses `mark_seen` in chat traffic.
      /story_seen|seen_story|mark_story_seen/i,
      /story\/seen|stories\/seen/i
    ],
    // Messenger read-status URLs are shared with chat bootstrap and can be
    // cancelled by Chromium before the page patch can classify the payload.
    // Leave this feature to the main-world interceptor, as Ghostify does.
    facebook_messages: [],
    // Both typing lists are plain literals, so they compile well under RE2 and
    // need no trimming.
    instagram_typing: URL_PATTERNS.instagram_typing,
    facebook_typing: URL_PATTERNS.facebook_typing
  };

  // One rule per pattern rather than one per feature. Joining a feature's
  // patterns into a single regex meant one oversized alternative disqualified
  // every pattern it was joined with; kept apart, a bad pattern costs only
  // itself. id = 100 + featureIndex*10 + patternIndex, so the feature is still
  // recoverable from the rule id when counting a match.
  const RULE_STRIDE = 10;
  const featureForRuleId = (id) =>
    FEATURES[Math.floor((id - 100) / RULE_STRIDE)];

  const dnrRules = [];
  FEATURES.forEach((f, fi) => {
    DNR_PATTERNS[f].forEach((p, pi) => {
      dnrRules.push({
        id: 100 + fi * RULE_STRIDE + pi,
        priority: 1,
        action: { type: "block" },
        condition: {
          regexFilter: p.source,
          isUrlFilterCaseSensitive: false,
          // requestMethods only applies to HTTP requests, so websocket/ping are
          // dropped from this rule -- pairing them with post/put would match
          // nothing at all.
          resourceTypes: ["xmlhttprequest", "other"],
          // Writes only, matching the Firefox listener: cancelling a GET that
          // merely looked like a seen signal hangs the page on a spinner.
          requestMethods: ["post", "put"],
          // MV3 spelling -- the old "domains" key is ignored, which left every
          // rule applying to all three sites.
          requestDomains: RULE_DOMAINS[f],
          initiatorDomains: RULE_DOMAINS[f]
        }
      });
    });
  });

  syncDnrFn = async function syncDnr() {
    try {
      const existing = await api.declarativeNetRequest.getDynamicRules();
      const removeRuleIds = existing.map((r) => r.id);
      const addRules = dnrRules.filter(
        (rule) => enabled[featureForRuleId(rule.id)]
      );
      try {
        await api.declarativeNetRequest.updateDynamicRules({
          removeRuleIds,
          addRules
        });
      } catch (err) {
        // updateDynamicRules is all-or-nothing: one rejected rule discards the
        // batch. Clear, then re-add one at a time so a single bad pattern costs
        // that pattern instead of all blocking.
        console.warn("[Stay Unseen] DNR batch rejected, adding singly:", err);
        await api.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
        for (const rule of addRules) {
          try {
            await api.declarativeNetRequest.updateDynamicRules({
              addRules: [rule]
            });
          } catch (e) {
            console.warn("[Stay Unseen] DNR rule skipped:", rule.id, e);
          }
        }
      }
    } catch (err) {
      console.error("[Stay Unseen] DNR sync failed:", err);
    }
  };

  syncDnrFn();

  // Firefox counts its blocks inside the webRequest listener above. DNR has no
  // equivalent -- it cancels inside the network stack with no callback -- so
  // anything the page patch did not already swallow was blocked silently and
  // never counted. onRuleMatchedDebug is the only way back out.
  //
  // It fires for unpacked extensions only, and needs the
  // declarativeNetRequestFeedback permission -- which no shipped build
  // requests, because a permission that does nothing in a store build fails
  // review (developer policy 1.6). Store builds therefore count page-patch
  // blocks and simply miss the DNR-only ones; the counter under-reports
  // rather than over-reports, which is the honest direction for a privacy
  // tool. To verify DNR counting during development, add the permission to
  // the unpacked manifest by hand.
  //
  // Guarded rather than assumed present: this runs at the top level of the
  // service worker, and everything below -- main-world script registration,
  // the badge -- would be skipped if addListener threw on a build where the
  // event object exists but the permission is absent.
  try {
    if (api.declarativeNetRequest.onRuleMatchedDebug) {
      api.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
        const id = info && info.rule && info.rule.ruleId;
        const feature = featureForRuleId(id);
        if (!feature) return;
        countBlock(feature, (info.request && info.request.url) || "", "net");
      });
    }
  } catch (err) {
    // No feedback permission -- page-patch counting carries the badge.
  }
}

// --- Main-world patch for GraphQL/body-based seen signals ---
const MAIN_WORLD_SCRIPTS = [
  {
    id: "stay-unseen-ig-main",
    matches: ["*://*.instagram.com/*", "*://instagram.com/*"],
    js: ["content/instagram-inject.js"],
    runAt: "document_start",
    world: "MAIN",
    allFrames: true
  },
  {
    id: "stay-unseen-fb-main",
    matches: [
      "*://*.facebook.com/*",
      "*://facebook.com/*",
      "*://*.messenger.com/*",
      "*://messenger.com/*"
    ],
    js: ["content/facebook-inject.js"],
    runAt: "document_start",
    world: "MAIN",
    allFrames: true
  }
];

// onInstalled, onStartup and the top-level call below can all land at once when
// the service worker wakes. Each ran get-then-register independently, so two
// overlapping runs both saw the ID as free and the loser threw "Duplicate
// script ID". Sharing one in-flight promise makes concurrent callers await the
// first instead of racing it.
let registerInFlight = null;

// Registered script IDs are persisted by the browser, so an install that
// predates the Ghost View -> Stay Unseen rename still has "ghost-" IDs on
// record. Matching the old prefix too means those get unregistered on upgrade
// instead of lingering and injecting alongside the new registration.
const MAIN_WORLD_ID_PREFIXES = ["stay-unseen-", "ghost-"];

function registerMainWorldScripts() {
  if (!api.scripting || typeof api.scripting.registerContentScripts !== "function") {
    return Promise.resolve();
  }
  if (registerInFlight) return registerInFlight;
  registerInFlight = (async () => {
    try {
      const existing = await api.scripting.getRegisteredContentScripts();
      const stale = existing
        .filter(
          (s) =>
            s.id && MAIN_WORLD_ID_PREFIXES.some((p) => s.id.startsWith(p))
        )
        .map((s) => s.id);
      if (stale.length) {
        await api.scripting.unregisterContentScripts({ ids: stale });
      }
      // Main-world scripts are injected by the site content scripts after
      // settings load. Registering them here bypasses that gate and can break
      // chat initialization when every feature is disabled.
    } catch (err) {
      console.error("[Stay Unseen] main-world registration failed:", err);
    } finally {
      registerInFlight = null;
    }
  })();
  return registerInFlight;
}

function updateBadge() {
  api.storage.local.get(
    FEATURES.map((f) => `count_${f}`),
    (r) => {
      const total = FEATURES.reduce(
        (sum, f) => sum + ((r && r[`count_${f}`]) || 0),
        0
      );
      const text = total > 0 ? String(total) : "";
      api.action.setBadgeText({ text });
      api.action.setBadgeBackgroundColor({ color: "#22c55e" });
    }
  );
}

async function onEnabledChanged() {
  const data = await storageGet(FEATURES.map((f) => `enabled_${f}`));
  FEATURES.forEach((f) => {
    enabled[f] = data[`enabled_${f}`] !== false;
  });
  if (!isFirefox && api.declarativeNetRequest && syncDnrFn) {
    syncDnrFn();
  }
}

api.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (Object.keys(changes).some((k) => k.startsWith("enabled_"))) {
    onEnabledChanged();
    if (!isFirefox && api.declarativeNetRequest && syncDnrFn) syncDnrFn();
  }
  updateBadge();
});

if (api.runtime.onInstalled) {
  api.runtime.onInstalled.addListener(registerMainWorldScripts);
}
if (api.runtime.onStartup) {
  api.runtime.onStartup.addListener(registerMainWorldScripts);
}

onEnabledChanged();
registerMainWorldScripts();
updateBadge();
