package com.kimju.claudeusage;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Locale;

public class UsageService extends Service {
    public static final String ACTION_REFRESH = "com.kimju.claudeusage.REFRESH";
    public static final String ACTION_USAGE = "com.kimju.claudeusage.USAGE";
    public static final String EXTRA_JSON = "json";
    public static final String EXTRA_PROVIDER = "provider";
    public static final String CLAUDE = "claude";
    public static final String CODEX = "codex";
    private static final String CHANNEL_ID = "ai_usage_status";
    private static final long POLL_MS = 60 * 1000L;
    private static final long PAGE_WAIT_MS = 4500L;

    private Handler handler;
    private WebView webView;
    private SharedPreferences prefs;
    private boolean polling;
    private boolean readScheduled;
    private int attempt;
    private int providerPass;
    private String activeProvider = CLAUDE;
    private final Runnable pollRunnable = this::poll;

    @Override public void onCreate() {
        super.onCreate();
        handler = new Handler(Looper.getMainLooper());
        prefs = getSharedPreferences("usage", MODE_PRIVATE);
        createChannel();
        publishNotifications();
        webView = new WebView(this);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUserAgentString(browserUserAgent(s.getUserAgentString()));
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);
        webView.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView view, String url) {
                if (polling && !readScheduled) {
                    readScheduled = true;
                    handler.postDelayed(() -> { readScheduled = false; readPage(); }, PAGE_WAIT_MS);
                }
            }
        });
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (enabledCount() == 0) { stopSelf(); return START_NOT_STICKY; }
        if (intent != null && ACTION_REFRESH.equals(intent.getAction())) {
            handler.removeCallbacks(pollRunnable);
            poll();
        } else if (!polling) {
            poll();
        }
        return START_STICKY;
    }

    private boolean enabled(String provider) {
        return prefs.getBoolean("show_" + provider, CLAUDE.equals(provider));
    }

    private int enabledCount() { return (enabled(CLAUDE) ? 1 : 0) + (enabled(CODEX) ? 1 : 0); }

    private void poll() {
        if (polling || webView == null || enabledCount() == 0) return;
        polling = true;
        providerPass = 0;
        startNextProvider();
    }

    private void startNextProvider() {
        if (providerPass >= enabledCount()) { finishCycle(); return; }
        if (providerPass == 0) activeProvider = enabled(CLAUDE) ? CLAUDE : CODEX;
        else activeProvider = enabled(CLAUDE) && activeProvider.equals(CLAUDE) ? CODEX : CLAUDE;
        attempt = 0;
        readScheduled = false;
        String url = CLAUDE.equals(activeProvider)
                ? "https://claude.ai/new?_usage_bar=" + System.currentTimeMillis() + "#settings/usage"
                : "https://chatgpt.com/codex/cloud/settings/analytics?_usage_bar=" + System.currentTimeMillis() + "#usage";
        webView.loadUrl(url);
    }

    private void readPage() {
        if (!polling) return;
        webView.evaluateJavascript(CLAUDE.equals(activeProvider) ? CLAUDE_EXTRACT_SCRIPT : CODEX_EXTRACT_SCRIPT, value -> {
            try {
                JSONObject result = new JSONObject(unquote(value));
                if (result.optBoolean("ok") || result.optBoolean("needsLogin")) {
                    saveAndNotify(activeProvider, result.toString());
                    finishProvider();
                } else if (attempt++ < 2) {
                    handler.postDelayed(this::readPage, 3500L);
                } else {
                    finishProvider();
                }
            } catch (JSONException e) {
                if (attempt++ < 2) handler.postDelayed(this::readPage, 3500L); else finishProvider();
            }
        });
    }

    private void finishProvider() {
        providerPass++;
        if (providerPass < enabledCount()) handler.postDelayed(this::startNextProvider, 250L); else finishCycle();
    }

    private void finishCycle() {
        polling = false;
        handler.postDelayed(pollRunnable, POLL_MS);
    }

    private String unquote(String value) {
        if (value == null || value.length() < 2) return "{}";
        try { return new JSONObject("{\"v\":" + value + "}").getString("v"); }
        catch (JSONException e) { return value; }
    }

    private String jsonFor(String provider) { return prefs.getString("last_" + provider + "_json", "{}"); }

    private String browserUserAgent(String current) {
        // Claude 로그인 페이지가 임베디드 앱 UA를 차단하거나 빈 화면으로 만들 수 있어
        // WebView 표시용 꼬리표는 붙이지 않고 Chrome 계열 UA만 사용한다.
        return current.replace("; wv", "").replace(" Version/4.0", "");
    }

    private void saveAndNotify(String provider, String json) {
        prefs.edit().putString("last_" + provider + "_json", json).putLong("updated_" + provider, System.currentTimeMillis()).apply();
        publishNotifications();
        Intent i = new Intent(ACTION_USAGE).setPackage(getPackageName()).putExtra(EXTRA_PROVIDER, provider).putExtra(EXTRA_JSON, json);
        sendBroadcast(i);
    }

    private void publishNotifications() {
        boolean c = enabled(CLAUDE), x = enabled(CODEX);
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (c) startForeground(7, buildNotification(CLAUDE, jsonFor(CLAUDE))); else manager.cancel(7);
        if (x) {
            if (!c) startForeground(8, buildNotification(CODEX, jsonFor(CODEX)));
            else manager.notify(8, buildNotification(CODEX, jsonFor(CODEX)));
        } else manager.cancel(8);
    }

    public static JSONObject readStored(SharedPreferences prefs, String provider) {
        try { return new JSONObject(prefs.getString("last_" + provider + "_json", "{}")); }
        catch (JSONException e) { return new JSONObject(); }
    }

    private Notification buildNotification(String provider, String json) {
        JSONObject o;
        try { o = new JSONObject(json); } catch (JSONException e) { o = new JSONObject(); }
        String name = CLAUDE.equals(provider) ? "Claude" : "Codex";
        String title, content;
        if (o.optBoolean("needsLogin")) {
            title = name + " 사용량 · 로그인 필요";
            content = name + "에 로그인하면 5시간/주간 사용량을 표시합니다";
        } else if (o.optBoolean("ok")) {
            title = compactLine(o, "session", "5시간");
            content = compactLine(o, "weekly", "주간");
        } else {
            title = name + " 사용량 · 확인 중";
            content = "5시간/주간 사용량을 읽는 중입니다";
        }
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent contentPi = PendingIntent.getActivity(this, provider.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent refresh = new Intent(this, UsageService.class).setAction(ACTION_REFRESH);
        PendingIntent refreshPi = PendingIntent.getService(this, provider.hashCode() + 100, refresh, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL_ID) : new Notification.Builder(this);
        b.setSmallIcon(Icon.createWithBitmap(makeNumericIcon(provider, o)))
                .setColor(CLAUDE.equals(provider) ? Color.rgb(217,119,87) : Color.rgb(92,118,180))
                .setContentTitle(title).setContentText(content).setSubText(name + " · 1분마다 자동 갱신")
                .setOngoing(true).setOnlyAlertOnce(true).setCategory(Notification.CATEGORY_STATUS)
                .setContentIntent(contentPi).setStyle(new Notification.BigTextStyle().bigText(detailText(name, o)))
                .addAction(android.R.drawable.ic_popup_sync, "새로고침", refreshPi);
        return b.build();
    }

    private Bitmap makeNumericIcon(String provider, JSONObject o) {
        Bitmap bitmap = Bitmap.createBitmap(72, 64, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bitmap);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG); paint.setColor(CLAUDE.equals(provider) ? Color.rgb(217,119,87) : Color.rgb(92,118,180)); paint.setTextAlign(Paint.Align.CENTER);
        paint.setTypeface(Typeface.create("sans-serif", Typeface.BOLD));
        paint.setTextSize(15); canvas.drawText("C", 10, 18, paint);
        paint.setTextSize(22); canvas.drawText(pct(o, "session"), 42, 27, paint);
        canvas.drawText(pct(o, "weekly"), 42, 57, paint);
        return bitmap;
    }

    private String pct(JSONObject o, String key) { JSONObject x=o.optJSONObject(key); return x==null||!x.has("pct")?"?":String.format(Locale.US,"%.0f",x.optDouble("pct")); }
    private String compactLine(JSONObject o, String key, String label) { JSONObject x=o.optJSONObject(key); return label+" "+pct(o,key)+"% · 리셋 "+(x==null?"-":x.optString("reset","-")); }
    private String detailText(String name, JSONObject o) { return name+" 사용량\n"+compactLine(o,"session","5시간")+"\n"+compactLine(o,"weekly","주간"); }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel c = new NotificationChannel(CHANNEL_ID, "AI 사용량", NotificationManager.IMPORTANCE_LOW);
            c.setDescription("Claude와 Codex 사용량을 상태바에 표시합니다"); c.setShowBadge(false);
            ((NotificationManager)getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(c);
        }
    }

    @Override public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        ((NotificationManager)getSystemService(NOTIFICATION_SERVICE)).cancel(7);
        ((NotificationManager)getSystemService(NOTIFICATION_SERVICE)).cancel(8);
        if (webView != null) { webView.stopLoading(); webView.destroy(); }
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    private static final String CLAUDE_EXTRACT_SCRIPT = "(function(){" +
            "const text=document.body.innerText||'';" +
            "function grab(label){const m=text.match(new RegExp(label+'\\\\s*\\\\n([^\\\\n]+)\\\\s*\\\\n(\\\\d+)%\\\\s*(?:사용됨|used)','i'));return m?{reset:m[1].trim(),pct:parseInt(m[2],10)}:null;}" +
            "const session=grab('(?:현재\\\\s*세션|Current\\\\s*session)');" +
            "const weekly=grab('(?:모든\\\\s*모델|All\\\\s*models)');" +
            "const hasLoginForm=!!document.querySelector('input[type=\\\"password\\\"],input[name=\\\"email\\\"]')||/계속하려면 로그인|Continue with|Log in to Claude|로 계속하기|로그인 또는 회원가입|빠르게 생각하고/i.test(text);" +
            "return {ok:!!(session&&weekly),needsLogin:!session&&!weekly&&hasLoginForm,session:session,weekly:weekly};})()";

    private static final String CODEX_EXTRACT_SCRIPT = "(function(){" +
            "const text=document.body.innerText||'';" +
            "function grab(label){const m=text.match(new RegExp(label+'\\\\s*\\\\n+(\\\\d+)%\\\\s*\\\\n*(?:남음|left|remaining)\\\\s*\\\\n*([^\\\\n]+)','i'));return m?{reset:m[2].trim(),pct:100-parseInt(m[1],10)}:null;}" +
            "const session=grab('(?:5시간\\\\s*사용\\\\s*한도|5[\\\\s-]*h(?:our)?\\\\s*(?:usage\\\\s*)?limit)');" +
            "const weekly=grab('(?:주간\\\\s*사용\\\\s*한도|Weekly\\\\s*(?:usage\\\\s*)?limit)')||grab('(?:월간\\\\s*사용\\\\s*한도|Monthly\\\\s*(?:usage\\\\s*)?limit)');" +
            "const hasLoginForm=!!document.querySelector('input[type=\\\"password\\\"],input[name=\\\"email\\\"]')||/로그인 또는 회원가입|Log in or sign up|계정으로 계속하기|Continue with/i.test(text);" +
            "return {ok:!!(session||weekly),needsLogin:!session&&!weekly&&hasLoginForm,session:session,weekly:weekly};})()";
}
