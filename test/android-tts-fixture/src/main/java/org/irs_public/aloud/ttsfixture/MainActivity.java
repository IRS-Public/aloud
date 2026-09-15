package org.irs_public.aloud.ttsfixture;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.AtomicFile;
import android.widget.TextView;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.irs_public.aloud.tts.Journal;
import org.irs_public.aloud.tts.RequestLedger;

/** Direct, instrumented TTS caller used to exercise queue semantics under output pressure. */
public final class MainActivity extends Activity {
  private TextToSpeech tts;
  private String mode, requestId;
  private int planned;
  private final AtomicInteger terminals = new AtomicInteger();

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    mode = getIntent().getStringExtra("mode");
    requestId = UUID.randomUUID().toString();
    TextView view = new TextView(this); view.setText("Aloud TTS fixture: " + mode); setContentView(view);
    RequestLedger.initialize(this);
    tts = new TextToSpeech(this, result -> new Handler(Looper.getMainLooper()).post(() -> {
      if (result != TextToSpeech.SUCCESS || !RequestLedger.enabled()) { status("error", "engine initialization"); return; }
      tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
        @Override public void onStart(String id) { RequestLedger.progress("start", id, false); }
        @Override public void onDone(String id) { RequestLedger.progress("done", id, false); terminals.incrementAndGet(); }
        @Override public void onError(String id) { RequestLedger.progress("error", id, false); terminals.incrementAndGet(); }
        @Override public void onStop(String id, boolean interrupted) { RequestLedger.progress("stop", id, interrupted); terminals.incrementAndGet(); }
      });
      new Thread(this::exercise, "TTS-fixture").start();
    }), RequestLedger.ENGINE);
  }

  private void speak(int queue, int duration, String text) {
    Bundle params = new Bundle(); params.putInt(RequestLedger.DURATION, duration);
    // Reuse original IDs on purpose: unique wire IDs must preserve each request.
    if (RequestLedger.speak(tts, text, queue, params, "repeated-original-id") != TextToSpeech.SUCCESS)
      throw new IllegalStateException("dispatch rejected");
  }

  private void exercise() {
    try {
      planned = "volume".equals(mode) ? 400 : "flush".equals(mode) ? 21
          : mode.endsWith("death") ? 20 : 1;
      RequestLedger.begin(requestId, mode, 0, "tts-fixture");
      RequestLedger.note("test-plan", Journal.object("mode", mode, "requests", planned));
      if ("volume".equals(mode)) {
        String text = "Repeated \"text\" 🙂\n".repeat(70);
        for (int i = 0; i < planned; i++) speak(TextToSpeech.QUEUE_ADD, 8, text);
      } else if ("flush".equals(mode)) {
        for (int i = 0; i < 20; i++) speak(TextToSpeech.QUEUE_ADD, 1000, "Queued text " + i);
        SystemClock.sleep(40);
        speak(TextToSpeech.QUEUE_FLUSH, 120, "Replacement text");
      } else if ("interruption".equals(mode)) {
        speak(TextToSpeech.QUEUE_ADD, 1000, "Interrupted text");
        SystemClock.sleep(40);
        if (RequestLedger.stop(tts) != TextToSpeech.SUCCESS) throw new IllegalStateException("stop rejected");
      } else if (mode.endsWith("death")) {
        for (int i = 0; i < planned; i++) speak(TextToSpeech.QUEUE_ADD, 1000, "Pending at process death " + i);
      } else if ("recovery".equals(mode)) speak(TextToSpeech.QUEUE_ADD, 120, "Recovered session");
      else throw new IllegalArgumentException("unknown fixture mode");
      RequestLedger.note("test-ready", Journal.object("requests", planned));
      status("ready", null);
      long deadline = SystemClock.uptimeMillis() + 180000;
      while (terminals.get() < planned && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(10);
      if (terminals.get() != planned) { status("incomplete", "terminal callbacks missing"); return; }
      RequestLedger.note("test-finished", Journal.object("terminals", terminals.get()));
      RequestLedger.end();
      status("completed", RequestLedger.failure());
    } catch (Exception error) { status("error", error.toString()); }
  }

  private synchronized void status(String stage, String error) {
    try {
      File file = new File(createDeviceProtectedStorageContext().getFilesDir(), "status.json");
      AtomicFile atomic = new AtomicFile(file);
      FileOutputStream stream = atomic.startWrite();
      stream.write(Journal.object("stage", stage, "error", error, "mode", mode, "planned", planned,
          "clientSession", RequestLedger.session(), "requestId", requestId, "terminals", terminals.get())
          .toString().getBytes(StandardCharsets.UTF_8));
      atomic.finishWrite(stream);
    } catch (Exception errorWritingStatus) { throw new IllegalStateException(errorWritingStatus); }
  }
}
