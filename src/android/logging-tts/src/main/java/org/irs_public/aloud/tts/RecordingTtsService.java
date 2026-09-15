package org.irs_public.aloud.tts;

import android.media.AudioFormat;
import android.os.SystemClock;
import android.speech.tts.SynthesisCallback;
import android.speech.tts.SynthesisRequest;
import android.speech.tts.TextToSpeech;
import android.speech.tts.TextToSpeechService;
import android.speech.tts.Voice;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import org.json.JSONObject;

/** Test engine: durable text receipts and silent PCM, never synthesized spoken words. */
public final class RecordingTtsService extends TextToSpeechService {
  private final String engineSession = UUID.randomUUID().toString();
  private final Map<String, Journal> journals = new HashMap<>();
  private volatile Active active;
  private static final class Active {
    final Journal journal;
    final String dispatchId;
    volatile boolean stopped;
    Active(Journal journal, String dispatchId) { this.journal = journal; this.dispatchId = dispatchId; }
  }

  @Override protected String[] onGetLanguage() { return new String[] {"eng", "USA", ""}; }
  @Override protected int onIsLanguageAvailable(String language, String country, String variant) {
    return "en".equals(language) || "eng".equals(language)
        ? TextToSpeech.LANG_COUNTRY_AVAILABLE : TextToSpeech.LANG_NOT_SUPPORTED;
  }
  @Override protected int onLoadLanguage(String language, String country, String variant) {
    return onIsLanguageAvailable(language, country, variant);
  }
  @Override public List<Voice> onGetVoices() {
    return List.of(new Voice("aloud-recording-en-US", Locale.US, Voice.QUALITY_NORMAL,
        Voice.LATENCY_NORMAL, false, new HashSet<>()));
  }
  @Override public String onGetDefaultVoiceNameFor(String language, String country, String variant) {
    return onIsLanguageAvailable(language, country, variant) >= 0 ? "aloud-recording-en-US" : null;
  }
  @Override public int onIsValidVoiceName(String name) {
    return "aloud-recording-en-US".equals(name) ? TextToSpeech.SUCCESS : TextToSpeech.ERROR;
  }
  @Override public int onLoadVoice(String name) { return onIsValidVoiceName(name); }

  @Override protected void onStop() {
    Active a = active;
    if (a != null) {
      a.stopped = true;
      try { a.journal.append("stop-request", Journal.object("dispatchId", a.dispatchId)); }
      catch (RuntimeException ignored) { /* The failed journal cannot validate as complete. */ }
    }
  }

  @Override protected void onSynthesizeText(SynthesisRequest request, SynthesisCallback callback) {
    Active current = null;
    try {
      String context = request.getParams().getString(RequestLedger.CONTEXT);
      JSONObject metadata = context == null ? new JSONObject() : new JSONObject(context);
      String clientSession = metadata.optString("clientSession");
      if (!clientSession.matches("[a-f0-9-]{36}")) clientSession = "unscoped";
      String dispatchId = metadata.optString("dispatchId", "unscoped-" + UUID.randomUUID());
      Journal journal = journals.get(clientSession);
      if (journal == null) {
        journal = new Journal(this, "engine", engineSession, clientSession);
        journals.put(clientSession, journal);
      }
      current = new Active(journal, dispatchId);
      active = current;
      journal.append("received", Journal.object("dispatchId", dispatchId, "metadata", metadata,
          "text", request.getCharSequenceText().toString(), "callerUid", request.getCallerUid(),
          "language", request.getLanguage(), "country", request.getCountry(), "variant", request.getVariant(),
          "speechRate", request.getSpeechRate(), "pitch", request.getPitch()));
      int result = callback.start(16000, AudioFormat.ENCODING_PCM_16BIT, 1);
      journal.append("synthesis-start", Journal.object("dispatchId", dispatchId, "result", result,
          "sampleRate", 16000, "channels", 1, "encoding", "pcm16", "output", "synthetic-silence"));
      if (result != TextToSpeech.SUCCESS) {
        journal.append("synthesis-error", Journal.object("dispatchId", dispatchId, "result", result));
        return;
      }
      int duration = Math.max(8, Math.min(1000, request.getParams().getInt(RequestLedger.DURATION, 120)));
      int remaining = duration * 32, bytes = 0;
      byte[] silence = new byte[Math.min(1600, callback.getMaxBufferSize())];
      while (remaining > 0 && !current.stopped) {
        int count = Math.min(remaining, silence.length);
        result = callback.audioAvailable(silence, 0, count);
        if (result != TextToSpeech.SUCCESS) break;
        remaining -= count; bytes += count;
        // Pace synthesis enough to observe active interruptions, without pretending to speak text.
        SystemClock.sleep(10);
      }
      if (current.stopped) {
        journal.append("synthesis-stopped", Journal.object("dispatchId", dispatchId, "bytes", bytes));
      } else if (result != TextToSpeech.SUCCESS) {
        journal.append("synthesis-error", Journal.object("dispatchId", dispatchId, "result", result, "bytes", bytes));
        callback.error();
      } else {
        result = callback.done();
        journal.append("synthesis-complete", Journal.object("dispatchId", dispatchId, "result", result,
            "bytes", bytes, "output", "synthetic-silence"));
      }
    } catch (Exception error) {
      callback.error(TextToSpeech.ERROR_SYNTHESIS);
    } finally { if (active == current) active = null; }
  }
}
