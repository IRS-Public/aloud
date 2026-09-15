package org.irs_public.aloud.tts;

import android.content.Context;
import android.os.Process;
import android.os.SystemClock;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** Append-only, process-scoped evidence. A write failure is sticky and never silently skipped. */
public final class Journal {
  public static final int VERSION = 1;
  private static final long MAX_BYTES = 32L * 1024 * 1024;
  public final String session;
  private final File file;
  private long index;
  private String failure;

  public Journal(Context context, String producer, String session, String directory) {
    this.session = session;
    File root = new File(context.createDeviceProtectedStorageContext().getFilesDir(), "aloud-tts");
    File dir = directory == null ? root : new File(root, directory);
    file = new File(dir, session + ".jsonl");
    try {
      if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("cannot create journal directory");
      if (!file.createNewFile()) throw new IOException("journal session already exists");
      append("header", object("producer", producer, "pid", Process.myPid(), "uid", Process.myUid(),
          "packageName", context.getPackageName(), "output", "synthetic-silence"));
    } catch (Exception e) { fail(e); }
  }

  public static JSONObject object(Object... values) {
    JSONObject result = new JSONObject();
    try {
      for (int i = 0; i < values.length; i += 2)
        result.put((String) values[i], values[i + 1] == null ? JSONObject.NULL : values[i + 1]);
    } catch (Exception e) { throw new IllegalArgumentException(e); }
    return result;
  }

  public synchronized long append(String kind, JSONObject data) {
    if (failure != null) throw new IllegalStateException(failure);
    long next = index + 1;
    byte[] bytes = (object("schemaVersion", VERSION, "session", session, "event", next,
        "kind", kind, "uptimeMs", SystemClock.uptimeMillis(), "data", data) + "\n")
        .getBytes(StandardCharsets.UTF_8);
    try {
      if (file.length() + bytes.length > MAX_BYTES) throw new IOException("journal size limit reached");
      try (FileOutputStream stream = new FileOutputStream(file, true)) {
        stream.write(bytes);
        stream.getFD().sync();
      }
      index = next;
      return index;
    } catch (Exception e) { fail(e); return -1; }
  }

  private void fail(Exception e) {
    failure = "TTS journal failed: " + e.getMessage();
    throw new IllegalStateException(failure, e);
  }
  public synchronized String failure() { return failure; }
  public synchronized long index() { return index; }
}
