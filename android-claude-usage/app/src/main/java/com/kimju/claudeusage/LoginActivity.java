package com.kimju.claudeusage;

import android.app.Activity;
import android.app.Dialog;
import android.content.Intent;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

public class LoginActivity extends Activity {
    private WebView web;
    private TextView status;
    private String provider;
    private Dialog popupDialog;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        provider = getIntent().getStringExtra(UsageService.EXTRA_PROVIDER);
        if (provider == null) provider = UsageService.CLAUDE;
        String name = UsageService.CLAUDE.equals(provider) ? "Claude" : "Codex";

        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(Color.rgb(250,249,245));
        LinearLayout bar = new LinearLayout(this); bar.setGravity(Gravity.CENTER_VERTICAL); bar.setPadding(dp(8),dp(6),dp(8),dp(6)); bar.setBackgroundColor(Color.rgb(20,20,19));
        Button close = toolbarButton("닫기", false); close.setOnClickListener(v -> finish()); bar.addView(close, new LinearLayout.LayoutParams(dp(76),-1));
        status = new TextView(this); status.setText(name + " 로그인 페이지 로딩 중…"); status.setTextColor(Color.LTGRAY); status.setTextSize(12); status.setGravity(Gravity.CENTER); bar.addView(status, new LinearLayout.LayoutParams(0,-1,1));
        Button done = toolbarButton("로그인 완료", true); done.setOnClickListener(v -> finishLogin()); bar.addView(done, new LinearLayout.LayoutParams(dp(116),-1)); root.addView(bar, new LinearLayout.LayoutParams(-1,dp(58)));

        web = createWebView(name);
        web.loadUrl(UsageService.CLAUDE.equals(provider) ? "https://claude.ai/login" : "https://chatgpt.com/auth/login?next=%2Fcodex%2Fcloud%2Fsettings%2Fanalytics");
        root.addView(web, new LinearLayout.LayoutParams(-1,0,1)); setContentView(root);
    }

    private WebView createWebView(String name) {
        WebView view = new WebView(this); configure(view);
        if (UsageService.CODEX.equals(provider)) {
            // ChatGPT's Google flow can request a nested blank WebView on Android.
            // Keep Codex authentication in the visible page instead of trapping
            // the user behind an empty dialog window.
            WebSettings settings = view.getSettings();
            settings.setSupportMultipleWindows(false);
            settings.setJavaScriptCanOpenWindowsAutomatically(false);
        }
        view.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView v, String url) { status.setText(name + " 로그인 페이지"); }
            @Override public void onPageCommitVisible(WebView v, String url) { status.setText(name + " 로그인 페이지"); }
            @Override public void onReceivedError(WebView v, WebResourceRequest request, WebResourceError error) { if (request.isForMainFrame()) status.setText("페이지 로딩 실패 · 새로고침 필요"); }
        });
        view.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onCreateWindow(WebView source, boolean dialog, boolean userGesture, Message resultMsg) {
                if (UsageService.CODEX.equals(provider)) return false;
                WebView child = createWebView(name);
                popupDialog = new Dialog(LoginActivity.this); popupDialog.setTitle(name + " 인증"); popupDialog.setContentView(child); popupDialog.show();
                popupDialog.setOnDismissListener(d -> child.destroy());
                WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj; transport.setWebView(child); resultMsg.sendToTarget(); return true;
            }
            @Override public void onCloseWindow(WebView window) { if (popupDialog != null && popupDialog.isShowing()) popupDialog.dismiss(); }
        });
        return view;
    }

    private void configure(WebView view) {
        WebSettings s=view.getSettings(); s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true); s.setDatabaseEnabled(true); s.setSupportZoom(false); s.setJavaScriptCanOpenWindowsAutomatically(true); s.setSupportMultipleWindows(true); s.setUserAgentString(browserUserAgent(s.getUserAgentString()));
        CookieManager.getInstance().setAcceptCookie(true); CookieManager.getInstance().setAcceptThirdPartyCookies(view,true); view.setBackgroundColor(Color.rgb(250,249,245));
    }
    private Button toolbarButton(String text, boolean primary) {
        Button b = new Button(this); b.setText(text); b.setTextColor(Color.WHITE); b.setTextSize(12); b.setAllCaps(false);
        b.setMinHeight(0); b.setMinWidth(0); b.setPadding(dp(4),0,dp(4),0);
        b.setBackgroundResource(primary ? R.drawable.bg_button : R.drawable.bg_secondary_button);
        return b;
    }
    private int dp(int n) { return (int)(n * getResources().getDisplayMetrics().density + 0.5f); }
    private String browserUserAgent(String current){return current.replace("; wv","").replace(" Version/4.0","");}
    private void finishLogin(){
        CookieManager.getInstance().flush();
        getSharedPreferences("usage", MODE_PRIVATE).edit()
                .putBoolean("login_completed_" + provider, true)
                .putLong("login_saved_" + provider, System.currentTimeMillis())
                .commit();
        Intent i=new Intent(this,UsageService.class).setAction(UsageService.ACTION_REFRESH);
        if(Build.VERSION.SDK_INT>=26)startForegroundService(i);else startService(i);
        finish();
    }
    @Override protected void onPause(){CookieManager.getInstance().flush();super.onPause();}
    @Override protected void onStop(){CookieManager.getInstance().flush();super.onStop();}
    @Override protected void onDestroy(){if(popupDialog!=null&&popupDialog.isShowing())popupDialog.dismiss();if(web!=null)web.destroy();super.onDestroy();}
    @Override public void onBackPressed(){if(web!=null&&web.canGoBack())web.goBack();else super.onBackPressed();}
}
