// Test-only companion for the pinned TalkBack build. Never included unless --companion is requested.
package com.google.android.accessibility.talkback;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Rect;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import com.google.android.accessibility.utils.Performance;
import com.google.android.accessibility.utils.output.FailoverTextToSpeech.FailoverTtsListener;
import com.google.android.accessibility.utils.output.FailoverTextToSpeech.UtteranceInfoCombo;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.UUID;
import java.util.function.BooleanSupplier;
import org.json.JSONArray;
import org.json.JSONObject;

/** Shell-only ordered broadcasts invoke TalkBack's own gesture actions on its main thread. */
public final class AloudBridge extends BroadcastReceiver implements FailoverTtsListener {
  public static final String ACTION = "org.irs_public.aloud.TALKBACK_COMMAND";
  public static final String PIN = "229212fdf5842191d0a93fc95d9ca1423b346866";
  private static AloudBridge instance;
  private static BooleanSupplier scrollPending = () -> false;
  public static void setScrollPending(BooleanSupplier supplier) { scrollPending = supplier; }
  private final TalkBackService service;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private final String session = UUID.randomUUID().toString();
  private final ArrayList<AccessibilityNodeInfo> nodes = new ArrayList<>();
  private String requestId, screen, target;
  private int sequence = -1, windowId;
  private PendingResult pending;
  private JSONObject response;
  private JSONArray signals, speech, events;
  private long started, changed;
  private String failure;
  private boolean focused;

  private AloudBridge(TalkBackService service) { this.service = service; }

  public static void install(TalkBackService service) {
    if (!BuildConfig.DEBUG) throw new IllegalStateException("Aloud requires a debug build");
    instance = new AloudBridge(service);
    // DUMP is a platform signature/privileged permission held by adb shell/root, not ordinary apps.
    // No exported manifest component, implicit receiver, TCP port, or unauthenticated service.
    service.registerReceiver(instance, new IntentFilter(ACTION), "android.permission.DUMP", null,
        Context.RECEIVER_EXPORTED);
    service.getSpeechController().getFailoverTts().addListener(instance);
  }

  public static void destroy() {
    if (instance == null) return;
    if (instance.pending != null) instance.finish("service-stopped");
    instance.service.getSpeechController().getFailoverTts().removeListener(instance);
    instance.service.unregisterReceiver(instance);
    instance.recycleNodes();
    instance = null;
  }

  /** Observes exact upstream branches; never changes their return values or navigation decisions. */
  public static void signal(String signal) {
    if (instance != null && instance.pending != null) {
      instance.signals.put(signal);
      instance.changed = SystemClock.uptimeMillis();
      if (signal.equals("scroll-failed") || signal.equals("wrap")) instance.failure = signal;
    }
  }

  public static void event(AccessibilityEvent event) {
    if (instance == null || instance.pending == null) return;
    AloudBridge b = instance;
    int type = event.getEventType();
    if (type == AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUSED) {
      AccessibilityNodeInfo node = event.getSource();
      if (node != null) {
        b.events.put(b.nodeJson(node));
        b.focused = true;
        b.changed = SystemClock.uptimeMillis();
        if (node.getWindowId() != b.windowId || !b.target.contentEquals(safe(node.getPackageName()))) {
          b.failure = "target-changed";
        }
        node.recycle();
      }
    } else if (type == AccessibilityEvent.TYPE_NOTIFICATION_STATE_CHANGED
        && !b.target.contentEquals(safe(event.getPackageName()))) {
      b.failure = "external-notification";
    } else if (type == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED && event.getWindowId() != b.windowId) {
      b.failure = "window-changed";
    } else if (type == AccessibilityEvent.TYPE_VIEW_SCROLLED) {
      b.changed = SystemClock.uptimeMillis();
    }
  }

  private void recycleNodes() {
    for (AccessibilityNodeInfo node : nodes) node.recycle();
    nodes.clear();
  }

  private static String safe(CharSequence text) { return text == null ? "" : text.toString(); }
  private static void put(JSONObject object, String key, Object value) {
    try { object.put(key, value); } catch (org.json.JSONException e) { throw new IllegalStateException(e); }
  }

  private JSONObject nodeJson(AccessibilityNodeInfo node) {
    JSONObject value = new JSONObject();
    if (node == null) return value;
    int index = nodes.indexOf(node);
    if (index < 0) { index = nodes.size(); nodes.add(AccessibilityNodeInfo.obtain(node)); }
    Rect rect = new Rect(); node.getBoundsInScreen(rect);
    put(value, "id", "node-" + index);
    put(value, "windowId", node.getWindowId());
    put(value, "packageName", safe(node.getPackageName()));
    put(value, "viewId", safe(node.getViewIdResourceName()));
    put(value, "className", safe(node.getClassName()));
    put(value, "text", safe(node.getText()));
    put(value, "description", safe(node.getContentDescription()));
    put(value, "enabled", node.isEnabled());
    put(value, "bounds", rect.flattenToString());
    return value;
  }

  private AccessibilityNodeInfo focus() {
    return service.findFocus(AccessibilityNodeInfo.FOCUS_ACCESSIBILITY);
  }

