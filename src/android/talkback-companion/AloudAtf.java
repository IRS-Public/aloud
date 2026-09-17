package com.google.android.accessibility.talkback;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Rect;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.AtomicFile;
import android.util.Base64;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat;
import com.google.android.apps.common.testing.accessibility.framework.AccessibilityHierarchyCheck;
import com.google.android.apps.common.testing.accessibility.framework.AccessibilityHierarchyCheckResult;
import com.google.android.apps.common.testing.accessibility.framework.checks.*;
import com.google.android.apps.common.testing.accessibility.framework.uielement.AccessibilityHierarchyAndroid;
import com.google.android.apps.common.testing.accessibility.framework.uielement.ViewHierarchyElement;
import com.google.common.collect.BiMap;
import com.google.common.collect.HashBiMap;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Iterator;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

/** Test-only, shell-restricted snapshot checks. No navigation or synthesized node properties. */
public final class AloudAtf extends BroadcastReceiver {
  public static final String ACTION = "org.irs_public.aloud.ATF_COMMAND";
  public static final String VERSION = "4.1.1";
  private static final String[] RULES = {"atf-speakable-text-present", "atf-editable-content-desc",
      "atf-touch-target-size", "atf-duplicate-speakable-text", "atf-redundant-description", "atf-class-name"};
  private static AloudAtf instance;
  private final TalkBackService service;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private final String session = UUID.randomUUID().toString();
  private volatile long changes;
  private volatile long lastChangeAt = SystemClock.uptimeMillis();
  private volatile boolean alive = true, busy;
  private String lastRequest, lastScreen, lastTarget;
  private boolean verified;
  private final ArrayList<JSONObject> changeEvents = new ArrayList<>();

