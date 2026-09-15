package org.irs_public.aloud.tts;

import android.content.Context;
import android.os.Bundle;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.json.JSONObject;

/** Records the TTS API boundary. Installed only in the explicit logging-engine mode. */
public final class RequestLedger {
  public static final String ENGINE = "org.irs_public.aloud.tts";
  public static final String CONTEXT = ENGINE + ".context";
  public static final String DURATION = ENGINE + ".durationMs";
  private static Journal journal;
  private static boolean enabled;
  private static String failure;
  private static JSONObject scope;
  private static long dispatchNumber, beginEvent;
  private static final Map<String, Dispatch> dispatches = new HashMap<>();

  private static final class Dispatch {
    final String id, original;
    final JSONObject metadata;
    Dispatch(String id, String original, JSONObject metadata) {
      this.id = id; this.original = original; this.metadata = metadata;
    }
  }

  public static synchronized void initialize(Context context) {
    if (journal != null || failure != null) return;
    enabled = ENGINE.equals(Settings.Secure.getString(context.getContentResolver(), "tts_default_synth"));
    if (!enabled) return;
    try { journal = new Journal(context, "client", UUID.randomUUID().toString(), null); }
    catch (RuntimeException e) { failure = e.getMessage(); }
  }

  public static synchronized boolean enabled() { return enabled; }
  public static synchronized String failure() {
    return failure != null ? failure : journal == null ? null : journal.failure();
  }
  public static synchronized String session() { return journal == null ? null : journal.session; }
  private static long record(String kind, JSONObject data) {
    if (failure() != null || journal == null) throw new IllegalStateException("TTS journal unavailable: " + failure());
    try { return journal.append(kind, data); }
    catch (RuntimeException e) { failure = e.getMessage(); throw e; }
  }

  public static synchronized void begin(String requestId, String screen, int sequence, String serviceSession) {
    if (!enabled) return;
    scope = Journal.object("requestId", requestId, "screen", screen, "sequence", sequence,
        "serviceSession", serviceSession);
    try { beginEvent = record("command-begin", Journal.object("scope", scope)); }
    catch (RuntimeException e) { failure = e.getMessage(); }
  }

  public static synchronized JSONObject end() {
    if (!enabled) return null;
    long endEvent = -1;
    try { endEvent = record("command-end", Journal.object("scope", scope)); }
    catch (RuntimeException e) { failure = e.getMessage(); }
    JSONObject result = Journal.object("schemaVersion", 1, "engine", ENGINE, "clientSession", session(),
        "firstEvent", beginEvent, "lastEvent", endEvent, "output", "synthetic-silence", "error", failure());
    scope = null;
    return result;
  }

  public static synchronized void note(String kind, JSONObject data) { if (enabled) record(kind, data); }

  private static synchronized Dispatch prepare(String operation, CharSequence text, Integer queueMode, String original) {
    if (++dispatchNumber > 10000) {
      failure = "TTS dispatch limit reached";
      throw new IllegalStateException(failure);
    }
    String id = session() + ":" + dispatchNumber;
    JSONObject metadata = Journal.object("clientSession", session(), "dispatchId", id,
        "originalUtteranceId", original, "scope", scope);
    Dispatch dispatch = new Dispatch(id, original, metadata);
    dispatches.put(id, dispatch);
    record("request", Journal.object("dispatchId", id, "operation", operation,
        "text", text == null ? null : text.toString(), "queueMode", queueMode,
        "wireId", original == null ? null : id, "metadata", metadata));
    return dispatch;
  }

  private static synchronized int returned(Dispatch dispatch, int result) {
    record("return", Journal.object("dispatchId", dispatch.id, "result", result));
    return result;
  }

  public static int speak(TextToSpeech tts, CharSequence text, int queueMode, Bundle params, String original) {
    if (!enabled()) return tts.speak(text, queueMode, params, original);
    try {
      Dispatch d = prepare("speak", text, queueMode, original);
      Bundle tagged = params == null ? new Bundle() : new Bundle(params);
      tagged.putString(CONTEXT, d.metadata.toString());
      return returned(d, tts.speak(text, queueMode, tagged, original == null ? null : d.id));
    } catch (RuntimeException e) { synchronized (RequestLedger.class) { failure = e.getMessage(); } return TextToSpeech.ERROR; }
  }

  @SuppressWarnings("deprecation")
  public static int speak(TextToSpeech tts, String text, int queueMode, HashMap<String, String> params) {
    if (!enabled()) return tts.speak(text, queueMode, params);
    try {
      String original = params == null ? null : params.get(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID);
      Dispatch d = prepare("speak", text, queueMode, original);
      HashMap<String, String> tagged = params == null ? new HashMap<>() : new HashMap<>(params);
      tagged.put(CONTEXT, d.metadata.toString());
      if (original != null) tagged.put(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, d.id);
      return returned(d, tts.speak(text, queueMode, tagged));
    } catch (RuntimeException e) { synchronized (RequestLedger.class) { failure = e.getMessage(); } return TextToSpeech.ERROR; }
  }

  public static int stop(TextToSpeech tts) {
    if (!enabled()) return tts.stop();
    try { Dispatch d = prepare("stop", null, null, null); return returned(d, tts.stop()); }
    catch (RuntimeException e) { synchronized (RequestLedger.class) { failure = e.getMessage(); } return TextToSpeech.ERROR; }
  }

  public static synchronized String originalId(String wireId) {
    Dispatch d = dispatches.get(wireId);
    return d == null ? wireId : d.original;
  }

  public static synchronized String progress(String kind, String wireId, boolean interrupted) {
    Dispatch d = dispatches.get(wireId);
    if (d == null) return wireId;
    try { record(kind, Journal.object("dispatchId", d.id, "interrupted", interrupted)); }
    catch (RuntimeException e) { failure = e.getMessage(); }
    return d.original;
  }
}