  private boolean targetMatches() {
    AccessibilityNodeInfo root = service.getRootInActiveWindow();
    if (root == null) return false;
    boolean matches = target.contentEquals(safe(root.getPackageName())) && root.getWindowId() == windowId;
    root.recycle();
    return matches;
  }

  @Override public void onReceive(Context context, Intent intent) {
    if (!isOrderedBroadcast()) return;
    if (pending != null) { setResultCode(409); setResultData("busy"); return; }
    String op = intent.getStringExtra("op");
    String incoming = intent.getStringExtra("requestId");
    String incomingScreen = intent.getStringExtra("screen");
    String incomingTarget = intent.getStringExtra("target");
    int next = intent.getIntExtra("sequence", -1);
    if (incoming == null || !incoming.matches("[a-zA-Z0-9-]{1,80}") ||
        incomingScreen == null || !incomingScreen.matches("[a-zA-Z0-9_.-]{1,120}") ||
        incomingTarget == null || !incomingTarget.matches("[a-zA-Z0-9_.]{1,200}")) {
      setResultCode(400); setResultData("invalid identity"); return;
    }
    if ("hello".equals(op) && next == 0) {
      requestId = incoming; screen = incomingScreen; target = incomingTarget; sequence = 0;
      recycleNodes();
      AccessibilityNodeInfo root = service.getRootInActiveWindow();
      windowId = root == null ? -1 : root.getWindowId();
      if (root != null) root.recycle();
    } else if (!incoming.equals(requestId) || !incomingScreen.equals(screen) || !incomingTarget.equals(target) ||
        !session.equals(intent.getStringExtra("session")) || next != sequence + 1 ||
        !("previous".equals(op) || "first".equals(op) || "reset".equals(op) || "next".equals(op))) {
      setResultCode(409); setResultData("stale session or command sequence"); return;
    } else { sequence = next; }
    response = new JSONObject(); signals = new JSONArray(); speech = new JSONArray(); events = new JSONArray();
    put(response, "schemaVersion", 1); put(response, "source", "talkback-focus");
    put(response, "requestId", requestId); put(response, "screen", screen); put(response, "target", target);
    put(response, "sequence", sequence); put(response, "action", op); put(response, "session", session);
    put(response, "talkbackCommit", PIN); put(response, "pid", android.os.Process.myPid());
    put(response, "windowId", windowId); put(response, "runtime", android.os.Build.VERSION.RELEASE);
    AccessibilityNodeInfo before = focus(); put(response, "before", nodeJson(before));
    if (before != null) before.recycle();
    failure = null; focused = false; started = changed = SystemClock.uptimeMillis();
    pending = goAsync();
    if (!targetMatches()) { finish("target-changed"); return; }
    if ("hello".equals(op)) {
      AccessibilityNodeInfo current = focus();
      boolean ready = current != null && current.getWindowId() == windowId
          && target.contentEquals(safe(current.getPackageName()))
          && service.getSpeechController().getFailoverTts().isReady();
      if (current != null) current.recycle();
      finish(ready ? "ready" : "not-ready"); return;
    }
    int action = "next".equals(op) ? R.string.shortcut_value_next :
        "previous".equals(op) ? R.string.shortcut_value_previous : R.string.shortcut_value_first_in_screen;
    service.gestureController.performAction(service.getString(action), Performance.EVENT_ID_UNTRACKED);
    handler.postDelayed(this::poll, 100);
  }

  private void poll() {
    if (pending == null) return;
    if (!targetMatches()) failure = "target-changed";
    long now = SystemClock.uptimeMillis();
    if (failure != null) { finish(failure); return; }
    boolean edge = signals.toString().contains("\"edge\"");
    if ((focused || edge) && now - changed >= 600 && !scrollPending.getAsBoolean() && !service.getSpeechController().isSpeakingOrSpeechQueued()) {
      finish(edge ? "edge" : "focused"); return;
    }
    if (now - started >= 8000) { finish("step-timeout"); return; }
    handler.postDelayed(this::poll, 100);
  }

  private void finish(String status) {
    handler.removeCallbacksAndMessages(null);
    AccessibilityNodeInfo after = focus(); put(response, "after", nodeJson(after));
    if (after != null) after.recycle();
    put(response, "status", status); put(response, "signals", signals);
    put(response, "speech", speech); put(response, "focusEvents", events);
    put(response, "elapsedMs", SystemClock.uptimeMillis() - started);
    String encoded = Base64.encodeToString(response.toString().getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
    pending.setResultCode(200); pending.setResultData(encoded); pending.finish(); pending = null;
  }

  @Override public void onBeforeUtteranceRequested(String id, UtteranceInfoCombo info) {
    if (pending == null) return;
    JSONObject entry = new JSONObject(); put(entry, "utteranceId", id); put(entry, "text", safe(info.text()));
    // This observes TalkBack's own request callback. It is not a recording of audible output.
    speech.put(entry); changed = SystemClock.uptimeMillis();
    if (speech.length() > 100 || speech.toString().length() > 100000) failure = "speech-limit";
  }
  @Override public void onUtteranceRangeStarted(String id, int start, int end) {}
  @Override public void onUtteranceCompleted(String id, boolean success) {
    if (pending != null) changed = SystemClock.uptimeMillis();
  }
}