  private AloudAtf(TalkBackService service) { this.service = service; }
  public static void install(TalkBackService service) {
    if (!BuildConfig.DEBUG) throw new IllegalStateException("ATF requires a debug companion");
    instance = new AloudAtf(service);
    service.registerReceiver(instance, new IntentFilter(ACTION), "android.permission.DUMP", null,
        Context.RECEIVER_EXPORTED);
  }
  public static boolean isBusy() { return instance != null && instance.busy; }
  public static void destroy() {
    if (instance == null) return;
    instance.alive = false;
    instance.service.unregisterReceiver(instance);
    instance = null;
  }
  public static void event(AccessibilityEvent event) {
    if (instance == null) return;
    int t = event.getEventType();
    // Clock ticks in SystemUI are not part of the app hierarchy. Focus-only window changes
    // likewise do not change the node properties used by this snapshot suite.
    boolean appContent = instance.lastTarget != null && instance.lastTarget.contentEquals(event.getPackageName() == null ? "" : event.getPackageName()) &&
        (t == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED || t == AccessibilityEvent.TYPE_VIEW_SCROLLED || t == AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED);
    boolean windowChange = t == AccessibilityEvent.TYPE_WINDOWS_CHANGED &&
        (event.getWindowChanges() & ~AccessibilityEvent.WINDOWS_CHANGE_ACCESSIBILITY_FOCUSED) != 0;
    if (appContent || windowChange || t == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED || t == AccessibilityEvent.TYPE_NOTIFICATION_STATE_CHANGED) instance.noteChange(event);
  }
  private synchronized void noteChange(AccessibilityEvent event) {
    changes++;
    lastChangeAt = SystemClock.uptimeMillis();
    changeEvents.add(obj("sequence", changes, "type", AccessibilityEvent.eventTypeToString(event.getEventType()),
        "packageName", text(event.getPackageName()), "windowId", event.getWindowId(), "windowChanges", event.getWindowChanges()));
    if (changeEvents.size() > 20) changeEvents.remove(0);
  }
  private synchronized JSONArray changesSince(long before) {
    JSONArray events = new JSONArray();
    for (JSONObject event : changeEvents) if (event.optLong("sequence") > before) events.put(event);
    return events;
  }
  private static JSONObject obj(Object... pairs) {
    JSONObject o = new JSONObject();
    try { for (int i = 0; i < pairs.length; i += 2) o.put((String) pairs[i], pairs[i + 1] == null ? JSONObject.NULL : pairs[i + 1]); }
    catch (Exception e) { throw new IllegalStateException(e); }
    return o;
  }
  private static void put(JSONObject o, String key, Object value) {
    try { o.put(key, value == null ? JSONObject.NULL : value); } catch (Exception e) { throw new IllegalStateException(e); }
  }
  private static String text(CharSequence s) {
    if (s != null && s.length() > 65536) throw new IllegalStateException("node-text-limit");
    return s == null ? null : s.toString();
  }
  private static String hash(byte[] bytes) throws Exception {
    StringBuilder s = new StringBuilder();
    for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) s.append(String.format(Locale.ROOT, "%02x", b & 255));
    return s.toString();
  }
  private static String id(ViewHierarchyElement e) { return e == null ? null : Long.toString(e.getCondensedUniqueId()); }

  @Override public void onReceive(Context context, Intent intent) {
    if (!isOrderedBroadcast()) return;
    if (busy || AloudBridge.isBusy()) { setResultCode(409); setResultData("busy"); return; }
    String request = intent.getStringExtra("requestId"), screen = intent.getStringExtra("screen");
    String target = intent.getStringExtra("target"), phase = intent.getStringExtra("phase");
    if (request == null || !request.matches("[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}") ||
        screen == null || !screen.matches("[a-zA-Z0-9_.-]{1,120}") ||
        target == null || !target.matches("[a-zA-Z0-9_.]{1,200}") ||
        !("ready".equals(phase) || "capture".equals(phase) || "verify".equals(phase))) {
      setResultCode(400); setResultData("invalid identity"); return;
    }
    if ("ready".equals(phase)) {
      if (!target.equals(lastTarget)) { lastTarget = target; lastChangeAt = SystemClock.uptimeMillis(); }
      AccessibilityNodeInfo root = service.getRootInActiveWindow();
      boolean ready = root != null && target.equals(text(root.getPackageName())) &&
          SystemClock.uptimeMillis() - lastChangeAt >= 1000 && !service.getSpeechController().isSpeakingOrSpeechQueued();
      if (root != null) root.recycle();
      setResultCode(ready ? 204 : 202); setResultData(ready ? "ready" : "settling"); return;
    }
    File dir = new File(service.createDeviceProtectedStorageContext().getFilesDir(), "aloud-atf");
    File file = new File(dir, request + "." + phase + ".json");
    if (file.exists() || ("verify".equals(phase) && (verified || !request.equals(lastRequest) ||
        !screen.equals(lastScreen) || !target.equals(lastTarget) || !session.equals(intent.getStringExtra("session"))))) {
      setResultCode(409); setResultData("stale request or session"); return;
    }
    if ("capture".equals(phase)) { lastRequest = request; lastScreen = screen; lastTarget = target; verified = false; }
    else verified = true;
    busy = true;
    PendingResult pending = goAsync();
    long beforeChanges = changes, started = SystemClock.uptimeMillis();
    // Binder queries and the framework run off the service main thread, which continues observing changes.
    new Thread(() -> {
      JSONObject value = obj("schemaVersion", 1, "source", "android-atf", "requestId", request,
          "screen", screen, "target", target, "phase", phase, "session", session,
          "pid", android.os.Process.myPid(), "talkbackCommit", AloudBridge.PIN,
          "framework", obj("artifact", "com.google.android.apps.common.testing.accessibility.framework:accessibility-test-framework",
              "version", VERSION, "suite", "aloud-node-v1", "origin", "ACCESSIBILITY_NODE_INFOS"),
          "runtime", obj("sdk", Build.VERSION.SDK_INT, "release", Build.VERSION.RELEASE,
              "fingerprint", Build.FINGERPRINT, "locale", Locale.getDefault().toLanguageTag()),
          "densityDpi", service.getResources().getDisplayMetrics().densityDpi,
          "changeSequence", beforeChanges,
          "status", "failed", "error", null, "nodes", new JSONArray(), "checks", new JSONArray());
      try {
        snapshot(value, target, started);
        if (!alive || changes != beforeChanges) throw new IllegalStateException("screen-changed-during-capture");
        put(value, "status", "completed");
      } catch (Exception | LinkageError e) { put(value, "error", e.getClass().getSimpleName() + ": " + e.getMessage()); }
      put(value, "elapsedMs", SystemClock.uptimeMillis() - started);
      // Drain events queued just after the last Binder response before declaring the snapshot complete.
      handler.postDelayed(() -> {
        try {
          if (!alive || changes != beforeChanges) {
            put(value, "status", "failed"); put(value, "error", "screen-changed-during-capture");
          }
          put(value, "observedChanges", changesSince(beforeChanges));
          byte[] bytes = (value.toString() + "\n").getBytes(StandardCharsets.UTF_8);
          if (bytes.length > 8 * 1024 * 1024) throw new IllegalStateException("artifact-size-limit");
          if (!dir.isDirectory() && !dir.mkdirs()) throw new IllegalStateException("artifact-directory-failed");
          AtomicFile atomic = new AtomicFile(file);
          FileOutputStream stream = atomic.startWrite();
          try { stream.write(bytes); stream.getFD().sync(); atomic.finishWrite(stream); }
          catch (Exception e) { atomic.failWrite(stream); throw e; }
          JSONObject receipt = obj("schemaVersion", 1, "source", "android-atf", "requestId", request,
              "screen", screen, "target", target, "phase", phase, "session", session,
              "file", file.getName(), "bytes", bytes.length, "sha256", hash(bytes));
          pending.setResultCode(200);
          pending.setResultData(Base64.encodeToString(receipt.toString().getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
        } catch (Exception e) { pending.setResultCode(500); pending.setResultData("ATF artifact write failed: " + e.getMessage()); }
        finally { busy = false; pending.finish(); }
      }, 150);
    }, "aloud-atf").start();
  }

  private static void budget(long started) {
    if (SystemClock.uptimeMillis() - started > 7000) throw new IllegalStateException("capture-time-limit");
  }
  private static int preflight(AccessibilityNodeInfo n, int depth, int count, long started) {
    budget(started);
    if (depth > 50 || ++count > 500) throw new IllegalStateException("node-limit");
    for (int i = 0; i < n.getChildCount(); i++) {
      AccessibilityNodeInfo child = n.getChild(i);
      if (child == null) throw new IllegalStateException("missing-child");
      try { count = preflight(child, depth + 1, count, started); } finally { child.recycle(); }
    }
    return count;
  }
  private void snapshot(JSONObject value, String target, long started) throws Exception {
    AccessibilityNodeInfo root = service.getRootInActiveWindow();
    if (root == null) throw new IllegalStateException("no-active-root");
    BiMap<Long, AccessibilityNodeInfo> origins = HashBiMap.create();
    try {
      if (!target.equals(text(root.getPackageName()))) throw new IllegalStateException("wrong-target");
      int count = preflight(root, 0, 0, started), window = root.getWindowId();
      put(value, "windowId", window);
      AccessibilityHierarchyAndroid hierarchy = AccessibilityHierarchyAndroid.newBuilder(root, service)
          .setNodeInfoOriginMap(origins).setObtainCharacterLocations(false).setObtainRenderingInfo(false).build();
      List<? extends ViewHierarchyElement> elements = hierarchy.getActiveWindow().getAllViews();
      if (elements.size() != count || origins.size() != count) throw new IllegalStateException("incomplete-node-map");
      JSONArray nodes = new JSONArray();
      for (ViewHierarchyElement element : elements) {
        AccessibilityNodeInfo n = origins.get(element.getCondensedUniqueId());
        if (n == null || n.getWindowId() != window || !target.equals(text(n.getPackageName())) ||
            n.getChildCount() != element.getChildViewCount()) throw new IllegalStateException("node-identity-changed");
        JSONArray children = new JSONArray();
        for (int i = 0; i < element.getChildViewCount(); i++) children.put(id(element.getChildView(i)));
        JSONObject node = node(n);
        put(node, "id", id(element)); put(node, "parentId", id(element.getParentView())); put(node, "children", children);
        nodes.put(node);
      }
      put(value, "nodes", nodes);
      put(value, "propertySupport", obj("hintText", Build.VERSION.SDK_INT >= 26, "stateDescription", Build.VERSION.SDK_INT >= 30,
          "paneTitle", Build.VERSION.SDK_INT >= 28, "roleDescription", true));
      JSONArray checks = new JSONArray(); put(value, "checks", checks);
      AccessibilityHierarchyCheck[] suite = {new SpeakableTextPresentCheck(), new EditableContentDescCheck(),
          new TouchTargetSizeCheck(), new DuplicateSpeakableTextCheck(), new RedundantDescriptionCheck(), new ClassNameCheck()};
      for (int i = 0; i < suite.length; i++) {
        budget(started);
        AccessibilityHierarchyCheck check = suite[i];
        JSONArray results = new JSONArray();
        JSONObject record = obj("ruleId", RULES[i], "className", check.getClass().getName(), "version", VERSION,
            "status", "failed", "error", null, "results", results);
        checks.put(record);
        try {
          for (AccessibilityHierarchyCheckResult r : check.runCheckOnHierarchy(hierarchy)) {
            if (results.length() >= 5000) throw new IllegalStateException("result-limit");
            results.put(obj("elementId", id(r.getElement()), "resultId", r.getResultId(), "type", r.getType().name(),
                "message", text(r.getMessage(Locale.ENGLISH))));
          }
          put(record, "status", "completed");
        } catch (Exception | LinkageError e) {
          put(record, "error", e.getClass().getSimpleName() + ": " + e.getMessage());
          throw e;
        }
      }
      // Refresh every origin after the checks; changed text/state/children invalidates the snapshot.
      for (int i = 0; i < elements.size(); i++) {
        AccessibilityNodeInfo n = origins.get(elements.get(i).getCondensedUniqueId());
        JSONObject old = nodes.getJSONObject(i);
        if (!n.refresh()) throw new IllegalStateException("stale-node");
        JSONObject fresh = node(n);
        for (Iterator<String> keys = fresh.keys(); keys.hasNext();) {
          String key = keys.next();
          if (!fresh.get(key).equals(old.get(key))) throw new IllegalStateException("node-changed: " + key);
        }
      }
      AccessibilityNodeInfo after = service.getRootInActiveWindow();
      try { if (after == null || !root.equals(after) || after.getWindowId() != window ||
          !target.equals(text(after.getPackageName()))) throw new IllegalStateException("active-window-changed"); }
      finally { if (after != null) after.recycle(); }
      budget(started);
    } finally {
      for (AccessibilityNodeInfo n : origins.values()) n.recycle();
      root.recycle();
    }
  }
  private static JSONObject node(AccessibilityNodeInfo n) {
    Rect b = new Rect(); n.getBoundsInScreen(b);
    return obj("packageName", text(n.getPackageName()), "windowId", n.getWindowId(), "viewId", text(n.getViewIdResourceName()),
        "className", text(n.getClassName()), "text", text(n.getText()), "description", text(n.getContentDescription()),
        "hintText", Build.VERSION.SDK_INT >= 26 ? text(n.getHintText()) : null,
        "stateDescription", Build.VERSION.SDK_INT >= 30 ? text(n.getStateDescription()) : null,
        "paneTitle", Build.VERSION.SDK_INT >= 28 ? text(n.getPaneTitle()) : null,
        "roleDescription", text(AccessibilityNodeInfoCompat.wrap(n).getRoleDescription()),
        "bounds", b.flattenToString(), "childCount", n.getChildCount(), "enabled", n.isEnabled(), "visible", n.isVisibleToUser(),
        "important", n.isImportantForAccessibility(), "clickable", n.isClickable(), "longClickable", n.isLongClickable(),
        "focusable", n.isFocusable(), "checkable", n.isCheckable(), "checked", n.isChecked(), "scrollable", n.isScrollable(),
        "editable", n.isEditable(), "showingHint", Build.VERSION.SDK_INT >= 26 && n.isShowingHintText());
  }
}
