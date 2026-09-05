/**
 * Stay Unseen - Instagram Injection Script (Production Fix)
 * 
 * 1. Blocks ALL seen/read receipts to Instagram servers:
 *    - GraphQL mutations (PolarisDirectMarkSeenMutation, DirectMarkSeenMutation, etc.)
 *    - REST endpoints (/direct_v2/threads/.../seen/, /batched_seen/)
 *    - Real-time MQTT frames over WebSocket (rt.direct_mark_seen, direct_mark_seen)
 *    - Web Workers & MessagePort payloads
 *    - SendBeacon background calls
 * 2. Blocks story seen receipts (PolarisStoriesV3SeenMutation, media_seen, reel/seen)
 * 3. Blocks typing indicator emissions (activity_indicator, indicate_activity)
 * 4. Preserves the blue "Unread" badge & bold snippet in your inbox UI even after opening messages
 * 5. Safe: Outgoing message sends (/threads/broadcast/, send_item) are NEVER blocked!
 * 6. 100% compatible with Chrome, Firefox, and Edge
 */
(function () {
  if (window.__stayUnseenInstagramInstalled) return;
  window.__stayUnseenInstagramInstalled = true;

  const IS_FIREFOX = /Firefox/.test(navigator.userAgent);

  const state = {
    instagram_stories: true,
    instagram_messages: true,
    instagram_typing: true
  };
  let settingsReady = true;

  window.addEventListener("message", (e) => {
    if (!e.data) return;
    const d = e.data;
    if (d.source === "stay-unseen" && d.type === "set") {
      if (Object.prototype.hasOwnProperty.call(state, d.feature)) {
        state[d.feature] = d.enabled !== false;
      }
      settingsReady = true;
    }
  });

  try {
    window.postMessage({ source: "stay-unseen", type: "ready" }, "*");
  } catch (err) {}

  // Set of thread IDs tracked as unread
  const trackedUnreadThreads = new Set();

  // Restore tracked unread threads across page navigations in the current session
  try {
    const saved = sessionStorage.getItem("__stay_unseen_ig_unread");
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        parsed.forEach((id) => trackedUnreadThreads.add(String(id)));
      }
    }
  } catch (err) {}

  function persistUnreadIds() {
    try {
      sessionStorage.setItem(
        "__stay_unseen_ig_unread",
        JSON.stringify(Array.from(trackedUnreadThreads).slice(-50))
      );
    } catch (err) {}
  }

  // --- 1. EXPLICIT SEEN MARKERS (NEVER PERMIT AS OUTGOING SENDS) --------------
  const EXPLICIT_SEEN_OR_READ =
    /PolarisDirectMarkSeenMutation|DirectMarkSeenMutation|DirectVisualMessageMarkSeenMutation|useDirectMarkSeenMutation|usePolarisDirectMarkSeenMutation|PolarisDirectMarkVisualItemSeenMutation|DirectMarkVisualItemSeenMutation|batched_seen|\/items\/[^/]+\/seen|\/threads\/[^/]+\/seen|\/threads\/seen|action=mark_seen|"action":"mark_seen"|"action":"seen"|action=seen|rt\.direct_mark_seen|direct_mark_seen|item_seen|thread_seen|mark_thread_read|mark_thread_seen|markThreadAsRead/i;

  // Real outgoing message send indicators
  const SEND_PATTERNS =
    /\/direct_v2\/threads\/broadcast\/|threads\/broadcast\/|action=send_item|"action":"send_item"|PolarisDirectSendMessageMutation|DirectSendMessageMutation|useDirectSendMessageMutation/i;

  function isOutgoingSend(url, body) {
    const sUrl = String(url || "");
    const sBody = typeof body === "string" ? body : String(body || "");
    const combined = sUrl + " " + sBody;

    // If request contains any explicit seen or read markers, it is NEVER an outgoing send!
    if (EXPLICIT_SEEN_OR_READ.test(combined)) {
      return false;
    }

    // Must match real send endpoints or actions
    return SEND_PATTERNS.test(combined);
  }

  // --- 2. SEEN & READ DETECTION PATTERNS -----------------------------------
  const IG_MESSAGE_SEEN_URLS = [
    /\/api\/v1\/direct_v2\/threads\/[^/]+\/items\/[^/]+\/seen\//i,
    /\/api\/v1\/direct_v2\/threads\/batched_seen\//i,
    /\/api\/v1\/direct_v2\/threads\/[^/]+\/seen\//i,
    /\/api\/v1\/direct_v2\/threads\/mark_read\//i,
    /\/api\/v1\/direct_v2\/threads\/mark_seen\//i,
    /\/direct_v2\/threads\/seen/i,
    /\/api\/v1\/direct_v2\/visual_threads\/[^/]+\/items\/[^/]+\/seen\//i,
    /\/api\/v1\/direct_v2\/threads\/show_seen\//i
  ];

  const IG_MESSAGE_SEEN_BODY = [
    /PolarisDirectMarkSeenMutation/i,
    /DirectMarkSeenMutation/i,
    /DirectVisualMessageMarkSeenMutation/i,
    /useDirectMarkSeenMutation/i,
    /usePolarisDirectMarkSeenMutation/i,
    /PolarisDirectMarkVisualItemSeenMutation/i,
    /DirectMarkVisualItemSeenMutation/i,
    /(?:operationName|doc_id|procedure|task_name)["':=][^&"'}]{0,100}MarkSeen/i,
    /"operationName"\s*:\s*"[^"]*MarkSeen[^"]*"/i,
    /"action"\s*:\s*"mark_seen"/i,
    /"action"\s*:\s*"seen"/i,
    /action=mark_seen/i,
    /action=seen/i,
    /batched_seen/i,
    /item_seen/i,
    /thread_seen/i,
    /last_seen_timestamp/i,
    /mark_thread_read/i,
    /mark_thread_seen/i,
    /markThreadAsRead/i
  ];

  const IG_TYPING_URLS = [
    /\/api\/v1\/direct_v2\/threads\/[^/]+\/activity_indicator\//i,
    /\/api\/v1\/direct_v2\/activity_indicator\//i
  ];

  const IG_TYPING_BODY = [
    /activity_indicator/i,
    /indicate_activity/i,
    /typing_indicator/i
  ];

  const IG_STORY_URLS = [
    /\/api\/v1\/stories\/reel\/seen\//i,
    /\/api\/v1\/media_seen\//i,
    /reel\/seen/i,
    /media_seen/i
  ];

  const IG_STORY_BODY = [
    /media_seen/i,
    /reel\/seen/i,
    /PolarisStoriesV3SeenMutation/i,
    /PolarisStoriesSeenMutation/i,
    /StoriesV3SeenMutation/i,
    /StoriesSeenMutation/i,
    /StorySeenMutation/i,
    /"operationName"\s*:\s*"[^"]*Stor(?:y|ies)V?[0-9]?Seen[^"]*"/i
  ];

  function shouldBlockIgRequest(url, body) {
    if (!settingsReady) return null;
    const sUrl = String(url || "");
    const sBody = typeof body === "string" ? body : String(body || "");

    // Safeguard: Never block outgoing messages!
    if (isOutgoingSend(sUrl, sBody)) return null;

    // Messages Seen Blocking
    if (state.instagram_messages) {
      for (const p of IG_MESSAGE_SEEN_URLS) {
        if (p.test(sUrl)) return "instagram_messages";
      }
      if (sBody) {
        for (const p of IG_MESSAGE_SEEN_BODY) {
          if (p.test(sBody)) return "instagram_messages";
        }
      }
    }

    // Typing Indicator Blocking
    if (state.instagram_typing) {
      for (const p of IG_TYPING_URLS) {
        if (p.test(sUrl)) return "instagram_typing";
      }
      if (sBody) {
        for (const p of IG_TYPING_BODY) {
          if (p.test(sBody)) return "instagram_typing";
        }
      }
    }

    // Story Seen Blocking
    if (state.instagram_stories) {
      for (const p of IG_STORY_URLS) {
        if (p.test(sUrl)) return "instagram_stories";
      }
      if (sBody) {
        for (const p of IG_STORY_BODY) {
          if (p.test(sBody)) return "instagram_stories";
        }
      }
    }

    return null;
  }

  function notifyBlocked(feature, url) {
    try {
      window.postMessage(
        { source: "stay-unseen", type: "block", feature, url },
        "*"
      );
    } catch (err) {}
  }

  function createMockOkResponse(url) {
    const payload = JSON.stringify({ status: "ok", data: {} });
    if (typeof Response === "function") {
      try {
        const res = new Response(payload, {
          status: 200,
          statusText: "OK",
          headers: { "Content-Type": "application/json" }
        });
        Object.defineProperty(res, "url", { value: url || "" });
        return Promise.resolve(res);
      } catch (err) {}
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      url: url || "",
      json: () => Promise.resolve({ status: "ok", data: {} }),
      text: () => Promise.resolve(payload),
      clone() {
        return this;
      }
    });
  }

  // --- 3. CLIENT-SIDE UNREAD BADGE PERSISTENCE ------------------------------
  // Modifies inbox query responses so Instagram's React UI keeps thread badges active:
  // Note: read_state = 0 is UNREAD in Instagram Direct v2 API (1 is read).
  function patchInboxJson(data) {
    if (!data || typeof data !== "object") return data;
    try {
      const inbox =
        data.inbox ||
        (data.data &&
          (data.data.inbox ||
            data.data.xdt_get_inbox ||
            data.data.direct_inbox ||
            (data.data.viewer && data.data.viewer.inbox)));
      const threads =
        (inbox && inbox.threads) ||
        (data.data && data.data.threads) ||
        data.threads;
      if (Array.isArray(threads)) {
        let changed = false;
        for (const thread of threads) {
          const id = String(
            thread.thread_id || thread.thread_v2_id || thread.id || ""
          );
          if (!id) continue;

          // If the thread is unread, register it
          if (
            thread.is_unread ||
            (thread.unseen_count && thread.unseen_count > 0) ||
            thread.read_state === 0
          ) {
            if (!trackedUnreadThreads.has(id)) {
              trackedUnreadThreads.add(id);
              changed = true;
            }
          }

          // Force unread state if tracked
          if (trackedUnreadThreads.has(id)) {
            thread.is_unread = true;
            thread.read_state = 0; // 0 = UNREAD in Instagram Direct v2 API
            if (!thread.unseen_count || thread.unseen_count < 1) {
              thread.unseen_count = 1;
            }
          }
        }
        if (changed) persistUnreadIds();
      }

      // Single thread query response
      const singleThread =
        data.thread ||
        (data.data && (data.data.thread || data.data.xdt_direct_thread));
      if (singleThread) {
        const id = String(
          singleThread.thread_id ||
            singleThread.thread_v2_id ||
            singleThread.id ||
            ""
        );
        if (id && trackedUnreadThreads.has(id)) {
          singleThread.is_unread = true;
          singleThread.read_state = 0; // 0 = UNREAD
          if (!singleThread.unseen_count || singleThread.unseen_count < 1) {
            singleThread.unseen_count = 1;
          }
        }
      }
    } catch (err) {}
    return data;
  }

  // Intercept fetch
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input && input.url;
      const body = init && init.body;
      const blockFeature = shouldBlockIgRequest(url, body);
      if (blockFeature) {
        notifyBlocked(blockFeature, url);
        return createMockOkResponse(url);
      }

      const fetchPromise = origFetch.apply(this, arguments);

      // Check if this is an inbox or thread query
      const sUrl = String(url || "");
      if (
        sUrl.includes("/direct_v2/inbox/") ||
        sUrl.includes("/direct_v2/threads/") ||
        sUrl.includes("PolarisDirectInbox") ||
        sUrl.includes("xdt_get_inbox")
      ) {
        return fetchPromise.then((response) => {
          if (!response || !response.ok) return response;
          try {
            const clone = response.clone();
            return clone
              .json()
              .then((json) => {
                const patched = patchInboxJson(json);
                const patchedText = JSON.stringify(patched);
                return new Response(patchedText, {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers
                });
              })
              .catch(() => response);
          } catch (err) {
            return response;
          }
        });
      }

      return fetchPromise;
    };
  }

  // Intercept XMLHttpRequest
  const origXhrOpen = XMLHttpRequest.prototype.open;
  const origXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__stayUnseenIgUrl = url;
    return origXhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const url = this.__stayUnseenIgUrl;
    const blockFeature = shouldBlockIgRequest(url, body);
    if (blockFeature) {
      notifyBlocked(blockFeature, url);
      try {
        this.abort();
      } catch (err) {}
      try {
        this.dispatchEvent(new Event("loadend"));
      } catch (err) {}
      return;
    }

    const sUrl = String(url || "");
    if (
      sUrl.includes("/direct_v2/inbox/") ||
      sUrl.includes("/direct_v2/threads/") ||
      sUrl.includes("PolarisDirectInbox") ||
      sUrl.includes("xdt_get_inbox")
    ) {
      this.addEventListener("readystatechange", () => {
        if (this.readyState === 4 && this.status === 200) {
          try {
            const parsed = JSON.parse(this.responseText);
            const patched = patchInboxJson(parsed);
            const patchedStr = JSON.stringify(patched);
            Object.defineProperty(this, "responseText", { value: patchedStr });
            Object.defineProperty(this, "response", { value: patchedStr });
          } catch (err) {}
        }
      });
    }

    return origXhrSend.apply(this, arguments);
  };

  // Intercept navigator.sendBeacon
  const origBeacon = navigator.sendBeacon;
  if (typeof origBeacon === "function") {
    navigator.sendBeacon = function (url, data) {
      const feature = shouldBlockIgRequest(url, data);
      if (feature) {
        notifyBlocked(feature, url);
        return true;
      }
      return origBeacon.call(this, url, data);
    };
  }

  // Intercept WebSocket (Real-time MQTT seen frames on edge-chat.instagram.com)
  if (typeof WebSocket !== "undefined" && WebSocket.prototype.send) {
    const origWsSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      let text = "";
      if (typeof data === "string") {
        text = data;
      } else if (data instanceof ArrayBuffer) {
        try {
          text = new TextDecoder().decode(data);
        } catch (err) {}
      } else if (ArrayBuffer.isView(data)) {
        try {
          text = new TextDecoder().decode(data.buffer);
        } catch (err) {}
      }

      if (text) {
        if (
          state.instagram_messages &&
          (/rt\.direct_mark_seen|direct_mark_seen|item_seen|thread_seen|batched_seen|mark_seen/i.test(
            text
          ) ||
            /\/direct_v2\/threads\/[^/]+\/seen/i.test(text))
        ) {
          notifyBlocked("instagram_messages", this.url || "websocket");
          return;
        }
        if (
          state.instagram_typing &&
          /activity_indicator|indicate_activity|typing_indicator/i.test(text)
        ) {
          notifyBlocked("instagram_typing", this.url || "websocket");
          return;
        }
        if (
          state.instagram_stories &&
          /story_seen|media_seen|reel\/seen|StoriesV3Seen/i.test(text)
        ) {
          notifyBlocked("instagram_stories", this.url || "websocket");
          return;
        }
      }

      return origWsSend.call(this, data);
    };
  }

  // Intercept Web Workers & MessagePorts
  if (typeof Worker !== "undefined" && Worker.prototype.postMessage) {
    const origWorkerPost = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, transfer) {
      try {
        const raw =
          typeof message === "string" ? message : JSON.stringify(message);
        if (raw) {
          if (
            state.instagram_messages &&
            /PolarisDirectMarkSeenMutation|DirectMarkSeenMutation|mark_seen|batched_seen|item_seen|thread_seen|rt\.direct_mark_seen/i.test(
              raw
            )
          ) {
            notifyBlocked("instagram_messages", "worker");
            return;
          }
          if (
            state.instagram_typing &&
            /activity_indicator|indicate_activity/i.test(raw)
          ) {
            notifyBlocked("instagram_typing", "worker");
            return;
          }
        }
      } catch (err) {}
      return origWorkerPost.call(this, message, transfer);
    };
  }

  // --- 4. FOCUS SPOOFING ON INSTAGRAM CHAT ----------------------------------
  // Prevents Instagram window focus listeners from emitting seen batches
  const origHasFocus = Document.prototype.hasOwnProperty("hasFocus")
    ? Document.prototype.hasFocus
    : document.hasFocus;
  if (typeof origHasFocus === "function") {
    Document.prototype.hasFocus = function () {
      try {
        const path = window.location.pathname;
        if (
          state.instagram_messages &&
          (path.startsWith("/direct") || path.includes("/t/"))
        ) {
          return false;
        }
      } catch (err) {}
      return origHasFocus.call(this);
    };
  }

  // --- 5. DOM UNREAD BADGE KEEPER (SIDEBAR INBOX UI) ------------------------
  // Continuously monitors inbox thread links in the sidebar.
  // When an unread thread is opened, preserves the blue dot badge and bold text.
  function ensureUnreadBadgeOnDom() {
    if (!state.instagram_messages) return;

    try {
      const links = document.querySelectorAll('a[href*="/direct/t/"]');
      links.forEach((link) => {
        const href = link.getAttribute("href") || "";
        const match = href.match(/\/direct\/t\/([0-9a-zA-Z_-]+)/);
        if (!match) return;
        const threadId = match[1];

        // If this thread element in the sidebar has an unread dot, register it
        const hasDot = link.querySelector(
          "div[style*='rgb(0, 149, 246)'], div[style*='rgb(0, 132, 255)'], span[style*='rgb(0, 149, 246)']"
        );
        if (hasDot && !trackedUnreadThreads.has(threadId)) {
          trackedUnreadThreads.add(threadId);
          persistUnreadIds();
        }

        // If tracked as unread, ensure blue dot is visible and snippet text is bold
        if (trackedUnreadThreads.has(threadId)) {
          if (!hasDot && !link.querySelector("[data-stay-unseen-dot='true']")) {
            const dot = document.createElement("div");
            dot.setAttribute("data-stay-unseen-dot", "true");
            dot.style.cssText =
              "width: 8px; height: 8px; border-radius: 50%; background-color: rgb(0, 149, 246); flex-shrink: 0; margin-left: auto; margin-right: 8px;";

            const targetContainer =
              link.querySelector("div[role='button']") || link;
            targetContainer.appendChild(dot);
          }

          // Keep message snippet font weight bold
          const textContainers = link.querySelectorAll("span, div");
          textContainers.forEach((el) => {
            if (
              el.textContent &&
              el.textContent.length > 0 &&
              el.children.length === 0
            ) {
              el.style.fontWeight = "600";
            }
          });
        }
      });
    } catch (err) {}
  }

  // Throttle DOM inspection
  let domTimer = null;
  const observer = new MutationObserver(() => {
    if (domTimer) return;
    domTimer = setTimeout(() => {
      domTimer = null;
      ensureUnreadBadgeOnDom();
    }, 250);
  });

  if (typeof document !== "undefined") {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
    window.addEventListener("popstate", () =>
      setTimeout(ensureUnreadBadgeOnDom, 200)
    );
  }
})();
