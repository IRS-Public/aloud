package org.irs_public.aloud.fixture;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

public class MainActivity extends Activity {
  private int nextId = 100;
  private LinearLayout column() {
    LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL);
    layout.setPadding(20, 12, 20, 12); return layout;
  }
  private Button button(String text) {
    Button button = new Button(this); button.setText(text); button.setId(nextId++);
    button.setMinimumHeight(140); return button;
  }
  @Override public void onCreate(Bundle saved) {
    super.onCreate(saved);
    String mode = getIntent().getStringExtra("mode");
    LinearLayout body = column(); setContentView(body);
    if ("scroll".equals(mode)) {
      ScrollView scroll = new ScrollView(this); LinearLayout rows = column();
      for (int i = 1; i <= 30; i++) rows.addView(button("Row " + i));
      scroll.addView(rows); body.addView(scroll);
    } else {
      TextView title = new TextView(this); title.setText("Focus fixture"); title.setTextSize(24); body.addView(title);
      LinearLayout nested = column();
      nested.addView(button("Same label")); nested.addView(button("Same label")); body.addView(nested);
      Button disabled = button("Unavailable control"); disabled.setEnabled(false); body.addView(disabled);
      body.addView(button("Final control"));
    }
    if ("dialog".equals(mode)) {
      body.postDelayed(() -> new AlertDialog.Builder(this).setTitle("Dialog heading")
          .setMessage("Dialog value 12.50").setPositiveButton("Close dialog", (d, w) -> d.dismiss()).show(), 300);
    }
    if ("permission".equals(mode)) {
      Intent probe = new Intent("org.irs_public.aloud.TALKBACK_COMMAND").setPackage("com.android.talkback")
          .putExtra("op", "hello").putExtra("requestId", "untrusted-probe").putExtra("screen", "probe")
          .putExtra("target", getPackageName()).putExtra("sequence", 0);
      sendOrderedBroadcast(probe, null, new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
          Log.i("ALOUD_PERMISSION", "result=" + getResultCode() + ",data=" + getResultData());
        }
      }, null, -17, "receiver-not-invoked", null);
    }
  }
}
