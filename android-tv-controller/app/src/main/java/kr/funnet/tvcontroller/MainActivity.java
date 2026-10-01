package kr.funnet.tvcontroller;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import kr.funnet.tvcontroller.data.SettingsStore;
import kr.funnet.tvcontroller.data.SecureTokenStore;
import kr.funnet.tvcontroller.device.NetworkIdentity;
import kr.funnet.tvcontroller.service.TvControlService;

public final class MainActivity extends Activity {
    private SettingsStore store;
    private EditText serverUrl;
    private EditText enrollmentKey;
    private EditText localName;
    private EditText displayId;
    private Spinner tvModel;
    private TextView status;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        store = new SettingsStore(this);
        setContentView(buildView());
        requestNotificationPermission();
    }

    @Override protected void onResume() {
        super.onResume();
        status.setText(statusText());
    }

    private View buildView() {
        ScrollView scroll = new ScrollView(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(48, 36, 48, 48);
        root.setBackgroundColor(Color.rgb(244, 247, 249));
        scroll.addView(root);

        TextView title = text("Yealink MeetingBar A10 TV Controller", 28, Color.rgb(16, 24, 32));
        title.setPadding(0, 0, 0, 24);
        root.addView(title);
        root.addView(text("Yealink MeetingBar A10 전용 정식 배포 앱입니다.", 16, Color.DKGRAY));
        root.addView(text("현재 IP: " + NetworkIdentity.localIpv4Address(), 16, Color.rgb(23, 105, 170)));

        serverUrl = field("서버 주소", store.serverUrl());
        enrollmentKey = field("등록 키", store.enrollmentKey());
        localName = field("설치 장소 / 장비 이름 (예: 관악구 ○○경로당)", store.localName());
        displayId = field("TV Display ID (0~253)", String.valueOf(store.displayId()));
        root.addView(serverUrl);
        root.addView(enrollmentKey);
        if (BuildConfig.PRECONFIGURED) {
            serverUrl.setEnabled(false);
            enrollmentKey.setVisibility(View.GONE);
            root.addView(text("배포 설정: " + store.regionName() + " · 서버 자동 설정 · Device ID " + store.displayId(), 15, Color.DKGRAY));
        }
        root.addView(localName);

        tvModel = new Spinner(this);
        String[] models = {"LH75QET", "LH65QET", "LH85QET", "LH65QBC", "LH75QBC", "LH85QBC"};
        tvModel.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, models));
        tvModel.setSelection(modelSelection(store.tvModel(), models));
        tvModel.setPadding(8, 12, 8, 12);
        root.addView(tvModel);
        root.addView(displayId);
        if (BuildConfig.PRECONFIGURED) displayId.setEnabled(false);

        Button save = button("설정 저장 및 서비스 시작");
        save.setOnClickListener(view -> saveAndStart());
        root.addView(save);

        Button battery = button("배터리 최적화 설정 열기");
        battery.setOnClickListener(view -> {
            try { startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); }
            catch (Exception error) { startActivity(new Intent(Settings.ACTION_SETTINGS)); }
        });
        root.addView(battery);

        Button reset = button("서버 장비 등록 초기화");
        reset.setOnClickListener(view -> {
            new SecureTokenStore(this).clear();
            store.status("등록 초기화됨 · 등록 키 입력 후 다시 시작");
            status.setText("상태: " + store.status());
            toast("저장된 장비 토큰을 삭제했습니다. 등록 키를 입력하고 다시 시작하세요.");
        });
        root.addView(reset);

        status = text(statusText(), 17, Color.rgb(23, 105, 170));
        status.setPadding(0, 28, 0, 12);
        root.addView(status);
        root.addView(text("필수 현장 설정: USB 접근 항상 허용 · 배터리 제한 없음 · 자동 절전 해제 · TV가 아닌 별도 전원 사용", 15, Color.DKGRAY));
        return scroll;
    }

    private void saveAndStart() {
        String url = BuildConfig.PRECONFIGURED ? store.serverUrl() : serverUrl.getText().toString().trim();
        String name = localName.getText().toString().trim();
        int id;
        try { id = BuildConfig.PRECONFIGURED ? store.displayId() : Integer.parseInt(displayId.getText().toString().trim()); }
        catch (NumberFormatException error) { toast("Display ID는 숫자여야 합니다."); return; }
        if (!url.matches("https?://.+") || name.isBlank() || id < 0 || id > 253) {
            toast("서버 주소, 장비 이름, Display ID를 확인해 주세요.");
            return;
        }
        store.save(url, BuildConfig.PRECONFIGURED ? store.enrollmentKey() : enrollmentKey.getText().toString(), name, tvModel.getSelectedItem().toString(), id);
        TvControlService.start(this);
        status.setText("상태: 서비스 시작 요청");
        toast("설정을 저장하고 TV 제어 서비스를 시작했습니다.");
    }

    private EditText field(String hint, String value) {
        EditText field = new EditText(this);
        field.setHint(hint);
        field.setText(value);
        field.setSingleLine(true);
        field.setTextSize(17);
        field.setPadding(8, 16, 8, 16);
        return field;
    }

    private Button button(String label) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextSize(16);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.topMargin = 16;
        button.setLayoutParams(params);
        button.setGravity(Gravity.CENTER);
        return button;
    }

    private TextView text(String value, int size, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        return view;
    }

    private void toast(String value) { Toast.makeText(this, value, Toast.LENGTH_LONG).show(); }

    private static int modelSelection(String saved, String[] models) {
        for (int index = 0; index < models.length; index++) {
            if (models[index].equalsIgnoreCase(saved)) return index;
        }
        if (saved != null && (saved.toUpperCase().contains("QBC") || saved.equalsIgnoreCase("QB75B"))) return 4;
        return 0;
    }

    private String statusText() {
        return "상태: " + store.status() + "\n절전 감시: " + store.powerStatus();
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 10);
        }
    }
}
