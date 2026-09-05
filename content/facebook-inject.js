(function () {
  if (window.__stayUnseenInstalled) return;
  window.__stayUnseenInstalled = true;

  const IS_FIREFOX = /Firefox/.test(navigator.userAgent);

  const state = {
    instagram_stories: true,
    instagram_messages: true,
    facebook_stories: true,
    facebook_messages: true,
    instagram_typing: true,
    facebook_typing: true
  };
  let settingsReady = false;
  const receivedSettings = new Set();

  const HOST_FEATURES = /(^|\.)messenger\.com$/i.test(
    String(window.location && window.location.hostname)
  )
    ? ["facebook_messages", "facebook_typing"]
    : ["facebook_stories", "facebook_messages", "facebook_typing"];

  const IS_TYPING = {
    instagram_typing: true,
    facebook_typing: true
  };

  window.addEventListener("message", (e) => {
    if (!e.data) return;
    const d = e.data;
    if (d.source === "stay-unseen" && d.type === "set") {
      if (Object.prototype.hasOwnProperty.call(state, d.feature)) {
        state[d.feature] = d.enabled !== false;
        receivedSettings.add(d.feature);
        if (HOST_FEATURES.every((feature) => receivedSettings.has(feature))) {
          settingsReady = true;
        }
      }
    }
  });

  const URL_PATTERNS = {
    instagram_stories: [/media_seen|reel\/seen/i],
    instagram_messages: [],
    instagram_typing: [],
    facebook_messages: [],
    facebook_stories: [
      /story_seen|seen_story|mark_story_seen/i,
      /story\/seen|stories\/seen/i,
      /(?:stories|story|reel)[\/_](?:seen|view)/i
    ],
    facebook_typing: [
      /ajax\/(?:messaging|chat|mercury)\/typ\.php/i,
      /typ\.php/i,
      /orca_typing_notifications/i,
      /thread_typing/i
    ]
  };

  const FB_TYPING_MARKERS =
    /typ\.php|orca_typing|thread_typing|typing_?indicator|is_?typing|typing_on|is_?composing|send_?typing|typing_?state|typing_?status|chat_?state|secure_?typing/i;

  const BODY_KEYWORDS = {
    instagram_stories: [],
    instagram_messages: [],
    instagram_typing: [],
    facebook_messages: [
      /LSUpdateThreadReadWatermark|LSUpdateLastReadWatermark|LSMarkThreadRead|MWMarkThreadRead|MarkThreadAsRead|MarkThreadReadMutation|LSSendReadReceipt|SendReadReceipt|ReadReceiptMutation|UpdateReadReceipt/i,
      /(?:fb_api_req_friendly_name|operationName|procedure|command|operation|task_name)["':=][^&"'}]{0,100}(?:MarkThread|MarkRead|ReadReceipt|ReadWatermark|ThreadSeen)/i,
      /"?(?:change_read_status|mark_read|mark_seen|read_receipt)"?\s*[:=]\s*(?:true|1)/i
    ],
    facebook_stories: [
      /mark_seen/i,
      /markSeen/i,
      /MarkSeen/i,
      /story_seen/i,
      /storySeen/i,
      /StoryViewer/i,
      /story_viewer/i,
      /mark_story_seen/i,
      /MarkStorySeen/i,
      /viewSeen/i,
      /StoriesSeen/i,
      /StorySeen/i,
      /(?:fb_api_req_friendly_name|operationName)[":=][^&"]*(?:story|stories)[^&"]*(?:seen|mark)/i,
      /(?:fb_api_req_friendly_name|operationName)[":=][^&"]*(?:seen|mark)[^&"]*(?:story|stories)/i
    ],
    facebook_typing: [
      FB_TYPING_MARKERS,
      /(?:fb_api_req_friendly_name|operationName)[":=][^&"]*[Tt]yping/i
    ]
  };

  const CAPTURE_RE =
    /(seen|read|typing|mark_|mark[A-Z]|media_seen|story_seen|storySeen|StoryViewer|reel\/seen)/i;

  const READ_MARKERS =
    /markThreadAsRead|mark_thread_read|markThreadRead|markThreadSeen|mark_thread_seen|read_receipt|readReceipt|sendreadreceipt|send_read_receipt|lsupdatethreadreadwatermark|lsupdatelastreadwatermark|lsmarkthreadread|mwmarkthreadread|change_read_status/i;

  const REALTIME_READ_WATERMARK =
    /(?:["']?label["']?\s*[:=]\s*["']?21["']?(?![0-9]))[\s\S]{0,900}(?:last_read_watermark_ts|lastreadwatermarkts)[\s\S]{0,900}(?:thread_key|threadkey|thread_fbid|threadfbid|thread_id|threadid|parent_thread_key|parentthreadkey)/i;
  const REALTIME_LAST_SEEN =
    /(?:["']?label["']?\s*[:=]\s*["']?6["']?(?![0-9]))[\s\S]{0,900}(?:last_seen_time_ms|lastseentimems)[\s\S]{0,900}(?:parent_thread_key|parentthreadkey|thread_key|threadkey|thread_fbid|threadfbid|thread_id|threadid)/i;

  function hasMessengerThreadContext(text) {
    return /thread_key|threadkey|thread_fbid|threadfbid|thread_id|threadid|parent_thread_key|parentthreadkey|message_thread|act_thread_id/i.test(
      text
    );
  }

  // --- SEND DETECTION LOGIC (ROBUST FOR GROUP CHATS & 1-ON-1) ----------------
  // Group chats (Open Messenger / MWV2) send messages via LightSpeed tasks
  // (task label 46 / 141, queue 'inbox_send', procedure 'LSExecuteInsertNewMessage')
  // which frequently piggyback or batch with watermark updates (label 21).
  const BRIDGE_SEND_INTENT =
    /LSSendMessage|LSSendTextMessage|send_?message|sendMessage|send_?text|sendText|send_?chat|sendChat|send_?group|sendGroup|message_?send|send_?item|new_?message|message_?text|encrypted_?message|encrypted_?payload|ciphertext|broadcast[\/_](?:text|link|media|share|reaction|message)|LSSendGroupMessage|LSInsertNewMessage|LSInsertMessage|LSExecuteInsertNewMessage|insert_new_message|inbox_send|send_open_message|usemwv2sendopenmessage|client_context/i;

  // Accepts negative numbers, hex IDs, and dedup IDs: [-a-z0-9]
  const SEND_ID_WITH_VALUE =
    /(?:otid|offline_?threading_?id|client_?message_?id|client_?mutation_?id|message_?id|dedup_?id|client_?context)[\\"']*\s*[:= ]\s*[\\\"']*(?!null\b|false\b|true\b)[-a-z0-9]/i;

  // Task labels for sending in LightSpeed (label 46 is standard send task, 141/142 are optimistic sends)
  // Also check queue_name inbox_send or send_type
  const LS_SEND_TASK =
    /send_?type|send_?text|send_?message|send_?chat|send_?group|LSSendTextMessage|LSSendMessage|inbox_send|label["':= ]+46\b|label["':= ]+14[123]\b/i;

  // Real message content (in raw text, JSON, or flattened stringify format)
  const HAS_MESSAGE_CONTENT =
    /(?:"(?:text|body|item_text|caption)"\s*:\s*"(?:[^"\\]|\\.)+"|(?:\btext|\bbody|\bmessage_text)\s+[^\s]{1,})/i;

  function isSendIntent(text) {
    if (!text) return false;
    return (
      BRIDGE_SEND_INTENT.test(text) ||
      LS_SEND_TASK.test(text) ||
      SEND_ID_WITH_VALUE.test(text) ||
      HAS_MESSAGE_CONTENT.test(text)
    );
  }

  function isRealtimeGroupReadFrame(text) {
    // If there is any send intent in this frame, it must NOT be treated as a pure read frame
    if (isSendIntent(text)) return false;

    const lower = String(text || "").toLowerCase();
    if (!/ls_req|issue_new_task|issuenewtask|storedprocedure|queue_name|queuename/.test(lower))
      return false;
    if (!hasMessengerThreadContext(lower)) return false;

    // Never treat send task queues or send labels as read receipts
    if (/inbox_send|send_type|send_message|send_text|label\s*[:= ]\s*46\b/.test(lower)) {
      return false;
    }

    const hasWatermark =
      /last_read_watermark|lastreadwatermark|read_watermark|readwatermark|last_seen_time_ms|lastseentimems|watermark_timestamp|watermarktimestamp/.test(
        lower
      );
    if (!hasWatermark)
      return /(?:thread_key|threadkey|thread_fbid|threadfbid|thread_id|threadid|parent_thread_key|parentthreadkey)[\s\S]{0,900}(?:mark_seen|markseen|mark_read|markread|thread_seen|threadseen|read_receipt|readreceipt)/i.test(
        lower
      );
    return (
      /(?:label[^0-9]{0,8}(?:21|6))(?![0-9])/.test(lower) ||
      /mark_seen|markseen|mark_read|markread|thread_seen|threadseen|read_receipt|readreceipt/.test(
        lower
      )
    );
  }

  const STORY_MARKERS =
    /story_seen|storySeen|markStorySeen|storyViewerSeen|StoriesSeen|StorySeen|markStoryRead/i;
  const TYPING_MARKERS = FB_TYPING_MARKERS;

  // Includes LSSendTextMessage, sendTextMessage, send_text, send_chat, etc.
  const SEND_GUARD =
    /LSSendMessage|LSSendTextMessage|send_?message|sendMessage|send_?text|sendText|"send_item"|send_item|new_message|message_text|otid|client_context|inbox_send/i;

  const USER_TEXT_FIELDS =
    "text|message|item_text|client_context_message|reply_text|comment_text|caption|body";
  const USER_TEXT_JSON = new RegExp(
    '("(?:' + USER_TEXT_FIELDS + ')"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"',
    "gi"
  );
  const USER_TEXT_FORM = new RegExp("\\b(" + USER_TEXT_FIELDS + ")=[^&]*", "gi");

  function stripUserText(text) {
    if (!text) return "";
    return String(text)
      .replace(USER_TEXT_JSON, '$1"<user_text>"')
      .replace(USER_TEXT_FORM, "$1=<user_text>");
  }

  const DECODER =
    typeof TextDecoder !== "undefined"
      ? new TextDecoder("utf-8", { fatal: false })
      : null;

  function frameToText(data) {
    if (typeof data === "string") return data;
    if (!DECODER) return null;
    try {
      if (data instanceof ArrayBuffer) return DECODER.decode(data);
      if (ArrayBuffer.isView(data)) return DECODER.decode(data);
    } catch (err) {}
    return null;
  }

  function classifyFrame(text) {
    if (!text) return null;
    // Any frame that carries send intent must be forwarded untouched!
    if (isSendIntent(text)) return null;

    if (
      state.facebook_messages &&
      (READ_MARKERS.test(text) ||
        REALTIME_READ_WATERMARK.test(text) ||
        REALTIME_LAST_SEEN.test(text) ||
        isRealtimeGroupReadFrame(text))
    ) {
      if (isSendIntent(text)) return null;
      return "facebook_messages";
    }
    if (state.facebook_stories && STORY_MARKERS.test(text)) {
      return "facebook_stories";
    }
    if (
      state.facebook_typing &&
      !SEND_GUARD.test(text) &&
      !isSendIntent(text) &&
      TYPING_MARKERS.test(stripUserText(text))
    ) {
      return "facebook_typing";
    }
    return null;
  }

  function shouldDropWsFrame(data) {
    if (!settingsReady) return null;
    return classifyFrame(frameToText(data));
  }

  function bodyText(body) {
    if (typeof body === "string") return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof FormData) {
      let out = "";
      for (const pair of body.entries()) {
        if (typeof pair[1] === "string") out += pair[0] + "=" + pair[1] + "&";
      }
      return out;
    }
    if (body && typeof body === "object" && !(body instanceof Blob)) {
      try {
        return JSON.stringify(body);
      } catch (err) {}
    }
    return "";
  }

  function matchesUrlOnly(url, feature) {
    const ups = URL_PATTERNS[feature];
    for (const p of ups) {
      if (p.test(url)) return true;
    }
    return false;
  }

  function shouldBlock(url, body) {
    if (!settingsReady) return null;
    let text = null;
    let typingText = null;
    for (const feature of HOST_FEATURES) {
      if (!state[feature]) continue;
      if (matchesUrlOnly(url, feature)) {
        return IS_FIREFOX ? null : feature;
      }
      if (body !== undefined && body !== null) {
        if (text === null) text = bodyText(body);
        if (IS_TYPING[feature]) {
          if (SEND_GUARD.test(text) || isSendIntent(text)) continue;
          if (typingText === null) typingText = stripUserText(text);
          for (const p of BODY_KEYWORDS[feature]) {
            if (p.test(typingText)) return feature;
          }
          continue;
        }
        if (isSendIntent(text)) continue;
        const bps = BODY_KEYWORDS[feature];
        for (const p of bps) {
          if (p.test(text)) return feature;
        }
      }
    }
    return null;
  }

  function notify(feature, url) {
    try {
      window.postMessage(
        { source: "stay-unseen", type: "block", feature, url },
        "*"
      );
    } catch (err) {}
  }

  const NOTIFY_MIN_GAP_MS = 1000;
  const lastNotifyAt = Object.create(null);

  function notifyThrottled(feature, source) {
    const key = feature + "|" + source;
    const now = Date.now();
    if (now - (lastNotifyAt[key] || 0) < NOTIFY_MIN_GAP_MS) return;
    lastNotifyAt[key] = now;
    notify(feature, source);
  }

  function maybeCapture(url, body, method) {
    try {
      const m = String(method || "GET").toUpperCase();
      const isGraphql = /graphql/i.test(String(url || ""));
      const text = String(url || "") + " " + bodyText(body);
      const keywordHit = CAPTURE_RE.test(text.slice(0, 600));
      if (m === "POST" || m === "PUT" || isGraphql || keywordHit) {
        const bodySnippet =
          isGraphql || m === "POST"
            ? stripUserText(bodyText(body)).slice(0, 4000)
            : stripUserText(text).slice(0, 200);
        window.postMessage(
          {
            source: "stay-unseen",
            type: "capture",
            url: url || "",
            body: bodySnippet,
            method: m
          },
          "*"
        );
      }
    } catch (err) {}
  }

  const WS_CAPTURE_INTEREST =
    /send|read|receipt|watermark|typing|seen|mark|task|queue|ls_req|msys|thread/i;

  function captureWsSend(data, wsUrl) {
    try {
      let snippet;
      if (typeof data === "string") {
        snippet = stripUserText(data).slice(0, 300);
      } else {
        const text = frameToText(data);
        snippet = text ? stripUserText(text).slice(0, 300) : null;
      }
      if (snippet && !WS_CAPTURE_INTEREST.test(snippet)) return;
      if (!snippet) snippet = "[binary frame " + (data && data.byteLength) + "b]";
      window.postMessage(
        {
          source: "stay-unseen",
          type: "wscapture",
          url: wsUrl || "",
          snippet,
          t: Date.now()
        },
        "*"
      );
    } catch (err) {}
  }

  try {
    window.postMessage({ source: "stay-unseen", type: "ready" }, "*");
  } catch (err) {}

  function blockedResponse(url) {
    const body = '{"data":{},"status":"ok"}';
    if (typeof Response === "function") {
      try {
        const res = new Response(body, {
          status: 200,
          statusText: "OK",
          headers: { "Content-Type": "application/json" }
        });
        try {
          Object.defineProperty(res, "url", { value: url || "" });
        } catch (err) {}
        return Promise.resolve(res);
      } catch (err) {}
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      url: url || "",
      headers: typeof Headers === "function" ? new Headers() : undefined,
      json: () => Promise.resolve({ data: {}, status: "ok" }),
      text: () => Promise.resolve(body),
      clone() {
        return this;
      }
    });
  }

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input && input.url;
      const body = init && init.body;
      const method =
        (init && init.method) ||
        (input && typeof input === "object" && input.method) ||
        "GET";
      const feature = shouldBlock(url, body);
      if (feature) {
        notify(feature, url);
        return blockedResponse(url);
      }
      maybeCapture(url, body, method);
      return origFetch.apply(this, arguments);
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, async, user, pass) {
    this.__stayUnseenUrl = url;
    this.__stayUnseenMethod = String(method || "GET").toUpperCase();
    return origOpen.call(this, method, url, async, user, pass);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const feature = shouldBlock(this.__stayUnseenUrl, body);
    if (feature) {
      notify(feature, this.__stayUnseenUrl);
      try {
        this.abort();
      } catch (err) {}
      try {
        this.dispatchEvent(new Event("loadend"));
      } catch (err) {}
      return;
    }
    maybeCapture(this.__stayUnseenUrl, body, this.__stayUnseenMethod);
    return origSend.call(this, body);
  };

  const origBeacon = navigator.sendBeacon;
  if (typeof origBeacon === "function") {
    navigator.sendBeacon = function (url, data) {
      const feature = shouldBlock(url);
      if (feature) {
        notify(feature, url);
        return true;
      }
      maybeCapture(url, data, "POST");
      return origBeacon.call(this, url, data);
    };
  }

  if (typeof WebSocket !== "undefined" && WebSocket.prototype.send) {
    const origWsSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (/facebook\.com|messenger\.com/i.test(this.url || "")) {
        const feature = shouldDropWsFrame(data);
        if (feature) {
          notify(feature, this.url);
          return;
        }
      }
      captureWsSend(data, this.url);
      return origWsSend.call(this, data);
    };
  }

  const TYPING_WRITE_INTENT =
    /send_?typing_?indicator|lssendtypingindicator|typing_?indicator_?stored_?procedure|send_?chat_?state(?:fromcomposer)?|secure_?typing_?state|maw_?secure_?typing_?state|typing_?status|indicate_?activity|activity_?indicator|typing_on/i;
  const TYPING_CONTEXT =
    /composer|typing_?indicator|chat_?state|typing_?state|typing_?status|thread_?key|threadkey|thread_?fbid|thread_?id|recipient_?id|message_?thread|ls_req|issue_new_task|issuenewtask|queue_?name|msys/i;
  const TYPING_STATE =
    /is_?typing|typing_?on|is_?composing|typing_?indicator|chat_?state|typing_?state|typing_?status/i;
  const TASK_ENVELOPE =
    /ls_req|issue_new_task|issuenewtask|stored_?procedure|queue_?name|payload|tasks/i;
  const THREAD_TARGET =
    /thread_?key|threadkey|thread_?fbid|threadfbid|thread_?id|threadid|recipient_?id|message_?thread|other_?user_?id|target_?id|act_?thread_?id|parent_?thread_?key/i;

  function decodeMaybe(value) {
    try {
      return decodeURIComponent(String(value).replace(/\+/g, " "));
    } catch (err) {
      return "";
    }
  }

  function stringifyForMatch(value, depth = 0) {
    if (!value || depth > 4) return "";
    try {
      if (typeof value === "string") return value + " " + decodeMaybe(value);
      if (typeof value === "number" || typeof value === "boolean")
        return String(value);
      if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        return frameToText(value) || "";
      }
      if (Array.isArray(value)) {
        return value
          .map((item) => stringifyForMatch(item, depth + 1))
          .join(" ");
      }
      if (typeof value === "object") {
        let text = "";
        for (const key of Object.keys(value)) {
          text += " " + key + " " + stringifyForMatch(value[key], depth + 1);
          if (text.length > 12000) break;
        }
        return text;
      }
    } catch (err) {}
    return "";
  }

  function isReadShapedText(text) {
    if (isSendIntent(text)) return false;
    return (
      REALTIME_READ_WATERMARK.test(text) ||
      REALTIME_LAST_SEEN.test(text) ||
      isRealtimeGroupReadFrame(text) ||
      (READ_MARKERS.test(text) && hasMessengerThreadContext(text))
    );
  }

  const SCAN_DEPTH_LIMIT = 6;

  // Recognizes typed arrays & ArrayBuffers as plain data
  function isPlainData(value) {
    if (value === null) return true;
    const t = typeof value;
    if (t === "string" || t === "number" || t === "boolean") return true;
    if (t !== "object") return false;
    if (Array.isArray(value)) return true;
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function batchCarriesOtherWork(value, depth) {
    if (depth > SCAN_DEPTH_LIMIT) return false;
    if (value === null || typeof value !== "object") return false;
    if (!isPlainData(value)) return false;

    // Check if the current payload has send intent
    const selfText = stringifyForMatch(value);
    if (isSendIntent(selfText)) return true;

    // Handle binary buffers directly
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      const text = frameToText(value);
      if (!text) return false;
      if (isSendIntent(text)) return true;
      return !isReadShapedText(text);
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === null || typeof item !== "object" || !isPlainData(item)) {
          continue;
        }
        const text = stringifyForMatch(item);
        if (isSendIntent(text)) return true;
        if (!isReadShapedText(text)) return true;
      }
      return false;
    }
    for (const key of Object.keys(value)) {
      const item = value[key];
      if (typeof item === "string" && item.length > 0 && item.length <= 20000) {
        if (isSendIntent(item)) return true;
        let parsed;
        try {
          parsed = JSON.parse(item);
        } catch (err) {
          continue;
        }
        if (
          parsed &&
          typeof parsed === "object" &&
          batchCarriesOtherWork(parsed, depth + 1)
        ) {
          return true;
        }
      } else if (item !== null && typeof item === "object" && isPlainData(item)) {
        if (batchCarriesOtherWork(item, depth + 1)) return true;
      }
    }
    return false;
  }

  function inspectWorkerMessage(message) {
    if (state.facebook_messages) {
      const raw = stringifyForMatch(message);
      if (raw) {
        // Absolute first check: if there is send intent, never block!
        if (isSendIntent(raw)) {
          return { feature: null, message: null };
        }
        if (isReadShapedText(raw)) {
          if (batchCarriesOtherWork(message, 0)) {
            return { feature: null, message: null };
          }
          return { feature: "facebook_messages" };
        }
      }
    }
    if (!state.facebook_typing) return { feature: null, message: null };
    const text = stripUserText(stringifyForMatch(message)).toLowerCase();
    if (!text) return { feature: null, message: null };
    if (isSendIntent(text)) return { feature: null, message: null };
    if (READ_MARKERS.test(text) && !state.facebook_messages) {
      return { feature: null, message: null };
    }
    const typing =
      (TYPING_WRITE_INTENT.test(text) && TYPING_CONTEXT.test(text)) ||
      (TYPING_STATE.test(text) &&
        TASK_ENVELOPE.test(text) &&
        THREAD_TARGET.test(text));
    return typing
      ? { feature: "facebook_typing" }
      : { feature: null, message: null };
  }

  const BRIDGE_CAPTURE_INTEREST =
    /send|read|receipt|watermark|typing|seen|mark|task|queue|ls_req|msys/i;
  const BRIDGE_CAPTURE_NOISE =
    /responsiveness|dgw_client|ods_|falco|banzai|qpl|browser_phase/i;

  function captureBridge(message, action) {
    try {
      const text = stripUserText(stringifyForMatch(message));
      if (!text || BRIDGE_CAPTURE_NOISE.test(text)) return;
      if (!BRIDGE_CAPTURE_INTEREST.test(text)) return;
      window.postMessage(
        {
          source: "stay-unseen",
          type: "bridgecapture",
          action: action || "forwarded",
          snippet: text.slice(0, 400),
          t: Date.now()
        },
        "*"
      );
    } catch (err) {}
  }

  function hookWorkerBridge(proto) {
    if (!proto || typeof proto.postMessage !== "function") return;
    if (proto.postMessage.__stayUnseenWrapped) return;
    const orig = proto.postMessage;
    const wrapped = function (message) {
      const verdict = inspectWorkerMessage(message);
      if (verdict.feature) {
        captureBridge(message, "dropped");
        notify(verdict.feature, "worker-bridge");
        return;
      }
      captureBridge(message, "forwarded");
      return orig.apply(this, arguments);
    };
    try {
      Object.defineProperty(wrapped, "__stayUnseenWrapped", {
        value: true,
        configurable: true
      });
    } catch (err) {}
    try {
      proto.postMessage = wrapped;
    } catch (err) {}
  }

  hookWorkerBridge(typeof Worker !== "undefined" ? Worker.prototype : null);
  hookWorkerBridge(
    typeof MessagePort !== "undefined" ? MessagePort.prototype : null
  );

  const TYPING_MODULE_NAME =
    /sendchatstatefromcomposer|sendtypingindicator|send_typing_indicator|lssendtypingindicator|typingindicatorstoredprocedure|sendchatstate|send_chat_state|securetypingstate|typing.*send|send.*typing/i;

  function isTypingExportName(name, allowDefault) {
    const n = String(name || "").toLowerCase();
    if (allowDefault && n === "default") return true;
    return (
      n.includes("sendtyping") ||
      n.includes("send_typing") ||
      n.includes("sendchatstate") ||
      n.includes("send_chat_state") ||
      n.includes("typingindicator")
    );
  }

  function wrapTypingFunction(fn) {
    if (typeof fn !== "function" || fn.__stayUnseenTypingWrapped) return fn;
    const wrapped = function () {
      if (state.facebook_typing) {
        notifyThrottled("facebook_typing", "module-export");
        return;
      }
      return fn.apply(this, arguments);
    };
    try {
      Object.defineProperty(wrapped, "__stayUnseenTypingWrapped", {
        value: true,
        configurable: true
      });
    } catch (err) {}
    return wrapped;
  }

  function wrapTypingExport(value, allowDefault) {
    if (typeof value === "function") return wrapTypingFunction(value);
    if (!value || typeof value !== "object") return value;
    for (const key of Object.getOwnPropertyNames(value)) {
      try {
        const candidate = value[key];
        if (
          typeof candidate === "function" &&
          (isTypingExportName(key, allowDefault) ||
            isTypingExportName(candidate.name, allowDefault))
        ) {
          value[key] = wrapTypingFunction(candidate);
        }
      } catch (err) {}
    }
    return value;
  }

  const READ_MODULE_IDENTITIES = {
    lssendreadreceipt: true,
    sendreadreceipt: true,
    lssendreadreceiptstoredprocedure: true,
    readreceiptmutation: true,
    sendreadreceiptmutation: true,
    markthreadasread: true,
    lsmarkthreadasread: true,
    mwmarkthreadasread: true,
    mawmarkthreadasread: true,
    lsupdatethreadreadwatermark: true,
    lsmarkthreadread: true,
    lsmarkthreadreadv2: true,
    mwmarkthreadread: true,
    lsupdatelastreadwatermark: true,
    markthreadread: true,
    updatelastreadwatermark: true,
    updatethreadreadwatermark: true,
    lsupdatereadreceipt: true,
    lsmailboxupdatereadreceiptstoredprocedure: true,
    updatereadreceipt: true
  };

  const PRESERVED_READ_INFRASTRUCTURE = {
    mawmarkthreadasreadscheduler: true,
    mawmarkthreadasreadtxns: true,
    mawmarkthreadasreaduptoapi: true
  };

  function isPreservedInfrastructureName(lowerName) {
    return (
      lowerName.includes("scheduler") ||
      lowerName.includes("txns") ||
      lowerName.includes("uptoapi") ||
      lowerName.includes("up_to_api")
    );
  }

  const REQUIRE_ONLY_IDENTITIES = {
    lsoptimisticmarkthreadreadv2: true
  };

  function normalizeModuleIdentity(name) {
    return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function isReadModuleIdentity(moduleName) {
    const id = normalizeModuleIdentity(moduleName);
    return (
      !!id &&
      Object.prototype.hasOwnProperty.call(READ_MODULE_IDENTITIES, id)
    );
  }

  function isReadExportName(name, allowDefault) {
    const n = String(name || "").toLowerCase();
    if (allowDefault && n === "default") return true;
    if (isPreservedInfrastructureName(n)) return false;
    return (
      n.includes("sendreadreceipt") ||
      n.includes("send_read_receipt") ||
      n.includes("readreceipt") ||
      n.includes("markthreadasread") ||
      n.includes("mark_thread_as_read") ||
      n.includes("markthreadread") ||
      n.includes("markasread") ||
      n.includes("markread") ||
      n.includes("mark_seen") ||
      n.includes("markseen") ||
      n.includes("readwatermark") ||
      n.includes("updatelastseenat") ||
      n.includes("lsmarkthreadread") ||
      n.includes("mwmarkthreadread")
    );
  }

  function isConstructorLike(fn) {
    try {
      if (/^class[\s{]/.test(Function.prototype.toString.call(fn))) return true;
    } catch (err) {}
    try {
      const proto = fn.prototype;
      if (proto && Object.getOwnPropertyNames(proto).length > 1) return true;
    } catch (err) {}
    return false;
  }

  function resolveEmptyChangeset(args) {
    if (!args || !args.length) return { handled: false, value: undefined };
    for (let i = 0; i < args.length; i++) {
      const runtime = args[i];
      if (runtime && typeof runtime.resolve === "function") {
        try {
          return {
            handled: true,
            value: Reflect.apply(runtime.resolve, runtime, [[]])
          };
        } catch (err) {
          return { handled: false, value: undefined };
        }
      }
    }
    return { handled: false, value: undefined };
  }

  function wrapReadFunction(fn) {
    if (typeof fn !== "function" || fn.__stayUnseenReadWrapped) return fn;
    if (isConstructorLike(fn)) return fn;
    const wrapped = function () {
      if (state.facebook_messages) {
        notifyThrottled("facebook_messages", "module-export");
        captureModuleFiring(wrapped.__stayUnseenOrigin, "read-export");
        const settled = resolveEmptyChangeset(arguments);
        return settled.handled ? settled.value : Promise.resolve(undefined);
      }
      return fn.apply(this, arguments);
    };
    try {
      Object.defineProperty(wrapped, "__stayUnseenReadWrapped", {
        value: true,
        configurable: true
      });
    } catch (err) {}
    return wrapped;
  }

  function wrapReadExport(value, allowDefault) {
    if (typeof value === "function") return wrapReadFunction(value);
    if (!value || typeof value !== "object") return value;
    for (const key of Object.getOwnPropertyNames(value)) {
      try {
        const candidate = value[key];
        if (
          typeof candidate === "function" &&
          (isReadExportName(key, allowDefault) ||
            isReadExportName(candidate.name, allowDefault))
        ) {
          value[key] = wrapReadFunction(candidate);
        }
      } catch (err) {}
    }
    return value;
  }

  const STORY_MODULE_IDENTITIES = {
    storiesmarkseenmutation: true,
    storiesseenstatemutation: true,
    storiesmarkbucketseen: true,
    storiesviewermarkseenmutation: true,
    storyviewerseenmutation: true,
    storyseenmutation: true,
    markstoryseen: true,
    lsmarkstoryseen: true,
    storybucketseenstate: true
  };

  function isStoryModuleIdentity(moduleName) {
    const id = normalizeModuleIdentity(moduleName);
    if (!id) return false;
    if (Object.prototype.hasOwnProperty.call(STORY_MODULE_IDENTITIES, id)) {
      return true;
    }
    if (/^use/.test(id)) return false;
    return matchesStorySeenShape(id);
  }

  function storyLeafKind(moduleName) {
    const id = normalizeModuleIdentity(moduleName);
    if (Object.prototype.hasOwnProperty.call(STORY_MODULE_IDENTITIES, id)) {
      return "story";
    }
    return storyShapeTier(id) === "write" ? "story" : "storyLoose";
  }

  const STORY_SUBJECT = /story|stories|reel|bucket/;
  const STORY_VERB_WRITE =
    /mutation|markseen|setseen|commitseen|updateseen|seenupdate/;
  const STORY_VERB_LOOSE =
    /update|commit|mark|store|action|dispatch|seenstate|write|send|report|flush|setter/;
  const STORY_READER =
    /query|fragment|refetchable|pagination|typedef|schema|selector/;

  function storyShapeTier(id) {
    if (!id.includes("seen")) return null;
    if (STORY_READER.test(id)) return null;
    if (!STORY_SUBJECT.test(id)) return null;
    if (STORY_VERB_WRITE.test(id)) return "write";
    if (STORY_VERB_LOOSE.test(id)) return "loose";
    return null;
  }

  function matchesStorySeenShape(id) {
    return storyShapeTier(id) !== null;
  }

  const STORY_READ_ACCESSOR =
    /^_*(get|is|has|should|can|use|select|read|fetch|load|query|find|compute|derive|subscribe|watch|observe|peek)/;

  function isStoryExportName(name, allowDefault) {
    const n = String(name || "").toLowerCase();
    if (allowDefault && n === "default") return true;
    if (isPreservedInfrastructureName(n)) return false;
    if (STORY_READ_ACCESSOR.test(n)) return false;
    return (
      n.includes("markstoryseen") ||
      n.includes("mark_story_seen") ||
      n.includes("markbucketseen") ||
      n.includes("storyseen") ||
      n.includes("bucketseen") ||
      n.includes("markseen") ||
      n.includes("mark_seen") ||
      n.includes("setseen") ||
      n.includes("set_seen") ||
      n.includes("setseenstate") ||
      n.includes("updateseenstate") ||
      n.includes("commitseen")
    );
  }

  function isComponentLike(fn) {
    try {
      if (fn.displayName || fn.propTypes || fn.contextTypes) return true;
    } catch (err) {}
    try {
      const n = String(fn.name || "").replace(/^_+/, "");
      const head = n.charAt(0);
      if (head && head === head.toUpperCase() && head !== head.toLowerCase()) {
        return true;
      }
    } catch (err) {}
    return false;
  }

  function wrapStoryFunction(fn) {
    if (typeof fn !== "function" || fn.__stayUnseenStoryWrapped) return fn;
    if (isConstructorLike(fn)) return fn;
    if (isComponentLike(fn)) return fn;
    const wrapped = function () {
      if (state.facebook_stories) {
        notifyThrottled("facebook_stories", "module-export");
        captureModuleFiring(wrapped.__stayUnseenOrigin, "story-export");
        const settled = resolveEmptyChangeset(arguments);
        return settled.handled ? settled.value : Promise.resolve(undefined);
      }
      return fn.apply(this, arguments);
    };
    try {
      Object.defineProperty(wrapped, "__stayUnseenStoryWrapped", {
        value: true,
        configurable: true
      });
    } catch (err) {}
    return wrapped;
  }

  function wrapStoryExport(value, allowDefault) {
    if (typeof value === "function") return wrapStoryFunction(value);
    if (!value || typeof value !== "object") return value;
    for (const key of Object.getOwnPropertyNames(value)) {
      try {
        const candidate = value[key];
        if (
          typeof candidate === "function" &&
          (isStoryExportName(key, allowDefault) ||
            isStoryExportName(candidate.name, allowDefault))
        ) {
          value[key] = wrapStoryFunction(candidate);
        }
      } catch (err) {}
    }
    return value;
  }

  const READ_HOOK_IDENTITIES = {
    usemarkthreadasreadmutation: true,
    usemarkthreadreadmutation: true,
    usemwmarkthreadasreadmutation: true,
    usesendreadreceiptmutation: true,
    usereadreceiptmutation: true,
    useupdatethreadreadwatermark: true,
    usemarkasreadmutation: true,
    usemwlsmarkthreadasread: true,
    usemawmarkthreadasread: true,
    usemwpsafelymarkthreadasread: true,
    usemwmarkthreadasreadwhennewmessagesarrive: true
  };

  const STORY_HOOK_IDENTITIES = {
    usestoriesmarkseenmutation: true,
    usestoryseenmutation: true,
    usemarkstoryseenmutation: true,
    usestoriesviewermarkseenmutation: true,
    usemarkbucketseenmutation: true
  };

  function isReadHookIdentity(moduleName) {
    const id = normalizeModuleIdentity(moduleName);
    return !!id && Object.prototype.hasOwnProperty.call(READ_HOOK_IDENTITIES, id);
  }

  function isStoryHookIdentity(moduleName) {
    const id = normalizeModuleIdentity(moduleName);
    if (!id) return false;
    if (Object.prototype.hasOwnProperty.call(STORY_HOOK_IDENTITIES, id)) {
      return true;
    }
    return /^use/.test(id) && storyShapeTier(id) === "write";
  }

  const COMMIT_KEYS =
    /^(?:commit|mutate|execute|run|send|call|dispatch|markasread|markread|markseen|onseen|seen)$/i;

  function noopCommitResult() {
    return {
      dispose() {},
      then(onFulfilled) {
        return Promise.resolve(undefined).then(onFulfilled);
      },
      catch() {
        return Promise.resolve(undefined);
      },
      finally(onFinally) {
        return Promise.resolve(undefined).finally(onFinally);
      }
    };
  }

  const commitGuards = new WeakMap();

  function guardCommit(fn, feature, origin) {
    let byFeature = commitGuards.get(fn);
    if (!byFeature) {
      byFeature = Object.create(null);
      commitGuards.set(fn, byFeature);
    }
    if (byFeature[feature]) return byFeature[feature];
    const guarded = function () {
      if (state[feature]) {
        notifyThrottled(feature, "hook-commit");
        captureModuleFiring(origin, "hook-commit");
        return noopCommitResult();
      }
      return fn.apply(this, arguments);
    };
    byFeature[feature] = guarded;
    return guarded;
  }

  function neutralizeCommit(result, feature, origin) {
    if (typeof result === "function") return guardCommit(result, feature, origin);
    if (Array.isArray(result)) {
      let changed = false;
      const out = result.map((item) => {
        if (typeof item !== "function") return item;
        changed = true;
        return guardCommit(item, feature, origin);
      });
      return changed ? out : result;
    }
    if (!result || typeof result !== "object") return result;
    let changed = false;
    const out = {};
    for (const key of Object.keys(result)) {
      const value = result[key];
      if (typeof value === "function" && COMMIT_KEYS.test(key)) {
        out[key] = guardCommit(value, feature, origin);
        changed = true;
      } else {
        out[key] = value;
      }
    }
    return changed ? out : result;
  }

  function wrapHookFunction(hook, feature) {
    if (typeof hook !== "function" || hook.__stayUnseenHookWrapped) return hook;
    const wrapped = function () {
      const result = hook.apply(this, arguments);
      return neutralizeCommit(result, feature, hook.__stayUnseenOrigin);
    };
    try {
      Object.defineProperty(wrapped, "__stayUnseenHookWrapped", {
        value: true,
        configurable: true
      });
    } catch (err) {}
    return wrapped;
  }

  function isHookExportName(name, allowDefault) {
    const n = String(name || "").toLowerCase();
    if (allowDefault && n === "default") return true;
    return n.startsWith("use");
  }

  function wrapHookExport(value, feature, allowDefault) {
    if (typeof value === "function") return wrapHookFunction(value, feature);
    if (!value || typeof value !== "object") return value;
    for (const key of Object.getOwnPropertyNames(value)) {
      try {
        const candidate = value[key];
        if (
          typeof candidate === "function" &&
          (isHookExportName(key, allowDefault) ||
            isHookExportName(candidate.name, allowDefault))
        ) {
          value[key] = wrapHookFunction(candidate, feature);
        }
      } catch (err) {}
    }
    return value;
  }

  function classifyModule(moduleName) {
    if (typeof moduleName !== "string" || !moduleName) return null;
    const id = normalizeModuleIdentity(moduleName);
    if (Object.prototype.hasOwnProperty.call(PRESERVED_READ_INFRASTRUCTURE, id)) {
      return null;
    }
    if (TYPING_MODULE_NAME.test(moduleName)) return "typing";
    if (isReadModuleIdentity(moduleName)) return "read";
    if (isStoryModuleIdentity(moduleName)) return storyLeafKind(moduleName);
    if (isReadHookIdentity(moduleName)) return "readHook";
    if (isStoryHookIdentity(moduleName)) return "storyHook";
    if (Object.prototype.hasOwnProperty.call(REQUIRE_ONLY_IDENTITIES, id)) {
      return "requireOnly";
    }
    return null;
  }

  function wrapByKind(kind, value, origin) {
    const wrapped = (function () {
      switch (kind) {
        case "typing":
          return wrapTypingExport(value, true);
        case "read":
          return wrapReadExport(value, true);
        case "story":
          return wrapStoryExport(value, true);
        case "storyLoose":
          return wrapStoryExport(value, false);
        case "readHook":
          return wrapHookExport(value, "facebook_messages", true);
        case "storyHook":
          return wrapHookExport(value, "facebook_stories", true);
        default:
          return value;
      }
    })();
    if (origin) stampOrigin(wrapped, origin);
    return wrapped;
  }

  function stampOrigin(value, origin) {
    try {
      if (typeof value === "function") {
        Object.defineProperty(value, "__stayUnseenOrigin", {
          value: origin,
          configurable: true
        });
        return value;
      }
      if (value && typeof value === "object") {
        for (const key of Object.getOwnPropertyNames(value)) {
          const item = value[key];
          if (typeof item === "function" && !item.__stayUnseenOrigin) {
            Object.defineProperty(item, "__stayUnseenOrigin", {
              value: origin,
              configurable: true
            });
          }
        }
      }
    } catch (err) {}
    return value;
  }

  function captureModuleFiring(origin, action) {
    try {
      if (!origin) return;
      window.postMessage(
        {
          source: "stay-unseen",
          type: "modulefire",
          name: String(origin).slice(0, 120),
          action: String(action || "").slice(0, 24),
          t: Date.now()
        },
        "*"
      );
    } catch (err) {}
  }

  function wrapModuleFactory(factory, selfKind, selfName) {
    const guarded = function (...factoryArgs) {
      for (let i = 1; i <= 3; i++) {
        const origRequire = factoryArgs[i];
        if (
          typeof origRequire !== "function" ||
          origRequire.__stayUnseenRequireWrapped
        ) {
          continue;
        }
        factoryArgs[i] = function (moduleName) {
          const required = origRequire.apply(this, arguments);
          const kind = classifyModule(moduleName);
          return kind ? wrapByKind(kind, required, moduleName) : required;
        };
        try {
          Object.defineProperty(factoryArgs[i], "__stayUnseenRequireWrapped", {
            value: true,
            configurable: true
          });
        } catch (err) {}
      }
      const result = factory.apply(this, factoryArgs);
      if (selfKind) {
        for (const candidate of factoryArgs) {
          if (
            candidate &&
            typeof candidate === "object" &&
            "exports" in candidate
          ) {
            try {
              candidate.exports = wrapByKind(
                selfKind,
                candidate.exports,
                selfName
              );
            } catch (err) {}
          }
        }
      }
      return result;
    };
    try {
      Object.defineProperty(guarded, "__stayUnseenFactoryWrapped", {
        value: true,
        configurable: true
      });
    } catch (err) {}
    return guarded;
  }

  const probedModules = new Set();
  const PROBE_INTEREST = /seen|markread|markthread|readreceipt|watermark/;
  const PROBE_LIMIT = 80;

  function probeModuleName(moduleName, matchedKind) {
    if (typeof moduleName !== "string" || !moduleName) return;
    const id = normalizeModuleIdentity(moduleName);
    if (!PROBE_INTEREST.test(id)) return;
    if (probedModules.has(id) || probedModules.size >= PROBE_LIMIT) return;
    probedModules.add(id);
    try {
      window.postMessage(
        {
          source: "stay-unseen",
          type: "moduleprobe",
          name: String(moduleName).slice(0, 120),
          kind: matchedKind || "",
          t: Date.now()
        },
        "*"
      );
    } catch (err) {}
  }

  function hookModuleDefines() {
    if (window.__stayUnseenModuleHook) return;
    window.__stayUnseenModuleHook = true;
    let originalDefine;
    const wrapDefine = (target) => {
      if (typeof target !== "function" || target.__stayUnseenDefineWrapped) {
        return target;
      }
      const wrapped = function (...args) {
        const moduleName = args[0];
        const dependencies = args[1];
        const factory = args[2];
        if (
          typeof factory === "function" &&
          !factory.__stayUnseenFactoryWrapped
        ) {
          const selfKind = classifyModule(moduleName);
          probeModuleName(moduleName, selfKind);
          const usesOne =
            Array.isArray(dependencies) &&
            dependencies.some((dep) => classifyModule(dep) !== null);
          if (selfKind || usesOne) {
            args[2] = wrapModuleFactory(factory, selfKind, moduleName);
          }
        }
        return target.apply(this, args);
      };
      try {
        Object.defineProperty(wrapped, "__stayUnseenDefineWrapped", {
          value: true,
          configurable: true
        });
      } catch (err) {}
      return wrapped;
    };
    originalDefine = wrapDefine(window.__d);
    try {
      Object.defineProperty(window, "__d", {
        get() {
          return originalDefine;
        },
        set(value) {
          originalDefine = wrapDefine(value);
        },
        configurable: true
      });
    } catch (err) {}
  }

  hookModuleDefines();

  function spoofLocationParts() {
    try {
      const loc = window.location || {};
      return {
        host: String(loc.hostname || "").toLowerCase(),
        path: String(loc.pathname || "/").toLowerCase(),
        search: String(loc.search || "").toLowerCase(),
        hash: String(loc.hash || "").toLowerCase()
      };
    } catch (err) {
      return { host: "", path: "/", search: "", hash: "" };
    }
  }

  function shouldSpoofFocus() {
    if (!settingsReady) return false;
    if (!state.facebook_messages) return false;
    const { host, path, search, hash } = spoofLocationParts();
    const isMessenger = /(^|\.)messenger\.com$/.test(host);
    const isFacebook = /(^|\.)facebook\.com$/.test(host);
    if (!isMessenger && !isFacebook) return false;
    const route = `${path} ${search} ${hash}`;
    if (
      route.includes("/requests") ||
      route.includes("message_requests") ||
      route.includes("message-requests") ||
      route.includes("pending_threads") ||
      route.includes("filtered_threads") ||
      route.includes("spam_threads")
    ) {
      return false;
    }
    if (isMessenger) {
      return path.startsWith("/t/") || path.startsWith("/e2ee/t/");
    }
    return (
      path.startsWith("/messages") ||
      path.startsWith("/messenger") ||
      search.includes("sk=messages") ||
      hash.includes("messages")
    );
  }

  const FOCUS_EVENT_TYPES = ["focus", "blur", "focusin", "focusout"];
  const focusListenerWrappers = new WeakMap();

  function getWrappedFocusListener(type, listener) {
    let typeMap = focusListenerWrappers.get(listener);
    if (!typeMap) {
      typeMap = new Map();
      focusListenerWrappers.set(listener, typeMap);
    }
    if (typeMap.has(type)) return typeMap.get(type);
    const wrapped = function (event) {
      if (shouldSpoofFocus()) {
        if (
          this === window ||
          this === document ||
          (event && (event.target === window || event.target === document))
        ) {
          return;
        }
      }
      if (typeof listener === "function") return listener.call(this, event);
      if (listener && typeof listener.handleEvent === "function")
        return listener.handleEvent.call(listener, event);
    };
    typeMap.set(type, wrapped);
    return wrapped;
  }

  function findWrappedFocusListener(type, listener) {
    if (!listener) return null;
    const typeMap = focusListenerWrappers.get(listener);
    return typeMap ? typeMap.get(type) || null : null;
  }

  function hookFocusSpoof() {
    if (typeof document === "undefined" || typeof EventTarget === "undefined")
      return;
    if (window.__stayUnseenFocusSpoofed) return;
    window.__stayUnseenFocusSpoofed = true;
    const origHasFocus = document.hasFocus;
    try {
      Object.defineProperty(document, "hasFocus", {
        value: function () {
          if (shouldSpoofFocus()) return false;
          return typeof origHasFocus === "function"
            ? origHasFocus.call(document)
            : true;
        },
        configurable: true
      });
    } catch (err) {}
    const origAdd = EventTarget.prototype.addEventListener;
    if (typeof origAdd !== "function") return;
    const origRemove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (
      type,
      listener,
      options
    ) {
      if (!FOCUS_EVENT_TYPES.includes(type) || !listener) {
        return origAdd.call(this, type, listener, options);
      }
      return origAdd.call(
        this,
        type,
        getWrappedFocusListener(type, listener),
        options
      );
    };
    if (typeof origRemove === "function") {
      EventTarget.prototype.removeEventListener = function (
        type,
        listener,
        options
      ) {
        const wrapped = FOCUS_EVENT_TYPES.includes(type)
          ? findWrappedFocusListener(type, listener)
          : null;
        return origRemove.call(this, type, wrapped || listener, options);
      };
    }
  }

  hookFocusSpoof();
})();
