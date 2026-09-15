package org.irs_public.aloud.tts;
import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import java.util.ArrayList;
import java.util.List;
public final class VoiceDataActivity extends Activity {
  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    Intent data = new Intent();
    data.putStringArrayListExtra(TextToSpeech.Engine.EXTRA_AVAILABLE_VOICES, new ArrayList<>(List.of("eng-USA")));
    data.putStringArrayListExtra(TextToSpeech.Engine.EXTRA_UNAVAILABLE_VOICES, new ArrayList<>());
    setResult(TextToSpeech.Engine.CHECK_VOICE_DATA_PASS, data);
    finish();
  }
}
