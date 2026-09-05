(function () {
  // --- Visible fallback: mark what we kept unread -------------------------
  //
  // The inject scripts stop Meta's client from mutating its own local state,
  // which is what keeps the native story ring and unread badge on screen. That
  // works by matching Meta-internal module and hook names, and those get
  // renamed -- when one does, the suppression silently stops working and the
  // ring quietly clears again.
  //
  // This layer needs no internal names at all. It watches the URL, which is the
  // one part of Instagram, Facebook and Messenger that does not churn: opening a
  // story puts the owner in the path, opening a thread puts the thread id there.
  // Anything visited while its feature was on gets an accent dot until the page
  // is reloaded.
  //
  // Deliberately a *distinct* marker rather than a replica of Meta's ring or
  // dot. When suppression works you see the native indicator and our dot
  // together, and a dot in a corner Meta never uses reads as "the extension is
  // holding this unread" instead of as a rendering bug.
  //
  // Runs in the isolated world: it only needs the DOM, never the page's JS. It
  // sets attributes and nothing else -- no inserting, moving, removing or
  // reverting nodes -- so React's reconciler never sees a tree it did not
  // author. If React recreates a node, the observer simply re-marks it.

  const api = typeof browser !== "undefined" ? browser : chrome;

  const MARK_ATTR = "data-stay-unseen-kept";
  const REL_ATTR = "data-stay-unseen-rel";
  const STYLE_ID = "stay-unseen-kept-style";
  const TOGGLE_KEY = "ui_keep_unread_marker";

  const FEATURES = [
    "instagram_stories",
    "instagram_messages",
    "facebook_stories",
    "facebook_messages"
  ];

  // Everything here lives in memory only. Not sessionStorage -- that is the
  // page's storage, so Meta's own code could read it -- and not storage.local,
  // because these marks *should* die on reload: a reload refetches the true
  // server state, which is still unread, so the native indicator comes back on
  // its own and a persisted mark would sit next to it for no reason.
  const subjects = new Map(); // key -> { kind, feature, key }
  const enabled = Object.create(null);
  FEATURES.forEach((f) => (enabled[f] = true));
  let markerOn = true;

  const host = String(location.hostname || "").toLowerCase();
  const IS_INSTAGRAM = /(^|\.)instagram\.com$/.test(host);
  const IS_MESSENGER = /(^|\.)messenger\.com$/.test(host);
  const IS_FACEBOOK = /(^|\.)facebook\.com$/.test(host);

  // Reserved first segments under /stories/. highlights and direct are not a
  // person's story tray entry at all, and create/archive/settings are the
  // owner's own tooling -- marking any of them would put a dot on something
  // that was never unread.
  const STORY_RESERVED = {
    highlights: true,
    direct: true,
    create: true,
    archive: true,
    settings: true,
    privacy: true
  };

  // --- Route -> subject --------------------------------------------------

  function segments(pathname) {
    return String(pathname || "")
      .split("/")
      .filter(Boolean);
  }

  // Returns { kind, feature, key } for a route that names something we can hold
  // unread, or null. Exported shape is what the scanner selects on.
  function subjectForRoute(pathname) {
    const parts = segments(pathname);
    if (!parts.length) return null;

    if (IS_INSTAGRAM) {
      if (parts[0] === "stories" && parts[1]) {
        const owner = parts[1].toLowerCase();
        if (STORY_RESERVED[owner]) return null;
        return { kind: "story", feature: "instagram_stories", key: owner };
      }
      // /direct/t/<threadId>
      if (parts[0] === "direct" && parts[1] === "t" && parts[2]) {
        return { kind: "thread", feature: "instagram_messages", key: parts[2] };
      }
      return null;
    }

    if (IS_MESSENGER) {
      // /t/<id>, and /e2ee/t/<id> on the encrypted surface.
      const ti = parts.indexOf("t");
      if (ti !== -1 && parts[ti + 1]) {
        return { kind: "thread", feature: "facebook_messages", key: parts[ti + 1] };
      }
      return null;
    }

    if (IS_FACEBOOK) {
      // /messages/t/<id>, /messages/e2ee/t/<id>
      if (parts[0] === "messages") {
        const ti = parts.indexOf("t");
        if (ti !== -1 && parts[ti + 1]) {
          return {
            kind: "thread",
            feature: "facebook_messages",
            key: parts[ti + 1]
          };
        }
        return null;
      }
      if (parts[0] === "stories" && parts[1]) {
        const bucket = parts[1].toLowerCase();
        if (STORY_RESERVED[bucket]) return null;
        // Bucket ids are long and opaque. A short segment is a route word we
        // have not listed, not an id.
        if (bucket.length < 5) return null;
        return { kind: "story", feature: "facebook_stories", key: bucket };
      }
      return null;
    }

    return null;
  }

  function decodeRouteValue(value) {
    try {
      return decodeURIComponent(String(value || "").replace(/\+/g, " "));
    } catch (err) {
      return String(value || "");
    }
  }

  function threadKeyFromQuery(text) {
    const source = String(text || "");
    const m = /(?:^|[?&#])(?:thread_id|threadid|thread_key|threadkey|thread_fbid|threadfbid)=([^&#]+)/i.exec(source);
    if (!m) return null;
    const key = decodeRouteValue(m[1]);
    return key && key.length >= 3 ? key : null;
  }

  function subjectForLocation() {
    const routeSubject = subjectForRoute(location.pathname);
    if (routeSubject) return routeSubject;
    if (!IS_MESSENGER && !IS_FACEBOOK) return null;
    const key = threadKeyFromQuery(
      String(location.search || "") + String(location.hash || "")
    );
    return key
      ? { kind: "thread", feature: "facebook_messages", key }
      : null;
  }

  function subjectId(subject) {
    return subject.kind + ":" + subject.key;
  }

  function recordCurrentRoute() {
    const subject = subjectForLocation();
    if (!subject) return;
    // Only hold it unread if the feature was actually on when it was opened.
    // With the feature off the receipt really was sent, so a dot would be a lie.
    if (!enabled[subject.feature]) return;
    const id = subjectId(subject);
    if (subjects.has(id)) return;
    subjects.set(id, subject);
    schedule();
  }

  // --- Finding the elements to mark --------------------------------------

  function markable(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el === document.documentElement || el === document.body) return null;
    return el;
  }

  // A pseudo-element cannot render on a replaced element, so an <img> is marked
  // via its parent. The parent is the circular avatar wrapper on every surface
  // that draws a ring, which is exactly where the dot belongs.
  function hostForImage(img) {
    return markable(img.parentElement) || markable(img);
  }

  function collectThread(key, out) {
    const wanted = String(key);
    const hrefMatches = (href) => {
      let value = String(href || "");
      for (let i = 0; i < 2; i++) value = decodeRouteValue(value);
      if (IS_INSTAGRAM) return value.indexOf("/direct/t/" + wanted) !== -1;
      if (/(?:^|\/)e2ee\/t\//i.test(value) || /(?:^|\/)t\//i.test(value) || /(?:^|\/)messages\/t\//i.test(value) || /(?:^|\/)messenger\/t\//i.test(value)) {
        if (new RegExp("(?:^|[?&#/])" + wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:$|[?&#/])").test(value)) return true;
      }
      return threadKeyFromQuery(value) === wanted;
    };

    let anchors = [];
    try {
      anchors = document.querySelectorAll("a[href]");
    } catch (err) {}
    for (const a of anchors) {
      if (!hrefMatches(a.getAttribute("href"))) continue;
      const el = markable(a);
      if (el) out.add(el);
    }

    // Some Chromium Messenger builds render virtualized rows without a link,
    // but retain the thread identity as a data attribute on the row.
    for (const attr of ["data-thread-id", "data-thread-key", "data-thread-fbid"]) {
      let rows = [];
      try {
        rows = document.querySelectorAll("[" + attr + "]");
      } catch (err) {}
      for (const row of rows) {
        if (decodeRouteValue(row.getAttribute(attr)) === wanted) {
          const el = markable(row);
          if (el) out.add(el);
        }
      }
    }
  }

  function collectInstagramStory(user, out) {
    // Most reliable first: the tray item is a link to the story itself, so the
    // username is in the href rather than in a localised alt string. This is the
    // same shape collectFacebookStory already relies on, and it is what makes
    // the marker appear even when the avatar's alt is missing or renamed.
    let trayLinks;
    try {
      trayLinks = document.querySelectorAll(
        'a[href*="/stories/' + CSS.escape(user) + '/"]'
      );
    } catch (err) {
      trayLinks = [];
    }
    for (const a of trayLinks) {
      const img = a.querySelector("img");
      const el = img ? hostForImage(img) : a;
      if (el) out.add(el);
    }
    // Instagram labels every avatar with the owner: alt="<user>'s profile
    // picture". The possessive suffix is localised but the username leads, so
    // match on the prefix rather than the whole string.
    let images;
    try {
      images = document.querySelectorAll("img[alt]");
    } catch (err) {
      return;
    }
    for (const img of images) {
      const alt = String(img.getAttribute("alt") || "").toLowerCase();
      if (!alt.startsWith(user)) continue;
      // "alexa" must not match a story by "alex". Require a separator after
      // the username.
      const next = alt.charAt(user.length);
      if (next && /[a-z0-9._]/.test(next)) continue;
      const el = hostForImage(img);
      if (el) out.add(el);
    }
    // The profile page avatar carries no useful alt on some builds, so pick it
    // up through the profile link instead.
    let links;
    try {
      links = document.querySelectorAll('a[href="/' + CSS.escape(user) + '/"]');
    } catch (err) {
      links = [];
    }
    for (const a of links) {
      const img = a.querySelector("img");
      if (!img) continue;
      const el = hostForImage(img);
      if (el) out.add(el);
    }
  }

  function collectFacebookStory(bucket, out) {
    let found;
    try {
      found = document.querySelectorAll(
        'a[href*="/stories/' + CSS.escape(bucket) + '"]'
      );
    } catch (err) {
      return;
    }
    for (const a of found) {
      const el = markable(a);
      if (el) out.add(el);
    }
  }

  // --- Marking ----------------------------------------------------------

  function clearMarks() {
    let marked;
    try {
      marked = document.querySelectorAll("[" + MARK_ATTR + "]");
    } catch (err) {
      return;
    }
    for (const el of marked) {
      el.removeAttribute(MARK_ATTR);
      el.removeAttribute(REL_ATTR);
    }
  }

  function applyMark(el, kind) {
    if (el.getAttribute(MARK_ATTR) === kind) return;
    el.setAttribute(MARK_ATTR, kind);
    // The dot is absolutely positioned, so it needs a positioned host. Only
    // promote a statically positioned element -- overriding an existing
    // absolute or fixed position would move the row itself.
    if (!el.hasAttribute(REL_ATTR)) {
      let position = "static";
      try {
        position = getComputedStyle(el).position;
      } catch (err) {}
      if (position === "static") el.setAttribute(REL_ATTR, "1");
    }
  }

  function sweep() {
    if (!markerOn || !subjects.size) {
      clearMarks();
      return;
    }

    const wanted = new Map(); // element -> kind
    for (const subject of subjects.values()) {
      // Re-checked every sweep, not just at record time: turning a feature off
      // should drop its dots immediately.
      if (!enabled[subject.feature]) continue;
      const found = new Set();
      if (subject.kind === "thread") {
        collectThread(subject.key, found);
      } else if (subject.feature === "instagram_stories") {
        collectInstagramStory(subject.key, found);
      } else {
        collectFacebookStory(subject.key, found);
      }
      for (const el of found) {
        if (!wanted.has(el)) wanted.set(el, subject.kind);
      }
    }

    let stale;
    try {
      stale = document.querySelectorAll("[" + MARK_ATTR + "]");
    } catch (err) {
      stale = [];
    }
    for (const el of stale) {
      if (!wanted.has(el)) {
        el.removeAttribute(MARK_ATTR);
        el.removeAttribute(REL_ATTR);
      }
    }
    for (const [el, kind] of wanted) {
      applyMark(el, kind);
    }
  }

  // One sweep per animation-frame-ish window. React re-renders the inbox in
  // bursts, and a sweep per mutation record would run hundreds of times for a
  // single scroll.
  let sweepTimer = null;
  function schedule() {
    if (sweepTimer !== null) return;
    sweepTimer = setTimeout(() => {
      sweepTimer = null;
      try {
        sweep();
      } catch (err) {}
    }, 150);
  }

  // --- Style ------------------------------------------------------------

  const CSS_TEXT = `
[${REL_ATTR}] { position: relative !important; }

[${MARK_ATTR}]::before,
[${MARK_ATTR}]::after {
  content: "";
  position: absolute;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #ff3040;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.92);
  pointer-events: none;
  z-index: 9;
}

/* Threads: leading edge of the inbox row, where a row-level dot reads as
   "this conversation". */
[${MARK_ATTR}="thread"]::before {
  left: 3px;
  top: 50%;
  margin-top: -4.5px;
}

/* Stories: bottom-right of the avatar. Outside the ring, and not a corner
   Instagram or Facebook draws anything in. */
[${MARK_ATTR}="story"]::after {
  right: -2px;
  bottom: -2px;
}

@media (prefers-color-scheme: dark) {
  [${MARK_ATTR}]::before,
  [${MARK_ATTR}]::after {
    box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.86);
  }
}
`;

  function addStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const root = document.documentElement;
    if (!root) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS_TEXT;
    // On documentElement rather than in <head>: outside React's root, so the
    // app never reconciles it away.
    root.appendChild(style);
  }

  function removeStyle() {
    const style = document.getElementById(STYLE_ID);
    if (style && style.parentNode) style.parentNode.removeChild(style);
  }

  function applyToggle() {
    if (markerOn) {
      addStyle();
      schedule();
    } else {
      removeStyle();
      clearMarks();
    }
  }

  // --- Wiring -----------------------------------------------------------

  function watchRoute() {
    let last = location.href;
    const check = () => {
      if (location.href === last) return;
      last = location.href;
      recordCurrentRoute();
      // The destination renders after the URL changes, so sweep again once it
      // has had a chance to.
      schedule();
    };
    // history.pushState cannot be patched from the isolated world -- the page's
    // History object is a different realm -- so the poll is the primary signal
    // and the events are just a faster path for the cases they cover.
    window.addEventListener("popstate", check);
    window.addEventListener("hashchange", check);
    setInterval(check, 400);
  }

  function watchDom() {
    if (typeof MutationObserver !== "function") return;
    const observer = new MutationObserver(() => {
      if (!markerOn || !subjects.size) return;
      schedule();
    });
    observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true
    });
  }

  function loadSettings() {
    const keys = FEATURES.map((f) => `enabled_${f}`);
    keys.push(TOGGLE_KEY);
    api.storage.local.get(keys, (r) => {
      const data = r || {};
      FEATURES.forEach((f) => {
        enabled[f] = data[`enabled_${f}`] !== false;
      });
      markerOn = data[TOGGLE_KEY] !== false;
      applyToggle();
      recordCurrentRoute();
      // Avoid installing observers and route polling when every feature is
      // disabled; this keeps the extension completely passive in chat.
      if (FEATURES.some((f) => enabled[f]) || markerOn) {
        watchRoute();
        watchDom();
      }
    });
  }

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    let touched = false;
    FEATURES.forEach((f) => {
      const change = changes[`enabled_${f}`];
      if (change) {
        enabled[f] = change.newValue !== false;
        touched = true;
      }
    });
    if (changes[TOGGLE_KEY]) {
      markerOn = changes[TOGGLE_KEY].newValue !== false;
      applyToggle();
      touched = true;
    }
    if (touched) schedule();
  });

  try {
    api.storage.local.set({ diag_ui_marker: true });
  } catch (err) {}

  loadSettings();
})();
