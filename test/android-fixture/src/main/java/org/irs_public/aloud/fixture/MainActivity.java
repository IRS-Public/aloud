package org.irs_public.aloud.fixture;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageButton;
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
  private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
  private void atf(LinearLayout body, boolean bad, boolean dynamic) {
    body.setFocusableInTouchMode(true); body.requestFocus();
    body.setAccessibilityPaneTitle("Account options");
    ImageButton image = new ImageButton(this);
    image.setImageResource(android.R.drawable.ic_menu_send);
    image.setContentDescription(bad ? null : "Send message");
    body.addView(image, new LinearLayout.LayoutParams(dp(52), dp(52)));
    Button small = button("Small target"); small.setMinWidth(0); small.setMinimumWidth(0);
    small.setMinHeight(0); small.setMinimumHeight(0); small.setPadding(0, 0, 0, 0);
    body.addView(small, new LinearLayout.LayoutParams(dp(bad ? 24 : 100), dp(bad ? 24 : 52)));
    body.addView(button("Transfer")); body.addView(button(bad ? "Transfer" : "Deposit"));
    EditText field = new EditText(this); field.setHint("Email address"); field.setSingleLine(true);
    field.setContentDescription(bad ? "Account" : null); field.setMinHeight(dp(52)); body.addView(field);
    Button redundant = button("Save"); redundant.setContentDescription(bad ? "Save button" : "Save changes"); body.addView(redundant);
    Button custom = button("Custom control");
    if (bad) custom.setAccessibilityDelegate(new View.AccessibilityDelegate() {
      @Override public void onInitializeAccessibilityNodeInfo(View host, AccessibilityNodeInfo info) {
        super.onInitializeAccessibilityNodeInfo(host, info); info.setClassName("org.example.UnknownControl");
      }
    });
    body.addView(custom);
    Button state = button("Delivery"); state.setStateDescription("Queued");
    state.setAccessibilityDelegate(new View.AccessibilityDelegate() {
      @Override public void onInitializeAccessibilityNodeInfo(View host, AccessibilityNodeInfo info) {
        super.onInitializeAccessibilityNodeInfo(host, info);
        info.getExtras().putCharSequence("AccessibilityNodeInfo.roleDescription", "status control");
      }
    });
    body.addView(state);
    if (dynamic) state.postDelayed(new Runnable() {
      private int tick;
      @Override public void run() { state.setStateDescription("Queued " + (++tick)); state.postDelayed(this, 80); }
    }, 80);
  }
  @Override public void onCreate(Bundle saved) {
    super.onCreate(saved);
    String mode = getIntent().getStringExtra("mode");
    LinearLayout body = column(); setContentView(body);
    if (mode != null && mode.startsWith("atf-")) {
      atf(body, "atf-bad".equals(mode), "atf-dynamic".equals(mode));
    } else if ("scroll".equals(mode)) {
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
